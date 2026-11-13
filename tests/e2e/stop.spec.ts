// Stop ("Stop → cancelled. Toast: Run stopped · changes kept [Revert all]"): Stop
// while Implement is running → the vendor process ends, the run is cancelled, the toast offers Revert all (available
// once the stopped process has gone) and the Re-run menu offers Re-run from Fix (live, and here disabled with
// core's reason, since Implement never finished: Re-run from Fix is "available when the source has a diff and ≥ 1 finding"). A user
// Stop is not a failure: no snag card.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { passArgvs } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { PARKED_IMPLEMENT } from './scenarios.ts'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('Stop during Implement cancels the run and keeps its changes', { tag: '@cross-os' }, async ({ e2e }) => {
  const page = await e2e.start({ scenario: PARKED_IMPLEMENT })
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()

  const pid = await e2e.waitForLiveProc(run.runId, 'implement')
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'running')
  // What the vendor has written so far (the parked fake writes nothing itself).
  const partial = join(e2e.sandbox, 'src', 'partial.ts')
  writeFileSync(partial, 'export const partial = true\n')

  await page.getByTestId('stop-run').click()
  const toast = page.locator(`[data-toast-id="stopped:${run.runId}"]`)
  await expect(toast).toContainText('Run stopped · changes kept', { timeout: 30_000 })
  await expect(toast.getByRole('button', { name: 'Revert all' })).toBeEnabled({ timeout: 15_000 })

  const s = await e2e.waitForSummary(run.runId, { status: 'cancelled' })
  expect(s.steps.find((x) => x.key === 'implement')?.status).toBe('cancelled')
  await expect(page.getByTestId('run-status')).toContainText(/cancelled/i)
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'cancelled')
  await expect(page.getByTestId('stop-run')).toHaveCount(0)
  await expect(page.getByTestId('snag-implement')).toHaveCount(0)

  // The vendor process is gone and nothing else started; the folder keeps what was written. Stop cancels the step
  // at once and ends the process through its interrupt-then-kill grace, so the pid may outlive the status briefly.
  expect((await e2e.e2eState()).procs).toEqual([])
  await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false)
  expect(passArgvs(e2e.fakeLog()).filter((a) => a.includes('acceptEdits'))).toHaveLength(1)
  expect(existsSync(partial)).toBe(true)
  expect(readFileSync(partial, 'utf8')).toBe('export const partial = true\n')

  // Re-run ▾ → Re-run from Fix is offered, disabled with core's reason (Implement never finished, so Fix has
  // no changes to work on); Re-run with same config is live.
  await page.getByTestId('rerun-menu').click()
  const fromFix = page.getByTestId('rerun-from-fix')
  await expect(fromFix).toBeVisible()
  await expect(fromFix).toHaveAttribute('aria-disabled', 'true')
  await expect(fromFix).toContainText('Re-run from Fix')
  await expect(fromFix).toContainText('Implement did not finish, so there are no changes for Fix to work on')
  await expect(page.getByTestId('rerun-start')).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  // The Dashboard lists it under Recent as cancelled.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`recent-outcome-${run.runId}`)).toContainText('Cancelled at Implement')

  expect(e2e.pageErrors).toEqual([])
})
