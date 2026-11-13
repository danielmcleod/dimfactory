// `muse exec --json` records → normalized events (the synthesized pin in
// src/core/adapters/muse/protocol/): the session stream, text from run.output.delta, tool rows from tool tasks, the
// terminal record, usage (x-assumed shapes), and the end of a run that left no terminal record. Never an ask.
import { describe, expect, it } from 'vitest'
import { MuseNormalizer, museUsage } from '@core/adapters/muse/normalize.ts'
import type { MuseStep } from '@core/adapters/muse/normalize.ts'
import type { AdapterSignal, NormalizedEvent } from '@shared/events.ts'

const SESSION = '0199d2a0-4c1e-7a3b-8d5f-6e7a8b9c0001'
let seq = 0
function rec(
  payloadType: string,
  payload: Record<string, unknown>,
  stream = SESSION,
): Record<string, unknown> {
  seq++
  return {
    schema_version: 1,
    id: `r${seq}`,
    stream: { kind: 'session', id: stream },
    sequence: seq,
    recorded_at: seq,
    record_type: 'event',
    durability: 'durable',
    causation_id: 'c',
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  }
}
const lifecycle = (task: string, kind: string, extra: Record<string, unknown> = {}) =>
  rec(`task.lifecycle.${kind}`, {
    kind: 'task_lifecycle',
    task_id: task,
    event: { kind, task_id: task, ...extra },
  })
const delta = (text: string) => rec('run.output.delta', { kind: 'run_output_delta', text })
const completed = (o: Record<string, unknown> = {}) =>
  rec('run.terminal.completed', { kind: 'run_terminal', terminal: 'completed', reason: null, ...o })
const toolResult = (call: string, o: Record<string, unknown> = {}) =>
  rec('tool.result', {
    kind: 'tool_result',
    call_id: call,
    text: 'x',
    correlation_facts: { outcome: 'success' },
    ...o,
  })

function normalizer(o: Partial<ConstructorParameters<typeof MuseNormalizer>[0]> = {}): MuseNormalizer {
  return new MuseNormalizer({ step: 'implement', mode: 'autoedit', cwd: '/w', now: () => 5000, ...o })
}

function feed(
  n: MuseNormalizer,
  records: Record<string, unknown>[],
): { events: NormalizedEvent[]; signals: AdapterSignal[]; steps: MuseStep[] } {
  const steps = records.map((r) => n.line(JSON.stringify(r)))
  return {
    events: steps.flatMap((s) => s.events),
    signals: steps.flatMap((s) => s.signals).filter((s) => s.type !== 'liveness'),
    steps,
  }
}

/** A tool task's records: proposed, scheduled with its call id, the policy decision, then the given tail. */
const toolTask = (task: string, name: string, call: string, policy = 'allow:policy') => [
  lifecycle(task, 'proposed', { task_kind: `tool.${name}` }),
  lifecycle(task, 'accepted'),
  lifecycle(task, 'scheduled', { idempotency_key: `tool:${call}` }),
  lifecycle(task, 'side_effect_intent', { operation: `tool:${name}`, policy_decision: policy }),
]

