// The game server: serves your game's files and runs the online rooms over WebSockets. Start it with: node server.js
// By default it only listens on this computer (127.0.0.1), which is right while you build the game.
// To host it for real, set HOST, PORT and ALLOWED_ORIGINS and put your own HTTPS proxy in front (see docs/game-server.md).
// Part of the Dim Factory game starter. MIT License: copy, change and share it freely.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRooms, MESSAGE_MAX_BYTES } from './src/server/rooms.js'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** Files and folders that are never sent to a browser. Paths are lowercase and relative to the game folder. */
const PRIVATE = ['server.js', 'package.json', 'package-lock.json', 'node_modules', 'src/server']

/** Turns a URL path into a file path inside root, or null when it must not be served. */
export function safeFilePath(root, urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\') || !decoded.startsWith('/')) return null
  if (decoded.endsWith('/')) decoded += 'index.html'
  const parts = decoded.split('/').filter(Boolean)
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('.'))) return null
  const relative = parts.join('/').toLowerCase()
  if (PRIVATE.some((p) => relative === p || relative.startsWith(p + '/'))) return null
  const base = resolve(root)
  const full = resolve(base, ...parts)
  return full.startsWith(base + sep) ? full : null
}

/**
 * @param {object} options
 * @param {new (options: object) => any} options.WebSocketServer The WebSocketServer class from the ws package.
 * @param {object} options.rules Your game rules (src/game/rules.js).
 * @param {string} [options.root] The game folder to serve. Default: the folder of this file.
 * @param {string} [options.host] HOST, default 127.0.0.1 (this computer only).
 * @param {number} [options.port] PORT, default 8787. 0 picks a free port.
 * @param {string[]} [options.allowedOrigins] ALLOWED_ORIGINS (comma list). Default: this server's own address.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ url: string, host: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer(options) {
  const { WebSocketServer, rules } = options
  const root = options.root ?? dirname(fileURLToPath(import.meta.url))
  const host = options.host ?? (process.env.HOST || '127.0.0.1')
  const wantedPort = options.port ?? (Number(process.env.PORT) || 8787)
  const log = options.log ?? console.log
  let allowed = []
  let csp = ''

  const httpServer = createServer((req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': csp }
    const refuse = (code, text) => {
      res.writeHead(code, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(text)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405, 'Method not allowed')
    const file = safeFilePath(root, req.url || '/')
    const type = file ? TYPES[extname(file).toLowerCase()] : undefined
    if (!file || !type) return refuse(404, 'Not found')
    stat(file)
      .then((s) => {
        if (!s.isFile()) throw new Error('not a file')
        return readFile(file)
      })
      .then((body) => {
        res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': body.length })
        res.end(req.method === 'HEAD' ? undefined : body)
      })
      .catch(() => refuse(404, 'Not found'))
  })

  await new Promise((done, fail) => {
    httpServer.once('error', fail)
    httpServer.listen(wantedPort, host, done)
  })
  const port = httpServer.address().port
  const url = `http://${host}:${port}/`

  const fromEnv = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  allowed = options.allowedOrigins ?? (fromEnv.length ? fromEnv : [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  // The page may only talk to this server: same-origin plus the WebSocket form of each allowed origin.
  const sockets = allowed.map((o) => o.replace(/^http/, 'ws'))
  csp = [
    "default-src 'self'",
    `connect-src 'self' ws://${host}:${port} ${sockets.join(' ')}`.trim(),
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

  const rooms = createRooms({ rules })
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/play',
    maxPayload: MESSAGE_MAX_BYTES,
    verifyClient: (info) => {
      const origin = info.origin ?? info.req?.headers?.origin
      return typeof origin === 'string' && allowed.includes(origin)
    },
  })
  wss.on('connection', (socket) => {
    const client = rooms.connect((obj) => socket.readyState === 1 && socket.send(JSON.stringify(obj)))
    socket.on('message', (data, isBinary) => {
      if (isBinary) return socket.close(1003)
      if (client.receive(String(data)) === 'close') socket.close(1008)
    })
    socket.on('close', () => client.close())
  })

  log(`Game server: ${url}`)
  return {
    url,
    host,
    port,
    close: () =>
      new Promise((done) => {
        wss.close()
        httpServer.close(() => done())
        httpServer.closeAllConnections?.()
      }),
  }
}

async function main() {
  const { WebSocketServer } = await import('ws')
  const rules = await import('./src/game/rules.js')
  await startServer({ WebSocketServer, rules })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
