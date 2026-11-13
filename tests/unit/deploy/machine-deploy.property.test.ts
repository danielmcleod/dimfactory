// fast-check invariants for runs with the Deploy step, over random but plausible event streams:
//   the outcome is never set while the Deploy step holds it · a run never completes with an outcome still held · the
//   Deploy pass spawns only while an outcome is held, after its plan named files to write, from its start snapshot ·
//   no mutating spawn without a start snapshot · terminal pass states never leave terminal · run.json round-trips.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { STEP_KEYS, TERMINAL_PASS_STATUSES } from '@shared/run.ts'
import type { PassStatus } from '@shared/run.ts'
import { isMutatingStep } from '@core/supervisor/machine.ts'
import type { EngineEvent, Reduction, RunConfig, RunState } from '@core/supervisor/types.ts'
import { act, configArb, drive } from '../supervisor/driver.ts'

const TERMINAL: readonly PassStatus[] = TERMINAL_PASS_STATUSES

/** The general config generator with the Deploy step on, and its reviewer and Fix sometimes on. */
const deployConfigArb: fc.Arbitrary<RunConfig> = fc
  .record({ base: configArb, review: fc.boolean(), fix: fc.boolean(), target: fc.constantFrom(null, 'fly') })
  .map(({ base, review, fix, target }) => {
    const c = structuredClone(base)
    c.passes.review.enabled = review
    c.passes.fix.enabled = fix
    c.deploy = { target }
    return c
  })

function check(prev: RunState, _e: EngineEvent, r: Reduction): void {
  const next = r.state
  // The outcome waits while the Deploy step holds it, and a held outcome never reads completed.
  if (next.deploy?.pending !== undefined) {
    expect(next.outcome, 'outcome while held').toBeUndefined()
    expect(next.status, 'completed while held').not.toBe('completed')
  }
  for (const fx of r.effects) {
    if (fx.t !== 'spawn') continue
    if (isMutatingStep(fx.step)) expect(next.steps[fx.step].startSnap, 'start snapshot').toBeDefined()
    if (fx.step === 'deploy') {
      expect(next.deploy?.pending, 'deploy spawn with an outcome held').toBeDefined()
      expect(next.deploy?.plan?.files.length ?? 0, 'deploy spawn with files to write').toBeGreaterThan(0)
      expect(next.steps.deploy.startSnap?.label).toBe('deploy-start')
    }
  }
  for (const k of STEP_KEYS) {
    if (TERMINAL.includes(prev.steps[k].status))
      expect(next.steps[k].status, `${k} left terminal`).toBe(prev.steps[k].status)
  }
  expect(JSON.parse(JSON.stringify(next))).toStrictEqual(next)
}

describe('the Deploy step (fast-check)', () => {
  it('holds on random event streams', () => {
    fc.assert(
      fc.property(deployConfigArb, fc.array(act, { minLength: 30, maxLength: 160 }), (config, acts) => {
        drive(config, acts, check)
      }),
      { numRuns: 300 },
    )
  }, 60_000)

  // A counterexample once found by the random runs: the Deploy pass fails (its hard timeout) while the outcome is
  // held, and a Stop then recorded the run as failed with the outcome still held.
  it('holds on the stream from seed 758146939 (Stop after the Deploy pass failed while holding the outcome)', () => {
    fc.assert(
      fc.property(deployConfigArb, fc.array(act, { minLength: 30, maxLength: 160 }), (config, acts) => {
        drive(config, acts, check)
      }),
      { numRuns: 300, seed: 758146939 },
    )
  }, 60_000)

  it('reaches the Deploy pass, its end and completion (sanity check on the generator)', () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(deployConfigArb, fc.array(act, { minLength: 60, maxLength: 200 }), (config, acts) => {
        drive(config, acts, (_p, _e, r) => {
          seen.add(`deploy:${r.state.steps.deploy.status}`)
          for (const fx of r.effects) if (fx.t === 'spawn' && fx.step === 'deploy') seen.add('spawn:deploy')
          if (r.state.status === 'completed' && r.state.steps.deploy.status === 'done')
            seen.add('completed-after-deploy')
        })
      }),
      { numRuns: 300, seed: 20261024 },
    )
    for (const s of [
      'spawn:deploy',
      'deploy:running',
      'deploy:done',
      'deploy:skipped',
      'completed-after-deploy',
    ])
      expect(seen, s).toContain(s)
  }, 60_000)
})
