// Review fixes in the reducer ("Revert to S0", branch prep; P21, R5):
// Revert all ends at the run's last result snapshot (never a `pre-revert`), an undo checks what the revert
// wrote and is itself undoable, reverts are recorded before any file is written (a relaunch keeps their Undo),
// revert-then-fresh reverts only what the failed attempt changed, a later pass retires a card revert's Undo, and the
// run branch is recorded before its ref writes (settled on relaunch and at the next branch prep).
import { describe, expect, it } from 'vitest'
import type { RunBranchInfo } from '@shared/run.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { CHANGED_PATHS_MAX } from '@core/supervisor/machine.ts'
import type { ReconcileCardInput, Reduction, RunConfig } from '@core/supervisor/types.ts'
import { Harness, PLAN_TEXT, failure, makeConfig } from '../supervisor/helpers.ts'

const HEAD_MAIN = { ref: 'refs/heads/main', commit: 'a'.repeat(40) }

const revertReq = (h: Harness): string => h.req((r) => r.kind === 'revert', 'revert')

function started(h: Harness, paths: string[], preRevert = 'c-pre-revert'): Reduction {
  return h.send({ t: 'revert-started', req: revertReq(h), preRevert, paths })
}

function revertDone(
  h: Harness,
  restored: string[],
  deleted: string[] = [],
  preRevert = 'c-pre-revert',
): Reduction {
  return h.send({
    t: 'revert-result',
    req: revertReq(h),
    outcome: { preRevert, restored, deleted, skipped: [] },
  })
}

function choose(h: Harness, kind: string, choiceId: string): Reduction {
  const c = h.state.cards.find((x) => x.view.kind === kind)
  expect(c, `open ${kind} card`).toBeDefined()
  return h.user({ kind: 'card', cardId: c?.view.id ?? '', choiceId })
}

/** Implement stopped by the user after S0; the `stopped` snapshot is the run's last result snapshot. */
function stoppedRun(): Harness {
  const h = new Harness().toImplementRunning()
  h.user({ kind: 'stop' })
  h.exit('implement', { code: 1 })
  h.snapshot('stopped', 'tree-changed')
  return h
}

/** Run-start (HEAD on main) → Plan reports a write → plan-end differs → planMutated open. */
function planMutated(config: RunConfig = makeConfig()): Harness {
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
  h.ev('plan', { type: 'tool', id: 't1', name: 'Write', summary: 'notes.md', phase: 'start' })
  h.ev('plan', { type: 'tool', id: 't1', name: 'Write', summary: 'notes.md', phase: 'end', status: 'ok' })
  h.ev('plan', { type: 'done', result: PLAN_TEXT })
  h.exit('plan')
  h.snapshot('plan-end', 'tree-plan')
  expect(h.state.cards.map((c) => c.view.kind)).toEqual(['planMutated'])
  return h
}

