// Easy's "Make two and pick", start to finish in the app on the fake Claude with an isolated home: the confirm
// screen's choice (One, or Two then pick) with what it means and costs, Start making the project and opening the page
// of both versions, the questions asked once (under the version that asks) and no plan to approve, both boxes keeping
// their place while the builds go on, the project folder untouched until one is kept, Open it on a version, Keep this
// one putting that version's files in the project and moving on to its Done screen, and the page afterwards saying
// which was kept. Then "Make a change" on that Done screen, made twice in the same way: the project stays as it is
// until one version of the change is kept. Only Claude is set up, so both versions are two tries of it; the page never
// says who built which.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { auditScreen } from './git-helpers.ts'
import { EASY_CONFIG, INDEX_HTML, QUESTIONS, ideaToConfirm } from './easy-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)

/** The second build's page: one more line, so the two versions differ. */
const SECOND_HTML = INDEX_HTML.replace('</body>', '<p>Second take.</p></body>')
/** The two versions of the change. */
const RETURNS_A = INDEX_HTML.replace('</body>', '<p>Returns within 30 days.</p></body>')
const RETURNS_B = INDEX_HTML.replace('</body>', '<p>Send it back within a month.</p></body>')

test('Make two and pick: two versions of one idea, the questions once, one kept; then a change made twice', async ({
  e2e,
}) => {
  test.setTimeout(600_000)
  const plan = { recording: 'C06-plan-native-host' }
  // After the first questions, every read-only pass on the default model gets "no questions": the builds run at the
  // same time, so it must not matter which of them takes which (a version's summary is then that text).
  const quiet = { recording: 'C02-review-shape', text: '{"questions": []}' }
  const page = await e2e.start({
    newUser: true,
    scenario: {
      plan: [plan, plan, plan, plan],
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: INDEX_HTML } },
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: SECOND_HTML } },
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: RETURNS_A } },
        { recording: 'C08a-session-id-implement', write: { path: 'index.html', content: RETURNS_B } },
      ],
      // The reviewers answer with no findings (the scenario's default): the two builds run at the same time, so a
      // scripted review could reach either of them.
      // Clarify asks once (the first version's run). A version's builder names no model, so these passes run on
      // Claude's own default.
      explainModel: null,
      explain: [
        { recording: 'C02-review-shape', text: JSON.stringify(QUESTIONS) },
        quiet,
        quiet,
        quiet,
        quiet,
        quiet,
      ],
    },
    config: EASY_CONFIG,
  })

  // ---- the confirm screen: one by default, two on the choice ----
  await page.getByTestId('welcome-easy').click()
  await ideaToConfirm(page)
  const choice = page.getByTestId('easy-two-choice')
  await expect(choice.getByRole('radio', { name: 'One', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByTestId('easy-two-line')).toHaveText('One version is made.')
  await expect(page.getByTestId('easy-two-cost')).toHaveCount(0)
  const choiceBox = await choice.boundingBox()
  await choice.getByRole('radio', { name: 'Two, then pick' }).click()
  await expect(choice.getByRole('radio', { name: 'Two, then pick' })).toHaveAttribute('aria-checked', 'true')
  // Only Claude is ready: the line does not promise two different builders.
  await expect(page.getByTestId('easy-two-line')).toHaveText(
    'Two versions are made, each in its own copy. You open both and keep one.',
  )
  await expect(page.getByTestId('easy-two-cost')).toContainText('Two cost about twice as much')
  await expect(page.getByTestId('easy-two-happens')).toContainText('the plan is not shown first')
  // The choice keeps its size whichever is chosen.
  expect(await choice.boundingBox()).toEqual(choiceBox)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await auditScreen(page, 'Easy confirm screen with two versions chosen')

  // ---- Start: the project is made and the page of both versions opens ----
  await expect(page.getByTestId('easy-start')).toBeEnabled()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/two\/[^/]+$/)
  const matchId = /#\/easy\/two\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  const two = page.getByTestId('easy-two')
  await expect(two).toBeVisible()
  await expect(page.getByTestId('easy-two-title')).toHaveText('Making two versions')
  const first = page.getByTestId('easy-two-version-0')
  const second = page.getByTestId('easy-two-version-1')
  await expect(first.getByRole('heading')).toHaveText('First version')
  await expect(second.getByRole('heading')).toHaveText('Second version')
  await expect(first.getByTestId('easy-two-keep')).toBeDisabled()
  await expect(second.getByTestId('easy-two-keep')).toBeDisabled()
  await expect(page.getByTestId('easy-two-neither')).toBeDisabled()
  const before = [await first.boundingBox(), await second.boundingBox()]
  const folder = (await e2e.call('easy.projects'))[0]?.folder ?? ''
  expect(folder).not.toBe('')

  // ---- the questions, asked once, under the version that asks ----
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await expect(questions).toContainText('Who will read it?')
  await expect(page.getByTestId('easy-needs-version')).toHaveText(/^For the (first|second) version$/)
  await expect(two).toHaveAttribute('data-status', 'needsYou')
  await expect(page.getByTestId('easy-two-status')).toHaveText('Something below needs your answer.')
  await auditScreen(page, 'Easy two versions page with the questions')
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  await expect(questions).toBeHidden()

  // ---- both build; no plan to approve, no keep-or-throw-away card, and the boxes do not move ----
  await expect(two).toHaveAttribute('data-status', 'ready', { timeout: 300_000 })
  await expect(page.getByTestId('easy-card-plan')).toHaveCount(0)
  await expect(page.getByTestId('easy-card-finalize')).toHaveCount(0)
  await expect(page.getByTestId('easy-card-questions')).toHaveCount(0)
  await expect(page.getByTestId('easy-two-title')).toHaveText('Pick the one you like')
  await expect(page.getByTestId('easy-two-status')).toHaveText(
    'Both are ready. Open each one, then keep the one you like.',
  )
  await expect(first).toHaveAttribute('data-state', 'ready')
  await expect(second).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('easy-stop')).toBeDisabled()
  expect([await first.boundingBox(), await second.boundingBox()]).toEqual(before)
  // Who built which is never said.
  expect(await two.innerText()).not.toMatch(/claude|codex/i)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await auditScreen(page, 'Easy two versions page with both ready')

  // The match is an ordinary one with its names hidden; the project folder has nothing of either version yet.
  const match = await e2e.call('matches.get', { matchId })
  expect(match).toMatchObject({ kind: 'headToHead', ready: true, shared: true })
  expect(match.blind?.revealedAt).toBeUndefined()
  expect(match.sides.map((s) => s.contestant.vendor)).toEqual(['claude', 'claude'])
  expect(existsSync(join(folder, 'index.html'))).toBe(false)

  // ---- open a version, then keep the first one shown ----
  await first.getByTestId('easy-two-open').click()
  await expect(first.getByTestId('easy-two-note')).toHaveText('Opened in a preview window.', {
    timeout: 60_000,
  })
  await first.getByTestId('easy-two-keep').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/, { timeout: 60_000 })
  const keptRun = /#\/easy\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  await expect(page.getByTestId('easy-done-title')).toHaveText('Your guide is ready', { timeout: 60_000 })
  const made = readFileSync(join(folder, 'index.html'), 'utf8')
  expect([INDEX_HTML, SECOND_HTML]).toContain(made)
  const after = await e2e.call('matches.get', { matchId })
  expect(after.pick?.side).toBe(after.kept)
  expect(after.sides.find((s) => s.side === after.kept)?.runId).toBe(keptRun)

  // ---- the page of both versions afterwards: which was kept, nothing more to keep ----
  await page.goto(page.url().replace(/#.*$/, `#/easy/two/${matchId}`))
  await expect(page.getByTestId('easy-two-status')).toHaveText(
    'You kept the first version. It is in your project now.',
  )
  await expect(first).toHaveAttribute('data-state', 'kept')
  await expect(second).toHaveAttribute('data-state', 'notKept')
  await expect(first.getByTestId('easy-two-keep')).toBeDisabled()
  await expect(second.getByTestId('easy-two-keep')).toBeDisabled()
  expect(await two.innerText()).not.toMatch(/claude|codex/i)
  await auditScreen(page, 'Easy two versions page after a pick')
  await page.getByTestId('easy-two-go-project').click()
  await expect(page).toHaveURL(new RegExp(`#/easy/runs/${keptRun}$`))

  // ---- Make a change, twice: the choice is in the change box of the Done screen ----
  const change = page.getByTestId('easy-done-change')
  const changeChoice = change.getByTestId('easy-change-two-choice')
  await expect(changeChoice.getByRole('radio', { name: 'One', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(change.getByTestId('easy-change-two-line')).toHaveText('One version is made.')
  // How far the button is below the choice (the page may scroll when the choice is clicked).
  const below = async (): Promise<number> =>
    ((await change.getByTestId('easy-make-change').boundingBox())?.y ?? 0) -
    ((await changeChoice.boundingBox())?.y ?? 0)
  const gap = await below()
  await changeChoice.getByRole('radio', { name: 'Two, then pick' }).click()
  await expect(change.getByTestId('easy-change-two-line')).toContainText(
    'The change is made twice, each in its own copy of your project.',
  )
  // Choosing moves nothing below it.
  expect(await below()).toBe(gap)
  await change.getByTestId('easy-change-text').fill('Add a line about returns')
  await expect(change.getByTestId('easy-make-change')).toBeEnabled({ timeout: 60_000 })
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await auditScreen(page, 'Easy Done screen with a change to be made twice')
  await change.getByTestId('easy-make-change').click()
  await expect(page).toHaveURL(/#\/easy\/two\/[^/]+$/)
  const changeMatch = /#\/easy\/two\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  expect(changeMatch).not.toBe(matchId)
  await expect(two).toHaveAttribute('data-match-id', changeMatch)
  await expect(two).toHaveAttribute('data-status', 'ready', { timeout: 300_000 })
  await expect(page.getByTestId('easy-card-plan')).toHaveCount(0)
  // The project is as it was: neither version of the change is in it.
  expect(readFileSync(join(folder, 'index.html'), 'utf8')).toBe(made)
  const changeView = await e2e.call('matches.get', { matchId: changeMatch })
  expect(changeView.task).toContain('Add a line about returns')
  expect(changeView.blind?.revealedAt).toBeUndefined()

  // ---- keep the second one shown ----
  await second.getByTestId('easy-two-keep').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/, { timeout: 60_000 })
  await expect(page.getByTestId('easy-done-title')).toBeVisible({ timeout: 60_000 })
  expect([RETURNS_A, RETURNS_B]).toContain(readFileSync(join(folder, 'index.html'), 'utf8'))
  expect(e2e.pageErrors).toEqual([])
})
