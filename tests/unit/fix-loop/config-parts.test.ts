// The settings behind Clarify and Fix until green: the config keys (profile, project, run layer), their defaults
// and limits (more than 3 rounds is rejected), the run's projection, the CLI flags, the estimate's planned steps and
// the session rules for a later round.
import { describe, expect, it } from 'vitest'
import { DimFactoryConfigZ, ProfileZ, ResolvedConfigZ, RunOverridesZ } from '@shared/config-schema.ts'
import { CLARIFY_MAX_QUESTIONS, FIX_ROUNDS_MAX, configPassOf } from '@shared/run.ts'
import { BUILTIN_PROFILES, resolveBuiltinConfig } from '@core/config/builtins.ts'
import { plannedSteps } from '@core/estimates/estimate.ts'
import { runConfigFromResolved } from '@core/supervisor/machine.ts'
import { fixLaunchSessionInputs, fixSessionInputs, decideSession } from '@core/supervisor/sessions.ts'
import {
  clarifyOn,
  fixLoopOn,
  fixRoundsMax,
  recheckAll,
  recheckOn,
  recheckPass,
} from '@core/supervisor/step-use.ts'
import { UsageError } from '../../../src/cli/args.ts'
import { withClarifyFlag, withFixRounds } from '../../../src/cli/commands/run.ts'
import { makeConfig, makeRun } from '../supervisor/helpers.ts'

