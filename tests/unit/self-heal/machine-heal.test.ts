// Self-heal reducer rows (P17 "heal if (unknown ∨ heuristic) ∧ selfHeal.enabled", P22, the
// wait_until executor "Loads disarmed after relaunch", self-heal "autoApplyConfigPatches … spends the pass's retry
// budget"): the heal effect and StepView.heal, "Diagnose with AI" for known categories, the heal result and its
// auto-applied patch, P22 retry or skip, and the wait_until timer armed, fired, toggled and disarmed by a relaunch.
import { describe, expect, it } from 'vitest'
import type { Failure, HealView } from '@shared/failure.ts'
import { DEFAULT_CONTEXT } from '@core/supervisor/machine.ts'
import { snagActions } from '@core/recovery/snag-actions.ts'
import { toStepView } from '@core/supervisor/derive.ts'
import { disarmOnLoad, HEAL_INTERRUPTED } from '@core/supervisor/loaded-state.ts'
import type { ReducerContext, RunConfig } from '@core/supervisor/types.ts'
import { Harness, T0, makeConfig } from '../supervisor/helpers.ts'

/** The controller's recovery list (from the failure table), without the core facts. */
const ctx: ReducerContext = {
  ...DEFAULT_CONTEXT,
  recoveryActions: (step, failure, info) =>
    snagActions({
      step,
      failure,
      hasSession: info.hasSession,
      hints: info.hints,
      at: info.at ?? 0,
      vendor: 'claude',
      vendorName: 'Claude',
      platform: 'win32',
      clockText: () => '14:05',
    }),
}

function failImplement(h: Harness, f: Partial<Failure> & Pick<Failure, 'category'>): void {
  h.ev('implement', {
    type: 'error',
    message: f.message ?? 'boom',
    raw: f.raw ?? '',
    fatal: true,
    category: f.category,
  })
}

/** Implement running, then failing with `f` through the exit (the classifier's verdict, P17 unless retried). */
function exitFailure(h: Harness, f: Failure): void {
  h.exit('implement', { code: 1, failure: f })
}

const failure = (category: Failure['category'], o: Partial<Failure> = {}): Failure => ({
  category,
  message: 'x',
  raw: '',
  classifiedBy: 'structured',
  ...o,
})

const okHeal = (o: Partial<HealView> = {}): HealView => ({
  status: 'ok',
  trigger: 'auto',
  at: T0,
  actions: [],
  hidden: 0,
  ...o,
})

const patched = (over: (c: RunConfig) => void): RunConfig => {
  const c = makeConfig()
  over(c)
  return c
}

describe('P17 automatic heal (selfHeal.enabled ∧ (unknown ∨ heuristic))', () => {
  it('an unknown failure starts the healer: heal effect, StepView.heal running, output heal', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(h, failure('unknown', { classifiedBy: 'heuristic' }))
    const [fx] = h.fx('heal')
    expect(fx).toMatchObject({ t: 'heal', step: 'implement', trigger: 'auto', healId: 1 })
    expect(fx?.failure.category).toBe('unknown')
    expect(h.step('implement').heal).toMatchObject({ status: 'running', trigger: 'auto', healId: 1 })
    expect(toStepView(h.step('implement')).heal).toEqual({
      status: 'running',
      trigger: 'auto',
      at: h.now,
      actions: [],
      hidden: 0,
    })
    expect(h.bodies('output')).toEqual([{ t: 'output', file: 'heal', version: 1 }])
    // Unknown: "Diagnose with AI" is the primary action.
    expect(h.bodies('snag')[0]?.actions[0]).toMatchObject({ kind: 'heal', id: 'implement:heal' })
  })

  it('a heuristic classification of a known category heals too; a structured one only offers it', () => {
    const heur = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(heur, failure('flag_drift', { classifiedBy: 'heuristic' }))
    expect(heur.fx('heal')).toHaveLength(1)

    const known = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(known, failure('auth_required'))
    expect(known.fx('heal')).toHaveLength(0)
    expect(known.step('implement').heal).toBeUndefined()
    const actions = known.bodies('snag')[0]?.actions ?? []
    const heal = actions.findIndex((a) => a.kind === 'heal')
    expect(heal).toBeGreaterThan(0) // secondary: after the login command
    expect(actions[heal]?.label).toBe('Diagnose with AI')
  })

  it('not with selfHeal off, and never for a category the failure table keeps from the healer', () => {
    const off = new Harness(makeConfig({ selfHeal: false }), ctx).toImplementRunning()
    exitFailure(off, failure('unknown', { classifiedBy: 'heuristic' }))
    expect(off.fx('heal')).toHaveLength(0)
    expect(off.bodies('snag')[0]?.actions.some((a) => a.kind === 'heal')).toBe(true) // still offered

    const policy = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(policy, failure('content_policy', { classifiedBy: 'heuristic' }))
    expect(policy.fx('heal')).toHaveLength(0)
    expect(policy.bodies('snag')[0]?.actions.some((a) => a.kind === 'heal')).toBe(false)
  })

  it('a new failure drops the previous diagnosis', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(h, failure('auth_required'))
    h.user({ kind: 'heal', step: 'implement' })
    expect(h.step('implement').heal?.status).toBe('running')
    h.user({ kind: 'retry', step: 'implement' })
    h.snapshot('pre-retry')
    h.passPreflight('implement')
    failImplement(h, { category: 'auth_required' })
    expect(h.step('implement').heal).toBeUndefined()
  })
})

