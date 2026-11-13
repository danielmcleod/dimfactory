// Revert all ("Stop → Toast: Run stopped · changes kept [Revert all] (Revert is undoable)", Diff
// tab "Revert … disabled while the folder is busy"; revert to S0; state-machine row R13): the Stop toast's Revert all
// waits while the stopped process is still ending or another run holds the folder (and turns available while the toast
// shows), then diff.revert{runId, paths:'all'} → "Reverted N files" with Undo → diff.undoRevert{runId, undoToken}.
// The same control sits in "After the run" and the Diff tab. A card revert core made (RunSnapshot.revertUndo) offers its
// Undo the same way. Core's errors are toasts; UNSUPPORTED shows "Available in a later version".
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RevertResult } from '@shared/ipc.ts'
import type { RunEnvelope, RunSnapshot, RunSummary } from '@shared/run.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import {
  folderBusyReason,
  otherRunBusy,
  resetRevertForTests,
  revertedText,
  STILL_RECORDING,
  STILL_STOPPING,
  STILL_WORKING,
  UNDONE_MESSAGE,
} from '@renderer/components/run/revert.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { applySnapshot, upsertSummaries } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let current: RunSnapshot
let release: (() => void) | null = null
const log: RunEnvelope[] = []

const RESULT: RevertResult = {
  undoToken: 'undo-1',
  restored: ['src/cli.ts', 'src/version.ts', 'README.md', 'package.json', 'src/a.ts', 'src/b.ts'],
  deleted: ['src/new.ts'],
  skipped: [],
}

const running = (): RunSnapshot =>
  snapWith({
    summary: {
      status: 'running',
      phase: 'implementing',
      progress: { tokens: 10, costUsd: null, filesChanged: 7 },
    },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: { status: 'running', attempt: 1, vendor: 'claude' },
    },
    lastSeq: 1,
  })

const finished = (summary: Partial<RunSummary> = {}): RunSnapshot =>
  snapWith({
    summary: {
      status: 'completed',
      phase: 'done',
      outcome: 'clean',
      endedAt: 1_700_000_900_000,
      progress: { tokens: 10, costUsd: null, filesChanged: 7 },
      ...summary,
    },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: { status: 'done', attempt: 1, vendor: 'claude' },
      review: { status: 'done', attempt: 1, vendor: 'claude' },
      critic: { status: 'skipped', reason: 'disabled' },
      fix: { status: 'skipped', reason: 'no findings' },
    },
    lastSeq: 9,
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  resetRevertForTests()
  setMacForTests(false)
  window.location.hash = ''
  current = running()
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => log),
      'runs.stop': () => undefined,
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
      'diff.revert': () => RESULT,
      'diff.undoRevert': () => undefined,
    },
  })
})

afterEach(() => {
  release?.()
  release = null
  resetStopWatches()
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  setMacForTests(null)
  resetBridgeForTests()
  window.location.hash = ''
})

