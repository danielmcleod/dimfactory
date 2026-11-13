// Settings → Diagnostics (versions, paths, storage sizes, Clear
// snapshots (an inline two-step), Copy diagnostics (raw lines opt-in); Clear snapshots is the app's one
// inline two-step confirm). Versions and paths from AppInfo at once; sizes from storage.usage after the section has
// been open a moment, with their rows there from the start; Clear snapshots per folder (first click arms, second
// clears, Cancel / Escape / leaving the row disarms; disabled with core's reason while a run uses that folder, asked
// again when a run's status or lock changes); Copy and Save diagnostics with "Include raw log lines" off by default and the redactions counted; core's
// `settings/storage?field=/storage/shadow` link focusing the per-folder list.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageUsage } from '@shared/ipc.ts'
import {
  CLEAR_LABEL,
  CONFIRM_CLEAR_LABEL,
  INCLUDE_RAW_LABEL,
  NO_SNAPSHOTS,
  redactionText,
} from '@renderer/pages/settings/DiagnosticsSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { formatBytes, SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { setAppInfo, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { defaultAppInfo, deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const KEY_A = 'aaaaaaaaaaaaaaaa'
const KEY_B = 'bbbbbbbbbbbbbbbb'
const EM_DASH = '\u2014'

function usage(over: Partial<StorageUsage> = {}): StorageUsage {
  return {
    home: 'C:\\dim-factory-test-home',
    totalBytes: 50 * 1024 * 1024,
    freeBytes: 20 * 1024 * 1024 * 1024,
    runs: { count: 12, bytes: 3 * 1024 * 1024 },
    shadows: [
      { folderKey: KEY_A, path: 'C:\\work\\alpha', bytes: 30 * 1024 * 1024 },
      { folderKey: KEY_B, path: null, bytes: 512 },
    ],
    worktrees: { count: 0, bytes: 0 },
    catalogBytes: 4096,
    logsBytes: 2048,
    ...over,
  }
}

let mock: MockDimFactory
let current: StorageUsage

beforeEach(() => {
  current = usage()
  mock = setUp({
    handlers: {
      'storage.usage': () => current,
      'storage.clearShadow': (req) => {
        current = { ...current, shadows: current.shadows.filter((s) => s.folderKey !== req.folderKey) }
        return current
      },
      'diagnostics.copy': () => undefined,
      'diagnostics.save': () => ({ path: 'C:\\Users\\me\\Desktop\\dim-factory-diagnostics.txt' }),
      'diagnostics.build': (req) => ({
        text: 'report',
        redactions: req.includeRaw === true ? { email: 1, 'anthropic-key': 2, home: 9 } : { home: 3 },
      }),
      'shell.open': () => undefined,
    },
  })
  act(() =>
    setAppInfo(
      defaultAppInfo({
        git: { path: 'C:\\Program Files\\Git\\cmd\\git.exe', version: '2.51.0' },
        packaged: true,
      }),
    ),
  )
})

afterEach(() => tearDown(mock))

function mount(): HTMLElement {
  render(
    <Providers>
      <SettingsPage section="diagnostics" />
    </Providers>,
  )
  return screen.getByTestId('settings-diagnostics')
}

