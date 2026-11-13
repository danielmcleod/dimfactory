// Dim Factory's own read-only static server for a folder of plain files (Run & Preview's "Serve index.html").
//
// - Bound to 127.0.0.1 on a port the OS picks; nothing else on the machine or the network can reach it.
// - The Host header must name that address (127.0.0.1 or localhost with the port), so a web page elsewhere cannot use
//   DNS rebinding to read the folder through it.
// - GET and HEAD only (405 otherwise); no request body is read.
// - Serves only inside its root: the decoded path may not hold `..`, a NUL, a backslash, a drive or stream colon or a
//   dot segment (`.git`, `.env`; `.well-known` is allowed), and the file's real path (links and junctions followed) must
//   still be inside the root's real path. Anything else is 403 or 404.
// - A folder is served only through its index.html (no listings); `/docs` redirects to `/docs/` first so relative
//   links in the page resolve.
// - Content types by extension (text types in UTF-8), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
// - An address that is no file falls back as a static host would (fallbackFor): a single-page site's `_redirects` rule
//   serves index.html, else a 404.html is served with a 404, so a link to an inner page of a React site opens it.
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { realPath } from '../real-path.ts'

export const STATIC_HOST = '127.0.0.1'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  // Ogg Opus, the usual .opus file.
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
}

/** The Content-Type for a file name (application/octet-stream when the extension is unknown). */
export function contentTypeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export type ResolvedRequest =
  | { kind: 'file'; path: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'error'; status: 400 | 403 | 404 }

/** A path segment the server never serves: parent, NUL, a backslash or colon (Windows), a dot file or folder. */
function badSegment(seg: string): boolean {
  if (seg === '..' || seg === '.') return true
  if (/[\0\\:]/.test(seg)) return true
  return seg.startsWith('.') && seg !== '.well-known'
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function statOf(p: string): Promise<'file' | 'dir' | null> {
  try {
    const s = await stat(p)
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : null
  } catch {
    return null
  }
}

/**
 * What a request path maps to under `root` (compared by its real path): a file to send, a redirect to the folder's
 * slash form, or an error status. Pure apart from reading the file system; exported for the tests.
 */
export async function resolveRequestPath(root: string, rawPath: string): Promise<ResolvedRequest> {
  // The root as the file system spells it, the same spelling realpath gives the file below (an 8.3 short name or a
  // linked temp folder would put every file outside it).
  const rootReal = await realPath(root)
  const q = rawPath.indexOf('?')
  const pathOnly = q === -1 ? rawPath : rawPath.slice(0, q)
  // `//host/…` would make a redirect leave the server (a protocol-relative URL).
  if (!pathOnly.startsWith('/') || pathOnly.startsWith('//')) return { kind: 'error', status: 400 }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathOnly)
  } catch {
    return { kind: 'error', status: 400 }
  }
  const segs = decoded.split('/').filter((s) => s !== '')
  if (segs.some(badSegment)) return { kind: 'error', status: 403 }
  let target = join(rootReal, ...segs)
  if (!inside(rootReal, target)) return { kind: 'error', status: 403 }
  let what = await statOf(target)
  if (what === null) return { kind: 'error', status: 404 }
  if (what === 'dir') {
    if (!decoded.endsWith('/')) return { kind: 'redirect', location: `${pathOnly}/` }
    target = join(target, 'index.html')
    what = await statOf(target)
    if (what !== 'file') return { kind: 'error', status: 404 }
  }
  // Links and junctions are followed only while they stay inside the root.
  let real: string
  try {
    real = await realpath(target)
  } catch {
    return { kind: 'error', status: 404 }
  }
  if (!inside(rootReal, real)) return { kind: 'error', status: 403 }
  return { kind: 'file', path: real }
}

/** `_redirects`' single-page rule (Netlify and Cloudflare Pages): every address opens index.html with a 200. */
const SPA_RULE = /^\s*\/\*\s+\/index\.html\s+200!?\s*$/m

