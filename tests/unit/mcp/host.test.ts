// The outside-agent MCP host's request checks: loopback peers only, no Origin, the exact Host, a constant-time token
// check that answers an unknown route and a wrong token alike, POST only, a 4 MB body cap, and a well-formed JSON body;
// a request that passes them all reaches a fresh MCP server with Dim Factory's name and instructions.
import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../../../src/core/log.ts'
import {
  MCP_MAX_BATCH,
  MCP_MAX_BODY,
  McpHost,
  bearerOf,
  cleanAgentName,
  clientNameOf,
  preAuthRefusal,
  tokenMatches,
} from '../../../src/core/mcp/host.ts'
import type { McpTimeouts } from '../../../src/core/mcp/host.ts'
import { connect } from 'node:net'
import { MCP_INSTRUCTIONS } from '../../../src/core/mcp/instructions.ts'
import { createHash } from 'node:crypto'

const TOKEN = 'a'.repeat(43)
const hosts: McpHost[] = []
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close()
})

async function host(
  timeouts?: Partial<McpTimeouts>,
): Promise<{ h: McpHost; calls: string[]; tools: string[] }> {
  const h = new McpHost(silentLogger, timeouts !== undefined ? { timeouts } : {})
  hosts.push(h)
  await h.listen()
  const calls: string[] = []
  const tools: string[] = []
  h.open('dim-factory', {
    token: TOKEN,
    onCall: (c) => calls.push(c.clientName ?? '-'),
    register: (server) => {
      server.registerTool('ping', { description: 'ping', inputSchema: {} }, () => {
        tools.push('ping')
        return { content: [{ type: 'text', text: 'pong' }] }
      })
    },
  })
  return { h, calls, tools }
}

interface Reply {
  status: number
  text: string
}

function send(
  port: number,
  o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: o.method ?? 'POST',
        path: o.path ?? '/mcp/dim-factory',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...o.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end(o.body)
  })
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'Test agent', version: '1.2' },
  },
})
const auth = { authorization: `Bearer ${TOKEN}` }

describe('preAuthRefusal', () => {
  it('refuses a peer that is not loopback, an Origin, and any other Host', () => {
    const ok = { remoteAddress: '127.0.0.1', origin: undefined, host: '127.0.0.1:5000' }
    expect(preAuthRefusal(ok, 5000)).toBeNull()
    expect(preAuthRefusal({ ...ok, remoteAddress: '::ffff:127.0.0.1' }, 5000)).toBeNull()
    expect(preAuthRefusal({ ...ok, remoteAddress: '192.168.1.20' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, remoteAddress: '::1' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, remoteAddress: undefined }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, origin: 'https://evil.example' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, origin: 'null' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, host: 'localhost:5000' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, host: 'evil.example:5000' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, host: '127.0.0.1:5001' }, 5000)).toBe(403)
    expect(preAuthRefusal({ ...ok, host: undefined }, 5000)).toBe(403)
  })
})

