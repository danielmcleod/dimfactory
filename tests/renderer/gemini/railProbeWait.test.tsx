// The right rail waits for Claude's and Codex's first probe answers when the setup card will show (UI copy and
// control standards: nothing moves on its own; the first run's "results stream in within 10 s"; found in review:
// ui-layout.spec.ts "the Dashboard as it loaded" measured a Codex row growing from "Checking Codex…" to its install fixes;
// the fix round: a slow state.json or vendors.list, and the sidebar footer growing when the vendors are listed).
import '../helpers/rtl.ts'
import { render, screen } from '@testing-library/react'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { Shell } from '@renderer/components/shell/Shell.tsx'
import { RAIL_PROBE_WAIT_MS, RAIL_WAIT_MS } from '@renderer/pages/dashboard/RightRail.tsx'
import { resetDashboardForTests } from '@renderer/pages/dashboard/rail/dashboardData.ts'
import { primaryProbePending, resetSetupStateForTests } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { upsertProbes } from '@renderer/state/actions.ts'
import { deferred } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, settle, setUp, tearDown } from '../dashboard/setup.tsx'
import { RailWithData, dashboardData } from '../dashboard/fixtures.tsx'

let mock: MockDimFactory
let dismissed: boolean

const state = (): AppState => ({
  schemaVersion: 1,
  setupDismissed: dismissed,
  firstLaunchCompletedAt: 0,
  catalog: { lastRefreshAt: null, snoozedUntil: null },
  notifications: { pausedUntil: null },
})

/** A vendor whose first probe has not answered: "Checking …" in the setup card. */
const firstProbe = (vendor: string): ProbeView => ({
  ...probeView(vendor, 'checking'),
  checking: true,
  probe: null,
})

/** The same vendor once its first probe answered (Codex: not installed). */
const answered = (vendor: string, health: ProbeView['health']): ProbeView => ({
  ...probeView(vendor, health),
  probe: { vendor, at: 2, ok: health === 'ready', checks: [], capabilities: {} as never, models: [] },
})

beforeEach(() => {
  dismissed = false
  resetSetupStateForTests()
  resetDashboardForTests()
  mock = setUp({ handlers: { 'dashboard.get': () => dashboardData(), 'state.get': () => state() } })
})

afterEach(() => {
  tearDown(mock)
  resetDashboardForTests()
  resetSetupStateForTests()
})

async function mount(): Promise<void> {
  render(
    <Providers>
      <RailWithData />
    </Providers>,
  )
  await settle()
}

const rail = (): HTMLElement => screen.getByTestId('right-rail')
const visible = (): boolean => rail().style.visibility !== 'hidden'

describe('the rail and the vendors’ first probes', () => {
  it('waits, invisible, for Claude’s and Codex’s first answers, then appears whole with their rows', async () => {
    upsertProbes([firstProbe('claude'), firstProbe('codex')])
    await mount()
    await settle(RAIL_WAIT_MS)
    // state.json and dashboard.get have answered, but Codex's row would still grow: the rail waits.
    expect(visible()).toBe(false)
    act(() => upsertProbes([answered('claude', 'ready')]))
    await settle()
    expect(visible()).toBe(false)
    act(() => upsertProbes([answered('codex', 'not-installed')]))
    await settle()
    expect(visible()).toBe(true)
    expect(screen.getByTestId('setup-vendor-codex').getAttribute('data-health')).toBe('not-installed')
    expect(screen.queryByText('Checking Codex…')).toBeNull()
  })

  it('shows what it has after RAIL_PROBE_WAIT_MS when a probe never answers (results within 10 s)', async () => {
    upsertProbes([answered('claude', 'ready'), firstProbe('codex')])
    await mount()
    await settle(RAIL_WAIT_MS)
    expect(visible()).toBe(false)
    await settle(RAIL_PROBE_WAIT_MS)
    expect(visible()).toBe(true)
    expect(RAIL_PROBE_WAIT_MS).toBeLessThanOrEqual(10_000)
  })

  it('does not wait for probes when the setup card is dismissed (nothing there grows with them)', async () => {
    dismissed = true
    upsertProbes([firstProbe('claude'), firstProbe('codex')])
    await mount()
    expect(visible()).toBe(true)
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })

  it('once shown it stays shown; a re-probe (an earlier answer kept) is not waited for', async () => {
    upsertProbes([answered('claude', 'ready'), answered('codex', 'not-installed')])
    await mount()
    expect(visible()).toBe(true)
    act(() => upsertProbes([{ ...answered('codex', 'not-installed'), checking: true }]))
    await settle()
    expect(visible()).toBe(true)
    expect(primaryProbePending([{ ...answered('codex', 'ready'), checking: true }])).toBe(false)
    // A vendor without a view yet is not waited for; Gemini (not a primary vendor) never is.
    expect(primaryProbePending([firstProbe('gemini')])).toBe(false)
    expect(primaryProbePending([firstProbe('claude')])).toBe(true)
  })
})

describe('the rail and what decides the setup card', () => {
  it('waits for core’s vendor list itself: no vendor view yet is a probe still to come', async () => {
    await mount()
    await settle(RAIL_WAIT_MS)
    expect(visible()).toBe(false)
    act(() => upsertProbes([answered('claude', 'ready'), answered('codex', 'not-installed')]))
    await settle()
    expect(visible()).toBe(true)
  })

  it('a launch whose probes then all answer ready still shows the card (decided while they ran)', async () => {
    // codex-balanced.spec.ts: first launch with Claude and Codex ready; the card names the profile it chose. The rail waits for
    // both answers before it shows, but the card was decided when state.json and dashboard.get answered.
    upsertProbes([firstProbe('claude'), firstProbe('codex')])
    await mount()
    await settle(RAIL_WAIT_MS)
    expect(visible()).toBe(false)
    act(() => upsertProbes([answered('claude', 'ready'), answered('codex', 'ready')]))
    await settle()
    expect(visible()).toBe(true)
    expect(screen.getByTestId('setup-card')).toBeTruthy()
    expect(screen.getByTestId('setup-vendor-claude').getAttribute('data-health')).toBe('ready')
    expect(screen.getByTestId('setup-vendor-codex').getAttribute('data-health')).toBe('ready')
  })

  it('a visit whose probes were all ready before it is decided shows no card (nothing to set up)', async () => {
    upsertProbes([answered('claude', 'ready'), answered('codex', 'ready')])
    await mount()
    expect(visible()).toBe(true)
    expect(screen.queryByTestId('setup-card')).toBeNull()
  })

  it('waits for state.json past RAIL_WAIT_MS (a card that came after the rail pushed every card down)', async () => {
    const hold = deferred<AppState>()
    mock.on('state.get', () => hold.promise)
    upsertProbes([answered('claude', 'ready'), answered('codex', 'not-installed')])
    await mount()
    await settle(RAIL_WAIT_MS)
    expect(visible()).toBe(false)
    await act(async () => {
      hold.resolve(state())
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(visible()).toBe(true)
    expect(screen.getByTestId('setup-card')).toBeTruthy()
  })

  it('the sidebar footer has the vendor dots’ height before core lists the vendors', () => {
    render(
      <Providers>
        <Shell>
          <p>page</p>
        </Shell>
      </Providers>,
    )
    expect(screen.getByRole('list', { name: 'Vendor health' }).className).toContain('min-h-5')
  })
})
