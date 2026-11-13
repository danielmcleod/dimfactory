// Easy mode's third phase end to end, on the fake Claude with an isolated home (new projects go beside the
// test's home, never a real Documents folder; the folder the user "already has" is the test's own sandbox):
//  1. A folder with commits: "Work on something I already have" picks it, says it works on a copy, and the run ends with
//     "Your changes are ready". Keep these changes puts them in the folder; Undo (the apply's own) takes them out.
//  2. The same, then Throw them away: confirmed first, undoable for a few seconds, then the copy is gone and the folder
//     never changed.
//  3. A folder that is no repository: Start waits for "Turn on undo for this folder" (git init); the run works in place,
//     an install there asks (an existing folder never gets the project permission), and Undo everything is offered.
//  4. A vague idea: "Did you mean a website or an app?" with plain choices; nothing is asked of a model until the user
//     presses Help me choose, which asks once, read only; the user still picks.
//  5. The overnight list: two ideas, each a new project, made one after another from Start now.
// No em dashes on any of these screens.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { rewriteAsks } from '../integration/easy/asks.ts'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { advanceClock } from './attention-helpers.ts'
import { EASY_CONFIG, SUMMARY } from './easy-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)
const NO_QUESTIONS = { recording: 'C02-review-shape', text: JSON.stringify({ questions: [] }) }
const SUMMARY_ENTRY = { recording: 'C02-review-shape', text: SUMMARY }
const CONTACT = {
  path: 'contact.html',
  content: '<!doctype html><title>Contact</title><h1>Contact us</h1>\n',
}

/** Easy chosen, no plan check (Phase 1's), Clarify and Explain on haiku, no install in an isolated copy. */
const CONFIG = {
  ...EASY_CONFIG,
  ui: { experience: 'easy' },
  easy: { skipPlanCheck: true },
  isolation: { worktree: { install: 'never' } },
}

/** Easy's home: Work on something I already have (the picker answers the sandbox), its screen, the change, Start. */
async function workOnSandbox(e2e: E2EHarness, page: Page, mode: 'isolated' | 'needsUndo'): Promise<string> {
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-work-existing').click()
  await expect(page).toHaveURL(/#\/easy\/existing\?folder=/)
  await expect(page.getByTestId('easy-existing-mode')).toHaveAttribute('data-mode', mode)
  await expect(page.getByTestId('easy-existing-name')).toHaveText('ts-small')
  await page.getByTestId('easy-existing-change').fill('Add a contact page')
  if (mode === 'needsUndo') {
    await expect(page.getByTestId('easy-existing-start')).toBeDisabled()
    await page.getByTestId('easy-existing-undo').click()
  }
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await page.getByTestId('easy-existing-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  return (await e2e.onlyRun()).runId
}

/** The project's own checks (npm test) ask on the plain trust card: skipped here. */
async function skipChecks(page: Page): Promise<void> {
  const trust = page.getByTestId('easy-card-trust')
  await expect(trust).toBeVisible({ timeout: 120_000 })
  await trust.getByTestId('card-choice-skip').click()
}

async function noPermission(e2e: E2EHarness): Promise<void> {
  const p = await e2e.call('easy.permission', { folder: e2e.sandbox })
  expect(p.granted).toBe(false)
  expect(await e2e.call('easy.permissions')).toEqual([])
}

test('a folder with commits: a copy, then Keep these changes; Undo takes them out again', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: CONTACT }],
      explain: [NO_QUESTIONS, SUMMARY_ENTRY],
    },
    config: CONFIG,
    pickSandbox: true,
  })
  const runId = await workOnSandbox(e2e, page, 'isolated')
  await expect(page.getByTestId('easy-existing-mode')).toHaveCount(0)
  await skipChecks(page)

  // ---- "Your changes are ready": nothing is in the folder yet ----
  const card = page.getByTestId('easy-card-finalize')
  await expect(card).toBeVisible({ timeout: 180_000 })
  await expect(card).toContainText('Your folder has not changed yet.')
  await expect(card).not.toContainText('Keep for later')
  expect(existsSync(join(e2e.sandbox, CONTACT.path))).toBe(false)
  const run = await e2e.snapshot(runId)
  expect(run.summary.isolation).toBe('worktree')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await card.getByTestId('easy-keep-changes').click()

  const ended = await e2e.waitForEnd(runId, 120_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const changes = page.getByTestId('easy-done-changes')
  await expect(changes.getByTestId('easy-changes-state')).toHaveText('Kept: 1 file changed in your folder.', {
    timeout: 60_000,
  })
  expect(readFileSync(join(e2e.sandbox, CONTACT.path), 'utf8')).toBe(CONTACT.content)
  await expect(page.getByTestId('easy-done-undo')).toHaveCount(0)

  // ---- the apply's own undo ----
  await changes.getByTestId('easy-changes-undo-apply').click()
  await expect.poll(() => existsSync(join(e2e.sandbox, CONTACT.path)), { timeout: 60_000 }).toBe(false)
  await noPermission(e2e)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('a folder with commits: Throw them away is confirmed, undoable, then the copy is gone', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: CONTACT }],
      explain: [NO_QUESTIONS, SUMMARY_ENTRY],
    },
    config: CONFIG,
    pickSandbox: true,
  })
  const runId = await workOnSandbox(e2e, page, 'isolated')
  await skipChecks(page)
  const card = page.getByTestId('easy-card-finalize')
  await expect(card).toBeVisible({ timeout: 180_000 })

  // ---- a plain confirmation first; "Keep them for now" changes nothing ----
  await card.getByTestId('easy-throw-away').click()
  const dialog = page.getByTestId('easy-throw-dialog')
  await expect(dialog).toContainText('Throw these changes away?')
  await page.getByTestId('easy-throw-no').click()
  await expect(dialog).toHaveCount(0)
  await expect(card).toBeVisible()
  await card.getByTestId('easy-throw-away').click()
  await page.getByTestId('easy-throw-yes').click()

  // ---- undoable for a few seconds, then deleted ----
  const state = page.getByTestId('easy-changes-state')
  await expect(state).toHaveAttribute('data-state', 'discarding', { timeout: 30_000 })
  await expect(state).toHaveText('Thrown away. You can still undo this for a few seconds.')
  await expect(page.getByTestId('easy-changes-undo-discard')).toBeVisible()
  await advanceClock(e2e, 11_000)
  const ended = await e2e.waitForEnd(runId, 60_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('easy-done-changes').getByTestId('easy-changes-state')).toHaveText(
    'Thrown away. Your folder is as it was.',
  )
  expect(existsSync(join(e2e.sandbox, CONTACT.path))).toBe(false)
  expect(ended.worktree?.notApplied ?? false).toBe(false)
  await noPermission(e2e)
  expect(e2e.pageErrors).toEqual([])
})

