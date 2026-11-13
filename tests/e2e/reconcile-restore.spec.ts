// Reconcile and restore (reconciliation: external edits overlapping run paths → choice [Include my
// edits] (default) · [Restore run's version] (undoable) · [Stop]; R10 reconcile(pre-fix)): between passes, at the gate
// before Fix (the run's one pause after Implement), the user edits a file the run created. Continue → core checks the
// folder before Fix and asks with a reconcile card, Fix waits → [Restore run's version] → the file is the run's version
// again, the run completes, and the user's edit is absent from the run's Combined diff (diff.files / diff.file). The
// restore is undoable: "After the run" keeps its Undo, which brings the user's bytes back exactly (CRLF).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { fakeProcs, toasts } from './attention-helpers.ts'
import { WITH_FINDINGS, auditBothSizes, expectSteadyWidth, mainScrollTop, trackWidth } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

/** The user's own edit, with Windows line endings (the bytes must come back exactly). */
const EXTERNAL = 'export const version = "edited by hand"\r\n'

test("an overlapping edit between passes: reconcile card, Restore run's version, undo", async ({ e2e }) => {
  const page = await e2e.start({
    scenario: WITH_FINDINGS,
    config: { gates: { afterPlan: true, beforeFix: true } },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()

  // ---- the gate before Fix: the user edits the run's new file by hand, then continues ----
  const gate = page.getByTestId('card-gate:beforeFix')
  await expect(gate).toBeVisible({ timeout: 120_000 })
  const target = join(e2e.sandbox, VERSION_WRITE.path)
  expect(readFileSync(target, 'utf8')).toBe(VERSION_WRITE.content)
  writeFileSync(target, EXTERNAL)
  await gate.getByTestId('card-choice-continue').click()
  await expect(gate).toBeHidden()

  // ---- the reconcile card: what changed, core's choices, Fix waits ----
  const card = page.getByTestId('card-reconcile')
  await expect(card).toBeVisible({ timeout: 60_000 })
  // Nothing scrolls on its own once the card is there (it takes focus without scrolling).
  const scrolled = await mainScrollTop(page)
  await expect(card.getByRole('heading')).toHaveText('1 file the run changed was edited outside it')
  await expect(card.getByTestId('reconcile-lead')).toHaveText('Dim Factory checked the folder before Fix.')
  await expect(card.getByTestId('reconcile-overlapping')).toContainText(
    'Changed by the run and edited outside it (1 file)',
  )
  await expect(card.getByTestId('reconcile-overlapping-path')).toHaveText([VERSION_WRITE.path])
  await expect(card.getByTestId('reconcile-reason-external-overlap')).toHaveAttribute(
    'data-severity',
    'choice',
  )
  await expect(card.locator('button[data-testid^="card-choice-"]')).toHaveText([
    'Include my edits',
    "Restore run's version",
    'Stop run',
  ])
  const snap = await e2e.snapshot(run.runId)
  const view = snap.cards.find((c) => c.kind === 'reconcile')
  expect(view?.defaultChoice).toBe('include-my-edits')
  expect(snap.steps.fix).toMatchObject({ status: 'waiting', reason: 'folder check' })
  expect(fakeProcs(e2e).some((p) => p.script.startsWith('resume-'))).toBe(false)
  // Still where it was once the card has settled (no scroll after its arrival); the audit below resizes the window.
  expect(await mainScrollTop(page)).toBe(scrolled)
  await auditBothSizes(e2e, page, 'Run view with the reconcile card')

  // ---- [Restore run's version]: the button keeps its size while core takes the choice ----
  await trackWidth(page, 'restore', '[data-testid="card-choice-restore-run-version"]')
  await card.getByTestId('card-choice-restore-run-version').click()
  await expect(card).toBeHidden()
  await expectSteadyWidth(page, 'restore', "Restore run's version")
  // The undo toast says what was reverted; its Undo waits while the run goes on in the folder.
  const undoToast = toasts(page).filter({ hasText: 'Reverted your edits outside the run' })
  await expect(undoToast).toHaveCount(1)

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  expect(readFileSync(target, 'utf8')).toBe(VERSION_WRITE.content)
  // Fix ran after the restore (it resumed Implement's session).
  expect(fakeProcs(e2e).filter((p) => p.script.startsWith('resume-'))).toHaveLength(1)

  // ---- the Combined diff (S0..S2) has the run's version, not the user's edit ----
  const files = await e2e.call('diff.files', { runId: run.runId, seg: 'combined' })
  expect(files.available).toEqual(['implement', 'fix', 'combined'])
  expect(files.files.find((f) => f.path === VERSION_WRITE.path)).toMatchObject({ status: 'A' })
  const patch = await e2e.call('diff.file', { runId: run.runId, seg: 'combined', path: VERSION_WRITE.path })
  expect(patch.patch).toContain('+export const version = "0.1.0"')
  expect(patch.patch).not.toContain('edited by hand')

  // ---- the restore is undoable after the run: the user's bytes come back exactly ----
  const end = page.getByTestId('run-end')
  await expect(end).toBeVisible()
  const undoLine = end.getByTestId('run-end-revert-undo')
  await expect(undoLine).toContainText('Reverted your edits outside the run (1 file). You can undo that.')
  await auditBothSizes(e2e, page, 'Run view after the run with the restore undo')
  await trackWidth(page, 'undo', '[data-testid="run-end-undo"]')
  await undoLine.getByTestId('run-end-undo').click()
  await expect(
    toasts(page).filter({ hasText: 'Revert undone: your edits outside the run are back' }),
  ).toHaveCount(1)
  await expect(undoLine).toBeHidden()
  await expectSteadyWidth(page, 'undo', 'Undo')
  expect(readFileSync(target).equals(Buffer.from(EXTERNAL, 'utf8'))).toBe(true)
  // The Combined diff is the run's, whatever the folder holds now.
  const after = await e2e.call('diff.file', { runId: run.runId, seg: 'combined', path: VERSION_WRITE.path })
  expect(after.patch).toBe(patch.patch)

  expect(e2e.pageErrors).toEqual([])
})
