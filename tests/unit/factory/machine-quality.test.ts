// The project's quality gates and model routing in the state machine (the reducer only; the drivers play the
// controller):
//   - no gates: the outcome stands
//   - a required verify command that passed keeps the outcome, with the gates noted; one that failed, did not run, or
//     a run with Verify off completes as gates-failed (RunState.gates says which and why)
//   - the security and acceptance reviews required but off; an unmet acceptance criterion
//   - an outcome that is a failure already is left alone; Deploy does not run after gates-failed
//   - routing: a routed step spawns its own model and effort on its pass's vendor
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@shared/events.ts'
import type { AgentStep } from '@shared/run.ts'
import { stepPassConfig } from '@core/supervisor/step-use.ts'
import { passCfg } from '@core/supervisor/machine.ts'
import type { Reduction, RunConfig } from '@core/supervisor/types.ts'
import { Flow, reviewConfig } from '../supervisor/helpers.review.ts'
import { makeRun, okReport } from '../supervisor/helpers.ts'
import { VFlow, verifyFlowConfig, result, trusted, verifyMust } from '../verify/machine-helpers.ts'

type Quality = NonNullable<RunConfig['quality']>

function vflow(q: Quality | undefined, o: ConstructorParameters<typeof VFlow>[0] = {}): VFlow {
  const f = new VFlow(o)
  if (q !== undefined) f.state = { ...f.state, config: { ...f.state.config, quality: q } }
  return f
}

const Q = (o: Partial<Quality>): Quality => ({ verify: [], security: false, acceptance: false, ...o })

describe('quality gates on a verify command', () => {
  it('no gates: the outcome stands and nothing is recorded', () => {
    const f = vflow(undefined).toVerified(result('test', 'pass'))
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('clean')
    expect(f.state.gates).toBeUndefined()
    expect(f.state.notes.some((n) => n.includes('Quality gates'))).toBe(false)
  })

  it('a required command that passed keeps the outcome; the gates are noted', () => {
    const f = vflow(Q({ verify: ['test'] })).toVerified(result('test', 'pass'))
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('clean')
    expect(f.state.gates).toEqual({ passed: ['test'], failed: [] })
    expect(f.state.notes).toContain('Quality gates passed: test.')
  })

  it('a required command that did not run makes it gates-failed', () => {
    const f = vflow(Q({ verify: ['lint'] })).toVerified(result('test', 'pass'))
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('gates-failed')
    expect(f.state.status).toBe('completed')
    expect(f.state.gates).toEqual({
      passed: [],
      failed: [{ name: 'lint', reason: 'It did not run in this run.' }],
    })
    expect(f.state.notes).toContain(
      "Completed with failures: the project's quality gates did not pass (lint: It did not run in this run.)",
    )
  })

  it('a required command that failed (Fix off: findings open) makes it gates-failed', () => {
    const f = vflow(Q({ verify: ['test'] }), { fix: false }).toVerified(result('test', 'fail'), [
      verifyMust('test'),
    ])
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('gates-failed')
    expect(f.state.gates?.failed).toEqual([{ name: 'test', reason: 'It failed.' }])
  })

  it('a command the round skipped says why', () => {
    const f = vflow(Q({ verify: ['test'] })).toS1()
    f.check([trusted('lint'), trusted('test')])
    f.round([result('lint', 'pass'), result('test', 'skipped', { reason: 'You skipped it' })])
    f.snapshot('post-verify-1', 'tree-changed')
    f.toJoinAfterVerify('none', 'none')
    expect(f.state.outcome).toBe('gates-failed')
    expect(f.state.gates?.failed).toEqual([{ name: 'test', reason: 'It did not run: You skipped it' }])
  })

  it('the last round counts: a command that failed after Implement and passed after Fix passes', () => {
    const f = vflow(Q({ verify: ['test'] }), { beforeFix: false }).toVerified(result('test', 'fail'), [
      verifyMust('test'),
    ])
    f.toJoinAfterVerify('none', 'none')
    f.fixToS2()
    f.check([trusted()], 'verify:2')
    f.round([result('test', 'pass')], [], 'verify:2')
    expect(f.state.outcome).toBe('fixed')
    expect(f.state.gates).toEqual({ passed: ['test'], failed: [] })
  })

  it('an outcome that is a failure already (verify-failed) is left alone', () => {
    const f = vflow(Q({ verify: ['test'] }), { beforeFix: false }).toVerified(result('test', 'fail'), [
      verifyMust('test'),
    ])
    f.toJoinAfterVerify('none', 'none')
    f.fixToS2()
    f.check([trusted()], 'verify:2')
    f.round([result('test', 'fail')], [verifyMust('test')], 'verify:2')
    expect(f.state.outcome).toBe('verify-failed')
    expect(f.state.gates).toBeUndefined()
  })

  it('Verify off: a required command cannot run', () => {
    const c = verifyFlowConfig({ enabled: false })
    c.quality = Q({ verify: ['test'] })
    const f = new Flow({ review: true, critic: false, fix: true, beforeFix: false })
    f.state = makeRun(c)
    f.toJoin(['none', []])
    expect(f.state.outcome).toBe('gates-failed')
    expect(f.state.gates?.failed).toEqual([
      { name: 'test', reason: 'Verify is off for this run, so it did not run.' },
    ])
  })
})

