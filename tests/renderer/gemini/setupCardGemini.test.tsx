// Gemini on the setup card (the Dashboard right rail's "setup card … offers install commands", the Gemini probe
// checks, readiness `trust`; Gemini install/login commands, gemini-trust.spec.ts).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, TrustState } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { NO_FOLDER_REASON } from '@renderer/components/recovery/FolderTrustChip.tsx'
import { resetFolderTrustForTests } from '@renderer/components/recovery/folderTrust.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetSandboxSetupForTests } from '@renderer/components/recovery/sandboxSetup.ts'
import {
  listsOptionalVendor,
  offersFolderTrust,
  SetupCard,
} from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { resetTrustStateForTests, setComposerFolder, trustEpochNow } from '@renderer/state/trust.ts'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { FOLDER, GEMINI_INSTALL, gemini, NOT_SIGNED_IN_DETAIL, OTHER_FOLDER, trustState } from './fixtures.ts'

let mock: MockDimFactory
let trusted: Set<string>

const state: AppState = {
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: 0,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
}

const claudeReady = probeView('claude', 'ready', { healthDetail: 'Ready · 2.1.289' })
const codexLogin = probeView('codex', 'login-needed')

beforeEach(() => {
  trusted = new Set()
  resetRecoveryForTests()
  resetSandboxSetupForTests()
  resetFolderTrustForTests()
  resetTrustStateForTests()
  mock = setUp({
    platform: 'darwin',
    handlers: {
      'state.get': () => state,
      'config.resolve': () => resolvedView({ profile: 'claude-only' }),
      'vendors.list': (): ProbeView[] => [],
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

async function mountCard(): Promise<void> {
  render(
    <Providers>
      <SetupCard />
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

const ID = 'setup-gemini-trust'
const status = (): string => screen.getByTestId(`${ID}-status`).textContent ?? ''
const phase = (): string | null => screen.getByTestId(`${ID}-chip`).getAttribute('data-phase')
const toasts = () => useStore.getState().toasts.items

describe('the Gemini row', () => {
  it('a ready Gemini reads ready with its version', async () => {
    upsertProbes([claudeReady, codexLogin, gemini()])
    await mountCard()
    const row = screen.getByTestId('setup-vendor-gemini')
    expect(row.getAttribute('data-health')).toBe('ready')
    expect(row.textContent).toContain('Gemini ready')
    expect(row.textContent).toContain('0.62.1')
  })

  it('a missing Gemini has no row: it is optional, so the card asks nothing of it', async () => {
    // ui-layout.spec.ts "the Dashboard as it loaded": Gemini's launch probe answers after the first-launch probes, and its
    // "not installed" block (detail, four fixes, the npm command) grew the card seconds after it showed. Settings →
    // Vendors and the composer's "More" list still say how to install it; the shell's Settings dot leaves it out too.
    upsertProbes([claudeReady, codexLogin, gemini({ state: 'not-installed' })])
    await mountCard()
    expect(screen.getByTestId('setup-vendor-codex')).toBeTruthy()
    expect(screen.queryByTestId('setup-vendor-gemini')).toBeNull()
    expect(screen.getByTestId('setup-card').textContent).not.toContain(GEMINI_INSTALL)
    expect(listsOptionalVendor(gemini({ state: 'not-installed' }))).toBe(false)
    // Nothing to trust a folder for either.
    expect(screen.queryByTestId(`${ID}-chip`)).toBeNull()
  })

  it('no Gemini row while its first probe runs, so no row comes and goes', async () => {
    const first: ProbeView = { ...gemini(), probe: null, health: 'checking', checking: true }
    upsertProbes([claudeReady, codexLogin, first])
    await mountCard()
    expect(screen.queryByTestId('setup-vendor-gemini')).toBeNull()
    expect(listsOptionalVendor(first)).toBe(false)
    // Claude and Codex keep their rows whatever their state; a found Gemini gets one, also while it is probed again.
    expect(listsOptionalVendor(claudeReady)).toBe(false)
    expect(listsOptionalVendor({ ...gemini(), checking: true })).toBe(true)
    expect(listsOptionalVendor(gemini({ state: 'login-needed' }))).toBe(true)
  })

  it('a Gemini probe that answers after the card showed adds nothing this visit; the next visit lists it', async () => {
    // Gemini's launch probe lands seconds after the first-launch probes: a row and a trust chip inserted then pushed
    // the git row, the profile line, the sandbox chip and the rail below them down on their own (CLS 0.0061).
    const first: ProbeView = { ...gemini(), probe: null, health: 'checking', checking: true }
    upsertProbes([claudeReady, codexLogin, first])
    const view = render(
      <Providers>
        <SetupCard />
      </Providers>,
    )
    await settle()
    const card = screen.getByTestId('setup-card')
    const before = [...card.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
    act(() => upsertProbes([gemini()]))
    await settle()
    expect(screen.queryByTestId('setup-vendor-gemini')).toBeNull()
    expect(screen.queryByTestId(`${ID}-chip`)).toBeNull()
    expect([...card.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))).toEqual(
      before,
    )
    // The next visit to the Dashboard decides the card again, with Gemini found: its row and its trust chip.
    view.unmount()
    await mountCard()
    expect(screen.getByTestId('setup-vendor-gemini').getAttribute('data-health')).toBe('ready')
    expect(screen.getByTestId(`${ID}-chip`)).toBeTruthy()
  })

  it('a signed-out Gemini offers the command that signs in', async () => {
    upsertProbes([claudeReady, codexLogin, gemini({ state: 'login-needed' })])
    await mountCard()
    const row = screen.getByTestId('setup-vendor-gemini')
    expect(row.textContent).toContain('Gemini: login needed')
    expect(row.textContent).toContain(NOT_SIGNED_IN_DETAIL)
    expect(within(row).getByTestId('recovery-gemini.login').textContent).toBe('Copy the sign-in command')
  })
})

describe('the Gemini trust chip on the setup card', () => {
  it('offers to trust a folder only once Gemini was found', () => {
    expect(offersFolderTrust(gemini())).toBe(true)
    expect(offersFolderTrust(gemini({ state: 'login-needed' }))).toBe(true)
    expect(offersFolderTrust(gemini({ state: 'not-installed' }))).toBe(false)
    expect(offersFolderTrust(gemini({ over: { probe: null, health: 'checking' } }))).toBe(false)
    expect(offersFolderTrust(probeView('claude', 'ready'))).toBe(false)
  })

  it('without a folder in the composer, the button waits with the reason', async () => {
    upsertProbes([claudeReady, codexLogin, gemini()])
    await mountCard()
    expect(phase()).toBe('no-folder')
    expect(status()).toBe('Choose a folder in the composer to trust it for Gemini')
    expect(screen.getByTestId<HTMLButtonElement>(ID).disabled).toBe(true)
    expect(
      screen.getByRole('group', { name: `Trust this folder for Gemini ${NO_FOLDER_REASON}` }),
    ).toBeTruthy()
    expect(mock.callsOf('trust.get')).toEqual([])
  })

  it('asks core about the composer’s folder, then trusts it with trust.set on the click', async () => {
    upsertProbes([claudeReady, codexLogin, gemini()])
    setComposerFolder(FOLDER)
    const answer = deferred<TrustState>()
    mock.on('trust.get', () => answer.promise)
    await mountCard()
    // Before core answered: the status line alone.
    expect(phase()).toBe('checking')
    expect(status()).toBe(`Checking Gemini's trust for ${FOLDER}…`)
    expect(screen.queryByTestId(ID)).toBeNull()
    expect(screen.queryByTestId(`${ID}-means`)).toBeNull()
    await act(async () => {
      answer.resolve(trustState(FOLDER, false))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('trust.get')).toEqual([{ folder: FOLDER }])
    expect(phase()).toBe('needed')
    expect(status()).toBe(`Gemini is not trusted in ${FOLDER} yet`)
    expect(screen.getByTestId(`${ID}-means`).textContent).toContain(
      'Gemini may read and act in this folder without its own trust prompt',
    )
    // Nothing is written on its own.
    await settle(60_000)
    expect(mock.callsOf('trust.set')).toEqual([])

    mock.on('trust.get', (req) => trustState(req.folder, trusted.has(req.folder)))
    const epoch = trustEpochNow()
    await click(screen.getByTestId(ID))
    expect(mock.callsOf('trust.set')).toEqual([
      { folder: FOLDER, grant: { kind: 'vendorFolder', vendor: 'gemini' }, trusted: true },
    ])
    expect(phase()).toBe('trusted')
    expect(status()).toBe(`Gemini trusted in ${FOLDER}`)
    expect(screen.queryByTestId(ID)).toBeNull()
    expect(screen.getByTestId(`${ID}-means`).textContent).toBe(
      'Gemini may read and act in this folder without its own trust prompt. Revoke it in Settings → Vendors.',
    )
    // The composer's checks and every other trust view ask again.
    expect(trustEpochNow()).toBe(epoch + 1)
    const t = toasts().find((x) => x.message === `Gemini trusted in ${FOLDER}`)
    expect(t?.action?.label).toBe('Undo')
  })

  it('a folder already trusted reads so, with no button', async () => {
    trusted.add(FOLDER)
    upsertProbes([claudeReady, codexLogin, gemini()])
    setComposerFolder(FOLDER)
    await mountCard()
    expect(phase()).toBe('trusted')
    expect(status()).toBe(`Gemini trusted in ${FOLDER}`)
    expect(screen.queryByTestId(ID)).toBeNull()
  })

  it('follows the composer to another folder', async () => {
    trusted.add(FOLDER)
    upsertProbes([claudeReady, codexLogin, gemini()])
    setComposerFolder(FOLDER)
    await mountCard()
    expect(phase()).toBe('trusted')
    act(() => setComposerFolder(OTHER_FOLDER))
    await settle()
    expect(mock.callsOf('trust.get').at(-1)).toEqual({ folder: OTHER_FOLDER })
    expect(phase()).toBe('needed')
    expect(status()).toBe(`Gemini is not trusted in ${OTHER_FOLDER} yet`)
  })
})
