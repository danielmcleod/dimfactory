// A grounding finding feeds Fix. The grounding checks are on for this test (the harness turns them off for
// the others, whose fake answers do not match the files they write). Implement writes version 0.1.0 and says "All
// tests pass"; the `test` verify command fails, so the grounding checks find the claim contradicted: a [must] from
// Grounding beside Verify's at the gate before Fix, with its chip and the Grounding filter. Fix gets both (its prompt
// lists the grounding finding), writes 1.0.0, verify:2 passes and the run reads Fixed.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import {
  CHECK_ARGV,
  CHECK_SCRIPT,
  findingsOf,
  trustCommand,
  verifyConfig,
  version,
  writeSandbox,
} from './verify-helpers.ts'

const CLAIM = "The AI said the tests pass, but Verify's `test` failed."

test('a contradicted claim becomes a [must] from Grounding and goes to Fix', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    grounding: true,
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: version('0.1.0'),
          text: 'Updated `src/version.ts`. All tests pass.',
        },
      ],
      resume: [
        { recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'Done.\n\nF1 fixed\nF2 fixed' },
      ],
    },
    config: verifyConfig([{ name: 'test', run: [...CHECK_ARGV] }], {
      gates: { afterPlan: true, beforeFix: true },
    }),
  })
  writeSandbox(e2e, { 'check.mjs': CHECK_SCRIPT })
  await trustCommand(e2e, CHECK_ARGV)

  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()

  // ---- the gate before Fix: Verify's [must] and Grounding's [must] ----
  const gate = page.getByTestId('card-gate:beforeFix')
  await expect(gate).toBeVisible({ timeout: 150_000 })
  const findings = await findingsOf(e2e, run.runId)
  const g = findings.find((f) => f.source === 'grounding')
  expect(g?.title).toBe(CLAIM)
  expect(g?.severity).toBe('must')
  await expect(gate.getByTestId(`finding-source-${g?.id ?? ''}`)).toHaveText('Grounding')
  const filter = gate.getByTestId('findings-filter-grounding')
  await expect(filter).toHaveText('Grounding 1')
  await filter.scrollIntoViewIfNeeded()
  const box = await filter.boundingBox()
  await filter.click()
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  // Selection is a background: the segment keeps its size and its place.
  const after = await filter.boundingBox()
  expect(after?.width ?? 0).toBeCloseTo(box?.width ?? -1, 1)
  expect(after?.height ?? 0).toBeCloseTo(box?.height ?? -1, 1)
  expect(after?.x ?? 0).toBeCloseTo(box?.x ?? -1, 1)
  await expect(gate.getByTestId(`finding-${g?.id ?? ''}`)).toBeVisible()
  await expect(gate).toContainText('Fix will receive 2 must · 0 should')
  await gate.getByTestId('card-choice-continue').click()
  await expect(gate).toBeHidden()

  // ---- Fix gets it; verify:2 passes; Fixed ----
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  const fix = promptSent(e2e, 'resume-1.script.jsonl')
  expect(fix).toContain(CLAIM)
  expect(e2e.pageErrors).toEqual([])
})
