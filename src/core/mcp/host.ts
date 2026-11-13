// The loopback MCP endpoint for outside agents (Streamable HTTP, stateless, JSON responses): one HTTP server on
// 127.0.0.1 with routes `/mcp/<name>`, each with its own bearer token. Every request must
//   - come from loopback (the server listens on 127.0.0.1 only; the peer address is checked as well),
//   - carry no Origin header (a browser page, and with it every DNS-rebinding page, is refused),
//   - name the exact Host `127.0.0.1:<port>`,
//   - carry the route's token (compared in constant time over SHA-256 digests, so neither its bytes nor its length
//     leak); an unknown route and a wrong token both answer 401, so a local process cannot tell which routes exist,
//   - be a POST with a body of at most MCP_MAX_BODY bytes, delivered within the header and request timeouts, and a
//     JSON-RPC batch (older protocol versions allow one) of at most MCP_MAX_BATCH messages.
// Each POST gets a fresh McpServer (stateless: no sessions to hold or hijack). Tokens and bodies are never logged.
// `POST /mcp/<name>/proof` (the same pre-auth checks, no token) answers the stdio bridge's nonce with a proof that only
// a holder of the route's token can make (proof.ts), so the bridge sends its token only to the real app; an unknown
// route gets an answer made with a key of its own, so the proof does not tell which routes exist either.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Logger } from '../log.ts'
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME } from './instructions.ts'
import { MCP_NONCE_HEADER, MCP_PROOF_SUFFIX, isProofNonce, serverProof } from './proof.ts'

/** Largest request body. */
export const MCP_MAX_BODY = 4 * 1024 * 1024
/** A client must send its headers within this long, and the whole request within MCP_REQUEST_TIMEOUT_MS. */
export const MCP_HEADERS_TIMEOUT_MS = 10_000
export const MCP_REQUEST_TIMEOUT_MS = 60_000
/** How often Node checks the two timeouts above (its default, 30 s, lets a stalled client stay ~3x longer). */
export const MCP_TIMEOUT_CHECK_MS = 2_000
/** Most messages one JSON-RPC batch may carry (each tool call reaches the core). */
export const MCP_MAX_BATCH = 16
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::ffff:127.0.0.1'])

/** What one request knows about its caller (the MCP handshake's clientInfo, when this request is the handshake). */
export interface McpCallContext {
  clientName: string | null
}

export interface McpRouteSpec {
  token: string
  /** Adds the route's tools to a fresh server (once per request). */
  register: (server: McpServer, call: McpCallContext) => void
  /** Called for every authenticated request. */
  onCall?: (call: McpCallContext) => void
}

const digest = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest()

/** The bearer token of an Authorization header ('' when there is none). */
export function bearerOf(header: string | undefined): string {
  if (header === undefined) return ''
  const m = /^Bearer[ ]+(\S+)$/i.exec(header.trim())
  return m?.[1] ?? ''
}

/** Constant-time comparison of a presented token with the expected one's digest. */
export function tokenMatches(given: string, expected: Buffer): boolean {
  if (given === '') return false
  return timingSafeEqual(digest(given), expected)
}

/**
 * A name an outside agent gives (its MCP clientInfo, request_run's `requestedBy`) as the app may show it: control
 * characters, line breaks and invisible format characters (bidirectional overrides could make it read as something
 * else) become spaces; then trimmed and cut at 80 characters.
 */
export function cleanAgentName(name: string): string {
  return name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .trim()
    .slice(0, 80)
}

/** The client's name from an `initialize` request body (single or batched), else null. */
export function clientNameOf(body: unknown): string | null {
  const msgs = Array.isArray(body) ? (body as unknown[]) : [body]
  for (const m of msgs) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } }
    if (r.method !== 'initialize') continue
    const name = r.params?.clientInfo?.name
    if (typeof name !== 'string' || name.trim() === '') continue
    const version = r.params?.clientInfo?.version
    const label = cleanAgentName(typeof version === 'string' && version !== '' ? `${name} ${version}` : name)
    if (label !== '') return label
  }
  return null
}

/**
 * The checks before the token: a loopback peer, no Origin (no browser page), the exact Host. 403 when one fails, else
 * null.
 */
export function preAuthRefusal(
  o: { remoteAddress: string | undefined; origin: string | undefined; host: string | undefined },
  port: number,
): 403 | null {
  if (!LOOPBACK.has(o.remoteAddress ?? '')) return 403
  if (o.origin !== undefined) return 403
  if (o.host !== `127.0.0.1:${port}`) return 403
  return null
}

export interface McpTimeouts {
  headersMs: number
  requestMs: number
  checkMs: number
}

const DEFAULT_TIMEOUTS: McpTimeouts = {
  headersMs: MCP_HEADERS_TIMEOUT_MS,
  requestMs: MCP_REQUEST_TIMEOUT_MS,
  checkMs: MCP_TIMEOUT_CHECK_MS,
}

interface Route {
  token: Buffer
  spec: McpRouteSpec
}

/** Largest body a proof request may carry (it needs none). */
const PROOF_MAX_BODY = 1024
const PROOF_PATH = new RegExp(`^/mcp/([^/?#]+)/${MCP_PROOF_SUFFIX}(?:[?#].*)?$`)

