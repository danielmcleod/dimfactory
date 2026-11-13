// "Fake `auth status` exit 1 → Run disabled → copy → Re-check enables
// Run" (live mode and cache invalidation; shell_copy): the fake Claude's `auth status` answers "not logged in"
// (exit 1). The composer's preflight strip shows the login blocker and Run is disabled with that reason. Its copy
// fix goes through recovery.execute, and main puts the command on the system clipboard (the developer's clipboard
// text is put back afterwards). The user "logs in" (the scenario's auth answer is swapped back), clicks [I ran it →
// Re-check] (a forced token-free probe, then the live check), and Run is enabled; the run then starts.
import { passArgvs } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { clipboardText, keepingClipboard, logOut } from './dashboard-helpers.ts'

test(
  'auth re-check: copy the login command, then Re-check enables Run',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    let login = (): void => {
      throw new Error('the scenario was not logged out')
    }
    const page = await e2e.start({
      scenario: { plan: { recording: 'C06-plan-native-host' } },
      editScenario: (sc) => {
        login = logOut(sc).login
      },
    })
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'login-needed')

    // ---- the composer: the login blocker in the strip, Run disabled with that reason ----
    const folder = page.getByTestId('composer-folder-input')
    await folder.fill(e2e.sandbox)
    await folder.press('Enter')
    await page.getByTestId('composer-task').fill('add a --version flag')
    const strip = page.getByTestId('preflight-strip')
    // The strip sums the checks up in one row; its chips open on the user's click (UI standard: core's answers never
    // shift the page on their own).
    await expect(strip.getByTestId('preflight-summary-text')).toContainText(
      '1 issue blocks the run: Claude Code is not logged in',
    )
    await strip.getByTestId('preflight-details').click()
    const chip = strip.getByTestId('preflight-chip-vendor.claude.auth')
    await expect(chip).toHaveAttribute('data-severity', 'blocking')
    await expect(chip).toContainText('Claude Code is not logged in')
    const run = page.getByTestId('composer-run')
    await expect(run).toBeDisabled()
    // One problem (the login, repeated by every pass that uses Claude): one chip, one reason, one issue.
    // Run keeps its label (it never changes size); what blocks it is the status beside it.
    await expect(run).toHaveText('Run')
    await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run')
    // The composer's own Run row: where opening the strip's details scrolled that row past the top (a taller
    // composer, macOS), the compact Run bar shows the same control too.
    await expect(
      page.getByTestId('composer-run-row').getByLabel('Fix 1 issue to run: Claude Code is not logged in'),
    ).toBeVisible()
    await expect(page.getByTestId('composer-checks-status')).toHaveText(
      'Checks: 1 issue blocks the run. Claude Code is not logged in.',
    )

    // ---- copy the login command: main writes it to the system clipboard ----
    await keepingClipboard(e2e, async () => {
      await chip.getByTestId('recovery-claude.login').click()
      await expect(page.getByText('Copied. Run it in a terminal.')).toBeVisible()
      expect(await clipboardText(e2e)).toBe('claude auth login')
    })

    // Still logged out: Re-check keeps Run disabled (and offers the copy again).
    await chip.getByTestId('recheck-claude.login').click()
    await expect(chip.getByTestId('recovery-claude.login')).toBeVisible()
    await expect(run).toBeDisabled()

    // ---- the user ran `claude auth login`; copy again → [I ran it → Re-check] → Run enabled ----
    login()
    await keepingClipboard(e2e, async () => {
      await chip.getByTestId('recovery-claude.login').click()
      await expect(chip.getByTestId('recheck-claude.login')).toBeVisible()
    })
    await chip.getByTestId('recheck-claude.login').click()
    await expect(run).toBeEnabled({ timeout: 30_000 })
    await expect(run).toHaveText('Run')
    await expect(page.getByTestId('composer-run-status')).toHaveText('')
    await expect(strip.getByTestId('preflight-chip-vendor.claude.auth')).toHaveCount(0)
    await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
    // Nothing but probes and auth checks ran so far.
    expect(passArgvs(e2e.fakeLog())).toEqual([])

    // ---- Run starts the run (the authoritative preflight agrees) ----
    await run.click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const created = await e2e.onlyRun()
    await expect(page.getByTestId('run-view')).toBeVisible()
    await e2e.call('runs.stop', { runId: created.runId })
    await e2e.waitForEnd(created.runId)
    expect(e2e.pageErrors).toEqual([])
  },
)
