// The Deploy step in the state machine (the reducer only; the drivers play the controller):
//   - a run without it never touches the `deploy` step
//   - with it, once the outcome is decided without failures, the outcome is held while the step plans (deployPlan),
//     then runs an editing pass on the Implement pass's config (deploy-start, the pass, deploy-end with the paths it
//     wrote, its end-of-pass
//     check), then the run completes with the held outcome
//   - nothing to write, no target, or an unreadable folder: done or skipped with a note, the run completes at once
//   - a run that made no changes, or ended with failures, skips it with a note
//   - a relaunch while it plans pauses it; Resume plans again; Continue without it completes; Stop cancels
//   - the prompt and launch: Implement's config, the target, files and variables; the Diff tab's Deploy segment
import { describe, expect, it } from 'vitest'
import type { DeployPlanFacts } from '@shared/deploy.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { segmentEnds } from '@core/supervisor/diff-segments.ts'
import { buildPrompt, startOptionsFor } from '@core/supervisor/effects.ts'
import { DEPLOY_NOTE, DEPLOY_OUTCOMES, DEPLOY_REASON, SKIP_REASON } from '@core/supervisor/machine.ts'
import type { Reduction } from '@core/supervisor/types.ts'
import { Flow, reviewConfig } from '../supervisor/helpers.review.ts'
import { okReport } from '../supervisor/helpers.ts'

const FACTS: DeployPlanFacts = {
  cls: { id: 'server-app', label: 'Server app', confidence: 'high' },
  target: { id: 'fly', label: 'Fly.io' },
  files: [
    { kind: 'dockerfile', path: 'Dockerfile', purpose: 'builds a container image that starts the app' },
    { kind: 'fly', path: 'fly.toml', purpose: 'describes the Fly.io app' },
  ],
  present: ['.env.example'],
  env: ['DATABASE_URL', 'PORT'],
  notes: [],
}

class DFlow extends Flow {
  constructor(o: { deploy?: boolean; fix?: boolean; target?: string | null } = {}) {
    super({ review: true, critic: false, fix: o.fix ?? true, beforeFix: false })
    const c = reviewConfig({ review: true, critic: false, fix: o.fix ?? true, beforeFix: false })
    if (o.deploy !== false) c.deploy = { target: o.target ?? null }
    this.state = { ...this.state, config: c }
  }

  /** Review reports nothing: the run's outcome is `clean` (Fix skipped by the rule). */
  toClean(): this {
    this.toJoin(['none', []])
    return this
  }

  planReq(): string {
    return this.req((r) => r.kind === 'deploy-plan', 'deploy plan')
  }

  plan(plan: DeployPlanFacts = FACTS): Reduction {
    return this.send({ t: 'deploy-plan-result', req: this.planReq(), plan })
  }

  /** The planning could not read the folder. */
  planFailed(): Reduction {
    return this.send({
      t: 'deploy-plan-result',
      req: this.planReq(),
      failure: { category: 'unknown', message: 'EACCES', raw: '', classifiedBy: 'app' },
    })
  }

  deployPreflight(): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === 'deploy',
      'passBoundary deploy',
    )
    return this.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
  }

  deploySpawnNo(): number {
    return this.state.steps.deploy.proc?.spawnNo ?? 0
  }

  /** Planned with files → deploy-start → the pass-boundary preflight → the Deploy pass spawned. */
  toDeploySpawned(): this {
    this.toClean()
    this.plan()
    this.snapshot('deploy-start', 'tree-changed')
    this.deployPreflight()
    return this
  }

  /** The pass answers and exits; its end-of-pass check is clean; deploy-end lands with the files it wrote. */
  deployDone(written: string[] = ['Dockerfile', 'fly.toml']): Reduction {
    this.send({
      t: 'adapter',
      step: 'deploy',
      spawnNo: this.deploySpawnNo(),
      ev: { type: 'session', id: 'deploy-s' },
    })
    this.send({
      t: 'adapter',
      step: 'deploy',
      spawnNo: this.deploySpawnNo(),
      ev: {
        type: 'done',
        result: 'Wrote Dockerfile and fly.toml. Set the app name.',
        usage: { input: 5, output: 9 },
      },
    })
    this.send({
      t: 'exit',
      step: 'deploy',
      spawnNo: this.deploySpawnNo(),
      code: 0,
      signal: null,
      ranMs: 3000,
    })
    this.reconcile('end-of-pass')
    return this.send({
      t: 'snapshot-done',
      req: this.snapReq('deploy-end'),
      commit: 'c-deploy-end',
      tree: 'tree-deployed',
      changed: written,
    })
  }
}

