// Git reducer rows (reconciliation, branch prep, "Revert to S0", the plan-end guard;
// R4, R5, R6/R7, R10, P15, P21). One case per new transition, all through `reduce` with the shared harnesses.
import { describe, expect, it } from 'vitest'
import type { RunBranchInfo } from '@shared/run.ts'
import { planWroteGeneratedNote, reconcileInput } from '@core/supervisor/machine.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { needsRelaunch, projectFromLog } from '@core/supervisor/recovery.ts'
import type {
  PendingRequest,
  ReconcileBoundary,
  ReconcileCardInput,
  ReconcileResult,
  Reduction,
  RunConfig,
} from '@core/supervisor/types.ts'
import { Harness, PLAN_TEXT, failure, makeConfig } from '../supervisor/helpers.ts'
import { Flow, must } from '../supervisor/helpers.review.ts'

// ---- verdicts as the controller sends them (git-effects.ts engineReconcileResult shapes) ------------------------

const HEAD_MAIN = { ref: 'refs/heads/main', commit: 'a'.repeat(40) }
const HEAD_FEATURE = { ref: 'refs/heads/feature', commit: 'b'.repeat(40) }

function mergeBlock(): ReconcileCardInput {
  return {
    verdict: 'block',
    reasons: [
      {
        row: 'operation',
        severity: 'block',
        title: 'A git merge is in progress',
        detail: 'Finish or abort the merge, then recheck. The run waits until then.',
        actions: [
          {
            id: 'reconcile.operation.0',
            label: 'Copy "git merge --abort"',
            kind: 'shell_copy',
            command: 'git merge --abort',
            shell: 'powershell',
            reason: 'A git merge is in progress',
            recheck: 'folder.git',
          },
        ],
      },
    ],
    external: [],
    overlapping: [],
    choices: [
      { id: 'recheck', label: 'Recheck', primary: true },
      { id: 'stop', label: 'Stop' },
    ],
    notes: [],
  }
}

function switchChoice(): ReconcileCardInput {
  return {
    verdict: 'choice',
    reasons: [
      {
        row: 'ref-switched',
        severity: 'choice',
        title: 'The folder switched to feature',
        detail: 'The run started on main. Diffs compare snapshots, so the run can continue on feature.',
        actions: [],
      },
    ],
    external: [],
    overlapping: [],
    choices: [
      { id: 'continue-on-branch', label: 'Continue on feature', primary: true },
      { id: 'stop', label: 'Stop' },
      { id: 'recheck', label: 'Recheck' },
    ],
    defaultChoice: 'continue-on-branch',
    notes: [],
  }
}

function overlapChoice(paths: string[]): ReconcileCardInput {
  return {
    verdict: 'choice',
    reasons: [
      {
        row: 'external-overlap',
        severity: 'choice',
        title: `${paths.length} file the run changed was edited outside it`,
        detail: `${paths.join(', ')}. Include your edits, or restore the run's version (you can undo that).`,
        actions: [],
      },
    ],
    external: paths,
    overlapping: paths,
    choices: [
      { id: 'include-my-edits', label: 'Include my edits', primary: true },
      { id: 'restore-run-version', label: "Restore run's version" },
      { id: 'stop', label: 'Stop' },
    ],
    defaultChoice: 'include-my-edits',
    notes: [`User edited outside the run: ${paths.join(', ')}`],
  }
}

const card = (input: ReconcileCardInput, head = HEAD_FEATURE): ReconcileResult =>
  input.verdict === 'choice'
    ? { verdict: 'choice', card: input, head }
    : { verdict: 'block', card: input, head }

function answer(h: Harness, boundary: ReconcileBoundary, result: ReconcileResult): Reduction {
  const req = h.req((r) => r.kind === 'reconcile' && r.boundary === boundary, `reconcile ${boundary}`)
  return h.send({ t: 'reconcile-result', req, result })
}

function choose(h: Harness, kind: string, choiceId: string): Reduction {
  const c = h.state.cards.find((x) => x.view.kind === kind)
  expect(c, `open ${kind} card`).toBeDefined()
  return h.user({ kind: 'card', cardId: c?.view.id ?? '', choiceId })
}

const revertReq = (h: Harness): string => h.req((r) => r.kind === 'revert', 'revert')

function revertDone(h: Harness, restored: string[], deleted: string[] = []): Reduction {
  return h.send({
    t: 'revert-result',
    req: revertReq(h),
    outcome: { preRevert: 'c-pre-revert', restored, deleted, skipped: [] },
  })
}

/** Run-start with HEAD on main, Plan done (no gate decision yet). */
function planGate(config: RunConfig = makeConfig()): Harness {
  const h = new Harness(config)
  h.create()
  h.lock()
  h.preflight()
  h.send({
    t: 'snapshot-done',
    req: h.snapReq('run-start'),
    commit: 'c-run-start',
    tree: 'tree-base',
    head: HEAD_MAIN,
  })
  h.passPreflight('plan')
  h.ev('plan', { type: 'done', result: PLAN_TEXT })
  h.exit('plan')
  return h
}

