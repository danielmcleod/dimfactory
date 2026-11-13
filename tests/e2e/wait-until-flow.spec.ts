// Flow ("recover from a rate limit via wait_until"; the done-check: a tester who hasn't read the docs
// completes the flow using only in-app text; the wait_until executor; failure category rate_limited). Driven the way
// a tester would, by what the screen says: roles,
// names and visible text, never test ids. A run's Plan hits a rate limit that resets 20 minutes ahead. The Dashboard
// says the run needs the user ("Failed at Plan · Claude rate limit hit") and opens it; the Plan card says what
// happened, when the limit resets and that Dim Factory retries on its own then ("Retrying automatically in …"). The
// tester turns the automatic retry off and on again (the text follows each choice), then time passes (core's clock is
// moved): Plan runs again by itself, the plan is approved, and the run completes.
import { expect, test } from './harness.ts'
import { advanceClock } from './attention-helpers.ts'
import { prependScripts, PLAN_MATCH, rateLimitedScript } from './recovery-helpers.ts'
import { CLEAN_FLOW } from './scenarios.ts'

const MIN = 60_000

test('Flow: recover from a rate limit via wait_until, using only in-app text', async ({ e2e }) => {
  const resetsAt = Date.now() + 20 * MIN
  const page = await e2e.start({
    scenario: CLEAN_FLOW,
    editScenario: (sc) =>
      prependScripts(sc, [
        { name: 'plan-rate-limited', match: PLAN_MATCH, ops: rateLimitedScript(resetsAt) },
      ]),
  })
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the Dashboard says the run needs the user, and why ----
  await e2e.waitForSnapshot(run.runId, (s) => s.steps.plan.wait?.armed === true, { what: 'the armed wait' })
  await page.getByRole('link', { name: 'Dashboard' }).click()
  const needsYou = page.getByRole('region', { name: /needs you/i })
  await expect(needsYou).toContainText('Failed at Plan · Claude rate limit hit')
  await needsYou.getByRole('link', { name: 'Open' }).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))

  // ---- the Plan card: what happened, when it resets, and what Dim Factory will do ----
  const card = page.getByRole('region', { name: 'Plan failed: Claude rate limit hit' })
  await expect(card).toBeVisible()
  await expect(card).toContainText(/Retry at \d\d:\d\d/)
  await expect(card).toContainText(/Retrying automatically in (19|20):\d\d \(at /)
  await expect(card.getByRole('button', { name: 'Retry now' })).toBeVisible()

  // ---- the tester turns the automatic retry off, then on again; the words follow ----
  await card.getByRole('button', { name: 'Disarm' }).click()
  await expect(card).toContainText('Automatic retry is off. The limit resets in')
  await card.getByRole('button', { name: 'Re-arm' }).click()
  await expect(card).toContainText(/Retrying automatically in (19|20):\d\d \(at /)

  // ---- the limit resets: Plan runs again by itself ----
  const wait = (await e2e.snapshot(run.runId)).steps.plan.wait
  if (wait === undefined) throw new Error('no wait')
  await advanceClock(e2e, wait.until - (await e2e.e2eState()).now + 1_000)
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await expect(gate.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 90_000 })
  await expect(card).toHaveCount(0)
  await gate.getByRole('button', { name: 'Approve' }).click()

  // ---- the run completes ----
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  expect(e2e.pageErrors).toEqual([])
})
