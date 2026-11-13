// Easy mode end to end, on the fake Claude with an isolated home (the projects folder is beside the test's home,
// never a real Documents folder).
//  1. A new user is asked once, in the composer's place; Make something for me opens Easy's home. An idea becomes a
//     project on the confirm screen (kind, folder, no limit by default); Start makes the folder and runs it. The five
//     milestones are always there and never move; the plain questions and the plan (what it will be able to do) wait
//     for the user; the Done screen says it is ready, explains how to use it first, lists what it can do and opens it
//     in a preview window. Show details opens the same run in the Full Run view; the sidebar switch goes to Full there
//     and back to Easy's view of the same run; the project is in Easy's list.
//  2. A spending limit set on the confirm screen stops the run once a pass passes it ("It stopped at your $0.01
//     limit"); Continue with more starts a follow-up run in the same folder with the new limit; Stop asks first.
//  3. An existing user sees no change: no welcome card, the composer, Full control.
// No em dashes on any Easy screen.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { CRITERIA, EASY_CONFIG, easyScenario, ideaToConfirm, setCost, withCriteria } from './easy-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)

test('one-shot: idea, questions, plan, done with Explain and Open it; Easy and Full on the same run', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    newUser: true,
    scenario: easyScenario(),
    editScenario: withCriteria,
    config: EASY_CONFIG,
  })

  // ---- first launch: the question, in the composer's place, two choices of one width ----
  await expect(page.getByTestId('welcome-card')).toBeVisible()
  await expect(page.getByTestId('composer')).toHaveCount(0)
  const easyBox = await page.getByTestId('welcome-easy').boundingBox()
  const fullBox = await page.getByTestId('welcome-full').boundingBox()
  // Two equal grid columns (layout rounding aside).
  expect(Math.abs((easyBox?.width ?? 0) - (fullBox?.width ?? -1))).toBeLessThan(0.5)
  await page.getByTestId('welcome-easy').click()
  await expect(page).toHaveURL(/#\/easy$/)
  await expect(page.getByTestId('experience-easy')).toHaveAttribute('aria-checked', 'true')

  // ---- the idea and the confirm screen ----
  await expect(page.getByTestId('easy-next')).toBeDisabled()
  await ideaToConfirm(page)
  await expect(page.getByTestId('easy-kind')).toContainText('A document or guide')
  await expect(page.getByTestId('easy-folder')).toContainText('Dim Factory Projects')
  await expect(page.getByTestId('easy-folder')).toContainText('help-guide-customers')
  await expect(page.getByTestId('easy-limit-line')).toContainText('No spending limit')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await expect(page.getByTestId('easy-start')).toBeEnabled()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()

  // ---- five milestones, always there; nothing moves as the run goes on ----
  const rows = page.getByTestId('easy-milestones').getByRole('listitem')
  await expect(rows).toHaveCount(5)
  const before = await Promise.all([0, 1, 2, 3, 4].map((i) => rows.nth(i).boundingBox()))

  // ---- plain questions ----
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await expect(questions).toContainText('Who will read it?')
  await expect(page.getByTestId('easy-milestone-understand')).toHaveAttribute('data-state', 'needsYou')
  // While it waits for the user, the time line says so (not a countdown), and the questions are in view.
  await expect(page.getByTestId('easy-time')).toHaveText('Waiting for you')
  await expect(questions).toBeInViewport()
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  await expect(questions).toBeHidden()

  // ---- the plan, as what it will be able to do ----
  const plan = page.getByTestId('easy-card-plan')
  await expect(plan).toBeVisible({ timeout: 90_000 })
  for (const c of CRITERIA) await expect(plan.getByTestId('easy-plan-will-do')).toContainText(c)
  await plan.getByTestId('easy-build-it').click()
  await expect(plan).toBeHidden()
  const during = await Promise.all([0, 1, 2, 3, 4].map((i) => rows.nth(i).boundingBox()))
  expect(during).toEqual(before)

  // ---- done: ready, how to use it first, what it can do, open it ----
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  await expect(page.getByTestId('easy-done-title')).toHaveText('Your guide is ready')
  // The project's short title from the idea (not the folder's name).
  await expect(page.getByTestId('easy-done-project')).toHaveText(
    'Help guide for the customers of my knitting shop',
  )
  await expect(page.getByTestId('easy-explain-text')).toContainText('A small help guide for your shop')
  const canDo = page.getByTestId('easy-done-can-do')
  for (const c of CRITERIA) await expect(canDo).toContainText(c)
  await expect(canDo).toContainText('Works')
  await page.getByTestId('easy-open-it').click()
  await expect(page.getByTestId('easy-open-note')).toHaveText('Opened in a preview window.', {
    timeout: 30_000,
  })
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)

  // Clarify asked the plain questions (clarify-easy.md), on the run's own overrides layer.
  expect(promptSent(e2e, 'explain-1.script.jsonl')).toContain(
    'Someone who does not write code wants this made',
  )

  // ---- Easy and Full on the same run ----
  await page.getByTestId('easy-show-details').click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
  await expect(page.getByTestId('run-view')).toBeVisible()
  await page.getByTestId('experience-full').click()
  await expect(page.getByTestId('experience-full')).toHaveAttribute('aria-checked', 'true')
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
  await expect(page.getByTestId('nav-dashboard')).toBeVisible()
  await page.getByTestId('experience-easy').click()
  await expect(page).toHaveURL(new RegExp(`#/easy/runs/${run.runId}$`))
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await page.getByTestId('nav-easy-projects').click()
  await expect(page.getByTestId(`easy-project-${run.runId}`)).toContainText(
    'Help guide for the customers of my knitting shop',
  )
  expect(e2e.pageErrors).toEqual([])
})

