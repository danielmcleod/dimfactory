// Review: the setup card and an Experimental vendor ("Muse (`exec`, no relay, Experimental)", "Muse has an
// Experimental badge and is not in any built-in profile"; the first-run card is about
// Claude and Codex). Muse works only in folders the user trusted for it (FOLDER_TRUST_VENDORS), but Dim Factory never
// suggests an Experimental vendor: the card neither lists it nor offers to trust the composer's folder for it. The user
// picks Muse under "More", and the composer's strip offers the grant from there.
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppState, TrustState } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { needsFolderTrust } from '@shared/vendors.ts'
import { resetFolderTrustForTests } from '@renderer/components/recovery/folderTrust.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { resetSandboxSetupForTests } from '@renderer/components/recovery/sandboxSetup.ts'
import {
  listsOptionalVendor,
  offersFolderTrust,
  SetupCard,
} from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { resetTrustStateForTests, setComposerFolder } from '@renderer/state/trust.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { FOLDER, gemini, trustState } from '../gemini/fixtures.ts'

let mock: MockDimFactory

const state: AppState = {
  schemaVersion: 1,
  setupDismissed: false,
  firstLaunchCompletedAt: 0,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
}

const claudeReady = probeView('claude', 'ready', { healthDetail: 'Ready · 2.1.289' })
const codexLogin = probeView('codex', 'login-needed')

/** A Muse its probe found, ready (core's view: built, Experimental, with a probe result). */
function muse(over: Partial<ProbeView> = {}): ProbeView {
  const g = gemini()
  return {
    ...g,
    vendor: 'muse',
    displayName: 'Muse',
    experimental: true,
    healthDetail: 'Ready · 1.4.2',
    versionRecommended: null,
    testedUpTo: null,
    probe: g.probe === null ? null : { ...g.probe, vendor: 'muse', version: '1.4.2', checks: [] },
    ...over,
  }
}

beforeEach(() => {
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
      'trust.get': (req): TrustState => trustState(req.folder, false),
    },
  })
})

afterEach(() => {
  resetFolderTrustForTests()
  resetTrustStateForTests()
  tearDown(mock)
})

describe('the setup card with an Experimental Muse found on this computer', () => {
  it('Muse needs a folder grant, yet the card never lists it nor offers to trust a folder for it', async () => {
    expect(needsFolderTrust('muse')).toBe(true)
    expect(listsOptionalVendor(muse())).toBe(false)
    expect(offersFolderTrust(muse())).toBe(false)
    expect(offersFolderTrust(muse({ health: 'login-needed', healthDetail: 'Login needed' }))).toBe(false)
    // The same view without the Experimental flag would be offered (the rule is the flag, not the vendor).
    expect(offersFolderTrust(muse({ experimental: false }))).toBe(true)

    // A Claude-only user (Codex signed out): the card shows, with the composer's folder chosen.
    upsertProbes([claudeReady, codexLogin, muse()])
    setComposerFolder(FOLDER)
    render(
      <Providers>
        <SetupCard />
      </Providers>,
    )
    await settle()
    const card = screen.getByTestId('setup-card')
    expect(screen.getByTestId('setup-vendor-claude')).toBeTruthy()
    expect(screen.getByTestId('setup-vendor-codex')).toBeTruthy()
    expect(screen.queryByTestId('setup-vendor-muse')).toBeNull()
    expect(screen.queryByTestId('setup-muse-trust-chip')).toBeNull()
    expect(card.textContent).not.toContain('Muse')
    // Nothing asked core about Muse's trust for the folder.
    expect(mock.callsOf('trust.get')).toEqual([])
  })

  it('beside a found Gemini (not Experimental), only Gemini gets its row and its trust chip', async () => {
    upsertProbes([claudeReady, codexLogin, gemini(), muse()])
    render(
      <Providers>
        <SetupCard />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('setup-vendor-gemini')).toBeTruthy()
    expect(screen.getByTestId('setup-gemini-trust-chip')).toBeTruthy()
    expect(screen.queryByTestId('setup-vendor-muse')).toBeNull()
    expect(screen.queryByTestId('setup-muse-trust-chip')).toBeNull()
  })
})
