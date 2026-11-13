// Beginners, part B end to end, on the fake Claude with an isolated home (projects beside the test's home,
// never a real Documents folder; no network):
//  a. The summary's Things to fill in is listed in its own section on Done, and How to use no longer has it.
//  b. A step by step checklist for a cafe starts from the printable checklist; only server words make a runbook.
//  c. Make a change runs the change recipe with the folder's saved Brief and the security advisor on: the secret scan
//     runs, and the reviewer is skipped when nothing sensitive changed.
//  d. A report from data: Share it says who can see its figures, and the upload file leaves data/*.csv out until the
//     user includes them.
//  e. A run whose Plan fails because Claude is signed out ends on Done with one plain line, the sign-in command, one
//     recovery button and Carry on, which starts a new run in the same folder that finishes.
//  f. Make a change says about what it costs a moment after typing stops; a small change plans on a lighter model with
//     no Critic.
//  g. A report from data with no file says it will use example numbers, with Add files.
//  h. The project history: going back to before a change takes it out of the folder, and the message's Undo puts it back.
// No em dashes on these screens.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { IDEA } from './easy-helpers.ts'
import {
  CONFIG,
  DATA_IDEA,
  EM_DASH,
  FILL_INS,
  FILL_IN_SUMMARY,
  GUIDE_INDEX,
  NO_QUESTIONS,
  PLAIN_SUMMARY,
  PLAN,
  REPORT_IMPLEMENT,
  RETURNS,
  at,
  firstRun,
  makeChange,
  runFile,
  runInUrl,
  toConfirm,
} from './beginner-helpers.ts'

const CHANGE_IMPLEMENT = { recording: 'C08a-session-id-implement', write: RETURNS }

test('(a) Things to fill in are listed on Done, apart from How to use', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: PLAN,
      implement: [GUIDE_INDEX],
      explain: [NO_QUESTIONS, { recording: 'C02-review-shape', text: FILL_IN_SUMMARY }],
    },
    config: CONFIG,
  })
  await firstRun(e2e, page, IDEA)
  const section = page.getByTestId('easy-done-fill-ins')
  await expect(section.getByRole('heading', { level: 2 })).toHaveText('Things to fill in')
  await expect(page.getByTestId('easy-fill-ins').getByRole('listitem')).toHaveText(FILL_INS)
  const how = page.getByTestId('easy-explain-text')
  await expect(how).toContainText('A small help guide for your shop')
  await expect(how).toContainText('Double-click index.html.')
  await expect(how).not.toContainText('Things to fill in')
  await expect(how).not.toContainText('phone number')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('(b) a cafe checklist starts from the printable checklist; server words make a runbook', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start({ config: CONFIG })
  await toConfirm(page, 'A step by step checklist for opening my cafe each morning')
  await expect(page.getByTestId('easy-confirm-kind')).toContainText(
    'Starts from: Checklist (print or tick on screen).',
  )
  await expect(page.getByTestId('easy-confirm-kind')).not.toContainText('Runbook')
  const cafe = await e2e.call('easy.resolve', {
    idea: 'A step by step checklist for opening my cafe each morning',
  })
  expect(cafe.kind).toBe('checklist')
  expect(cafe.template.id).toBe('checklist')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)

  const server = await e2e.call('easy.resolve', {
    idea: 'A step by step checklist for deploying our web server and rolling back',
  })
  expect(server.kind).toBe('checklist')
  expect(server.template.id).toBe('runbook')
  await page.getByTestId('easy-back').click()
  await toConfirm(page, 'A step by step checklist for deploying our web server and rolling back')
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Starts from: Runbook.')
  expect(e2e.pageErrors).toEqual([])
})

