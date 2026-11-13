// The Codex run handles through the real resolver and spawn path (the app-server route; session id persistence:
// from the thread/start response, before turn/start; Codex with the Windows sandbox not ready: autoedit
// unsupported, never a silent downgrade; the probe routes a schema missing a required method to exec).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunHandle, StartOptions } from '../../../../src/core/adapters/types.ts'
import type { NormalizedEvent } from '../../../../src/shared/events.ts'
import type { Op, ScenarioEntry } from './helpers.ts'
import {
  COMMITTED_SCHEMA,
  checkInvariants,
  drive,
  eventsOf,
  fakeCodex,
  fakeSetup,
  loadFixture,
  scenario,
  tempDir,
} from './helpers.ts'

const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e99'
const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }

const startOptions = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: 'run-it',
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

const threadResult = (sandbox: Record<string, unknown>) => ({
  thread: { id: THREAD },
  model: 'gpt-5.6-terra',
  modelProvider: 'openai',
  cwd: '/w',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox,
})

const turnDone: Op[] = [
  {
    op: 'stdout',
    json: {
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD, turnId: 'turn-1', itemId: 'm', delta: 'Done.' },
    },
  },
  {
    op: 'stdout',
    json: {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'turn-1', items: [], status: 'completed', error: null } },
    },
  },
]

describe('session id persistence', () => {
  it('turn/start waits until onSession has recorded the thread id', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          {
            op: 'rpcExpect',
            method: 'thread/start',
            as: 'ts',
            params: { sandbox: 'workspace-write', approvalsReviewer: 'user' },
          },
          {
            op: 'rpcResult',
            id: '$ts',
            result: threadResult({ type: 'workspaceWrite', writableRoots: [], networkAccess: false }),
          },
          { op: 'rpcExpect', method: 'turn/start', as: 'tu', params: { threadId: THREAD } },
          { op: 'rpcResult', id: '$tu', result: { turn: { id: 'turn-1', status: 'inProgress' } } },
          ...turnDone,
          { op: 'expectEof' },
          { op: 'rpcDrained' },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const seen: { id: string; turnStartBeforeRecorded: boolean }[] = []
    const o = startOptions(tempDir('codex-cwd-'), {
      onSession: async (id) => {
        // Hold the "run.json write" a while: the adapter must not send turn/start meanwhile.
        await new Promise((r) => setTimeout(r, 600))
        const sent = fake.stdinLines().some((m) => (m as { method?: string }).method === 'turn/start')
        seen.push({ id, turnStartBeforeRecorded: sent })
        return { ok: true }
      },
    })
    const d = await drive(fake.adapter, o)
    expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
    expect(seen).toEqual([{ id: THREAD, turnStartBeforeRecorded: false }])
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'turn/start')).toBe(true)
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: 'Done.' })
    expect(d.handle.sessionId()).toBe(THREAD)
  }, 60_000)

  /** thread/start answers, then the adapter must stop before turn/start (the fake fails if one arrives). */
  const noTurn = (): string =>
    scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          {
            op: 'rpcResult',
            id: '$ts',
            result: threadResult({ type: 'workspaceWrite', writableRoots: [], networkAccess: false }),
          },
          { op: 'expectEof', ignoreLines: true },
          { op: 'exit', code: 0 },
        ],
      },
    ])

  it('review: a thread id run.json could not hold ends the pass before turn/start (no model call)', async () => {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, noTurn())
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('codex-cwd-'), {
        onSession: () =>
          Promise.resolve({ ok: false, reason: 'run.json could not be written: no space', code: 'ENOSPC' }),
      }),
    )
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'turn/start')).toBe(false)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', fatal: true, category: 'disk_full' })
    checkInvariants(d, { readOnly: false })
  }, 60_000)

  it('review: a run.json write that never confirms ends the pass after the wait, without a turn', async () => {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, noTurn(), { adapter: { timing: { sessionPersistMs: 1_000 } } })
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('codex-cwd-'), { onSession: () => new Promise(() => undefined) }),
    )
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'turn/start')).toBe(false)
    const last = eventsOf(d.entries).at(-1)
    expect(last).toMatchObject({ type: 'error', fatal: true, category: 'unknown' })
    expect((last as { message: string }).message).toMatch(/did not start the turn/)
  }, 60_000)
})

