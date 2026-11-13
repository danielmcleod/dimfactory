// Run-level contracts: primitives, statuses, phases, core-derived views and persisted event bodies.
// The renderer only formats these; core derives them.
import type { VerifyScenarioLine } from './playtest.ts'
import type { AllowRule, AskDecision, AskKind, AutoAnswerReason, NormalizedEvent, Usage } from './events.ts'
import type { GuardrailFinding } from './guardrails.ts'
import type { CostBasis, Percentiles } from './estimates.ts'
import type { Failure, FailureCategory, HealView, RecoveryAction } from './failure.ts'
import type { Finding, SecurityLevel } from './findings.ts'
import type { AcceptanceView } from './acceptance.ts'
import type { DeployRunView } from './deploy.ts'
import type { ResearchView } from './research.ts'
import type { RunRecipe } from './recipes.ts'
import type { MatchRef } from './match.ts'
import type { Support } from './vendors.ts'
import type { QualityGatesView } from './factory.ts'
import type { ContextHealthReport, ContextSummary, ContextView } from './context.ts'
import type { RunDepthView } from './depth.ts'

// ---- primitives ----------------------------------------------------------

export const PASS_NAMES = ['plan', 'implement', 'review', 'critic', 'security', 'fix'] as const
export type PassName = (typeof PASS_NAMES)[number]

/**
 * Steps a vendor CLI runs: the configured passes, plus Test-first's `tests` step (it writes failing tests from the
 * plan's acceptance criteria before Implement, and runs on the Implement pass's vendor, model, effort and mode), the
 * `recheck` step (a short read-only pass after Fix that confirms each [must] it was given is resolved: the security
 * advisor's security findings, or with Fix until green every [must] of the round; it runs on the Security pass's
 * vendor, model, effort and mode, or on Review's when the advisor is off), and the `clarify` step (an optional
 * read-only pass before Plan that may ask the user a few multiple-choice questions; it runs on the Plan pass's
 * vendor, model and effort, always read-only), and the `research` step (an optional read-only pass after Clarify and
 * before Plan that studies the problem space, on the web where the vendor can, and hands Plan a cited brief; it runs
 * on the Plan pass's vendor, model and effort, confined: no edits, no shell, no agents), and the Deploy helper's `deploy`
 * step (an optional editing pass at the end of a run that writes the deploy config the chosen target needs; it runs
 * on the Implement pass's vendor, model, effort and mode, and never deploys), the `acceptance` step (an optional
 * read-only pass after Implement's checks and before Review that marks each of the plan's acceptance criteria met, not
 * met or unknown with evidence; it runs on the Review pass's vendor, model and effort, or Critic's, then Plan's, when
 * Review is off), and the `explain` step (an optional read-only pass once the outcome is decided that writes a
 * plain-language explain.md for non-developers; it runs on the Plan pass's vendor, model and effort, or Review's when
 * Plan is off).
 */
export const AGENT_STEPS = [
  ...PASS_NAMES,
  'tests',
  'recheck',
  'clarify',
  'research',
  'deploy',
  'acceptance',
  'explain',
] as const
export type AgentStep = (typeof AGENT_STEPS)[number]

/** Passes that may change files ("mutating"). */
export const MUTATING_PASSES = ['implement', 'fix'] as const satisfies readonly PassName[]
/** Passes that must always run read-only (a semantic config rule). */
export const READONLY_PASSES = ['plan', 'review', 'critic', 'security'] as const satisfies readonly PassName[]

export const MODES = ['readonly', 'autoedit', 'full'] as const
export type Mode = (typeof MODES)[number]

/** Execution order. `:` in a key must go through `fileSafe()` before it reaches a path. */
export const STEP_KEYS = [
  'preflight',
  'prepare',
  'verify:0',
  'clarify',
  'research',
  'plan',
  'tests',
  'verify:red',
  'implement',
  'verify:1',
  'scan',
  'acceptance',
  'review',
  'critic',
  'security',
  'fix',
  'verify:2',
  'recheck',
  'deploy',
  'explain',
  'finalize',
] as const
export type StepKey = (typeof STEP_KEYS)[number]

/** Steps run by Dim Factory itself (no vendor CLI). They never become `stalled`. */
export const RUNNER_STEPS = [
  'preflight',
  'prepare',
  'verify:0',
  'verify:red',
  'verify:1',
  'scan',
  'verify:2',
  'finalize',
] as const satisfies readonly StepKey[]
export type RunnerStep = (typeof RUNNER_STEPS)[number]
/** The verify rounds; `verify:red` is Test-first's check that the new tests fail before Implement. */
export type VerifyStep = Extract<StepKey, `verify:${string}`>

export const PASS_STATUSES = [
  'queued',
  'running',
  'waiting',
  'stalled',
  'paused',
  'done',
  'skipped',
  'failed',
  'cancelled',
] as const
export type PassStatus = (typeof PASS_STATUSES)[number]
export const TERMINAL_PASS_STATUSES = [
  'done',
  'skipped',
  'cancelled',
] as const satisfies readonly PassStatus[]

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
/** Statuses that hold the folder lock (except while step `preflight` is failed). */
export const LOCK_HOLDING_RUN_STATUSES = [
  'running',
  'waiting',
  'paused',
  'failed',
] as const satisfies readonly RunStatus[]

