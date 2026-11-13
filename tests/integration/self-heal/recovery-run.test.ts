// Recovery executors and self-heal through a real core and the fake Claude (state-machine rows P17/P22, E2E
// rate-limit.spec.ts and unknown-heal.spec.ts on Claude):
//  - wait_until: a rate limit with a reset time arms a wait on the E2E clock; reaching it retries the pass; after a
//    relaunch the wait loads disarmed and recovery.execute re-arms it;
//  - P22: "Use Claude's default model" patches resolved.json (`patches[]`) and retries Plan without `--model`;
//  - P17: an unknown failure is diagnosed automatically (the healer is a fake here, injected through the HEAL_API
//    seam): its tail is stderr only, its unsafe suggestion is hidden, its config fix applies through P22, and
//    autoApplyConfigPatches applies one on its own, spending the pass's automatic retry.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HealApi, HealOutcome, HealRequest } from '../../../src/core/recovery/heal-api.ts'
import type { RecoveryAction } from '../../../src/shared/failure.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { passArgvs } from '../run/scenario.ts'
import {
  PLAN_MATCH,
  UNKNOWN_STDERR,
  World,
  atPlanGate,
  prepend,
  failedWithSnag,
  rateLimitedScript,
  unknownFailureScript,
  value,
} from './helpers.ts'

const world = new World()
afterEach(async () => {
  await world.dispose()
})

const snagOf = (
  events: RunEnvelope[],
  step: string,
): Extract<RunEnvelope['body'], { t: 'snag' }> | undefined =>
  events
    .map((e) => e.body)
    .filter((b): b is Extract<RunEnvelope['body'], { t: 'snag' }> => b.t === 'snag' && b.step === step)
    .at(-1)

const resolvedJson = (home: string, runId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, 'runs', runId, 'resolved.json'), 'utf8')) as Record<string, unknown>

const HOUR = 3_600_000

