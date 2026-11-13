// Settings → Config file (a read-only view with error markers, and Restore
// last good; config errors and recovery; settings.spec.ts "config error file:line:col"): the user's dimfactory.json (or a
// project's, once a folder is chosen) as config.read returns it, read-only with numbered lines; each problem marked on
// its line with its message and listed as file:line:col (a click brings the line into view and focuses it); Restore
// last good through config.restoreBackup('last-good') with an Undo toast (core's backup), "already matches" without
// one, disabled with the reason when there is nothing to restore; Open in editor through shell.open; a config change
// reads the file again; core's config_invalid links focus the problem or Restore.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigIssue, ConfigReadResult, ConfigWriteResult } from '@shared/ipc.ts'
import {
  fileLines,
  issueLocation,
  issueSummary,
  markedRanges,
  OPEN_LABEL,
  RESTORE_LABEL,
} from '@renderer/pages/settings/ConfigFileSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { bumpConfigEpoch } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'

const USER_PATH = 'C:\\dim-factory-test-home\\dimfactory.json'
const PROJECT = 'C:\\work\\alpha'
const PROJECT_PATH = 'C:\\work\\alpha\\.dimfactory\\dimfactory.json'

const BROKEN = [
  '{',
  '  "passes": {',
  '    "plan": { "promptTemplte": "x" }',
  '  },',
  '  "ui": { "theme": "dim" }',
  '}',
  '',
].join('\n')

function issue(over: Partial<ConfigIssue>): ConfigIssue {
  return {
    file: USER_PATH,
    pointer: '/passes/plan/promptTemplte',
    line: 3,
    col: 15,
    endLine: 3,
    endCol: 30,
    code: 'unknown_key',
    message: 'Unknown key "promptTemplte" (did you mean "promptTemplate"?)',
    severity: 'error',
    ...over,
  }
}

const ISSUES: ConfigIssue[] = [
  issue({}),
  issue({
    pointer: '/ui/theme',
    line: 5,
    col: 20,
    endLine: 5,
    endCol: 25,
    code: 'invalid_value',
    message: 'theme must be one of system, light, dark',
  }),
]

function read(over: Partial<ConfigReadResult> = {}): ConfigReadResult {
  return {
    path: USER_PATH,
    exists: true,
    text: BROKEN,
    value: null,
    issues: ISSUES,
    version: 1,
    backups: [{ id: 'last-good', at: 1_700_000_000_000, bytes: 40, kind: 'last-good' }],
    lastGood: true,
    restorable: true,
    ...over,
  }
}

const write = (over: Partial<ConfigWriteResult> = {}): ConfigWriteResult => ({
  path: USER_PATH,
  changed: true,
  diff: '',
  backupId: 'b-7',
  ...over,
})

let mock: MockDimFactory
let userFile: ConfigReadResult

beforeEach(() => {
  userFile = read()
  mock = setUp({
    handlers: {
      'config.read': (req) =>
        req.scope === 'user'
          ? userFile
          : read({
              path: PROJECT_PATH,
              text: '{ "auto": false }\n',
              issues: [],
              backups: [],
              restorable: false,
            }),
      'config.restoreBackup': () => write(),
      'shell.open': () => undefined,
      'dialog.pickFolder': () => PROJECT,
      'folders.recent': () => [],
    },
  })
})

afterEach(() => tearDown(mock))

function mount(section = 'config'): void {
  render(
    <Providers>
      <SettingsPage section={section} />
    </Providers>,
  )
}