export const RUN_PHASES = [
  'queued',
  'preflight',
  'preparing',
  'clarifying',
  'researching',
  'research-review',
  'planning',
  'plan-review',
  'writing-tests',
  'implementing',
  'verifying',
  'accepting',
  'reviewing',
  'findings-review',
  'fixing',
  'final-verify',
  'security-recheck',
  'rechecking',
  'deploying',
  'explaining',
  'ready-to-apply',
  'needs-attention',
  'stopping',
  'done',
] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/**
 * `verify-failed` renders as "Completed with failures", and so does `security-open`: the security re-check after Fix
 * found a security [must] still open. So does `fix-stopped`: Fix until green stopped before the run was green (the
 * round cap, the budget, or a round that made no progress; RunSummary.fixLoop.stop says which). So does
 * `gates-failed`: the run would have been done, but a required check of the project's quality gates did not pass
 * (RunSummary.gates says which).
 */
export const RUN_OUTCOMES = [
  'fixed',
  'clean',
  'no-changes',
  'findings-open',
  'verify-failed',
  'security-open',
  'fix-stopped',
  'gates-failed',
  'failed',
] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

export const PAUSE_REASONS = ['ask-timeout', 'denied', 'interrupted', 'interrupted-by-quit'] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

export const FRESH_REASONS = [
  'vendor-differs',
  'no-session',
  'cannot-resume',
  'cwd-changed',
  'model-differs',
  'override-fresh',
  'override-other-vendor',
  'resume-failed',
  'implement-skipped',
  /** Implement's session ended heavy (nearly full, or summarised twice): Fix starts clean (context health). */
  'context-heavy',
  /** Continuity: Plan did not run, so Implement has no Plan session to continue. */
  'plan-skipped',
  /** Continuity: Plan ran on another vendor than Implement. */
  'plan-vendor-differs',
  /** Continuity: the vendor cannot switch a resumed session from Plan's read-only mode to Implement's. */
  'mode-switch-unsupported',
] as const
export type FreshReason = (typeof FRESH_REASONS)[number]

/**
 * What a fresh start's FreshReason alone does not say, for the session line's "Why?" (core sets it; the
 * renderer only words it). Absent: the reason's usual case.
 *  - `vendor-cannot-resume` (with cannot-resume): the vendor cannot continue any session (its capabilities say
 *    resume 'none'), rather than canResume finding the session gone.
 *  - `new-attempt` (with resume-failed): this fresh start began a new attempt (the retry budget, or Retry), rather
 *    than being the free fallback that keeps the attempt.
 */
export const FRESH_DETAILS = ['vendor-cannot-resume', 'new-attempt'] as const
export type FreshDetail = (typeof FRESH_DETAILS)[number]

/** The FreshReason each FreshDetail goes with. */
export const FRESH_DETAIL_REASON: Readonly<Record<FreshDetail, FreshReason>> = {
  'vendor-cannot-resume': 'cannot-resume',
  'new-attempt': 'resume-failed',
}

export const PLAN_MODES = ['native', 'emulated'] as const
export type PlanMode = (typeof PLAN_MODES)[number]

export const ISOLATION_MODES = ['inPlace', 'worktree'] as const
export type IsolationMode = (typeof ISOLATION_MODES)[number]

/**
 * The steps a profile's `routing` may give a model and effort of their own (they run on their pass's vendor): Research,
 * Clarify and Explain on Plan's, the acceptance review on Review's, the re-check on Security's (or Review's).
 */
export const ROUTED_STEPS = ['research', 'clarify', 'explain', 'acceptance', 'recheck'] as const
export type RoutedStep = (typeof ROUTED_STEPS)[number]

export function isRoutedStep(v: unknown): v is RoutedStep {
  return typeof v === 'string' && (ROUTED_STEPS as readonly string[]).includes(v)
}

export function isPassName(v: unknown): v is PassName {
  return typeof v === 'string' && (PASS_NAMES as readonly string[]).includes(v)
}

export function isAgentStep(v: unknown): v is AgentStep {
  return typeof v === 'string' && (AGENT_STEPS as readonly string[]).includes(v)
}

/**
 * What configPassOf needs of a run's passes to place the re-check (absent: the security advisor's), the acceptance
 * review (absent: Review's) and Explain (absent: Plan's).
 */
export interface PassesEnabled {
  plan?: { enabled: boolean }
  security?: { enabled: boolean }
  review?: { enabled: boolean }
  critic?: { enabled: boolean }
}

/**
 * The configured pass a step runs as: Test-first's Tests step and the Deploy step run on the Implement pass's config,
 * Clarify and Research on the Plan pass's, and the re-check on the Security pass's. Given the run's `passes`, a re-check in a run without the security
 * advisor (Fix until green) runs on Review's config, or Critic's when Review is off. The acceptance review runs on
 * Review's config, or Critic's when Review is off, then Plan's; Explain on Plan's, or Review's when Plan is off.
 */
export function configPassOf(k: AgentStep, passes?: PassesEnabled): PassName {
  if (k === 'tests' || k === 'deploy') return 'implement'
  if (k === 'clarify' || k === 'research') return 'plan'
  if (k === 'acceptance') {
    if (passes === undefined || passes.review?.enabled === true) return 'review'
    if (passes.critic?.enabled === true) return 'critic'
    if (passes.plan?.enabled === true) return 'plan'
    return 'review'
  }
  if (k === 'explain') {
    if (passes === undefined || passes.plan?.enabled !== false) return 'plan'
    return passes.review?.enabled === true ? 'review' : 'plan'
  }
  if (k === 'recheck') {
    if (passes === undefined || passes.security?.enabled === true) return 'security'
    if (passes.review?.enabled !== true && passes.critic?.enabled === true) return 'critic'
    return 'review'
  }
  return k
}

export function isStepKey(v: unknown): v is StepKey {
  return typeof v === 'string' && (STEP_KEYS as readonly string[]).includes(v)
}

// ---- cards -----------------------------------------------------------------

