// Quick composer, Dashboard v0: Run → runs.start with folder, task and
// overrides, then the Run view; ⌘/Ctrl+Enter; PREFLIGHT_BLOCKED renders core's blocking checks and goes nowhere;
// Queue · "Folder busy" when an active run holds the folder (or a parent/child); drafts per folder; profiles and the
// pass line from config.resolve, and its failure shown inline without blocking Run.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightReport } from '@shared/preflight.ts'
import { QuickComposer } from '@renderer/pages/dashboard/QuickComposer.tsx'
import {
  blockingChecks,
  folderBusy,
  normalizeFolder,
  passesLine,
  recentFolders,
} from '@renderer/pages/dashboard/composer-model.ts'
import { upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSummary } from '../helpers/fixtures.ts'
import { deferred, mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory

const FOLDER = 'C:\\work\\repo'

beforeEach(() => {
  mock = setUp({
    handlers: {
      'config.resolve': () => resolvedView({ profiles: ['balanced', 'claude-only', 'mine'] }),
      'runs.start': () => ({ runId: 'r9', displayNo: 9 }),
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  render(
    <Providers>
      <QuickComposer />
    </Providers>,
  )
  await settle()
}

function folderInput(): HTMLInputElement {
  return screen.getByTestId<HTMLInputElement>('composer-folder-input')
}
function taskBox(): HTMLTextAreaElement {
  return screen.getByTestId<HTMLTextAreaElement>('composer-task')
}
function runButton(): HTMLButtonElement {
  return screen.getByTestId<HTMLButtonElement>('composer-run')
}

/** What Run reads: its constant label, then the state shown beside it (UI standard: the button never changes size). */
const runReads = (): string => {
  const status = screen.getByTestId('composer-run-status').textContent ?? ''
  const label = runButton().textContent ?? ''
  return status === '' ? label : `${label} · ${status}`
}

async function fill(folder: string, task: string): Promise<void> {
  fireEvent.change(folderInput(), { target: { value: folder } })
  fireEvent.change(taskBox(), { target: { value: task } })
  await settle(500)
}

const blockedReport: PreflightReport = {
  mode: 'authoritative',
  ok: false,
  blocking: [
    {
      id: 'vendor.claude.auth',
      scope: 'vendor',
      status: 'fail',
      blocking: true,
      category: 'auth_required',
      title: 'Claude needs you to log in',
      detail: 'claude auth status exited with code 1.',
      recovery: [
        {
          id: 'a1',
          kind: 'shell_copy',
          label: 'Log in to Claude',
          command: 'claude auth login',
          shell: 'powershell',
          reason: 'Run this in a terminal, then check again.',
          recheck: 'vendor.claude.auth',
        },
        {
          id: 'a2',
          kind: 'switch_vendor',
          label: 'Use Codex instead',
          pass: 'all',
          to: 'codex',
          model: null,
        },
      ],
      at: 0,
      ttlMs: 0,
    },
  ],
  warnings: [],
  info: [],
}

describe('QuickComposer: Run', () => {
  it('starts the run with folder, task and overrides, then opens the Run view', async () => {
    await mount()
    await fill(FOLDER, '  Add a --version flag  ')
    expect(runReads()).toBe('Run')
    fireEvent.click(screen.getByTestId('composer-auto'))
    expect(screen.getByTestId('composer-auto').getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([
      { folder: FOLDER, task: 'Add a --version flag', overrides: { auto: true } },
    ])
    expect(window.location.hash).toBe('#/runs/r9')
    // The draft for the folder is gone once its run started.
    expect(window.localStorage.getItem(`dimf.draft.${FOLDER}`)).toBeNull()
  })

  it('sends no overrides when nothing was changed', async () => {
    await mount()
    await fill(FOLDER, 'Fix the tests')
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Fix the tests' }])
  })

  it('sends the profile picked in the dropdown, after resolving the config with it', async () => {
    await mount()
    await fill(FOLDER, 'Fix the tests')
    const trigger = screen.getByTestId('composer-profile')
    act(() => {
      fireEvent.keyDown(trigger, { key: 'Enter' })
    })
    await settle()
    act(() => {
      fireEvent.keyDown(screen.getByRole('option', { name: 'mine' }), { key: 'Enter' })
    })
    await settle()
    expect(mock.callsOf('config.resolve').at(-1)).toEqual({ folder: FOLDER, overrides: { profile: 'mine' } })
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start').at(-1)).toEqual({
      folder: FOLDER,
      task: 'Fix the tests',
      overrides: { profile: 'mine' },
    })
  })

  it('starts on Ctrl+Enter from the task box', async () => {
    await mount()
    await fill(FOLDER, 'Add a flag')
    await act(async () => {
      fireEvent.keyDown(taskBox(), { key: 'Enter', code: 'Enter', ctrlKey: true })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toHaveLength(1)
    expect(window.location.hash).toBe('#/runs/r9')
  })

  it('is disabled until there is a folder (full path) and a task, and says why', async () => {
    await mount()
    expect(runButton().disabled).toBe(true)
    expect(screen.getByLabelText('Choose a folder first')).toBeTruthy()
    fireEvent.change(folderInput(), { target: { value: 'work\\repo' } })
    expect(screen.getByLabelText('Enter the full path of the folder')).toBeTruthy()
    fireEvent.change(folderInput(), { target: { value: FOLDER } })
    expect(screen.getByLabelText('Describe the task first')).toBeTruthy()
    fireEvent.keyDown(taskBox(), { key: 'Enter', code: 'Enter', ctrlKey: true })
    await settle()
    expect(mock.callsOf('runs.start')).toHaveLength(0)
    fireEvent.change(taskBox(), { target: { value: 'Do it' } })
    expect(runButton().disabled).toBe(false)
  })

  it('shows Starting… while runs.start is pending, with the label readable', async () => {
    const hold = deferred<{ runId: string; displayNo: number }>()
    mock.on('runs.start', () => hold.promise)
    await mount()
    await fill(FOLDER, 'Add a flag')
    act(() => {
      fireEvent.click(runButton())
    })
    expect(runReads()).toBe('Run · Starting…')
    expect(runButton().disabled).toBe(true)
    await act(async () => {
      hold.resolve({ runId: 'r10', displayNo: 10 })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(window.location.hash).toBe('#/runs/r10')
  })
})

describe('QuickComposer: blocked and failed starts', () => {
  it('renders the blocking checks inline on PREFLIGHT_BLOCKED and does not navigate', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mock.on('runs.start', () => {
      throw mockError('PREFLIGHT_BLOCKED', 'Claude needs you to log in: …', blockedReport)
    })
    await mount()
    await fill(FOLDER, 'Add a flag')
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(window.location.hash).toBe('')
    const blockers = screen.getByTestId('composer-blockers')
    expect(blockers.textContent).toContain('No run was created.')
    expect(blockers.textContent).toContain('Claude needs you to log in')
    // The checks themselves open on the user's click (UI standard: core's answers never shift the page on their own).
    fireEvent.click(screen.getByTestId('preflight-details'))
    await settle()
    const chips = screen.getByTestId('preflight-chips')
    expect(chips.textContent).toContain('claude auth status exited with code 1.')
    expect(chips.textContent).toContain('claude auth login')
    // Copy works now; other recovery actions wait for recovery.execute.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy: Log in to Claude' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(writeText).toHaveBeenCalledWith('claude auth login')
    const other = screen.getByRole<HTMLButtonElement>('button', { name: 'Use Codex instead' })
    expect(other.disabled).toBe(true)
    expect(screen.queryByTestId('composer-error')).toBeNull()
    // A different folder clears what was blocking the old one.
    fireEvent.change(folderInput(), { target: { value: 'C:\\work\\other' } })
    await settle(500)
    expect(screen.queryByTestId('composer-blockers')).toBeNull()
  })

  it('shows any other error inline and as a toast', async () => {
    mock.on('runs.start', () => {
      throw mockError('STORAGE', 'The disk refused to write the run folder.')
    })
    await mount()
    await fill(FOLDER, 'Add a flag')
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId('composer-error').textContent).toBe('The disk refused to write the run folder.')
    expect(useStore.getState().toasts.items.map((t) => t.message)).toEqual([
      'The disk refused to write the run folder.',
    ])
    expect(window.location.hash).toBe('')
  })
})

describe('QuickComposer: folder busy', () => {
  it('labels Run "Queue · Folder busy" when an active run uses the folder, a parent or a child', async () => {
    upsertSummaries([makeSummary({ runId: 'a', status: 'running', folder: 'c:/Work/Repo/' })], {
      loaded: true,
    })
    await mount()
    await fill(FOLDER, 'Add a flag')
    expect(runReads()).toBe('Queue · Folder busy')
    expect(runButton().disabled).toBe(false)
    fireEvent.change(folderInput(), { target: { value: 'C:\\work\\repo\\packages\\cli' } })
    expect(runReads()).toBe('Queue · Folder busy')
    fireEvent.change(folderInput(), { target: { value: 'C:\\work\\repo-two' } })
    expect(runReads()).toBe('Run')
  })

  it('is plain Run when the run in that folder has finished', async () => {
    upsertSummaries([makeSummary({ runId: 'a', status: 'completed', folder: FOLDER })], { loaded: true })
    await mount()
    await fill(FOLDER, 'Add a flag')
    expect(runReads()).toBe('Run')
  })
})

describe('QuickComposer: folders, drafts and profile', () => {
  it('offers recent folders as chips and keeps a draft per folder', async () => {
    upsertSummaries(
      [
        makeSummary({ runId: 'a', folder: 'C:\\work\\api', status: 'completed', createdAt: 3 }),
        makeSummary({ runId: 'b', folder: 'C:\\work\\web', status: 'completed', createdAt: 2 }),
      ],
      { loaded: true },
    )
    window.localStorage.setItem('dimf.draft.C:\\work\\web', 'Fix the header')
    await mount()
    const chips = screen.getAllByRole('button', { name: /^Use folder / })
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Use folder C:\\work\\api',
      'Use folder C:\\work\\web',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Use folder C:\\work\\api' }))
    fireEvent.change(taskBox(), { target: { value: 'Add caching' } })
    expect(window.localStorage.getItem('dimf.draft.C:\\work\\api')).toBe('Add caching')
    fireEvent.click(screen.getByRole('button', { name: 'Use folder C:\\work\\web' }))
    expect(folderInput().value).toBe('C:\\work\\web')
    expect(taskBox().value).toBe('Fix the header')
  })

  it('chooses a folder with the system dialog', async () => {
    mock.on('dialog.pickFolder', () => 'D:\\projects\\site')
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-choose-folder'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(folderInput().value).toBe('D:\\projects\\site')
    await settle()
    expect(mock.callsOf('config.resolve').at(-1)).toEqual({ folder: 'D:\\projects\\site' })
  })

  it("shows the folder's profile and a one-line summary of its passes", async () => {
    mock.on('config.resolve', () =>
      resolvedView({ profile: 'mine', profiles: ['balanced', 'mine'], disabled: ['critic'] }),
    )
    await mount()
    await fill(FOLDER, 'x')
    expect(mock.callsOf('config.resolve').at(-1)).toEqual({ folder: FOLDER })
    expect(screen.getByTestId('composer-profile').textContent).toContain('mine')
    expect(screen.getByTestId('composer-passes').textContent).toBe(
      'Plan · Claude · opus · Implement · Claude · default · Review · Claude · sonnet · Fix · Claude · default',
    )
  })

  it('resolves again when a vendor probe changes (core picks the default profile from readiness)', async () => {
    await mount()
    const before = mock.callsOf('config.resolve').length
    act(() => upsertProbes([probeView('claude', 'ready')]))
    await settle()
    expect(mock.callsOf('config.resolve')).toHaveLength(before + 1)
  })

  it('shows a config error inline and still runs with the default profile', async () => {
    mock.on('config.resolve', () => {
      throw mockError('VALIDATION', 'dimfactory.json:3:5 Unknown key "promptTemplte".')
    })
    await mount()
    await fill(FOLDER, 'Add a flag')
    expect(screen.getByTestId('composer-config-error').textContent).toContain(
      'dimfactory.json:3:5 Unknown key "promptTemplte".',
    )
    expect(runButton().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(runButton())
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.start')).toEqual([{ folder: FOLDER, task: 'Add a flag' }])
  })
})

describe('composer-model', () => {
  it('normalizes folders and finds overlaps case-insensitively on Windows only', () => {
    expect(normalizeFolder('C:\\Work\\Repo\\', 'win32')).toBe('c:/work/repo')
    expect(normalizeFolder('C:\\', 'win32')).toBe('c:/')
    expect(normalizeFolder('\\\\server\\share\\x', 'win32')).toBe('//server/share/x')
    expect(normalizeFolder('/home/me/Repo/', 'linux')).toBe('/home/me/Repo')
    expect(folderBusy('C:\\work\\repo', ['c:/WORK/repo'], 'win32')).toBe(true)
    expect(folderBusy('/home/me/repo', ['/home/me/Repo'], 'linux')).toBe(false)
    expect(folderBusy('C:\\work', ['C:\\work\\repo'], 'win32')).toBe(true)
    expect(folderBusy('C:\\work\\repo2', ['C:\\work\\repo'], 'win32')).toBe(false)
    expect(folderBusy('', ['C:\\work'], 'win32')).toBe(false)
  })

  it('lists distinct recent folders, newest first, at most six', () => {
    const list = ['a', 'B', 'b', 'c', 'd', 'e', 'f', 'g'].map((f, i) =>
      makeSummary({ runId: `r${i}`, folder: `C:\\w\\${f}` }),
    )
    expect(recentFolders(list, 'win32')).toEqual([
      'C:\\w\\a',
      'C:\\w\\B',
      'C:\\w\\c',
      'C:\\w\\d',
      'C:\\w\\e',
      'C:\\w\\f',
    ])
  })

  it('reads blocking checks only from PREFLIGHT_BLOCKED', () => {
    expect(blockingChecks({ code: 'PREFLIGHT_BLOCKED', message: 'm', details: blockedReport })).toHaveLength(
      1,
    )
    expect(blockingChecks({ code: 'PREFLIGHT_BLOCKED', message: 'm' })).toEqual([])
    expect(blockingChecks({ code: 'STORAGE', message: 'm', details: blockedReport })).toBeNull()
  })

  it('summarizes enabled passes', () => {
    expect(passesLine(resolvedView({ disabled: ['plan', 'review', 'critic'] }).config)).toBe(
      'Implement · Claude · default · Fix · Claude · default',
    )
  })
})
