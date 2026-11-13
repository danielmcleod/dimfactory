// Every Codex fixture replays through the real resolver and spawn path: the fake CLI,
// resolved as `codex` from its shim, replays the recording while a host built on the real JsonRpcPeer (app-server)
// or ChildHandle (exec) sends the recorded host frames. Proves each fixture is self-consistent (every host frame is
// matched, ids are masked and mapped, the exit is the recorded one) and that a wrong host frame fails the replay.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonRpcError, JsonRpcPeer } from '../../../../src/core/proc/jsonrpc.ts'
import { stopChild } from '../../../../src/core/proc/kill.ts'
import { spawnChild } from '../../../../src/core/proc/spawn.ts'
import type { ChildHandle } from '../../../../src/core/proc/spawn.ts'
import type { CodexFrame, CodexRecording } from './helpers.ts'
import { fakeCodex, fixtureIds, loadCodexRecording, messageOf, tempDir, withCwd } from './helpers.ts'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

interface Observed {
  notifications: Record<string, unknown>[]
  results: Map<string, unknown>
  errors: Map<string, { code: number; message: string }>
  exit: { code: number | null; signal: string | null }
  stderr: string[]
}

/** The recorded server → client traffic of an app-server recording. */
function recordedOut(rec: CodexRecording): {
  notifications: Record<string, unknown>[]
  responses: Map<string, Record<string, unknown>>
  requests: Map<string, Record<string, unknown>>
} {
  const notifications: Record<string, unknown>[] = []
  const responses = new Map<string, Record<string, unknown>>()
  const requests = new Map<string, Record<string, unknown>>()
  for (const f of rec.frames) {
    if (f.dir !== 'out') continue
    const m = messageOf(f)
    if (m === undefined) continue
    if (typeof m['method'] === 'string' && 'id' in m) requests.set(JSON.stringify(m['id']), m)
    // The peer hands over method and params (the envelope's emittedAtMs is not part of the notification).
    else if (typeof m['method'] === 'string')
      notifications.push(
        'params' in m ? { method: m['method'], params: m['params'] } : { method: m['method'] },
      )
    else responses.set(JSON.stringify(m['id']), m)
  }
  return { notifications, responses, requests }
}

/**
 * Drives one app-server recording as Dim Factory's host would: requests and notifications in recorded order through a
 * JsonRpcPeer (its own ids, from 1), server requests answered with the recorded replies, stdin closed at the
 * recorded `eof`. `mutate` rewrites a host message before it is sent (the negative tests).
 */
async function hostAppServer(
  rec: CodexRecording,
  o: {
    mutate?: (m: Record<string, unknown>) => Record<string, unknown> | null
    extraEnv?: Record<string, string>
  } = {},
): Promise<Observed> {
  const cwd = tempDir('codex-replay-cwd-')
  const fake = await fakeCodex(rec.path, o.extraEnv)
  const child = await spawnChild({
    cli: fake.cli,
    args: rec.header.argv.slice(1),
    cwd,
    env: fake.env,
    label: 'codex-fixture-replay',
  })
  const peer = JsonRpcPeer.fromChild(child, { header: 'omit' })
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
  // Replies to server requests, by the server's id (replayed as recorded).
  const replies = new Map<string, Record<string, unknown>>()
  for (const f of rec.frames) {
    const m = f.dir === 'in' ? messageOf(f) : undefined
    if (m !== undefined && typeof m['method'] !== 'string') replies.set(JSON.stringify(m['id']), m)
  }
  const { requests } = recordedOut(rec)
  for (const method of new Set([...requests.values()].map((r) => String(r['method'])))) {
    peer.onRequest(method, (_params, ctx) => {
      const reply = replies.get(JSON.stringify(ctx.id))
      if (reply === undefined)
        throw new JsonRpcError(-32601, `no recorded reply to ${method} ${String(ctx.id)}`)
      if (isObj(reply['error'])) {
        const e = reply['error']
        throw new JsonRpcError(Number(e['code']), String(e['message']))
      }
      return reply['result']
    })
  }
  let notesBefore = 0
  for (const f of rec.frames) {
    if (f.dir === 'out' && typeof messageOf(f)?.['method'] === 'string' && !('id' in (messageOf(f) ?? {})))
      notesBefore++
    if (f.dir === 'eof') {
      // Like an adapter, close stdin only once the turn is over (every notification before the close arrived).
      for (
        let i = 0;
        i < 400 && observed.notifications.length < notesBefore && child.exitInfo() === null;
        i++
      )
        await new Promise((r) => setTimeout(r, 25))
      child.closeStdin()
    }
    if (f.dir !== 'in') continue
    const recorded = messageOf(f)
    if (recorded === undefined || typeof recorded['method'] !== 'string') continue
    const sent = o.mutate ? o.mutate(withCwd(recorded, cwd)) : withCwd(recorded, cwd)
    if (sent === null) continue
    const method = String(sent['method'])
    if (!('id' in sent)) {
      await peer.notify(method, sent['params'])
      continue
    }
    try {
      const result = await peer.request(method, sent['params'], { timeoutMs: 20_000, retry: false })
      observed.results.set(JSON.stringify(recorded['id']), result)
    } catch (err) {
      if (err instanceof JsonRpcError) {
        observed.errors.set(JSON.stringify(recorded['id']), { code: err.code, message: err.message })
        continue
      }
      break // the replay failed: the exit code tells why
    }
  }
  const exit = await child.exited
  observed.exit = { code: exit.code, signal: exit.signal }
  observed.stderr = child.stderrTail(40)
  peer.close()
  return observed
}

