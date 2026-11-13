// Screenshots of the optional light 3D game in light and dark, for review (not a gate; it asserts
// only what it needs to reach each screen): Easy's confirm screen for a 3D idea (the 3D template, "Uses three.js,
// installed into the project (needs Node)"), Run it for the 3D fixture game after a play-test, and the fixture running
// in its preview window (a picture of the window itself). Runs when GAMES3D_SCREENS=1 and writes PNGs to
// test-results/games3d-screens/ (git-ignored; Playwright clears test-results at the start of a run, so run this spec on
// its own, last).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG } from './easy-helpers.ts'
import { layoutMarble3d } from '../unit/games/marble3d-fixture.ts'

const OUT = join(REPO_ROOT, 'test-results', 'games3d-screens')

test.skip(process.env['GAMES3D_SCREENS'] === undefined, 'screenshots only: set GAMES3D_SCREENS=1')

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

/** A picture of the game's preview window itself (its page), with the app in each theme. */
async function windowShot(
  e2e: E2EHarness,
  app: ElectronApplication,
  url: string,
  name: string,
): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await new Promise((r) => setTimeout(r, 500))
    const b64 = await app.evaluate(async ({ BrowserWindow }, u) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(u))
      if (win === undefined) throw new Error('no preview window')
      return (await win.webContents.capturePage()).toPNG().toString('base64')
    }, url)
    writeFileSync(join(OUT, `${name}-${theme}.png`), Buffer.from(b64, 'base64'))
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

test('Easy: a 3D idea uses three.js, installed into the project', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ config: { ...EASY_CONFIG, ui: { experience: 'easy' } } })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTestId('easy-idea').fill('A 3D marble game where you tilt a garden board to collect gems')
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Light 3D game (three.js)', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('easy-confirm-fallback')).toHaveText(
    'Uses three.js, installed into the project (needs Node).',
  )
  await shot(e2e, page, '01-easy-confirm-3d')
})

test('Run it: the 3D fixture after a play-test, and its preview window', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  await page.setViewportSize({ width: 1280, height: 900 })
  layoutMarble3d(e2e.sandbox)
  await page.evaluate((f) => {
    window.location.hash = `#/preview?folder=${encodeURIComponent(f)}`
  }, e2e.sandbox)
  const start = page.getByTestId('run-it-start-static:.')
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()
  await expect(page.getByTestId('run-it-network')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('run-it-playtest').click()
  await expect(page.getByTestId('run-it-playtest-result')).toBeVisible({ timeout: 180_000 })
  await page.getByTestId('run-it-playtest-result').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '02-run-it-3d-playtest')
  const session = (await e2e.call('preview.list')).find((s) => s.game === true)
  if (session === undefined) throw new Error('no game preview')
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await e2e.call('preview.open', { sessionId: session.id, target: 'app' })
  await opened
  await page.waitForTimeout(2000)
  await windowShot(e2e, app, session.url ?? '', '03-3d-preview-window')
})
