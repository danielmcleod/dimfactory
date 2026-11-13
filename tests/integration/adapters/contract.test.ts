// The adapter contract invariants, checked on every Claude fixture (recorded and synthesized). The replay test
// proves the real adapter emits exactly what the normalizer does for each recording, so these hold for it too.
import { describe, expect, it } from 'vitest'
import type { RecordingEntry } from '../../../src/core/adapters/claude/normalize.ts'
import {
  ClaudeNormalizer,
  normalizeRecording,
  routeFromArgv,
} from '../../../src/core/adapters/claude/normalize.ts'
import { obj, parseFrame, str } from '../../../src/core/adapters/claude/protocol.ts'
import { addUsage, USAGE_FIELDS } from '../../../src/core/adapters/usage.ts'
import type { Usage } from '../../../src/shared/events.ts'
import { loadRecording, recordingIds, terminals } from './helpers.ts'
import { synth } from '../../synth.ts'

const ids = recordingIds()

function expectedText(text: string): string {
  let out = ''
  for (const raw of text.split(/\r?\n/)) {
    const fr = parseFrame(raw)
    if (fr?.['dir'] !== 'out' || typeof fr['line'] !== 'string') continue
    const f = parseFrame(fr['line'])
    if (f?.['type'] !== 'stream_event' || (f['parent_tool_use_id'] ?? null) !== null) continue
    const delta = obj(obj(f['event'])?.['delta'])
    if (delta?.['type'] === 'text_delta') out += str(delta['text']) ?? ''
  }
  return out
}

function checkInvariants(entries: readonly RecordingEntry[], o: { readOnly: boolean; text?: string }): void {
  // exactly one terminal event, and it is the last event
  const terms = terminals(entries)
  expect(terms).toHaveLength(1)
  const events = entries.filter((e) => ['session', 'text', 'tool', 'ask', 'done', 'error'].includes(e.type))
  expect(events.at(-1)).toBe(terms[0])

  // no double-printed text: text events are exactly the main-thread text_delta stream, once
  if (o.text !== undefined) {
    const printed = entries.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
    expect(printed).toBe(o.text)
  }

  // every ask is answered or withdrawn, exactly once; automatic answers never raise an ask
  const asks = entries.flatMap((e) => (e.type === 'ask' ? [e.requestId] : []))
  const answered = entries.flatMap((e) =>
    e.type === 'stdin' && e.frame.type === 'control_response' ? [e.frame.response.request_id] : [],
  )
  const withdrawn = entries.flatMap((e) => (e.type === 'ask-withdrawn' ? [e.requestId] : []))
  const auto = entries.flatMap((e) => (e.type === 'auto-answered' ? [e.requestId] : []))
  for (const id of asks)
    expect(answered.filter((a) => a === id).length + withdrawn.filter((w) => w === id).length).toBe(1)
  for (const id of auto) expect(asks).not.toContain(id)
  expect(new Set(answered).size).toBe(answered.length)

  // zero asks in read-only passes
  if (o.readOnly) expect(asks).toEqual([])

  // per-pass usage ≥ 0
  for (const e of entries) {
    if (e.type !== 'done' || e.usage === undefined) continue
    for (const f of USAGE_FIELDS) expect(e.usage[f] ?? 0).toBeGreaterThanOrEqual(0)
  }

  // session before done
  const done = entries.findIndex((e) => e.type === 'done')
  if (done !== -1) {
    const session = entries.findIndex((e) => e.type === 'session')
    expect(session).toBeGreaterThanOrEqual(0)
    expect(session).toBeLessThan(done)
  }
}

