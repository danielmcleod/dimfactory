// Final-attempt active time (estimates "… final attempt only" and the live ETA; shared/run.ts
// RunSummaryStep "Final attempt only"): after a retry the step's view, its summary row (the estimates' sample) and
// the live ETA count only the attempt that runs now; StepState.activeMs keeps the total over every attempt. Also the
// summary's ETA state for a summary-only reader (etaState / etaEndsAt). Every case replays the real reducer.
import { describe, expect, it } from 'vitest'
import type { RunEnvelope } from '@shared/run.ts'
import type { RunEstimate, StepEstimate } from '@shared/estimates.ts'
import { EstimateAggregate, sampleKey } from '@core/estimates/aggregate.ts'
import { runEtaOf, toRunSummary, toStepView } from '@core/supervisor/derive.ts'
import { projectFromLog } from '@core/supervisor/recovery.ts'
import type { Effect } from '@core/supervisor/types.ts'
import { Harness } from './helpers.ts'

const S = 1000

const est = (p50: number, p80: number): StepEstimate => ({
  level: 'exact',
  durationMs: { p50: p50 * S, p80: p80 * S },
  costUsd: null,
  samples: 5,
  basis: 'from 5 runs',
  missingPricing: [],
})

/** Implement only: p50 60 s, p80 90 s. */
const IMPLEMENT_ONLY: RunEstimate = {
  total: { ...est(60, 90) },
  steps: { implement: est(60, 90) },
  pFix: { value: 0.6, basis: 'prior' },
}

/** Implement ran 100 s and failed (a snag); the user read it for 30 s and pressed Retry (fresh). */
function failedThenRetried(): Harness {
  const h = new Harness().toImplementRunning()
  h.tick(100 * S).ev('implement', {
    type: 'error',
    message: 'Not logged in',
    raw: '',
    fatal: true,
    category: 'auth_required',
  })
  h.exit('implement', { code: 1 })
  h.snapshot('stopped', 'tree-changed')
  h.tick(30 * S)
  h.user({ kind: 'retry', step: 'implement', strategy: 'fresh' })
  h.snapshot('pre-retry', 'tree-changed')
  h.passPreflight('implement')
  return h
}

