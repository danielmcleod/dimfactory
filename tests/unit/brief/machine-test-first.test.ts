// Test-first in the state machine (the reducer only; the controller's answers are played by the drivers):
//   - a run without it never touches the `tests` / `verify:red` steps (no events, never cancelled or shown)
//   - Plan → gate → the Tests step takes R5 (reconcile, branch prep) and T0, the run's base → T1 (its files) → the red
//     check (failures expected, never findings) → post-red → Implement (its reconcile starts from post-red, its own
//     changes from T0) → S1 → the tests check (T1 vs S1) → verify:1 (always, Verify on) → Review ∥ Critic
//   - no failing command → testsNotRed: Rewrite sends the Tests step back (resumed, with why), Continue goes on, Stop
//     stops; Auto rewrites once, then continues
//   - weakened tests → a [must] (source tests) that joins the reviewers' at R8 and blocks the Fix skip rule
//   - Continue without the Tests step skips its red check; Implement runs as usual
//   - relaunch re-issues the post-red snapshot and the tests check
import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/run.ts'
import type { NormalizedEvent } from '@shared/events.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { promptDiffRange } from '@core/supervisor/effects.ts'
import type { FindingInput, Reduction } from '@core/supervisor/types.ts'
import { result, trusted, VFlow } from '../verify/machine-helpers.ts'
import type { VerifyOptions } from '../verify/machine-helpers.ts'

const TEST_FILES = ['test/version.test.ts', 'src/version.ts']

class TFlow extends VFlow {
  constructor(o: VerifyOptions & { testFirst?: boolean } = {}) {
    super(o)
    if (o.testFirst !== false)
      this.state = { ...this.state, config: { ...this.state.config, testFirst: true } }
  }

  agentSpawnNo(step: AgentStep): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  agentEv(step: AgentStep, ev: NormalizedEvent): Reduction {
    return this.send({ t: 'adapter', step, spawnNo: this.agentSpawnNo(step), ev })
  }

  agentExit(step: AgentStep): Reduction {
    return this.send({
      t: 'exit',
      step,
      spawnNo: this.agentSpawnNo(step),
      code: 0,
      signal: null,
      ranMs: 5000,
    })
  }

  agentPreflight(step: AgentStep): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({
      t: 'preflight-result',
      req,
      report: { mode: 'passBoundary', ok: true, blocking: [], warnings: [], info: [] },
    })
  }

  /** Plan → gate approved → R5 reconcile → T0 → the Tests step spawned with its session. */
  toTestsRunning(): this {
    this.toPlanGate()
    if (this.state.cards.some((c) => c.view.kind === 'gate:afterPlan')) this.approve()
    this.reconcile('pre-implement')
    this.snapshot('T0', 'tree-base')
    this.agentPreflight('tests')
    this.agentEv('tests', { type: 'session', id: 'tests-session' })
    return this
  }

  /** The Tests step done → exit → end-of-pass → T1 with the files it changed. */
  testsDone(files: string[] = TEST_FILES, tree = 'tree-tests'): this {
    this.agentEv('tests', { type: 'done', result: 'wrote the tests', usage: { input: 5, output: 5 } })
    this.agentExit('tests')
    this.reconcile('end-of-pass')
    this.send({ t: 'snapshot-done', req: this.snapReq('T1'), commit: 'c-T1', tree, changed: files })
    return this
  }

  /** The red check with `status` for its one command (no post-red snapshot yet). */
  red(status: 'fail' | 'pass' = 'fail'): this {
    this.check([trusted('test')], 'verify:red')
    this.round([result('test', status)], [], 'verify:red')
    return this
  }

  /** post-red → Implement's reconcile → S0 → Implement spawned. */
  toImplementAfterTests(): this {
    this.snapshot('post-red', 'tree-tests')
    this.reconcile('pre-implement')
    this.snapshot('S0', 'tree-tests')
    this.passPreflight('implement')
    this.ev('implement', { type: 'session', id: 'impl-session' })
    return this
  }

  /** Implement done → exit → end-of-pass → S1. */
  implementDone(tree = 'tree-impl'): this {
    this.ev('implement', { type: 'done', result: 'implemented', usage: { input: 5, output: 5 } })
    this.exit('implement')
    this.reconcile('end-of-pass')
    this.snapshot('S1', tree)
    return this
  }

  guard(findings: FindingInput[] = []): Reduction {
    const req = this.req((r) => r.kind === 'tests-check', 'tests-check')
    return this.send({ t: 'tests-check-result', req, findings })
  }
}

