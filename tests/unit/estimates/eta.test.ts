// Live ETA (src/core/estimates/eta.ts): p50 − elapsed, past p50 → p80 − elapsed, past p80 →
// "longer than usual" (no run ETA); queued steps count p50, Review ∥ Critic the larger, Fix P(fix) until the
// reviewers are decided. Also the derive.ts views that carry it (StepView.eta / modeCopy, RunSummary.progress.etaMs).
import { describe, expect, it } from 'vitest'
import { liveRemainingMs, runRemainingMs, stepEta } from '@core/estimates/eta.ts'
import type { EtaStep } from '@core/estimates/eta.ts'
import { toRunSnapshot, toRunSummary } from '@core/supervisor/derive.ts'
import type { RunEstimate, StepEstimate } from '@shared/estimates.ts'
import type { PassStatus, StepKey } from '@shared/run.ts'
import type { Support } from '@shared/vendors.ts'
import { T0, makeConfig, makeRun } from '../supervisor/helpers.ts'

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
  total: {
    durationMs: { p50: 0, p80: 0 },
    costUsd: null,
    samples: 5,
    basis: 'from 5 runs',
    missingPricing: [],
  },
  steps: {
    plan: est(60, 90),
    implement: est(300, 400),
    review: est(50, 80),
    critic: est(70, 100),
    fix: est(100, 150),
  },
  pFix: { value: 0.5, basis: 'folder' },
}

const steps = (s: Partial<Record<StepKey, [PassStatus, number]>>): Partial<Record<StepKey, EtaStep>> =>
  Object.fromEntries(Object.entries(s).map(([k, [status, sec]]) => [k, { status, activeMs: sec * S }]))

describe('step ETA', () => {
  it('StepView.eta is the frozen p50/p80; steps outside the estimate have none', () => {
    expect(stepEta(ESTIMATE, 'implement')).toEqual({ p50: 300 * S, p80: 400 * S })
    expect(stepEta(ESTIMATE, 'verify:1')).toBeUndefined()
    expect(stepEta(null, 'plan')).toBeUndefined()
  })

  it('p50 − elapsed, then p80 − elapsed, then longer than usual', () => {
    const eta = { p50: 100, p80: 150 }
    expect(liveRemainingMs(eta, 40)).toBe(60)
    expect(liveRemainingMs(eta, 100)).toBe(0)
    expect(liveRemainingMs(eta, 120)).toBe(30)
    expect(liveRemainingMs(eta, 150)).toBe(0)
    expect(liveRemainingMs(eta, 151)).toBeNull()
  })
})

describe('run ETA (RunSummary.progress.etaMs)', () => {
  it('a queued run: every planned step at p50, Fix weighted by P(fix)', () => {
    // 60 + 300 + max(50, 70) + 0.5 × 100
    expect(runRemainingMs(ESTIMATE, {}, 'queued')).toBe(480 * S)
  })

  it('a running step counts down from p50, then from p80', () => {
    expect(runRemainingMs(ESTIMATE, steps({ plan: ['running', 30] }), 'running')).toBe(450 * S)
    expect(runRemainingMs(ESTIMATE, steps({ plan: ['running', 70] }), 'running')).toBe(
      (20 + 300 + 70 + 50) * S,
    )
  })

  it('past p80 the run runs longer than usual: no ETA', () => {
    expect(runRemainingMs(ESTIMATE, steps({ plan: ['running', 95] }), 'running')).toBeUndefined()
    expect(runRemainingMs(ESTIMATE, steps({ plan: ['stalled', 95] }), 'waiting')).toBeUndefined()
  })

  it('Review ∥ Critic take the larger remaining time', () => {
    const s = steps({
      plan: ['done', 60],
      implement: ['done', 300],
      review: ['running', 60], // past p50: 80 − 60 = 20
      critic: ['running', 10], // 70 − 10 = 60
    })
    expect(runRemainingMs(ESTIMATE, s, 'running')).toBe((60 + 0.5 * 100) * S)
  })

  it('once the reviewers are decided a queued Fix is coming (full weight); a skipped Fix is none', () => {
    const decided = steps({
      plan: ['done', 1],
      implement: ['done', 1],
      review: ['done', 1],
      critic: ['done', 1],
    })
    expect(runRemainingMs(ESTIMATE, decided, 'waiting')).toBe(100 * S)
    expect(runRemainingMs(ESTIMATE, { ...decided, ...steps({ fix: ['skipped', 0] }) }, 'running')).toBe(0)
    expect(runRemainingMs(ESTIMATE, { ...decided, ...steps({ fix: ['running', 120] }) }, 'running')).toBe(
      30 * S,
    )
  })

  it('a run waiting at the plan gate: the rest of the run, user time excluded', () => {
    expect(runRemainingMs(ESTIMATE, steps({ plan: ['done', 80] }), 'waiting')).toBe((300 + 70 + 50) * S)
  })

  it('paused, failed and finished runs have no ETA', () => {
    for (const status of ['paused', 'failed', 'completed', 'cancelled'] as const) {
      expect(runRemainingMs(ESTIMATE, {}, status)).toBeUndefined()
    }
  })
})

describe('views (derive.ts)', () => {
  const support: Support = { status: 'degraded', copy: 'Read-only + plan template', reason: 'no native plan' }
  const runOnly: RunEstimate = { ...ESTIMATE, steps: { plan: est(60, 90), implement: est(300, 400) } }

  it('a queued run carries its whole remaining time; no estimate, no etaMs', () => {
    const s = makeRun(makeConfig())
    expect(s.status).toBe('queued')
    expect(toRunSummary(s, T0, { estimate: runOnly }).progress.etaMs).toBe(360 * S)
    expect(toRunSummary(s, T0).progress.etaMs).toBeUndefined()
    expect(toRunSummary(s, T0, { estimate: null }).progress.etaMs).toBeUndefined()
  })

  it('a running plan counts its live segment; past p80 the summary has no etaMs', () => {
    const s = makeRun(makeConfig())
    s.status = 'running'
    s.steps.plan.status = 'running'
    s.steps.plan.attempt = 1
    s.steps.plan.activeMs = 10 * S
    s.steps.plan.activeSince = T0
    expect(toRunSummary(s, T0 + 20 * S, { estimate: runOnly }).progress.etaMs).toBe((30 + 300) * S)
    expect(toRunSummary(s, T0 + 81 * S, { estimate: runOnly }).progress.etaMs).toBeUndefined()
  })

  it('toRunSnapshot: StepView.eta for every planned step and modeCopy where given', () => {
    const s = makeRun(makeConfig())
    const snap = toRunSnapshot(s, 3, T0, { estimate: runOnly, modeCopy: { plan: support } })
    expect(snap.steps.plan.eta).toEqual({ p50: 60 * S, p80: 90 * S })
    expect(snap.steps.implement.eta).toEqual({ p50: 300 * S, p80: 400 * S })
    expect(snap.steps.preflight.eta).toBeUndefined()
    expect(snap.steps.plan.modeCopy).toEqual(support)
    expect(snap.steps.implement.modeCopy).toBeUndefined()
    expect(snap.summary.progress.etaMs).toBe(360 * S)
    const bare = toRunSnapshot(s, 3, T0)
    expect(bare.steps.plan.eta).toBeUndefined()
    expect(bare.steps.plan.modeCopy).toBeUndefined()
    expect(bare.summary.progress.etaMs).toBeUndefined()
  })
})
