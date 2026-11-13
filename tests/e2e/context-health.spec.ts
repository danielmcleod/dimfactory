// Context health end to end on the fake Claude. Implement replays an automatic compaction (C23s, held a
// few seconds around it): its card's context meter sits in its reserved slot from the step's start, turns amber near
// the window's end ("Context 83%"), reads "Summarising…" while the CLI compacts and "Context 16% · 1 summary" after;
// nothing in the metrics line moves meanwhile. Once the run is over, "After the run" has the Context table and the
// Context health items (the 166k-token overhead before the task, compared with Plan at Extensions None), and Easy
// mode's Done screen says it in plain words. No em dashes. With CONTEXT_SCREENS=1 it also writes light and dark
// screenshots to test-results/context1-screens/ for review (not committed).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'

const OUT = join(REPO_ROOT, 'test-results', 'context1-screens')
const SCREENS = process.env['CONTEXT_SCREENS'] !== undefined

/** The fake's answer to the context breakdown: one MCP server, as Claude names them. */
const BREAKDOWN = {
  totalTokens: 12_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  memoryFiles: [],
  mcpTools: [
    { name: 'mcp__github__search', serverName: 'github', tokens: 5_200 },
    { name: 'mcp__github__issue', serverName: 'github', tokens: 4_100 },
  ],
  agents: [],
}

async function shot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  if (!SCREENS) return
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

test('the context meter, a compaction and the Context health section', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C23s-compact-auto',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
          holdAroundCompactingMs: SCREENS ? 9_000 : 4_000,
        },
      ],
    },
    editScenario: (sc) => {
      sc.env['FAKE_CLI_CONTEXT_USAGE_JSON'] = JSON.stringify(BREAKDOWN)
    },
    config: { gates: { afterPlan: false, beforeFix: false } },
  })
  await page.setViewportSize({ width: 1280, height: 860 })

  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()

  // ---- the meter: its slot from the step's start, amber near the end of the window ----
  const meter = page.getByTestId('pass-context-implement')
  await expect(meter).toBeVisible({ timeout: 120_000 })
  const line = page.getByTestId('pass-metrics-implement')
  const slot = await meter.boundingBox()
  const lineBox = await line.boundingBox()
  await expect(meter).toHaveText('Context 83%', { timeout: 60_000 })
  await expect(meter).toHaveAttribute('data-warn', 'true')
  expect((await meter.boundingBox())?.width).toBeCloseTo(slot?.width ?? -1, 0)
  await meter.scrollIntoViewIfNeeded()
  await shot(e2e, page, '02-meter-amber')

  // ---- the CLI summarises: "Summarising…" in the same slot ----
  await expect(meter).toHaveText('Summarising…', { timeout: 30_000 })
  await expect(meter).toHaveAttribute('data-compacting', 'true')
  expect((await meter.boundingBox())?.width).toBeCloseTo(slot?.width ?? -1, 0)
  expect((await line.boundingBox())?.height).toBeCloseTo(lineBox?.height ?? -1, 0)
  await shot(e2e, page, '03-summarising')

  // ---- after: the summary counted, amber gone ----
  await expect(meter).toHaveText('Context 16% · 1 summary', { timeout: 60_000 })
  await expect(meter).not.toHaveAttribute('data-warn', 'true')
  expect((await meter.boundingBox())?.width).toBeCloseTo(slot?.width ?? -1, 0)
  expect((await line.boundingBox())?.height).toBeCloseTo(lineBox?.height ?? -1, 0)
  await shot(e2e, page, '01-meter')

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // ---- After the run: Context and Context health ----
  const table = page.getByTestId('run-end-context')
  await expect(table).toBeVisible({ timeout: 30_000 })
  const impl = page.getByTestId('run-end-context-implement')
  await expect(impl).toContainText('83%')
  await expect(impl).toContainText('github MCP 9k')
  const items = page.getByTestId('run-end-context-health-items')
  await expect(items).toContainText('This pass started with about')
  await expect(items).toContainText('tokens before your task (Plan started with')
  await expect(items).toContainText('Lower Extensions for this pass.')
  // No scroll box of its own and no buttons (UI standards).
  const health = page.getByTestId('run-end-context-health')
  expect(['visible', 'clip']).toContain(await health.evaluate((el) => getComputedStyle(el).overflowY))
  expect(await health.getByRole('button').count()).toBe(0)
  await page.getByTestId('main').evaluate((m) => m.scrollTo(0, m.scrollHeight))
  await table.scrollIntoViewIfNeeded()
  await shot(e2e, page, '04-context-health')

  const snap = await e2e.call('runs.get', { runId: run.runId })
  expect(snap.contextHealth?.items.some((i) => i.id === 'D1' && i.step === 'implement')).toBe(true)
  expect(await page.locator('body').innerText()).not.toContain(String.fromCodePoint(0x2014))

  // ---- Easy mode's Done screen: the same, in plain words ----
  await page.evaluate((id) => {
    window.location.hash = `#/easy/runs/${id}`
  }, run.runId)
  const notes = page.getByTestId('easy-context-notes')
  await expect(notes).toBeVisible({ timeout: 30_000 })
  await expect(notes).toContainText('Some of your add-ons make each step heavier.')
  await notes.scrollIntoViewIfNeeded()
  await shot(e2e, page, '05-easy-wording')
  expect(await page.locator('body').innerText()).not.toContain(String.fromCodePoint(0x2014))
  expect(e2e.pageErrors).toEqual([])
})
