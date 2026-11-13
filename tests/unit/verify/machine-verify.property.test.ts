// fast-check invariants with Verify on (the verify step, the Fix skip rule, R6/R7/R11 and the runner-step note):
// random streams through the full sequence with verify rounds, trust and verifyEnv cards, Stop, quit and relaunch.
//   - a round runs only while no pass works (one that reported `done` may still be exiting), never two at once;
//     nothing spawns while a round runs
//   - the folder lock is never released while a round's commands may still run
//   - verify steps never read `stalled` or `failed`; terminal statuses stay terminal
//   - outcomes agree with the rounds: fixed ⇒ verify:2 has no failing command, verify-failed ⇒ it has, clean ⇒ the
//     latest verify has no [must] failure (the Fix skip rule)
//   - Auto never opens a trust card; a trust card is only open while its round is in its trust phase
//   - run.json round-trips
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { STEP_KEYS, TERMINAL_PASS_STATUSES } from '@shared/run.ts'
import type { PassStatus } from '@shared/run.ts'
import { anyLiveProc } from '@core/supervisor/derive.ts'
import { failingCommands, latestVerifyHasMust, reduce } from '@core/supervisor/machine.ts'
import type { EngineEvent, Reduction, RunConfig, RunState } from '@core/supervisor/types.ts'
import { act, interpret, newState, verifyAnswer } from '../supervisor/driver.ts'
import type { Act } from '../supervisor/driver.ts'
import { verifyFlowConfig } from './machine-helpers.ts'

const TERMINAL: readonly PassStatus[] = TERMINAL_PASS_STATUSES

type Act12 =
  | Act
  | { k: 'trustCard'; skip: boolean }
  /** Answer an outstanding verify request (check, grant, round): pass / fail / environment. */
  | { k: 'verifyAns'; ok: boolean; alt: boolean }

const act12: fc.Arbitrary<Act12> = fc.oneof(
  { weight: 30, arbitrary: fc.record({ k: fc.constant('go' as const), alt: fc.boolean() }) },
  { weight: 8, arbitrary: act },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('trustCard' as const), skip: fc.boolean() }) },
  {
    weight: 4,
    arbitrary: fc.record({ k: fc.constant('verifyAns' as const), ok: fc.boolean(), alt: fc.boolean() }),
  },
)

const config12: fc.Arbitrary<RunConfig> = fc
  .record({
    auto: fc.boolean(),
    beforeFix: fc.boolean(),
    review: fc.constantFrom(true, true, false),
    critic: fc.constantFrom(true, false),
    fix: fc.constantFrom(true, true, false),
    runAfter: fc.constantFrom<('implement' | 'fix')[]>(['implement', 'fix'], ['implement'], ['fix']),
  })
  .map((o) => verifyFlowConfig(o))

function interpret12(s: RunState, now: number, a: Act12): ReturnType<typeof interpret> {
  if (a.k === 'verifyAns') {
    const id = Object.keys(s.requests).find((x) => {
      const kind = s.requests[x]?.kind
      return kind === 'verify-check' || kind === 'trust-grant' || kind === 'verify'
    })
    const r = id === undefined ? undefined : s.requests[id]
    if (id === undefined || r === undefined) return null
    if (r.kind !== 'verify-check' && r.kind !== 'trust-grant' && r.kind !== 'verify') return null
    return { body: verifyAnswer(id, r.kind, a.ok, a.alt), at: now }
  }
  if (a.k !== 'trustCard') return interpret(s, now, a)
  const card = s.cards.find((c) => c.view.kind === 'trust')
  if (card === undefined) return null
  return {
    body: { t: 'user', cmd: { kind: 'card', cardId: card.view.id, choiceId: a.skip ? 'skip' : 'trust' } },
    at: now,
  }
}