describe('token checks', () => {
  it('reads a bearer token and compares it in constant time over digests', () => {
    expect(bearerOf(undefined)).toBe('')
    expect(bearerOf('Basic abc')).toBe('')
    expect(bearerOf(`Bearer ${TOKEN}`)).toBe(TOKEN)
    const want = createHash('sha256').update(TOKEN).digest()
    expect(tokenMatches(TOKEN, want)).toBe(true)
    expect(tokenMatches('', want)).toBe(false)
    expect(tokenMatches(TOKEN.slice(1), want)).toBe(false)
    expect(tokenMatches(`${TOKEN}b`, want)).toBe(false)
  })

  it('reads the client name from an initialize request only', () => {
    expect(clientNameOf(JSON.parse(INIT))).toBe('Test agent 1.2')
    expect(clientNameOf({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toBeNull()
    expect(clientNameOf([JSON.parse(INIT)])).toBe('Test agent 1.2')
    expect(
      clientNameOf({ method: 'initialize', params: { clientInfo: { name: 'a\nb\u0007', version: '' } } }),
    ).toBe('a b')
  })

  it('makes control, line and invisible format characters (bidi overrides) spaces in an agent name', () => {
    expect(cleanAgentName('  Claude\u202Eexe.txt\u2066x\u200B\u2028y\u0000 ')).toBe('Claude exe.txt x  y')
    expect(cleanAgentName('\u202E\u202C')).toBe('')
    expect(cleanAgentName('é'.repeat(100))).toHaveLength(80)
    expect(
      clientNameOf({
        method: 'initialize',
        params: { clientInfo: { name: 'Codex\u202Etxt.exe', version: '1' } },
      }),
    ).toBe('Codex txt.exe 1')
    expect(
      clientNameOf({ method: 'initialize', params: { clientInfo: { name: '\u202E', version: '' } } }),
    ).toBeNull()
  })
})

describe('McpHost over HTTP', () => {
  it('listens on 127.0.0.1 only', async () => {
    const { h } = await host()
    expect(h.listening).toBe(true)
    expect(h.port).toBeGreaterThan(0)
  })

  it('answers a good initialize with Dim Factory’s server name and instructions', async () => {
    const { h, calls } = await host()
    const r = await send(h.port, { headers: auth, body: INIT })
    expect(r.status).toBe(200)
    const body = JSON.parse(r.text) as { result: { serverInfo: { name: string }; instructions: string } }
    expect(body.result.serverInfo.name).toBe('dim-factory')
    expect(body.result.instructions).toBe(MCP_INSTRUCTIONS)
    expect(calls).toEqual(['Test agent 1.2'])
  })

  it('refuses an Origin (a browser page) and a wrong Host with 403, before the token', async () => {
    const { h, calls } = await host()
    expect(
      (await send(h.port, { headers: { ...auth, origin: 'http://127.0.0.1' }, body: INIT })).status,
    ).toBe(403)
    expect(
      (await send(h.port, { headers: { ...auth, host: `localhost:${h.port}` }, body: INIT })).status,
    ).toBe(403)
    expect((await send(h.port, { headers: { ...auth, host: 'evil.example' }, body: INIT })).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('answers 401 alike for no token, a wrong token and an unknown route', async () => {
    const { h, calls } = await host()
    expect((await send(h.port, { body: INIT })).status).toBe(401)
    expect((await send(h.port, { headers: { authorization: 'Bearer nope' }, body: INIT })).status).toBe(401)
    expect((await send(h.port, { headers: { authorization: `Bearer ${TOKEN}x` }, body: INIT })).status).toBe(
      401,
    )
    expect((await send(h.port, { headers: { authorization: TOKEN }, body: INIT })).status).toBe(401)
    expect((await send(h.port, { path: '/mcp/other', headers: auth, body: INIT })).status).toBe(401)
    expect((await send(h.port, { path: '/', headers: auth, body: INIT })).status).toBe(401)
    expect((await send(h.port, { path: '/mcp/%E0%A4%A', headers: auth, body: INIT })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('takes POST only', async () => {
    const { h } = await host()
    for (const method of ['GET', 'DELETE', 'PUT']) {
      expect((await send(h.port, { method, headers: auth })).status).toBe(405)
    }
  })

  it('refuses a body over 4 MB, declared or streamed', async () => {
    const { h, calls } = await host()
    const big = Buffer.alloc(MCP_MAX_BODY + 1, 0x20)
    // The host answers 413 and closes at once; a client still writing may see the reset first.
    const declared = await send(h.port, { headers: auth, body: big }).then(
      (r) => r.status,
      (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? 413 : 0),
    )
    expect(declared).toBe(413)
    // Streamed without a length (chunked): cut once it passes the cap.
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: h.port,
          method: 'POST',
          path: '/mcp/dim-factory',
          headers: { ...auth, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', (err: NodeJS.ErrnoException) =>
        err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve(413) : reject(err),
      )
      const chunk = Buffer.alloc(1024 * 1024, 0x20)
      for (let i = 0; i < 5; i++) req.write(chunk)
      req.end()
    })
    expect(streamed).toBe(413)
    expect(calls).toEqual([])
  })

  it(`answers 400 for a JSON-RPC batch of more than ${MCP_MAX_BATCH} messages, before any tool runs`, async () => {
    const { h, calls, tools } = await host()
    const old = { ...auth, 'mcp-protocol-version': '2025-03-26' }
    const ping = (id: number): object => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    })
    const small = await send(h.port, { headers: old, body: JSON.stringify([ping(1), ping(2)]) })
    expect(small.status).toBe(200)
    expect(tools).toEqual(['ping', 'ping'])
    const big = Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => ping(i + 10))
    const r = await send(h.port, { headers: old, body: JSON.stringify(big) })
    expect(r).toEqual({ status: 400, text: 'batch too large' })
    expect(tools).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('closes a connection whose headers never finish soon after the header timeout', async () => {
    const { h } = await host({ headersMs: 300, requestMs: 600, checkMs: 100 })
    const t0 = Date.now()
    const closedAfter = await new Promise<number>((resolve) => {
      const s = connect({ host: '127.0.0.1', port: h.port })
      s.on('error', () => undefined)
      const CRLF = String.fromCharCode(13, 10)
      s.write(`POST /mcp/dim-factory HTTP/1.1${CRLF}host: 127.0.0.1:${h.port}${CRLF}`)
      // One more header line now and then: never the blank line that ends them.
      const iv = setInterval(() => s.write(`x-a: b${CRLF}`), 100)
      s.on('close', () => {
        clearInterval(iv)
        resolve(Date.now() - t0)
      })
      setTimeout(() => s.destroy(), 5_000)
    })
    expect(closedAfter).toBeLessThan(2_000)
  })

  it('answers 400 for a body that is not JSON', async () => {
    const { h } = await host()
    expect((await send(h.port, { headers: auth, body: '{nope' })).status).toBe(400)
  })

  it('stops answering once the route or the host is closed', async () => {
    const { h } = await host()
    h.closeRoute('dim-factory')
    expect((await send(h.port, { headers: auth, body: INIT })).status).toBe(401)
    const port = h.port
    await h.close()
    await expect(send(port, { headers: auth, body: INIT })).rejects.toThrow()
  })

  it('reports a port in use when listening', async () => {
    const { h } = await host()
    const other = new McpHost(silentLogger, { port: h.port })
    hosts.push(other)
    await expect(other.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(other.listening).toBe(false)
  })
})
