// lib/streamBuffer.ts: block building, the 400-block cap with full text kept, seq idempotence and frame batching.
import './helpers/rtl.ts'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STREAM_BLOCK_CAP,
  StreamBuffer,
  TEXT_BLOCK_HARD_CHARS,
  TEXT_BLOCK_SOFT_CHARS,
  streamBuffer,
  useStream,
} from '@renderer/lib/streamBuffer.ts'
import type { StreamBlock } from '@renderer/lib/streamBuffer.ts'
import { env, ev, text, textLog } from './helpers/fixtures.ts'

/** A buffer whose frame callbacks run only when the test says so. */
function manual(cap?: number): { buf: StreamBuffer; frames: () => number; runFrame: () => void } {
  const queue: (() => void)[] = []
  const buf = new StreamBuffer({ schedule: (cb) => queue.push(cb), ...(cap !== undefined ? { cap } : {}) })
  return {
    buf,
    frames: () => queue.length,
    runFrame: () => {
      for (const cb of queue.splice(0)) cb()
    },
  }
}

const kinds = (blocks: readonly StreamBlock[]): string[] => blocks.map((b) => b.kind)

describe('streamBuffer blocks', () => {
  it('coalesces consecutive text deltas and starts a new block after any other block', () => {
    const { buf } = manual()
    buf.apply(env('r1', 1, text('plan', 'Hello ')))
    buf.apply(env('r1', 2, text('plan', 'world\n')))
    buf.apply(
      env('r1', 3, ev('plan', { type: 'tool', id: 't1', name: 'Read', summary: 'a.ts', phase: 'start' })),
    )
    buf.apply(env('r1', 4, text('plan', 'More')))
    buf.flush()
    const s = buf.snapshot('r1', 'plan')
    expect(kinds(s.blocks)).toEqual(['text', 'tool', 'text'])
    expect(s.blocks[0]).toMatchObject({ kind: 'text', text: 'Hello world\n', seq: 1 })
    expect(s.blocks[2]).toMatchObject({ kind: 'text', text: 'More' })
    expect(buf.streamText('r1', 'plan')).toBe('Hello world\nMore')
  })

  it('merges a tool start and end by id, with times from the envelopes', () => {
    const { buf } = manual()
    buf.apply(
      env(
        'r1',
        1,
        ev('implement', { type: 'tool', id: 'a', name: 'Bash', summary: 'npm test', phase: 'start' }),
        1000,
      ),
    )
    buf.apply(
      env(
        'r1',
        2,
        ev('implement', { type: 'tool', id: 'b', name: 'Edit', summary: 'x.ts', phase: 'start' }),
        1100,
      ),
    )
    buf.apply(
      env(
        'r1',
        3,
        ev('implement', {
          type: 'tool',
          id: 'a',
          name: 'Bash',
          summary: 'npm test',
          phase: 'end',
          status: 'failed',
        }),
        4000,
      ),
    )
    buf.apply(
      env(
        'r1',
        4,
        ev('implement', {
          type: 'tool',
          id: 'b',
          name: 'Edit',
          summary: 'x.ts',
          phase: 'end',
          status: 'declined',
        }),
        4100,
      ),
    )
    buf.flush()
    const blocks = buf.snapshot('r1', 'implement').blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      toolId: 'a',
      status: 'failed',
      startedAt: 1000,
      endedAt: 4000,
    })
    expect(blocks[1]).toMatchObject({
      kind: 'tool',
      toolId: 'b',
      status: 'declined',
      startedAt: 1100,
      endedAt: 4100,
    })
  })

  it('a second start for a running row is its progress: the row keeps its place and takes the new summary', () => {
    const { buf } = manual()
    const agent = (seq: number, summary: string, phase: 'start' | 'end', at: number) =>
      env(
        'r1',
        seq,
        ev('review', {
          type: 'tool',
          id: 'ag',
          name: 'Agent',
          summary,
          phase,
          ...(phase === 'end' ? { status: 'ok' } : {}),
        }),
        at,
      )
    buf.apply(agent(1, 'Summarize src', 'start', 100))
    buf.apply(env('r1', 2, text('review', 'Looking.')))
    buf.apply(agent(3, 'Summarize src · general-purpose · Read · 18.7k tokens', 'start', 200))
    buf.flush()
    let blocks = buf.snapshot('r1', 'review').blocks
    expect(kinds(blocks)).toEqual(['tool', 'text'])
    expect(blocks[0]).toMatchObject({
      status: 'running',
      startedAt: 100,
      summary: 'Summarize src · general-purpose · Read · 18.7k tokens',
    })
    buf.apply(agent(4, 'Summarize src', 'end', 300))
    buf.flush()
    blocks = buf.snapshot('r1', 'review').blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      status: 'ok',
      endedAt: 300,
      summary: 'Summarize src · general-purpose · Read · 18.7k tokens',
    })
  })

  it('shows an end without a start, and a tool event without phase, as finished rows', () => {
    const { buf } = manual()
    buf.apply(
      env('r1', 1, ev('fix', { type: 'tool', id: 'x', name: 'Write', summary: 'y', phase: 'end' }), 50),
    )
    buf.apply(env('r1', 2, ev('fix', { type: 'tool', name: 'WebSearch', summary: 'q', status: 'ok' }), 60))
    buf.flush()
    const blocks = buf.snapshot('r1', 'fix').blocks
    expect(blocks[0]).toMatchObject({ status: 'ok', startedAt: 50, endedAt: 50 })
    expect(blocks[1]).toMatchObject({ status: 'ok', startedAt: 60, endedAt: 60, name: 'WebSearch' })
  })

  it('keeps ask markers and updates them when answered or extended', () => {
    const { buf } = manual()
    const ask = {
      type: 'ask' as const,
      requestId: 'q1',
      kind: 'shell' as const,
      detail: 'rm -rf build',
      expiresAt: 9000,
      allowSession: true,
    }
    buf.apply(env('r1', 1, ev('implement', ask)))
    buf.apply(env('r1', 2, { t: 'ask-extended', step: 'implement', requestId: 'q1', expiresAt: 12_000 }))
    buf.apply(
      env(
        'r1',
        3,
        { t: 'ask-resolved', step: 'implement', requestId: 'q1', by: 'user', via: 'app', decision: 'deny' },
        5000,
      ),
    )
    buf.flush()
    expect(buf.snapshot('r1', 'implement').blocks[0]).toMatchObject({
      kind: 'ask',
      requestId: 'q1',
      askKind: 'shell',
      expiresAt: 12_000,
      resolved: { by: 'user', via: 'app', decision: 'deny', at: 5000 },
    })
  })

  it('records auto-answered notes, errors and the done marker', () => {
    const { buf } = manual()
    buf.apply(
      env('r1', 1, {
        t: 'auto-answered',
        step: 'review',
        attempt: 1,
        requestId: 'q',
        tool: 'Read',
        decision: 'allow',
        why: 'readonly',
      }),
    )
    buf.apply(env('r1', 2, ev('review', { type: 'error', message: 'slow down', raw: '', fatal: false })))
    buf.apply(env('r1', 3, ev('review', { type: 'done', result: 'ok', usage: { input: 10, output: 5 } })))
    buf.flush()
    const s = buf.snapshot('r1', 'review')
    expect(kinds(s.blocks)).toEqual(['auto', 'error', 'done'])
    expect(s.blocks[2]).toMatchObject({ result: 'ok', usage: { input: 10, output: 5 } })
    expect(s.done).toBe(true)
  })

  it('ignores session events and other bodies', () => {
    const { buf } = manual()
    buf.apply(env('r1', 1, ev('plan', { type: 'session', id: 's' })))
    buf.apply(env('r1', 2, { t: 'run-status', status: 'running', phase: 'planning' }))
    buf.flush()
    expect(buf.snapshot('r1', 'plan').blocks).toEqual([])
    expect(buf.lastSeq('r1')).toBe(2)
  })
})