describe('config keys', () => {
  it('Fix until green: rounds 1 to 3; more is rejected (file, profile and run layer alike)', () => {
    expect(FIX_ROUNDS_MAX).toBe(3)
    for (const n of [1, 2, 3])
      expect(RunOverridesZ.safeParse({ passes: { fix: { rounds: n } } }).success).toBe(true)
    for (const n of [0, 4, 2.5, -1]) {
      expect(RunOverridesZ.safeParse({ passes: { fix: { rounds: n } } }).success, `rounds ${n}`).toBe(false)
      expect(DimFactoryConfigZ.safeParse({ passes: { fix: { rounds: n } } }).success).toBe(false)
      expect(ProfileZ.safeParse({ fix: { rounds: n } }).success).toBe(false)
    }
  })

  it('Fix until green: the budget and the re-check', () => {
    const ok = { passes: { fix: { recheck: false, maxCostUsd: 2.5, maxMinutes: 30 } } }
    expect(DimFactoryConfigZ.safeParse(ok).success).toBe(true)
    expect(
      DimFactoryConfigZ.safeParse({ passes: { fix: { maxCostUsd: null, maxMinutes: null } } }).success,
    ).toBe(true)
    expect(DimFactoryConfigZ.safeParse({ passes: { fix: { maxCostUsd: 0 } } }).success).toBe(false)
    expect(DimFactoryConfigZ.safeParse({ passes: { fix: { maxMinutes: 0 } } }).success).toBe(false)
    expect(DimFactoryConfigZ.safeParse({ passes: { fix: { maxMinutes: 1.5 } } }).success).toBe(false)
  })

  it('Clarify: a key of the Plan pass; 1 to 8 questions; only the Plan pass takes it', () => {
    expect(CLARIFY_MAX_QUESTIONS).toBe(8)
    const ok = { passes: { plan: { clarify: true, clarifyQuestions: 3, clarifyInAuto: true } } }
    expect(DimFactoryConfigZ.safeParse(ok).success).toBe(true)
    for (const n of [0, 9]) {
      expect(DimFactoryConfigZ.safeParse({ passes: { plan: { clarifyQuestions: n } } }).success).toBe(false)
    }
    expect(DimFactoryConfigZ.safeParse({ passes: { review: { clarify: true } } }).success).toBe(false)
    expect(DimFactoryConfigZ.safeParse({ passes: { plan: { rounds: 2 } } }).success).toBe(false)
  })

  it('defaults: Clarify off (4 questions, skipped in Auto); a single Fix with the re-check on and no budget', () => {
    const c = resolveBuiltinConfig({ profile: 'balanced' })
    expect(c.passes.plan).toMatchObject({ clarify: false, clarifyQuestions: 4, clarifyInAuto: false })
    expect(c.passes.fix).toMatchObject({ rounds: 1, recheck: true, maxCostUsd: null, maxMinutes: null })
    expect(runConfigFromResolved(c).clarify).toBeUndefined()
    expect(runConfigFromResolved(c).fixLoop).toBeUndefined()
  })

  it('the thorough profile turns both on (Clarify, 3 rounds); the others leave them off', () => {
    expect(BUILTIN_PROFILES.thorough.plan?.clarify).toBe(true)
    expect(BUILTIN_PROFILES.thorough.fix?.rounds).toBe(3)
    const t = resolveBuiltinConfig({ profile: 'thorough' })
    expect(runConfigFromResolved(t)).toMatchObject({
      clarify: { questions: 4, inAuto: false },
      fixLoop: { rounds: 3, recheck: true },
    })
    for (const p of ['balanced', 'claude-only', 'codex-only', 'fast'] as const) {
      const c = resolveBuiltinConfig({ profile: p })
      expect(c.passes.plan.clarify, p).toBe(false)
      expect(c.passes.fix.rounds, p).toBe(1)
    }
  })

  it('the run layer turns them on; the projection carries the budget', () => {
    const c = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: {
        passes: {
          plan: { clarify: true, clarifyQuestions: 2, clarifyInAuto: true },
          fix: { rounds: 2, recheck: false, maxCostUsd: 1.5, maxMinutes: 20 },
        },
      },
    })
    expect(runConfigFromResolved(c)).toMatchObject({
      clarify: { questions: 2, inAuto: true },
      fixLoop: { rounds: 2, recheck: false, maxUsd: 1.5, maxMinutes: 20 },
    })
  })

  it('a resolved.json from before these keys loads with them off', () => {
    const c = structuredClone(resolveBuiltinConfig({ profile: 'claude-only' })) as unknown as {
      passes: Record<string, Record<string, unknown>>
    }
    for (const k of ['clarify', 'clarifyQuestions', 'clarifyInAuto']) delete c.passes['plan']?.[k]
    for (const k of ['rounds', 'recheck', 'maxCostUsd', 'maxMinutes']) delete c.passes['fix']?.[k]
    const parsed = ResolvedConfigZ.parse(c)
    expect(parsed.passes.plan.clarify).toBe(false)
    expect(parsed.passes.fix.rounds).toBe(1)
  })
})

describe('which steps a run uses', () => {
  it('reads Clarify, the loop and the re-check from the run config', () => {
    const plain = makeRun(makeConfig())
    expect([clarifyOn(plain), fixLoopOn(plain), recheckOn(plain), fixRoundsMax(plain)]).toEqual([
      false,
      false,
      false,
      1,
    ])
    const loop = makeRun(makeConfig({ fixLoop: { rounds: 3, recheck: true } }))
    expect([fixLoopOn(loop), recheckAll(loop), recheckOn(loop), fixRoundsMax(loop)]).toEqual([
      true,
      true,
      true,
      3,
    ])
    // A single round is no loop, whatever its re-check says.
    const one = makeRun(makeConfig({ fixLoop: { rounds: 1, recheck: true } }))
    expect([fixLoopOn(one), recheckOn(one)]).toEqual([false, false])
  })

  it('places the re-check: the Security pass when the advisor is on, else Review, else Critic', () => {
    const c = makeConfig({ fixLoop: { rounds: 2, recheck: true } })
    c.passes.review.enabled = true
    expect(recheckPass(makeRun(c))).toBe('review')
    c.passes.review.enabled = false
    c.passes.critic.enabled = true
    expect(recheckPass(makeRun(c))).toBe('critic')
    c.passes.security.enabled = true
    expect(recheckPass(makeRun(c))).toBe('security')
    // Without the run's passes (an older caller): the advisor's, as before; Clarify is the Plan pass.
    expect(configPassOf('recheck')).toBe('security')
    expect(configPassOf('clarify')).toBe('plan')
  })
})

