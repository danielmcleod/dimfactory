// Settings → Isolation & Verify, the Isolation half (`isolation` {mode, branch, worktree {copy, install,
// installCommand, autoApply}} and `verify.baseline`; Settings, "Save" with
// an undo toast). Core's resolved values with their source; every control writes one config.patch (to the chosen
// project, or your settings without one) with Undo, showing the value at once; the install command is split as core
// splits it and shell syntax is refused with an install command's words, writing nothing; the copy list is one line
// until its editor is opened. Every control is there (disabled) before core answers, so nothing moves.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import {
  AUTO_APPLY_LABEL,
  copyProblem,
  copySummary,
  NEW_BRANCH_LABEL,
  NO_COPY,
  RUN_LOCATION_LABEL,
} from '@renderer/pages/settings/isolation/IsolationGroup.tsx'
import { installCommandLine, parseInstallCommand } from '@renderer/pages/settings/isolation/installCommand.ts'
import { BASELINE_LABEL } from '@renderer/pages/settings/IsolationSection.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { SETTINGS_FIELDS } from '@renderer/pages/settings/index.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { fakeResolve, FOLDER } from '../composer/fixtures.tsx'

const EM_DASH = '\u2014'

let mock: MockDimFactory
let copy: string[]

function resolveIsolation() {
  const base = fakeResolve()
  return (req: { folder?: string; overrides?: RunOverrides }) => {
    const r = base(req)
    r.config.isolation.worktree.copy = [...copy]
    r.config.isolation.worktree.installCommand = ['pnpm', 'install', '--offline']
    r.provenance['/isolation/mode'] = { source: 'default' }
    r.provenance['/isolation/worktree/install'] = { source: 'project', file: 'dimfactory.json', line: 3 }
    return r
  }
}

beforeEach(() => {
  copy = ['.env']
  mock = setUp({
    handlers: {
      'config.resolve': resolveIsolation(),
      'verify.detect': () => [],
      'folders.recent': () => [],
      'config.patch': () => ({
        path: 'C:\\work\\repo\\.dimfactory\\dimfactory.json',
        changed: true,
        diff: '',
        backupId: 'b1',
      }),
      'config.restoreBackup': () => ({ path: '', changed: true, diff: '', backupId: null }),
    },
  })
})

afterEach(() => tearDown(mock))

function render0(folder: string | null): void {
  window.location.hash =
    folder !== null ? `#/settings/isolation?folder=${encodeURIComponent(folder)}` : '#/settings/isolation'
  render(
    <Providers>
      <SettingsPage section="isolation" />
    </Providers>,
  )
}

async function mount(folder: string | null = FOLDER): Promise<HTMLElement> {
  render0(folder)
  await settle(SECTION_LOAD_DELAY_MS)
  await settle()
  return screen.getByTestId('settings-content')
}

const lastPatch = (): { scope: string; folder?: string; ops: JsonPatchOp[] } | undefined =>
  mock.callsOf('config.patch').at(-1)
const lastToast = () => useStore.getState().toasts.items.at(-1)

async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el)
  await settle()
}