export const GATE_KINDS = ['gate:afterPlan', 'gate:beforeFix'] as const
export type GateKind = (typeof GATE_KINDS)[number]

export const CARD_KINDS = [
  ...GATE_KINDS,
  'insufficientContext',
  'planMutated',
  'preflight',
  'reconcile',
  'trust',
  'depsConsent',
  'depsFailed',
  'verifyEnv',
  'emptyFindings',
  'retryPartial',
  'finalize',
  'finalizeConflicts',
  'interruptedApply',
  'stall',
  'testsNotRed',
  'clarify',
  'research',
  // ---- context reactions ----
  /** Context health: the pass's session compacted often; restart it fresh with a summary, or keep going. */
  'restartFresh',
  /** Context health: the pass repeated one call many times; stop it, or keep going. */
  'loop',
] as const
export type CardKind = (typeof CARD_KINDS)[number]

/**
 * What a choice takes with `cards.resolve`: text (`plan`, `task`, `command`) or a list (`findings`: finding ids;
 * `paths`: the files a finalizeConflicts choice applies to, every conflicting file when absent; `answers`: the
 * Clarify card's answers, one per question in order, '' for a question left unanswered).
 */
export type CardChoiceInput = 'plan' | 'task' | 'findings' | 'command' | 'paths' | 'answers' | 'research'

export interface CardChoice {
  id: string
  label: string
  primary?: boolean
  danger?: boolean
  input?: CardChoiceInput
}

/**
 * Value sent with `cards.resolve` for a choice with `input`: text for plan/task/command, finding ids for findings,
 * relative file paths for paths, one answer per question for answers.
 */
export type CardChoiceValue = string | string[]

/**
 * One protocol for gates and runner prompts; core builds the choices. In Auto mode a card with a
 * `defaultChoice` is taken automatically and logged; blocking cards without a default always wait.
 */
export interface CardView {
  id: string
  kind: CardKind
  title: string
  body: string
  payload: unknown
  blocking: boolean
  defaultChoice?: string
  choices: CardChoice[]
}

// ---- views -----------------------------------------------------------------

export type AnswerVia = 'app' | 'notification' | 'cli'

export interface AskView {
  runId: string
  step: StepKey
  attempt: number
  requestId: string
  vendor: string
  kind: AskKind
  detail: string
  reason?: string
  expiresAt: number
  allowSession: boolean
  defaultToNo?: boolean
  /** Position in the step's FIFO ask queue (1-based index). */
  queue: { index: number; total: number }
  /** Set while a Deny sits in its undo grace; the vendor has not been answered yet. */
  pendingDenyUntil?: number
}

export interface StepCost {
  usd: number | null
  basis: CostBasis
  apiEquivalent: boolean
  /**
   * `catalog` basis only: the prices the figure was priced at (the run's pricingRef), as of the pass's end:
   * when they were fetched, their confidence, and whether they were older than 2× the refresh interval then. The cost
   * labels read these instead of today's catalog.
   */
  pricing?: StepCostPricing
}

export interface StepCostPricing {
  fetchedAt: number
  confidence: 'verified' | 'unverified' | 'user'
  stale: boolean
}

/**
 * "AUTO approved N": asks the adapter answered itself (`auto-answered` bodies: allow-cache hits,
 * read-only and unsupported denials), over every attempt. The plan capture's deny is not counted.
 */
export interface AutoAnsweredCounts {
  approved: number
  denied: number
  /**
   * Asks allowed under Easy mode's project permission (`why: 'project-permission'`), counted apart: they are the
   * user's own standing answer for the project, not AUTO's. Absent while none.
   */
  project?: number
}

