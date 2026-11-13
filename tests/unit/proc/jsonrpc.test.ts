import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  JsonRpcError,
  JsonRpcPeer,
  JsonRpcPeerError,
  METHOD_NOT_FOUND,
  SERVER_OVERLOADED,
} from '../../../src/core/proc/jsonrpc.ts'
import type { JsonRpcPeerOptions, RpcStreamError } from '../../../src/core/proc/jsonrpc.ts'

/** The far side: reads what the peer writes, writes what the peer reads. */
class Remote {
  readonly toPeer = new PassThrough()
  readonly fromPeer = new PassThrough()
  readonly received: Record<string, unknown>[] = []
  private buffer = ''
  private readonly waiters: (() => void)[] = []

  constructor() {
    this.fromPeer.setEncoding('utf8')
    this.fromPeer.on('data', (chunk: string) => {
      this.buffer += chunk
      let nl = this.buffer.indexOf('\n')
      while (nl !== -1) {
        this.received.push(JSON.parse(this.buffer.slice(0, nl)) as Record<string, unknown>)
        this.buffer = this.buffer.slice(nl + 1)
        nl = this.buffer.indexOf('\n')
      }
      for (const w of this.waiters.splice(0)) w()
    })
  }

  send(frame: unknown): void {
    this.toPeer.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`)
  }

  async next(
    predicate: (f: Record<string, unknown>) => boolean = () => true,
    from = 0,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const hit = this.received.slice(from).find(predicate)
      if (hit !== undefined) return hit
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }

  peer(opts: Partial<JsonRpcPeerOptions> = {}): JsonRpcPeer {
    return JsonRpcPeer.fromStreams(this.toPeer, this.fromPeer, { header: 'omit', ...opts })
  }
}

const peers: JsonRpcPeer[] = []
afterEach(() => {
  for (const p of peers.splice(0)) p.close()
})
function setup(opts: Partial<JsonRpcPeerOptions> = {}): { remote: Remote; peer: JsonRpcPeer } {
  const remote = new Remote()
  const peer = remote.peer(opts)
  peers.push(peer)
  return { remote, peer }
}

describe('JsonRpcPeer', () => {
  it('omits the jsonrpc header for Codex and correlates responses by id', async () => {
    const { remote, peer } = setup()
    const a = peer.request<{ v: number }>('a', { x: 1 })
    const b = peer.request('b')
    const fa = await remote.next((f) => f['method'] === 'a')
    const fb = await remote.next((f) => f['method'] === 'b')
    expect(fa).toEqual({ id: 1, method: 'a', params: { x: 1 } })
    expect(fb).toEqual({ id: 2, method: 'b' })
    remote.send({ id: 2, result: 'B' })
    remote.send({ jsonrpc: '2.0', id: 1, result: { v: 7 } })
    expect(await a).toEqual({ v: 7 })
    expect(await b).toBe('B')
  })

  it("adds jsonrpc:'2.0' for ACP, including notifications and replies", async () => {
    const { remote, peer } = setup({ header: '2.0' })
    await peer.notify('session/cancel', { sessionId: 's' })
    peer.onRequest('fs/read', () => ({ content: 'x' }))
    remote.send({ jsonrpc: '2.0', id: 'srv-1', method: 'fs/read', params: {} })
    await remote.next((f) => f['id'] === 'srv-1')
    expect(remote.received).toEqual([
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } },
      { jsonrpc: '2.0', id: 'srv-1', result: { content: 'x' } },
    ])
  })

  it('answers unknown server requests with -32601 and handler failures with an error reply', async () => {
    const { remote, peer } = setup()
    peer.onRequest('explode', () => {
      throw new Error('boom')
    })
    peer.onRequest('typed', () => {
      throw new JsonRpcError(-32000, 'not supported by Dim Factory', { why: 'x' })
    })
    peer.onRequest('async', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return undefined
    })
    remote.send({ id: 10, method: 'item/tool/call', params: {} })
    remote.send({ id: 11, method: 'explode' })
    remote.send({ id: 12, method: 'typed' })
    remote.send({ id: 13, method: 'async' })
    await remote.next((f) => f['id'] === 13)
    const byId = new Map(remote.received.map((f) => [f['id'], f]))
    expect(byId.get(10)).toEqual({
      id: 10,
      error: { code: METHOD_NOT_FOUND, message: 'Method not found: item/tool/call' },
    })
    expect(byId.get(11)).toEqual({ id: 11, error: { code: -32603, message: 'boom' } })
    expect(byId.get(12)).toEqual({
      id: 12,
      error: { code: -32000, message: 'not supported by Dim Factory', data: { why: 'x' } },
    })
    expect(byId.get(13)).toEqual({ id: 13, result: null })
  })

  it('delivers notifications to method and wildcard listeners', async () => {
    const { remote, peer } = setup()
    const seen: string[] = []
    peer.onNotification('turn/started', (p) => seen.push(`exact:${JSON.stringify(p)}`))
    const off = peer.onNotification('*', (_p, m) => seen.push(`any:${m}`))
    remote.send({ method: 'turn/started', params: { id: 1 } })
    remote.send({ method: 'item/agentMessage/delta', params: {} })
    await new Promise((r) => setTimeout(r, 20))
    off()
    remote.send({ method: 'later' })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['exact:{"id":1}', 'any:turn/started', 'any:item/agentMessage/delta'])
  })

  it('onResult sees the result before a notification read with it in one chunk (the await may not)', async () => {
    const { remote, peer } = setup()
    const order: string[] = []
    peer.onNotification('usage', (p) => order.push(`notification:${JSON.stringify(p)}`))
    const r = peer
      .request('turn/start', {}, { onResult: (v) => order.push(`onResult:${JSON.stringify(v)}`) })
      .then((v) => order.push(`await:${JSON.stringify(v)}`))
    const sent = await remote.next((f) => f['method'] === 'turn/start')
    // One write, as a pipe read on Linux delivers it: the response and the notification behind it.
    remote.toPeer.write(
      `${JSON.stringify({ id: sent['id'], result: { turn: 't1' } })}\n${JSON.stringify({ method: 'usage', params: 1 })}\n`,
    )
    await r
    // The awaited result is a few microtasks behind (each line comes through an async generator): it may land on
    // either side of the notification, the hook never does.
    expect(order.filter((o) => !o.startsWith('await:'))).toEqual(['onResult:{"turn":"t1"}', 'notification:1'])
    expect(order).toContain('await:{"turn":"t1"}')
    // An error response never calls it; a throwing hook does not lose the result.
    const failed = peer.request('x', {}, { onResult: () => order.push('wrong') }).catch((e: unknown) => e)
    const fx = await remote.next((f) => f['method'] === 'x')
    remote.send({ id: fx['id'], error: { code: -32600, message: 'no' } })
    expect(await failed).toBeInstanceOf(JsonRpcError)
    const thrown = peer.request(
      'y',
      {},
      {
        onResult: () => {
          throw new Error('hook')
        },
      },
    )
    const fy = await remote.next((f) => f['method'] === 'y')
    remote.send({ id: fy['id'], result: 'Y' })
    expect(await thrown).toBe('Y')
    expect(order).not.toContain('wrong')
  })

  it('retries -32001 at the configured delays with fresh ids, then gives up', async () => {
    const { remote, peer } = setup({ retryDelaysMs: [20, 40] })
    const started = Date.now()
    const call = peer.request('turn/start', { t: 1 })
    for (let i = 0; i < 3; i++) {
      const frame = await remote.next((f) => f['method'] === 'turn/start', i)
      remote.send({ id: frame['id'], error: { code: SERVER_OVERLOADED, message: 'overloaded' } })
    }
    await expect(call).rejects.toMatchObject({ code: SERVER_OVERLOADED, method: 'turn/start' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
    expect(remote.received.map((f) => f['id'])).toEqual([1, 2, 3])

    const second = peer.request('turn/start', {}, { retry: false })
    const f = await remote.next((x) => x['id'] === 4)
    remote.send({ id: f['id'], error: { code: SERVER_OVERLOADED, message: 'overloaded' } })
    await expect(second).rejects.toBeInstanceOf(JsonRpcError)
  })

  it('a retried request succeeds when the server recovers', async () => {
    const { remote, peer } = setup({ retryDelaysMs: [10] })
    const call = peer.request('x')
    const first = await remote.next()
    remote.send({ id: first['id'], error: { code: SERVER_OVERLOADED, message: 'busy' } })
    const second = await remote.next(() => true, 1)
    remote.send({ id: second['id'], result: 'ok' })
    expect(await call).toBe('ok')
  })

  it('raises stream_malformed after three consecutive unparseable lines', async () => {
    const { remote, peer } = setup()
    const errors: RpcStreamError[] = []
    peer.onError((e) => errors.push(e))
    remote.send('garbage 1')
    remote.send('garbage 2')
    remote.send({ method: 'ok' }) // resets the streak
    remote.send('[1,2]')
    remote.send('{"unterminated":')
    remote.send('plain text')
    remote.send('more text')
    remote.send({ id: 999, result: null })
    await new Promise((r) => setTimeout(r, 30))
    expect(errors.map((e) => [e.category, e.reason])).toEqual([
      ['stream_malformed', 'malformed'],
      ['stream_malformed', 'unknown-response-id'],
    ])
    expect(errors[0]?.lines).toEqual(['[1,2]', '{"unterminated":', 'plain text'])
  })

  it('times out a request and rejects pending ones when the stream closes', async () => {
    const { remote, peer } = setup()
    await expect(peer.request('slow', undefined, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'timeout',
    })
    const pending = peer.request('never')
    let closed = false
    peer.onClose(() => {
      closed = true
    })
    remote.toPeer.end()
    await expect(pending).rejects.toBeInstanceOf(JsonRpcPeerError)
    await peer.done
    expect(closed).toBe(true)
    await expect(peer.request('after')).rejects.toMatchObject({ kind: 'closed' })
  })

  it('a reply after a local timeout is dropped quietly; only never-issued ids are stream errors', async () => {
    const { remote, peer } = setup()
    const errors: RpcStreamError[] = []
    peer.onError((e) => errors.push(e))
    const slow = peer.request('slow', undefined, { timeoutMs: 20 })
    const sent = await remote.next((f) => f['method'] === 'slow')
    await expect(slow).rejects.toMatchObject({ kind: 'timeout' })
    remote.send({ id: sent['id'], result: { ok: true } })
    remote.send({ id: sent['id'], result: { ok: true } }) // a second copy is no longer expected
    remote.send({ id: 4242, result: null })
    await new Promise((r) => setTimeout(r, 30))
    expect(errors.map((e) => [e.reason, e.lines[0]])).toEqual([
      ['unknown-response-id', JSON.stringify({ id: sent['id'], result: { ok: true } })],
      ['unknown-response-id', JSON.stringify({ id: 4242, result: null })],
    ])
  })
})
