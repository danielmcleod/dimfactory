// Retention, Pin and Remove ("retention (pinned exempt, batched update-ref --stdin, worktrees removed only
// when finalized)"; `storage` {keepRuns, keepDays, rawLogDays}; shadow GC; the Runs history's Pin and Remove
// (with undo); undo toasts, not confirm dialogs; the UI standards'
// "a removed row leaves an undo row in place").
// Four clean runs in one folder with storage {keepRuns: 1, keepDays: 1}: #1 and #2, then (core's clock two days on)
// #3 and #4. #1 is pinned from the Runs page, after which its Remove is disabled and core refuses it too. A retention
// pass (the app's daily pass, run through the E2E hook: the schedule is off under DIM_FACTORY_E2E=1) then deletes #2
// (older than a day and past the newest run): its run folder and its snapshot ref go, while the pinned #1 stays with
// its ref, named in the report as kept because it is pinned; #3 is younger than a day and #4 the newest.
// Then Remove on #3 leaves an undo row where the row was (the list does not close up) and an Undo toast; Undo brings
// the row back. Removed again and left past the undo window, the run is deleted for real (its folder and its ref), and
// a late Undo says it is too late. #4 is removed and the app quit inside the undo window: the next start deletes it.
import { expect, test } from './harness.ts'
import { cleanRuns } from './dashboard-helpers.ts'
import { advanceClock, toasts } from './attention-helpers.ts'
import {
  DAY_MS,
  NO_GATES,
  openRunsPage,
  rowIds,
  runFolderExists,
  runRetention,
  runRow,
  shadowRunRefs,
} from './history-helpers.ts'