async function open(): Promise<HTMLElement> {
  const el = mount()
  await settle(SECTION_LOAD_DELAY_MS)
  return el
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const lastToast = (): string | undefined => useStore.getState().toasts.items.at(-1)?.message

describe('Settings → Diagnostics: versions, paths and sizes', () => {
  it('is live, shows versions and paths at once, and reads sizes only once it has been open a moment', async () => {
    expect(findSection('diagnostics')?.live).toBe(true)
    mount()
    const list = screen.getByTestId('diagnostics-versions')
    expect(list.textContent).toContain('Dim Factory0.1.0-test')
    expect(list.textContent).toContain('Git2.51.0 · C:\\Program Files\\Git\\cmd\\git.exe')
    expect(list.textContent).toContain('LogsC:\\dim-factory-test-home\\logs')
    // Every size row is there before the answer, so nothing moves when it comes.
    const table = screen.getByTestId('storage-table')
    const rowsBefore = table.querySelectorAll('tbody tr').length
    expect(screen.getByTestId('storage-size-total').textContent).toBe('Loading…')
    expect(mock.callsOf('storage.usage')).toHaveLength(0)
    await settle(SECTION_LOAD_DELAY_MS - 1)
    expect(mock.callsOf('storage.usage')).toHaveLength(0)
    await settle(1)
    expect(mock.callsOf('storage.usage')).toHaveLength(1)
    expect(table.querySelectorAll('tbody tr')).toHaveLength(rowsBefore)
    expect(screen.getByTestId('storage-size-total').textContent).toBe('50.0 MB')
    expect(screen.getByTestId('storage-size-runs').textContent).toBe('3.0 MB')
    expect(screen.getByTestId('storage-shadows').textContent).toContain('Snapshots by folder')
    expect(table.textContent).toContain('Runs (12)')
    expect(table.textContent).toContain('Snapshots (2 folders)')
    expect(screen.getByTestId('storage-size-free').textContent).toBe('20.0 GB')
  })

  it('lists each folder’s snapshots with the folder path and size, last in the section', async () => {
    const section = await open()
    const row = screen.getByTestId(`shadow-row-${KEY_A}`)
    expect(within(row).getByTestId(`shadow-path-${KEY_A}`).textContent).toBe('C:\\work\\alpha')
    expect(row.textContent).toContain('30.0 MB')
    expect(screen.getByTestId(`shadow-path-${KEY_B}`).textContent).toBe(
      `A folder Dim Factory no longer knows (${KEY_B})`,
    )
    // The list whose length was unknown is the last thing in the section.
    const groups = section.querySelectorAll(':scope > section')
    expect(groups[groups.length - 1]?.contains(screen.getByTestId('storage-shadows'))).toBe(true)
    expect(screen.getByTestId('storage-shadows').nextElementSibling).toBeNull()
  })

  it('says when there are no snapshots', async () => {
    current = usage({ shadows: [] })
    await open()
    expect(screen.getByTestId('storage-shadows').textContent).toContain(NO_SNAPSHOTS)
    expect(screen.getByTestId('storage-table').textContent).toContain('Snapshots (0 folders)')
  })

  it('shows the error in its reserved line when the sizes cannot be read', async () => {
    mock.on('storage.usage', () => {
      throw mockError('STORAGE', 'The data folder is locked.')
    })
    mount()
    const line = screen.getByTestId('storage-error')
    expect(line.textContent).toBe('')
    await settle(SECTION_LOAD_DELAY_MS)
    expect(line.textContent).toBe('The sizes could not be read: The data folder is locked.')
    expect(screen.getByTestId('storage-size-total').textContent).toBe('Loading…')
  })

  it('opens the data and logs folders', async () => {
    mount()
    await click(screen.getByTestId('diagnostics-open-home'))
    await click(screen.getByTestId('diagnostics-open-logs'))
    expect(mock.callsOf('shell.open')).toEqual([{ target: 'home' }, { target: 'logs' }])
  })
})

describe('Settings → Diagnostics: Clear snapshots (inline two-step)', () => {
  it('arms on the first click, clears on the second, and keeps the button’s size and place', async () => {
    await open()
    const clear = screen.getByTestId(`shadow-clear-${KEY_A}`)
    const cancel = screen.getByTestId(`shadow-cancel-${KEY_A}`)
    expect(clear.textContent).toBe(CLEAR_LABEL)
    // Both labels are reserved in one cell, so the button is as wide in either state.
    const reserved = [...clear.querySelectorAll('[data-label]')].map((e) => e.getAttribute('data-label'))
    expect(reserved).toEqual(expect.arrayContaining([CLEAR_LABEL, CONFIRM_CLEAR_LABEL]))
    // Cancel keeps its place while hidden.
    expect(cancel.className).toContain('invisible')
    await click(clear)
    expect(mock.callsOf('storage.clearShadow')).toEqual([])
    expect(clear.textContent).toBe(CONFIRM_CLEAR_LABEL)
    expect(cancel.className).not.toContain('invisible')
    expect(screen.getByTestId(`shadow-note-${KEY_A}`).textContent).toContain('can no longer be reverted')
    expect(clear.getAttribute('aria-describedby')).toBe(screen.getByTestId(`shadow-note-${KEY_A}`).id)
    await click(clear)
    expect(mock.callsOf('storage.clearShadow')).toEqual([{ folderKey: KEY_A }])
    expect(screen.queryByTestId(`shadow-row-${KEY_A}`)).toBeNull()
    expect(lastToast()).toBe(`Cleared the snapshots of C:\\work\\alpha (${formatBytes(30 * 1024 * 1024)}).`)
    // No undo: clearing cannot be taken back, which is why it asks twice.
    expect(useStore.getState().toasts.items.at(-1)?.action).toBeUndefined()
    expect(document.activeElement).toBe(screen.getByTestId('storage-shadows'))
  })

  it('Cancel, Escape and leaving the row disarm it; arming another folder disarms the first', async () => {
    await open()
    const clear = screen.getByTestId(`shadow-clear-${KEY_A}`)
    await click(clear)
    await click(screen.getByTestId(`shadow-cancel-${KEY_A}`))
    expect(clear.textContent).toBe(CLEAR_LABEL)
    await click(clear)
    act(() => {
      fireEvent.keyDown(clear, { key: 'Escape' })
    })
    expect(clear.textContent).toBe(CLEAR_LABEL)
    await click(clear)
    act(() => {
      fireEvent.blur(clear, { relatedTarget: document.body })
    })
    expect(clear.textContent).toBe(CLEAR_LABEL)
    await click(clear)
    await click(screen.getByTestId(`shadow-clear-${KEY_B}`))
    expect(clear.textContent).toBe(CLEAR_LABEL)
    expect(screen.getByTestId(`shadow-clear-${KEY_B}`).textContent).toBe(CONFIRM_CLEAR_LABEL)
    expect(mock.callsOf('storage.clearShadow')).toEqual([])
  })

  it('is disabled with core’s reason while a run uses the folder (a failed run too), and asks core again when a run’s lock changes', async () => {
    const REASON = 'Run #12 is using this folder. Clear its snapshots once the run has finished.'
    current = usage({
      shadows: [
        { folderKey: KEY_A, path: 'C:\\work\\alpha', bytes: 30 * 1024 * 1024, busy: REASON },
        { folderKey: KEY_B, path: null, bytes: 512 },
      ],
    })
    // A failed run still holds its folder's lock: core says so, the renderer does not decide it from the status.
    act(() =>
      upsertSummaries([
        makeSummary({ runId: 'r12', displayNo: 12, folderKey: KEY_A, status: 'failed', lock: 'held' }),
        makeSummary({ runId: 'r9', displayNo: 9, folderKey: KEY_B, status: 'completed' }),
      ]),
    )
    await open()
    const clear = screen.getByTestId<HTMLButtonElement>(`shadow-clear-${KEY_A}`)
    expect(clear.disabled).toBe(true)
    const note = screen.getByTestId(`shadow-note-${KEY_A}`)
    expect(note.textContent).toBe(REASON)
    expect(clear.getAttribute('aria-describedby')).toBe(note.id)
    expect(screen.getByTestId<HTMLButtonElement>(`shadow-clear-${KEY_B}`).disabled).toBe(false)
    expect(mock.callsOf('storage.usage')).toHaveLength(1)
    // An unrelated change to the run (its phase) asks core nothing.
    act(() =>
      upsertSummaries([
        makeSummary({
          runId: 'r12',
          displayNo: 12,
          folderKey: KEY_A,
          status: 'failed',
          lock: 'held',
          phase: 'needs-attention',
        }),
      ]),
    )
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('storage.usage')).toHaveLength(1)
    // Core releases the lock and republishes the summary: the section asks again, and the folder can be cleared.
    current = usage()
    act(() =>
      upsertSummaries([makeSummary({ runId: 'r12', displayNo: 12, folderKey: KEY_A, status: 'failed' })]),
    )
    // The last answer stays on screen while core is asked again.
    expect(clear.disabled).toBe(true)
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('storage.usage')).toHaveLength(2)
    expect(clear.disabled).toBe(false)
    expect(screen.queryByTestId(`shadow-note-${KEY_A}`)).toBeNull()
  })

  it('shows core’s refusal and keeps the folder', async () => {
    mock.on('storage.clearShadow', () => {
      throw mockError('FOLDER_BUSY', 'A run is working in this folder.')
    })
    await open()
    const clear = screen.getByTestId(`shadow-clear-${KEY_A}`)
    await click(clear)
    await click(clear)
    expect(lastToast()).toBe('A run is working in this folder.')
    expect(screen.getByTestId(`shadow-row-${KEY_A}`)).toBeTruthy()
    expect(clear.textContent).toBe(CLEAR_LABEL)
  })

  it('is disabled while the clear is in flight', async () => {
    const held = deferred<StorageUsage>()
    mock.on('storage.clearShadow', () => held.promise)
    await open()
    const clear = screen.getByTestId<HTMLButtonElement>(`shadow-clear-${KEY_A}`)
    await click(clear)
    await click(clear)
    expect(clear.disabled).toBe(true)
    await act(async () => {
      held.resolve(usage({ shadows: [] }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(screen.getByTestId('storage-shadows').textContent).toContain(NO_SNAPSHOTS)
  })
})

describe('Settings → Diagnostics: the report', () => {
  it('copies without raw log lines by default and says what was removed', async () => {
    mount()
    const raw = screen.getByRole('checkbox', { name: new RegExp(INCLUDE_RAW_LABEL) })
    expect(raw.getAttribute('aria-checked')).toBe('false')
    await click(screen.getByTestId('diagnostics-copy'))
    expect(mock.callsOf('diagnostics.copy')).toEqual([{}])
    expect(mock.callsOf('diagnostics.build')).toEqual([{}])
    const outcome = screen.getByTestId('diagnostics-outcome')
    expect(outcome.getAttribute('role')).toBe('status')
    expect(outcome.textContent).toContain('Copied to the clipboard.')
    expect(screen.getByTestId('diagnostics-redactions').textContent).toBe(
      'Removed first: 3 home folder paths.',
    )
  })

  it('includes raw log lines only when asked, and saves to the file the user chose', async () => {
    mount()
    await click(screen.getByRole('checkbox', { name: new RegExp(INCLUDE_RAW_LABEL) }))
    await click(screen.getByTestId('diagnostics-save'))
    expect(mock.callsOf('diagnostics.save')).toEqual([{ includeRaw: true }])
    expect(mock.callsOf('diagnostics.build')).toEqual([{ includeRaw: true }])
    expect(screen.getByTestId('diagnostics-outcome').textContent).toContain(
      'Saved to C:\\Users\\me\\Desktop\\dim-factory-diagnostics.txt.',
    )
    expect(screen.getByTestId('diagnostics-redactions').textContent).toBe(
      'Removed first: 9 home folder paths · 2 API keys · 1 email address.',
    )
  })

  it('says nothing when the save dialog is closed, and shows core’s error when it fails', async () => {
    mock.on('diagnostics.save', () => null)
    mount()
    await click(screen.getByTestId('diagnostics-save'))
    expect(screen.getByTestId('diagnostics-outcome').textContent).toBe('')
    mock.on('diagnostics.copy', () => {
      throw mockError('INTERNAL', 'The clipboard is not available.')
    })
    await click(screen.getByTestId('diagnostics-copy'))
    expect(screen.getByTestId('diagnostics-outcome').textContent).toBe('The clipboard is not available.')
  })

  it('keeps two one-line rows for the outcome from the start, so an answer moves nothing below it', async () => {
    mount()
    const outcome = screen.getByTestId('diagnostics-outcome')
    const rows = () => [screen.getByTestId('diagnostics-said'), screen.getByTestId('diagnostics-redactions')]
    // Before any answer: both rows are there, empty, at a fixed height.
    expect(outcome.className).toContain('h-8')
    for (const r of rows()) {
      expect(r.textContent).toBe('')
      expect(r.className).toContain('h-4')
      expect(r.className).toContain('truncate')
    }
    await click(screen.getByTestId('diagnostics-save'))
    // A long saved path is cut on its one line, and says itself in full as its tooltip.
    const [said, redactions] = rows()
    expect(said?.textContent).toBe('Saved to C:\\Users\\me\\Desktop\\dim-factory-diagnostics.txt.')
    expect(said?.getAttribute('title')).toBe(said?.textContent)
    expect(redactions?.getAttribute('title')).toBe('Removed first: 3 home folder paths.')
    expect(outcome.children).toHaveLength(2)
  })

  it('keeps Copy and Save the same size while one runs (the spinner takes the icon slot)', async () => {
    const held = deferred<void>()
    mock.on('diagnostics.copy', () => held.promise)
    mount()
    const copy = screen.getByTestId<HTMLButtonElement>('diagnostics-copy')
    const label = copy.textContent
    await act(async () => {
      fireEvent.click(copy)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(copy.disabled).toBe(true)
    expect(copy.textContent).toBe(label)
    expect(copy.querySelector('[data-spinner]')).not.toBeNull()
    expect(screen.getByTestId<HTMLButtonElement>('diagnostics-save').disabled).toBe(true)
    await act(async () => {
      held.resolve()
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(copy.disabled).toBe(false)
  })

  it('words the redaction counts, merging rules of one kind, with no em dash', () => {
    expect(redactionText({})).toBe('Nothing needed removing.')
    expect(redactionText({ email: 0 })).toBe('Nothing needed removing.')
    expect(redactionText({ 'openai-key': 1, 'anthropic-key': 1, username: 1 })).toBe(
      'Removed first: 2 API keys · 1 user name.',
    )
    expect(redactionText({ 'new-rule': 2 })).toBe('Removed first: 2 items matching "new-rule".')
    expect(redactionText({ pem: 1, jwt: 2, hostname: 1 })).not.toContain(EM_DASH)
  })
})

describe('Settings → Diagnostics: core’s link to Clear snapshots', () => {
  it('#/settings/storage?field=/storage/shadow opens Diagnostics and focuses the per-folder list once it is there', async () => {
    window.location.hash = '#/settings/storage?field=%2Fstorage%2Fshadow'
    render(
      <Providers>
        <SettingsPage section="storage" />
      </Providers>,
    )
    expect(screen.getByTestId('settings-content').dataset['section']).toBe('diagnostics')
    expect(document.activeElement).toBe(document.body)
    await settle(SECTION_LOAD_DELAY_MS)
    expect(document.activeElement).toBe(screen.getByTestId('storage-shadows'))
  })

  it("preflight's low-disk link (#/settings/storage?field=/storage) lands on the same list", async () => {
    window.location.hash = '#/settings/storage?field=%2Fstorage'
    render(
      <Providers>
        <SettingsPage section="storage" />
      </Providers>,
    )
    expect(screen.getByTestId('settings-content').dataset['section']).toBe('diagnostics')
    await settle(SECTION_LOAD_DELAY_MS)
    expect(document.activeElement).toBe(screen.getByTestId('storage-shadows'))
  })
})
