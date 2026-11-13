import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { TimeWindowBatcher } from '../../../src/core/bus/batcher.ts'
import { COALESCE_FLUSH_MS, COALESCE_MAX_BYTES, TextCoalescer } from '../../../src/core/bus/coalesce.ts'
import type { CoalescedText } from '../../../src/core/bus/coalesce.ts'
import { RING_MAX_BYTES, RING_MAX_ITEMS, RingBuffer } from '../../../src/core/bus/ring.ts'

const env = (seq: number): RunEnvelope => ({
  runId: 'r',
  seq,
  ts: seq,
  body: { t: 'diff-stats', files: seq, added: 0, deleted: 0, live: true },
})

describe('RingBuffer', () => {
  it('defaults to 5000 envelopes / 8 MB', () => {
    const r = new RingBuffer()
    expect([r.maxItems, r.maxBytes]).toEqual([RING_MAX_ITEMS, RING_MAX_BYTES])
    expect([RING_MAX_ITEMS, RING_MAX_BYTES]).toEqual([5000, 8 * 1024 * 1024])
  })

  it('evicts the oldest by count and serves seq > sinceSeq', () => {
    const r = new RingBuffer({ maxItems: 5 })
    for (let s = 1; s <= 8; s++) r.push(env(s), 10)
    expect([r.firstSeq, r.lastSeq, r.length, r.bytes]).toEqual([4, 8, 5, 50])
    expect(r.since(3, 100)?.map((e) => e.seq)).toEqual([4, 5, 6, 7, 8])
    expect(r.since(5, 2)?.map((e) => e.seq)).toEqual([6, 7])
    expect(r.since(8, 10)).toEqual([])
    expect(r.since(2, 10)).toBeNull()
    expect(r.covers(3)).toBe(true)
    expect(r.covers(2)).toBe(false)
  })

  it('evicts by bytes but always keeps the newest', () => {
    const r = new RingBuffer({ maxItems: 100, maxBytes: 100 })
    for (let s = 1; s <= 5; s++) r.push(env(s), 30)
    expect([r.firstSeq, r.length, r.bytes]).toEqual([3, 3, 90])
    r.push(env(6), 500)
    expect([r.firstSeq, r.length]).toEqual([6, 1])
    r.clear()
    expect(r.since(0, 1)).toBeNull()
  })
})

describe('TextCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges deltas per (run, step, attempt) and flushes after 40 ms', () => {
    const out: CoalescedText[] = []
    const c = new TextCoalescer({ onFlush: (t) => out.push(t) })
    expect([c.flushMs, c.maxBytes]).toEqual([COALESCE_FLUSH_MS, COALESCE_MAX_BYTES])
    c.push('r', 'plan', 1, 'Hel')
    c.push('r', 'plan', 1, 'lo')
    c.push('r', 'review', 1, 'R')
    c.push('r', 'plan', 2, 'second attempt')
    vi.advanceTimersByTime(39)
    expect(out).toEqual([])
    vi.advanceTimersByTime(1)
    expect(out).toEqual([
      { runId: 'r', step: 'plan', attempt: 1, delta: 'Hello' },
      { runId: 'r', step: 'review', attempt: 1, delta: 'R' },
      { runId: 'r', step: 'plan', attempt: 2, delta: 'second attempt' },
    ])
    expect(c.size).toBe(0)
  })

  it('flushes at 8 KB without waiting for the timer', () => {
    const out: CoalescedText[] = []
    const c = new TextCoalescer({ onFlush: (t) => out.push(t), maxBytes: 8192 })
    c.push('r', 'plan', 1, 'a'.repeat(5000))
    expect(out).toHaveLength(0)
    c.push('r', 'plan', 1, 'b'.repeat(3192))
    expect(out).toHaveLength(1)
    expect(out[0]?.delta.length).toBe(8192)
    c.push('r', 'plan', 1, 'c')
    vi.advanceTimersByTime(40)
    expect(out.map((t) => t.delta)).toEqual(['a'.repeat(5000) + 'b'.repeat(3192), 'c'])
  })

  it('flushStep / flushRun / discardRun target only their buffers', () => {
    const out: CoalescedText[] = []
    const c = new TextCoalescer({ onFlush: (t) => out.push(t) })
    c.push('a', 'plan', 1, 'p1')
    c.push('a', 'plan', 2, 'p2')
    c.push('a', 'review', 1, 'rv')
    c.push('b', 'plan', 1, 'other run')
    c.flushStep('a', 'plan')
    expect(out.map((t) => t.delta)).toEqual(['p1', 'p2'])
    expect(c.hasPending('a', 'plan')).toBe(false)
    expect(c.hasPending('a')).toBe(true)
    c.flushRun('a')
    expect(out.map((t) => t.delta)).toEqual(['p1', 'p2', 'rv'])
    c.discardRun('b')
    vi.advanceTimersByTime(100)
    expect(out).toHaveLength(3)
  })
})

describe('TimeWindowBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes 16 ms after the first enqueue', () => {
    const batches: number[][] = []
    const b = new TimeWindowBatcher<number>({ flush: (items) => batches.push(items) })
    b.push(1)
    vi.advanceTimersByTime(10)
    b.push(2)
    vi.advanceTimersByTime(5)
    expect(batches).toEqual([])
    vi.advanceTimersByTime(1)
    expect(batches).toEqual([[1, 2]])
    expect(b.windowMs).toBe(16)
  })

  it('uses a 33 ms window after a slow flush or a big queue, and returns to 16 ms', () => {
    let clock = 0
    const batches: number[][] = []
    const b = new TimeWindowBatcher<number>({
      now: () => clock,
      flush: (items) => {
        batches.push(items)
        clock += items.includes(99) ? 10 : 0
      },
      bigQueue: 3,
    })
    b.push(99)
    vi.advanceTimersByTime(16)
    expect(b.windowMs).toBe(33)
    b.push(1)
    vi.advanceTimersByTime(32)
    expect(batches).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(batches).toHaveLength(2)
    expect(b.windowMs).toBe(16)
    for (let i = 0; i < 5; i++) b.push(i)
    expect(b.windowMs).toBe(33)
    vi.advanceTimersByTime(16)
    expect(batches).toHaveLength(3)
    expect(b.windowMs).toBe(33)
  })

  it('applies the overflow policy past 5000 items or 2 MB and never throws', () => {
    const batches: string[][] = []
    const b = new TimeWindowBatcher<string>({
      flush: (items) => {
        batches.push(items)
        throw new Error('sink bug')
      },
      sizeOf: (s) => s.length,
      overflowItems: 10,
      overflowBytes: 1000,
      onOverflow: (q) => ['resync', ...q.filter((x) => x.startsWith('status'))],
      onError: () => undefined,
    })
    for (let i = 0; i < 11; i++) b.push(i === 3 ? 'status' : `run${i}`)
    expect(b.overflows).toBe(1)
    expect(b.length).toBe(2)
    b.push('x'.repeat(1200))
    expect(b.overflows).toBe(2)
    vi.advanceTimersByTime(40)
    expect(batches).toEqual([['resync', 'status']])
    b.dispose()
    b.push('ignored')
    expect(b.length).toBe(0)
  })
})
