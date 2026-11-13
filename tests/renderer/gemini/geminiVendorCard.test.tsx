// Settings → Vendors, the Gemini card (path, version, checks with fixes, default
// model, Test = forced probe; Gemini launch "system node <entry>", the probe checks; trust.json `vendorFolder` grants).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigReadResult, RecentFolder, TrustState } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { resetFolderTrustForTests } from '@renderer/components/recovery/folderTrust.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { LAST_FOLDER_KEY } from '@renderer/pages/dashboard/composer-model.ts'
import { SECTION_LOAD_DELAY_MS } from '@renderer/pages/settings/sectionData.ts'
import { SettingsPage } from '@renderer/pages/settings/SettingsPage.tsx'
import { nodeEntryText } from '@renderer/pages/settings/vendors/PathField.tsx'
import {
  loadTrustedFolders,
  NO_TRUSTED_FOLDERS,
  trustedFoldersIntro,
} from '@renderer/pages/settings/vendors/TrustedFolders.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { resetTrustStateForTests, setComposerFolder } from '@renderer/state/trust.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import {
  FOLDER,
  GEMINI_COPY,
  GEMINI_ENTRY,
  GEMINI_INSTALL,
  GEMINI_MODEL_OPTIONS,
  GEMINI_SHIM,
  gemini,
  NOT_SIGNED_IN_DETAIL,
  NOW,
  OTHER_FOLDER,
  SYSTEM_NODE,
  trustState,
} from './fixtures.ts'

let mock: MockDimFactory
let listed: ProbeView[]
let trusted: Set<string>

const recent = (folder: string): RecentFolder => ({
  folder,
  scopeRoot: folder,
  lastRunAt: NOW,
  isGit: true,
  exists: true,
})

function readResult(value: unknown): ConfigReadResult {
  return {
    path: 'C:\\home\\dimfactory.json',
    exists: true,
    text: '{}',
    value,
    issues: [],
    version: 1,
    backups: [],
  }
}

beforeEach(() => {
  listed = [gemini()]
  trusted = new Set([FOLDER])
  resetRecoveryForTests()
  resetFolderTrustForTests()
  resetTrustStateForTests()
  mock = setUp({
    handlers: {
      'config.read': () => readResult({ vendors: { gemini: { defaultModel: 'gemini-2.5-flash' } } }),
      'config.patch': () => ({ path: 'C:\\home\\dimfactory.json', changed: true, diff: '', backupId: 'b1' }),
      'vendors.models': (req) => (req.vendor === 'gemini' ? GEMINI_MODEL_OPTIONS : []),
      'vendors.list': () => listed,
      'vendors.probe': () => listed,
      'folders.recent': () => [recent(FOLDER), recent(OTHER_FOLDER)],
      'trust.get': (req): TrustState => trustState(req.folder, trusted.has(req.folder)),
      'trust.set': (req): TrustState => {
        if (req.trusted) trusted.add(req.folder)
        else trusted.delete(req.folder)
        return trustState(req.folder, req.trusted)
      },
    },
  })
})

afterEach(() => {
  resetFolderTrustForTests()
  resetTrustStateForTests()
  tearDown(mock)
})

async function mount(): Promise<void> {
  render(
    <Providers>
      <SettingsPage section="vendors" />
    </Providers>,
  )
  await settle()
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el)
    await vi.advanceTimersByTimeAsync(0)
  })
  await settle()
}

const card = (): HTMLElement => screen.getByTestId('settings-vendor-gemini')
const toasts = () => useStore.getState().toasts.items

