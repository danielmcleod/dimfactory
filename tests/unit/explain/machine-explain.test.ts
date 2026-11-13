// Explain it to me in the state machine (the reducer only; the drivers play the controller):
//   - once the outcome is decided it is held while a read-only pass on Plan's config writes explain.md; the run then
//     completes with the held outcome (Explain never changes it)
//   - after the Deploy step (finish → Deploy → Explain → complete)
//   - on a "Completed with failures" outcome (verify-failed) too
//   - skipped with a note when the run made no changes
//   - an empty answer is a note, not a failure; a failure is a snag with Continue without
//   - a relaunch during it pauses it, Resume runs it again; Stop cancels it
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@shared/events.ts'
import type { AgentStep } from '@shared/run.ts'
import type { DeployPlanFacts } from '@shared/deploy.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { buildPrompt, startOptionsFor } from '@core/supervisor/effects.ts'
import { EXPLAIN_NOTE, EXPLAIN_REASON, SKIP_REASON } from '@core/supervisor/machine.ts'
import type { Reduction } from '@core/supervisor/types.ts'
import { Flow, reviewConfig } from '../supervisor/helpers.review.ts'
import { failure, makeRun, okReport } from '../supervisor/helpers.ts'
import { VFlow, verifyFlowConfig, result, trusted, verifyMust } from '../verify/machine-helpers.ts'

const SUMMARY = '## What was built\nA todo list.\n\n## How to run it\n1. `npm start`'

class XFlow extends Flow {
  constructor(o: { explain?: boolean; deploy?: boolean } = {}) {
    super({ review: true, critic: false, fix: true, beforeFix: false })
    const c = reviewConfig({ review: true, critic: false, fix: true, beforeFix: false })
    if (o.explain !== false) c.explain = true
    if (o.deploy === true) c.deploy = { target: null }
    this.state = makeRun(c)
  }

  agentSpawnNo(step: AgentStep): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  agentEv(step: AgentStep, ev: NormalizedEvent): Reduction {
    return this.send({ t: 'adapter', step, spawnNo: this.agentSpawnNo(step), ev })
  }

  agentExit(step: AgentStep, o: { failure?: ReturnType<typeof failure> } = {}): Reduction {
    return this.send({
      t: 'exit',
      step,
      spawnNo: this.agentSpawnNo(step),
      code: o.failure !== undefined ? 1 : 0,
      signal: null,
      ranMs: 4000,
      ...(o.failure !== undefined ? { failure: o.failure } : {}),
    })
  }

  agentPreflight(step: AgentStep): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
  }

  explainDone(text: string = SUMMARY): this {
    this.agentPreflight('explain')
    this.agentEv('explain', { type: 'done', result: text, usage: { input: 5, output: 5, costUsd: 0.01 } })
    this.agentExit('explain')
    return this
  }
}

