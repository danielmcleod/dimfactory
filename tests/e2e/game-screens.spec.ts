// Screenshots of "A game" in Easy mode in light and dark, for review (not a gate; it asserts only what
// it needs to reach each screen), and of the fixture game being played in the preview window. Runs when
// GAMES1_SCREENS=1 and writes PNGs to test-results/games1-screens/ (git-ignored; Playwright clears test-results at the
// start of a run, so run this spec on its own, last).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG } from './easy-helpers.ts'
import { gameScenario, withGamePlan } from './games-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'games1-screens')

test.skip(process.env['GAMES1_SCREENS'] === undefined, 'screenshots only: set GAMES1_SCREENS=1')

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

/** A tiny real PNG (a 2 by 2 picture), as a photo the user adds. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEEwDQDAwMDAwA9bQX7m6WZ6QAAAABJRU5ErkJggg==',
  'base64',
)

test('a game, light and dark, and the game being played', async ({ e2e }) => {
  test.setTimeout(600_000)
  const photos = mkdtempSync(join(tmpdir(), 'dimf-photos-'))
  const photo = join(photos, 'birthday.png')
  writeFileSync(photo, PNG)
  try {
    const page = await e2e.start({
      scenario: gameScenario(),
      editScenario: withGamePlan,
      config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
      pickFiles: [photo],
    })
    const app = e2e.app
    if (app === null) throw new Error('no app')
    await page.setViewportSize({ width: 1280, height: 860 })

    // ---- home: the gallery with the two game cards ----
    await expect(page.getByTestId('easy-home')).toBeVisible()
    await expect(page.getByTestId('easy-thumb-game-photos')).toBeVisible()
    await page
      .getByRole('heading', { name: 'Need an idea? Start from one of these' })
      .evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await shot(e2e, page, '01-home-gallery-games')

    // ---- a photo added: where it goes ----
    await page.getByTestId('main').evaluate((m) => m.scrollTo(0, 0))
    await page.getByTestId('easy-example-game').click()
    await page.getByTestId('easy-attach-add').click()
    await expect(page.getByTestId('easy-photo-privacy')).toBeVisible()
    await shot(e2e, page, '02-home-photo-privacy')

    // ---- confirm: A game, from the arcade template ----
    await page.getByTestId('easy-next').click()
    await expect(page.getByTestId('easy-kind')).toContainText('A game')
    await shot(e2e, page, '03-confirm-a-game')
    await page.getByTestId('easy-start').click()
    const run = await e2e.onlyRun()

    // ---- how it is played ----
    const questions = page.getByTestId('easy-card-questions')
    await expect(questions).toBeVisible({ timeout: 90_000 })
    await shot(e2e, page, '04-questions-how-to-play')
    await questions.getByTestId('easy-q-0-opt-0').check()
    await questions.getByTestId('easy-continue').click()
    const research = page.getByTestId('easy-card-research')
    await expect(research).toBeVisible({ timeout: 90_000 })
    await shot(e2e, page, '05-similar-games')
    await research.getByTestId('easy-research-use').click()

    // ---- the plan as play outcomes ----
    const plan = page.getByTestId('easy-card-plan')
    await expect(plan).toBeVisible({ timeout: 90_000 })
    await shot(e2e, page, '06-plan-play-outcomes')
    await plan.getByTestId('easy-build-it').click()

    // ---- done ----
    const ended = await e2e.waitForEnd(run.runId, 240_000)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await expect(page.getByTestId('easy-play-it')).toBeVisible()
    await shot(e2e, page, '07-done-play-it')
    const share = page.getByTestId('easy-done-share')
    await share.scrollIntoViewIfNeeded()
    await share.getByRole('button', { name: 'Show how to share it' }).click()
    await expect(share).toContainText('itch.io')
    await expect(page.getByTestId('easy-share-photos')).toBeVisible()
    await share.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await shot(e2e, page, '08-done-share-itch-photos')

    // ---- the game being played in the preview window ----
    await page.getByTestId('main').evaluate((m) => m.scrollTo(0, 0))
    const opened = app.waitForEvent('window', { timeout: 30_000 })
    await page.getByTestId('easy-play-it').click()
    const game = await opened
    await game.waitForLoadState('load')
    await expect(game.locator('#message')).toContainText('Press Space to start')
    await game.waitForTimeout(400)
    await game.screenshot({ path: join(OUT, '09-play-title.png') })
    await game.keyboard.press('Space')
    // Steer up the garden, then left (the snake keeps moving between presses).
    for (const k of ['ArrowUp', 'ArrowLeft']) {
      await game.keyboard.down(k)
      await game.waitForTimeout(450)
      await game.keyboard.up(k)
    }
    await game.screenshot({ path: join(OUT, '10-play-playing.png') })
    await game.keyboard.press('KeyP')
    await expect(game.locator('#message')).toContainText('Paused')
    await game.waitForTimeout(200)
    await game.screenshot({ path: join(OUT, '11-play-paused.png') })
    expect(e2e.pageErrors).toEqual([])
  } finally {
    rmSync(photos, { recursive: true, force: true })
  }
})
