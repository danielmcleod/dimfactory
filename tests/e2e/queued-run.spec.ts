// A queued run (the folder-lock scheduler, the folder.lock check, Active run cards): a second run in the same
// folder while the first waits at its plan gate. The composer reads Queue · "Folder busy" from core's live preflight
// (folder.lock: "Queues behind run #1"); started anyway, the second run's Dashboard card reads "Queued · blocked by
// run #1" with [Open] [Cancel it] and "waits on you" (run #1 waits on the user). Approving run #1 through [Open] lets
// it finish, and run #2 then starts on its own.
import { expect, test } from './harness.ts'
import { cleanRuns, runByNo } from './dashboard-helpers.ts'

test('a second run in the same folder queues behind the first', { tag: ['@cross-os'] }, async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: cleanRuns(2) })

  // ---- run #1 from the Dashboard waits at its plan gate ----
  const first = await e2e.runFromDashboard('add a --version flag')
  expect(first.displayNo).toBe(1)
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })

  // ---- the composer (it remembers the folder): core's live preflight says the run would queue ----
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('composer-folder-input')).toHaveValue(e2e.sandbox)
  await page.getByTestId('composer-task').fill('add a --help flag')
  const run = page.getByTestId('composer-run')
  const runStatus = page.getByTestId('composer-run-status')
  await expect(run).toHaveText('Queue')
  await expect(runStatus).toHaveText('Folder busy')
  await expect(run).toBeEnabled()
  await page.getByTestId('preflight-ok').click()
  await expect(page.getByTestId('preflight-ok-list').locator('[data-check-id="folder.lock"]')).toContainText(
    'Queues behind run #1 (waiting',
  )

  // ---- start it: queued behind run #1 ----
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const second = await runByNo(e2e, 2)
  await expect(page).toHaveURL(new RegExp(`#/runs/${second.runId}$`))
  expect(second.status).toBe('queued')
  expect(second.blockedBy).toBe(first.runId)

  await page.keyboard.press('ControlOrMeta+1')
  const card = page.getByTestId(`active-run-${second.runId}`)
  await expect(card).toHaveAttribute('data-status', 'queued')
  const line = card.getByTestId('phase-line')
  await expect(line).toContainText('Queued · blocked by run #1')
  await expect(line.getByRole('link', { name: 'Open', exact: true })).toBeVisible()
  await expect(card.getByTestId(`blocked-cancel-${second.runId}`)).toHaveText('Cancel it')
  await expect(card.getByTestId(`active-run-eta-${second.runId}`)).toHaveText('waits on you')
  // Run #1's own card still reads its gate.
  await expect(page.getByTestId(`active-run-${first.runId}`)).toHaveAttribute('data-status', 'waiting')

  // ---- [Open] leads to run #1; approving it lets it finish, then run #2 starts by itself ----
  await line.getByRole('link', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${first.runId}$`))
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(first.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  const started = await e2e.waitForSummary(second.runId, (s) => s.status !== 'queued', 90_000)
  expect(started.blockedBy).toBeUndefined()
  await page.keyboard.press('ControlOrMeta+1')
  await expect(card).not.toHaveAttribute('data-status', 'queued')
  await expect(card.getByTestId('phase-line')).not.toContainText('blocked by')
  // The composer follows the runs while it stays open: busy with run #2 now, free once run #2 is stopped.
  await page.getByTestId('composer-task').fill('add a --quiet flag')
  await expect(run).toHaveText('Queue')
  await expect(runStatus).toHaveText('Folder busy')
  await e2e.call('runs.stop', { runId: second.runId })
  await e2e.waitForEnd(second.runId)
  await expect(run).toHaveText('Run')
  await expect(runStatus).toHaveText('')
  expect(e2e.pageErrors).toEqual([])
})