describe('Revert all ends at the run’s last result snapshot', () => {
  it('a second Revert all, and one after an Undo, revert the same range: never up to a pre-revert', () => {
    const h = stoppedRun()
    const range = { from: 'c-S0', to: 'c-stopped' }
    h.user({ kind: 'revert' })
    expect(h.fx('revert')).toEqual([expect.objectContaining({ scope: range, why: 'user' })])
    started(h, ['a.txt'])
    revertDone(h, ['a.txt'])
    // Clicked twice: the same range, although the shadow's latest snapshot is now `pre-revert`.
    h.user({ kind: 'revert' })
    expect(h.fx('revert')).toEqual([expect.objectContaining({ scope: range })])
    started(h, [], 'c-pre-revert-2')
    revertDone(h, [], [], 'c-pre-revert-2')
    // Revert all, Undo, Revert all.
    h.user({ kind: 'undo-revert', token: 'revert-1' })
    started(h, ['a.txt'], 'c-pre-revert-3')
    revertDone(h, ['a.txt'], [], 'c-pre-revert-3')
    h.user({ kind: 'revert' })
    expect(h.fx('revert')).toEqual([expect.objectContaining({ to: 'c-S0', scope: range })])
  })

  it('a segment the run has not reached is NOT_FOUND (never an open-ended range)', () => {
    const h = stoppedRun()
    h.user({ kind: 'revert', seg: 'implement' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
    expect(h.fx('revert')).toEqual([])
  })
})

describe('undo: checks what the revert wrote, and is itself undoable', () => {
  it('carries the revert’s target as `expect`; a conflict leaves the revert undoable; the undo gets its own record', () => {
    const h = stoppedRun()
    h.user({ kind: 'revert' })
    started(h, ['a.txt'])
    expect(h.state.git?.reverts?.[0]).toMatchObject({ token: 'revert-1', target: 'c-S0', pending: true })
    revertDone(h, ['a.txt'])
    expect(h.state.git?.reverts?.[0]).toMatchObject({ token: 'revert-1', paths: ['a.txt'] })
    expect(h.state.git?.reverts?.[0]?.pending).toBeUndefined()

    h.user({ kind: 'undo-revert', token: 'revert-1' })
    expect(h.fx('revert')).toEqual([
      {
        t: 'revert',
        req: expect.any(String) as string,
        to: 'c-pre-revert',
        paths: ['a.txt'],
        why: 'undo',
        token: 'revert-1',
        undoToken: 'revert-2',
        expect: 'c-S0',
      },
    ])
    // The folder changed since the revert: refused, nothing recorded, still undoable.
    const msg =
      '1 file changed after the revert (a.txt), so undoing it would overwrite that work. Nothing was undone.'
    h.send({ t: 'revert-result', req: revertReq(h), conflict: msg })
    expect(h.state.git?.reverts).toHaveLength(1)
    expect(h.state.git?.reverts?.[0]?.undone).toBeUndefined()

    // The user puts it back; the undo goes through and records itself.
    h.user({ kind: 'undo-revert', token: 'revert-1' })
    expect(h.fx('revert')[0]).toMatchObject({ token: 'revert-1', undoToken: 'revert-3' })
    started(h, ['a.txt'], 'c-pre-undo')
    revertDone(h, ['a.txt'], [], 'c-pre-undo')
    expect(h.state.git?.reverts?.map((r) => [r.token, r.why, r.undone === true])).toEqual([
      ['revert-1', 'user', true],
      ['revert-3', 'undo', false],
    ])
    expect(h.state.git?.reverts?.[1]).toMatchObject({
      preRevert: 'c-pre-undo',
      target: 'c-pre-revert',
      undoes: 'revert-1',
      paths: ['a.txt'],
    })
    expect(h.state.notes).toContain('Undid "Revert" (1 file).')
    // The undo is undone the same way: back to its own undo point, only while a.txt still holds what it wrote.
    h.user({ kind: 'undo-revert', token: 'revert-3' })
    expect(h.fx('revert')[0]).toMatchObject({ to: 'c-pre-undo', expect: 'c-pre-revert', why: 'undo' })
  })

  it('a record without its target cannot be undone (CONFLICT)', () => {
    const h = stoppedRun()
    h.user({ kind: 'revert' })
    revertDone(h, ['a.txt'])
    const rec = h.state.git?.reverts?.[0]
    if (rec !== undefined) delete rec.target
    h.user({ kind: 'undo-revert', token: 'revert-1' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })
})

describe('write-ahead: a revert is recorded before any file is written', () => {
  it('relaunch mid-revert: the record is kept as interrupted, with a note and the Undo; plan-end is checked again', () => {
    const h = planMutated()
    choose(h, 'planMutated', 'revert-plan')
    started(h, ['notes.md', 'todo.md'], 'c-pre-plan-revert')
    expect(h.state.git?.reverts?.[0]).toMatchObject({
      why: 'plan',
      pending: true,
      paths: ['notes.md', 'todo.md'],
    })
    // Still running: no Undo offered yet.
    expect(toRunSnapshot(h.state, 0).revertUndo).toBeUndefined()
    h.send({ t: 'relaunch' })
    const rec = h.state.git?.reverts?.[0]
    expect(rec?.pending).toBeUndefined()
    expect(rec?.interrupted).toBe(true)
    expect(h.state.notes).toContain(
      "Revert Plan's changes was interrupted when Dim Factory closed, so 2 files may be only partly reverted. Undo puts back what it changed.",
    )
    expect(toRunSnapshot(h.state, 0).revertUndo).toMatchObject({
      undoToken: 'revert-1',
      label: "Plan's changes",
      files: 2,
    })
    // R4 compares again (the half-reverted folder shows the card again).
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'plan-end' })])
    h.snapshot('plan-end', 'tree-half-reverted')
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['planMutated'])
    // The Undo brings Plan's output back.
    h.user({ kind: 'undo-revert', token: 'revert-1' })
    expect(h.fx('revert')).toEqual([
      expect.objectContaining({
        to: 'c-pre-plan-revert',
        paths: ['notes.md', 'todo.md'],
        expect: 'c-run-start',
      }),
    ])
  })

  it('an interrupted Revert all is offered after a relaunch (its toast never came)', () => {
    const h = stoppedRun()
    h.user({ kind: 'revert' })
    started(h, ['a.txt', 'b.txt'])
    h.send({ t: 'relaunch' })
    expect(toRunSnapshot(h.state, 0).revertUndo).toMatchObject({
      undoToken: 'revert-1',
      label: "the run's changes",
      files: 2,
    })
  })

  it('git failing part way leaves the record undoable, with a note', () => {
    const h = stoppedRun()
    h.user({ kind: 'revert', paths: ['a.txt'] })
    started(h, ['a.txt'])
    h.send({
      t: 'revert-result',
      req: revertReq(h),
      failure: { ...failure('snapshot_failed'), message: 'git checkout-index failed' },
    })
    expect(h.state.git?.reverts?.[0]).toMatchObject({ interrupted: true, paths: ['a.txt'] })
    expect(h.state.notes).toContain(
      'Revert stopped part way: git checkout-index failed. Undo puts back the 1 file it was changing.',
    )
  })
})

