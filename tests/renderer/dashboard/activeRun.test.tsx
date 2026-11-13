// Active run cards with estimates ("Live ETA" + display, the Dashboard's Active run cards, "Blocked and stale
// runs", queued-run.spec.ts): the footer ETA from core's progress.etaMs, "longer than usual"
// when core's etaState says so, a queued run's "starts after run #N (~ETA)" / "waits on you" with [Cancel it] (the Run view's
// Stop) and "Paused 2d" after its links, the timeline sized by ETA p50, and the stale chip for runs paused over 24 h.
import '../helpers/rtl.ts'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttentionItem } from '@shared/estimates.ts'
import type { RunSummary } from '@shared/run.ts'
import { resetStopWatches } from '@renderer/components/run/stop.ts'
import { ActiveRunCard, ageText, etaText } from '@renderer/pages/dashboard/ActiveRunCard.tsx'
import { applySnapshot, setAttention, upsertSummaries } from '@renderer/state/actions.ts'
import { useStore } from '@renderer/state/store.ts'
import { makeSnapshot, makeSummary } from '../helpers/fixtures.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { Providers, settle, setUp, tearDown } from './setup.tsx'

let mock: MockDimFactory
const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()
const MIN = 60_000
const DAY = 24 * 60 * MIN

beforeEach(() => {
  mock = setUp({ handlers: { 'runs.stop': () => undefined } })
})

afterEach(() => {
  resetStopWatches()
  tearDown(mock)
})

function running(over: Partial<RunSummary> = {}): RunSummary {
  return makeSummary({
    runId: 'r1',
    displayNo: 12,
    status: 'running',
    phase: 'implementing',
    createdAt: NOW - 7 * MIN,
    progress: { tokens: 12_300, costUsd: 0.42, filesChanged: 3, etaMs: 6 * MIN },
    steps: [
      { key: 'plan', vendor: 'claude', status: 'done', activeMs: MIN, costBasis: 'catalog' },
      { key: 'implement', vendor: 'claude', status: 'running', activeMs: 4 * MIN },
    ],
    ...over,
  })
}

async function mount(runId: string): Promise<void> {
  render(
    <Providers>
      <ActiveRunCard runId={runId} />
    </Providers>,
  )
  await settle()
}

function pausedItem(runId: string, since: number): AttentionItem {
  return {
    id: `paused:${runId}`,
    runId,
    displayNo: 12,
    title: 't',
    folder: 'C:\\work\\repo',
    since,
    kind: 'paused',
    step: 'implement',
    pause: 'interrupted',
  }
}

describe('footer ETA', () => {
  it("shows core's ETA between elapsed and tokens", async () => {
    upsertSummaries([running()], { loaded: true })
    await mount('r1')
    expect(screen.getByTestId('active-run-eta-r1').textContent).toBe('ETA ~6 min')
    expect(screen.getByTestId('active-run-r1').textContent).toContain(
      '7m 0s · ETA ~6 min · 12.3k tokens · $0.42 est. · 3 files',
    )
  })

  it('says "longer than usual" when core says so (etaState)', async () => {
    const { etaMs: _eta, ...rest } = running().progress
    upsertSummaries([running({ progress: { ...rest, etaState: 'longer-than-usual' } })], { loaded: true })
    await mount('r1')
    const eta = screen.getByTestId('active-run-eta-r1')
    expect(eta.textContent).toBe('longer than usual')
    expect(eta.className).toContain('text-warning')
  })

  it('never decides "longer than usual" itself: past the snapshot p80 it still reads core’s ETA', async () => {
    upsertSummaries([running()], { loaded: true })
    const snap = makeSnapshot(running())
    snap.steps.implement.eta = { p50: 2 * MIN, p80: 3 * MIN }
    applySnapshot(snap)
    await mount('r1')
    expect(screen.getByTestId('active-run-eta-r1').textContent).toBe('ETA ~6 min')
  })

  it('leaves the ETA out when core has none', async () => {
    upsertSummaries([running({ progress: { tokens: 0, costUsd: null, filesChanged: 0 } })], { loaded: true })
    await mount('r1')
    expect(screen.queryByTestId('active-run-eta-r1')).toBeNull()
    expect(screen.getByTestId('active-run-r1').textContent).toContain('7m 0s · 0 tokens · 0 files')
  })

  it('sizes the mini timeline by the steps’ ETA p50', async () => {
    upsertSummaries([running()], { loaded: true })
    const snap = makeSnapshot(running())
    snap.steps.plan.eta = { p50: MIN, p80: 2 * MIN }
    snap.steps.implement.eta = { p50: 6 * MIN, p80: 8 * MIN }
    applySnapshot(snap)
    await mount('r1')
    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')
    expect(steps.map((s) => s.style.flexGrow)).toEqual([String(MIN), String(6 * MIN)])
  })
})

