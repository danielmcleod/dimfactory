// A schedule that was due while Dim Factory was closed. The home has a queue with a pending task
// and a schedule whose window is open now, with "resume automatically" off (the default). At launch the notice
// banner says the schedule was due and that nothing runs until you start it, and nothing runs; [Start queue] starts
// the queue (and dismisses the notice), and the task runs to done on the fake Claude.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from './harness.ts'

/** The queue file's name: a hash of the folder's path (core's briefKey: case folded on Windows and macOS). */
function queueKey(folder: string): string {
  const abs = resolve(folder)
  const norm = process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16)
}

const hhmm = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('a due schedule at launch shows a notice; nothing runs until Start queue', async ({ e2e }) => {
  test.setTimeout(240_000)
  const now = Date.now()
  await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
        },
      ],
    },
    config: {
      gates: { afterPlan: false, beforeFix: false },
      factory: {
        schedule: {
          enabled: true,
          start: hhmm(now - 60_000),
          end: hhmm(now + 60 * 60_000),
          days: [0, 1, 2, 3, 4, 5, 6],
          resumeAutomatically: false,
        },
      },
    },
  })
  // The first launch had no queue: no notice. Dim Factory closes; a queue with a pending task is left in its home
  // (as a queue added before the computer restarted).
  await expect(e2e.p.getByTestId('queue-notice')).toHaveCount(0)
  await e2e.close()
  mkdirSync(join(e2e.home, 'queue'), { recursive: true })
  const doc = {
    schemaVersion: 1,
    folder: resolve(e2e.sandbox),
    tasks: [
      {
        id: 't0000000000a1',
        task: 'add a --version flag',
        title: 'add a --version flag',
        source: { kind: 'manual' },
        addedAt: now - 3_600_000,
        status: 'pending',
      },
    ],
    state: 'idle',
    consecutiveFailures: 0,
  }
  writeFileSync(join(e2e.home, 'queue', `${queueKey(e2e.sandbox)}.json`), `${JSON.stringify(doc, null, 2)}\n`)

  const page = await e2e.launch()
  const notice = page.getByTestId('queue-notice')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('queue-notice-text')).toContainText('The schedule was due at')
  await expect(page.getByTestId('queue-notice-text')).toContainText('Nothing runs until you do.')
  // Nothing started on its own.
  await page.waitForTimeout(2000)
  expect((await e2e.call('runs.list', {})).items).toHaveLength(0)
  const before = await e2e.call('queue.get')
  expect(before.folders[0]?.state).not.toBe('running')

  await page.getByTestId('queue-notice-start').click()
  await expect(notice).toHaveCount(0)
  await expect(page).toHaveURL(/#\/queue$/)
  const row = page.getByTestId('queue-task-t0000000000a1')
  await expect(row).toHaveAttribute('data-status', 'done', { timeout: 150_000 })
  const runs = (await e2e.call('runs.list', {})).items
  expect(runs).toHaveLength(1)
  expect(runs[0]!.status, e2e.describeRun(runs[0]!)).toBe('completed')
  expect((await e2e.call('queue.get')).notice).toBeUndefined()
  expect(await page.locator('body').innerText()).not.toContain('—')
  expect(e2e.pageErrors).toEqual([])
})