describe('P21 revert-then-fresh reverts only what the failed attempt changed', () => {
  function failedNoSession(): Harness {
    const h = new Harness().toImplementRunning({ session: false })
    h.ev('implement', { type: 'error', message: 'boom', raw: '', fatal: true, category: 'auth_expired' })
    h.exit('implement', { code: 1 })
    return h
  }

  it('Retry (revert-then-fresh): S0..the snapshot taken when the attempt failed, not S0..now', () => {
    const h = failedNoSession()
    h.snapshot('stopped', 'tree-attempt')
    expect(h.step('implement').attemptEnd).toMatchObject({ commit: 'c-stopped' })
    h.user({ kind: 'retry', step: 'implement', strategy: 'revert-then-fresh' })
    // pre-retry includes the user's edits made while the pass sat failed: not the scope.
    h.snapshot('pre-retry', 'tree-with-user-edits')
    expect(h.fx('revert')).toEqual([
      expect.objectContaining({ to: 'c-S0', scope: { from: 'c-S0', to: 'c-stopped' }, why: 'retry' }),
    ])
    expect(h.fx('revert')[0]?.paths).toBeUndefined()
    revertDone(h, ['src/partial.ts'])
    h.passPreflight('implement')
    expect(h.fx('spawn')).toHaveLength(1)
    // A new attempt: its own end will be recorded when it ends.
    expect(h.step('implement').attemptEnd).toBeUndefined()
  })

  it('waits for the failure snapshot when Retry comes first', () => {
    const h = failedNoSession()
    h.user({ kind: 'retry', step: 'implement', strategy: 'revert-then-fresh' })
    h.snapshot('pre-retry', 'tree-x')
    expect(h.fx('revert')).toEqual([])
    h.snapshot('stopped', 'tree-attempt')
    expect(h.fx('revert')).toEqual([expect.objectContaining({ scope: { from: 'c-S0', to: 'c-stopped' } })])
  })

  it('without a snapshot of the attempt’s end nothing is reverted: the pass fails with the reason', () => {
    const h = failedNoSession()
    h.snapshotFail('stopped')
    h.user({ kind: 'retry', step: 'implement', strategy: 'revert-then-fresh' })
    h.snapshot('pre-retry', 'tree-x')
    expect(h.log.some((e) => e.t === 'revert')).toBe(false)
    expect(h.step('implement')).toMatchObject({ status: 'failed', reason: 'snapshot_failed' })
    expect(h.step('implement').failure?.message).toContain('Nothing was reverted.')
  })

  it('P16 (an automatic retry): its pre-retry snapshot is the attempt’s end; retryPartial scopes to it', () => {
    const h = new Harness().toImplementRunning({ session: false })
    h.exit('implement', { code: 1, ranMs: 60_000 }) // process_crash after > 3 s: an automatic retry
    h.snapshot('pre-retry', 'tree-attempt')
    expect(h.step('implement').attemptEnd).toMatchObject({ commit: 'c-pre-retry' })
    choose(h, 'retryPartial', 'revert-then-fresh')
    expect(h.fx('revert')).toEqual([expect.objectContaining({ scope: { from: 'c-S0', to: 'c-pre-retry' } })])
  })
})

