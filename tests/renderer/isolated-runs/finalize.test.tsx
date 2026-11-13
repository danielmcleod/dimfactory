// Finalize step and its Undo (Finalize: Apply or Discard finish it, Keep for later skips it;
// Undo = restore(applied, P); Discard is deferred 10 s and undoable; "Undo toasts, not confirm dialogs";
// state-machine row R12). The step's card says what core's finalize view reports, in one line with [Undo] beside it while core holds a
// token; an apply or a discard core reports while the view is open gets its toast with Undo once per token (the
// Discard toast lasts until core deletes the copy), never for a token that was there when the card mounted.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FinalizeView, RunSnapshot } from '@shared/run.ts'
import { FinalizeCard, finalizeReasonText } from '@renderer/components/run/FinalizeCard.tsx'
import { finalizeInfoOf, finalizeStateText } from '@renderer/components/run/isolation.ts'
import { APPLY_UNDONE, DISCARDED, DISCARD_UNDONE, discardToastMs } from '@renderer/components/run/worktree.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { RUN } from '../run/helpers.tsx'
import { finalizeStep, isolatedSnap } from './fixtures.ts'

const EM_DASH = '—'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({
    handlers: {
      'worktree.undoApply': () => undefined,
      'worktree.undoDiscard': () => undefined,
      'runs.get': () => isolatedSnap(),
    },
  })
})

afterEach(() => tearDown(mock))

const toasts = () => useStore.getState().toasts.items

function snapAt(view: FinalizeView, status: 'waiting' | 'done' | 'skipped' = 'waiting'): RunSnapshot {
  return isolatedSnap({ finalize: finalizeStep(view, { status }) })
}

function card(snap: RunSnapshot) {
  return (
    <Providers>
      <FinalizeCard runId={RUN} snap={snap} view={snap.steps.finalize} />
    </Providers>
  )
}

describe('the Finalize step', () => {
  it('says what core reports, one line from the start, its words changing in place', async () => {
    const view = render(card(snapAt({ state: 'pending', files: 3 })))
    await settle()
    const line = screen.getByTestId('finalize-state')
    expect(line.textContent).toBe('Waiting for your choice below.')
    expect(line.parentElement?.className).toContain('h-7')
    view.rerender(card(snapAt({ state: 'applying', files: 3 }, 'waiting')))
    expect(screen.getByTestId('finalize-state').textContent).toBe('Applying to your folder…')
    view.rerender(card(snapAt({ state: 'kept', files: 3 }, 'skipped')))
    expect(screen.getByTestId('finalize-state').textContent).toBe(
      'Kept for later: the isolated copy stays until you apply or discard it.',
    )
    expect(screen.getByTestId('pass-card-finalize').textContent?.includes(EM_DASH)).toBe(false)
  })

  it('an apply core reports while the view is open: a toast with Undo, and Undo beside the line', async () => {
    const view = render(card(snapAt({ state: 'pending', files: 3 })))
    await settle()
    expect(toasts()).toEqual([])
    view.rerender(card(snapAt({ state: 'applied', files: 3, applied: 3, undoToken: 'u-1' }, 'done')))
    await settle()
    expect(toasts()).toHaveLength(1)
    const t = toasts()[0]
    expect(t?.message).toBe('Applied 3 files to your folder')
    expect(t?.id).toBe(`worktree-apply:${RUN}`)
    expect(t?.action?.label).toBe('Undo')
    expect(screen.getByTestId('finalize-state').textContent).toBe('Applied to your folder (3 files).')
    const undo = screen.getByTestId('finalize-undo-apply')
    expect(undo.textContent).toBe('Undo')
    // The same token again (a later snapshot): no second toast.
    view.rerender(card(snapAt({ state: 'applied', files: 3, applied: 3, undoToken: 'u-1' }, 'done')))
    await settle()
    expect(toasts()).toHaveLength(1)
    await act(async () => {
      fireEvent.click(undo)
      await settle()
    })
    expect(mock.callsOf('worktree.undoApply')).toEqual([{ runId: RUN, undoToken: 'u-1' }])
    expect(toasts().map((x) => x.message)).toContain(APPLY_UNDONE)
  })

  it('a discard: a toast with Undo lasting until core deletes the copy; Undo sends core’s discard token', async () => {
    const view = render(card(snapAt({ state: 'pending', files: 3 })))
    await settle()
    const deleteAt = Date.now() + 10_000
    view.rerender(card(snapAt({ state: 'discarding', deleteAt, discardToken: 'd-1' }, 'done')))
    await settle()
    const t = toasts()[0]
    expect(t?.message).toBe(DISCARDED)
    expect(t?.durationMs).toBeGreaterThan(9_000)
    expect(t?.durationMs).toBeLessThanOrEqual(10_000)
    expect(screen.getByTestId('finalize-state').textContent).toBe(
      'Discarding the isolated copy: you can still undo it.',
    )
    await act(async () => {
      if (t?.action !== undefined && 'onClick' in t.action) await t.action.onClick()
      await settle()
    })
    expect(mock.callsOf('worktree.undoDiscard')).toEqual([{ runId: RUN, undoToken: 'd-1' }])
    expect(toasts().map((x) => x.message)).toContain(DISCARD_UNDONE)
    expect(discardToastMs(Number.NaN)).toBe(10_000)
    expect(discardToastMs(Date.now() - 5)).toBe(1000)
  })

  it('a token already there when the card mounts gets no toast (reopening a run repeats nothing)', async () => {
    render(card(snapAt({ state: 'applied', files: 2, applied: 2, undoToken: 'u-old' }, 'done')))
    await settle()
    expect(toasts()).toEqual([])
    expect(screen.getByTestId('finalize-undo-apply')).toBeTruthy()
  })

  it('reads core’s view defensively and words every state', () => {
    expect(finalizeInfoOf(undefined)).toEqual({
      state: null,
      files: null,
      applied: null,
      conflicts: [],
      undoToken: null,
      deleteAt: null,
      discardToken: null,
      error: null,
    })
    const words = (
      [
        'preview',
        'pending',
        'waiting',
        'applying',
        'conflicts',
        'interrupted',
        'applied',
        'kept',
        'undoing',
        'discarding',
        'discarded',
      ] as const
    ).map((state) =>
      finalizeStateText(
        finalizeInfoOf(isolatedSnap({ finalize: finalizeStep({ state, conflicts: ['a'] }) }).steps.finalize),
      ),
    )
    for (const w of words) {
      expect(w).not.toBeNull()
      expect(w?.includes(EM_DASH)).toBe(false)
    }
    expect(finalizeReasonText({ ...isolatedSnap().steps.finalize, status: 'skipped', reason: 'kept' })).toBe(
      'Kept for later',
    )
  })
})
