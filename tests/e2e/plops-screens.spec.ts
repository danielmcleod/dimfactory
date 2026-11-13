// plops-screens.spec.ts: screenshots of the Plops page's animation states for review (not a gate; it asserts only what it
// needs to reach each state). Runs when PLOPS_SCREENS=1 and writes PNGs to test-results/plops-screens/ (git-ignored;
// Playwright clears test-results at the start of a run, so run this spec last).
//
// Deterministic frames: Math.random is replaced with a seeded generator and Playwright's clock drives the page's
// timers (paused, then stepped with runFor), so the snack, the growth spurt and each rotation item land at known
// points. The SVG loops themselves run on the document's own clock, so a frame's exact pose inside a loop may vary.
//
// The home: earlier runs with usage for Claude, Codex and Gemini (a failed step: oil) and Grok (a rate limit two hours
// ago: steam), Mistral 45 days ago only (a puddle on 30 days; Gemini and gpt-5 are puddles on 7 days), plus one live
// run whose Implement step is parked (Claude: running now, so it rotates). Codex, used in the last day with nothing
// to show (no run, no oil, no steam), snacks now and then at rest.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { RunSummary, RunSummaryStep } from '../../src/shared/run.ts'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { DAY_MS, seededSummary } from './history-helpers.ts'
import type { SeedRow } from './history-helpers.ts'
import { PARKED_IMPLEMENT } from './scenarios.ts'

const OUT = join(REPO_ROOT, 'test-results', 'plops-screens')
const HOUR_MS = 3_600_000
// Kept in step with src/renderer/src/pages/plops (SNACK_MS, GROWING_MS, ROTATE_MAX_MS).
const SNACK_MS: Record<string, number> = { metal: 2400, cord: 3200, bolt: 2200, water: 3000 }
const GROWING_MS = 1400

test.skip(process.env['PLOPS_SCREENS'] === undefined, 'screenshots only: set PLOPS_SCREENS=1')

const used = (
  key: RunSummaryStep['key'],
  vendor: string,
  model: string,
  input: number,
  output: number,
  costUsd: number,
): RunSummaryStep => ({
  key,
  vendor,
  model,
  status: 'done',
  activeMs: 30_000,
  usage: { input, output, costUsd },
  costBasis: 'vendor',
})

function seed(home: string, now: number): void {
  const rows: { row: SeedRow; steps: RunSummaryStep[] }[] = [
    {
      // Used before both periods only: a puddle on 30 days (the design's sixth Plop).
      row: { title: 'mistral review', folder: 'C:\\work\\old', status: 'completed', ageMs: 45 * DAY_MS },
      steps: [used('review', 'mistral', 'mistral-large', 560_000, 80_000, 0.9)],
    },
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
      ],
    },
    {
      row: { title: 'grok quick fix', folder: 'C:\\work\\web', status: 'failed', ageMs: 2 * HOUR_MS },
      steps: [
        used('plan', 'grok', 'grok-4', 60_000, 8_000, 0.12),
        {
          key: 'implement',
          vendor: 'grok',
          model: 'grok-4',
          status: 'failed',
          activeMs: 1000,
          failureCategory: 'rate_limited',
        },
      ],
    },
  ]
  const out: RunSummary[] = rows.map((r, i) => ({ ...seededSummary(r.row, i + 1, now), steps: r.steps }))
  const runs = join(home, 'runs')
  mkdirSync(runs, { recursive: true })
  writeFileSync(
    join(runs, 'index.jsonl'),
    out.map((s) => JSON.stringify({ v: 1, op: 'put', s })).join('\n') + '\n',
  )
}

async function shot(target: Page | Locator, name: string): Promise<string> {
  mkdirSync(OUT, { recursive: true })
  const path = join(OUT, `${name}.png`)
  // The paused page clock starves the main-process heartbeat, so its banner shows; it is not part of the Plops.
  await target.screenshot({
    path,
    animations: 'allow',
    style: '[data-testid="lost-contact"] { display: none !important; }',
  })
  return path
}

/** A Plop's current frame, as its data attributes give it: mood/snack/emit. */
async function frame(page: Page, testId: string): Promise<{ mood: string; snack: string; emit: string }> {
  const el = page.getByTestId(testId)
  return {
    mood: (await el.getAttribute('data-mood')) ?? '',
    snack: (await el.getAttribute('data-snack')) ?? '',
    emit: (await el.getAttribute('data-emit')) ?? '',
  }
}

/** Seeded Math.random (mulberry32) for every load of the page. */
const SEED_SCRIPT = `(() => {
  let a = 20261024 >>> 0
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
})()`

