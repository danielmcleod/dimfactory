// Dashboard review fixes ("Live ETA", Active run cards and the mini timeline "∝ p50", the
// setup card; "the setup card probes vendors and git"):
//   - the footer ETA is core's: it counts down to core's `etaEndsAt`, and "longer than usual" is core's etaState;
//   - the mini timeline is sized by p50 in a real run, whose summary lists preflight (never estimated) first;
//   - the setup card shows git from dashboard.get, with its install fix and a Re-check that asks core again.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { RunSummary } from '@shared/run.ts'
import { resetRecoveryForTests } from '@renderer/components/recovery/RecoveryActions.tsx'
import { etaRemainingMs, formatRunEta } from '@renderer/lib/format.ts'
import { ActiveRunCard, etaText } from '@renderer/pages/dashboard/ActiveRunCard.tsx'
import { resetDashboardForTests } from '@renderer/pages/dashboard/rail/dashboardData.ts'
import { SetupCard } from '@renderer/pages/dashboard/rail/SetupCard.tsx'
import { applySnapshot, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { makeSnapshot, makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from './setup.tsx'
import { RailWithData, dashboardData } from './fixtures.tsx'

let mock: MockDimFactory
let state: AppState
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const MIN = 60_000

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
      'config.resolve': () => resolvedView({ profile: 'claude-only' }),
      'runs.stop': () => undefined,
    },
  })
  resetRecoveryForTests()
  resetDashboardForTests()
})

afterEach(() => {
  resetRecoveryForTests()
  resetDashboardForTests()
  tearDown(mock)
})

function running(over: Partial<RunSummary> = {}): RunSummary {
  return makeSummary({
    runId: 'r1',
    displayNo: 12,
    status: 'running',
    phase: 'implementing',
    createdAt: NOW - 7 * MIN,
    progress: { tokens: 0, costUsd: null, filesChanged: 0, etaMs: 6 * MIN, etaState: 'ok' },
    steps: [
      { key: 'preflight', status: 'done', activeMs: 2000 },
      { key: 'plan', vendor: 'claude', status: 'done', activeMs: MIN },
      { key: 'implement', vendor: 'claude', status: 'running', activeMs: 4 * MIN },
    ],
    ...over,
  })
}

async function mountCard(runId = 'r1'): Promise<void> {
  render(
    <Providers>
      <ActiveRunCard runId={runId} />
    </Providers>,
  )
  await settle()
}

describe("the footer ETA is core's", () => {
  it('counts down to core’s etaEndsAt between summaries', async () => {
    upsertSummaries([running({ progress: { ...running().progress, etaEndsAt: NOW + 6 * MIN } })], {
      loaded: true,
    })
    await mountCard()
    const eta = (): string | null => screen.getByTestId('active-run-eta-r1').textContent
    expect(eta()).toBe('ETA ~6 min')
    await settle(2 * MIN)
    expect(eta()).toBe('ETA ~4 min')
  })

  it('stands still without etaEndsAt (the run waits on you), and says "longer than usual" only from core', async () => {
    upsertSummaries([running()], { loaded: true })
    await mountCard()
    await settle(2 * MIN)
    expect(screen.getByTestId('active-run-eta-r1').textContent).toBe('ETA ~6 min')
    const { etaMs: _eta, ...rest } = running().progress
    act(() => upsertSummaries([running({ progress: { ...rest, etaState: 'longer-than-usual' } })]))
    expect(screen.getByTestId('active-run-eta-r1').textContent).toBe('longer than usual')
  })

  it('a queued run starts after the run ahead, counting down with it', () => {
    const holder = running({ runId: 'holder', progress: { ...running().progress, etaEndsAt: NOW + 6 * MIN } })
    const q = makeSummary({ runId: 'q', status: 'queued', blockedBy: 'holder' })
    expect(etaText(q, NOW + 3 * MIN, holder)).toBe('starts after run #12 (~3 min)')
    const late = { ...holder, progress: { ...holder.progress, etaState: 'longer-than-usual' as const } }
    expect(etaText(q, NOW, late)).toBe('starts after run #12')
  })

  it('formatRunEta / etaRemainingMs only format core’s figures', () => {
    const p = { tokens: 0, costUsd: null, filesChanged: 0 }
    expect(formatRunEta(p, NOW)).toBeNull()
    expect(formatRunEta({ ...p, etaMs: 6 * MIN }, NOW)).toBe('ETA ~6 min')
    expect(formatRunEta({ ...p, etaMs: 6 * MIN, etaEndsAt: NOW + 2 * MIN }, NOW)).toBe('ETA ~2 min')
    expect(formatRunEta({ ...p, etaState: 'longer-than-usual' }, NOW)).toBe('longer than usual')
    expect(etaRemainingMs({ ...p, etaMs: 6 * MIN, etaEndsAt: NOW - 1 }, NOW)).toBeUndefined()
  })
})