describe('wait_until', () => {
  it('arms on the E2E clock, retries at the reset; loads disarmed after a relaunch and re-arms', async () => {
    const resetsAt = Date.now() + 2 * HOUR
    await world.setup({ plan: [{ recording: 'C06-plan-native-host' }] }, [
      { name: 'plan-rate-limited-1', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt) },
      { name: 'plan-rate-limited-2', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt + HOUR) },
    ])
    const w = await world.boot({}, { DIM_FACTORY_E2E: '1' })
    const { runId, c } = await world.start(w)
    const failed = await c.waitFor(failedWithSnag('plan'), 90_000)
    expect(failed.steps.plan.failure).toMatchObject({ category: 'rate_limited' })
    const action = snagOf(w.events, 'plan')?.actions.find((a) => a.kind === 'wait_until')
    expect(action).toMatchObject({ id: 'plan:wait', kind: 'wait_until', armed: true })
    const until = action?.kind === 'wait_until' ? action.until : 0
    expect(Math.abs(until - Math.floor(resetsAt / 1000) * 1000)).toBeLessThan(1000)
    const snap = value(await w.core.invoke('runs.get', { runId }))
    expect(snap.steps.plan.wait).toEqual({ actionId: 'plan:wait', until, armed: true })

    // The clock reaches the reset: Plan retries on its own (the automatic retry is spent), and fails again.
    value(await w.core.advanceClock(until - w.core.clock.now() + 1000))
    const again = await c.waitFor((s) => failedWithSnag('plan')(s) && s.steps.plan.attempt === 2, 90_000)
    expect(again.steps.plan).toMatchObject({ autoRetryUsed: true })
    expect(again.notes).toContain('The wait is over: retrying Plan.')
    // The budget is spent: this wait is offered, not armed.
    expect(again.steps.plan.wait).toMatchObject({ armed: false, disarmed: 'offered' })
    // The user arms it, then Dim Factory closes.
    expect(value(await w.core.invoke('recovery.execute', { actionId: 'plan:wait', runId }))).toMatchObject({
      kind: 'wait_until',
      wait: { armed: true },
    })
    await world.stop(w.core)

    // Relaunch: the run loads with its wait disarmed (Retry now and Re-arm), and nothing fires on its own.
    const w2 = await world.boot({ heal: null }, { DIM_FACTORY_E2E: '1' })
    const view = value(await w2.core.invoke('runs.get', { runId }))
    expect(view.steps.plan.status).toBe('failed')
    expect(view.steps.plan.wait).toMatchObject({ armed: false, disarmed: 'relaunch' })
    const due = view.steps.plan.wait?.until ?? 0
    const plansBefore = passArgvs(w2.sc.entries()).filter((a) => a.includes('plan')).length
    expect(plansBefore).toBe(2)
    // Core's clock passes the reset while the wait is disarmed, first with the run not loaded, then with
    // its controller loaded (asking the AI loads it): nothing retries.
    value(await w2.core.advanceClock(due - w2.core.clock.now() + 1000))
    value(await w2.core.invoke('heal.diagnose', { runId, step: 'plan' }))
    const c2 = w2.core.controller(runId)
    if (c2 === undefined) throw new Error('no controller after heal.diagnose')
    await c2.settle()
    value(await w2.core.advanceClock(60_000))
    await new Promise((r) => setTimeout(r, 1000))
    await c2.settle()
    expect(c2.state.steps.plan).toMatchObject({ status: 'failed', attempt: 2, snagOpen: true })
    expect(c2.state.steps.plan.wait).toMatchObject({ armed: false, disarmed: 'relaunch' })
    expect(c2.state.timers['wait|plan']).toBeUndefined()
    expect(passArgvs(w2.sc.entries()).filter((a) => a.includes('plan'))).toHaveLength(plansBefore)
    // Re-arm past its time: Plan retries at once.
    const rearmed = value(await w2.core.invoke('recovery.execute', { actionId: 'plan:wait', runId }))
    expect(rearmed).toEqual({ kind: 'wait_until', message: 'Retrying Plan now.' })
    const gate = await c2.waitFor(atPlanGate, 90_000)
    expect(gate.steps.plan).toMatchObject({ status: 'done', attempt: 3 })
  }, 240_000)

  it('a wait the user re-armed after a relaunch counts down again and fires at its time', async () => {
    const resetsAt = Date.now() + 2 * HOUR
    await world.setup({ plan: [{ recording: 'C06-plan-native-host' }] }, [
      { name: 'plan-rate-limited-1', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt) },
    ])
    const w = await world.boot({}, { DIM_FACTORY_E2E: '1' })
    const { runId, c } = await world.start(w)
    await c.waitFor(failedWithSnag('plan'), 90_000)
    expect(c.state.steps.plan.wait).toMatchObject({ armed: true })
    await world.stop(w.core)

    const w2 = await world.boot({}, { DIM_FACTORY_E2E: '1' })
    const rearmed = value(await w2.core.invoke('recovery.execute', { actionId: 'plan:wait', runId }))
    expect(rearmed).toMatchObject({
      kind: 'wait_until',
      wait: { armed: true },
      message: 'Dim Factory retries Plan when the wait is over.',
    })
    const c2 = w2.core.controller(runId)
    if (c2 === undefined) throw new Error('no controller after re-arm')
    const due = c2.state.steps.plan.wait?.until ?? 0
    value(await w2.core.advanceClock(due - w2.core.clock.now() + 1000))
    const gate = await c2.waitFor(atPlanGate, 90_000)
    expect(gate.steps.plan).toMatchObject({ status: 'done', attempt: 2 })
  }, 240_000)
})

describe('wait_until on the scaled clock', () => {
  it('an armed wait fires on its own when the compressed clock reaches the reset', async () => {
    await world.setup({ plan: [{ recording: 'C06-plan-native-host' }] })
    const w = await world.boot({}, { DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_TIME_SCALE: '100' })
    // 15 minutes of core time ahead: past the 120 s auto-retry rule when Plan fails, about 9 s of wall time later.
    const resetsAt = w.core.clock.now() + 15 * 60_000
    prepend(w.sc, [{ name: 'plan-rate-limited', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt) }])
    const { c } = await world.start(w)
    const failed = await c.waitFor(failedWithSnag('plan'), 60_000)
    expect(failed.steps.plan.wait).toMatchObject({ armed: true })
    const gate = await c.waitFor(atPlanGate, 90_000)
    expect(gate.steps.plan).toMatchObject({ status: 'done', attempt: 2, autoRetryUsed: true })
  }, 180_000)
})

