// The factory's task queue end to end, on the fake Claude in the temp sandbox. Two tasks are queued for the
// sandbox from the Queue page; nothing runs until Start; then they run one after another as ordinary runs (each a
// plan and an implement on the fake), both end done in order, the queue goes idle, the Dashboard's Queue card and the
// daily report count them, and each run's end proposes a project memory update that is written only when approved.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'

const write = (v: string): { path: string; content: string } => ({
  path: 'src/version.ts',
  content: `export const version = "${v}"\n`,
})

test('queue two tasks, start, both run to done one after another', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: write('1.0.0') },
        { recording: 'C08a-session-id-implement', write: write('1.1.0') },
      ],
    },
    config: { gates: { afterPlan: false, beforeFix: false } },
  })
  await page.getByTestId('nav-queue').click()
  await expect(page).toHaveURL(/#\/queue$/)
  await expect(page.getByTestId('queue-page')).toBeVisible()
  await page.getByTestId('queue-folder-input').fill(e2e.sandbox)
  await page.getByTestId('queue-task-input').fill('add a --version flag')
  await page.getByTestId('queue-add-button').click()
  await expect(page.getByTestId('queue-add-note')).toHaveText('Added to the queue.')
  await page.getByTestId('queue-task-input').fill('bump the version to 1.1.0')
  await page.getByTestId('queue-add-button').click()
  const folder = page.getByTestId('queue-folder')
  await expect(folder).toHaveCount(1)
  const rows = folder.locator('[data-testid^="queue-task-t"][data-status]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'pending')
  // Nothing runs before Start.
  expect((await e2e.call('runs.list', {})).items).toHaveLength(0)

  const toggle = folder.getByTestId('queue-toggle')
  const width = (await toggle.boundingBox())?.width
  await toggle.click()
  await expect(folder).toHaveAttribute('data-state', 'running')
  // The button turned into Pause and kept its width.
  await expect(toggle).toHaveText('Pause')
  expect((await toggle.boundingBox())?.width).toBe(width)

  await expect(rows.nth(0)).toHaveAttribute('data-status', 'done', { timeout: 150_000 })
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'done', { timeout: 150_000 })
  await expect(folder).toHaveAttribute('data-state', 'idle')
  const runs = (await e2e.call('runs.list', {})).items.sort((a, b) => a.displayNo - b.displayNo)
  expect(runs.map((r) => [r.title, r.status])).toEqual([
    ['add a --version flag', 'completed'],
    ['bump the version to 1.1.0', 'completed'],
  ])
  // One after another: the second run was created after the first ended.
  expect(runs[1]!.createdAt).toBeGreaterThanOrEqual(runs[0]!.endedAt ?? Infinity)
  await expect(rows.nth(0).getByTestId('queue-task-run')).toHaveAttribute('href', `#/runs/${runs[0]!.runId}`)

  // The daily report counts both and is written to the home.
  await page.getByTestId('queue-report-load').click()
  await expect(page.getByTestId('queue-report-runs')).toContainText(`Run #${runs[0]!.displayNo}`)
  const file = (await page.getByTestId('queue-report-file').textContent()) ?? ''
  expect(file.startsWith(join(e2e.home, 'reports'))).toBe(true)
  expect(existsSync(file)).toBe(true)

  // Project memory: each run proposed an update; nothing is written until approved.
  const memory = folder.getByTestId('queue-memory')
  await expect(memory.getByTestId('memory-approve')).toHaveCount(2)
  const memFile = join(e2e.sandbox, 'DIM_FACTORY.md')
  expect(existsSync(memFile)).toBe(false)
  await memory.getByTestId('memory-approve').first().click()
  await expect(memory.getByTestId('memory-approve')).toHaveCount(1)
  expect(readFileSync(memFile, 'utf8')).toContain(`Run #${runs[0]!.displayNo}`)

  // The Dashboard's card says the same.
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('queue-card-counts')).toContainText('2 done')
  expect(await page.locator('body').innerText()).not.toContain('—')
  expect(e2e.pageErrors).toEqual([])
})
