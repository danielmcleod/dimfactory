// Verify fails again after Fix ("failing again → Completed with failures"; verify:2
// runs after Fix, and a failure there makes the outcome verify-failed; state-machine row R11; Recent runs'
// outcome strings; stop.spec.ts's "Re-run from Fix offered"). The node-script check fails after Implement (0.1.0)
// and still fails after Fix (0.2.0): the run completes as "Completed with failures", verify:2's failure is listed after
// Fix (round 2, not sent to Fix), the timeline marks the failing round, and the Re-run menu offers Re-run from Fix
// (live, saying whether Fix would continue the Implement session).
import { expect, test } from './harness.ts'
import {
  CHECK_ARGV,
  CHECK_COMMAND,
  CHECK_SCRIPT,
  findingsOf,
  showExcerpt,
  trustCommand,
  verifyConfig,
  verifyFlow,
  writeSandbox,
} from './verify-helpers.ts'

test('verify still fails after Fix: Completed with failures, Re-run from Fix offered', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: verifyFlow('0.2.0'),
    config: verifyConfig([CHECK_COMMAND], { gates: { afterPlan: false, beforeFix: false } }),
  })
  writeSandbox(e2e, { 'check.mjs': CHECK_SCRIPT })
  await trustCommand(e2e, CHECK_ARGV)

  const run = await e2e.runFromDashboard('add a --version flag')
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('verify-failed')
  expect(ended.findings).toEqual({ must: 2, should: 0 })

  // ---- the Run view: the outcome, the failing final round, core's note ----
  await expect(page.getByTestId('run-outcome')).toHaveText('Completed with failures')
  await expect(page.getByTestId('run-status')).toContainText(/completed/i)
  const final = page.getByTestId('pass-card-verify:2')
  await expect(final).toHaveAttribute('data-status', 'done')
  await expect(final.getByTestId('verify-command-verify:2-0')).toHaveAttribute('data-status', 'fail')
  await expect(final.getByTestId('verify-summary-verify:2')).toHaveText('1 failed')
  await expect(await showExcerpt(final, 'verify:2', 0)).toContainText(
    'expected version 1.0.0, got export const version = "0.2.0"',
  )
  // A finished round with a failing command reads as a failure in the timeline (its node's border), and its tooltip
  // lists the results.
  const node = page.getByTestId('timeline-node-verify:2')
  await expect(node).toHaveAttribute('data-status', 'done')
  await expect(node).toHaveClass(/border-st-failed/)
  await node.hover()
  await expect(page.getByRole('tooltip')).toContainText('Commands: 1 failed')
  await page.mouse.move(0, 0)
  await expect(page.getByTestId('run-view')).toContainText(
    'Completed with failures: check still fails after Fix.',
  )

  // verify:1's finding went to Fix; verify:2's is listed after it (round 2), not sent to Fix.
  const findings = await findingsOf(e2e, run.runId)
  expect(findings.map((f) => [f.n, f.severity, f.source, f.round])).toEqual([
    [1, 'must', 'verify', 1],
    [2, 'must', 'verify', 2],
  ])

  // ---- Re-run ▾ → Re-run from Fix is offered (live, with what its Fix would do) ----
  await page.getByTestId('rerun-menu').click()
  const fromFix = page.getByTestId('rerun-from-fix')
  await expect(fromFix).toBeVisible()
  await expect(fromFix).toContainText('Re-run from Fix')
  await expect(fromFix).not.toHaveAttribute('aria-disabled', 'true')
  await expect(fromFix).toContainText('Fix would continue the Implement session')
  await page.keyboard.press('Escape')

  // ---- the Dashboard's Recent row ----
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`recent-outcome-${run.runId}`)).toHaveText('Completed with failures')
  expect(e2e.pageErrors).toEqual([])
})
