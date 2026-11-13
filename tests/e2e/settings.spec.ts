// Settings (Settings, the Ctrl/Cmd+K palette; template lookup;
// config "Save", "Errors and recovery", "Restore last good"): Settings as the user drives it.
//   (a) Vendors → Test is a forced probe (the fake CLI is asked again); Profiles → Duplicate a built-in, change a
//       pass's model and make it your default: one config.patch each, written to your dimfactory.json, with Undo.
//   (b) Prompts → One project → Implement: the saved template shows the "This project" badge, and the next run in that
//       folder sends it to the vendor (the fake's stdin); your own scope still reads Built-in.
//   (c) Config file: a typo'd key in your dimfactory.json is marked at its file:line:col, and Restore the last good
//       copy puts the file back byte for byte (the mark goes, an Undo toast offers it back).
//   (d) Appearance: the theme and accent switch the whole window at once and are saved; the palette (Ctrl/Cmd+K) finds a
//       setting by its label, and choosing it opens its section with that setting focused.
//   (e) A project's broken dimfactory.json blocks its folder in the composer, whose fixes open Settings → Config file on
//       that project's file (core's link names the folder): at the problem, then at Restore, which fixes it.
// Every screen on the way passes the UI-standards audit (no em dash, no sideways scrolling, one scroll region).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import {
  openPalette,
  probeSpawns,
  promptSent,
  readUserConfig,
  userConfigPath,
} from './diff-settings-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { auditScreen } from './git-helpers.ts'
import { CLEAN_FLOW } from './scenarios.ts'

/** Open a Settings section from the section list. */
async function openSection(page: Page, id: string): Promise<void> {
  if (
    !(await page
      .getByTestId('settings-nav')
      .isVisible()
      .catch(() => false))
  )
    await page.getByTestId('nav-settings').click()
  await page.getByTestId(`settings-section-${id}`).click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', id)
}

test('(a) vendor Test re-probes; a duplicated profile is saved, edited and made the default', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

  // ---- Vendors → Test: a forced probe spawns the CLI again ----
  await openSection(page, 'vendors')
  await expect(page.getByTestId('settings-vendor-claude')).toBeVisible()
  const before = probeSpawns(e2e)
  expect(before).toBeGreaterThan(0)
  const testButton = page.getByTestId('vendor-test-claude')
  await testButton.click()
  await expect(testButton).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => probeSpawns(e2e), { timeout: 30_000 }).toBeGreaterThan(before)
  await expect(page.getByTestId('settings-vendor-claude')).not.toContainText('Not checked yet')

  // ---- Profiles: built-ins are read-only; Duplicate makes one of yours ----
  await openSection(page, 'profiles')
  const detail = page.getByTestId('profiles-detail')
  await expect(page.getByTestId('profile-item-claude-only')).toBeChecked()
  await expect(detail).toHaveAttribute('data-profile', 'claude-only')
  await expect(page.getByTestId('profile-detail-scope')).toHaveText('Built-in')
  await expect(page.getByTestId('profile-passes-table')).toBeVisible()
  await auditScreen(page, 'Settings → Profiles (a built-in)')
  await page.getByTestId('profile-duplicate').click()
  await expect(toasts(page).filter({ hasText: 'Duplicated claude-only as claude-only-copy' })).toHaveCount(1)
  await expect(detail).toHaveAttribute('data-profile', 'claude-only-copy')
  await expect(page.getByTestId('profile-detail-scope')).toHaveText('Yours')
  await expect
    .poll(
      () => (readUserConfig(e2e)['profiles'] as Record<string, unknown> | undefined)?.['claude-only-copy'],
    )
    .toBeTruthy()

  // ---- a pass's model, then your default ----
  const model = page.getByTestId('pass-model-profile-review')
  await expect(model).toBeEnabled()
  await model.fill('haiku')
  await model.press('Enter')
  await expect(toasts(page).filter({ hasText: 'claude-only-copy: Review model haiku' })).toHaveCount(1)
  await expect
    .poll(() => {
      const profiles = readUserConfig(e2e)['profiles'] as Record<string, { review?: { model?: unknown } }>
      return profiles['claude-only-copy']?.review?.model
    })
    .toBe('haiku')
  const setDefault = page.getByTestId('profile-default-user')
  await setDefault.click()
  const madeDefault = toasts(page).filter({ hasText: 'claude-only-copy is now your default profile.' })
  await expect(madeDefault).toHaveCount(1)
  await expect.poll(() => readUserConfig(e2e)['profile']).toBe('claude-only-copy')
  await expect(page.getByTestId('profile-default-user-claude-only-copy')).toHaveText('Your default')

  // ---- Undo puts the previous default back; then it is made the default again ----
  await madeDefault.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => readUserConfig(e2e)['profile']).toBe('claude-only')
  await expect(page.getByTestId('profile-default-user-claude-only')).toHaveText('Your default')
  await expect(setDefault).toBeEnabled()
  await setDefault.click()
  await expect.poll(() => readUserConfig(e2e)['profile']).toBe('claude-only-copy')
  await auditScreen(page, 'Settings → Profiles (one of yours, editable)')

  // The Dashboard's composer starts from it.
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('composer-profile')).toContainText('claude-only-copy')
  expect(e2e.pageErrors).toEqual([])
})