const appServer = fixtureIds('app-server')
const exec = fixtureIds('exec')

describe('Codex app-server fixtures replay through the real resolver and spawn', () => {
  it('finds the P0 set (X01–X17) and the exec set (E01–E08)', () => {
    const ids = new Set(appServer.map((d) => d.replace(/-.*/, '').replace(/[a-z]$/, '')))
    for (let n = 1; n <= 17; n++) expect(ids).toContain(`X${String(n).padStart(2, '0')}`)
    expect(appServer.filter((d) => d.startsWith('X11'))).toHaveLength(3)
    expect(exec.map((d) => d.slice(0, 3))).toEqual(['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08'])
  })

  it.each(appServer)('%s', async (id) => {
    const rec = loadCodexRecording('app-server', id)
    const out = recordedOut(rec)
    const seen = await hostAppServer(rec)
    expect(seen.stderr.filter((l) => l.startsWith('fake-cli:'))).toEqual([])
    const exit = rec.frames.find((f) => f.dir === 'exit')
    expect(seen.exit.code).toBe(exit?.code ?? 0)
    // Every recorded notification arrives, in order, as recorded.
    expect(seen.notifications).toEqual(out.notifications)
    // Every response matches the recorded one, error or result, under the host's own ids.
    for (const [key, response] of out.responses) {
      if (isObj(response['error'])) expect(seen.errors.get(key)?.code).toBe(response['error']['code'])
      else expect(seen.results.get(key)).toEqual(response['result'])
    }
  })
})

describe('the JSON-RPC replay is strict', () => {
  const X02 = (): CodexRecording => loadCodexRecording('app-server', 'X02-review-agent-deltas')
  const failFast = { FAKE_CLI_TIMEOUT_MS: '4000' }

  it('a host frame whose params differ fails with exit 99 and names the field', async () => {
    const seen = await hostAppServer(X02(), {
      extraEnv: failFast,
      mutate: (m) =>
        m['method'] === 'thread/start' && isObj(m['params'])
          ? { ...m, params: { ...m['params'], sandbox: 'workspace-write' } }
          : m,
    })
    expect(seen.exit.code).toBe(99)
    expect(seen.stderr.join('\n')).toMatch(/sandbox/)
  })

  it('a request the recording does not have fails at the exit', async () => {
    const rec = X02()
    // The recorded host frames, with a model/list sent first: the replay rejects the stray request.
    const child = await spawnRaw(rec, failFast)
    await child.writeLine({ id: 900, method: 'model/list', params: {} })
    for (const f of rec.frames) {
      if (f.dir === 'eof') child.closeStdin()
      const m = f.dir === 'in' ? messageOf(f) : undefined
      if (m !== undefined) await child.writeLine(withCwd(m, child.cwdForTest))
    }
    const exit = await child.handle.exited
    expect(exit.code).toBe(99)
    expect(child.handle.stderrTail(20).join('\n')).toMatch(/client messages the recording does not have/)
  })

  it('stdin closed before the recording expects it fails with exit 98', async () => {
    const rec = X02()
    const child = await spawnRaw(rec, failFast)
    // The handshake and thread/start, then the host closes stdin: the replay was still waiting for turn/start.
    for (const f of rec.frames) {
      const m = f.dir === 'in' ? messageOf(f) : undefined
      if (m === undefined) continue
      if (m['method'] === 'turn/start') break
      await child.writeLine(withCwd(m, child.cwdForTest))
    }
    child.closeStdin()
    const exit = await child.handle.exited
    expect(exit.code).toBe(98)
    expect(child.handle.stderrTail(20).join('\n')).toMatch(/stdin closed during replay/)
  })
})

interface RawChild {
  handle: ChildHandle
  cwdForTest: string
  writeLine(v: unknown): Promise<boolean>
  closeStdin(): void
}

async function spawnRaw(rec: CodexRecording, extraEnv: Record<string, string> = {}): Promise<RawChild> {
  const cwd = tempDir('codex-replay-raw-')
  const fake = await fakeCodex(rec.path, extraEnv)
  const handle = await spawnChild({
    cli: fake.cli,
    args: rec.header.argv.slice(1),
    cwd,
    env: fake.env,
    label: 'codex-raw',
  })
  return {
    handle,
    cwdForTest: cwd,
    writeLine: (v) => handle.writeLine(v),
    closeStdin: () => handle.closeStdin(),
  }
}