describe('a retried step counts its final attempt only', () => {
  it('the view and the summary row carry the final attempt; the step keeps the total', () => {
    const h = failedThenRetried()
    h.tick(40 * S)
    const st = h.step('implement')
    expect(st.attempt).toBe(2)
    expect(toStepView(st, h.now).activeMs).toBe(40 * S)
    expect(toRunSummary(h.state, h.now).steps.find((r) => r.key === 'implement')?.activeMs).toBe(40 * S)
    // The total over both attempts stays on the state (waits on the user excluded).
    expect(st.activeMs + (h.now - (st.activeSince ?? h.now))).toBe(140 * S)
  })

  it("the estimates' sample is the final attempt's time, not failed time plus successful time", () => {
    const h = failedThenRetried()
    h.tick(40 * S).ev('implement', { type: 'done', result: 'ok', usage: { input: 1, output: 1 } })
    const row = toRunSummary(h.state, h.now).steps.find((r) => r.key === 'implement')
    expect(row).toMatchObject({ status: 'done', activeMs: 40 * S })
    const finished = { ...toRunSummary(h.state, h.now), status: 'completed' as const, endedAt: h.now }
    const agg = EstimateAggregate.from([finished])
    expect(agg.window(sampleKey.step('implement')).map((x) => x.activeMs)).toEqual([40 * S])
  })

  it('the live ETA restarts with the new attempt instead of reading "longer than usual"', () => {
    const h = failedThenRetried()
    h.tick(40 * S)
    // 100 s + 40 s over both attempts would be past the p80 (90 s); the new attempt is 40 s in.
    expect(runEtaOf(h.state, IMPLEMENT_ONLY, h.now)).toEqual({
      remainingMs: 20 * S,
      state: 'ok',
      countsDown: true,
      nextChangeMs: 20 * S,
    })
    expect(toRunSummary(h.state, h.now, { estimate: IMPLEMENT_ONLY }).progress).toMatchObject({
      etaMs: 20 * S,
      etaState: 'ok',
      etaEndsAt: h.now + 20 * S,
    })
  })

  it('an automatic retry restarts the count while the step stays running', () => {
    const h = new Harness().toImplementRunning()
    h.tick(10 * S).ev('implement', {
      type: 'error',
      message: 'ECONNRESET',
      raw: '',
      fatal: true,
      category: 'network',
    })
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2 })
    h.tick(5 * S)
    expect(toStepView(h.step('implement'), h.now).activeMs).toBe(5 * S)
  })

  it('a resume keeps the attempt, so its time adds to the same attempt', () => {
    const h = new Harness().toImplementRunning()
    h.tick(10 * S).ev('implement', {
      type: 'error',
      message: 'No conversation found',
      raw: '',
      fatal: true,
      category: 'resume_failed',
    })
    h.tick(5 * S)
    expect(h.step('implement').attempt).toBe(1)
    expect(toStepView(h.step('implement'), h.now).activeMs).toBe(15 * S)
  })

  it('crash recovery: a later attempt found only in the log starts from what run.json recorded', () => {
    const h = new Harness().toImplementRunning()
    h.tick(100 * S).ev('implement', {
      type: 'error',
      message: 'Not logged in',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    h.exit('implement', { code: 1 })
    h.snapshot('stopped', 'tree-changed')
    const runJson = structuredClone(h.state)
    const before = h.log.length
    h.user({ kind: 'retry', step: 'implement', strategy: 'fresh' })
    const log: RunEnvelope[] = h.log
      .slice(before)
      .filter((e): e is Extract<Effect, { t: 'emit' }> => e.t === 'emit')
      .map((e, i) => ({ runId: h.state.runId, seq: 100 + i, ts: h.now, body: e.body }))
    const s = projectFromLog(runJson, log)
    expect(s.steps.implement.attempt).toBe(2)
    expect(s.steps.implement.attemptActiveFrom).toBe(100 * S)
    expect(toStepView(s.steps.implement).activeMs).toBe(0)
  })
})

describe('the summary states the ETA for a summary-only reader', () => {
  it('"longer than usual" is a state, not a missing figure; nothing counts down then', () => {
    const h = new Harness().toImplementRunning()
    h.tick(95 * S)
    const p = toRunSummary(h.state, h.now, { estimate: IMPLEMENT_ONLY }).progress
    expect(p.etaState).toBe('longer-than-usual')
    expect(p.etaMs).toBeUndefined()
    expect(p.etaEndsAt).toBeUndefined()
  })

  it('past p50 the ETA is p80 − elapsed and the next change is the p80 crossing', () => {
    const h = new Harness().toImplementRunning()
    h.tick(70 * S)
    expect(runEtaOf(h.state, IMPLEMENT_ONLY, h.now)).toEqual({
      remainingMs: 20 * S,
      state: 'ok',
      countsDown: true,
      nextChangeMs: 20 * S,
    })
  })

  it('a run waiting on the user does not count down (no etaEndsAt) and has no next change', () => {
    const h = new Harness()
    h.toPlanGate()
    const planOnly: RunEstimate = { ...IMPLEMENT_ONLY, steps: { plan: est(30, 60), implement: est(60, 90) } }
    const eta = runEtaOf(h.state, planOnly, h.now)
    expect(eta).toMatchObject({ state: 'ok', countsDown: false, remainingMs: 60 * S })
    expect(eta?.nextChangeMs).toBeUndefined()
    const p = toRunSummary(h.state, h.now, { estimate: planOnly }).progress
    expect(p).toMatchObject({ etaMs: 60 * S, etaState: 'ok' })
    expect(p.etaEndsAt).toBeUndefined()
  })

  it('without a reference time nothing counts down; without an estimate there is no ETA state', () => {
    const h = new Harness().toImplementRunning()
    h.tick(10 * S)
    expect(toRunSummary(h.state, undefined, { estimate: IMPLEMENT_ONLY }).progress.etaEndsAt).toBeUndefined()
    expect(toRunSummary(h.state, h.now).progress.etaState).toBeUndefined()
  })
})
