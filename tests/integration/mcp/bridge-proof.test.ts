// The stdio bridge sends the outside-agent token only to the real app. Before each message it asks the configured port
// for a proof of the token (a fresh nonce, an HMAC bound to the port), and the token goes only on the connection that
// proved itself. Impostor listeners that hold the port while Dim Factory is closed (one that answers anything, one
// that answers like an older app, one that passes the real app's proof through from another port) never see the
// token, and the client is told why; the real app still works, and an HTTP client with the token still connects.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../../../src/core/log.ts'
import { runMcpBridge } from '../../../src/core/mcp/bridge.ts'
import { McpHost } from '../../../src/core/mcp/host.ts'
import { MCP_ROUTE } from '../../../src/core/mcp/instructions.ts'
import { MCP_NONCE_HEADER, isProofNonce, proofMatches, serverProof } from '../../../src/core/mcp/proof.ts'

const TOKEN = 'T0ken_' + 'k'.repeat(40)
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => undefined)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A home whose state.json says outside agents are on, at `port`, with TOKEN. */
function stateFile(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dim-factory-bridge-proof-'))
  dirs.push(dir)
  const file = join(dir, 'state.json')
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, externalMcp: { enabled: true, port, token: TOKEN } }),
  )
  return file
}

async function realHost(): Promise<McpHost> {
  const h = new McpHost(silentLogger)
  await h.listen()
  closers.push(() => h.close())
  h.open(MCP_ROUTE, {
    token: TOKEN,
    register: (server) => {
      server.registerTool('ping', { description: 'ping', inputSchema: {} }, () => ({
        content: [{ type: 'text', text: 'pong' }],
      }))
    },
  })
  return h
}

interface Seen {
  socket: Socket
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

/** A listener on a free port that records everything it is sent and answers with `answer`. */
async function impostor(
  answer: (s: Seen, res: ServerResponse) => void | Promise<void>,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = {
        socket: req.socket,
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(s)
      void answer(s, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r())
        server.closeAllConnections()
      }),
  )
  return { port: (server.address() as AddressInfo).port, seen }
}

/** Run the bridge over one message; its reply lines. */
async function bridge(file: string, msg: object): Promise<string[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  output.on('data', (d: Buffer) =>
    lines.push(
      ...String(d)
        .split('\n')
        .filter((l) => l.trim() !== ''),
    ),
  )
  const done = runMcpBridge({ stateFile: file, input, output })
  input.end(`${JSON.stringify(msg)}\n`)
  expect(await done).toBe(0)
  return lines
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
}

/** Nothing the listener was sent carries the token, in any header or body, nor any Authorization header. */
function expectNoToken(seen: readonly Seen[]): void {
  for (const s of seen) {
    expect(JSON.stringify(s.headers)).not.toContain(TOKEN)
    expect(s.body).not.toContain(TOKEN)
    expect(s.url).not.toContain(TOKEN)
    expect(s.headers.authorization).toBeUndefined()
  }
}

