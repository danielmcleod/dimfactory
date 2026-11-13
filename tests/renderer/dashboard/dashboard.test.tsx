// Dashboard v0 sections (full-run.spec.ts): recent outcome strings in the app's wording,
// active run cards (phase line, blocked-by line, mini timeline, footer, Stop), the needs-you strip and its actions,
// today's tiles, vendor health with Re-probe, and the empty state. Needs you and Active runs are always there, so
// what core adds or removes never moves the page (UI standards).
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttentionItem } from '@shared/estimates.ts'
import type { RunSummary } from '@shared/run.ts'
import { DashboardPage } from '@renderer/pages/dashboard/DashboardPage.tsx'
import { phaseText } from '@renderer/pages/dashboard/ActiveRunCard.tsx'
import { applySnapshot, setAttention, upsertProbes, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSnapshot, makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, probeView, resolvedView, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()

beforeEach(() => {
  mock = setUp({ handlers: { 'config.resolve': () => resolvedView() } })
})

afterEach(() => tearDown(mock))

async function mount(): Promise<void> {
  render(
    <Providers>
      <DashboardPage />
    </Providers>,
  )
  await settle()
}

function finished(runId: string, over: Partial<RunSummary>): RunSummary {
  return makeSummary({
    runId,
    status: 'completed',
    phase: 'done',
    createdAt: NOW - 10 * 60_000,
    endedAt: NOW - 4 * 60_000,
    ...over,
  })
}

describe('Recent runs', () => {
  it('shows each outcome in the app wording', async () => {
    upsertSummaries(
      [
        finished('fixed', { outcome: 'fixed', findings: { must: 3, should: 5 } }),
        finished('clean', { outcome: 'clean' }),
        finished('verify', { outcome: 'verify-failed' }),
        finished('nochg', { outcome: 'no-changes' }),
        finished('open', { outcome: 'findings-open', findings: { must: 2, should: 1 } }),
        finished('failed', {
          status: 'failed',
          outcome: 'failed',
          failure: { step: 'implement', category: 'auth_expired' },
          steps: [
            { key: 'plan', vendor: 'claude', status: 'done', activeMs: 1 },
            { key: 'implement', vendor: 'codex', status: 'failed', activeMs: 1 },
          ],
        }),
        finished('cancel', {
          status: 'cancelled',
          steps: [
            { key: 'implement', vendor: 'claude', status: 'done', activeMs: 1 },
            { key: 'review', vendor: 'claude', status: 'cancelled', activeMs: 1 },
          ],
        }),
      ],
      { loaded: true },
    )
    await mount()
    const outcome = (id: string): string | null => screen.getByTestId(`recent-outcome-${id}`).textContent
    expect(outcome('fixed')).toBe('Fixed · 3 must · 5 should')
    expect(outcome('clean')).toBe('Clean: no findings')
    expect(outcome('verify')).toBe('Completed with failures')
    expect(outcome('failed')).toBe('Failed at Implement · Codex login expired')
    expect(outcome('nochg')).toBe('No changes made')
    expect(outcome('cancel')).toBe('Cancelled at Review')
    expect(outcome('open')).toBe('Findings open · 2 must · 1 should')
    const row = screen.getByTestId('recent-run-fixed')
    expect(row.querySelector('a')?.getAttribute('href')).toBe('#/runs/fixed')
    expect(row.textContent).toContain('repo · 6m 0s')
  })

  it('lists at most 20 finished runs and no active ones', async () => {
    upsertSummaries(
      [
        ...Array.from({ length: 25 }, (_, i) =>
          finished(`f${i}`, { outcome: 'clean', createdAt: NOW - 100_000 + i }),
        ),
        makeSummary({ runId: 'live', status: 'running', createdAt: NOW }),
      ],
      { loaded: true },
    )
    await mount()
    const list = screen.getByTestId('recent-runs')
    expect(within(list).getAllByRole('listitem')).toHaveLength(20)
    expect(screen.queryByTestId('recent-run-live')).toBeNull()
    expect(screen.getByTestId('active-run-live')).toBeTruthy()
  })

  it('says a title cut to one line in full as a tooltip', async () => {
    upsertSummaries([finished('fixed', { displayNo: 7, title: 'A long task', outcome: 'clean' })], {
      loaded: true,
    })
    await mount()
    const line = screen.getByTestId('recent-outcome-fixed').parentElement
    expect(line?.className).toContain('truncate')
    expect(line?.getAttribute('title')).toBe('Clean: no findings · #7 A long task')
  })

  it('shows an empty state before the first run', async () => {
    upsertSummaries([], { loaded: true })
    await mount()
    expect(screen.getByText('No runs yet')).toBeTruthy()
    expect(screen.getByTestId('needs-you-none').textContent).toBe('Nothing needs you right now.')
    expect(screen.getByTestId('active-runs-none').textContent).toBe('No active runs.')
  })
})

describe('Active run cards', () => {
  const running = makeSummary({
    runId: 'r1',
    displayNo: 4,
    title: 'Add a --version flag',
    status: 'running',
    phase: 'implementing',
    auto: true,
    createdAt: NOW - 7 * 60_000,
    progress: { tokens: 12_300, costUsd: 0.42, filesChanged: 3 },
    steps: [
      { key: 'plan', vendor: 'claude', status: 'done', activeMs: 60_000, costBasis: 'catalog' },
      { key: 'implement', vendor: 'claude', status: 'running', activeMs: 252_000 },
    ],
  })

  it('shows status, title, folder, AUTO, the phase line, a timeline and the footer', async () => {
    upsertSummaries([running], { loaded: true })
    await mount()
    const card = screen.getByTestId('active-run-r1')
    expect(card.textContent).toContain('Running')
    expect(card.textContent).toContain('#4 Add a --version flag')
    expect(within(card).getByText('repo')).toBeTruthy()
    expect(within(card).getByText('AUTO')).toBeTruthy()
    expect(within(card).getByTestId('phase-line').textContent).toBe('Implement · Claude · running 4m 12s')
    const segments = within(card).getAllByRole('listitem')
    expect(segments.map((s) => s.getAttribute('aria-label'))).toEqual(['Plan: Done', 'Implement: Running'])
    expect(segments[1]?.dataset['current']).toBe('true')
    expect(card.textContent).toContain('7m 0s · 12.3k tokens · $0.42 est. · 3 files')
    // The running step keeps counting between summaries.
    await settle(5000)
    expect(within(card).getByTestId('phase-line').textContent).toBe('Implement · Claude · running 4m 17s')
  })

  it('says its title, cut to one line, in full as a tooltip', async () => {
    upsertSummaries([running], { loaded: true })
    await mount()
    const link = screen.getByTestId('active-run-r1').querySelector('a[href="#/runs/r1"]')
    expect(link?.className).toContain('truncate')
    expect(link?.getAttribute('title')).toBe('#4 Add a --version flag')
  })

  it('sizes timeline segments by step ETA when the snapshot has one for every step', async () => {
    upsertSummaries([running], { loaded: true })
    const snap = makeSnapshot({ ...running })
    snap.steps.plan.eta = { p50: 60_000, p80: 90_000 }
    snap.steps.implement.eta = { p50: 300_000, p80: 400_000 }
    applySnapshot(snap)
    await mount()
    const [plan, impl] = within(screen.getByTestId('active-run-r1')).getAllByRole('listitem')
    expect(plan?.style.flexGrow).toBe('60000')
    expect(impl?.style.flexGrow).toBe('300000')
  })

  it('says which run a queued run waits for, with Open', async () => {
    upsertSummaries(
      [
        makeSummary({ runId: 'holder', displayNo: 12, status: 'running', createdAt: NOW - 2 }),
        makeSummary({ runId: 'q', displayNo: 13, status: 'queued', phase: 'queued', blockedBy: 'holder' }),
      ],
      { loaded: true },
    )
    await mount()
    const line = within(screen.getByTestId('active-run-q')).getByTestId('phase-line')
    expect(line.textContent).toContain('Queued · blocked by run #12')
    expect(within(line).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('#/runs/holder')
  })

  it('stops a run', async () => {
    mock.on('runs.stop', () => undefined)
    upsertSummaries([running], { loaded: true })
    await mount()
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('active-run-r1')).getByRole('button', { name: 'Stop' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: 'r1' }])
  })

  // UI standard (nothing moves on its own): the cards keep their places for the visit.
  it('keeps the card of a run that ends while the Dashboard is open; it joins Recent runs on the next visit', async () => {
    upsertSummaries([running, finished('old', { outcome: 'clean' })], { loaded: true })
    const view = render(
      <Providers>
        <DashboardPage />
      </Providers>,
    )
    await settle()
    act(() => {
      upsertSummaries([{ ...running, status: 'completed', phase: 'done', outcome: 'clean', endedAt: NOW }])
    })
    const card = screen.getByTestId('active-run-r1')
    expect(card.dataset['status']).toBe('completed')
    // It says how the run ended, and Stop stays (disabled), so the card keeps its shape.
    expect(within(card).getByTestId('phase-line').textContent).toBe('Clean: no findings')
    expect(within(card).getByRole('button', { name: 'Stop' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByTestId('recent-run-r1')).toBeNull()
    expect(screen.getByTestId('recent-run-old')).toBeTruthy()
    // No active runs left: the heading drops its count, the card stays.
    expect(screen.getByRole('heading', { name: 'Active runs' })).toBeTruthy()

    view.unmount()
    await mount()
    expect(screen.queryByTestId('active-run-r1')).toBeNull()
    expect(screen.getByTestId('recent-run-r1')).toBeTruthy()
    expect(screen.getByTestId('active-runs-none')).toBeTruthy()
  })

  it('puts a run that starts while the Dashboard is open after the cards already shown', async () => {
    upsertSummaries([running], { loaded: true })
    await mount()
    act(() => {
      // Core lists runs newest first: the new one would otherwise go on top and push the others down.
      upsertSummaries([makeSummary({ runId: 'r2', displayNo: 5, status: 'running', createdAt: NOW })])
    })
    const ids = [
      ...screen.getByTestId('active-runs').querySelectorAll('article[data-testid^="active-run-"]'),
    ].map((el) => el.getAttribute('data-testid'))
    expect(ids).toEqual(['active-run-r1', 'active-run-r2'])
  })

  it('formats runner steps without a vendor and falls back to the phase', () => {
    const s = makeSummary({
      runId: 'x',
      phase: 'verifying',
      steps: [{ key: 'verify:1', status: 'running', activeMs: 12_000 }],
    })
    expect(phaseText(s, Date.now())).toBe('Verify · running 12s')
    expect(phaseText({ ...s, steps: [] }, Date.now())).toBe('Verifying')
  })
})

describe('Needs-you strip', () => {
  const base = { displayNo: 4, title: 'Add a flag', folder: 'C:\\work\\repo', since: NOW - 60_000 }
  const items: AttentionItem[] = [
    {
      ...base,
      id: 'ask1',
      runId: 'r1',
      kind: 'ask',
      ask: {
        runId: 'r1',
        step: 'implement',
        attempt: 1,
        requestId: 'q1',
        vendor: 'claude',
        kind: 'shell',
        detail: 'npm test',
        expiresAt: NOW + 240_000,
        allowSession: true,
        queue: { index: 1, total: 1 },
      },
    },
    {
      ...base,
      id: 'gate1',
      runId: 'r2',
      kind: 'card',
      cardId: 'c1',
      cardKind: 'gate:afterPlan',
      cardTitle: 'Plan ready',
      blocking: true,
    },
    {
      ...base,
      id: 'gate2',
      runId: 'r3',
      kind: 'card',
      cardId: 'c2',
      cardKind: 'gate:beforeFix',
      cardTitle: 'Findings ready',
      blocking: true,
    },
    { ...base, id: 'p1', runId: 'r4', kind: 'paused', step: 'implement', pause: 'interrupted' },
    { ...base, id: 'f1', runId: 'r5', kind: 'failed', step: 'implement', category: 'auth_expired' },
  ]

  it('keeps its one slot while nothing needs you: "Nothing needs you right now."', async () => {
    setAttention(0, [])
    await mount()
    const strip = screen.getByTestId('needs-you')
    expect(strip.getAttribute('data-count')).toBe('0')
    const none = screen.getByTestId('needs-you-none')
    expect(none.textContent).toBe('Nothing needs you right now.')
    // The same fixed height as an item, so the first item to arrive takes its place without moving anything.
    expect(none.className.split(' ')).toContain('h-14')
    expect(screen.queryByTestId('needs-you-more')).toBeNull()
  })

  it("says an item's title, cut to one line, in full as a tooltip", async () => {
    setAttention(1, items.slice(0, 1))
    await mount()
    const link = screen.getByTestId('needs-you-ask1').querySelector('a')
    expect(link?.className).toContain('truncate')
    expect(link?.getAttribute('title')).toBe('#4 Add a flag')
  })

  it('shows the first item in that slot and the rest only when the user asks', async () => {
    setAttention(5, items)
    await mount()
    const rows = (): string[] =>
      [...screen.getByTestId('needs-you').querySelectorAll('li')].map(
        (li) => li.getAttribute('data-testid') ?? '',
      )
    expect(rows()).toEqual(['needs-you-ask1'])
    const first = screen.getByTestId('needs-you-ask1')
    // One line that never wraps: the text gives way to the actions.
    expect(first.className.split(' ')).toEqual(expect.arrayContaining(['h-14', 'items-center']))
    expect(first.className.split(' ')).not.toContain('flex-wrap')
    const more = screen.getByTestId('needs-you-more')
    expect(more.textContent).toBe('Show 4 more')
    expect(more.getAttribute('aria-expanded')).toBe('false')
    // The toggle keeps one width (Show NN more / Show less).
    expect([...more.querySelectorAll('[data-label]')].map((r) => r.getAttribute('data-label'))).toEqual([
      'Show 00 more',
      'Show less',
    ])
    fireEvent.click(more)
    expect(rows()).toEqual([
      'needs-you-ask1',
      'needs-you-gate1',
      'needs-you-gate2',
      'needs-you-p1',
      'needs-you-f1',
    ])
    expect(more.textContent).toBe('Show less')
    // Back to one item: the list closes, so the next arrival waits behind "Show N more" again.
    act(() => setAttention(1, items.slice(0, 1)))
    expect(screen.queryByTestId('needs-you-more')).toBeNull()
    act(() => setAttention(2, items.slice(0, 2)))
    expect(rows()).toEqual(['needs-you-ask1'])
  })

  it('offers each item its inline actions', async () => {
    mock.on('asks.answer', () => undefined)
    mock.on('runs.resume', () => undefined)
    setAttention(5, items)
    await mount()
    fireEvent.click(screen.getByTestId('needs-you-more'))
    const strip = screen.getByTestId('needs-you')
    expect(strip.textContent).toContain('Wants to run: npm test')
    expect(within(strip).getByRole('timer').getAttribute('aria-label')).toBe('4m 0s left')
    expect(
      within(screen.getByTestId('needs-you-gate1'))
        .getByRole('link', { name: 'Review plan' })
        .getAttribute('href'),
    ).toBe('#/runs/r2')
    expect(
      within(screen.getByTestId('needs-you-gate2')).getByRole('link', { name: 'Review findings' }),
    ).toBeTruthy()
    expect(screen.getByTestId('needs-you-p1').textContent).toContain('Paused at Implement · Interrupted')
    expect(screen.getByTestId('needs-you-f1').textContent).toContain(
      'Failed at Implement · The vendor login expired',
    )
    expect(within(screen.getByTestId('needs-you-f1')).getByRole('link', { name: 'Open' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('needs-you-ask1')).getByRole('button', { name: 'Allow' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('needs-you-ask1')).getByRole('button', { name: 'Deny' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('asks.answer')).toEqual([
      { runId: 'r1', requestId: 'q1', decision: 'allow' },
      { runId: 'r1', requestId: 'q1', decision: 'deny', graceMs: 3000 },
    ])
    const toast = useStore.getState().toasts.items.at(-1)
    expect(toast?.message).toBe('Denied · Undo (3 s)')
    expect(toast?.durationMs).toBe(3000)
    expect(toast?.action).toMatchObject({
      label: 'Undo',
      call: { cmd: 'asks.undo', req: { runId: 'r1', requestId: 'q1' } },
    })

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('needs-you-p1')).getByRole('button', { name: 'Resume' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.resume')).toEqual([{ runId: 'r4' }])
  })
})

describe('Right rail', () => {
  it("shows today's tiles disabled: the renderer adds up no costs or counts (core's totals come later)", async () => {
    await mount()
    for (const t of ['runs', 'completed', 'failed', 'cost'])
      expect(screen.getByTestId(`today-${t}`).textContent).toBe('Not available')
    expect(screen.getByRole('group', { name: /Runs .*Cost .*Available in a later version$/ })).toBeTruthy()
    // No runs.list of its own for the tiles: only the bridge's active and recent loads.
    expect(mock.callsOf('runs.list').some((q) => q.from !== undefined)).toBe(false)
  })

  it('lists built vendors with version and failing checks, and re-probes one', async () => {
    const claude = probeView('claude', 'login-needed', {
      probe: {
        vendor: 'claude',
        at: NOW,
        ok: false,
        version: '2.1.3',
        checks: [
          {
            id: 'vendor.claude.auth',
            scope: 'vendor',
            status: 'fail',
            blocking: true,
            title: 'Not logged in',
            detail: 'Run claude auth login.',
            recovery: [],
            at: NOW,
            ttlMs: 0,
          },
        ],
        capabilities: {} as never,
        models: [],
      },
    })
    upsertProbes([claude, probeView('gemini', 'not-built', { built: false })])
    mock.on('vendors.probe', () => [probeView('claude', 'ready', { healthDetail: 'Ready' })])
    await mount()
    const row = screen.getByTestId('vendor-health-claude')
    expect(row.textContent).toContain('2.1.3')
    expect(row.textContent).toContain('Not logged in')
    expect(screen.queryByTestId('vendor-health-gemini')).toBeNull()
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Re-probe Claude' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('vendors.probe')).toEqual([{ vendor: 'claude', force: true }])
    expect(useStore.getState().probes.byVendor['claude']?.health).toBe('ready')
  })
})