class GFlow extends Flow {
  constructor(c: RunConfig) {
    super({ review: true, critic: false, fix: true, beforeFix: false })
    this.state = makeRun(c)
  }

  agentSpawnNo(step: AgentStep): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  agentEv(step: AgentStep, ev: NormalizedEvent): Reduction {
    return this.send({ t: 'adapter', step, spawnNo: this.agentSpawnNo(step), ev })
  }

  agentPreflight(step: AgentStep): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
  }
}

const PLAN_AC = [
  '## Goal',
  'G',
  '',
  '## Acceptance criteria',
  '- One',
  '- Two',
  '',
  '## Risks',
  '- none',
].join('\n')

describe('quality gates on the security and acceptance reviews', () => {
  it('security required but the advisor off', () => {
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    c.quality = Q({ security: true })
    const f = new GFlow(c)
    f.toJoin(['none', []])
    expect(f.state.outcome).toBe('gates-failed')
    expect(f.state.gates?.failed).toEqual([
      { name: 'security', reason: 'The security review is off for this run.' },
    ])
  })

  it('acceptance required but the review off', () => {
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    c.quality = Q({ acceptance: true })
    const f = new GFlow(c)
    f.toJoin(['none', []])
    expect(f.state.gates?.failed).toEqual([
      { name: 'acceptance', reason: 'The acceptance review is off for this run.' },
    ])
  })

  it('acceptance required: an unmet criterion fails it; all met passes', () => {
    const run = (verdicts: { id: string; status: string }[]): GFlow => {
      const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
      c.acceptance = true
      c.quality = Q({ acceptance: true })
      const f = new GFlow(c)
      f.toPlanGate(PLAN_AC)
      f.approve()
      f.reconcile()
      f.snapshot('S0', 'tree-base')
      f.passPreflight('implement')
      f.ev('implement', { type: 'session', id: 'impl-session' })
      f.ev('implement', { type: 'done', result: 'done' })
      f.exit('implement')
      f.reconcile('end-of-pass')
      f.snapshot('S1', 'tree-changed')
      f.agentPreflight('acceptance')
      f.agentEv('acceptance', {
        type: 'done',
        result: JSON.stringify({ verdicts: verdicts.map((v) => ({ ...v, evidence: 'seen in the diff' })) }),
      })
      f.send({
        t: 'exit',
        step: 'acceptance',
        spawnNo: f.agentSpawnNo('acceptance'),
        code: 0,
        signal: null,
        ranMs: 10,
      })
      f.reconcile('pre-review')
      f.passPreflight('review')
      f.report('review', 'none')
      if (f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined)
        f.snapshot('post-review', 'tree-changed')
      return f
    }
    const unmet = run([
      { id: 'AC1', status: 'met' },
      { id: 'AC2', status: 'not-met' },
    ])
    expect(unmet.state.outcome).toBe('gates-failed')
    expect(unmet.state.gates?.failed).toEqual([
      { name: 'acceptance', reason: 'Not every criterion is met (AC2).' },
    ])
    const met = run([
      { id: 'AC1', status: 'met' },
      { id: 'AC2', status: 'met' },
    ])
    expect(met.state.outcome).toBe('clean')
    expect(met.state.gates).toEqual({ passed: ['acceptance'], failed: [] })
  })

  it('Deploy does not run after gates-failed', () => {
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    c.deploy = { target: null }
    c.quality = Q({ security: true })
    const f = new GFlow(c)
    f.toJoin(['none', []])
    expect(f.state.outcome).toBe('gates-failed')
    expect(f.state.deploy).toBeUndefined()
    expect(f.step('deploy').status).toBe('skipped')
    expect(f.log.some((e) => e.t === 'spawn' && e.step === 'deploy')).toBe(false)
  })
})

describe('model routing', () => {
  it('a routed step takes its own model and effort; other steps and fields follow the pass', () => {
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    c.routing = { explain: { model: 'haiku', effort: 'low' }, research: { model: null } }
    const s = { config: c }
    expect(stepPassConfig(s, 'explain')).toEqual({ ...c.passes.plan, model: 'haiku', effort: 'low' })
    expect(stepPassConfig(s, 'research')).toEqual({ ...c.passes.plan, model: null })
    expect(stepPassConfig(s, 'plan')).toBe(c.passes.plan)
    expect(stepPassConfig(s, 'acceptance')).toBe(c.passes.review)
    expect(passCfg(s, 'explain').model).toBe('haiku')
  })

  it('the spawn of a routed step names its model (Explain on haiku while Plan is opus)', () => {
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    c.explain = true
    c.routing = { explain: { model: 'haiku' } }
    const f = new GFlow(c)
    f.toJoin(['none', []])
    expect(f.step('plan').model).toBe(c.passes.plan.model)
    f.agentPreflight('explain')
    expect(f.fx('spawn')[0]).toMatchObject({ step: 'explain', vendor: c.passes.plan.vendor, model: 'haiku' })
  })
})
