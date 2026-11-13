import { describe, expect, expectTypeOf, it } from 'vitest'
import { ADAPTER_SIGNAL_TYPES, ASK_DECISIONS, NORMALIZED_EVENT_TYPES } from '@shared/events.ts'
import type {
  AdapterSignal,
  AskDecision,
  AutoAnswerReason,
  NormalizedEvent,
  NormalizedEventOf,
  PlanCaptureSource,
  ASK_KINDS,
  AUTO_ANSWER_REASONS,
  PLAN_CAPTURE_SOURCES,
} from '@shared/events.ts'
import {
  CARD_KINDS,
  FRESH_REASONS,
  GATE_KINDS,
  ISOLATION_MODES,
  LOCK_HOLDING_RUN_STATUSES,
  MODES,
  MUTATING_PASSES,
  AGENT_STEPS,
  PASS_NAMES,
  PASS_STATUSES,
  PAUSE_REASONS,
  PLAN_MODES,
  READONLY_PASSES,
  RUNNER_STEPS,
  RUN_EVENT_TYPES,
  RUN_OUTCOMES,
  RUN_OUTPUT_FILES,
  RUN_PHASES,
  RUN_STATUSES,
  STEP_KEYS,
  TERMINAL_PASS_STATUSES,
  isPassName,
  isStepKey,
} from '@shared/run.ts'
import type {
  CardKind,
  FreshReason,
  Mode,
  PassName,
  PassStatus,
  PauseReason,
  PlanMode,
  RunEventBody,
  RunEventOf,
  RunOutcome,
  RunPhase,
  RunSnapshot,
  RunStatus,
  StepKey,
  StepView,
  VerifyStep,
} from '@shared/run.ts'

const unique = (xs: readonly unknown[]): boolean => new Set(xs).size === xs.length