const HOUSE_RULE = 'HOUSE RULE (e2e): keep every change under twenty lines.'
const PROJECT_IMPLEMENT = `${HOUSE_RULE}\n\nTask:\n{{task}}\n\nPlan:\n{{plan}}\n`

test('(b) a project prompt override shows its badge and reaches the next run in that folder', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const page = await e2e.start({ scenario: CLEAN_FLOW, pickSandbox: true })

  await openSection(page, 'prompts')
  await page.getByTestId('prompts-scope-project').check()
  await page.getByTestId('prompts-folder-choose').click()
  await expect(page.getByTestId('prompts-folder-path')).toHaveText(e2e.sandbox)
  await page.getByTestId('prompts-tab-implement').click()
  const panel = page.getByTestId('prompt-panel-implement')
  const source = panel.getByTestId('prompt-source')
  await expect(source).toHaveAttribute('data-source', 'builtin')
  const editor = panel.getByTestId('prompt-editor')
  await expect(editor).toBeEnabled()
  await editor.fill(PROJECT_IMPLEMENT)
  await expect(panel.getByTestId('prompt-status')).toContainText('Unsaved changes')
  await panel.getByTestId('prompt-save').click()
  await expect(toasts(page).filter({ hasText: 'Saved the Implement prompt for ts-small.' })).toHaveCount(1)
  await expect(source).toHaveAttribute('data-source', 'project')
  await expect(source).toHaveText('This project')
  const file = join(e2e.sandbox, '.dimfactory', 'prompts', 'implement.md')
  expect(readFileSync(file, 'utf8')).toBe(PROJECT_IMPLEMENT)
  await auditScreen(page, 'Settings → Prompts (a project template)')

  // Your own scope is untouched: still the built-in template.
  await page.getByTestId('prompts-scope-user').check()
  await expect(panel.getByTestId('prompt-source')).toHaveAttribute('data-source', 'builtin')

  // ---- the next run in that folder sends it to Implement ----
  await page.getByTestId('nav-dashboard').click()
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const prompt = promptSent(e2e, 'implement-1.script.jsonl')
  expect(prompt).toContain(HOUSE_RULE)
  expect(prompt).toContain('add a --version flag')
  // Plan has its own template: the override is Implement's only.
  expect(promptSent(e2e, 'plan-1.script.jsonl')).not.toContain(HOUSE_RULE)
  expect(e2e.pageErrors).toEqual([])
})

test('(c) a config error is marked at file:line:col, and Restore the last good copy fixes it', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
  const path = userConfigPath(e2e)
  const good = readFileSync(path)

  await openSection(page, 'config')
  const lines = page.getByTestId('config-file-lines')
  await expect(lines).toBeVisible()
  await expect(page.getByTestId('config-issues')).toHaveCount(0)

  // A typo'd key on line 2 (the file keeps its other lines).
  const text = good.toString('utf8')
  const bad = text.replace('{\n', '{\n  "profle": "fast",\n')
  expect(bad).not.toBe(text)
  writeFileSync(path, bad)
  const issue = page.getByTestId('config-issue').first()
  await expect(issue).toBeVisible({ timeout: 30_000 })
  await expect(issue).toContainText('dimfactory.json:2:3')
  await expect(issue).toContainText('profle')
  await expect(page.getByTestId('config-issues')).toContainText('Runs are blocked until they are fixed.')
  await expect(page.getByTestId('config-line-2')).toHaveAttribute('data-issue', 'error')
  await expect(page.getByTestId('config-line-issue-2')).toContainText('Column 3')
  await auditScreen(page, 'Settings → Config file (an error marked)')

  // ---- Restore the last good copy ----
  const restore = page.getByTestId('config-restore')
  await expect(restore).toBeEnabled()
  await restore.click()
  const restored = toasts(page).filter({ hasText: 'Restored the last good copy of dimfactory.json.' })
  await expect(restored).toHaveCount(1)
  await expect(page.getByTestId('config-issues')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('config-line-2')).not.toHaveAttribute('data-issue', 'error')
  expect(readFileSync(path).equals(good)).toBe(true)
  // The Undo toast offers the replaced text back.
  await expect(restored.getByRole('button', { name: 'Undo' })).toBeVisible()
  expect(e2e.pageErrors).toEqual([])
})

