// Pass cost. The figure comes from, in order: `vendor` (Claude Δtotal_cost_usd, carried
// in Usage.costUsd by the adapter), `catalog` (tokens × price; cache read and cache write priced separately;
// reasoning at the output rate unless the adapter declares it already counted in output), else `none` (the app
// shows "No price"). Pure: the caller looks the price up (catalog/store.ts) and freezes the result at pass end.
import type { PriceConfidence, PriceEntry } from '../../shared/catalog.ts'
import type { Usage } from '../../shared/events.ts'
import type { StepCost } from '../../shared/run.ts'

/** Tokens per price unit: prices are USD per 1,000,000 tokens. */
export const MTOK = 1_000_000
export const DAY_MS = 86_400_000
/** Pricing older than this many refresh intervals is stale (shown amber). */
export const STALE_INTERVALS = 2
/** Used when a caller passes no usable interval (the config default). */
export const DEFAULT_REFRESH_INTERVAL_DAYS = 14

export interface CostOptions {
  /**
   * The vendor's own figure for this pass. `undefined` → `usage.costUsd` when present; `null` → ignore any vendor
   * figure. Negative or non-finite values are ignored.
   */
  vendorReportedUsd?: number | null | undefined
  /** The catalog price for the pass's model (null/undefined: no price known). */
  priceEntry?: PriceEntry | null | undefined
  /** Adapter capability: `usage.reasoning` is already part of `usage.output` (Claude, Codex). */
  reasoningIncludedInOutput: boolean
  /** Subscription auth (not an API key): any USD figure is what the tokens would cost on the API ("API-equiv."). */
  subscription?: boolean | undefined
  /** The usage delta is approximate (StepView.usageApprox): no figure is shown, basis `none`. */
  usageApprox?: boolean | undefined
  /** With `now`: sets `pricingStale` on a catalog figure. Default {@link DEFAULT_REFRESH_INTERVAL_DAYS}. */
  intervalDays?: number | undefined
  /** Epoch ms; enables the `pricingStale` check. */
  now?: number | undefined
}

/** StepCost plus where a catalog figure came from (for the "est. from pricing fetched <date>" tooltip). */
export interface CostResult extends StepCost {
  /** Catalog basis only: the priced entry's fetchedAt. */
  pricingFetchedAt?: number
  /** Catalog basis only. */
  confidence?: PriceConfidence
  /** Catalog basis only: the concrete model id that was priced. */
  pricedModel?: string
  /** Catalog basis with `now` given: the price is older than 2× the refresh interval. */
  pricingStale?: boolean
}

const finite = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

/** Float noise (0.1 + 0.2) is rounded at 1e-10 USD, the same precision the usage deltas use. */
export function roundUsd(n: number): number {
  return Math.round(n * 1e10) / 1e10
}

/**
 * USD for `usage` at `price`. `input` is uncached input; cache reads and writes use their own rates, and a rate the
 * vendor does not offer (`null`) bills those tokens as ordinary input. `reasoning` is added at the output rate only
 * when it is reported outside `output`.
 */
export function catalogCostUsd(
  usage: Usage,
  price: Pick<PriceEntry, 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok'>,
  reasoningIncludedInOutput: boolean,
): number {
  const input = finite(price.inputPerMTok)
  const output = finite(price.outputPerMTok)
  const cacheRead = price.cacheReadPerMTok === null ? input : finite(price.cacheReadPerMTok)
  const cacheWrite = price.cacheWritePerMTok === null ? input : finite(price.cacheWritePerMTok)
  const outputTokens = finite(usage.output) + (reasoningIncludedInOutput ? 0 : finite(usage.reasoning))
  const micro =
    finite(usage.input) * input +
    outputTokens * output +
    finite(usage.cacheRead) * cacheRead +
    finite(usage.cacheWrite) * cacheWrite
  return roundUsd(micro / MTOK)
}

/** True when `fetchedAt` is older than 2× the refresh interval at `now`. */
export function isPricingStale(fetchedAt: number, intervalDays: number, now: number): boolean {
  const days =
    Number.isFinite(intervalDays) && intervalDays > 0 ? intervalDays : DEFAULT_REFRESH_INTERVAL_DAYS
  return now - fetchedAt > STALE_INTERVALS * days * DAY_MS
}

function vendorFigure(usage: Usage, reported: number | null | undefined): number | null {
  const v = reported === undefined ? usage.costUsd : reported
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** The pass's cost and its basis (the source of the figure). */
export function costForUsage(usage: Usage, opts: CostOptions): CostResult {
  const subscription = opts.subscription === true
  if (opts.usageApprox === true) return { usd: null, basis: 'none', apiEquivalent: false }

  const vendor = vendorFigure(usage, opts.vendorReportedUsd)
  if (vendor !== null) return { usd: roundUsd(vendor), basis: 'vendor', apiEquivalent: subscription }

  const price = opts.priceEntry
  if (price === null || price === undefined) return { usd: null, basis: 'none', apiEquivalent: false }

  const out: CostResult = {
    usd: catalogCostUsd(usage, price, opts.reasoningIncludedInOutput),
    basis: 'catalog',
    apiEquivalent: subscription,
    pricingFetchedAt: price.fetchedAt,
    confidence: price.confidence,
    pricedModel: price.model,
  }
  if (opts.now !== undefined) {
    out.pricingStale = isPricingStale(
      price.fetchedAt,
      opts.intervalDays ?? DEFAULT_REFRESH_INTERVAL_DAYS,
      opts.now,
    )
  }
  return out
}

/**
 * Subscription logins by `ProbeAccount.method`, spelling-insensitive (Claude.ai, ChatGPT). Gemini's Google
 * login (its auth type `oauth-personal`, "Login with Google") is billed by the account, not per token, so its cost is
 * API-equivalent too; a Gemini API key or Vertex AI is not.
 */
const SUBSCRIPTION_METHODS: ReadonlySet<string> = new Set([
  'claudeai',
  'chatgpt',
  'oauthpersonal',
  'loginwithgoogle',
])

/**
 * Subscription auth (the app labels it "API-equiv."): a Claude.ai or ChatGPT login, or any
 * login that names a plan; never an API key. Unknown (no account): false.
 */
export function isSubscriptionAuth(account: { method: string; plan?: string } | undefined): boolean {
  if (account === undefined) return false
  const m = account.method.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (m === 'apikey') return false
  return SUBSCRIPTION_METHODS.has(m) || account.plan !== undefined
}

/** Just the StepCost part (what StepView.cost carries). */
export function toStepCost(c: CostResult): StepCost {
  return { usd: c.usd, basis: c.basis, apiEquivalent: c.apiEquivalent }
}
