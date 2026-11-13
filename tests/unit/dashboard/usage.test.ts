// Usage per vendor and model for the Plops page (src/core/dashboard/usage.ts, `usage.get{range}`): the 7- and 30-day
// periods by createdAt with the previous period of equal length, tokens and cost from the steps' final attempts (null
// when unpriced), and the signals the moods and emissions read (failed steps, re-runs, limit hits, live steps, last
// use). Also the command itself through createHandlers.
import { describe, expect, it } from 'vitest'
import { DAY_MS } from '@core/dashboard/stats.ts'
import type { SpendPricing } from '@core/dashboard/stats.ts'
import { buildUsage } from '@core/dashboard/usage.ts'
import { createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { DashboardDeps } from '@core/handlers-dashboard.ts'
import type { RunSummary, RunSummaryStep } from '@shared/run.ts'
import { MIN, run, step, usage } from '../estimates/helpers.ts'

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)
const H = 3_600_000

/** stepUsd = usage.costUsd (a stand-in for the vendor's figure or the catalog's). */
const pricing = (subscription: string[] = []): SpendPricing => ({
  stepUsd: (row) => row.usage?.costUsd ?? null,
  apiEquivalent: (v) => subscription.includes(v),
})

/** A finished run created `ageMs` before NOW (ended 10 minutes after it started). */
const at = (ageMs: number, steps: RunSummaryStep[], over: Partial<RunSummary> = {}): RunSummary =>
  run(steps, { createdAt: NOW - ageMs, endedAt: NOW - ageMs + 10 * MIN, ...over })

const row = (
  vendor: string,
  model: string | null,
  input: number,
  usd?: number,
  over: Partial<RunSummaryStep> = {},
): RunSummaryStep =>
  step('implement', 1, {
    vendor,
    model,
    usage: usage(input, 0, usd !== undefined ? { costUsd: usd } : {}),
    ...over,
  })

describe('buildUsage: periods', () => {
  it('counts runs created in the last 7 or 30 days, and the period before as `previous`', () => {
    const runs = [
      at(1 * DAY_MS, [row('claude', 'opus', 100, 1)]),
      at(6 * DAY_MS, [row('claude', 'opus', 200, 2)]),
      at(8 * DAY_MS, [row('claude', 'opus', 400, 4)]),
      at(20 * DAY_MS, [row('claude', 'opus', 800, 8)]),
      at(45 * DAY_MS, [row('claude', 'opus', 1600, 16)]),
      at(70 * DAY_MS, [row('claude', 'opus', 3200, 32)]),
    ]
    const w = buildUsage(runs, '7d', NOW, pricing())
    expect(w.from).toBe(NOW - 7 * DAY_MS)
    expect(w.to).toBe(NOW)
    expect(w.totals).toEqual({ tokens: 300, costUsd: 3, costPartial: false, runs: 2 })
    // The 7 days before: day 8 only.
    expect(w.previous).toEqual({ tokens: 400, costUsd: 4, costPartial: false, runs: 1 })
    const m = buildUsage(runs, '30d', NOW, pricing())
    expect(m.totals.tokens).toBe(1500)
    // Days 30 to 60: the 45-day run only.
    expect(m.previous.tokens).toBe(1600)
    expect(m.vendors[0]?.previous.tokens).toBe(1600)
  })

  it('a run on the boundary belongs to the current period', () => {
    const w = buildUsage([at(7 * DAY_MS, [row('claude', 'opus', 5)])], '7d', NOW, pricing())
    expect(w.totals.tokens).toBe(5)
    expect(w.previous.tokens).toBe(0)
  })
})