test('(c) Make a change keeps the saved Brief, runs the secret scan, skips the reviewer', async ({ e2e }) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: [PLAN, PLAN],
      implement: [GUIDE_INDEX, CHANGE_IMPLEMENT],
      explain: [NO_QUESTIONS, PLAIN_SUMMARY, NO_QUESTIONS, PLAIN_SUMMARY],
    },
    config: CONFIG,
  })
  const first = await firstRun(e2e, page, IDEA)
  const brief1 = at(runFile(e2e, first.runId, 'resolved.json'), 'brief')
  expect(brief1, 'the first run had a Brief').toBeTruthy()

  // Not small (a new page), nothing sensitive in its words.
  const second = await makeChange(page, first.runId, 'Add a page about returning yarn')
  const ended = await e2e.waitForEnd(second, 300_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.folder).toBe(first.folder)
  expect(readFileSync(join(first.folder, ...RETURNS.path.split('/')), 'utf8')).toBe(RETURNS.content)

  // The change recipe, with the folder's saved Brief.
  const resolved = runFile(e2e, second, 'resolved.json')
  const brief2 = at(resolved, 'brief')
  expect(brief2, 'the change run carries the saved Brief').toBeTruthy()
  expect(at(brief2, 'category')).toBe(at(brief1, 'category'))
  expect(JSON.stringify(resolved)).toContain('easy-change')
  // The security advisor on, its reviewer kept for sensitive changes.
  const security = at(resolved, 'config', 'passes', 'security')
  expect(at(security, 'enabled')).toBe(true)
  expect(at(security, 'review')).toBe('sensitive')
  const state = at(runFile(e2e, second, 'run.json'), 'state')
  expect(at(state, 'config', 'passes', 'security', 'review')).toBe('sensitive')
  expect(at(state, 'steps', 'scan', 'status')).toBe('done')
  expect(at(state, 'steps', 'security', 'status')).toBe('skipped')
  // The snapshot says why the reviewer did not run.
  const snap = await e2e.snapshot(second)
  expect(snap.steps.scan.status).toBe('done')
  expect(snap.steps.security.status).toBe('skipped')
  expect(JSON.stringify(snap.steps.security)).toContain('not needed: no keys or personal data changed')
  await expect(page.getByTestId('easy-done-title')).toBeVisible({ timeout: 60_000 })
  expect(e2e.pageErrors).toEqual([])
})

test('(d) a report from data: Share it says who sees it; the upload file leaves data/*.csv out', async ({
  e2e,
}) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: PLAN,
      implement: [REPORT_IMPLEMENT],
      explain: [NO_QUESTIONS, PLAIN_SUMMARY],
    },
    config: CONFIG,
  })
  const run = await firstRun(e2e, page, DATA_IDEA)
  expect(existsSync(join(run.folder, 'data', 'sample.csv'))).toBe(true)
  const share = page.getByTestId('easy-done-share')
  await expect(share.getByTestId('easy-share-data')).toHaveText(
    'This report shows figures from your data: anyone with the link can see them. The upload file leaves your data files out unless you include them.',
  )
  await share.getByTestId('deploy-toggle').click()
  await expect(page.getByTestId('deploy-upload')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  await page.getByTestId('deploy-upload-make').click()
  await expect(page.getByTestId('deploy-upload-status')).toHaveAttribute('data-state', 'made', {
    timeout: 60_000,
  })
  const data = page.getByTestId('deploy-upload-data')
  await expect(data).toContainText('data/sample.csv')
  await expect(page.getByTestId('deploy-upload-data-included')).toHaveCount(0)
  const include = page.getByTestId('deploy-upload-include-data')
  await include.click()
  await expect(page.getByTestId('deploy-upload-data-included')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deploy-upload-data')).toHaveCount(0)
  expect(await share.innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('(e) signed out: one plain line, the sign-in command, one recovery button, then Carry on', async ({
  e2e,
}) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C09b-logged-out' }, PLAN],
      implement: [GUIDE_INDEX],
      explain: [NO_QUESTIONS, NO_QUESTIONS, PLAIN_SUMMARY],
    },
    config: CONFIG,
  })
  await toConfirm(page, IDEA)
  await page.getByTestId('easy-start').click()
  const run = await e2e.onlyRun()
  const ended = await e2e.waitForEnd(run.runId, 240_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('failed')

  await expect(page.getByTestId('easy-done-title')).toHaveText('It did not finish', { timeout: 60_000 })
  const failed = page.getByTestId('easy-failed')
  await expect(failed).toHaveAttribute('data-category', 'auth_required')
  await expect(page.getByTestId('easy-failure-line')).toHaveText(
    'You are signed out of Claude. Sign in again (the command is below), then press Carry on.',
  )
  await expect(page.getByTestId('easy-sign-in')).toContainText('claude auth login')
  const actions = page.getByTestId('easy-failed-actions')
  await expect(actions.locator('[data-testid^="recovery-"]')).toHaveCount(1, { timeout: 30_000 })
  const carry = page.getByTestId('easy-carry-on')
  await expect(carry).toHaveText('Carry on')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)

  await carry.click()
  const next = await runInUrl(page, run.runId)
  await expect(page.getByTestId('easy-run').or(page.getByTestId('easy-done'))).toBeVisible()
  // The new run must get the folder: the failed run (its snag still open) has to let go of it.
  await e2e.waitForSummary(next, (s) => s.status !== 'queued', 60_000)
  const done = await e2e.waitForEnd(next, 300_000)
  expect(done.status, e2e.describeRun(done)).toBe('completed')
  expect(done.folder).toBe(run.folder)
  await expect(page.getByTestId('easy-done-title')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('easy-failed')).toHaveCount(0)
})

