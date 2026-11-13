// Screenshots of Easy mode's third-phase screens in light and dark, for review (not a gate; it asserts
// only what it needs to reach each screen). Runs when EASY3_SCREENS=1 and writes PNGs to test-results/easy3-screens/
// (git-ignored; Playwright clears test-results at the start of a run, so run this spec on its own, last).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG, SUMMARY } from './easy-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'easy3-screens')

test.skip(process.env['EASY3_SCREENS'] === undefined, 'screenshots only: set EASY3_SCREENS=1')

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

const NO_QUESTIONS = { recording: 'C02-review-shape', text: JSON.stringify({ questions: [] }) }
const SUMMARY_ENTRY = { recording: 'C02-review-shape', text: SUMMARY }
const CONFIG = {
  ...EASY_CONFIG,
  ui: { experience: 'easy' },
  easy: { skipPlanCheck: true },
  isolation: { worktree: { install: 'never' } },
}

test('the third phase, light and dark', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: {
            path: 'contact.html',
            content: '<!doctype html><title>Contact</title><h1>Contact us</h1>\n',
          },
        },
        {
          recording: 'C08a-session-id-implement',
          write: {
            path: 'index.html',
            content:
              '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title></head><body><h1>Our bakery</h1><p>Open every day from 7.</p></body></html>\n',
          },
        },
      ],
      explain: [NO_QUESTIONS, SUMMARY_ENTRY, NO_QUESTIONS, SUMMARY_ENTRY],
    },
    config: CONFIG,
    pickSandbox: true,
  })
  await page.setViewportSize({ width: 1280, height: 860 })

  // ---- home: the pictures and the two other ways in ----
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, 260))
  await shot(e2e, page, '01-home-thumbnails-other-ways')

  // ---- a vague idea ----
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, 0))
  await page.getByTestId('easy-idea').fill('Something for my bakery')
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-did-you-mean')).toBeVisible()
  await shot(e2e, page, '02-confirm-did-you-mean')
  await page.getByTestId('easy-back').click()
  await page.getByTestId('easy-idea').fill('')

  // ---- a folder with commits: its screen, the run's "Your changes are ready", the Done screen ----
  await page.getByTestId('easy-work-existing').click()
  await expect(page.getByTestId('easy-existing-mode')).toHaveAttribute('data-mode', 'isolated')
  await page.getByTestId('easy-existing-change').fill('Add a contact page with our phone number')
  await shot(e2e, page, '03-existing-folder-copy')
  await page.getByTestId('easy-existing-start').click()
  const first = await e2e.onlyRun()
  const trust = page.getByTestId('easy-card-trust')
  await expect(trust).toBeVisible({ timeout: 120_000 })
  await shot(e2e, page, '04-existing-checks-ask')
  await trust.getByTestId('card-choice-skip').click()
  await expect(page.getByTestId('easy-card-finalize')).toBeVisible({ timeout: 180_000 })
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await shot(e2e, page, '05-run-your-changes-ready')
  await page.getByTestId('easy-throw-away').click()
  await expect(page.getByTestId('easy-throw-dialog')).toBeVisible()
  await shot(e2e, page, '06-throw-away-confirm')
  await page.getByTestId('easy-throw-no').click()
  await page.getByTestId('easy-keep-changes').click()
  await e2e.waitForEnd(first.runId, 120_000)
  await expect(page.getByTestId('easy-done-changes')).toBeVisible()
  await page.getByTestId('easy-done-changes').scrollIntoViewIfNeeded()
  await shot(e2e, page, '07-done-changes-kept')

  // ---- a website Easy made: Look it over on its Done screen ----
  mkdirSync(join(e2e.home, 'easy'), { recursive: true })
  writeFileSync(
    join(e2e.home, 'easy', 'projects.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          folder: e2e.sandbox,
          idea: 'A landing page for my bakery',
          kind: 'website',
          templateId: 'landing-page',
          createdAt: 1,
          consent: false,
        },
      ],
    })}\n`,
  )
  await page.getByTestId('nav-easy-home').click()
  await page.getByTestId('easy-work-existing').click()
  await expect(page.getByTestId('easy-existing-how')).toContainText('You made this project here')
  await page.getByTestId('easy-existing-change').fill('Add our opening hours')
  await page.getByTestId('easy-existing-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\//)
  const runs = await e2e.call('runs.list', {})
  const second = runs.items.find((r) => r.runId !== first.runId)
  if (second === undefined) throw new Error('no second run')
  const trust2 = page.getByTestId('easy-card-trust')
  await expect(trust2).toBeVisible({ timeout: 120_000 })
  await trust2.getByTestId('card-choice-skip').click()
  await e2e.waitForEnd(second.runId, 180_000)
  await expect(page.getByTestId('easy-done-look')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('easy-done-look').scrollIntoViewIfNeeded()
  await shot(e2e, page, '08-done-look-it-over')

  // ---- the overnight list ----
  await page.getByTestId('nav-easy-overnight').click()
  for (const idea of [
    'A help guide for the customers of my knitting shop: how to order and how shipping works.',
    'A checklist for opening my cafe each morning, step by step.',
  ]) {
    await page.getByTestId('easy-overnight-idea').fill(idea)
    await page.getByTestId('easy-overnight-add').click()
    await expect(page.getByTestId('easy-overnight-idea')).toHaveValue('')
  }
  await page.getByTestId('easy-overnight-time').fill('22:30')
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await shot(e2e, page, '09-overnight-list')
})