const BRANCH: RunBranchInfo = {
  name: 'dim/20261008-add-a-version-flag',
  base: 'a'.repeat(40),
  previous: 'refs/heads/main',
}

describe('R5 pre-Implement reconcile', () => {
  it('asks with the run-start snapshot as `last`, the expected HEAD from run-start, no run start yet', () => {
    const h = planGate()
    expect(h.state.git?.expectedHead).toEqual(HEAD_MAIN)
    h.approve()
    const fx = h.fx('reconcile')
    expect(fx).toEqual([
      {
        t: 'reconcile',
        req: expect.any(String) as string,
        boundary: 'pre-implement',
        step: 'implement',
        input: { branchMode: 'none', expectedHead: HEAD_MAIN, last: 'c-run-start' },
      },
    ])
  })

  it('info: run notes, and the "N files changed during planning" chip on Implement (StepView.chip)', () => {
    const h = planGate()
    h.approve()
    answer(h, 'pre-implement', {
      verdict: 'info',
      notes: ['2 files changed during planning: Implement starts from the folder as it is now.'],
      promptNotes: [],
      chip: '2 files changed during planning',
      head: HEAD_MAIN,
    })
    expect(h.state.notes).toContain(
      '2 files changed during planning: Implement starts from the folder as it is now.',
    )
    expect(h.step('implement').chip).toBe('2 files changed during planning')
    expect(toRunSnapshot(h.state, 0).steps.implement.chip).toBe('2 files changed during planning')
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
  })

  it('choice (ref switched, branch none): card with its default; Implement waits; Continue → new HEAD, reconcile again', () => {
    const h = planGate()
    h.approve()
    answer(h, 'pre-implement', card(switchChoice()))
    const c = h.state.cards.find((x) => x.view.kind === 'reconcile')
    expect(c?.view).toMatchObject({
      title: 'The folder switched to feature',
      defaultChoice: 'continue-on-branch',
      blocking: true,
    })
    expect(c?.view.choices.map((x) => x.id)).toEqual(['continue-on-branch', 'stop', 'recheck'])
    expect(c?.view.choices.find((x) => x.id === 'stop')).toMatchObject({ label: 'Stop run', danger: true })
    expect(h.fx('snapshot')).toEqual([])
    expect(h.state).toMatchObject({ status: 'waiting', phase: 'needs-attention' })
    choose(h, 'reconcile', 'continue-on-branch')
    expect(h.state.git?.expectedHead).toEqual(HEAD_FEATURE)
    expect(h.state.notes).toContain('The run continues on feature.')
    expect(h.fx('reconcile')).toEqual([
      expect.objectContaining({
        boundary: 'pre-implement',
        input: expect.objectContaining({ expectedHead: HEAD_FEATURE }) as unknown,
      }),
    ])
    answer(h, 'pre-implement', { verdict: 'clean', head: HEAD_FEATURE })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
  })

  it('Auto takes a choice card default (logged), never a block card', () => {
    const cfg = makeConfig({ auto: true, gates: { afterPlan: false, beforeFix: false } })
    const a = planGate(cfg)
    answer(a, 'pre-implement', card(switchChoice()))
    expect(a.state.cards).toHaveLength(0)
    expect(a.state.notes.some((n) => n.startsWith('Auto:') && n.includes('Continue on feature'))).toBe(true)
    expect(a.fx('reconcile')).toHaveLength(1)

    const b = planGate(cfg)
    answer(b, 'pre-implement', card(mergeBlock(), HEAD_MAIN))
    const c = b.state.cards.find((x) => x.view.kind === 'reconcile')
    expect(c?.view.defaultChoice).toBeUndefined()
    expect(b.fx('reconcile')).toHaveLength(0)
    expect(b.state.status).toBe('waiting')
  })

  it('block (merge in progress): copyable abort in the payload; Recheck reconciles again; Stop cancels', () => {
    const h = planGate()
    h.approve()
    answer(h, 'pre-implement', card(mergeBlock(), HEAD_MAIN))
    const c = h.state.cards.find((x) => x.view.kind === 'reconcile')
    expect(c?.view.body).toContain('A git merge is in progress: Finish or abort the merge')
    expect(c?.view.payload).toMatchObject({
      boundary: 'pre-implement',
      step: 'implement',
      verdict: 'block',
      reasons: [{ row: 'operation', actions: [{ kind: 'shell_copy', command: 'git merge --abort' }] }],
    })
    choose(h, 'reconcile', 'recheck')
    expect(h.fx('reconcile')).toHaveLength(1)
    answer(h, 'pre-implement', card(mergeBlock(), HEAD_MAIN))
    choose(h, 'reconcile', 'stop')
    expect(h.state.status).toBe('cancelled')
    expect(h.state.cards).toHaveLength(0)
  })

  it('a relaunch leaves the card open and the launch parked on it', () => {
    const h = planGate()
    h.approve()
    answer(h, 'pre-implement', card(mergeBlock(), HEAD_MAIN))
    h.send({ t: 'relaunch' })
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['reconcile'])
    expect(h.step('implement')).toMatchObject({ status: 'waiting', reason: 'folder check' })
    choose(h, 'reconcile', 'recheck')
    expect(h.fx('reconcile')).toHaveLength(1)
  })

  it('while its launch waits on the card the step reads waiting (no active time), then running again', () => {
    const h = planGate()
    h.approve()
    expect(h.step('implement').status).toBe('running')
    h.tick(1000)
    answer(h, 'pre-implement', card(mergeBlock(), HEAD_MAIN))
    const parked = h.step('implement')
    expect(parked).toMatchObject({ status: 'waiting', reason: 'folder check' })
    expect(parked.activeSince).toBeUndefined()
    const active = parked.activeMs
    // The user takes a minute over the card: none of it is Implement's active time.
    h.tick(60_000)
    choose(h, 'reconcile', 'recheck')
    expect(h.step('implement').status).toBe('running')
    expect(h.step('implement').reason).toBeUndefined()
    expect(h.step('implement').activeMs).toBe(active)
    answer(h, 'pre-implement', { verdict: 'clean', head: HEAD_MAIN })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
  })
})