describe('buildUsage: vendors and models', () => {
  it('groups tokens (input, output and cache) and cost per vendor and per model, largest first', () => {
    const runs = [
      at(H, [
        row('claude', 'claude-opus-4-1', 1000, 1.5),
        row('claude', 'claude-sonnet-4-5', 300, 0.25, { key: 'review' }),
        step('critic', 1, {
          vendor: 'codex',
          model: 'gpt-5-codex',
          usage: usage(100, 50, { cacheRead: 30, cacheWrite: 20, costUsd: 0.1 }),
        }),
        step('verify:1', 1, { usage: usage(9999, 0) }),
      ]),
      at(2 * H, [row('claude', 'claude-opus-4-1', 500, 0.5)]),
    ]
    const d = buildUsage(runs, '7d', NOW, pricing())
    expect(d.vendors.map((v) => [v.vendor, v.tokens, v.costUsd, v.runs])).toEqual([
      ['claude', 1800, 2.25, 2],
      ['codex', 200, 0.1, 1],
    ])
    expect(d.vendors[0]?.models.map((m) => [m.model, m.tokens, m.costUsd, m.runs, m.steps])).toEqual([
      ['claude-opus-4-1', 1500, 2, 2, 2],
      ['claude-sonnet-4-5', 300, 0.25, 1, 1],
    ])
    // A runner step (no vendor) is not usage of an AI model.
    expect(d.totals.tokens).toBe(2000)
  })

  it('cost is null when nothing was priced, and partial when only some steps were', () => {
    const d = buildUsage(
      [at(H, [row('claude', 'opus', 100, 1), row('claude', 'haiku', 50)]), at(H, [row('grok', null, 10)])],
      '7d',
      NOW,
      pricing(),
    )
    const claude = d.vendors.find((v) => v.vendor === 'claude')
    expect(claude).toMatchObject({ costUsd: 1, costPartial: true })
    expect(claude?.models.find((m) => m.model === 'haiku')).toMatchObject({
      costUsd: null,
      costPartial: false,
    })
    const grok = d.vendors.find((v) => v.vendor === 'grok')
    expect(grok).toMatchObject({ costUsd: null, costPartial: false })
    // The vendor's default model has no id.
    expect(grok?.models[0]?.model).toBeNull()
  })

  it('a vendor or model with tokens only before the period is listed with none in it (a puddle), after the rest', () => {
    const d = buildUsage(
      [
        at(H, [row('claude', 'opus', 10)]),
        at(10 * DAY_MS, [row('gemini', 'pro', 99), row('claude', 'haiku', 7)]),
        // Long before both periods: still lifetime usage.
        at(400 * DAY_MS, [row('claude', 'haiku', 1000), row('grok', 'grok-4', 5)]),
      ],
      '7d',
      NOW,
      pricing(),
    )
    expect(d.vendors.map((v) => [v.vendor, v.tokens, v.lifetimeTokens])).toEqual([
      ['claude', 10, 1017],
      ['gemini', 0, 99],
      ['grok', 0, 5],
    ])
    expect(d.vendors[0]?.models.map((m) => [m.model, m.tokens, m.lifetimeTokens])).toEqual([
      ['opus', 10, 10],
      ['haiku', 0, 1007],
    ])
    expect(d.vendors[0]?.previous.tokens).toBe(7)
    // Only the period counts toward the totals.
    expect(d.totals.tokens).toBe(10)
    expect(d.vendors[1]).toMatchObject({ steps: 0, runs: 0, costUsd: null, previous: { tokens: 99 } })
  })

  it('a run created after now is not counted, not even toward the lifetime tokens', () => {
    const d = buildUsage([at(-H, [row('claude', 'opus', 10)])], '7d', NOW, pricing())
    expect(d.vendors).toEqual([])
  })

  it('a model that never reported tokens is folded into its vendor and not listed on its own', () => {
    const d = buildUsage(
      [
        at(H, [
          row('claude', 'opus', 100, 1),
          // The CLI's default model, a step that sent no usage figures and one that sent zeros.
          step('review', 1, { vendor: 'claude', model: null, status: 'failed', failureCategory: 'network' }),
          step('critic', 1, { vendor: 'claude', model: null, usage: usage(0, 0) }),
        ]),
        // A vendor whose only steps never reported tokens: listed (its signals), with no models.
        at(H, [step('implement', 1, { vendor: 'gemini', model: null, status: 'failed' })]),
      ],
      '7d',
      NOW,
      pricing(),
    )
    const claude = d.vendors.find((v) => v.vendor === 'claude')
    expect(claude?.models.map((m) => m.model)).toEqual(['opus'])
    // Its steps still count toward the vendor: three steps, one failed.
    expect(claude).toMatchObject({ tokens: 100, steps: 3, failedSteps: 1, lifetimeTokens: 100 })
    const gemini = d.vendors.find((v) => v.vendor === 'gemini')
    expect(gemini).toMatchObject({ tokens: 0, lifetimeTokens: 0, failedSteps: 1, models: [] })
  })

  it('marks a subscription vendor with a price as API-equivalent', () => {
    const d = buildUsage([at(H, [row('claude', 'opus', 10, 1)])], '7d', NOW, pricing(['claude']))
    expect(d.vendors[0]?.apiEquivalent).toBe(true)
    const none = buildUsage([at(H, [row('claude', 'opus', 10)])], '7d', NOW, pricing(['claude']))
    expect(none.vendors[0]?.apiEquivalent).toBe(false)
  })

  it('no runs: empty lineup and zero totals', () => {
    const d = buildUsage([], '30d', NOW, pricing())
    expect(d.vendors).toEqual([])
    expect(d.totals).toEqual({ tokens: 0, costUsd: null, costPartial: false, runs: 0 })
  })
})

