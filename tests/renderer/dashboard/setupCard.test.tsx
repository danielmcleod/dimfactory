// Setup card (the right rail; the first-run script, first-launch.spec.ts): rows follow probe
// events as they arrive ("Checking Claude…", then "Claude ready" / "Claude: login needed [Copy the login command]" /
// "Codex not installed [Copy the install command]"), the profile first launch picked ("Using claude-only (Codex
// isn't ready)"), the Codex sandbox chip (its status line alone until Codex reports), and Dismiss
// (state.json) with Undo.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { profileLine, setupLine, SetupCard } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { bumpConfigEpoch, upsertProbes } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory
let state: AppState

const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()

beforeEach(() => {
  state = {
    schemaVersion: 1,
    setupDismissed: false,
    firstLaunchCompletedAt: NOW,
    catalog: { lastRefreshAt: null, snoozedUntil: null },
    notifications: { pausedUntil: null },
  }
  mock = setUp({
    handlers: {
      'state.get': () => state,
      'state.set': (req) => {
        state = {
          ...state,
          ...(req.setupDismissed !== undefined ? { setupDismissed: req.setupDismissed } : {}),
        }
        return state
      },
      'config.resolve': () => resolvedView({ profile: 'claude-only' }),
    },
  })
  resetRecoveryForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  tearDown(mock)
})

function check(vendor: string, id: string, over: Partial<CheckResult> = {}): CheckResult {
  return {
    id: `vendor.${vendor}.${id}`,
    scope: 'vendor',
    status: 'fail',
    blocking: true,
    title: 'Failed',
    detail: '',
    recovery: [],
    at: NOW,
    ttlMs: 0,
    ...over,
  }
}

function probed(
  vendor: string,
  health: ProbeView['health'],
  checks: CheckResult[],
  over: Partial<ProbeView> = {},
) {
  return probeView(vendor, health, {
    probe: {
      vendor,
      at: NOW,
      ok: health === 'ready',
      version: '2.1.288',
      checks,
      capabilities: {} as never,
      models: [],
    },
    ...over,
  })
}

const checking = (vendor: string): ProbeView =>
  probeView(vendor, 'checking', { healthDetail: 'Not checked yet', probe: null })

const claudeLogin = probed(
  'claude',
  'login-needed',
  [
    check('claude', 'auth', {
      title: 'Claude Code is not logged in',
      detail: 'claude auth status says no one is logged in.',
      category: 'auth_required',
      recovery: [
        {
          id: 'claude.login',
          label: 'Copy the login command',
          kind: 'shell_copy',
          command: 'claude auth login',
          shell: 'powershell',
          reason: 'Log in to Claude Code',
          recheck: 'vendor.claude.auth',
        },
      ],
    }),
  ],
  { healthDetail: 'Login needed' },
)

const codexMissing = probed(
  'codex',
  'not-installed',
  [
    check('codex', 'bin', {
      title: 'Codex is not installed',
      category: 'cli_missing',
      recovery: [
        {
          id: 'codex.install',
          label: 'Copy the install command',
          kind: 'shell_copy',
          command: 'npm install -g @openai/codex@latest',
          shell: 'powershell',
          reason: 'Codex is not installed',
          recheck: 'vendor.codex.bin',
        },
      ],
    }),
  ],
  { healthDetail: 'Not installed' },
)

async function mount(): Promise<void> {
  render(
    <Providers>
      <SetupCard />
    </Providers>,
  )
  await settle()
}

const row = (vendor: string): HTMLElement => screen.getByTestId(`setup-vendor-${vendor}`)