/**
 * What a static host serves for an address that is no file, as the folder asks for it: a single-page site whose
 * `_redirects` sends every address to index.html gets index.html (200), and a folder with a 404.html gets that page
 * (404, as GitHub Pages serves it). Only an address that looks like a page (its last part has no file extension) falls
 * back; null: a plain 404.
 */
export async function fallbackFor(
  root: string,
  rawPath: string,
): Promise<{ path: string; status: 200 | 404 } | null> {
  const rootReal = await realPath(root)
  const pathOnly = rawPath.split('?')[0] ?? ''
  const last = pathOnly.split('/').pop() ?? ''
  if (last.includes('.')) return null
  const fileIn = async (name: string): Promise<string | null> => {
    const p = join(rootReal, name)
    if ((await statOf(p)) !== 'file') return null
    const real = await realpath(p).catch(() => null)
    return real !== null && inside(rootReal, real) ? real : null
  }
  const redirects = await fileIn('_redirects')
  if (redirects !== null) {
    const s = await stat(redirects)
    const text = s.size <= 64 * 1024 ? await readFile(redirects, 'utf8').catch(() => '') : ''
    const index = await fileIn('index.html')
    if (SPA_RULE.test(text) && index !== null) return { path: index, status: 200 }
  }
  const notFound = await fileIn('404.html')
  return notFound !== null ? { path: notFound, status: 404 } : null
}

export interface StaticServer {
  /** `http://127.0.0.1:<port>/` */
  readonly url: string
  readonly port: number
  readonly root: string
  close(): Promise<void>
}

export interface StaticServerOptions {
  /** One line per request (`GET /index.html 200`), for the preview's output. */
  onRequest?: (line: string) => void
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad request',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  421: 'Misdirected request',
}

function plain(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  const body = `${status} ${STATUS_TEXT[status] ?? ''}\n`
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  })
  res.end(body)
}

/** Serve `root` read-only on 127.0.0.1 (see the header). */
export async function startStaticServer(root: string, o: StaticServerOptions = {}): Promise<StaticServer> {
  const rootReal = await realPath(root)
  if ((await statOf(rootReal)) !== 'dir') throw new Error(`${root} is not a folder`)
  let port = 0
  const hosts = (): Set<string> => new Set([`${STATIC_HOST}:${port}`, `localhost:${port}`])

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const host = (req.headers.host ?? '').toLowerCase()
    if (!hosts().has(host)) {
      plain(res, 421)
      return 421
    }
    const method = req.method ?? ''
    if (method !== 'GET' && method !== 'HEAD') {
      plain(res, 405, { Allow: 'GET, HEAD' })
      return 405
    }
    let r = await resolveRequestPath(rootReal, req.url ?? '/')
    let status: 200 | 404 = 200
    if (r.kind === 'error' && r.status === 404) {
      const fallback = await fallbackFor(rootReal, req.url ?? '/')
      if (fallback !== null) {
        r = { kind: 'file', path: fallback.path }
        status = fallback.status
      }
    }
    if (r.kind === 'error') {
      plain(res, r.status)
      return r.status
    }
    if (r.kind === 'redirect') {
      plain(res, 301, { Location: r.location })
      return 301
    }
    const s = await stat(r.path)
    res.writeHead(status, {
      'Content-Type': contentTypeOf(r.path),
      'Content-Length': String(s.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    if (method === 'HEAD') {
      res.end()
      return status
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(r.path)
      stream.on('error', () => {
        res.destroy()
        resolve()
      })
      stream.on('end', () => resolve())
      stream.pipe(res)
    })
    return status
  }

  const server: Server = createServer((req, res) => {
    // A request body is never read: GET and HEAD carry none, and anything else is refused before it would be.
    void handle(req, res)
      .then((status) => o.onRequest?.(`${req.method ?? '?'} ${(req.url ?? '/').slice(0, 300)} ${status}`))
      .catch(() => {
        if (!res.headersSent) plain(res, 404)
        else res.destroy()
      })
  })
  server.keepAliveTimeout = 2000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, STATIC_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port
  let closing: Promise<void> | null = null
  return {
    url: `http://${STATIC_HOST}:${port}/`,
    port,
    root: rootReal,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })),
  }
}