describe('the Gemini card', () => {
  it('shows its version against the floor and tested-up-to, the route, the npm shim and how it is started', async () => {
    upsertProbes([gemini()])
    await mount()
    expect(within(card()).getByRole('heading', { name: 'Gemini' })).toBeTruthy()
    expect(card().textContent).toContain('Ready · 0.62.1')
    // No floor (a Gemini without --acp fails its version check instead), 0.62.0 recommended, tested up to 0.64.0.
    expect(card().textContent).toContain('0.62.1 · recommended 0.62.0 · tested up to 0.64.0')
    expect(card().textContent).toContain('acp (acp)')
    expect(card().textContent).toContain(`In use: ${GEMINI_SHIM} (from the npm global folder)`)
    expect(screen.getByTestId('vendor-runs-as-gemini').textContent).toBe(
      `Runs with your system Node.js: ${SYSTEM_NODE} ${GEMINI_ENTRY}`,
    )
    expect(nodeEntryText('node', ['a.js'])).toBe('Runs with your system Node.js: node a.js')
    // Not in the "later version" line any more.
    expect(screen.queryByText(/Not in this version: .*Gemini/)).toBeNull()
  })

  it('says what each mode does over ACP, in core’s words', async () => {
    upsertProbes([gemini()])
    await mount()
    const rows = [...screen.getByTestId('vendor-modes-gemini').querySelectorAll('li')].map(
      (li) => li.textContent,
    )
    expect(rows).toEqual([
      `Read-only: Yes. ${GEMINI_COPY.readonly}`,
      `Approve edits: Yes. ${GEMINI_COPY.autoedit}`,
      `Approve everything: Yes. ${GEMINI_COPY.full}`,
    ])
  })

  it('lists every check with its fixes: a signed-out Gemini offers the sign-in command', async () => {
    listed = [gemini({ state: 'login-needed' })]
    upsertProbes(listed)
    await mount()
    const auth = screen.getByTestId('vendor-check-vendor.gemini.auth')
    expect(auth.getAttribute('data-status')).toBe('fail')
    expect(auth.textContent).toContain('Gemini is not signed in')
    expect(auth.textContent).toContain(NOT_SIGNED_IN_DETAIL)
    expect(within(auth).getByTestId('recovery-gemini.login').textContent).toBe('Copy the sign-in command')
    expect(auth.textContent).toContain('gemini')
    expect(screen.getByTestId('vendor-check-vendor.gemini.protocol').getAttribute('data-status')).toBe('pass')
  })

  it('a missing Gemini shows its install command', async () => {
    listed = [gemini({ state: 'not-installed' })]
    upsertProbes(listed)
    await mount()
    expect(card().textContent).toContain(GEMINI_INSTALL)
    expect(card().textContent).toContain('No Gemini executable in use.')
  })

  it('a Gemini without --acp names the version check that failed', async () => {
    listed = [gemini({ state: 'no-acp', version: '0.55.0' })]
    upsertProbes(listed)
    await mount()
    expect(screen.getByTestId('vendor-version-note-gemini').textContent).toBe(
      'Gemini 0.55.0 cannot talk to Dim Factory',
    )
  })

  it('the default model lists Gemini’s models from core', async () => {
    upsertProbes([gemini()])
    await mount()
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('vendors.models')).toContainEqual({ vendor: 'gemini' })
    expect(screen.getByTestId('vendor-default-model-gemini').textContent).toBe(
      'Gemini 2.5 Flash (gemini-2.5-flash)',
    )
  })

  it('the default model says a choice cut to the trigger’s width in full as its tooltip', async () => {
    // ui-layout.spec.ts (e): Gemini's "The CLI's default (gemini-3-pro-preview)" is cut with an ellipsis at the trigger's
    // fixed width; the trigger's title says it whole.
    mock.on('config.read', () => readResult({ vendors: { gemini: {} } }))
    mock.on('vendors.models', () => [
      {
        id: 'gemini-3-pro-preview',
        label: 'gemini-3-pro-preview',
        source: 'cli',
        isDefault: true,
        hasPricing: true,
      },
      ...GEMINI_MODEL_OPTIONS.filter((m) => m.id !== 'auto'),
    ])
    upsertProbes([gemini()])
    await mount()
    await settle(SECTION_LOAD_DELAY_MS)
    const trigger = screen.getByTestId('vendor-default-model-gemini')
    expect(trigger.textContent).toBe("The CLI's default (gemini-3-pro-preview)")
    expect(trigger.getAttribute('title')).toBe("The CLI's default (gemini-3-pro-preview)")
  })

  it('a chosen default model is the trigger’s tooltip too', async () => {
    upsertProbes([gemini()])
    await mount()
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.getByTestId('vendor-default-model-gemini').getAttribute('title')).toBe(
      'Gemini 2.5 Flash (gemini-2.5-flash)',
    )
  })

  it('Test is a forced probe of Gemini', async () => {
    upsertProbes([gemini()])
    await mount()
    await click(screen.getByTestId('vendor-test-gemini'))
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'gemini', force: true }])
  })
})

