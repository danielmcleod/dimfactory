// Every Gemini ACP fixture replays through the real resolver and spawn path: the fake CLI,
// resolved as `gemini` from its npm-style shim (system `node <entry>`), replays the recording while a host built on the
// real JsonRpcPeer with the JSON-RPC 2.0 header sends the recorded host frames and answers the agent's
// permission requests with the recorded replies. Proves each fixture is self-consistent (every host frame matched, ids
// mapped, the recorded exit) and that a wrong host frame fails the replay (99), as does an early close (98).
import { describe, expect, it } from 'vitest'
import { JsonRpcError, JsonRpcPeer } from '../../../../src/core/proc/jsonrpc.ts'
import { spawnChild } from '../../../../src/core/proc/spawn.ts'
import type { ChildHandle } from '../../../../src/core/proc/spawn.ts'
import type { AcpRecording } from './helpers.ts'
import { fakeGemini, fixtureIds, loadRecording, messageOf, tempDir, withCwd } from './helpers.ts'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

interface Observed {
  notifications: Record<string, unknown>[]
  results: Map<string, unknown>
  errors: Map<string, { code: number; message: string; data: unknown }>
  exit: { code: number | null; signal: string | null }
  stderr: string[]
}

/** The recorded agent → host traffic of a recording. */
function recordedOut(rec: AcpRecording): {
  notifications: Record<string, unknown>[]
  responses: Map<string, Record<string, unknown>>
} {
  const notifications: Record<string, unknown>[] = []
  const responses = new Map<string, Record<string, unknown>>()
  for (const f of rec.frames) {
    if (f.dir !== 'out') continue
    const m = messageOf(f)
    if (m === undefined || ('method' in m && 'id' in m)) continue
    if (typeof m['method'] === 'string')
      notifications.push(
        'params' in m ? { method: m['method'], params: m['params'] } : { method: m['method'] },
      )
    else responses.set(JSON.stringify(m['id']), m)
  }
  return { notifications, responses }
}

/**
 * Drives one recording as the ACP base would: requests in recorded order through a JsonRpcPeer (header '2.0', its own
 * ids from 1), each awaited but session/prompt (its answer ends the turn, after any session/cancel); notifications
 * sent in order; agent requests answered with the recorded replies; stdin closed at the recorded `eof`. `mutate`
 * rewrites a host message before it is sent; `reply` overrides the answer to an agent request.
 */
async function host(
  rec: AcpRecording,
  o: {
    mutate?: (m: Record<string, unknown>) => Record<string, unknown> | null
    reply?: (id: unknown, recorded: Record<string, unknown>) => unknown
    extraEnv?: Record<string, string>
  } = {},
): Promise<Observed> {
  const cwd = tempDir('acp-replay-cwd-')
  const fake = await fakeGemini(rec.path, o.extraEnv)
  const child = await spawnChild({
    cli: fake.cli,
    args: rec.header.argv.slice(1),
    cwd,
    env: fake.env,
    label: 'gemini-fixture-replay',
  })
  const peer = JsonRpcPeer.fromChild(child, { header: '2.0' })
  const observed: Observed = {
    notifications: [],
    results: new Map(),
    errors: new Map(),
    exit: { code: null, signal: null },
    stderr: [],
  }
  peer.onNotification('*', (params, method) => {
    observed.notifications.push(params === undefined ? { method } : { method, params })
  })
  const replies = new Map<string, Record<string, unknown>>()
  const agentMethods = new Set<string>()
  for (const f of rec.frames) {
    const m = messageOf(f)
    if (m === undefined) continue
    if (f.dir === 'in' && typeof m['method'] !== 'string') replies.set(JSON.stringify(m['id']), m)
    if (f.dir === 'out' && typeof m['method'] === 'string' && 'id' in m) agentMethods.add(String(m['method']))
  }
  for (const method of agentMethods) {
    peer.onRequest(method, (_params, ctx) => {
      const recorded = replies.get(JSON.stringify(ctx.id))
      if (recorded === undefined)
        throw new JsonRpcError(-32601, `no recorded reply to ${method} ${String(ctx.id)}`)
      if (o.reply !== undefined) return o.reply(ctx.id, recorded)
      return recorded['result']
    })
  }
  const notesBefore = (upTo: number): number =>
    rec.frames.slice(0, upTo).filter((f) => {
      const m = f.dir === 'out' ? messageOf(f) : undefined
      return m !== undefined && typeof m['method'] === 'string' && !('id' in m)
    }).length
  const pending: Promise<unknown>[] = []
  let failed = false
  for (const [i, f] of rec.frames.entries()) {
    if (failed) break
    if (f.dir === 'eof') {
      // Like an adapter, close stdin once the turn is over: the prompt answered and every update before the close in.
      await Promise.allSettled(pending)
      for (
        let n = 0;
        n < 400 && observed.notifications.length < notesBefore(i) && child.exitInfo() === null;
        n++
      )
        await new Promise((r) => setTimeout(r, 25))
      child.closeStdin()
      continue
    }
    if (f.dir !== 'in') continue
    const recorded = messageOf(f)
    if (recorded === undefined || typeof recorded['method'] !== 'string') continue
    const sent = o.mutate ? o.mutate(withCwd(recorded, cwd)) : withCwd(recorded, cwd)
    if (sent === null) continue
    const method = String(sent['method'])
    if (!('id' in sent)) {
      await peer.notify(method, sent['params']).catch(() => undefined)
      continue
    }
    const call = peer.request(method, sent['params'], { timeoutMs: 20_000, retry: false }).then(
      (result) => {
        observed.results.set(JSON.stringify(recorded['id']), result)
      },
      (err: unknown) => {
        if (err instanceof JsonRpcError) {
          observed.errors.set(JSON.stringify(recorded['id']), {
            code: err.code,
            message: err.message,
            data: err.data,
          })
          return
        }
        failed = true // the replay failed or the CLI exited: the exit code tells why
      },
    )
    if (method === 'session/prompt') pending.push(call)
    else await call
  }
  const exit = await child.exited
  await Promise.allSettled(pending)
  observed.exit = { code: exit.code, signal: exit.signal }
  observed.stderr = child.stderrTail(40)
  peer.close()
  return observed
}

