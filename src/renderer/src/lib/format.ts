// Formatting for core-derived views (the renderer never derives statuses, phases, costs, findings
// or estimates; it only formats RunSummary / StepView / Estimate). Wording mirrors the dev CLI (src/cli/render.ts)
// and the Recent-runs outcome strings; failure titles mirror core's heal/categories.ts (a test keeps them in step).
import { NO_RUN_COST, runCostGap } from '@shared/cost-text.ts'
import type { NoRunCost } from '@shared/cost-text.ts'
import type { CostBasis, Percentiles } from '@shared/estimates.ts'
import type { Usage } from '@shared/events.ts'
import type { FailureCategory } from '@shared/failure.ts'
import type {
  FixStopReason,
  PassStatus,
  PauseReason,
  RunPhase,
  RunStatus,
  RunSummary,
  StepKey,
} from '@shared/run.ts'

// ---- durations ---------------------------------------------------------------------------------------------------

/** `12s`, `4m 12s`, `1h 3m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Stopwatch style: `2:13`, `1:02:13`. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000))
}

function minutesText(n: number): string {
  if (n < 60) return `${n} min`
  const h = Math.floor(n / 60)
  const m = n % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** An ETA from its p50: `~6 min`, `~1 h 10 min` (never under a minute). */
export function formatEta(p50Ms: number): string {
  return `~${minutesText(minutes(p50Ms))}`
}

/** An estimate range p50–p80: `6–10 min`, or `~6 min` when both round to the same minute. */
export function formatDurationRange(p: Percentiles): string {
  const a = minutes(p.p50)
  const b = minutes(Math.max(p.p50, p.p80))
  if (a === b) return `~${minutesText(a)}`
  if (b < 60) return `${a}–${b} min`
  return `${minutesText(a)} – ${minutesText(b)}`
}

export const LONGER_THAN_USUAL = 'longer than usual'

/**
 * Elapsed against the step's ETA: `2:13 / ~6 min`, `2:13` without an ETA, and `8:40 · longer than usual` once the
 * elapsed time passes the p80.
 */
export function formatElapsedVsEta(elapsedMs: number, eta?: Percentiles): string {
  const clock = formatClock(elapsedMs)
  if (eta === undefined) return clock
  if (elapsedMs > eta.p80) return `${clock} · ${LONGER_THAN_USUAL}`
  return `${clock} / ${formatEta(eta.p50)}`
}

/**
 * A run's ETA as core states it: "longer than usual" when core's `etaState` says a step is
 * past its p80; else `ETA ~6 min`, counting down to core's `etaEndsAt` while core says the time runs down with the
 * clock (its `etaMs` otherwise). null when core has no ETA (or it has run out until core's next summary).
 */
export function formatRunEta(p: RunSummary['progress'], now: number): string | null {
  if (p.etaState === 'longer-than-usual') return LONGER_THAN_USUAL
  const ms = etaRemainingMs(p, now)
  return ms !== undefined ? `ETA ${formatEta(ms)}` : null
}

