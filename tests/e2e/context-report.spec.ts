// Settings > Extensions > Context for a project with six earlier runs, each with its
// context-health.json: the report's line says what share failed and had AI claims that did not match the run, the
// table opens on a click with each contributor's size and how its runs compare with the project's average, and the
// suggestions name the big memory file, the heavy skill, the MCP server never called and the skill whose runs failed.
// Core answers the same report.
// The options write the user's settings. No em dashes; the report adds no scrollbar of its own.
import { expect, test } from './harness.ts'
import { contextProject, seedContextRuns } from './context-report-helpers.ts'

test('the project Context report and the context health options', async ({ e2e }) => {
  test.setTimeout(180_000)
  const project = contextProject(e2e.root)
  seedContextRuns(e2e.home, project, Date.now())
  const page = await e2e.start()
  await page.setViewportSize({ width: 1280, height: 900 })

  const report = await e2e.call('context.report', { folder: project })
  expect(report.runs).toBe(6)
  expect(report.failureRate).toBe(0.33)
  expect(report.recommendations.map((r) => r.kind).sort()).toEqual([
    'big-memory',
    'heavy-skill',
    'lift',
    'lift',
    'unused-mcp',
  ])

  await page.evaluate((f) => {
    window.location.hash = `#/settings/extensions?folder=${encodeURIComponent(f)}`
  }, project)
  const group = page.getByTestId('extensions-context')
  await expect(group).toBeVisible({ timeout: 30_000 })
  const summary = page.getByTestId('context-report-summary')
  await expect(summary).toHaveText(
    'From 6 recent runs: 33% failed or completed with failures, 17% had AI claims that did not match the run. 5 suggestions.',
    { timeout: 30_000 },
  )
  const box = await page.getByTestId('context-report').boundingBox()
  await page.getByTestId('context-report-details').locator('summary').click()
  const tips = page.getByTestId('context-report-suggestions')
  await expect(tips).toContainText('CLAUDE.md is ~40k tokens and loads into every pass.')
  await expect(tips).toContainText('Skill big-helper adds ~12k tokens to every Implement pass.')
  await expect(tips).toContainText("Runs with big-helper failed 2 times as often as this project's average.")
  await expect(tips).toContainText('MCP server tracker: 31 tools, unused in the last 6 runs.')
  const table = page.getByTestId('context-report-table')
  await expect(table).toContainText('tracker')
  await expect(table).toContainText('MCP server')
  // Opening it is the user's doing; before that the report held its room.
  expect(box?.height ?? 0).toBeGreaterThan(40)
  const frame = page.getByTestId('context-report')
  expect(['visible', 'clip']).toContain(await frame.evaluate((el) => getComputedStyle(el).overflowY))

  // An option goes to the user's settings.
  await page.getByTestId('context-registry').click()
  await expect(page.getByTestId('context-registry')).toHaveAttribute('data-state', 'checked')
  await expect
    .poll(async () => {
      const r = await e2e.call('config.read', { scope: 'user' })
      return JSON.stringify(r)
    })
    .toContain('registryCheck')
  expect(await page.locator('body').innerText()).not.toContain(String.fromCodePoint(0x2014))
  expect(e2e.pageErrors).toEqual([])
})