describe('R5 runBranch ⇒ create the branch after reconcile, before S0', () => {
  const runBranch = (): RunConfig => makeConfig({ branch: 'runBranch' })

  it('clean → `branch` effect → branch recorded (expected HEAD = the run branch) → S0; RunSnapshot.branch', () => {
    const h = planGate(runBranch())
    h.approve()
    expect(h.fx('reconcile')[0]?.input).toMatchObject({ branchMode: 'runBranch' })
    answer(h, 'pre-implement', { verdict: 'clean', head: HEAD_MAIN })
    expect(h.fx('branch')).toHaveLength(1)
    expect(h.fx('snapshot')).toEqual([])
    h.send({
      t: 'branch-result',
      req: h.req((r) => r.kind === 'branch'),
      branch: BRANCH,
      notes: [],
    })
    expect(h.state.branch).toEqual(BRANCH)
    expect(h.state.git?.expectedHead).toEqual({ ref: `refs/heads/${BRANCH.name}`, commit: BRANCH.base })
    expect(h.state.notes).toContain(`Working on the run branch ${BRANCH.name}.`)
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
    expect(toRunSnapshot(h.state, 0).branch).toEqual(BRANCH)
    // Later boundaries name the run branch.
    h.snapshot('S0', 'tree-base')
    expect(reconcileInput(h.state, 'pre-review').runBranch).toEqual(BRANCH)
  })

  it('blocked branch prep → block card (branchPrep); Recheck redoes reconcile then branch prep', () => {
    const h = planGate(runBranch())
    h.approve()
    answer(h, 'pre-implement', { verdict: 'clean', head: HEAD_MAIN })
    const blocked: ReconcileCardInput = {
      ...mergeBlock(),
      reasons: [
        {
          row: 'branch-unborn-head',
          severity: 'block',
          title: 'The repository has no commits yet',
          detail: 'A run branch starts at a commit. Commit once first, or run without a run branch.',
          actions: [],
        },
      ],
    }
    h.send({ t: 'branch-result', req: h.req((r) => r.kind === 'branch'), blocked })
    const c = h.state.cards.find((x) => x.view.kind === 'reconcile')
    expect(c?.view.title).toBe('The repository has no commits yet')
    expect(c?.view.payload).toMatchObject({ branchPrep: true, boundary: 'pre-implement' })
    expect(c?.view.body).toContain('The run branch could not be made.')
    expect(h.state.branch).toBeUndefined()
    choose(h, 'reconcile', 'recheck')
    answer(h, 'pre-implement', { verdict: 'clean', head: HEAD_MAIN })
    expect(h.fx('branch')).toHaveLength(1)
  })

  it('an unexpected git failure fails Implement (no retry), no snapshot', () => {
    const h = planGate(runBranch())
    h.approve()
    answer(h, 'pre-implement', { verdict: 'clean' })
    h.send({
      t: 'branch-result',
      req: h.req((r) => r.kind === 'branch'),
      failure: { ...failure('git_state'), message: 'fatal: bad object HEAD' },
    })
    expect(h.step('implement')).toMatchObject({ status: 'failed', reason: 'git_state' })
    expect(h.fx('snapshot')).toEqual([])
  })

  it('cancel at the plan gate: no branch effect, ever', () => {
    const h = planGate(runBranch())
    const c = h.state.cards.find((x) => x.view.kind === 'gate:afterPlan')
    h.user({ kind: 'card', cardId: c?.view.id ?? '', choiceId: 'cancel' })
    h.snapshot('stopped')
    expect(h.state.status).toBe('cancelled')
    expect(h.log.some((e) => e.t === 'branch')).toBe(false)
  })

  it('a branch made while the run was stopping is still recorded (the run end offers return / delete)', () => {
    const h = planGate(runBranch())
    h.approve()
    answer(h, 'pre-implement', { verdict: 'clean' })
    const req = h.req((r) => r.kind === 'branch')
    h.user({ kind: 'stop' })
    h.snapshot('stopped')
    expect(h.state.lock).toBe('held') // the branch request is outstanding
    h.send({ t: 'branch-result', req, branch: BRANCH, notes: [] })
    expect(h.state.branch).toEqual(BRANCH)
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.state.status).toBe('cancelled')
  })
})

