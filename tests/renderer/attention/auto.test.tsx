// Auto everywhere (the Auto switch in amber with AUTO text, the Run view's AUTO, the Log tab's
// "AUTO approved N"; auto.spec.ts): the amber AUTO badge (text, not colour only) on the Run header, the
// Dashboard's active and recent cards and the Log tab; "AUTO approved N" from core's count; the gates Auto skips
// shown on the timeline as skipped, marked AUTO.
import '../helpers/rtl.ts'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunSnapshot } from '@shared/run.ts'
import { PhaseTimeline } from '@renderer/components/run/PhaseTimeline.tsx'
import { RunHeader } from '@renderer/components/run/RunHeader.tsx'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { ActiveRunCard } from '@renderer/pages/dashboard/ActiveRunCard.tsx'
import { RecentRuns } from '@renderer/pages/dashboard/RecentRuns.tsx'
import { LogTab } from '@renderer/pages/run/LogTab.tsx'
import { applySnapshot, upsertSummaries } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env, makeSummary } from '../helpers/fixtures.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  log = [
    env(RUN, 1, {
      t: 'auto-answered',
      step: 'plan',
      attempt: 1,
      tool: 'Read',
      decision: 'allow',
      why: 'readonly',
    }),
  ]
  mock = installMockDimFactory({ handlers: { 'runs.events': eventsHandler(() => log) } })
})

afterEach(() => {
  mock.uninstall()
  cancelRefetches()
  clearToasts()
  resetShortcuts()
  resetTicker()
  resetBridgeForTests()
})

function autoSnap(over: Partial<RunSnapshot> = {}, auto = true): RunSnapshot {
  return snapWith({
    summary: { auto, status: 'running', phase: 'implementing' },
    steps: {
      plan: { status: 'done', attempt: 1 },
      implement: { status: 'running', attempt: 1 },
      fix: { status: 'queued' },
    },
    extra: over,
  })
}

describe('Run header', () => {
  it('shows the AUTO badge and core’s "AUTO approved N" in an Auto run', () => {
    renderUi(
      <RunHeader
        snap={autoSnap({ autoAnswered: { approved: 4, denied: 1 } })}
        onStop={() => {}}
        stopping={false}
      />,
    )
    const badge = screen.getByTestId('auto-badge')
    expect(badge.textContent).toBe('AUTO')
    expect(badge.className).toContain('text-auto')
    const count = screen.getByTestId('auto-approved-count')
    expect(count.textContent).toBe('AUTO approved 4')
    expect(count.dataset['count']).toBe('4')
  })

  it('says 0 while core has counted none, and shows neither outside Auto', () => {
    const { unmount } = renderUi(<RunHeader snap={autoSnap()} onStop={() => {}} stopping={false} />)
    expect(screen.getByTestId('auto-approved-count').textContent).toBe('AUTO approved 0')
    unmount()
    renderUi(<RunHeader snap={autoSnap({}, false)} onStop={() => {}} stopping={false} />)
    expect(screen.queryByTestId('auto-badge')).toBeNull()
    expect(screen.queryByTestId('auto-approved-count')).toBeNull()
  })
})

describe('Switch to Auto', () => {
  async function pick(trigger: HTMLElement): Promise<void> {
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      await settle()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('auto-switch-confirm'))
      await settle()
    })
  }

  it('the header offers it outside Auto, and its item calls runs.switchToAuto', async () => {
    mock.uninstall()
    mock = installMockDimFactory({
      handlers: { 'runs.events': eventsHandler(() => log), 'runs.switchToAuto': () => undefined },
    })
    renderUi(<RunHeader snap={autoSnap({}, false)} onStop={() => {}} stopping={false} />)
    const trigger = screen.getByTestId('auto-switch')
    expect(trigger.textContent).toContain('Auto')
    await pick(trigger)
    expect(mock.callsOf('runs.switchToAuto')).toEqual([{ runId: RUN }])
  })

  it('is absent in an Auto run, and keeps its room (hidden) once the run has ended', () => {
    const { unmount } = renderUi(<RunHeader snap={autoSnap()} onStop={() => {}} stopping={false} />)
    expect(screen.queryByTestId('auto-switch')).toBeNull()
    expect(screen.queryByTestId('auto-switch-room')).toBeNull()
    unmount()
    const ended = snapWith({
      summary: { auto: false, status: 'completed', phase: 'done' },
      steps: { plan: { status: 'done', attempt: 1 }, implement: { status: 'done', attempt: 1 } },
    })
    renderUi(<RunHeader snap={ended} onStop={() => {}} stopping={false} />)
    expect(screen.queryByTestId('auto-switch')).toBeNull()
    expect(screen.getByTestId('auto-switch-room').className).toContain('invisible')
  })

  it('the compact header offers it as an icon button named by its label', () => {
    renderUi(<RunHeader snap={autoSnap({}, false)} onStop={() => {}} stopping={false} compact />)
    expect(screen.getByTestId('auto-switch').getAttribute('aria-label')).toBe('Switch to Auto')
  })
})

