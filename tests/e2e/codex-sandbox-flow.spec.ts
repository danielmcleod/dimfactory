// Flow ("set up the Codex sandbox from the chip"; the done-check: a tester who hasn't read the docs completes
// the flow using only in-app text; the mode row "Codex, Windows sandbox not ready" and vendor_setup; codex-sandbox.spec.ts). Windows
// only. Driven the way a tester would, by what
// the screen says: roles, names and visible text, never test ids. balanced puts Implement on Codex, whose Windows
// sandbox is not set up (the fake Codex answers readiness `notConfigured`). The tester picks a folder and types a task;
// Run says what to fix ("Fix 1 issue to run") and the check says Codex cannot run Implement; its details offer
// [Set up the Codex sandbox]. One click: the line beside it says it is setting the sandbox up, then the setup card says
// "Codex sandbox ready", the issue is gone and Run works. The run then goes through: Claude plans, Codex implements.
import { expect, test } from './harness.ts'
import { IS_WIN32, editPass, threadIdNow } from './codex-helpers.ts'

test('Flow: set up the Codex sandbox from the chip, using only in-app text', async ({ e2e }) => {
  test.skip(!IS_WIN32, 'the Codex Windows sandbox exists on Windows only')
  test.setTimeout(240_000)
  const thread = threadIdNow('flow')
  const page = await e2e.start({
    scenario: { plan: { recording: 'C06-plan-native-host' } },
    config: { profile: 'balanced' },
    codex: {
      sandbox: 'notConfigured',
      edit: editPass({
        threadId: thread,
        turnId: 'turn-flow',
        text: 'Added the --version flag.',
        write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        total: { input: 9_000, cached: 4_000, output: 700, reasoning: 200 },
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')

  // ---- the Dashboard: a folder and a task; Run says what is in the way ----
  const where = page.getByRole('textbox', { name: 'Folder', exact: true })
  await where.fill(e2e.sandbox)
  await where.press('Enter')
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('add a --version flag')
  // Reaching the setup button scrolls the composer's Run row out of view, and the bar that then shows over the top of
  // the page has the same Run: the tester presses the one at the top, which is the first of the two.
  const run = page.getByRole('button', { name: 'Run', exact: true }).first()
  await expect(page.getByText('Fix 1 issue to run', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(run).toBeDisabled()
  await expect(
    page.getByText(/1 issue blocks the run: Codex cannot run Implement in autoedit mode/),
  ).toBeVisible()

  // ---- the details offer the sandbox setup; one click ----
  await page.getByRole('button', { name: 'Show details', exact: true }).click()
  const issue = page.getByRole('listitem').filter({ hasText: 'Codex cannot run Implement in autoedit mode' })
  const setUp = issue.getByRole('button', { name: 'Set up the Codex sandbox' })
  await expect(setUp).toBeEnabled()
  await setUp.click()
  await expect(page.getByText(/^Setting up the Codex sandbox… \d+:\d\d$/).first()).toBeVisible()
  // (The fake's sandbox is set up once the setup has started: its next readiness answer is `ready`.)
  await fake.waitForRequest('windowsSandbox/setupStart')
  fake.set({ sandbox: 'ready' })

  // ---- the sandbox is ready, the issue is gone, Run works ----
  await expect(page.getByText('Codex sandbox ready', { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('Fix 1 issue to run', { exact: true })).toHaveCount(0)
  await expect(run).toBeEnabled({ timeout: 30_000 })
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)

  // ---- the run: Claude plans (approved at its gate), Codex implements, the reviewers find nothing ----
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await gate.getByRole('button', { name: 'Approve' }).click({ timeout: 90_000 })
  const runId = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  const end = await e2e.waitForEnd(runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  expect(fake.requests('windowsSandbox/setupStart')).toHaveLength(1)
  expect(fake.requests('thread/start')).toHaveLength(1)
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
