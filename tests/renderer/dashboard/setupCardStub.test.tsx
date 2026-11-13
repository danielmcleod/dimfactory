// Setup card, a vendor not in this build (the first-run script's "Codex not installed [copy]", first-launch.spec.ts): core's view
// of a registry stub carries the stub's probe, whose check offers "Use Claude instead" and
// the install command. The row stays greyed ("Codex: arrives in a later version") and offers only the install command:
// no switch button and no "Pick another vendor" detail (the profile already leaves the vendor out).
import '../helpers/rtl.ts'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { SetupCard } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory

const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const INSTALL = 'npm install -g @openai/codex@latest'

beforeEach(() => {
  const state: AppState = {
    schemaVersion: 1,
    setupDismissed: false,
    firstLaunchCompletedAt: NOW,
    catalog: { lastRefreshAt: null, snoozedUntil: null },
    notifications: { pausedUntil: null },
  }
  mock = setUp({
    handlers: {
      'state.get': () => state,
      'config.resolve': () => resolvedView({ profile: 'claude-only' }),
    },
  })
  resetRecoveryForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

const ready = probeView('claude', 'ready', {
  probe: {
    vendor: 'claude',
    at: NOW,
    ok: true,
    version: '2.1.288',
    checks: [],
    capabilities: {} as never,
    models: [],
  },
})

const codexStub: ProbeView = probeView('codex', 'not-built', {
  built: false,
  healthDetail: 'Not available in this build',
  probe: {
    vendor: 'codex',
    at: NOW,
    ok: false,
    checks: [
      {
        id: 'vendor.codex.protocol',
        scope: 'vendor',
        status: 'fail',
        blocking: true,
        category: 'capability_missing',
        title: 'Codex: not available in this build',
        detail: 'This build of Dim Factory has no Codex adapter yet. Pick another vendor.',
        recovery: [
          {
            id: 'codex.switch-vendor',
            label: 'Use Claude instead',
            kind: 'switch_vendor',
            pass: 'all',
            to: 'claude',
            model: null,
          },
          {
            id: 'codex.install',
            label: 'Copy the install command',
            kind: 'shell_copy',
            command: INSTALL,
            shell: 'sh',
            reason: 'Install it now to use it once Dim Factory supports Codex',
            recheck: 'vendor.codex.bin',
          },
        ],
        at: NOW,
        ttlMs: 0,
      },
    ],
    capabilities: {} as never,
    models: [],
  },
})

describe('setup card: a vendor not in this build', () => {
  it('stays greyed and offers only the install command', async () => {
    upsertProbes([ready, codexStub])
    render(
      <Providers>
        <SetupCard />
      </Providers>,
    )
    await settle()
    const row = screen.getByTestId('setup-vendor-codex')
    expect(row.getAttribute('data-health')).toBe('not-built')
    expect(row.className).toContain('text-muted-foreground')
    expect(within(row).getByText('Codex: arrives in a later version')).toBeTruthy()
    expect(within(row).getByTestId<HTMLButtonElement>('recovery-codex.install').disabled).toBe(false)
    expect(within(row).getByText(INSTALL)).toBeTruthy()
    expect(within(row).getByText('Install it now to use it once Dim Factory supports Codex')).toBeTruthy()
    expect(within(row).queryByTestId('recovery-codex.switch-vendor')).toBeNull()
    expect(row.textContent).not.toContain('Pick another vendor')
  })
})