const spawnedSteps = (f: TFlow): string[] => f.log.filter((e) => e.t === 'spawn').map((e) => e.step)

describe('Test-first off', () => {
  it('leaves the tests and verify:red steps untouched: no events, not shown, not cancelled on Stop', () => {
    const f = new TFlow({
      testFirst: false,
      runAfter: ['implement'],
      review: false,
      critic: false,
      fix: false,
    })
    f.toVerified(result('test', 'pass'))
    const emitted = f.log
      .filter((e) => e.t === 'emit')
      .map((e) => (e.t === 'emit' && e.body.t === 'step-status' ? e.body.step : ''))
    expect(emitted).not.toContain('tests')
    expect(emitted).not.toContain('verify:red')
    expect(f.state.outcome).toBe('clean')
    expect(f.step('tests')).toMatchObject({ status: 'queued', attempt: 0 })
    const snap = toRunSnapshot(f.state, 0)
    expect(snap.steps.tests.planned).toBeUndefined()
    expect(snap.steps['verify:red'].planned).toBeUndefined()
    expect(snap.summary.status).toBe('completed')
    expect(spawnedSteps(f)).toEqual(['plan', 'implement'])

    const g = new TFlow({ testFirst: false, review: false, critic: false, fix: false })
    g.toImplementRunning()
    g.user({ kind: 'stop' })
    expect(g.step('tests').status).toBe('queued')
    expect(g.step('verify:red').status).toBe('queued')
  })
})

