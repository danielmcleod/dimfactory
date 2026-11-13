// Screenshots of Easy mode's second-phase screens in light and dark, for review (not a gate; it asserts
// only what it needs to reach each screen). Runs when EASY2_SCREENS=1 and writes PNGs to test-results/easy2-screens/
// (git-ignored; Playwright clears test-results at the start of a run, so run this spec on its own, last).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { rewriteAsks } from '../integration/easy/asks.ts'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG, IDEA, QUESTIONS, SUMMARY, ideaToConfirm } from './easy-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'easy2-screens')

test.skip(process.env['EASY2_SCREENS'] === undefined, 'screenshots only: set EASY2_SCREENS=1')

async function shot(e2e: E2EHarness, page: Page, name: string, target?: Page): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    if (target !== undefined) await target.emulateMedia({ colorScheme: theme })
    await page.waitForTimeout(250)
    await (target ?? page).screenshot({ path: join(OUT, `${name}-${theme}.png`) })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

const PACKAGE = JSON.stringify({ name: 'shop', private: true, scripts: { dev: 'vite' } })
const PACKAGE_TEST = JSON.stringify({ name: 'cafe', private: true, scripts: { test: 'node -e 0' } })
const DOC_INDEX =
  '# Knitting shop help\n\nEverything you need to order, get your parcel and look after your yarn.\n\n' +
  '## Ordering\n\nPick your yarn, choose a colour and add it to the basket. See [shipping](shipping.md) for times.\n\n' +
  '| Yarn | Weight | Price |\n| --- | --- | --- |\n| Merino | DK | $9 |\n| Alpaca | Aran | $12 |\n'
const DOC_SHIPPING =
  '# Shipping\n\n1. We pack your order within two days.\n2. Delivery takes three to five days.\n'

test('the second phase, light and dark', async ({ e2e }) => {
  test.setTimeout(600_000)
  const csv = join(e2e.root, 'shop-orders.csv')
  writeFileSync(csv, 'month,orders\nJan,12\nFeb,15\n')
  const outside = join(e2e.root, 'outside', 'notes.txt')
  const page = await e2e.start({
    scenario: {
      plan: [
        { recording: 'C06-plan-native-host' },
        { recording: 'C06-plan-native-host' },
        { recording: 'C06-plan-native-host' },
      ],
      implement: [
        {
          recording: 'C04a-ask-allow',
          delayMs: 1500,
          prepend: [
            { op: 'writeFile', path: 'package.json', content: PACKAGE },
            { op: 'writeFile', path: 'docs/index.md', content: DOC_INDEX },
          ],
          write: { path: 'docs/shipping.md', content: DOC_SHIPPING },
        },
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'package.json', content: PACKAGE_TEST },
        },
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'runbook.md', content: '# Opening the cafe\n' },
        },
      ],
      explain: [
        { recording: 'C02-review-shape', text: JSON.stringify(QUESTIONS) },
        { recording: 'C02-review-shape', text: SUMMARY },
        { recording: 'C02-review-shape', text: JSON.stringify({ questions: [] }) },
        { recording: 'C02-review-shape', text: SUMMARY },
        { recording: 'C02-review-shape', text: JSON.stringify({ questions: [] }) },
        { recording: 'C02-review-shape', text: SUMMARY },
      ],
    },
    editScenario: (sc) =>
      rewriteAsks(join(sc.dir, 'implement-1.script.jsonl'), [
        { tool: 'Bash', input: { command: 'npm install' } },
        { tool: 'Bash', input: { command: 'npm run dev' } },
        { tool: 'Write', input: { file_path: outside, content: 'x' } },
      ]),
    config: { ...EASY_CONFIG, ui: { experience: 'easy' }, easy: { skipPlanCheck: true } },
    pickFiles: [csv],
  })
  await page.setViewportSize({ width: 1280, height: 860 })

  // ---- home with a file added, the confirm screen with it and the permission ----
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill(IDEA)
  await page.getByTestId('easy-attach-add').click()
  await expect(page.getByTestId('easy-privacy')).toBeVisible()
  await shot(e2e, page, '01-home-files')
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-confirm-kind')).toBeVisible()
  await page.getByTestId('easy-consent').click()
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await shot(e2e, page, '02-confirm-files-permission')
  await page.getByTestId('easy-start').click()
  await expect(page.getByTestId('easy-run')).toBeVisible()
  const first = await e2e.onlyRun()

  // ---- the run: the short title, the permission's count, the outside ask ----
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  const ask = page.getByTestId('easy-ask')
  await expect(ask).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('easy-permission-uses')).toHaveText(
    'Approved under your project permission: 2',
  )
  await shot(e2e, page, '03-run-permission-outside-ask')
  await ask.getByTestId('easy-ask-allow').click()
  await e2e.waitForEnd(first.runId, 180_000)

  // ---- Done: a document, with Save as PDF, Remember and Share it ----
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await shot(e2e, page, '04-done-document')
  const app = e2e.app
  if (app === null) throw new Error('no app')
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.getByTestId('easy-open-it').click()
  const preview: Page = await opened
  await preview.waitForLoadState('domcontentloaded')
  await preview.setViewportSize({ width: 1000, height: 760 })
  await shot(e2e, page, '05-document-preview', preview)
  await preview.close()
  await page.getByTestId('easy-save-pdf').click()
  await expect(page.getByTestId('easy-open-note')).toContainText('Saved as', { timeout: 60_000 })
  await expect(page.getByTestId('easy-remember')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('easy-remember').click()
  await expect(page.getByTestId('easy-remembered')).toBeVisible()
  await page.getByTestId('easy-done-share').getByTestId('deploy-toggle').click()
  await expect(page.getByTestId('easy-done-share').getByTestId('deploy-body')).toBeVisible()
  await page.getByTestId('easy-done-remember').scrollIntoViewIfNeeded()
  await shot(e2e, page, '06-done-pdf-remember-share')

  // ---- Easy settings and Settings: the permissions ----
  await page.getByTestId('nav-easy-settings').click()
  await expect(page.getByTestId('easy-permissions-row')).toHaveCount(1)
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await shot(e2e, page, '07-easy-settings-permissions')

  // ---- a project without the permission: a change run's checks ask on the plain trust card ----
  await page.getByTestId('nav-easy-home').click()
  await ideaToConfirm(page, 'A checklist for opening my cafe each morning, step by step.')
  await page.getByTestId('easy-start').click()
  await expect(page.getByTestId('easy-run')).toBeVisible()
  const runs = await e2e.call('runs.list', {})
  const second = runs.items.find((r) => r.runId !== first.runId)
  if (second === undefined) throw new Error('no second run')
  await e2e.waitForEnd(second.runId, 180_000)
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await page.getByTestId('easy-change-text').fill('Add a step for the coffee machine')
  await page.getByTestId('easy-make-change').click()
  const trust = page.getByTestId('easy-card-trust')
  await expect(trust).toBeVisible({ timeout: 120_000 })
  await trust.getByTestId('easy-card-what').click()
  await shot(e2e, page, '08-run-trust-card')

  // Full control's Settings, Vendors: the permission beside the trusted folders.
  await page.getByTestId('experience-full').click()
  await expect(page).toHaveURL(/#\/runs\//)
  await page.evaluate(() => (window.location.hash = '#/settings/vendors'))
  await expect(page.getByTestId('settings-easy-permissions-row')).toHaveCount(1)
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await shot(e2e, page, '09-settings-vendors-permissions')
})
