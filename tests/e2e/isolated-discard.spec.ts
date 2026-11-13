// Discard (Finalize: [Discard] (deletion deferred 10 s; undoable); "Cleanup: worktree remove
// --force → update-ref -d → worktree prune"; "Shadow GC: worktree shadows are dropped together with their worktree";
// "Undo toasts, not confirm dialogs"). At the finalize card the user discards the run's isolated copy: the toast
// offers Undo for the 10 s before the deletion, and Undo brings the finalize card back with the copy untouched. Then
// Discard again, and once the 10 s have passed (core's clock moved forward) the worktree, its branch and its shadow
// are gone, the folder never changed, and the run completes discarded with no "Isolated: not applied" chip.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { advanceClock, toasts } from './attention-helpers.ts'
import { expectSteadyWidth, trackWidth } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'
import {
  card,
  choose,
  commitSandbox,
  dimFactoryBranches,
  hashes,
  isolatedConfig,
  worktreeOf,
} from './isolated-helpers.ts'

test('Discard is undoable for 10 s, then the isolated copy and its branch are deleted', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
    },
    config: isolatedConfig({ mode: 'worktree', install: 'never' }),
  })
  commitSandbox(e2e, { 'README.md': '# ts-small\n' })
  const folder = e2e.sandbox
  const before = hashes(folder, ['README.md', 'src/index.ts', VERSION_WRITE.path])

  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()
  await card(page, 'finalize', 180_000)
  const wt = worktreeOf(e2e, run.runId)
  expect(existsSync(join(wt, VERSION_WRITE.path))).toBe(true)
  expect(dimFactoryBranches(e2e)).toHaveLength(1)
  const shadows = (): number => readdirSync(join(e2e.home, 'shadow')).length
  const shadowsWithCopy = shadows()

  // ---- Discard → the toast's Undo within 10 s → the copy stays, the card is back ----
  await choose(page, 'finalize', 'discard')
  const state = page.getByTestId('finalize-state')
  await expect(state).toHaveAttribute('data-state', 'discarding')
  await expect(state).toHaveText('Discarding the isolated copy: you can still undo it.')
  const toast = toasts(page).filter({ hasText: 'Discarded the isolated copy.' })
  await expect(toast).toHaveCount(1)
  await trackWidth(page, 'undo-discard', '[data-testid="finalize-undo-discard"]')
  await toast.getByRole('button', { name: 'Undo' }).click()
  await card(page, 'finalize', 30_000)
  await expect(state).toHaveAttribute('data-state', 'pending')
  expect(existsSync(join(wt, VERSION_WRITE.path))).toBe(true)
  expect(dimFactoryBranches(e2e)).toHaveLength(1)
  // 10 s later nothing was deleted: the undone discard's timer is gone.
  await advanceClock(e2e, 15_000)
  await page.waitForTimeout(1_000)
  expect(existsSync(wt)).toBe(true)
  expect((await e2e.snapshot(run.runId)).summary.status).toBe('waiting')

  // ---- Discard again, and let the 10 s pass ----
  await choose(page, 'finalize', 'discard')
  await expect(state).toHaveAttribute('data-state', 'discarding')
  await expect(page.getByTestId('finalize-undo-discard')).toBeEnabled()
  await expectSteadyWidth(page, 'undo-discard', "The finalize card's Undo")
  await advanceClock(e2e, 11_000)
  const ended = await e2e.waitForEnd(run.runId, 60_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(state).toHaveAttribute('data-state', 'discarded')
  await expect(state).toHaveText('Discarded: the isolated copy is deleted.')
  expect(existsSync(wt)).toBe(false)
  expect(dimFactoryBranches(e2e)).toEqual([])
  expect(shadows()).toBe(shadowsWithCopy - 1)
  expect(hashes(folder, ['README.md', 'src/index.ts', VERSION_WRITE.path])).toEqual(before)
  expect(ended.worktree?.notApplied ?? false).toBe(false)
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`recent-run-${run.runId}`)).toBeVisible()
  await expect(page.getByTestId(`isolated-chip-${run.runId}`)).toHaveCount(0)
  expect(e2e.pageErrors).toEqual([])
})
