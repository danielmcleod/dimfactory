// Screenshots of games phase 3 in light and dark, for review (not a gate; it asserts only what it
// needs to reach each screen): Run it for a game with Phone size on and a play-test whose checks include reduced motion
// and the name check; the game's preview window at phone size (a picture of the window itself); Easy's confirm screen
// for an idea that asks for online multiplayer (pass and play or play by link instead). Runs when GAMES3_SCREENS=1 and
// writes PNGs to test-results/games3-screens/ (git-ignored; Playwright clears test-results at the start of a run, so
// run this spec on its own, last).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG } from './easy-helpers.ts'
import { SNAKE_HTML, SNAKE_PLAYTEST, layoutGame } from './playtest-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'games3-screens')

test.skip(process.env['GAMES3_SCREENS'] === undefined, 'screenshots only: set GAMES3_SCREENS=1')

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
    const b64 = await app.evaluate(async ({ BrowserWindow }, u) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(u))
      if (win === undefined) throw new Error('no preview window')
      return (await win.webContents.capturePage()).toPNG().toString('base64')
    }, url)
    writeFileSync(join(OUT, `${name}-${theme}.png`), Buffer.from(b64, 'base64'))
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

test('Run it: Phone size, the play-test checks, and the phone-size window', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start()
  const app = e2e.app
  if (app === null) throw new Error('no app')
  await page.setViewportSize({ width: 1280, height: 900 })
  layoutGame(e2e.sandbox, SNAKE_HTML, {
    ...SNAKE_PLAYTEST,
    scenarios: [
      {
        name: 'A tap on the garden starts the game on a phone',
        viewport: 'phone',
        steps: [{ tap: [0.5, 0.5] }, { wait: { ms: 300 } }, { expect: 'scene', eq: 'playing' }],
      },
      {
        name: 'With less motion asked for, the game says so',
        reducedMotion: true,
        steps: [{ expect: 'reducedMotion', eq: true }],
      },
      ...SNAKE_PLAYTEST.scenarios,
    ],
  })
  await page.evaluate((f) => {
    window.location.hash = `#/preview?folder=${encodeURIComponent(f)}`
  }, e2e.sandbox)
  const start = page.getByTestId('run-it-start-static:.')
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()
  await expect(page.getByTestId('run-it-network')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('run-it-playtest').click()
  await expect(page.getByTestId('run-it-playtest-result')).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId('run-it-game-check-motion').first()).toBeVisible()
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.getByTestId('run-it-phone').click()
  await opened
  await expect(page.getByTestId('run-it-phone')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  await page.bringToFront()
  await page.getByTestId('run-it-session').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '01-run-it-phone-size-on')
  await page.getByTestId('run-it-playtest-result').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '02-run-it-playtest-motion-names')
  const session = (await e2e.call('preview.list')).find((s) => s.game === true)
  await page.waitForTimeout(1500)
  await windowShot(e2e, app, session?.url ?? '', '03-phone-size-preview-window')
})

test('Easy: an idea that asks for online multiplayer', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ config: { ...EASY_CONFIG, ui: { experience: 'easy' } } })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTestId('easy-idea').fill('An online multiplayer checkers game I can play with my friends')
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-online')).toBeVisible({ timeout: 30_000 })
  await shot(e2e, page, '04-easy-online-pass-and-play')
  await page.getByTestId('easy-online-play-by-link').click()
  await shot(e2e, page, '05-easy-online-play-by-link')
})