describe('"Diagnose with AI" (heal.diagnose / a heal action)', () => {
  it('starts a user heal on a failed pass with an open snag', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(h, failure('auth_required'))
    h.user({ kind: 'heal', step: 'implement' })
    expect(h.fx('result')).toEqual([])
    expect(h.fx('heal')).toEqual([expect.objectContaining({ step: 'implement', trigger: 'user', healId: 1 })])
    // Twice while running: CONFLICT.
    h.user({ kind: 'heal', step: 'implement' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })

  it('refused for a running pass and for a category the healer never sees', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    h.user({ kind: 'heal', step: 'implement' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    exitFailure(h, failure('content_policy'))
    h.user({ kind: 'heal', step: 'implement' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'FORBIDDEN' })])
  })
})

describe('heal-result', () => {
  it('keeps the outcome on the step; a stale or second result is dropped', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(h, failure('unknown', { classifiedBy: 'heuristic' }))
    const view = okHeal({
      diagnosis: 'The CLI renamed --permission-mode.',
      confidence: 'high',
      actions: [{ id: 'implement:heal-1', label: 'Rename the flag', kind: 'heal' }],
      hidden: 2,
    })
    h.send({ t: 'heal-result', step: 'implement', healId: 9, heal: view })
    expect(h.step('implement').heal?.status).toBe('running')
    h.send({ t: 'heal-result', step: 'implement', healId: 1, heal: view })
    expect(toStepView(h.step('implement')).heal).toEqual(view)
    expect(h.bodies('output')).toEqual([{ t: 'output', file: 'heal', version: 2 }])
    h.send({ t: 'heal-result', step: 'implement', healId: 1, heal: okHeal({ diagnosis: 'other' }) })
    expect(h.step('implement').heal?.diagnosis).toBe('The CLI renamed --permission-mode.')
  })

  it('autoApplyConfigPatches: the patch is applied through P22 and spends the automatic retry', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(h, failure('unknown', { classifiedBy: 'heuristic' }))
    expect(h.step('implement').autoRetryUsed).toBe(false)
    const config = patched((c) => (c.timeouts = { ...c.timeouts, stallMs: 600_000 }))
    h.send({
      t: 'heal-result',
      step: 'implement',
      healId: 1,
      heal: okHeal({
        actions: [
          {
            id: 'implement:heal-1',
            label: 'Wait longer',
            kind: 'config_patch',
            target: 'resolved',
            ops: [{ op: 'replace', path: '/timeouts/stallMs', value: 600_000 }],
            preview: '',
          },
        ],
      }),
      autoApply: { patchId: 'p1', actionId: 'implement:heal-1', label: 'Wait longer', config },
    })
    expect(h.fx('apply-patch')).toEqual([{ t: 'apply-patch', patchId: 'p1' }])
    expect(h.state.config.timeouts.stallMs).toBe(600_000)
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
    expect(h.step('implement').heal?.autoApplied).toBe('implement:heal-1')
    expect(h.state.notes).toContain('Self-heal applied "Wait longer" and retried Implement.')
  })

  it('autoApply waits for a click when the automatic retry is spent, or the snag is gone', () => {
    const run = (o: { spent?: boolean; retried?: boolean }): Harness => {
      const h = new Harness(makeConfig(), ctx).toImplementRunning()
      exitFailure(h, failure('unknown', { classifiedBy: 'heuristic' }))
      if (o.spent === true) h.state.steps.implement.autoRetryUsed = true
      if (o.retried === true) h.user({ kind: 'retry', step: 'implement' })
      h.send({
        t: 'heal-result',
        step: 'implement',
        healId: 1,
        heal: okHeal({
          actions: [
            {
              id: 'implement:heal-1',
              label: 'x',
              kind: 'config_patch',
              target: 'resolved',
              ops: [{ op: 'replace', path: '/passes/implement/model', value: 'sonnet' }],
              preview: '',
            },
          ],
        }),
        autoApply: {
          patchId: 'p1',
          actionId: 'implement:heal-1',
          label: 'x',
          config: patched((c) => (c.passes.implement.model = 'sonnet')),
        },
      })
      return h
    }
    for (const h of [run({ spent: true }), run({ retried: true })]) {
      expect(h.fx('apply-patch')).toEqual([])
      expect(h.state.config.passes.implement.model).toBeNull()
      expect(h.step('implement').heal?.autoApplied).toBeUndefined()
    }
  })
})