/** The ms core's ETA reads at `now` (see formatRunEta); undefined when there is none or it has run out. */
export function etaRemainingMs(p: RunSummary['progress'], now: number): number | undefined {
  if (p.etaState === 'longer-than-usual') return undefined
  const ms = p.etaEndsAt !== undefined ? p.etaEndsAt - now : p.etaMs
  return ms !== undefined && ms > 0 ? ms : undefined
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export function formatAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

// ---- tokens, cost, files -------------------------------------------------------------------------------------------

/** `950`, `12.3k`, `1.25M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** `12.3k in · 4.1k out · 80.0k cache` (cache = read + write; omitted when zero). */
export function formatUsage(u: Usage): string {
  const cache = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
  const parts = [`${formatTokens(u.input)} in`, `${formatTokens(u.output)} out`]
  if (cache > 0) parts.push(`${formatTokens(cache)} cache`)
  return parts.join(' · ')
}

/** Where a figure came from, for tooltips and the cost line. */
export const COST_BASIS_LABEL: Readonly<Record<CostBasis, string>> = {
  vendor: 'reported by vendor',
  catalog: 'est. from pricing',
  none: 'no price known',
}

/**
 * An unknown cost (usage reported, but no vendor figure and no catalog price): a word, never a dash (UI copy
 * standard). A run total without a figure says which of the shared NO_RUN_COST cases it is (runCostGap), the same
 * words the dev CLI prints.
 */
export const NO_PRICE = NO_RUN_COST.unpriced

export const API_EQUIVALENT = 'API-equiv.'
export const API_EQUIVALENT_HINT = 'What these tokens would cost on the API; your subscription covers it'

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export interface CostInput {
  usd: number | null
  basis: CostBasis
  apiEquivalent?: boolean
}

/** `$0.62` (vendor), `$0.62 est.` (catalog), `No price` (unknown); `· API-equiv.` when priced for a subscription. */
export function formatCost(c: CostInput): string {
  if (c.usd === null || c.basis === 'none') return NO_PRICE
  const text = c.basis === 'catalog' ? `${formatUsd(c.usd)} est.` : formatUsd(c.usd)
  return c.apiEquivalent === true ? `${text} · ${API_EQUIVALENT}` : text
}

/**
 * Tooltip text for a cost: `est. from pricing`, plus the API-equivalent hint. `catalogBasis` replaces the words of a
 * catalog-priced figure with what core says about the prices (lib/pricing.ts `pricingTitle`: `est. from pricing
 * fetched 3 Oct 2026 (unverified)`).
 */
export function costTitle(c: CostInput, catalogBasis?: string): string {
  if (c.usd === null || c.basis === 'none') return 'No cost reported, and no price known for the model'
  const basis = c.basis === 'catalog' && catalogBasis !== undefined ? catalogBasis : COST_BASIS_LABEL[c.basis]
  return c.apiEquivalent === true ? `${basis} · ${API_EQUIVALENT_HINT}` : basis
}

/**
 * The basis label for a run total: `catalog` when any step was priced from the catalog (the total is then an
 * estimate), else `vendor` when any step reported one, else `none`.
 */
export function runCostBasis(s: Pick<RunSummary, 'steps' | 'progress'>): CostBasis {
  if (s.progress.costUsd === null) return 'none'
  if (s.steps.some((st) => st.costBasis === 'catalog')) return 'catalog'
  if (s.steps.some((st) => st.costBasis === 'vendor')) return 'vendor'
  return 'none'
}

type RunCostInput = Pick<RunSummary, 'status' | 'steps' | 'progress'>

/**
 * A run's total cost from its summary: `$0.62 est.`; without a figure, the shared words for why (runCostGap):
 * `No cost yet` (still going, no step reported usage yet), `No cost reported` (ended without any usage) or `No price`
 * (usage reported, but no price for it).
 */
export function formatRunCost(s: RunCostInput): string {
  const gap = runCostGap(s)
  return gap !== null ? NO_RUN_COST[gap] : formatCost({ usd: s.progress.costUsd, basis: runCostBasis(s) })
}

const NO_RUN_COST_TITLE: Readonly<Record<NoRunCost, string>> = {
  pending: 'No step has reported its usage yet',
  unreported: 'No step reported any usage',
  unpriced: 'No cost reported, and no price known for the model',
}

/** Tooltip text for a run's total (formatRunCost): where the figure came from, or why there is none. */
export function runCostTitle(s: RunCostInput, catalogBasis?: string): string {
  const gap = runCostGap(s)
  return gap !== null
    ? NO_RUN_COST_TITLE[gap]
    : costTitle({ usd: s.progress.costUsd, basis: runCostBasis(s) }, catalogBasis)
}

const MINUS = '−'

/**
 * A diff-stats body from core's live count: files only (the poller counts no lines, so its 0/0 is no total). Live
 * balanced run: the Summary bar read "3 files +0 −0" while Fix ran.
 */
export function liveCountOnly(b: { live: boolean; added: number; deleted: number }): boolean {
  return b.live && b.added === 0 && b.deleted === 0
}

/** `7 files +120 −34`; `7 files` for a live count without line totals. */
export function formatFiles(files: number, added?: number, deleted?: number): string {
  const head = `${files} ${files === 1 ? 'file' : 'files'}`
  if (added === undefined || deleted === undefined) return head
  return `${head} +${added} ${MINUS}${deleted}`
}

/** `3 must · 5 should`, or `no findings`. */
export function formatFindingCounts(c: { must: number; should: number }): string {
  return c.must + c.should === 0 ? 'no findings' : `${c.must} must · ${c.should} should`
}

// ---- labels ------------------------------------------------------------------------------------------------------

export const STEP_LABEL: Readonly<Record<StepKey, string>> = {
  preflight: 'Preflight',
  prepare: 'Prepare',
  'verify:0': 'Baseline verify',
  clarify: 'Clarify',
  research: 'Research',
  plan: 'Plan',
  tests: 'Tests',
  'verify:red': 'Red check',
  implement: 'Implement',
  'verify:1': 'Verify',
  scan: 'Security scan',
  acceptance: 'Acceptance review',
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  fix: 'Fix',
  'verify:2': 'Final verify',
  recheck: 'Re-check',
  deploy: 'Deploy',
  explain: 'Explain it to me',
  finalize: 'Finalize',
}

export function stepLabel(step: StepKey): string {
  return STEP_LABEL[step]
}

/** The re-check after Fix in a run with the security advisor (STEP_LABEL's "Re-check" is Fix until green's alone). */
export const SECURITY_RECHECK_LABEL = 'Security re-check'

/**
 * A step's label in one run: the re-check reads "Security re-check" when the run has the security advisor, and
 * "Re-check" without it (its Security step settled as not used, or absent from the summary); others as stepLabel says.
 */
export function runStepLabel(
  step: StepKey,
  steps: Readonly<Partial<Record<StepKey, { status: PassStatus; reason?: string; attempt?: number }>>>,
): string {
  if (step !== 'recheck') return stepLabel(step)
  return securityAdvisorUsed(steps) ? SECURITY_RECHECK_LABEL : stepLabel(step)
}

const UNUSED: ReadonlySet<string> = new Set(['not used', 'disabled', 'not in this build'])

/** The run has the security advisor: its Security step is not settled as unused. */
export function securityAdvisorUsed(
  steps: Readonly<Partial<Record<StepKey, { status: PassStatus; reason?: string; attempt?: number }>>>,
): boolean {
  const sec = steps.security
  if (sec === undefined) return false
  return !(
    sec.status === 'skipped' &&
    (sec.attempt ?? 0) === 0 &&
    (sec.reason === undefined || UNUSED.has(sec.reason))
  )
}

/** runStepLabel over a summary's steps (the Recent-runs lines). */
export function summaryStepLabel(step: StepKey, s: Pick<RunSummary, 'steps'>): string {
  return runStepLabel(step, Object.fromEntries(s.steps.map((st) => [st.key, st])))
}

export const PASS_STATUS_LABEL: Readonly<Record<PassStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  stalled: 'Stalled',
  paused: 'Paused',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const RUN_STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for you',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const RUN_PHASE_LABEL: Readonly<Record<RunPhase, string>> = {
  queued: 'Queued',
  preflight: 'Running checks',
  preparing: 'Preparing',
  clarifying: 'Clarifying',
  researching: 'Researching',
  'research-review': 'Research ready for review',
  planning: 'Planning',
  'plan-review': 'Plan ready for review',
  'writing-tests': 'Writing tests',
  implementing: 'Implementing',
  verifying: 'Verifying',
  accepting: 'Checking acceptance',
  reviewing: 'Reviewing',
  'findings-review': 'Findings ready for review',
  fixing: 'Fixing',
  'final-verify': 'Final verify',
  'security-recheck': 'Security re-check',
  rechecking: 'Re-checking',
  deploying: 'Writing deploy config',
  explaining: 'Writing the summary',
  'ready-to-apply': 'Ready to apply',
  'needs-attention': 'Needs attention',
  stopping: 'Stopping',
  done: 'Done',
}

