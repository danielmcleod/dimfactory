// Engine: an isolated run's prepare (Prepare steps 1 to 5; verify:0;
// isolation.verifyReady; R2 isolated, R5 "await prepare", R13 Stop; trust: Auto never installs
// without a `deps` grant). One case per row or branch, through `reduce`.
import { describe, expect, it } from 'vitest'
import { DEPS_CHOICE, VERIFY_ENV_CHOICE } from '@core/supervisor/cards.ts'
import { PREPARE_WAIT_REASON, uncommittedNote } from '@core/supervisor/machine.ts'
import { result, trusted, untrusted, verifyMust } from '../../verify/machine-helpers.ts'
import { PLAN_TEXT } from '../../supervisor/helpers.ts'
import { IFlow, PNPM, install } from './helpers.ts'

const rows = (h: IFlow): Record<string, string> =>
  Object.fromEntries((h.state.isolation?.rows ?? []).map((r) => [r.id, r.status]))

describe('R2 isolated: prepare steps 1 and 2 first', () => {
  it('after preflight only the setup stage runs: no run-start, no Plan', () => {
    const h = new IFlow()
    h.create()
    h.lock()
    h.preflight()
    expect(h.step('prepare')).toMatchObject({ status: 'running', attempt: 1 })
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'setup' })])
    expect(h.fx('snapshot')).toHaveLength(0)
    expect(h.step('plan').status).toBe('queued')
    expect(rows(h)).toMatchObject({ worktree: 'running', copy: 'queued', deps: 'queued' })
  })

  it('setup → run-start (in the worktree) ∥ Plan launch ∥ the deps stage; the uncommitted changes are noted', () => {
    const h = new IFlow()
    h.create()
    h.lock()
    h.preflight()
    h.setup({ uncommitted: 3, copied: 2 })
    expect(h.state.isolation?.worktree?.branch).toBe('dim/20261005-add-a-version-flag-abcd')
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'run-start' })])
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'rest' })])
    expect(h.step('plan').status).toBe('running')
    expect(h.fx('spawn')).toHaveLength(0)
    expect(h.state.notes).toContain(uncommittedNote(3))
    expect(uncommittedNote(3)).toBe(
      '3 uncommitted changes not included: the isolated run starts from the last commit.',
    )
    expect(rows(h)).toMatchObject({ worktree: 'done', copy: 'done', deps: 'running' })
    h.snapshot('run-start', 'tree-base')
    h.passPreflight('plan')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
  })

  it('no copy-in globs: the copy row is skipped', () => {
    const h = new IFlow()
    h.create()
    h.lock()
    h.preflight()
    h.setup()
    expect(h.state.isolation?.rows.find((r) => r.id === 'copy')).toMatchObject({
      status: 'skipped',
      detail: 'No files to copy.',
    })
  })

  it('a worktree that cannot be made fails prepare (worktree_failed) with a snag; Resume runs setup again', () => {
    const h = new IFlow()
    h.create()
    h.lock()
    h.preflight()
    h.send({
      t: 'prepare-result',
      req: h.prepReq('setup'),
      ok: false,
      failure: { category: 'worktree_failed', message: 'branch exists', raw: '', classifiedBy: 'app' },
    })
    expect(h.step('prepare')).toMatchObject({ status: 'failed', reason: 'worktree_failed' })
    expect(h.bodies('snag')).toHaveLength(1)
    expect(h.state.status).toBe('failed')
    expect(h.fx('snapshot')).toHaveLength(0)
    h.user({ kind: 'resume' })
    expect(h.step('prepare')).toMatchObject({ status: 'running' })
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'setup' })])
    expect(h.state.failure).toBeUndefined()
  })

  it('a worktree reported after Stop is still recorded (never lost, never deleted)', () => {
    const h = new IFlow()
    h.create()
    h.lock()
    h.preflight()
    const req = h.prepReq('setup')
    h.user({ kind: 'stop' })
    h.send({
      t: 'prepare-result',
      req,
      ok: true,
      worktree: { path: 'C:\\home\\worktrees\\x', branch: 'b', base: 'c0', rel: '' },
    })
    expect(h.state.isolation?.worktree?.path).toBe('C:\\home\\worktrees\\x')
    expect(h.state.status).toBe('cancelled')
  })
})

