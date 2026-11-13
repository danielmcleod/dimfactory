// Flow ("apply an isolated run to the folder"; the done-check: a tester who hasn't read the docs completes the
// flow using only in-app text; the composer's "In place | Isolated run (warns about uncommitted changes)", Cards
// depsConsent and finalize). Driven the way a tester would, by what the screen says: roles, names and visible text,
// never test ids.
// From the Dashboard the tester picks the project, writes the task, opens the pass rows and chooses Isolated run,
// which says the run starts from the last commit; the run asks before installing dependencies in its isolated copy
// (Install), the plan is approved, and when the run is done it asks whether to apply its changes to the folder
// (Apply to folder). The folder then has the run's file, and the run says it was applied.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { CLEAN_FLOW } from './scenarios.ts'
import { INSTALL_SCRIPT, commitSandbox, isolatedConfig } from './isolated-helpers.ts'

test('Flow: apply an isolated run to the folder, using only in-app text', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: CLEAN_FLOW, config: isolatedConfig() })
  commitSandbox(e2e, { 'install.mjs': INSTALL_SCRIPT })
  const target = join(e2e.sandbox, 'src', 'version.ts')

  // ---- the composer: the project, the task, Isolated run ----
  const where = page.getByRole('textbox', { name: 'Folder', exact: true })
  await where.fill(e2e.sandbox)
  await where.press('Enter')
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('add a --version flag')
  const passes = page.getByRole('button', { name: /^(Passes|Hide passes)$/ })
  if ((await passes.getAttribute('aria-expanded')) !== 'true') await passes.click()
  const isolated = page.getByRole('button', { name: 'Isolated run', exact: true })
  await expect(isolated).toBeEnabled({ timeout: 30_000 })
  await isolated.click()
  await expect(isolated).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/isolated runs start from your last commit/i)).toBeVisible()
  // With the pass rows open the composer's top scrolls away and the compact bar adds its own Run: either one starts it.
  const run = page.getByRole('button', { name: 'Run', exact: true }).first()
  await expect(run).toBeEnabled({ timeout: 30_000 })
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)

  // ---- the run asks before it installs dependencies in its isolated copy ----
  const consent = page.getByRole('region', { name: 'Install dependencies in the isolated copy?' })
  await expect(consent).toBeVisible({ timeout: 120_000 })
  await expect(consent).toContainText('node install.mjs')
  await expect(consent).toContainText('Install trusts it for this project and runs it.')
  await consent.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(consent).toBeHidden()

  // ---- the plan ----
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await gate.getByRole('button', { name: 'Approve' }).click({ timeout: 90_000 })
  await expect(gate).toBeHidden()

  // ---- the run is done in its copy: apply it to the folder ----
  const finalize = page.getByRole('region', { name: 'Apply the run to your folder?' })
  await expect(finalize).toBeVisible({ timeout: 180_000 })
  await expect(finalize).toContainText('changed 1 file there. They are not in your folder yet.')
  await expect(finalize).toContainText(
    `Apply to folder copies the changes into ${e2e.sandbox} (you can undo it).`,
  )
  expect(existsSync(target)).toBe(false)
  await finalize.getByRole('button', { name: 'Apply to folder' }).click()
  await expect(finalize).toBeHidden()

  // ---- the folder has the run's file, and the run says so ----
  await expect(toasts(page).filter({ hasText: 'Applied 1 file to your folder' })).toHaveCount(1, {
    timeout: 60_000,
  })
  await expect(page.getByText('Applied to your folder (1 file).', { exact: true })).toBeVisible()
  expect(readFileSync(target, 'utf8')).toBe('export const version = "0.1.0"\n')
  await expect(page.getByRole('button', { name: 'Undo the apply' })).toBeEnabled()
  expect(e2e.pageErrors).toEqual([])
})
