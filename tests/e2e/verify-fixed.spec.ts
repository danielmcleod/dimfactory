// Verify → Fix → fixed ("failing verify → [must] → Fix → pass → fixed"; verify
// results "A failing command becomes [must] `cmd` failed (exit N, Ts) with the excerpt, source:'verify'"; the Fix
// skip rule; state-machine rows R6/R7/R8/R11; VerifyCard, gate:beforeFix). A real node script is the verify command in the
// temp sandbox: it passes only once src/version.ts names 1.0.0. Implement writes 0.1.0, so verify:1 fails; its [must]
// reaches the gate before Fix (the reviewers found nothing) with a "Verify" chip; Fix writes 1.0.0, verify:2 passes
// and the run reads Fixed. The prompts carry {{verify}}: the reviewers saw the FAIL with its excerpt, Fix got F1.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import {
  CHECK_ARGV,
  CHECK_COMMAND,
  CHECK_SCRIPT,
  findingsOf,
  showExcerpt,
  showOutput,
  trustCommand,
  verifyConfig,
  verifyFlow,
  writeSandbox,
} from './verify-helpers.ts'

test('a failing verify becomes a [must], Fix fixes it, verify:2 passes: Fixed', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: verifyFlow('1.0.0'),
    config: verifyConfig([CHECK_COMMAND], { gates: { afterPlan: true, beforeFix: true } }),
  })
  writeSandbox(e2e, { 'check.mjs': CHECK_SCRIPT })
  await trustCommand(e2e, CHECK_ARGV)

  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()

  // ---- verify:1: the command fails; its card lists it with the exit code and the failure's excerpt ----
  const card = page.getByTestId('pass-card-verify:1')
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 120_000 })
  const row = card.getByTestId('verify-command-verify:1-0')
  await expect(row).toHaveAttribute('data-status', 'fail')
  await expect(row.getByTestId('verify-command-verify:1-0-status')).toContainText('Failed')
  await expect(row.getByTestId('verify-command-verify:1-0-facts')).toContainText('exit 1')
  await expect(row).toContainText('node check.mjs')
  await expect(card.getByTestId('verify-summary-verify:1')).toHaveText('1 failed')
  // The failure's excerpt and the round's output (core's log, served as runs.output verify:1).
  await expect(await showExcerpt(card, 'verify:1', 0)).toContainText(
    'expected version 1.0.0, got export const version = "0.1.0"',
  )
  const output = await showOutput(card, 'verify:1')
  await expect(output).toContainText('$ node check.mjs')
  await expect(output).toContainText('expected version 1.0.0')

  // ---- the gate before Fix: F1 [must] from Verify ----
  const gate = page.getByTestId('card-gate:beforeFix')
  await expect(gate).toBeVisible({ timeout: 120_000 })
  const findings = await findingsOf(e2e, run.runId)
  const f1 = findings.find((f) => f.n === 1)
  expect(findings.map((f) => [f.n, f.severity, f.source])).toEqual([[1, 'must', 'verify']])
  expect(f1?.title).toMatch(/^`node check\.mjs` failed \(exit 1, \d+s\)$/)
  await expect(gate.getByTestId(`finding-source-${f1?.id ?? ''}`)).toHaveText('Verify')
  await expect(gate).toContainText('node check.mjs')
  await expect(gate).toContainText('Fix will receive 1 must · 0 should')
  await gate.getByTestId('card-choice-continue').click()
  await expect(gate).toBeHidden()

  // ---- Fix → verify:2 passes → Fixed ----
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  expect(ended.findings).toEqual({ must: 1, should: 0 })
  await expect(page.getByTestId('run-outcome')).toHaveText('Fixed · 1 must · 0 should')
  for (const step of ['verify:1', 'verify:2', 'fix'] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')
  const final = page.getByTestId('pass-card-verify:2')
  await expect(final.getByTestId('verify-command-verify:2-0')).toHaveAttribute('data-status', 'pass')
  await expect(final.getByTestId('verify-summary-verify:2')).toHaveText('1 passed')

  // ---- {{verify}}: the reviewers saw verify:1's FAIL and its excerpt; Fix got F1 (verify) ----
  const review = promptSent(e2e, 'review-default.script.jsonl')
  expect(review).toContain('- FAIL `node check.mjs` (exit 1, ')
  expect(review).toContain('expected version 1.0.0')
  const fix = promptSent(e2e, 'resume-1.script.jsonl')
  expect(fix).toMatch(/- \[must\] F1 \(verify\) `node check\.mjs` failed \(exit 1, \d+s\)/)

  // ---- the Dashboard's Recent row ----
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`recent-outcome-${run.runId}`)).toHaveText('Fixed · 1 must · 0 should')
  expect(e2e.pageErrors).toEqual([])
})