describe('Test-first on', () => {
  it('runs Plan, the Tests step, the red check and Implement in order, with T0 as the run base', () => {
    const f = new TFlow({ runAfter: [], review: true, critic: false, fix: false })
    const queued = toRunSnapshot(f.state, 0)
    expect(queued.steps.tests.planned).toBe(true)
    expect(queued.steps['verify:red'].planned).toBe(true)
    // verify:1 always runs with Test-first, even when runAfter leaves Implement out.
    expect(queued.steps['verify:1'].planned).toBe(true)

    f.toTestsRunning()
    expect(f.step('tests').status).toBe('running')
    expect(f.state.phase).toBe('writing-tests')
    expect(f.state.snapshots.T0?.commit).toBe('c-T0')
    const spawn = f.log.find((e) => e.t === 'spawn' && e.step === 'tests')
    expect(spawn).toMatchObject({ vendor: 'claude', mode: 'autoedit' })

    f.testsDone()
    // T1 asked for what changed since T0.
    const t1 = f.log.find((e) => e.t === 'snapshot' && e.label === 'T1')
    expect(t1).toMatchObject({ diffFrom: 'c-T0' })
    expect(f.state.testFirst?.files).toEqual(TEST_FILES)
    expect(f.step('verify:red').status).toBe('running')

    f.red('fail')
    expect(f.step('verify:red').status).toBe('done')
    // Expected failures are no findings.
    expect(f.state.findings?.verify).toBeUndefined()
    expect(f.state.notes.some((n) => n.includes('fail before Implement'))).toBe(true)
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-red')).toBeDefined()

    f.snapshot('post-red', 'tree-tests')
    const rec = f.log.filter((e) => e.t === 'reconcile' && e.boundary === 'pre-implement').at(-1)
    // Implement's pre-implement check starts where the red check left the folder; the tests are the run's own.
    expect(rec).toMatchObject({ step: 'implement', input: { last: 'c-post-red', runStart: 'c-T0' } })
    f.reconcile('pre-implement')
    f.snapshot('S0', 'tree-tests')
    f.passPreflight('implement')
    f.ev('implement', { type: 'session', id: 'impl-session' })
    expect(spawnedSteps(f)).toEqual(['plan', 'tests', 'implement'])

    f.implementDone()
    const check = f.log.find((e) => e.t === 'testsCheck')
    expect(check).toMatchObject({ from: 'c-T1', to: 'c-S1', paths: TEST_FILES })
    expect(f.state.status).toBe('running')
    f.guard([])
    expect(f.state.testFirst?.guard).toBe('ok')
    expect(toRunSnapshot(f.state, 0).steps.tests.testFirst).toEqual({ files: TEST_FILES, guard: 'ok' })
    expect(f.step('verify:1').status).toBe('running')
    f.check([trusted('test')])
    f.round([result('test', 'pass')])
    f.snapshot('post-verify-1', 'tree-impl')
    f.reconcile('pre-review')
    f.passPreflight('review')
    // The reviewers' diff starts at the run's base, so they see the tests too.
    const reviewSpawn = f.log.find((e) => e.t === 'spawn' && e.step === 'review')
    expect(reviewSpawn?.t === 'spawn' ? promptDiffRange(f.state, reviewSpawn)?.from?.commit : '').toBe('c-T0')
  })

  it('makes the run branch in the Tests step, before T0', () => {
    const f = new TFlow({ review: false, critic: false, fix: false })
    f.state = { ...f.state, config: { ...f.state.config, branch: 'runBranch' } }
    f.toPlanGate()
    f.approve()
    f.reconcile('pre-implement')
    const req = f.req((r) => r.kind === 'branch', 'branch')
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'T0')).toBeUndefined()
    f.send({
      t: 'branch-result',
      req,
      branch: { name: 'dim/run-1', base: 'abc', previous: 'refs/heads/main' },
    })
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'T0')).toBeDefined()
    f.snapshot('T0', 'tree-base')
    f.agentPreflight('tests')
    f.testsDone()
    f.red('fail')
    f.snapshot('post-red', 'tree-tests')
    f.reconcile('pre-implement')
    // The branch exists: Implement does not make another.
    expect(f.findReq((r) => r.kind === 'branch')).toBeUndefined()
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'S0')).toBeDefined()
  })

  it('no failing command opens testsNotRed; Rewrite resumes the Tests step with why, Continue goes on', () => {
    const f = new TFlow({ review: false, critic: false, fix: false })
    f.toTestsRunning().testsDone().red('pass')
    const card = f.card('testsNotRed')
    expect(card.view.title).toBe('The new tests already pass')
    expect(card.view.payload).toMatchObject({ step: 'verify:red', ran: true, passed: ['test'] })
    expect(card.view.choices.map((c) => c.id)).toEqual(['rewrite', 'continue', 'stop'])
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-red')).toBeUndefined()

    f.choose('testsNotRed', 'rewrite')
    expect(f.step('tests')).toMatchObject({ status: 'running', attempt: 2 })
    expect(f.step('verify:red').status).toBe('queued')
    expect(f.state.testFirst?.rewrites).toBe(1)
    f.agentPreflight('tests')
    const resumed = f.log.filter((e) => e.t === 'spawn' && e.step === 'tests').at(-1)
    expect(resumed).toMatchObject({ launch: { resume: { sessionId: 'tests-session' } } })
    expect(resumed?.t === 'spawn' ? resumed.launch.continuation : '').toContain('do not fail yet')

    f.testsDone(TEST_FILES, 'tree-tests-2')
    expect(f.step('verify:red')).toMatchObject({ status: 'running', attempt: 2 })
    f.red('pass')
    f.choose('testsNotRed', 'continue')
    expect(f.state.notes).toContain('Continued although the new tests did not fail before Implement.')
    f.toImplementAfterTests()
    expect(spawnedSteps(f)).toEqual(['plan', 'tests', 'tests', 'implement'])
  })

  it('Auto rewrites once, then continues', () => {
    const f = new TFlow({ auto: true, review: false, critic: false, fix: false })
    f.toTestsRunning().testsDone().red('pass')
    // Auto took the default: Rewrite.
    expect(f.state.cards.some((c) => c.view.kind === 'testsNotRed')).toBe(false)
    expect(f.step('tests').attempt).toBe(2)
    f.agentPreflight('tests')
    f.testsDone(TEST_FILES, 'tree-tests-2')
    f.red('pass')
    // The second time Auto continues.
    expect(f.state.cards.some((c) => c.view.kind === 'testsNotRed')).toBe(false)
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-red')).toBeDefined()
  })

  it('Stop on testsNotRed stops the run', () => {
    const f = new TFlow({ review: false, critic: false, fix: false })
    f.toTestsRunning().testsDone().red('pass')
    f.choose('testsNotRed', 'stop')
    expect(f.state.stop).toBeDefined()
  })

  it('weakened tests are a [must] (source tests) that joins at R8 and blocks the Fix skip rule', () => {
    const f = new TFlow({ review: true, critic: false, fix: true, beforeFix: true, runAfter: [] })
    f.toTestsRunning().testsDone().red('fail').toImplementAfterTests().implementDone()
    f.guard([
      {
        id: 'w1',
        severity: 'must',
        title: '`test/version.test.ts` was weakened after the Tests step wrote it: 1 assertion removed',
        body: '',
      },
    ])
    expect(f.state.testFirst?.guard).toBe('weakened')
    expect(toRunSnapshot(f.state, 0).steps.tests.testFirst).toMatchObject({ guard: 'weakened', weakened: 1 })
    f.check([trusted('test')])
    f.round([result('test', 'pass')])
    f.snapshot('post-verify-1', 'tree-impl')
    f.toJoinAfterVerify('none')
    const gate = f.card('gate:beforeFix')
    expect(gate).toBeDefined()
    expect(f.state.findings?.list).toEqual([
      expect.objectContaining({ n: 1, severity: 'must', source: 'tests', id: 'w1' }),
    ])
  })

  it('Continue without the Tests step skips the red check; Implement runs as usual', () => {
    const f = new TFlow({ review: false, critic: false, fix: false })
    f.toTestsRunning()
    f.agentEv('tests', { type: 'error', fatal: true, message: 'boom', raw: '', category: 'auth_required' })
    f.agentExit('tests')
    expect(f.step('tests').status).toBe('failed')
    f.user({ kind: 'skip', step: 'tests' })
    expect(f.step('tests')).toMatchObject({ status: 'skipped', reason: 'user' })
    expect(f.step('verify:red')).toMatchObject({ status: 'skipped', reason: 'not needed' })
    f.reconcile('pre-implement')
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'S0')).toBeDefined()
  })

  it('a relaunch re-issues the post-red snapshot and the tests check', () => {
    const f = new TFlow({ review: false, critic: false, fix: false })
    f.toTestsRunning().testsDone().red('fail')
    f.send({ t: 'relaunch' })
    expect(f.findReq((r) => r.kind === 'snapshot' && r.label === 'post-red')).toBeDefined()

    const g = new TFlow({ review: false, critic: false, fix: false })
    g.toTestsRunning().testsDone().red('fail').toImplementAfterTests().implementDone()
    g.send({ t: 'relaunch' })
    expect(g.findReq((r) => r.kind === 'tests-check')).toBeDefined()
    g.guard([])
    expect(g.state.testFirst?.guard).toBe('ok')
  })

  it('Verify off: the red check is skipped with a note', () => {
    const f = new TFlow({ enabled: false, review: false, critic: false, fix: false })
    f.toTestsRunning().testsDone()
    expect(f.step('verify:red')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(f.state.notes.some((n) => n.includes('red check did not run'))).toBe(true)
    // No red round, so no post-red snapshot: Implement's reconcile starts from T1.
    const rec = f.log.filter((e) => e.t === 'reconcile' && e.boundary === 'pre-implement').at(-1)
    expect(rec).toMatchObject({ step: 'implement', input: { last: 'c-T1' } })
  })
})