describe('buildUsage: signals', () => {
  it('counts failed steps, re-runs and limit hits in the last 24 hours', () => {
    const runs = [
      at(
        2 * H,
        [row('claude', 'opus', 10, undefined, { status: 'failed', failureCategory: 'rate_limited' })],
        {
          status: 'failed',
        },
      ),
      at(3 * DAY_MS, [
        step('implement', 1, {
          vendor: 'claude',
          model: 'opus',
          status: 'failed',
          failureCategory: 'billing',
        }),
      ]),
      at(H, [row('claude', 'opus', 10)], { rerunOf: { runId: 'run-x', displayNo: 1, from: 'start' } }),
    ]
    const d = buildUsage(runs, '7d', NOW, pricing())
    const opus = d.vendors[0]?.models[0]
    expect(opus).toMatchObject({ failedSteps: 2, reruns: 1, limitHits24h: 1, steps: 3 })
  })

  it('live steps in an active run, and lastUsedAt (now while active, else the end)', () => {
    const active = run([row('codex', 'gpt-5', 0, undefined, { status: 'running' })], {
      status: 'running',
      createdAt: NOW - 5 * MIN,
    })
    delete active.endedAt
    const done = at(30 * H, [row('claude', 'opus', 10)])
    const d = buildUsage([active, done], '7d', NOW, pricing())
    const codex = d.vendors.find((v) => v.vendor === 'codex')
    expect(codex).toMatchObject({ live: 1, lastUsedAt: NOW })
    const claude = d.vendors.find((v) => v.vendor === 'claude')
    expect(claude).toMatchObject({ live: 0, lastUsedAt: NOW - 30 * H + 10 * MIN })
  })

  it('a queued step without usage is not counted', () => {
    const d = buildUsage(
      [at(H, [step('fix', 1, { vendor: 'claude', model: 'opus', status: 'queued' })])],
      '7d',
      NOW,
      pricing(),
    )
    expect(d.vendors).toEqual([])
  })
})

describe('usage.get', () => {
  const ctx = (summaries: RunSummary[], withDeps: boolean): HandlerContext =>
    ({
      now: () => NOW,
      summaries: () => summaries,
      ...(withDeps
        ? {
            dashboard: {
              attention: () => ({ needsYou: 0, items: [] }),
              vendorHealth: () => [],
              catalogStatus: () => Promise.reject(new Error('unused')),
              pricing: pricing(),
              estimate: () => Promise.reject(new Error('unused')),
            } satisfies DashboardDeps,
          }
        : {}),
    }) as unknown as HandlerContext

  it('answers the range asked for from the summaries', async () => {
    const h = createHandlers(ctx([at(H, [row('claude', 'opus', 42, 0.5)])], true))
    const r = await dispatch(h, 'usage.get', { range: '30d' })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.range).toBe('30d')
    expect(r.value.vendors[0]).toMatchObject({ vendor: 'claude', tokens: 42, costUsd: 0.5 })
  })

  it('refuses a range it does not keep, and answers UNSUPPORTED without the dashboard deps', async () => {
    const h = createHandlers(ctx([], true))
    const bad = await dispatch(h, 'usage.get', { range: '24h' } as never)
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
    const none = await dispatch(createHandlers(ctx([], false)), 'usage.get', { range: '7d' })
    expect(none.ok ? null : none.error.code).toBe('UNSUPPORTED')
  })
})
