// Step and run estimates. Pure over the aggregate (aggregate.ts) and a price lookup:
//   - each step uses the most specific level with MIN_SUCCESSES successes in its window:
//     (vendor, model, mode, step, bucket) → (vendor, model, step) → (vendor, step) → (step) → prior;
//   - figures are p50/p80 of the successes' activeMs (waits excluded), tokens and cost;
//   - run total = prepare + plan + implement + verify·[implement∈runAfter] + max(review, critic)
//                 + P(fix)·R·(fix + verify·[fix∈runAfter] + recheck), R = Fix until green's expected rounds (1 without
//                 the loop; with it, the mean rounds of the history's looped runs at p50 and their 80th percentile at
//                 p80, else 1 at p50 and the round cap at p80).
// Interpretations:
//   - Level 1's bucket is the step's prompt size (RunSummary.steps[].inBytesBucket, derive.ts). Before a run starts
//     no prompt exists (and `estimates.get` carries no task), so a query without a bucket matches level 1 on
//     (vendor, model, mode, step) across buckets; a caller that knows a step's bucket passes it.
//   - Cost prices every sample's usage at the CURRENT catalog price of the queried model (so a price update applies
//     at once). `model: null` resolves to the probe's default model; without one, or without a price, the
//     step has tokens only, `costUsd: null`, and `missingPricing` names `vendor/model` (`vendor/default`).
//   - Dim Factory's own steps (prepare, verify) spend no tokens: cost and tokens 0. A pass at the prior level uses its
//     token prior (defaults.ts PRIOR_USAGE), priced like samples, so a first run has a cost.
//   - Totals add the steps' p50s (and p80s) term by term; Review ∥ Critic run in parallel, so the duration takes
//     the larger of the two while tokens and cost add both. A total's cost/tokens are unknown when any of its
//     steps' is.
//   - Priors have a spread: the table value is the p80 and the p50 is PRIOR_P50_SHARE of it.
// The persisted form (estimate.json, the frozen estimate of a run) is the only I/O here.
import { join } from 'node:path'
import type { PriceEntry } from '../../shared/catalog.ts'
import type { Usage } from '../../shared/events.ts'
import type {
  Estimate,
  EstimateLevel,
  Percentiles,
  RunEstimate,
  StepEstimate,
} from '../../shared/estimates.ts'
import type { InputBytesBucket, IsolationMode, Mode, PassName, StepKey } from '../../shared/run.ts'
import { catalogCostUsd, roundUsd } from '../catalog/cost.ts'
import { readVersionedJson, writeVersionedJson } from '../store/versions.ts'
import type { EstimateAggregate, StepSample } from './aggregate.ts'
import { sampleKey } from './aggregate.ts'
import {
  PRIOR_MS,
  PRIOR_P50_SHARE,
  PRIOR_USAGE,
  estimateStepOf,
  isRunnerFamily,
  percentile,
  scaleUsage,
} from './defaults.ts'
import type { EstimateStep } from './defaults.ts'

/** The parts of ResolvedConfig an estimate reads (ResolvedConfig is assignable to it). */
type EstimatePass = { enabled: boolean; vendor: string; model: string | null; mode: Mode }

export interface EstimateConfig {
  /**
   * The Security pass is optional here (a config written before the security advisor has none: off), and so are
   * Clarify, Research and Explain (on the Plan pass), the acceptance review (on the Review pass) and Fix until green's
   * rounds and re-check (on the Fix pass).
   */
  passes: Record<Exclude<PassName, 'security' | 'plan' | 'fix' | 'review'>, EstimatePass> & {
    plan: EstimatePass & { clarify?: boolean; clarifyInAuto?: boolean; research?: boolean; explain?: boolean }
    review: EstimatePass & { acceptance?: boolean }
    fix: EstimatePass & { rounds?: number; recheck?: boolean }
    security?: EstimatePass & { recheck?: boolean }
  }
  /** Auto skips Clarify unless `clarifyInAuto`. */
  auto?: boolean
  verify: { enabled: boolean; runAfter: readonly ('implement' | 'fix')[] }
  isolation: { mode: IsolationMode }
  /** Test-first (the Brief): the Tests step (on Implement's config) and its red check, and verify:1 always. */
  testFirst?: boolean
  /** Model routing: a routed step is priced at the model its profile names for it (absent: its pass's). */
  routing?: Partial<Record<string, { model?: string | null | undefined }>>
}