describe('R4 plan-end guard', () => {
  function planWrote(o: { declined?: boolean; config?: RunConfig } = {}): Harness {
    const h = new Harness(o.config ?? makeConfig())
    h.toPlanRunning()
    h.ev('plan', { type: 'tool', id: 't1', name: 'Write', summary: 'notes.md', phase: 'start' })
    h.ev('plan', {
      type: 'tool',
      id: 't1',
      name: 'Write',
      summary: 'notes.md',
      phase: 'end',
      status: o.declined === true ? 'declined' : 'ok',
    })
    h.ev('plan', { type: 'done', result: PLAN_TEXT })
    h.exit('plan')
    return h
  }

  it('no write reported → no plan-end snapshot, the gate at once', () => {
    const h = new Harness().toPlanGate()
    expect(h.log.some((e) => e.t === 'snapshot' && e.label === 'plan-end')).toBe(false)
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
  })

  it('a declined write does not count', () => {
    const h = planWrote({ declined: true })
    expect(h.step('plan').writes).toBeUndefined()
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
  })

  it('write reported, tree = run-start → the gate (the difference, if any, is the user’s)', () => {
    const h = planWrote()
    expect(h.step('plan').writes).toEqual(['t1'])
    expect(h.state.cards).toHaveLength(0)
    expect(h.state.flow.planEnd).toBe('requested')
    expect(h.log.filter((e) => e.t === 'snapshot' && e.label === 'plan-end')).toEqual([
      expect.objectContaining({ label: 'plan-end', step: 'plan', diffFrom: 'c-run-start' }),
    ])
    h.snapshot('plan-end', 'tree-base')
    expect(h.state.flow.planEnd).toBe('done')
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
  })

  it('write reported, tree ≠ run-start → planMutated (no default, even in Auto); Keep → the gate', () => {
    const h = planWrote()
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('plan-end'),
      commit: 'c-plan-end',
      tree: 'tree-plan',
      changed: ['notes.md'],
    })
    const c = h.state.cards.find((x) => x.view.kind === 'planMutated')
    expect(c?.view).toMatchObject({
      title: 'Plan changed files',
      blocking: true,
      payload: { paths: ['notes.md'] },
    })
    expect(c?.view.defaultChoice).toBeUndefined()
    expect(c?.view.body).toContain('1 file changed while it ran: notes.md')
    expect(c?.view.choices.map((x) => x.label)).toEqual(["Revert Plan's changes", 'Keep'])
    expect(h.state.plan.decided).toBe(false)
    expect(h.state.phase).toBe('needs-attention')
    choose(h, 'planMutated', 'keep')
    expect(h.state.cards.map((x) => x.view.kind)).toEqual(['gate:afterPlan'])
    // pre-implement compares with plan-end (Plan's kept changes are not "changed during planning").
    h.approve()
    expect(h.fx('reconcile')[0]?.input.last).toBe('c-plan-end')

    const auto = planWrote({
      config: makeConfig({ auto: true, gates: { afterPlan: false, beforeFix: false } }),
    })
    auto.snapshot('plan-end', 'tree-plan')
    expect(auto.state.cards.map((x) => x.view.kind)).toEqual(['planMutated'])
    expect(auto.state.plan.decided).toBe(false)
    expect(auto.fx('reconcile')).toEqual([])
  })

  it('Revert Plan’s changes → revert to run-start for the paths Plan changed → the gate; undoable', () => {
    const h = planWrote()
    h.snapshot('plan-end', 'tree-plan')
    choose(h, 'planMutated', 'revert-plan')
    expect(h.state.flow.planEnd).toBe('reverting')
    expect(h.fx('revert')).toEqual([
      {
        t: 'revert',
        req: expect.any(String) as string,
        to: 'c-run-start',
        scope: { from: 'c-run-start', to: 'c-plan-end' },
        why: 'plan',
        token: 'revert-1',
      },
    ])
    expect(h.state.cards).toHaveLength(0)
    revertDone(h, ['notes.md'])
    expect(h.state.cards.map((x) => x.view.kind)).toEqual(['gate:afterPlan'])
    expect(h.state.notes).toContain("Reverted Plan's changes (1 file). You can undo this.")
    expect(h.state.git?.ownPaths).toEqual(['notes.md'])
    expect(toRunSnapshot(h.state, 0).revertUndo).toEqual({
      undoToken: 'revert-1',
      label: "Plan's changes",
      files: 1,
      at: h.now,
    })
    // pre-implement: the reverted path is Dim Factory's own write, not an external edit.
    h.approve()
    expect(h.fx('reconcile')[0]?.input).toMatchObject({ last: 'c-plan-end', ownPaths: ['notes.md'] })
    h.reconcile('pre-implement')
    h.snapshot('S0', 'tree-base')
    expect(h.state.git?.ownPaths).toBeUndefined()
  })

  it('only dependency or build output changed (an install during Plan) → no card, a note, the gate', () => {
    const h = planWrote()
    const changed = [
      'node_modules/.bin/tsc',
      'node_modules/.bin/tsc.cmd',
      'node_modules/.bin/vite',
      'node_modules/.bin/vite.cmd',
      '.venv/lib/site.py',
      'web/dist/index.js',
    ]
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('plan-end'),
      commit: 'c-plan-end',
      tree: 'tree-plan',
      changed,
    })
    expect(h.state.cards.map((x) => x.view.kind)).toEqual(['gate:afterPlan'])
    expect(h.state.flow.planEnd).toBe('done')
    expect(h.state.notes).toContain(planWroteGeneratedNote(changed))
    expect(planWroteGeneratedNote(changed)).toContain('node_modules, .venv, dist')
  })

  it('a real edit next to install output → the card names only the edit, and Revert touches only it', () => {
    const h = planWrote()
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('plan-end'),
      commit: 'c-plan-end',
      tree: 'tree-plan',
      changed: ['node_modules/.bin/vite', 'src/App.tsx'],
    })
    const c = h.state.cards.find((x) => x.view.kind === 'planMutated')
    expect(c?.view.payload).toMatchObject({ paths: ['src/App.tsx'] })
    expect(c?.view.body).toContain('1 file changed while it ran: src/App.tsx')
    choose(h, 'planMutated', 'revert-plan')
    expect(h.fx('revert')).toEqual([
      expect.objectContaining({ scope: { from: 'c-run-start', to: 'c-plan-end' }, paths: ['src/App.tsx'] }),
    ])
  })

  it('Plan spawns only after run-start, so its writes always reach the plan-end comparison', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight()
    h.passPreflight('plan')
    expect(h.step('plan').proc).toBeUndefined()
    h.snapshot('run-start', 'tree-base')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
    h.ev('plan', { type: 'tool', id: 't1', name: 'Bash', summary: 'touch x', phase: 'start' })
    h.ev('plan', { type: 'done', result: PLAN_TEXT })
    expect(h.state.flow.planEnd).toBe('requested')
    expect(h.fx('snapshot')).toEqual([
      expect.objectContaining({ label: 'plan-end', step: 'plan', diffFrom: 'c-run-start' }),
    ])
  })

  it('a run.json from an earlier build (Plan spawned while run-start was outstanding) waits for run-start', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight()
    // Earlier builds spawned Plan in parallel with run-start: let the launch through as they did.
    h.state = { ...h.state, flow: { ...h.state.flow, runStart: 'done' } }
    h.passPreflight('plan')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
    h.state = { ...h.state, flow: { ...h.state.flow, runStart: 'requested' } }
    h.ev('plan', { type: 'tool', id: 't1', name: 'Bash', summary: 'touch x', phase: 'start' })
    h.ev('plan', { type: 'done', result: PLAN_TEXT })
    expect(h.state.flow.planEnd).toBe('wait')
    expect(h.findReq((r) => r.kind === 'snapshot' && r.label === 'plan-end')).toBeUndefined()
    h.snapshot('run-start', 'tree-base')
    expect(h.state.flow.planEnd).toBe('requested')
  })

  it('an auto-answered write counts', () => {
    const h = new Harness().toPlanRunning()
    h.signal('plan', {
      type: 'auto-answered',
      requestId: 'q9',
      decision: 'allow',
      tool: 'Edit',
      why: 'allow-cache',
    })
    expect(h.step('plan').writes).toEqual(['auto:q9'])
  })

  it('projection: an open planMutated card keeps the plan undecided; a relaunch re-checks a lost plan-end', () => {
    const h = planWrote()
    const runJson = structuredClone(h.state)
    h.snapshot('plan-end', 'tree-plan')
    const opened = h.bodies('card')
    const envelopes = opened.map((body, i) => ({ runId: h.state.runId, seq: 100 + i, ts: h.now, body }))
    const s = projectFromLog(runJson, envelopes)
    expect(s.plan.decided).toBe(false)
    expect(s.cards.map((c) => c.view.kind)).toEqual(['planMutated'])

    const r = planWrote()
    r.send({ t: 'relaunch' })
    expect(r.fx('snapshot').map((e) => e.label)).toContain('plan-end')
    expect(r.state.flow.planEnd).toBe('requested')
  })
})

