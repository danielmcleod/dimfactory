// "Make an upload file" end to end, in Easy mode on the fake Claude with an isolated home (the projects
// folder is beside the test's home). A small page is made (with a .env, a memory file, a key, a node_modules folder and
// Dim Factory's play-test data beside it); the Done screen's Share it, once opened, offers Make an upload file with the
// plain steps and "Putting it online makes it public."; one click writes <project>-site.zip next to the project, and
// the zip holds the page's files only. Nothing is uploaded and no browser window opens. The Full Deploy page offers the
// same button for the folder. With DEPLOY_MORE_SCREENS=1 it also saves review screenshots, light and dark, to
// test-results/deploy-more-screens/ (git-ignored; run it on its own, last, since Playwright clears test-results).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { readZip } from '../../src/core/deploy/zip.ts'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG, INDEX_HTML, easyScenario, ideaToConfirm, withCriteria } from './easy-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)
const OUT = join(REPO_ROOT, 'test-results', 'deploy-more-screens')
const SCREENS = process.env['DEPLOY_MORE_SCREENS'] !== undefined

async function shot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  if (!SCREENS) return
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

test('Easy Done, Share it: Make an upload file writes a zip of the page next to the project', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: easyScenario({
      implement: [
        {
          recording: 'C08a-session-id-implement',
          prepend: [
            { op: 'writeFile', path: 'style.css', content: 'body { font-family: sans-serif }\n' },
            { op: 'writeFile', path: 'pages/shipping.html', content: '<h1>Shipping</h1>\n' },
            { op: 'writeFile', path: '.env', content: 'SHOP_KEY=\n' },
            { op: 'writeFile', path: 'CLAUDE.md', content: '# Notes for the agent\n' },
            { op: 'writeFile', path: 'deploy.pem', content: 'not a key\n' },
            { op: 'writeFile', path: 'playtest.json', content: '{}\n' },
            { op: 'writeFile', path: 'node_modules/left-pad/index.js', content: 'module.exports = 1\n' },
          ],
          write: { path: 'index.html', content: INDEX_HTML },
        },
      ],
    }),
    editScenario: withCriteria,
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
  })
  await page.setViewportSize({ width: 1280, height: 900 })

  await ideaToConfirm(page)
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  const plan = page.getByTestId('easy-card-plan')
  await expect(plan).toBeVisible({ timeout: 90_000 })
  await plan.getByTestId('easy-build-it').click()
  const ended = await e2e.waitForEnd(run.runId, 240_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('easy-done-title')).toBeVisible()

  // ---- Share it, opened: the upload file with its steps and the caveat ----
  const share = page.getByTestId('easy-done-share')
  await share.getByTestId('deploy-toggle').click()
  const upload = share.getByTestId('deploy-upload')
  await expect(upload).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  await expect(upload.getByTestId('deploy-upload-steps')).toContainText(
    'Open Netlify Drop and drag this file (or the folder) onto the page.',
  )
  await expect(upload.getByTestId('deploy-upload-steps')).toContainText(
    'Or in Cloudflare Pages: Create, Upload assets, then choose this file.',
  )
  await expect(upload.getByTestId('deploy-upload-public')).toHaveText('Putting it online makes it public.')
  await expect(upload.getByTestId('deploy-upload-show')).toBeDisabled()
  await upload.scrollIntoViewIfNeeded()
  await shot(e2e, page, '01-easy-share-it')

  // ---- Make an upload file: one zip next to the project, the page's files only ----
  const zip = join(dirname(run.folder), `${basename(run.folder)}-site.zip`)
  expect(existsSync(zip)).toBe(false)
  const windows = e2e.app?.windows().length ?? 0
  const makeBox = await upload.getByTestId('deploy-upload-make').boundingBox()
  await upload.getByTestId('deploy-upload-make').click()
  const status = upload.getByTestId('deploy-upload-status')
  await expect(status).toHaveAttribute('data-state', 'made', { timeout: 60_000 })
  await expect(status).toContainText(`Made ${basename(zip)}`)
  await expect(upload.getByTestId('deploy-upload-show')).toBeEnabled()
  // The button kept its size; nothing opened.
  const after = await upload.getByTestId('deploy-upload-make').boundingBox()
  expect(after?.width).toBe(makeBox?.width)
  expect(e2e.app?.windows().length ?? 0).toBe(windows)
  expect(existsSync(zip)).toBe(true)
  const entries = readZip(readFileSync(zip))
    ?.entries.map((e) => e.name)
    .sort()
  expect(entries).toEqual(['index.html', 'pages/shipping.html', 'style.css'])
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await shot(e2e, page, '02-easy-upload-made')

  // ---- the Full Deploy page offers the same button for the folder ----
  await page.evaluate((f) => {
    window.location.hash = `#/deploy?folder=${encodeURIComponent(f)}`
  }, run.folder)
  await expect(page.getByTestId('deploy-page')).toBeVisible()
  const full = page.getByTestId('deploy-upload')
  await expect(full).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  await expect(page.getByTestId('deploy-option-surge')).toBeVisible()
  await full.scrollIntoViewIfNeeded()
  await shot(e2e, page, '03-full-deploy-upload')
  await page.getByTestId('deploy-option-surge').click()
  await expect(page.getByTestId('deploy-steps')).toContainText('surge.sh')
  await page.getByTestId('deploy-steps').scrollIntoViewIfNeeded()
  await shot(e2e, page, '04-full-surge-steps')
  expect(e2e.pageErrors).toEqual([])
})
