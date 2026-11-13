// Keep for later (Finalize: Keep for later → finalize skipped(kept), the run completes;
// "Unfinalized worktrees are never auto-deleted. The Dashboard shows a chip 'Isolated: not applied'"; the Diff tab's
// "Isolated runs get an 'Apply to folder…' panel (all files or reviewed only)"). The run changes two files in its
// isolated copy; at the finalize card the user keeps it for later. The run completes with its copy kept, and the
// Dashboard's Recent row says "Isolated: not applied". Later, in the run's Diff tab, the user marks one file reviewed
// and applies the reviewed files only: just that file reaches the folder, and the chip goes.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { diffFile, openDiffTab } from './diff-settings-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { auditScreen } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'
import { choose, commitSandbox, isolatedConfig, worktreeOf, writeBeforeResult } from './isolated-helpers.ts'

const EXTRA = { path: 'src/extra.ts', content: 'export const extra = true\n' }

test('Keep for later: the Dashboard chip, then Apply the reviewed files from the Diff tab', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
    },
    editScenario: (sc) => writeBeforeResult(sc, 'implement-1', [EXTRA]),
    config: isolatedConfig({ mode: 'worktree', install: 'never' }),
  })
  commitSandbox(e2e, { 'README.md': '# ts-small\n' })
  const folder = e2e.sandbox

  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()

  // ---- Keep for later: the run completes, its copy stays ----
  await choose(e2e.p, 'finalize', 'keep', 180_000)
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.worktree).toEqual({ state: 'kept', notApplied: true })
  await expect(page.getByTestId('pass-card-finalize')).toHaveAttribute('data-status', 'skipped')
  await expect(page.getByTestId('finalize-state')).toHaveText(
    'Kept for later: the isolated copy stays until you apply or discard it.',
  )
  const wt = worktreeOf(e2e, run.runId)
  expect(readFileSync(join(wt, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  expect(existsSync(join(folder, VERSION_WRITE.path))).toBe(false)
  expect(existsSync(join(folder, EXTRA.path))).toBe(false)

  // ---- the Dashboard says the run's changes are not in the folder ----
  await page.keyboard.press('ControlOrMeta+1')
  const chip = page.getByTestId(`isolated-chip-${run.runId}`)
  await expect(chip).toHaveText('Isolated: not applied')
  await auditScreen(page, 'Dashboard with an isolated run not applied')

  // ---- later: the Diff tab, one file marked reviewed, Apply the reviewed files only ----
  await page.getByTestId(`recent-run-${run.runId}`).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}`))
  await openDiffTab(page, run.runId)
  const panel = page.getByTestId('diff-apply-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('diff-apply-facts')).toHaveText('2 files to write')
  await diffFile(page, VERSION_WRITE.path).getByTestId('diff-file-reviewed').click()
  await expect(diffFile(page, VERSION_WRITE.path).getByTestId('diff-file-reviewed')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await panel.getByTestId('diff-apply-reviewed').check()
  await expect(panel).toContainText('Reviewed files only (1 file)')
  await expect(panel.getByTestId('diff-apply-facts')).toHaveText('1 file to write')
  await auditScreen(page, 'Diff tab with the Apply panel')
  await panel.getByTestId('diff-apply').click()
  await expect(toasts(page).filter({ hasText: 'Applied 1 file to your folder' })).toHaveCount(1, {
    timeout: 60_000,
  })
  expect(readFileSync(join(folder, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  expect(existsSync(join(folder, EXTRA.path))).toBe(false)
  await expect.poll(async () => (await e2e.snapshot(run.runId)).summary.worktree?.notApplied).toBe(false)

  // ---- the chip is gone ----
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`recent-run-${run.runId}`)).toBeVisible()
  await expect(chip).toHaveCount(0)
  expect(e2e.pageErrors).toEqual([])
})