describe('Settings → Isolation & Verify, the Isolation half', () => {
  it('shows every control before core answers (disabled), then core’s values with their source', async () => {
    render0(FOLDER)
    // Before anything is read: the controls are there, disabled; nothing will move when the values land.
    expect(screen.getByRole('group', { name: RUN_LOCATION_LABEL })).toBeTruthy()
    expect(screen.getByTestId<HTMLInputElement>('isolation-mode-inPlace').disabled).toBe(true)
    expect(screen.getByRole('switch', { name: NEW_BRANCH_LABEL }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('isolation-copy-summary').textContent).toBe('Reading the settings…')
    expect(screen.getByTestId<HTMLInputElement>('isolation-install-command').disabled).toBe(true)
    await settle(SECTION_LOAD_DELAY_MS)
    await settle()
    expect(screen.getByTestId<HTMLInputElement>('isolation-mode-inPlace').checked).toBe(true)
    expect(screen.getByTestId<HTMLInputElement>('isolation-mode-inPlace').disabled).toBe(false)
    expect(screen.getByTestId<HTMLInputElement>('isolation-install-ask').checked).toBe(true)
    expect(screen.getByTestId('isolation-install-source').getAttribute('data-source')).toBe('project')
    expect(screen.getByTestId('isolation-copy-summary').textContent).toBe('.env')
    expect(screen.getByTestId<HTMLInputElement>('isolation-install-command').value).toBe(
      'pnpm install --offline',
    )
    expect(screen.getByRole('switch', { name: AUTO_APPLY_LABEL }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('switch', { name: BASELINE_LABEL }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('isolation-group').textContent?.includes(EM_DASH)).toBe(false)
  })

  it('writes run location, a new branch, the install policy, autoApply and the baseline check, each with Undo', async () => {
    await mount()
    await click(screen.getByTestId('isolation-mode-worktree'))
    expect(lastPatch()).toEqual({
      scope: 'project',
      folder: FOLDER,
      ops: [{ op: 'replace', path: '/isolation/mode', value: 'worktree' }],
    })
    expect(lastToast()?.message).toBe('Runs work in an isolated copy by default')
    expect(lastToast()?.action?.label).toBe('Undo')
    await click(screen.getByRole('switch', { name: NEW_BRANCH_LABEL }))
    expect(lastPatch()?.ops).toEqual([{ op: 'replace', path: '/isolation/branch', value: 'runBranch' }])
    await click(screen.getByTestId('isolation-install-never'))
    expect(lastPatch()?.ops).toEqual([{ op: 'replace', path: '/isolation/worktree/install', value: 'never' }])
    expect(lastToast()?.message).toBe('Isolated runs never install dependencies')
    await click(screen.getByRole('switch', { name: AUTO_APPLY_LABEL }))
    expect(lastPatch()?.ops).toEqual([{ op: 'replace', path: '/isolation/worktree/autoApply', value: true }])
    await click(screen.getByRole('switch', { name: BASELINE_LABEL }))
    expect(lastPatch()?.ops).toEqual([{ op: 'replace', path: '/verify/baseline', value: true }])
    // Undo restores core's backup of the file.
    await act(async () => {
      const a = lastToast()?.action
      if (a !== undefined && 'onClick' in a) await a.onClick()
    })
    await settle()
    expect(mock.callsOf('config.restoreBackup').at(-1)).toEqual({
      scope: 'project',
      folder: FOLDER,
      backupId: 'b1',
    })
  })

  it('without a project, writes your settings', async () => {
    await mount(null)
    await click(screen.getByTestId('isolation-install-auto'))
    expect(lastPatch()).toEqual({
      scope: 'user',
      ops: [{ op: 'replace', path: '/isolation/worktree/install', value: 'auto' }],
    })
  })

  it('the install command: shell syntax refused with an install command’s words (nothing written); a valid line saved as argv; empty goes back to detection', async () => {
    await mount()
    const box = screen.getByTestId<HTMLInputElement>('isolation-install-command')
    const error = screen.getByTestId('isolation-install-command-error')
    expect(error.className).toContain('min-h-4')
    fireEvent.change(box, { target: { value: 'pnpm install && pnpm build' } })
    await click(screen.getByTestId('isolation-install-command-save'))
    expect(error.textContent).toBe(
      '`&` needs a shell, and Dim Factory runs install commands without one: use a package script',
    )
    expect(mock.callsOf('config.patch')).toEqual([])

    fireEvent.change(box, { target: { value: 'npm ci --ignore-scripts' } })
    expect(error.textContent).toBe('')
    fireEvent.keyDown(box, { key: 'Enter' })
    await settle()
    expect(lastPatch()?.ops).toEqual([
      { op: 'replace', path: '/isolation/worktree/installCommand', value: ['npm', 'ci', '--ignore-scripts'] },
    ])
    expect(lastToast()?.message).toBe('Saved the install command')

    await click(screen.getByTestId('isolation-install-command-detect'))
    expect(lastPatch()?.ops).toEqual([
      { op: 'replace', path: '/isolation/worktree/installCommand', value: null },
    ])
    expect(lastToast()?.message).toBe('Isolated runs use the detected install command')
  })

  it('the copy list is one line until its editor opens; adding and removing write the whole list', async () => {
    await mount()
    const edit = screen.getByTestId('isolation-copy-edit')
    expect(edit.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('isolation-copy-editor')).toBeNull()
    // The toggle keeps one width (Edit, Done).
    expect(edit.querySelector('[data-stable-label]')).not.toBeNull()
    await click(edit)
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    expect(edit.textContent).toBe('Done')
    const input = screen.getByTestId<HTMLInputElement>('isolation-copy-input')
    fireEvent.change(input, { target: { value: '.env' } })
    await click(screen.getByTestId('isolation-copy-add'))
    expect(screen.getByTestId('isolation-copy-problem').textContent).toBe(
      'That pattern is already in the list.',
    )
    expect(mock.callsOf('config.patch')).toEqual([])
    fireEvent.change(input, { target: { value: 'config/*.local.json' } })
    await click(screen.getByTestId('isolation-copy-add'))
    expect(lastPatch()?.ops).toEqual([
      { op: 'replace', path: '/isolation/worktree/copy', value: ['.env', 'config/*.local.json'] },
    ])
    // Shown at once, until core's next answer.
    expect(screen.getByTestId('isolation-copy-summary').textContent).toBe('.env, config/*.local.json')
    expect(input.value).toBe('')
    const remove = screen.getAllByTestId('isolation-copy-remove')[0] as HTMLElement
    expect(remove.getAttribute('aria-label')).toBe('Remove .env')
    await click(remove)
    expect(lastPatch()?.ops).toEqual([
      { op: 'replace', path: '/isolation/worktree/copy', value: ['config/*.local.json'] },
    ])
  })

  it('its rows are in the Settings index (the palette lands on them)', () => {
    const ids = new Set(SETTINGS_FIELDS.filter((f) => f.section === 'isolation').map((f) => f.id))
    for (const id of [
      '/isolation/mode',
      '/isolation/branch',
      '/isolation/worktree/copy',
      '/isolation/worktree/install',
      '/isolation/worktree/installCommand',
      '/isolation/worktree/autoApply',
      '/verify/baseline',
    ])
      expect(ids.has(id), id).toBe(true)
  })

  it('words and checks', () => {
    expect(copySummary([])).toBe(NO_COPY)
    expect(copyProblem(' ', [])).toContain('Type a file name')
    expect(copyProblem('x'.repeat(261), [])).toBe('A pattern can be at most 260 characters.')
    expect(
      copyProblem(
        'b',
        Array.from({ length: 50 }, (_, i) => `f${i}`),
      ),
    ).toBe('At most 50 patterns.')
    expect(parseInstallCommand('')).toEqual({ ok: false, message: 'The install command is empty' })
    expect(parseInstallCommand('a\nb')).toEqual({ ok: false, message: 'An install command must be one line' })
    expect(parseInstallCommand('uv sync --frozen')).toEqual({ ok: true, argv: ['uv', 'sync', '--frozen'] })
    expect(installCommandLine(['pnpm', 'install', 'a b'])).toBe("pnpm install 'a b'")
    expect(installCommandLine('npm ci')).toBe('npm ci')
    expect(installCommandLine(null)).toBe('')
  })
})