describe('contract invariants: recorded fixtures', () => {
  it.each(ids)('%s', (id) => {
    const rec = loadRecording(id)
    const { route } = routeFromArgv(rec.header.argv ?? [])
    const entries = normalizeRecording(rec.text)
    // C24a asks a third turn after the compaction (to see the reminder reach the model), which a pass never sends: the
    // normalizer prints the pass's turn only, so the whole recording's text is not what it printed.
    const text = id === 'C24a-compaction-reminder' ? undefined : expectedText(rec.text)
    checkInvariants(entries, { readOnly: route !== 'edit', ...(text !== undefined ? { text } : {}) })
  })

  it('C01b (no partial messages) prints nothing yet still returns the final message', () => {
    const entries = normalizeRecording(loadRecording('C01b-plain-text-no-partial').text)
    expect(entries.filter((e) => e.type === 'text')).toEqual([])
    expect(entries.find((e) => e.type === 'done')).toMatchObject({ result: synth('hello') })
  })

  it('C08: per-pass usage across --resume sums to the final cumulative total', () => {
    const a = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1 })
    const usages: Usage[] = []
    const feed = (n: ClaudeNormalizer, id: string): void => {
      for (const f of loadRecording(id).frames) {
        if (f.dir !== 'out' || f.line === undefined) continue
        for (const e of n.line(f.line).events) if (e.type === 'done' && e.usage) usages.push(e.usage)
      }
    }
    feed(a, 'C08a-session-id-implement')
    const b = new ClaudeNormalizer({
      route: 'edit',
      askTimeoutMs: 1,
      resumed: true,
      priorUsage: a.cumulativeUsage(),
    })
    feed(b, 'C08b-resume-fix')
    expect(usages).toHaveLength(2)
    expect(usages[1]).toMatchObject({ input: 4, output: 231, cacheRead: 51887, cacheWrite: 415 })
    expect(usages[1]!.costUsd).toBeCloseTo(0.0143554, 9)
    const total = addUsage(usages[0]!, usages[1]!)
    const cumulative = b.cumulativeUsage()!
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
      expect(total[f]).toBe(cumulative[f])
    expect(total.costUsd).toBeCloseTo(cumulative.costUsd!, 9)
    // The session id survives the resume (no fork).
    expect(b.sessionId()).toBe(a.sessionId())
  })
})

describe('contract invariants: synthesized sessions', () => {
  const frame = (v: unknown): string => JSON.stringify(v)
  const run = (
    route: 'edit' | 'plan' | 'readonly',
    lines: unknown[],
    answers: Record<string, 'allow' | 'deny'> = {},
  ) => {
    const n = new ClaudeNormalizer({ route, askTimeoutMs: 1000, now: () => 0 })
    const out: RecordingEntry[] = []
    const take = (s: ReturnType<ClaudeNormalizer['line']>): void => {
      out.push(...s.signals, ...s.events, ...s.stdin.map((f) => ({ type: 'stdin' as const, frame: f })))
    }
    for (const l of lines) {
      take(n.line(frame(l)))
      for (const [id, d] of Object.entries(answers)) if (n.pendingAsks().includes(id)) take(n.answer(id, d))
    }
    take(n.end({ code: 0, signal: null }))
    return out
  }
  const init = { type: 'system', subtype: 'init', session_id: 's1' }
  const ask = (id: string) => ({
    type: 'control_request',
    request_id: id,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: `echo ${id}` },
      tool_use_id: `t-${id}`,
    },
  })
  const ok = { type: 'result', subtype: 'success', is_error: false, result: 'fine', modelUsage: {} }

  it('withdrawn and answered asks', () => {
    const entries = run(
      'edit',
      [init, ask('a'), { type: 'control_cancel_request', request_id: 'a' }, ask('b'), ok],
      { b: 'deny' },
    )
    checkInvariants(entries, { readOnly: false })
  })

  it('a host ask in a read-only plan pass is answered automatically', () => {
    checkInvariants(run('plan', [init, ask('a'), ok]), { readOnly: true })
  })

  it('a process that exits without a result still ends with one terminal', () => {
    checkInvariants(run('edit', [init, keepAliveFrame()]), { readOnly: false })
  })
})

function keepAliveFrame(): unknown {
  return { type: 'keep_alive' }
}
