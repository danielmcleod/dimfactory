// Allow for this run hidden, the Gemini variant ("allowSession:false hides 'Allow for this run'"; the ACP
// decision table: allow-session takes the first allow_always in optionPrefs that is not forbidden and whose name does
// not match /future|all sessions|permanent/i, "If none qualifies, the ask was raised with allowSession:false"; Gemini
// optionPrefs.allowSession = proceed_always_tool, proceed_always, proceed_always_server, forbidden
// proceed_always_and_save; G06b). Implement runs on the fake Gemini (ACP over the npm shim) in a folder trusted for it;
// it asks to run `npm test` offering only "Allow for all future sessions" (the forbidden proceed_always_and_save), Allow
// and Reject. The ask reaches the user with allowSession:false: the panel has no "Allow for this run" and says why, ⇧A
// does nothing, and the desktop notification (recorded, never shown) offers only Allow once and Deny. A allows once:
// Gemini gets proceed_once, never the option that would save the approval into its own settings.
import { expect, test } from './harness.ts'
import { nextAsk, simulateFocus, waitForNotification } from './attention-helpers.ts'
import { FORBIDDEN_ONLY_OPTIONS, SHELL_HERE, editPass } from './gemini-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

test(
  'Gemini: an ask Gemini lets be allowed only for all future sessions hides "Allow for this run"',
  {
    tag: ['@cross-os'],
  },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: { plan: { recording: 'C06-plan-native-host' } },
      config: {
        gates: { afterPlan: false },
        passes: { implement: { vendor: 'gemini', model: null }, fix: { vendor: 'gemini', model: null } },
      },
      gemini: {
        edit: editPass({
          asks: [
            {
              toolCallId: 'run_shell_command-e2e-1',
              kind: 'execute',
              title: 'npm test',
              content: `${SHELL_HERE} (Run the test suite)`,
              options: FORBIDDEN_ONLY_OPTIONS,
              expect: 'proceed_once',
              after: 'completed',
              timeoutMs: 180_000,
            },
          ],
          write: VERSION_WRITE,
          text: 'Added the --version flag; the tests pass.',
          usage: { input: 11_264, cached: 6_144, output: 512, thought: 96 },
        }),
      },
    })
    const fake = e2e.gemini
    if (fake === null) throw new Error('no fake Gemini')
    await expect(page.getByTestId('vendor-health-gemini')).toHaveAttribute('data-health', 'ready', {
      timeout: 30_000,
    })
    // The folder is trusted for Gemini already (gemini-trust.spec.ts's grant, made here through core's own command).
    await e2e.call('trust.set', {
      folder: e2e.sandbox,
      grant: { kind: 'vendorFolder', vendor: 'gemini' },
      trusted: true,
    })
    const run = await e2e.runFromDashboard('add a --version flag')
    // Away from the window while the ask arrives: a desktop notification (recorded under E2E).
    await simulateFocus(e2e, false)

    const ask = page.getByTestId('ask-panel')
    const requestId = await nextAsk(page)
    await expect(ask).toContainText('npm test')
    const note = await waitForNotification(e2e, (n) => n.kind === 'ask' && n.requestId === requestId)
    expect(note.title).toMatch(/^Gemini needs approval/)
    if (process.platform === 'win32') expect(note.actions).toEqual(['Allow once', 'Deny'])
    else expect(note.actions).not.toContain('Allow for this run')
    await simulateFocus(e2e, true)

    // ---- core's ask, and the panel: Allow once and Deny, a note instead of Allow for this run ----
    const snap = await e2e.snapshot(run.runId)
    expect(snap.asks.find((a) => a.requestId === requestId)?.allowSession).toBe(false)
    await expect(ask.getByTestId('ask-allow')).toBeVisible()
    await expect(ask.getByTestId('ask-deny')).toBeVisible()
    await expect(ask.getByTestId('ask-allow-session')).toHaveCount(0)
    await expect(ask.getByTestId('ask-no-session')).toHaveText(
      'This tool cannot be allowed for the whole run',
    )
    await expect(ask.getByRole('button', { name: /Allow for this run/ })).toHaveCount(0)

    // ⇧A is not bound for this ask: the ask stays, Gemini gets no answer.
    await ask.focus()
    await page.keyboard.press('Shift+A')
    await page.waitForTimeout(1_000)
    await expect(ask).toHaveAttribute('data-request-id', requestId)
    await expect(ask.getByTestId('ask-allow')).toBeEnabled()
    expect(fake.permissionAnswers()).toEqual([])

    // ---- A: allowed once (proceed_once), never the option that saves the approval in Gemini's settings ----
    await page.keyboard.press('a')
    await expect(ask).toBeHidden()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    const implement = fake.pidOfMode('autoEdit')
    expect(fake.permissionAnswers()).toEqual([{ pid: implement, optionId: 'proceed_once' }])
    expect((await e2e.snapshot(run.runId)).allowRules).toEqual([])
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)
