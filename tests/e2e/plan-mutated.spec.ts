// Plan wrote a file (the plan-end guard: the tree ≠ run-start and Plan reported an edit/write/shell
// tool → planMutated [Revert Plan's changes] [Keep]; Cards; state-machine row R4). Plan, which should only read, writes
// a file (CRLF bytes). Before the plan gate core shows the planMutated card with the file, and waits: it has no default
// (Auto never answers it) and Implement does not start. [Revert Plan's changes] → the file is gone, the toast says what
// was reverted, the plan gate opens → Approve → the run completes without the file, Implement without a "changed
// during planning" chip → After the run keeps the revert's Undo, which brings Plan's file back byte for byte.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { fakeProcs, toasts } from './attention-helpers.ts'
import { auditBothSizes, expectSteadyWidth, trackWidth } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

const PLAN_FILE = { path: 'PLAN-NOTES.md', content: 'Plan should not have written this.\r\n' }

test("Plan wrote a file: planMutated card, Revert Plan's changes, the run goes on", async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host', write: PLAN_FILE },
      implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
    },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const target = join(e2e.sandbox, PLAN_FILE.path)

  // ---- the planMutated card: the file, core's choices, no default; Implement waits ----
  const card = page.getByTestId('card-planMutated')
  await expect(card).toBeVisible({ timeout: 90_000 })
  expect(readFileSync(target, 'utf8')).toBe(PLAN_FILE.content)
  await expect(card.getByRole('heading')).toHaveText('Plan changed files')
  await expect(card).toContainText('The Plan step should only read, but 1 file changed while it ran')
  await expect(card.getByTestId('plan-mutated-paths')).toContainText('Changed while Plan ran (1 file)')
  await expect(card.getByTestId('plan-mutated-paths-path')).toHaveText([PLAN_FILE.path])
  await expect(card.locator('button[data-testid^="card-choice-"]')).toHaveText([
    "Revert Plan's changes",
    'Keep',
  ])
  const snap = await e2e.snapshot(run.runId)
  expect(snap.cards.find((c) => c.kind === 'planMutated')?.defaultChoice).toBeUndefined()
  expect(snap.steps.implement.status).toBe('queued')
  await expect(page.getByTestId('card-gate:afterPlan')).toHaveCount(0)
  expect(fakeProcs(e2e).some((p) => p.script.startsWith('implement-'))).toBe(false)
  await auditBothSizes(e2e, page, 'Run view with the planMutated card')

  // ---- [Revert Plan's changes] → the file is gone → the plan gate ----
  await trackWidth(page, 'revert-plan', '[data-testid="card-choice-revert-plan"]')
  await card.getByTestId('card-choice-revert-plan').click()
  await expect(card).toBeHidden()
  await expectSteadyWidth(page, 'revert-plan', "Revert Plan's changes")
  await expect.poll(() => existsSync(target)).toBe(false)
  await expect(toasts(page).filter({ hasText: "Reverted Plan's changes" })).toHaveCount(1)
  await e2e.approvePlan()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(existsSync(target)).toBe(false)
  expect(readFileSync(join(e2e.sandbox, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  // The reverted file was Dim Factory's own write, not an edit "during planning".
  await expect(page.getByTestId('step-chip-implement')).toHaveCount(0)

  // ---- the revert stays undoable after the run: Plan's bytes come back ----
  const undoLine = page.getByTestId('run-end-revert-undo')
  await expect(undoLine).toContainText("Reverted Plan's changes (1 file). You can undo that.")
  await undoLine.getByTestId('run-end-undo').click()
  await expect(toasts(page).filter({ hasText: "Revert undone: Plan's changes are back" })).toHaveCount(1)
  await expect(undoLine).toBeHidden()
  expect(readFileSync(target).equals(Buffer.from(PLAN_FILE.content, 'utf8'))).toBe(true)

  expect(e2e.pageErrors).toEqual([])
})