describe('P22', () => {
  it('a patch that turns the failed pass off skips it instead of retrying', () => {
    const h = new Harness(
      makeConfig({
        passes: {
          ...makeConfig().passes,
          review: { enabled: true, vendor: 'claude', model: 'sonnet', mode: 'readonly' },
        },
      }),
      ctx,
    ).toPlanRunning()
    h.ev('plan', { type: 'error', message: 'x', raw: '', fatal: true, category: 'capability_missing' })
    h.exit('plan', { code: 1 })
    const config = patched((c) => (c.passes.plan = { ...c.passes.plan, enabled: false }))
    h.user({ kind: 'config-patch', step: 'plan', config, label: 'Turn off Plan', patchId: 'p1' })
    expect(h.fx('apply-patch')).toHaveLength(1)
    expect(h.step('plan')).toMatchObject({ status: 'skipped', reason: 'disabled', snagOpen: false })
  })

  it("a card's fix without a step changes the config only, and not while a pass runs", () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    const config = patched((c) => (c.timeouts = { ...c.timeouts, askMs: 120_000 }))
    h.user({ kind: 'config-patch', config, label: 'x', patchId: 'p1' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    exitFailure(h, failure('auth_required'))
    h.user({ kind: 'config-patch', config, label: 'Ask longer', patchId: 'p2' })
    expect(h.fx('apply-patch')).toEqual([{ t: 'apply-patch', patchId: 'p2' }])
    expect(h.state.config.timeouts.askMs).toBe(120_000)
    expect(h.step('implement').status).toBe('failed')
    h.user({ kind: 'stop' })
    h.user({ kind: 'config-patch', config, label: 'x', patchId: 'p3' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })

  it('a resume retry carries its continuation', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    h.ev('implement', { type: 'tool', name: 'Edit', summary: 'a.ts', phase: 'start', id: 't1' })
    exitFailure(h, failure('turn_limit'))
    const snag = h.bodies('snag')[0] ?? { actions: [] }
    h.snapshot('stopped', 'tree-changed')
    expect(snag.actions[0]).toMatchObject({
      id: 'implement:continue',
      kind: 'resume',
      continuation: 'continue',
    })
    h.user({ kind: 'retry', step: 'implement', strategy: 'resume', continuation: 'Keep going.' })
    h.snapshot('pre-retry', 'tree-changed')
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toMatchObject({ continuation: 'Keep going.' })
  })
})

describe('wait_until (executor; rate_limited / quota_exceeded)', () => {
  const RESET = T0 + 3_600_000
  const rateLimited = (h: Harness): void =>
    exitFailure(h, failure('rate_limited', { resetsAt: RESET, retryAfterMs: 3_000_000 }))

  it('a rate limit arms the wait (the snag countdown); it fires at `until` and retries, spending the budget', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    rateLimited(h)
    const wait = h.bodies('snag')[0]?.actions.find((a) => a.kind === 'wait_until')
    expect(wait).toEqual({
      id: 'implement:wait',
      label: 'Retry at 14:05',
      kind: 'wait_until',
      until: RESET,
      armed: true,
    })
    expect(toStepView(h.step('implement')).wait).toEqual({
      actionId: 'implement:wait',
      until: RESET,
      armed: true,
    })
    expect(h.timerDue('wait|implement')).toBe(RESET)
    h.fire('wait|implement')
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
    expect(h.step('implement').wait).toBeUndefined()
    expect(h.state.notes).toContain('The wait is over: retrying Implement.')
  })

  it('disarm and re-arm (the wait_until action toggles); a re-arm past its time retries at once', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    rateLimited(h)
    h.user({ kind: 'wait', step: 'implement' })
    expect(h.step('implement').wait).toEqual({
      actionId: 'implement:wait',
      until: RESET,
      armed: false,
      disarmed: 'user',
    })
    expect(h.fx('clearTimer')).toEqual([{ t: 'clearTimer', id: 'wait|implement' }])
    expect(h.timerDue('wait|implement')).toBeUndefined()
    h.user({ kind: 'wait', step: 'implement' })
    expect(h.step('implement').wait).toEqual({ actionId: 'implement:wait', until: RESET, armed: true })
    expect(h.timerDue('wait|implement')).toBe(RESET)
    // A wait the user armed retries without spending the automatic retry.
    h.fire('wait|implement')
    expect(h.step('implement')).toMatchObject({ status: 'running', autoRetryUsed: false })

    const late = new Harness(makeConfig(), ctx).toImplementRunning()
    rateLimited(late)
    late.user({ kind: 'wait', step: 'implement', arm: false })
    late.tick(4_000_000)
    late.user({ kind: 'wait', step: 'implement', arm: true })
    expect(late.step('implement').status).toBe('running')
  })

  it('a usage limit, or a spent automatic retry, offers the wait disarmed', () => {
    const quota = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(quota, failure('quota_exceeded', { resetsAt: RESET }))
    expect(quota.step('implement').wait).toEqual({
      actionId: 'implement:wait',
      until: RESET,
      armed: false,
      disarmed: 'offered',
    })
    expect(quota.timerDue('wait|implement')).toBeUndefined()

    const spent = new Harness(makeConfig(), ctx).toImplementRunning()
    spent.state.steps.implement.autoRetryUsed = true
    rateLimited(spent)
    expect(spent.step('implement').wait?.armed).toBe(false)
    expect(spent.step('implement').wait?.disarmed).toBe('offered')
  })

  it('loads disarmed after a relaunch (Retry now and Re-arm stay), and a running heal is over', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    rateLimited(h)
    h.user({ kind: 'heal', step: 'implement' })
    h.send({ t: 'relaunch' })
    expect(h.step('implement').wait).toEqual({
      actionId: 'implement:wait',
      until: RESET,
      armed: false,
      disarmed: 'relaunch',
    })
    expect(h.state.timers['wait|implement']).toBeUndefined()
    expect(h.step('implement').heal).toMatchObject({ status: 'failed', error: HEAL_INTERRUPTED })
    expect(h.step('implement')).toMatchObject({ status: 'failed', snagOpen: true })
    h.user({ kind: 'wait', step: 'implement' })
    expect(h.timerDue('wait|implement')).toBe(RESET)

    // The same for a run read back from run.json without a relaunch (a dormant failed run).
    const again = new Harness(makeConfig(), ctx).toImplementRunning()
    rateLimited(again)
    const loaded = disarmOnLoad(again.state, T0 + 10)
    expect(loaded).not.toBe(again.state)
    expect(loaded.steps.implement.wait).toMatchObject({ armed: false, disarmed: 'relaunch' })
    expect(loaded.timers['wait|implement']).toBeUndefined()
    expect(again.state.steps.implement.wait?.armed).toBe(true) // input untouched
    const quiet = new Harness(makeConfig(), ctx)
    expect(disarmOnLoad(quiet.state, T0)).toBe(quiet.state)
  })

  it('Stop, Retry and Continue without clear the wait and its timer', () => {
    for (const cmd of [{ kind: 'stop' }, { kind: 'retry', step: 'implement' }] as const) {
      const h = new Harness(makeConfig(), ctx).toImplementRunning()
      rateLimited(h)
      h.user(cmd)
      expect(h.step('implement').wait).toBeUndefined()
      expect(h.state.timers['wait|implement']).toBeUndefined()
    }
    const r = new Harness(makeConfig(), ctx).toPlanRunning()
    r.exit('plan', { code: 1, failure: failure('rate_limited', { resetsAt: RESET }) })
    expect(r.step('plan').wait?.armed).toBe(true)
    r.user({ kind: 'skip', step: 'plan' })
    expect(r.state.timers['wait|plan']).toBeUndefined()
  })

  it('no wait without a pass to retry, and no wait action to toggle is CONFLICT', () => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    exitFailure(h, failure('auth_required'))
    h.user({ kind: 'wait', step: 'implement' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })
})
