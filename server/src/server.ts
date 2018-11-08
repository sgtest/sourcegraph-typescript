import 'source-map-support/register'

import {
    createMessageConnection,
    isNotificationMessage,
    isRequestMessage,
    isResponseMessage,
    IWebSocket,
    WebSocketMessageReader,
    WebSocketMessageWriter,
} from '@sourcegraph/vscode-ws-jsonrpc'
import * as rpcServer from '@sourcegraph/vscode-ws-jsonrpc/lib/server'
import decompress from 'decompress'
import glob from 'globby'
import * as http from 'http'
import * as https from 'https'
import { Tracer as LightstepTracer } from 'lightstep-tracer'
import LightstepSpan from 'lightstep-tracer/lib/imp/span_imp'
import mkdirp from 'mkdirp-promise'
import * as fs from 'mz/fs'
import { createWriteStream } from 'mz/fs'
import { Span, Tracer } from 'opentracing'
import { tmpdir } from 'os'
import * as path from 'path'
import request from 'request'
import rmfr from 'rmfr'
import { fileURLToPath, pathToFileURL } from 'url'
import uuid = require('uuid')
import { ErrorCodes, InitializeParams } from 'vscode-languageserver-protocol'
import { Server } from 'ws'
import { filterDependencies } from './dependencies'
import { Logger, LSPLogger } from './logging'
import { tracePromise } from './tracing'
import { install } from './yarn'

const CACHE_DIR = process.env.CACHE_DIR || tmpdir()
console.log(`Using CACHE_DIR ${CACHE_DIR}`)

/**
 * Rewrites all `uri` properties in an object, recursively
 */
function rewriteUris(obj: any, transform: (uri: URL) => URL): void {
    if (typeof obj !== 'object' || obj === null) {
        return
    }
    if ('uri' in obj) {
        obj.uri = transform(new URL(obj.uri)).href
    }
    for (const key of Object.keys(obj)) {
        rewriteUris(obj[key], transform)
    }
}

let tracer = new Tracer()
if (process.env.LIGHTSTEP_ACCESS_TOKEN) {
    console.log('LightStep tracing enabled')
    tracer = new LightstepTracer({
        access_token: process.env.LIGHTSTEP_ACCESS_TOKEN,
        component_name: 'lang-typescript',
    })
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080

let httpServer: http.Server | https.Server
if (process.env.TLS_CERT && process.env.TLS_KEY) {
    console.log('TLS encryption enabled')
    httpServer = https.createServer({
        cert: process.env.TLS_CERT,
        key: process.env.TLS_KEY,
    })
} else {
    httpServer = http.createServer()
}

type CleanupFn = () => void | Promise<void>
async function cleanupAll(cleanupFns: Iterable<CleanupFn>): Promise<void> {
    for (const cleanup of cleanupFns) {
        try {
            await cleanup()
        } catch (err) {
            console.error('Error cleaning up', err)
        }
    }
}

const globalCleanupFns = new Set<CleanupFn>()

// Cleanup when receiving signals
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    process.once(signal, async () => {
        console.log(`Received ${signal}, cleaning up`)
        await cleanupAll(globalCleanupFns)
        process.exit(0)
    })
}

const webSocketServer = new Server({ server: httpServer })