describe('setup card', () => {
  it('streams probe results into its rows as they arrive', async () => {
    upsertProbes([checking('claude'), checking('codex')])
    await mount()
    expect(row('claude').textContent).toBe('Checking Claude…')
    expect(row('codex').textContent).toBe('Checking Codex…')

    // A `probe` event, as the bridge stores it.
    act(() => upsertProbes([probed('claude', 'ready', [], { healthDetail: 'Ready · 2.1.288' })]))
    expect(row('claude').textContent).toBe('Claude ready2.1.288')
    expect(row('codex').textContent).toBe('Checking Codex…')

    act(() => upsertProbes([codexMissing]))
    expect(within(row('codex')).getByText('Codex not installed')).toBeTruthy()
    expect(within(row('codex')).getByTestId('recovery-codex.install').textContent).toBe(
      'Copy the install command',
    )
    expect(row('codex').textContent).toContain('npm install -g @openai/codex@latest')
  })

  it('offers the login command for a vendor that needs a login, with Re-check', async () => {
    mock.on('recovery.execute', () => ({ kind: 'shell_copy' as const, copied: 'claude auth login' }))
    mock.on('vendors.probe', () => [probed('claude', 'ready', [])])
    upsertProbes([claudeLogin, codexMissing])
    await mount()
    expect(within(row('claude')).getByText('Claude: login needed')).toBeTruthy()
    expect(row('claude').textContent).toContain('claude auth status says no one is logged in.')
    await act(async () => {
      fireEvent.click(within(row('claude')).getByTestId('recovery-claude.login'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    await act(async () => {
      fireEvent.click(within(row('claude')).getByTestId('recheck-claude.login'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(row('claude').textContent).toContain('Claude ready')
  })

  it('names the profile first launch selected and which vendor is not ready', async () => {
    upsertProbes([probed('claude', 'ready', []), codexMissing])
    await mount()
    expect(screen.getByTestId('setup-profile').textContent).toBe("Using claude-only (Codex isn't ready)")
    expect(mock.callsOf('config.resolve')).toEqual([{}])
    // First launch writes the profile after the probes: a config change reads it again.
    mock.on('config.resolve', () => resolvedView({ profile: 'balanced' }))
    act(() => bumpConfigEpoch())
    await settle()
    expect(screen.getByTestId('setup-profile').textContent).toBe("Using balanced (Codex isn't ready)")
  })

  // The vendor_setup chip (codex-sandbox.spec.ts) is live; until Codex reports, it is its status line alone
  // ("Checking Codex…": no disabled button and no room held under it), and the button comes with core's
  // answer (tests/renderer/codex/sandboxChip.test.tsx covers the setup itself).
  it('shows the Codex sandbox chip on Windows: "Checking Codex…" alone until Codex reports its sandbox', async () => {
    upsertProbes([claudeLogin])
    await mount()
    expect(screen.getByTestId('setup-codex-sandbox-status').textContent).toBe('Checking Codex…')
    expect(screen.queryByTestId('setup-codex-sandbox')).toBeNull()
    expect(screen.getByTestId('setup-codex-sandbox-chip').children).toHaveLength(1)
  })

  it('greys a vendor that is not in this version', async () => {
    upsertProbes([
      probed('claude', 'ready', []),
      probeView('codex', 'not-built', { built: false, healthDetail: 'Not available in this build' }),
    ])
    await mount()
    expect(row('codex').textContent).toBe('Codex: arrives in a later version')
    expect(row('codex').className).toContain('text-muted-foreground')
  })

  // Codex is built, so on a machine without it the row reads "not installed": greyed like an unbuilt vendor
  // (first-launch.spec.ts "Codex greyed with install tooltip"), its install command still a live button.
  it('greys a vendor that is not installed, keeping its install command', async () => {
    upsertProbes([probed('claude', 'ready', []), codexMissing])
    await mount()
    expect(row('codex').className).toContain('text-muted-foreground')
    expect(row('claude').className).not.toContain('text-muted-foreground')
  })

  it('is dismissed into state.json, with Undo', async () => {
    upsertProbes([claudeLogin, codexMissing])
    await mount()
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-dismiss'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('state.set')).toEqual([{ setupDismissed: true }])
    expect(screen.queryByTestId('setup-card')).toBeNull()
    const undo = useStore.getState().toasts.items.at(-1)
    expect(undo?.message).toBe('Setup card hidden')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('state.set')).toEqual([{ setupDismissed: true }, { setupDismissed: false }])
    expect(screen.getByTestId('setup-card')).toBeTruthy()
  })

  it('is hidden once dismissed, and once Claude and Codex are both ready', async () => {
    state = { ...state, setupDismissed: true }
    upsertProbes([claudeLogin])
    await mount()
    expect(screen.queryByTestId('setup-card')).toBeNull()
    expect(mock.callsOf('config.resolve')).toEqual([])
  })

  it('stays in place when both primary vendors become ready, and is gone on the next visit', async () => {
    upsertProbes([probed('claude', 'ready', []), codexMissing])
    const first = render(
      <Providers>
        <SetupCard />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('setup-card')).toBeTruthy()
    // Nothing moves on its own (UI standard): the card keeps its place, its row now says Codex is ready.
    act(() => upsertProbes([probed('codex', 'ready', [])]))
    expect(screen.getByTestId('setup-card')).toBeTruthy()
    expect(row('codex').getAttribute('data-health')).toBe('ready')
    first.unmount()
    await mount()
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })

  it('stays hidden when state.json cannot be read', async () => {
    mock.on('state.get', () => {
      throw new Error('no state')
    })
    upsertProbes([claudeLogin])
    await mount()
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })
})

describe('setup wording', () => {
  it('follows the first-run script', () => {
    expect(setupLine(checking('claude'))).toBe('Checking Claude…')
    expect(setupLine(probeView('claude', 'ready'))).toBe('Claude ready')
    expect(setupLine(probeView('claude', 'login-needed'))).toBe('Claude: login needed')
    expect(setupLine(probeView('codex', 'not-installed'))).toBe('Codex not installed')
    expect(setupLine(probeView('codex', 'warning', { healthDetail: 'Newer than tested' }))).toBe(
      'Codex ready · Newer than tested',
    )
    const claude = probeView('claude', 'login-needed')
    const codex = probeView('codex', 'not-installed')
    expect(profileLine('balanced', [claude, codex])).toBe("Using balanced (Claude and Codex aren't ready)")
    expect(profileLine('balanced', [probeView('claude', 'ready')])).toBe('Using balanced')
  })
})