describe('primitive unions', () => {
  it('match the plan exactly at the type level', () => {
    expectTypeOf<PassName>().toEqualTypeOf<'plan' | 'implement' | 'review' | 'critic' | 'security' | 'fix'>()
    expectTypeOf<Mode>().toEqualTypeOf<'readonly' | 'autoedit' | 'full'>()
    expectTypeOf<AskDecision>().toEqualTypeOf<'allow' | 'allow-session' | 'deny' | 'cancel'>()
    expectTypeOf<StepKey>().toEqualTypeOf<
      | 'preflight'
      | 'prepare'
      | 'verify:0'
      | 'clarify'
      | 'research'
      | 'plan'
      | 'tests'
      | 'verify:red'
      | 'implement'
      | 'verify:1'
      | 'scan'
      | 'acceptance'
      | 'review'
      | 'critic'
      | 'security'
      | 'fix'
      | 'verify:2'
      | 'recheck'
      | 'deploy'
      | 'explain'
      | 'finalize'
    >()
    expectTypeOf<PassStatus>().toEqualTypeOf<
      'queued' | 'running' | 'waiting' | 'stalled' | 'paused' | 'done' | 'skipped' | 'failed' | 'cancelled'
    >()
    expectTypeOf<RunStatus>().toEqualTypeOf<
      'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled'
    >()
    expectTypeOf<RunPhase>().toEqualTypeOf<
      | 'queued'
      | 'preflight'
      | 'preparing'
      | 'clarifying'
      | 'researching'
      | 'research-review'
      | 'planning'
      | 'plan-review'
      | 'writing-tests'
      | 'implementing'
      | 'verifying'
      | 'accepting'
      | 'reviewing'
      | 'findings-review'
      | 'fixing'
      | 'final-verify'
      | 'security-recheck'
      | 'rechecking'
      | 'deploying'
      | 'explaining'
      | 'ready-to-apply'
      | 'needs-attention'
      | 'stopping'
      | 'done'
    >()
    expectTypeOf<RunOutcome>().toEqualTypeOf<
      | 'fixed'
      | 'clean'
      | 'no-changes'
      | 'findings-open'
      | 'verify-failed'
      | 'security-open'
      | 'fix-stopped'
      | 'gates-failed'
      | 'failed'
    >()
    expectTypeOf<PauseReason>().toEqualTypeOf<
      'ask-timeout' | 'denied' | 'interrupted' | 'interrupted-by-quit'
    >()
    expectTypeOf<FreshReason>().toEqualTypeOf<
      | 'vendor-differs'
      | 'no-session'
      | 'cannot-resume'
      | 'cwd-changed'
      | 'model-differs'
      | 'override-fresh'
      | 'override-other-vendor'
      | 'resume-failed'
      | 'implement-skipped'
      | 'context-heavy'
      | 'plan-skipped'
      | 'plan-vendor-differs'
      | 'mode-switch-unsupported'
    >()
    expectTypeOf<PlanMode>().toEqualTypeOf<'native' | 'emulated'>()
    expectTypeOf<VerifyStep>().toEqualTypeOf<'verify:0' | 'verify:red' | 'verify:1' | 'verify:2'>()
  })

  it('runtime arrays have the plan lengths and no duplicates', () => {
    const arrays: [string, readonly unknown[], number][] = [
      ['PASS_NAMES', PASS_NAMES, 6],
      ['MODES', MODES, 3],
      ['ASK_DECISIONS', ASK_DECISIONS, 4],
      ['STEP_KEYS', STEP_KEYS, 21],
      ['PASS_STATUSES', PASS_STATUSES, 9],
      ['RUN_STATUSES', RUN_STATUSES, 7],
      ['RUN_PHASES', RUN_PHASES, 24],
      ['RUN_OUTCOMES', RUN_OUTCOMES, 9],
      ['PAUSE_REASONS', PAUSE_REASONS, 4],
      ['FRESH_REASONS', FRESH_REASONS, 13],
      ['PLAN_MODES', PLAN_MODES, 2],
      ['CARD_KINDS', CARD_KINDS, 21],
      ['RUN_EVENT_TYPES', RUN_EVENT_TYPES, 13],
      ['NORMALIZED_EVENT_TYPES', NORMALIZED_EVENT_TYPES, 6],
      ['ADAPTER_SIGNAL_TYPES', ADAPTER_SIGNAL_TYPES, 13],
    ]
    for (const [name, xs, n] of arrays) {
      expect(xs, name).toHaveLength(n)
      expect(unique(xs), name).toBe(true)
    }
  })

  it('keeps STEP_KEYS in execution order', () => {
    expect(STEP_KEYS.indexOf('preflight')).toBe(0)
    expect(STEP_KEYS.indexOf('clarify')).toBeLessThan(STEP_KEYS.indexOf('plan'))
    expect(STEP_KEYS.indexOf('plan')).toBeLessThan(STEP_KEYS.indexOf('implement'))
    expect(STEP_KEYS.indexOf('implement')).toBeLessThan(STEP_KEYS.indexOf('verify:1'))
    expect(STEP_KEYS.indexOf('critic')).toBeLessThan(STEP_KEYS.indexOf('fix'))
    expect(STEP_KEYS.at(-1)).toBe('finalize')
    // The acceptance review runs after Implement's checks and before the reviewers; Explain after Deploy.
    expect(STEP_KEYS.indexOf('scan')).toBeLessThan(STEP_KEYS.indexOf('acceptance'))
    expect(STEP_KEYS.indexOf('acceptance')).toBeLessThan(STEP_KEYS.indexOf('review'))
    expect(STEP_KEYS.indexOf('deploy')).toBeLessThan(STEP_KEYS.indexOf('explain'))
    expect(STEP_KEYS.indexOf('explain')).toBeLessThan(STEP_KEYS.indexOf('finalize'))
  })

  it('partitions steps into passes and runner steps', () => {
    // Test-first's Tests step, the re-check, Clarify, Research, Deploy, the acceptance review and Explain are agent steps
    // that are not configured passes.
    expect([...RUNNER_STEPS, ...AGENT_STEPS].sort()).toEqual([...STEP_KEYS].sort())
    expect(AGENT_STEPS.filter((k) => !(PASS_NAMES as readonly string[]).includes(k))).toEqual([
      'tests',
      'recheck',
      'clarify',
      'research',
      'deploy',
      'acceptance',
      'explain',
    ])
    expect([...MUTATING_PASSES, ...READONLY_PASSES].sort()).toEqual([...PASS_NAMES].sort())
    for (const s of TERMINAL_PASS_STATUSES) expect(PASS_STATUSES).toContain(s)
    for (const s of LOCK_HOLDING_RUN_STATUSES) expect(RUN_STATUSES).toContain(s)
    expect(ISOLATION_MODES).toEqual(['inPlace', 'worktree'])
  })

  it('guards step keys and pass names', () => {
    expect(isStepKey('verify:1')).toBe(true)
    expect(isStepKey('verify:3')).toBe(false)
    expect(isPassName('fix')).toBe(true)
    expect(isPassName('verify:1')).toBe(false)
    expect(isPassName(null)).toBe(false)
  })
})

