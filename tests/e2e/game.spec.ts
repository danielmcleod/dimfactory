// "A game" in Easy mode end to end, on the fake Claude with an isolated home (the projects folder is beside
// the test's home, never a real Documents folder). The gallery's game card fills the idea; the confirm screen says
// "A game" and starts from the arcade template; the new folder gets the starter engine (src/engine/, lib/VENDORED.md)
// before the run starts; the questions ask how it is played (the plain Clarify prompt's game clause); the plan lists
// play outcomes; the Done screen says "Your game is ready" with Play it, Open in browser and Show the files, the
// controls on one line and How to play; Play it opens the preview window, which takes the keyboard at once: a real key
// press starts the game with no click first.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { EASY_CONFIG } from './easy-helpers.ts'
import {
  GAME_CONTROLS,
  GAME_CRITERIA,
  GAME_HTML,
  GAME_IDEA,
  gameScenario,
  withGamePlan,
} from './games-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)

test('a game idea: questions, a plan of play outcomes, Done with Play it; the preview takes the keys', async ({
  e2e,
}) => {
  test.setTimeout(400_000)
  const page = await e2e.start({
    scenario: gameScenario(),
    editScenario: withGamePlan,
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
  })
  const app = e2e.app
  if (app === null) throw new Error('no app')

  // ---- the gallery card and the confirm screen ----
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await expect(page.getByTestId('easy-thumb-game')).toBeVisible()
  await page.getByTestId('easy-example-game').click()
  await expect(page.getByTestId('easy-idea')).toHaveValue(GAME_IDEA)
  await page.getByTestId('easy-next').click()
  await expect(page).toHaveURL(/#\/easy\/new$/)
  await expect(page.getByTestId('easy-kind')).toContainText('A game')
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Arcade game (canvas)')
  await expect(page.getByTestId('easy-folder')).toContainText('snake-game-play')
  await expect(page.getByTestId('easy-start')).toBeEnabled()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()

  // The starter engine is in the new folder before the run builds anything.
  for (const f of ['loop.js', 'rng.js', 'input.js', 'storage.js', 'test-hook.js'])
    expect(existsSync(join(run.folder, 'src', 'engine', f)), f).toBe(true)
  expect(readFileSync(join(run.folder, 'lib', 'VENDORED.md'), 'utf8')).toContain('src/engine/loop.js')
  expect(existsSync(join(run.folder, 'docs', 'game-test-hook.md'))).toBe(true)

  // ---- how it is played ----
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await expect(questions).toContainText('How do you play it?')
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  await expect(questions).toBeHidden()

  // ---- a look at similar games ----
  const research = page.getByTestId('easy-card-research')
  await expect(research).toBeVisible({ timeout: 90_000 })
  await research.getByTestId('easy-research-use').click()

  // ---- the plan, as things a player does and sees ----
  const plan = page.getByTestId('easy-card-plan')
  await expect(plan).toBeVisible({ timeout: 90_000 })
  for (const c of GAME_CRITERIA) await expect(plan.getByTestId('easy-plan-will-do')).toContainText(c)
  await plan.getByTestId('easy-build-it').click()
  await expect(plan).toBeHidden()

  // ---- done: ready, Play it, the controls, How to play ----
  const ended = await e2e.waitForEnd(run.runId, 240_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('easy-done-title')).toHaveText('Your game is ready')
  await expect(page.getByTestId('easy-play-it')).toHaveText('Play it')
  await expect(page.getByTestId('easy-open-browser')).toHaveText('Open in browser')
  await expect(page.getByTestId('easy-show-files')).toBeVisible()
  await expect(page.getByTestId('easy-open-it')).toHaveCount(0)
  await expect(page.getByTestId('easy-controls')).toHaveText(`Controls: ${GAME_CONTROLS}`)
  await expect(page.getByTestId('easy-done-explain').getByRole('heading', { level: 2 })).toHaveText(
    'How to play',
  )
  for (const c of GAME_CRITERIA) await expect(page.getByTestId('easy-done-can-do')).toContainText(c)
  await expect(page.getByTestId('easy-done-share')).toContainText('Anyone with the link can play.')
  expect(readFileSync(join(run.folder, 'index.html'), 'utf8')).toBe(GAME_HTML)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)

  // The plain questions carry the game clause; the summary was asked for How to play; the critic and the security
  // reviewer were given the Games pack's focus.
  expect(promptSent(e2e, 'explain-1.script.jsonl')).toContain('If it is a game, ask about playing it')
  expect(promptSent(e2e, 'explain-2.script.jsonl')).toContain('## How to play')
  const reviews = e2e
    .fakeLog()
    .filter((x) => x.kind === 'stdin')
    .map((x) => JSON.stringify(x))
  expect(reviews.some((t) => t.includes('No gambling or real money'))).toBe(true)

  // ---- Play it: the preview window, which takes the keyboard at once ----
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.getByTestId('easy-play-it').click()
  const game = await opened
  await game.waitForLoadState('load')
  await expect(page.getByTestId('easy-open-note')).toHaveText(
    'Opened in a preview window. Press F11 for full screen.',
  )
  const url = game.url()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  await expect
    .poll(() =>
      app.evaluate(
        ({ BrowserWindow }, u) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL() === u)
            ?.webContents.isFocused() ?? false,
        url,
      ),
    )
    .toBe(true)
  await expect(game.locator('#message')).toHaveText(
    'Press Space to start. Arrow keys steer. P or Esc pauses.',
  )
  // A real key press, no click first: the game starts.
  await game.keyboard.press('Space')
  await expect(game.locator('#message')).toHaveText('Eat the apples. Do not hit the walls or yourself.')
  await game.keyboard.press('KeyP')
  await expect(game.locator('#message')).toHaveText('Paused. Press P or Esc to carry on.')
  expect(e2e.pageErrors).toEqual([])
})
