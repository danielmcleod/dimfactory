// Rate limit, the Codex variant ("429 snag: wait_until countdown → auto-retry"; failure category rate_limited
// "X `rateLimitExceeded` · if retry-after ≤ 120 s · wait_until · switch_vendor" and
// quota_exceeded "X `usageLimitExceeded` · wait_until (armable) · switch_vendor"; X09a/X09b; the wait_until executor).
// balanced: Codex Implement's turn fails with codexErrorInfo `rateLimitExceeded`, its message saying when to try again
// (15 minutes: past the 120 s automatic-retry rule). The snag reads "Codex rate limit hit" with the wait first, armed,
// counting down on core's clock; "use Claude" is live. Moving core's clock past the reset retries Implement on its own,
// in a new Codex thread, and the run completes. A usage limit (`usageLimitExceeded`, hours away) reads "Codex usage
// limit reached" and offers the same wait, unarmed until the user arms it.
import { expect, test } from './harness.ts'
import { advanceClock } from './attention-helpers.ts'
import { snagCard } from './recovery-helpers.ts'
import { editPass, failedPass, threadIdNow } from './codex-helpers.ts'

const NO_GATES = { gates: { afterPlan: false, beforeFix: false } }
const SUCCESS = (tail: string) =>
  editPass({
    threadId: threadIdNow(tail),
    turnId: `turn-${tail}`,
    text: 'Added the --version flag.',
    write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
    total: { input: 9_000, cached: 4_000, output: 700, reasoning: 200 },
  })

test('Codex: a rate limit with its reset; the wait counts down, then Implement retries on its own', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: { plan: { recording: 'C06-plan-native-host' } },
    config: { profile: 'balanced', ...NO_GATES },
    codex: {
      edit: failedPass({
        threadId: threadIdNow('e10a'),
        turnId: 'turn-e10-a',
        message:
          'Rate limit reached for gpt-5.6-terra on tokens per min (TPM). Please try again in 15 minutes.',
        codexErrorInfo: 'rateLimitExceeded',
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the snag: the wait first, armed, counting down ----
  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'rate_limited')
  await expect(snag).toContainText('Codex rate limit hit')
  const wait = snag.getByTestId('wait-implement:wait')
  await expect(wait).toHaveAttribute('data-armed', 'true')
  const status = snag.getByTestId('wait-status-implement:wait')
  await expect(status).toHaveText(/^Retrying automatically in 1[45]:\d\d /)
  const before = await status.innerText()
  await expect(status).not.toHaveText(before, { timeout: 5_000 })
  await expect(snag.getByTestId('recovery-implement:switch')).toBeEnabled()
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.implement.failure).toMatchObject({ category: 'rate_limited', classifiedBy: 'structured' })
  const until = snap.steps.implement.wait?.until ?? 0
  expect(snap.steps.implement.wait).toEqual({ actionId: 'implement:wait', until, armed: true })

  // ---- the limit resets: Implement runs again by itself and the run completes ----
  fake.set({ edit: SUCCESS('e10b') })
  await advanceClock(e2e, until - (await e2e.e2eState()).now + 1_000)
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  const after = await e2e.snapshot(run.runId)
  expect(after.steps.implement).toMatchObject({ status: 'done', attempt: 2 })
  expect(after.notes).toContain('The wait is over: retrying Implement.')
  expect(fake.requests('thread/start')).toHaveLength(2)
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})

test('Codex: a usage limit hours away offers the same wait', async ({ e2e }) => {
  const page = await e2e.start({
    scenario: { plan: { recording: 'C06-plan-native-host' } },
    config: { profile: 'balanced', ...NO_GATES },
    codex: {
      edit: failedPass({
        threadId: threadIdNow('e10c'),
        turnId: 'turn-e10-c',
        message: "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.",
        codexErrorInfo: 'usageLimitExceeded',
      }),
    },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'quota_exceeded')
  await expect(snag).toContainText('Codex usage limit reached')
  // quota_exceeded: the wait is offered, not armed ("wait_until (armable)").
  const wait = snag.getByTestId('wait-implement:wait')
  await expect(wait).toHaveAttribute('data-armed', 'false')
  await expect(wait).toHaveAttribute('data-disarmed', 'offered')
  await expect(wait).toContainText(/^Retry when the limit resets \(\d\d:\d\d\)/)
  await expect(snag.getByTestId('wait-status-implement:wait')).toContainText(
    'Dim Factory does not retry this on its own.',
  )
  await expect(snag.getByTestId('recovery-implement:wait')).toHaveText('Arm')
  await expect(snag.getByTestId('recovery-implement:switch')).toBeEnabled()
  const snap = await e2e.snapshot(run.runId)
  const reset = snap.steps.implement.wait?.until ?? 0
  const now = (await e2e.e2eState()).now
  expect(reset - now).toBeGreaterThan(2 * 60 * 60_000)
  expect(reset - now).toBeLessThan(2 * 60 * 60_000 + 14 * 60_000)
  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})
