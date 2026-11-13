// IPC push (src/main/push-routing.ts, push.ts): the stream focus protocol, asks always forwarded, the per-run
// run-summary window with terminal flush, overflow → resync, batching into one message, and the heartbeat.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PushSink, eventSize, startHeartbeat } from '../../../src/main/push.ts'
import { SummaryDebouncer, forwardsRunEnvelope, keepOnOverflow } from '../../../src/main/push-routing.ts'
import { EVT_CHANNEL } from '../../../src/shared/ipc.ts'
import type { AppEvent } from '../../../src/shared/ipc.ts'
import type { RunEnvelope, RunStatus, RunSummary } from '../../../src/shared/run.ts'

let seq = 0
const textEnv = (runId: string, delta = 'x'): RunEnvelope => ({
  runId,
  seq: ++seq,
  ts: 0,
  body: { t: 'ev', step: 'plan', attempt: 1, ev: { type: 'text', delta } },
})
const askEnv = (runId: string): RunEnvelope => ({
  runId,
  seq: ++seq,
  ts: 0,
  body: {
    t: 'ev',
    step: 'implement',
    attempt: 1,
    ev: { type: 'ask', requestId: 'q1', kind: 'shell', detail: 'ls', expiresAt: 0, allowSession: true },
  },
})
const statusEnv = (runId: string): RunEnvelope => ({
  runId,
  seq: ++seq,
  ts: 0,
  body: { t: 'run-status', status: 'running', phase: 'planning' },
})
const summary = (runId: string, status: RunStatus, tokens = 0): RunSummary =>
  ({
    runId,
    status,
    title: runId,
    displayNo: 1,
    progress: { tokens, costUsd: null, filesChanged: 0 },
  }) as RunSummary

describe('forwardsRunEnvelope', () => {
  it('forwards ev bodies only for focused runs', () => {
    expect(forwardsRunEnvelope(textEnv('a'), new Set(['a']))).toBe(true)
    expect(forwardsRunEnvelope(textEnv('b'), new Set(['a']))).toBe(false)
  })

  it('always forwards asks', () => {
    expect(forwardsRunEnvelope(askEnv('b'), new Set())).toBe(true)
  })

  it('always forwards every non-ev body', () => {
    expect(forwardsRunEnvelope(statusEnv('b'), new Set())).toBe(true)
    const card: RunEnvelope = {
      runId: 'b',
      seq: 1,
      ts: 0,
      body: { t: 'diff-stats', files: 1, added: 1, deleted: 0, live: true },
    }
    expect(forwardsRunEnvelope(card, new Set())).toBe(true)
  })
})

describe('keepOnOverflow', () => {
  it('drops run envelopes, keeps globals in order and appends one merged resync', () => {
    const theme: AppEvent = { kind: 'theme', theme: { theme: 'dark', resolved: 'dark', accent: 'slate' } }
    const hb: AppEvent = { kind: 'heartbeat', at: 1 }
    const kept = keepOnOverflow([
      { kind: 'run', env: textEnv('a') },
      theme,
      { kind: 'resync', runIds: ['c'] },
      { kind: 'run', env: textEnv('b') },
      { kind: 'run', env: textEnv('a') },
      hb,
    ])
    expect(kept).toEqual([theme, hb, { kind: 'resync', runIds: ['a', 'c', 'b'] }])
  })

  it('adds no resync when nothing was dropped', () => {
    const hb: AppEvent = { kind: 'heartbeat', at: 1 }
    expect(keepOnOverflow([hb])).toEqual([hb])
  })
})

describe('SummaryDebouncer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends the latest summary once per window per run', () => {
    const out: RunSummary[] = []
    const d = new SummaryDebouncer({ delayMs: 1000, emit: (s) => out.push(s) })
    d.push(summary('a', 'running', 1))
    d.push(summary('a', 'running', 2))
    d.push(summary('b', 'running', 9))
    vi.advanceTimersByTime(999)
    expect(out).toEqual([])
    d.push(summary('a', 'running', 3))
    vi.advanceTimersByTime(1)
    expect(out.map((s) => [s.runId, s.progress.tokens])).toEqual([
      ['a', 3],
      ['b', 9],
    ])
    // A busy run is not starved: the next push opens a new window.
    d.push(summary('a', 'running', 4))
    vi.advanceTimersByTime(1000)
    expect(out.at(-1)?.progress.tokens).toBe(4)
    expect(d.pendingRuns).toBe(0)
  })

  it.each<RunStatus>(['completed', 'failed', 'cancelled'])(
    'sends a %s summary at once and drops the window',
    (st) => {
      const out: RunSummary[] = []
      const d = new SummaryDebouncer({ delayMs: 1000, emit: (s) => out.push(s) })
      d.push(summary('a', 'running', 1))
      d.push(summary('a', st, 2))
      expect(out.map((s) => s.status)).toEqual([st])
      vi.advanceTimersByTime(5000)
      expect(out).toHaveLength(1)
    },
  )

  it('flushAll sends pending summaries; dispose drops them', () => {
    const out: RunSummary[] = []
    const d = new SummaryDebouncer({ delayMs: 1000, emit: (s) => out.push(s) })
    d.push(summary('a', 'running'))
    d.flushAll()
    expect(out).toHaveLength(1)
    d.push(summary('b', 'running'))
    d.dispose()
    vi.advanceTimersByTime(5000)
    expect(out).toHaveLength(1)
  })
})