describe('P15 end-of-pass reconcile', () => {
  function implementDone(): Harness {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'done' })
    h.exit('implement')
    return h
  }

  it('asks with awaitEnd, deletion base = the pass start, run start = S0', () => {
    const h = implementDone()
    const fx = h.log.filter((e) => e.t === 'reconcile' && e.boundary === 'end-of-pass')
    expect(fx).toEqual([
      expect.objectContaining({
        step: 'implement',
        input: expect.objectContaining({ awaitEnd: true, deletionBase: 'c-S0', runStart: 'c-S0' }) as unknown,
      }),
    ])
    expect(fx[0]?.t === 'reconcile' && fx[0].input.last).toBeUndefined()
  })

  it('a block card holds the run after Implement; Recheck (held) → clean → Review / completion goes on', () => {
    const h = implementDone()
    answer(h, 'end-of-pass', card(mergeBlock(), HEAD_MAIN))
    expect(h.step('implement').endCheck).toBe('hold')
    h.snapshot('S1', 'tree-changed')
    // Held: not completed, no pre-review.
    expect(h.state.outcome).toBeUndefined()
    expect(h.state.boundary).toEqual({ name: 'post-implement', step: 'implement' })
    expect(h.state.status).toBe('waiting')
    choose(h, 'reconcile', 'recheck')
    const req = h.req((r) => r.kind === 'reconcile' && r.boundary === 'end-of-pass')
    expect(h.state.requests[req]).toMatchObject({ hold: true })
    expect(h.fx('reconcile')[0]?.input).toMatchObject({ last: 'c-S1', deletionBase: 'c-S0' })
    answer(h, 'end-of-pass', { verdict: 'clean', head: HEAD_MAIN })
    expect(h.step('implement').endCheck).toBeUndefined()
    expect(h.state.outcome).toBe('clean')
  })

  it('a relaunch with the hold and no card asks again', () => {
    const h = implementDone()
    answer(h, 'end-of-pass', card(mergeBlock(), HEAD_MAIN))
    h.snapshot('S1', 'tree-changed')
    choose(h, 'reconcile', 'recheck')
    h.send({ t: 'relaunch' })
    expect(h.fx('reconcile')).toEqual([
      expect.objectContaining({ boundary: 'end-of-pass', step: 'implement' }),
    ])
    expect(h.state.flow.hold).toBe('interrupted')
  })

  it('boot recovery relaunches a held end check that lost both its card and its request', () => {
    const h = implementDone()
    answer(h, 'end-of-pass', card(mergeBlock(), HEAD_MAIN))
    h.snapshot('S1', 'tree-changed')
    expect(needsRelaunch(h.state)).toBe(false) // the card is open: it waits for the user
    choose(h, 'reconcile', 'recheck')
    expect(needsRelaunch({ ...h.state, requests: {} })).toBe(true)
  })

  it('after the flow moved on, a card verdict becomes notes', () => {
    const h = implementDone()
    h.snapshot('S1', 'tree-changed')
    expect(h.state.outcome).toBe('clean')
    answer(h, 'end-of-pass', card(mergeBlock(), HEAD_MAIN))
    expect(h.state.cards).toHaveLength(0)
    expect(h.state.notes).toContain(
      'A git merge is in progress: Finish or abort the merge, then recheck. The run waits until then.',
    )
  })

  it('Fix: the end-of-pass card holds completion until answered', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    f.toFixSpawned()
    f.ev('fix', { type: 'done', result: 'ok' })
    f.exit('fix')
    answer(f, 'end-of-pass', card(switchChoice()))
    f.snapshot('S2', 'tree-fixed')
    expect(f.state.outcome).toBeUndefined()
    expect(f.state.boundary).toEqual({ name: 'post-fix', step: 'fix' })
    f.choose('reconcile', 'continue-on-branch')
    answer(f, 'end-of-pass', { verdict: 'clean', head: HEAD_FEATURE })
    expect(f.state.outcome).toBe('fixed')
  })
})

