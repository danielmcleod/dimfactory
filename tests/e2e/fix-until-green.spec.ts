// Fix until green end to end, on the fake Claude in the temp sandbox with a real verify command. The
// composer's "Fix until green" switch turns the loop on (up to 3 rounds) and moves nothing. Implement leaves the
// version wrong (verify fails) and Review reports two [must]s; round 1's Fix resolves the reviewers' findings (its
// re-check, on Review's model, confirms them) but not the version; round 2's Fix (continuing round 1's session) fixes
// the version; verify passes and the run reads Fixed. In the Run view round 1 runs in the usual Fix, Final verify and
// Re-check cards (they keep round 1 once round 2 starts), round 1's verdict follows them, then round 2's section (its
// heading, its own cards with a "Round 2 of 3" chip, its verdict) and the stop line are appended: nothing above moves.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import {
  CHECK_ARGV,
  CHECK_COMMAND,
  CHECK_SCRIPT,
  trustCommand,
  verifyConfig,
  version,
  writeSandbox,
} from './verify-helpers.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

test('the check still fails after round 1; round 2 makes it green', async ({ e2e }) => {
  test.setTimeout(360_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
      resume: [
        { recording: 'C08b-resume-fix', write: version('0.2.0'), text: 'F1 fixed\nF2 fixed\nF3 fixed' },
        { recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'F5 fixed' },
      ],
      review: [
        { recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS },
        { recording: 'C02-review-shape', text: 'F1 resolved\nF2 resolved' },
      ],
    },
    config: verifyConfig([CHECK_COMMAND], { gates: { afterPlan: false, beforeFix: false } }),
  })
  writeSandbox(e2e, { 'check.mjs': CHECK_SCRIPT })
  await trustCommand(e2e, CHECK_ARGV)

  // ---- the composer: "Fix until green" is off; turning it on moves nothing ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const toggle = page.getByTestId('composer-fix-loop')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const note = page.getByTestId('composer-fix-loop-note')
  const noteText = await note.textContent()
  const box = await note.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(await note.textContent()).toBe(noteText)
  expect((await note.boundingBox())?.y).toBe(box?.y)
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()

  // ---- round 1: its verdict appears once the round is over, below round 1's Re-check card ----
  const rounds = page.getByTestId('fix-rounds')
  await expect(rounds.getByTestId('fix-round-1')).toBeVisible({ timeout: 200_000 })
  await expect(rounds.getByTestId('fix-round-1-verify')).toContainText('Still failing: check')
  await expect(rounds.getByTestId('fix-round-1-resolved')).toContainText('F1, F2 resolved')
  await expect(rounds.getByTestId('fix-round-1-open')).toContainText('F5 still open')
  // Everything later is appended: round 1's verdict stays where it was while round 2 runs and after.
  const row1 = await rounds.getByTestId('fix-round-1').boundingBox()
  const fix1 = page.getByTestId('pass-card-fix')
  await expect(fix1.getByTestId('round-chip-fix')).toContainText('Round 1 of 3')
  const recheck1 = await page.getByTestId('pass-card-recheck').getByTestId('recheck-line').textContent()
  // Round 1's cards keep their size when round 2 begins (their frozen views read as the live steps did).
  const heights = async (): Promise<(number | undefined)[]> =>
    Promise.all(
      ['pass-card-fix', 'pass-card-verify:2', 'pass-card-recheck'].map(
        async (id) => (await page.getByTestId(id).boundingBox())?.height,
      ),
    )
  const heights1 = await heights()

  // ---- round 2 → green → Fixed ----
  const ended = await e2e.waitForEnd(run.runId, 200_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  expect(ended.fixLoop).toEqual({ rounds: 2, max: 3, stop: 'green' })
  // Round 2's section, after round 1's verdict: its heading, its own Fix card, its verdict.
  const round2 = page.getByTestId('fix-round-section-2')
  await expect(round2.getByTestId('fix-round-2-heading')).toHaveText('Round 2 of 3')
  await expect(round2.getByTestId('pass-card-fix-round-2')).toContainText('Round 2 of 3')
  await expect(round2.getByTestId('fix-round-2')).toBeVisible()
  await expect(round2.getByTestId('fix-round-2-verify')).toContainText('Passed')
  expect(await heights()).toEqual(heights1)
  expect((await rounds.getByTestId('fix-round-1').boundingBox())?.y).toBe(row1?.y)
  // Round 1's cards still show round 1.
  await expect(fix1.getByTestId('round-chip-fix')).toContainText('Round 1 of 3')
  await expect(page.getByTestId('pass-card-recheck').getByTestId('recheck-line')).toHaveText(recheck1 ?? '')
  // The stop line comes last.
  const stop = page.getByTestId('fix-rounds-stop')
  await expect(stop).toContainText('green after round 2')
  const stopBox = await stop.boundingBox()
  const round2Box = await round2.boundingBox()
  expect((stopBox?.y ?? 0) > (round2Box?.y ?? 0)).toBe(true)
  await expect(page.getByTestId('run-outcome')).toContainText('Fixed')
  for (const step of ['fix', 'verify:2'] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')

  // Round 2's Fix continued round 1's session and got only what was still open.
  const fix2 = promptSent(e2e, 'resume-2.script.jsonl')
  expect(fix2).toContain('Fix until green, round 2 of 3')
  expect(fix2).toMatch(/F5 \(verify\)/)
  expect(fix2).not.toMatch(/F1 \(review\)/)
  // Round 1's re-check read the reviewers' [must]s.
  expect(promptSent(e2e, 'review-2.script.jsonl')).toContain('You are re-checking a fix')
  expect(await page.locator('body').innerText()).not.toContain('\u2014')

  // ---- the Diff tab: a segment per round, each its own round's change ----
  const files = await e2e.call('diff.files', { runId: run.runId, seg: 'fix-round-1' })
  expect(files.available).toEqual(['implement', 'fix', 'fix-round-1', 'fix-round-2', 'combined'])
  expect(files.files.map((f) => f.path)).toEqual(['src/version.ts'])
  const round2Files = await e2e.call('diff.files', { runId: run.runId, seg: 'fix-round-2' })
  expect(round2Files.files.map((f) => f.path)).toEqual(['src/version.ts'])
  await page.getByTestId('run-tab-diff').click()
  const segs = page.getByTestId('diff-segments').getByRole('radio')
  await expect(segs).toHaveText(['Implement', 'Fix', 'Fix round 1', 'Fix round 2', 'Combined'])
  await page.getByTestId('diff-segments').getByRole('radio', { name: 'Fix round 2', exact: true }).click()
  await expect(
    page.getByTestId('diff-segments').getByRole('radio', { name: 'Fix round 2', exact: true }),
  ).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('diff-summary')).toContainText('1 file changed')
  expect(e2e.pageErrors).toEqual([])
})