const json = (res: ServerResponse, status: number, obj: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

describe('the bridge proves the app before it sends the token', () => {
  it('the real app proves itself and the message goes through', async () => {
    const h = await realHost()
    const lines = await bridge(stateFile(h.port), INIT)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'dim-factory' } },
    })
  })

  it('an impostor that answers anything gets a nonce and no token', async () => {
    const imp = await impostor((s, res) =>
      json(res, 200, { proof: 'x'.repeat(43), jsonrpc: '2.0', id: 1, result: {} }),
    )
    const lines = await bridge(stateFile(imp.port), INIT)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      id: 1,
      error: { message: expect.stringContaining('could not prove it is Dim Factory') as string },
    })
    // It saw the proof request only: a fresh nonce, no token.
    expect(imp.seen.map((s) => [s.method, s.url])).toEqual([['POST', `/mcp/${MCP_ROUTE}/proof`]])
    expect(isProofNonce(imp.seen[0]!.headers[MCP_NONCE_HEADER] as string)).toBe(true)
    expectNoToken(imp.seen)
  })

  it('an impostor that answers like an older app (401 to the proof) gets no token', async () => {
    const imp = await impostor((_s, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
    })
    const lines = await bridge(stateFile(imp.port), { jsonrpc: '2.0', id: 7, method: 'tools/list' })
    expect(lines[0]).toContain('restart it')
    expectNoToken(imp.seen)
  })

  it('an impostor that passes the real app on another port through gets no token (the proof names the port)', async () => {
    const real = await realHost()
    const imp = await impostor(async (s, res) => {
      // Relay the bridge's proof request, nonce and all, to the real app, and its answer back.
      const r = await fetch(`http://127.0.0.1:${real.port}${s.url}`, {
        method: 'POST',
        headers: { [MCP_NONCE_HEADER]: String(s.headers[MCP_NONCE_HEADER]) },
      })
      json(res, r.status, await r.json())
    })
    const lines = await bridge(stateFile(imp.port), INIT)
    expect(lines[0]).toContain('could not prove it is Dim Factory')
    expect(imp.seen).toHaveLength(1)
    expectNoToken(imp.seen)
  })

  it('the token goes only on a connection that proved itself, even when the app closes one in between', async () => {
    // An app that knows the token but closes the connection after each proof: the bridge proves the next one too.
    const proven = new WeakSet<Socket>()
    const app = await impostor((s, res) => {
      if (s.url.endsWith('/proof')) {
        const nonce = String(s.headers[MCP_NONCE_HEADER])
        proven.add(s.socket)
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ proof: serverProof(TOKEN, { port: app.port, route: MCP_ROUTE, nonce }) }))
        return
      }
      json(res, 200, { jsonrpc: '2.0', id: 1, result: { ok: proven.has(s.socket) } })
    })
    const lines = await bridge(stateFile(app.port), INIT)
    // Every message carrying the token came on a socket that had just proved itself.
    const withToken = app.seen.filter((s) => s.headers.authorization !== undefined)
    for (const s of withToken) expect(proven.has(s.socket)).toBe(true)
    // Here no socket outlived its proof, so the token was never sent and the client is told why.
    expect(withToken).toHaveLength(0)
    expect(lines[0]).toContain('could not prove it is Dim Factory')
  })
})

describe('the proof endpoint', () => {
  async function ask(port: number, path: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers })
  }

  it('answers a nonce with a proof of the token for its own port, and an unknown route with one of no token', async () => {
    const h = await realHost()
    const nonce = 'n'.repeat(43)
    const good = (await (
      await ask(h.port, `/mcp/${MCP_ROUTE}/proof`, { [MCP_NONCE_HEADER]: nonce })
    ).json()) as {
      proof: string
    }
    expect(proofMatches(good.proof, TOKEN, { port: h.port, route: MCP_ROUTE, nonce })).toBe(true)
    expect(proofMatches(good.proof, TOKEN, { port: h.port + 1, route: MCP_ROUTE, nonce })).toBe(false)
    expect(proofMatches(good.proof, 'other-token', { port: h.port, route: MCP_ROUTE, nonce })).toBe(false)
    const other = (await (await ask(h.port, '/mcp/nope/proof', { [MCP_NONCE_HEADER]: nonce })).json()) as {
      proof: string
    }
    expect(proofMatches(other.proof, TOKEN, { port: h.port, route: 'nope', nonce })).toBe(false)
    // No nonce, a bad one, or a browser page: refused before anything is made.
    expect((await ask(h.port, `/mcp/${MCP_ROUTE}/proof`, {})).status).toBe(400)
    expect((await ask(h.port, `/mcp/${MCP_ROUTE}/proof`, { [MCP_NONCE_HEADER]: 'short' })).status).toBe(400)
    expect(
      (
        await ask(h.port, `/mcp/${MCP_ROUTE}/proof`, {
          [MCP_NONCE_HEADER]: nonce,
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403)
  })

  it('an HTTP client with the token still connects as before (no proof needed for the token holder)', async () => {
    const h = await realHost()
    const r = await fetch(`http://127.0.0.1:${h.port}/mcp/${MCP_ROUTE}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(INIT),
    })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('dim-factory')
  })
})