describe('queued behind another run', () => {
  const holder = running({ runId: 'holder', displayNo: 12 })
  const queued = makeSummary({
    runId: 'q',
    displayNo: 13,
    status: 'queued',
    phase: 'queued',
    blockedBy: 'holder',
    createdAt: NOW - MIN,
  })

  it('reads "Queued · blocked by run #12", starts after it (~ETA), and [Cancel it] stops that run', async () => {
    upsertSummaries([holder, queued], { loaded: true })
    await mount('q')
    const card = screen.getByTestId('active-run-q')
    expect(within(card).getByTestId('phase-line').textContent).toContain('Queued · blocked by run #12')
    expect(screen.getByTestId('active-run-eta-q').textContent).toBe('starts after run #12 (~6 min)')
    await act(async () => {
      fireEvent.click(screen.getByTestId('blocked-cancel-q'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.callsOf('runs.stop')).toEqual([{ runId: 'holder' }])
    // No confirm dialog: Stop is the Run view's, with its toast once the run is cancelled.
    const messages = (): string[] => useStore.getState().toasts.items.map((t) => t.message)
    expect(messages()).not.toContain('Run stopped · changes kept')
    act(() => upsertSummaries([{ ...holder, status: 'cancelled', phase: 'done' }]))
    expect(messages()).toContain('Run stopped · changes kept')
  })

  it('"waits on you" when the run ahead waits for you, with how long it has been paused', async () => {
    upsertSummaries([{ ...holder, status: 'paused' }, queued], { loaded: true })
    setAttention(1, [pausedItem('holder', NOW - 2 * DAY - 5 * MIN)])
    await mount('q')
    expect(screen.getByTestId('active-run-eta-q').textContent).toBe('waits on you')
    expect(screen.getByTestId('phase-line').textContent).toContain('Queued · blocked by run #12')
    // How long it has been paused follows the Open / Cancel it links, so its changing text never moves them.
    expect(screen.getByTestId('blocked-status-q').textContent).toBe('Paused 2d')
  })
})

describe('stale runs', () => {
  it('flags a run paused for more than 24 h', async () => {
    upsertSummaries([running({ status: 'paused' })], { loaded: true })
    setAttention(1, [pausedItem('r1', NOW - DAY - MIN)])
    await mount('r1')
    expect(screen.getByTestId('stale-r1').textContent).toBe('Stale')
    expect(screen.getByTestId('stale-r1').getAttribute('title')).toBe('Paused for 1d')
  })

  it('does not flag a run paused for less', async () => {
    upsertSummaries([running({ status: 'paused' })], { loaded: true })
    setAttention(1, [pausedItem('r1', NOW - 3 * 60 * MIN)])
    await mount('r1')
    expect(screen.queryByTestId('stale-r1')).toBeNull()
  })
})

describe('etaText / ageText', () => {
  it('formats the ETA cases', () => {
    const s = running()
    expect(etaText(s, Date.now(), undefined)).toBe('ETA ~6 min')
    expect(etaText({ ...s, progress: { ...s.progress, etaMs: 0 } }, Date.now(), undefined)).toBeNull()
    const q = makeSummary({ runId: 'q', status: 'queued', blockedBy: 'r1' })
    expect(etaText(q, Date.now(), undefined)).toBeNull()
    expect(etaText(q, Date.now(), { ...s, status: 'waiting' })).toBe('waits on you')
    const { etaMs: _eta, ...noEta } = s.progress
    expect(etaText(q, Date.now(), { ...s, progress: noEta })).toBe('starts after run #12')
    expect([ageText(30_000), ageText(45 * MIN), ageText(5 * 60 * MIN), ageText(2 * DAY)]).toEqual([
      '1m',
      '45m',
      '5h',
      '2d',
    ])
  })
})
