// The Run view's Diff tab (diffs, revert to S0; diff.spec.ts): the toolbar
// (only the segments core has, Split | Stacked, Ignore line endings, Mark all reviewed, Revert all), reviewed marks
// sent to core and kept through a re-render from new data, files laid out only near the view, files over 3000 lines
// collapsed, each special row, a file's Revert with its Undo toast, disabled while the folder is busy (and for a saved
// patch) with the reason, the isolated run's Apply panel (live; its cases in tests/renderer/isolated-runs), and J/K/R/S.
// Review fixes: while the run goes on, a list core sends that would move the page waits for [Show the latest changes];
// the list's open default is fixed when it first shows; a drawn diff stays until its replacement has drawn; an added
// file's estimate has no context rows;
// R / J / K act on the file in view (never a file out of sight) and never from a menu or the toasts. The @pierre/diffs
// view is replaced by a stand-in that shows what it was given (its own smoke test is patchView.test.tsx).
import '../helpers/rtl.ts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffBlob, DiffFilePatch, DiffFiles, Req, RevertResult } from '@shared/ipc.ts'
import type { RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { clearPatchCache } from '@renderer/components/diff/patches.ts'
import { resetDiffPrefs } from '@renderer/components/diff/prefs.ts'
import { GITLINK_REVERT_REASON, NEWER_CHANGES_TEXT } from '@renderer/components/diff/text.ts'
import { clearOutputCache } from '@renderer/components/run/outputs.ts'
import { STILL_WORKING, resetRevertForTests } from '@renderer/components/run/revert.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { resetBridgeForTests, startBridge } from '@renderer/ipc/bridge.ts'
import { resetShortcuts, setMacForTests } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { ISOLATED_REVERT_REASON } from '@renderer/pages/run/DiffTab.tsx'
import { RunPage } from '@renderer/pages/run/RunPage.tsx'
import { applySnapshot } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore, useStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { deferred, installMockDimFactory, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'
import { bringNear, change, fakeView, files, installFakeIO, patchFor } from './helpers.tsx'

vi.mock('@renderer/components/diff/PatchView.tsx', async () => {
  const h = await import('./helpers.tsx')
  return { PatchView: h.FakePatchView }
})

let mock: MockDimFactory
let current: RunSnapshot
let list: DiffFiles
let release: (() => void) | null = null
let restoreIO: () => void
const log: RunEnvelope[] = []

const REVERTED: RevertResult = { undoToken: 'undo-file-1', restored: ['src/a.ts'], deleted: [], skipped: [] }

const finished = (): RunSnapshot =>
  snapWith({
    summary: {
      status: 'completed',
      phase: 'done',
      outcome: 'clean',
      endedAt: 1_700_000_900_000,
      progress: { tokens: 10, costUsd: null, filesChanged: 2 },
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

const running = (): RunSnapshot =>
  snapWith({
    summary: {
      status: 'running',
      phase: 'reviewing',
      progress: { tokens: 10, costUsd: null, filesChanged: 2 },
    },
    steps: {
      preflight: { status: 'done', attempt: 1 },
      plan: { status: 'done', attempt: 1, vendor: 'claude' },
      implement: { status: 'done', attempt: 1, vendor: 'claude' },
      review: { status: 'running', attempt: 1, vendor: 'claude' },
    },
    lastSeq: 9,
  })

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  clearOutputCache()
  clearPatchCache()
  resetDiffPrefs()
  resetRevertForTests()
  setMacForTests(false)
  restoreIO = installFakeIO()
  fakeView.draws = true
  fakeView.held.length = 0
  window.location.hash = ''
  current = finished()
  list = files([change('src/a.ts'), change('src/b.ts', { added: 2, deleted: 1 })])
  mock = installMockDimFactory({
    handlers: {
      'runs.get': () => current,
      'runs.events': eventsHandler(() => log),
      'runs.output': () => {
        throw mockError('NOT_FOUND', 'none')
      },
      'diff.files': (req) => ({ ...list, seg: req.seg }),
      'diff.file': (req): DiffFilePatch => ({ patch: patchFor(req.path), truncated: false }),
      'diff.markReviewed': () => undefined,
      'diff.revert': () => REVERTED,
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
  restoreIO()
  window.location.hash = ''
})

async function mount(): Promise<void> {
  release = startBridge()
  renderUi(<RunPage runId={RUN} tab="diff" />)
  await act(async () => {
    await settle(10)
  })
  await waitFor(() => expect(screen.getByTestId('diff-files')).toBeTruthy())
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await settle()
  })
}

/** Press a single key with focus where it is (or on <body>). */
async function press(
  key: string,
  target: EventTarget = document.activeElement ?? document.body,
): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settle()
  })
}

const section = (path: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`article[data-path="${path}"]`)
  if (el === null) throw new Error(`no section for ${path}`)
  return el
}

/** The section comes near the page scroller's view: its body may ask core and lay out. */
async function near(path: string): Promise<void> {
  await act(async () => {
    bringNear(section(path))
    await settle(10)
  })
}

/** Core's list changes while the tab is open (a new snapshot): the refresh key moves. */
async function newSnapshot(filesChanged: number): Promise<void> {
  current = {
    ...current,
    summary: { ...current.summary, progress: { ...current.summary.progress, filesChanged } },
  }
  await act(async () => {
    applySnapshot(current)
    await settle(10)
  })
}