test('every Plops animation state, captured', async ({ e2e }) => {
  test.setTimeout(240_000)
  const written: string[] = []
  seed(e2e.home, Date.now())
  const page = await e2e.start({ scenario: PARKED_IMPLEMENT })
  // The composer by hand (runFromDashboard expects the only run in the home; this one has the seeded ones too).
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const runId = decodeURIComponent(page.url().split('#/runs/')[1] ?? '')
  await e2e.approvePlan()
  await e2e.waitForLiveProc(runId, 'implement')
  await e2e.call('ui.setTheme', { theme: 'light' })

  // Seeded random and a page clock we step by hand, from a fresh load (the run keeps going in core).
  await page.addInitScript(SEED_SCRIPT)
  await page.clock.install()
  await page.reload()
  await page.waitForFunction(() => '__dimFactoryE2E' in window, null, { timeout: 60_000 })
  const t0 = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(t0 + 1000)
  await page.evaluate(() => {
    window.location.hash = '#/plops'
  })
  await expect(page.getByTestId('plops-vendors')).toHaveAttribute('data-status', 'ready')
  const claude = 'plops-vendor-plop-claude'
  const claudeTile = page.getByTestId('plops-vendor-claude')
  await expect(page.getByTestId('plops-vendor-plop-gemini')).toHaveAttribute('data-emit', 'oil')
  await expect(page.getByTestId('plops-vendor-plop-grok')).toHaveAttribute('data-emit', 'steam')

  // ---- the snack before growth, then the growth spurt (every Plop here is new this period, so each grew) ----
  const pre = await frame(page, claude)
  expect(pre.snack).not.toBe('none')
  written.push(await shot(claudeTile, `07-pregrowth-1-snack-${pre.snack}`))
  written.push(await shot(page, `07-pregrowth-1-snack-lineup`))
  await page.clock.runFor(SNACK_MS[pre.snack] ?? 3200)
  await expect(page.getByTestId(claude)).toHaveAttribute('data-mood', 'growing')
  written.push(await shot(claudeTile, '08-pregrowth-2-growing'))
  written.push(await shot(page, '08-pregrowth-2-growing-lineup'))
  await page.clock.runFor(GROWING_MS)
  await expect(page.getByTestId(claude)).not.toHaveAttribute('data-mood', 'growing')

  // ---- the rotation while Claude's step runs: frames until gas, smoke and two snacks have all shown ----
  const seen = new Set<string>()
  const snacks = new Set<string>()
  const emits = new Set<string>()
  let n = 0
  let last = ''
  for (let i = 0; i < 400 && (n < 3 || !emits.has('gas') || !emits.has('smoke') || snacks.size < 2); i++) {
    const f = await frame(page, claude)
    const k = `${f.snack}-${f.emit}`
    if (k !== last && !seen.has(k)) {
      seen.add(k)
      if (f.snack !== 'none') snacks.add(f.snack)
      if (f.emit !== 'none') emits.add(f.emit)
      n++
      const label = [f.snack !== 'none' ? `snack-${f.snack}` : '', f.emit !== 'none' ? f.emit : '']
        .filter((s) => s !== '')
        .join('-plus-')
      written.push(await shot(claudeTile, `06-active-rotation-${String(n).padStart(2, '0')}-${label}`))
    }
    last = k
    await page.clock.runFor(500)
  }
  expect(n).toBeGreaterThanOrEqual(3)
  expect([...emits].sort()).toEqual(['gas', 'smoke'])

  // ---- Plops in use snack now and then at rest: Codex (used 3 hours ago) mid-snack; Grok (steam) never does ----
  const idle = ['codex']
  const caught = new Set<string>()
  let lineupShot = false
  for (let i = 0; i < 600 && (caught.size < 3 || !lineupShot); i++) {
    await expect(page.getByTestId('plops-vendor-plop-grok')).toHaveAttribute('data-snack', 'none')
    let eating = 0
    for (const v of idle) {
      const f = await frame(page, `plops-vendor-plop-${v}`)
      if (f.snack === 'none') continue
      eating++
      expect(f.mood).not.toBe('growing')
      const k = `${v}-${f.snack}`
      if (caught.has(k) || caught.size >= 3) continue
      caught.add(k)
      written.push(await shot(page.getByTestId(`plops-vendor-${v}`), `16-in-use-snack-${k}`))
    }
    if (eating > 0 && !lineupShot) {
      lineupShot = true
      written.push(await shot(page.getByTestId('plops-vendors'), '16-in-use-snack-lineup'))
    }
    await page.clock.runFor(500)
  }
  expect(caught.size).toBeGreaterThanOrEqual(2)
  expect(lineupShot).toBe(true)

  // ---- oil and steam (they never rotate) ----
  written.push(await shot(page.getByTestId('plops-vendor-gemini'), '09-oil-gemini'))
  written.push(await shot(page.getByTestId('plops-vendor-grok'), '10-steam-grok'))

  // ---- a puddle: used before, no tokens in the period (it never rotates, eats or grows) ----
  const mistral = page.getByTestId('plops-vendor-plop-mistral')
  await expect(mistral).toHaveAttribute('data-mood', 'puddle')
  written.push(await shot(page.getByTestId('plops-vendor-mistral'), '13-puddle-mistral'))
  await page.clock.runFor(2250)
  written.push(await shot(page.getByTestId('plops-vendor-mistral'), '13-puddle-mistral-ripple'))
  await expect(mistral).toHaveAttribute('data-mood', 'puddle')
  await expect(mistral).toHaveAttribute('data-snack', 'none')

  // ---- the lineup, light and dark, and the 30-day period ----
  written.push(await shot(page, '01-lineup-light'))
  written.push(await shot(page.getByTestId('plops-vendors'), '03-period-30-days'))
  await e2e.call('ui.setTheme', { theme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  written.push(await shot(page, '02-lineup-dark'))
  await e2e.call('ui.setTheme', { theme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // ---- 7 days (new keys: those Plops eat and grow again; let them settle) ----
  await page.getByTestId('plops-range-7d').click()
  await expect(page.getByTestId('plops-summary')).toContainText('last 7 days')
  await expect(page.getByTestId('plops-vendors')).toHaveAttribute('data-status', 'ready')
  await page.clock.runFor(6000)
  written.push(await shot(page.getByTestId('plops-vendors'), '04-period-7-days'))
  // Gemini and gpt-5 ran only before these 7 days: puddles, in the lineup and on Codex's models' floor.
  await expect(page.getByTestId('plops-vendor-plop-gemini')).toHaveAttribute('data-mood', 'puddle')
  written.push(await shot(page.getByTestId('plops-vendor-gemini'), '14-puddle-7-days-gemini'))
  await page.getByTestId('plops-vendor-codex').click()
  await expect(page.getByTestId('plops-model-plop-1')).toHaveAttribute('data-mood', 'puddle')
  written.push(await shot(page.getByTestId('plops-models'), '14-puddle-7-days-codex-models'))
  await page.getByTestId('plops-range-30d').click()
  await expect(page.getByTestId('plops-vendors')).toHaveAttribute('data-status', 'ready')

  // ---- a vendor drilled into ----
  await page.getByTestId('plops-vendor-codex').click()
  await expect(page.getByTestId('plops-models')).toHaveAttribute('data-vendor', 'codex')
  await page.clock.runFor(6000)
  written.push(await shot(page, '05-vendor-drilled-codex'))
  written.push(await shot(page.getByTestId('plops-models'), '05-vendor-drilled-codex-models'))

  // ---- reduced motion: one still pose that still shows running ----
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByTestId('plops-vendor-claude').click()
  await expect(page.getByTestId(claude)).toHaveAttribute('data-snack', 'none')
  const still = await frame(page, claude)
  expect(['gas', 'smoke']).toContain(still.emit)
  written.push(await shot(claudeTile, `11-reduced-motion-still-${still.emit}`))
  written.push(await shot(page, '11-reduced-motion-still-lineup'))
  // A still puddle: no shine pulse, no ripple.
  await expect(page.getByTestId('plops-vendor-plop-mistral')).toHaveAttribute('data-mood', 'puddle')
  expect(
    await page.getByTestId('plops-vendor-plop-mistral').locator('animate, animateTransform').count(),
  ).toBe(0)
  written.push(await shot(page.getByTestId('plops-vendor-mistral'), '15-puddle-reduced-motion'))
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  expect(e2e.pageErrors).toEqual([])
  console.log(`Plops screenshots:\n${written.join('\n')}`)
})

test('the empty state', async ({ e2e }) => {
  const page = await e2e.start()
  await e2e.call('ui.setTheme', { theme: 'light' })
  await page.evaluate(() => {
    window.location.hash = '#/plops'
  })
  await expect(page.getByTestId('plops-empty')).toBeVisible()
  const path = await shot(page, '12-empty-state')
  expect(e2e.pageErrors).toEqual([])
  console.log(`Plops screenshot: ${path}`)
})
