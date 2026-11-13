// A merge in progress ("merge-in-progress → block + copyable abort"; reconciliation:
// a merge in progress or unmerged paths → block: [Recheck] [Stop], plus copyable `git <op> --abort`; state-machine row R5).
// The sandbox is left in a conflicted merge. The live preflight only warns (in place, no run branch), so the run
// starts; at the pre-Implement boundary core blocks with a reconcile card: why, the copyable `git merge --abort`, and
// no default (Auto never answers a block). Implement does not start. The user copies the command (it reaches the
// clipboard through recovery.execute), runs it (the test does), presses [I ran it → Re-check] on the same button, and
// the run goes on to completion. The card passes the UI standards audit.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { clipboardText, keepingClipboard } from './dashboard-helpers.ts'
import { fakeProcs } from './attention-helpers.ts'
import { auditBothSizes, expectSteadyWidth, gitOut, mergeInConflict, trackWidth } from './git-helpers.ts'
import { CLEAN_FLOW, VERSION_WRITE } from './scenarios.ts'

test('a merge in progress blocks the run with a copyable abort until Recheck', async ({ e2e }) => {
  const page = await e2e.start({ scenario: CLEAN_FLOW, config: { gates: { afterPlan: false } } })
  mergeInConflict(e2e.sandbox)
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the block card at the pre-Implement boundary ----
  const card = page.getByTestId('card-reconcile')
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(card.getByRole('heading')).toHaveText('A git merge is in progress (and 1 more)')
  await expect(card.getByTestId('reconcile-lead')).toHaveText(
    'Dim Factory checked the folder before Implement.',
  )
  const op = card.getByTestId('reconcile-reason-operation')
  await expect(op).toHaveAttribute('data-severity', 'block')
  await expect(op).toContainText('Finish or abort the merge, then recheck.')
  await expect(op.locator('code')).toHaveText(['git merge --abort'])
  await expect(card.getByTestId('reconcile-reason-unmerged')).toContainText('src/index.ts')
  await expect(card.locator('button[data-testid^="card-choice-"]')).toHaveText(['Recheck', 'Stop run'])
  const snap = await e2e.snapshot(run.runId)
  expect(snap.cards.find((c) => c.kind === 'reconcile')?.defaultChoice).toBeUndefined()
  // Implement waits on the card (it does not read running, nor count the wait as its time); nothing spawned.
  expect(snap.steps.implement).toMatchObject({ status: 'waiting', reason: 'folder check' })
  expect(fakeProcs(e2e).some((p) => p.script.startsWith('implement-'))).toBe(false)
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'waiting')
  await auditBothSizes(e2e, page, 'Run view with the merge block card')

  // ---- Copy → the user runs it → [I ran it → Re-check] on the same button, which keeps its size ----
  const copyId = 'recovery-reconcile.operation.0'
  const recheckId = 'recheck-reconcile.operation.0'
  await trackWidth(page, 'abort', `[data-testid="${copyId}"], [data-testid="${recheckId}"]`)
  await keepingClipboard(e2e, async () => {
    await op.getByTestId(copyId).click()
    await expect(op.getByTestId(recheckId)).toBeVisible()
    expect(await clipboardText(e2e)).toBe('git merge --abort')
  })
  gitOut(e2e.sandbox, 'merge', '--abort')
  expect(existsSync(join(e2e.sandbox, '.git', 'MERGE_HEAD'))).toBe(false)
  await op.getByTestId(recheckId).click()
  await expect(card).toBeHidden({ timeout: 60_000 })
  await expectSteadyWidth(page, 'abort', 'The copy / re-check button')

  // ---- the run goes on: Implement runs and the run completes ----
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.steps.find((s) => s.key === 'implement')?.status).toBe('done')
  expect(fakeProcs(e2e).filter((p) => p.script.startsWith('implement-'))).toHaveLength(1)
  expect(existsSync(join(e2e.sandbox, VERSION_WRITE.path))).toBe(true)

  expect(e2e.pageErrors).toEqual([])
})