export type PriceRates = Pick<
  PriceEntry,
  'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok'
>

/** The catalog rates a pass's tokens are costed at, or the `vendor/model` tag that has no price. */
export type StepPrice = { rates: PriceRates; reasoningIncludedInOutput: boolean } | { missing: string }

export type PriceLookup = (vendor: string, model: string | null) => StepPrice

export interface StepQuery {
  key: StepKey
  /** Passes only; runner steps (prepare, verify) have none. */
  vendor?: string
  model?: string | null
  mode?: Mode
  /** The step's expected prompt-size bucket, when known. */
  bucket?: InputBytesBucket
}

export interface EstimateInput {
  config: EstimateConfig
  /** The folder's key (P(fix) from its own runs first); null when the scope is unknown. */
  folderKey: string | null
  price: PriceLookup
  /** Expected prompt-size bucket per step, when known (see the header). */
  buckets?: Partial<Record<StepKey, InputBytesBucket>>
}

export const PRIOR_BASIS = 'typical (no history yet)'

export function sampleTokens(u: Usage): number {
  return u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
}

const pct = (values: readonly number[]): Percentiles => ({
  p50: percentile(values, 50),
  p80: percentile(values, 80),
})

const ZERO: Percentiles = { p50: 0, p80: 0 }

function modelLabel(model: string | null | undefined): string {
  return model === null || model === undefined ? 'default model' : model
}

function levelBasis(level: EstimateLevel, n: number, q: StepQuery): string {
  const runs = `from ${n} runs`
  if (q.vendor === undefined) return runs
  switch (level) {
    case 'exact':
      return `${runs} (${[q.vendor, modelLabel(q.model), ...(q.mode !== undefined ? [q.mode] : [])].join(' · ')})`
    case 'model':
      return `${runs} (${q.vendor} · ${modelLabel(q.model)})`
    case 'vendor':
      return `${runs} (${q.vendor}, any model)`
    case 'step':
      return `${runs} (any vendor)`
    case 'prior':
      return PRIOR_BASIS
  }
}

/** One step's estimate: the first level with enough successes, else the prior. */
export function estimateStep(agg: EstimateAggregate, q: StepQuery, price?: PriceLookup): StepEstimate {
  const family = estimateStepOf(q.key)
  const runner = isRunnerFamily(family) || q.vendor === undefined
  const levels: [EstimateLevel, string][] = []
  if (!runner && q.vendor !== undefined) {
    const model = q.model ?? null
    if (q.mode !== undefined) {
      levels.push([
        'exact',
        q.bucket !== undefined
          ? sampleKey.exact(q.vendor, model, q.mode, family, q.bucket)
          : sampleKey.exactAnyBucket(q.vendor, model, q.mode, family),
      ])
    }
    levels.push(['model', sampleKey.model(q.vendor, model, family)])
    levels.push(['vendor', sampleKey.vendor(q.vendor, family)])
  }
  levels.push(['step', sampleKey.step(family)])

  // A missing price is named whatever the history (it stays missing when samples arrive).
  const rate =
    !runner && q.vendor !== undefined && price !== undefined ? price(q.vendor, q.model ?? null) : null
  const missingPricing = rate !== null && 'missing' in rate ? [rate.missing] : []

  for (const [level, key] of levels) {
    const ok = agg.successes(key)
    if (ok === null) continue
    return {
      level,
      ...fromSamples(ok, runner, rate),
      samples: ok.length,
      basis: levelBasis(level, ok.length, q),
      missingPricing,
    }
  }
  return priorStep(family, runner, rate, missingPricing)
}

/** p50 = PRIOR_P50_SHARE of the table's p80 (defaults.ts PRIOR_MS). */
const priorRange = (p80: number): Percentiles => ({ p50: Math.round(p80 * PRIOR_P50_SHARE), p80 })