describe('R6/R7 pre-review and R10 pre-fix reconcile', () => {
  it('pre-review: a card holds Review ∥ Critic; Include my edits → notes (run + Fix) → both launch', () => {
    const f = new Flow().toS1()
    expect(f.fx('reconcile')[0]?.input).toMatchObject({ last: 'c-S1', runStart: 'c-S0' })
    answer(f, 'pre-review', card(overlapChoice(['src/a.ts'])))
    expect(f.findReq((r) => r.kind === 'preflight' && r.mode === 'passBoundary')).toBeUndefined()
    expect(f.step('review').status).toBe('queued')
    f.choose('reconcile', 'include-my-edits')
    expect(f.state.notes).toContain('User edited outside the run: src/a.ts')
    expect(f.state.findings?.notes).toEqual(['User edited outside the run: src/a.ts'])
    f.passPreflight('review')
    f.passPreflight('critic')
    expect(f.fx('spawn').map((e) => e.step)).toEqual(['review', 'critic'])
  })

  it('pre-review: Restore → revert to S1 for the overlap → reconcile(pre-review) again; Stop cancels', () => {
    const f = new Flow().toS1()
    answer(f, 'pre-review', card(overlapChoice(['src/a.ts'])))
    f.choose('reconcile', 'restore-run-version')
    expect(f.fx('revert')).toEqual([
      expect.objectContaining({ to: 'c-S1', paths: ['src/a.ts'], why: 'restore' }),
    ])
    expect(f.state.flow.review).toBe('reconcile')
    revertDone(f, ['src/a.ts'])
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-review' })])
    answer(f, 'pre-review', card(overlapChoice(['src/b.ts'])))
    f.choose('reconcile', 'stop')
    expect(f.state.status).toBe('cancelled')
    expect(f.step('review').status).toBe('cancelled')
  })

  it('pre-review: a relaunch keeps the open card and does not ask again', () => {
    const f = new Flow().toS1()
    answer(f, 'pre-review', card(overlapChoice(['src/a.ts'])))
    f.send({ t: 'relaunch' })
    expect(f.fx('reconcile')).toEqual([])
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['reconcile'])
  })

  it('pre-review info: run notes and the Fix prompt’s notes', () => {
    const f = new Flow().toS1()
    answer(f, 'pre-review', {
      verdict: 'info',
      notes: ['1 file edited outside the run: README.md. The next step is told about them.'],
      promptNotes: ['User edited outside the run: README.md'],
    })
    expect(f.state.notes).toContain(
      '1 file edited outside the run: README.md. The next step is told about them.',
    )
    expect(f.state.findings?.notes).toEqual(['User edited outside the run: README.md'])
  })

  it('pre-fix overlap: Restore run’s version → revert to post-review for the overlapping paths → reconcile again', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    expect(f.fx('reconcile')[0]?.input).toMatchObject({ last: 'c-post-review', runStart: 'c-S0' })
    answer(f, 'pre-fix', card(overlapChoice(['src/version.ts'])))
    expect(f.step('fix').launch?.card).toBeDefined()
    f.choose('reconcile', 'restore-run-version')
    expect(f.fx('revert')).toEqual([
      expect.objectContaining({ to: 'c-post-review', paths: ['src/version.ts'], why: 'restore' }),
    ])
    expect(f.state.requests[revertReq(f)]).toMatchObject({ boundary: 'pre-fix', step: 'fix' })
    revertDone(f, ['src/version.ts'])
    expect(f.state.notes).toContain("Restored the run's version of src/version.ts.")
    expect(f.fx('reconcile')).toEqual([
      expect.objectContaining({
        boundary: 'pre-fix',
        input: expect.objectContaining({ ownPaths: ['src/version.ts'] }) as unknown,
      }),
    ])
    answer(f, 'pre-fix', { verdict: 'clean' })
    expect(f.fx('snapshot')).toEqual([expect.objectContaining({ label: 'fix-start' })])
    // The undo is offered (RunSnapshot.revertUndo).
    expect(toRunSnapshot(f.state, 0).revertUndo).toMatchObject({
      label: 'your edits outside the run',
      files: 1,
    })
  })

  it('pre-fix overlap: Include my edits → the notes reach the Fix prompt', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    f.choose('gate:beforeFix', 'continue')
    answer(f, 'pre-fix', card(overlapChoice(['src/version.ts'])))
    f.choose('reconcile', 'include-my-edits')
    f.snapshot('fix-start', 'tree-changed')
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.notes).toEqual(['User edited outside the run: src/version.ts'])
  })
})