describe('streamBuffer cap and full text', () => {
  it(`keeps the last ${STREAM_BLOCK_CAP} blocks, counts the dropped ones and keeps the full text`, () => {
    const { buf } = manual()
    let expected = ''
    let seq = 0
    for (let i = 0; i < 300; i++) {
      const t = `chunk ${i}\n`
      expected += t
      buf.apply(env('r1', ++seq, text('implement', t)))
      buf.apply(
        env('r1', ++seq, ev('implement', { type: 'tool', name: 'Read', summary: `f${i}`, status: 'ok' })),
      )
    }
    buf.flush()
    const s = buf.snapshot('r1', 'implement')
    expect(s.blocks).toHaveLength(STREAM_BLOCK_CAP)
    expect(s.dropped).toBe(600 - STREAM_BLOCK_CAP)
    expect(s.blocks.at(-1)).toMatchObject({ kind: 'tool', summary: 'f299' })
    expect(buf.streamText('r1', 'implement')).toBe(expected)
    // Block ids stay unique and increasing across the drop.
    const ids = s.blocks.map((b) => b.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('finishes a tool whose start is still kept, and a late end of a dropped start becomes its own row', () => {
    const { buf } = manual(3)
    buf.apply(
      env('r1', 1, ev('fix', { type: 'tool', id: 'old', name: 'Bash', summary: 'a', phase: 'start' })),
    )
    for (let i = 2; i <= 4; i++)
      buf.apply(env('r1', i, ev('fix', { type: 'tool', name: 'Read', summary: `${i}` })))
    buf.apply(
      env(
        'r1',
        5,
        ev('fix', { type: 'tool', id: 'old', name: 'Bash', summary: 'a', phase: 'end', status: 'ok' }),
      ),
    )
    buf.flush()
    const s = buf.snapshot('r1', 'fix')
    expect(s.blocks).toHaveLength(3)
    expect(s.blocks.at(-1)).toMatchObject({ toolId: 'old', status: 'ok' })
  })

  it('splits long text after a newline past the soft limit and never grows a block past the hard limit', () => {
    const { buf } = manual()
    const long = 'x'.repeat(TEXT_BLOCK_SOFT_CHARS)
    buf.apply(env('r1', 1, text('plan', long)))
    buf.apply(env('r1', 2, text('plan', 'tail\nnext line')))
    buf.apply(env('r1', 3, text('plan', 'y'.repeat(TEXT_BLOCK_HARD_CHARS * 2))))
    buf.flush()
    const blocks = buf.snapshot('r1', 'plan').blocks as Extract<StreamBlock, { kind: 'text' }>[]
    expect(blocks[0]?.text).toBe(`${long}tail\n`)
    expect(blocks[1]?.text.startsWith('next line')).toBe(true)
    for (const b of blocks) expect(b.text.length).toBeLessThanOrEqual(TEXT_BLOCK_HARD_CHARS)
    expect(blocks.map((b) => b.text).join('')).toBe(buf.streamText('r1', 'plan'))
  })
})

describe('streamBuffer idempotence', () => {
  it('ignores envelopes at or below the last applied seq, so an overlapping replay adds nothing', () => {
    const { buf } = manual()
    const log = textLog('r1', 'implement', 10)
    buf.applyAll(log.slice(0, 6))
    buf.applyAll(log) // replay from 0 overlapping what was applied live
    buf.apply(log[3]!)
    buf.flush()
    expect(buf.streamText('r1', 'implement')).toBe(log.map((_, i) => `line ${i + 1}\n`).join(''))
    expect(buf.lastSeq('r1')).toBe(10)
    expect(buf.apply(log[9]!)).toBe(false)
  })

  it('keeps runs apart', () => {
    const { buf } = manual()
    buf.apply(env('a', 1, text('plan', 'A')))
    buf.apply(env('b', 1, text('plan', 'B')))
    expect(buf.streamText('a', 'plan')).toBe('A')
    expect(buf.streamText('b', 'plan')).toBe('B')
  })
})

describe('streamBuffer attempts', () => {
  it('opens the new attempt on step-status, before any output, and lists every attempt', () => {
    const { buf } = manual()
    buf.apply(env('r1', 1, text('implement', 'first try')))
    buf.apply(env('r1', 2, { t: 'step-status', step: 'implement', attempt: 2, status: 'running' }))
    buf.flush()
    const latest = buf.snapshot('r1', 'implement')
    expect(latest.attempt).toBe(2)
    expect(latest.attempts).toEqual([1, 2])
    expect(latest.blocks).toEqual([])
    expect(latest.firstOutputAt).toBeNull()
    expect(buf.snapshot('r1', 'implement', 1).blocks).toHaveLength(1)
    expect(buf.streamText('r1', 'implement', 1)).toBe('first try')
  })

  it('returns a stable empty snapshot for a step without a stream', () => {
    const { buf } = manual()
    const a = buf.snapshot('r9', 'plan')
    expect(a).toBe(buf.snapshot('r9', 'plan'))
    expect(a.attempt).toBeNull()
  })
})

describe('streamBuffer frame batching', () => {
  it('schedules one frame for many envelopes and bumps each changed stream once', () => {
    const { buf, frames, runFrame } = manual()
    let notified = 0
    buf.subscribe('r1', 'plan', () => notified++)
    const before = buf.snapshot('r1', 'plan')
    for (let i = 1; i <= 50; i++) buf.apply(env('r1', i, text('plan', `${i} `)))
    expect(frames()).toBe(1)
    // Until the frame runs, readers keep the previous snapshot.
    expect(buf.snapshot('r1', 'plan')).toBe(before)
    runFrame()
    expect(notified).toBe(1)
    const after = buf.snapshot('r1', 'plan')
    expect(after.version).toBe(1)
    expect(after).toBe(buf.snapshot('r1', 'plan'))
    expect(Object.isFrozen(after.blocks)).toBe(true)
  })

  it('notifies only the step that changed', () => {
    const { buf, runFrame } = manual()
    let plan = 0
    let impl = 0
    buf.subscribe('r1', 'plan', () => plan++)
    buf.subscribe('r1', 'implement', () => impl++)
    buf.apply(env('r1', 1, text('implement', 'x')))
    runFrame()
    expect([plan, impl]).toEqual([0, 1])
  })

  it('useStream re-renders once per frame, not per envelope', async () => {
    streamBuffer.reset()
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useStream('hook-run', 'plan')
    })
    const start = renders
    act(() => {
      for (let i = 1; i <= 100; i++) streamBuffer.apply(env('hook-run', i, text('plan', 'a')))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(result.current.blocks).toHaveLength(1)
    expect((result.current.blocks[0] as { text: string }).text).toBe('a'.repeat(100))
    expect(renders - start).toBe(1)
  })
})

afterEach(() => {
  streamBuffer.reset()
})
