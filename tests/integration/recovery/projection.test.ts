// projectFromLog for the review and fix rows (recovery from the log): when run.json is behind events.jsonl, the bodies after its
// checkpoint rebuild the Review ∥ Critic flow, the gate before Fix / Fix underway, the joined findings and the
// selection (findings.json), and a reviewer whose findings parse never answered (review.md) — which the relaunch
// then asks for again. The states come from the real reducer (the unit-test Flow driver).
import { describe, expect, it } from 'vitest'
import { reduce } from '../../../src/core/supervisor/machine.ts'
import { projectFromLog } from '../../../src/core/supervisor/recovery.ts'
import type { Effect, EffectOf, RunState } from '../../../src/core/supervisor/types.ts'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { Flow, must, should } from '../../unit/supervisor/helpers.review.ts'

/** The bodies a stretch of reductions emitted, as events.jsonl envelopes. */
function envelopesOf(effects: readonly Effect[], runId: string): RunEnvelope[] {
  return effects
    .filter((e): e is EffectOf<'emit'> => e.t === 'emit')
    .map((e, i) => ({ runId, seq: i + 1, ts: 2_000_000 + i, body: e.body }))
}

function lastFindingsDoc(effects: readonly Effect[]): FindingsFile | null {
  const w = effects.filter((e): e is EffectOf<'writeFindings'> => e.t === 'writeFindings').at(-1)
  return w?.doc ?? null
}

/** Run the flow from a checkpoint and project the emitted bodies onto the checkpoint. */
function lagging(
  f: Flow,
  advance: (f: Flow) => void,
  opts: Parameters<typeof projectFromLog>[2] = {},
): { projected: RunState; live: RunState; effects: Effect[] } {
  const checkpoint = structuredClone(f.state)
  const from = f.log.length
  advance(f)
  const effects = f.log.slice(from)
  const projected = projectFromLog(checkpoint, envelopesOf(effects, f.state.runId), {
    findings: lastFindingsDoc(effects),
    ...opts,
  })
  return { projected, live: f.state, effects }
}

describe('projectFromLog: the review and fix rows', () => {
  it('rebuilds the join, the findings and the open gate before Fix', () => {
    const f = new Flow({ beforeFix: true }).toReviewRunning()
    const { projected, live } = lagging(f, (x) => {
      x.report('review', 'ok', [must('m1'), should('s1')])
      x.report('critic', 'ok', [must('m2')])
      x.snapshot('post-review', 'tree-changed')
    })
    expect(live.cards.map((c) => c.view.kind)).toEqual(['gate:beforeFix'])
    expect(projected.flow).toMatchObject({ review: 'joined', fix: 'gate' })
    expect(projected.cards.map((c) => c.view.kind)).toEqual(['gate:beforeFix'])
    expect(projected.findings?.list.map((x) => [x.id, x.n, x.severity, x.source])).toEqual(
      live.findings?.list.map((x) => [x.id, x.n, x.severity, x.source]),
    )
    expect(projected.findings?.selected).toEqual(live.findings?.selected)
    expect(projected.findings?.sources.review?.status).toBe('ok')
    expect(projected.findings?.sources.critic?.findings.map((x) => x.id)).toEqual(['m2'])
    expect(projected.steps.review.status).toBe('done')
    expect(projected.steps.critic.status).toBe('done')
    // The user's gate choice after recovery still reaches Fix with the projected selection.
    const gate = projected.cards[0]?.view
    if (gate === undefined) throw new Error('no gate')
    const r = reduce(projected, {
      t: 'user',
      cmd: { kind: 'card', cardId: gate.id, choiceId: 'continue', input: ['m2'] },
      at: 3_000_000,
    })
    expect(r.state.flow.fix).toBe('started')
    expect(r.state.findings?.selected).toEqual(['m2'])
    expect(r.state.steps.fix.status).toBe('running')
  })

  it('keeps the user’s selection from the latest findings.json and marks Fix underway', () => {
    const f = new Flow({ beforeFix: true }).toJoin(['ok', [must('m1'), should('s1')]], ['none', []])
    const { projected, live } = lagging(f, (x) => {
      x.choose('gate:beforeFix', 'continue', ['m1'])
    })
    expect(live.flow.fix).toBe('started')
    expect(projected.flow).toMatchObject({ review: 'joined', fix: 'started' })
    expect(projected.findings?.selected).toEqual(['m1'])
    expect(projected.steps.fix.status).toBe('running')
  })

  it('a reviewer whose output was written but whose parse never answered is parsed again on relaunch', () => {
    const f = new Flow().toReviewRunning()
    const text = '- [must] `a.ts:1` — broken. Fix it.'
    const { projected, live } = lagging(
      f,
      (x) => {
        x.reviewerDone('review', text)
      },
      { reviewerText: { review: `${text}\n` } },
    )
    // The live state awaits the parse; the checkpoint knew nothing about the output.
    expect(live.findings?.sources.review?.status).toBe('parsing')
    expect(projected.steps.review.status).toBe('running')
    expect(projected.findings?.sources.review?.status).toBe('parsing')
    expect(projected.steps.review.result).toBe(`${text}\n`)
    expect(projected.flow.review).toBe('running')
    const r = reduce(projected, { t: 'relaunch', at: 3_000_000 })
    const parse = r.effects.filter((e): e is EffectOf<'parseFindings'> => e.t === 'parseFindings')
    expect(parse).toEqual([expect.objectContaining({ step: 'review', text: `${text}\n` })])
    expect(r.state.steps.review.status).toBe('running')
  })

  it('a reviewer that went done after the checkpoint gets its findings from its output again', () => {
    const f = new Flow().toReviewRunning()
    const text = '- [should] `b.ts:2` — rename it.'
    const { projected } = lagging(
      f,
      (x) => {
        x.reviewerDone('review', text)
        x.parsed('review', 'ok', [should('b1')])
      },
      { reviewerText: { review: text } },
    )
    expect(projected.steps.review.status).toBe('done')
    expect(projected.findings?.sources.review?.status).toBe('ok')
    expect(projected.findings?.sources.review?.findings.map((x) => x.title)).toEqual([
      // The location's separator reads as a colon in the title (UI standard: no em dash in the app).
      '`b.ts:2`: rename it.',
    ])
  })

  it('usage bodies keep their cost basis (the vendor figure when reported)', () => {
    const f = new Flow().toReviewRunning()
    const { projected } = lagging(f, (x) => {
      x.reviewerDone('review', 'NO FINDINGS')
    })
    expect(projected.steps.review.usage).toEqual({ input: 10, output: 5, costUsd: 0.01 })
    expect(projected.steps.review.cost).toEqual({ usd: 0.01, basis: 'vendor', apiEquivalent: false })
  })

  it('usage bodies after the checkpoint add to the step’s spend (every attempt counts)', () => {
    const f = new Flow().toReviewRunning()
    f.ev('review', { type: 'done', result: '', usage: { input: 10, output: 5, costUsd: 0.01 } })
    f.exit('review')
    f.parsed('review', 'empty')
    const { projected, live } = lagging(f, (x) => {
      x.passPreflight('review')
      x.ev('review', { type: 'done', result: 'NO FINDINGS', usage: { input: 20, output: 7, costUsd: 0.02 } })
    })
    expect(live.steps.review.spent).toMatchObject({ tokens: 42, usd: 0.03 })
    expect(projected.steps.review.spent).toMatchObject({ tokens: 42, usd: 0.03, bases: ['vendor'] })
    expect(projected.steps.review.usage).toEqual({ input: 20, output: 7, costUsd: 0.02 })
  })
})
