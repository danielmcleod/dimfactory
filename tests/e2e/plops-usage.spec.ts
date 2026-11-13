// The Plops page (AI usage per vendor and model). The home starts with four earlier runs in runs/index.jsonl
// whose steps carry real usage: Claude (Opus two days ago, Sonnet three hours ago), Codex (gpt-5-codex three hours
// ago, gpt-5 twenty days ago) and Gemini (a failed step twenty-five days ago), plus a Claude step on the CLI's default
// model that reported no tokens (Claude's, with no Plop of its own). From the sidebar the page opens on the last 30
// days with a Plop per vendor and Claude's models drilled into; on 7 days Gemini and gpt-5 (used before, no tokens
// now) lie as puddles in their tiles, with the period buttons keeping their size; back on 30 days, choosing Codex shows
// "All Codex" and its two models on one floor.
import type { RunSummary, RunSummaryStep } from '../../src/shared/run.ts'
import { expect, test } from './harness.ts'
import { DAY_MS, seededSummary } from './history-helpers.ts'
import type { SeedRow } from './history-helpers.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOUR_MS = 3_600_000

const used = (
  key: RunSummaryStep['key'],
  vendor: string,
  model: string,
  input: number,
  output: number,
  costUsd: number,
  over: Partial<RunSummaryStep> = {},
): RunSummaryStep => ({
  key,
  vendor,
  model,
  status: 'done',
  activeMs: 30_000,
  usage: { input, output, costUsd },
  costBasis: 'vendor',
  ...over,
})

function seed(home: string, now: number): RunSummary[] {
  const rows: { row: SeedRow; steps: RunSummaryStep[] }[] = [
    {
      row: { title: 'gemini docs pass', folder: 'C:\\work\\docs', status: 'failed', ageMs: 25 * DAY_MS },
      steps: [
        used('plan', 'gemini', 'gemini-2.5-pro', 40_000, 6_000, 0.08),
        {
          key: 'implement',
          vendor: 'gemini',
          model: 'gemini-2.5-pro',
          status: 'failed',
          activeMs: 1000,
          failureCategory: 'network',
        },
      ],
    },
    {
      row: { title: 'codex refactor', folder: 'C:\\work\\api', status: 'completed', ageMs: 20 * DAY_MS },
      steps: [used('implement', 'codex', 'gpt-5', 300_000, 40_000, 0.9)],
    },
    {
      row: { title: 'opus plan and build', folder: 'C:\\work\\api', status: 'completed', ageMs: 2 * DAY_MS },
      steps: [
        used('plan', 'claude', 'claude-opus-4-1', 900_000, 120_000, 4.1),
        used('implement', 'claude', 'claude-opus-4-1', 1_200_000, 200_000, 6.3),
      ],
    },
    {
      row: { title: 'cross-vendor review', folder: 'C:\\work\\api', status: 'completed', ageMs: 3 * HOUR_MS },
      steps: [
        used('implement', 'codex', 'gpt-5-codex', 700_000, 90_000, 1.4),
        used('review', 'claude', 'claude-sonnet-4-5', 150_000, 20_000, 0.6),
        // A step on the CLI's default model that reported no tokens: it counts toward Claude, with no Plop of its own.
        {
          key: 'critic',
          vendor: 'claude',
          model: null,
          status: 'done',
          activeMs: 500,
          usage: { input: 0, output: 0 },
        },
      ],
    },
  ]
  const out = rows.map((r, i) => ({ ...seededSummary(r.row, i + 1, now), steps: r.steps }))
  const runs = join(home, 'runs')
  mkdirSync(runs, { recursive: true })
  writeFileSync(
    join(runs, 'index.jsonl'),
    out.map((s) => JSON.stringify({ v: 1, op: 'put', s })).join('\n') + '\n',
  )
  return out
}