/** A step without enough history: the priors table, and for a pass its token prior priced at the current rate. */
function priorStep(
  family: EstimateStep,
  runner: boolean,
  rate: StepPrice | null,
  missingPricing: string[],
): StepEstimate {
  const est: StepEstimate = {
    level: 'prior',
    durationMs: priorRange(PRIOR_MS[family]),
    costUsd: runner ? { ...ZERO } : null,
    samples: 0,
    basis: PRIOR_BASIS,
    missingPricing,
  }
  if (runner) {
    est.tokens = { ...ZERO }
    return est
  }
  const u = PRIOR_USAGE[family]
  if (u === undefined) return est
  est.tokens = priorRange(sampleTokens(u))
  if (rate !== null && 'rates' in rate) {
    const cost = (x: Usage): number => catalogCostUsd(x, rate.rates, rate.reasoningIncludedInOutput)
    est.costUsd = { p50: cost(scaleUsage(u, PRIOR_P50_SHARE)), p80: cost(u) }
  }
  return est
}

function fromSamples(
  ok: readonly StepSample[],
  runner: boolean,
  rate: StepPrice | null,
): Pick<Estimate, 'durationMs' | 'costUsd' | 'tokens'> {
  const durationMs = pct(ok.map((x) => x.activeMs))
  if (runner) return { durationMs, costUsd: { ...ZERO }, tokens: { ...ZERO } }
  const used = ok.flatMap((x) => (x.usage !== undefined ? [x.usage] : []))
  if (used.length === 0) return { durationMs, costUsd: null }
  const tokens = pct(used.map(sampleTokens))
  if (rate === null || 'missing' in rate) return { durationMs, costUsd: null, tokens }
  const costs = used.map((u) => catalogCostUsd(u, rate.rates, rate.reasoningIncludedInOutput))
  return { durationMs, costUsd: pct(costs), tokens }
}

// ---- persisted form ----------------------------------------------------------------------------------------------

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isPct = (v: unknown): v is Percentiles =>
  isRec(v) && Number.isFinite(v['p50']) && Number.isFinite(v['p80'])

/** A RunEstimate as persisted, or null when anything is malformed (it is then ignored, never trusted). */
export function parseRunEstimate(v: unknown): RunEstimate | null {
  if (!isRec(v) || !isRec(v['total']) || !isRec(v['steps']) || !isRec(v['pFix'])) return null
  if (!isPct(v['total']['durationMs']) || !Number.isFinite(v['pFix']['value'])) return null
  for (const e of Object.values(v['steps'])) if (!isRec(e) || !isPct(e['durationMs'])) return null
  return v as unknown as RunEstimate
}

/**
 * The estimate frozen at run start lives in `runs/<id>/estimate.json` (`{schemaVersion:1, estimate}`), written
 * with resolved.json before the first spawn. resolved.json has an `estimate` field, but it was pinned to null before
 * estimates existed; the sidecar keeps resolved.json as it was written.
 */
export const ESTIMATE_FILE = 'estimate.json'

export function runEstimateFile(runDir: string): string {
  return join(runDir, ESTIMATE_FILE)
}

export async function writeRunEstimate(runDir: string, estimate: RunEstimate): Promise<void> {
  await writeVersionedJson(runEstimateFile(runDir), { estimate })
}

/** Null when missing (a run from before estimates existed), unreadable or malformed: the run then shows no ETA. */
export async function readRunEstimate(runDir: string): Promise<RunEstimate | null> {
  try {
    const r = await readVersionedJson(runEstimateFile(runDir))
    return r.kind === 'ok' ? parseRunEstimate(r.value['estimate']) : null
  } catch {
    return null
  }
}

// ---- run total -------------------------------------------------------------------------------------------------