describe('P22 config_patch', () => {
  it("model_unavailable: Use Claude's default model patches resolved.json and retries Plan without --model", async () => {
    await world.setup({ plan: [{ recording: 'C11b-invalid-model' }, { recording: 'C06-plan-native-host' }] })
    const w = await world.boot()
    const { runId, c } = await world.start(w)
    await c.waitFor(failedWithSnag('plan'), 90_000)
    const actions = snagOf(w.events, 'plan')?.actions ?? []
    const fix = actions.find((a) => a.kind === 'config_patch')
    expect(fix).toMatchObject({
      id: 'plan:default-model',
      kind: 'config_patch',
      target: 'resolved',
      ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
      preview: '- passes.plan.model: "opus"\n+ passes.plan.model: null',
    })
    expect(value(await w.core.invoke('recovery.execute', { actionId: 'plan:default-model', runId }))).toEqual(
      {
        kind: 'config_patch',
        message: 'Applied. Retrying Plan.',
      },
    )
    const gate = await c.waitFor(atPlanGate, 90_000)
    expect(gate.config.passes.plan.model).toBeNull()
    expect(gate.notes).toContain('Applied "Use Claude\'s default model" to this run.')
    const patches = resolvedJson(w.home, runId)['patches'] as unknown[]
    expect(patches).toEqual([
      expect.objectContaining({
        ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
        label: "Use Claude's default model",
        source: 'recovery',
        step: 'plan',
        actionId: 'plan:default-model',
      }),
    ])
    const plans = passArgvs(w.sc.entries()).filter((a) => a.includes('plan'))
    expect(plans).toHaveLength(2)
    expect(plans[0]).toContain('--model')
    expect(plans[1]).not.toContain('--model')
    // A forbidden patch never applies, whatever offered it (here: an action id the run does not have).
    const stale = await w.core.invoke('recovery.execute', { actionId: 'plan:default-model', runId })
    expect(stale.ok ? null : stale.error.code).toBe('NOT_FOUND')
  }, 180_000)
})

/** The fake healer's config fix: the renamed `--permission-mode` (a read-only safety flag), or another one. */
const RENAMED_FLAG: Pick<Extract<RecoveryAction, { kind: 'config_patch' }>, 'label' | 'ops'> = {
  label: 'Use the renamed flag',
  ops: [{ op: 'add', path: '/vendors/claude/flagMap/--permission-mode', value: '--perm-mode' }],
}

/** A healer that answers a config fix and one unsafe suggestion, and records what it was asked. */
function fakeHealer(asked: HealRequest[], fix = RENAMED_FLAG): HealApi {
  return {
    diagnose: (req) => {
      asked.push(req)
      const actions: RecoveryAction[] = [
        {
          id: 'h1',
          label: fix.label,
          kind: 'config_patch',
          target: 'resolved',
          ops: fix.ops,
          preview: '',
        },
        {
          id: 'h2',
          label: 'Wipe it',
          kind: 'shell_copy',
          command: 'rm -rf ~\nrm -rf /',
          shell: 'sh',
          reason: '',
          recheck: '',
        },
      ]
      const outcome: HealOutcome = {
        status: 'ok',
        diagnosis: 'The CLI renamed --permission-mode to --perm-mode.',
        confidence: 'high',
        category: 'flag_drift',
        actions,
        hidden: 1,
        at: Date.now(),
      }
      return Promise.resolve(outcome)
    },
  }
}