describe('Implement waits for prepare', () => {
  it('the plan is approved while deps run: preparing, no reconcile until prepare is done', () => {
    const h = new IFlow().toPlanGate()
    h.approve()
    expect(h.state.phase).toBe('preparing')
    expect(h.fx('reconcile')).toHaveLength(0)
    h.deps(null)
    expect(h.step('prepare').status).toBe('done')
    expect(h.state.flow.prepared).toBe('all')
    expect(h.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-implement' })])
  })

  it('an isolated run never makes a run branch in the folder', () => {
    const h = new IFlow()
    h.state = { ...h.state, config: { ...h.state.config, branch: 'runBranch' } }
    h.toPlanGate()
    h.approve()
    h.finishPrepare()
    h.reconcile()
    expect(h.fx('branch')).toHaveLength(0)
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
  })
})

describe('step 3: deps', () => {
  it('nothing to install: the row is skipped and prepare is done (verify off)', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(null)
    expect(rows(h)).toMatchObject({ deps: 'skipped', baseline: 'skipped', ready: 'skipped' })
    expect(h.step('prepare').status).toBe('done')
  })

  it('install off: the deps row is skipped from the start and no deps stage runs', () => {
    const h = new IFlow({ install: 'never' })
    expect(rows(h)).toMatchObject({ deps: 'skipped' })
    h.create()
    h.lock()
    h.preflight()
    h.setup()
    expect(h.fx('prepare')).toHaveLength(0)
    expect(h.step('prepare').status).toBe('done')
  })

  it('a trusted command installs at once; a pass finishes the row', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'install', deps: PNPM })])
    expect(h.state.cards).toHaveLength(0)
    h.installed(install('pass'))
    expect(rows(h)).toMatchObject({ deps: 'done' })
    expect(h.step('prepare').status).toBe('done')
  })

  it('untrusted (install ask): depsConsent; [Install] writes the deps grant, then installs', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'untrusted', { body: 'file pnpm-lock.yaml sha256 bb' })
    const card = h.cardOf('depsConsent')
    expect(card.view.defaultChoice).toBe(DEPS_CHOICE.skipInstall)
    expect(card.view.choices.map((c) => c.id)).toEqual(['install', 'edit-command', 'skip-install'])
    expect(card.view.payload).toMatchObject({
      command: 'pnpm install --frozen-lockfile',
      lockfile: 'pnpm-lock.yaml',
    })
    expect(h.step('prepare')).toMatchObject({ status: 'waiting', reason: PREPARE_WAIT_REASON.consent })
    h.choose('depsConsent', DEPS_CHOICE.install)
    expect(h.fx('trustGrant')).toEqual([
      expect.objectContaining({
        command: {
          kind: 'deps',
          argv: ['pnpm', 'install', '--frozen-lockfile'],
          cwdRel: '.',
          body: 'file pnpm-lock.yaml sha256 bb',
        },
      }),
    ])
    expect(h.fx('prepare')).toHaveLength(0)
    const req = h.req((r) => r.kind === 'deps-grant')
    h.send({ t: 'trust-grant-result', req, ok: true })
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'install' })])
    h.installed()
    expect(h.step('prepare').status).toBe('done')
  })

  it('Auto never installs without a grant: depsConsent takes Skip install, with a note', () => {
    const h = new IFlow({ auto: true }).toPlanRunning()
    h.deps(PNPM, 'untrusted')
    expect(h.state.cards).toHaveLength(0)
    expect(h.log.some((e) => e.t === 'trustGrant')).toBe(false)
    expect(h.log.some((e) => e.t === 'prepare' && e.stage === 'install')).toBe(false)
    expect(rows(h)).toMatchObject({ deps: 'skipped' })
    expect(h.state.notes).toContain('Auto: "Install dependencies in the isolated copy?" → Skip install')
    expect(h.step('prepare').status).toBe('done')
  })

  it('[Edit command] decides again with the typed command; shell syntax is refused and the card stays', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'untrusted')
    h.choose('depsConsent', DEPS_CHOICE.editCommand, 'npm ci && rm -rf /')
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    expect(h.cardOf('depsConsent')).toBeDefined()
    h.choose('depsConsent', DEPS_CHOICE.editCommand, 'npm ci')
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'rest', command: 'npm ci' })])
    expect(h.state.isolation?.deps?.edited).toBe('npm ci')
  })

  it('[Skip install] goes on without dependencies, with a note', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'untrusted')
    h.choose('depsConsent', DEPS_CHOICE.skipInstall)
    expect(rows(h)).toMatchObject({ deps: 'skipped' })
    expect(h.state.notes.some((n) => n.includes('no installed dependencies'))).toBe(true)
  })

  it('a failed install opens depsFailed [Retry] [Edit command] [Skip install] [Cancel]; Retry installs again', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    h.installed(install('fail', { reason: 'pnpm exited with 1' }))
    const card = h.cardOf('depsFailed')
    expect(card.view.choices.map((c) => c.id)).toEqual(['retry', 'edit-command', 'skip-install', 'cancel'])
    expect(card.view.payload).toMatchObject({ exitCode: 1, excerpt: 'ERR_PNPM_LOCKFILE' })
    expect(h.step('prepare')).toMatchObject({ status: 'waiting', reason: PREPARE_WAIT_REASON.depsFailed })
    h.choose('depsFailed', DEPS_CHOICE.retry)
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'install' })])
    h.installed()
    expect(h.step('prepare').status).toBe('done')
  })

  it('depsFailed [Cancel] stops the run', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    h.installed(install('env', { reason: 'pnpm not found' }))
    h.choose('depsFailed', DEPS_CHOICE.cancel)
    expect(h.state.status).toBe('cancelled')
  })

  it('a grant gone right before the spawn (skipped-untrusted) asks for consent again', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    h.installed(install('skipped-untrusted', { reason: 'the lockfile changed' }))
    expect(h.cardOf('depsConsent').view.body).toContain('the lockfile changed')
  })

  it('a command trust cannot cover (invalid) opens depsFailed, never consent', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'invalid')
    expect(h.cardOf('depsFailed')).toBeDefined()
    expect(h.state.cards.some((c) => c.view.kind === 'depsConsent')).toBe(false)
  })

  it('Stop during the install cancels it (prepareStop) and the stopped snapshot waits for it to end', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    const req = h.prepReq('install')
    // Plan exits first (Stop interrupts it).
    h.user({ kind: 'stop' })
    expect(h.fx('prepareStop')).toEqual([{ t: 'prepareStop', req }])
    h.exit('plan', { code: null })
    expect(h.state.phase).toBe('stopping')
    expect(h.findReq((r) => r.kind === 'snapshot' && r.label === 'stopped')).toBeUndefined()
    h.send({ t: 'prepare-result', req, ok: true, install: install('skipped', { reason: 'Stopped' }) })
    expect(h.findReq((r) => r.kind === 'snapshot' && r.label === 'stopped')).toBeDefined()
  })

  it('a relaunch during the install pauses prepare; Resume installs again', () => {
    const h = new IFlow().toPlanRunning()
    h.deps(PNPM, 'trusted')
    h.send({ t: 'relaunch' })
    expect(h.step('prepare')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    h.user({ kind: 'resume' })
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'install' })])
  })

  it("Auto takes depsFailed's default too (Skip install), so an Auto run is not blocked", () => {
    const h = new IFlow({ auto: true }).toPlanRunning()
    h.deps(PNPM, 'trusted')
    h.installed(install('fail'))
    expect(h.state.cards).toHaveLength(0)
    expect(rows(h)).toMatchObject({ deps: 'skipped' })
  })
})

