// Continuity: when Plan and Implement run on the same vendor (and the models are compatible), Plan keeps its session
// and Implement resumes it in its own mode, with a session note; else Implement starts fresh with a reason in Plan's
// terms. Covered here: the decision rules, the reducer rows (Plan's launch keeps its session, Implement's launch
// resumes it after the controller's session-check), and the adapters' launch for a kept Plan session.
import { describe, expect, it } from 'vitest'
import { buildArgv } from '@core/adapters/claude/launch.ts'
import { ephemeralFor, execArgv } from '@core/adapters/codex/launch.ts'
import { threadResumeParams, threadStartParams } from '@core/adapters/codex/params.ts'
import { buildPrompt, implementContinuesPlan, startOptionsFor } from '@core/supervisor/effects.ts'
import {
  FRESH_REASON_TEXT,
  IMPLEMENT_ONLY_REASONS,
  SESSION_NOTE,
  decideImplementSession,
  implementSessionInputs,
  planKeepsSession,
} from '@core/supervisor/sessions.ts'
import type { SessionInputs } from '@core/supervisor/sessions.ts'
import type { EffectOf, RunConfig } from '@core/supervisor/types.ts'
import { resolve } from '@core/config/resolve.ts'
import { Harness, makeConfig } from '../supervisor/helpers.ts'

function continuityConfig(over: (c: RunConfig) => void = () => {}): RunConfig {
  const c = makeConfig()
  c.continuity = true
  over(c)
  return c
}

/** Implement's inputs as the reducer builds them: Plan done on Claude with its session. */
function inputs(
  o: Partial<SessionInputs['implement']> = {},
  caps?: SessionInputs['capabilities'],
): SessionInputs {
  return {
    fix: { vendor: 'claude', model: null, reuseSession: true, override: 'reuse' },
    implement: { vendor: 'claude', model: 'opus', status: 'done', sessionId: 'plan-s', ...o },
    ...(caps !== undefined ? { capabilities: caps } : {}),
  }
}

describe('decideImplementSession', () => {
  it('reuses Plan session when the vendor is the same and the vendor can switch models and modes', () => {
    expect(
      decideImplementSession(inputs({}, { resume: 'id', resumeModelSwitch: true, resumeModeSwitch: true })),
    ).toEqual({ reuse: true, sessionId: 'plan-s' })
  })

  it("names its fresh reasons in Plan's terms", () => {
    expect(decideImplementSession(inputs({ vendor: 'codex' }))).toEqual({
      reuse: false,
      reason: 'plan-vendor-differs',
    })
    expect(decideImplementSession(inputs({ status: 'skipped' }))).toEqual({
      reuse: false,
      reason: 'plan-skipped',
    })
    expect(decideImplementSession(inputs({ sessionId: undefined } as never))).toEqual({
      reuse: false,
      reason: 'no-session',
    })
  })

  it('falls back fresh where the vendor cannot change the mode on resume, or switch models', () => {
    expect(
      decideImplementSession(
        inputs({}, { resume: 'load', resumeModelSwitch: true, resumeModeSwitch: false }),
      ),
    ).toEqual({ reuse: false, reason: 'mode-switch-unsupported' })
    expect(
      decideImplementSession(
        inputs({}, { resume: 'load', resumeModelSwitch: false, resumeModeSwitch: true }),
      ),
    ).toEqual({ reuse: false, reason: 'model-differs' })
    expect(decideImplementSession(inputs({}, { resume: 'none', resumeModelSwitch: true }))).toEqual({
      reuse: false,
      reason: 'cannot-resume',
    })
  })

  it('its reasons have session-line words', () => {
    for (const r of IMPLEMENT_ONLY_REASONS) expect(FRESH_REASON_TEXT[r]).not.toBe('')
    expect(SESSION_NOTE.reusedPlan).toBe('continued the Plan session')
  })

  it('Plan keeps its session only with continuity on, both passes on and one vendor', () => {
    expect(planKeepsSession({ config: continuityConfig() })).toBe(true)
    expect(planKeepsSession({ config: makeConfig() })).toBe(false)
    expect(planKeepsSession({ config: continuityConfig((c) => (c.passes.implement.vendor = 'codex')) })).toBe(
      false,
    )
    expect(planKeepsSession({ config: continuityConfig((c) => (c.passes.plan.enabled = false)) })).toBe(false)
  })

  it('continuity is on by default and off with passes.implement.continuePlan false', async () => {
    const { runConfigFromResolved } = await import('@core/supervisor/machine.ts')
    expect(runConfigFromResolved(resolve({}).config).continuity).toBe(true)
    expect(
      runConfigFromResolved(resolve({ run: { passes: { implement: { continuePlan: false } } } }).config)
        .continuity,
    ).toBeUndefined()
  })
})

