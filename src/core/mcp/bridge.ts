// `Dim Factory --mcp`: a stdio MCP server for clients that run a command (Codex plugins, Claude Code and Desktop, VS Code,
// Cursor). Each JSON-RPC line from stdin goes to the running app's outside-agent endpoint (loopback, with the port and
// token read from DIM_FACTORY_HOME/state.json for every message, so a new token works at once); each reply goes to
// stdout. The client's configuration holds no token. When Dim Factory is not running or outside agents are off,
// requests get an error that says what to do. Nothing here takes the home lock or writes to the home.
//
// The token goes only to the real app: before each message the bridge asks the port for a proof of the token
// (proof.ts: a fresh nonce, answered with an HMAC only a holder of the token can make, bound to the port), and sends
// the token only on the very connection that proved itself (one keep-alive socket; a request that would go out on any
// other socket is dropped before a byte is written and the check runs again). A listener that holds the port while
// Dim Factory is closed gets a nonce and nothing else, and the client is told why.
import { readFile } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import type { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { MCP_ROUTE } from './instructions.ts'
import { MCP_NONCE_HEADER, MCP_PROOF_SUFFIX, newProofNonce, proofMatches } from './proof.ts'
import { externalMcpOf } from './state.ts'

/** How long one message may wait for the app. */
export const BRIDGE_TIMEOUT_MS = 120_000
/** How long the app has to prove itself. */
export const BRIDGE_PROOF_TIMEOUT_MS = 10_000
/** Largest proof answer read. */
const MAX_PROOF = 4096
/** Largest line the bridge relays (the endpoint's own cap). */
const MAX_LINE = 4 * 1024 * 1024

export const BRIDGE_NOT_SET_UP =
  'Dim Factory has not been set up on this computer yet. Open Dim Factory, then turn on Settings, Outside agents.'
export const BRIDGE_OFF =
  'Outside agents are turned off in Dim Factory. Turn them on in Settings, Outside agents.'
export const BRIDGE_NOT_RUNNING = 'Dim Factory is not running. Open Dim Factory and try again.'
export const BRIDGE_REFUSED =
  'Dim Factory refused the token. Check that outside agents are on, and that this is the same computer and account.'
/** Something answers on the port but cannot prove it is Dim Factory: the token was not sent. */
export const bridgeUnverified = (port: number): string =>
  `Something on port ${port} answered but could not prove it is Dim Factory, so the bridge did not send its token. ` +
  'If Dim Factory was just updated, restart it. Otherwise another program holds the port: pick another port in Settings, Outside agents.'

/** A request that would have left on a socket that never proved itself (nothing was written on it). */
class UnprovenSocket extends Error {}

interface Endpoint {
  port: number
  token: string
}

async function endpoint(stateFile: string): Promise<Endpoint | string> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    return BRIDGE_NOT_SET_UP
  }
  const ext = externalMcpOf(raw)
  if (!ext.enabled || ext.token === null) return BRIDGE_OFF
  return { port: ext.port, token: ext.token }
}

/** The bridge's one connection to the app, and which of its sockets proved they are the app. */
interface Link {
  agent: Agent
  proven: WeakSet<Socket>
}

/**
 * Ask the port for its proof (no token is sent). `ok`: the socket that answered is the app's and is remembered;
 * `unproven`: it answered without a valid proof. Rejects when nothing answers (not running).
 */
function prove(link: Link, ep: Endpoint): Promise<'ok' | 'unproven'> {
  const nonce = newProofNonce()
  return new Promise((resolve, reject) => {
    let socket: Socket | undefined
    const req = request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: `/mcp/${MCP_ROUTE}/${MCP_PROOF_SUFFIX}`,
        method: 'POST',
        agent: link.agent,
        headers: { host: `127.0.0.1:${ep.port}`, [MCP_NONCE_HEADER]: nonce, 'content-length': 0 },
        timeout: BRIDGE_PROOF_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size <= MAX_PROOF) chunks.push(c)
        })
        res.on('end', () => {
          let given: unknown
          try {
            given = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { proof?: unknown }).proof
          } catch {
            given = undefined
          }
          const ok =
            res.statusCode === 200 &&
            size <= MAX_PROOF &&
            proofMatches(given, ep.token, { port: ep.port, route: MCP_ROUTE, nonce })
          if (ok && socket !== undefined) link.proven.add(socket)
          resolve(ok ? 'ok' : 'unproven')
        })
        res.on('error', reject)
      },
    )
    req.on('socket', (s: Socket) => {
      socket = s
    })
    req.on('timeout', () => req.destroy(new Error('Dim Factory did not answer in time.')))
    req.on('error', reject)
    req.end()
  })
}