export const PAUSE_REASON_LABEL: Readonly<Record<PauseReason, string>> = {
  'ask-timeout': 'Question timed out',
  denied: 'Permission denied',
  interrupted: 'Interrupted',
  'interrupted-by-quit': 'Dim Factory was closed',
}

/** Core's adapter display names (adapters/registry.ts); other ids show as themselves. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
  muse: 'Muse',
}

export function vendorName(vendor: string | undefined): string {
  if (vendor === undefined) return 'The vendor'
  const known = VENDOR_NAMES[vendor]
  if (known !== undefined) return known
  return vendor.startsWith('local-') ? `Local model (${vendor.slice('local-'.length)})` : vendor
}

/** Failure category titles as core words them (heal/categories.ts); `{{vendor}}` is the vendor's display name. */
export const FAILURE_TITLE: Readonly<Record<FailureCategory, string>> = {
  cli_missing: '{{vendor}} CLI not found',
  cli_version: '{{vendor}} CLI is too old',
  flag_drift: '{{vendor}} CLI rejected a flag',
  auth_required: '{{vendor}} needs you to log in',
  auth_expired: '{{vendor}} login expired',
  rate_limited: '{{vendor}} rate limit hit',
  quota_exceeded: '{{vendor}} usage limit reached',
  billing: '{{vendor}} billing problem',
  model_unavailable: 'Model not available',
  network: 'Network problem',
  sandbox_unavailable: '{{vendor}} sandbox not set up',
  trust_required: 'Folder not trusted for {{vendor}}',
  capability_missing: "{{vendor}} can't do this here",
  resume_failed: 'Could not resume the session',
  stream_malformed: 'Unreadable output from {{vendor}}',
  config_invalid: 'Configuration error',
  git_missing: 'Git not found',
  git_state: 'Repository needs attention',
  folder_guard: "Folder can't be used",
  snapshot_failed: 'Snapshot failed',
  worktree_failed: 'Isolated worktree failed',
  deps_missing: 'Dependencies missing',
  local_server: 'Local model server not reachable',
  verify_failed: 'Verify failed',
  verify_untrusted: 'Verify command not trusted',
  timeout_stall: 'No output for a while',
  timeout_hard: 'Stopped after too long without output',
  ask_timeout: 'Question timed out',
  permission_denied: 'Permission denied',
  turn_limit: 'Turn or budget limit reached',
  context_exceeded: 'Too much input for the model',
  runaway_loop: 'The AI kept repeating the same step',
  content_policy: 'Request refused by {{vendor}}',
  vendor_internal: '{{vendor}} service error',
  process_crash: '{{vendor}} crashed',
  disk_full: 'Disk full',
  user_cancelled: 'Stopped',
  unknown: 'Something went wrong',
}

