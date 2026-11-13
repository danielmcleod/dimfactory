// Screenshots of every Easy mode screen in light and dark, for review (not a gate; it asserts only what
// it needs to reach each screen). Runs when EASY_SCREENS=1 and writes PNGs to test-results/easy-screens/ (git-ignored;
// Playwright clears test-results at the start of a run, so run this spec on its own, last).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import {
  EASY_CONFIG,
  INDEX_HTML,
  easyScenario,
  ideaToConfirm,
  setCost,
  withCriteria,
} from './easy-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'easy-screens')

test.skip(process.env['EASY_SCREENS'] === undefined, 'screenshots only: set EASY_SCREENS=1')

async function shot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

test('every Easy screen, light and dark', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start({
    newUser: true,
    scenario: easyScenario({
      // Implement asks to run a command first (the plain ask card), then writes the page.
      implement: [
        { recording: 'C04a-ask-allow', write: { path: 'index.html', content: INDEX_HTML }, delayMs: 4000 },
      ],
    }),
    editScenario: (sc) => {
      withCriteria(sc)
      setCost(sc, 'explain-1.script.jsonl', 0.42)
    },
    config: EASY_CONFIG,
  })
  await page.setViewportSize({ width: 1280, height: 860 })

  await expect(page.getByTestId('welcome-card')).toBeVisible()
  await shot(e2e, page, '01-welcome')
  await page.getByTestId('welcome-easy').click()
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await shot(e2e, page, '02-home')
  await page.getByTestId('easy-example-document').click()
  await shot(e2e, page, '03-home-with-idea')

  await ideaToConfirm(
    page,
    'A help guide for the customers of my knitting shop: ordering, shipping and yarn care.',
  )
  await page.getByTestId('easy-limit').fill('0.2')
  await shot(e2e, page, '04-confirm-limit-warning')
  await page.getByTestId('easy-limit').fill('')
  await shot(e2e, page, '05-confirm')
  await page.getByTestId('easy-start').click()
  await expect(page.getByTestId('easy-run')).toBeVisible()
  const run = await e2e.onlyRun()

  await expect(page.getByTestId('easy-card-questions')).toBeVisible({ timeout: 90_000 })
  await shot(e2e, page, '06-run-questions')
  await page.getByTestId('easy-q-0-opt-0').check()
  await page.getByTestId('easy-continue').click()

  await expect(page.getByTestId('easy-card-plan')).toBeVisible({ timeout: 90_000 })
  await shot(e2e, page, '07-run-plan')
  await page.getByTestId('easy-plan-toggle').click()
  await shot(e2e, page, '08-run-plan-full')
  await page.getByTestId('easy-build-it').click()

  const ask = page.getByTestId('easy-ask')
  await expect(ask).toBeVisible({ timeout: 90_000 })
  await shot(e2e, page, '09-run-ask')
  // The recorded Implement asks twice for the same command.
  await ask.getByTestId('easy-ask-allow').click()
  await page.waitForTimeout(800)
  await page.getByTestId('easy-ask').getByTestId('easy-ask-allow').click()
  await expect(page.getByTestId('easy-ask')).toBeHidden()
  await shot(e2e, page, '10-run-building')
  await page.getByTestId('easy-stop').click()
  await expect(page.getByTestId('easy-stop-dialog')).toBeVisible()
  await shot(e2e, page, '11-run-stop-confirm')
  // The run may end while the dialog shows: the dialog goes with it.
  if (await page.getByTestId('easy-stop-no').isVisible()) await page.getByTestId('easy-stop-no').click()

  await e2e.waitForEnd(run.runId, 180_000)
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await shot(e2e, page, '12-done')
  await page.getByTestId('easy-change-text').fill('Add a page about our opening hours')
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await shot(e2e, page, '13-done-make-a-change')

  await page.getByTestId('nav-easy-projects').click()
  await expect(page.getByTestId('easy-projects-page')).toBeVisible()
  await shot(e2e, page, '14-projects')
  await page.getByTestId('nav-easy-settings').click()
  await expect(page.getByTestId('easy-settings')).toBeVisible()
  await shot(e2e, page, '15-easy-settings')

  // A run its limit stopped.
  await page.getByTestId('nav-easy-home').click()
  await ideaToConfirm(page, 'A checklist for opening my cafe each morning, step by step.')
  await page.getByTestId('easy-limit').fill('0.01')
  await page.getByTestId('easy-start').click()
  await expect(page.getByTestId('easy-run')).toBeVisible()
  await expect(page.getByTestId('easy-continue-more')).toBeVisible({ timeout: 150_000 })
  await shot(e2e, page, '16-done-limit-stop')

  // Full control, with the switch in the sidebar.
  await page.getByTestId('experience-full').click()
  await expect(page.getByTestId('nav-dashboard')).toBeVisible()
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await shot(e2e, page, '17-full-dashboard-switch')
})