describe('records → events', () => {
  it('the session once (from the session stream), text deltas, and done with the terminal text', () => {
    const n = normalizer()
    const { events } = feed(n, [
      rec('runtime.command.accepted', { kind: 'command_accepted' }),
      rec('session.run.linked', { kind: 'session_run_linked' }),
      delta('Hello '),
      delta('world.'),
      completed({ text: 'Hello world.' }),
    ])
    expect(events).toEqual([
      { type: 'session', id: SESSION },
      { type: 'text', delta: 'Hello ' },
      { type: 'text', delta: 'world.' },
      { type: 'done', result: 'Hello world.' },
    ])
    expect(n.sessionId()).toBe(SESSION)
    expect(n.terminal).toBe(true)
    // Nothing after the terminal event.
    expect(n.line(JSON.stringify(delta('late'))).events).toEqual([])
  })

  it('a run that streamed nothing shows its terminal text once; done.result is the text since the last tool', () => {
    const quiet = feed(normalizer(), [completed({ text: 'Only at the end.' })]).events
    expect(quiet).toEqual([
      { type: 'session', id: SESSION },
      { type: 'text', delta: 'Only at the end.' },
      { type: 'done', result: 'Only at the end.' },
    ])
    const n = normalizer()
    const { events } = feed(n, [
      delta('Before. '),
      ...toolTask('t1', 'read_file', 'call_1'),
      lifecycle('t1', 'started'),
      lifecycle('t1', 'completed'),
      delta('After.'),
      completed({ text: null }),
    ])
    expect(events.at(-1)).toEqual({ type: 'done', result: 'After.' })
  })

  it('names the model Muse configured (META_MODEL_USED) only for a pass that names none', () => {
    const configured = rec('run.model.configured', { kind: 'model_configured', model_id: 'muse-spark-1.2' })
    expect(feed(normalizer(), [configured]).signals).toEqual([
      { type: 'meta', key: 'modelUsed', value: { model: 'muse-spark-1.2' } },
    ])
    expect(feed(normalizer({ model: 'muse-spark-1.2' }), [configured]).signals).toEqual([])
  })

  it('tool tasks: start and end by task id; ok, failed, declined; other tasks are not tools', () => {
    const n = normalizer()
    const { events } = feed(n, [
      lifecycle('m1', 'proposed', { task_kind: 'model.meta.response' }),
      lifecycle('m1', 'started'),
      lifecycle('m1', 'completed'),
      lifecycle('r1', 'proposed', { task_kind: 'reminder.agent.plugin:x:skill-reminder' }),
      lifecycle('r1', 'rejected', { reason: 'skip_if_running' }),
      ...toolTask('t1', 'write_file', 'call_a'),
      lifecycle('t1', 'started'),
      toolResult('call_a', { edit_facts: { path: '/w/src/cli.ts', added: 3 } }),
      lifecycle('t1', 'completed'),
      ...toolTask('t2', 'bash', 'call_b'),
      lifecycle('t2', 'started'),
      toolResult('call_b', { correlation_facts: { outcome: 'error' } }),
      lifecycle('t2', 'completed'),
      ...toolTask('t3', 'bash', 'call_c'),
      lifecycle('t3', 'started'),
      lifecycle('t3', 'failed', { reason: 'exit status 2' }),
      ...toolTask('t4', 'bash', 'call_d'),
      lifecycle('t4', 'started'),
      lifecycle('t4', 'cancelled', { reason: 'run completed' }),
    ])
    const tools = events.filter((e) => e.type === 'tool')
    expect(tools.map((e) => (e.type === 'tool' ? [e.id, e.name, e.phase, e.status ?? null] : null))).toEqual([
      ['t1', 'write_file', 'start', null],
      ['t1', 'write_file', 'end', 'ok'],
      ['t2', 'bash', 'start', null],
      ['t2', 'bash', 'end', 'failed'],
      ['t3', 'bash', 'start', null],
      ['t3', 'bash', 'end', 'failed'],
      ['t4', 'bash', 'start', null],
      ['t4', 'bash', 'end', 'failed'],
    ])
    // A file inside the pass folder reads relative to it once tool.result named it.
    const end = tools[1]
    expect(end?.type === 'tool' ? end.summary : '').toBe('write_file src/cli.ts')
  })

  it('no relay: a refused escalation is a declined tool row (never an ask), even when it never started', () => {
    const { events } = feed(normalizer(), [
      ...toolTask('t1', 'bash', 'call_n', 'deny:approval_disabled'),
      toolResult('call_n', { correlation_facts: { outcome: 'denied' } }),
      lifecycle('t1', 'failed', { reason: 'approval required, but approvals are disabled' }),
      ...toolTask('t2', 'bash', 'call_m'),
      lifecycle('t2', 'started'),
      lifecycle('t2', 'failed', { reason: 'network access requires approval' }),
      ...toolTask('t3', 'write_file', 'call_o'),
      lifecycle('t3', 'rejected', { reason: 'outside the workspace' }),
    ])
    expect(events.filter((e) => e.type === 'ask')).toEqual([])
    expect(events.map((e) => (e.type === 'tool' ? `${e.id}:${e.phase}:${e.status ?? ''}` : e.type))).toEqual([
      'session',
      't1:start:',
      't1:end:declined',
      't2:start:',
      't2:end:declined',
      't3:start:',
      't3:end:declined',
    ])
  })

  it('a tool.result that comes before its task named the call is kept for it', () => {
    const { events } = feed(normalizer(), [
      lifecycle('t1', 'proposed', { task_kind: 'tool.edit_file' }),
      toolResult('call_e', { edit_facts: { path: '/w/a.ts' } }),
      lifecycle('t1', 'scheduled', { idempotency_key: 'tool:call_e' }),
      lifecycle('t1', 'started'),
      lifecycle('t1', 'completed'),
    ])
    const end = events.find((e) => e.type === 'tool' && e.phase === 'end')
    expect(end).toMatchObject({ status: 'ok', summary: 'edit_file a.ts' })
  })

  it('stray stdout lines are no events; a non-record JSON line is ignored too', () => {
    const n = normalizer()
    expect(n.line('Muse Code 1.4.2').events).toEqual([])
    expect(n.line('{"hello":1}').events).toEqual([])
    expect(n.line('   ').events).toEqual([])
  })
})