describe('Gemini’s trusted folders', () => {
  it('reads nothing while the section is passed through, then lists the folders with the grant', async () => {
    upsertProbes([gemini()])
    await mount()
    const list = screen.getByTestId('vendor-trusted-gemini')
    expect(list.textContent).toContain(trustedFoldersIntro('Gemini'))
    expect(screen.getByTestId('vendor-trusted-gemini-state').textContent).toBe('Reading trusted folders…')
    expect(mock.callsOf('trust.get')).toEqual([])
    await settle(SECTION_LOAD_DELAY_MS)
    const rows = screen.getAllByTestId('vendor-trusted-gemini-row')
    expect(rows.map((r) => r.querySelector('code')?.textContent)).toEqual([FOLDER])
    expect(rows[0]?.textContent).toContain('Trusted 2 d ago')
    expect(
      within(rows[0] as HTMLElement).getByRole('button', { name: `Revoke: Gemini in ${FOLDER}` }),
    ).toBeTruthy()
  })

  it('Revoke takes the grant back through trust.set, with Undo', async () => {
    upsertProbes([gemini()])
    await mount()
    await settle(SECTION_LOAD_DELAY_MS)
    const row = screen.getByTestId('vendor-trusted-gemini-row')
    await click(within(row).getByRole('button', { name: `Revoke: Gemini in ${FOLDER}` }))
    expect(mock.callsOf('trust.set')).toEqual([
      { folder: FOLDER, grant: { kind: 'vendorFolder', vendor: 'gemini' }, trusted: false },
    ])
    const t = toasts().find((x) => x.message === `Gemini no longer trusted in ${FOLDER}`)
    expect(t?.action?.label).toBe('Undo')
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.queryByTestId('vendor-trusted-gemini-row')).toBeNull()
    expect(screen.getByTestId('vendor-trusted-gemini-state').textContent).toBe(NO_TRUSTED_FOLDERS)
    // Undo trusts it again, and the list reads it back.
    await act(async () => {
      await (t?.action as { onClick: () => Promise<unknown> }).onClick()
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle(SECTION_LOAD_DELAY_MS)
    expect(mock.callsOf('trust.set').at(-1)).toEqual({
      folder: FOLDER,
      grant: { kind: 'vendorFolder', vendor: 'gemini' },
      trusted: true,
    })
    expect(screen.getAllByTestId('vendor-trusted-gemini-row')).toHaveLength(1)
  })

  it('asks about recent folders, the composer’s folder and its last one; one row per scope root, newest first', async () => {
    window.localStorage.setItem(LAST_FOLDER_KEY, 'C:\\work\\last')
    setComposerFolder('C:\\work\\now')
    trusted = new Set([FOLDER, 'C:\\work\\now'])
    mock.on('trust.get', (req): TrustState => {
      // C:\work\now is inside FOLDER's repository: the same grant, keyed by its scope root.
      if (req.folder === 'C:\\work\\now') return { ...trustState(FOLDER, true), folder: req.folder }
      return trustState(req.folder, trusted.has(req.folder))
    })
    const r = await loadTrustedFolders('gemini')
    expect(mock.callsOf('trust.get').map((q) => q.folder)).toEqual([
      FOLDER,
      OTHER_FOLDER,
      'C:\\work\\now',
      'C:\\work\\last',
    ])
    expect(r.ok && r.value.map((f) => f.folder)).toEqual([FOLDER])
  })

  it('no trusted folder reads "None yet."', async () => {
    trusted = new Set()
    upsertProbes([gemini()])
    await mount()
    await settle(SECTION_LOAD_DELAY_MS)
    expect(screen.getByTestId('vendor-trusted-gemini-state').textContent).toBe(NO_TRUSTED_FOLDERS)
  })

  it('only vendors that ask for folder trust have the list', async () => {
    upsertProbes([gemini(), { ...gemini(), vendor: 'claude', displayName: 'Claude' }])
    await mount()
    expect(screen.getByTestId('vendor-trusted-gemini')).toBeTruthy()
    expect(screen.queryByTestId('vendor-trusted-claude')).toBeNull()
  })
})