/** `Codex login expired`: the category's title with the vendor filled in (`The vendor` when unknown). */
export function categoryTitle(category: FailureCategory, vendor?: string): string {
  return FAILURE_TITLE[category].replaceAll('{{vendor}}', vendorName(vendor))
}

// ---- outcomes ------------------------------------------------------------------------------------------------------

function vendorOfStep(s: Pick<RunSummary, 'steps'>, step: StepKey): string | undefined {
  return s.steps.find((st) => st.key === step)?.vendor
}

/** `Failed at Implement · Codex login expired`. */
export function failedAtText(s: Pick<RunSummary, 'failure' | 'steps'>): string {
  const f = s.failure
  if (f === undefined) return 'Failed'
  return `Failed at ${summaryStepLabel(f.step, s)} · ${categoryTitle(f.category, vendorOfStep(s, f.step))}`
}

/** `Cancelled at Review`: the first step (in run order) the stop cancelled. */
export function cancelledAtText(s: Pick<RunSummary, 'steps'>): string {
  const at = s.steps.find((st) => st.status === 'cancelled')
  return at === undefined ? 'Cancelled' : `Cancelled at ${summaryStepLabel(at.key, s)}`
}

/** Why Fix until green stopped short of green, as the outcome line says it. */
const FIX_STOP_OUTCOME: Readonly<Record<Exclude<FixStopReason, 'green'>, string>> = {
  cap: 'round cap reached',
  budget: 'budget reached',
  'no-progress': 'no progress',
}

/** `Completed with failures · round cap reached` (or budget reached, no progress); plain without a reason. */
export function fixStoppedText(stop: FixStopReason | undefined): string {
  if (stop === undefined || stop === 'green') return 'Completed with failures'
  return `Completed with failures · ${FIX_STOP_OUTCOME[stop]}`
}

/**
 * The Recent-runs outcome line: `Fixed · 3 must · 5 should`, `Clean: no findings` (or `Clean · 0 must ·
 * 1 should` when Verify listed a [should]), `Completed with failures`, `Failed at Implement · Codex login expired`, `No changes made`, `Cancelled at Review`,
 * `Findings open · 2 must · 1 should`. Null while the run is still going.
 */
export function outcomeText(s: RunSummary): string | null {
  switch (s.status) {
    case 'queued':
    case 'running':
    case 'waiting':
    case 'paused':
      return null
    case 'failed':
      return failedAtText(s)
    case 'cancelled':
      return s.outcome === 'failed' ? failedAtText(s) : cancelledAtText(s)
    case 'completed':
      break
  }
  const counts = s.findings.must + s.findings.should
  if (s.outcome === undefined) return 'Completed'
  switch (s.outcome) {
    case 'fixed':
      return counts === 0 ? 'Fixed' : `Fixed · ${formatFindingCounts(s.findings)}`
    case 'clean':
      // A clean run can still list a [should] Verify added (a command Auto skipped as untrusted): it
      // does not block the rule that skips Fix, but "no findings" would not be true.
      return counts === 0 ? 'Clean: no findings' : `Clean · ${formatFindingCounts(s.findings)}`
    case 'no-changes':
      return 'No changes made'
    case 'findings-open':
      return counts === 0 ? 'Findings open' : `Findings open · ${formatFindingCounts(s.findings)}`
    case 'verify-failed':
      return 'Completed with failures'
    case 'security-open':
      // The security re-check after Fix found a security [must] still open.
      return 'Completed with failures · security findings open'
    case 'fix-stopped':
      // Fix until green stopped before the run was green.
      return fixStoppedText(s.fixLoop?.stop)
    case 'gates-failed':
      // The project's quality gates: a required check did not pass.
      return gatesFailedText(s)
    case 'failed':
      return failedAtText(s)
  }
}

/** `Completed with failures · quality gates: tests, security` (the gates that did not pass). */
export function gatesFailedText(s: Pick<RunSummary, 'gates'>): string {
  const failed = s.gates?.failed.map((g) => g.name) ?? []
  return failed.length > 0
    ? `Completed with failures · quality gates: ${failed.join(', ')}`
    : 'Completed with failures · quality gates'
}