describe('usage (x-assumed shapes: no capture shows exec usage)', () => {
  it('reads Responses-style usage; cached tokens come off input; reasoning stays inside output', () => {
    expect(
      museUsage({
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 600 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toEqual({ input: 400, output: 50, cacheRead: 600, reasoning: 20 })
    expect(museUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
    })
    expect(museUsage({ total_tokens: 5 })).toBeUndefined()
    expect(museUsage('nope')).toBeUndefined()
  })

  it('sums model calls from producer facets; a usage on the terminal record wins', () => {
    const facet = (input: number, cached: number, output: number) =>
      lifecycle('m', 'status', {
        details: {
          phase: 'stream_succeeded',
          facets: [
            {
              kind: 'producer',
              detail: {
                kind: 'provider',
                usage: {
                  input_tokens: input,
                  input_tokens_details: { cached_tokens: cached },
                  output_tokens: output,
                },
              },
            },
          ],
        },
      })
    const a = feed(normalizer(), [facet(100, 40, 10), facet(200, 100, 20), completed({ text: 'ok' })])
    expect(a.events.at(-1)).toEqual({
      type: 'done',
      result: 'ok',
      usage: expect.objectContaining({ input: 160, output: 30, cacheRead: 140 }) as unknown,
    })
    const n = normalizer()
    const b = feed(n, [
      facet(100, 40, 10),
      completed({ text: 'ok', usage: { input_tokens: 999, output_tokens: 9 } }),
    ])
    expect(b.events.at(-1)).toMatchObject({ usage: { input: 999, output: 9, cacheRead: 0 } })
    expect(n.cumulativeUsage()).toMatchObject({ input: 999 })
  })
})

describe('the end of a run', () => {
  it('a failed terminal record waits for the exit, then is classified with the last stderr line', () => {
    const n = normalizer()
    const { events, steps } = feed(n, [
      rec('runtime.command.accepted', {}),
      rec('run.terminal.failed', {
        kind: 'run_terminal',
        terminal: 'failed',
        reason: 'Not signed in: set META_API_KEY.',
      }),
    ])
    expect(events.filter((e) => e.type === 'error' || e.type === 'done')).toEqual([])
    expect(steps.at(-1)?.terminalRecord).toBe(true)
    const end = n.end({
      code: 1,
      signal: null,
      ranMs: 900,
      stderrTail: ['error: Not signed in: set META_API_KEY.'],
    })
    expect(end.events).toEqual([
      expect.objectContaining({ type: 'error', fatal: true, category: 'auth_required' }),
    ])
  })

  it('exit 0 without a terminal record is stream_malformed; exit 2 is flag_drift; a silent crash is process_crash', () => {
    const quiet = normalizer()
    expect(quiet.end({ code: 0, signal: null, ranMs: 10, stderrTail: [] }).events[0]).toMatchObject({
      category: 'stream_malformed',
    })
    const usage = normalizer()
    expect(
      usage.end({
        code: 2,
        signal: null,
        ranMs: 10,
        stderrTail: ["error: unexpected argument '--prompt-file'"],
      }).events[0],
    ).toMatchObject({ category: 'flag_drift' })
    const crash = normalizer()
    expect(crash.end({ code: 3221225477, signal: null, ranMs: 10, stderrTail: [] }).events[0]).toMatchObject({
      category: 'process_crash',
    })
  })

  it("Dim Factory's own stop wins over what the process said: user_cancelled, timeout_hard", () => {
    const user = normalizer()
    user.markKilled('stop')
    expect(
      user.end({ code: 1, signal: null, ranMs: 10, stderrTail: ['error: cancelled'] }).events[0],
    ).toMatchObject({
      category: 'user_cancelled',
    })
    const hard = normalizer()
    hard.markKilled('hard')
    expect(hard.end({ code: null, signal: 'SIGKILL', ranMs: 10, stderrTail: [] }).events[0]).toMatchObject({
      category: 'timeout_hard',
    })
  })

  it('a failed run that billed reports its usage as a META_USAGE signal before the error', () => {
    const n = normalizer()
    feed(n, [
      lifecycle('m', 'status', {
        details: {
          facets: [{ kind: 'producer', detail: { usage: { input_tokens: 10, output_tokens: 1 } } }],
        },
      }),
    ])
    const end = n.end({ code: 1, signal: null, ranMs: 10, stderrTail: ['error: 429 Too Many Requests'] })
    expect(end.signals).toEqual([
      { type: 'meta', key: 'usage', value: { input: 10, output: 1, cacheRead: 0 } },
    ])
    expect(end.events[0]).toMatchObject({ type: 'error', category: 'rate_limited' })
  })

  it('after done the exit changes nothing (1.4.2: a completed run whose cleanup stalled)', () => {
    const n = normalizer()
    feed(n, [completed({ text: 'ok' })])
    expect(n.end({ code: 1, signal: null, ranMs: 10, stderrTail: ['cleanup stalled'] }).events).toEqual([])
  })
})
