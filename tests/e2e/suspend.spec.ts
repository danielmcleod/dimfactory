// Suspend tests (timers: Sleep — powerMonitor suspend/resume shifts
// lastEventAt, keepWaitingAt and each ask's expiresAt, then emits `ask-extended`; E2E: e2e.power + e2e.clock): an ask
// is waiting, the machine sleeps (e2e.power suspend), core's clock jumps past the 10-minute ask timeout while it
// sleeps (e2e.clock), and it wakes (e2e.power resume). The ask has not timed out: it is still in the panel, its
// expiry moved by the time asleep (snapshot, countdown, attention), `ask-extended` is in the run's log (and the Log
// tab), and the countdown still reads about ten minutes. Then A allows it and the run completes.
import { expect, test } from './harness.ts'
import {
  ASK_MS,
  advanceClock,
  bodiesOf,
  fakeProc,
  nextAsk,
  permissionAnswers,
  power,
  powerOf,
  runBodies,
} from './attention-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

const ASLEEP_MS = ASK_MS + 60_000

test('suspend: an ask outlives a sleep longer than its timeout', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE }],
    },
    config: { gates: { afterPlan: false } },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const ask = page.getByTestId('ask-panel')
  const requestId = await nextAsk(page)
  const before = (await e2e.snapshot(run.runId)).asks.find((a) => a.requestId === requestId)
  expect(before).toBeDefined()
  const expiresAt = before?.expiresAt ?? 0
  await expect(page.getByTestId('ask-countdown')).toHaveAttribute('data-expires-at', String(expiresAt))

  // ---- sleep; core's clock passes the ask timeout meanwhile; wake ----
  await power(e2e, 'suspend')
  expect(powerOf(await e2e.e2eState())).toBe('suspend')
  await advanceClock(e2e, ASLEEP_MS)
  const asleep = await e2e.snapshot(run.runId)
  expect(asleep.steps.implement.status).toBe('waiting')
  expect(asleep.asks.map((a) => a.requestId)).toEqual([requestId])
  await power(e2e, 'resume')
  expect(powerOf(await e2e.e2eState())).toBe('resume')

  // ---- not timed out; the expiry moved by the time asleep ----
  const after = await e2e.snapshot(run.runId)
  expect(after.steps.implement.status).toBe('waiting')
  expect(after.steps.implement.pause).toBeUndefined()
  const moved = after.asks.find((a) => a.requestId === requestId)
  expect(moved).toBeDefined()
  const extended = moved?.expiresAt ?? 0
  expect(extended).toBeGreaterThanOrEqual(expiresAt + ASLEEP_MS)
  const extendedBodies = bodiesOf(await runBodies(e2e, run.runId), 'ask-extended')
  expect(extendedBodies).toEqual([{ t: 'ask-extended', step: 'implement', requestId, expiresAt: extended }])
  expect(bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved')).toEqual([])
  // The Dashboard / tray / toasts count down from the same expiry.
  const dashboard = await e2e.call('dashboard.get')
  const item = dashboard.attention.items.find((i) => i.kind === 'ask')
  expect(item?.kind === 'ask' ? item.ask.expiresAt : undefined).toBe(extended)

  // ---- the panel: same ask, new expiry, about ten minutes left on core's clock ----
  await expect(ask).toHaveAttribute('data-request-id', requestId)
  await expect(page.getByTestId('ask-countdown')).toHaveAttribute('data-expires-at', String(extended))
  await expect
    .poll(async () =>
      Number(await page.getByTestId('ask-countdown').getByRole('timer').getAttribute('data-remaining-ms')),
    )
    .toBeGreaterThan(ASK_MS - 120_000)
  const remaining = Number(
    await page.getByTestId('ask-countdown').getByRole('timer').getAttribute('data-remaining-ms'),
  )
  expect(remaining).toBeLessThanOrEqual(ASK_MS)
  // Half of the new expiry later, nothing has timed out either.
  await advanceClock(e2e, ASK_MS / 2)
  expect((await e2e.snapshot(run.runId)).steps.implement.status).toBe('waiting')

  // ---- the Log tab lists the extension ----
  await page.getByRole('tab', { name: 'Log' }).click()
  await expect(page.getByTestId('log-rows')).toContainText('ask extended')
  await page.getByRole('tab', { name: 'Flow' }).click()

  // ---- A, twice (C04a asks the same thing again), and the run completes ----
  await ask.focus()
  await page.keyboard.press('a')
  await nextAsk(page, requestId)
  await ask.focus()
  await page.keyboard.press('a')
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl')).map((a) => a.behavior)).toEqual([
    'allow',
    'allow',
  ])
  expect(e2e.pageErrors).toEqual([])
})