describe('step 4: the verify:0 baseline', () => {
  it('after deps: a verify round of its own in the worktree; its results are the baseline map, never findings', () => {
    const h = new IFlow({ enabled: true, baseline: true }).toPlanRunning()
    expect(h.state.isolation?.rows.find((r) => r.id === 'baseline')?.status).toBe('queued')
    h.deps(null)
    expect(h.fx('verifyCheck')).toEqual([expect.objectContaining({ step: 'verify:0' })])
    h.check([trusted('test'), trusted('lint')], 'verify:0')
    h.round([result('test', 'fail'), result('lint', 'pass')], [], 'verify:0')
    expect(h.state.isolation?.baseline).toEqual({ test: 'fail', lint: 'pass' })
    expect(h.fx('writeBaseline')).toEqual([{ t: 'writeBaseline', baseline: { test: 'fail', lint: 'pass' } }])
    expect(h.state.findings?.verify).toBeUndefined()
    expect(h.step('verify:0').status).toBe('done')
    expect(h.state.notes.some((n) => n.startsWith('Already failing before this run: test.'))).toBe(true)
    // Step 5 follows.
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'ready' })])
  })

  it('an untrusted command asks (non-Auto) with the baseline named on its trust card', () => {
    const h = new IFlow({ enabled: true, baseline: true }).toPlanRunning()
    h.deps(null)
    h.check([untrusted('test')], 'verify:0')
    const card = h.cardOf('trust')
    expect(card.view.payload).toMatchObject({ step: 'verify:0' })
    expect(card.view.body).toContain('(the baseline)')
  })

  it('an environment failure is recorded as env (no verifyEnv card for the baseline)', () => {
    const h = new IFlow({ enabled: true, baseline: true }).toPlanRunning()
    h.deps(null)
    h.check([trusted('test')], 'verify:0')
    h.round([result('test', 'env')], [], 'verify:0')
    expect(h.state.isolation?.baseline).toEqual({ test: 'env' })
    expect(h.state.cards.some((c) => c.view.kind === 'verifyEnv')).toBe(false)
  })

  it('a pre-existing failure is a [should]: it does not block the skip rule (clean, not findings-open)', () => {
    const h = new IFlow({ enabled: true, baseline: true, review: false, critic: false, fix: false })
    toBaseline(h, [result('test', 'fail')])
    toImplementEnd(h)
    h.check([trusted('test')])
    h.round([result('test', 'fail')], [{ ...verifyMust('test'), severity: 'should', flags: ['preexisting'] }])
    h.snapshot('post-verify-1', 'tree-changed')
    expect(h.state.outcome).toBe('clean')
    expect(h.step('finalize').status).toBe('running')
  })

  it('verify:2: a command already failing before the run never makes the run verify-failed', () => {
    const h = new IFlow({ enabled: true, baseline: true, review: false, critic: false, fix: true })
    toBaseline(h, [result('test', 'fail'), result('lint', 'pass')])
    toImplementEnd(h)
    // verify:1: the pre-existing test failure ([should]) and a new lint failure ([must]) → Fix runs.
    h.check([trusted('test'), trusted('lint')])
    h.round(
      [result('test', 'fail'), result('lint', 'fail')],
      [verifyMust('lint'), { ...verifyMust('test'), severity: 'should', flags: ['preexisting'] }],
    )
    h.snapshot('post-verify-1', 'tree-changed')
    h.choose('gate:beforeFix', 'continue')
    h.reconcile('pre-fix')
    h.snapshot('fix-start', 'tree-changed')
    h.passPreflight('fix')
    h.ev('fix', { type: 'done', result: 'F1 fixed' })
    h.exit('fix')
    h.reconcile('end-of-pass')
    h.snapshot('S2', 'tree-fixed')
    h.check([trusted('test'), trusted('lint')], 'verify:2')
    h.round([result('test', 'fail'), result('lint', 'pass')], [], 'verify:2')
    expect(h.state.outcome).toBe('fixed')
    expect(h.state.notes).toContain('test still fails, as it already did before this run.')
  })
})

