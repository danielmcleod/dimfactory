// Allow for this run hidden (AttentionPanel; "Allow for this run is omitted when the ask has
// allowSession:false"): Claude marks the ask `suppress_always_allow_rule` (the recorded C03 PowerShell ask, marked by
// the scenario), so core's ask has allowSession:false. The panel has no "Allow for this run" and says why, ⇧A does
// nothing, and the desktop notification (recorded, never shown) offers only Allow once and Deny. A allows once.
import { expect, test } from './harness.ts'
import {
  fakeProc,
  nextAsk,
  permissionAnswers,
  simulateFocus,
  suppressAllowRule,
  waitForNotification,
} from './attention-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

test('allowSession:false hides "Allow for this run"', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C03-accept-edits', write: VERSION_WRITE }],
    },
    editScenario: (sc) => suppressAllowRule(sc, 'implement-1'),
    config: { gates: { afterPlan: false } },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  // Away from the window while the ask arrives: a desktop notification (recorded under E2E).
  await simulateFocus(e2e, false)

  const ask = page.getByTestId('ask-panel')
  const requestId = await nextAsk(page)
  await expect(ask).toContainText('PowerShell')
  const note = await waitForNotification(e2e, (n) => n.kind === 'ask' && n.requestId === requestId)
  expect(note.title).toBe('Claude needs approval · ts-small')
  if (process.platform === 'win32') expect(note.actions).toEqual(['Allow once', 'Deny'])
  else expect(note.actions).not.toContain('Allow for this run')
  await simulateFocus(e2e, true)

  // ---- the panel: Allow once and Deny, a note instead of Allow for this run ----
  await expect(ask.getByTestId('ask-allow')).toBeVisible()
  await expect(ask.getByTestId('ask-deny')).toBeVisible()
  await expect(ask.getByTestId('ask-allow-session')).toHaveCount(0)
  await expect(ask.getByTestId('ask-no-session')).toHaveText('This tool cannot be allowed for the whole run')
  await expect(ask.getByRole('button', { name: /Allow for this run/ })).toHaveCount(0)

  // ⇧A is not bound for this ask: the ask stays, nothing reaches the vendor.
  await ask.focus()
  await page.keyboard.press('Shift+A')
  await page.waitForTimeout(1_000)
  await expect(ask).toHaveAttribute('data-request-id', requestId)
  await expect(ask.getByTestId('ask-allow')).toBeEnabled()
  expect(permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))).toEqual([])

  // ---- A: allowed once ----
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const answers = permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))
  expect(answers).toEqual([expect.objectContaining({ behavior: 'allow' })])
  expect(answers[0]?.updatedPermissions).toBeUndefined()
  expect((await e2e.snapshot(run.runId)).allowRules).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