test('retention keeps the pinned run and deletes an unpinned old one; Remove, Undo, and Remove for good', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  let page = await e2e.start({
    scenario: cleanRuns(4),
    config: { storage: { keepRuns: 1, keepDays: 1 }, ...NO_GATES },
  })
  const start = async (task: string): Promise<string> => {
    const { runId } = await e2e.call('runs.start', { folder: e2e.sandbox, task, overrides: {} })
    const ended = await e2e.waitForEnd(runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    return runId
  }
  const listed = async (): Promise<string[]> => (await e2e.call('runs.list', {})).items.map((s) => s.runId)
  const r1 = await start('add flag number 1')
  const r2 = await start('add flag number 2')
  await advanceClock(e2e, 2 * DAY_MS)
  const r3 = await start('add flag number 3')
  const r4 = await start('add flag number 4')
  const folderKey = (await e2e.snapshot(r1)).summary.folderKey
  expect(shadowRunRefs(e2e, folderKey).sort()).toEqual([r1, r2, r3, r4].sort())

  // ---- Pin #1 from the Runs page: Remove is then disabled for it, and core refuses it ----
  await openRunsPage(page)
  expect(await rowIds(page)).toEqual([r4, r3, r2, r1])
  const pin = page.getByTestId(`runs-pin-${r1}`)
  await expect(pin).toHaveAttribute('aria-pressed', 'false')
  await pin.click()
  await expect(pin).toHaveAttribute('aria-pressed', 'true')
  await expect(runRow(page, r1)).toHaveAttribute('data-pinned', 'true')
  await expect(page.getByTestId(`runs-remove-${r1}`)).toBeDisabled()
  await page
    .locator('[data-disabled-hint]')
    .filter({ has: page.getByTestId(`runs-remove-${r1}`) })
    .hover()
  await expect(page.getByRole('tooltip')).toHaveText('Pinned runs are kept. Unpin it to remove it.')
  await page.mouse.move(0, 0)
  const refused = await e2e.invoke('runs.remove', { runIds: [r1] })
  expect(refused.ok).toBe(false)
  if (!refused.ok) {
    expect(refused.error.code).toBe('CONFLICT')
    expect(refused.error.message).toBe('Run #1 is pinned. Unpin it first, then remove it.')
  }
  expect((await e2e.snapshot(r1)).summary.pinned).toBe(true)

  // ---- retention: #2 goes (folder and snapshot ref), the pinned #1 stays; #3 is under a day old, #4 the newest ----
  const report = await runRetention(e2e)
  expect(report.removed.map((r) => r.runId)).toEqual([r2])
  expect(report.kept.map((r) => [r.runId, r.reason])).toEqual([[r1, 'pinned']])
  expect(report.failed).toEqual([])
  expect(runFolderExists(e2e, r2)).toBe(false)
  expect(runFolderExists(e2e, r1)).toBe(true)
  expect(shadowRunRefs(e2e, folderKey).sort()).toEqual([r1, r3, r4].sort())
  expect(await listed()).toEqual([r4, r3, r1])
  expect((await e2e.snapshot(r1)).summary.pinned).toBe(true)
  // A fresh visit lists what core lists.
  await page.getByTestId('nav-dashboard').click()
  await openRunsPage(page)
  expect(await rowIds(page)).toEqual([r4, r3, r1])

  // ---- Remove #3: an undo row in its place and an Undo toast; Undo brings it back ----
  const row3 = runRow(page, r3)
  const rowTop = (await row3.boundingBox())?.y
  const row1Top = (await runRow(page, r1).boundingBox())?.y
  await page.getByTestId(`runs-remove-${r3}`).click()
  await expect(row3).toHaveAttribute('data-removed', 'removed')
  await expect(page.getByTestId(`runs-removed-${r3}`)).toHaveText(
    'Removed from the history. Undo brings it back.',
  )
  // The list did not close up under the pointer: the next row is where it was.
  expect((await row3.boundingBox())?.y).toBe(rowTop)
  expect((await runRow(page, r1).boundingBox())?.y).toBe(row1Top)
  const toast = toasts(page).filter({ hasText: 'Run #3 removed' })
  await expect(toast).toBeVisible()
  expect(await listed()).toEqual([r4, r1])
  await page.getByTestId(`runs-undo-${r3}`).click()
  await expect(row3).toHaveAttribute('data-status', 'completed')
  await expect(row3).not.toHaveAttribute('data-removed', /.*/)
  await expect(toast).toHaveCount(0)
  expect(await listed()).toEqual([r4, r3, r1])
  expect(runFolderExists(e2e, r3)).toBe(true)

  // ---- Remove #3 again and let the undo window pass: it is deleted for real; a late Undo says so ----
  await page.getByTestId(`runs-remove-${r3}`).click()
  await expect(row3).toHaveAttribute('data-removed', 'removed')
  await expect.poll(() => runFolderExists(e2e, r3), { timeout: 30_000 }).toBe(false)
  expect(shadowRunRefs(e2e, folderKey).sort()).toEqual([r1, r4].sort())
  await page.getByTestId(`runs-undo-${r3}`).click()
  await expect(row3).toHaveAttribute('data-removed', 'gone')
  await expect(page.getByTestId(`runs-removed-${r3}`)).toHaveText(
    'Removed for good: It is too late to undo: Run #3 was already deleted.',
  )
  await expect(page.getByTestId(`runs-undo-${r3}`)).toBeDisabled()
  expect(await listed()).toEqual([r4, r1])

  // ---- Remove #4 and quit inside the undo window: the next start deletes it ----
  await page.getByTestId(`runs-remove-${r4}`).click()
  await expect(runRow(page, r4)).toHaveAttribute('data-removed', 'removed')
  await e2e.close()
  expect(runFolderExists(e2e, r4)).toBe(true)
  page = await e2e.launch()
  await expect.poll(() => runFolderExists(e2e, r4), { timeout: 30_000 }).toBe(false)
  expect(shadowRunRefs(e2e, folderKey)).toEqual([r1])
  expect(await listed()).toEqual([r1])
  await openRunsPage(page)
  expect(await rowIds(page)).toEqual([r1])
  // The pinned run and its snapshots are untouched by all of it.
  expect(runFolderExists(e2e, r1)).toBe(true)
  await expect(page.getByTestId(`runs-pin-${r1}`)).toHaveAttribute('aria-pressed', 'true')
  expect(e2e.pageErrors).toEqual([])
})