export class McpHost {
  #server: Server | null = null
  #port = 0
  readonly #routes = new Map<string, Route>()
  readonly #log: Logger
  readonly #fixedPort: number
  readonly #timeouts: McpTimeouts
  /** The key an unknown route's proof is made with (never a token). */
  readonly #decoy = randomBytes(32).toString('base64url')

  /** `port`: listen there (0: any free port). `timeouts`: tests shorten them. */
  constructor(log: Logger, o: { port?: number; timeouts?: Partial<McpTimeouts> } = {}) {
    this.#log = log
    this.#fixedPort = o.port ?? 0
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts }
  }

  get port(): number {
    return this.#port
  }

  get listening(): boolean {
    return this.#server !== null
  }

  /** Start listening (rejects with the listen error, e.g. EADDRINUSE). */
  async listen(): Promise<void> {
    if (this.#server !== null) return
    const t = this.#timeouts
    // A slow or stalled local client cannot hold sockets open.
    const server = createServer(
      { connectionsCheckingInterval: t.checkMs, headersTimeout: t.headersMs, requestTimeout: t.requestMs },
      (req, res) => {
        void this.#handle(req, res)
      },
    )
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 64
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen({ port: this.#fixedPort, host: '127.0.0.1', exclusive: true }, () => {
        server.off('error', onError)
        resolve()
      })
    })
    server.on('error', (err) => this.#log.warn('mcp host error', { err: err.message }))
    this.#port = (server.address() as AddressInfo).port
    this.#server = server
    this.#log.info('mcp host listening', { port: this.#port })
  }

  /** Open (or replace) a route. Its URL is `http://127.0.0.1:<port>/mcp/<name>`. */
  open(name: string, spec: McpRouteSpec): string {
    this.#routes.set(name, { token: digest(spec.token), spec })
    return `http://127.0.0.1:${this.#port}/mcp/${encodeURIComponent(name)}`
  }

  closeRoute(name: string): void {
    this.#routes.delete(name)
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refuse = (status: number, msg: string): void => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' })
      res.end(msg)
    }
    try {
      const pre = preAuthRefusal(
        { remoteAddress: req.socket.remoteAddress, origin: req.headers.origin, host: req.headers.host },
        this.#port,
      )
      if (pre !== null) return refuse(pre, 'forbidden')
      const p = PROOF_PATH.exec(req.url ?? '')
      if (p !== null) return await this.#proof(req, res, p[1] ?? '', refuse)
      const m = /^\/mcp\/([^/?#]+)(?:[?#].*)?$/.exec(req.url ?? '')
      let name: string | undefined
      try {
        name = m?.[1] !== undefined ? decodeURIComponent(m[1]) : undefined
      } catch {
        name = undefined
      }
      const route = name !== undefined ? this.#routes.get(name) : undefined
      const given = bearerOf(req.headers.authorization)
      // Compared even for an unknown route, so both answers take the same time.
      const ok = tokenMatches(given, route?.token ?? digest('\u0000no-route'))
      if (route === undefined || !ok) return refuse(401, 'unauthorized')
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        return refuse(405, 'method not allowed')
      }
      const declared = Number(req.headers['content-length'] ?? '0')
      if (Number.isFinite(declared) && declared > MCP_MAX_BODY) return refuse(413, 'too large')

      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > MCP_MAX_BODY) {
          refuse(413, 'too large')
          req.destroy()
          return
        }
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try {
        body = text === '' ? undefined : JSON.parse(text)
      } catch {
        return refuse(400, 'bad request')
      }
      if (Array.isArray(body) && body.length > MCP_MAX_BATCH) return refuse(400, 'batch too large')
      const call: McpCallContext = { clientName: clientNameOf(body) }
      route.spec.onCall?.(call)

      const server = new McpServer(
        { name: MCP_SERVER_NAME, version: '1.0.0' },
        { instructions: MCP_INSTRUCTIONS },
      )
      route.spec.register(server, call)
      // No session id generator: stateless (every request stands alone, which suits per-request servers).
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      // The SDK's own types disagree with exactOptionalPropertyTypes (onclose?: () => void).
      await server.connect(transport as unknown as Parameters<McpServer['connect']>[0])
      await transport.handleRequest(req, res, body)
    } catch (err) {
      this.#log.warn('mcp request failed', { err: err instanceof Error ? err.message : String(err) })
      refuse(500, 'error')
    }
  }

  /** `POST /mcp/<name>/proof`: the route's proof for the bridge's nonce (see the header). */
  async #proof(
    req: IncomingMessage,
    res: ServerResponse,
    rawName: string,
    refuse: (status: number, msg: string) => void,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return refuse(405, 'method not allowed')
    }
    const nonceHeader = req.headers[MCP_NONCE_HEADER]
    const nonce = typeof nonceHeader === 'string' ? nonceHeader : undefined
    if (!isProofNonce(nonce)) return refuse(400, 'bad request')
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > PROOF_MAX_BODY) {
        refuse(413, 'too large')
        req.destroy()
        return
      }
    }
    let name: string | undefined
    try {
      name = decodeURIComponent(rawName)
    } catch {
      name = undefined
    }
    const route = name !== undefined ? this.#routes.get(name) : undefined
    const key = route?.spec.token ?? this.#decoy
    const proof = serverProof(key, { port: this.#port, route: name ?? rawName, nonce })
    const body = JSON.stringify({ proof })
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async close(): Promise<void> {
    this.#routes.clear()
    const s = this.#server
    this.#server = null
    if (s === null) return
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections()
    })
  }
}