test('a limit set on the confirm screen stops the run; Continue with more carries on in the same folder', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: easyScenario(),
    editScenario: (sc) => {
      withCriteria(sc)
      // Clarify (the first read-only haiku spawn) reports $0.50: over a $0.01 limit as soon as it ends.
      setCost(sc, 'explain-1.script.jsonl', 0.5)
    },
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
  })
  // Easy is the chosen mode: its home stands in for the Dashboard.
  await expect(page).toHaveURL(/#\/easy$/)
  await ideaToConfirm(page)
  await page.getByTestId('easy-limit').fill('0.01')
  await expect(page.getByTestId('easy-limit-line')).toContainText('$0.01')
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const first = await e2e.onlyRun()

  const ended = await e2e.waitForEnd(first.runId, 150_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('cancelled')
  const limits = await e2e.call('runs.limits', { runId: first.runId })
  expect(limits.limits).toEqual({ maxCostUsd: 0.01, maxMinutes: null })
  expect(limits.stop).toMatchObject({ kind: 'cost', limit: 0.01, costUsd: 0.5 })
  await expect(page.getByTestId('easy-done-title')).toHaveText('It stopped at your $0.01 limit')
  const more = page.getByTestId('easy-continue-more')
  await expect(more).toHaveText('Continue with $1 more')
  await more.click()
  await expect(page).not.toHaveURL(new RegExp(`#/easy/runs/${first.runId}$`))
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const list = await e2e.call('runs.list', {})
  expect(list.items).toHaveLength(2)
  const second = list.items.find((s) => s.runId !== first.runId)
  if (second === undefined) throw new Error('no follow-up run')
  expect(second.folder).toBe(first.folder)
  expect((await e2e.call('runs.limits', { runId: second.runId })).limits).toEqual({
    maxCostUsd: 1,
    maxMinutes: null,
  })

  // Stop asks first; what was made stays.
  await expect(page.getByTestId('easy-run')).toBeVisible()
  await page.getByTestId('easy-stop').click()
  await expect(page.getByTestId('easy-stop-dialog')).toBeVisible()
  await page.getByTestId('easy-stop-yes').click()
  const stopped = await e2e.waitForEnd(second.runId, 120_000)
  expect(stopped.status).toBe('cancelled')
  await expect(page.getByTestId('easy-done-title')).toHaveText('You stopped it')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('an existing user sees no change: no welcome card, the composer, Full control', async ({ e2e }) => {
  const page = await e2e.start()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('welcome-card')).toHaveCount(0)
  await expect(page.getByTestId('experience-full')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('nav-dashboard')).toBeVisible()
})
