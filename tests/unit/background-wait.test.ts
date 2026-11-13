// A Claude or Codex answer given while background work (a shell, a sub-agent) still runs does not end the pass: it waits
// for the turn that follows when the work finishes (Claude frames as Claude Code 2.1 streams them; Codex frames as the
// 0.160 app-server sends them with multi_agent on).
import { expect, it } from 'vitest'
import { ClaudeNormalizer } from '../../src/core/adapters/claude/normalize.ts'
import { CodexNormalizer } from '../../src/core/adapters/codex/normalize.ts'

const frames = {
  started: {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Run the test suite' }],
  },
  answer: {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Started the tests.',
    modelUsage: { m: { inputTokens: 10, outputTokens: 2 } },
  },
  finished: { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  followUp: {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'All 42 tests pass.',
    modelUsage: { m: { inputTokens: 25, outputTokens: 5 } },
  },
}
const line = (n: ClaudeNormalizer, f: object) => n.line(JSON.stringify(f))

it('Claude: holds the answer while background work runs, then ends with the follow-up turn', () => {
  const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000 })
  const started = line(n, frames.started)
  expect(started.signals).toContainEqual({ type: 'waiting', tasks: ['Run the test suite'] })

  const answer = line(n, frames.answer)
  expect(answer.events.some((e) => e.type === 'done')).toBe(false)
  expect(n.waiting).toBe(true)

  expect(line(n, frames.finished).drained).toBe(true)
  const done = line(n, frames.followUp).events.find((e) => e.type === 'done')
  // modelUsage is the process's running total: the follow-up's covers the held turn (no double count).
  expect(done).toMatchObject({ type: 'done', result: 'All 42 tests pass.', usage: { input: 25, output: 5 } })
  expect(n.waiting).toBe(false)
})

it('Claude: ends with the answer it has when no follow-up turn comes, or the process goes', () => {
  const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000 })
  line(n, frames.started)
  line(n, frames.answer)
  expect(n.finishHeld().events.find((e) => e.type === 'done')).toMatchObject({ result: 'Started the tests.' })

  const gone = new ClaudeNormalizer({ route: 'readonly', askTimeoutMs: 1000 })
  line(gone, frames.started)
  line(gone, frames.answer)
  expect(gone.end({ code: 0, signal: null }).events.find((e) => e.type === 'done')).toMatchObject({
    result: 'Started the tests.',
  })
})

it('Claude: ambient tasks (housekeeping, watchers) are not waited on', () => {
  const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000 })
  line(n, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'w1', task_type: 'local_bash', description: 'watch', ambient: true }],
  })
  expect(line(n, frames.answer).events.some((e) => e.type === 'done')).toBe(true)
})

it('Claude: an allowed MCP server that did not connect gets one warning, naming it; others are not judged', () => {
  const n = new ClaudeNormalizer({ route: 'readonly', askTimeoutMs: 1000, allowedMcp: ['docs', 'tickets'] })
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    mcp_servers: [
      { name: 'docs', status: 'failed' },
      { name: 'tickets', status: 'pending' },
      { name: 'other', status: 'failed' },
    ],
  }
  const warned = line(n, init).events.filter((e) => e.type === 'error')
  expect(warned).toHaveLength(1)
  expect(warned[0]).toMatchObject({ fatal: false })
  expect(warned[0]?.type === 'error' ? warned[0].message : '').toContain('docs')
  expect(warned[0]?.type === 'error' ? warned[0].raw : '').not.toContain('docs')
  // init again (a follow-up turn): no second warning.
  expect(line(n, init).events.filter((e) => e.type === 'error')).toEqual([])
})

const codexNormalizer = (): CodexNormalizer =>
  new CodexNormalizer({
    step: 'implement',
    mode: 'autoedit',
    cwd: '/repo',
    planNative: false,
    resumed: false,
    askTimeoutMs: 1000,
    allowRules: [],
    structured: false,
    loopback: false,
    now: Date.now,
  })

const activity = (kind: string, turnId = 't1') => ({
  threadId: 'main',
  turnId,
  item: {
    type: 'subAgentActivity',
    id: `a-${kind}`,
    kind,
    agentThreadId: 'sub',
    agentPath: '/root/run_tests',
  },
})

