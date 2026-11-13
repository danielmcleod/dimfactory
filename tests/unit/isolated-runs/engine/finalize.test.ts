// Engine: R12 finalize (Finalize, Apply, Cleanup; R12, R13, "Crash relaunch";
// Apply copies only files whose folder content still equals base, conflicts are Keep mine / Take run's). One case
// per row or branch, through `reduce`.
import { describe, expect, it } from 'vitest'
import { CONFLICT_CHOICE, FINALIZE_CHOICE, INTERRUPTED_APPLY_CHOICE } from '@core/supervisor/cards.ts'
import { toRunSnapshot, toRunSummary } from '@core/supervisor/derive.ts'
import { DISCARD_DEFER_MS, DISCARD_TIMER, FINALIZE_WAIT_REASON } from '@core/supervisor/machine.ts'
import { finalizeWorkPending, needsRelaunch } from '@core/supervisor/recovery.ts'
import { IFlow } from './helpers.ts'

describe('the outcome is fixed, then finalize', () => {
  it('no-changes reaches finalize: outcome set, finalize running (its preview), the run not completed yet', () => {
    const h = new IFlow().toR12NoChanges()
    expect(h.state.outcome).toBe('no-changes')
    expect(h.state.endedAt).toBeUndefined()
    expect(h.step('finalize')).toMatchObject({ status: 'running', attempt: 1 })
    expect(h.fx('finalizePreview')).toHaveLength(1)
    expect(h.state.phase).toBe('ready-to-apply')
    expect(h.state.status).toBe('running')
    expect(h.fx('notify').some((n) => n.kind === 'completed')).toBe(false)
  })

  it('the preview opens the finalize card [Apply to folder] [Keep for later] [Discard] (default Keep)', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    const c = h.cardOf('finalize')
    expect(c.view.choices.map((x) => [x.id, x.label])).toEqual([
      ['apply', 'Apply to folder'],
      ['keep', 'Keep for later'],
      ['discard', 'Discard'],
    ])
    expect(c.view.defaultChoice).toBe(FINALIZE_CHOICE.keep)
    expect(c.view.payload).toMatchObject({ files: 3, branch: 'dim/20261005-add-a-version-flag-abcd' })
    expect(h.step('finalize')).toMatchObject({ status: 'waiting', reason: FINALIZE_WAIT_REASON.choice })
    expect(h.state).toMatchObject({ status: 'waiting', phase: 'ready-to-apply', outcome: 'clean' })
    expect(h.fx('notify')).toEqual([expect.objectContaining({ kind: 'card' })])
  })

  it('[Apply to folder]: lease the folder, then the apply (write-ahead), then finalize done and the run completes', () => {
    const h = new IFlow().toR12Clean()
    h.preview(1)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    expect(h.fx('lease')).toEqual([{ t: 'lease' }])
    expect(h.fx('apply')).toHaveLength(0)
    expect(h.state.isolation?.finalize).toMatchObject({ state: 'waiting', lease: 'requested' })
    const r = h.lease()
    expect(h.fx('apply')).toEqual([expect.objectContaining({ no: 1 })])
    // The transition (state `applying`) is persisted before the effect writes anything.
    expect(r.transition).toBe(true)
    expect(h.state.isolation?.finalize?.state).toBe('applying')
    h.applied(['src/cli.ts'], [], 'apply-tok')
    expect(h.fx('unlease')).toEqual([{ t: 'unlease' }])
    expect(h.step('finalize')).toMatchObject({ status: 'done', reason: 'applied' })
    expect(h.state).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(h.fx('notify')).toEqual([expect.objectContaining({ kind: 'completed' })])
    expect(h.fx('unlock')).toHaveLength(1)
    const snap = toRunSnapshot(h.state, 1)
    expect(snap.steps.finalize.finalize).toMatchObject({
      state: 'applied',
      applied: 1,
      undoToken: 'apply-tok',
    })
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'applied', notApplied: false })
  })

  it('[Keep for later]: finalize skipped(kept), the run completes, the chip says not applied', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.keep)
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'kept' })
    expect(h.state.status).toBe('completed')
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'kept', notApplied: true })
    expect(h.fx('lease')).toHaveLength(0)
  })

  it('[Discard] is deferred 10 s and undoable; then the worktree is removed and finalize is done', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.discard)
    const d = h.state.isolation?.finalize?.discard
    expect(d?.deleteAt).toBe(h.now + DISCARD_DEFER_MS)
    expect(h.state.timers[DISCARD_TIMER]).toBe(d?.deleteAt)
    expect(h.fx('removeWorktree')).toHaveLength(0)
    expect(toRunSnapshot(h.state, 1).steps.finalize.finalize).toMatchObject({
      state: 'discarding',
      discardToken: d?.token,
    })
    // Undo within the 10 s: the card is back.
    h.user({ kind: 'undo-discard', token: d?.token ?? '' })
    expect(h.cardOf('finalize')).toBeDefined()
    expect(h.state.timers[DISCARD_TIMER]).toBeUndefined()
    h.choose('finalize', FINALIZE_CHOICE.discard)
    h.fire(DISCARD_TIMER)
    expect(h.fx('removeWorktree')).toHaveLength(1)
    // Too late to undo once the deletion began.
    h.user({ kind: 'undo-discard', token: h.state.isolation?.finalize?.discard?.token ?? '' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    h.send({ t: 'remove-result', req: h.finReq('remove'), ok: true })
    expect(h.step('finalize')).toMatchObject({ status: 'done', reason: 'discarded' })
    expect(h.state.status).toBe('completed')
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'discarded', notApplied: false })
  })

  it('a deletion that fails keeps the worktree (kept), with the reason', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.discard)
    h.fire(DISCARD_TIMER)
    h.send({ t: 'remove-result', req: h.finReq('remove'), ok: false, error: 'a file is open' })
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'kept' })
    expect(h.state.notes.some((n) => n.includes('a file is open'))).toBe(true)
  })
})