describe('reducer: Plan → Implement resume', () => {
  /** Plan approved; Implement's launch is at its pass-boundary preflight. */
  function toImplementPreflight(c: RunConfig): Harness {
    const h = new Harness(c)
    h.toPlanGate()
    h.approve()
    h.reconcile()
    h.snapshot('S0', 'tree-base')
    return h
  }

  it("Plan's launch keeps its session; Implement resumes it with the session note", () => {
    const h = new Harness(continuityConfig())
    h.toPlanRunning()
    const planSpawn = h.log
      .filter((e): e is EffectOf<'spawn'> => e.t === 'spawn')
      .find((e) => e.step === 'plan')
    expect(planSpawn?.launch.keepSession).toBe(true)
    const g = toImplementPreflight(continuityConfig())
    expect(g.step('implement').launch?.decide).toBe('session')
    g.send({
      t: 'session-check',
      step: 'implement',
      check: {
        sessionId: 'plan-session',
        ok: true,
        cwd: 'C:\\tmp\\ts-small',
        capabilities: { resume: 'id', resumeModelSwitch: true, resumeModeSwitch: true },
      },
    })
    g.passPreflight('implement')
    const spawn = g.fx('spawn').find((e) => e.step === 'implement')
    expect(spawn?.launch.resume?.sessionId).toBe('plan-session')
    expect(spawn?.launch.session).toEqual({ reuse: true, sessionId: 'plan-session' })
    expect(spawn?.mode).toBe('autoedit')
    expect(g.step('implement').sessionNote).toBe(SESSION_NOTE.reusedPlan)
  })

  it('a vendor that cannot switch modes on resume: Implement starts fresh and says why', () => {
    const g = toImplementPreflight(continuityConfig())
    g.send({
      t: 'session-check',
      step: 'implement',
      check: {
        sessionId: 'plan-session',
        ok: true,
        capabilities: { resume: 'load', resumeModelSwitch: true, resumeModeSwitch: false },
      },
    })
    g.passPreflight('implement')
    const spawn = g.fx('spawn').find((e) => e.step === 'implement')
    expect(spawn?.launch.resume).toBeUndefined()
    expect(spawn?.launch.fresh).toEqual({ reason: 'mode-switch-unsupported' })
    expect(g.step('implement').sessionNote).toBe(SESSION_NOTE.fresh('mode-switch-unsupported'))
  })

  it('Plan on another vendor: fresh, "Plan ran on another vendor"', () => {
    const g = toImplementPreflight(continuityConfig((c) => (c.passes.implement.vendor = 'codex')))
    g.passPreflight('implement')
    expect(g.step('implement').sessionNote).toBe(SESSION_NOTE.fresh('plan-vendor-differs'))
  })

  it('without continuity (an earlier run) Implement starts fresh with no note', () => {
    const g = toImplementPreflight(makeConfig())
    g.passPreflight('implement')
    const spawn = g.fx('spawn').find((e) => e.step === 'implement')
    expect(spawn?.launch.fresh).toEqual({})
    expect(g.step('implement').sessionNote).toBeUndefined()
  })

  it('the resumed Implement gets its full prompt (the plan as approved), not a bare continuation', () => {
    const g = toImplementPreflight(continuityConfig())
    g.send({
      t: 'session-check',
      step: 'implement',
      check: { sessionId: 'plan-session', ok: true, capabilities: { resume: 'id', resumeModelSwitch: true } },
    })
    g.passPreflight('implement')
    const spawn = g.fx('spawn').find((e) => e.step === 'implement') as EffectOf<'spawn'>
    expect(implementContinuesPlan(spawn)).toBe(true)
    const config = resolve({ run: { profile: 'claude-only' } }).config
    const prompt = buildPrompt(g.state, config, spawn)
    expect(prompt.text).toContain('Implement the following task')
    expect(prompt.text).toContain('Add a flag.')
    const o = startOptionsFor({
      runId: g.state.runId,
      cwd: 'C:\\x',
      config,
      state: g.state,
      spawn,
      prompt: '',
    })
    expect(o.resume?.sessionId).toBe('plan-session')
    expect(o.mode).toBe('autoedit')
  })

  it("Plan's start options keep the session under a pre-assigned id", () => {
    const h = new Harness(continuityConfig())
    h.toPlanRunning()
    const spawn = h.log.find((e): e is EffectOf<'spawn'> => e.t === 'spawn' && e.step === 'plan')
    expect(spawn).toBeDefined()
    const config = resolve({ run: { profile: 'claude-only' } }).config
    const o = startOptionsFor({
      runId: h.state.runId,
      cwd: 'C:\\x',
      config,
      state: h.state,
      spawn: spawn as EffectOf<'spawn'>,
      prompt: '',
    })
    expect(o.keepSession).toBe(true)
    expect(o.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(o.mode).toBe('readonly')
  })
})

describe('adapters: a kept Plan session', () => {
  it('Claude: no --no-session-persistence, a --session-id, still the plan permission mode', () => {
    const kept = buildArgv({
      route: 'plan',
      mode: 'readonly',
      step: 'plan',
      sessionId: 'fa4e0000-0000-4000-8000-000000000001',
      keepSession: true,
    })
    expect(kept).not.toContain('--no-session-persistence')
    expect(kept).toContain('--session-id=fa4e0000-0000-4000-8000-000000000001')
    expect(kept.slice(kept.indexOf('--permission-mode'), kept.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'plan',
    ])
    const emulated = buildArgv({
      route: 'readonly',
      mode: 'readonly',
      step: 'plan',
      sessionId: 'x',
      keepSession: true,
    })
    expect(emulated).not.toContain('--no-session-persistence')
    expect(emulated).toContain('--session-id=x')
    // Without it, as always: the session is thrown away.
    expect(buildArgv({ route: 'plan', mode: 'readonly', step: 'plan' })).toContain('--no-session-persistence')
    // Implement resumes it in its own mode.
    const resumed = buildArgv({ route: 'edit', mode: 'autoedit', step: 'implement', resumeId: 'x' })
    expect(resumed).toContain('--resume=x')
    expect(
      resumed.slice(resumed.indexOf('--permission-mode'), resumed.indexOf('--permission-mode') + 2),
    ).toEqual(['--permission-mode', 'acceptEdits'])
  })

  it('Codex: a Plan thread that is not ephemeral, still read-only; Implement resumes it with its own sandbox', () => {
    expect(ephemeralFor('plan')).toBe(true)
    expect(ephemeralFor('plan', true)).toBe(false)
    expect(ephemeralFor('review', true)).toBe(true)
    const start = threadStartParams({ step: 'plan', mode: 'readonly', cwd: 'C:\\x', keepSession: true })
    expect(start.ephemeral).toBe(false)
    expect(start.sandbox).toBe('read-only')
    const resume = threadResumeParams('t1', { step: 'implement', mode: 'autoedit', cwd: 'C:\\x' })
    expect(resume.sandbox).toBe('workspace-write')
    expect(resume.approvalPolicy).toBe('on-request')
    const exec = execArgv({ step: 'plan', mode: 'readonly', cwd: 'C:\\x', outFile: 'o', keepSession: true })
    expect(exec).not.toContain('--ephemeral')
    expect(execArgv({ step: 'plan', mode: 'readonly', cwd: 'C:\\x', outFile: 'o' })).toContain('--ephemeral')
  })
})

describe('implementSessionInputs', () => {
  it("reads Plan's step and session as the session Implement would continue", () => {
    const h = new Harness(continuityConfig())
    h.toPlanGate()
    const i = implementSessionInputs(h.state)
    expect(i.implement).toMatchObject({ vendor: 'claude', status: 'done', sessionId: 'plan-session' })
    expect(i.fix).toMatchObject({ vendor: 'claude', reuseSession: true })
  })
})
