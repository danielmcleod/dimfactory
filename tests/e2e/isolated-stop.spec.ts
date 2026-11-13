// Stop an isolated run ("Stop → cancelled. Toast"; state-machine row R13; an isolated run's
// worktree: unfinalized worktrees are never auto-deleted, the Dashboard chip "Isolated: not applied", the Diff tab's
// "Apply to folder…" panel). Implement writes in the isolated copy and keeps working; the user stops the run. The
// folder is untouched; the toast says the isolated copy is kept and offers "Apply to folder…" (not Revert
// all, which would revert the copy); the Dashboard shows the chip; the toast's action opens the Diff tab, whose Apply
// panel puts the stopped run's file into the folder, and the chip goes.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { writeThenPark } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'
import { commitSandbox, isolatedConfig, worktreeOf } from './isolated-helpers.ts'

test('Stop an isolated run: the copy is kept, and its changes can be applied later', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', delayMs: 300_000 }],
    },
    editScenario: (sc) => writeThenPark(sc, 'implement-1', [VERSION_WRITE]),
    config: isolatedConfig({ mode: 'worktree', install: 'never' }),
  })
  commitSandbox(e2e, { 'README.md': '# ts-small\n' })
  const folder = e2e.sandbox
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()
  await e2e.waitForLiveProc(run.runId, 'implement')
  const wt = worktreeOf(e2e, run.runId)
  await expect.poll(() => existsSync(join(wt, VERSION_WRITE.path)), { timeout: 30_000 }).toBe(true)

  // ---- Stop: the folder is untouched; the toast points at the Apply panel ----
  await page.getByTestId('stop-run').click()
  const stopped = page.locator(`[data-toast-id="stopped:${run.runId}"]`)
  await expect(stopped).toContainText('Run stopped · its isolated copy is kept', {
    timeout: 30_000,
  })
  await expect(stopped.getByRole('button', { name: 'Revert all' })).toHaveCount(0)
  const ended = await e2e.waitForSummary(run.runId, { status: 'cancelled' })
  expect(ended.worktree).toEqual({ state: 'kept', notApplied: true })
  expect(existsSync(join(folder, VERSION_WRITE.path))).toBe(false)
  expect(existsSync(wt)).toBe(true)
  await expect(page.getByTestId('run-end-changes')).toContainText(
    'are in its isolated copy, not in your folder. Apply them from the Diff tab.',
  )

  // ---- the toast's action opens the Diff tab's Apply panel; Apply puts the file in the folder ----
  await stopped.getByRole('button', { name: 'Apply to folder…' }).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}/diff$`))
  const panel = page.getByTestId('diff-apply-panel')
  await expect(panel.getByTestId('diff-apply-facts')).toHaveText('1 file to write')
  await expect(panel.getByTestId('diff-apply')).toBeEnabled({ timeout: 30_000 })
  await panel.getByTestId('diff-apply').click()
  await expect(toasts(page).filter({ hasText: 'Applied 1 file to your folder' })).toHaveCount(1, {
    timeout: 60_000,
  })
  expect(readFileSync(join(folder, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  await expect.poll(async () => (await e2e.snapshot(run.runId)).summary.worktree?.notApplied).toBe(false)
  expect((await e2e.snapshot(run.runId)).summary.status).toBe('cancelled')
  expect(e2e.pageErrors).toEqual([])
})