/** The steps a run with this config would go through, in order, with what each is looked up by. */
export function plannedSteps(cfg: EstimateConfig): StepQuery[] {
  const pass = (p: Exclude<PassName, 'security'>): StepQuery => {
    const c = cfg.passes[p]
    return { key: p, vendor: c.vendor, model: c.model, mode: c.mode }
  }
  const on = (p: Exclude<PassName, 'security'>): boolean => cfg.passes[p].enabled
  const security = cfg.passes.security?.enabled === true ? cfg.passes.security : undefined
  const verifyAfter = (p: 'implement' | 'fix'): boolean =>
    cfg.verify.enabled && cfg.verify.runAfter.includes(p)
  const out: StepQuery[] = []
  if (cfg.isolation.mode === 'worktree') out.push({ key: 'prepare' })
  // Clarify (on the Plan pass's config) asks before Plan, unless Auto skips it.
  const plan = cfg.passes.plan
  if (on('plan') && plan.clarify === true && (cfg.auto !== true || plan.clarifyInAuto === true))
    out.push({ ...pass('plan'), key: 'clarify' })
  // Research (on the Plan pass's config) before Plan; Auto runs it too (it takes the research card's default).
  if (on('plan') && plan.research === true) out.push({ ...pass('plan'), key: 'research' })
  if (on('plan')) out.push(pass('plan'))
  const testFirst = cfg.testFirst === true
  if (on('implement')) {
    if (testFirst) {
      out.push({ ...pass('implement'), key: 'tests' })
      if (cfg.verify.enabled) out.push({ key: 'verify:red' })
    }
    out.push(pass('implement'))
    if (verifyAfter('implement') || (testFirst && cfg.verify.enabled)) out.push({ key: 'verify:1' })
  }
  // The security advisor: its scan (no tokens) before the reviewers, and its reviewer beside them.
  if (security !== undefined) out.push({ key: 'scan' })
  // The acceptance review (on Review's config, or Critic's, then Plan's) before the reviewers. Counted although it is
  // skipped when the plan lists no criteria: the estimate cannot know.
  if (on('implement') && cfg.passes.review.acceptance === true) {
    const at = on('review') ? 'review' : on('critic') ? 'critic' : on('plan') ? 'plan' : undefined
    if (at !== undefined) out.push({ ...pass(at), key: 'acceptance' })
  }
  if (on('review')) out.push(pass('review'))
  if (on('critic')) out.push(pass('critic'))
  const sec = (key: 'security' | 'recheck'): StepQuery =>
    security !== undefined
      ? { key, vendor: security.vendor, model: security.model, mode: security.mode }
      : { key }
  if (security !== undefined) out.push(sec('security'))
  // Fix only ever runs on findings, which need a reviewer.
  if (on('fix') && (on('review') || on('critic') || security !== undefined)) {
    out.push(pass('fix'))
    if (verifyAfter('fix')) out.push({ key: 'verify:2' })
    // The re-check after Fix (when Fix was given a security [must]), or Fix until green's re-check of the round's
    // [must] findings (on Review's config, or Critic's, without the advisor). Each is one round's: the run total
    // counts them once per expected round (estimateRun).
    const loop = (cfg.passes.fix.rounds ?? 1) > 1 && cfg.passes.fix.recheck !== false
    if (security !== undefined && (security.recheck !== false || loop)) out.push(sec('recheck'))
    else if (loop) {
      const on2 = on('review') ? 'review' : on('critic') ? 'critic' : undefined
      if (on2 !== undefined) out.push({ ...pass(on2), key: 'recheck' })
    }
  }
  // Explain it to me (on Plan's config, or Review's) once the outcome is decided.
  if (on('implement') && plan.explain === true) {
    const at = on('plan') ? 'plan' : on('review') ? 'review' : undefined
    if (at !== undefined) out.push({ ...pass(at), key: 'explain' })
  }
  // Model routing: a routed step runs (and is priced at) the model its profile names for it.
  return out.map((q) => {
    const model = cfg.routing?.[q.key]?.model
    return model !== undefined && q.vendor !== undefined ? { ...q, model } : q
  })
}

interface Sum {
  d: Percentiles
  c: Percentiles | null
  t: Percentiles | null
}

const addP = (a: Percentiles, b: Percentiles, w = 1): Percentiles => ({
  p50: a.p50 + w * b.p50,
  p80: a.p80 + w * b.p80,
})
const maxP = (a: Percentiles, b: Percentiles): Percentiles => ({
  p50: Math.max(a.p50, b.p50),
  p80: Math.max(a.p80, b.p80),
})

/** `a + b·w`, with its own weight for the p50 and the p80 term. */
const addPW = (a: Percentiles, b: Percentiles, w: Percentiles): Percentiles => ({
  p50: a.p50 + w.p50 * b.p50,
  p80: a.p80 + w.p80 * b.p80,
})

