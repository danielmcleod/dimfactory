// `usage.get{range}` (the Plops page): tokens, cost and runs per vendor and per model over the last 7 or 30 days, with
// the previous period of equal length, plus the signals the Plops' moods and emissions read. Pure over RunSummary rows
// (runs/index.jsonl plus the live runs), like stats.ts.
// Definitions:
//   - a run belongs to a period by its createdAt (stats.ts rangeStart): the current period is [now − N days, now],
//     the previous one [now − 2N days, now − N days).
//   - a step is counted when it has a vendor and either has usage, failed (status failed or a failure category) or
//     is running now. Its tokens are its final attempt's input + output + cache (estimate.ts sampleTokens); its cost
//     is SpendPricing.stepUsd (the vendor's figure, else the catalog's), null when unknown.
//   - a figure's costUsd is the sum over its priced steps, null when none had a price; costPartial says that some
//     step with tokens had none.
//   - runs counts distinct runs; reruns counts the runs started as a re-run of another (RunSummary.rerunOf).
//   - limitHits24h: steps stopped by rate_limited, quota_exceeded or billing in a run that ended (or is active) in the
//     last 24 hours. live: steps running, stalled or waiting in an active run.
//   - lastUsedAt: now for a run still active, else the run's endedAt (createdAt when it has none), over the runs whose
//     step had tokens or is live.
//   - lifetimeTokens: tokens over every run created up to now, whatever the period (a puddle's size on the Plops page).
//   - who is listed: a vendor with a counted step in the period or tokens before it (a puddle: used before, none now);
//     of its models, only those that ever reported tokens. A model that never did (a step on the CLI's default model
//     that sent no usage) counts toward its vendor's figures and signals but is not listed on its own.
import type { FailureCategory } from '../../shared/failure.ts'
import type { PassStatus, RunSummary, RunSummaryStep } from '../../shared/run.ts'
import type {
  ModelUsage,
  UsageData,
  UsageFigures,
  UsageRange,
  UsageSignals,
  VendorUsage,
} from '../../shared/usage.ts'
import { roundUsd } from '../catalog/cost.ts'
import { sampleTokens } from '../estimates/estimate.ts'
import { ACTIVE_STATUSES } from './dashboard.ts'
import type { SpendPricing } from './stats.ts'
import { DAY_MS, rangeStart } from './stats.ts'

const LIMIT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['rate_limited', 'quota_exceeded', 'billing'])
const LIVE_STEP_STATUSES: ReadonlySet<PassStatus> = new Set(['running', 'stalled', 'waiting'])

/** One accumulator per vendor, per model and for the totals. */
class Acc {
  tokens = 0
  usd = 0
  priced = false
  partial = false
  readonly runs = new Set<string>()
  readonly rerunRuns = new Set<string>()
  steps = 0
  failedSteps = 0
  limitHits24h = 0
  live = 0
  lastUsedAt: number | null = null

  figures(): UsageFigures {
    return {
      tokens: this.tokens,
      costUsd: this.priced ? roundUsd(this.usd) : null,
      costPartial: this.priced && this.partial,
      runs: this.runs.size,
    }
  }

  signals(): UsageSignals {
    return {
      steps: this.steps,
      failedSteps: this.failedSteps,
      reruns: this.rerunRuns.size,
      limitHits24h: this.limitHits24h,
      live: this.live,
      lastUsedAt: this.lastUsedAt,
    }
  }
}

/** What one counted step adds (see the header). */
interface StepPart {
  runId: string
  rerun: boolean
  tokens: number
  usd: number | null
  failed: boolean
  limitHit: boolean
  live: boolean
  /** When the run last did work (for lastUsedAt). */
  at: number
}

function add(a: Acc, p: StepPart): void {
  a.tokens += p.tokens
  if (p.usd !== null) {
    a.usd += Math.max(0, p.usd)
    a.priced = true
  } else if (p.tokens > 0) a.partial = true
  a.runs.add(p.runId)
  if (p.rerun) a.rerunRuns.add(p.runId)
  a.steps++
  if (p.failed) a.failedSteps++
  if (p.limitHit) a.limitHits24h++
  if (p.live) a.live++
  if ((p.tokens > 0 || p.live) && (a.lastUsedAt === null || p.at > a.lastUsedAt)) a.lastUsedAt = p.at
}