async function open(): Promise<void> {
  mount()
  await settle(SECTION_LOAD_DELAY_MS)
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const lastToast = () => useStore.getState().toasts.items.at(-1)

describe('Settings → Config file: the file as Dim Factory reads it', () => {
  it('is live, renders at once and reads the user file once it has been open a moment', async () => {
    expect(findSection('config')?.live).toBe(true)
    mount()
    expect(screen.getByTestId('config-path').textContent).toBe('Loading…')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: RESTORE_LABEL }).disabled).toBe(true)
    expect(mock.callsOf('config.read')).toHaveLength(0)
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.read')).toEqual([{ scope: 'user' }])
    expect(screen.getByTestId('config-path').textContent).toBe(USER_PATH)
  })

  it('shows every line, numbered and read-only, in monospace', async () => {
    await open()
    const lines = screen.getByTestId('config-file-lines')
    expect(lines.tagName).toBe('OL')
    expect(lines.className).toContain('font-mono')
    expect(lines.querySelectorAll(':scope > li')).toHaveLength(6)
    const line3 = screen.getByTestId('config-line-3')
    expect(line3.querySelector('span[aria-hidden]')?.textContent).toBe('3')
    expect(line3.querySelector('code')?.textContent).toBe('    "plan": { "promptTemplte": "x" }')
    expect(lines.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0)
    // Long lines wrap; the view never scrolls sideways or on its own.
    expect(line3.querySelector('code')?.className).toContain('whitespace-pre-wrap')
    expect(lines.className).not.toMatch(/overflow-(x-|y-)?(auto|scroll)/)
  })

  it('marks each problem on its line with its message, and lists them as file:line:col', async () => {
    await open()
    const line3 = screen.getByTestId('config-line-3')
    expect(line3.dataset['issue']).toBe('error')
    expect(line3.querySelector('mark[data-issue-mark]')?.textContent).toBe('"promptTemplte"')
    expect(within(line3).getByRole('note').textContent).toBe(
      'Column 15: Unknown key "promptTemplte" (did you mean "promptTemplate"?)',
    )
    expect(screen.getByTestId('config-line-5').dataset['issue']).toBe('error')
    expect(screen.getByTestId('config-line-1').dataset['issue']).toBeUndefined()
    const list = screen.getByTestId('config-issues')
    expect(list.textContent).toContain('2 errors. Runs are blocked until they are fixed.')
    const entries = within(list).getAllByTestId('config-issue')
    expect(entries.map((e) => e.textContent)).toEqual([
      `${USER_PATH}:3:15 Unknown key "promptTemplte" (did you mean "promptTemplate"?)`,
      `${USER_PATH}:5:20 theme must be one of system, light, dark`,
    ])
  })

  it('a click on a problem brings its line into view and focuses it (and only a click)', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
    try {
      await open()
      expect(scroll).not.toHaveBeenCalled()
      const [, second] = screen.getAllByTestId('config-issue')
      await click(second!)
      expect(document.activeElement).toBe(screen.getByTestId('config-line-5'))
      expect(scroll).toHaveBeenCalledTimes(1)
    } finally {
      scroll.mockRestore()
    }
  })

  it('reads the file again after a config change, keeping the last one on screen meanwhile', async () => {
    await open()
    userFile = read({ text: '{}\n', issues: [] })
    act(() => bumpConfigEpoch())
    expect(screen.getByTestId('config-file-lines')).toBeTruthy()
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.read')).toHaveLength(2)
    expect(screen.queryByTestId('config-issues')).toBeNull()
    expect(screen.getByTestId('config-line-1').textContent).toContain('{}')
  })

  it('says when the file does not exist yet, or could not be read', async () => {
    userFile = read({ exists: false, text: '', issues: [], backups: [], restorable: false, lastGood: false })
    await open()
    expect(screen.getByTestId('config-file-state').textContent).toBe(
      'You have no dimfactory.json yet. Dim Factory uses its built-in settings until you change one.',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: OPEN_LABEL }).disabled).toBe(true)
    expect(screen.getByRole('group', { name: `${OPEN_LABEL} The file does not exist yet` })).toBeTruthy()
  })

  it('shows the read error in place of the file', async () => {
    mock.on('config.read', () => {
      throw mockError('STORAGE', 'The file is not UTF-8.')
    })
    await open()
    expect(screen.getByTestId('config-file-state').textContent).toBe(
      'The file could not be read: The file is not UTF-8.',
    )
  })

  it('opens the file in the editor through shell.open', async () => {
    await open()
    await click(screen.getByRole('button', { name: OPEN_LABEL }))
    expect(mock.callsOf('shell.open')).toEqual([{ target: 'configFile', scope: 'user' }])
  })

  it('matches the helpers core and the CLI use for places and lines', () => {
    expect(issueLocation({ file: 'a.json', line: 2, col: 9 })).toBe('a.json:2:9')
    expect(fileLines('a\r\nb\n')).toEqual(['a', 'b'])
    expect(fileLines('a\n\n')).toEqual(['a', ''])
    expect(fileLines('')).toEqual([''])
    // Ranges: clipped to the line, merged, and an empty range still marks one place.
    expect(markedRanges([issue({ line: 1, col: 3, endLine: 1, endCol: 6 })], 1, 10)).toEqual([[2, 5]])
    expect(markedRanges([issue({ line: 1, col: 3, endLine: 2, endCol: 1 })], 1, 10)).toEqual([[2, 10]])
    expect(markedRanges([issue({ line: 1, col: 4, endLine: 1, endCol: 4 })], 1, 10)).toEqual([[3, 4]])
    expect(
      markedRanges(
        [
          issue({ line: 1, col: 1, endLine: 1, endCol: 5 }),
          issue({ line: 1, col: 3, endLine: 1, endCol: 8 }),
        ],
        1,
        10,
      ),
    ).toEqual([[0, 7]])
    expect(markedRanges([issue({ line: 2 })], 1, 10)).toEqual([])
    // What the problems mean for runs: user file, project file, warnings only.
    expect(issueSummary([issue({})], false)).toBe('1 error. Runs are blocked until they are fixed.')
    expect(issueSummary([issue({}), issue({ severity: 'warning' })], true)).toBe(
      '1 error · 1 warning. Runs in this folder are blocked until they are fixed.',
    )
    expect(issueSummary([issue({ severity: 'warning' }), issue({ severity: 'warning' })], false)).toBe(
      '2 warnings. Runs are not blocked.',
    )
  })
})