const ids = fixtureIds()

describe('Gemini ACP fixtures replay through the real resolver and spawn', () => {
  it('finds G01–G10 and the exit-code set', () => {
    const set = new Set(ids.map((d) => d.replace(/[a-z]?-.*/, '')))
    for (let n = 1; n <= 10; n++) expect(set).toContain(`G${String(n).padStart(2, '0')}`)
    for (const code of [41, 42, 44, 52, 53, 54, 55]) expect(set).toContain(`GX${code}`)
  })

  it.each(ids)('%s', async (id) => {
    const rec = loadRecording(id)
    const out = recordedOut(rec)
    const seen = await host(rec)
    expect(seen.stderr.filter((l) => l.startsWith('fake-cli:'))).toEqual([])
    const exit = rec.frames.find((f) => f.dir === 'exit')
    expect(seen.exit.code).toBe(exit?.code ?? 0)
    // Every recorded notification arrives, in order, as recorded (the replayed history of a load included).
    expect(seen.notifications).toEqual(out.notifications)
    // Every response matches the recorded one, error or result, under the host's own ids.
    for (const [key, response] of out.responses) {
      if (isObj(response['error'])) {
        expect(seen.errors.get(key)).toMatchObject({
          code: response['error']['code'],
          message: response['error']['message'],
        })
        expect(seen.errors.get(key)?.data).toEqual(response['error']['data'])
      } else expect(seen.results.get(key)).toEqual(response['result'])
    }
    // The stderr a CLI that died wrote is replayed as recorded.
    const err = rec.frames.filter((f) => f.dir === 'err').map((f) => f.line)
    expect(seen.stderr.filter((l) => !l.startsWith('fake-cli:'))).toEqual(err)
  })
})

