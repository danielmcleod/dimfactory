// fast-check invariants over random but plausible event streams (the state machine):
//   no mutating spawn without a start snapshot · no Plan spawn before run-start · never two live processes per
//   step · unlock never while a process is alive · terminal pass states never leave terminal · timers never fire
//   while an ask is pending ·
//   seq-independent determinism (same events → same state, no wall clock).
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STEP_KEYS, TERMINAL_PASS_STATUSES, configPassOf } from '@shared/run.ts'
import type { PassStatus } from '@shared/run.ts'
import { anyLiveProc } from '@core/supervisor/derive.ts'
import { isMutatingStep, reduce } from '@core/supervisor/machine.ts'
import { parseTimerId } from '@core/supervisor/timers.ts'
import type { EngineEvent, Reduction, RunState } from '@core/supervisor/types.ts'
import { act, configArb, drive, newState } from './driver.ts'

const TERMINAL: readonly PassStatus[] = TERMINAL_PASS_STATUSES

/** The invariants, checked on every transition. */
function check(prev: RunState, e: EngineEvent, r: Reduction): void {
  const next = r.state
  const spawnsPerStep = new Map<string, number>()
  for (const fx of r.effects) {
    if (fx.t === 'spawn') {
      // No mutating spawn without a start snapshot (taken before the spawn).
      if (isMutatingStep(fx.step)) expect(next.steps[fx.step].startSnap, 'start snapshot').toBeDefined()
      // R2: Plan never spawns before the run-start snapshot has answered (taken or failed).
      if (fx.step === 'plan' || fx.step === 'clarify')
        expect(['done', 'failed'], `${fx.step} before run-start`).toContain(next.flow.runStart)
      // Clarify always comes before Plan: Plan never spawns while Clarify's questions wait or it still runs.
      if (fx.step === 'plan' && next.config.clarify !== undefined)
        expect(['done', 'skipped'], 'clarify before plan').toContain(next.steps.clarify.status)
      // Never two live processes per step.
      expect(prev.steps[fx.step].proc?.live === true, `${fx.step} already live`).toBe(false)
      spawnsPerStep.set(fx.step, (spawnsPerStep.get(fx.step) ?? 0) + 1)
      expect(next.steps[fx.step].proc).toMatchObject({ live: true, spawnNo: fx.spawnNo })
      expect(next.stop, 'no spawn after stop').toBeUndefined()
      expect(next.config.passes[configPassOf(fx.step)].enabled).toBe(true)
    }
    if (fx.t === 'unlock') {
      // Unlock never while a process is alive.
      expect(anyLiveProc(next), 'unlock with a live process').toBe(false)
      // Only a held/queued lock is released, except a stray grant that is handed straight back.
      if (e.t !== 'lock-acquired') expect(prev.lock).not.toBe('none')
      expect(next.lock).toBe('none')
    }
    if (fx.t === 'answer') {
      const p = prev.steps[fx.step].proc
      expect(p?.live && p.spawnNo === fx.spawnNo, 'answer goes to the live process').toBe(true)
      if (fx.decision === 'cancel' && fx.why !== undefined)
        expect(['ask-timeout', 'denied']).toContain(fx.why)
    }
  }
  for (const n of spawnsPerStep.values()) expect(n).toBe(1)
  for (const k of STEP_KEYS) {
    // Terminal pass states never leave terminal.
    if (TERMINAL.includes(prev.steps[k].status))
      expect(next.steps[k].status, `${k} left terminal`).toBe(prev.steps[k].status)
    // At most one process slot per step, and a live one belongs to a step that may have one.
    const st = next.steps[k]
    // Timers never fire while an ask is pending: no stall/hard timer is armed then (nor while asleep).
    if (st.asks.length > 0 || next.suspendedAt !== undefined) {
      expect(next.timers[`stall|${k}`], `stall armed with asks on ${k}`).toBeUndefined()
      expect(next.timers[`hard|${k}`], `hard armed with asks on ${k}`).toBeUndefined()
    }
  }
  if (e.t === 'timer') {
    const t = parseTimerId(e.id)
    if (t && (t.kind === 'stall' || t.kind === 'hard')) {
      const before = prev.steps[t.step]
      if (before.asks.length > 0 || prev.suspendedAt !== undefined) {
        expect(next.steps[t.step].status).toBe(before.status)
      }
    }
  }
  // run.json round-trips exactly (no undefined values, no functions).
  expect(JSON.parse(JSON.stringify(next))).toStrictEqual(next)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reducer invariants (fast-check)', () => {
  it('hold on random event streams', () => {
    fc.assert(
      fc.property(configArb, fc.array(act, { minLength: 30, maxLength: 150 }), (config, acts) => {
        drive(config, acts, check)
      }),
      { numRuns: 400 },
    )
    // ~3 s alone; leave room for a loaded machine (the integration suite running alongside).
  }, 30_000)

  it('reach the interesting states (sanity check on the generator)', () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(configArb, fc.array(act, { minLength: 40, maxLength: 150 }), (config, acts) => {
        drive(config, acts, (_prev, _e, r) => {
          for (const k of STEP_KEYS) seen.add(`${k}:${r.state.steps[k].status}`)
          for (const e of r.effects) {
            if (e.t === 'spawn') seen.add(`spawn:${e.step}:${e.launch.resume ? 'resume' : 'fresh'}`)
            if (e.t === 'answer') seen.add(`answer:${e.decision}`)
          }
          seen.add(`run:${r.state.status}`)
          for (const c of r.state.cards) seen.add(`card:${c.view.kind}`)
        })
      }),
      // Fixed seed: this asserts the generator's reach, so it must not depend on luck.
      { numRuns: 400, seed: 20261005 },
    )
    for (const s of [
      'spawn:plan:fresh',
      'spawn:implement:fresh',
      'spawn:implement:resume',
      'implement:done',
      'implement:failed',
      'implement:paused',
      'implement:stalled',
      'implement:waiting',
      'answer:allow',
      'answer:deny',
      'answer:cancel',
      'card:gate:afterPlan',
      'card:insufficientContext',
      'card:preflight',
      'card:stall',
      'run:completed',
      'run:cancelled',
      'run:paused',
      'run:failed',
    ]) {
      expect(seen, s).toContain(s)
    }
  })

  it('are deterministic and independent of the wall clock and of bus seq: same events → same state', () => {
    fc.assert(
      fc.property(configArb, fc.array(act, { minLength: 20, maxLength: 120 }), (config, acts) => {
        const a = drive(config, acts)
        // Replay the recorded events with a different wall clock and randomness.
        vi.spyOn(Date, 'now').mockReturnValue(42)
        vi.spyOn(Math, 'random').mockReturnValue(0.123)
        let s = newState(config)
        const effects: unknown[] = []
        for (const e of a.events) {
          const r = reduce(s, e)
          effects.push(...r.effects)
          s = r.state
        }
        vi.restoreAllMocks()
        expect(s).toStrictEqual(a.final)
        expect(effects).toStrictEqual(a.effects)
      }),
      { numRuns: 150 },
    )
  })

  it('never mutate the input state', () => {
    fc.assert(
      fc.property(configArb, fc.array(act, { minLength: 20, maxLength: 80 }), (config, acts) => {
        const { events } = drive(config, acts)
        let s = newState(config)
        for (const e of events) {
          const frozen = JSON.stringify(s)
          const r = reduce(s, e)
          expect(JSON.stringify(s)).toBe(frozen)
          s = r.state
        }
      }),
      { numRuns: 100 },
    )
  })
})