describe('Settings → Config file: Restore last good', () => {
  it('restores through config.restoreBackup(last-good) and offers Undo with core’s backup', async () => {
    await open()
    const restore = screen.getByRole<HTMLButtonElement>('button', { name: RESTORE_LABEL })
    expect(restore.disabled).toBe(false)
    await click(restore)
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'last-good' }])
    const t = lastToast()
    expect(t?.message).toBe('Restored the last good copy of dimfactory.json.')
    expect(t?.action?.label).toBe('Undo')
    // The file is read again after the restore.
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.read').length).toBeGreaterThanOrEqual(2)
    await act(async () => {
      const a = t?.action
      if (a !== undefined && 'onClick' in a && a.onClick !== undefined) await a.onClick()
    })
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.restoreBackup')).toEqual([
      { scope: 'user', backupId: 'last-good' },
      { scope: 'user', backupId: 'b-7' },
    ])
  })

  it('says when the file already matches, with nothing to undo', async () => {
    mock.on('config.restoreBackup', () => write({ changed: false, backupId: null }))
    await open()
    await click(screen.getByRole('button', { name: RESTORE_LABEL }))
    expect(lastToast()?.message).toBe('This file already matches the last good copy.')
    expect(lastToast()?.action).toBeUndefined()
  })

  it('shows core’s refusal', async () => {
    mock.on('config.restoreBackup', () => {
      throw mockError('NOT_FOUND', 'There is no earlier copy of this file to restore.')
    })
    await open()
    await click(screen.getByRole('button', { name: RESTORE_LABEL }))
    expect(lastToast()?.message).toBe('There is no earlier copy of this file to restore.')
    expect(lastToast()?.level).toBe('error')
  })

  it('is disabled with the reason when no earlier copy is saved', async () => {
    userFile = read({ backups: [], restorable: false, lastGood: false })
    await open()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: RESTORE_LABEL }).disabled).toBe(true)
    expect(
      screen.getByRole('group', { name: `${RESTORE_LABEL} No earlier copy of this file is saved yet` }),
    ).toBeTruthy()
  })

  it('falls back to the backup list when core does not say whether it can restore', async () => {
    const { restorable: _r, lastGood: _l, ...older } = read()
    userFile = older
    await open()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: RESTORE_LABEL }).disabled).toBe(false)
  })

  it('is the primary action while the file has errors, an outline button otherwise', async () => {
    await open()
    expect(screen.getByRole('button', { name: RESTORE_LABEL }).className).toContain('bg-primary')
    userFile = read({ issues: [] })
    act(() => bumpConfigEpoch())
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.getByRole('button', { name: RESTORE_LABEL }).className).not.toContain('bg-primary')
  })
})

