// What core answers after the first paint never moves the composer (UI standard:
// async content never shifts the page; reserve its space or overlay it), and no room is kept for what may never come.
// Each answer fills a place that is there from the start: the chips row (at the chips' height), the pass rows (their
// last measured height while config.resolve is out), the strip's one summary row, the estimate line, and the status
// beside Run (a failed start's error included). A folder note takes the room the chips leave, at the end of their line.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedWithProvenance } from '@shared/ipc.ts'
import type { PreflightReport } from '@shared/preflight.ts'
import type { RunEstimate } from '@shared/estimates.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { PASSES_HEIGHT_KEY, PASSES_OPEN_KEY } from '@renderer/pages/dashboard/composer/state.ts'
import { setLiveSupportForTests } from '@renderer/pages/dashboard/composer/useLiveChecks.ts'
import { upsertProbes } from '@renderer/state/actions.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { check, fakeResolve, FOLDER, mountComposer, probe, report, runEstimate } from './fixtures.tsx'

let mock: MockDimFactory

beforeEach(() => {
  resetRecoveryForTests()
  setLiveSupportForTests()
  mock = setUp({
    handlers: {
      'config.resolve': fakeResolve(),
      'preflight.run': () => report(),
      'estimates.get': () => runEstimate(),
    },
  })
  upsertProbes([probe('claude', 'ready')])
})

afterEach(() => tearDown(mock))

const classes = (el: Element): string[] => el.className.toString().split(/\s+/)

describe('the folder lines', () => {
  it('keeps the chips row at the chips’ height, and no empty line for a note that may never come', async () => {
    await mountComposer(null)
    const chips = screen.getByTestId('folder-chips')
    expect(chips.textContent).toBe('No recent folders yet')
    expect(classes(chips)).toContain('h-6')
    // The chips row is the only line under the folder row: nothing is held open below it.
    expect(chips.parentElement?.children).toHaveLength(1)
    expect(screen.queryByTestId('folder-note-line')).toBeNull()
  })

  it('puts a note core sends at the end of the chips line, at its height, so its arrival moves nothing', async () => {
    mock.on('config.resolve', fakeResolve({ scopeRoot: 'C:\\work' }))
    await mountComposer()
    const note = screen.getByTestId('folder-note-line')
    // The path keeps its width in the folder row: only the path box, "Choose folder…" and "New project…" (always
    // there, so it moves nothing) are there.
    const row = screen.getByTestId('composer-folder-input').parentElement
    expect(row?.contains(note)).toBe(false)
    expect(classes(row as Element)).not.toContain('flex-wrap')
    const order = [...(row?.children ?? [])].map((c) => c.getAttribute('data-testid'))
    expect(order.slice(1)).toEqual([
      'composer-folder-input',
      'composer-choose-folder',
      'composer-new-project',
    ])
    expect(classes(screen.getByTestId('composer-choose-folder'))).toContain('shrink-0')
    expect(classes(screen.getByTestId('composer-new-project'))).toContain('shrink-0')
    // The chips line: one line at the chips' height, the note after the chips, pushed to its end.
    const line = screen.getByTestId('folder-chips').parentElement as HTMLElement
    expect(note.parentElement).toBe(line)
    expect(classes(line)).toContain('h-6')
    expect(classes(line)).not.toContain('flex-wrap')
    expect([...line.children].map((c) => c.getAttribute('data-testid'))).toEqual([
      'folder-chips',
      'folder-note-line',
    ])
    // It gives way before the chips (a far larger shrink factor), down to its least width.
    expect(classes(note)).toEqual(expect.arrayContaining(['ml-auto', 'h-6', 'shrink-[100]', 'min-w-24']))
    expect(screen.getByTestId('scope-root-note').getAttribute('title')).toBe(
      'Snapshots cover repo root C:\\work',
    )
  })

  it('puts the chips in their one row, each giving way instead of wrapping onto a second', async () => {
    mock.on('folders.recent', () =>
      ['api', 'web', 'cli', 'docs', 'infra', 'tools'].map((n, i) => ({
        folder: `C:\\work\\${n}`,
        scopeRoot: null,
        lastRunAt: i,
        isGit: true,
        exists: true,
      })),
    )
    await mountComposer(null)
    const row = screen.getByRole('list', { name: 'Recent folders' })
    expect(row.getAttribute('data-testid')).toBe('folder-chips')
    expect(classes(row)).toEqual(expect.arrayContaining(['h-6', 'flex-nowrap']))
    expect(classes(row)).not.toContain('flex-wrap')
    for (const li of within(row).getAllByRole('listitem')) expect(classes(li)).toContain('shrink')
  })

  it('shows the non-git notice at the end of the chips line, one line with its button, the whole text in its title', async () => {
    mock.on('preflight.run', () =>
      report({
        info: [check('folder.git', { title: 'Not a git repository', detail: 'Snapshots still work.' })],
      }),
    )
    await mountComposer()
    await settle(300)
    const note = screen.getByTestId('folder-note-line')
    expect(note.parentElement).toBe(screen.getByTestId('folder-chips').parentElement)
    expect(classes(note)).toEqual(expect.arrayContaining(['h-6', 'ml-auto', 'shrink-[100]', 'min-w-52']))
    const banner = within(note).getByTestId('non-git-banner')
    expect(classes(banner)).not.toContain('flex-wrap')
    const text = banner.querySelector('[title]')
    expect(text?.getAttribute('title')).toBe(
      'Not a git repository. Dim Factory tracks changes itself, so every run still gets snapshots and a diff.',
    )
    expect(classes(text as Element)).toContain('truncate')
    // [Initialize git] keeps its size at the chips' height; the text gives way.
    const init = within(banner).getByTestId('init-git')
    expect(classes(init)).toEqual(expect.arrayContaining(['h-6', 'shrink-0']))
  })
})