webSocketServer.on('connection', async connection => {
    console.log('New WebSocket connection')
    const webSocket: IWebSocket = {
        onMessage: handler => connection.on('message', handler),
        onClose: handler => connection.on('close', handler),
        onError: handler => connection.on('error', handler),
        send: content => connection.send(content),
        dispose: () => connection.close(),
    }
    const webSocketReader = new WebSocketMessageReader(webSocket)
    const webSocketWriter = new WebSocketMessageWriter(webSocket)
    const webSocketConnection = rpcServer.createConnection(webSocketReader, webSocketWriter, () => webSocket.dispose())
    const webSocketMessageConnection = createMessageConnection(
        webSocketConnection.reader,
        webSocketConnection.writer,
        console
    )
    /** The logger for this connection, loggin to the user's browser console */
    const logger: Logger = new LSPLogger(webSocketMessageConnection)

    const languageServerConnection = rpcServer.createServerProcess('TypeScript language', 'node', [
        path.resolve(__dirname, '..', '..', 'node_modules', 'typescript-language-server', 'lib', 'cli.js'),
        '--stdio',
        // Use local tsserver instead of the tsserver of the repo for security reasons
        '--tsserver-path=' + path.join(__dirname, '..', '..', 'node_modules', 'typescript', 'bin', 'tsserver'),
        // '--log-level=4',
    ])

    let zipRootUri: URL
    let fileRootUri: URL
    let tempDir: string
    let extractPath: string
    // yarn folders
    let globalFolderRoot: string
    let cacheFolderRoot: string

    const connectionCleanupFns: CleanupFn[] = []
    const cleanupConnection = () => cleanupAll(connectionCleanupFns)
    globalCleanupFns.add(cleanupConnection)
    connectionCleanupFns.push(() => languageServerConnection.dispose())
    connection.on('close', async (code, reason) => {
        console.log('WebSocket closed', { code, reason })
        await cleanupAll(connectionCleanupFns)
        globalCleanupFns.delete(cleanupConnection)
    })

    const transformZipToFileUri = (zipUri: URL): URL => {
        const fileUri = new URL(fileRootUri.href)
        fileUri.pathname = path.posix.join(fileRootUri.pathname, zipUri.hash.substr(1))
        return fileUri
    }
    const transformFileToZipUri = (fileUri: URL): URL => {
        const filePath = fileURLToPath(fileUri)
        const zipUri = new URL(zipRootUri.href)
        zipUri.hash = path.relative(extractPath, filePath).replace(/\\/g, '/')
        return zipUri
    }

    /** OpenTracing spans for pending requests by message ID */
    const requestSpans = new Map<string | number, Span>()

    webSocketReader.listen(async message => {
        let span = new Span()
        try {
            // If a request or notification, start a span
            if (isRequestMessage(message) || isNotificationMessage(message)) {
                span = tracer.startSpan('Handle ' + message.method)
                // Log the trace URL for this request in the client
                // if (span instanceof LightstepSpan) {
                //     const traceUrl = span.generateTraceURL()
                //     logger.log(`Trace ${message.method} ${traceUrl}`)
                // }
                span.setTag('method', message.method)
                if (isRequestMessage(message)) {
                    span.setTag('id', message.id)
                    requestSpans.set(message.id, span)
                }
            }
            if (zipRootUri) {
                span.setTag('rootUri', zipRootUri.href)
            }

            // Intercept initialize
            if (isRequestMessage(message) && message.method === 'initialize') {
                const params: InitializeParams = message.params
                if (!params.rootUri) {
                    throw new Error('No rootUri given as initialize parameter')
                }
                if (params.workspaceFolders && params.workspaceFolders.length > 1) {
                    throw new Error(
                        'More than one workspace folder given. The TypeScript server only supports a single workspace folder.'
                    )
                }
                zipRootUri = new URL(params.rootUri)
                span.setTag('rootUri', zipRootUri.href)
                if (!zipRootUri.pathname.endsWith('.zip')) {
                    throw new Error('rootUri must end with .zip')
                }
                if (zipRootUri.protocol !== 'http:' && zipRootUri.protocol !== 'https:') {
                    throw new Error('Protocol must be http or https')
                }
                // Create temp folders
                tempDir = path.join(
                    CACHE_DIR,
                    (zipRootUri.hostname + zipRootUri.pathname).replace(/\//g, '_') + '_' + uuid.v1()
                )
                await mkdirp(tempDir)
                connectionCleanupFns.push(async () => {
                    logger.log('Deleting temp dir ', tempDir)
                    await rmfr(tempDir)
                })
                extractPath = path.join(tempDir, 'repo')
                cacheFolderRoot = path.join(tempDir, 'cache')
                globalFolderRoot = path.join(tempDir, 'global')
                await Promise.all([fs.mkdir(extractPath), fs.mkdir(cacheFolderRoot), fs.mkdir(globalFolderRoot)])

                // Fetch zip and extract into temp folder
                logger.log('Fetching zip from', zipRootUri.href)
                const archivePath = path.join(tempDir, 'archive.zip')
                await tracePromise('Fetch source archive', span, async span => {
                    span.setTag('url', zipRootUri.href)
                    let bytes = 0
                    await new Promise<void>((resolve, reject) => {
                        const response = request(zipRootUri.href)
                        response
                            .once('error', reject)
                            .on('data', (chunk: Buffer) => {
                                bytes += chunk.byteLength
                            })
                            .pipe(createWriteStream(archivePath))
                            .once('finish', resolve)
                            .once('error', reject)
                    })
                    span.setTag('bytes', bytes)
                })
                await tracePromise('Extract source archive', span, async span => {
                    await decompress(archivePath, extractPath, {
                        strip: 1,
                    })
                })

                // Find package.jsons to install
                const packageJsonPaths = await tracePromise('Find package.jsons', span, span =>
                    glob('**/package.json', { cwd: extractPath })
                )
                logger.log('package.jsons found:', packageJsonPaths)

                // Install dependencies
                await tracePromise('Install dependencies', span, async span => {
                    await Promise.all(
                        packageJsonPaths.map(async relPackageJsonPath => {
                            try {
                                await tracePromise('Install dependencies for package', span, async span => {
                                    span.setTag('packageJsonPath', relPackageJsonPath)
                                    const absPackageJsonPath = path.join(extractPath, relPackageJsonPath)
                                    await filterDependencies(absPackageJsonPath, logger, span)

                                    // It's important that each concurrent yarn process has their own global and cache folders
                                    const relPackageJsonDirName = path.dirname(relPackageJsonPath)
                                    const globalFolder = path.join(globalFolderRoot, relPackageJsonDirName)
                                    const cacheFolder = path.join(cacheFolderRoot, relPackageJsonDirName)
                                    const cwd = path.join(extractPath, relPackageJsonDirName)

                                    await Promise.all([mkdirp(path.join(globalFolder)), mkdirp(path.join(cacheFolder))])

                                    await new Promise<void>((resolve, reject) => {
                                        const yarnProcess = install({ cwd, globalFolder, cacheFolder, logger }, span)
                                        yarnProcess.on('success', resolve)
                                        yarnProcess.on('error', reject)
                                        connectionCleanupFns.unshift(() => {
                                            logger.log('Killing yarn process in ', cwd)
                                            yarnProcess.kill()
                                        })
                                    })
                                })
                            } catch (err) {
                                logger.error(`Installation for ${relPackageJsonPath} failed`, err)
                            }
                        })
                    )
                })

                // Rewrite HTTP zip root URI to a file URI pointing to the checkout dir
                fileRootUri = pathToFileURL(extractPath)
                params.rootUri = fileRootUri.href
                params.rootPath = extractPath
                params.workspaceFolders = [{ name: '', uri: fileRootUri.href }]
            }

            rewriteUris(message, transformZipToFileUri)

            // Forward message to language server
            languageServerConnection.writer.write(message)
        } catch (err) {
            span.setTag('error', true)
            span.log({ event: 'error', 'error.object': err, stack: err.stack, message: err.message })

            logger.error('Error handling message\n', message, '\n', err)
            if (isRequestMessage(message)) {
                const errResponse = {
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        message: err.message,
                        code: typeof err.code === 'number' ? err.code : ErrorCodes.UnknownErrorCode,
                        data: {
                            stack: err.stack,
                            ...err,
                        },
                    },
                }
                webSocketConnection.writer.write(errResponse)
            }
        }
    })

    languageServerConnection.forward(webSocketConnection, message => {
        // If a response, finish the span
        if (isResponseMessage(message) && message.id !== null) {
            const span = requestSpans.get(message.id)
            if (span) {
                // const meta = {}
                // span.tracer().inject(span, FORMAT_TEXT_MAP, meta)
                // ;(message as any).meta = meta
                if (span instanceof LightstepSpan) {
                    // Add trace URL to message for easy access in the WebSocket frame inspector
                    ;(message as any)._trace = span.generateTraceURL()
                }
                span.finish()
                requestSpans.delete(message.id)
            }
        }
        rewriteUris(message, transformFileToZipUri)
        return message
    })
})

httpServer.listen(port, () => {
    console.log(`WebSocket server listening on port ${port}`)
})
