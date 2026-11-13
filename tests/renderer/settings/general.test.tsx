// Settings → General (default profile, timeouts, ask.denyPauses,
// close-to-tray, storage retention; schema bounds, semantic rules, provenance, "Save … an undo toast follows"): values
// from config.resolve once the section is open; each control writes the user file with exactly one config.patch op and
// offers Undo; values the schema or the timeout order rule would refuse are named and nothing is written; each value says
// where it comes from, and a chosen project's overrides are named.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProvenanceMap } from '@shared/config-schema.ts'
import type { ConfigWriteResult, ResolvedWithProvenance } from '@shared/ipc.ts'
import { LOAD_DELAY_MS } from '@renderer/pages/settings/general/ProjectFolder.tsx'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { findSection } from '@renderer/pages/settings/sections.ts'
import { useStore } from '@renderer/state/store.ts'
import { Providers, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { mockError } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'

const EM_DASH = '\u2014'
const USER_FILE = 'C:\\home\\dimfactory.json'
const PROJECT = 'C:\\work\\app'
const PROJECT_FILE = 'C:\\work\\app\\.dimfactory\\dimfactory.json'

let mock: MockDimFactory
let backupId: string | null

const write = (id: string | null): ConfigWriteResult => ({
  path: USER_FILE,
  changed: true,
  diff: '',
  backupId: id,
})

function view(
  over: { provenance?: ProvenanceMap; stallMs?: number; profile?: string } = {},
): ResolvedWithProvenance {
  const base = resolvedView({
    profile: over.profile ?? 'claude-only',
    profiles: ['balanced', 'claude-only', 'fast', 'mine'],
  })
  return {
    ...base,
    config: {
      ...base.config,
      ask: { denyPauses: false },
      ui: { theme: 'system', accent: 'slate', closeToTray: 'auto', streamFontSize: 13, experience: null },
      timeouts: {
        stallMs: over.stallMs ?? 300_000,
        hardKillMs: 1_200_000,
        toolStallMs: 900_000,
        askMs: 600_000,
      },
      storage: { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
    },
    provenance: over.provenance ?? {
      '/profile': { source: 'default' },
      '/ask/denyPauses': { source: 'default' },
      '/ui/closeToTray': { source: 'default' },
      '/timeouts/stallMs': { source: 'user', file: USER_FILE, line: 3 },
      '/timeouts/hardKillMs': { source: 'default' },
      '/timeouts/toolStallMs': { source: 'default' },
      '/timeouts/askMs': { source: 'default' },
      '/storage/keepRuns': { source: 'default' },
      '/storage/keepDays': { source: 'default' },
      '/storage/rawLogDays': { source: 'default' },
    },
  }
}

beforeEach(() => {
  backupId = 'b-1'
  mock = setUp({
    handlers: {
      'config.resolve': (req) =>
        req.folder === PROJECT
          ? view({
              stallMs: 720_000,
              profile: 'fast',
              provenance: {
                ...view().provenance,
                '/profile': { source: 'project', file: PROJECT_FILE, line: 2 },
                '/timeouts/stallMs': { source: 'project', file: PROJECT_FILE, line: 4 },
              },
            })
          : view(),
      'config.patch': () => write(backupId),
      'config.restoreBackup': () => write(null),
      'folders.recent': () => [],
    },
  })
})

afterEach(() => tearDown(mock))

async function mount(): Promise<HTMLElement> {
  render(
    <Providers>
      <SettingsPage section="general" />
    </Providers>,
  )
  await settle(LOAD_DELAY_MS)
  return screen.getByTestId('settings-general')
}

async function pick(testId: string, name: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('option', { name }), { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

async function type(testId: string, text: string): Promise<void> {
  const input = screen.getByTestId(testId)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await settle()
}

const lastToast = () => useStore.getState().toasts.items.at(-1)
const patches = () => mock.callsOf('config.patch')

describe('Settings → General', () => {
  it('is live: nothing is read while passing through, then core’s values', async () => {
    expect(findSection('general')?.live).toBe(true)
    render(
      <Providers>
        <SettingsPage section="general" />
      </Providers>,
    )
    expect(mock.callsOf('config.resolve')).toHaveLength(0)
    // Until the values arrive each control's place is kept (same size), with no control in it.
    expect(screen.queryByTestId('general-timeout-stallMs')).toBeNull()
    expect(screen.queryByTestId('general-deny-pauses')).toBeNull()
    expect(screen.getByTestId('general-profile').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('settings-general').getAttribute('aria-busy')).toBe('true')
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('config.resolve')).toEqual([{}])
    expect(screen.getByTestId<HTMLInputElement>('general-timeout-stallMs').value).toBe('5')
    expect(screen.getByTestId<HTMLInputElement>('general-timeout-hardKillMs').value).toBe('20')
    expect(screen.getByTestId<HTMLInputElement>('general-storage-keepRuns').value).toBe('300')
    expect(screen.getByTestId('general-profile').textContent).toContain('claude-only')
    expect(screen.getByTestId('settings-general').textContent).not.toContain(EM_DASH)
  })

  it('marks every row with its Settings-index field id', async () => {
    const content = await mount()
    for (const id of [
      '/profile',
      '/ask/denyPauses',
      '/ui/closeToTray',
      '/timeouts/stallMs',
      '/timeouts/hardKillMs',
      '/timeouts/toolStallMs',
      '/timeouts/askMs',
      '/storage/keepRuns',
      '/storage/keepDays',
      '/storage/rawLogDays',
    ])
      expect(content.querySelector(`[data-setting-field="${id}"]`), id).not.toBeNull()
    expect(screen.getByLabelText('Stall warning')).toBe(screen.getByTestId('general-timeout-stallMs'))
    expect(screen.getByLabelText('Runs kept')).toBe(screen.getByTestId('general-storage-keepRuns'))
  })

  it('the default profile writes /profile in your file, with Undo from core’s backup', async () => {
    await mount()
    await pick('general-profile', 'fast')
    expect(patches()).toEqual([{ scope: 'user', ops: [{ op: 'replace', path: '/profile', value: 'fast' }] }])
    expect(lastToast()?.message).toBe('Default profile: fast')
    await act(async () => {
      const action = lastToast()?.action
      if (action !== undefined && 'onClick' in action) await action.onClick()
    })
    expect(mock.callsOf('config.restoreBackup')).toEqual([{ scope: 'user', backupId: 'b-1' }])
  })

  it('Undo of a write that created your file removes the key again', async () => {
    backupId = null
    await mount()
    fireEvent.click(screen.getByTestId('general-deny-pauses'))
    await settle()
    expect(patches()).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/ask/denyPauses', value: true }] },
    ])
    expect(lastToast()?.message).toBe('A denied request pauses the run: on')
    await act(async () => {
      const action = lastToast()?.action
      if (action !== undefined && 'onClick' in action) await action.onClick()
    })
    expect(patches().at(-1)).toEqual({ scope: 'user', ops: [{ op: 'remove', path: '/ask/denyPauses' }] })
  })

  it('closing the window writes /ui/closeToTray as true, false or "auto"', async () => {
    await mount()
    await pick('general-close', 'Keep running in the tray')
    await pick('general-close', 'Quit Dim Factory')
    await pick('general-close', 'Automatic: keep running in the tray')
    expect(patches().map((p) => p.ops)).toEqual([
      [{ op: 'replace', path: '/ui/closeToTray', value: true }],
      [{ op: 'replace', path: '/ui/closeToTray', value: false }],
      [{ op: 'replace', path: '/ui/closeToTray', value: 'auto' }],
    ])
  })

  it('timeouts are written in milliseconds from the minutes typed', async () => {
    await mount()
    await type('general-timeout-stallMs', '10')
    await type('general-timeout-askMs', '2.5')
    await type('general-timeout-hardKillMs', '30')
    await type('general-timeout-toolStallMs', '0.5')
    expect(patches().map((p) => p.ops)).toEqual([
      [{ op: 'replace', path: '/timeouts/stallMs', value: 600_000 }],
      [{ op: 'replace', path: '/timeouts/askMs', value: 150_000 }],
      [{ op: 'replace', path: '/timeouts/hardKillMs', value: 1_800_000 }],
      [{ op: 'replace', path: '/timeouts/toolStallMs', value: 30_000 }],
    ])
    expect(lastToast()?.message).toBe('Tool stall: 0.5 min')
  })

  it('a value below the schema’s minimum is named and not written', async () => {
    await mount()
    await type('general-timeout-stallMs', '0.2')
    expect(patches()).toHaveLength(0)
    const row = screen.getByTestId('general-timeout-stallMs').closest('[data-setting-field]') as HTMLElement
    expect(within(row).getByRole('alert').textContent).toBe('At least 0.5 min.')
    expect(screen.getByTestId('general-timeout-stallMs').getAttribute('aria-invalid')).toBe('true')
    await type('general-timeout-askMs', '90')
    expect(
      screen.getByTestId('general-timeout-askMs').closest('[data-setting-field]')?.textContent,
    ).toContain('At most 60 min.')
    await type('general-storage-keepDays', '0')
    expect(
      screen.getByTestId('general-storage-keepDays').closest('[data-setting-field]')?.textContent,
    ).toContain('At least 1.')
    expect(patches()).toHaveLength(0)
  })

  it('a stall limit not shorter than the hard stop is blocked before anything is written', async () => {
    await mount()
    await type('general-timeout-stallMs', '20')
    await type('general-timeout-toolStallMs', '25')
    await type('general-timeout-hardKillMs', '10')
    expect(patches()).toHaveLength(0)
    const text = (id: string) => screen.getByTestId(id).closest('[data-setting-field]')?.textContent ?? ''
    expect(text('general-timeout-stallMs')).toContain('Must be shorter than the hard stop (20 min).')
    expect(text('general-timeout-toolStallMs')).toContain('Must be shorter than the hard stop (20 min).')
    expect(text('general-timeout-hardKillMs')).toContain('Must be longer than the tool limit (15 min).')
    // Correcting the value clears the error and writes.
    await type('general-timeout-hardKillMs', '40')
    expect(patches()).toEqual([
      { scope: 'user', ops: [{ op: 'replace', path: '/timeouts/hardKillMs', value: 2_400_000 }] },
    ])
    expect(text('general-timeout-hardKillMs')).not.toContain('Must be')
  })

  it('run history counts are written as whole numbers', async () => {
    await mount()
    await type('general-storage-keepRuns', '500')
    await type('general-storage-rawLogDays', '0')
    expect(patches().map((p) => p.ops)).toEqual([
      [{ op: 'replace', path: '/storage/keepRuns', value: 500 }],
      [{ op: 'replace', path: '/storage/rawLogDays', value: 0 }],
    ])
  })

  it('core’s refusal is shown and the value goes back', async () => {
    mock.on('config.patch', () => {
      throw mockError('VALIDATION', 'The change would make dimfactory.json invalid: x')
    })
    await mount()
    await type('general-timeout-askMs', '12')
    expect(lastToast()).toMatchObject({
      level: 'error',
      message: 'The change would make dimfactory.json invalid: x',
    })
    expect(screen.getByTestId<HTMLInputElement>('general-timeout-askMs').value).toBe('10')
  })

  it('each value says where it comes from', async () => {
    await mount()
    const stall = screen.getByTestId('general-source-/timeouts/stallMs')
    expect(stall.textContent).toBe('Yours')
    expect(stall.getAttribute('title')).toBe(`Your settings: ${USER_FILE}, line 3`)
    expect(screen.getByTestId('general-source-/timeouts/askMs').textContent).toBe('Default')
  })

  it('with a project chosen (deep link), the values it overrides are named', async () => {
    window.location.hash = `#/settings/general?folder=${encodeURIComponent(PROJECT)}`
    await mount()
    await settle(LOAD_DELAY_MS)
    expect(mock.callsOf('config.resolve')).toEqual(expect.arrayContaining([{}, { folder: PROJECT }]))
    expect(screen.getByTestId('general-folder-path').textContent).toBe(PROJECT)
    expect(screen.getByTestId('general-folder-status').textContent).toBe(
      'app overrides 2 of these settings (marked Project).',
    )
    expect(screen.getByTestId('general-note-/timeouts/stallMs').textContent).toBe(
      'app sets this to 12 min, so runs there use that.',
    )
    expect(screen.getByTestId('general-note-/profile').textContent).toBe(
      'app sets this to fast, so runs there use that.',
    )
    expect(screen.getByTestId('general-source-/timeouts/stallMs').textContent).toBe('Project')
    // Your own value is what the field edits.
    expect(screen.getByTestId<HTMLInputElement>('general-timeout-stallMs').value).toBe('5')
    expect(screen.queryByTestId('general-note-/timeouts/askMs')).toBeNull()
    // Clearing the project drops the notes.
    fireEvent.click(screen.getByTestId('general-folder-clear'))
    await settle()
    expect(screen.queryByTestId('general-note-/timeouts/stallMs')).toBeNull()
  })
})