describe('P21 revert-then-fresh and the retryPartial card', () => {
  function failedNoSession(): Harness {
    const h = new Harness().toImplementRunning({ session: false })
    h.ev('implement', { type: 'error', message: 'boom', raw: '', fatal: true, category: 'auth_expired' })
    h.exit('implement', { code: 1 })
    h.snapshot('stopped', 'tree-changed')
    return h
  }

  it('retryPartial [Revert partial then fresh] → revert to S0 → fresh spawn; a note and an undo', () => {
    const h = failedNoSession()
    h.user({ kind: 'retry', step: 'implement' })
    h.snapshot('pre-retry', 'tree-changed')
    choose(h, 'retryPartial', 'revert-then-fresh')
    expect(h.fx('revert')).toEqual([expect.objectContaining({ to: 'c-S0', why: 'retry' })])
    expect(h.fx('revert')[0]?.paths).toBeUndefined()
    expect(h.fx('spawn')).toEqual([])
    revertDone(h, ['src/a.ts'], ['src/new.ts'])
    expect(h.state.notes).toContain("Reverted Implement's partial changes (2 files) before the fresh retry.")
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toEqual({ fresh: {} })
    expect(toRunSnapshot(h.state, 0).revertUndo).toMatchObject({
      label: "Implement's partial changes",
      files: 2,
    })
  })

  it('a failed revert fails the pass again, without a retry', () => {
    const h = failedNoSession()
    h.user({ kind: 'retry', step: 'implement', strategy: 'revert-then-fresh' })
    h.snapshot('pre-retry', 'tree-changed')
    h.send({
      t: 'revert-result',
      req: revertReq(h),
      failure: { ...failure('snapshot_failed'), message: 'disk is busy' },
    })
    expect(h.step('implement')).toMatchObject({ status: 'failed', reason: 'snapshot_failed' })
    expect(h.step('implement').failure?.message).toContain(
      'Reverting the partial changes failed: disk is busy',
    )
  })

  it('read-only passes have nothing to revert: fresh', () => {
    const f = new Flow().toReviewRunning()
    f.ev('review', { type: 'error', message: 'x', raw: '', fatal: true, category: 'auth_required' })
    f.exit('review', { code: 1 })
    f.user({ kind: 'retry', step: 'review', strategy: 'revert-then-fresh' })
    expect(f.fx('revert')).toEqual([])
    f.passPreflight('review')
    expect(f.fx('spawn')[0]?.launch.fresh).toBeDefined()
  })
})

