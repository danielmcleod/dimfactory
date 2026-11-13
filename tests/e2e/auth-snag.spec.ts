// Auth snag ("Auth snag: copy login → Re-check → retry succeeds"; failure category auth_required; the
// shell_copy executor "Copies through the main-process clipboard, then shows I ran it → Re-check"; the snag card). Plan
// starts while Claude is logged in, then the CLI answers "Not logged in" (the C09b recording): the snag reads "Claude
// needs you to log in" with [Copy login command] first. Copying puts `claude auth login` on the system clipboard
// (the developer's clipboard is put back afterwards) and the same button turns into [I ran it → Re-check]. While the
// fake's `auth status` still answers "not logged in", Re-check says so; once the user "logs in" (the fake's auth answer
// is swapped back), Re-check finds Claude ready, and Retry runs Plan again: it succeeds and the plan gate opens. The
// copy button keeps its width through Copy, I ran it → Re-check and Checking…; switch_vendor renders disabled (no
// second vendor is ready in this build); the card passes the UI standards audit at both window sizes.
import { expect, test } from './harness.ts'
import { clipboardText, keepingClipboard, logOut } from './dashboard-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { auditBothSizes, expectSteadyWidth, trackWidth } from './git-helpers.ts'
import { planArgvs, snagCard } from './recovery-helpers.ts'

test('auth snag: copy the login command, log in, Re-check, then Retry succeeds', async ({ e2e }) => {
  const page = await e2e.start({
    scenario: { plan: [{ recording: 'C09b-logged-out' }, { recording: 'C06-plan-native-host' }] },
  })
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the snag: what failed, and the login command first ----
  const snag = snagCard(page, 'plan')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'auth_required')
  await expect(snag).toContainText('Claude needs you to log in')
  const copy = snag.getByTestId('recovery-plan:login')
  await expect(copy).toHaveText('Copy login command')
  await expect(snag.getByText('claude auth login', { exact: true })).toBeVisible()
  // No second vendor is ready in this build: the switch renders disabled.
  await expect(snag.getByTestId('recovery-plan:switch')).toBeDisabled()
  await expect(snag.getByTestId('recovery-plan:retry')).toBeEnabled()
  await expect(snag.getByTestId('recovery-run:close')).toBeVisible()
  await auditBothSizes(e2e, page, 'Run view with the auth snag')

  // The user really is logged out now: the fake's `auth status` answers so until they log in.
  const sc = e2e.scenario
  if (sc === null) throw new Error('no scenario')
  const { login } = logOut(sc)

  await trackWidth(page, 'login', '[data-testid="snag-plan"] [data-kind="shell_copy"]')
  await keepingClipboard(e2e, async () => {
    // ---- copy → main's clipboard; the same button reads [I ran it → Re-check] ----
    await copy.click()
    await expect(toasts(page).filter({ hasText: 'Copied. Run it in a terminal.' })).toHaveCount(1)
    expect(await clipboardText(e2e)).toBe('claude auth login')
    const recheck = snag.getByTestId('recheck-plan:login')
    await expect(recheck).toHaveText('I ran it → Re-check')

    // Still logged out: Re-check says so, and the copy is offered again.
    await recheck.click()
    await expect(toasts(page).filter({ hasText: 'Claude: Login needed' })).not.toHaveCount(0)
    await expect(copy).toBeVisible()

    // ---- the user ran `claude auth login`: copy again → Re-check finds Claude ready ----
    await copy.click()
    await expect(recheck).toBeVisible()
    login()
    await recheck.click()
    await expect(toasts(page).filter({ hasText: 'Claude: Ready' })).not.toHaveCount(0)
    await expect(copy).toBeVisible()
  })
  await expectSteadyWidth(page, 'login', 'The snag copy button')

  // ---- Retry → Plan runs again and succeeds ----
  await snag.getByTestId('recovery-plan:retry').click()
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveCount(0)
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan).toMatchObject({ status: 'done', attempt: 2 })
  expect(planArgvs(e2e)).toHaveLength(2)

  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})