const tokens = (threadId: string, input: number, output: number) => ({
  threadId,
  turnId: 'x',
  tokenUsage: {
    total: {
      inputTokens: input,
      cachedInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  },
})

it('Codex: holds the answer until its sub-agents finish, keeping their words out of the conversation', () => {
  const n = codexNormalizer()
  n.session('main')
  n.turnStarted('t1')
  const note = (method: string, params: object) => n.notification(method, params)
  const started = note('item/started', activity('started'))
  expect(started.signals).toContainEqual({ type: 'waiting', tasks: ['sub-agent /root/run_tests'] })
  expect(started.events).toContainEqual({
    type: 'tool',
    id: 'subagent-sub',
    name: 'agent',
    summary: 'Sub-agent /root/run_tests',
    phase: 'start',
  })
  note('item/completed', {
    threadId: 'main',
    turnId: 't1',
    item: { type: 'agentMessage', id: 'm1', text: 'started' },
  })
  const ended = note('turn/completed', { threadId: 'main', turn: { id: 't1', status: 'completed' } })
  expect(ended.events.some((e) => e.type === 'done')).toBe(false)
  expect(n.waiting).toBe(true)

  // The sub-agent's own thread: its report is kept, not shown, and its turn/completed does not end the pass.
  const said = note('item/completed', {
    threadId: 'sub',
    turnId: 's1',
    item: { type: 'agentMessage', id: 'm2', text: 'All 42 tests pass.' },
  })
  expect(said.events).toEqual([])
  expect(note('item/agentMessage/delta', { threadId: 'sub', itemId: 'm2', delta: 'All' }).events).toEqual([])
  expect(note('turn/completed', { threadId: 'sub', turn: { id: 's1', status: 'completed' } }).events).toEqual(
    [],
  )
  expect(note('error', { threadId: 'sub', willRetry: false }).fatalPending).toBeUndefined()

  const finished = note('item/completed', activity('completed'))
  expect(finished.subAgentsDone).toBe(true)
  expect(finished.events).toContainEqual(
    expect.objectContaining({ id: 'subagent-sub', phase: 'end', status: 'ok' }),
  )
  expect(n.subAgentFollowUp()).toContain('All 42 tests pass.')
  n.newTurn()
  note('turn/started', { threadId: 'main', turn: { id: 't2' } })
  expect(n.turnId).toBe('t2')
  note('item/completed', {
    threadId: 'main',
    turnId: 't2',
    item: { type: 'agentMessage', id: 'm3', text: 'Done: the tests pass.' },
  })
  const done = note('turn/completed', {
    threadId: 'main',
    turn: { id: 't2', status: 'completed' },
  }).events.find((e) => e.type === 'done')
  expect(done).toMatchObject({ result: 'Done: the tests pass.' })
})

it("Codex: a sub-agent's tokens count toward the pass's usage", () => {
  const n = codexNormalizer()
  n.session('main')
  n.turnStarted('t1')
  n.notification('item/started', activity('started'))
  n.notification('thread/tokenUsage/updated', tokens('main', 100, 10))
  n.notification('thread/tokenUsage/updated', tokens('sub', 40, 4))
  // Totals are cumulative per thread: the latest one counts, not the sum of every report.
  n.notification('thread/tokenUsage/updated', tokens('sub', 50, 5))
  n.notification('item/completed', activity('completed'))
  const done = n
    .notification('turn/completed', { threadId: 'main', turn: { id: 't1', status: 'completed' } })
    .events.find((e) => e.type === 'done')
  expect(done).toMatchObject({ usage: { input: 150, output: 15 } })
})

it('Codex: a held answer ends with what it has when the wait runs out, or the process goes', () => {
  const n = codexNormalizer()
  n.session('main')
  n.turnStarted('t1')
  n.notification('item/started', activity('started'))
  n.notification('item/completed', {
    threadId: 'main',
    turnId: 't1',
    item: { type: 'agentMessage', id: 'm1', text: 'Started the sub-agent.' },
  })
  n.notification('turn/completed', { threadId: 'main', turn: { id: 't1', status: 'completed' } })
  expect(n.waiting).toBe(true)
  const done = n.finishHeld().events.find((e) => e.type === 'done')
  expect(done).toMatchObject({ result: 'Started the sub-agent.' })
  expect(n.waiting).toBe(false)

  const gone = codexNormalizer()
  gone.session('main')
  gone.turnStarted('t1')
  gone.notification('item/started', activity('started'))
  gone.notification('turn/completed', { threadId: 'main', turn: { id: 't1', status: 'completed' } })
  const end = gone.end({ code: 0, signal: null, ranMs: 10, stderrTail: [] })
  expect(end.events.find((e) => e.type === 'done')).toBeDefined()
})

it('Codex: a turn with no sub-agents still ends at turn/completed', () => {
  const n = codexNormalizer()
  n.session('main')
  n.turnStarted('t1')
  const ended = n.notification('turn/completed', {
    threadId: 'main',
    turn: { id: 't1', status: 'completed' },
  })
  expect(ended.events.some((e) => e.type === 'done')).toBe(true)
  expect(ended.signals.some((s) => s.type === 'waiting')).toBe(false)
})