export interface StepView {
  key: StepKey
  status: PassStatus
  reason?: string
  pause?: PauseReason
  attempt: number
  startedAt?: number
  endedAt?: number
  /** The current attempt's running + stalled time (waits on the user excluded). */
  activeMs: number
  eta?: Percentiles
  vendor?: string
  model?: string | null
  /** The effort level the pass runs at (absent: the vendor's default, or a vendor without an effort setting). */
  effort?: string
  /**
   * Live balanced run: the model a pass that names none ran, as its vendor said when it started (Codex's app-server:
   * the model its thread answered with for the folder, or the account's default Dim Factory ran in its place). Absent
   * when the pass names a model, or the vendor did not say (Codex's exec route, a thread answer without a model,
   * Claude, Gemini). With modelOverrideIgnored, the model the vendor ran in place of the default Dim Factory sent.
   */
  modelUsed?: string
  /**
   * Live balanced run: with modelUsed, the model the vendor's own settings named for this pass, which the account
   * is not offered, so Dim Factory ran modelUsed (the account's default) instead. Absent when it ran what they named.
   */
  modelReplaced?: string
  /**
   * Model wording: with modelReplaced (and no modelUsed), the account's default Dim Factory asked the
   * vendor to run on turn/start in place of modelReplaced, which the vendor has not confirmed running (yet: Codex says
   * so with a thread/settings/updated naming it or the turn's first usage total, and modelUsed then names it). Absent
   * once confirmed, and when nothing was asked for.
   */
  modelAsked?: string
  /**
   * With modelUsed, the model the vendor moved this pass's turn away from (Codex's `model/rerouted`, for a
   * request it flags): modelUsed ran in its place. Absent otherwise.
   */
  modelRerouted?: string
  /**
   * Live balanced run: the account's default Dim Factory sent (on turn/start) in place of the model the vendor's
   * settings named, which the vendor did not run: the pass failed `model_unavailable` naming that model (modelUsed
   * here), not the default (shared/vendors.ts modelOverrideIgnored). Absent otherwise.
   */
  modelOverrideIgnored?: string
  /**
   * Live balanced run: for a pass that names no model, the model core expects it to run (the one its estimate is
   * priced at: the vendor probe's default for the account, frozen when the run first needs it), while the pass is
   * queued, and once it runs until its vendor says which model it runs (only on a route that says so before its turn,
   * shared/vendors.ts MODEL_REPORT_ROUTES). Absent when the pass names a model, runs a local preset, has started where
   * its vendor never says (Codex exec, Gemini), has ended, or none is known: its card then reads "default model"
   * unless modelUsed names what ran.
   */
  expectedModel?: string
  mode?: Mode
  modeCopy?: Support
  planMode?: PlanMode
  planFallbackReason?: string
  sessionNote?: string
  /** With a "fresh session: …" note, the fact behind it its FreshReason does not carry. */
  freshDetail?: FreshDetail
  route?: string
  usage?: Usage
  /** The token figures are approximate (resumed without a known base, or a vendor counter went backwards). */
  usageApprox?: boolean
  cost?: StepCost
  /**
   * The pass's context meter (how full the vendor's context window is, its compactions); absent until the pass's
   * vendor reports anything (the card then reads "n/a" in the slot it keeps from the start).
   */
  context?: ContextView
  failure?: Failure
  /** The step's auto-answered asks; absent while there are none. */
  autoAnswered?: AutoAnsweredCounts
  /**
   * A short fact core states about how the step started, shown beside it (Implement: "3 files changed during
   * planning", from reconciliation). Absent when there is none.
   */
  chip?: string
  /**
   * What the step's launch waits on before it spawns, where that wait can be long. `run-start`: Plan waits for
   * the run-start snapshot (R2), about a second normally but up to minutes for the cold first snapshot of
   * a large folder (bounded by the snapshot timeout). Absent otherwise, and once the step has spawned.
   */
  launchWait?: 'run-start'
  /** The failed step's AI diagnosis (running or done); absent when none was asked for. */
  heal?: HealView
  /** The `wait_until` retry of a failed step (countdown while armed); absent without one. */
  wait?: WaitView
  /**
   * The Verify step: verify:1 / verify:2 only, once the round has its commands. The round's output
   * streams through `output` bodies for the file `verify:<n>` (runs.output).
   */
  verify?: VerifyStepView
  /**
   * UI standard, nothing moves on its own: verify:1 / verify:2 while queued and not yet begun, when the run's
   * config runs that round (verify on, `runAfter` ∋ its pass). The timeline shows such a node from the start instead
   * of inserting it mid-row when the round begins. Absent otherwise. Also verify:0 (the baseline) and finalize of
   * an isolated run, from its start.
   */
  planned?: true
  /** Isolated run: the `prepare` step of an isolated run, its rows from the start. */
  prepare?: PrepareView
  /** Finalize (R12): the `finalize` step of an isolated run once it began. */
  finalize?: FinalizeView
  /**
   * Test-first, on the `tests` step: the test files it wrote (once its end snapshot is in) and Dim Factory's check
   * that Implement left them whole. Absent otherwise.
   */
  testFirst?: TestFirstView
  /** The security advisor's `scan` step: the secret scanner's hits and the dependency audits. Absent otherwise. */
  scan?: ScanView
  /** The `recheck` step: which [must] findings Fix resolved. Absent otherwise. */
  recheck?: RecheckView
  /** The `clarify` step: its questions and the user's answers, once it has asked. Absent otherwise. */
  clarify?: ClarifyView
  /** The `research` step: its lenses, then its cited answer and what was kept for Plan. Absent otherwise. */
  research?: ResearchView
  /** The Deploy helper's `deploy` step: the class, the target, the files to write and those it wrote. Absent otherwise. */
  deploy?: DeployRunView
  /** The `acceptance` step: the plan's acceptance criteria as a checklist (RunSnapshot.acceptance). Absent otherwise. */
  acceptance?: AcceptanceView
  /**
   * Fix until green, on `fix`, `verify:2` and `recheck`: the round the step belongs to now (`n` of at most `of`).
   * Absent in a run without it.
   */
  round?: { n: number; of: number }
}

// ---- Clarify ---------------------------------------------------------------------------------------------------

/** The most questions Clarify may ask (config `passes.plan.clarifyQuestions` is 1 to this). */
export const CLARIFY_MAX_QUESTIONS = 8
/** The most options one question may offer (besides "Other"). */
export const CLARIFY_MAX_OPTIONS = 6
/** The longest answer the Clarify card takes for one question ("Other" text included). */
export const CLARIFY_ANSWER_MAX = 500

/** One multiple-choice question Clarify asks (every question also takes "Other" free text). */
export interface ClarifyQuestion {
  question: string
  options: string[]
}

/**
 * StepView.clarify. `status`: `asking` (the Clarify card is open) · `answered` (some answers given) · `skipped` (the
 * user skipped the questions) · `none` (Clarify asked nothing: it had no question, or its answer was unreadable;
 * `note` says which).
 */
export interface ClarifyView {
  status: 'asking' | 'answered' | 'skipped' | 'none'
  questions: ClarifyQuestion[]
  /** One per question once answered ('' for a question left unanswered). */
  answers?: string[]
  note?: string
}

// ---- Fix until green -----------------------------------------------------------------------------------------------

/** The most Fix rounds a run may take (config validation rejects more). */
export const FIX_ROUNDS_MAX = 3

/**
 * Why Fix until green stopped: `green` (no [must] open, verify green, no critical or high security finding open), the
 * round cap, the budget, or a round that made no progress (no change, or the open findings did not shrink).
 */
