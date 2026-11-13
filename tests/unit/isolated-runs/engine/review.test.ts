// Review fixes in the run engine for isolated runs (Finalize, Apply, Cleanup;
// R12, "Run status derivation", "Crash relaunch"; isolation.verifyReady). One
// case per finding, through `reduce`; each fails on the code before its fix.
import { describe, expect, it } from 'vitest'
import {
  CONFLICT_CHOICE,
  FINALIZE_CHOICE,
  INTERRUPTED_APPLY_CHOICE,
  VERIFY_ENV_CHOICE,
} from '@core/supervisor/cards.ts'
import { toRunSnapshot, toRunSummary } from '@core/supervisor/derive.ts'
import { DISCARD_TIMER, FINALIZE_NOTHING_REASON, ISOLATED_REVERT_TEXT } from '@core/supervisor/machine.ts'
import { result, trusted } from '../../verify/machine-helpers.ts'
import { PLAN_TEXT } from '../../supervisor/helpers.ts'
import { IFlow } from './helpers.ts'

const interrupted = (h: IFlow): void => {
  h.send({
    t: 'apply-result',
    req: h.finReq('apply'),
    failure: { category: 'disk_full', message: 'the drive is full', raw: '', classifiedBy: 'app' },
    interrupted: true,
  })
}

describe('a completed run stays completed when its copy is applied or undone later (finding 9)', () => {
  it('Keep for later, then the Diff tab applies and undoes: status completed, the step as it completed', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.keep)
    expect(h.state.status).toBe('completed')
    const endedAt = h.state.endedAt
    h.user({ kind: 'apply' })
    expect(h.fx('lease')).toHaveLength(1)
    expect(h.state).toMatchObject({ status: 'completed', phase: 'done' })
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'kept' })
    expect(toRunSummary(h.state).status).toBe('completed')
    h.lease()
    expect(h.state.isolation?.finalize?.state).toBe('applying')
    expect(h.state.status).toBe('completed')
    h.applied(['src/cli.ts'], [], 'tok-1')
    expect(h.state).toMatchObject({ status: 'completed', phase: 'done', endedAt })
    expect(toRunSnapshot(h.state, 1).steps.finalize.finalize).toMatchObject({
      state: 'applied',
      undoToken: 'tok-1',
    })
    // The step keeps how the run completed; finalize's progress is in its view.
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'kept' })
    h.user({ kind: 'undo-apply', token: 'tok-1' })
    h.lease()
    expect(h.state.status).toBe('completed')
    h.send({ t: 'undo-apply-result', req: h.finReq('undo'), ok: true })
    expect(h.state).toMatchObject({ status: 'completed', phase: 'done' })
    expect(h.fx('notify').filter((n) => n.kind === 'completed')).toHaveLength(0)
  })

  it('conflicts found by a later apply open their card on the completed run: no Needs you, no notification', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.keep)
    h.user({ kind: 'apply' })
    h.lease()
    h.applied(['src/cli.ts'], [{ path: 'src/b.ts', reason: 'changed in your folder' }], 'tok-1')
    expect(h.cardOf('finalizeConflicts')).toBeDefined()
    expect(h.state).toMatchObject({ status: 'completed', phase: 'done' })
    expect(h.fx('notify')).toEqual([])
    // Keep mine settles it; the run stays completed.
    h.choose('finalizeConflicts', CONFLICT_CHOICE.keepMine, ['src/b.ts'])
    expect(h.state.cards).toHaveLength(0)
    expect(h.state.status).toBe('completed')
  })
})

describe('finalizeConflicts while an apply is interrupted (finding 11)', () => {
  it('Keep mine is refused until [Finish apply]; the run never completes with interruptedApply open', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.applied(['src/a.ts'], [{ path: 'src/b.ts' }])
    h.choose('finalizeConflicts', CONFLICT_CHOICE.takeTheirs, ['src/b.ts'])
    h.lease()
    interrupted(h)
    expect(h.state.cards.map((c) => c.view.kind).sort()).toEqual(['finalizeConflicts', 'interruptedApply'])
    h.choose('finalizeConflicts', CONFLICT_CHOICE.keepMine, ['src/b.ts'])
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    expect(h.state.endedAt).toBeUndefined()
    expect(h.fx('notify').some((n) => n.kind === 'completed')).toBe(false)
    expect(h.state.isolation?.finalize?.conflicts?.map((c) => c.path)).toEqual(['src/b.ts'])
    // Finish apply carries the Take run's on; its result decides what is left.
    h.choose('interruptedApply', INTERRUPTED_APPLY_CHOICE.finish)
    h.lease()
    expect(h.fx('apply')).toEqual([
      expect.objectContaining({ resume: true, paths: ['src/b.ts'], resolutions: { 'src/b.ts': 'theirs' } }),
    ])
    h.applied(['src/b.ts'], [], 'apply-2')
    expect(h.state.cards).toHaveLength(0)
    expect(h.state.status).toBe('completed')
  })

  it('Finish apply that finds the file changed again asks about it again (the conflicts card rebuilt)', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.apply)
    h.lease()
    h.applied(['src/a.ts'], [{ path: 'src/b.ts' }])
    h.choose('finalizeConflicts', CONFLICT_CHOICE.takeTheirs, ['src/b.ts'])
    h.lease()
    interrupted(h)
    h.choose('interruptedApply', INTERRUPTED_APPLY_CHOICE.finish)
    h.lease()
    h.applied(
      [],
      [{ path: 'src/b.ts', reason: 'It was changed in the folder after the run started.' }],
      'apply-2',
    )
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['finalizeConflicts'])
    expect(h.state.status).toBe('waiting')
  })
})