describe('the ACP replay is strict', () => {
  const failFast = { FAKE_CLI_TIMEOUT_MS: '4000' }

  it('a read-only pass that allows instead of rejecting fails with exit 99 (G07)', async () => {
    const seen = await host(loadRecording('G07-review-readonly-rejects'), {
      extraEnv: failFast,
      reply: () => ({ outcome: { outcome: 'selected', optionId: 'proceed_once' } }),
    })
    expect(seen.exit.code).toBe(99)
    expect(seen.stderr.join('\n')).toMatch(/optionId/)
  })

  it('another mode than the recorded one fails with exit 99 and names the field', async () => {
    const seen = await host(loadRecording('G07-review-readonly-rejects'), {
      extraEnv: failFast,
      mutate: (m) =>
        m['method'] === 'session/set_mode' && isObj(m['params'])
          ? { ...m, params: { ...m['params'], modeId: 'yolo' } }
          : m,
    })
    expect(seen.exit.code).toBe(99)
    expect(seen.stderr.join('\n')).toMatch(/modeId/)
  })

  it('a session of Dim Factory’s own MCP servers fails (99)', async () => {
    const seen = await host(loadRecording('G02-review-message-chunks'), {
      extraEnv: failFast,
      mutate: (m) =>
        m['method'] === 'session/new' && isObj(m['params'])
          ? { ...m, params: { ...m['params'], mcpServers: [{ name: 'x', command: 'x', args: [], env: [] }] } }
          : m,
    })
    expect(seen.exit.code).toBe(99)
    expect(seen.stderr.join('\n')).toMatch(/mcpServers/)
  })

  it('a frame without the JSON-RPC 2.0 header fails (99)', async () => {
    const rec = loadRecording('G01-handshake-session')
    const child = await spawnRaw(rec, failFast)
    const bare: Record<string, unknown> = { ...messageOf(rec.frames.find((f) => f.dir === 'in')!) }
    delete bare['jsonrpc']
    await child.handle.writeLine(bare)
    const exit = await child.handle.exited
    expect(exit.code).toBe(99)
    expect(child.handle.stderrTail(20).join('\n')).toMatch(/jsonrpc/)
  })

  it('a request the recording does not have (authenticate) fails at the exit (99)', async () => {
    const rec = loadRecording('G01-handshake-session')
    const child = await spawnRaw(rec, failFast)
    await child.handle.writeLine({
      jsonrpc: '2.0',
      id: 900,
      method: 'authenticate',
      params: { methodId: 'oauth-personal' },
    })
    for (const f of rec.frames) {
      if (f.dir === 'eof') child.handle.closeStdin()
      const m = f.dir === 'in' ? messageOf(f) : undefined
      if (m !== undefined) await child.handle.writeLine(withCwd(m, child.cwd))
    }
    const exit = await child.handle.exited
    expect(exit.code).toBe(99)
    expect(child.handle.stderrTail(20).join('\n')).toMatch(
      /client messages the recording does not have[\s\S]*authenticate/,
    )
  })

  it('stdin closed before the recording expects it fails with exit 98', async () => {
    const rec = loadRecording('G02-review-message-chunks')
    const child = await spawnRaw(rec, failFast)
    for (const f of rec.frames) {
      const m = f.dir === 'in' ? messageOf(f) : undefined
      if (m === undefined) continue
      if (m['method'] === 'session/prompt') break
      await child.handle.writeLine(withCwd(m, child.cwd))
    }
    child.handle.closeStdin()
    const exit = await child.handle.exited
    expect(exit.code).toBe(98)
    expect(child.handle.stderrTail(20).join('\n')).toMatch(/stdin closed during replay/)
  })

  it("the host's own request ids, numeric or string, are echoed in every response", async () => {
    const idSchemes: ((n: number) => number | string)[] = [(n) => n + 100, (n) => `req-${n}`]
    for (const mine of idSchemes) {
      const rec = loadRecording('G04-permission-allow-once')
      const child = await spawnRaw(rec, { FAKE_CLI_TIMEOUT_MS: '8000' })
      const lines: Record<string, unknown>[] = []
      const reading = (async () => {
        for await (const l of child.handle.lines('stdout'))
          lines.push(JSON.parse(l) as Record<string, unknown>)
      })()
      const waitFor = async (pred: (m: Record<string, unknown>) => boolean): Promise<void> => {
        for (let i = 0; i < 400 && !lines.some(pred); i++) await new Promise((r) => setTimeout(r, 25))
      }
      for (const f of rec.frames) {
        if (f.dir === 'eof') {
          await waitFor((x) => x['id'] === mine(4) && !('method' in x))
          child.handle.closeStdin()
        }
        const m = f.dir === 'in' ? messageOf(f) : undefined
        if (m === undefined) continue
        if (typeof m['method'] === 'string') {
          const id = mine(Number(m['id']))
          await child.handle.writeLine({ ...withCwd(m, child.cwd), id })
          if (m['method'] !== 'session/prompt') await waitFor((x) => x['id'] === id && !('method' in x))
        } else {
          await waitFor((x) => typeof x['method'] === 'string' && x['id'] === m['id'])
          await child.handle.writeLine(m)
        }
      }
      const exit = await child.handle.exited
      await reading
      expect(child.handle.stderrTail(20).filter((l) => l.startsWith('fake-cli:'))).toEqual([])
      expect(exit.code).toBe(0)
      const responses = lines.filter((x) => !('method' in x))
      expect(responses.map((r) => r['id'])).toEqual([1, 2, 3, 4].map(mine))
      for (const r of lines) expect(r['jsonrpc']).toBe('2.0')
    }
  })
})

interface RawChild {
  handle: ChildHandle
  cwd: string
}

async function spawnRaw(rec: AcpRecording, extraEnv: Record<string, string> = {}): Promise<RawChild> {
  const cwd = tempDir('acp-replay-raw-')
  const fake = await fakeGemini(rec.path, extraEnv)
  const handle = await spawnChild({
    cli: fake.cli,
    args: rec.header.argv.slice(1),
    cwd,
    env: fake.env,
    label: 'gemini-raw',
  })
  return { handle, cwd }
}