export const FIX_STOP_REASONS = ['green', 'cap', 'budget', 'no-progress'] as const
export type FixStopReason = (typeof FIX_STOP_REASONS)[number]

/** One round of Fix until green (RunSnapshot.fixLoop.rounds). */
export interface FixRoundView {
  n: number
  /** `stopped`: the run ended before the round's checks did (Stop, or Fix skipped). */
  status: 'running' | 'done' | 'stopped'
  /** Fix changed files in this round (absent until its end snapshot). */
  changed?: boolean
  /** The verify commands that still failed after this round (absent while verify has not run). */
  failing?: string[]
  /** F-numbers confirmed resolved in this round, and those still open after it. */
  resolved: number[]
  open: number[]
  /** What the round spent (null: not priced) and its working time. */
  usd: number | null
  activeMs: number
  /**
   * The round's Fix, Final verify and Re-check as they ended (each with `round`), once the round is over. Each round is
   * an attempt of the same steps, so RunSnapshot.steps holds only the latest round's; the views of an earlier round
   * keep its cards as they were (StepView.attempt names the attempt whose stream it shows). Absent while it runs.
   */
  views?: { fix: StepView; verify: StepView; recheck: StepView }
}

/** RunSnapshot.fixLoop: Fix until green's rounds so far, and why it stopped once it has. */
export interface FixLoopView {
  max: number
  round: number
  rounds: FixRoundView[]
  stop?: { reason: FixStopReason; text: string }
  /** The configured budget (absent: none). */
  budget?: { usd?: number; minutes?: number }
}

/** One secret the scanner found in the run's added lines. `masked` never holds the whole value. */
export interface ScanSecretView {
  file: string
  line: number
  /** What kind of secret, as UI copy ("AWS access key ID"). */
  label: string
  masked: string
  /** `pattern`: a known key format; `entropy`: a random-looking string beside a secret-ish name. */
  confidence: 'pattern' | 'entropy'
  /** The finding it became (critical for a known format, medium for an entropy hit). */
  level: SecurityLevel
}

/**
 * One dependency audit of the scan: `queued` · `running` · `done` (its output was read) · `skipped` (the user skipped
 * it, or Auto did not run it because it is not trusted) · `env` (the tool is not installed or could not run: an info
 * note, never a finding) · `unreadable` (it ran but Dim Factory could not read its output: an info note).
 */
export interface ScanAuditView {
  name: string
  argv: string[]
  status: 'queued' | 'running' | 'done' | 'skipped' | 'env' | 'unreadable'
  /** Why it was skipped or could not run, or what made its output unreadable (UI copy). */
  reason?: string
  /** Advisories for dependencies the run added or changed (each a finding). */
  introduced?: number
  /** Advisories for dependencies the run did not touch (one info note in all). */
  existing?: number
}

/** An advisory for a dependency the run added or changed. */
export interface ScanAdvisoryView {
  tool: string
  package: string
  version?: string
  id: string
  title: string
  level: SecurityLevel
  /** false: the tool reports no severity (Dim Factory then treats it as high). */
  levelKnown: boolean
  url?: string
  fixedIn?: string
}

/**
 * StepView.scan. `phase`: `check` (reading what applies and the audits' trust) · `trust` (a trust card is open) ·
 * `running` · `done`.
 */
export interface ScanView {
  phase: 'check' | 'trust' | 'running' | 'done'
  secrets: ScanSecretView[]
  audits: ScanAuditView[]
  advisories: ScanAdvisoryView[]
  /** Advisories the audits found for dependencies the run did not touch. */
  existing: number
  /** What the scan says beside its findings (no tool installed, a monorepo subfolder not audited, …). */
  notes: string[]
}

/**
 * StepView.recheck: `checking` while the re-check runs · `resolved` (every security [must] is resolved) · `open` (some
 * are not: the run completes with failures) · `unclear` (the answer named none of them: treated as open).
 */
export interface RecheckView {
  status: 'checking' | 'resolved' | 'open' | 'unclear'
  /** F-numbers the re-check confirmed resolved. */
  resolved: number[]
  /** F-numbers still open, with the re-check's reason when it gave one. */
  open: { n: number; reason?: string }[]
}

/**
 * The `tests` step's facts. `guard`: `checking` while Dim Factory compares the test files before and after Implement,
 * `ok` (none weakened), `weakened` (a `[must]` finding each: deleted files, removed assertions or tests, added skips),
 * `failed` (the comparison could not run: a note says why). Absent until Implement ended.
 */
export interface TestFirstView {
  files: string[]
  guard?: 'checking' | 'ok' | 'weakened' | 'failed'
  /** The `[must]` findings the guard raised. */
  weakened?: number
}

// ---- isolated runs (R2/R5/R12) ---------------------------------------------------------------------------------

/** The PrepareCard's rows, in order (Prepare steps 1 to 5). */
export const PREPARE_STEP_IDS = ['worktree', 'copy', 'deps', 'baseline', 'ready'] as const
export type PrepareStepId = (typeof PREPARE_STEP_IDS)[number]

/** One prepare row (core-derived). `skipped` rows say why in `detail`. */
export interface PrepareStepView {
  id: PrepareStepId
  status: PassStatus
  /** One line of UI copy: what the row did or why it waits, was skipped or failed. */
  detail?: string
}

/** The install the deps row runs (depsConsent / depsFailed show it too). */
export interface DepsCommandView {
  /** The package manager (pnpm, npm, uv, …; `custom` for a configured command). */
  manager: string
  argv: string[]
  /** Relative to the worktree's root, `/` separators (`.` for the root). */
  cwdRel: string
  lockfile?: string
  /** `detected` (the lockfile table), `config` (`isolation.worktree.installCommand`) or `edited` ([Edit command]). */
  source: 'detected' | 'config' | 'edited'
}

