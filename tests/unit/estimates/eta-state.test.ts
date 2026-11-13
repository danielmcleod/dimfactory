// The live ETA for a summary-only reader (src/core/estimates/eta.ts `runEta`: past p50
// → p80 − elapsed, past p80 → "longer than usual"): the state, whether the remaining time runs down with the clock,
// and when it next changes rule (core republishes the summary then).
import { describe, expect, it } from 'vitest'
import { runEta } from '@core/estimates/eta.ts'
import type { EtaStep } from '@core/estimates/eta.ts'
import type { RunEstimate, StepEstimate } from '@shared/estimates.ts'
import type { PassStatus, StepKey } from '@shared/run.ts'

const S = 1000

const est = (p50: number, p80: number): StepEstimate => ({
  level: 'exact',
  durationMs: { p50: p50 * S, p80: p80 * S },
  costUsd: null,
  samples: 5,
  basis: 'from 5 runs',
  missingPricing: [],
})

const ESTIMATE: RunEstimate = {
  total: est(0, 0),
  steps: { plan: est(60, 90), implement: est(300, 400), review: est(50, 80), critic: est(70, 100) },
  pFix: { value: 0.5, basis: 'folder' },
}

const ACTIVE: readonly PassStatus[] = ['running', 'stalled']

function steps(
  o: Partial<Record<StepKey, readonly [PassStatus, number]>>,
): Partial<Record<StepKey, EtaStep>> {
  const out: Partial<Record<StepKey, EtaStep>> = {}
  for (const [k, v] of Object.entries(o) as [StepKey, readonly [PassStatus, number]][])
    out[k] = { status: v[0], activeMs: v[1] * S, active: ACTIVE.includes(v[0]) }
  return out
}

describe('runEta', () => {
  it('a running step counts down until its p50; the next change is that crossing', () => {
    expect(runEta(ESTIMATE, steps({ plan: ['running', 20] }), 'running')).toEqual({
      remainingMs: (40 + 300 + 70) * S,
      state: 'ok',
      countsDown: true,
      nextChangeMs: 40 * S,
    })
  })

  it('a step exactly on its p80 is not past it yet: its next change is now, then it is "longer than usual"', () => {
    // A timer armed for the crossing may fire a millisecond early; the republish there must still arm the next one.
    expect(runEta(ESTIMATE, steps({ plan: ['running', 90] }), 'running')).toMatchObject({
      state: 'ok',
      nextChangeMs: 0,
    })
    const after: Partial<Record<StepKey, EtaStep>> = {
      plan: { status: 'running', activeMs: 90 * S + 1, active: true },
    }
    expect(runEta(ESTIMATE, after, 'running')).toEqual({ state: 'longer-than-usual', countsDown: false })
  })

  it('past p80 the run is "longer than usual": no remaining time, no countdown, no further change', () => {
    expect(runEta(ESTIMATE, steps({ plan: ['running', 95] }), 'running')).toEqual({
      state: 'longer-than-usual',
      countsDown: false,
    })
    // A stalled step is still active time.
    expect(runEta(ESTIMATE, steps({ plan: ['stalled', 95] }), 'running')?.state).toBe('longer-than-usual')
  })

  it('a step waiting on the user does not count down', () => {
    const e = runEta(ESTIMATE, steps({ plan: ['done', 60], implement: ['waiting', 100] }), 'waiting')
    expect(e).toMatchObject({ state: 'ok', countsDown: false, remainingMs: (200 + 70) * S })
    expect(e?.nextChangeMs).toBeUndefined()
  })

  it('Review ∥ Critic: counts down only while the longer of the two is the one running', () => {
    const done = { plan: ['done', 60], implement: ['done', 300] } as const
    // Critic (70 s p50) runs and is the longer: counts down.
    expect(
      runEta(ESTIMATE, steps({ ...done, review: ['done', 50], critic: ['running', 10] }), 'running'),
    ).toMatchObject({ countsDown: true, remainingMs: 60 * S })
    // Review runs but Critic, waiting on an ask, still needs longer: the run's remaining time stands still.
    expect(
      runEta(ESTIMATE, steps({ ...done, review: ['running', 10], critic: ['waiting', 0] }), 'waiting'),
    ).toMatchObject({ countsDown: false, remainingMs: 70 * S })
  })

  it('no ETA outside queued, running and waiting', () => {
    for (const status of ['paused', 'failed', 'completed', 'cancelled'] as const)
      expect(runEta(ESTIMATE, {}, status)).toBeUndefined()
    expect(runEta(ESTIMATE, {}, 'queued')).toMatchObject({ state: 'ok', countsDown: false })
  })
})
