// Property: coalescing merges text but never reorders it across any other event of the same step, run-level events
// flush every step first, and seqs stay contiguous.
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunEnvelope, StepKey } from '../../../src/shared/run.ts'
import { EventBus } from '../../../src/core/bus/bus.ts'

const STEPS = ['plan', 'review', 'critic'] as const satisfies readonly StepKey[]

type Op = { k: 'text'; step: StepKey; delta: string } | { k: 'tool'; step: StepKey } | { k: 'run' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant('text' as const),
      step: fc.constantFrom(...STEPS),
      delta: fc.string({ minLength: 1, maxLength: 6 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('tool' as const), step: fc.constantFrom(...STEPS) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'run' as const }) },
)

/** Per-step token stream: merged text runs and event ids, as seen by that step. */
function project(items: { step?: StepKey; text?: string; id: string }[], step: StepKey): string[] {
  const out: string[] = []
  let buf = ''
  for (const it of items) {
    if (it.text !== undefined) {
      if (it.step === step) buf += it.text
      continue
    }
    if (it.step !== step && it.step !== undefined) continue
    if (buf !== '') out.push(`T:${buf}`)
    buf = ''
    if (it.step === step) out.push(it.id)
  }
  if (buf !== '') out.push(`T:${buf}`)
  return out
}

const buses: EventBus[] = []
afterAll(async () => {
  for (const b of buses) await b.close()
})

describe('coalescer ordering (property)', () => {
  it('text is merged, never reordered, and flushed before run-level events', async () => {
    const bus = new EventBus({ home: process.env['DIM_FACTORY_HOME'] ?? '' })
    buses.push(bus)
    let runNo = 0
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 60 }), async (ops) => {
        const runId = `prop-${++runNo}`
        await bus.openRun(runId)
        const seen: RunEnvelope[] = []
        const detach = bus.attach({ name: 'p', run: (e) => e.runId === runId && seen.push(e) })
        const input: { step?: StepKey; text?: string; id: string }[] = []
        ops.forEach((op, i) => {
          if (op.k === 'text') {
            bus.pass(runId, op.step, 1, { type: 'text', delta: op.delta })
            input.push({ step: op.step, text: op.delta, id: '' })
          } else if (op.k === 'tool') {
            bus.pass(runId, op.step, 1, { type: 'tool', name: `tool-${i}`, summary: '' })
            input.push({ step: op.step, id: `tool-${i}` })
          } else {
            bus.emit(runId, { t: 'diff-stats', files: i, added: 0, deleted: 0, live: true })
            input.push({ id: `run-${i}` })
          }
        })
        await bus.sync(runId)
        detach()
        await bus.closeRun(runId)

        expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1))
        const output = seen.map((e) => {
          const b = e.body
          if (b.t === 'ev' && b.ev.type === 'text') return { step: b.step, text: b.ev.delta, id: '' }
          if (b.t === 'ev' && b.ev.type === 'tool') return { step: b.step, id: b.ev.name }
          if (b.t === 'diff-stats') return { id: `run-${b.files}` }
          throw new Error('unexpected body')
        })
        // Non-text events keep their global order.
        expect(output.filter((o) => o.id !== '').map((o) => o.id)).toEqual(
          input.filter((o) => o.id !== '').map((o) => o.id),
        )
        // Per step, text between that step's events (and run-level events) is identical.
        for (const step of STEPS) expect(project(output, step)).toEqual(project(input, step))
      }),
      { numRuns: 60 },
    )
  })
})