/** StepView.prepare. The install's output streams through `output` bodies for the file `prepare` (runs.output). */
export interface PrepareView {
  steps: PrepareStepView[]
  /** The worktree once made: `<home>/worktrees/<runId>` on its own branch from HEAD (`base`). */
  worktree?: { path: string; branch: string; base: string }
  /** Uncommitted changes in the folder the worktree does not include (it starts from HEAD). */
  uncommitted?: number
  deps?: DepsCommandView
}

/**
 * StepView.finalize `state`: `preview` (reading what Apply would do) · `pending` (the finalize card waits for a choice)
 * · `waiting` (Apply waits for the folder: another run holds it) · `applying` · `conflicts` (finalizeConflicts open) ·
 * `interrupted` (Dim Factory closed while applying: interruptedApply open) · `applied` · `kept` (Keep for later, or the run
 * stopped with its worktree) · `undoing` (Undo of an apply) · `discarding` (deferred deletion; undoable until
 * `deleteAt`) · `discarded`.
 */
export const FINALIZE_STATES = [
  'preview',
  'pending',
  'waiting',
  'applying',
  'conflicts',
  'interrupted',
  'applied',
  'kept',
  'undoing',
  'discarding',
  'discarded',
] as const
export type FinalizeState = (typeof FINALIZE_STATES)[number]

/** StepView.finalize (core-derived; the finalize, finalizeConflicts and interruptedApply cards read it too). */
export interface FinalizeView {
  state: FinalizeState
  /** Files the run changed in its worktree (the preview's writes and deletes, conflicts included). */
  files?: number
  /** Files whose folder content no longer equals the run's base (Keep mine / Take run's). */
  conflicts?: string[]
  /** Files the last apply wrote or deleted. */
  applied?: number
  /** worktree.undoApply's token for the last apply, while it can be undone. */
  undoToken?: string
  /** `discarding`: when the worktree is deleted, and worktree.undoDiscard's token. */
  deleteAt?: number
  discardToken?: string
  /** UI copy: why the last apply, undo or deletion did not finish. */
  error?: string
}

/**
 * An isolated run's worktree on the Dashboard and in history. `notApplied` drives the chip "Isolated: not applied"
 * (an unfinalized worktree is never deleted automatically): the worktree exists and the run's changes are not
 * in the folder (the finalize card waits, Keep for later, a stopped run, an apply undone). Never while an apply
 * Dim Factory's close interrupted waits for [Finish apply] (`state: 'interrupted'`): part of the changes may be in the
 * folder, and the chip reads "Isolated: apply interrupted" instead.
 */
export interface RunWorktreeSummary {
  state: FinalizeState | 'preparing' | 'working'
  notApplied: boolean
}

/**
 * A verify command's state in a round. `queued` / `running` while the round runs (core's live view); then the
 * round's result: `pass`, `fail` (a `[must]` finding), `env` (the environment could not run it: never a finding),
 * `skipped-untrusted` (Auto skipped it because it is not trusted: a `[should]` finding) or `skipped` (the user
 * skipped it, failFast stopped the round, or it cannot run as configured; `reason` says which).
 */
export const VERIFY_COMMAND_STATUSES = [
  'queued',
  'running',
  'pass',
  'fail',
  'env',
  'skipped-untrusted',
  'skipped',
] as const
export type VerifyCommandStatus = (typeof VERIFY_COMMAND_STATUSES)[number]

/** One command of a verify round (StepView.verify). */
export interface VerifyCommandView {
  name: string
  argv: string[]
  status: VerifyCommandStatus
  /** Exit code of a finished command (null: killed or never started). */
  exitCode?: number | null
  durationMs?: number
  /** The output excerpt (last lines plus error lines, at most 4 KB) of a failed or env command. */
  excerpt?: string
  /** Why it was skipped or could not run, as UI copy. */
  reason?: string
  /** Dim Factory's play-test: each scenario as passed or failed. */
  scenarios?: VerifyScenarioLine[]
}

/** StepView.verify (core-derived; the renderer only formats it). */
export interface VerifyStepView {
  commands: VerifyCommandView[]
  /** failFast stopped the round after a failure; the remaining commands read `skipped`. */
  aborted?: boolean
}

/**
 * `wait_until` (rate_limited / quota_exceeded): the retry a failed step waits for.
 * While `armed`, core retries the pass at `until` (its clock); executing the action (`actionId`) arms or disarms it.
 * An armed wait loads disarmed after Dim Factory restarts (crash relaunch), offering Retry now and Re-arm.
 */
export interface WaitView {
  actionId: string
  until: number
  armed: boolean
  /**
   * Why it is not armed: `user` disarmed it, `relaunch` = Dim Factory restarted, `offered` = Dim Factory does not arm it on
   * its own here (a usage limit, or the pass's automatic retry is spent).
   */
  disarmed?: 'user' | 'relaunch' | 'offered'
}

/** Prompt/diff size bucket used by estimates: <10 KB, <50 KB, <150 KB, ≥150 KB. */
export type InputBytesBucket = 0 | 1 | 2 | 3

/** Final attempt only. Feeds estimates and the Dashboard via runs/index.jsonl. */
export interface RunSummaryStep {
  key: StepKey
  vendor?: string
  model?: string | null
  /** The effort level the step ran at (absent: the vendor's default). */
  effort?: string
  mode?: Mode
  planMode?: PlanMode
  status: PassStatus
  activeMs: number
  usage?: Usage
  /** See StepView.usageApprox; the cost basis is then `none`. */
  usageApprox?: boolean
  costBasis?: CostBasis
  inBytesBucket?: InputBytesBucket
  failureCategory?: FailureCategory
  /** The pass's peak context use, compactions and baseline (no names); absent when its vendor reported none. */
  context?: ContextSummary
}

