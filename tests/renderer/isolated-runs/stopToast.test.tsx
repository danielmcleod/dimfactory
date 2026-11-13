// Integration fix ("Stop → cancelled. Toast: Run stopped · changes kept [Revert all]", state-machine row
// R13; a stopped isolated run keeps its copy and its changes are not in the folder): an
// isolated run's Stop toast says where its changes are and offers the Diff tab's "Apply to folder…" panel. Revert all
// is left out: for an isolated run it would revert the copy, never the folder. In-place runs keep their toast.
import '../helpers/rtl.ts'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/run.ts'
import { APPLY_TITLE } from '@renderer/components/diff/text.ts'
import { REVERT_ALL_LABEL } from '@renderer/components/run/revert.ts'
import {
  STOPPED_ISOLATED_APPLIED,
  STOPPED_ISOLATED_CLEAN,
  STOPPED_ISOLATED_MESSAGE,
  STOPPED_MESSAGE,
  UNDO_APPLY_LABEL,
  resetStopWatches,
  watchStop,
} from '@renderer/components/run/stop.ts'
import { setRunEntry, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { setUp, settle, tearDown } from '../dashboard/setup.tsx'
import { finalizeStep, isolatedSnap } from './fixtures.ts'

let mock: MockDimFactory

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.get': () => ({}) as never, 'worktree.undoApply': () => undefined } })
})

afterEach(() => {
  resetStopWatches()
  tearDown(mock)
})

function stopped(runId: string, over: Partial<RunSummary>): void {
  act(() => upsertSummaries([makeSummary({ runId, status: 'cancelled', phase: 'done', ...over })]))
  act(() => watchStop(runId))
}

const toastOf = (runId: string) => useStore.getState().toasts.items.find((t) => t.id === `stopped:${runId}`)

describe('the Stop toast of an isolated run', () => {
  it('its copy kept: says so and offers Apply to folder… (the Diff tab), not Revert all', () => {
    stopped('iso-1', { isolation: 'worktree', worktree: { state: 'kept', notApplied: true } })
    const t = toastOf('iso-1')
    expect(t?.message).toBe(STOPPED_ISOLATED_MESSAGE)
    expect(t?.action?.label).toBe(APPLY_TITLE)
    expect(t?.action?.label).not.toBe(REVERT_ALL_LABEL)
    act(() => {
      if (t?.action !== undefined && 'onClick' in t.action) void t.action.onClick()
    })
    expect(window.location.hash).toBe('#/runs/iso-1/diff')
  })

  it('stopped before its copy was made: says the folder is unchanged, no action', () => {
    stopped('iso-2', { isolation: 'worktree' })
    expect(toastOf('iso-2')?.message).toBe(STOPPED_ISOLATED_CLEAN)
    expect(toastOf('iso-2')?.action).toBeUndefined()
  })

  // Review finding 10: part of the run was applied before the stop, so the folder is not unchanged.
  it('stopped after part of it was applied: says so and offers that apply’s Undo (core’s token)', async () => {
    const snap = isolatedSnap({
      summary: { runId: 'iso-3', status: 'cancelled', phase: 'done' },
      finalize: finalizeStep({ state: 'applied', applied: 1, undoToken: 'apply-7', conflicts: ['b.ts'] }),
    })
    act(() => setRunEntry('iso-3', { snapshot: snap, lastSeq: 1, status: 'ready' }))
    mock.on('runs.get', () => snap)
    stopped('iso-3', { isolation: 'worktree', worktree: { state: 'applied', notApplied: false } })
    const t = toastOf('iso-3')
    expect(t?.message).toBe(STOPPED_ISOLATED_APPLIED)
    expect(t?.message).not.toBe(STOPPED_ISOLATED_CLEAN)
    expect(t?.action?.label).toBe(UNDO_APPLY_LABEL)
    await act(async () => {
      if (t?.action !== undefined && 'onClick' in t.action) await t.action.onClick()
      await settle()
    })
    expect(mock.callsOf('worktree.undoApply')).toEqual([{ runId: 'iso-3', undoToken: 'apply-7' }])
  })

  it('applied, with no snapshot loaded: says so and offers the Apply panel (where the rest is)', () => {
    stopped('iso-4', { isolation: 'worktree', worktree: { state: 'applied', notApplied: false } })
    const t = toastOf('iso-4')
    expect(t?.message).toBe(STOPPED_ISOLATED_APPLIED)
    expect(t?.action?.label).toBe(APPLY_TITLE)
  })

  it('an in-place run keeps "changes kept [Revert all]"', () => {
    stopped('ip-1', { isolation: 'inPlace' })
    const t = toastOf('ip-1')
    expect(t?.message).toBe(STOPPED_MESSAGE)
    expect(t?.action?.label).toBe(REVERT_ALL_LABEL)
  })

  it('no em dash in the new words', () => {
    for (const text of [
      STOPPED_ISOLATED_MESSAGE,
      STOPPED_ISOLATED_CLEAN,
      STOPPED_ISOLATED_APPLIED,
      UNDO_APPLY_LABEL,
    ])
      expect(text).not.toContain(String.fromCharCode(0x2014))
  })
})
