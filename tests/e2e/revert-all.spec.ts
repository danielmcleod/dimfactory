// Revert all ("Stop → cancelled. Toast: Run stopped · changes kept [Revert all] (Revert is
// undoable)"; revert to S0: a scratch GIT_INDEX_FILE, files absent at S0 deleted, Undo restores the `pre-revert`
// snapshot, allowed only when no process holds the folder; state-machine row R13). Implement writes three files (a tracked
// file changed, an untracked CRLF file rewritten, a new file) and keeps running; the user presses Stop. The toast's
// [Revert all] waits while the stopped process ends, then reverts: every file is back to its S0 bytes (CRLF and
// non-ASCII kept) and the new file is gone → "Reverted 3 files" [Undo] → the run's versions are back, byte for byte.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { auditBothSizes, expectSteadyWidth, fingerprint, trackWidth, writeThenPark } from './git-helpers.ts'

/** What the vendor writes before it is stopped. */
const RUN_WRITES = [
  { path: 'src/index.ts', content: 'export const changed = "by the run"\n' },
  { path: 'notes/crlf.txt', content: 'rewritten by the run\n' },
  { path: 'src/added.ts', content: 'export const added = true\n' },
] as const
const PATHS = RUN_WRITES.map((w) => w.path)
/** The untracked file the run rewrites, as the user had it: CRLF and non-ASCII bytes. */
const CRLF = Buffer.from('line one\r\nété\r\n', 'utf8')

test('Revert all after Stop puts the S0 bytes back, and Undo brings the run back', async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', delayMs: 300_000 }],
    },
    editScenario: (sc) => writeThenPark(sc, 'implement-1', RUN_WRITES),
  })
  const f = e2e.sandbox
  mkdirSync(join(f, 'notes'), { recursive: true })
  writeFileSync(join(f, 'notes/crlf.txt'), CRLF)
  const s0 = fingerprint(f, PATHS)
  expect(s0['src/added.ts']).toBe('absent')

  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()
  await e2e.waitForLiveProc(run.runId, 'implement')
  // The vendor has written its three files and keeps working.
  await expect
    .poll(
      () =>
        RUN_WRITES.every(
          (w) => existsSync(join(f, w.path)) && readFileSync(join(f, w.path), 'utf8') === w.content,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true)
  const runVersion = fingerprint(f, PATHS)

  // ---- Stop → the toast's Revert all waits for the process, then reverts ----
  await page.getByTestId('stop-run').click()
  const stopped = page.locator(`[data-toast-id="stopped:${run.runId}"]`)
  await expect(stopped).toContainText('Run stopped · changes kept', { timeout: 30_000 })
  const toastButton = `[data-toast-id="stopped:${run.runId}"] button:not([aria-label="Dismiss"])`
  await trackWidth(page, 'toast-revert', toastButton)
  const revert = stopped.getByRole('button', { name: 'Revert all' })
  await expect(revert).toBeEnabled({ timeout: 15_000 })
  await revert.click()
  const reverted = page.locator(`[data-toast-id="reverted:${run.runId}"]`)
  await expect(reverted).toContainText('Reverted 3 files')
  await expectSteadyWidth(page, 'toast-revert', "The Stop toast's Revert all")

  expect(fingerprint(f, PATHS)).toEqual(s0)
  expect(readFileSync(join(f, 'notes/crlf.txt')).equals(CRLF)).toBe(true)
  expect(existsSync(join(f, 'src/added.ts'))).toBe(false)
  const s = await e2e.waitForSummary(run.runId, { status: 'cancelled' })
  expect(s.steps.find((x) => x.key === 'implement')?.status).toBe('cancelled')
  await auditBothSizes(e2e, page, 'Run view after Revert all')

  // ---- Undo → the run's versions, byte for byte ----
  await reverted.getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page).filter({ hasText: "Revert undone: the run's changes are back" })).toHaveCount(1)
  expect(fingerprint(f, PATHS)).toEqual(runVersion)
  for (const w of RUN_WRITES) expect(readFileSync(join(f, w.path), 'utf8')).toBe(w.content)

  // After the run keeps Revert all available (the run's changes are in the folder again).
  await expect(page.getByTestId('run-end').getByTestId('revert-all')).toBeEnabled()

  expect(e2e.pageErrors).toEqual([])
})