export interface RunProgress {
  tokens: number
  costUsd: number | null
  filesChanged: number
  /** Remaining active time (live ETA), as of when core built the summary. */
  etaMs?: number
  /** 'longer-than-usual' once a live step is past its p80 (then no etaMs); absent without an estimate. */
  etaState?: 'ok' | 'longer-than-usual'
  /** While the remaining time runs down with the clock, when the run is expected to end (format it − now). */
  etaEndsAt?: number
}

export interface FindingCounts {
  must: number
  should: number
}

export interface RunSummary {
  runId: string
  /** Monotonic per home; shown as "#N". */
  displayNo: number
  folder: string
  folderKey: string
  /** First 80 characters of the task. */
  title: string
  status: RunStatus
  phase: RunPhase
  outcome?: RunOutcome
  failure?: { step: StepKey; category: FailureCategory }
  profile: string
  /** The recipe the run used (`Recipe: New web app`); absent without one. */
  recipe?: RunRecipe
  auto: boolean
  isolation: IsolationMode
  pinned: boolean
  createdAt: number
  endedAt?: number
  /** runId of the run holding the folder lock this run queues behind. */
  blockedBy?: string
  /**
   * The run's folder lock (the scheduler's): `held` = it owns its folder, `requested` = it queues for it;
   * absent once released. Core republishes the summary when the lock is released, so a reader that asks core about
   * the folder (the composer's folder.lock) knows when to ask again.
   */
  lock?: 'held' | 'requested'
  /** An isolated run's worktree (the Dashboard chip "Isolated: not applied"); absent for in-place runs. */
  worktree?: RunWorktreeSummary
  /** The run this one re-runs ("Re-run of #N", "Re-run from Fix of #N"); absent for a run started anew. */
  rerunOf?: RerunSource
  /** A match's side: the match this run belongs to and the side it builds; absent for a run of its own. */
  matchOf?: MatchRef
  /**
   * What Re-run from Fix of this run would do (the Runs history row's action and tooltip), as
   * RunSnapshot.rerunFromFix says it. Absent in a summary an earlier build wrote.
   */
  rerunFromFix?: RerunFromFix
  /** Fix until green: rounds run, the cap, and why it stopped (absent in a run without it). */
  fixLoop?: { rounds: number; max: number; stop?: FixStopReason }
  /** The project's quality gates as the run ended (absent: none required, or the run has not ended). */
  gates?: QualityGatesView
  progress: RunProgress
  findings: FindingCounts
  steps: RunSummaryStep[]
}

/**
 * Branch prep: the run branch Dim Factory made at the pre-Implement boundary. `base` is the commit it
 * started at; `previous` is the branch HEAD named before (`refs/heads/<name>`) or `detached:<sha>`.
 */
export interface RunBranchInfo {
  name: string
  base: string
  previous: string
}

/**
 * The latest revert core made for a card choice (Revert Plan's changes, Restore run's version, Revert partial
 * then fresh) that `diff.undoRevert{runId, undoToken}` can still undo. A revert the user asked for through
 * `diff.revert` is not listed: its RevertResult carries its own token.
 */
export interface RevertUndoView {
  undoToken: string
  /**
   * What was reverted, as UI copy that reads after "Reverted": "Plan's changes", "Implement's partial changes", "your
   * edits outside the run" (Restore run's version puts the run's version back over them).
   */
  label: string
  /** Files restored or deleted. */
  files: number
  at: number
}

export interface RerunFromFix {
  available: boolean
  fresh: boolean
  reason?: FreshReason
  /** Why Re-run from Fix is not offered (UI copy, for the tooltip); absent while it is available. */
  unavailable?: string
  /**
   * The findings Fix gets when none are chosen (every must, plus the shoulds selected at the run's beforeFix gate),
   * in the run's list order; absent while Re-run from Fix is not available.
   */
  findingIds?: string[]
  /**
   * The findings Re-run from Fix offers (the picker's list), with the ids runs.rerun takes: the run's merged
   * list, or the done reviewers' findings when its Review/Critic join never ran (no findings.json then). In
   * RunSnapshot (runs.get) only, never in a RunSummary; absent while Re-run from Fix is not available.
   */
  findings?: Finding[]
}

/** The run a re-run started from (R14): Re-run (`start`) or Re-run from Fix (`fix`). */
export interface RerunSource {
  runId: string
  displayNo: number
  from: 'start' | 'fix'
}