test('opens Plops, switches 30 and 7 days, and drills into a vendor', async ({ e2e }) => {
  test.setTimeout(180_000)
  seed(e2e.home, Date.now())
  const page = await e2e.start()

  // Core answers the same lineup the page shows.
  const month = await e2e.call('usage.get', { range: '30d' })
  expect(month.vendors.map((v) => v.vendor)).toEqual(['claude', 'codex', 'gemini'])
  expect(month.vendors[0]?.models.map((m) => m.model)).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5'])
  // The default-model step with no tokens is Claude's (four steps) but not a model of its own.
  expect(month.vendors[0]?.steps).toBe(4)
  expect(month.vendors[2]?.failedSteps).toBe(1)
  // Seven days: Gemini and gpt-5 have no tokens in the period but did before (puddles).
  const week = await e2e.call('usage.get', { range: '7d' })
  expect(week.vendors.map((v) => [v.vendor, v.tokens > 0])).toEqual([
    ['claude', true],
    ['codex', true],
    ['gemini', false],
  ])
  expect(week.vendors[2]?.lifetimeTokens).toBe(46_000)
  expect(week.vendors[1]?.models.map((m) => [m.model, m.tokens, m.lifetimeTokens])).toEqual([
    ['gpt-5-codex', 790_000, 790_000],
    ['gpt-5', 0, 340_000],
  ])

  // ---- from the sidebar: Plops sits above Settings at the foot ----
  const nav = page.getByTestId('nav-plops')
  const settings = page.getByTestId('nav-settings')
  const [navBox, settingsBox] = [await nav.boundingBox(), await settings.boundingBox()]
  expect(navBox !== null && settingsBox !== null && navBox.y < settingsBox.y).toBe(true)
  await nav.click()
  await expect(page).toHaveURL(/#\/plops$/)
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const vendors = page.getByTestId('plops-vendors')
  await expect(vendors).toHaveAttribute('data-status', 'ready')
  const r30 = page.getByTestId('plops-range-30d')
  const r7 = page.getByTestId('plops-range-7d')
  await expect(r30).toHaveAttribute('aria-pressed', 'true')
  for (const v of ['claude', 'codex', 'gemini'])
    await expect(page.getByTestId(`plops-vendor-${v}`)).toBeVisible()
  await expect(page.getByTestId('plops-vendor-claude')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('plops-models')).toHaveAttribute('data-vendor', 'claude')
  // Each Plop is an image named for its model and its usage (usage up on the empty period before: it grew into Mega,
  // plays growing once, then rests happy).
  const claudeImg = page.getByTestId('plops-vendor-claude').getByRole('img')
  await expect(claudeImg).toHaveAttribute(
    'aria-label',
    /^Claude: 2\.59M tokens, \$11\.00( API-equivalent)?\. Mega Plop, (growing|happy)$/,
  )
  // Gemini's only run failed a step: it leaks oil.
  await expect(page.getByTestId('plops-vendor-plop-gemini')).toHaveAttribute('data-emit', 'oil')

  // ---- 7 days: Gemini and gpt-5 melt into puddles; the period buttons keep their size ----
  const sizes = async (): Promise<string> =>
    JSON.stringify(
      await Promise.all(
        [r30, r7].map(async (b) => {
          const box = await b.boundingBox()
          return box === null ? null : [Math.round(box.width), Math.round(box.height)]
        }),
      ),
    )
  const before = await sizes()
  await r7.click()
  await expect(r7).toHaveAttribute('aria-pressed', 'true')
  await expect(r30).toHaveAttribute('aria-pressed', 'false')
  await expect(vendors).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('plops-summary')).toContainText('last 7 days')
  expect(await sizes()).toBe(before)
  const geminiPlop = page.getByTestId('plops-vendor-plop-gemini')
  await expect(geminiPlop).toHaveAttribute('data-mood', 'puddle')
  await expect(geminiPlop).toHaveAttribute('data-emit', 'none')
  await expect(geminiPlop.getByRole('img')).toHaveAttribute(
    'aria-label',
    /^Gemini: 0 tokens, \$0\.00\. \w+ Plop, puddle \(used before, no tokens in this period\)$/,
  )
  await expect(geminiPlop.locator('[data-plop-part="puddle"]')).toHaveCount(1)
  // The puddle lies in the same tile on the same floor as the Plops beside it.
  const tileOf = async (id: string): Promise<number[]> => {
    const t = await page.getByTestId(`plops-vendor-${id}`).boundingBox()
    const s = await page.getByTestId(`plops-vendor-plop-${id}`).locator('svg').boundingBox()
    return [t?.y, t?.width, t?.height, s?.y, s?.height].map((n) => Math.round(n ?? -1))
  }
  expect(await tileOf('gemini')).toEqual(await tileOf('claude'))
  // Nothing moves on its own: it holds its pose (no snack, no growth spurt) while the page is open.
  const geminiBox = await tileOf('gemini')
  await page.waitForTimeout(3000)
  await expect(geminiPlop).toHaveAttribute('data-mood', 'puddle')
  await expect(geminiPlop).toHaveAttribute('data-snack', 'none')
  expect(await tileOf('gemini')).toEqual(geminiBox)
  // Codex's gpt-5 is a puddle on the models' floor.
  await page.getByTestId('plops-vendor-codex').click()
  await expect(page.getByTestId('plops-model-plop-1')).toHaveAttribute('data-mood', 'puddle')
  await expect(page.getByTestId('plops-model-plop-1').getByRole('img')).toHaveAttribute(
    'aria-label',
    /^gpt-5: 0 tokens/,
  )
  // Legend: what a puddle means.
  await expect(page.getByText('Puddle', { exact: true })).toBeVisible()

  // ---- back to 30 days, then drill into Codex ----
  await r30.click()
  await expect(page.getByTestId('plops-vendor-gemini')).toBeVisible()
  await page.getByTestId('plops-vendor-codex').click()
  await expect(page.getByTestId('plops-vendor-codex')).toHaveAttribute('aria-pressed', 'true')
  const models = page.getByTestId('plops-models')
  await expect(models).toHaveAttribute('data-vendor', 'codex')
  await expect(models.getByRole('heading')).toHaveText('Codex by model')
  const labels = await models
    .getByRole('img')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  expect(labels.map((l) => l.split(':')[0])).toEqual(['All Codex', 'gpt-5-codex', 'gpt-5'])
  expect(labels.join(' ')).not.toContain('\u2014')
  expect(e2e.pageErrors).toEqual([])
})
