// controller.takeQueuedText (performance.spec.ts): consecutive queued text deltas of one spawn reduce as one event — up to
// the size cap, never across another event, another spawn or another step — carrying the last delta's time.
import { describe, expect, it } from 'vitest'
import { takeQueuedText } from '../../../src/core/supervisor/controller.ts'
import type { EngineEvent } from '../../../src/core/supervisor/types.ts'

interface Item {
  ev: EngineEvent
  n: number
}

let n = 0
const text = (delta: string, at: number, o: { step?: 'implement' | 'fix'; spawnNo?: number } = {}): Item => ({
  n: n++,
  ev: { t: 'adapter', step: o.step ?? 'implement', spawnNo: o.spawnNo ?? 1, ev: { type: 'text', delta }, at },
})
const tool = (at: number): Item => ({
  n: n++,
  ev: {
    t: 'adapter',
    step: 'implement',
    spawnNo: 1,
    ev: { type: 'tool', name: 'Read', summary: 'a.ts', phase: 'start' },
    at,
  },
})
const timer = (at: number): Item => ({ n: n++, ev: { t: 'timer', id: 'stall:implement', due: at, at } })

describe('takeQueuedText', () => {
  it('merges the text deltas queued behind a text head into one event at the last delta time', () => {
    const head = text('a', 1)
    const queue = [text('b', 2), text('c', 3), tool(4), text('d', 5)]
    const r = takeQueuedText(head, queue)
    expect(r.taken.map((i) => i.n)).toEqual([head.n, head.n + 1, head.n + 2])
    expect(r.ev).toEqual({
      t: 'adapter',
      step: 'implement',
      spawnNo: 1,
      ev: { type: 'text', delta: 'abc' },
      at: 3,
    })
    // The tool event and everything after it stay queued, in order.
    expect(queue.map((i) => i.ev.t === 'adapter' && i.ev.ev.type)).toEqual(['tool', 'text'])
  })

  it('leaves a lone text delta, and any other head, as it is', () => {
    const lone = text('a', 1)
    expect(takeQueuedText(lone, [tool(2)])).toEqual({ taken: [lone], ev: lone.ev })
    const t = timer(1)
    const queue = [text('b', 2)]
    expect(takeQueuedText(t, queue)).toEqual({ taken: [t], ev: t.ev })
    expect(queue).toHaveLength(1)
  })

  it('never merges across another spawn, another step or another kind of event', () => {
    for (const next of [text('x', 2, { spawnNo: 2 }), text('x', 2, { step: 'fix' }), timer(2)]) {
      const head = text('a', 1)
      const queue = [next, text('y', 3)]
      const r = takeQueuedText(head, queue)
      expect(r.taken).toEqual([head])
      expect(queue).toHaveLength(2)
    }
  })

  it('stops once the merged text reaches the cap', () => {
    const head = text('aaaa', 1)
    const queue = [text('bbbb', 2), text('cccc', 3), text('dddd', 4)]
    const r = takeQueuedText(head, queue, 8)
    expect(r.ev.t === 'adapter' && r.ev.ev.type === 'text' ? r.ev.ev.delta : '').toBe('aaaabbbb')
    expect(queue).toHaveLength(2)
  })
})