describe("client ids are the host's own", () => {
  it.each(['X04-filechange-approval', 'X05b-permissions-elicitation', 'X12c-plan-collaboration-rejected'])(
    '%s replays with shifted numeric ids and with string ids',
    async (id) => {
      for (const ids of [(n: number) => n + 100, (n: number) => `req-${n}`]) {
        const rec = loadCodexRecording('app-server', id)
        const child = await spawnRaw(rec, { FAKE_CLI_TIMEOUT_MS: '8000' })
        const lines: Record<string, unknown>[] = []
        const reading = (async () => {
          for await (const l of child.handle.lines('stdout')) {
            try {
              lines.push(JSON.parse(l) as Record<string, unknown>)
            } catch {
              // not JSON
            }
          }
        })()
        const waitFor = async (pred: (m: Record<string, unknown>) => boolean): Promise<void> => {
          for (let i = 0; i < 400 && !lines.some(pred); i++) await new Promise((r) => setTimeout(r, 25))
        }
        for (const f of rec.frames) {
          if (f.dir === 'eof') child.closeStdin()
          const m = f.dir === 'in' ? messageOf(f) : undefined
          if (m === undefined) continue
          if (typeof m['method'] === 'string' && 'id' in m) {
            const mine = ids(Number(m['id']))
            await child.writeLine({ ...withCwd(m, child.cwdForTest), id: mine })
            await waitFor((x) => x['id'] === mine && !('method' in x))
          } else if (typeof m['method'] === 'string') {
            await child.writeLine(withCwd(m, child.cwdForTest))
          } else {
            // A reply to a server request: once the server asked.
            await waitFor((x) => typeof x['method'] === 'string' && x['id'] === m['id'])
            await child.writeLine(m)
          }
        }
        const exit = await child.handle.exited
        await reading
        expect(child.handle.stderrTail(20).filter((l) => l.startsWith('fake-cli:'))).toEqual([])
        expect(exit.code).toBe(0)
        // Every response carries the id the host used, never the recorded one.
        const responses = lines.filter((x) => !('method' in x))
        const recordedIds = rec.frames.flatMap((f) => {
          const m = f.dir === 'in' ? messageOf(f) : undefined
          return m !== undefined && typeof m['method'] === 'string' && 'id' in m ? [ids(Number(m['id']))] : []
        })
        expect(responses.map((r) => r['id'])).toEqual(recordedIds)
      }
    },
  )
})

describe('Codex exec fixtures replay through the real resolver and spawn', () => {
  it.each(exec)('%s', async (id) => {
    const rec = loadCodexRecording('exec', id)
    const cwd = tempDir('codex-exec-cwd-')
    const fake = await fakeCodex(rec.path)
    const args = withCwd(rec.header.argv.slice(1), cwd)
    const child = await spawnChild({ cli: fake.cli, args, cwd, env: fake.env, label: 'codex-exec-replay' })
    const out: string[] = []
    const reading = (async () => {
      for await (const l of child.lines('stdout')) out.push(l)
    })()
    const prompt = rec.frames.filter((f) => f.dir === 'in').map((f) => f.line ?? '')
    await child.writeRaw(`${prompt.join('\n')}\n`)
    child.closeStdin()
    const hold = rec.frames.some((f) => f.dir === 'hold')
    if (hold) {
      // The recorded process was stopped mid-command: stop it once the command started.
      for (let i = 0; i < 400 && !out.some((l) => l.includes('"item.started"')); i++)
        await new Promise((r) => setTimeout(r, 25))
      await stopChild(child, { stdinWaitMs: 0 })
    }
    const exit = await child.exited
    await reading
    expect(child.stderrTail(20).filter((l) => l.startsWith('fake-cli:'))).toEqual([])
    const recordedOutLines = rec.frames.filter(
      (f): f is CodexFrame & { line: string } => f.dir === 'out' && f.line !== undefined,
    )
    expect(out).toEqual(recordedOutLines.map((f) => f.line))
    if (!hold) expect(exit.code).toBe(rec.frames.find((f) => f.dir === 'exit')?.code)
    else expect(exit.code === 0).toBe(false)
    const file = rec.frames.find((f) => f.dir === 'file')
    const oPath = args[args.indexOf('-o') + 1]!
    if (file !== undefined) expect(readFileSync(oPath, 'utf8')).toBe(file.content)
    else expect(existsSync(oPath)).toBe(false)
  })

  it('a prompt that differs from the recorded one fails the replay', async () => {
    const rec = loadCodexRecording('exec', 'E01-review-readonly')
    const cwd = tempDir('codex-exec-cwd-')
    const fake = await fakeCodex(rec.path, { FAKE_CLI_TIMEOUT_MS: '4000' })
    const child = await spawnChild({
      cli: fake.cli,
      args: withCwd(rec.header.argv.slice(1), cwd),
      cwd,
      env: fake.env,
    })
    await child.writeRaw('Something else entirely.\n')
    child.closeStdin()
    const exit = await child.exited
    expect(exit.code).toBe(99)
    expect(existsSync(join(cwd, '.dimfactory', 'last-message.txt'))).toBe(false)
  })
})