describe('the mini timeline in a real run', () => {
  it('sizes by p50 although preflight (never estimated) comes first; preflight gets a short segment', async () => {
    upsertSummaries([running()], { loaded: true })
    const snap = makeSnapshot(running())
    snap.steps.plan.eta = { p50: MIN, p80: 2 * MIN }
    snap.steps.implement.eta = { p50: 6 * MIN, p80: 8 * MIN }
    applySnapshot(snap)
    await mountCard()
    const list = screen.getByRole('list', { name: 'Steps' })
    expect(list.getAttribute('data-proportional')).toBe('true')
    const steps = within(list).getAllByRole('listitem')
    expect(steps.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Preflight: Done',
      'Plan: Done',
      'Implement: Running',
    ])
    expect(steps.map((s) => s.style.flexGrow)).toEqual([String(MIN / 4), String(MIN), String(6 * MIN)])
  })

  it('equal segments while the run has no ETAs', async () => {
    upsertSummaries([running()], { loaded: true })
    await mountCard()
    const list = screen.getByRole('list', { name: 'Steps' })
    expect(list.hasAttribute('data-proportional')).toBe(false)
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((s) => s.style.flexGrow),
    ).toEqual(['1', '1', '1'])
  })
})

describe("git on the setup card (core's app.git)", () => {
  const gitInstall = {
    id: 'app.git.install',
    label: 'Copy the git install command',
    kind: 'shell_copy' as const,
    command: 'winget install --id Git.Git -e',
    shell: 'powershell' as const,
    reason: 'Git is not installed',
    recheck: 'app.git',
  }
  const gitCheck = (over: Partial<CheckResult>): CheckResult => ({
    id: 'app.git',
    scope: 'app',
    status: 'pass',
    blocking: false,
    title: 'Git 2.47.1',
    detail: 'git version 2.47.1.windows.1',
    recovery: [],
    at: 0,
    ttlMs: 0,
    ...over,
  })
  const missing = gitCheck({
    status: 'fail',
    blocking: true,
    category: 'git_missing',
    title: 'Git is not installed',
    detail: 'Dim Factory uses git to snapshot and diff every run. Install git, then re-check.',
    recovery: [gitInstall],
  })

  it('reads "Git ready" with the version, and nothing before core answered', async () => {
    upsertProbes([probeView('claude', 'ready')])
    const { rerender } = render(
      <Providers>
        <SetupCard />
      </Providers>,
    )
    await settle()
    expect(screen.queryByTestId('setup-git')).toBeNull()
    rerender(
      <Providers>
        <SetupCard appChecks={[gitCheck({})]} />
      </Providers>,
    )
    expect(screen.getByTestId('setup-git').textContent).toBe('Git readyGit 2.47.1')
  })

  it('shows a missing git with its install fix; copy → Re-check asks core again and the row follows', async () => {
    upsertProbes([probeView('claude', 'ready')])
    let answer = dashboardData({ appChecks: [missing] })
    mock.on('dashboard.get', () => answer)
    mock.on('recovery.execute', () => ({ kind: 'shell_copy' as const, copied: gitInstall.command }))
    render(
      <Providers>
        <RailWithData />
      </Providers>,
    )
    await settle()
    const row = (): HTMLElement => screen.getByTestId('setup-git')
    expect(row().getAttribute('data-status')).toBe('fail')
    expect(row().textContent).toContain('Git is not installed')
    expect(row().textContent).toContain('winget install --id Git.Git -e')
    await act(async () => {
      fireEvent.click(within(row()).getByTestId('recovery-app.git.install'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    // Core executed it (no folder: an app-scope fix).
    expect(mock.callsOf('recovery.execute')).toEqual([{ actionId: 'app.git.install' }])
    answer = dashboardData({ appChecks: [gitCheck({})] })
    const asked = mock.callsOf('dashboard.get').length
    await act(async () => {
      fireEvent.click(within(row()).getByTestId('recheck-app.git.install'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await settle()
    expect(mock.callsOf('dashboard.get').length).toBeGreaterThan(asked)
    expect(row().getAttribute('data-status')).toBe('pass')
    expect(row().textContent).toContain('Git ready')
  })

  it('stays up while git is failing, even with both vendors ready', async () => {
    upsertProbes([probeView('claude', 'ready'), probeView('codex', 'ready')])
    render(
      <Providers>
        <SetupCard appChecks={[missing]} />
      </Providers>,
    )
    await settle()
    expect(screen.getByTestId('setup-card')).toBeTruthy()
    expect(screen.getByTestId('setup-git').getAttribute('data-status')).toBe('fail')
  })
})
