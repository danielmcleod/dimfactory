// Screenshots of games phase 2 in light and dark, for review (not a gate; it asserts only what it
// needs to reach each screen): Easy's Done screen with "Play-tested" after Play-test it again, and the line about a
// request to the internet with "Allow internet for this preview"; Run it for a game (the no-internet line with the
// blocked host, a play-test result, the smoke check's game checks); a run whose Verify play-test failed and whose Fix
// made it pass, with the scenarios open on the Verify card. Runs when GAMES2_SCREENS=1 and writes PNGs to
// test-results/games2-screens/ (git-ignored; Playwright clears test-results at the start of a run, so run this spec on
// its own, last).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT, git } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG } from './easy-helpers.ts'
import { gameScenario, withGamePlan } from './games-helpers.ts'
import {
  SNAKE_HTML,
  SNAKE_PLAYTEST,
  blankCanvas,
  brokenKeys,
  cdnFont,
  layoutGame,
  playtestVerifyConfig,
} from './playtest-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'games2-screens')

test.skip(process.env['GAMES2_SCREENS'] === undefined, 'screenshots only: set GAMES2_SCREENS=1')

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

test('Easy: Play-tested, Play-test it again, a blocked request', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start({
    scenario: gameScenario(),
    editScenario: withGamePlan,
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTestId('easy-example-game').click()
  await page.getByTestId('easy-next').click()
  await page.getByTestId('easy-start').click()
  const run = await e2e.onlyRun()
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  const research = page.getByTestId('easy-card-research')
  await expect(research).toBeVisible({ timeout: 90_000 })
  await research.getByTestId('easy-research-use').click()
  const plan = page.getByTestId('easy-card-plan')
  await expect(plan).toBeVisible({ timeout: 90_000 })
  await plan.getByTestId('easy-build-it').click()
  const ended = await e2e.waitForEnd(run.runId, 300_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // The game now has its scenarios, and asks a font from the internet.
  writeFileSync(join(run.folder, 'playtest.json'), `${JSON.stringify(SNAKE_PLAYTEST, null, 2)}\n`)
  writeFileSync(join(run.folder, 'index.html'), cdnFont(SNAKE_HTML))
  const section = page.getByTestId('easy-done-playtest')
  await section.scrollIntoViewIfNeeded()
  await section.getByTestId('easy-playtest-again').click()
  await expect(section.getByTestId('easy-playtest-scenario')).toHaveCount(4, { timeout: 120_000 })
  await expect(section.getByTestId('easy-playtest-allow-internet')).toBeVisible()
  await section.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '01-easy-done-playtested-blocked')
  await section.getByTestId('easy-playtest-allow-internet').click()
  await expect(section.getByTestId('easy-playtest-note')).toContainText('Internet allowed for this preview')
  await shot(e2e, page, '02-easy-done-internet-allowed')
})

test('Run it for a game, and Verify with the play-test', async ({ e2e }) => {
  test.setTimeout(600_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'index.html', content: brokenKeys(SNAKE_HTML) },
        },
      ],
      resume: [
        {
          recording: 'C08b-resume-fix',
          write: { path: 'index.html', content: SNAKE_HTML },
          text: 'F1 fixed',
        },
      ],
    },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  layoutGame(e2e.sandbox)
  playtestVerifyConfig(e2e.sandbox)
  git(e2e.sandbox, 'add', '-A')
  git(e2e.sandbox, 'commit', '-q', '-m', 'a snake game with a play-test')

  // ---- Verify: the play-test failed, Fix repaired it ----
  const run = await e2e.runFromDashboard('Make the snake steer with the arrow keys')
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(run.runId, 300_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const toggle = page.locator('[data-testid$="-scenarios-toggle"]').first()
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  const card = page.locator('[data-testid^="pass-card-verify:1"]').first()
  await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '03-verify-playtest-scenarios')

  // ---- the run's Run it: no internet, a blocked request, Play-test, the smoke check's findings ----
  writeFileSync(join(e2e.sandbox, 'index.html'), cdnFont(brokenKeys(SNAKE_HTML)))
  const open = page.getByTestId('run-it-toggle')
  await open.scrollIntoViewIfNeeded()
  await open.click()
  const start = page.getByTestId('run-it-start-static:.')
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()
  await expect(page.getByTestId('run-it-network')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('run-it-playtest').click()
  await expect(page.getByTestId('run-it-playtest-result')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('run-it-network-text')).toContainText('fonts.example.invalid', {
    timeout: 30_000,
  })
  await page.getByTestId('run-it-session').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '04-run-it-playtest-blocked')
  writeFileSync(join(e2e.sandbox, 'index.html'), cdnFont(blankCanvas(SNAKE_HTML)))
  await page.getByTestId('run-it-smoke').click()
  await expect(page.getByTestId('run-it-game-check-canvas').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId('run-it-smoke-findings')).toContainText('internet (fonts.example.invalid)')
  await page.getByTestId('run-it-smoke-result').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '05-run-it-smoke-game-checks')
})
