// Codex sub-agents (multi_agent, on by default in 0.160) through the real spawn and JSON-RPC path: a sub-agent's own
// thread never reaches the pass's conversation nor ends it; a turn that ends while one still runs is held, and once it
// finishes Dim Factory starts a follow-up turn on the same thread with its report. Its tokens count toward the pass.
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import type { Op } from './helpers.ts'
import { drive, eventsOf, fakeCodex, fakeSetup, scenario, tempDir } from './helpers.ts'

const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e10'
const SUB = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e11'
const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }

const note = (method: string, params: Record<string, unknown>): Op => ({
  op: 'stdout',
  json: { method, params },
})
const activity = (kind: string, turnId: string): Op =>
  note(kind === 'started' ? 'item/started' : 'item/completed', {
    threadId: THREAD,
    turnId,
    item: {
      type: 'subAgentActivity',
      id: `act-${kind}`,
      kind,
      agentThreadId: SUB,
      agentPath: '/root/run_tests',
    },
  })
const total = (threadId: string, input: number, output: number): Op =>
  note('thread/tokenUsage/updated', {
    threadId,
    turnId: 'x',
    tokenUsage: {
      total: {
        totalTokens: input + output,
        inputTokens: input,
        cachedInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: null,
    },
  })
const message = (threadId: string, turnId: string, id: string, text: string): Op =>
  note('item/completed', { threadId, turnId, item: { type: 'agentMessage', id, text, phase: null } })
const completed = (threadId: string, turnId: string): Op =>
  note('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } })

const script: Op[] = [
  { op: 'rpcExpect', method: 'initialize', kind: 'request', as: 'init' },
  {
    op: 'rpcResult',
    id: '$init',
    result: { userAgent: 'fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' },
  },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
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
  { op: 'rpcExpect', method: 'turn/start', as: 'tu', params: { threadId: THREAD } },
  { op: 'rpcResult', id: '$tu', result: { turn: { id: 'turn-1', status: 'inProgress' } } },
  activity('started', 'turn-1'),
  message(THREAD, 'turn-1', 'm1', 'Started the test run in a sub-agent.'),
  total(THREAD, 100, 10),
  completed(THREAD, 'turn-1'),
  // The sub-agent's own thread: its words, its total and its turn's end.
  message(SUB, 's-1', 'm2', 'All 42 tests pass.'),
  total(SUB, 50, 5),
  completed(SUB, 's-1'),
  activity('completed', 'turn-1'),
  // Dim Factory hands the report over in a new turn on the same thread.
  { op: 'rpcExpect', method: 'turn/start', as: 'tu2', params: { threadId: THREAD } },
  { op: 'rpcResult', id: '$tu2', result: { turn: { id: 'turn-2', status: 'inProgress' } } },
  note('turn/started', {
    threadId: THREAD,
    turn: { id: 'turn-2', items: [], status: 'inProgress', error: null },
  }),
  message(THREAD, 'turn-2', 'm3', 'Done: the tests pass.'),
  total(THREAD, 160, 16),
  completed(THREAD, 'turn-2'),
  { op: 'expectEof' },
  { op: 'rpcDrained' },
  { op: 'exit', code: 0 },
]

const startOptions = (cwd: string): StartOptions => ({
  runId: 'run-sub',
  step: 'implement',
  cwd,
  prompt: 'Run the tests in a sub-agent and report.',
  mode: 'autoedit',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
})

describe('Codex sub-agents', () => {
  it('holds the answer, starts a follow-up turn with the report, and counts the sub-agent tokens', async () => {
    const setup = await fakeSetup()
    const fake = fakeCodex(setup, scenario([{ match: APP_SERVER, script }]))
    const d = await drive(fake.adapter, startOptions(tempDir('codex-sub-')))
    expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
    const events = eventsOf(d.entries)
    const turns = fake.stdinLines().filter((m) => (m as { method?: string }).method === 'turn/start') as {
      params: { input: { text: string }[] }
    }[]
    expect(turns).toHaveLength(2)
    expect(turns[1]?.params.input[0]?.text).toContain('All 42 tests pass.')
    expect(turns[1]?.params.input[0]?.text).toContain('/root/run_tests')
    // One terminal event: the follow-up's answer, with the main thread's and the sub-agent's tokens.
    const done = events.filter((e) => e.type === 'done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ result: 'Done: the tests pass.', usage: { input: 210, output: 21 } })
    // The sub-agent shows as an agent row; its words never reach the conversation.
    expect(events.filter((e) => e.type === 'tool')).toMatchObject([
      { name: 'agent', summary: 'Sub-agent /root/run_tests', phase: 'start' },
      { name: 'agent', phase: 'end', status: 'ok' },
    ])
    expect(JSON.stringify(events)).not.toContain('All 42 tests pass.')
    expect(d.entries.some((e) => e.type === 'waiting')).toBe(true)
  }, 60_000)
})