describe('diff.revert / diff.undoRevert', () => {
  const gate = (): Flow => new Flow().toJoin(['ok', [must('r1')]])

  it('refused while a process holds the folder; nothing outstanding → allowed', () => {
    const h = new Harness().toImplementRunning()
    h.user({ kind: 'revert' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'FOLDER_BUSY' })])
    const q = new Harness().toPlanGate()
    q.user({ kind: 'revert' })
    expect(q.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
  })

  it('at the gate before Fix: revert → record + Fix note + gate refreshed; undo takes the note back', () => {
    const f = gate()
    f.user({ kind: 'revert', seg: 'implement', paths: ['src/version.ts'] })
    expect(f.fx('revert')).toEqual([
      {
        t: 'revert',
        req: expect.any(String) as string,
        to: 'c-S0',
        paths: ['src/version.ts'],
        scope: { from: 'c-S0', to: 'c-S1' },
        why: 'user',
        token: 'revert-1',
      },
    ])
    // A second revert while one runs is refused.
    f.user({ kind: 'revert' })
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'FOLDER_BUSY' })])
    revertDone(f, ['src/version.ts'])
    expect(f.state.findings?.notes).toEqual(['User reverted after review: src/version.ts'])
    const gateCard = f.bodies('card').at(-1)
    expect(gateCard).toMatchObject({ state: 'open', card: { kind: 'gate:beforeFix' } })
    expect(gateCard?.card.body).toContain('Note: User reverted after review: src/version.ts')
    expect(f.state.git?.reverts?.[0]).toMatchObject({
      token: 'revert-1',
      why: 'user',
      paths: ['src/version.ts'],
      note: 'User reverted after review: src/version.ts',
    })
    // diff.revert reverts are not the card undo.
    expect(toRunSnapshot(f.state, 0).revertUndo).toBeUndefined()
    f.user({ kind: 'undo-revert', token: 'revert-1' })
    expect(f.fx('revert')).toEqual([
      expect.objectContaining({
        to: 'c-pre-revert',
        paths: ['src/version.ts'],
        why: 'undo',
        token: 'revert-1',
      }),
    ])
    revertDone(f, ['src/version.ts'])
    expect(f.state.findings?.notes).toEqual([])
    expect(f.state.git?.reverts?.[0]?.undone).toBe(true)
    f.user({ kind: 'undo-revert', token: 'revert-1' })
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    f.user({ kind: 'undo-revert', token: 'nope' })
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
  })

  it('Continue at the gate while a revert runs: R10 waits for it', () => {
    const f = gate()
    f.user({ kind: 'revert' })
    expect(f.fx('revert')[0]).toMatchObject({ scope: { from: 'c-S0' } })
    f.choose('gate:beforeFix', 'continue')
    expect(f.fx('reconcile')).toEqual([])
    revertDone(f, ['src/a.ts'])
    expect(f.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-fix' })])
    // The note made it into the Fix prompt.
    f.reconcile('pre-fix')
    f.snapshot('fix-start')
    f.passPreflight('fix')
    expect(f.fx('spawn')[0]?.launch.notes).toEqual(['User reverted after review: src/a.ts'])
  })

  it('the fix segment reverts to F0; a stopped run reverts the combined range to the latest snapshot', () => {
    const f = gate()
    f.user({ kind: 'revert', seg: 'fix' })
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
    const h = new Harness().toImplementRunning()
    h.user({ kind: 'stop' })
    h.exit('implement', { code: 1 })
    h.snapshot('stopped', 'tree-changed')
    h.user({ kind: 'revert' })
    // Both ends explicit (the shadow's latest ref may be a `pre-revert`): S0..the run's last result snapshot.
    expect(h.fx('revert')).toEqual([
      expect.objectContaining({ to: 'c-S0', scope: { from: 'c-S0', to: 'c-stopped' }, why: 'user' }),
    ])
  })

  it('state stays plain JSON through reverts and cards', () => {
    const f = gate()
    f.user({ kind: 'revert' })
    revertDone(f, ['a'])
    expect(JSON.parse(JSON.stringify(f.state))).toStrictEqual(f.state)
  })
})

describe('reconcileInput', () => {
  it('pre-fix compares with post-review; own paths come along until the next boundary snapshot', () => {
    const f = new Flow().toJoin(['ok', [must('r1')]])
    const input = reconcileInput(f.state, 'pre-fix', 'fix')
    expect(input).toEqual({ branchMode: 'none', last: 'c-post-review', runStart: 'c-S0' })
    const pending: PendingRequest[] = Object.values(f.state.requests)
    expect(pending).toEqual([])
  })
})