export interface RunSnapshot {
  summary: RunSummary
  steps: Record<StepKey, StepView>
  asks: AskView[]
  cards: CardView[]
  allowRules: AllowRule[]
  notes: string[]
  branch?: RunBranchInfo
  /** The card revert that can still be undone (see RevertUndoView); absent when there is none. */
  revertUndo?: RevertUndoView
  /** Isolated-run finalize (the finalize step's FinalizeView, as StepView.finalize carries it). */
  finalize?: unknown
  rerunFromFix: RerunFromFix
  lastSeq: number
  /** The run's auto-answered asks, summed over its steps ("AUTO approved N"); absent while there are none. */
  autoAnswered?: AutoAnsweredCounts
  /** What guardrails did: rules in force (settings files not counted), and what fired. */
  guardrails?: { rules: number; fired: number; undone: number; stopped: boolean; blocked?: number }
  /** Fix until green's rounds (absent in a run without it, and until its first round starts). */
  fixLoop?: FixLoopView
  /**
   * The plan's acceptance criteria as a checklist (each Met, Not met, Unknown or Not checked, with evidence and the
   * tests mapped to it); absent while the decided plan has none.
   */
  acceptance?: AcceptanceView
  /**
   * Context health, once the run is over: per pass its peak, compactions, baseline and top contributors, and the
   * health items the detectors found (also runs/<id>/context-health.json). Absent while the run goes on, and when no
   * pass reported its context.
   */
  contextHealth?: ContextHealthReport
  /**
   * Adaptive depth: Quick or Thorough, who decided and why, and why a Quick run switched to thorough checks (the Run
   * view's header shows it). Absent: no decision recorded (an earlier build's run).
   */
  depth?: RunDepthView
  /**
   * Findings that turned out wrong: how many findings Fix disputed, and of those how many the checks after Fix
   * confirmed were fine (the end panel shows it). Absent: Fix disputed nothing.
   */
  findingsWrong?: { disputed: number; wrong: number }
}

// ---- persisted event bodies (events.jsonl) -----------------------------------

/** `auto`: approved because the run was switched to Auto while the pass that asked was running. */
export type AskResolvedBy = 'user' | 'timeout' | 'vendor-cancel' | 'stop' | 'auto'

export const RUN_OUTPUT_FILES = [
  'plan',
  'plan.original',
  'review',
  'critic',
  'findings',
  'resolved',
  'verify',
  'heal',
  /** A verify round's combined output (runs.output), announced by `output` bodies while the round runs. */
  'verify:1',
  'verify:2',
  /** The baseline round (isolated runs) and the dependency install's output (the PrepareCard). */
  'verify:0',
  'prepare',
  /** Test-first: the red check's output (announced like verify:1's), and the Tests step's answer. */
  'verify:red',
  'tests',
  /** The security advisor: the Security pass's answer, the scan's facts (announced as they change), the re-check's answer. */
  'security',
  'scan',
  'recheck',
  /** Clarify's answer (the questions as the vendor wrote them), and Fix until green's rounds (announced as they change). */
  'clarify',
  'rounds',
  /** Research: research.md (Dim Factory's rendering of the cited answer) and research.json (the parsed answer). */
  'research',
  'research.json',
  /** The Deploy step: its answer, and its facts (announced as they change). */
  'deploy',
  /** The plan's acceptance criteria and their statuses (acceptance.json, rewritten as they change). */
  'acceptance',
  /** Explain it to me: the plain-language summary of the run (explain.md). */
  'explain',
] as const
export type RunOutputFile = (typeof RUN_OUTPUT_FILES)[number]

export const RUN_EVENT_TYPES = [
  'ev',
  'step-status',
  'run-status',
  'card',
  'ask-resolved',
  'ask-extended',
  'auto-answered',
  'snag',
  'usage',
  'context',
  'diff-stats',
  'output',
  'guardrail',
] as const

export type RunEventBody =
  | { t: 'ev'; step: StepKey; attempt: number; ev: NormalizedEvent }
  | {
      t: 'step-status'
      step: StepKey
      attempt: number
      status: PassStatus
      reason?: string
      pause?: PauseReason
      sessionNote?: string
      /** StepView.freshDetail (with a "fresh session: …" note). */
      freshDetail?: FreshDetail
      route?: string
      argv?: string[]
      planMode?: PlanMode
      planFallbackReason?: string
      /**
       * Live balanced run: StepView.modelUsed and StepView.modelReplaced; also StepView.modelAsked and
       * StepView.modelRerouted.
       */
      modelUsed?: string
      modelReplaced?: string
      modelAsked?: string
      modelRerouted?: string
    }
  | { t: 'run-status'; status: RunStatus; phase: RunPhase; outcome?: RunOutcome }
  | { t: 'card'; card: CardView; state: 'open' | 'resolved'; choiceId?: string }
  | {
      t: 'ask-resolved'
      step: StepKey
      requestId: string
      by: AskResolvedBy
      via?: AnswerVia
      decision?: AskDecision
    }
  | { t: 'ask-extended'; step: StepKey; requestId: string; expiresAt: number }
  | {
      t: 'auto-answered'
      step: StepKey
      attempt: number
      requestId?: string
      tool: string
      decision: AskDecision
      why: AutoAnswerReason
    }
  | { t: 'snag'; step: StepKey; failure: Failure; actions: RecoveryAction[] }
  | { t: 'usage'; step: StepKey; attempt: number; usage: Usage; costBasis: CostBasis }
  /**
   * The pass's context meter changed (throttled: a new percent point, a compaction starting or ending, the window
   * becoming known). `used`/`window`/`percent` as StepView.context has them.
   */
  | {
      t: 'context'
      step: StepKey
      attempt: number
      used?: number
      window?: number
      percent?: number
      compactions: number
      compacting: boolean
    }
  | { t: 'diff-stats'; files: number; added: number; deleted: number; live: boolean }
  | { t: 'output'; file: RunOutputFile; version: number }
  /** A guardrail fired. `undone`: the change was put back before the pass's end snapshot. */
  | { t: 'guardrail'; step: StepKey; finding: GuardrailFinding; undone: boolean; blocked?: boolean }

export type RunEventType = RunEventBody['t']
export type RunEventOf<T extends RunEventType> = Extract<RunEventBody, { t: T }>

/** `seq` is per run, monotonic from 1 (the events.jsonl header is seq 0) and owned by the bus. */
export interface RunEnvelope {
  runId: string
  seq: number
  ts: number
  body: RunEventBody
}