describe('PushSink', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function sink(o: { overflowItems?: number } = {}) {
    const sent: { channel: string; batch: AppEvent[] }[] = []
    let attached = true
    const warn = vi.fn()
    const s = new PushSink({
      target: () => (attached ? { send: (channel, batch) => sent.push({ channel, batch }) } : null),
      log: { warn, error: vi.fn() },
      batcher: { ...(o.overflowItems !== undefined ? { overflowItems: o.overflowItems } : {}) },
    })
    return {
      s,
      sent,
      warn,
      detach: () => {
        attached = false
      },
    }
  }

  it('batches bus traffic into one dimf:evt message per window', () => {
    const { s, sent } = sink()
    s.setFocus(['a'])
    s.run(textEnv('a', 'he'))
    s.run(textEnv('a', 'llo'))
    s.global({ kind: 'config-changed', scope: 'user' })
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe(EVT_CHANNEL)
    expect(sent[0]?.batch.map((e) => e.kind)).toEqual(['run', 'run', 'config-changed'])
  })

  it('applies the focus protocol and follows focus changes', () => {
    const { s, sent } = sink()
    s.run(textEnv('a'))
    s.run(askEnv('a'))
    s.run(statusEnv('a'))
    s.setFocus(['a'])
    s.run(textEnv('a', 'now'))
    vi.advanceTimersByTime(16)
    const bodies = sent.flatMap((m) => m.batch).map((e) => (e.kind === 'run' ? e.env.body.t : e.kind))
    expect(bodies).toEqual(['ev', 'run-status', 'ev'])
    expect(s.focused).toEqual(new Set(['a']))
  })

  it('debounces run-summary through the bus and emit() alike', () => {
    const { s, sent } = sink()
    s.global({ kind: 'run-summary', summary: summary('a', 'running', 1) })
    s.emit({ kind: 'run-summary', summary: summary('a', 'running', 2) })
    vi.advanceTimersByTime(1016)
    const sums = sent.flatMap((m) => m.batch).filter((e) => e.kind === 'run-summary')
    expect(sums).toHaveLength(1)
    expect(sums[0]?.kind === 'run-summary' && sums[0].summary.progress.tokens).toBe(2)
  })

  it('on overflow drops queued run envelopes and queues one resync', () => {
    const { s, sent, warn } = sink({ overflowItems: 5 })
    s.setFocus(['a', 'b'])
    s.emit({ kind: 'heartbeat', at: 1 })
    for (let i = 0; i < 3; i++) s.run(textEnv('a'))
    s.run(textEnv('b'))
    s.run(textEnv('b')) // 6th item → overflow
    s.run(textEnv('a')) // after the overflow: queued normally
    vi.advanceTimersByTime(40)
    const batch = sent.flatMap((m) => m.batch)
    expect(batch[0]).toEqual({ kind: 'heartbeat', at: 1 })
    expect(batch[1]).toEqual({ kind: 'resync', runIds: ['a', 'b'] })
    expect(batch.slice(2).map((e) => e.kind)).toEqual(['run'])
    expect(warn).toHaveBeenCalled()
  })

  it('drops batches while there is no window, and clears on reload', () => {
    const { s, sent, detach } = sink()
    detach()
    s.emit({ kind: 'heartbeat', at: 1 })
    vi.advanceTimersByTime(20)
    expect(sent).toHaveLength(0)
    const live = sink()
    live.s.setFocus(['a'])
    live.s.run(textEnv('a'))
    live.s.resetForReload()
    vi.advanceTimersByTime(20)
    expect(live.sent).toHaveLength(0)
    expect(live.s.focused.size).toBe(0)
  })

  it('a send that throws is reported, not thrown into the bus', () => {
    const error = vi.fn()
    const s = new PushSink({
      target: () => ({
        send: () => {
          throw new Error('Object has been destroyed')
        },
      }),
      log: { warn: vi.fn(), error },
    })
    s.emit({ kind: 'heartbeat', at: 1 })
    expect(() => vi.advanceTimersByTime(20)).not.toThrow()
    expect(error).toHaveBeenCalled()
  })

  it('flush() delivers pending summaries and the queue now; dispose() stops everything', () => {
    const { s, sent } = sink()
    s.emit({ kind: 'run-summary', summary: summary('a', 'running') })
    s.flush()
    expect(sent.flatMap((m) => m.batch).map((e) => e.kind)).toEqual(['run-summary'])
    s.dispose()
    s.emit({ kind: 'heartbeat', at: 2 })
    s.run(askEnv('a'))
    vi.advanceTimersByTime(2000)
    expect(sent).toHaveLength(1)
  })

  it('sizes events by their JSON length', () => {
    const ev: AppEvent = { kind: 'heartbeat', at: 12 }
    expect(eventSize(ev)).toBe(JSON.stringify(ev).length)
  })
})

describe('startHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('beats at once and every 5 s while shouldBeat holds', () => {
    const beats: number[] = []
    let visible = true
    let now = 100
    const stop = startHeartbeat({ shouldBeat: () => visible, beat: (at) => beats.push(at), now: () => now })
    expect(beats).toEqual([100])
    now = 200
    vi.advanceTimersByTime(5000)
    expect(beats).toEqual([100, 200])
    visible = false
    vi.advanceTimersByTime(5000)
    expect(beats).toHaveLength(2)
    stop()
    visible = true
    vi.advanceTimersByTime(20_000)
    expect(beats).toHaveLength(2)
  })
})
