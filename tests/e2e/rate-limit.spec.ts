// Rate limit ("429 snag: wait_until countdown → auto-retry"; failure category rate_limited "if
// retry-after ≤ 120 s · wait_until · switch_vendor"; the wait_until executor "Armable. Loads disarmed after relaunch,
// with [Retry now] [Re-arm]"; the snag card's countdown for wait_until; after a crash relaunch, armed wait_until
// timers come back disarmed and nothing resumes on its own). Plan's CLI answers a rate limit that resets 15 minutes ahead (past
// the 120 s automatic-retry rule): the snag reads "Claude rate limit hit" with the wait first, armed, counting down on
// core's clock, its time written as core's label writes it; Disarm and Re-arm keep one button width. Moving core's
// clock (e2e.clock) past the reset retries Plan on its own, and it succeeds. After a relaunch an armed wait comes back
// disarmed ("Dim Factory restarted, so the automatic retry is off.") with [Re-arm] and [Retry now]: core's clock passes
// the reset and nothing retries on its own; Retry now runs Plan again.
import { expect, test } from './harness.ts'
import { advanceClock } from './attention-helpers.ts'
import { auditBothSizes, expectSteadyWidth, trackWidth } from './git-helpers.ts'
import {
  PLAN_MATCH,
  planArgvs,
  prependScripts,
  rateLimitedScript,
  snagCard,
  unpromptedShifts,
  watchShifts,
} from './recovery-helpers.ts'

const MIN = 60_000
/** A time of day as core's label writes it (24-hour, `20:03`; a weekday first a day or more ahead). */
const AT = String.raw`\(at (?:[A-Z][a-z]{2} )?\d\d:\d\d\)`
const armedText = new RegExp(String.raw`^Retrying automatically in 1[45]:\d\d ${AT}\.$`)

test('rate limit: the snag counts down to the reset, then the armed wait retries Plan on its own', async ({
  e2e,
}) => {
  const resetsAt = Date.now() + 15 * MIN
  const page = await e2e.start({
    scenario: { plan: [{ recording: 'C06-plan-native-host' }] },
    editScenario: (sc) =>
      prependScripts(sc, [
        { name: 'plan-rate-limited', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt) },
      ]),
  })
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the snag: the wait first, armed, counting down to the reset ----
  const snag = snagCard(page, 'plan')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'rate_limited')
  await expect(snag).toContainText('Claude rate limit hit')
  const wait = snag.getByTestId('wait-plan:wait')
  await expect(wait).toHaveAttribute('data-armed', 'true')
  await expect(wait).toContainText(/^Retry at \d\d:\d\d/)
  const status = snag.getByTestId('wait-status-plan:wait')
  await expect(status).toHaveText(armedText)
  await expect(snag.getByTestId('recovery-plan:wait')).toHaveText('Disarm')
  await expect(snag.getByTestId('wait-retry-plan:wait')).toHaveText('Retry now')
  // The countdown runs on core's clock: a few seconds later it shows less time, and its ticking moves nothing.
  await watchShifts(page)
  const before = await status.innerText()
  await expect(status).not.toHaveText(before, { timeout: 5_000 })
  const moved = await unpromptedShifts(page)
  expect(moved.cls, `layout shifts while counting down: ${moved.moved.join(' | ')}`).toBeLessThan(0.02)
  await expect(snag.getByTestId('recovery-plan:switch')).toBeDisabled()
  let snap = await e2e.snapshot(run.runId)
  const until = snap.steps.plan.wait?.until ?? 0
  expect(snap.steps.plan.wait).toEqual({ actionId: 'plan:wait', until, armed: true })
  expect(Math.abs(until - Math.floor(resetsAt / 1000) * 1000)).toBeLessThan(1000)
  expect(planArgvs(e2e)).toHaveLength(1)
  await auditBothSizes(e2e, page, 'Run view with the rate-limit snag')
  // The label and the status line write the reset time the same way.
  const label = /Retry at (\d\d:\d\d)/.exec(await wait.innerText())?.[1]
  expect(label).toBeDefined()
  await expect(status).toContainText(`(at ${label ?? ''}).`)

  // ---- Disarm and Re-arm: one button width; a wait the user armed again still retries on its own ----
  const arm = snag.getByTestId('recovery-plan:wait')
  await trackWidth(page, 'arm', '[data-testid="recovery-plan:wait"]')
  await arm.click()
  await expect(arm).toHaveText('Re-arm')
  await expect(status).toHaveText(/^Automatic retry is off\. The limit resets in /)
  await arm.click()
  await expect(arm).toHaveText('Disarm')
  await expect(status).toHaveText(armedText)
  await expectSteadyWidth(page, 'arm', 'The wait arm button')

  // ---- core's clock reaches the reset: Plan retries on its own and succeeds ----
  const now = (await e2e.e2eState()).now
  await advanceClock(e2e, until - now + 1_000)
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveCount(0)
  snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan).toMatchObject({ status: 'done', attempt: 2 })
  expect(snap.steps.plan.wait).toBeUndefined()
  expect(snap.notes).toContain('The wait is over: retrying Plan.')
  expect(planArgvs(e2e)).toHaveLength(2)

  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})