describe('R12 in Auto', () => {
  it('without autoApply: the card takes Keep for later (Auto never writes the folder on its own)', () => {
    const h = new IFlow({ auto: true }).toR12Clean()
    h.preview(2)
    expect(h.state.cards).toHaveLength(0)
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'kept' })
    expect(h.state.notes).toContain('Auto: "Apply the run to your folder?" → Keep for later')
    expect(h.log.some((e) => e.t === 'lease')).toBe(false)
  })

  it('autoApply ∧ Auto ∧ no conflicts: applies without the card', () => {
    const h = new IFlow({ auto: true, autoApply: true }).toR12Clean()
    h.preview(2)
    expect(h.state.cards).toHaveLength(0)
    expect(h.fx('lease')).toHaveLength(1)
    h.lease()
    h.applied()
    expect(h.state.status).toBe('completed')
    expect(h.step('finalize').status).toBe('done')
  })

  it('autoApply ∧ Auto with conflicts: the card (Auto keeps), never an apply', () => {
    const h = new IFlow({ auto: true, autoApply: true }).toR12Clean()
    h.preview(2, [{ path: 'src/cli.ts', reason: 'changed in your folder' }])
    expect(h.log.some((e) => e.t === 'lease')).toBe(false)
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'kept' })
  })

  it('autoApply without Auto: the card waits', () => {
    const h = new IFlow({ autoApply: true }).toR12Clean()
    h.preview(2)
    expect(h.cardOf('finalize')).toBeDefined()
  })
})