describe('a later pass retires a card revert’s Undo', () => {
  /** Plan's changes reverted (notes.md), then Implement runs to its end snapshot request. */
  function revertedThenImplementDone(): Harness {
    const h = planMutated()
    choose(h, 'planMutated', 'revert-plan')
    started(h, ['notes.md'])
    revertDone(h, ['notes.md'])
    h.approve()
    h.reconcile('pre-implement')
    h.snapshot('S0', 'tree-base')
    h.passPreflight('implement')
    h.ev('implement', { type: 'done', result: 'done', usage: { input: 1, output: 1, costUsd: 0 } })
    return h
  }

  it('the end snapshot asks for the pass’s changed paths while a card Undo is offered', () => {
    const h = revertedThenImplementDone()
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S1', diffFrom: 'c-S0' })])
  })

  it('Implement changed a reverted path: the Undo is no longer offered', () => {
    const h = revertedThenImplementDone()
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('S1'),
      commit: 'c-S1',
      tree: 'tree-S1',
      changed: ['notes.md', 'src/a.ts'],
    })
    expect(h.state.git?.reverts?.[0]?.stale).toBe(true)
    expect(toRunSnapshot(h.state, 0).revertUndo).toBeUndefined()
  })

  it('Implement left the reverted paths alone: the Undo stays', () => {
    const h = revertedThenImplementDone()
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('S1'),
      commit: 'c-S1',
      tree: 'tree-S1',
      changed: ['src/a.ts'],
    })
    expect(toRunSnapshot(h.state, 0).revertUndo).toMatchObject({ label: "Plan's changes" })
  })

  it('a cut list of changed paths counts as touching', () => {
    const h = revertedThenImplementDone()
    const many = Array.from({ length: CHANGED_PATHS_MAX }, (_, i) => `f${i}.ts`)
    h.send({ t: 'snapshot-done', req: h.snapReq('S1'), commit: 'c-S1', tree: 'tree-S1', changed: many })
    expect(toRunSnapshot(h.state, 0).revertUndo).toBeUndefined()
  })

  it('no card revert: no extra diff on the end snapshot', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'done', usage: { input: 1, output: 1, costUsd: 0 } })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S1' })])
    expect(h.fx('snapshot')[0]?.diffFrom).toBeUndefined()
  })
})