describe('never a silent downgrade', () => {
  it.each(['unknown', 'unchecked'] as const)(
    'review: a Windows sandbox nobody confirmed (%s) is not ready: the edit pass fails before any spawn',
    async (winSandbox) => {
      const setup = await fakeSetup()
      const fake = fakeCodex(setup, scenario([]), { facts: { winSandbox }, platform: 'win32' })
      const need = { pass: 'implement' as const, planNative: false, trustFolder: false }
      expect(fake.adapter.support({ ...need, mode: 'autoedit' })).toMatchObject({ status: 'unsupported' })
      expect(fake.adapter.support({ ...need, mode: 'full' })).toMatchObject({ status: 'unsupported' })
      expect(fake.adapter.support({ ...need, pass: 'review', mode: 'readonly' })).toMatchObject({
        status: 'degraded',
      })
      const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
      expect(eventsOf(d.entries)).toMatchObject([
        { type: 'error', fatal: true, category: 'sandbox_unavailable' },
      ])
      expect(fake.logEntries().filter((e) => e['kind'] === 'start')).toEqual([])
    },
    60_000,
  )

  it('Windows sandbox not set up: an edit pass fails sandbox_unavailable before anything is spawned', async () => {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, scenario([]), { facts: { winSandbox: 'notConfigured' }, platform: 'win32' })
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    expect(eventsOf(d.entries)).toMatchObject([
      { type: 'error', fatal: true, category: 'sandbox_unavailable' },
    ])
    expect(fake.logEntries().filter((e) => e['kind'] === 'start')).toEqual([])
    expect(d.exit).toMatchObject({ code: null, sawTerminal: true })
  }, 60_000)

  it('thread/start answering a read-only sandbox for an edit pass ends it before turn/start (no model call)', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          { op: 'rpcResult', id: '$ts', result: threadResult({ type: 'readOnly', networkAccess: false }) },
          { op: 'expectEof', ignoreLines: true },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'sandbox_unavailable' })
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'turn/start')).toBe(false)
  }, 60_000)

  it('extraArgs that touch the sandbox are refused before spawn (config_invalid)', async () => {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, scenario([]))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('codex-cwd-'), { extraArgs: ['-c', 'sandbox_mode="danger-full-access"'] }),
    )
    expect(eventsOf(d.entries)).toMatchObject([{ type: 'error', category: 'config_invalid' }])
  }, 60_000)
})

describe('stop (kill: turn/interrupt, then stdin, then the tree)', () => {
  it('a user stop interrupts the running turn and ends as user_cancelled', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          {
            op: 'rpcResult',
            id: '$ts',
            result: threadResult({ type: 'workspaceWrite', writableRoots: [], networkAccess: false }),
          },
          { op: 'rpcExpect', method: 'turn/start', as: 'tu' },
          // The response and the item in one write, as one pipe read on Linux often holds them: the stop the item
          // triggers comes before the awaited response, and must still interrupt the turn.
          {
            op: 'stdout',
            raw: `{"id":$tu,"result":${JSON.stringify({ turn: { id: 'turn-1', status: 'inProgress' } })}}\n${JSON.stringify(
              {
                method: 'item/started',
                params: {
                  item: { type: 'commandExecution', id: 'c1', command: 'sleep 60', status: 'inProgress' },
                },
              },
            )}\n`,
          },
          {
            op: 'rpcExpect',
            method: 'turn/interrupt',
            as: 'ti',
            params: { threadId: THREAD, turnId: 'turn-1' },
          },
          { op: 'rpcResult', id: '$ti', result: {} },
          {
            op: 'stdout',
            json: {
              method: 'turn/completed',
              params: {
                threadId: THREAD,
                turn: { id: 'turn-1', items: [], status: 'interrupted', error: null },
              },
            },
          },
          { op: 'expectEof' },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')), [], {
      stopAfter: (e) => e.type === 'tool' && e.phase === 'start',
    })
    expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).slice(-2)).toMatchObject([
      { type: 'tool', id: 'c1', phase: 'end', status: 'declined' },
      { type: 'error', category: 'user_cancelled' },
    ])
    expect(d.exit.stoppedBy).toBe('user')
  }, 60_000)

  it('a stop that arrives while the process is being recorded (procs.json) still ends that process', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          { op: 'sleep', ms: 30_000 },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const ref: { handle?: RunHandle } = {}
    let stopped: Promise<void> | undefined
    const fake = fakeCodex(setup, dir, {
      adapter: {
        onSpawn: async () => {
          stopped = fake.adapter.stop(ref.handle!, 'user')
          await new Promise((r) => setTimeout(r, 100))
        },
      },
    })
    const started = Date.now()
    const handle = fake.adapter.start(startOptions(tempDir('codex-cwd-')))
    ref.handle = handle
    const events: NormalizedEvent[] = []
    handle.onEvent((e) => events.push(e))
    const exit = await handle.exited
    await stopped
    expect(Date.now() - started).toBeLessThan(25_000)
    expect(exit.stoppedBy).toBe('user')
    expect(events.at(-1)).toMatchObject({ type: 'error', category: 'user_cancelled' })
  }, 60_000)

  it('a CLI that never answers initialize is flag_drift (the handshake timer), and is killed', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          { op: 'sleep', ms: 30_000 },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir, { adapter: { timing: { initializeMs: 1_500 } } })
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'flag_drift' })
  }, 60_000)
})