const toastMessages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
const toastEl = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-toast-id="${id}"]`)
  if (el === null) throw new Error(`no toast ${id}`)
  return el
}
const headerCheck = (path: string): HTMLElement => within(section(path)).getByTestId('diff-file-reviewed')
const shownPaths = (): string[] =>
  [...document.querySelectorAll('article[data-testid="diff-file"]')].map(
    (el) => el.getAttribute('data-path') ?? '',
  )

/**
 * Lay the file sections out as the page would (happy-dom lays nothing out): each 280 px tall, 300 px apart from
 * 100 px, moved up by `layout.scrolled` (the wheel). The reading area is the window (no sticky bars here).
 */
const layout = { scrolled: 0 }
function layOut(): void {
  layout.scrolled = 0
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const m = /^diff-file-(\d+)$/.exec(this.id)
    // Nothing else is laid out here (happy-dom's own answer is all zeros too).
    if (m === null || this.getAttribute('data-testid') !== 'diff-file') return new DOMRect(0, 0, 0, 0)
    return new DOMRect(0, 100 + Number(m[1]) * 300 - layout.scrolled, 800, 280)
  })
}
const checked = (el: HTMLElement): boolean => el.getAttribute('data-state') === 'checked'

// ---- the toolbar ------------------------------------------------------------------------------------------------

describe('toolbar', () => {
  it('offers only the segments core says the run has, shows Combined first, and fetches a segment when chosen', async () => {
    await mount()
    const segs = screen.getByRole('radiogroup', { name: 'Changes from' })
    expect(
      within(segs)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Implement', 'Combined'])
    expect(within(segs).getByRole('radio', { name: 'Combined' }).getAttribute('aria-checked')).toBe('true')
    expect(mock.callsOf('diff.files')).toEqual([{ runId: RUN, seg: 'combined' }])
    await click(within(segs).getByRole('radio', { name: 'Implement' }))
    expect(mock.callsOf('diff.files').at(-1)).toEqual({ runId: RUN, seg: 'implement' })
    expect(screen.getByTestId('diff-tab').getAttribute('data-segment')).toBe('implement')
    expect(within(segs).getByRole('radio', { name: 'Implement' }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows Fix once core lists it, and says what the segment changed', async () => {
    list = files([change('src/a.ts'), change('src/b.ts', { added: 2, deleted: 1 })], {
      available: ['implement', 'fix', 'combined'],
    })
    await mount()
    const segs = screen.getByRole('radiogroup', { name: 'Changes from' })
    expect(
      within(segs)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Implement', 'Fix', 'Combined'])
    // E2E reads "N files changed" here as it always has.
    expect(screen.getByTestId('diff-summary').textContent).toBe('2 files changed · +5 −2')
  })

  it('Split | Stacked lays every diff out again, and S switches it too', async () => {
    await mount()
    await near('src/a.ts')
    const view = (): HTMLElement => within(section('src/a.ts')).getByTestId('patch-view')
    expect(view().getAttribute('data-layout')).toBe('split')
    await click(within(screen.getByTestId('diff-layout')).getByRole('radio', { name: 'Stacked' }))
    expect(view().getAttribute('data-layout')).toBe('stacked')
    await press('s', document.body)
    expect(view().getAttribute('data-layout')).toBe('split')
    expect(screen.getByTestId('diff-layout').getAttribute('aria-keyshortcuts')).toBe('S')
  })

  it('Ignore line endings asks core for the patch without them', async () => {
    await mount()
    await near('src/a.ts')
    expect(mock.callsOf('diff.file')).toEqual([{ runId: RUN, seg: 'combined', path: 'src/a.ts' }])
    await click(screen.getByTestId('diff-ignore-eol'))
    await waitFor(() =>
      expect(mock.callsOf('diff.file').at(-1)).toEqual({
        runId: RUN,
        seg: 'combined',
        path: 'src/a.ts',
        ignoreEol: true,
      }),
    )
  })

  it("keeps the theme the app shows: the view gets the app's light or dark", async () => {
    await mount()
    await near('src/a.ts')
    expect(within(section('src/a.ts')).getByTestId('patch-view').getAttribute('data-theme')).toBe('light')
  })
})

// ---- reviewed marks ---------------------------------------------------------------------------------------------

describe('reviewed marks', () => {
  it('a checkbox marks the file reviewed through core, for the segment shown, in the header and the list', async () => {
    await mount()
    await click(headerCheck('src/a.ts'))
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/a.ts'], reviewed: true },
    ])
    expect(checked(headerCheck('src/a.ts'))).toBe(true)
    expect(checked(screen.getByRole('checkbox', { name: 'Reviewed: src/a.ts' }))).toBe(true)
    expect(screen.getByTestId('diff-reviewed-count').textContent).toBe('2 files · 1 of 2 reviewed')
    // From the list too.
    await click(screen.getByRole('checkbox', { name: 'Reviewed: src/b.ts' }))
    expect(mock.callsOf('diff.markReviewed').at(-1)).toEqual({
      runId: RUN,
      seg: 'combined',
      paths: ['src/b.ts'],
      reviewed: true,
    })
    expect(checked(headerCheck('src/b.ts'))).toBe(true)
  })

  it("shows core's reviewed marks (review-state.json, so they last across a reload)", async () => {
    list = files([change('src/a.ts'), change('src/b.ts')], { reviewed: ['src/b.ts'] })
    await mount()
    expect(checked(headerCheck('src/a.ts'))).toBe(false)
    expect(checked(headerCheck('src/b.ts'))).toBe(true)
  })

  it('a mark survives a list core fetched before it was stored, then follows core again', async () => {
    await mount()
    // A refetch goes out (a new snapshot) and core holds its answer, made before the mark.
    const held = deferred<DiffFiles>()
    mock.on('diff.files', () => held.promise)
    await newSnapshot(3)
    await click(headerCheck('src/a.ts'))
    expect(checked(headerCheck('src/a.ts'))).toBe(true)
    await act(async () => {
      held.resolve(files([change('src/a.ts'), change('src/b.ts')], { reviewed: [] }))
      await settle(10)
    })
    expect(checked(headerCheck('src/a.ts'))).toBe(true)
    // The next list carries the mark: still checked.
    mock.on('diff.files', () => files([change('src/a.ts'), change('src/b.ts')], { reviewed: ['src/a.ts'] }))
    await newSnapshot(4)
    expect(checked(headerCheck('src/a.ts'))).toBe(true)
    // Core's word from then on: unmarked elsewhere, unmarked here.
    mock.on('diff.files', () => files([change('src/a.ts'), change('src/b.ts')], { reviewed: [] }))
    await newSnapshot(5)
    expect(checked(headerCheck('src/a.ts'))).toBe(false)
  })

  it("while another segment's list loads, the shown files keep their own segment (marks and diffs)", async () => {
    await mount()
    const held = deferred<DiffFiles>()
    mock.on('diff.files', () => held.promise)
    await click(within(screen.getByTestId('diff-segments')).getByRole('radio', { name: 'Implement' }))
    expect(screen.getByTestId('diff-tab').getAttribute('aria-busy')).toBe('true')
    await near('src/a.ts')
    expect(mock.callsOf('diff.file')).toEqual([{ runId: RUN, seg: 'combined', path: 'src/a.ts' }])
    await click(headerCheck('src/a.ts'))
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/a.ts'], reviewed: true },
    ])
    await act(async () => {
      held.resolve(files([change('src/a.ts')], { seg: 'implement' }))
      await settle(10)
    })
    expect(screen.getByTestId('diff-tab').getAttribute('aria-busy')).toBe('false')
    // The Implement list has its own marks: the Combined mark is not shown on it.
    expect(checked(headerCheck('src/a.ts'))).toBe(false)
    await waitFor(() =>
      expect(mock.callsOf('diff.file').at(-1)).toEqual({ runId: RUN, seg: 'implement', path: 'src/a.ts' }),
    )
  })

  it("a mark core refuses goes back, with core's message", async () => {
    mock.on('diff.markReviewed', () => {
      throw mockError('STORAGE', 'Could not write review-state.json.')
    })
    await mount()
    await click(headerCheck('src/a.ts'))
    expect(checked(headerCheck('src/a.ts'))).toBe(false)
    expect(toastMessages()).toContain('Could not write review-state.json.')
  })

  it('Mark all reviewed marks every unreviewed file, offers Undo, then waits with its reason', async () => {
    list = files([change('src/a.ts'), change('src/b.ts'), change('src/c.ts')], { reviewed: ['src/b.ts'] })
    await mount()
    await click(screen.getByTestId('diff-mark-all'))
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/a.ts', 'src/c.ts'], reviewed: true },
    ])
    expect(toastMessages()).toContain('Marked 2 files reviewed')
    const all = screen.getByTestId<HTMLButtonElement>('diff-mark-all')
    expect(all.disabled).toBe(true)
    expect(
      screen.getByRole('group', { name: 'Mark all reviewed Every file is marked reviewed.' }),
    ).toBeTruthy()
    await click(within(toastEl(`diff-marked:${RUN}`)).getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('diff.markReviewed').at(-1)).toEqual({
      runId: RUN,
      seg: 'combined',
      paths: ['src/a.ts', 'src/c.ts'],
      reviewed: false,
    })
    expect(checked(headerCheck('src/a.ts'))).toBe(false)
    expect(checked(headerCheck('src/b.ts'))).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('diff-mark-all').disabled).toBe(false)
  })
})

// ---- lazy files and large ones ----------------------------------------------------------------------------------

describe('lazy files', () => {
  it('only files near the view ask core for their diff and lay it out', async () => {
    list = files([change('src/a.ts'), change('src/b.ts'), change('src/c.ts')])
    await mount()
    expect(mock.callsOf('diff.file')).toEqual([])
    expect(screen.queryAllByTestId('patch-view')).toHaveLength(0)
    // Out of view, a section holds its estimated height and the browser skips laying it out.
    expect(section('src/a.ts').style.contentVisibility).toBe('auto')
    expect(section('src/a.ts').style.containIntrinsicSize).toMatch(/^auto \d+px$/)
    await near('src/b.ts')
    expect(mock.callsOf('diff.file')).toEqual([{ runId: RUN, seg: 'combined', path: 'src/b.ts' }])
    expect(screen.getAllByTestId('patch-view')).toHaveLength(1)
    expect(within(section('src/b.ts')).getByTestId('patch-view').textContent).toContain('+const b = 3')
    expect(within(section('src/a.ts')).queryByTestId('patch-view')).toBeNull()
    expect(within(section('src/c.ts')).queryByTestId('patch-view')).toBeNull()
  })

  it('a body keeps its estimated height until its diff has drawn, so nothing below it jumps', async () => {
    list = files([change('src/a.ts', { added: 10, deleted: 2 })])
    fakeView.draws = false
    await mount()
    // Not near yet: a placeholder at the estimate (rows of the split layout and a few for context).
    const estimate = `${(10 + 8) * 20 + 16}px`
    expect(within(section('src/a.ts')).getByTestId('diff-pending').style.minHeight).toBe(estimate)
    await near('src/a.ts')
    const view = within(section('src/a.ts')).getByTestId('diff-view')
    expect(view.style.minHeight).toBe(estimate)
    expect(within(view).getByTestId('patch-view')).toBeTruthy()
  })

  it('once drawn, the body takes its own height', async () => {
    await mount()
    await near('src/a.ts')
    expect(within(section('src/a.ts')).getByTestId('diff-view').style.minHeight).toBe('')
  })

  it('a diff already fetched is not asked for again when the list comes back from core', async () => {
    await mount()
    await near('src/a.ts')
    await newSnapshot(3)
    expect(mock.callsOf('diff.file')).toHaveLength(1)
    expect(within(section('src/a.ts')).getByTestId('patch-view')).toBeTruthy()
  })

  it('a file over 3000 changed lines starts collapsed with Expand, and asks core nothing until expanded', async () => {
    list = files([change('src/a.ts'), change('src/huge.ts', { added: 2900, deleted: 300, large: true })])
    await mount()
    await near('src/huge.ts')
    expect(mock.callsOf('diff.file')).toEqual([])
    const huge = section('src/huge.ts')
    expect(within(huge).getByTestId('diff-large').textContent).toBe(
      '3,200 changed lines: collapsed to keep the page quick.',
    )
    expect(within(huge).getByTestId('diff-file-toggle').getAttribute('aria-expanded')).toBe('false')
    await click(within(huge).getByTestId('diff-expand'))
    await waitFor(() =>
      expect(mock.callsOf('diff.file')).toEqual([{ runId: RUN, seg: 'combined', path: 'src/huge.ts' }]),
    )
    expect(within(huge).getByTestId('patch-view')).toBeTruthy()
    expect(within(huge).getByTestId('diff-file-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it("follows core's `large`, and the counts where an older core sends none", async () => {
    list = files([
      change('src/marked.ts', { added: 10, deleted: 0, large: true }),
      change('src/counted.ts', { added: 2000, deleted: 1001 }),
      change('src/small.ts', { added: 3000, deleted: 0 }),
    ])
    await mount()
    expect(section('src/marked.ts').hasAttribute('data-collapsed')).toBe(true)
    expect(section('src/counted.ts').hasAttribute('data-collapsed')).toBe(true)
    expect(section('src/small.ts').hasAttribute('data-collapsed')).toBe(false)
  })

  it('the toggle collapses a file and opens it again', async () => {
    await mount()
    await near('src/a.ts')
    const toggle = within(section('src/a.ts')).getByTestId('diff-file-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Collapse src/a.ts')
    await click(toggle)
    expect(within(section('src/a.ts')).queryByTestId('patch-view')).toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('Expand src/a.ts')
    await click(toggle)
    expect(within(section('src/a.ts')).getByTestId('patch-view')).toBeTruthy()
  })
})

// ---- special rows -----------------------------------------------------------------------------------------------

describe('special rows', () => {
  const image = (bytes: number): DiffBlob => ({ base64: 'iVBORw0KGgo=', bytes, mime: 'image/png' })

  it('a binary image shows its two sides from diff.blob, side by side', async () => {
    list = files([change('assets/logo.png', { binary: true, added: null, deleted: null })])
    mock.on('diff.blob', () => image(2048))
    await mount()
    await near('assets/logo.png')
    expect(mock.callsOf('diff.blob')).toEqual([
      { runId: RUN, seg: 'combined', side: 'old', path: 'assets/logo.png' },
      { runId: RUN, seg: 'combined', side: 'new', path: 'assets/logo.png' },
    ])
    const old = screen.getByTestId<HTMLImageElement>('diff-image-old')
    expect(old.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(old.getAttribute('alt')).toBe('assets/logo.png, before')
    expect(screen.getByTestId('diff-image-new').getAttribute('alt')).toBe('assets/logo.png, after')
    expect(mock.callsOf('diff.file')).toEqual([])
    expect(within(section('assets/logo.png')).getByText('Binary')).toBeTruthy()
  })

  it('an added image asks only for its new side; the old one reads None', async () => {
    list = files([change('a.png', { status: 'A', binary: true, added: null, deleted: null })])
    mock.on('diff.blob', () => image(512))
    await mount()
    await near('a.png')
    expect(mock.callsOf('diff.blob')).toEqual([{ runId: RUN, seg: 'combined', side: 'new', path: 'a.png' }])
    expect(within(section('a.png')).getByText('None')).toBeTruthy()
  })

  it('another binary file says its size in KB', async () => {
    list = files([change('data/model.bin', { binary: true, added: null, deleted: null })])
    mock.on('diff.blob', () => ({ base64: '', bytes: 12_288, mime: null }))
    await mount()
    await near('data/model.bin')
    await waitFor(() => expect(screen.getByTestId('diff-binary').textContent).toBe('Binary file, 12 KB'))
  })

  it('a file whose line endings alone changed says so, and asks core for no patch', async () => {
    list = files([change('README.md', { eolOnly: true, added: 40, deleted: 40 })])
    await mount()
    await near('README.md')
    expect(screen.getByTestId('diff-eol-only').textContent).toBe('Only line endings changed')
    expect(mock.callsOf('diff.file')).toEqual([])
  })

  it("a submodule shows its commits, and its Revert says Dim Factory doesn't revert submodules", async () => {
    list = files([
      change('vendor/lib', {
        gitlink: true,
        added: null,
        deleted: null,
        oldMode: '160000',
        newMode: '160000',
      }),
    ])
    await mount()
    expect(screen.getByTestId('diff-gitlink').textContent).toBe('Submodule moved from 1111111 to 2222222')
    expect(within(section('vendor/lib')).getByText('Submodule')).toBeTruthy()
    expect(screen.getByRole('group', { name: `Revert ${GITLINK_REVERT_REASON}` })).toBeTruthy()
  })

  it('a mode change is a chip, and alone it is the row', async () => {
    list = files([change('run.sh', { newMode: '100755', added: 0, deleted: 0, modeChanged: true })])
    await mount()
    expect(within(section('run.sh')).getByTestId('diff-mode').textContent).toBe('Mode 100644 to 100755')
    expect(screen.getByTestId('diff-meta').textContent).toBe('Only the mode changed (100644 to 100755)')
    expect(mock.callsOf('diff.file')).toEqual([])
  })

  it('a rename shows both paths and its similarity; with no line changed it says so', async () => {
    list = files([
      change('src/new.ts', { status: 'R', oldPath: 'src/old.ts', similarity: 92, added: 0, deleted: 0 }),
    ])
    await mount()
    const s = section('src/new.ts')
    expect(within(s).getByTestId('diff-file-path').textContent).toBe('src/old.ts → src/new.ts')
    expect(within(s).getByTestId('diff-file-path').getAttribute('title')).toBe('src/old.ts → src/new.ts')
    expect(within(s).getByTestId('diff-similarity').textContent).toBe('92% similar')
    expect(within(s).getByTestId('diff-meta').textContent).toBe('Renamed from src/old.ts, no line changes')
  })

  it('a file edited after the run carries a chip that says what it means', async () => {
    list = files([change('src/a.ts', { editedAfterRun: true }), change('src/b.ts')])
    await mount()
    const chip = within(section('src/a.ts')).getByTestId('diff-edited-after-run')
    expect(chip.textContent).toBe('Edited after the run')
    expect(chip.getAttribute('title')).toContain('The folder changed after the run wrote this file')
    expect(within(section('src/b.ts')).queryByTestId('diff-edited-after-run')).toBeNull()
    expect(within(screen.getByTestId('diff-file-list')).getByText('Edited after the run')).toBeTruthy()
  })

  it("a cut patch says so, and core's error reads in place of the diff", async () => {
    list = files([change('src/a.ts'), change('src/b.ts')])
    mock.on('diff.file', (req: Req<'diff.file'>) => {
      if (req.path === 'src/b.ts') throw mockError('GIT', 'git could not read the snapshot.')
      return { patch: patchFor(req.path), truncated: true }
    })
    await mount()
    await near('src/a.ts')
    await near('src/b.ts')
    expect(within(section('src/a.ts')).getByTestId('diff-truncated').textContent).toBe(
      'This diff is cut short: it is larger than Dim Factory shows.',
    )
    expect(within(section('src/b.ts')).getByTestId('diff-error').textContent).toBe(
      'git could not read the snapshot.',
    )
  })

  it('status letters name the change for screen readers', async () => {
    list = files([change('a.ts', { status: 'A' }), change('d.ts', { status: 'D' }), change('m.ts')])
    await mount()
    const letters = [
      ...screen.getByTestId('diff-files').querySelectorAll('header > span[data-status] > span[aria-hidden]'),
    ].map((el) => el.textContent)
    expect(letters).toEqual(['A', 'D', 'M'])
    expect(within(section('a.ts')).getByText('Added')).toBeTruthy()
    expect(within(section('d.ts')).getByText('Deleted')).toBeTruthy()
  })
})

// ---- revert -----------------------------------------------------------------------------------------------------

describe('revert', () => {
  it("reverts a file to the segment's start, with an Undo toast", async () => {
    await mount()
    const before = mock.callsOf('diff.files').length
    await click(within(section('src/a.ts')).getByRole('button', { name: 'Revert src/a.ts' }))
    expect(mock.callsOf('diff.revert')).toEqual([{ runId: RUN, seg: 'combined', paths: ['src/a.ts'] }])
    expect(toastMessages()).toContain('Reverted src/a.ts')
    // The list is asked for again (edited-after-run can change).
    await waitFor(() => expect(mock.callsOf('diff.files').length).toBeGreaterThan(before))
    await click(within(toastEl(`revert-file:${RUN}:src/a.ts`)).getByRole('button', { name: 'Undo' }))
    expect(mock.callsOf('diff.undoRevert')).toEqual([{ runId: RUN, undoToken: 'undo-file-1' }])
    expect(toastMessages()).toContain('Revert undone: src/a.ts is back')
  })

  it('a rename reverts both of its sides', async () => {
    list = files([change('src/new.ts', { status: 'R', oldPath: 'src/old.ts' })])
    await mount()
    await click(within(section('src/new.ts')).getByRole('button', { name: 'Revert src/new.ts' }))
    expect(mock.callsOf('diff.revert')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/old.ts', 'src/new.ts'] },
    ])
  })

  it('nothing to revert: no Undo is offered', async () => {
    mock.on('diff.revert', () => ({ undoToken: 'u', restored: [], deleted: [], skipped: [] }))
    await mount()
    await click(within(section('src/a.ts')).getByRole('button', { name: 'Revert src/a.ts' }))
    expect(toastMessages()).toContain('Nothing to revert in src/a.ts')
    expect(within(toastEl(`revert-file:${RUN}:src/a.ts`)).queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('is disabled with the reason while the run works in the folder, and turns available once it ends', async () => {
    current = running()
    await mount()
    const button = within(section('src/a.ts')).getByTestId<HTMLButtonElement>('diff-file-revert')
    expect(button.disabled).toBe(true)
    expect(within(section('src/a.ts')).getByRole('group', { name: `Revert ${STILL_WORKING}` })).toBeTruthy()
    expect(screen.getByTestId<HTMLButtonElement>('diff-revert-all').disabled).toBe(true)
    current = finished()
    await act(async () => {
      applySnapshot(current)
      await settle(10)
    })
    const ready = within(section('src/a.ts')).getByTestId<HTMLButtonElement>('diff-file-revert')
    expect(ready.disabled).toBe(false)
    expect(screen.getByTestId<HTMLButtonElement>('diff-revert-all').disabled).toBe(false)
  })

  it("shows core's FOLDER_BUSY message", async () => {
    mock.on('diff.revert', () => {
      throw mockError('FOLDER_BUSY', 'Run #4 is working in this folder. Revert when it ends.')
    })
    await mount()
    await click(within(section('src/a.ts')).getByRole('button', { name: 'Revert src/a.ts' }))
    expect(toastMessages()).toContain('Run #4 is working in this folder. Revert when it ends.')
  })

  it("a saved patch (a history run) is read only: core's one-line reason, on every Revert too", async () => {
    const why =
      "Shown from the saved patch: this run's snapshots were cleared, so its files cannot be reverted."
    list = files([change('src/a.ts'), change('src/b.ts')], { persisted: true, revertUnavailable: why })
    await mount()
    expect(screen.getByTestId('diff-read-only').textContent).toBe(why)
    expect(within(section('src/a.ts')).getByRole('group', { name: `Revert ${why}` })).toBeTruthy()
    expect(screen.getByRole('group', { name: `Revert all ${why}` })).toBeTruthy()
    // Reading and marking still work.
    await near('src/a.ts')
    expect(within(section('src/a.ts')).getByTestId('patch-view')).toBeTruthy()
    await click(headerCheck('src/a.ts'))
    expect(mock.callsOf('diff.markReviewed')).toHaveLength(1)
  })

  it('an older core that marks a saved patch without a reason still gets one', async () => {
    list = files([change('src/a.ts')], { persisted: true })
    await mount()
    expect(screen.getByTestId('diff-read-only').textContent).toContain('cannot be reverted')
    expect(within(section('src/a.ts')).getByTestId<HTMLButtonElement>('diff-file-revert').disabled).toBe(true)
  })
})

// ---- keys -------------------------------------------------------------------------------------------------------

describe('nothing moves on its own (review fixes)', () => {
  it('while the run goes on, a list that would move the page waits for [Show the latest changes]; marks show at once', async () => {
    current = running()
    await mount()
    expect(screen.queryByTestId('diff-show-newer')).toBeNull()
    expect(screen.getByTestId('diff-newer-status').textContent).toBe('')
    // A new snapshot: a new file above the others, and a changed one.
    list = files(
      [change('src/0-new.ts'), change('src/a.ts', { newSha: '3'.repeat(40) }), change('src/b.ts')],
      { reviewed: ['src/b.ts'] },
    )
    await newSnapshot(3)
    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(screen.getByTestId('diff-summary').textContent).toBe('2 files changed · +5 −2')
    // Core's reviewed marks change no layout: they show at once.
    expect(checked(headerCheck('src/b.ts'))).toBe(true)
    const show = screen.getByTestId('diff-show-newer')
    expect(show.textContent).toBe('Show the latest changes')
    expect(screen.getByTestId('diff-newer-status').textContent).toBe(NEWER_CHANGES_TEXT)
    await click(show)
    expect(shownPaths()).toEqual(['src/0-new.ts', 'src/a.ts', 'src/b.ts'])
    expect(screen.queryByTestId('diff-show-newer')).toBeNull()
  })

  it('the run’s end is held too (the list on screen came from the live run); after that, the user’s changes show at once', async () => {
    current = running()
    await mount()
    list = files([change('src/a.ts'), change('src/b.ts'), change('test/fix.test.ts', { status: 'A' })], {
      available: ['implement', 'fix', 'combined'],
    })
    current = finished()
    await act(async () => {
      applySnapshot(current)
      await settle(10)
    })
    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts'])
    // The Fix segment it brings waits too (a new segment button would move the toolbar).
    expect(
      within(screen.getByRole('radiogroup', { name: 'Changes from' }))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Implement', 'Combined'])
    await click(screen.getByTestId('diff-show-newer'))
    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts', 'test/fix.test.ts'])
    // The run has ended: a later list (the user edited a file) shows at once.
    list = files(
      [change('src/a.ts', { editedAfterRun: true }), change('src/b.ts'), change('test/fix.test.ts')],
      {
        available: ['implement', 'fix', 'combined'],
      },
    )
    await newSnapshot(4)
    expect(within(section('src/a.ts')).getByTestId('diff-edited-after-run')).toBeTruthy()
    expect(screen.queryByTestId('diff-show-newer')).toBeNull()
  })

  it('a list with the same layout replaces nothing and offers nothing', async () => {
    current = running()
    await mount()
    const before = section('src/a.ts')
    list = files([change('src/a.ts'), change('src/b.ts', { added: 2, deleted: 1 })])
    await newSnapshot(2)
    await newSnapshot(3)
    expect(section('src/a.ts')).toBe(before)
    expect(screen.queryByTestId('diff-show-newer')).toBeNull()
  })

  it('a refresh core fails while a list is on screen leaves the list as it is', async () => {
    current = running()
    await mount()
    mock.on('diff.files', () => {
      throw mockError('GIT', 'Dim Factory could not read this run’s changes: busy')
    })
    await newSnapshot(3)
    expect(shownPaths()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(screen.getByTestId('diff-tab').textContent).not.toContain('could not read')
  })

  it('the file list’s open or closed default is fixed when the list first shows (never by a later count)', async () => {
    await mount()
    expect(screen.getByTestId('diff-list-toggle').getAttribute('aria-expanded')).toBe('true')
    list = files(Array.from({ length: 45 }, (_, i) => change(`src/f${String(i).padStart(2, '0')}.ts`)))
    await newSnapshot(45)
    expect(shownPaths()).toHaveLength(45)
    expect(screen.getByTestId('diff-list-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('a drawn diff stays until its replacement has drawn (Ignore line endings), then gives way in one step', async () => {
    await mount()
    await near('src/a.ts')
    const body = (): HTMLElement => section('src/a.ts')
    const first = within(body()).getByTestId('diff-view')
    fakeView.draws = false
    await click(screen.getByTestId('diff-ignore-eol'))
    // The drawn diff is still on screen; the next one lays out unseen beside it.
    expect(within(body()).getByTestId('diff-view')).toBe(first)
    expect(within(body()).queryByTestId('diff-pending')).toBeNull()
    const next = within(body()).getByTestId('diff-view-next')
    expect(next.getAttribute('aria-hidden')).toBe('true')
    expect(next.className).toContain('invisible')
    expect(next.className).toContain('absolute')
    await act(async () => {
      for (const draw of fakeView.held.splice(0)) draw()
      await settle()
    })
    // Swapped in one step: the same element (never mounted again), now on screen.
    expect(within(body()).queryByTestId('diff-view-next')).toBeNull()
    const now = within(body()).getByTestId('diff-view')
    expect(now).toBe(next)
    expect(now.className).not.toContain('invisible')
    expect(now.style.minHeight).toBe('')
    expect(within(now).getByTestId('patch-view').getAttribute('data-cache-key')).toContain('eol')
  })

  it('an added file’s estimate has no context rows (one hunk of its own lines)', async () => {
    list = files([
      change('src/new.ts', { status: 'A', added: 10, deleted: 0, oldMode: '000000', oldSha: '0'.repeat(40) }),
      change('src/gone.ts', { status: 'D', added: 0, deleted: 4, newMode: '000000', newSha: '0'.repeat(40) }),
    ])
    fakeView.draws = false
    await mount()
    expect(within(section('src/new.ts')).getByTestId('diff-pending').style.minHeight).toBe(
      `${10 * 20 + 16}px`,
    )
    expect(within(section('src/gone.ts')).getByTestId('diff-pending').style.minHeight).toBe(
      `${4 * 20 + 16}px`,
    )
  })
})

describe('keys', () => {
  beforeEach(layOut)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('J and K move focus from file to file, R marks the current file, from anywhere on the page', async () => {
    list = files([change('src/a.ts'), change('src/b.ts'), change('src/c.ts')])
    await mount()
    expect(document.body.getAttribute('data-key-scope')).toContain('diff')
    await press('j', document.body)
    expect(document.activeElement).toBe(section('src/a.ts'))
    await press('j')
    expect(document.activeElement).toBe(section('src/b.ts'))
    await press('j')
    await press('j')
    expect(document.activeElement).toBe(section('src/c.ts'))
    await press('k')
    expect(document.activeElement).toBe(section('src/b.ts'))
    await press('r')
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/b.ts'], reviewed: true },
    ])
    expect(checked(headerCheck('src/b.ts'))).toBe(true)
    await press('r')
    expect(mock.callsOf('diff.markReviewed').at(-1)).toEqual({
      runId: RUN,
      seg: 'combined',
      paths: ['src/b.ts'],
      reviewed: false,
    })
    // From the tab bar (focus in the sticky header): J still goes on from the current file.
    screen.getByTestId('run-tab-diff').focus()
    await press('j')
    expect(document.activeElement).toBe(section('src/c.ts'))
  })

  it('R acts on the file focus is in (a click inside it)', async () => {
    await mount()
    section('src/b.ts').focus()
    await press('r')
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/b.ts'], reviewed: true },
    ])
  })

  it('with nothing focused, R marks the file at the top of the reading area, not the first one, and J/K go on from it', async () => {
    list = files([change('src/a.ts'), change('src/b.ts'), change('src/c.ts')])
    await mount()
    // The reader wheel-scrolled into b's body: a is above the view, b at its top, c below.
    layout.scrolled = 450
    await press('r', document.body)
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/b.ts'], reviewed: true },
    ])
    // J and K go on from it.
    await press('j', document.body)
    expect(document.activeElement).toBe(section('src/c.ts'))
    ;(document.activeElement as HTMLElement | null)?.blur()
    await press('k', document.body)
    expect(document.activeElement).toBe(section('src/b.ts'))
  })

  it('with no file of its own, K goes to the start of the file being read, J to the next one below', async () => {
    list = files([change('src/a.ts'), change('src/b.ts'), change('src/c.ts')])
    await mount()
    layout.scrolled = 450
    await press('k', document.body)
    expect(document.activeElement).toBe(section('src/b.ts'))
  })

  it('the keyboard’s file counts only while it is in view: after the wheel, R and J follow what is read', async () => {
    list = files([change('src/a.ts'), change('src/b.ts'), change('src/c.ts')])
    await mount()
    await press('j', document.body)
    expect(document.activeElement).toBe(section('src/a.ts'))
    // Focus stays on a while the wheel brings c to the top: a is out of sight.
    layout.scrolled = 700
    await press('r')
    expect(mock.callsOf('diff.markReviewed')).toEqual([
      { runId: RUN, seg: 'combined', paths: ['src/c.ts'], reviewed: true },
    ])
  })

  it('R does nothing when no file is in view; J then goes to the first file below', async () => {
    list = files([change('src/a.ts'), change('src/b.ts')])
    await mount()
    // The files are all below the reading area (a long list or toolbar above them).
    layout.scrolled = -2000
    await press('r', document.body)
    expect(mock.callsOf('diff.markReviewed')).toEqual([])
    await press('j', document.body)
    expect(document.activeElement).toBe(section('src/a.ts'))
  })

  it('a letter typed in an open menu, a dialog or on a toast is theirs, never a Diff key', async () => {
    await mount()
    for (const html of [
      '<div role="menu"><button type="button">Re-run with same config</button></div>',
      '<div role="listbox" tabindex="-1"><div role="option" tabindex="0">balanced</div></div>',
      '<div role="dialog"><button type="button">Close</button></div>',
      '<section data-key-scope-stop=""><button type="button">Undo</button></section>',
    ]) {
      const host = document.createElement('div')
      host.innerHTML = html
      document.body.append(host)
      const target = host.querySelector<HTMLElement>('button, [role="option"]')
      target?.focus()
      for (const key of ['r', 'j', 's']) await press(key, target ?? document.body)
      host.remove()
    }
    expect(mock.callsOf('diff.markReviewed')).toEqual([])
    expect(screen.getByTestId('diff-layout').querySelector('[aria-checked="true"]')?.textContent).toBe(
      'Split',
    )
  })

  it('says its keys: J/K on each file, R on its Reviewed mark, S on the layout', async () => {
    await mount()
    expect(section('src/a.ts').getAttribute('aria-keyshortcuts')).toBe('J K')
    expect(headerCheck('src/a.ts').getAttribute('aria-keyshortcuts')).toBe('R')
    expect(screen.getByTestId('diff-layout').getAttribute('aria-keyshortcuts')).toBe('S')
  })

  it('does nothing while typing in a field', async () => {
    await mount()
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    await press('j', field)
    await press('r', field)
    expect(document.activeElement).toBe(field)
    expect(mock.callsOf('diff.markReviewed')).toEqual([])
    field.remove()
  })

  it('the page leaves the diff scope when the tab closes', async () => {
    release = startBridge()
    const r = renderUi(<RunPage runId={RUN} tab="diff" />)
    await waitFor(() => expect(screen.getByTestId('diff-files')).toBeTruthy())
    expect(document.body.getAttribute('data-key-scope')).toBe('diff')
    r.unmount()
    expect(document.body.hasAttribute('data-key-scope')).toBe(false)
  })
})

// ---- other states -----------------------------------------------------------------------------------------------

describe('other states', () => {
  it("before core has a diff: the live count and core's reason, with Revert all and Open the folder", async () => {
    mock.on('diff.files', () => {
      throw mockError('NOT_FOUND', 'Implement has not finished, so its changes cannot be shown yet.')
    })
    current = running()
    release = startBridge()
    renderUi(<RunPage runId={RUN} tab="diff" />)
    await waitFor(() =>
      expect(screen.getByTestId('diff-tab').textContent).toContain(
        'Implement has not finished, so its changes cannot be shown yet.',
      ),
    )
    expect(screen.getByTestId('diff-tab').textContent).toContain('2 files changed')
    expect(screen.getByTestId('diff-revert-all')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open the folder' })).toBeTruthy()
  })

  it('asks core again once a stopped run has taken its last snapshot (the lock released)', async () => {
    current = snapWith({
      summary: {
        status: 'cancelled',
        phase: 'done',
        lock: 'held',
        progress: { tokens: 1, costUsd: null, filesChanged: 2 },
      },
      steps: { plan: { status: 'done', attempt: 1 }, implement: { status: 'cancelled', attempt: 1 } },
      lastSeq: 7,
    })
    mock.on('diff.files', () => {
      throw mockError('NOT_FOUND', 'The run has not recorded any changes yet.')
    })
    release = startBridge()
    renderUi(<RunPage runId={RUN} tab="diff" />)
    await waitFor(() =>
      expect(screen.getByTestId('diff-tab').textContent).toContain(
        'The run has not recorded any changes yet.',
      ),
    )
    // The `stopped` snapshot lands; core releases the lock and republishes the summary.
    mock.on('diff.files', (req) => ({ ...list, seg: req.seg }))
    const { lock: _held, ...released } = current.summary
    await act(async () => {
      mock.push({ kind: 'run-summary', summary: released })
      await settle(10)
    })
    await waitFor(() => expect(screen.getByTestId('diff-summary').textContent).toContain('2 files changed'))
  })

  it('a segment with no files says so', async () => {
    list = files([])
    release = startBridge()
    renderUi(<RunPage runId={RUN} tab="diff" />)
    await waitFor(() => expect(screen.getByText('No files changed')).toBeTruthy())
    expect(screen.getByTestId('diff-summary').textContent).toBe('0 files changed · +0 −0')
  })

  it('an isolated run shows "Apply to folder…" with core\'s preview; Apply is live', async () => {
    current = { ...current, summary: { ...current.summary, isolation: 'worktree' } }
    list = files([change('src/a.ts'), change('src/b.ts')], { reviewed: ['src/a.ts'] })
    mock.on('worktree.preview', () => ({ files: list.files, conflicts: [] }))
    await mount()
    const panel = screen.getByTestId('diff-apply-panel')
    expect(within(panel).getByRole('heading', { name: 'Apply to folder…' })).toBeTruthy()
    await waitFor(() => expect(panel.textContent).toContain('All files (2 files)'))
    expect(panel.textContent).toContain('Reviewed files only (1 file)')
    expect(within(panel).getByTestId<HTMLButtonElement>('diff-apply').disabled).toBe(false)
    for (const r of within(panel).getAllByRole<HTMLInputElement>('radio')) expect(r.disabled).toBe(false)
  })

  it('an in-place run has no Apply panel', async () => {
    await mount()
    expect(screen.queryByTestId('diff-apply-panel')).toBeNull()
  })

  // Review finding 14: an isolated run's Revert would change its copy, never the folder.
  it("an isolated run's Revert all and per-file Revert are disabled, saying Apply and its Undo change the folder", async () => {
    current = { ...current, summary: { ...current.summary, isolation: 'worktree' } }
    mock.on('worktree.preview', () => ({ files: list.files, conflicts: [] }))
    await mount()
    expect(screen.getByTestId<HTMLButtonElement>('diff-revert-all').disabled).toBe(true)
    expect(screen.getByRole('group', { name: `Revert all ${ISOLATED_REVERT_REASON}` })).toBeTruthy()
    expect(within(section('src/a.ts')).getByTestId<HTMLButtonElement>('diff-file-revert').disabled).toBe(true)
    expect(
      within(section('src/a.ts')).getByRole('group', { name: `Revert ${ISOLATED_REVERT_REASON}` }),
    ).toBeTruthy()
    expect(mock.callsOf('diff.revert')).toEqual([])
  })

  it('a long list starts closed behind its toggle, which keeps one width', async () => {
    list = files(Array.from({ length: 45 }, (_, i) => change(`src/f${i}.ts`)))
    await mount()
    const toggle = screen.getByTestId('diff-list-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByTestId('diff-list-row')).toHaveLength(0)
    expect(toggle.querySelector('[data-stable-label]')).not.toBeNull()
    await click(toggle)
    expect(screen.getAllByTestId('diff-list-row')).toHaveLength(45)
    expect(toggle.textContent).toBe('Hide the list')
  })

  it('a path in the list goes to its file and focuses it (a click)', async () => {
    await mount()
    await click(
      within(screen.getByTestId('diff-file-list')).getAllByTestId('diff-list-open')[1] as HTMLElement,
    )
    expect(document.activeElement).toBe(section('src/b.ts'))
  })

  it('no em dash anywhere in the tab', async () => {
    list = files([
      change('src/a.ts', { editedAfterRun: true }),
      change('x.bin', { binary: true, added: null, deleted: null }),
      change('m', { gitlink: true, added: null, deleted: null }),
      change('e.txt', { eolOnly: true }),
    ])
    current = { ...current, summary: { ...current.summary, isolation: 'worktree' } }
    mock.on('diff.blob', () => ({ base64: '', bytes: 100, mime: null }))
    await mount()
    for (const p of ['src/a.ts', 'x.bin']) await near(p)
    expect(screen.getByTestId('diff-tab').textContent).not.toContain('—')
  })
})