/** The message, with the token, on a socket that proved itself (UnprovenSocket, nothing sent, on any other). */
function post(link: Link, ep: Endpoint, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: `/mcp/${MCP_ROUTE}`,
        method: 'POST',
        agent: link.agent,
        headers: {
          host: `127.0.0.1:${ep.port}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${ep.token}`,
          'content-length': Buffer.byteLength(body),
        },
        timeout: BRIDGE_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('Dim Factory did not answer in time.')))
    req.on('error', reject)
    // Headers and body are written only by end(): a socket that never proved itself gets nothing at all.
    req.on('socket', (s: Socket) => {
      if (link.proven.has(s)) req.end(body)
      else req.destroy(new UnprovenSocket())
    })
  })
}

/** Prove, then send; once more when the proven socket closed in between (the keep-alive ended). */
async function send(
  link: Link,
  ep: Endpoint,
  body: string,
): Promise<{ status: number; text: string } | 'unproven'> {
  for (let attempt = 0; ; attempt++) {
    if ((await prove(link, ep)) !== 'ok') return 'unproven'
    try {
      return await post(link, ep, body)
    } catch (err) {
      if (!(err instanceof UnprovenSocket) || attempt >= 1) throw err
    }
  }
}

/** JSON-RPC replies from a JSON or an SSE response body. */
export function replies(text: string): string[] {
  const t = text.trim()
  if (t === '') return []
  if (t.startsWith('{') || t.startsWith('[')) return [t.replace(/\r?\n/g, ' ')]
  return t
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((l) => l !== '')
}

/** Relay stdin to the app until stdin closes. Resolves with the exit code. */
export async function runMcpBridge(o: {
  stateFile: string
  input: Readable
  output: Writable
}): Promise<number> {
  const write = (obj: unknown): void =>
    void o.output.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`)
  const fail = (id: unknown, message: string): void => {
    // A notification (no id) gets no reply, as JSON-RPC wants.
    if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } })
  }
  const lines = createInterface({ input: o.input, crlfDelay: Infinity })
  // One socket per port, kept alive: the proof and the message share it.
  const link: Link = {
    agent: new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }),
    proven: new WeakSet(),
  }
  try {
    await relay(lines, link, o.stateFile, write, fail)
  } finally {
    link.agent.destroy()
  }
  return 0
}

async function relay(
  lines: AsyncIterable<string>,
  link: Link,
  stateFile: string,
  write: (obj: unknown) => void,
  fail: (id: unknown, message: string) => void,
): Promise<void> {
  for await (const line of lines) {
    const body = line.trim()
    if (body === '') continue
    if (body.length > MAX_LINE) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } })
      continue
    }
    let id: unknown
    try {
      const parsed = JSON.parse(body) as unknown
      id = Array.isArray(parsed) ? undefined : (parsed as { id?: unknown } | null)?.id
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    const ep = await endpoint(stateFile)
    if (typeof ep === 'string') {
      fail(id, ep)
      continue
    }
    try {
      const r = await send(link, ep, body)
      if (r === 'unproven') fail(id, bridgeUnverified(ep.port))
      else if (r.status === 401) fail(id, BRIDGE_REFUSED)
      else if (r.status >= 400) fail(id, `Dim Factory answered ${r.status}: ${r.text.slice(0, 200)}`)
      else for (const reply of replies(r.text)) write(reply)
    } catch (err) {
      fail(id, err instanceof UnprovenSocket ? bridgeUnverified(ep.port) : BRIDGE_NOT_RUNNING)
    }
  }
}
