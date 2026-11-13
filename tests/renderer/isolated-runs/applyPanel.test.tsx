// The Diff tab's "Apply to folder…" (all files or reviewed only; Apply: a file whose folder content no longer equals
// the base is a conflict, never overwritten; Undo restores the folder; the worktree starts from HEAD). Core's
// preview (worktree.preview) is counted for the files chosen in one reserved line; Apply sends every file or the
// reviewed ones (worktree.apply paths); its toast says what core applied and left, with Undo (worktree.undoApply); the
// conflicts open on a click; a disabled Apply says why (the run still working, the copy discarded, nothing reviewed,
// a core without worktree commands).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileChange, WorktreePreview } from '@shared/ipc.ts'
import type { RunSnapshot } from '@shared/run.ts'
import {
  APPLY_DISCARDED,
  APPLY_NONE_REVIEWED,
  APPLY_REVIEWED_EARLIER,
  APPLY_RUN_WORKING,
  ApplyPanel,
  applyCounts,
  applyCountsText,
  DISCARD_COPY_LABEL,
  DISCARD_INTERRUPTED,
  PREVIEW_LOADING,
} from '@renderer/components/diff/ApplyPanel.tsx'
import {
  appliedText,
  APPLY_UNDONE,
  DISCARDED,
  DISCARD_UNDONE,
  resetWorktreeForTests,
} from '@renderer/components/run/worktree.ts'
import { LATER_VERSION } from '@renderer/components/ui/DisabledHint.tsx'
import { useStore } from '@renderer/state/store.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { change } from '../diff/helpers.tsx'
import { RUN } from '../run/helpers.tsx'
import { finalizeStep, isolatedSnap } from './fixtures.ts'

let mock: MockDimFactory
let preview: WorktreePreview

const A = change('src/a.ts')
const B = change('src/b.ts')
const GONE: FileChange = { ...change('old.txt'), status: 'D' }

const ended = (over: Parameters<typeof isolatedSnap>[0] = {}): RunSnapshot =>
  isolatedSnap({
    summary: { status: 'completed', phase: 'done', outcome: 'clean' },
    prepare: { status: 'done', attempt: 1 },
    ...over,
  })

beforeEach(() => {
  resetWorktreeForTests()
  preview = { files: [A, B, GONE], conflicts: ['src/b.ts'] }
  mock = setUp({
    handlers: {
      'worktree.preview': () => preview,
      'worktree.apply': (req) => ({
        applied: (req.paths ?? ['src/a.ts', 'old.txt']).filter((p) => p !== 'src/b.ts'),
        conflicts: req.paths === undefined || req.paths.includes('src/b.ts') ? ['src/b.ts'] : [],
        undoToken: 'apply-1',
      }),
      'worktree.undoApply': () => undefined,
      'worktree.discard': () => ({ undoToken: 'discard-1', deleteAt: Date.now() + 10_000 }),
      'worktree.undoDiscard': () => undefined,
      'runs.get': () => ended(),
    },
  })
})

afterEach(() => {
  tearDown(mock)
  resetWorktreeForTests()
})

const toasts = () => useStore.getState().toasts.items

function mount(snap: RunSnapshot = ended(), reviewed: readonly string[] = ['src/a.ts']) {
  return render(
    <Providers>
      <ApplyPanel snap={snap} reviewed={new Set(reviewed)} refreshKey="k" />
    </Providers>,
  )
}

const facts = (): string => screen.getByTestId('diff-apply-facts').textContent ?? ''
const apply = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('diff-apply')