/** Prepare with nothing to install and a baseline round with `results` (all trusted), the worktree ready. */
function toBaseline(h: IFlow, results: ReturnType<typeof result>[]): void {
  h.toPlanRunning()
  h.deps(null)
  h.check(
    results.map((r) => trusted(r.name)),
    'verify:0',
  )
  h.round(results, [], 'verify:0')
  h.ready()
  expect(h.step('prepare').status).toBe('done')
}

/** Plan → gate → R5 → Implement changes files → S1 (verify:1's trust check is asked for). */
function toImplementEnd(h: IFlow): void {
  h.ev('plan', { type: 'session', id: 'plan-session' })
  h.ev('plan', { type: 'done', result: PLAN_TEXT })
  h.exit('plan')
  h.approve()
  h.reconcile()
  h.snapshot('S0', 'tree-base')
  h.passPreflight('implement')
  h.ev('implement', { type: 'session', id: 'impl-session' })
  h.ev('implement', { type: 'done', result: 'implemented' })
  h.exit('implement')
  h.reconcile('end-of-pass')
  h.snapshot('S1', 'tree-changed')
}

describe('step 5: isolation.verifyReady', () => {
  it('a program missing in the worktree opens verifyEnv before Implement; Retry checks again', () => {
    const h = new IFlow({ enabled: true }).toPlanRunning()
    h.deps(null)
    h.ready([{ name: 'test', argv: ['vitest', 'run'], reason: 'vitest was not found in the isolated copy' }])
    const card = h.cardOf('verifyEnv')
    expect(card.view.payload).toMatchObject({ step: 'prepare' })
    expect(card.view.title).toBe('The test check cannot run in the isolated copy')
    expect(h.step('prepare')).toMatchObject({ status: 'waiting', reason: PREPARE_WAIT_REASON.env })
    h.choose('verifyEnv', VERIFY_ENV_CHOICE.retry)
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'ready' })])
    h.ready()
    expect(h.step('prepare').status).toBe('done')
  })

  it('[Skip verify] goes on to Implement', () => {
    const h = new IFlow({ enabled: true }).toPlanRunning()
    h.deps(null)
    h.ready([{ name: 'test', argv: ['vitest'] }])
    h.choose('verifyEnv', VERIFY_ENV_CHOICE.skipVerify)
    expect(h.step('prepare').status).toBe('done')
    expect(h.state.flow.prepared).toBe('all')
  })
})