describe('self-heal on Claude, healer faked', () => {
  it('an unknown failure is diagnosed on its own; its fix applies through P22 and Plan runs again', async () => {
    await world.setup({ plan: [{ recording: 'C06-plan-native-host' }] }, [
      { name: 'plan-unknown', match: PLAN_MATCH, ops: unknownFailureScript() },
    ])
    const asked: HealRequest[] = []
    const w = await world.boot({ heal: fakeHealer(asked) })
    const { runId, c } = await world.start(w)
    const healed = await c.waitFor(
      (s) =>
        failedWithSnag('plan')(s) &&
        s.steps.plan.heal !== undefined &&
        s.steps.plan.heal.status !== 'running',
      90_000,
    )
    expect(healed.steps.plan.failure).toMatchObject({ category: 'unknown', classifiedBy: 'heuristic' })
    // The healer saw stderr, never the prompt.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ runId, step: 'plan', trigger: 'auto', vendor: 'claude' })
    expect(asked[0]?.tail.join('\n')).toContain(UNKNOWN_STDERR)
    expect(asked[0]?.tail.join('\n')).not.toContain('add a --version flag')
    expect(asked[0]?.passArgv.length).toBeGreaterThan(0)
    const view = value(await w.core.invoke('runs.get', { runId })).steps.plan.heal
    expect(view).toMatchObject({
      status: 'ok',
      trigger: 'auto',
      diagnosis: 'The CLI renamed --permission-mode to --perm-mode.',
      hidden: 2,
      actions: [
        {
          id: 'plan:heal-1',
          kind: 'config_patch',
          preview: '+ vendors.claude.flagMap.--permission-mode: "--perm-mode"',
        },
      ],
    })
    expect(w.events.some((e) => e.body.t === 'output' && e.body.file === 'heal')).toBe(true)
    // Unknown: Diagnose with AI leads the snag.
    expect(snagOf(w.events, 'plan')?.actions[0]?.kind).toBe('heal')

    expect(value(await w.core.invoke('recovery.execute', { actionId: 'plan:heal-1', runId }))).toMatchObject({
      kind: 'config_patch',
      message: 'Applied. Retrying Plan.',
    })
    const gate = await c.waitFor(atPlanGate, 90_000)
    expect(gate.steps.plan.status).toBe('done')
    const plans = passArgvs(w.sc.entries()).filter((a) => a.includes('plan'))
    expect(plans[1]).toContain('--perm-mode')
    expect(plans[1]).not.toContain('--permission-mode')
    expect(resolvedJson(w.home, runId)['patches']).toEqual([
      expect.objectContaining({ source: 'recovery', actionId: 'plan:heal-1' }),
    ])
  }, 180_000)

  it('autoApplyConfigPatches applies the fix on its own, once: the retry spends the automatic retry', async () => {
    await world.setup(
      { plan: [{ recording: 'C06-plan-native-host' }] },
      [{ name: 'plan-unknown', match: PLAN_MATCH, ops: unknownFailureScript() }],
      { selfHeal: { autoApplyConfigPatches: true } },
    )
    const asked: HealRequest[] = []
    const modelFix = {
      label: "Use Claude's default model for Plan",
      ops: [{ op: 'replace' as const, path: '/passes/plan/model', value: null }],
    }
    const w = await world.boot({ heal: fakeHealer(asked, modelFix) })
    const { runId, c } = await world.start(w)
    const gate = await c.waitFor(atPlanGate, 120_000)
    expect(gate.steps.plan).toMatchObject({ status: 'done', attempt: 2, autoRetryUsed: true })
    expect(gate.steps.plan.heal?.autoApplied).toBe('plan:heal-1')
    expect(gate.notes).toContain(`Self-heal applied "${modelFix.label}" and retried Plan.`)
    expect(resolvedJson(w.home, runId)['patches']).toEqual([
      expect.objectContaining({ source: 'self-heal', actionId: 'plan:heal-1' }),
    ])
  }, 180_000)

  it('autoApplyConfigPatches never renames a read-only safety flag on its own: the fix waits for a click', async () => {
    await world.setup(
      { plan: [{ recording: 'C06-plan-native-host' }] },
      [{ name: 'plan-unknown', match: PLAN_MATCH, ops: unknownFailureScript() }],
      { selfHeal: { autoApplyConfigPatches: true } },
    )
    const w = await world.boot({ heal: fakeHealer([]) })
    const { runId, c } = await world.start(w)
    const healed = await c.waitFor(
      (s) => failedWithSnag('plan')(s) && s.steps.plan.heal?.status === 'ok',
      120_000,
    )
    await c.settle()
    expect(c.state.steps.plan).toMatchObject({ status: 'failed', attempt: 1, autoRetryUsed: false })
    expect(c.state.steps.plan.heal?.autoApplied).toBeUndefined()
    expect(healed.steps.plan.heal?.actions.map((a) => a.id)).toEqual(['plan:heal-1'])
    expect(resolvedJson(w.home, runId)['patches'] ?? []).toEqual([])
  }, 180_000)

  it('heal.diagnose on a known failure records a user diagnosis; without a healer it fails with the docs', async () => {
    await world.setup({ plan: [{ recording: 'C09b-logged-out' }] })
    const w = await world.boot({ heal: null })
    const { runId, c } = await world.start(w)
    await c.waitFor(failedWithSnag('plan'), 90_000)
    expect(c.state.steps.plan.heal).toBeUndefined() // a known category does not heal on its own
    value(await w.core.invoke('heal.diagnose', { runId, step: 'plan' }))
    const done = await c.waitFor((s) => s.steps.plan.heal?.status === 'failed', 30_000)
    expect(done.steps.plan.heal).toMatchObject({
      trigger: 'user',
      error: 'Self-heal is not available in this build.',
      actions: [{ kind: 'open_docs' }],
    })
    const r = await w.core.invoke('heal.diagnose', { runId, step: 'implement' })
    expect(r.ok ? null : r.error.code).toBe('CONFLICT')
  }, 120_000)
})
