// estimates.get, dashboard.get, stats.get and folders.recent through a real core (src/core/app-core.ts,
// handlers-dashboard.ts; estimates and the Dashboard's data): a home with four finished runs in its index, the
// config resolved as runs.start would, model:null priced as the probe's default model once a probe ran, and a fifth
// run finishing for real moves the estimate from the prior to "from 5 runs" through the index's own update.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { RunEstimate } from '../../../src/shared/estimates.ts'
import type { RunSummary, RunSummaryStep } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

async function until(pred: () => boolean | Promise<boolean>, ms = 90_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 200))
  }
}

const S = 1000
const DAY = 86_400_000

/** A finished claude-only run two days ago (plan, implement with usage, two clean reviewers). */
function seeded(n: number, folder: string): RunSummary {
  const row = (
    key: RunSummaryStep['key'],
    model: string | null,
    mode: RunSummaryStep['mode'],
    activeMs: number,
  ) =>
    ({
      key,
      vendor: 'claude',
      model,
      ...(mode !== undefined ? { mode } : {}),
      status: 'done',
      activeMs,
      usage: { input: 1000, output: 200, costUsd: 0.1 },
      costBasis: 'vendor',
    }) satisfies RunSummaryStep
  const createdAt = Date.now() - 2 * DAY + n * 60_000
  return {
    runId: `20261001T00000${n}Z-seed`,
    displayNo: n,
    folder,
    folderKey: 'seededfolderkey0',
    title: `seeded ${n}`,
    status: 'completed',
    phase: 'done',
    outcome: 'clean',
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt,
    endedAt: createdAt + 5 * 60_000,
    progress: { tokens: 4800, costUsd: 0.5, filesChanged: 1 },
    findings: { must: 0, should: 0 },
    steps: [
      row('plan', 'opus', 'readonly', 30 * S),
      row('implement', null, 'autoedit', 120 * S),
      row('review', 'sonnet', 'readonly', 40 * S),
      row('critic', 'opus', 'readonly', 45 * S),
    ],
  }
}

describe('estimates and dashboard data through the core', () => {
  it('priors below five runs, "from 5 runs" after a fifth one finishes; model:null priced once probed', async () => {
    const sc = await makeScenario({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
      ],
    })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const elsewhere = join(home, 'gone-folder')
    const paths = homePaths(home)
    mkdirSync(paths.runsDir, { recursive: true })
    writeFileSync(
      paths.runIndex,
      [1, 2, 3, 4].map((n) => `${JSON.stringify({ v: 1, op: 'put', s: seeded(n, elsewhere) })}\n`).join(''),
    )

    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    cores.push(core)
    const estimate = async (): Promise<RunEstimate> => {
      const r = await core.invoke('estimates.get', { folder })
      if (!r.ok) throw new Error(r.error.message)
      return r.value
    }

    // Four runs: below the n ≥ 5 threshold everywhere. No probe yet: the CLI default model has no price.
    const before = await estimate()
    expect(Object.keys(before.steps)).toEqual(['plan', 'implement', 'review', 'critic', 'fix'])
    expect(before.steps.plan).toMatchObject({ level: 'prior', durationMs: { p50: 36 * S, p80: 60 * S } })
    expect(before.total.basis).toBe('typical (no history yet)')
    expect(before.total.missingPricing).toEqual(['claude/default'])
    expect(before.pFix).toEqual({ value: 0.6, basis: 'prior' })
    // Overrides resolve like runs.start: Critic off leaves it out.
    const noCritic = await core.invoke('estimates.get', {
      folder,
      overrides: { passes: { critic: { enabled: false } } },
    })
    expect(noCritic.ok && Object.keys(noCritic.value.steps)).toEqual(['plan', 'implement', 'review', 'fix'])
    const bad = await core.invoke('estimates.get', { folder, overrides: { passes: { nope: {} } } as never })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')

    // The probe names the CLI default (claude-opus-5-5, priced in the seed catalog).
    const probed = await core.invoke('vendors.probe', { vendor: 'claude' })
    expect(probed.ok).toBe(true)
    expect((await estimate()).total.missingPricing).toEqual([])

    // A fifth run, for real.
    const r = await core.invoke('runs.start', {
      folder,
      task: 'add a --version flag',
      overrides: { gates: { afterPlan: false } },
    })
    if (!r.ok) throw new Error(r.error.message)
    const c = core.controller(r.value.runId)
    if (c === undefined) throw new Error('no controller')
    expect(core.summary(r.value.runId)?.progress.etaMs).toBeGreaterThan(0)
    const done = await c.waitFor((s) => s.status === 'completed' || s.status === 'failed', 90_000)
    expect(done.status).toBe('completed')
    await until(async () => (await estimate()).steps.plan?.level === 'exact')
    const after = await estimate()
    expect(after.steps.plan).toMatchObject({
      level: 'exact',
      samples: 5,
      basis: 'from 5 runs (claude · opus · readonly)',
    })
    // Implement (model:null) is priced at the default model's catalog price.
    expect(after.steps.implement).toMatchObject({ level: 'exact', samples: 5, missingPricing: [] })
    expect(after.steps.implement?.costUsd?.p50).toBeGreaterThan(0)
    // Fix never ran: still its prior, and the total says so.
    expect(after.steps.fix?.level).toBe('prior')
    expect(after.total.basis).toBe('from 5 runs (some steps typical)')
    expect(core.summary(r.value.runId)?.progress.etaMs).toBeUndefined()

    // dashboard.get / stats.get / folders.recent over the same five runs.
    const dash = await core.invoke('dashboard.get')
    if (!dash.ok) throw new Error(dash.error.message)
    expect(dash.value.active).toEqual([])
    expect(dash.value.recent.map((s) => s.runId)[0]).toBe(r.value.runId)
    expect(dash.value.recent).toHaveLength(5)
    expect(dash.value.totals.today).toMatchObject({ runs: 1, completed: 1, failed: 0 })
    expect(dash.value.totals.d7).toMatchObject({ runs: 5, completed: 5, failed: 0 })
    expect(dash.value.spendByVendor7d.map((v) => v.vendor)).toEqual(['claude'])
    expect(dash.value.spendByVendor7d[0]?.costUsd).toBeCloseTo(dash.value.totals.d7.costUsd, 8)
    expect(dash.value.spendByVendor7d[0]?.tokens).toBe(dash.value.totals.d7.tokens)
    const health = await core.invoke('vendors.list')
    expect(health.ok && dash.value.vendorHealth).toEqual(health.ok ? health.value : null)
    expect(dash.value.catalog.pricingUpdatedAt).toBeGreaterThan(0)
    expect(dash.value.catalog.jobRunning).toBe(false)

    const stats = await core.invoke('stats.get', { range: '7d' })
    expect(stats.ok && stats.value).toMatchObject({ runs: 5, completed: 5, failed: 0, successRate: 1 })

    const folders = await core.invoke('folders.recent')
    if (!folders.ok) throw new Error(folders.error.message)
    expect(folders.value).toEqual([
      expect.objectContaining({ folder, isGit: true, exists: true, scopeRoot: folder }),
      expect.objectContaining({ folder: elsewhere, isGit: false, exists: false, scopeRoot: null }),
    ])
  }, 180_000)
})
