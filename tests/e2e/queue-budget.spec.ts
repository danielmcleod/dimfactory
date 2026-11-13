// A budget stop, end to end on the fake Claude. With a cost limit per run far below what one pass
// costs, the queue's first run is stopped as soon as its first priced pass ends; the queue pauses and says why (the
// run-budget reason, which says what to do next), the stopped task reads "Budget reached", and the next task stays
// pending: nothing is skipped silently and nothing starts on its own.
import { expect, test } from './harness.ts'

test('the per-run limit stops the run and pauses the queue with its reason', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
        },
      ],
    },
    config: {
      gates: { afterPlan: false, beforeFix: false },
      factory: { maxCostPerRunUsd: 0.000001 },
    },
  })
  await page.getByTestId('nav-queue').click()
  await expect(page.getByTestId('queue-limits')).toContainText('Per run: <$0.01')
  await page.getByTestId('queue-folder-input').fill(e2e.sandbox)
  for (const t of ['add a --version flag', 'write the README']) {
    await page.getByTestId('queue-task-input').fill(t)
    await page.getByTestId('queue-add-button').click()
    await expect(page.getByTestId('queue-task-input')).toHaveValue('')
  }
  const folder = page.getByTestId('queue-folder')
  const rows = folder.locator('[data-testid^="queue-task-t"][data-status]')
  await expect(rows).toHaveCount(2)
  await folder.getByTestId('queue-toggle').click()

  await expect(folder).toHaveAttribute('data-state', 'paused', { timeout: 150_000 })
  await expect(folder.getByTestId('queue-pause')).toContainText('per run, so Dim Factory stopped it')
  await expect(folder.getByTestId('queue-pause')).toContainText('then resume the queue')
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'stopped')
  await expect(rows.nth(0).getByTestId('queue-task-facts')).toContainText('Budget reached')
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'pending')
  await expect(folder.getByTestId('queue-toggle')).toHaveText('Resume')

  const runs = (await e2e.call('runs.list', {})).items
  expect(runs).toHaveLength(1)
  expect(runs[0]!.status, e2e.describeRun(runs[0]!)).toBe('cancelled')
  // The pause stays; still only one run a moment later.
  await page.waitForTimeout(2000)
  expect((await e2e.call('runs.list', {})).items).toHaveLength(1)
  const view = await e2e.call('queue.get')
  expect(view.folders[0]?.pause?.reason).toBe('run-budget')
  expect(await page.locator('body').innerText()).not.toContain('—')
  expect(e2e.pageErrors).toEqual([])
})