describe('the pass rows', () => {
  it("keep their summary line, and the open rows' last measured height, while core resolves the configuration", async () => {
    window.localStorage.setItem(PASSES_OPEN_KEY, '1')
    window.localStorage.setItem(PASSES_HEIGHT_KEY, '312')
    const hold = deferred<ResolvedWithProvenance>()
    mock.on('config.resolve', () => hold.promise)
    await mountComposer()
    const pending = screen.getByTestId('composer-passes-pending')
    expect(pending.style.minHeight).toBe('312px')
    expect(pending.getAttribute('aria-busy')).toBe('true')
    expect(pending.textContent).toContain('Reading the configuration…')
    expect(screen.getByTestId('composer-passes-toggle').getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      hold.resolve(fakeResolve()({}))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.queryByTestId('composer-passes-pending')).toBeNull()
    expect(screen.getByTestId('composer-passes').textContent).toContain('Claude')
  })

  it('reserve only the summary line while the rows are closed', async () => {
    const hold = deferred<ResolvedWithProvenance>()
    mock.on('config.resolve', () => hold.promise)
    await mountComposer()
    expect(screen.getByTestId('composer-passes-pending').style.minHeight).toBe('')
  })

  it('show a configuration error in the summary line, not as a line of its own', async () => {
    mock.on('config.resolve', () => {
      throw mockError('VALIDATION', 'dimfactory.json:3:5 Unknown key "promptTemplte".')
    })
    await mountComposer()
    await settle()
    const error = screen.getByTestId('composer-config-error')
    expect(error.parentElement?.contains(screen.getByTestId('composer-passes-toggle'))).toBe(true)
    expect(classes(error)).toContain('truncate')
    expect(error.getAttribute('title')).toContain('Unknown key "promptTemplte".')
  })
})

describe('the strip and the estimate', () => {
  it('keep their places with a hint before there is a folder to check', async () => {
    await mountComposer(null)
    const slot = screen.getByTestId('preflight-slot')
    expect(classes(slot)).toContain('min-h-7')
    expect(within(slot).getByTestId('preflight-hint').textContent).toBe(
      'The folder and the vendors are checked once you choose a folder.',
    )
    const estimate = screen.getByTestId('estimate-slot')
    expect(classes(estimate)).toContain('h-5')
    expect(within(estimate).getByTestId('estimate-pending').textContent).toBe(
      'The estimate follows once you choose a folder.',
    )
  })

  it('show the summary row and "Estimating…" while core checks, then core answers in the same places', async () => {
    const pre = deferred<PreflightReport>()
    const est = deferred<RunEstimate>()
    mock.on('preflight.run', () => pre.promise)
    mock.on('estimates.get', () => est.promise)
    await mountComposer()
    await settle(300)
    expect(screen.getByTestId('preflight-checking').textContent).toBe('Checking the folder and vendors…')
    expect(screen.getByTestId('preflight-recheck')).toBeTruthy()
    expect(within(screen.getByTestId('estimate-slot')).getByTestId('estimate-pending').textContent).toBe(
      'Estimating…',
    )
    await act(async () => {
      pre.resolve(
        report({ warnings: [check('pass.review.relay', { status: 'warn', title: 'Asks are denied' })] }),
      )
      est.resolve(runEstimate())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.getByTestId('preflight-summary-text').textContent).toBe('1 warning: Asks are denied')
    expect(screen.queryByTestId('preflight-chips')).toBeNull()
    expect(within(screen.getByTestId('estimate-slot')).getByTestId('estimate-line')).toBeTruthy()
    // Only the user opens the chips.
    fireEvent.click(screen.getByTestId('preflight-details'))
    expect(screen.getByTestId('preflight-chips')).toBeTruthy()
    const toggle = screen.getByTestId('preflight-details')
    expect([...toggle.querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label'))).toEqual([
      'Show details',
      'Hide details',
    ])
  })

  it("say core's error in the summary row, cut to one line", async () => {
    mock.on('preflight.run', () => {
      throw mockError('INTERNAL', 'The folder could not be read.')
    })
    await mountComposer()
    await settle(300)
    const error = screen.getByTestId('preflight-error')
    expect(error.parentElement).toBe(screen.getByTestId('preflight-summary'))
    expect(classes(error)).toContain('truncate')
  })
})

describe('the status beside Run', () => {
  it("holds a failed start's error (an alert, and a toast), so nothing is added below the composer", async () => {
    mock.on('runs.start', () => {
      throw mockError('STORAGE', 'The disk refused to write the run folder.')
    })
    await mountComposer()
    fireEvent.change(screen.getByTestId('composer-task'), { target: { value: 'Add a flag' } })
    await settle(300)
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-run'))
      await vi.advanceTimersByTimeAsync(0)
    })
    const status = screen.getByTestId('composer-run-status')
    const error = within(status).getByTestId('composer-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe('The disk refused to write the run folder.')
    expect(status.getAttribute('title')).toBe('The disk refused to write the run folder.')
    expect(classes(status)).toEqual(expect.arrayContaining(['truncate', 'text-destructive']))
    expect(screen.getByTestId('composer-run').getAttribute('aria-describedby')).toBe(status.id)
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Add a flag' }])
  })
})