test('a folder that is no repository: undo turned on first, in place, an install asks, Undo everything', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    git: false,
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: CONTACT }],
      explain: [NO_QUESTIONS, SUMMARY_ENTRY],
    },
    editScenario: (sc) =>
      rewriteAsks(join(sc.dir, 'implement-1.script.jsonl'), [
        { tool: 'Bash', input: { command: 'npm install' } },
        { tool: 'Bash', input: { command: 'npm run build' } },
      ]),
    config: CONFIG,
    pickSandbox: true,
  })
  expect(existsSync(join(e2e.sandbox, '.git'))).toBe(false)
  const runId = await workOnSandbox(e2e, page, 'needsUndo')
  // "Turn on undo for this folder": git init, before the run.
  expect(existsSync(join(e2e.sandbox, '.git'))).toBe(true)
  expect((await e2e.snapshot(runId)).summary.isolation).toBe('inPlace')

  // ---- the install asks: an existing folder never has the project permission ----
  const ask = page.getByTestId('easy-ask')
  await expect(ask).toBeVisible({ timeout: 120_000 })
  await expect(ask).toContainText('npm install')
  await expect(page.getByTestId('easy-permission-uses')).toHaveText('')
  await noPermission(e2e)
  await ask.getByTestId('easy-ask-allow').click()
  // The project's own script asks too.
  await expect(ask).toContainText('run the project', { timeout: 60_000 })
  await ask.getByTestId('easy-ask-allow').click()
  await skipChecks(page)

  const ended = await e2e.waitForEnd(runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await expect(page.getByTestId('easy-done-changes')).toHaveCount(0)
  await expect(page.getByTestId('easy-undo-all')).toBeEnabled({ timeout: 60_000 })
  expect(readFileSync(join(e2e.sandbox, CONTACT.path), 'utf8')).toBe(CONTACT.content)
  const trust = join(e2e.home, 'trust.json')
  if (existsSync(trust)) expect(readFileSync(trust, 'utf8')).not.toContain('easyProject')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('a vague idea: plain choices with no model call; Help me choose asks once, read only, on the click', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const intent = '```json\n{"kind":"website","reason":"It is about pages people visit."}\n```'
  const page = await e2e.start({
    scenario: { explain: [{ recording: 'C02-review-shape', text: intent }] },
    config: CONFIG,
  })
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill('Something for my bakery')
  await page.getByTestId('easy-next').click()
  const q = page.getByTestId('easy-did-you-mean')
  await expect(q).toBeVisible()
  await expect(q.getByRole('heading')).toHaveText('Did you mean a website or an app?')
  await expect(page.getByTestId('easy-start')).toBeDisabled()
  await expect(page.getByTestId('easy-help-choose-cost')).toContainText('Sends your idea to Claude')
  // Nothing has asked a model yet.
  const readOnlyCalls = (): number =>
    e2e
      .fakeLog()
      .filter(
        (x) => x.kind === 'start' && Array.isArray(x['argv']) && x['argv'].includes('--permission-prompts'),
      ).length
  expect(readOnlyCalls()).toBe(0)

  await page.getByTestId('easy-help-choose').click()
  await expect(page.getByTestId('easy-help-choose-note')).toHaveText(
    'Suggested: A website. It is about pages people visit.',
    { timeout: 60_000 },
  )
  expect(readOnlyCalls()).toBe(1)
  // Still the user's pick.
  await expect(page.getByTestId('easy-start')).toBeDisabled()
  await q.getByTestId('easy-meant-website').click()
  await expect(page.getByTestId('easy-did-you-mean')).toHaveCount(0)
  await expect(page.getByTestId('easy-kind')).toContainText('A website')
  await expect(page.getByTestId('easy-start')).toBeEnabled()
  expect(readOnlyCalls()).toBe(1)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('the overnight list: two ideas, two new projects, made one after another', async ({ e2e }) => {
  test.setTimeout(400_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'docs/index.md', content: '# Help\n' },
          delayMs: 1500,
        },
        // A checklist is the plain printable page now (its page-load check opens checklist.html).
        {
          recording: 'C08a-session-id-implement',
          write: {
            path: 'checklist.html',
            content: '<!doctype html><html lang="en"><title>Opening</title><h1>Opening</h1></html>\n',
          },
        },
      ],
      explain: [SUMMARY_ENTRY, SUMMARY_ENTRY],
    },
    config: CONFIG,
  })
  await page.getByTestId('nav-easy-overnight').click()
  await expect(page.getByTestId('easy-overnight')).toBeVisible()
  await expect(page.getByTestId('easy-overnight-empty')).toBeVisible()
  for (const idea of [
    'A help guide for the customers of my knitting shop: how to order and how shipping works.',
    'A checklist for opening my cafe each morning, step by step.',
  ]) {
    await page.getByTestId('easy-overnight-idea').fill(idea)
    await page.getByTestId('easy-overnight-add').click()
    await expect(page.getByTestId('easy-overnight-idea')).toHaveValue('')
  }
  const items = page.getByTestId('easy-overnight-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText('A document or guide')
  await expect(items.nth(1)).toContainText('A checklist or how-to')
  // Added, not started: each is a new, empty project folder with nothing run yet.
  expect((await e2e.call('runs.list', {})).items).toEqual([])
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)

  await page.getByTestId('easy-overnight-run').click()
  await expect(page.getByTestId('easy-overnight-state')).toHaveText('Making them one after another.')
  // One after another: the second waits while the first is made.
  await expect(items.nth(0)).toHaveAttribute('data-status', 'running', { timeout: 60_000 })
  await expect(items.nth(1)).toHaveAttribute('data-status', 'pending')
  expect((await e2e.call('runs.list', {})).items).toHaveLength(1)

  await expect(items.nth(0)).toHaveAttribute('data-status', 'done', { timeout: 180_000 })
  await expect(items.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 180_000 })
  const runs = (await e2e.call('runs.list', {})).items
  expect(runs).toHaveLength(2)
  // Each in its own new folder, with Easy's recipe, nobody asked anything.
  expect(new Set(runs.map((r) => r.folder)).size).toBe(2)
  for (const r of runs) expect(r.status, e2e.describeRun(r)).toBe('completed')
  const queue = await e2e.call('queue.get')
  const tasks = queue.folders.flatMap((f) => f.tasks).filter((t) => t.easy !== undefined)
  expect(tasks).toHaveLength(2)
  for (const t of tasks)
    expect(t.easy?.overrides).toMatchObject({
      auto: false,
      gates: { afterPlan: false },
      passes: { plan: { clarify: false, research: false } },
    })
  await expect(page.getByTestId('easy-overnight-state')).toHaveText(
    'Everything on the list has been made. Open each one to see it.',
  )
  await items.nth(0).getByTestId('easy-overnight-open').click()
  await expect(page).toHaveURL(/#\/easy\/runs\//)
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  expect(e2e.pageErrors).toEqual([])
})