describe('the Deploy step', () => {
  it('a run without it never touches the step, and completes as before', () => {
    const f = new DFlow({ deploy: false })
    f.toClean()
    expect(f.state.outcome).toBe('clean')
    expect(f.state.status).toBe('completed')
    expect(f.log.some((e) => e.t === 'deployPlan')).toBe(false)
    expect(f.state.steps.deploy).toMatchObject({ status: 'skipped', reason: SKIP_REASON.notUsed, attempt: 0 })
  })

  it('holds the outcome, plans, writes the missing config on Implement config, then completes with the outcome', () => {
    const f = new DFlow({ target: 'fly' })
    f.toClean()
    // The outcome is decided but held: the run is still going, the step plans.
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.deploy?.pending).toEqual({ outcome: 'clean' })
    expect(f.state.steps.deploy.status).toBe('running')
    expect(f.state.phase).toBe('deploying')
    const plan = f.fx('deployPlan')
    expect(plan).toHaveLength(1)
    expect(plan[0]?.target).toBe('fly')

    f.plan()
    expect(f.state.notes).toContain(DEPLOY_NOTE.planned('Fly.io', ['Dockerfile', 'fly.toml']))
    // A mutating pass: its start snapshot (deploy-start) before anything spawns.
    expect(f.fx('snapshot').map((s) => s.label)).toEqual(['deploy-start'])
    f.snapshot('deploy-start', 'tree-changed')
    f.deployPreflight()
    const spawn = f.fx('spawn')[0]
    expect(spawn).toMatchObject({ step: 'deploy', vendor: 'claude', mode: 'autoedit' })
    expect(spawn?.launch.fresh).toBeDefined()
    expect(f.state.liveCount).toBe(true)

    const r = f.deployDone()
    // The answer is kept, and the files it wrote are recorded; the run completes with the held outcome.
    expect(f.log.some((e) => e.t === 'writeOutput' && e.file === 'deploy')).toBe(true)
    expect(f.state.deploy?.written).toEqual(['Dockerfile', 'fly.toml'])
    expect(f.state.deploy?.pending).toBeUndefined()
    expect(f.state.outcome).toBe('clean')
    expect(f.state.status).toBe('completed')
    expect(r.effects.some((e) => e.t === 'notify' && e.kind === 'completed')).toBe(true)
    // The end snapshot listed the pass's own paths (from deploy-start).
    const d1 = f.log.find((e) => e.t === 'snapshot' && e.label === 'deploy-end')
    expect(d1).toMatchObject({ step: 'deploy', diffFrom: 'c-deploy-start' })

    // The views: the step's facts, and the Diff tab's Deploy segment deploy-start..deploy-end inside Combined.
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.steps.deploy.deploy).toMatchObject({
      phase: 'done',
      cls: { id: 'server-app' },
      target: { id: 'fly', label: 'Fly.io' },
      written: ['Dockerfile', 'fly.toml'],
      present: ['.env.example'],
    })
    expect(segmentEnds(f.state, 'deploy')).toMatchObject({
      from: { label: 'deploy-start' },
      to: { label: 'deploy-end' },
    })
    expect(segmentEnds(f.state, 'combined')?.to.label).toBe('deploy-end')
  })

  it('its node is planned from the start (the timeline never inserts it mid-row)', () => {
    const f = new DFlow()
    f.create()
    expect(toRunSnapshot(f.state, 0, f.now).steps.deploy.planned).toBe(true)
    const off = new DFlow({ deploy: false })
    off.create()
    expect(toRunSnapshot(off.state, 0, off.now).steps.deploy.planned).toBeUndefined()
  })

  it('nothing to write: the step is done with a note, and the run completes at once', () => {
    const f = new DFlow()
    f.toClean()
    f.plan({ ...FACTS, files: [], present: ['Dockerfile', 'fly.toml'] })
    expect(f.state.steps.deploy).toMatchObject({ status: 'done', reason: DEPLOY_REASON.nothingToWrite })
    expect(f.state.notes).toContain(DEPLOY_NOTE.nothingToWrite('Fly.io', ['Dockerfile', 'fly.toml']))
    expect(f.state.outcome).toBe('clean')
    expect(f.log.some((e) => e.t === 'spawn' && e.step === 'deploy')).toBe(false)
  })

  it('no target for the class, or a folder it cannot read: skipped with a note, the run completes', () => {
    const a = new DFlow()
    a.toClean()
    a.plan({ ...FACTS, target: null, files: [] })
    expect(a.state.steps.deploy).toMatchObject({ status: 'skipped', reason: DEPLOY_REASON.noTarget })
    expect(a.state.notes).toContain(DEPLOY_NOTE.noTarget('Server app'))
    expect(a.state.outcome).toBe('clean')

    const b = new DFlow()
    b.toClean()
    b.planFailed()
    expect(b.state.steps.deploy).toMatchObject({ status: 'skipped', reason: DEPLOY_REASON.unreadable })
    expect(b.state.notes).toContain(DEPLOY_NOTE.unreadable('EACCES'))
    expect(b.state.outcome).toBe('clean')
  })

  it('runs only after an outcome without failures; a run with no changes skips it with a note', () => {
    expect([...DEPLOY_OUTCOMES]).toEqual(['fixed', 'clean', 'findings-open'])
    const f = new DFlow()
    f.toImplementDone()
    f.snapshot('S1', 'tree-base')
    expect(f.state.outcome).toBe('no-changes')
    expect(f.state.steps.deploy).toMatchObject({ status: 'skipped', reason: DEPLOY_REASON.noChanges })
    expect(f.state.notes).toContain(DEPLOY_NOTE.noChanges)
    expect(f.log.some((e) => e.t === 'deployPlan')).toBe(false)
  })

  it('findings left open (Fix off) still writes the config', () => {
    const f = new DFlow({ fix: false })
    f.toJoin(['ok', [{ id: 'm1', severity: 'must', title: 'a bug', body: 'b' }]])
    expect(f.state.deploy?.pending).toEqual({ outcome: 'findings-open' })
    f.plan({ ...FACTS, files: [] })
    expect(f.state.outcome).toBe('findings-open')
  })

  it('a relaunch while it plans pauses it; Resume plans again', () => {
    const f = new DFlow()
    f.toClean()
    f.send({ t: 'relaunch' })
    expect(f.state.steps.deploy).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(f.findReq((r) => r.kind === 'deploy-plan')).toBeUndefined()
    f.user({ kind: 'resume' })
    expect(f.fx('deployPlan')).toHaveLength(1)
    f.plan({ ...FACTS, files: [] })
    expect(f.state.outcome).toBe('clean')
  })

  it('a failed Deploy pass offers Continue without it, which completes with the held outcome', () => {
    const f = new DFlow()
    f.toDeploySpawned()
    f.send({
      t: 'adapter',
      step: 'deploy',
      spawnNo: f.deploySpawnNo(),
      ev: { type: 'error', message: 'login needed', raw: '', fatal: true, category: 'auth_required' },
    })
    expect(f.state.steps.deploy.status).toBe('failed')
    expect(f.state.outcome).toBeUndefined()
    f.user({ kind: 'skip', step: 'deploy' })
    expect(f.state.steps.deploy).toMatchObject({ status: 'skipped', reason: SKIP_REASON.user })
    expect(f.state.outcome).toBe('clean')
  })

  it('Stop while it runs cancels it (the run is cancelled, its changes kept)', () => {
    const f = new DFlow()
    f.toDeploySpawned()
    f.user({ kind: 'stop' })
    expect(f.state.steps.deploy.status).toBe('cancelled')
    expect(f.state.status).toBe('cancelled')
  })

  it('Stop after the Deploy pass failed cancels the run without giving it an outcome', () => {
    const f = new DFlow()
    f.toDeploySpawned()
    f.send({
      t: 'adapter',
      step: 'deploy',
      spawnNo: f.deploySpawnNo(),
      ev: { type: 'error', message: 'login needed', raw: '', fatal: true, category: 'auth_required' },
    })
    expect(f.state.steps.deploy.status).toBe('failed')
    f.user({ kind: 'stop' })
    expect(f.state.status).toBe('cancelled')
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.steps.deploy.status).toBe('cancelled')
  })

  it('the prompt names the target, the files and the variables; the launch is Implement config, editing', () => {
    const f = new DFlow()
    f.toDeploySpawned()
    const spawn = f.log.find((e) => e.t === 'spawn' && e.step === 'deploy')
    if (spawn === undefined || spawn.t !== 'spawn') throw new Error('no deploy spawn')
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    const prompt = buildPrompt(f.state, config, spawn).text
    expect(prompt).toContain('deployed to Fly.io (fly)')
    expect(prompt).toContain('What it ships as: Server app')
    expect(prompt).toContain('- Dockerfile: builds a container image that starts the app')
    expect(prompt).toContain('- DATABASE_URL')
    expect(prompt).toMatch(/Never put a real secret/)
    expect(prompt).toMatch(/Do not run deploy, login, publish or release commands/)
    expect(prompt).not.toMatch(/\{\{/)
    const o = startOptionsFor({ runId: f.state.runId, cwd: 'C:\\w', config, state: f.state, spawn, prompt })
    expect(o).toMatchObject({ step: 'implement', mode: 'autoedit' })
    expect(o.sessionId).toBeDefined()
  })
})