test('(f) Make a change says what it costs before the click; a small change is lighter', async ({ e2e }) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: [PLAN, PLAN],
      implement: [GUIDE_INDEX, GUIDE_INDEX],
      explain: [NO_QUESTIONS, PLAIN_SUMMARY],
    },
    config: CONFIG,
  })
  const first = await firstRun(e2e, page, IDEA)
  const line = page.getByTestId('easy-change-estimate')
  await expect(line).toHaveText('')
  const height = (await line.boundingBox())?.height
  await page.getByTestId('easy-change-text').fill('Make the buttons bigger')
  await expect(line).toHaveText(/A small change, so it uses a lighter model\.$/, { timeout: 10_000 })
  const text = await line.innerText()
  expect(text.length).toBeGreaterThan('A small change, so it uses a lighter model.'.length)
  expect((await line.boundingBox())?.height).toBe(height)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)

  // The small change runs Plan on Sonnet, with no Critic; the scan is on.
  await page.getByTestId('easy-make-change').click()
  const second = await runInUrl(page, first.runId)
  await expect.poll(() => existsSync(join(e2e.home, 'runs', second, 'resolved.json'))).toBe(true)
  const passes = at(runFile(e2e, second, 'resolved.json'), 'config', 'passes')
  expect(at(passes, 'plan', 'model')).toBe('sonnet')
  expect(at(passes, 'critic', 'enabled')).toBe(false)
  expect(at(passes, 'security', 'enabled')).toBe(true)
  expect(at(passes, 'security', 'review')).toBe('sensitive')
  await e2e.call('runs.stop', { runId: second })
  await e2e.waitForEnd(second, 120_000)
})

test('(g) a report from data with no file says it uses example numbers, with Add files', async ({ e2e }) => {
  test.setTimeout(180_000)
  const page = await e2e.start({ config: CONFIG })
  await toConfirm(page, DATA_IDEA)
  await expect(page.getByTestId('easy-no-data-line')).toHaveText(
    'No data file added: it will use example numbers.',
  )
  await expect(page.getByTestId('easy-confirm-add-files')).toBeVisible()
  await expect(page.getByTestId('easy-start')).toBeEnabled()
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('(h) the project history: back to before a change, then Undo', async ({ e2e }) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: [PLAN, PLAN],
      implement: [GUIDE_INDEX, CHANGE_IMPLEMENT],
      explain: [NO_QUESTIONS, PLAIN_SUMMARY, NO_QUESTIONS, PLAIN_SUMMARY],
    },
    config: CONFIG,
  })
  const first = await firstRun(e2e, page, IDEA)
  const second = await makeChange(page, first.runId, 'Add a page about returning yarn')
  const ended = await e2e.waitForEnd(second, 300_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const returns = join(first.folder, ...RETURNS.path.split('/'))
  expect(existsSync(returns)).toBe(true)

  await expect(page.getByTestId('easy-done-title')).toBeVisible({ timeout: 60_000 })
  const rows = page.getByTestId('easy-done-history').getByTestId('easy-history-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-run-id', second)
  await expect(rows.nth(1)).toHaveAttribute('data-run-id', first.runId)
  const back = rows.nth(0).getByTestId('easy-history-back')
  await expect(back).toHaveText('Go back to before this')
  await expect(back).toBeEnabled({ timeout: 60_000 })
  const width = (await back.boundingBox())?.width
  await back.click()
  await expect.poll(() => existsSync(returns), { timeout: 60_000 }).toBe(false)
  // The first run's page is still there.
  expect(existsSync(join(first.folder, 'index.html'))).toBe(true)
  expect((await back.boundingBox())?.width).toBe(width)

  const toast = toasts(page).filter({ has: page.getByRole('button', { name: 'Undo' }) })
  await expect(toast).toHaveCount(1, { timeout: 30_000 })
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => existsSync(returns), { timeout: 60_000 }).toBe(true)
  expect(readFileSync(returns, 'utf8')).toBe(RETURNS.content)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})