describe('Settings → Config file: a project’s file', () => {
  it('shows a project’s file once a folder is chosen, and restores and opens that one', async () => {
    await open()
    await click(within(screen.getByTestId('config-scope-project')).getByRole('radio'))
    expect(screen.getByTestId('config-path').textContent).toBe('Choose a folder to see its project file.')
    await click(screen.getByTestId('config-project-choose'))
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.read').at(-1)).toEqual({ scope: 'project', folder: PROJECT })
    expect(screen.getByTestId('config-path').textContent).toBe(PROJECT_PATH)
    expect(screen.getByTestId('config-line-1').textContent).toContain('{ "auto": false }')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: RESTORE_LABEL }).disabled).toBe(true)
    await click(screen.getByRole('button', { name: OPEN_LABEL }))
    expect(mock.callsOf('shell.open')).toEqual([{ target: 'configFile', scope: 'project', folder: PROJECT }])
    // Back to the user's file.
    await click(within(screen.getByTestId('config-scope-user')).getByRole('radio'))
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.getByTestId('config-path').textContent).toBe(USER_PATH)
  })
})

describe('Settings → Config file: core’s config_invalid links', () => {
  it('?field=<pointer> focuses that problem once the file is read', async () => {
    window.location.hash = '#/settings/config?field=%2Fui%2Ftheme'
    mount()
    await settle(SECTION_LOAD_DELAY_MS)
    const [, second] = screen.getAllByTestId('config-issue')
    expect(document.activeElement).toBe(second)
  })

  it('?field=/backups/last-good focuses Restore once it can be used', async () => {
    window.location.hash = '#/settings/config?field=%2Fbackups%2Flast-good'
    mount()
    expect(document.activeElement).toBe(document.body)
    await settle(SECTION_LOAD_DELAY_MS)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: RESTORE_LABEL }))
  })
})

describe('Settings → Config file: a link about a project’s file', () => {
  it('?folder= opens that project’s file, and its Restore link focuses Restore there', async () => {
    mock.on('config.read', (req) =>
      req.scope === 'user'
        ? userFile
        : read({ path: PROJECT_PATH, issues: ISSUES.map((i) => ({ ...i, file: PROJECT_PATH })) }),
    )
    window.location.hash = `#/settings/config?field=%2Fbackups%2Flast-good&folder=${encodeURIComponent(PROJECT)}`
    mount()
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('config.read')).toEqual([{ scope: 'project', folder: PROJECT }])
    expect(
      within(screen.getByTestId('config-scope-project')).getByRole<HTMLInputElement>('radio').checked,
    ).toBe(true)
    expect(screen.getByTestId('config-path').textContent).toBe(PROJECT_PATH)
    expect(screen.getByTestId('config-issues').textContent).toContain(
      'Runs in this folder are blocked until they are fixed.',
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: RESTORE_LABEL }))
    await click(screen.getByRole('button', { name: RESTORE_LABEL }))
    expect(mock.callsOf('config.restoreBackup')).toEqual([
      { scope: 'project', folder: PROJECT, backupId: 'last-good' },
    ])
  })

  it('a problem’s link with ?folder= focuses that problem in the project’s file', async () => {
    mock.on('config.read', (req) =>
      req.scope === 'user'
        ? read({ issues: [] })
        : read({ path: PROJECT_PATH, issues: ISSUES.map((i) => ({ ...i, file: PROJECT_PATH })) }),
    )
    window.location.hash = `#/settings/config?field=%2Fui%2Ftheme&folder=${encodeURIComponent(PROJECT)}`
    mount()
    await settle(SECTION_LOAD_DELAY_MS)
    const [, second] = screen.getAllByTestId('config-issue')
    expect(second?.textContent).toContain(`${PROJECT_PATH}:5:20`)
    expect(document.activeElement).toBe(second)
  })
})