function check(prev: RunState, r: Reduction): void {
  const next = r.state
  const rounds = (s: RunState): number => Object.values(s.requests).filter((x) => x.kind === 'verify').length
  expect(rounds(next), 'two rounds at once').toBeLessThanOrEqual(1)
  for (const fx of r.effects) {
    if (fx.t === 'verify') {
      // A pass that reported `done` may still be exiting (as when S1 is taken); none may still be working.
      const working = STEP_KEYS.filter(
        (k) => next.steps[k].proc?.live === true && !next.steps[k].proc?.terminal,
      )
      expect(working, 'a round while a pass works').toEqual([])
      expect(next.stop).toBeUndefined()
    }
    if (fx.t === 'spawn') expect(rounds(next), 'a spawn while a round runs').toBe(0)
    if (fx.t === 'unlock') {
      expect(rounds(next), 'unlock while a round runs').toBe(0)
      expect(anyLiveProc(next)).toBe(false)
    }
  }
  for (const k of STEP_KEYS) {
    if (TERMINAL.includes(prev.steps[k].status))
      expect(next.steps[k].status, `${k} left terminal`).toBe(prev.steps[k].status)
  }
  for (const k of ['verify:1', 'verify:2'] as const) {
    expect(['stalled', 'failed']).not.toContain(next.steps[k].status)
  }
  for (const c of next.cards) {
    if (c.view.kind !== 'trust') continue
    expect(next.config.auto, 'a trust card in Auto').toBe(false)
    const step = c.step === 'verify:2' ? 'verify:2' : 'verify:1'
    expect(next.steps[step].verify?.phase).toBe('trust')
  }
  if (next.outcome !== undefined && prev.outcome === undefined && next.stop === undefined) {
    const v2 = next.steps['verify:2']
    switch (next.outcome) {
      case 'fixed':
        expect(failingCommands(v2.verify)).toEqual([])
        break
      case 'verify-failed':
        expect(v2.status).toBe('done')
        expect(failingCommands(v2.verify).length).toBeGreaterThan(0)
        break
      case 'clean':
        expect(latestVerifyHasMust(next)).toBe(false)
        break
      case 'findings-open':
      case 'no-changes':
      case 'failed':
      case 'security-open':
      case 'fix-stopped':
      case 'gates-failed':
        // (security-open, fix-stopped, gates-failed: the security advisor, Fix until green and quality gates are off in
        // these configs, so it never ends that way.)
        break
    }
  }
  expect(JSON.parse(JSON.stringify(next))).toStrictEqual(next)
}

function drive12(config: RunConfig, acts: readonly Act12[], onStep: (r: Reduction) => void): RunState {
  let s = newState(config)
  let now = 1_000_000
  const step = (e: EngineEvent): void => {
    const prev = s
    const r = reduce(s, e)
    check(prev, r)
    onStep(r)
    s = r.state
  }
  step({ t: 'created', at: now })
  for (const a of acts) {
    const x = interpret12(s, now, a)
    if (x === null) continue
    if (x === 'tick') {
      now += a.k === 'tick' ? a.ms : 0
      continue
    }
    now = x.at
    step({ ...x.body, at: x.at })
  }
  return s
}

describe('reducer invariants with Verify on (fast-check)', () => {
  it('hold on random event streams through verify rounds', () => {
    fc.assert(
      fc.property(config12, fc.array(act12, { minLength: 40, maxLength: 220 }), (config, acts) => {
        drive12(config, acts, () => undefined)
      }),
      { numRuns: 250 },
    )
  }, 90_000)

  it('reach the verify states (sanity check on the generator)', () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(config12, fc.array(act12, { minLength: 60, maxLength: 220 }), (config, acts) => {
        drive12(config, acts, (r) => {
          for (const k of ['verify:1', 'verify:2'] as const) seen.add(`${k}:${r.state.steps[k].status}`)
          for (const c of r.state.cards) seen.add(`card:${c.view.kind}`)
          if (r.state.outcome !== undefined) seen.add(`outcome:${r.state.outcome}`)
          seen.add(`phase:${r.state.phase}`)
        })
      }),
      { numRuns: 300, seed: 20261009 },
    )
    for (const s of [
      'verify:1:running',
      'verify:1:done',
      'verify:1:waiting',
      'verify:2:done',
      'card:trust',
      'card:verifyEnv',
      'outcome:fixed',
      'outcome:verify-failed',
      'phase:verifying',
      'phase:final-verify',
    ]) {
      expect(seen, s).toContain(s)
    }
  }, 90_000)
})