describe('Apply to folder…', () => {
  it('counts core’s preview for all files or the reviewed ones, in one reserved line, its words changing in place', async () => {
    const gate = deferred<WorktreePreview>()
    mock.on('worktree.preview', () => gate.promise)
    mount()
    expect(facts()).toBe(PREVIEW_LOADING)
    expect(screen.getByTestId('diff-apply-facts').parentElement?.className).toContain('h-5')
    // The counts keep one width while core answers.
    expect(screen.getByTestId('diff-apply-panel').textContent).toContain('All files (…)')
    await act(async () => {
      gate.resolve(preview)
      await settle()
    })
    expect(screen.getByTestId('diff-apply-panel').textContent).toContain('All files (3 files)')
    expect(screen.getByTestId('diff-apply-panel').textContent).toContain('Reviewed files only (1 file)')
    expect(facts()).toBe('1 file to write · 1 to delete · 1 conflict')
    fireEvent.click(screen.getByTestId('diff-apply-reviewed'))
    expect(facts()).toBe('1 file to write')
    expect(applyCountsText(applyCounts(preview, new Set()))).toBe('No files to apply.')
  })

  it('Apply sends all files, then only the reviewed ones; the toast says what core applied and left, with Undo', async () => {
    mount()
    await settle()
    expect(facts()).toContain('to write')
    await act(async () => {
      fireEvent.click(apply())
      await settle()
    })
    expect(mock.callsOf('worktree.apply')).toEqual([{ runId: RUN }])
    const t = toasts()[0]
    expect(t?.message).toBe('Applied 2 files to your folder · 1 conflict to choose')
    expect(t?.level).toBe('warn')
    expect(t?.action?.label).toBe('Undo')
    await act(async () => {
      if (t?.action !== undefined && 'onClick' in t.action) await t.action.onClick()
      await settle()
    })
    expect(mock.callsOf('worktree.undoApply')).toEqual([{ runId: RUN, undoToken: 'apply-1' }])
    expect(toasts().map((x) => x.message)).toContain(APPLY_UNDONE)

    fireEvent.click(screen.getByTestId('diff-apply-reviewed'))
    await act(async () => {
      fireEvent.click(apply())
      await settle()
    })
    // Core picks the reviewed files (a mark that names the version Apply writes).
    expect(mock.callsOf('worktree.apply').at(-1)).toEqual({ runId: RUN, reviewedOnly: true })
    expect(appliedText({ applied: [], conflicts: [] })).toBe(
      "Nothing to apply: your folder already has the run's changes.",
    )
  })

  it('counts core’s own per-path actions when it sends them (already the same, left alone), with a conflict’s reason', async () => {
    preview = {
      files: [A, B, GONE],
      conflicts: ['src/b.ts'],
      actions: [
        { path: 'src/a.ts', action: 'noop' },
        { path: 'src/b.ts', action: 'conflict', reason: 'changed in your folder since the run started' },
        { path: 'old.txt', action: 'skip', reason: 'a link is in the place of its folder' },
      ],
    }
    mount()
    await settle()
    expect(facts()).toBe('1 already the same · 1 conflict · 1 left alone')
    fireEvent.click(screen.getByTestId('diff-apply-conflicts-toggle'))
    expect(screen.getByTestId('diff-apply-conflicts').textContent).toContain(
      'src/b.tschanged in your folder since the run started',
    )
    expect(
      appliedText({ applied: ['src/a.ts'], conflicts: [], skipped: [{ path: 'old.txt', reason: 'x' }] }),
    ).toBe('Applied 1 file to your folder · 1 left alone')
  })

  it('lists the conflicts on a click (never on its own)', async () => {
    mount()
    await settle()
    expect(facts()).toContain('1 conflict')
    expect(screen.queryByTestId('diff-apply-conflicts')).toBeNull()
    const toggle = screen.getByTestId('diff-apply-conflicts-toggle')
    expect(toggle.querySelector('[data-stable-label]')).not.toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByTestId('diff-apply-conflicts').textContent).toContain('src/b.ts')
    expect(screen.getByTestId('diff-apply-conflicts').textContent).toContain('Keep mine or Take run')
  })

  it('a disabled Apply says why: the run still working, the copy discarded, nothing reviewed', async () => {
    const view = mount(isolatedSnap({ summary: { status: 'running', phase: 'implementing' } }))
    await settle()
    expect(apply().disabled).toBe(true)
    expect(apply().closest('[data-disabled-hint]')?.textContent).toContain(APPLY_RUN_WORKING)
    view.unmount()

    // At the finalize card the run waits: Apply is live.
    const atCard = mount(
      isolatedSnap({
        summary: { status: 'waiting', phase: 'ready-to-apply' },
        finalize: finalizeStep({ state: 'pending' }),
      }),
    )
    await settle()
    expect(facts()).toContain('to write')
    expect(apply().disabled).toBe(false)
    atCard.unmount()

    const discarded = mount(ended({ finalize: finalizeStep({ state: 'discarded' }, { status: 'done' }) }))
    await settle()
    expect(apply().closest('[data-disabled-hint]')?.textContent).toContain(APPLY_DISCARDED)
    discarded.unmount()

    mount(ended(), [])
    await settle()
    expect(facts()).toContain('to write')
    fireEvent.click(screen.getByTestId('diff-apply-reviewed'))
    expect(apply().closest('[data-disabled-hint]')?.textContent).toContain(APPLY_NONE_REVIEWED)
    // The button keeps its label whatever the reason.
    expect(apply().textContent).toBe('Apply')
  })

  // Review finding 13: the count is core's (marks in any segment that name the blob Apply writes), not the
  // segment on screen, and Apply sends reviewedOnly so core applies exactly those.
  it('"Reviewed files only" counts core’s reviewed files and sends reviewedOnly', async () => {
    preview = { files: [A, B, GONE], conflicts: [], reviewed: ['src/b.ts', 'old.txt'] }
    mount(ended(), ['src/a.ts'])
    await settle()
    expect(screen.getByTestId('diff-apply-panel').textContent).toContain('Reviewed files only (2 files)')
    fireEvent.click(screen.getByTestId('diff-apply-reviewed'))
    expect(facts()).toBe('1 file to write · 1 to delete')
    await act(async () => {
      fireEvent.click(apply())
      await settle()
    })
    expect(mock.callsOf('worktree.apply')).toEqual([{ runId: RUN, reviewedOnly: true }])
  })

  it('marks on screen that name an earlier version count for nothing, and Apply says why', async () => {
    preview = { files: [A, B, GONE], conflicts: [], reviewed: [] }
    mount(ended(), ['src/a.ts'])
    await settle()
    expect(screen.getByTestId('diff-apply-panel').textContent).toContain('Reviewed files only (0 files)')
    fireEvent.click(screen.getByTestId('diff-apply-reviewed'))
    expect(apply().closest('[data-disabled-hint]')?.textContent).toContain(APPLY_REVIEWED_EARLIER)
  })

  // Review finding 15: a kept or stopped run's copy can be discarded from here, deferred 10 s with Undo.
  it('[Discard copy] sends worktree.discard; its toast offers Undo (worktree.undoDiscard)', async () => {
    mount()
    await settle()
    const discard = screen.getByTestId<HTMLButtonElement>('diff-discard')
    expect(discard.textContent).toBe(DISCARD_COPY_LABEL)
    expect(discard.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(discard)
      await settle()
    })
    expect(mock.callsOf('worktree.discard')).toEqual([{ runId: RUN }])
    const t = toasts().find((x) => x.message === DISCARDED)
    expect(t?.action?.label).toBe('Undo')
    await act(async () => {
      if (t?.action !== undefined && 'onClick' in t.action) await t.action.onClick()
      await settle()
    })
    expect(mock.callsOf('worktree.undoDiscard')).toEqual([{ runId: RUN, undoToken: 'discard-1' }])
    expect(toasts().map((x) => x.message)).toContain(DISCARD_UNDONE)
  })

  it('[Discard copy] is disabled with why: the run still working, an apply to finish, the copy discarded', async () => {
    const discardBtn = (): HTMLButtonElement => screen.getByTestId<HTMLButtonElement>('diff-discard')
    const working = mount(isolatedSnap({ summary: { status: 'running', phase: 'implementing' } }))
    await settle()
    expect(discardBtn().closest('[data-disabled-hint]')?.textContent).toContain(APPLY_RUN_WORKING)
    working.unmount()
    const open = mount(ended({ finalize: finalizeStep({ state: 'interrupted' }, { status: 'waiting' }) }))
    await settle()
    expect(discardBtn().closest('[data-disabled-hint]')?.textContent).toContain(DISCARD_INTERRUPTED)
    open.unmount()
    mount(ended({ finalize: finalizeStep({ state: 'discarded' }, { status: 'done' }) }))
    await settle()
    expect(discardBtn().closest('[data-disabled-hint]')?.textContent).toContain(APPLY_DISCARDED)
    expect(discardBtn().textContent).toBe(DISCARD_COPY_LABEL)
  })

  it('a core without worktree commands: "Available in a later version", remembered for the session', async () => {
    mock.on('worktree.preview', () => {
      throw mockError('UNSUPPORTED', 'worktree.preview is not available in this build.')
    })
    mock.on('worktree.apply', () => {
      throw mockError('UNSUPPORTED', 'worktree.apply is not available in this build.')
    })
    mount()
    await settle()
    // The preview's UNSUPPORTED is remembered: Apply and the radios say it is for a later version, and nothing is sent.
    expect(apply().disabled).toBe(true)
    expect(apply().closest('[data-disabled-hint]')?.textContent).toContain(LATER_VERSION)
    expect(facts()).toBe(LATER_VERSION)
    for (const r of screen.getAllByRole<HTMLInputElement>('radio')) expect(r.disabled).toBe(true)
    expect(mock.callsOf('worktree.apply')).toEqual([])
  })

  it('another refusal of the preview is shown in core’s words; Apply stays offered (core checks again)', async () => {
    mock.on('worktree.preview', () => {
      throw mockError('NOT_FOUND', 'The isolated copy of run #1 is gone.')
    })
    mount()
    await settle()
    expect(facts()).toBe(
      'Dim Factory could not compare with your folder: The isolated copy of run #1 is gone.',
    )
    expect(apply().disabled).toBe(false)
  })
})
