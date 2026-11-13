// Flow ("trust a verify command"; the done-check: a tester who hasn't read the docs completes the flow using
// only in-app text; verify commands and trust; trust.json; Settings → Isolation & Verify: defaults, and commands with
// their trust state; the trust card: the command and its body
// (a diff when changed) · [Trust for this project] [Skip]). Driven the way a tester would, by what the screen says:
// roles, names and visible text, never test ids. From the Dashboard the tester opens Settings → Isolation & Verify,
// reads what Verify does, picks the project, finds the test script Dim Factory detected (not trusted yet), turns Verify
// on, has the run use the test command and trusts it. The next run runs it (the Run view says it passed). Then the
// tester edits the project's test script: the next run stops at a card saying the check changed since it was trusted,
// with what changed in its script; [Trust for this project] runs it, and Settings reads it as trusted again.
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { setScripts, version } from './verify-helpers.ts'

const TEST_SCRIPT = 'node --test src/index.test.ts'
const CHANGED_SCRIPT = 'node --test --test-reporter=spec src/index.test.ts'

/** Start a run from the Dashboard by its visible controls; resolves with the new run's id from the address. */
async function runFromComposer(
  page: Page,
  folder: string,
  task: string,
  before: readonly string[],
): Promise<string> {
  await page.getByRole('link', { name: /^Dashboard/ }).click()
  const where = page.getByRole('textbox', { name: 'Folder', exact: true })
  await where.fill(folder)
  await where.press('Enter')
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill(task)
  // The composer says the run verifies, and with how many commands (its pass rows, opened).
  const passes = page.getByRole('button', { name: /^(Passes|Hide passes)$/ })
  if ((await passes.getAttribute('aria-expanded')) !== 'true') await passes.click()
  await expect(page.getByRole('checkbox', { name: 'Verify', exact: true })).toBeChecked()
  await expect(page.getByText('Verify: 1 command', { exact: true })).toBeVisible()
  const run = page.getByRole('button', { name: 'Run', exact: true })
  await expect(run).toBeEnabled({ timeout: 30_000 })
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const id = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  expect(before).not.toContain(id)
  return id
}

/** Approve the plan at its gate, as the card says. */
async function approvePlan(page: Page): Promise<void> {
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await gate.getByRole('button', { name: 'Approve' }).click({ timeout: 90_000 })
  await expect(gate).toBeHidden()
}

test('Flow: trust a verify command, using only in-app text', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: version('1.0.0') },
        { recording: 'C08a-session-id-implement', write: version('1.1.0') },
      ],
    },
    pickSandbox: true,
  })
  // The project's own test script (ts-small's), as the tester found it.
  setScripts(e2e, { test: TEST_SCRIPT })

  // ---- Settings → Isolation & Verify says what Verify does ----
  await page.getByRole('link', { name: /^Settings/ }).click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Isolation & Verify' })
    .click()
  const section = page.getByRole('region', { name: 'Isolation & Verify' })
  await expect(section).toContainText(
    'Verify runs commands you trust, such as your tests, to check each change.',
  )
  await expect(section).toContainText('Choose a project above to see its commands.')

  // ---- the project: its detected test script, not trusted yet ----
  await section.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(section).toContainText(e2e.sandbox)
  await expect(section).toContainText("Saved to ts-small's dimfactory.json.")
  const table = section.getByRole('table', { name: 'Verify commands' })
  const row = table.getByRole('row').filter({ hasText: 'npm run test' })
  await expect(row).toContainText('test')
  await expect(row).toContainText('package.json script')
  await expect(row).toContainText('Not trusted')
  await row.getByText('Script', { exact: true }).click()
  await expect(row).toContainText(TEST_SCRIPT)

  // ---- Verify on, the test command in the run, and trusted ----
  await section.getByRole('switch', { name: 'Verify changes' }).click()
  await expect(toasts(page).filter({ hasText: 'Verify is on' })).toHaveCount(1)
  await expect(section.getByRole('switch', { name: 'Verify changes' })).toBeChecked()
  await row.getByRole('switch', { name: 'Run test' }).click()
  await expect(toasts(page).filter({ hasText: 'test runs in verify' })).toHaveCount(1)
  // The command is now the project's own (configured): its row reads as added in the project's settings.
  const configured = table.getByRole('row').filter({ hasText: 'npm run test' })
  await expect(configured.getByRole('switch', { name: 'Run test' })).toBeChecked()
  await configured.getByRole('button', { name: 'Trust test' }).click()
  await expect(toasts(page).filter({ hasText: 'Trusted test for this project' })).toHaveCount(1)
  await expect(configured).toContainText('Trusted')
  await expect(configured.getByRole('button', { name: 'Untrust test' })).toBeVisible()

  // ---- the next run uses it ----
  const first = await runFromComposer(page, e2e.sandbox, 'add a --version flag', [])
  await approvePlan(page)
  const verify = page.getByRole('article', { name: /^Verify/ })
  await expect(verify).toContainText('Passed', { timeout: 120_000 })
  await expect(verify).toContainText('npm run test')
  const ended = await e2e.waitForEnd(first)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  await expect(page.getByRole('main')).toContainText('Clean: no findings')

  // ---- the test script changes: the next run asks to trust it again, showing what changed ----
  setScripts(e2e, { test: CHANGED_SCRIPT })
  const second = await runFromComposer(page, e2e.sandbox, 'add a --help flag', [first])
  await approvePlan(page)
  const card = page.getByRole('region', { name: 'The test check changed since you trusted it' })
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card).toContainText('npm run test')
  await expect(card).toContainText('In the project folder')
  // The body is the package.json's scripts map (a script may run any other): the test line changed, and
  // the map's other lines show unchanged around it.
  const changes = card.getByRole('list', { name: 'Script changes: 1 added, 1 removed' })
  const items = changes.getByRole('listitem')
  const removed = items.filter({ hasText: 'Removed:' })
  const added = items.filter({ hasText: 'Added:' })
  await expect(removed).toHaveCount(1)
  await expect(removed).toContainText(`"test": "${TEST_SCRIPT}"`)
  await expect(added).toHaveCount(1)
  await expect(added).toContainText(`"test": "${CHANGED_SCRIPT}"`)
  expect(await items.count()).toBeGreaterThan(2)
  await expect(card.getByRole('button')).toHaveText(['Trust for this project', 'Skip'])
  await card.getByRole('button', { name: 'Trust for this project' }).click()
  await expect(card).toBeHidden()

  const again = page.getByRole('article', { name: /^Verify/ })
  await expect(again).toContainText('Passed', { timeout: 120_000 })
  const done = await e2e.waitForEnd(second)
  expect(done.status, e2e.describeRun(done)).toBe('completed')
  expect(done.outcome).toBe('clean')
  await expect(page.getByRole('main')).toContainText('Trusted the verify command test for this project.')

  // ---- Settings reads it as trusted again ----
  await page.getByRole('link', { name: /^Settings/ }).click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Isolation & Verify' })
    .click()
  await section.getByRole('button', { name: 'Choose folder…' }).click()
  const now = section
    .getByRole('table', { name: 'Verify commands' })
    .getByRole('row')
    .filter({ hasText: 'npm run test' })
  await expect(now).toContainText('Trusted')
  await now.getByText('Script', { exact: true }).click()
  await expect(now).toContainText(CHANGED_SCRIPT)
  expect(e2e.pageErrors).toEqual([])
})