describe('R5 run branch write-ahead', () => {
  const BRANCH: RunBranchInfo = {
    name: 'dim/20261008-add-a-version-flag',
    base: 'a'.repeat(40),
    previous: 'refs/heads/main',
  }
  const runBranch = (): RunConfig => makeConfig({ branch: 'runBranch' })
  const blockCard = (): ReconcileCardInput => ({
    verdict: 'block',
    reasons: [
      {
        row: 'branch-ref-left',
        severity: 'block',
        title: `The branch ${BRANCH.name} was left behind`,
        detail: 'Dim Factory made it and could not remove it again.',
        actions: [],
      },
    ],
    external: [],
    overlapping: [],
    choices: [
      { id: 'recheck', label: 'Recheck', primary: true },
      { id: 'stop', label: 'Stop' },
    ],
    notes: [],
  })

  function atBranchPrep(): Harness {
    const h = planMutated(runBranch())
    choose(h, 'planMutated', 'keep')
    h.approve()
    h.send({
      t: 'reconcile-result',
      req: h.req((r) => r.kind === 'reconcile' && r.boundary === 'pre-implement'),
      result: { verdict: 'clean', head: HEAD_MAIN },
    })
    expect(h.fx('branch')).toEqual([{ t: 'branch', req: expect.any(String) as string }])
    return h
  }
  const branchReq = (h: Harness): string => h.req((r) => r.kind === 'branch', 'branch')

  it('the intent is recorded first; a ref left behind stays pending and the next branch prep settles it', () => {
    const h = atBranchPrep()
    h.send({ t: 'branch-intent', req: branchReq(h), branch: BRANCH })
    expect(h.state.branchPending).toEqual(BRANCH)
    expect(h.last?.state.branchPending).toEqual(BRANCH)
    h.send({ t: 'branch-result', req: branchReq(h), blocked: blockCard(), leftover: BRANCH })
    expect(h.state.branchPending).toEqual(BRANCH)
    choose(h, 'reconcile', 'recheck')
    h.send({
      t: 'reconcile-result',
      req: h.req((r) => r.kind === 'reconcile' && r.boundary === 'pre-implement'),
      result: { verdict: 'clean', head: HEAD_MAIN },
    })
    expect(h.fx('branch')).toEqual([{ t: 'branch', req: expect.any(String) as string, pending: BRANCH }])
    h.send({ t: 'branch-result', req: branchReq(h), branch: BRANCH, notes: [] })
    expect(h.state.branch).toEqual(BRANCH)
    expect(h.state.branchPending).toBeUndefined()
  })

  it('a block with nothing left behind (the ref was never written, or was removed) clears the intent', () => {
    const h = atBranchPrep()
    h.send({ t: 'branch-intent', req: branchReq(h), branch: BRANCH })
    h.send({ t: 'branch-result', req: branchReq(h), blocked: blockCard() })
    expect(h.state.branchPending).toBeUndefined()
  })

  it('an unexpected failure keeps the intent (the next settle finds out)', () => {
    const h = atBranchPrep()
    h.send({ t: 'branch-intent', req: branchReq(h), branch: BRANCH })
    h.send({ t: 'branch-result', req: branchReq(h), failure: failure('git_state') })
    expect(h.state.branchPending).toEqual(BRANCH)
  })

  it('relaunch with an intent: settle at once; adopted → the run branch, expected HEAD on it', () => {
    const h = atBranchPrep()
    h.send({ t: 'branch-intent', req: branchReq(h), branch: BRANCH })
    h.send({ t: 'relaunch' })
    expect(h.fx('branch')).toEqual([
      { t: 'branch', req: expect.any(String) as string, pending: BRANCH, settle: true },
    ])
    expect(h.step('implement').status).toBe('paused')
    h.send({ t: 'branch-result', req: branchReq(h), branch: BRANCH, notes: [] })
    expect(h.state.branch).toEqual(BRANCH)
    expect(h.state.branchPending).toBeUndefined()
    expect(h.state.git?.expectedHead).toEqual({ ref: `refs/heads/${BRANCH.name}`, commit: BRANCH.base })
    expect(h.step('implement').status).toBe('paused')
  })

  it('relaunch settle that keeps it pending (HEAD not on it yet): R5 settles it later', () => {
    const h = atBranchPrep()
    h.send({ t: 'branch-intent', req: branchReq(h), branch: BRANCH })
    h.send({ t: 'relaunch' })
    h.send({ t: 'branch-result', req: branchReq(h), leftover: BRANCH })
    expect(h.state.branchPending).toEqual(BRANCH)
    expect(h.state.branch).toBeUndefined()
  })
})

describe('Plan’s wait for the run-start snapshot is named', () => {
  it('while Plan’s launch waits for run-start the step view says so; the spawn clears it', () => {
    const h = new Harness()
    h.create()
    h.lock()
    expect(toRunSnapshot(h.state, 0).steps.plan.launchWait).toBeUndefined()
    h.preflight()
    expect(h.state.flow.runStart).toBe('requested')
    const waiting = toRunSnapshot(h.state, 0).steps.plan
    expect(waiting).toMatchObject({ status: 'running', launchWait: 'run-start' })
    // Its pass-boundary preflight answering changes nothing: the spawn still waits for the snapshot.
    h.passPreflight('plan')
    expect(h.fx('spawn')).toHaveLength(0)
    expect(toRunSnapshot(h.state, 0).steps.plan.launchWait).toBe('run-start')
    h.snapshot('run-start', 'tree-base')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
    expect(toRunSnapshot(h.state, 0).steps.plan.launchWait).toBeUndefined()
  })

  it('a failed run-start lets Plan go, and the wait is no longer named', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight()
    h.passPreflight('plan')
    h.snapshotFail('run-start')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
    expect(toRunSnapshot(h.state, 0).steps.plan.launchWait).toBeUndefined()
  })

  it('a skipped Plan names no wait (run-start goes on beside Implement’s boundary)', () => {
    const h = new Harness(
      makeConfig({
        passes: { ...makeConfig().passes, plan: { ...makeConfig().passes.plan, enabled: false } },
      }),
    )
    h.create()
    h.lock()
    h.preflight()
    expect(h.state.flow.runStart).toBe('requested')
    expect(toRunSnapshot(h.state, 0).steps.plan).toMatchObject({ status: 'skipped' })
    expect(toRunSnapshot(h.state, 0).steps.plan.launchWait).toBeUndefined()
  })
})
