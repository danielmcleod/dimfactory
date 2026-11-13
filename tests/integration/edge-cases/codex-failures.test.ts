// Coverage: Codex when the app-server misbehaves, and the Windows sandbox setup when it does not finish (a
// bounded handshake, the thread id before turn/start; failure categories flag_drift / stream_malformed;
// the `vendor_setup` executor: the unelevated setup over a private app-server, every way it can end said in one plain sentence,
// never a throw). Through the real resolver and spawn path with the fake Codex running a short script.
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import { MALFORMED_THRESHOLD } from '../../../src/core/proc/jsonrpc.ts'
import type { Op } from '../codex/adapter/helpers.ts'
import {
  checkInvariants,
  drive,
  eventsOf,
  fakeCodex,
  fakeSetup,
  scenario,
  tempDir,
} from '../codex/adapter/helpers.ts'

const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e99'
const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }
const TIMING = { exitAfterTerminalMs: 3_000, stopTurnMs: 3_000, fatalErrorWaitMs: 2_000 }

const startOptions = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: 'run-codex-failures',
  step: 'implement',
  cwd,
  prompt: 'Add a --version flag.',
  mode: 'autoedit',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...o,
})

const handshake: Op[] = [
  {
    op: 'rpcExpect',
    method: 'initialize',
    kind: 'request',
    as: 'init',
    params: { clientInfo: { name: 'dim-factory' } },
  },
  {
    op: 'rpcResult',
    id: '$init',
    result: { userAgent: 'fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' },
  },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
]

const end: Op[] = [
  { op: 'expectEof', timeoutMs: 20_000 },
  { op: 'exit', code: 0 },
]

const methodsSent = (lines: unknown[]): string[] =>
  lines.flatMap((m) => {
    const method = (m as { method?: unknown }).method
    return typeof method === 'string' ? [method] : []
  })

describe('Codex app-server: the handshake and the thread', () => {
  it('initialize refused with a JSON-RPC error: flag_drift with Codex’s words; no thread is started', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          { op: 'rpcExpect', method: 'initialize', kind: 'request', as: 'init' },
          {
            op: 'rpcError',
            id: '$init',
            error: { code: -32600, message: 'Invalid request: unknown field `capabilities`' },
          },
          ...end,
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      fatal: true,
      category: 'flag_drift',
      message: expect.stringMatching(/Codex rejected the startup handshake: Invalid request/) as string,
    })
    expect(methodsSent(fake.stdinLines())).toEqual(['initialize'])
  }, 60_000)

  it('thread/start answered without a thread id: stream_malformed; no turn is started', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          { op: 'rpcResult', id: '$ts', result: { thread: {}, model: 'gpt-5.6-terra' } },
          ...end,
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'stream_malformed',
      message: expect.stringMatching(/Codex answered thread\/start without a thread id/) as string,
    })
    expect(eventsOf(d.entries).some((e) => e.type === 'session')).toBe(false)
    expect(methodsSent(fake.stdinLines())).not.toContain('turn/start')
  }, 60_000)

  it('thread/start not answered in time: unknown, naming the request; no turn is started', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start' },
          { op: 'sleep', ms: 30_000 },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir, { adapter: { timing: { ...TIMING, requestMs: 1_500 } } })
    const started = Date.now()
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'unknown',
      message: expect.stringMatching(/Codex did not answer thread\/start within 2 s/) as string,
    })
    expect(methodsSent(fake.stdinLines())).not.toContain('turn/start')
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it(`${MALFORMED_THRESHOLD} unreadable lines in a row mid-turn: stream_malformed with them as evidence, the process ended`, async () => {
    const setup = await fakeSetup()
    const garbage: Op[] = Array.from({ length: MALFORMED_THRESHOLD }, (_, i) => ({
      op: 'stdout',
      line: `thread 'main' panicked at codex-rs/core/src/x.rs:${i + 1}`,
    }))
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          {
            op: 'rpcResult',
            id: '$ts',
            result: {
              thread: { id: THREAD },
              model: 'gpt-5.6-terra',
              modelProvider: 'openai',
              cwd: '/w',
              approvalPolicy: 'on-request',
              approvalsReviewer: 'user',
              sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
            },
          },
          { op: 'rpcExpect', method: 'turn/start', as: 'tu' },
          { op: 'rpcResult', id: '$tu', result: { turn: { id: 'turn-1', status: 'inProgress' } } },
          ...garbage,
          { op: 'sleep', ms: 30_000 },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const started = Date.now()
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    checkInvariants(d, { readOnly: false })
    const last = eventsOf(d.entries).at(-1)
    expect(last).toMatchObject({
      type: 'error',
      fatal: true,
      category: 'stream_malformed',
      message: expect.stringMatching(/Codex sent unreadable output/) as string,
    })
    expect((last as { raw: string }).raw).toContain('panicked at')
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)
})

