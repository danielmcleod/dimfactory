// Screenshots of beginners part B for review, in light and dark (not a gate; it asserts only what it
// needs to reach each screen). Runs when BEGINNER_B_SCREENS=1 and writes PNGs to test-results/beginner-b-screens/
// (git-ignored; Playwright clears test-results at the start of a run, so run this spec on its own, last).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { IDEA } from './easy-helpers.ts'
import {
  CONFIG,
  DATA_IDEA,
  FILL_IN_SUMMARY,
  GUIDE_INDEX,
  NO_QUESTIONS,
  PLAIN_SUMMARY,
  PLAN,
  REPORT_IMPLEMENT,
  RETURNS,
  firstRun,
  makeChange,
  toConfirm,
} from './beginner-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'beginner-b-screens')

test.skip(process.env['BEGINNER_B_SCREENS'] === undefined, 'screenshots only: set BEGINNER_B_SCREENS=1')

async function shot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`), fullPage: true })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

/** The page's one scroll region scrolled so `el` is near the top. */
async function scrollTo(el: Locator): Promise<void> {
  await el.evaluate((n) => n.scrollIntoView({ block: 'start' }))
}

test('Done with Things to fill in, Make a change with its estimate, the project history', async ({ e2e }) => {
  test.setTimeout(480_000)
  const page = await e2e.start({
    scenario: {
      plan: [PLAN, PLAN],
      implement: [GUIDE_INDEX, { recording: 'C08a-session-id-implement', write: RETURNS }],
      explain: [
        NO_QUESTIONS,
        { recording: 'C02-review-shape', text: FILL_IN_SUMMARY },
        NO_QUESTIONS,
        PLAIN_SUMMARY,
      ],
    },
    config: CONFIG,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  const first = await firstRun(e2e, page, IDEA)
  await expect(page.getByTestId('easy-done-fill-ins')).toBeVisible()
  await scrollTo(page.getByTestId('easy-done-explain'))
  await shot(e2e, page, '01-done-fill-ins')
  await page.getByTestId('easy-change-text').fill('Make the buttons bigger')
  await expect(page.getByTestId('easy-change-estimate')).not.toHaveText('', { timeout: 10_000 })
  await scrollTo(page.getByTestId('easy-done-change'))
  await shot(e2e, page, '02-make-change-estimate')

  // A second run in the folder (not a small change), then the history of both.
  const second = await makeChange(page, first.runId, 'Add a page about returning yarn')
  await e2e.waitForEnd(second, 300_000)
  const history = page.getByTestId('easy-done-history')
  await expect(history.getByTestId('easy-history-row')).toHaveCount(2, { timeout: 60_000 })
  await expect(history.getByTestId('easy-history-back').first()).toBeEnabled({ timeout: 60_000 })
  await scrollTo(history)
  await shot(e2e, page, '06-project-history')
})

test('a report from data: no data file on the confirm screen, the upload with data left out', async ({
  e2e,
}) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: { plan: PLAN, implement: [REPORT_IMPLEMENT], explain: [NO_QUESTIONS, PLAIN_SUMMARY] },
    config: CONFIG,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await toConfirm(page, DATA_IDEA)
  await expect(page.getByTestId('easy-no-data-line')).toBeVisible()
  await shot(e2e, page, '03-confirm-no-data')
  await page.getByTestId('easy-back').click()
  await firstRun(e2e, page, DATA_IDEA)
  const share = page.getByTestId('easy-done-share')
  await share.getByTestId('deploy-toggle').click()
  await expect(page.getByTestId('deploy-upload')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await page.getByTestId('deploy-upload-make').click()
  await expect(page.getByTestId('deploy-upload-data')).toBeVisible({ timeout: 60_000 })
  await scrollTo(share)
  await shot(e2e, page, '04-upload-data-left-out')
})

test('a failed run with Carry on', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C09b-logged-out' }],
      explain: [NO_QUESTIONS],
    },
    config: CONFIG,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await toConfirm(page, IDEA)
  await page.getByTestId('easy-start').click()
  const run = await e2e.onlyRun()
  await e2e.waitForEnd(run.runId, 240_000)
  await expect(page.getByTestId('easy-failed')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('easy-failed-actions').locator('[data-testid^="recovery-"]')).toHaveCount(1, {
    timeout: 30_000,
  })
  await shot(e2e, page, '05-done-failed-carry-on')
})

test('a folder with unsaved changes, and the overnight list with warnings', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ config: CONFIG, pickSandbox: true })
  await page.setViewportSize({ width: 1280, height: 900 })
  // Two files git has not saved yet, in a folder with commits.
  writeFileSync(join(e2e.sandbox, 'notes.txt'), 'Ideas for the next version\n')
  writeFileSync(join(e2e.sandbox, 'todo.md'), '# To do\n- Contact page\n')
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-work-existing').click()
  await expect(page.getByTestId('easy-existing-unsaved')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('easy-existing-change').fill('Add a contact page')
  await shot(e2e, page, '07-existing-unsaved')

  await page.getByTestId('nav-easy-overnight').click()
  await expect(page.getByTestId('easy-overnight')).toBeVisible()
  for (const idea of [
    DATA_IDEA,
    'A snake game I can play in the browser',
    'Something for my bakery',
    'A help guide for the customers of my knitting shop: how to order and how shipping works.',
  ]) {
    await page.getByTestId('easy-overnight-idea').fill(idea)
    await page.getByTestId('easy-overnight-add').click()
    await expect(page.getByTestId('easy-overnight-idea')).toHaveValue('', { timeout: 30_000 })
  }
  await expect(page.getByTestId('easy-overnight-item')).toHaveCount(4)
  await expect(page.getByTestId('easy-overnight-warning').first()).toBeVisible()
  await shot(e2e, page, '08-overnight-warnings')
})

test('Easy setup steps when nobody can do the work', async ({ e2e }) => {
  test.setTimeout(180_000)
  // No vendor configured: every one reads "not installed".
  const page = await e2e.start({ config: { ...CONFIG, vendors: {} } })
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill(IDEA)
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-setup')).toBeVisible({ timeout: 30_000 })
  await scrollTo(page.getByTestId('easy-setup'))
  await shot(e2e, page, '09-easy-setup')
})