describe('CLI flags', () => {
  it('--clarify turns Clarify on for the run', () => {
    expect(withClarifyFlag({}, false)).toEqual({})
    expect(withClarifyFlag({ passes: { plan: { model: 'x' } } }, true)).toEqual({
      passes: { plan: { model: 'x', clarify: true } },
    })
  })

  it('--fix-rounds N sets the rounds; outside 1 to 3 it is a usage error', () => {
    expect(withFixRounds({}, undefined)).toEqual({})
    expect(withFixRounds({}, '3')).toEqual({ passes: { fix: { rounds: 3 } } })
    expect(withFixRounds({ passes: { fix: { recheck: false } } }, '2')).toEqual({
      passes: { fix: { recheck: false, rounds: 2 } },
    })
    for (const bad of ['4', '0', 'two', '2.5', '-1', ''])
      expect(() => withFixRounds({}, bad), bad).toThrow(UsageError)
  })
})

describe('estimates', () => {
  const base = (): Parameters<typeof plannedSteps>[0] => {
    const c = resolveBuiltinConfig({ profile: 'claude-only' })
    return c
  }

  it('counts Clarify before Plan (on the Plan config) unless Auto skips it', () => {
    const c = base()
    c.passes.plan.clarify = true
    expect(
      plannedSteps(c)
        .map((q) => q.key)
        .slice(0, 2),
    ).toEqual(['clarify', 'plan'])
    expect(plannedSteps(c)[0]).toMatchObject({
      key: 'clarify',
      vendor: 'claude',
      model: 'opus',
      mode: 'readonly',
    })
    expect(plannedSteps({ ...c, auto: true }).map((q) => q.key)).not.toContain('clarify')
    c.passes.plan.clarifyInAuto = true
    expect(plannedSteps({ ...c, auto: true }).map((q) => q.key)).toContain('clarify')
  })

  it("counts the loop's re-check (on Review's config without the advisor)", () => {
    const c = base()
    expect(plannedSteps(c).map((q) => q.key)).not.toContain('recheck')
    c.passes.fix.rounds = 3
    expect(plannedSteps(c).find((q) => q.key === 'recheck')).toMatchObject({ model: 'sonnet' })
    c.passes.fix.recheck = false
    expect(plannedSteps(c).map((q) => q.key)).not.toContain('recheck')
  })
})

describe('sessions in a later round', () => {
  it('round 1 decides against Implement; a later round against the previous round of Fix, by the same rules', () => {
    const s = makeRun(makeConfig({ fixLoop: { rounds: 3, recheck: true } }))
    s.steps.implement = {
      ...s.steps.implement,
      status: 'done',
      sessionId: 'impl',
      vendor: 'claude',
      model: null,
    }
    s.steps.fix = { ...s.steps.fix, status: 'running', sessionId: 'fix-1', vendor: 'claude', model: null }
    expect(fixLaunchSessionInputs(s)).toEqual(fixSessionInputs(s))
    expect(decideSession(fixLaunchSessionInputs(s))).toEqual({ reuse: true, sessionId: 'impl' })
    s.fixLoop = { round: 2, rounds: [], before: 1 }
    expect(decideSession(fixLaunchSessionInputs(s))).toEqual({ reuse: true, sessionId: 'fix-1' })
    s.config.passes.fix.reuseSession = false
    expect(decideSession(fixLaunchSessionInputs(s))).toEqual({ reuse: false, reason: 'override-fresh' })
    s.config.passes.fix.reuseSession = true
    delete s.steps.fix.sessionId
    expect(decideSession(fixLaunchSessionInputs(s))).toEqual({ reuse: false, reason: 'no-session' })
  })
})
