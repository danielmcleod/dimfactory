// Auth snag, the Codex variant ("Auth snag: copy login → Re-check → retry succeeds"; failure category auth_expired
// "X `unauthorized` while logged in · shell_copy re-login · switch_vendor", X
// codexErrorInfo; the shell_copy executor "Copies through the main-process clipboard, then shows I ran it → Re-check";
// "switch_vendor … renders disabled until a second vendor is ready", live now). balanced: Codex Implement's turn
// fails with codexErrorInfo `unauthorized`. The snag says Codex needs a new login, with the `codex login` command
// first and "use Claude" enabled (Claude is ready). Copying puts `codex login` on the system clipboard; while
// `codex login status` still says "Not logged in", Re-check says so; once the user logged in, Re-check finds Codex
// ready, and Retry runs Implement again in a new thread: it succeeds.
import { expect, test } from './harness.ts'
import { clipboardText, keepingClipboard } from './dashboard-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { auditBothSizes, expectSteadyWidth, trackWidth } from './git-helpers.ts'
import { snagCard } from './recovery-helpers.ts'
import { editPass, failedPass, threadIdNow } from './codex-helpers.ts'

test('Codex: an expired Codex login; copy codex login, Re-check, then Retry succeeds', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: { plan: { recording: 'C06-plan-native-host' } },
    config: { profile: 'balanced', gates: { afterPlan: false, beforeFix: false } },
    codex: {
      edit: failedPass({
        threadId: threadIdNow('e08a'),
        turnId: 'turn-e08-a',
        message: 'Your access token could not be refreshed. Please log out and sign in again.',
        codexErrorInfo: 'unauthorized',
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the snag: what failed, the login command first, "use Claude" live ----
  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'auth_expired')
  await expect(snag).toContainText('Codex login expired')
  const copy = snag.getByTestId('recovery-implement:login')
  await expect(copy).toHaveText('Copy login command')
  await expect(snag.getByText('codex login', { exact: true })).toBeVisible()
  // A second vendor is ready now: switching renders enabled.
  const sw = snag.getByTestId('recovery-implement:switch')
  await expect(sw).toBeEnabled()
  await expect(sw).toContainText('Claude')
  await auditBothSizes(e2e, page, 'Run view with the Codex auth snag')

  // The user really is logged out now: `codex login status` says so until they log in.
  fake.set({ login: 'out' })
  const copyId = (await copy.getAttribute('data-testid')) ?? ''
  const recheck = snag.getByTestId(copyId.replace(/^recovery-/, 'recheck-'))
  await trackWidth(page, 'login', `[data-testid="${copyId}"]`)
  await keepingClipboard(e2e, async () => {
    await copy.click()
    await expect(toasts(page).filter({ hasText: 'Copied. Run it in a terminal.' })).toHaveCount(1)
    expect(await clipboardText(e2e)).toBe('codex login')
    await expect(recheck).toHaveText('I ran it → Re-check')
    // Still logged out: Re-check says so.
    await recheck.click()
    await expect(toasts(page).filter({ hasText: /^Codex: Login needed/ })).not.toHaveCount(0)
    await expect(copy).toBeVisible()

    // ---- the user ran `codex login`: Re-check finds Codex ready ----
    fake.set({
      login: 'in',
      edit: editPass({
        threadId: threadIdNow('e08b'),
        turnId: 'turn-e08-b',
        text: 'Added the --version flag.',
        write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        total: { input: 9_000, cached: 4_000, output: 700, reasoning: 200 },
      }),
    })
    await copy.click()
    await expect(recheck).toBeVisible()
    await recheck.click()
    await expect(toasts(page).filter({ hasText: /^Codex: Ready/ })).not.toHaveCount(0)
  })
  await expectSteadyWidth(page, 'login', 'The snag copy button')

  // ---- Retry → Implement runs again (a new thread) and the run completes ----
  await snag.getByTestId('recovery-implement:retry').click()
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.implement).toMatchObject({ status: 'done', attempt: 2, vendor: 'codex' })
  expect(fake.requests('thread/start')).toHaveLength(2)
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