function stepPart(s: RunSummary, row: RunSummaryStep, now: number, pricing: SpendPricing): StepPart | null {
  if (row.vendor === undefined) return null
  const active = ACTIVE_STATUSES.includes(s.status)
  const failed = row.status === 'failed' || row.failureCategory !== undefined
  const live = active && LIVE_STEP_STATUSES.has(row.status)
  if (row.usage === undefined && !failed && !live) return null
  const at = active ? now : (s.endedAt ?? s.createdAt)
  return {
    runId: s.runId,
    rerun: s.rerunOf !== undefined,
    tokens: row.usage !== undefined ? sampleTokens(row.usage) : 0,
    usd: row.usage !== undefined ? pricing.stepUsd(row) : null,
    failed,
    limitHit:
      row.failureCategory !== undefined && LIMIT_CATEGORIES.has(row.failureCategory) && at >= now - DAY_MS,
    live,
    at,
  }
}

const modelKey = (model: string | null | undefined): string => model ?? ''

interface ModelAcc {
  model: string | null
  acc: Acc
  prev: Acc
  lifetime: number
}

interface VendorAcc {
  acc: Acc
  prev: Acc
  lifetime: number
  models: Map<string, ModelAcc>
}

/** Largest in the period first; among equals (puddles: none in the period), the largest before it. */
const byUsage = (
  a: UsageFigures & { lifetimeTokens: number },
  b: UsageFigures & { lifetimeTokens: number },
): number => b.tokens - a.tokens || (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.lifetimeTokens - a.lifetimeTokens

/** `usage.get{range}`. */
export function buildUsage(
  summaries: readonly RunSummary[],
  range: UsageRange,
  now: number,
  pricing: SpendPricing,
): UsageData {
  const from = rangeStart(range, now) ?? now
  const prevFrom = from - (now - from)
  const totals = new Acc()
  const prevTotals = new Acc()
  const vendors = new Map<string, VendorAcc>()
  const vendorOf = (vendor: string): VendorAcc => {
    let v = vendors.get(vendor)
    if (v === undefined) {
      v = { acc: new Acc(), prev: new Acc(), lifetime: 0, models: new Map() }
      vendors.set(vendor, v)
    }
    return v
  }
  const modelOf = (v: VendorAcc, model: string | null | undefined): ModelAcc => {
    const key = modelKey(model)
    let m = v.models.get(key)
    if (m === undefined) {
      m = { model: model ?? null, acc: new Acc(), prev: new Acc(), lifetime: 0 }
      v.models.set(key, m)
    }
    return m
  }
  for (const s of summaries) {
    if (s.createdAt > now) continue
    const current = s.createdAt >= from
    const previous = s.createdAt >= prevFrom && s.createdAt < from
    for (const row of s.steps) {
      if (row.vendor === undefined) continue
      // Every run up to now counts toward the lifetime tokens, whatever the period.
      if (row.usage !== undefined) {
        const tokens = sampleTokens(row.usage)
        if (tokens > 0) {
          const v = vendorOf(row.vendor)
          v.lifetime += tokens
          modelOf(v, row.model).lifetime += tokens
        }
      }
      if (!current && !previous) continue
      const part = stepPart(s, row, now, pricing)
      if (part === null) continue
      const v = vendorOf(row.vendor)
      const m = modelOf(v, row.model)
      if (current) {
        add(totals, part)
        add(v.acc, part)
        add(m.acc, part)
      } else {
        add(prevTotals, part)
        add(v.prev, part)
        add(m.prev, part)
      }
    }
  }
  const out: VendorUsage[] = []
  for (const [vendor, v] of vendors) {
    if (v.acc.steps === 0 && v.lifetime === 0) continue
    const models: ModelUsage[] = [...v.models.values()]
      // Never any tokens: folded into the vendor (see the header).
      .filter((m) => m.lifetime > 0)
      .map((m) => ({
        model: m.model,
        ...m.acc.figures(),
        ...m.acc.signals(),
        previous: m.prev.figures(),
        lifetimeTokens: m.lifetime,
      }))
      .sort((a, b) => byUsage(a, b) || modelKey(a.model).localeCompare(modelKey(b.model)))
    out.push({
      vendor,
      ...v.acc.figures(),
      ...v.acc.signals(),
      apiEquivalent: v.acc.priced && pricing.apiEquivalent(vendor),
      previous: v.prev.figures(),
      lifetimeTokens: v.lifetime,
      models,
    })
  }
  out.sort((a, b) => byUsage(a, b) || a.vendor.localeCompare(b.vendor))
  return { range, from, to: now, totals: totals.figures(), previous: prevTotals.figures(), vendors: out }
}