describe("conflicts: finalizeConflicts [Keep mine] / [Take run's]", () => {
  const conflicts = [
    { path: 'a.txt', reason: 'changed in your folder' },
    { path: 'b.txt', reason: 'changed in your folder' },
  ]

  it('the apply reports conflicts: the card waits (no default, Auto included); file by file in place', () => {
    const h = new IFlow({ auto: true, autoApply: true }).toR12Clean()
    h.preview(3)
    h.lease()
    h.applied(['src/cli.ts'], conflicts)
    const card = h.cardOf('finalizeConflicts')
    expect(card.view.defaultChoice).toBeUndefined()
    expect(card.view.choices.map((c) => [c.id, c.input])).toEqual([
      [CONFLICT_CHOICE.keepMine, 'paths'],
      [CONFLICT_CHOICE.takeTheirs, 'paths'],
    ])
    expect(h.state.status).toBe('waiting')
    expect(h.step('finalize')).toMatchObject({ status: 'waiting', reason: FINALIZE_WAIT_REASON.conflicts })
    // Keep mine for a.txt: nothing written; the same card stays with b.txt.
    h.choose('finalizeConflicts', CONFLICT_CHOICE.keepMine, ['a.txt'])
    const again = h.cardOf('finalizeConflicts')
    expect(again.view.id).toBe(card.view.id)
    expect(again.view.payload).toMatchObject({ files: [{ path: 'b.txt' }] })
    expect(h.fx('lease')).toHaveLength(0)
    // Take run's for b.txt: an apply of that file with `theirs`.
    h.choose('finalizeConflicts', CONFLICT_CHOICE.takeTheirs, ['b.txt'])
    expect(h.fx('lease')).toHaveLength(1)
    // Another choice while it runs is refused.
    h.choose('finalizeConflicts', CONFLICT_CHOICE.keepMine)
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    h.lease()
    expect(h.fx('apply')).toEqual([
      expect.objectContaining({ paths: ['b.txt'], resolutions: { 'b.txt': 'theirs' } }),
    ])
    h.applied(['b.txt'], [], 'apply-2')
    expect(h.state.cards.some((c) => c.view.kind === 'finalizeConflicts')).toBe(false)
    expect(h.step('finalize').status).toBe('done')
    expect(h.state.status).toBe('completed')
  })

  it('an unknown path is refused', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.applied([], conflicts)
    h.choose('finalizeConflicts', CONFLICT_CHOICE.keepMine, ['nope.txt'])
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
  })
})

describe('Crash relaunch while applying: interruptedApply [Finish apply]', () => {
  it('a relaunch while the apply wrote opens interruptedApply (never auto-resumed); Finish carries it on', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    expect(needsRelaunch(h.state)).toBe(true)
    h.send({ t: 'relaunch' })
    const card = h.cardOf('interruptedApply')
    expect(card.view.defaultChoice).toBeUndefined()
    expect(card.view.choices.map((c) => c.id)).toEqual([INTERRUPTED_APPLY_CHOICE.finish])
    expect(h.state.phase).toBe('ready-to-apply')
    expect(h.log.filter((e) => e.t === 'apply')).toHaveLength(1)
    h.choose('interruptedApply', INTERRUPTED_APPLY_CHOICE.finish)
    h.lease()
    expect(h.fx('apply')).toEqual([expect.objectContaining({ resume: true })])
    h.applied(['src/cli.ts'])
    expect(h.state.status).toBe('completed')
  })

  it('an apply that failed part way (the journal has it) opens interruptedApply with the reason', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.send({
      t: 'apply-result',
      req: h.finReq('apply'),
      failure: { category: 'disk_full', message: 'the drive is full', raw: '', classifiedBy: 'app' },
      interrupted: true,
    })
    expect(h.cardOf('interruptedApply').view.body).toContain('the drive is full')
  })

  it('an apply refused before writing anything goes back to the finalize card, saying why', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.send({
      t: 'apply-result',
      req: h.finReq('apply'),
      failure: {
        category: 'git_state',
        message: "This run's snapshots are gone",
        raw: '',
        classifiedBy: 'app',
      },
    })
    expect(h.cardOf('finalize').view.body).toContain("This run's snapshots are gone")
  })

  it('a deferred discard keeps its 10 s from the relaunch (its Undo stays possible meanwhile)', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.discard)
    expect(finalizeWorkPending(h.state)).toBe(true)
    h.tick(60_000)
    h.send({ t: 'relaunch' })
    expect(h.state.timers[DISCARD_TIMER]).toBe(h.now + DISCARD_DEFER_MS)
    expect(h.fx('removeWorktree')).toHaveLength(0)
  })
})