describe('cards', () => {
  it('declares every card kind from the plan, gates first', () => {
    expectTypeOf<CardKind>().toEqualTypeOf<
      | 'gate:afterPlan'
      | 'gate:beforeFix'
      | 'insufficientContext'
      | 'planMutated'
      | 'preflight'
      | 'reconcile'
      | 'trust'
      | 'depsConsent'
      | 'depsFailed'
      | 'verifyEnv'
      | 'emptyFindings'
      | 'retryPartial'
      | 'finalize'
      | 'finalizeConflicts'
      | 'interruptedApply'
      | 'stall'
      | 'testsNotRed'
      | 'clarify'
      | 'research'
      | 'restartFresh'
      | 'loop'
    >()
    expect(CARD_KINDS.slice(0, 2)).toEqual([...GATE_KINDS])
  })
})

describe('event bodies', () => {
  it('RUN_EVENT_TYPES covers RunEventBody exactly', () => {
    expectTypeOf<(typeof RUN_EVENT_TYPES)[number]>().toEqualTypeOf<RunEventBody['t']>()
    expectTypeOf<RunEventOf<'snag'>>().toHaveProperty('actions')
    expectTypeOf<RunEventOf<'ask-resolved'>['by']>().toEqualTypeOf<
      'user' | 'timeout' | 'vendor-cancel' | 'stop' | 'auto'
    >()
    expectTypeOf<RunEventOf<'card'>['state']>().toEqualTypeOf<'open' | 'resolved'>()
    expect(RUN_OUTPUT_FILES).toContain('plan.original')
  })

  it('NORMALIZED_EVENT_TYPES and ADAPTER_SIGNAL_TYPES cover their unions', () => {
    expectTypeOf<(typeof NORMALIZED_EVENT_TYPES)[number]>().toEqualTypeOf<NormalizedEvent['type']>()
    expectTypeOf<(typeof ADAPTER_SIGNAL_TYPES)[number]>().toEqualTypeOf<AdapterSignal['type']>()
    expectTypeOf<(typeof PLAN_CAPTURE_SOURCES)[number]>().toEqualTypeOf<PlanCaptureSource>()
    expectTypeOf<(typeof AUTO_ANSWER_REASONS)[number]>().toEqualTypeOf<AutoAnswerReason>()
    expectTypeOf<NormalizedEventOf<'ask'>['kind']>().toEqualTypeOf<(typeof ASK_KINDS)[number]>()
    expectTypeOf<NormalizedEventOf<'error'>>().toHaveProperty('fatal').toBeBoolean()
  })

  it('a hand-written exhaustive switch compiles over every body', () => {
    const describeBody = (b: RunEventBody): string => {
      switch (b.t) {
        case 'ev':
          return b.ev.type
        case 'step-status':
          return `${b.step}:${b.status}`
        case 'run-status':
          return `${b.status}/${b.phase}`
        case 'card':
          return `${b.card.kind}:${b.state}`
        case 'ask-resolved':
          return b.by
        case 'ask-extended':
          return String(b.expiresAt)
        case 'auto-answered':
          return b.why
        case 'snag':
          return b.failure.category
        case 'usage':
          return b.costBasis
        case 'context':
          return String(b.compactions)
        case 'diff-stats':
          return String(b.files)
        case 'output':
          return b.file
        case 'guardrail':
          return b.finding.rule
      }
    }
    expect(describeBody({ t: 'run-status', status: 'running', phase: 'planning' })).toBe('running/planning')
    expect(
      describeBody({
        t: 'snag',
        step: 'implement',
        failure: { category: 'auth_expired', message: 'm', raw: 'r', classifiedBy: 'regex' },
        actions: [],
      }),
    ).toBe('auth_expired')
  })
})

describe('views', () => {
  it('RunSnapshot has a StepView for every step key', () => {
    expectTypeOf<RunSnapshot['steps']>().toEqualTypeOf<Record<StepKey, StepView>>()
    expectTypeOf<RunSnapshot['rerunFromFix']['reason']>().toEqualTypeOf<FreshReason | undefined>()
  })
})
