// Screenshots of beginners part A for review, in light and dark (not a gate; it asserts only what it
// needs to reach each screen). Runs when BEGINNER_A_SCREENS=1 and writes PNGs to test-results/beginner-a-screens/
// (git-ignored; Playwright clears test-results at the start of a run, so run this spec on its own, last). The React
// site is a realistic sample built from the web starter's own files (with a bakery's words in src/content.ts) by its
// real Vite build, offline (react-helpers.ts), and shown in Dim Factory's preview window.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG } from './easy-helpers.ts'
import { BAKERY_CONTENT, BAKERY_IDEA, linkReactDeps, stageStarter } from './react-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'beginner-a-screens')

test.skip(process.env['BEGINNER_A_SCREENS'] === undefined, 'screenshots only: set BEGINNER_A_SCREENS=1')

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

/** A picture of a preview window (its page), with the app in each theme (the page follows the system's). */
async function windowShot(
  e2e: E2EHarness,
  app: ElectronApplication,
  url: string,
  name: string,
): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await new Promise((r) => setTimeout(r, 700))
    const b64 = await app.evaluate(
      async ({ BrowserWindow }, [u, t]) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(u))
        if (win === undefined) throw new Error('no preview window')
        // The site's own theme switch (its toggle sets data-theme), as a visitor would pick it.
        await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${t}'`)
        await new Promise((r) => setTimeout(r, 300))
        return (await win.webContents.capturePage()).toPNG().toString('base64')
      },
      [url, theme] as const,
    )
    writeFileSync(join(OUT, `${name}-${theme}.png`), Buffer.from(b64, 'base64'))
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

async function toConfirm(page: Page, idea: string): Promise<void> {
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill(idea)
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-confirm-kind')).toBeVisible({ timeout: 30_000 })
}

test('the confirm screen: React with the sign-up question, the AI proxy offer', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
    env: { DIM_FACTORY_E2E_NODE: '22.12.0' },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await toConfirm(page, BAKERY_IDEA)
  await expect(page.getByTestId('easy-need-question')).toBeVisible()
  await shot(e2e, page, '01-confirm-react-signups')
  await page.getByTestId('easy-back').click()
  await toConfirm(page, 'An AI caption writer app for my photos, with a members area to save favourites')
  await expect(page.getByTestId('easy-need-ai-proxy')).toBeVisible()
  await shot(e2e, page, '02-confirm-ai-proxy')
  await page.getByTestId('easy-stack-html').click()
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Static website')
  await shot(e2e, page, '03-confirm-plain-html')
})

test('the confirm screen without Node.js, and with one too old', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
    env: { DIM_FACTORY_E2E_NODE: 'none' },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await toConfirm(page, 'A tip splitter app my friends can open on their phones')
  await expect(page.getByTestId('easy-stack-why')).toBeVisible()
  await shot(e2e, page, '04-confirm-no-node')
})

test('OneDrive: the projects folder in the user folder, and why', async ({ e2e }) => {
  test.setTimeout(240_000)
  const documents = join(e2e.root, 'OneDrive', 'Documents')
  mkdirSync(documents, { recursive: true })
  const page = await e2e.start({
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
    env: { DIM_FACTORY_E2E_DOCUMENTS: documents },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTestId('nav-easy-settings').click()
  await expect(page.getByTestId('easy-settings-onedrive')).toBeVisible()
  await shot(e2e, page, '05-easy-settings-onedrive')
})

test('a React site from the starter: Get it ready to share, and the site in the preview window', async ({
  e2e,
}) => {
  test.setTimeout(600_000)
  const page = await e2e.start({ config: { ...EASY_CONFIG, ui: { experience: 'full' } } })
  const app = e2e.app
  if (app === null) throw new Error('no app')
  await page.setViewportSize({ width: 1280, height: 900 })
  const site = join(e2e.root, 'bramble-and-rye')
  mkdirSync(site, { recursive: true })
  stageStarter(site)
  writeFileSync(join(site, 'src', 'content.ts'), BAKERY_CONTENT)
  linkReactDeps(site)
  // Its own tests pass (the starter's, on the bakery's words).
  const test_ = spawnSync('npm run test', { cwd: site, shell: true, encoding: 'utf8', windowsHide: true })
  expect(test_.status, test_.stdout + test_.stderr).toBe(0)

  // ---- Deploy: Get it ready to share asks to trust the build, then builds dist/ ----
  await page.evaluate((f) => {
    window.location.hash = `#/deploy?folder=${encodeURIComponent(f)}`
  }, site)
  const build = page.getByTestId('deploy-build-run')
  await expect(build).toBeVisible({ timeout: 60_000 })
  await build.click()
  await expect(page.getByTestId('deploy-build-trust')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('deploy-build-trust').scrollIntoViewIfNeeded()
  await shot(e2e, page, '06-deploy-get-ready-trust')
  await page.getByTestId('deploy-build-trust-ok').click()
  await expect(page.getByTestId('deploy-build-status')).toHaveText(/^Ready to share/, { timeout: 180_000 })
  await expect(page.getByTestId('deploy-upload')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  await page.getByTestId('deploy-build').scrollIntoViewIfNeeded()
  await shot(e2e, page, '07-deploy-ready-to-share')

  // ---- the built site in Dim Factory's preview window ----
  await page.evaluate((f) => {
    window.location.hash = `#/preview?folder=${encodeURIComponent(f)}`
  }, site)
  const start = page.getByTestId('run-it-start-static:dist')
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()
  await expect(page.getByTestId('run-it-status')).toContainText('http://127.0.0.1:', { timeout: 30_000 })
  const session = (await e2e.call('preview.list')).find((s) => s.commandId === 'static:dist')
  if (session?.url === undefined || session.url === null) throw new Error('no static preview')
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await e2e.call('preview.open', { sessionId: session.id, target: 'app' })
  const win = await opened
  await win.waitForLoadState('load')
  await expect(win.locator('h1')).toBeVisible({ timeout: 30_000 })
  await windowShot(e2e, app, session.url, '08-react-site-home')
  await win.goto(new URL('about', session.url).href)
  await expect(win.locator('h1')).toHaveText('About')
  await windowShot(e2e, app, session.url, '09-react-site-about')
  await win.goto(new URL('no-such-page', session.url).href)
  await expect(win.locator('h1')).toHaveText('We could not find that page')
  await windowShot(e2e, app, session.url, '10-react-site-not-found')
})