test('after a relaunch the wait comes back disarmed, with Re-arm and Retry now', async ({ e2e }) => {
  const resetsAt = Date.now() + 15 * MIN
  let page = await e2e.start({
    scenario: { plan: [{ recording: 'C06-plan-native-host' }] },
    editScenario: (sc) =>
      prependScripts(sc, [
        { name: 'plan-rate-limited', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt) },
      ]),
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  await expect(snagCard(page, 'plan').getByTestId('wait-plan:wait')).toHaveAttribute('data-armed', 'true', {
    timeout: 90_000,
  })

  // ---- Dim Factory closes and starts again ----
  await e2e.close()
  page = await e2e.launch()
  await page.evaluate((id) => {
    location.hash = `#/runs/${id}`
  }, run.runId)
  const snag = snagCard(page, 'plan')
  await expect(snag).toBeVisible({ timeout: 30_000 })
  const wait = snag.getByTestId('wait-plan:wait')
  await expect(wait).toHaveAttribute('data-armed', 'false')
  await expect(wait).toHaveAttribute('data-disarmed', 'relaunch')
  const status = snag.getByTestId('wait-status-plan:wait')
  await expect(status).toHaveText(
    new RegExp(
      String.raw`^Dim Factory restarted, so the automatic retry is off\. The limit resets in 1[45]:\d\d ${AT}\.$`,
    ),
  )
  const arm = snag.getByTestId('recovery-plan:wait')
  await expect(arm).toHaveText('Re-arm')
  await expect(snag.getByTestId('wait-retry-plan:wait')).toHaveText('Retry now')
  let snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan.wait).toMatchObject({ actionId: 'plan:wait', armed: false, disarmed: 'relaunch' })
  await auditBothSizes(e2e, page, 'Run view after a relaunch with a disarmed wait')

  // ---- core's clock passes the reset while the wait is disarmed: nothing retries on its own ----
  const until = snap.steps.plan.wait?.until ?? 0
  const now = (await e2e.e2eState()).now
  expect(until).toBeGreaterThan(now)
  await advanceClock(e2e, until - now + 1_000)
  await expect(status).toHaveText(
    'Dim Factory restarted, so the automatic retry is off. The limit should have reset by now.',
  )
  // Let the controller take anything the moved clock made due.
  await page.waitForTimeout(2_000)
  snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan).toMatchObject({ status: 'failed', attempt: 1 })
  expect(snap.steps.plan.wait).toMatchObject({ armed: false, disarmed: 'relaunch' })
  expect(planArgvs(e2e)).toHaveLength(1)
  await expect(arm).toHaveText('Re-arm')

  // ---- Retry now → Plan runs again and succeeds ----
  await snag.getByTestId('wait-retry-plan:wait').click()
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan).toMatchObject({ status: 'done', attempt: 2 })
  expect(planArgvs(e2e)).toHaveLength(2)

  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})