describe('Codex Windows sandbox setup (vendor_setup): every ending is one sentence, never a throw', () => {
  const setupStart: Op = {
    op: 'rpcExpect',
    method: 'windowsSandbox/setupStart',
    as: 'ss',
    params: { mode: 'unelevated' },
  }
  const completed = (params: Record<string, unknown>): Op => ({
    op: 'stdout',
    json: { method: 'windowsSandbox/setupCompleted', params },
  })

  async function runSetup(
    script: Op[],
    signal = new AbortController().signal,
  ): Promise<{ ok: boolean; detail: string }> {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, scenario([{ match: APP_SERVER, script }]), { platform: 'win32' })
    return fake.adapter.vendorSetup('windowsSandbox/setupStart', { mode: 'unelevated' }, signal)
  }

  it('a Codex without the method: update Codex', async () => {
    const r = await runSetup([
      ...handshake,
      setupStart,
      { op: 'rpcError', id: '$ss', error: { code: -32601, message: 'Method not found' } },
      ...end,
    ])
    expect(r).toEqual({
      ok: false,
      detail: 'This Codex cannot set up its Windows sandbox from Dim Factory. Update Codex.',
    })
  }, 60_000)

  it('a refusal: Codex’s own words, as a sentence', async () => {
    const r = await runSetup([
      ...handshake,
      setupStart,
      { op: 'rpcError', id: '$ss', error: { code: -32000, message: 'a sandbox setup is already running' } },
      ...end,
    ])
    expect(r).toEqual({ ok: false, detail: 'Codex refused the setup: a sandbox setup is already running.' })
  }, 60_000)

  it('started:false: Codex did not start it', async () => {
    const r = await runSetup([
      ...handshake,
      setupStart,
      { op: 'rpcResult', id: '$ss', result: { started: false } },
      ...end,
    ])
    expect(r).toEqual({ ok: false, detail: 'Codex did not start the setup.' })
  }, 60_000)

  it('Codex exits before the setup finished', async () => {
    const r = await runSetup([
      ...handshake,
      setupStart,
      { op: 'rpcResult', id: '$ss', result: { started: true } },
      { op: 'exit', code: 0 },
    ])
    expect(r).toEqual({ ok: false, detail: 'Codex stopped before the setup finished.' })
  }, 60_000)

  it('another mode’s completion is not this one’s; a failure without Codex’s text says it failed', async () => {
    const r = await runSetup([
      ...handshake,
      setupStart,
      { op: 'rpcResult', id: '$ss', result: { started: true } },
      completed({ mode: 'elevated', success: true, error: null }),
      completed({ mode: 'unelevated', success: false, error: '' }),
      ...end,
    ])
    expect(r).toEqual({ ok: false, detail: 'Codex reported that the setup failed.' })
  }, 60_000)

  it('cancelled while Codex works on it: the setup is stopped, and says it took too long', async () => {
    const ac = new AbortController()
    const p = runSetup(
      [
        ...handshake,
        setupStart,
        { op: 'rpcResult', id: '$ss', result: { started: true } },
        { op: 'sleep', ms: 30_000 },
        { op: 'exit', code: 0 },
      ],
      ac.signal,
    )
    setTimeout(() => ac.abort(), 1_500)
    const started = Date.now()
    expect(await p).toEqual({ ok: false, detail: 'The setup took too long, so Dim Factory stopped it.' })
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it('already cancelled: nothing is started', async () => {
    const ac = new AbortController()
    ac.abort()
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, scenario([{ match: APP_SERVER, script: [{ op: 'exit', code: 0 }] }]), {
      platform: 'win32',
    })
    expect(
      await fake.adapter.vendorSetup('windowsSandbox/setupStart', { mode: 'unelevated' }, ac.signal),
    ).toEqual({
      ok: false,
      detail: 'The setup was cancelled before it started.',
    })
    expect(
      fake
        .logEntries()
        .filter((e) => e['kind'] === 'start' && JSON.stringify(e['argv']).includes('app-server')),
    ).toEqual([])
  }, 60_000)
})