describe('a relaunch while Discard was deleting the copy finishes the deletion (finding 6)', () => {
  it('no second Undo window: the removal is asked for again, and undo-discard is refused', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.discard)
    h.fire(DISCARD_TIMER)
    expect(h.fx('removeWorktree')).toHaveLength(1)
    const token = h.state.isolation?.finalize?.discard?.token ?? ''
    h.send({ t: 'relaunch' })
    expect(h.fx('removeWorktree')).toHaveLength(1)
    expect(h.state.timers[DISCARD_TIMER]).toBeUndefined()
    expect(toRunSnapshot(h.state, 1).steps.finalize.finalize?.discardToken).toBeUndefined()
    h.user({ kind: 'undo-discard', token })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    h.send({ t: 'remove-result', req: h.finReq('remove'), ok: true })
    expect(h.step('finalize')).toMatchObject({ status: 'done', reason: 'discarded' })
  })
})

describe('a run that changed no files has nothing to apply (finding 16)', () => {
  it('no finalize card, no chip: finalize skipped (nothing to apply), the run completes', () => {
    const h = new IFlow().toR12NoChanges()
    h.preview(0)
    expect(h.state.cards).toHaveLength(0)
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: FINALIZE_NOTHING_REASON })
    expect(h.state).toMatchObject({ status: 'completed', outcome: 'no-changes' })
    expect(toRunSummary(h.state).worktree).toEqual({ state: 'kept', notApplied: false })
    expect(h.fx('notify').filter((n) => n.kind === 'card')).toEqual([])
    expect(h.state.notes.some((n) => n.includes('nothing to apply'))).toBe(true)
  })

  it('in Auto: no Keep for later note and no chip', () => {
    const h = new IFlow({ auto: true }).toR12NoChanges()
    h.preview(0)
    expect(h.state.notes.some((n) => n.includes('Keep for later'))).toBe(false)
    expect(toRunSummary(h.state).worktree?.notApplied).toBe(false)
  })
})

describe("the readiness card's [Skip verify] is remembered by the rounds (finding 17)", () => {
  /** Readiness finds `test` missing → [Skip verify] → Plan → Implement → S1 → verify:1's check. */
  const toVerify1 = (): IFlow => {
    const h = new IFlow({ enabled: true }).toPlanRunning()
    h.deps(null)
    h.ready([
      { name: 'test', argv: ['npm', 'run', 'test'], reason: 'npm was not found in the isolated copy' },
    ])
    h.choose('verifyEnv', VERIFY_ENV_CHOICE.skipVerify)
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
    return h
  }

  it('verify:1 reports the skipped command as not run, without a second verifyEnv card', () => {
    const h = toVerify1()
    h.check([trusted('test')])
    h.round([result('test', 'env')])
    expect(h.state.cards.some((c) => c.view.kind === 'verifyEnv')).toBe(false)
    // Nothing passed or failed: the round reads skipped ("no command ran"), and the run goes on.
    expect(h.step('verify:1').status).toBe('skipped')
    expect(h.step('verify:1').verify?.commands).toEqual([
      expect.objectContaining({ name: 'test', status: 'env' }),
    ])
    expect(h.state.notes.some((n) => n.includes('Skip verify before Implement'))).toBe(true)
  })

  it('a command the readiness card did not name still asks', () => {
    const h = toVerify1()
    h.check([trusted('test'), trusted('lint')])
    h.round([result('test', 'env'), result('lint', 'env')])
    expect(h.cardOf('verifyEnv').view.payload).toMatchObject({ step: 'verify:1' })
  })
})

describe('diff.revert is refused for an isolated run (finding 14)', () => {
  it('Revert all would change the copy, never the folder: CONFLICT with why', () => {
    const h = new IFlow().toR12Clean()
    h.preview(2)
    h.choose('finalize', FINALIZE_CHOICE.keep)
    h.user({ kind: 'revert' })
    expect(h.fx('result')).toEqual([
      expect.objectContaining({ code: 'CONFLICT', message: ISOLATED_REVERT_TEXT }),
    ])
    expect(h.fx('revert')).toHaveLength(0)
  })
})