describe('worktree.* commands', () => {
  it('apply is refused while the run still works in its worktree', () => {
    const h = new IFlow().toImplementRunning()
    h.user({ kind: 'apply' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })

  it("apply with paths from the finalize card state answers the card (the Diff tab is the user's choice)", () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.user({ kind: 'apply', paths: ['src/cli.ts'] })
    expect(h.state.cards.some((c) => c.view.kind === 'finalize')).toBe(false)
    h.lease()
    expect(h.fx('apply')).toEqual([expect.objectContaining({ paths: ['src/cli.ts'] })])
  })

  it('a kept run can be applied later; Undo under the lease makes it not applied again', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.keep)
    h.user({ kind: 'apply' })
    h.lease()
    h.applied(['src/cli.ts'], [], 'tok-1')
    expect(h.state.status).toBe('completed')
    expect(toRunSummary(h.state).worktree?.notApplied).toBe(false)
    h.user({ kind: 'undo-apply', token: 'tok-1' })
    expect(h.fx('lease')).toHaveLength(1)
    h.lease()
    expect(h.fx('undoApply')).toEqual([expect.objectContaining({ token: 'tok-1' })])
    h.send({ t: 'undo-apply-result', req: h.finReq('undo'), ok: true })
    expect(h.state.isolation?.finalize?.applies[0]?.undone).toBe(true)
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'kept', notApplied: true })
    h.user({ kind: 'undo-apply', token: 'tok-1' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })

  it('an undo refused because a file changed since keeps the apply, with the reason', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.applied(['src/cli.ts'], [], 'tok-1')
    h.user({ kind: 'undo-apply', token: 'tok-1' })
    h.lease()
    h.send({
      t: 'undo-apply-result',
      req: h.finReq('undo'),
      ok: false,
      conflict: true,
      error: 'src/cli.ts changed',
    })
    expect(h.state.isolation?.finalize).toMatchObject({ state: 'applied' })
    expect(h.state.isolation?.finalize?.error).toContain('Undo refused')
  })

  it('a stopped run keeps its worktree: apply and discard still work on it', () => {
    const h = new IFlow().toImplementRunning()
    h.user({ kind: 'stop' })
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'kept', notApplied: true })
    h.user({ kind: 'discard' })
    expect(h.state.isolation?.finalize?.state).toBe('discarding')
    expect(h.state.status).toBe('cancelled')
    // The status did not change, the Dashboard chip did: the summary is published again.
    expect(h.fx('index')).toHaveLength(1)
  })
})

describe('Stop while finalize is open', () => {
  it('Stop at the finalize card: cancelled, the worktree kept (never deleted on its own)', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.user({ kind: 'stop' })
    expect(h.state.status).toBe('cancelled')
    expect(h.step('finalize').status).toBe('cancelled')
    expect(h.state.isolation?.finalize?.state).toBe('kept')
    expect(h.log.some((e) => e.t === 'removeWorktree')).toBe(false)
    expect(toRunSummary(h.state).worktree?.notApplied).toBe(true)
  })

  it('Stop while the apply writes is refused (the folder is never left half written by a Stop)', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.user({ kind: 'stop' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })

  it('Stop while the apply waits for the folder gives the lease request back', () => {
    const h = new IFlow().toR12Clean()
    h.preview(3)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.user({ kind: 'stop' })
    expect(h.fx('unlease')).toEqual([{ t: 'unlease' }])
    expect(h.state.status).toBe('cancelled')
    // A grant that crossed the release is handed straight back.
    h.lease()
    expect(h.fx('unlease')).toEqual([{ t: 'unlease' }])
    expect(h.fx('apply')).toHaveLength(0)
  })
})

describe('views', () => {
  it("prepare rows and the baseline and finalize nodes are planned from the run's start", () => {
    const h = new IFlow({ enabled: true, baseline: true })
    const snap = toRunSnapshot(h.state, 0)
    expect(snap.steps.prepare.prepare?.steps.map((r) => [r.id, r.status])).toEqual([
      ['worktree', 'queued'],
      ['copy', 'queued'],
      ['deps', 'queued'],
      ['baseline', 'queued'],
      ['ready', 'queued'],
    ])
    expect(snap.steps['verify:0'].planned).toBe(true)
    expect(snap.steps.finalize.planned).toBe(true)
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'preparing', notApplied: false })
  })

  it('verify off: the baseline and ready rows are skipped from the start, with why', () => {
    const h = new IFlow()
    const rows = toRunSnapshot(h.state, 0).steps.prepare.prepare?.steps ?? []
    expect(rows.find((r) => r.id === 'baseline')).toEqual({
      id: 'baseline',
      status: 'skipped',
      detail: 'Verify is off.',
    })
    expect(rows.find((r) => r.id === 'ready')).toEqual({
      id: 'ready',
      status: 'skipped',
      detail: 'Verify is off.',
    })
  })

  it('an in-place run has no prepare view and no worktree summary', () => {
    const h = new IFlow()
    h.state = { ...h.state, config: { ...h.state.config, isolation: 'inPlace' } }
    delete h.state.isolation
    const snap = toRunSnapshot(h.state, 0)
    expect(snap.steps.prepare.prepare).toBeUndefined()
    expect(snap.summary.worktree).toBeUndefined()
  })
})
