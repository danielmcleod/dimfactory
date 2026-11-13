// Review (the Log tab's "AUTO approved N"): one definition of the AUTO counts.
// Core leaves RunSnapshot.autoAnswered out while it has counted nothing, and it never counts the native Plan's
// ExitPlanMode capture (`why: 'plan-capture'`, derive.ts addAutoAnswered). The Log tab's count over the log, used
// while the snapshot has none, now leaves the capture out too. A Claude-only run with a native Plan used to read
// "AUTO denied 1", and that line vanished once core counted anything.
import '../helpers/rtl.ts'
import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEnvelope, RunEventBody, RunSnapshot } from '@shared/run.ts'
import { resetBridgeForTests } from '@renderer/ipc/bridge.ts'
import { LogFollower } from '@renderer/components/run/runLog.ts'
import type { LogTail } from '@renderer/components/run/runLog.ts'
import { resetShortcuts } from '@renderer/lib/keys.ts'
import { streamBuffer } from '@renderer/lib/streamBuffer.ts'
import { resetTicker } from '@renderer/lib/ticker.ts'
import { LogTab } from '@renderer/pages/run/LogTab.tsx'
import { applySnapshot } from '@renderer/state/actions.ts'
import { cancelRefetches } from '@renderer/state/runs.ts'
import { resetStore } from '@renderer/state/store.ts'
import { clearToasts } from '@renderer/state/toasts.ts'
import { env } from '../helpers/fixtures.ts'
import { installMockDimFactory } from '../helpers/mockDimFactory.ts'
import type { MockDimFactory } from '../helpers/mockDimFactory.ts'
import { RUN, eventsHandler, renderUi, settle, snapWith } from '../run/helpers.tsx'

let mock: MockDimFactory
let log: RunEnvelope[]

/** What the native Plan's capture writes to the log (tests/fixtures C06-plan-native-host, machine.ts P6). */
const PLAN_CAPTURE: RunEventBody = {
  t: 'auto-answered',
  step: 'plan',
  attempt: 1,
  requestId: 'toolu_plan',
  tool: 'ExitPlanMode',
  decision: 'deny',
  why: 'plan-capture',
}
const READONLY_DENY: RunEventBody = {
  t: 'auto-answered',
  step: 'review',
  attempt: 1,
  tool: 'Edit',
  decision: 'deny',
  why: 'readonly',
}

beforeEach(() => {
  resetBridgeForTests()
  resetStore()
  streamBuffer.reset()
  clearToasts()
  log = [env(RUN, 1, PLAN_CAPTURE)]
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

/** A Claude-only run past its native Plan; core has counted no auto-answer (no `autoAnswered`). */
function snap(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return snapWith({
    summary: { auto: false, status: 'running', phase: 'implementing' },
    steps: { plan: { status: 'done', attempt: 1 }, implement: { status: 'running', attempt: 1 } },
    extra: over,
  })
}

async function showLog(s: RunSnapshot): Promise<HTMLElement> {
  act(() => {
    applySnapshot(s)
  })
  renderUi(<LogTab runId={RUN} />)
  await act(() => settle(10))
  return screen.getByTestId('log-tab')
}

describe('Log tab AUTO counts', () => {
  it('a native Plan’s capture is not "AUTO denied" when the snapshot carries no count', async () => {
    const tab = await showLog(snap())
    expect(screen.getByTestId('log-rows').querySelectorAll('[data-seq]')).toHaveLength(1)
    expect(screen.getByTestId('log-auto-approved').textContent).toBe('AUTO approved 0')
    expect(tab.textContent).not.toContain('AUTO denied')
  })

  it('agrees with core once core counts: the same figures with or without the snapshot’s count', async () => {
    log.push(env(RUN, 2, READONLY_DENY))
    const tab = await showLog(snap())
    expect(tab.textContent).toContain('AUTO denied 1')
    // What core reports for the same log (the capture left out): nothing changes on screen.
    act(() => {
      applySnapshot(snap({ autoAnswered: { approved: 0, denied: 1 } }))
    })
    await act(() => settle(10))
    expect(screen.getByTestId('log-auto-approved').textContent).toBe('AUTO approved 0')
    expect(tab.textContent).toContain('AUTO denied 1')
  })

  it('the log follower counts as core does', async () => {
    log.push(
      env(RUN, 2, READONLY_DENY),
      env(RUN, 3, { ...READONLY_DENY, decision: 'allow', tool: 'Read' }),
      env(RUN, 4, { ...PLAN_CAPTURE, attempt: 2 }),
    )
    let tail: LogTail | null = null
    const f = new LogFollower(RUN, (t) => (tail = t), 20)
    f.start()
    await act(() => settle(10))
    const t = tail as unknown as LogTail
    expect(t.total).toBe(4)
    expect([t.autoApproved, t.autoDenied]).toEqual([1, 1])
    f.stop()
  })
})
