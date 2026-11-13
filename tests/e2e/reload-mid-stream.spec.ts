// Reload mid-stream (state and performance → the bridge): webContents.reload() while Implement
// streams a long answer in many small deltas → after the reload the renderer replays the run's log and then follows
// the live stream; once Implement is done the stream buffer's full text equals the scenario's text exactly (no
// loss, no duplication). Also: what main pushes only on change survives a reload, and a blocked navigation does not
// stop the stream.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from './harness.ts'
import { CLEAN_FLOW, longText, streamDeltas, streamingImplement } from './scenarios.ts'

// About 24 KB in 480 deltas with a short sleep after each: several seconds of streaming.
const TEXT = longText(24_000)
const CHUNK = 50

test('a reload mid-stream loses and duplicates nothing', { tag: '@cross-os' }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: streamingImplement(TEXT),
    editScenario: (sc) => streamDeltas(sc, 'implement-1', TEXT, { chunkSize: CHUNK, sleepMs: 15 }),
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()

  // Some of the answer is on screen, but not all of it.
  const pane = page.getByTestId('stream-implement')
  await expect(pane).toContainText('line 1: ', { timeout: 60_000 })
  await expect.poll(async () => (await e2e.streamText(run.runId, 'implement')).length).toBeGreaterThan(2_000)
  const before = await e2e.streamText(run.runId, 'implement')
  expect(TEXT.startsWith(before)).toBe(true)
  expect(before.length).toBeLessThan(TEXT.length / 2)

  // The reload itself, as main would do it.
  const app = e2e.app
  if (app === null) throw new Error('the app is not running')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.reload())
  await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: 60_000 })
  await expect(page.getByTestId('run-view')).toBeVisible()
  // Still mid-stream after the reload: Implement has not finished yet.
  expect((await e2e.snapshot(run.runId)).steps.implement.status).toBe('running')
  await expect(pane).toBeVisible()

  await e2e.waitForSnapshot(run.runId, (s) => s.steps.implement.status === 'done', {
    what: 'Implement done',
    timeoutMs: 120_000,
  })
  await expect.poll(async () => (await e2e.streamText(run.runId, 'implement')).length).toBe(TEXT.length)
  const after = await e2e.streamText(run.runId, 'implement')
  expect(
    after === TEXT,
    `stream text differs from the scenario (length ${after.length} vs ${TEXT.length})`,
  ).toBe(true)

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  // The stream survived the run's end too (no late duplicates from the final structural refetch).
  expect(await e2e.streamText(run.runId, 'implement')).toBe(TEXT)

  expect(e2e.pageErrors).toEqual([])
})

// What main pushes only on change (attention, theme) is pushed again to a reloaded page: the run waiting at the plan
// gate is still in the needs-you strip and the sidebar badge, and the page keeps the accent chosen after launch.
test('a reload keeps the needs-you strip, the badge and the theme', { tag: '@cross-os' }, async ({ e2e }) => {
  const page = await e2e.start({ scenario: CLEAN_FLOW })
  const run = await e2e.runFromDashboard('add a --version flag')
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  await e2e.call('ui.setTheme', { accent: 'rose' })
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'rose')

  await page.keyboard.press('ControlOrMeta+1')
  const item = page.getByTestId('needs-you').getByRole('link', { name: 'Review plan' })
  await expect(item).toBeVisible()
  await expect(page.getByTestId('nav-dashboard')).toContainText('1')

  const app = e2e.app
  if (app === null) throw new Error('the app is not running')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.reload())
  await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: 60_000 })
  await expect(item).toBeVisible()
  await expect(page.getByTestId('nav-dashboard')).toContainText('1')
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'rose')
  expect((await e2e.snapshot(run.runId)).summary.status).toBe('waiting')

  expect(e2e.pageErrors).toEqual([])
})

// A navigation the hardening blocks (Chromium navigates to a file dropped on the window) leaves the page, its stream
// focus and main's push queue alone: the open run's stream keeps flowing while Implement is still running.
// The renderer on app://: the page is app://, and Chromium itself refuses it a local file, logging
// "Not allowed to load local resource" (the one console line this test provokes), so a web page main's will-navigate
// stops is tried as well.
test('a blocked navigation mid-stream keeps the stream live', { tag: '@cross-os' }, async ({ e2e }) => {
  const text = longText(48_000)
  const page = await e2e.start({
    scenario: streamingImplement(text),
    editScenario: (sc) => streamDeltas(sc, 'implement-1', text, { chunkSize: CHUNK, sleepMs: 15 }),
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()
  await expect.poll(async () => (await e2e.streamText(run.runId, 'implement')).length).toBeGreaterThan(1_000)

  // Playwright then waits for a navigation that never finishes, so from here on the test reads the page through
  // evaluate only (no locators).
  const before = await page.evaluate(() => window.location.href)
  const outside = pathToFileURL(join(e2e.sandbox, 'package.json')).href
  for (const target of [outside, 'https://example.com/dim-factory-e18']) {
    await page.evaluate((url) => {
      window.location.href = url
    }, target)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.location.href), target).toBe(before)
  }
  expect(await page.evaluate(() => document.querySelector('[data-testid="run-view"]') !== null)).toBe(true)

  const at = (await e2e.streamText(run.runId, 'implement')).length
  await expect
    .poll(async () => (await e2e.streamText(run.runId, 'implement')).length, { timeout: 30_000 })
    .toBeGreaterThan(at + 2_000)
  // Still mid-stream: the text arrived live, not from the catch-up at Implement's end.
  expect((await e2e.snapshot(run.runId)).steps.implement.status).toBe('running')

  await e2e.waitForSnapshot(run.runId, (s) => s.steps.implement.status === 'done', {
    what: 'Implement done',
    timeoutMs: 120_000,
  })
  await expect.poll(async () => e2e.streamText(run.runId, 'implement')).toBe(text)
  expect(
    e2e.pageErrors.filter((e) => e !== `console: Not allowed to load local resource: ${outside}`),
  ).toEqual([])
})