describe('Explain it to me', () => {
  it('a run without it never touches the step', () => {
    const f = new XFlow({ explain: false })
    f.toJoin(['none', []])
    expect(f.state.outcome).toBe('clean')
    expect(f.step('explain')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.notUsed, attempt: 0 })
  })

  it('holds the outcome, writes explain.md on Plan config (read-only), then completes with the same outcome', () => {
    const f = new XFlow()
    f.toJoin(['none', []])
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.explain?.pending).toEqual({ outcome: 'clean' })
    expect(f.step('explain').status).toBe('running')
    expect(f.state.phase).toBe('explaining')
    f.agentPreflight('explain')
    const spawn = f.fx('spawn')[0]
    expect(spawn).toMatchObject({ step: 'explain', vendor: 'claude', model: 'opus', mode: 'readonly' })
    if (spawn === undefined) throw new Error('no spawn')
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const prompt = buildPrompt(f.state, cfg, spawn, {
      explain: {
        files: '1 file changed (3 lines added, 0 removed):\n- added: src/todo.ts',
        run: '- npm start',
      },
    }).text
    expect(prompt).toContain('- added: src/todo.ts')
    expect(prompt).toContain('- npm start')
    expect(prompt).toContain('## How to run it')
    expect(prompt).not.toContain('{{')
    const o = startOptionsFor({ runId: 'r', cwd: 'C:\\w', config: cfg, state: f.state, spawn, prompt })
    expect(o.step).toBe('plan')
    expect(o.planNative).toBe(false)
    expect(o.extensions?.level).toBe('none')
    f.agentEv('explain', { type: 'done', result: SUMMARY, usage: { input: 5, output: 5 } })
    f.agentExit('explain')
    expect(f.log.filter((e) => e.t === 'writeOutput' && e.file === 'explain')).toEqual([
      expect.objectContaining({ text: SUMMARY }),
    ])
    expect(f.state).toMatchObject({ outcome: 'clean', status: 'completed' })
    expect(f.state.explain?.pending).toBeUndefined()
  })

  it('runs after the Deploy step: finish, Deploy, Explain, complete', () => {
    const f = new XFlow({ deploy: true })
    f.toJoin(['none', []])
    expect(f.state.deploy?.pending).toEqual({ outcome: 'clean' })
    expect(f.step('explain').status).toBe('queued')
    const facts: DeployPlanFacts = {
      cls: { id: 'static-site', label: 'Static site', confidence: 'high' },
      target: { id: 'netlify', label: 'Netlify' },
      files: [],
      present: ['netlify.toml'],
      env: [],
      notes: [],
    }
    const req = f.req((r) => r.kind === 'deploy-plan', 'deploy plan')
    f.send({ t: 'deploy-plan-result', req, plan: facts })
    expect(f.step('deploy').status).toBe('done')
    // Deploy is over; Explain now holds the outcome.
    expect(f.state.deploy?.pending).toBeUndefined()
    expect(f.state.explain?.pending).toEqual({ outcome: 'clean' })
    expect(f.state.outcome).toBeUndefined()
    f.agentPreflight('explain')
    const spawn = f.fx('spawn')[0]
    if (spawn === undefined) throw new Error('no spawn')
    const prompt = buildPrompt(f.state, resolveBuiltinConfig({ profile: 'claude-only' }), spawn).text
    expect(prompt).toContain('Netlify. Nothing was deployed.')
    f.agentEv('explain', { type: 'done', result: SUMMARY })
    f.agentExit('explain')
    expect(f.state).toMatchObject({ outcome: 'clean', status: 'completed' })
  })

  it('runs on a "Completed with failures" outcome, which it never changes', () => {
    const c = verifyFlowConfig({ critic: false })
    c.explain = true
    const f = new VFlow({ critic: false })
    f.state = makeRun(c)
    f.toVerified(result('test', 'fail'), [verifyMust('test')])
    f.toJoinAfterVerify('none', 'none')
    f.choose('gate:beforeFix', 'continue')
    f.fixToS2()
    f.check([trusted()], 'verify:2')
    f.round([result('test', 'fail')], [verifyMust('test')], 'verify:2')
    expect(f.state.explain?.pending).toEqual({ outcome: 'verify-failed' })
    const req = f.req((r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === 'explain')
    f.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
    const spawn = f.fx('spawn')[0]
    if (spawn === undefined) throw new Error('no spawn')
    // The prompt has the run's last checks (verify:2's failure).
    expect(buildPrompt(f.state, resolveBuiltinConfig({ profile: 'claude-only' }), spawn).text).toContain(
      'test',
    )
    f.send({ t: 'adapter', step: 'explain', spawnNo: 1, ev: { type: 'done', result: SUMMARY } })
    f.send({ t: 'exit', step: 'explain', spawnNo: 1, code: 0, signal: null, ranMs: 100 })
    expect(f.state).toMatchObject({ outcome: 'verify-failed', status: 'completed' })
  })

  it('is skipped with a note when the run made no changes', () => {
    const f = new XFlow()
    f.toImplementDone()
    f.snapshot('S1', 'tree-base')
    expect(f.state.outcome).toBe('no-changes')
    expect(f.step('explain')).toMatchObject({ status: 'skipped', reason: EXPLAIN_REASON.noChanges })
    expect(f.state.notes).toContain(EXPLAIN_NOTE.noChanges)
    expect(f.log.some((e) => e.t === 'spawn' && e.step === 'explain')).toBe(false)
  })

  it('an empty answer is a note, not a failure', () => {
    const f = new XFlow()
    f.toJoin(['none', []])
    f.explainDone('   ')
    expect(f.step('explain')).toMatchObject({ status: 'done', reason: EXPLAIN_REASON.empty })
    expect(f.state.notes).toContain(EXPLAIN_NOTE.empty)
    expect(f.log.some((e) => e.t === 'writeOutput' && e.file === 'explain')).toBe(false)
    expect(f.state).toMatchObject({ outcome: 'clean', status: 'completed' })
  })

  it('a failure is a snag like any pass: Continue without completes with the held outcome', () => {
    const f = new XFlow()
    f.toJoin(['none', []])
    f.agentPreflight('explain')
    f.agentExit('explain', { failure: failure('auth_expired') })
    expect(f.step('explain').status).toBe('failed')
    expect(f.state.outcome).toBeUndefined()
    f.user({ kind: 'skip', step: 'explain' })
    expect(f.step('explain')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.user })
    expect(f.state).toMatchObject({ outcome: 'clean', status: 'completed' })
  })

  it('a relaunch pauses it, Resume runs it again; Stop cancels it', () => {
    const f = new XFlow()
    f.toJoin(['none', []])
    f.agentPreflight('explain')
    f.send({ t: 'relaunch' })
    expect(f.step('explain').status).toBe('paused')
    expect(f.state.outcome).toBeUndefined()
    f.user({ kind: 'resume' })
    f.explainDone()
    expect(f.log.filter((e) => e.t === 'spawn' && e.step === 'explain')).toHaveLength(2)
    expect(f.state).toMatchObject({ outcome: 'clean', status: 'completed' })

    const g = new XFlow()
    g.toJoin(['none', []])
    g.agentPreflight('explain')
    g.user({ kind: 'stop' })
    expect(g.step('explain').status).toBe('cancelled')
    expect(g.state.status).toBe('cancelled')
  })

  it('its node is planned from the start, and the summary panel reads it once done', () => {
    const f = new XFlow()
    f.create()
    expect(toRunSnapshot(f.state, 0, f.now).steps.explain.planned).toBe(true)
  })
})