describe('exec resume echo ("assert the echoed id")', () => {
  it('review: a different thread echoed by `exec resume` is never reported as the session; the pass fails', async () => {
    const setup = await fakeSetup()
    const other = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4eff'
    const dir = scenario([
      {
        match: { argvIncludes: ['exec', '--json'] },
        script: [
          { op: 'expectEof', ignoreLines: true },
          { op: 'stdout', json: { type: 'thread.started', thread_id: other } },
          { op: 'stdout', json: { type: 'turn.started' } },
          { op: 'sleep', ms: 20_000 },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir, { facts: { route: 'exec' } })
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('codex-cwd-'), { step: 'fix', resume: { sessionId: THREAD } }),
    )
    const events = eventsOf(d.entries)
    expect(events.filter((e) => e.type === 'session')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true, category: 'resume_failed' })
    expect(d.handle.sessionId()).not.toBe(other)
  }, 60_000)
})

describe('route choice (probe: a schema without a required method → the exec fallback)', () => {
  it('the probe picks exec, warns, and the next pass runs `codex exec` with the exec argv', async () => {
    const setup = await fakeSetup()
    // The committed 0.160 bundle without turn/interrupt.
    const bundle = JSON.parse(
      readFileSync(join(COMMITTED_SCHEMA, 'codex_app_server_protocol.schemas.json'), 'utf8'),
    ) as { definitions: Record<string, { oneOf?: { properties?: { method?: { enum?: string[] } } }[] }> }
    const root = bundle.definitions['ClientRequest']!
    root.oneOf = root.oneOf!.filter((v) => !(v.properties?.method?.enum ?? []).includes('turn/interrupt'))
    const trimmed = join(tempDir('codex-bundle-'), 'codex_app_server_protocol.schemas.json')
    writeFileSync(trimmed, JSON.stringify(bundle))
    const e02 = loadFixture('exec', 'E02-implement-edit-command')
    const entries: ScenarioEntry[] = [
      {
        match: { argvIncludes: ['login', 'status'] },
        script: [
          { op: 'stderr', line: 'Logged in using ChatGPT' },
          { op: 'exit', code: 0 },
        ],
        repeat: true,
      },
      {
        match: { argvIncludes: ['generate-json-schema'] },
        script: [
          { op: 'copyFiles', from: trimmed, argvPath: '--out' },
          { op: 'exit', code: 0 },
        ],
        repeat: true,
      },
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'model/list', as: 'ml' },
          { op: 'rpcResult', id: '$ml', result: { data: [], nextCursor: null } },
          { op: 'expectEof' },
          { op: 'exit', code: 0 },
        ],
        repeat: true,
      },
      { match: { argvIncludes: ['exec', '--json'] }, script: e02.recording, repeat: true },
    ]
    const fake = fakeCodex(setup, scenario(entries))
    const probe = await fake.adapter.probe()
    expect(probe).toMatchObject({ route: 'exec', transport: 'codex-exec' })
    expect(fake.adapter.transport).toBe('codex-exec')
    expect(probe.checks.find((c) => c.id === 'vendor.codex.protocol')).toMatchObject({
      status: 'warn',
      title: 'Codex runs without a question relay',
    })
    expect(probe.capabilities).toMatchObject({ askRelay: false, planMode: 'emulated' })
    expect(
      fake.adapter.support({ pass: 'implement', mode: 'autoedit', planNative: false, trustFolder: false }),
    ).toMatchObject({
      status: 'degraded',
      reason: 'no-relay',
    })

    const cwd = tempDir('codex-cwd-')
    const d = await drive(fake.adapter, startOptions(cwd, { prompt: e02.inMessages[0] as string }))
    expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
    expect(d.handle.route).toBe('exec')
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    const start = fake
      .logEntries()
      .find((e) => e['kind'] === 'start' && (e['argv'] as string[]).includes('exec'))
    const argv = start?.['argv'] as string[]
    expect(argv.slice(0, 11)).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--cd',
      cwd,
      '-c',
      'approvals_reviewer="user"',
    ])
    expect(argv.at(-1)).toBe('-')
    expect(argv).not.toContain('--ephemeral')
    expect(argv).not.toContain('--full-auto')
  }, 90_000)
})
