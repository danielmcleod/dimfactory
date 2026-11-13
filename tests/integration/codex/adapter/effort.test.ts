// Codex app-server with a pass effort: turn/start carries `effort`; an effort that is not a plain level fails the
// pass before anything is spawned (config_invalid).
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import type { Op } from './helpers.ts'
import { drive, eventsOf, fakeCodex, fakeSetup, scenario, tempDir } from './helpers.ts'

const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e98'
const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }

const startOptions = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: 'run-effort',
  step: 'review',
  cwd,
  prompt: 'Review the change.',
  mode: 'readonly',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...o,
})

const handshake: Op[] = [
  { op: 'rpcExpect', method: 'initialize', kind: 'request', as: 'init' },
  {
    op: 'rpcResult',
    id: '$init',
    result: { userAgent: 'fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' },
  },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
]

const threadResult = {
  thread: { id: THREAD },
  model: 'gpt-5.6-terra',
  modelProvider: 'openai',
  cwd: '/w',
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandbox: { type: 'readOnly', networkAccess: false },
}

const turnDone: Op[] = [
  {
    op: 'stdout',
    json: {
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD, turnId: 'turn-1', itemId: 'm', delta: 'Looks fine.' },
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

const turnStarts = (lines: readonly unknown[]): Record<string, unknown>[] =>
  lines
    .map((m) => m as { method?: string; params?: Record<string, unknown> })
    .filter((m) => m.method === 'turn/start')
    .map((m) => m.params ?? {})

describe('codex adapter: effort', () => {
  it('turn/start carries the pass effort', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          { op: 'rpcResult', id: '$ts', result: threadResult },
          { op: 'rpcExpect', method: 'turn/start', as: 'tu', params: { threadId: THREAD, effort: 'high' } },
          { op: 'rpcResult', id: '$tu', result: { turn: { id: 'turn-1', status: 'inProgress' } } },
          ...turnDone,
          { op: 'expectEof' },
          { op: 'rpcDrained' },
          { op: 'exit', code: 0 },
        ],
      },
    ])
    const fake = fakeCodex(setup, dir)
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-'), { effort: 'high' }))
    expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
    expect(turnStarts(fake.stdinLines()).map((p) => p['effort'])).toEqual(['high'])
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
  }, 60_000)

  it('no effort: turn/start has none (the thread default)', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          { op: 'rpcResult', id: '$ts', result: threadResult },
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
    await drive(fake.adapter, startOptions(tempDir('codex-cwd-')))
    const starts = turnStarts(fake.stdinLines())
    expect(starts).toHaveLength(1)
    expect(starts[0]).not.toHaveProperty('effort')
  }, 60_000)

  it('an effort that is not a plain level is refused before spawn (config_invalid)', async () => {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, scenario([]))
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-'), { effort: 'high --x' }))
    expect(eventsOf(d.entries)).toMatchObject([{ type: 'error', category: 'config_invalid' }])
  }, 60_000)
})