test('(d) theme and accent switch the window; the palette opens a setting with it focused', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
  const html = page.locator('html')

  // ---- Appearance ----
  await openSection(page, 'appearance')
  const primary = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())
  await page.getByTestId('theme-light').click()
  await expect(html).not.toHaveClass(/\bdark\b/)
  const slate = await primary()
  await page.getByTestId('accent-violet').click()
  await expect(html).toHaveAttribute('data-accent', 'violet')
  await expect.poll(primary).not.toBe(slate)
  await page.getByTestId('theme-dark').click()
  await expect(html).toHaveClass(/\bdark\b/)
  await expect
    .poll(() => (readUserConfig(e2e)['ui'] as Record<string, unknown> | undefined) ?? {})
    .toMatchObject({ theme: 'dark', accent: 'violet' })
  await auditScreen(page, 'Settings → Appearance (dark, violet)')

  // ---- the palette: a setting found by its label, opened with that setting focused ----
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await openPalette(page)
  await page.getByTestId('palette-input').fill('Stop a pass that is silent')
  const item = page.getByTestId('palette-item-field:general::/timeouts/hardKillMs')
  await expect(item).toBeVisible()
  await expect(item).toHaveAttribute('aria-selected', 'true')
  await auditScreen(page, 'the palette (a setting found)')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('palette')).toBeHidden()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'general')
  await expect(page.getByTestId('general-timeout-hardKillMs')).toBeFocused({ timeout: 10_000 })
  expect(e2e.pageErrors).toEqual([])
})

test("(e) a project's config error: the composer's fixes open that project's file, and Restore fixes it", async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
  const dir = join(e2e.sandbox, '.dimfactory')
  const projectFile = join(dir, 'dimfactory.json')
  const good = '{\n  "passes": { "review": { "model": "haiku" } }\n}\n'
  mkdirSync(dir, { recursive: true })
  writeFileSync(projectFile, good)

  // The composer reads the project's settings (Review on haiku); a load without errors is its last good copy.
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('haiku')
  await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })

  // Then it breaks: a typo'd key on line 2. The folder is blocked, with the fixes on its chip.
  writeFileSync(projectFile, '{\n  "pases": { "review": { "model": "haiku" } }\n}\n')
  await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run', { timeout: 30_000 })
  await expect(page.getByTestId('composer-run')).toBeDisabled()
  const details = page.getByTestId('preflight-details')
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click()
  const chip = page.getByTestId('preflight-chip-folder.project.config')
  await expect(chip).toHaveAttribute('data-severity', 'blocking')

  // "Open dimfactory.json at line 2": Settings → Config file on the project's file, at the problem.
  await chip.getByTestId('recovery-folder.project.config.open').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'config')
  await expect(page.getByTestId('config-path')).toHaveText(projectFile)
  const issue = page.getByTestId('config-issue').first()
  await expect(issue).toContainText('dimfactory.json:2:3')
  await expect(issue).toBeFocused()
  await expect(page.getByTestId('config-issues')).toContainText(
    'Runs in this folder are blocked until they are fixed.',
  )

  // Back on the Dashboard, "Restore last good" lands on the Restore button for that file.
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run', { timeout: 30_000 })
  const detailsAgain = page.getByTestId('preflight-details')
  if ((await detailsAgain.getAttribute('aria-expanded')) !== 'true') await detailsAgain.click()
  const chipAgain = page.getByTestId('preflight-chip-folder.project.config')
  // The chip shows its first fix inline; the others are with its details.
  await chipAgain.getByRole('button', { name: /^Show details and fixes:/ }).click()
  await chipAgain.getByTestId('recovery-folder.project.config.restore').click()
  const restore = page.getByTestId('config-restore')
  await expect(restore).toBeFocused({ timeout: 10_000 })
  await restore.click()
  await expect(
    toasts(page).filter({ hasText: 'Restored the last good copy of dimfactory.json.' }),
  ).toHaveCount(1)
  await expect(page.getByTestId('config-issues')).toHaveCount(0, { timeout: 30_000 })
  expect(readFileSync(projectFile, 'utf8')).toBe(good)
  expect(e2e.pageErrors).toEqual([])
})