/**
 * Add a step's figures (cost and tokens always add; `duration: false` leaves the duration to the caller). `w` weighs
 * the step: one number for both terms, or a weight per term (Fix until green's rounds: expected at p50, more at p80).
 */
function addStep(sum: Sum, e: Estimate, w: number | Percentiles, duration = true): void {
  const wp = typeof w === 'number' ? { p50: w, p80: w } : w
  // A term weighted 0 adds nothing, not even an unknown cost: Fix where P(fix) is 0 (this folder's reviews never
  // needed one) cannot make the run's cost unknown.
  if (wp.p50 === 0 && wp.p80 === 0) return
  if (duration) sum.d = addPW(sum.d, e.durationMs, wp)
  sum.c = sum.c !== null && e.costUsd !== null ? addPW(sum.c, e.costUsd, wp) : null
  sum.t = sum.t !== null && e.tokens !== undefined ? addPW(sum.t, e.tokens, wp) : null
}

const roundP = (p: Percentiles, f: (n: number) => number): Percentiles => ({ p50: f(p.p50), p80: f(p.p80) })

/** `estimates.get` and the estimate frozen at run start (runs/<id>/estimate.json). */
export function estimateRun(agg: EstimateAggregate, input: EstimateInput): RunEstimate {
  const planned = plannedSteps(input.config)
  const steps: Partial<Record<StepKey, StepEstimate>> = {}
  for (const q of planned) {
    const bucket = input.buckets?.[q.key]
    steps[q.key] = estimateStep(agg, bucket !== undefined ? { ...q, bucket } : q, input.price)
  }
  const pFix = agg.pFix(input.folderKey)

  const sum: Sum = { d: { ...ZERO }, c: { ...ZERO }, t: { ...ZERO } }
  for (const k of [
    'prepare',
    'clarify',
    'research',
    'plan',
    'tests',
    'verify:red',
    'implement',
    'verify:1',
    'scan',
    'acceptance',
  ] as const) {
    const e = steps[k]
    if (e !== undefined) addStep(sum, e, 1)
  }
  // Review ∥ Critic ∥ Security: one join node, so the slowest of them.
  const reviewers = [steps.review, steps.critic, steps.security].filter(
    (e): e is StepEstimate => e !== undefined,
  )
  if (reviewers.length > 0) sum.d = addP(sum.d, reviewers.map((e) => e.durationMs).reduce(maxP))
  for (const e of reviewers) addStep(sum, e, 1, false)
  // Fix, its verify round and its re-check, P(fix) of the time; with Fix until green once per round: the rounds
  // history expects (its mean at p50, its 80th percentile at p80), else one at p50 and every round at p80.
  const cap = input.config.passes.fix.rounds ?? 1
  const fixRounds = cap > 1 ? agg.fixRounds(input.folderKey, cap) : undefined
  const rounds = fixRounds !== undefined ? { p50: fixRounds.p50, p80: fixRounds.p80 } : { p50: 1, p80: 1 }
  for (const k of ['fix', 'verify:2', 'recheck'] as const) {
    const e = steps[k]
    if (e !== undefined) addStep(sum, e, { p50: pFix.value * rounds.p50, p80: pFix.value * rounds.p80 })
  }
  if (steps.explain !== undefined) addStep(sum, steps.explain, 1)

  const all = Object.values(steps)
  const known = all.filter((e) => e.level !== 'prior')
  const samples = known.length > 0 ? Math.min(...known.map((e) => e.samples)) : 0
  const basis =
    known.length === 0
      ? PRIOR_BASIS
      : known.length === all.length
        ? `from ${samples} runs`
        : `from ${samples} runs (some steps typical)`
  const total: Estimate = {
    durationMs: roundP(sum.d, Math.round),
    costUsd: sum.c !== null ? roundP(sum.c, roundUsd) : null,
    samples,
    basis,
    missingPricing: [...new Set(all.flatMap((e) => e.missingPricing))],
  }
  if (sum.t !== null) total.tokens = roundP(sum.t, Math.round)
  return { total, steps, pFix, ...(fixRounds !== undefined ? { fixRounds } : {}) }
}