async function mount(tab: 'flow' | 'diff' = 'flow'): Promise<void> {
  release = startBridge()
  renderUi(<RunPage runId={RUN} tab={tab} />)
  await act(async () => {
    await settle(10)
  })
  await waitFor(() => expect(screen.getByTestId('run-header')).toBeTruthy())
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

async function pushSummary(over: Partial<RunSummary>): Promise<void> {
  await act(async () => {
    mock.push({ kind: 'run-summary', summary: { ...current.summary, ...over } })
    await settle()
  })
}

const toastEl = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-toast-id="${id}"]`)
  if (el === null) throw new Error(`no toast ${id}`)
  return el
}
const toastMessages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)

describe('the Stop toast', () => {
  it('waits while the stopped process is still ending, then reverts all and offers Undo', async () => {
    await mount()
    await click(screen.getByTestId('stop-run'))
    // Core says cancelled while the vendor process is still in its interrupt-then-kill grace (phase stopping).
    await pushSummary({ status: 'cancelled', phase: 'stopping' })
    const toast = toastEl(`stopped:${RUN}`)
    expect(toast.textContent).toContain('Run stopped · changes kept')
    const waiting = within(toast).getByRole<HTMLButtonElement>('button', { name: 'Revert all' })
    expect(waiting.disabled).toBe(true)
    expect(within(toast).getByRole('group', { name: `Revert all ${STILL_STOPPING}` })).toBeTruthy()
    // The process has gone: the same toast's action turns available.
    await pushSummary({ status: 'cancelled', phase: 'done' })
    const revert = within(toastEl(`stopped:${RUN}`)).getByRole<HTMLButtonElement>('button', {
      name: 'Revert all',
    })
    expect(revert.disabled).toBe(false)
    await click(revert)
    expect(mock.callsOf('diff.revert')).toEqual([{ runId: RUN, paths: 'all' }])
    expect(toastMessages()).toContain('Reverted 7 files')
    const reverted = toastEl(`reverted:${RUN}`)
    await click(within(reverted).getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('diff.undoRevert')).toEqual([{ runId: RUN, undoToken: 'undo-1' }])
    expect(toastMessages()).toContain(UNDONE_MESSAGE)
  })

  it('waits while another run holds the folder', async () => {
    await mount()
    await click(screen.getByTestId('stop-run'))
    act(() => {
      upsertSummaries([
        makeSummary({
          runId: 'run-2',
          displayNo: 2,
          status: 'running',
          lock: 'held',
          createdAt: 1_700_000_500_000,
        }),
      ])
    })
    await pushSummary({ status: 'cancelled', phase: 'done' })
    const toast = toastEl(`stopped:${RUN}`)
    expect(within(toast).getByRole('group', { name: `Revert all ${otherRunBusy(2)}` })).toBeTruthy()
    // Run #2 ends: Revert all is available.
    act(() => {
      upsertSummaries([
        makeSummary({
          runId: 'run-2',
          displayNo: 2,
          status: 'completed',
          phase: 'done',
          createdAt: 1_700_000_500_000,
        }),
      ])
    })
    await act(async () => {
      await settle()
    })
    expect(
      within(toastEl(`stopped:${RUN}`)).getByRole<HTMLButtonElement>('button', { name: 'Revert all' })
        .disabled,
    ).toBe(false)
  })
})

describe('folderBusyReason (from core summaries only)', () => {
  const state = (...sums: RunSummary[]) => {
    act(() => upsertSummaries(sums))
    return useStore.getState()
  }

  it('names this run stopping or still working, and another run in the same folder that holds it', () => {
    const me = (over: Partial<RunSummary>) => makeSummary({ runId: RUN, displayNo: 1, ...over })
    expect(folderBusyReason(state(me({ status: 'cancelled', phase: 'stopping' })), RUN)).toBe(STILL_STOPPING)
    expect(folderBusyReason(state(me({ status: 'running', phase: 'implementing' })), RUN)).toBe(STILL_WORKING)
    expect(folderBusyReason(state(me({ status: 'completed', phase: 'done' })), RUN)).toBeUndefined()
    // Ended but still holding the folder lock: Dim Factory is taking the run's last snapshot (R13: the lock goes after).
    expect(folderBusyReason(state(me({ status: 'cancelled', phase: 'done', lock: 'held' })), RUN)).toBe(
      STILL_STOPPING,
    )
    expect(folderBusyReason(state(me({ status: 'completed', phase: 'done', lock: 'held' })), RUN)).toBe(
      STILL_RECORDING,
    )
    expect(folderBusyReason(state(me({ status: 'cancelled', phase: 'done' })), RUN)).toBeUndefined()
    // Waiting on an ask (a step waiting with its process) is working; waiting on a gate or a card is not.
    const ask = [{ key: 'implement' as const, status: 'waiting' as const, activeMs: 0 }]
    const gate = [
      { key: 'review' as const, status: 'done' as const, activeMs: 0 },
      { key: 'fix' as const, status: 'queued' as const, activeMs: 0 },
    ]
    expect(folderBusyReason(state(me({ status: 'waiting', steps: ask })), RUN)).toBe(STILL_WORKING)
    expect(folderBusyReason(state(me({ status: 'waiting', steps: gate })), RUN)).toBeUndefined()
    // Another run: busy while it holds the lock and works or is about to start, or while it stops; not when it only
    // queues for the lock, nor while it waits at a gate.
    const other = (over: Partial<RunSummary>) =>
      makeSummary({ runId: 'run-3', displayNo: 3, createdAt: 1_700_000_100_000, ...over })
    expect(folderBusyReason(state(other({ status: 'waiting', lock: 'held', steps: ask })), RUN)).toBe(
      otherRunBusy(3),
    )
    expect(
      folderBusyReason(state(other({ status: 'waiting', lock: 'held', steps: gate })), RUN),
    ).toBeUndefined()
    expect(folderBusyReason(state(other({ status: 'queued', lock: 'held' })), RUN)).toBe(otherRunBusy(3))
    expect(folderBusyReason(state(other({ status: 'queued', lock: 'requested' })), RUN)).toBeUndefined()
    expect(folderBusyReason(state(other({ status: 'cancelled', phase: 'stopping' })), RUN)).toBe(
      otherRunBusy(3),
    )
    expect(folderBusyReason(state(other({ status: 'paused', lock: 'held' })), RUN)).toBeUndefined()
    // A run in another folder never counts.
    expect(
      folderBusyReason(
        state(
          other({ status: 'running', lock: 'held', folderKey: 'ffffffffffffffff', phase: 'implementing' }),
        ),
        RUN,
      ),
    ).toBeUndefined()
    expect(folderBusyReason(useStore.getState(), 'unknown-run')).toBeUndefined()
  })

  it("the open run's snapshot tells an ask from a card: only a step waiting on an ask works", () => {
    const parked = snapWith({
      summary: { status: 'waiting', phase: 'implementing' },
      steps: { implement: { status: 'waiting', reason: 'folder check', attempt: 1 } },
      lastSeq: 3,
    })
    act(() => {
      applySnapshot(parked)
    })
    expect(folderBusyReason(useStore.getState(), RUN)).toBeUndefined()
    const ask = {
      runId: RUN,
      step: 'implement' as const,
      attempt: 1,
      requestId: 'ask-1',
      vendor: 'claude',
      kind: 'shell' as const,
      detail: 'npm test',
      expiresAt: 1_700_000_600_000,
      allowSession: true,
      queue: { index: 1, total: 1 },
    }
    act(() => {
      applySnapshot({ ...parked, asks: [ask], lastSeq: 4 })
    })
    expect(folderBusyReason(useStore.getState(), RUN)).toBe(STILL_WORKING)
  })
})

describe('Revert all in "After the run" and the Diff tab', () => {
  it('shows "After the run" only once the run has ended, with Revert all', async () => {
    await mount()
    expect(screen.queryByTestId('run-end')).toBeNull()
    current = finished()
    act(() => {
      applySnapshot(current)
    })
    const panel = screen.getByTestId('run-end')
    expect(panel.textContent).toContain('After the run')
    expect(screen.getByTestId('run-end-changes').textContent).toBe(
      "The run's changes (7 files) stay in the folder. Revert all puts it back as it was before the run changed it; you can undo that.",
    )
    // The panel arrives after everything already in the flow.
    const flow = screen.getByTestId('flow-tab')
    expect(flow.lastElementChild).toBe(panel)
    await click(within(panel).getByTestId('revert-all'))
    expect(mock.callsOf('diff.revert')).toEqual([{ runId: RUN, paths: 'all' }])
    expect(toastMessages()).toContain('Reverted 7 files')
  })

  it("keeps a card revert's Undo once the run has ended (RunSnapshot.revertUndo)", async () => {
    current = {
      ...finished(),
      revertUndo: { undoToken: 'revert-2', label: 'your edits outside the run', files: 1, at: 2 },
    }
    await mount()
    const line = screen.getByTestId('run-end-revert-undo')
    expect(line.textContent).toContain('Reverted your edits outside the run (1 file). You can undo that.')
    await click(within(line).getByTestId('run-end-undo'))
    expect(mock.callsOf('diff.undoRevert')).toEqual([{ runId: RUN, undoToken: 'revert-2' }])
    expect(toastMessages()).toContain('Revert undone: your edits outside the run are back')
  })

  it('says the run made no changes, with Revert all disabled', async () => {
    current = finished({ outcome: 'no-changes', progress: { tokens: 1, costUsd: null, filesChanged: 0 } })
    await mount()
    expect(screen.getByTestId('run-end-changes').textContent).toBe('The run made no changes to the folder.')
    expect(screen.getByTestId<HTMLButtonElement>('revert-all').disabled).toBe(true)
    expect(screen.getByRole('group', { name: 'Revert all The run made no changes' })).toBeTruthy()
  })

  it('says so too for a run stopped at the plan gate (Implement never ran, no files changed)', async () => {
    current = snapWith({
      summary: {
        status: 'cancelled',
        phase: 'done',
        progress: { tokens: 1, costUsd: null, filesChanged: 0 },
      },
      steps: { plan: { status: 'done', attempt: 1 }, implement: { status: 'cancelled' } },
      lastSeq: 4,
    })
    await mount()
    expect(screen.getByTestId('run-end-changes').textContent).toBe('The run made no changes to the folder.')
    expect(screen.getByTestId<HTMLButtonElement>('revert-all').disabled).toBe(true)
  })

  it('in the Diff tab: disabled while the run works in the folder, available once it ended', async () => {
    await mount('diff')
    const button = screen.getByTestId<HTMLButtonElement>('diff-revert-all')
    expect(button.disabled).toBe(true)
    expect(screen.getByRole('group', { name: `Revert all ${STILL_WORKING}` })).toBeTruthy()
    current = finished()
    act(() => {
      applySnapshot(current)
    })
    const ready = screen.getByTestId<HTMLButtonElement>('diff-revert-all')
    expect(ready.disabled).toBe(false)
    await click(ready)
    expect(mock.callsOf('diff.revert')).toEqual([{ runId: RUN, paths: 'all' }])
  })

  it("shows core's FOLDER_BUSY message", async () => {
    mock.on('diff.revert', () => {
      throw mockError('FOLDER_BUSY', 'Run #4 is working in this folder. Revert when it ends.')
    })
    current = finished()
    await mount()
    await click(screen.getByTestId('revert-all'))
    expect(toastMessages()).toContain('Run #4 is working in this folder. Revert when it ends.')
    expect(screen.getByTestId<HTMLButtonElement>('revert-all').disabled).toBe(false)
  })

  it('a core without diff.revert: says so once and shows the reason from then on', async () => {
    mock.on('diff.revert', () => {
      throw mockError('UNSUPPORTED', 'diff.revert is not available')
    })
    current = finished()
    await mount()
    await click(screen.getByTestId('revert-all'))
    expect(toastMessages()).toContain('Revert all: available in a later version.')
    expect(screen.getByTestId<HTMLButtonElement>('revert-all').disabled).toBe(true)
    expect(screen.getByRole('group', { name: 'Revert all Available in a later version' })).toBeTruthy()
  })
})

describe("the toast's words", () => {
  it('counts restored and deleted files, says what was skipped, and offers no Undo when nothing changed', async () => {
    expect(revertedText(RESULT)).toBe('Reverted 7 files')
    expect(revertedText({ ...RESULT, restored: ['a'], deleted: [] })).toBe('Reverted 1 file')
    expect(revertedText({ ...RESULT, skipped: [{ path: 'vendor/lib', reason: 'gitlink' }] })).toBe(
      'Reverted 7 files · 1 skipped',
    )
    mock.on('diff.revert', () => ({ undoToken: 'u0', restored: [], deleted: [], skipped: [] }))
    current = finished()
    await mount()
    await click(screen.getByTestId('revert-all'))
    const t = useStore.getState().toasts.items.find((x) => x.id === `reverted:${RUN}`)
    expect(t?.message).toBe('No files needed reverting')
    expect(t?.action).toBeUndefined()
  })
})

describe('a card revert core made (RunSnapshot.revertUndo)', () => {
  it('offers Undo for a revert that appears while the view is open, once; it waits while the run works', async () => {
    current = { ...running(), revertUndo: { undoToken: 'old', label: 'an earlier change', files: 1, at: 1 } }
    await mount()
    // One already there when the view opened is not offered again.
    expect(useStore.getState().toasts.items.find((x) => x.id === `revert-undo:${RUN}`)).toBeUndefined()
    current = {
      ...current,
      lastSeq: 5,
      revertUndo: { undoToken: 'r-7', label: "Plan's changes", files: 2, at: 2 },
    }
    act(() => {
      applySnapshot(current)
    })
    await act(async () => {
      await settle()
    })
    expect(toastMessages()).toContain("Reverted Plan's changes")
    // The run still works in the folder: Undo waits, with the reason.
    const waitingUndo = within(toastEl(`revert-undo:${RUN}`)).getByRole<HTMLButtonElement>('button', {
      name: 'Undo',
    })
    expect(waitingUndo.disabled).toBe(true)
    expect(screen.getByRole('group', { name: `Undo ${STILL_WORKING}` })).toBeTruthy()
    // The run waits at the plan gate (no process in the folder): Undo is available while the toast shows.
    current = {
      ...current,
      lastSeq: 6,
      summary: { ...current.summary, status: 'waiting', phase: 'plan-review' },
      steps: { ...current.steps, implement: { ...current.steps.implement, status: 'queued' } },
    }
    act(() => {
      applySnapshot(current)
    })
    await act(async () => {
      await settle()
    })
    await click(within(toastEl(`revert-undo:${RUN}`)).getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('diff.undoRevert')).toEqual([{ runId: RUN, undoToken: 'r-7' }])
    expect(toastMessages()).toContain("Revert undone: Plan's changes are back")
    // The same revert in a later snapshot is not offered again.
    act(() => {
      applySnapshot({ ...current, lastSeq: 7 })
    })
    await act(async () => {
      await settle()
    })
    expect(
      useStore.getState().toasts.items.filter((x) => x.message === "Reverted Plan's changes"),
    ).toHaveLength(0)
  })
})
