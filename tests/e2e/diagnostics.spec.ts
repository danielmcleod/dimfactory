// Diagnostics (Settings → Diagnostics: versions, paths, storage sizes, Clear snapshots (an inline
// two-step), Copy diagnostics (raw lines opt-in); "Undo toasts, not confirm dialogs. The one exception is Clear
// snapshots"; the Diff tab's "History runs render the persisted .patch files"; the wire-up between core's storage.*,
// main's diagnostics.* and the Settings section): a run in the sandbox, then Settings → Diagnostics.
//   - While the run has not ended, its folder's Clear snapshots is disabled with core's reason (storage.usage's `busy`,
//     the words storage.clearShadow refuses with), and turns available once the run ends (no click, no reload).
//   - The storage table has every size, and the folder's snapshots are listed by its path.
//   - Clear snapshots takes two clicks (Clear snapshots → Confirm clear, one width; Cancel kept in place), then says
//     what it cleared. The run's Diff tab still shows its changes, read only, from the saved patch, with the reason on
//     Revert.
//   - Copy diagnostics puts a redacted text bundle on the clipboard (versions; never the task, the user name or the
//     home folder), and says what it removed; Save diagnostics writes the same kind of bundle (E2E: no dialog).
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { realPathSync } from '../../src/core/real-path.ts'
import { expect, test } from './harness.ts'
import { diffFile, openDiffTab, settingsLoaded } from './diff-settings-helpers.ts'
import { clipboardText, keepingClipboard } from './dashboard-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { auditScreen, expectSteadyWidth, trackWidth } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

const TASK = 'add a --version flag for the diagnostics check'

test('Diagnostics: sizes, Clear snapshots in two steps (blocked while the run lives), redacted copy and save', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  // Save diagnostics writes here instead of showing a dialog (main reads it at launch, under DIM_FACTORY_E2E=1 only).
  const saveTo = join(e2e.root, 'diagnostics.txt')
  process.env['DIM_FACTORY_E2E_DIAGNOSTICS_PATH'] = saveTo
  const page = await e2e
    .start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE, delayMs: 8000 }],
      },
    })
    .finally(() => delete process.env['DIM_FACTORY_E2E_DIAGNOSTICS_PATH'])
  const run = await e2e.runFromDashboard(TASK)
  await e2e.approvePlan()
  await e2e.waitForLiveProc(run.runId, 'implement')

  // ---- while the run lives: its folder's snapshots cannot be cleared ----
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-diagnostics').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'diagnostics')
  const folderKey = run.folderKey
  const clear = page.getByTestId(`shadow-clear-${folderKey}`)
  await expect(clear).toBeVisible({ timeout: 20_000 })
  await expect(clear).toBeDisabled()
  await expect(page.getByTestId(`shadow-note-${folderKey}`)).toHaveText(
    `Run #${run.displayNo} is using this folder. Clear its snapshots once the run has finished.`,
  )
  await expect(page.getByTestId(`shadow-path-${folderKey}`)).toHaveText(realPathSync(e2e.sandbox))

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // ---- the sizes ----
  await settingsLoaded(page)
  for (const row of ['runs', 'snapshots', 'worktrees', 'catalog', 'logs', 'total', 'free'])
    await expect(page.getByTestId(`storage-size-${row}`)).not.toHaveText(/Loading|^$/)
  await expect(page.getByTestId('diagnostics-versions')).toContainText('Electron')
  await auditScreen(page, 'Settings → Diagnostics')

  // ---- Clear snapshots: two clicks, one width; Cancel kept in place ----
  await expect(clear).toBeEnabled()
  await trackWidth(page, 'clear', `[data-testid="shadow-clear-${folderKey}"]`)
  await clear.click()
  await expect(clear).toHaveText('Confirm clear')
  await expect(page.getByTestId(`shadow-note-${folderKey}`)).toContainText('Deletes these snapshots.')
  await expect(page.getByTestId(`shadow-cancel-${folderKey}`)).toBeVisible()
  await auditScreen(page, 'Settings → Diagnostics (Clear snapshots armed)')
  await clear.click()
  await expect(
    toasts(page).filter({ hasText: `Cleared the snapshots of ${realPathSync(e2e.sandbox)}` }),
  ).toHaveCount(1)
  await expect(clear).toHaveCount(0)
  await expectSteadyWidth(page, 'clear', 'Clear snapshots / Confirm clear')

  // ---- the run's Diff tab: the saved patch, read only ----
  await openDiffTab(page, run.runId)
  await expect(page.getByTestId('diff-read-only')).toContainText('snapshots')
  const file = diffFile(page, VERSION_WRITE.path)
  await expect(file).toBeVisible()
  await expect(file.getByTestId('diff-file-revert')).toBeDisabled()
  await expect(file).toContainText('export const version')
  await auditScreen(page, 'Diff tab of a run whose snapshots were cleared')

  // ---- Copy and Save diagnostics ----
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-diagnostics').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'diagnostics')
  const copied = await keepingClipboard(e2e, async () => {
    await page.getByTestId('diagnostics-copy').click()
    await expect(page.getByTestId('diagnostics-outcome')).toContainText('Copied to the clipboard.')
    return clipboardText(e2e)
  })
  await expect(page.getByTestId('diagnostics-redactions')).toHaveText(
    /^(Removed first: .+|Nothing needed removing)\.$/,
  )
  expect(copied).toContain('Electron')
  expect(copied).not.toContain(TASK)
  const user = userInfo().username
  if (user.length >= 3) expect(copied).not.toContain(user)
  await page.getByTestId('diagnostics-save').click()
  await expect(page.getByTestId('diagnostics-outcome')).toContainText('Saved to')
  await expect.poll(() => existsSync(saveTo)).toBe(true)
  const saved = readFileSync(saveTo, 'utf8')
  expect(saved).toContain('Electron')
  expect(saved).not.toContain(TASK)
  expect(e2e.pageErrors).toEqual([])
})