describe('Log tab', () => {
  it('uses core’s count over the envelopes it read, and shows AUTO for an Auto run', async () => {
    act(() => {
      applySnapshot(autoSnap({ autoAnswered: { approved: 7, denied: 2 } }))
    })
    renderUi(<LogTab runId={RUN} />)
    await act(() => settle(10))
    expect(screen.getByTestId('log-auto-approved').textContent).toBe('AUTO approved 7')
    expect(screen.getByTestId('log-tab').textContent).toContain('AUTO denied 2')
    expect(screen.getByTestId('log-auto-badge').textContent).toBe('AUTO')
  })

  it('counts the log itself when the snapshot carries no count', async () => {
    act(() => {
      applySnapshot(autoSnap({}, false))
    })
    renderUi(<LogTab runId={RUN} />)
    await act(() => settle(10))
    expect(screen.getByTestId('log-auto-approved').textContent).toBe('AUTO approved 1')
    expect(screen.queryByTestId('log-auto-badge')).toBeNull()
  })
})

describe('Dashboard cards', () => {
  it('marks an active Auto run and a recent one with the AUTO badge', () => {
    act(() => {
      upsertSummaries(
        [
          makeSummary({ runId: 'a1', auto: true, status: 'running' }),
          makeSummary({ runId: 'a2', auto: false, status: 'running' }),
          makeSummary({
            runId: 'f1',
            auto: true,
            status: 'completed',
            outcome: 'clean',
            endedAt: 1_700_000_100_000,
          }),
          makeSummary({
            runId: 'f2',
            auto: false,
            status: 'completed',
            outcome: 'clean',
            endedAt: 1_700_000_100_000,
          }),
        ],
        { loaded: true },
      )
    })
    renderUi(
      <>
        <ActiveRunCard runId="a1" />
        <ActiveRunCard runId="a2" />
        <RecentRuns />
      </>,
    )
    expect(within(screen.getByTestId('active-run-a1')).getByTestId('auto-badge').textContent).toBe('AUTO')
    expect(within(screen.getByTestId('active-run-a2')).queryByTestId('auto-badge')).toBeNull()
    expect(within(screen.getByTestId('recent-run-f1')).getByTestId('auto-badge').textContent).toBe('AUTO')
    expect(within(screen.getByTestId('recent-run-f2')).queryByTestId('auto-badge')).toBeNull()
  })
})

describe('timeline', () => {
  it('shows the gates Auto skips as skipped, marked AUTO', () => {
    renderUi(<PhaseTimeline snap={autoSnap()} />)
    expect(screen.queryByTestId('timeline-gate-afterPlan')).toBeNull()
    const plan = screen.getByTestId('timeline-gate-auto-afterPlan')
    expect(plan.getAttribute('aria-label')).toBe('Plan review: skipped in Auto')
    expect(plan.textContent).toBe('AUTO')
    expect(screen.getByTestId('timeline-gate-auto-beforeFix').getAttribute('aria-label')).toBe(
      'Findings review: skipped in Auto',
    )
  })

  it('keeps the ordinary diamonds outside Auto', () => {
    renderUi(<PhaseTimeline snap={autoSnap({}, false)} />)
    expect(screen.getByTestId('timeline-gate-afterPlan')).toBeTruthy()
    expect(screen.queryByTestId('timeline-gate-auto-afterPlan')).toBeNull()
  })
})
