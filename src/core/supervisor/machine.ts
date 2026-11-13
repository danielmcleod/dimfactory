// The run/pass state machine as a pure reducer.
//
//   reduce(state, event, ctx?) → { state, effects, transition }
//
// Pure: time comes only from `event.at`; request/card ids come from counters in the state; no I/O, no Date.now,
// no randomness. The input state is never mutated. Effects run in array order (see types.ts `Effect`).
//
// Pass rows P1–P26 (P21: the retry strategies auto / resume / fresh / keep-changes / revert-then-fresh) and run
// rows R1–R14 with R2b.
// The run sequence: R6 (S1 → reconcile(pre-review) → Review ∥ Critic, spawned in the same
// reduction), P15 read-only ⇒ `parseFindings` (+ `findings-result`, the one budgeted retry of an empty output, the
// emptyFindings card), R8 (post-review snapshot, then first match: failed · paused · skip rule → clean · Fix
// disabled → findings-open · gate:beforeFix · pre-Fix), R9 (gate choices), R10 (reconcile(pre-fix) → F0 →
// decideSession → Fix P1) and R11 (S2 → completed(fixed)). A verify round that is off is skipped by P2 ("verify off")
// in its own row, as are prepare and finalize for an in-place run.
// A relaunch or quit at a run-level boundary (S1, reconcile(pre-review), the post-review snapshot, S2, a findings
// parse) re-issues that work but holds the pass it leads to (`flow.hold` → paused) until the user resumes.
// Session reuse: decideSession v1 (sessions.ts) right before Fix P1, fed by the controller's `session-check`
// (adapter.canResume, Fix's folder, the vendor's capabilities); a resume rejected at startup (resume_failed) restarts
// the pass fresh ("fresh session: resuming failed") without a new attempt or the retry budget. A fresh step carries
// `freshDetail` when its reason alone does not say why (rule 4's vendor capability; a resume_failed new attempt).
// Git (branch prep, reconciliation, revert to S0): reconcile verdicts at every boundary (R5 / R10 inside
// the pass's launch, R6/R7 at the run level, P15 after a mutating pass) become notes, Implement's chip or a reconcile
// card (`choice` with its default, `block` without); runBranch ⇒ the `branch` effect at R5 after the reconcile; the
// R4 plan-end guard (planMutated); reverts (diff.revert and its undo, Revert Plan's changes, revert-then-fresh,
// Restore run's version) as `revert` effects that never overlap a spawn. Reverts and the run branch are recorded before
// any write (`revert-started`, `branch-intent`), scoped revert ranges have explicit snapshot ends, an undo only applies
// over what its revert wrote, and revert-then-fresh reverts only the failed attempt's changes.
// Recovery (P17/P22): P22 applies a checked `config_patch` (the controller holds the ResolvedConfig) to
// the run's config and retries the pass (or skips it when the patch turned it off); P17 starts the healer for an
// unknown or heuristic failure when selfHeal is on, and "Diagnose with AI" starts it for a known one (`heal`
// effect → `heal-result`, kept as StepState.heal; autoApplyConfigPatches applies a suggested patch through P22,
// spending the pass's automatic retry); a snag's `wait_until` is armed as a `wait` timer (by Dim Factory only while the
// automatic retry is unspent) that retries the pass at its time, and loads disarmed after a relaunch.
// Verify step (R6/R7/R11): verify:1 after Implement and verify:2 after Fix are runner steps.
// A round starts with a trust check (`verifyCheck`: every configured command's body re-read against trust.json); an
// untrusted or changed command opens a `trust` card (non-Auto: [Trust for this project] writes the command grant,
// [Skip] leaves it out) or is skipped with a `[should]` finding (Auto never implies trust); then the round runs
// (`verify`). Environment failures open `verifyEnv` [Retry] [Skip verify] (Auto takes Skip verify with a note) and are
// never findings; a failing command is a `[must]` finding (source verify) that joins the reviewers' at R8 and counts
// against the Fix skip rule. R7: the post-verify-1 snapshot, then reconcile(pre-review). R11: a verify:2 failure
// completes the run as verify-failed ("Completed with failures"). Stop cancels a round (tree kill), a relaunch pauses
// it, and Resume reruns it from its trust check.
// Isolated runs (worktree; the verify:0 baseline; R2/R5/R12; see the section at the end): an isolated
// run prepares its worktree first (steps 1 and 2), then Plan ∥ run-start ∥ deps → the verify:0 baseline →
// isolation.verifyReady, which R5 waits for; a baseline failure is pre-existing (a [should] that neither blocks the
// skip rule nor makes the run verify-failed). R12: the outcome is fixed, then finalize (preview, the finalize card,
// Apply under the folder's lease with conflicts and the interruptedApply card after a crash, Keep, Discard deferred
// 10 s), then the run completes.
// Test-first (the Brief's approach; RunConfig.testFirst): after the plan is decided, the `tests` step (a mutating pass
// on the Implement pass's config, the run's first mutating pass: it takes R5's reconcile and branch prep, and its start
// snapshot T0 is the base of the run's changes) writes failing tests; its end snapshot T1 lists the files it changed.
// The `verify:red` round must show them failing: failures there are expected, never findings; a round with no failing
// command opens testsNotRed ([Rewrite the tests] [Continue anyway] [Stop run]). The post-red snapshot, then Implement
// (verify:1 always runs after it). After Implement's S1, Dim Factory compares the Tests step's files at T1 and S1
// (`testsCheck`): a deleted or weakened test file is a `[must]` finding (source tests) that joins the reviewers' at R8.
// Clarify (RunConfig.clarify): before Plan, a read-only pass on the Plan pass's config may ask a few multiple-choice
// questions (structured JSON, or a fenced JSON block). Questions open the Clarify card, blocking with no default (it
// waits even in Auto); the answers join the run's brief (`{{brief}}`), then Plan starts. No questions or an unreadable
// answer lets Plan start with a note; Auto skips Clarify unless `inAuto`.
// Research (RunConfig.research): after Clarify and before Plan, a confined read-only pass on the Plan pass's config
// (no edits, no shell, no agents; web search where the vendor has it, else the repository lens only) answers with cited
// JSON. Uncited claims are dropped; what is left opens the research card (blocking, its default keeps the must-haves
// and recommendations, which Auto takes). The items kept become `{{research}}` in the Plan prompt. Nothing usable, or
// "Plan without research", lets Plan start with a note.
// Fix until green (RunConfig.fixLoop): each round is a new attempt of Fix (its own start snapshot, R10's reconcile and
// decideSession against the previous round's session), then verify:2 and the re-check of the round's [must] findings.
// Green (none open, verify passes) completes as fixed; the round cap, the budget (cost or working time, the next round
// expected to cost what the last did) or a round without progress completes as fix-stopped. Between rounds, the
// post-round snapshot; each round's three steps are kept as they ended (RunSnapshot.fixLoop).
// Deploy (RunConfig.deploy): once the run's outcome is decided and it completed without failures (fixed, clean or
// findings open), the outcome is held (`deploy.pending`) while the Deploy step plans (`deployPlan`: classify the
// folder, pick the target, list the missing config files) and, when files are missing, runs an editing pass on the
// Implement pass's config (deploy-start, the pass, deploy-end and its end-of-pass check). Then the run completes with
// the held outcome (an isolated run finalizes first, so the config is applied with the rest). Dim Factory never runs a
// deploy.
// Acceptance criteria: once the plan is decided (its gate's edits included), its `## Acceptance criteria` list is
// parsed into AC1…ACn (acceptance.json); Test-first's Tests step maps tests to them. The acceptance review
// (RunConfig.acceptance): after verify:1 and the scan, before Review ∥ Critic ∥ Security, a read-only pass on Review's
// config (Critic's, then Plan's, when Review is off) marks each criterion met, not met or unknown with evidence. With
// Fix until green, an unmet criterion is a [must] finding (source acceptance) that joins the reviewers' at R8 and is
// confirmed by each round's re-check; otherwise the review is a summary note only and never changes the outcome. It is
// skipped with a note when the plan has no criteria.
// Explain it to me (RunConfig.explain): once the outcome is decided (every outcome but no-changes), it is held
// (`explain.pending`) while a read-only pass on Plan's config (Review's when Plan is off) writes explain.md, after the
// Deploy step and before finalize. Explain never changes the outcome.
import type { GuardrailFinding } from '../../shared/guardrails.ts'
import { rulesInForce } from '../../shared/guardrails.ts'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import { ASK_KINDS } from '../../shared/events.ts'
import type {
  AdapterSignal,
  AllowRule,
  AskDecision,
  AskKind,
  NormalizedEventOf,
  Usage,
} from '../../shared/events.ts'
import { applyContextSignal, applyToolEvent, contextEventDue, newContextState } from '../context/state.ts'
import { contextHealthOf, contextHealthRunConfig } from '../context/policy.ts'
import type { Failure, GrantCommand, RecoveryAction, RetryStrategy } from '../../shared/failure.ts'
import { isSecurityFinding, triggersFix } from '../../shared/findings.ts'
import { mergeReviewerFindings } from '../findings/merge.ts'
import { DEPTH_ESCALATED_NOTE } from '../../shared/depth.ts'
import type { FindingSource } from '../../shared/findings.ts'
import { fileSafe } from '../../shared/ids.ts'
import { isGeneratedPath } from '../../shared/generated-paths.ts'
import type { ResultCode } from '../../shared/ipc.ts'
import type { PreflightReport } from '../../shared/preflight.ts'
import {
  AGENT_STEPS,
  CLARIFY_ANSWER_MAX,
  FIX_ROUNDS_MAX,
  FRESH_DETAIL_REASON,
  ROUTED_STEPS,
  STEP_KEYS,
  configPassOf,
  isAgentStep,
} from '../../shared/run.ts'
import { MATCH_TEXT } from '../../shared/match.ts'
import { supportsEffort } from '../../shared/vendors.ts'
import type {
  AgentStep,
  AnswerVia,
  AskResolvedBy,
  CardChoiceValue,
  CardKind,
  CardView,
  FinalizeState,
  FixStopReason,
  FreshReason,
  PassName,
  PassStatus,
  PauseReason,
  PlanMode,
  PrepareStepId,
  RunEventBody,
  RunOutcome,
  RunOutputFile,
  StepCost,
  StepKey,
  StepView,
} from '../../shared/run.ts'
import { parseRecheck } from '../security/recheck.ts'
import { fixReportById, parseFixReport } from '../findings/parse.ts'
import { fixContradictions } from '../grounding/checks.ts'
import type { VerifyFact } from '../grounding/checks.ts'
import { newGroundingTrack, noteTool } from '../grounding/evidence.ts'
import { parseClarify, withClarifyAnswers } from '../clarify/parse.ts'
import { RESEARCH_PARSE_NOTE, parseResearch } from '../research/parse.ts'
import { renderResearchMd } from '../research/render.ts'
import { RESEARCH_ANSWER_MAX, autoResearchChoice, parseResearchEntry } from '../../shared/research.ts'
import { parseAcceptanceAnswer, parseCriteria, parseTestsMapping } from '../acceptance/parse.ts'
import { acceptanceView } from './acceptance-view.ts'
import { acceptanceCounts, acceptanceSummaryText } from '../../shared/acceptance.ts'
import type { AcceptanceFile } from '../../shared/acceptance.ts'
import { tokenizeCommandLine } from '../verify/argv.ts'
import {
  META_LATE_ALLOW_RULE,
  META_MODEL_USED,
  META_PLAN_FALLBACK,
  META_PLAN_SOURCE,
  META_RESUME_IGNORED,
  META_SESSION_MODEL,
  META_STRUCTURED_OUTPUT,
  META_USAGE,
  META_USAGE_APPROX,
} from '../adapters/types.ts'
import { CATEGORY_INFO, retryPolicy } from '../heal/categories.ts'
import type { RetryContext } from '../heal/categories.ts'
import {
  CHOICE,
  CLARIFY_CHOICE,
  CONFLICT_CHOICE,
  DEPS_CHOICE,
  FINALIZE_CHOICE,
  INTERRUPTED_APPLY_CHOICE,
  PLAN_MUTATED_CHOICE,
  RECONCILE_CHOICE,
  RESEARCH_CHOICE,
  TESTS_NOT_RED_CHOICE,
  TRUST_CHOICE,
  VERIFY_ENV_CHOICE,
  afterPlanGateCard,
  beforeFixGateCard,
  cardId,
  clarifyCard,
  defaultSnagActions,
  depsConsentCard,
  depsFailedCard,
  emptyFindingsCard,
  emptyOutputText,
  finalizeCard,
  finalizeConflictsCard,
  insufficientContextCard,
  interruptedApplyCard,
  LOOP_STOP_MESSAGE,
  loopCard,
  REACTION_CHOICE,
  restartFreshCard,
  planMutatedCard,
  preflightCard,
  reasonLine,
  reconcileCard,
  reconcilePayloadOf,
  researchCard,
  retryPartialCard,
  stallCard,
  stepLabel,
  testsNotRedCard,
  trustCard,
  trustPayloadOf,
  verifyEnvCard,
  verifyEnvStepOf,
} from './cards.ts'
import type { DepsCardInput, VerifyEnvCommand } from './cards.ts'
import type { ReconcileCardPayload } from './cards.ts'
import { HEAL_INTERRUPTED, interruptPendingReverts } from './loaded-state.ts'
import { PREPARE_SKIP, plannedPrepareRows, worktreeSummary } from './isolation-view.ts'
import { missingSegmentText, runBaseSnap, segmentEnds } from './diff-segments.ts'
import {
  activeMsAt,
  addAutoAnswered,
  addAutoApproved,
  anyLiveProc,
  installInFlight,
  verifyRoundInFlight,
  isCardRevert,
  deriveStatus,
  derivePhase,
  isLiveStatus,
  isTerminalPassStatus,
  selectedFindings,
  stepSpend,
  toStepView,
  totalCost,
} from './derive.ts'
import {
  acceptanceOn,
  clarifyOn,
  deployOn,
  explainOn,
  fixLoopOn,
  fixRoundsMax,
  recheckAll,
  recheckOn,
  recheckPass,
  researchOn,
  securityOn,
  stepPassConfig,
} from './step-use.ts'
import {
  EXIT_GRACE_MS,
  KILL_GRACE_MS,
  defaultDenyGraceMs,
  hardDeadline,
  idleBase,
  inactivityTimersWanted,
  parseTimerId,
  stallDeadline,
  timerId,
} from './timers.ts'
import {
  SESSION_NOTE,
  canResumeFrom,
  decideSession,
  decidedByCapability,
  decideImplementSession,
  fixLaunchSessionInputs,
  implementSessionInputs,
  planKeepsSession,
} from './sessions.ts'
import type {
  ApplyRecord,
  AskCancelReason,
  AcceptanceState,
  ClarifyState,
  ConfigPatchRecord,
  DeployRunState,
  ResearchState,
  FixLoopState,
  FixRoundState,
  GroundingRunState,
  AskState,
  CardState,
  DepsCommandState,
  DepsState,
  Effect,
  EngineEvent,
  EngineEventBody,
  FinalizeOp,
  FinalizeRunState,
  Finding,
  FindingInput,
  FindingsFile,
  FindingsState,
  GitHead,
  HealState,
  InstallOutcome,
  IsolationState,
  LaunchPlan,
  PendingLaunch,
  PendingRequest,
  PrepareStage,
  ReconcileBoundary,
  ReconcileCardInput,
  ReconcileInput,
  ReconcileResult,
  Reduction,
  ReducerContext,
  RevertRecord,
  RevertWhy,
  ReviewerPass,
  RunConfig,
  RunGitState,
  RunInit,
  RunPassConfig,
  RunState,
  ScanAuditState,
  ScanCheckAudit,
  ScanRunAudit,
  ScanState,
  SessionCheck,
  SnapshotLabel,
  SnapshotPurpose,
  SnapshotRef,
  SourceFindings,
  StepState,
  UserCommand,
  VerifyCheckCommand,
  VerifyCommandState,
  VerifyResultInput,
  VerifyRound,
  VerifyRoundState,
  VerifyRunCommand,
} from './types.ts'

// ---- constants -----------------------------------------------------------------------------------------------

/** The first build's steps (kept for tests of that tail). */
export const PLAN_IMPLEMENT_BUILD_STEPS = [
  'preflight',
  'plan',
  'implement',
] as const satisfies readonly StepKey[]

/** The steps without verify (kept for tests of the sequence without verify). */
export const REVIEW_BUILD_STEPS = [
  'preflight',
  'plan',
  'implement',
  'review',
  'critic',
  'fix',
] as const satisfies readonly StepKey[]

/** Those plus the verify rounds after Implement and Fix (kept for tests of that build). */
export const VERIFY_BUILD_STEPS = [
  ...REVIEW_BUILD_STEPS,
  'verify:1',
  'verify:2',
] as const satisfies readonly StepKey[]

/** Those plus isolated runs (prepare, the verify:0 baseline, finalize). */
export const ISOLATED_BUILD_STEPS = [
  ...VERIFY_BUILD_STEPS,
  'prepare',
  'verify:0',
  'finalize',
] as const satisfies readonly StepKey[]

/**
 * Steps this build implements: those plus Test-first's `tests` step and its `verify:red` round, the security
 * advisor's `scan`, `security` and `recheck` steps, Clarify before Plan, Research after it, the Deploy step, the
 * acceptance review and Explain it to me.
 */
export const BUILD_STEPS = [
  ...ISOLATED_BUILD_STEPS,
  'tests',
  'verify:red',
  'scan',
  'security',
  'recheck',
  'clarify',
  'research',
  'deploy',
  'acceptance',
  'explain',
] as const satisfies readonly StepKey[]

export { PREPARE_SKIP, plannedPrepareRows }

export const SKIP_REASON = {
  disabled: 'disabled',
  notInBuild: 'not in this build',
  inPlace: 'in place',
  verifyOff: 'verify off',
  noChanges: 'no changes',
  user: 'user',
  /** R8 skip rule: every enabled reviewer reported nothing (or no findings to address). */
  noFindings: 'no findings',
  /** R9: Continue with 0 findings. */
  noneSelected: 'no findings selected',
  /** Quieter reviews: nothing listed came with evidence of a real problem. */
  noEvidence: 'nothing with evidence',
  /** A later step whose predecessor did not run (verify:2 without Fix). */
  notNeeded: 'not needed',
  /** Test-first's steps in a run without it. */
  notUsed: 'not used',
  /** Clarify in an Auto run (unless `clarifyInAuto`). */
  auto: 'skipped in Auto',
  /** The acceptance review when the decided plan lists no acceptance criteria. */
  noCriteria: 'no criteria',
  /** The security reviewer of a run that reviews only sensitive changes, when the scan found none. */
  notSensitive: 'not needed: no keys or personal data changed',
} as const

/**
 * A run whose security reviewer runs only for sensitive changes (`passes.security.review: 'sensitive'`): the scan has
 * read the changes and found nothing that handles keys, sign-in, payments or people's data, and no secret. The scan
 * itself always runs.
 */
function reviewNotNeeded(s: RunState): boolean {
  if (s.config.passes.security.review !== 'sensitive') return false
  const sc = s.security?.scan
  if (sc?.phase !== 'done') return false
  return sc.sensitive !== true && sc.findings.length === 0
}

/**
 * The read-only passes whose output becomes findings; Review ∥ Critic ∥ Security is one join node (the scheduler).
 * Security takes part only when the security advisor is on (otherwise it is settled as not used from the start).
 */
export const REVIEWER_PASSES = ['review', 'critic', 'security'] as const satisfies readonly ReviewerPass[]

export function isReviewerStep(k: StepKey): k is ReviewerPass {
  return k === 'review' || k === 'critic' || k === 'security'
}

export const CONTINUATION = {
  interrupted: 'Continue. The previous turn was interrupted.',
  askTimeout: 'continue',
  denied: (detail: string): string => `The user denied ${detail}; do not retry it.`,
  failed: (message: string): string => `Previous attempt failed: ${message}; continue.`,
} as const

export const DEFAULT_CONTEXT: ReducerContext = {
  retryPolicy: (category, failure, rctx) => retryPolicy(category, failure, rctx),
  recoveryActions: defaultSnagActions,
  buildSteps: BUILD_STEPS,
}

const AFTER_IMPLEMENT = [
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
] as const satisfies readonly StepKey[]

type MutatingPass = 'tests' | 'implement' | 'fix' | 'deploy'

export const MUTATING_PASSES = [
  'tests',
  'implement',
  'fix',
  'deploy',
] as const satisfies readonly MutatingPass[]

export function isMutatingStep(k: StepKey): k is MutatingPass {
  return k === 'implement' || k === 'fix' || k === 'tests' || k === 'deploy'
}

const START_LABEL: Readonly<Record<MutatingPass, SnapshotLabel>> = {
  tests: 'T0',
  implement: 'S0',
  fix: 'fix-start',
  deploy: 'deploy-start',
}
const END_LABEL: Readonly<Record<MutatingPass, SnapshotLabel>> = {
  tests: 'T1',
  implement: 'S1',
  fix: 'S2',
  deploy: 'deploy-end',
}
/** The end snapshot also lists the paths the pass changed (Test-first's tests, the Deploy step's config files). */
const listsChanged = (k: MutatingPass): boolean => k === 'tests' || k === 'deploy'
const startLabel = (k: MutatingPass): SnapshotLabel => START_LABEL[k]
const endLabel = (k: MutatingPass): SnapshotLabel => END_LABEL[k]

export { configPassOf, runBaseSnap }

/** A step's pass config (the Tests step's is Implement's, Clarify's Plan's, the re-check's as recheckPass places it). */
export function passCfg(s: Pick<RunState, 'config'>, k: AgentStep): RunPassConfig {
  // Model routing: a routed step runs its own model and effort on its pass's vendor, where the profile names them.
  return stepPassConfig(s, k)
}

/** Test-first is on for this run. */
export function testFirstOn(s: Pick<RunState, 'config'>): boolean {
  return s.config.testFirst === true
}

export {
  acceptanceOn,
  clarifyOn,
  deployOn,
  explainOn,
  fixLoopOn,
  fixRoundsMax,
  recheckAll,
  recheckOn,
  recheckPass,
  researchOn,
  securityOn,
}

/** The security advisor's steps. */
export const SECURITY_STEPS = ['scan', 'security', 'recheck'] as const satisfies readonly StepKey[]

/**
 * Test-first's steps in a run without it (never started, never shown, never settled: no events), Clarify in a run
 * without it (the same), and the security advisor's in a run without it (settled as not used from the start, so they
 * are never shown). The re-check is used by the advisor or by Fix until green.
 */
export function unusedStep(s: Pick<RunState, 'config'>, k: StepKey): boolean {
  if (k === 'scan' || k === 'security') return !securityOn(s)
  if (k === 'recheck') return !securityOn(s) && !recheckAll(s)
  if (k === 'clarify') return !clarifyOn(s)
  if (k === 'research') return !researchOn(s)
  if (k === 'deploy') return !deployOn(s)
  if (k === 'acceptance') return !acceptanceOn(s)
  if (k === 'explain') return !explainOn(s)
  return (k === 'tests' || k === 'verify:red') && !testFirstOn(s)
}

// ---- construction ------------------------------------------------------------------------------------------

/** A round's command names made unique in order (`test`, `test (2)`): its rows, results and logs are keyed by them. */
export function uniqueVerifyNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.map((name) => {
    let n = name
    for (let i = 2; seen.has(n); i++) n = `${name} (${i})`
    seen.add(n)
    return n
  })
}

/** RunConfig.verify.names: the enabled commands' names (absent when there is none). */
function verifyNamesOf(cfg: ResolvedConfig): { names?: string[] } {
  const names = uniqueVerifyNames(cfg.verify.commands.filter((c) => c.enabled ?? true).map((c) => c.name))
  return names.length > 0 ? { names } : {}
}

export function runConfigFromResolved(
  cfg: ResolvedConfig,
  planMode: PlanMode = cfg.planning.native === 'auto' ? 'native' : 'emulated',
): RunConfig {
  const pass = (p: PassName): RunPassConfig => ({
    enabled: cfg.passes[p].enabled,
    vendor: cfg.passes[p].vendor,
    model: cfg.passes[p].model,
    effort: cfg.passes[p].effort,
    extensions: cfg.passes[p].extensions,
    mode: cfg.passes[p].mode,
  })
  const quality = qualityOf(cfg)
  const routing = routingOf(cfg)
  return {
    guardrailRules: rulesInForce(cfg.guardrails).length,
    auto: cfg.auto,
    gates: { afterPlan: cfg.gates.afterPlan, beforeFix: cfg.gates.beforeFix },
    denyPauses: cfg.ask.denyPauses,
    timeouts: { ...cfg.timeouts },
    selfHeal: cfg.selfHeal.enabled,
    isolation: cfg.isolation.mode,
    branch: cfg.isolation.branch,
    verify: {
      enabled: cfg.verify.enabled,
      runAfter: [...cfg.verify.runAfter],
      baseline: cfg.verify.baseline,
      ...verifyNamesOf(cfg),
    },
    passes: {
      plan: pass('plan'),
      implement: pass('implement'),
      review: pass('review'),
      critic: pass('critic'),
      security: {
        ...pass('security'),
        recheck: cfg.passes.security.recheck,
        // Read defensively: a config from before the key has none (the reviewer always runs).
        ...((cfg.passes.security as Partial<ResolvedConfig['passes']['security']>).review === 'sensitive'
          ? { review: 'sensitive' as const }
          : {}),
      },
      fix: { ...pass('fix'), reuseSession: cfg.passes.fix.reuseSession },
    },
    planMode,
    ...(cfg.passes.plan.clarify
      ? {
          clarify: {
            questions: cfg.passes.plan.clarifyQuestions,
            inAuto: cfg.passes.plan.clarifyInAuto,
            // Read defensively: a hand-made config may leave the key out.
            ...((cfg.passes.plan as Partial<ResolvedConfig['passes']['plan']>).clarifyPlain === true
              ? { plain: true as const }
              : {}),
          },
        }
      : {}),
    ...(cfg.passes.fix.rounds > 1
      ? {
          fixLoop: {
            rounds: cfg.passes.fix.rounds,
            recheck: cfg.passes.fix.recheck,
            ...(cfg.passes.fix.maxCostUsd !== null ? { maxUsd: cfg.passes.fix.maxCostUsd } : {}),
            ...(cfg.passes.fix.maxMinutes !== null ? { maxMinutes: cfg.passes.fix.maxMinutes } : {}),
          },
        }
      : {}),
    ...(cfg.isolation.mode === 'worktree'
      ? {
          worktree: {
            install: cfg.isolation.worktree.install,
            autoApply: cfg.isolation.worktree.autoApply,
          },
        }
      : {}),
    ...(cfg.passes.implement.deploy ? { deploy: { target: cfg.passes.implement.deployTarget } } : {}),
    // Read defensively: a hand-made config may leave the keys out.
    ...((cfg.passes.review as Partial<ResolvedConfig['passes']['review']>).acceptance === true
      ? { acceptance: true as const }
      : {}),
    ...((cfg.passes.plan as Partial<ResolvedConfig['passes']['plan']>).explain === true
      ? { explain: true as const }
      : {}),
    ...((cfg.passes.plan as Partial<ResolvedConfig['passes']['plan']>).explainPlain === true
      ? { explainPlain: true as const }
      : {}),
    // The project's quality gates (read defensively: a config from before the factory has none).
    ...(quality !== undefined ? { quality } : {}),
    ...(routing !== undefined ? { routing } : {}),
    contextHealth: contextHealthRunConfig(cfg),
    // Quieter reviews: only findings with evidence go to Fix, unless the config says every finding does.
    ...((cfg.passes.fix as Partial<ResolvedConfig['passes']['fix']>).trigger !== 'all'
      ? { fixTrigger: 'evidence' as const }
      : {}),
    // Continuity: Implement may continue Plan's session (on unless the config turns it off).
    ...((cfg.passes.implement as Partial<ResolvedConfig['passes']['implement']>).continuePlan !== false
      ? { continuity: true as const }
      : {}),
  }
}

export { contextHealthOf, contextHealthRunConfig }

/** RunConfig.quality: the gates a run must pass, when the project turned them on and requires anything. */
function qualityOf(cfg: ResolvedConfig): RunConfig['quality'] {
  const q = (cfg as Partial<ResolvedConfig>).quality
  if (q === undefined || !q.enabled) return undefined
  if (q.verify.length === 0 && !q.security && !q.acceptance) return undefined
  return { verify: [...q.verify], security: q.security, acceptance: q.acceptance }
}

/** RunConfig.routing: the routed steps that name a model or an effort. */
function routingOf(cfg: ResolvedConfig): RunConfig['routing'] {
  const r = (cfg as Partial<ResolvedConfig>).routing
  if (r === undefined) return undefined
  const out: NonNullable<RunConfig['routing']> = {}
  for (const k of ROUTED_STEPS) {
    const route = r[k]
    if (route === undefined || (route.model === undefined && route.effort === undefined)) continue
    out[k] = {
      ...(route.model !== undefined ? { model: route.model } : {}),
      ...(route.effort !== undefined ? { effort: route.effort } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function emptyStep(key: StepKey): StepState {
  return {
    key,
    status: 'queued',
    attempt: 0,
    spawnNo: 0,
    activeMs: 0,
    inFlightTools: [],
    asks: [],
    snagOpen: false,
    autoRetryUsed: false,
    meta: {},
  }
}

export function titleFromTask(task: string): string {
  const first = task.trim().split(/\r?\n/, 1)[0] ?? ''
  return first.length > 80 ? first.slice(0, 80) : first
}

/**
 * A queued run before R1. Apply `{t:'created'}` to announce it. The security advisor's steps of a run without it are
 * settled as not used from the start (the timeline never shows them), and so is the re-check when it is turned off.
 */
export function initRunState(init: RunInit): RunState {
  const s = baseRunState(init)
  for (const k of SECURITY_STEPS) {
    // Fix until green's re-check uses the step even without the advisor.
    if (k === 'recheck' && recheckAll(s)) continue
    if (!securityOn(s)) Object.assign(s.steps[k], { status: 'skipped', reason: SKIP_REASON.notUsed })
    else if (k === 'recheck' && !recheckOn(s))
      Object.assign(s.steps[k], { status: 'skipped', reason: SKIP_REASON.disabled })
  }
  return s
}

function baseRunState(init: RunInit): RunState {
  return {
    schemaVersion: 1,
    runId: init.runId,
    displayNo: init.displayNo,
    folder: init.folder,
    folderKey: init.folderKey,
    title: init.title ?? titleFromTask(init.task),
    task: init.task,
    profile: init.profile,
    ...(init.recipe !== undefined ? { recipe: init.recipe } : {}),
    createdAt: init.createdAt,
    config: init.config,
    started: false,
    lock: 'none',
    status: 'queued',
    phase: 'queued',
    steps: Object.fromEntries(STEP_KEYS.map((k) => [k, emptyStep(k)])) as Record<StepKey, StepState>,
    cards: [],
    timers: {},
    requests: {},
    counters: { req: 0, card: 0 },
    flow: { runStart: 'none', prepared: 'none' },
    plan: { decided: false, text: null, edited: false },
    allowRules: [],
    sessions: {},
    snapshots: {},
    outputs: {},
    notes: [],
    liveCount: false,
    ...(init.brief !== undefined && init.brief !== '' ? { brief: init.brief } : {}),
    ...(init.category !== undefined ? { category: init.category } : {}),
    ...(init.securityFocus !== undefined && init.securityFocus !== ''
      ? { securityFocus: init.securityFocus }
      : {}),
    ...(init.memory !== undefined && init.memory !== '' ? { memory: init.memory } : {}),
    // An isolated run's prepare rows exist from its start (the PrepareCard never grows rows).
    ...(init.config.isolation === 'worktree' ? { isolation: { rows: plannedPrepareRows(init.config) } } : {}),
    ...(init.matchOf !== undefined ? { matchOf: { ...init.matchOf } } : {}),
    ...(init.copyFrom !== undefined ? { copyFrom: { ...init.copyFrom } } : {}),
  }
}

// ---- plan output -----------------------------------------------------------------------------------------------

/** Strip BOM, CRLF → LF, unwrap a single fence, then extract `<proposed_plan>` if present. */
export function normalizePlanText(text: string): string {
  let t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const fence = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(t)
  if (fence) t = fence[2] ?? ''
  const proposed = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i.exec(t)
  if (proposed) t = proposed[1] ?? ''
  return t.trim()
}

/** A first line `INSUFFICIENT_CONTEXT: x` → x. */
export function insufficientContextOf(plan: string): string | null {
  const first = plan.split('\n', 1)[0]?.trim() ?? ''
  const m = /^INSUFFICIENT_CONTEXT:\s*(.*)$/.exec(first)
  if (!m) return null
  const msg = m[1]?.trim() ?? ''
  return msg === '' ? 'The planner says the task lacks the context it needs.' : msg
}

// ---- transaction ---------------------------------------------------------------------------------------------

class Tx {
  readonly s: RunState
  readonly at: number
  readonly ctx: ReducerContext
  readonly fx: Effect[] = []
  readonly autoQueue: string[] = []
  readonly prevOutcome: RunOutcome | undefined
  /** RunSummary.worktree before the event (the Dashboard chip; a stopped run's apply changes only it). */
  readonly prevWorktree: string
  transition = false

  constructor(state: RunState, at: number, ctx: ReducerContext) {
    this.s = structuredClone(state)
    this.at = at
    this.ctx = ctx
    this.prevOutcome = state.outcome
    this.prevWorktree = JSON.stringify(worktreeSummary(state) ?? null)
  }

  push(e: Effect): void {
    this.fx.push(e)
  }

  emit(body: RunEventBody): void {
    this.fx.push({ t: 'emit', body })
  }

  reject(code: ResultCode, message: string): void {
    this.fx.push({ t: 'result', code, message })
  }

  note(text: string): void {
    this.s.notes.push(text)
  }

  armTimer(id: string, at: number): void {
    if (this.s.timers[id] === at) return
    this.s.timers[id] = at
    this.fx.push({ t: 'timer', id, at })
  }

  clearTimer(id: string): void {
    if (this.s.timers[id] === undefined) return
    delete this.s.timers[id]
    this.fx.push({ t: 'clearTimer', id })
  }

  request(r: PendingRequest): string {
    this.s.counters.req += 1
    const id = `r${this.s.counters.req}`
    this.s.requests[id] = r
    return id
  }

  take(req: string): PendingRequest | undefined {
    const r = this.s.requests[req]
    if (r !== undefined) delete this.s.requests[req]
    return r
  }
}

// ---- entry ---------------------------------------------------------------------------------------------------

export function reduce(
  state: RunState,
  event: EngineEvent,
  ctx: ReducerContext = DEFAULT_CONTEXT,
): Reduction {
  const tx = new Tx(state, event.at, ctx)
  dispatch(tx, event)
  settle(tx)
  return { state: tx.s, effects: tx.fx, transition: tx.transition }
}

/** Apply events in order (tests, recovery replays). */
export function reduceAll(
  state: RunState,
  events: readonly EngineEvent[],
  ctx: ReducerContext = DEFAULT_CONTEXT,
): Reduction {
  let s = state
  const effects: Effect[] = []
  let transition = false
  for (const e of events) {
    const r = reduce(s, e, ctx)
    s = r.state
    effects.push(...r.effects)
    transition ||= r.transition
  }
  return { state: s, effects, transition }
}

function dispatch(tx: Tx, e: EngineEvent): void {
  const s = tx.s
  if (!s.started && e.t !== 'created') return
  switch (e.t) {
    case 'created':
      return onCreated(tx)
    case 'lock-acquired':
      return onLockAcquired(tx)
    case 'lease-acquired':
      return onLeaseAcquired(tx)
    case 'preflight-result':
      return onPreflightResult(tx, e.req, e.report)
    case 'prepare-result':
      return onPrepareResult(tx, e)
    case 'prepare-progress':
      return onPrepareProgress(tx, e)
    case 'finalize-preview':
      return onFinalizePreview(tx, e)
    case 'apply-result':
      return onApplyResult(tx, e)
    case 'undo-apply-result':
      return onUndoApplyResult(tx, e)
    case 'remove-result':
      return onRemoveResult(tx, e)
    case 'snapshot-done':
      if (e.warnings !== undefined && s.requests[e.req] !== undefined) {
        for (const w of e.warnings) if (!s.notes.includes(w)) tx.note(w)
      }
      return onSnapshotResult(
        tx,
        e.req,
        {
          commit: e.commit,
          tree: e.tree,
          ...(e.nested !== undefined ? { nested: e.nested } : {}),
          ...(e.head !== undefined ? { head: e.head } : {}),
          ...(e.changed !== undefined ? { changed: e.changed } : {}),
        },
        undefined,
      )
    case 'snapshot-failed':
      return onSnapshotResult(tx, e.req, undefined, e.failure)
    case 'reconcile-result':
      return onReconcileResult(tx, e)
    case 'guardrail-findings':
      return onGuardrailFindings(tx, e)
    case 'branch-result':
      return onBranchResult(tx, e)
    case 'branch-intent':
      return onBranchIntent(tx, e)
    case 'revert-result':
      return onRevertResult(tx, e)
    case 'revert-started':
      return onRevertStarted(tx, e)
    case 'findings-result':
      return onFindingsResult(tx, e)
    case 'spawned':
      return onSpawned(tx, e)
    case 'session-check':
      return onSessionCheck(tx, e.step, e.check)
    case 'session-assigned':
      return onSessionAssigned(tx, e)
    case 'adapter':
      return onAdapter(tx, e)
    case 'signal':
      return onSignal(tx, e)
    case 'context-facts':
      return onContextFacts(tx, e)
    case 'exit':
      return onExit(tx, e)
    case 'diff-stats': {
      const d = { files: e.files, added: e.added, deleted: e.deleted, live: e.live }
      s.diffStats = d
      tx.emit({ t: 'diff-stats', ...d })
      return
    }
    case 'timer':
      return onTimer(tx, e.id, e.due)
    case 'power':
      return e.state === 'suspend' ? onSuspend(tx) : onResumePower(tx)
    case 'relaunch':
      return onRelaunch(tx)
    case 'quit':
      return onQuit(tx)
    case 'user':
      return onUser(tx, e.cmd)
    case 'heal-result':
      return onHealResult(tx, e)
    case 'verify-check-result':
      return onVerifyCheckResult(tx, e)
    case 'trust-grant-result':
      return onTrustGrantResult(tx, e)
    case 'verify-progress':
      return onVerifyProgress(tx, e)
    case 'verify-result':
      return onVerifyResult(tx, e)
    case 'tests-check-result':
      return onTestsCheckResult(tx, e)
    case 'grounding-result':
      return onGroundingResult(tx, e)
    case 'scan-check-result':
      return onScanCheckResult(tx, e)
    case 'scan-result':
      return onScanResult(tx, e)
    case 'deploy-plan-result':
      return onDeployPlanResult(tx, e)
    case 'preview-findings':
      return onPreviewFindings(tx, e)
  }
}

// ---- settle: advance the run, auto choices, derivation, unlock, persist ---------------------------------------

function settle(tx: Tx): void {
  for (let guard = 0; guard < 16; guard++) {
    advance(tx)
    const id = tx.autoQueue.shift()
    if (id === undefined) break
    const c = tx.s.cards.find((x) => x.view.id === id)
    if (c?.view.defaultChoice !== undefined) chooseCard(tx, id, c.view.defaultChoice, undefined, true)
  }
  maybeUnlock(tx)
  const s = tx.s
  const status = deriveStatus(s)
  const phase = derivePhase(s, status)
  if (status !== s.status || phase !== s.phase || s.outcome !== tx.prevOutcome) {
    s.status = status
    s.phase = phase
    const body: RunEventBody = { t: 'run-status', status, phase }
    if (s.outcome !== undefined) body.outcome = s.outcome
    tx.emit(body)
    tx.push({ t: 'index' })
    tx.transition = true
  } else if (JSON.stringify(worktreeSummary(s) ?? null) !== tx.prevWorktree) {
    // The "Isolated: not applied" chip changed without a status change (an apply or discard of a stopped run).
    tx.push({ t: 'index' })
    tx.transition = true
  }
  tx.push({ t: 'persist', force: tx.transition })
}

/** Lock release: R2b (in its handler), or a finished run once no process is alive and nothing is outstanding. */
function maybeUnlock(tx: Tx): void {
  const s = tx.s
  const finished = s.stop !== undefined || (s.outcome !== undefined && deriveStatus(s) === 'completed')
  // A verify round being cancelled still has processes in the folder; the `stopped` snapshot waits for them.
  // So does a dependency install being cancelled in the worktree.
  if (!finished || s.lock !== 'held' || anyLiveProc(s) || verifyRoundInFlight(s) || installInFlight(s)) return
  if (s.stop?.snapshot === 'todo') {
    s.stop.snapshot = 'requested'
    requestSnapshot(tx, 'stopped', 'recovery')
    return
  }
  if (Object.keys(s.requests).length > 0) return
  s.lock = 'none'
  tx.push({ t: 'unlock' })
  tx.transition = true
}

/** R2: the run-start snapshot has answered (taken or failed); Plan spawns only after it. */
function runStartSettled(s: RunState): boolean {
  return s.flow.runStart === 'done' || s.flow.runStart === 'failed'
}

/**
 * Run-level scheduling: R2 (run-start, then Plan: its launch starts with the request, its spawn waits for the
 * answer), P1/P2 for every pass, R5–R11. Idempotent (settle loops it).
 */
function advance(tx: Tx): void {
  const s = tx.s
  if (!s.started || s.stop !== undefined || s.outcome !== undefined) return
  if (s.steps.preflight.status !== 'done' || s.flow.prepared === 'none') return
  // The outcome is decided and held while the Deploy step runs; nothing before it moves any more.
  if (s.deploy?.pending !== undefined) {
    deployFlow(tx)
    return
  }
  // The same while Explain writes its summary.
  if (s.explain?.pending !== undefined) {
    explainFlow(tx)
    return
  }
  if (s.flow.runStart === 'none') {
    s.flow.runStart = 'requested'
    requestSnapshot(tx, 'run-start', 'run-start')
  }
  const plan = s.steps.plan
  // Clarify (optional) comes first, then Research (optional): Plan starts once Clarify's questions are answered or
  // skipped (or it asked none), and Research's items are chosen (or it was skipped, or found nothing usable).
  if (plan.status === 'queued' && clarifyFlow(tx) && researchFlow(tx)) {
    const skip = skipReason(tx, 'plan')
    if (skip !== undefined) {
      setStatus(tx, plan, 'skipped', { reason: skip })
      s.plan = { decided: true, text: null, edited: false }
    } else {
      startLaunch(tx, 'plan', {
        cause: 'initial',
        plan: {
          fresh: {},
          planMode: s.config.planMode,
          ...(planKeepsSession(s) ? { keepSession: true } : {}),
        },
        preflight: 'todo',
      })
    }
  }
  if (
    plan.status === 'done' &&
    !s.plan.decided &&
    s.plan.text !== null &&
    s.plan.insufficient === undefined
  ) {
    // R4: the plan-end guard waits for `run-start` (only an earlier build's run.json can get here without it:
    // R2 spawns Plan after it); a plan stage left without its gate (a state projected from the log, or one an
    // earlier build wrote) takes the guard and the gate again.
    const open = s.cards.some((c) => c.view.kind === 'gate:afterPlan' || c.view.kind === 'planMutated')
    if (s.flow.planEnd === 'wait') planEndGuard(tx)
    else if ((s.flow.planEnd === undefined || s.flow.planEnd === 'done') && !open) afterPlanOutput(tx)
  }
  // The decided plan's acceptance criteria (its gate's edits included), once, before the Tests step reads them.
  if (s.plan.decided && s.acceptance === undefined) decideCriteria(tx)
  const impl = s.steps.implement
  // Test-first: the Tests step and its red check come between the plan and Implement.
  const testsDone = !s.plan.decided || s.flow.prepared !== 'all' || testsFlow(tx)
  if (s.plan.decided && impl.status === 'queued' && s.flow.prepared === 'all' && testsDone) {
    const skip = skipReason(tx, 'implement')
    if (skip !== undefined) setStatus(tx, impl, 'skipped', { reason: skip })
    else {
      // R5: await prepare (above) → reconcile(pre-implement) → S0 → P1, all inside Implement's launch pipeline.
      // Continuity: Implement decides its session (Plan's, or fresh with the reason) right before its spawn.
      startLaunch(tx, 'implement', {
        cause: 'initial',
        ...(s.config.continuity === true && s.config.passes.plan.enabled
          ? { decide: 'session' as const }
          : { plan: { fresh: {} } }),
        reconcile: 'todo',
        preflight: 'todo',
      })
    }
  }
  if (impl.status === 'done' || impl.status === 'skipped') afterImplement(tx)
  // Review ∥ Critic join: a launch parked at the barrier spawns once its sibling is ready too (or gone).
  for (const k of REVIEWER_PASSES) if (s.steps[k].launch?.ready === true) pump(tx, k)
}

/** P2 reasons; undefined = the step runs. */
function skipReason(tx: Tx, key: StepKey): string | undefined {
  const c = tx.s.config
  const notInBuild = tx.ctx.buildSteps.includes(key) ? undefined : SKIP_REASON.notInBuild
  const verifyAfter = (p: 'implement' | 'fix'): string | undefined =>
    c.verify.enabled && c.verify.runAfter.includes(p) ? notInBuild : SKIP_REASON.verifyOff
  switch (key) {
    case 'preflight':
      return undefined
    case 'prepare':
    case 'finalize':
      return c.isolation === 'inPlace' ? SKIP_REASON.inPlace : notInBuild
    case 'verify:0':
      if (c.isolation === 'inPlace') return SKIP_REASON.inPlace
      return c.verify.enabled && c.verify.baseline ? notInBuild : SKIP_REASON.verifyOff
    case 'verify:1':
      // Test-first: Implement must make verify green, so verify:1 runs whenever Verify is on.
      if (testFirstOn(tx.s) && c.verify.enabled) return notInBuild
      return verifyAfter('implement')
    case 'verify:2':
      return verifyAfter('fix')
    case 'tests':
      if (!testFirstOn(tx.s)) return SKIP_REASON.notUsed
      return c.passes.implement.enabled ? notInBuild : SKIP_REASON.disabled
    case 'verify:red':
      if (!testFirstOn(tx.s)) return SKIP_REASON.notUsed
      return c.verify.enabled ? notInBuild : SKIP_REASON.verifyOff
    case 'scan':
      return securityOn(tx.s) ? notInBuild : SKIP_REASON.notUsed
    case 'security':
      if (!securityOn(tx.s)) return SKIP_REASON.notUsed
      return reviewNotNeeded(tx.s) ? SKIP_REASON.notSensitive : notInBuild
    case 'recheck':
      if (!securityOn(tx.s) && !recheckAll(tx.s)) return SKIP_REASON.notUsed
      if (!recheckOn(tx.s)) return SKIP_REASON.disabled
      // Fix until green's re-check without the advisor runs on Review's (or Critic's) config.
      return passCfg(tx.s, 'recheck').enabled ? notInBuild : SKIP_REASON.disabled
    case 'clarify':
      if (!clarifyOn(tx.s)) return SKIP_REASON.notUsed
      // Clarify runs on the Plan pass's vendor and model.
      if (!c.passes.plan.enabled) return SKIP_REASON.disabled
      if (c.auto && c.clarify?.inAuto !== true) return SKIP_REASON.auto
      return notInBuild
    case 'research':
      if (!researchOn(tx.s)) return SKIP_REASON.notUsed
      // Research runs on the Plan pass's vendor and model.
      return c.passes.plan.enabled ? notInBuild : SKIP_REASON.disabled
    case 'deploy':
      if (!deployOn(tx.s)) return SKIP_REASON.notUsed
      // The Deploy step runs on the Implement pass's vendor, model and mode.
      return c.passes.implement.enabled ? notInBuild : SKIP_REASON.disabled
    case 'acceptance':
      if (!acceptanceOn(tx.s)) return SKIP_REASON.notUsed
      // The acceptance review runs on Review's config, or Critic's, then Plan's: off only when all three are.
      return passCfg(tx.s, 'acceptance').enabled ? notInBuild : SKIP_REASON.disabled
    case 'explain':
      if (!explainOn(tx.s)) return SKIP_REASON.notUsed
      // Explain runs on Plan's config, or Review's when Plan is off.
      return passCfg(tx.s, 'explain').enabled ? notInBuild : SKIP_REASON.disabled
    case 'plan':
    case 'implement':
    case 'review':
    case 'critic':
    case 'fix':
      return c.passes[key].enabled ? notInBuild : SKIP_REASON.disabled
  }
}

// ---- Clarify (before Plan) ---------------------------------------------------------------------------------------

/** What the Clarify step reads while its card waits for the user. */
export const CLARIFY_WAIT_REASON = 'questions'

/** Notes Clarify adds (UI copy, no em dashes). */
export const CLARIFY_NOTE = {
  auto: 'Clarify was skipped: Auto does not stop for questions. Turn on "Ask in Auto" to change this.',
  planOff: "Clarify was skipped: it uses the Plan pass's settings, and Plan is off.",
  skipped: "You skipped Clarify's questions; Plan decides those points itself.",
  answered: (n: number): string =>
    `Your ${n === 1 ? 'answer' : `${n} answers`} to Clarify's questions joined the brief.`,
} as const

/** `output clarify`: Clarify's questions or answers changed (StepView.clarify); the renderer reads them again. */
function announceClarify(tx: Tx): void {
  const v = (tx.s.outputs.clarify ?? 0) + 1
  tx.s.outputs.clarify = v
  tx.emit({ t: 'output', file: 'clarify', version: v })
  tx.transition = true
}

/**
 * Clarify, before Plan: the read-only pass that may ask a few questions, then its card. True once Plan may start (also
 * when Clarify is not used, skipped, asked nothing, or its questions were answered or skipped).
 */
function clarifyFlow(tx: Tx): boolean {
  const s = tx.s
  if (!clarifyOn(s)) return true
  const st = s.steps.clarify
  if (st.status === 'queued') {
    const skip = skipReason(tx, 'clarify')
    if (skip === undefined) {
      if (holdLaunch(tx, 'clarify')) return false
      startLaunch(tx, 'clarify', { cause: 'initial', plan: freshPlan(tx, 'clarify'), preflight: 'todo' })
      return false
    }
    setStatus(tx, st, 'skipped', { reason: skip })
    if (skip === SKIP_REASON.auto) addNotes(tx, [CLARIFY_NOTE.auto])
    else if (skip === SKIP_REASON.disabled) addNotes(tx, [CLARIFY_NOTE.planOff])
  }
  return isTerminalPassStatus(st.status)
}

/**
 * Clarify's answer: the vendor's structured answer when it gave one, else a fenced JSON block in its final message.
 * Questions open the Clarify card (blocking, no default: it waits even in Auto); none, or an unreadable answer, lets
 * Plan start with a note.
 */
function clarifyDone(tx: Tx, result: string): void {
  const s = tx.s
  const st = s.steps.clarify
  const structured = st.meta[META_STRUCTURED_OUTPUT]
  writeOutput(tx, 'clarify', structured !== undefined ? JSON.stringify(structured, null, 2) : result)
  const max = s.config.clarify?.questions ?? 1
  const parsed = parseClarify(structured !== undefined ? structured : result, max)
  if (parsed.questions.length === 0) {
    s.clarify = { status: 'none', questions: [], ...(parsed.note !== undefined ? { note: parsed.note } : {}) }
    if (parsed.note !== undefined) addNotes(tx, [parsed.note])
    setStatus(tx, st, 'done', { reason: 'no questions' })
    announceClarify(tx)
    return
  }
  const id = nextCardId(tx, 'clarify')
  s.clarify = { status: 'asking', questions: parsed.questions, cardId: id }
  setStatus(tx, st, 'waiting', { reason: CLARIFY_WAIT_REASON })
  openCard(tx, clarifyCard(id, { questions: parsed.questions }), 'clarify')
  announceClarify(tx)
}

/** The Clarify card: [Use these answers] adds them to the brief; [Skip questions] goes on without. */
function chooseClarify(tx: Tx, c: CardState, choiceId: string, input: string[] | undefined): void {
  const s = tx.s
  const st = s.steps.clarify
  const state: ClarifyState | undefined = s.clarify
  if (state === undefined || state.cardId !== c.view.id) {
    resolveCard(tx, c.view.id, choiceId)
    return
  }
  if (choiceId === CLARIFY_CHOICE.answer && input !== undefined) {
    if (input.length !== state.questions.length) {
      tx.reject('VALIDATION', `Give one answer per question (${state.questions.length}).`)
      return
    }
    if (input.some((a) => a.length > CLARIFY_ANSWER_MAX)) {
      tx.reject('VALIDATION', `An answer can be at most ${CLARIFY_ANSWER_MAX} characters.`)
      return
    }
  }
  resolveCard(tx, c.view.id, choiceId)
  delete state.cardId
  const answers = (input ?? []).map((a) => a.replace(/\r\n?/g, '\n').trim())
  const given = answers.filter((a) => a !== '').length
  if (choiceId === CLARIFY_CHOICE.skip || given === 0) {
    state.status = 'skipped'
    addNotes(tx, [CLARIFY_NOTE.skipped])
    setStatus(tx, st, 'done', { reason: 'questions skipped' })
  } else {
    state.status = 'answered'
    state.answers = answers
    s.brief = withClarifyAnswers(s.brief, state.questions, answers)
    addNotes(tx, [CLARIFY_NOTE.answered(given)])
    setStatus(tx, st, 'done')
  }
  announceClarify(tx)
}

// ---- Research (after Clarify, before Plan) -------------------------------------------------------------------------

/** What the Research step reads while its card waits for the user. */
export const RESEARCH_WAIT_REASON = 'review'

/** Notes Research adds (UI copy, no em dashes). */
export const RESEARCH_NOTE = {
  planOff: "Research was skipped: it uses the Plan pass's settings, and Plan is off.",
  skipped: 'You planned without the research.',
  nothingKept: 'You kept nothing from the research, so Plan starts without it.',
  kept: (n: number): string =>
    `${n === 1 ? 'One research item goes' : `${n} research items go`} into the Plan prompt.`,
  offWeb: (vendor: string, labels: readonly string[]): string =>
    `${vendor} cannot search the web from Dim Factory, so Research reads this repository only (left out: ${labels.join(', ')}).`,
} as const

/** `output research`: Research's facts changed (StepView.research); the renderer reads the snapshot again. */
function announceResearch(tx: Tx): void {
  const v = (tx.s.outputs.research ?? 0) + 1
  tx.s.outputs.research = v
  tx.emit({ t: 'output', file: 'research', version: v })
  tx.transition = true
}

/**
 * Research, before Plan: the confined read-only pass, then its card. True once Plan may start (also when Research is
 * not used, skipped, found nothing usable, or its items were chosen).
 */
function researchFlow(tx: Tx): boolean {
  const s = tx.s
  if (!researchOn(s)) return true
  const st = s.steps.research
  if (st.status === 'queued') {
    const skip = skipReason(tx, 'research')
    if (skip === undefined) {
      if (holdLaunch(tx, 'research')) return false
      const off = s.config.research?.offWeb
      if (off !== undefined && off.length > 0)
        addNotes(tx, [RESEARCH_NOTE.offWeb(vendorLabel(passCfg(s, 'research').vendor), off)])
      startLaunch(tx, 'research', { cause: 'initial', plan: freshPlan(tx, 'research'), preflight: 'todo' })
      return false
    }
    setStatus(tx, st, 'skipped', { reason: skip })
    if (skip === SKIP_REASON.disabled) addNotes(tx, [RESEARCH_NOTE.planOff])
  }
  return isTerminalPassStatus(st.status)
}

/** A vendor id as a note names it. */
function vendorLabel(vendor: string): string {
  return vendor === '' ? 'This vendor' : `${vendor.charAt(0).toUpperCase()}${vendor.slice(1)}`
}

/**
 * Research's answer: the vendor's structured answer when it gave one, else a fenced JSON block in its final message.
 * Cited items open the research card (blocking; Auto takes its default); nothing usable lets Plan start with a note.
 */
function researchDone(tx: Tx, result: string): void {
  const s = tx.s
  const st = s.steps.research
  const structured = st.meta[META_STRUCTURED_OUTPUT]
  const parsed = parseResearch(structured !== undefined ? structured : result)
  const cfg = s.config.research
  if (parsed.result === undefined) {
    s.research = { status: 'none', note: parsed.note ?? RESEARCH_PARSE_NOTE.unreadable }
    addNotes(tx, [s.research.note ?? ''])
    setStatus(tx, st, 'done', { reason: 'nothing usable' })
    announceResearch(tx)
    return
  }
  const r = parsed.result
  writeOutput(tx, 'research.json', JSON.stringify(r, null, 2))
  writeOutput(tx, 'research', renderResearchMd(r, { lenses: cfg?.lenses ?? [], web: cfg?.web === true }))
  if (r.dropped > 0) addNotes(tx, [RESEARCH_PARSE_NOTE.dropped(r.dropped)])
  const id = nextCardId(tx, 'research')
  s.research = { status: 'reviewing', result: r, cardId: id }
  setStatus(tx, st, 'waiting', { reason: RESEARCH_WAIT_REASON })
  openCard(tx, researchCard(id, { result: r, web: cfg?.web === true }), 'research')
  announceResearch(tx)
}

/**
 * The research card: [Use selected] keeps the ticked items and the answers (Auto: the must-haves and recommendations,
 * no answers); [Plan without research] goes on without it.
 */
function chooseResearch(
  tx: Tx,
  c: CardState,
  choiceId: string,
  input: string[] | undefined,
  auto: boolean,
): void {
  const s = tx.s
  const st = s.steps.research
  const state: ResearchState | undefined = s.research
  const r = state?.result
  if (state === undefined || r === undefined || state.cardId !== c.view.id) {
    resolveCard(tx, c.view.id, choiceId)
    return
  }
  const known = new Set([...r.features, ...r.standards, ...r.options].map((x) => x.id))
  const questions = new Set(r.questions.map((q) => q.id))
  const chosen: string[] = []
  const answers: Record<string, string> = {}
  if (choiceId === RESEARCH_CHOICE.use && input !== undefined) {
    for (const e of input) {
      const p = parseResearchEntry(e)
      if ('id' in p) {
        if (!known.has(p.id)) {
          tx.reject('VALIDATION', `Unknown research item "${p.id}".`)
          return
        }
        if (!chosen.includes(p.id)) chosen.push(p.id)
        continue
      }
      if (!questions.has(p.question)) {
        tx.reject('VALIDATION', `Unknown research question "${p.question}".`)
        return
      }
      const a = p.answer.replace(/\r\n?/g, '\n').trim()
      if (a.length > RESEARCH_ANSWER_MAX) {
        tx.reject('VALIDATION', `An answer can be at most ${RESEARCH_ANSWER_MAX} characters.`)
        return
      }
      if (a !== '') answers[p.question] = a
    }
  } else if (choiceId === RESEARCH_CHOICE.use) {
    chosen.push(...autoResearchChoice(r))
  }
  resolveCard(tx, c.view.id, choiceId)
  delete state.cardId
  const given = Object.keys(answers).length
  if (choiceId === RESEARCH_CHOICE.skip) {
    state.status = 'skipped'
    addNotes(tx, [RESEARCH_NOTE.skipped])
    setStatus(tx, st, 'done', { reason: 'research skipped' })
  } else if (chosen.length === 0 && given === 0) {
    state.status = 'skipped'
    addNotes(tx, [RESEARCH_NOTE.nothingKept])
    setStatus(tx, st, 'done', { reason: 'nothing kept' })
  } else {
    state.status = 'chosen'
    state.chosen = chosen
    if (given > 0) state.answers = answers
    if (auto && input === undefined) state.auto = true
    addNotes(tx, [RESEARCH_NOTE.kept(chosen.length + given)])
    setStatus(tx, st, 'done')
  }
  announceResearch(tx)
}

/** Same tree (and nested-repository fingerprints, which the tree does not hold). */
function sameSnap(a: SnapshotRef | undefined, b: SnapshotRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.tree === b.tree && a.nested === b.nested
}

// ---- Test-first ----------------------------------------------------------------------------------------------

/** Continuation for a Tests step sent back because its tests did not fail first. */
export const TESTS_NOT_RED_CONTINUATION = (passed: readonly string[], ran: boolean): string =>
  ran
    ? `The tests you wrote do not fail yet: ${passed.length > 0 ? passed.join(', ') : 'every check'} passed before anything was implemented. Rewrite them so that they fail now because the planned behaviour is missing, and pass once it is built. Do not implement the feature.`
    : 'No check ran your tests, so Dim Factory could not see them fail. Make sure the project checks run the new tests, and that the tests fail now because the planned behaviour is missing. Do not implement the feature.'

/** The test files the Tests step wrote, for the Implement, Review, Critic and Fix prompts. */
function tf(s: RunState): NonNullable<RunState['testFirst']> {
  s.testFirst ??= { files: [] }
  return s.testFirst
}

/** `output tests`: the Tests step's facts changed (StepView.testFirst); the renderer reads the snapshot again. */
function announceTests(tx: Tx): void {
  const v = (tx.s.outputs.tests ?? 0) + 1
  tx.s.outputs.tests = v
  tx.emit({ t: 'output', file: 'tests', version: v })
  tx.transition = true
}

/**
 * Test-first, between the decided plan and Implement: the Tests step (R5's reconcile and branch prep, T0, the pass,
 * T1 and its end-of-pass check), then the red check, its testsNotRed card when nothing failed, and the post-red
 * snapshot. True once Implement may start (also when Test-first is off, or the user went on without the Tests step).
 */
function testsFlow(tx: Tx): boolean {
  const s = tx.s
  if (!testFirstOn(s)) return true
  const t = s.steps.tests
  const red = s.steps['verify:red']
  if (t.status === 'queued') {
    const skip = skipReason(tx, 'tests')
    if (skip === undefined) {
      startLaunch(tx, 'tests', {
        cause: 'initial',
        plan: freshPlan(tx, 'tests'),
        reconcile: 'todo',
        preflight: 'todo',
      })
      return false
    }
    setStatus(tx, t, 'skipped', { reason: skip })
  }
  if (t.status === 'skipped') {
    if (red.status === 'queued') setStatus(tx, red, 'skipped', { reason: SKIP_REASON.notNeeded })
    return isTerminalPassStatus(red.status)
  }
  if (t.status !== 'done') return false
  // P15: the end snapshot (T1) and the end-of-pass check.
  if (t.endSnapStatus === 'requested' || t.endCheck === 'hold') {
    s.boundary = { name: 'post-tests', step: 'tests' }
    return false
  }
  if (s.boundary?.name === 'post-tests') delete s.boundary
  if (red.status === 'queued') {
    const reason = skipReason(tx, 'verify:red')
    if (reason === undefined) {
      startVerify(tx, 'verify:red')
      return false
    }
    setStatus(tx, red, 'skipped', { reason })
    addNotes(tx, ['The red check did not run (Verify is off), so the new tests were not seen failing.'])
  }
  if (!isTerminalPassStatus(red.status)) return false
  if (s.cards.some((c) => c.view.kind === 'testsNotRed')) return false
  if (red.attempt > 0 && s.flow.postRed !== 'done') {
    s.boundary = { name: 'post-red', step: 'verify:red' }
    if (s.flow.postRed === undefined) {
      s.flow.postRed = 'requested'
      requestSnapshot(tx, 'post-red', 'post-red')
      tx.transition = true
    }
    return false
  }
  return true
}

/** The red check is over: a failing command shows the tests fail first; none opens testsNotRed. */
function afterRedRound(tx: Tx): void {
  const s = tx.s
  const st = s.steps['verify:red']
  const cmds = st.verify?.commands ?? []
  const failing = cmds.filter((c) => c.status === 'fail').map((c) => c.name)
  if (failing.length > 0) {
    addNotes(tx, [
      `The new tests fail before Implement, as Test-first expects (${failing.join(', ')} ${failing.length === 1 ? 'fails' : 'fail'}).`,
    ])
    return
  }
  const passed = cmds.filter((c) => c.status === 'pass').map((c) => c.name)
  const ran = passed.length > 0
  const id = nextCardId(tx, 'testsNotRed')
  const rewrite = (tf(s).rewrites ?? 0) < 1 && ran
  openCard(tx, testsNotRedCard(id, { ran, passed, attempt: s.steps.tests.attempt, rewrite }), 'verify:red')
}

/** testsNotRed: [Rewrite the tests] sends the Tests step back, [Continue anyway] goes on, [Stop run] stops. */
function chooseTestsNotRed(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  resolveCard(tx, c.view.id, choiceId)
  if (s.stop !== undefined || s.outcome !== undefined) return
  if (choiceId === TESTS_NOT_RED_CHOICE.stop) {
    stopRun(tx, 'stop')
    return
  }
  if (choiceId === TESTS_NOT_RED_CHOICE.continue) {
    addNotes(tx, ['Continued although the new tests did not fail before Implement.'])
    return
  }
  const red = s.steps['verify:red']
  const passed = (red.verify?.commands ?? []).filter((x) => x.status === 'pass').map((x) => x.name)
  const ran = passed.length > 0
  const t = s.steps.tests
  tf(s).rewrites = (tf(s).rewrites ?? 0) + 1
  setStatus(tx, red, 'queued')
  nextAttempt(tx, t)
  delete t.endSnap
  delete t.endSnapStatus
  delete t.endCheck
  const continuation = TESTS_NOT_RED_CONTINUATION(passed, ran)
  const plan: LaunchPlan =
    t.sessionId !== undefined
      ? resumePlan(tx, t, t.sessionId, continuation)
      : { ...freshPlan(tx, 'tests'), continuation }
  startLaunch(tx, 'tests', { cause: 'retry', plan, preflight: 'todo' }, { force: true })
}

/**
 * After Implement's S1 (Test-first): compare the Tests step's files at T1 with S1 once. True while the comparison is
 * outstanding (the run waits; it counts as Implement running).
 */
function testsGuardPending(tx: Tx): boolean {
  const s = tx.s
  const st = s.testFirst
  if (!testFirstOn(s) || st === undefined || st.files.length === 0) return false
  if (st.guard === 'requested') {
    s.boundary = { name: 'tests-check', step: 'implement' }
    return true
  }
  if (st.guard !== undefined) return false
  const t1 = s.steps.tests.endSnap ?? s.snapshots.T1
  const s1 = s.steps.implement.endSnap
  if (t1 === undefined || s1 === undefined || s.steps.implement.endSnapStatus !== 'done') {
    st.guard = 'failed'
    addNotes(tx, ['Dim Factory could not check the tests after Implement: a snapshot is missing.'])
    announceTests(tx)
    return false
  }
  st.guard = 'requested'
  s.boundary = { name: 'tests-check', step: 'implement' }
  const req = tx.request({ kind: 'tests-check' })
  tx.push({ t: 'testsCheck', req, from: t1.commit, to: s1.commit, paths: [...st.files] })
  tx.transition = true
  return true
}

function onTestsCheckResult(tx: Tx, e: Extract<EngineEventBody, { t: 'tests-check-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'tests-check') return
  const s = tx.s
  const st = s.testFirst
  if (st?.guard !== 'requested') return
  if (s.boundary?.name === 'tests-check') delete s.boundary
  if (e.failure !== undefined) {
    st.guard = 'failed'
    addNotes(tx, [`Dim Factory could not check the tests after Implement: ${e.failure.message}`])
  } else {
    const findings = toFindings(e.findings, 'tests').map((f) => ({ ...f, severity: 'must' as const }))
    st.findings = findings
    st.guard = findings.length > 0 ? 'weakened' : 'ok'
    if (findings.length > 0)
      addNotes(tx, [
        `Implement weakened the tests written before it: ${findings.length === 1 ? 'one finding' : `${findings.length} findings`}.`,
      ])
  }
  announceTests(tx)
}

/** The tests check's `[must]` findings (they join the reviewers' at R8 and block the Fix skip rule). */
export function testsGuardFindings(s: RunState): Finding[] {
  return s.testFirst?.guard === 'weakened' ? (s.testFirst.findings ?? []) : []
}

// ---- grounding checks (what a pass said against what the run shows) ----------------------------------------------

/** The grounding checks run in this reduction's context (the controller answers them). */
function groundingOn(tx: Tx): boolean {
  return tx.ctx.grounding === true && contextHealthOf(tx.s).grounding !== false
}

function gr(s: RunState): GroundingRunState {
  s.grounding ??= { checks: {} }
  return s.grounding
}

/** The grounding checks' findings after Implement (they join the reviewers' at R8 and count for the skip rule). */
export function groundingFindings(s: RunState): Finding[] {
  const c = s.grounding?.checks['implement']
  return c?.phase === 'done' ? c.findings : []
}

/** What the reducer hands the checks of `key` (`implement`, `fix:<round>`); undefined when a snapshot is missing. */
function groundingEffect(
  tx: Tx,
  key: string,
  req: string,
): Extract<Effect, { t: 'groundingCheck' }> | undefined {
  const s = tx.s
  const step: 'implement' | 'fix' = key === 'implement' ? 'implement' : 'fix'
  const st = s.steps[step]
  const from =
    st.startSnap ?? (step === 'fix' && (s.fixLoop?.round ?? 1) <= 1 ? s.fixLoop?.firstStart : undefined)
  const to = st.endSnap
  if (from === undefined || to === undefined) return undefined
  const v = s.steps[step === 'implement' ? 'verify:1' : 'verify:2']
  const verify: VerifyFact[] =
    v.status === 'done'
      ? (v.verify?.commands ?? []).flatMap((c) =>
          c.status === 'pass' ||
          c.status === 'fail' ||
          c.status === 'env' ||
          c.status === 'skipped' ||
          c.status === 'skipped-untrusted'
            ? [{ name: c.name, argv: [...c.argv], status: c.status }]
            : [],
        )
      : []
  const policy = contextHealthOf(s)
  return {
    t: 'groundingCheck',
    req,
    step,
    from: from.commit,
    to: to.commit,
    finalText: st.result ?? '',
    ...(step === 'implement' && typeof s.plan.text === 'string' ? { plan: s.plan.text } : {}),
    ...(st.grounding !== undefined ? { evidence: structuredClone(st.grounding) } : {}),
    ...(verify.length > 0 ? { verify } : {}),
    registryCheck: policy.registryCheck,
    ...(policy.aiJudge && step === 'implement' ? { judge: { vendor: s.config.passes.review.vendor } } : {}),
    ...researchSources(s),
  }
}

/** The Brief category whose result is a research memo: its links are checked against what Research found. */
const RESEARCH_CATEGORY = 'research-writing'

/** A research memo's run with Research's web sources: the grounding link check reads them (no model). */
function researchSources(s: RunState): { sources?: string[] } {
  if (s.category !== RESEARCH_CATEGORY) return {}
  const sources = (s.research?.result?.sources ?? []).map((x) => x.url).filter((u) => /^https?:\/\//i.test(u))
  return sources.length > 0 ? { sources } : {}
}

/** Ask for the checks of `key`; false (with a note) when a snapshot is missing. */
function requestGrounding(tx: Tx, key: string): boolean {
  const s = tx.s
  const req = tx.request({ kind: 'grounding', key })
  const effect = groundingEffect(tx, key, req)
  if (effect === undefined) {
    tx.take(req)
    gr(s).checks[key] = { phase: 'failed', findings: [], notes: [] }
    addNotes(tx, ['Dim Factory could not run the grounding checks: a snapshot is missing.'])
    return false
  }
  gr(s).checks[key] = { phase: 'requested', findings: [], notes: [] }
  s.boundary = { name: 'grounding-check', step: key === 'implement' ? 'implement' : 'fix' }
  tx.push(effect)
  tx.transition = true
  return true
}

/**
 * After Implement's checks (verify:1 and its snapshot): the grounding checks over the pass, once. True once they
 * answered (or do not run); the run waits meanwhile (it counts as Implement running).
 */
function groundingFlow(tx: Tx): boolean {
  const s = tx.s
  if (!groundingOn(tx) || s.steps.implement.status !== 'done') return true
  const cur = s.grounding?.checks['implement']
  if (cur?.phase === 'requested') {
    s.boundary = { name: 'grounding-check', step: 'implement' }
    return false
  }
  if (cur !== undefined) return true
  return !requestGrounding(tx, 'implement')
}

/**
 * After Fix (its snapshot, verify:2 and the re-check): Fix's report checked against the next check (a contradiction is
 * a `[must]`), then the grounding checks over the round. Their findings are listed after the others (not sent to a Fix
 * that already ran); they never change the outcome. True once they answered (or do not run).
 */
function groundingFixFlow(tx: Tx): boolean {
  const s = tx.s
  const fix = s.steps.fix
  if (!groundingOn(tx) || fix.status !== 'done') return true
  const key = `fix:${s.fixLoop?.round ?? 1}`
  const cur = s.grounding?.checks[key]
  if (cur?.phase === 'requested') {
    s.boundary = { name: 'grounding-check', step: 'fix' }
    return false
  }
  if (cur !== undefined) return true
  noteContradictions(tx)
  return !requestGrounding(tx, key)
}

/** Findings after the join: listed after the others (ids kept clear of theirs), not selected for Fix. */
function appendFindings(tx: Tx, add: readonly Finding[]): number {
  if (add.length === 0) return 0
  const fs = ensureFindings(tx.s)
  const taken = new Set(fs.list.map((f) => f.id))
  const next = add.filter((f) => !taken.has(f.id))
  if (next.length === 0) return 0
  fs.list = [...fs.list, ...next].map((f, i) => ({ ...f, n: i + 1 }))
  writeFindingsFile(tx)
  return next.length
}

/** Fix said a finding was fixed, but the re-check or verify:2 still finds the same stable id: a `[must]`. */
function noteContradictions(tx: Tx): void {
  const s = tx.s
  const fs = s.findings
  const fix = s.steps.fix
  if (fs === undefined || fix.result === undefined) return
  const report = fixReportById(fs.list, parseFixReport(fix.result))
  if (Object.keys(report).length === 0) return
  const open = new Set<string>()
  const rc = s.security?.recheck
  if (s.steps.recheck.status === 'done' && rc !== undefined && rc.status !== 'unclear') {
    for (const o of rc.open) {
      const f = fs.list.find((x) => x.n === o.n)
      if (f !== undefined) open.add(f.id)
    }
  }
  if (fs.verify?.step === 'verify:2')
    for (const f of fs.verify.findings) if (f.severity === 'must') open.add(f.id)
  const g = gr(s)
  const done = new Set(g.contradicted ?? [])
  const given = selectedFindings(s).filter((f) => !done.has(f.id))
  const found = fixContradictions(given, report, open)
  if (found.length === 0) return
  g.contradicted = [
    ...done,
    ...given.filter((f) => report[f.id] === 'fixed' && open.has(f.id)).map((f) => f.id),
  ]
  const round = s.fixLoop?.round ?? 1
  const added = appendFindings(
    tx,
    toFindings(found, 'grounding').map((f) => ({ ...f, severity: 'must' as const, round: round + 1 })),
  )
  if (added > 0)
    addNotes(tx, [
      `Fix said ${added === 1 ? 'a finding was' : `${added} findings were`} fixed, but the next check still finds ${added === 1 ? 'it' : 'them'}.`,
    ])
  tx.transition = true
}

function onGroundingResult(tx: Tx, e: Extract<EngineEventBody, { t: 'grounding-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'grounding') return
  const s = tx.s
  const c = s.grounding?.checks[r.key]
  if (c?.phase !== 'requested') return
  if (s.boundary?.name === 'grounding-check') delete s.boundary
  tx.transition = true
  const after = r.key === 'implement' ? 'Implement' : 'Fix'
  if (e.failure !== undefined) {
    c.phase = 'failed'
    addNotes(tx, [`Dim Factory could not run the grounding checks after ${after}: ${e.failure.message}`])
    return
  }
  const round = r.key === 'implement' ? 1 : (s.fixLoop?.round ?? 1) + 1
  c.phase = 'done'
  c.findings = toFindings(e.findings, 'grounding').map((f) => ({ ...f, round }))
  c.notes = [...e.notes]
  if (e.notes.length > 0) addNotes(tx, e.notes)
  if (r.key === 'implement') {
    const musts = c.findings.filter((f) => f.severity === 'must').length
    if (c.findings.length > 0)
      addNotes(tx, [
        `The grounding checks found ${c.findings.length === 1 ? 'one problem' : `${c.findings.length} problems`} in what Implement said it did${musts > 0 ? ` (${musts} must fix)` : ''}.`,
      ])
    return
  }
  const added = appendFindings(tx, c.findings)
  if (added > 0)
    addNotes(tx, [
      `The grounding checks found ${added === 1 ? 'one problem' : `${added} problems`} in what Fix said it did.`,
    ])
}

/**
 * R6 → R11 after Implement finished. R6: wait for S1; tree(S0) = tree(S1) → completed(no-changes). Otherwise verify:1
 * when `runAfter ∋ implement`, whose end is R7: the post-verify-1 snapshot; then reconcile(pre-review) and
 * Review ∥ Critic (`reviewFlow`).
 */
function afterImplement(tx: Tx): void {
  const s = tx.s
  if (s.flow.review === undefined) {
    const impl = s.steps.implement
    let changed = false
    if (impl.status === 'done') {
      // P15: the end-of-pass check needs the user (its reconcile card, or the recheck they chose).
      if (impl.endSnapStatus === 'requested' || impl.endCheck === 'hold') {
        s.boundary = { name: 'post-implement', step: 'implement' }
        return
      }
      // A failed S1 counts as changed: never report `no-changes` without proof. The run's changes start at its base
      // (Test-first: the Tests step's start, so tests alone are changes).
      changed = impl.endSnapStatus !== 'done' || !sameSnap(runBaseSnap(s), impl.endSnap)
    }
    delete s.boundary
    if (!changed) {
      finish(tx, 'no-changes', { all: SKIP_REASON.noChanges })
      return
    }
    // Test-first: the tests before and after Implement, compared once before verify:1.
    if (testsGuardPending(tx)) return
    // R6: verify:1 if `runAfter ∋ implement` (P2 skips it otherwise: "verify off").
    const v1 = s.steps['verify:1']
    if (v1.status === 'queued') {
      const reason = skipReason(tx, 'verify:1')
      if (reason === undefined) {
        startVerify(tx, 'verify:1')
        return
      }
      setStatus(tx, v1, 'skipped', { reason })
    }
    if (!isTerminalPassStatus(v1.status)) return
    // R7: verify:1 ran → the post-verify-1 snapshot (≠ S1 ⇒ a note) before reconcile(pre-review).
    if (v1.attempt > 0 && s.flow.postVerify1 !== 'done') {
      s.boundary = { name: 'post-verify-1', step: 'verify:1' }
      if (s.flow.postVerify1 === undefined) {
        s.flow.postVerify1 = 'requested'
        requestSnapshot(tx, 'post-verify-1', 'post-verify-1')
        tx.transition = true
      }
      return
    }
    // The grounding checks (no tokens): what Implement said against what it did; their findings join the reviewers'.
    if (!groundingFlow(tx)) return
    // The security advisor's scan (no tokens) runs before the reviewers, so the Security pass reads its results.
    if (!scanFlow(tx)) return
    // The acceptance review, after Implement's checks: its unmet criteria can join the reviewers' findings.
    if (!acceptanceFlow(tx)) return
    // Adaptive depth: a Quick run whose check failed switches to thorough checks before its reviewers start.
    escalateOnFailedCheck(tx)
    beginReview(tx)
  }
  reviewFlow(tx)
}

/** What failed in a Quick run's checks after Implement (undefined: nothing did): verify, grounding, the tests check. */
function failedCheckOf(s: RunState): string | undefined {
  const v1 = s.steps['verify:1']
  if (v1.status === 'done') {
    const failing = blockingFailures(s, v1.verify)
    if (failing.length > 0) return failing.map((c) => c.name).join(', ')
  }
  if (groundingFindings(s).some((f) => f.severity === 'must')) return 'the grounding checks'
  if (testsGuardFindings(s).length > 0) return 'the tests check'
  return undefined
}

/**
 * Thorough checks for a Quick run: the Critic joins Review when it runs on a vendor the run already uses (its readiness
 * was checked when the run started), and Fix repeats until the checks pass (Fix until green, when it was not on).
 */
export function applyEscalation(c: RunConfig): void {
  const used = new Set([c.passes.implement.vendor, c.passes.review.vendor])
  if (!c.passes.critic.enabled && used.has(c.passes.critic.vendor)) c.passes.critic.enabled = true
  c.fixLoop ??= { rounds: FIX_ROUNDS_MAX, recheck: false }
}

/** A Quick run's check failed after Implement: it escalates once, with a note (the Run view shows why). */
function escalateOnFailedCheck(tx: Tx): void {
  const s = tx.s
  const d = s.config.depth
  if (d?.depth !== 'direct' || d.escalated !== undefined) return
  const what = failedCheckOf(s)
  if (what === undefined) return
  d.escalated = what
  applyEscalation(s.config)
  addNotes(tx, [DEPTH_ESCALATED_NOTE(what)])
  tx.transition = true
}

/** R6 tail / R7: reconcile(pre-review), then Review ∥ Critic. No reviewer to run ⇒ straight to the join's rules. */
function beginReview(tx: Tx): void {
  const s = tx.s
  // A state projected from the log (recovery.ts) may already show the reviewers underway: join them.
  if (REVIEWER_PASSES.some((k) => s.steps[k].status !== 'queued' && s.steps[k].status !== 'skipped')) {
    s.flow.review = 'running'
    return
  }
  let first: ReviewerPass | undefined
  for (const k of REVIEWER_PASSES) {
    const st = s.steps[k]
    if (st.status !== 'queued') continue
    const reason = skipReason(tx, k)
    if (reason !== undefined) setStatus(tx, st, 'skipped', { reason })
    else first ??= k
  }
  if (first === undefined) {
    s.flow.review = 'joined'
    tx.transition = true
    return
  }
  s.flow.review = 'reconcile'
  s.boundary = { name: 'pre-review', step: first }
  requestReconcile(tx, 'pre-review')
  tx.transition = true
}

/**
 * reconcile(pre-review) answered: both reviewers get their launch pipelines now (they spawn together). Under a
 * relaunch hold they are paused instead, and Resume launches them.
 */
function launchReviewers(tx: Tx): void {
  const s = tx.s
  s.flow.review = 'running'
  delete s.boundary
  for (const k of REVIEWER_PASSES) {
    if (s.steps[k].status !== 'queued') continue
    if (!holdLaunch(tx, k))
      startLaunch(tx, k, { cause: 'initial', plan: freshPlan(tx, k), preflight: 'todo' })
  }
}

/**
 * `flow.hold` (never auto-resume): the pass the run would launch next is paused with the hold's
 * reason instead (attempt 1 when it never ran, as if paused in its own launch pipeline). True when held.
 */
function holdLaunch(tx: Tx, key: AgentStep): boolean {
  const hold = tx.s.flow.hold
  if (hold === undefined) return false
  const st = tx.s.steps[key]
  if (st.attempt === 0) st.attempt = 1
  setStatus(tx, st, 'paused', { pause: hold })
  return true
}

/**
 * Run-level boundary work outstanding (R6 S1, reconcile(pre-review), R8 post-review snapshot, R11 S2, or a
 * reviewer that waits only for its findings parse): a relaunch or quit holds the run's next launch (`flow.hold`).
 */
function boundaryPending(s: RunState): boolean {
  if (s.stop !== undefined || s.outcome !== undefined) return false
  if (s.boundary !== undefined || s.flow.review === 'reconcile' || s.flow.review === 'post-review')
    return true
  if (REVIEWER_PASSES.some((k) => awaitsFindings(s, k))) return true
  return MUTATING_PASSES.some(
    (k) =>
      s.steps[k].status === 'done' &&
      (s.steps[k].endSnapStatus === 'requested' || s.steps[k].endCheck === 'hold'),
  )
}

/** The user continued the run (Resume, Retry, Continue without, a card choice): launches proceed again. */
function releaseHold(tx: Tx): void {
  if (tx.s.flow.hold === undefined) return
  delete tx.s.flow.hold
  tx.transition = true
}

function reviewFlow(tx: Tx): void {
  const s = tx.s
  if (s.flow.review === 'running') joinReviewers(tx)
  if (s.flow.review !== 'joined') return
  if (s.flow.fix === undefined) {
    // A state projected from the log may already hold the gate, or a Fix underway.
    if (s.cards.some((c) => c.view.kind === 'gate:beforeFix')) s.flow.fix = 'gate'
    else if (s.steps.fix.status !== 'queued') s.flow.fix = 'started'
    else if (s.rerunOf?.from === 'fix') {
      // Re-run from Fix: the findings were chosen with the re-run (no join, no gate): straight to R10.
      beginFix(tx)
      return
    } else {
      decideJoin(tx)
      return
    }
  }
  if (s.flow.fix === 'started') afterFix(tx)
}

/**
 * R8 join, its waiting half: both reviewers must be done or skipped. Any failed → the run reads failed (the
 * survivor finishes and keeps its findings) until Retry / Continue without; any paused → paused until Resume.
 * Then the `post-review` snapshot (when a reviewer ran), whose result moves the flow to `joined`.
 */
function joinReviewers(tx: Tx): void {
  const s = tx.s
  if (!REVIEWER_PASSES.every((k) => s.steps[k].status === 'done' || s.steps[k].status === 'skipped')) return
  const ran = REVIEWER_PASSES.find((k) => s.steps[k].status === 'done')
  tx.transition = true
  if (ran === undefined) {
    s.flow.review = 'joined'
    return
  }
  s.flow.review = 'post-review'
  s.boundary = { name: 'post-review', step: ran }
  requestSnapshot(tx, 'post-review', 'post-review')
}

/**
 * "Every enabled reviewer": a reviewer counts for the skip rule when it is enabled in the run's config and P2
 * did not skip it (not in this build). One the user continued without (P23, skipped(user)) never reviewed
 * anything, so like a failed, empty or unparsed one it never counts as zero.
 */
function countedReviewers(s: RunState): ReviewerPass[] {
  return REVIEWER_PASSES.filter((k) => {
    const st = s.steps[k]
    return s.config.passes[k].enabled && (st.status !== 'skipped' || st.reason === SKIP_REASON.user)
  })
}

/**
 * Fix skip rule: every enabled reviewer is done with `none`, or `ok` with 0 findings (a treated-as-none empty
 * output is `none`), and the latest verify has no `[must]` failures (a failing command of the latest round).
 */
export function fixSkipRuleHolds(s: RunState): boolean {
  for (const k of countedReviewers(s)) {
    if (s.steps[k].status !== 'done') return false
    const src = s.findings?.sources[k]
    if (src === undefined) return false
    if (src.status === 'none') continue
    if (src.status === 'ok' && src.findings.length === 0) continue
    return false
  }
  return (
    !latestVerifyHasMust(s) &&
    testsGuardFindings(s).length === 0 &&
    scanFindings(s).length === 0 &&
    acceptanceFindings(s).length === 0 &&
    groundingFindings(s).length === 0
  )
}

/**
 * Merge the done reviewers' findings and the latest verify round's: must first (review, critic, verify, parser
 * order), numbered F1…; ids unique.
 */
export function joinFindings(
  sources: FindingsState['sources'],
  from: readonly ReviewerPass[],
  verify: readonly Finding[] = [],
): Finding[] {
  const all: Finding[] = []
  for (const k of from) all.push(...(sources[k]?.findings ?? []))
  all.push(...verify)
  const ordered = [...all.filter((f) => f.severity === 'must'), ...all.filter((f) => f.severity !== 'must')]
  const seen = new Set<string>()
  return ordered.map((f, i) => {
    let id = f.id
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`
    seen.add(id)
    return { ...f, id, n: i + 1, flags: [...f.flags] }
  })
}

function ensureFindings(s: RunState): FindingsState {
  s.findings ??= { sources: {}, list: [], selected: [], notes: [] }
  return s.findings
}

/**
 * findings.json (shared `FindingsFile`): `writeFindings` + an `output` body (UI refresh), with the next version.
 * Sources still parsing are left out; `selected` maps every listed finding id to whether Fix gets it.
 */
function writeFindingsFile(tx: Tx): void {
  const s = tx.s
  const fs = s.findings
  if (fs === undefined) return
  const version = (s.outputs.findings ?? 0) + 1
  s.outputs.findings = version
  const sources: FindingsFile['sources'] = {}
  for (const k of REVIEWER_PASSES) {
    const src = fs.sources[k]
    if (src === undefined || src.status === 'parsing') continue
    sources[k] = { status: src.status, count: src.findings.length, rawFile: `${k}.md` }
  }
  // The security scan, as a source (its facts are on the scan step).
  const scan = s.security?.scan
  if (scan?.phase === 'done') {
    const n = scan.findings.length
    sources.scan = { status: n > 0 ? 'ok' : 'none', count: n, rawFile: 'scan' }
  }
  // The acceptance review's unmet criteria, as a source (the checklist is acceptance.json).
  const accept = acceptanceFindings(s)
  if (accept.length > 0)
    sources.acceptance = { status: 'ok', count: accept.length, rawFile: 'acceptance.json' }
  // The grounding checks (no model), as a source: Implement's, and the ones listed after Fix.
  const grounding = fs.list.filter((f) => f.source === 'grounding').length
  if (s.grounding !== undefined && Object.values(s.grounding.checks).some((c) => c.phase === 'done'))
    sources.grounding = { status: grounding > 0 ? 'ok' : 'none', count: grounding, rawFile: 'run.json' }
  // The latest verify round, as a source (its combined output is the round's output file).
  if (fs.verify !== undefined) {
    const n = fs.verify.findings.length
    sources.verify = { status: n > 0 ? 'ok' : 'none', count: n, rawFile: verifyOutputRel(fs.verify.step) }
  }
  // The preview's smoke check, as a source (its record is preview/smoke.json).
  if (fs.preview !== undefined && fs.preview.length > 0)
    sources.preview = { status: 'ok', count: fs.preview.length, rawFile: 'preview/smoke.json' }
  const want = new Set(fs.selected)
  const selected: Record<string, boolean> = {}
  for (const f of fs.list) selected[f.id] = want.has(f.id)
  const wrong = fs.wrong
  const doc: FindingsFile = structuredClone({
    schemaVersion: 1,
    runId: s.runId,
    round: 1,
    sources,
    findings: fs.list,
    selected,
    // Findings that turned out wrong (Fix disputed them and the checks confirmed the code was fine).
    ...(wrong !== undefined && wrong.disputed.length > 0
      ? {
          metrics: { disputed: wrong.disputed.length, wrong: wrong.wrong.length, wrongIds: [...wrong.wrong] },
        }
      : {}),
  })
  tx.push({ t: 'writeFindings', doc, version })
  tx.emit({ t: 'output', file: 'findings', version })
}

/**
 * R8 join, its deciding half (first match after failed/paused): skip rule → completed(clean) · Fix disabled →
 * completed(findings-open) · beforeFix ∧ ¬auto → gate:beforeFix · else the pre-Fix boundary (R10).
 */
function decideJoin(tx: Tx): void {
  const s = tx.s
  const done = REVIEWER_PASSES.filter((k) => s.steps[k].status === 'done')
  const scan = scanFindings(s)
  const accept = acceptanceFindings(s)
  const grounding = groundingFindings(s)
  if (
    s.findings !== undefined ||
    done.length > 0 ||
    testsGuardFindings(s).length > 0 ||
    scan.length > 0 ||
    accept.length > 0 ||
    grounding.length > 0
  ) {
    const fs = ensureFindings(s)
    // verify:1's findings join the reviewers' (the gate lists them; Fix's {{findings}} gets the selection), and so do
    // the security scan's, Test-first's weakened-tests findings and the acceptance review's unmet criteria.
    const verify = fs.verify?.step === 'verify:1' ? fs.verify.findings : []
    const joined = joinFindings(fs.sources, done, [
      ...scan,
      ...verify,
      ...testsGuardFindings(s),
      ...accept,
      ...grounding,
    ])
    if (quietReviews(s)) {
      // Quieter reviews: two reviewers on the same place are listed once (a disagreement as a suggestion).
      const merged = mergeReviewerFindings(joined)
      fs.list = merged.list
      if (merged.notes.length > 0) addNotes(tx, merged.notes)
    } else fs.list = joined
    fs.selected = defaultSelection(s, fs.list)
    writeFindingsFile(tx)
  }
  const fixSkip = skipReason(tx, 'fix')
  if (fixSkipRuleHolds(s)) {
    finish(tx, 'clean', { fix: fixSkip ?? SKIP_REASON.noFindings })
    return
  }
  for (const k of countedReviewers(s)) {
    if (s.steps[k].status !== 'skipped') continue
    const note = `${stepLabel(k)} did not review the change (you continued without it), so the run is not reported clean.`
    if (!s.notes.includes(note)) tx.note(note)
  }
  if (fixSkip !== undefined) {
    finish(tx, 'findings-open', { fix: fixSkip })
    return
  }
  const fs = ensureFindings(s)
  if (s.config.gates.beforeFix && !s.config.auto) {
    s.flow.fix = 'gate'
    openCard(tx, beforeFixGateCard(nextCardId(tx, 'gate:beforeFix'), fs.list, fs.selected, fs.notes), 'fix')
    return
  }
  // Quieter reviews: nothing real failed (no finding with evidence), so Fix does not run; everything stays listed.
  if (quietReviews(s) && fs.selected.length === 0) {
    finishQuiet(tx, fs.list)
    return
  }
  beginFix(tx)
}

/** Quieter reviews are on for this run: only findings with evidence go to Fix by default. */
export function quietReviews(s: Pick<RunState, 'config'>): boolean {
  return s.config.fixTrigger === 'evidence'
}

/**
 * The findings Fix gets unless the user ticks others (the gate, Re-run from Fix): with quieter reviews those with
 * evidence (shared triggersFix), else every finding.
 */
export function defaultSelection(s: RunState, list: readonly Finding[]): string[] {
  if (!quietReviews(s)) return list.map((f) => f.id)
  const loop = fixLoopOn(s)
  return list.filter((f) => triggersFix(f, loop)).map((f) => f.id)
}

export const QUIET_NOTE = (n: number): string =>
  `The reviewers listed ${n === 1 ? 'one finding' : `${n} findings`} without evidence of a real problem (a file and line, a failing check or a grounding flag), so Fix did not run. Tick any of them with Re-run from Fix to fix it.`

/**
 * The join's findings hold nothing with evidence: the run completes without Fix. Clean when only suggestions are
 * listed; findings open when a reviewer's [must] came without evidence (it is listed for you to judge).
 */
function finishQuiet(tx: Tx, list: readonly Finding[]): void {
  addNotes(tx, [QUIET_NOTE(list.length)])
  const must = list.some((f) => f.severity === 'must')
  finish(tx, must ? 'findings-open' : 'clean', { fix: SKIP_REASON.noEvidence })
}

/** R10: reconcile(pre-fix) → F0 → decideSession → Fix P1, all inside Fix's launch pipeline. */
function beginFix(tx: Tx): void {
  const s = tx.s
  const fs = ensureFindings(s)
  if (fs.selected.length === 0) {
    tx.note('Fix was skipped: there are no findings it could address.')
    finish(tx, 'findings-open', { fix: SKIP_REASON.noFindings })
    return
  }
  s.flow.fix = 'started'
  tx.transition = true
  // Fix until green: round 1 starts with the [must] findings Fix gets.
  if (fixLoopOn(s) && s.fixLoop === undefined) {
    const musts = selectedFindings(s).filter((f) => f.severity === 'must').length
    s.fixLoop = { round: 1, rounds: [newRound(tx, 1)], before: musts }
    announceRounds(tx)
  }
  // A relaunch hold: Fix waits paused; Resume redoes R10 from the start (resumePass → initialLaunch).
  if (holdLaunch(tx, 'fix')) return
  startLaunch(tx, 'fix', { cause: 'initial', decide: 'session', reconcile: 'todo', preflight: 'todo' })
}

/**
 * R11: Fix done → S2 (the run stays `fixing` meanwhile) → verify:2 if `runAfter ∋ fix`: passes → completed(fixed),
 * a failing command → completed(verify-failed), "Completed with failures". Fix skipped by the user (P23 Continue
 * without Fix) → completed(findings-open).
 */
function afterFix(tx: Tx): void {
  const s = tx.s
  const fix = s.steps.fix
  if (fix.status === 'skipped') {
    finish(tx, 'findings-open')
    return
  }
  if (fix.status !== 'done') return
  if (fix.endSnapStatus === 'requested' || fix.endCheck === 'hold') {
    s.boundary = { name: 'post-fix', step: 'fix' }
    return
  }
  if (s.fixLoop?.postRound === 'requested') {
    s.boundary = { name: 'post-round', step: 'fix' }
    return
  }
  delete s.boundary
  if (fix.endSnapStatus === 'done' && sameSnap(fix.startSnap, fix.endSnap)) {
    const round = s.fixLoop?.round ?? 1
    const note = round > 1 ? `Fix made no changes in round ${round}.` : 'Fix made no changes.'
    if (!s.notes.includes(note)) tx.note(note)
  }
  // R11: verify:2 if `runAfter ∋ fix` (P2 skips it otherwise: "verify off").
  const v2 = s.steps['verify:2']
  if (v2.status === 'queued') {
    const reason = skipReason(tx, 'verify:2')
    if (reason === undefined) {
      startVerify(tx, 'verify:2')
      return
    }
    setStatus(tx, v2, 'skipped', { reason })
  }
  if (!isTerminalPassStatus(v2.status)) return
  // The re-check of the [must] findings Fix was given (the security advisor's, or Fix until green's).
  if (!recheckFlow(tx)) return
  // Fix's report against the next check, and the grounding checks over the round (notes and findings only).
  if (!groundingFixFlow(tx)) return
  // Findings Fix disputed that the checks confirm were wrong (a metric; it never changes the outcome).
  noteWrongFindings(tx)
  // Fix until green: this round's verdict decides green, another round, or a stop.
  if (fixLoopOn(s) && s.fixLoop !== undefined) {
    afterRound(tx, s.fixLoop)
    return
  }
  const failing = v2.status === 'done' ? blockingFailures(s, v2.verify) : []
  const securityOpen = openSecurityMusts(s)
  if (securityOpen !== undefined && securityOpen.length > 0) {
    const list = securityOpen.map((n) => `F${n}`).join(', ')
    tx.note(
      `${failing.length > 0 ? 'Also, the' : 'Completed with failures: the'} security re-check found ${list} still open after Fix.`,
    )
  }
  if (failing.length > 0) {
    tx.note(
      `Completed with failures: ${failing.map((c) => c.name).join(', ')} still ${failing.length === 1 ? 'fails' : 'fail'} after Fix.`,
    )
    finish(tx, 'verify-failed')
    return
  }
  if (securityOpen !== undefined && securityOpen.length > 0) {
    finish(tx, 'security-open')
    return
  }
  // The user went on without the re-check: the security findings are not confirmed resolved.
  if (s.steps.recheck.status === 'skipped' && s.steps.recheck.reason === SKIP_REASON.user) {
    addNotes(tx, ['The security re-check did not run, so the security findings are not confirmed resolved.'])
    finish(tx, 'findings-open')
    return
  }
  // A command that also failed before the run is listed, never "Completed with failures".
  notePreexisting(tx)
  // R11 "pass → fixed": only a pass is evidence. A command that failed in verify:1 and did not run and
  // pass in verify:2 (untrusted, its script changed, skipped, could not run) leaves its [must] open, so the run is
  // not `fixed`: in Auto, Fix could otherwise "fix" a failing check by editing its script.
  const unverified = v2.attempt > 0 ? unverifiedAfterFix(s) : []
  if (unverified.length > 0) {
    for (const u of unverified) {
      tx.note(
        `${u.name} did not run after Fix, so its failure is still open.${u.reason !== undefined ? ` ${u.reason}` : ''}`,
      )
    }
    finish(tx, 'findings-open')
    return
  }
  finish(tx, 'fixed')
}

/**
 * Findings that turned out wrong: of the findings Fix got this round, those it disputed, and of those the ones the
 * checks after Fix confirm were fine (verify:2 ran and passed, the re-check does not keep them open, the grounding
 * checks did not contradict Fix). Without checks after Fix a dispute stays unconfirmed (counted as disputed only).
 * Once per finding; written to findings.json `metrics`.
 */
function noteWrongFindings(tx: Tx): void {
  const s = tx.s
  const fs = s.findings
  const fix = s.steps.fix
  if (fs === undefined || fix.status !== 'done' || fix.result === undefined) return
  const report = fixReportById(fs.list, parseFixReport(fix.result))
  const prev = fs.wrong ?? { disputed: [], wrong: [] }
  const given = selectedFindings(s)
  const disputed = given.filter((f) => report[f.id] === 'disputed' && !prev.disputed.includes(f.id))
  if (disputed.length === 0) return
  const v2 = s.steps['verify:2']
  const verifyOk =
    v2.status === 'done' &&
    v2.attempt > 0 &&
    blockingFailures(s, v2.verify).length === 0 &&
    unverifiedAfterFix(s).length === 0
  const rc = s.security?.recheck
  const open = new Set<number>(
    s.steps.recheck.status === 'done' && rc !== undefined
      ? rc.status === 'unclear'
        ? rc.checks
        : rc.open.map((o) => o.n)
      : [],
  )
  const contradicted = new Set(s.grounding?.contradicted ?? [])
  const wrong = verifyOk
    ? disputed.filter((f) => f.source !== 'verify' && !open.has(f.n) && !contradicted.has(f.id))
    : []
  fs.wrong = {
    disputed: [...prev.disputed, ...disputed.map((f) => f.id)],
    wrong: [...prev.wrong, ...wrong.map((f) => f.id)],
  }
  if (wrong.length > 0)
    addNotes(tx, [
      `${wrong.length === 1 ? 'One finding' : `${wrong.length} findings`} turned out wrong: Fix disputed ${wrong.map((f) => `F${f.n}`).join(', ')} and the checks after Fix passed.`,
    ])
  writeFindingsFile(tx)
  tx.transition = true
}

/** verify:2's failing commands that also failed before the run (the baseline): listed, never a failure. */
function notePreexisting(tx: Tx): void {
  const s = tx.s
  const v2 = s.steps['verify:2']
  const before =
    v2.status === 'done' ? failingCommands(v2.verify).filter((c) => preexistingFailure(s, c.name)) : []
  if (before.length > 0) {
    addNotes(tx, [
      `${before.map((c) => c.name).join(', ')} still ${before.length === 1 ? 'fails' : 'fail'}, as ${before.length === 1 ? 'it' : 'they'} already did before this run.`,
    ])
  }
}

/**
 * Skip every queued step after Implement by its P2 reason (`all` overrides every reason, `fix` Fix's), then
 * complete with `outcome`.
 */
function finish(tx: Tx, decided: RunOutcome, o: { all?: string; fix?: string } = {}): void {
  const s = tx.s
  delete s.boundary
  // The project's quality gates: a run that would be done but misses a required check completes with failures.
  const outcome = qualityGates(tx, decided)
  // Fix until green: a round that did not reach its verdict (Fix skipped, the run ended) is over.
  const open = s.fixLoop?.rounds.find((r) => r.status === 'running')
  if (open !== undefined) {
    open.status = 'stopped'
    announceRounds(tx)
  }
  // R12: an isolated run's finalize step starts once the outcome is fixed (it is never skipped here).
  const finalizes = isolatedRun(s) && skipReason(tx, 'finalize') === undefined
  // The Deploy step runs before finalize (its config is applied with the rest), when the run had no failures.
  const deploys = deployRuns(tx, outcome)
  // Explain runs after it (it can say what Deploy wrote), before finalize.
  const explains = explainRuns(tx, outcome)
  for (const k of AFTER_IMPLEMENT) {
    const st = s.steps[k]
    if (
      st.status !== 'queued' ||
      (k === 'finalize' && finalizes) ||
      (k === 'deploy' && deploys) ||
      (k === 'explain' && explains)
    )
      continue
    const reason =
      k === 'deploy'
        ? deploySkipReason(tx, outcome)
        : k === 'explain'
          ? explainSkipReason(tx, outcome)
          : (o.all ?? (k === 'fix' ? o.fix : undefined) ?? skipReason(tx, k) ?? SKIP_REASON.notNeeded)
    if (k === 'acceptance' && acceptanceOn(s) && outcome === 'no-changes')
      noteAcceptanceSkipped(tx, ACCEPTANCE_NOTE.noChanges)
    setStatus(tx, st, 'skipped', { reason })
  }
  if (deploys) {
    beginDeploy(tx, outcome)
    return
  }
  afterOutcomeHeld(tx, outcome)
}

/**
 * The outcome is decided and the Deploy step (when it ran) is over: Explain (when it runs), then an isolated run's
 * finalize, then completion.
 */
function afterOutcomeHeld(tx: Tx, outcome: RunOutcome): void {
  const s = tx.s
  if (s.steps.explain.status === 'queued' && explainRuns(tx, outcome)) {
    beginExplain(tx, outcome)
    return
  }
  if (isolatedRun(s) && skipReason(tx, 'finalize') === undefined) {
    beginFinalize(tx, outcome)
    return
  }
  complete(tx, outcome)
}

function complete(tx: Tx, outcome: RunOutcome): void {
  const s = tx.s
  s.outcome = outcome
  s.endedAt = tx.at
  delete s.flow.hold
  // The checklist as the run ends (a re-check of Fix until green may have confirmed criteria).
  if ((s.acceptance?.criteria.length ?? 0) > 0) writeAcceptance(tx)
  tx.push({ t: 'notify', kind: 'completed' })
  tx.transition = true
}

// ---- quality gates (the project's required checks, when the outcome is decided) -----------------------------------

/** The outcomes the quality gates apply to: a run that would otherwise count as done. */
const GATED_OUTCOMES: readonly RunOutcome[] = ['fixed', 'clean', 'findings-open']

/**
 * The project's quality gates (RunConfig.quality) over a decided outcome: each required verify command passed in the
 * run's last verify round, the security review ran with no security [must] left open, and the acceptance review marked
 * every criterion met. All pass: the outcome stands; one misses: `gates-failed` ("Completed with failures") with a
 * note naming each. Recorded as RunState.gates either way. Other outcomes are failures already and are left alone.
 */
export function qualityGates(tx: Tx, outcome: RunOutcome): RunOutcome {
  const s = tx.s
  const q = (s.config as Partial<RunConfig>).quality
  if (q === undefined || !GATED_OUTCOMES.includes(outcome)) return outcome
  const passed: string[] = []
  const failed: { name: string; reason: string }[] = []
  if (q.verify.length > 0) {
    // The run's last verify round: verify:2 after Fix when it ran, else verify:1 after Implement.
    const v1 = s.steps['verify:1']
    const v2 = s.steps['verify:2']
    const round = v2.status === 'done' ? v2.verify : v1.status === 'done' ? v1.verify : undefined
    // A round that did not run at all says why (its step's skip reason).
    const skipped =
      round === undefined ? [v2, v1].find((v) => v.status === 'skipped' && v.reason !== undefined) : undefined
    for (const name of q.verify) {
      const c = round?.commands.find((x) => x.name === name)
      if (!s.config.verify.enabled)
        failed.push({ name, reason: 'Verify is off for this run, so it did not run.' })
      else if (c === undefined && skipped?.reason !== undefined)
        failed.push({ name, reason: `It did not run: ${skipped.reason}.`.replace(/..$/, '.') })
      else if (c === undefined) failed.push({ name, reason: 'It did not run in this run.' })
      else if (c.status === 'pass') passed.push(name)
      else if (c.status === 'fail') failed.push({ name, reason: 'It failed.' })
      else
        failed.push({
          name,
          reason:
            c.reason !== undefined && c.reason !== '' ? `It did not run: ${c.reason}` : 'It did not run.',
        })
    }
  }
  if (q.security) {
    const name = 'security'
    if (!securityOn(s)) failed.push({ name, reason: 'The security review is off for this run.' })
    else if (s.steps.security.status !== 'done')
      failed.push({ name, reason: 'The security review did not finish.' })
    else {
      const open = (s.findings?.list ?? []).filter(
        (f) =>
          isSecurityFinding(f) &&
          f.severity === 'must' &&
          (outcome === 'findings-open' || !(s.findings?.selected ?? []).includes(f.id)),
      )
      if (open.length > 0)
        failed.push({
          name,
          reason: `Security findings are still open (${open.map((f) => `F${f.n}`).join(', ')}).`,
        })
      else passed.push(name)
    }
  }
  if (q.acceptance) {
    const name = 'acceptance'
    const a = s.acceptance
    const criteria = a?.criteria ?? []
    if (!acceptanceOn(s)) failed.push({ name, reason: 'The acceptance review is off for this run.' })
    else if (criteria.length === 0) failed.push({ name, reason: 'The plan has no acceptance criteria.' })
    else if (a?.review !== 'done') failed.push({ name, reason: 'The acceptance review did not finish.' })
    else {
      const unmet = criteria.filter((c) => a.results?.[c.id]?.status !== 'met')
      if (unmet.length > 0)
        failed.push({ name, reason: `Not every criterion is met (${unmet.map((c) => c.id).join(', ')}).` })
      else passed.push(name)
    }
  }
  s.gates = { passed, failed }
  tx.transition = true
  if (failed.length === 0) {
    tx.note(`Quality gates passed: ${passed.join(', ')}.`)
    return outcome
  }
  tx.note(
    `Completed with failures: the project's quality gates did not pass (${failed.map((f) => `${f.name}: ${f.reason}`).join(' ')})`,
  )
  return 'gates-failed'
}

// ---- the Deploy step (the Deploy helper's config, after the outcome is decided) -----------------------------------

/** The outcomes after which the Deploy step runs: the run completed without failures. */
export const DEPLOY_OUTCOMES: readonly RunOutcome[] = ['fixed', 'clean', 'findings-open']

/** Why the Deploy step did not run (step reasons and notes; UI copy, no em dashes). */
export const DEPLOY_REASON = {
  failures: 'run had failures',
  noChanges: 'no changes',
  nothingToWrite: 'nothing to write',
  noTarget: 'no target',
  unreadable: 'folder unreadable',
} as const

export const DEPLOY_NOTE = {
  failures:
    "The Deploy step did not run: the run completed with failures. Fix them, then open Deploy from the run's end.",
  noChanges: 'The Deploy step did not run: the run made no changes.',
  nothingToWrite: (target: string, present: readonly string[]): string =>
    present.length > 0
      ? `Deploy: ${target} needs no new config (${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} there already).`
      : `Deploy: ${target} needs no config file in the folder.`,
  noTarget: (cls: string): string =>
    `The Deploy step wrote nothing: no pack offers a deploy target for a ${cls.toLowerCase()}. See the Deploy panel for the checklist.`,
  unreadable: (why: string): string =>
    `The Deploy step could not read the folder, so it wrote nothing: ${why}`,
  planned: (target: string, files: readonly string[]): string =>
    `Deploy: writing ${files.join(', ')} for ${target}. Review them in the Diff tab; nothing is deployed.`,
} as const

function dep(s: RunState): DeployRunState {
  s.deploy ??= { phase: 'planning' }
  return s.deploy
}

/** `output deploy`: the Deploy step's facts changed (StepView.deploy); the renderer reads the snapshot again. */
function announceDeploy(tx: Tx): void {
  const v = (tx.s.outputs.deploy ?? 0) + 1
  tx.s.outputs.deploy = v
  tx.emit({ t: 'output', file: 'deploy', version: v })
  tx.transition = true
}

/** The Deploy step runs after this outcome: it is on, still queued, runnable, and the run had no failures. */
function deployRuns(tx: Tx, outcome: RunOutcome): boolean {
  const s = tx.s
  return (
    deployOn(s) &&
    s.steps.deploy.status === 'queued' &&
    skipReason(tx, 'deploy') === undefined &&
    DEPLOY_OUTCOMES.includes(outcome)
  )
}

/** The Deploy step's reason when it does not run (with its note when it was on). */
function deploySkipReason(tx: Tx, outcome: RunOutcome): string {
  const skip = skipReason(tx, 'deploy')
  if (skip !== undefined) return skip
  if (outcome === 'no-changes') {
    addNotes(tx, [DEPLOY_NOTE.noChanges])
    return DEPLOY_REASON.noChanges
  }
  addNotes(tx, [DEPLOY_NOTE.failures])
  return DEPLOY_REASON.failures
}

/** Hold the outcome and start the Deploy step with its planning. */
function beginDeploy(tx: Tx, outcome: RunOutcome): void {
  const s = tx.s
  s.deploy = { pending: { outcome }, phase: 'planning' }
  tx.transition = true
  startDeployPlanning(tx)
}

/**
 * The Deploy step's planning (again on Resume or a relaunch's Resume): the `deployPlan` request. A relaunch hold
 * pauses the step instead (Resume plans).
 */
function startDeployPlanning(tx: Tx): void {
  const s = tx.s
  const st = s.steps.deploy
  const d = dep(s)
  d.phase = 'planning'
  delete d.plan
  delete d.written
  delete d.note
  if (holdLaunch(tx, 'deploy')) {
    announceDeploy(tx)
    return
  }
  if (st.attempt === 0) st.attempt = 1
  setStatus(tx, st, 'running', { force: true })
  const req = tx.request({ kind: 'deploy-plan', attempt: st.attempt })
  tx.push({ t: 'deployPlan', req, target: s.config.deploy?.target ?? null })
  announceDeploy(tx)
}

/** The plan: nothing to write (the step is done with a note), or the editing pass with its start snapshot. */
function onDeployPlanResult(tx: Tx, e: Extract<EngineEventBody, { t: 'deploy-plan-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'deploy-plan') return
  const s = tx.s
  const st = s.steps.deploy
  const d = s.deploy
  if (d?.pending === undefined || d.phase !== 'planning' || s.stop !== undefined) return
  if (st.status !== 'running' || st.attempt !== r.attempt) return
  tx.transition = true
  if (e.plan === undefined) {
    d.phase = 'done'
    d.note = DEPLOY_NOTE.unreadable(e.failure?.message ?? 'unknown error')
    addNotes(tx, [d.note])
    setStatus(tx, st, 'skipped', { reason: DEPLOY_REASON.unreadable })
    announceDeploy(tx)
    return
  }
  const plan = e.plan
  d.plan = structuredClone(plan)
  if (plan.target === null) {
    d.phase = 'done'
    d.note = DEPLOY_NOTE.noTarget(plan.cls.label)
    addNotes(tx, [d.note])
    setStatus(tx, st, 'skipped', { reason: DEPLOY_REASON.noTarget })
    announceDeploy(tx)
    return
  }
  if (plan.files.length === 0) {
    d.phase = 'done'
    d.note = DEPLOY_NOTE.nothingToWrite(plan.target.label, plan.present)
    addNotes(tx, [d.note])
    setStatus(tx, st, 'done', { reason: DEPLOY_REASON.nothingToWrite })
    announceDeploy(tx)
    return
  }
  d.phase = 'generating'
  addNotes(tx, [
    DEPLOY_NOTE.planned(
      plan.target.label,
      plan.files.map((f) => f.path),
    ),
  ])
  announceDeploy(tx)
  startLaunch(tx, 'deploy', { cause: 'initial', plan: freshPlan(tx, 'deploy'), preflight: 'todo' })
}

/**
 * While the outcome is held: wait for the Deploy step to end (done with its end snapshot and end-of-pass check,
 * skipped, or the user went on without it), then complete with the held outcome (an isolated run finalizes first).
 */
function deployFlow(tx: Tx): void {
  const s = tx.s
  const d = s.deploy
  const st = s.steps.deploy
  if (d?.pending === undefined || !isTerminalPassStatus(st.status)) return
  if (st.status === 'done' && (st.endSnapStatus === 'requested' || st.endCheck === 'hold')) {
    s.boundary = { name: 'post-deploy', step: 'deploy' }
    return
  }
  if (s.boundary?.name === 'post-deploy') delete s.boundary
  const outcome = d.pending.outcome
  delete d.pending
  d.phase = 'done'
  announceDeploy(tx)
  afterOutcomeHeld(tx, outcome)
}

// ---- acceptance criteria and the acceptance review ------------------------------------------------------------

/** Notes about the acceptance criteria and their review (UI copy, no em dashes). */
export const ACCEPTANCE_NOTE = {
  noCriteria: 'The acceptance review did not run: the plan lists no acceptance criteria.',
  passesOff:
    "The acceptance review did not run: it uses the Review pass's settings (or Critic's, then Plan's), and all three are off.",
  noChanges: 'The acceptance review did not run: the run made no changes.',
  dropped: (n: number): string =>
    `The plan lists more acceptance criteria than Dim Factory keeps: ${n === 1 ? 'one was' : `${n} were`} left out.`,
  findings: (ids: readonly string[]): string =>
    `${ids.join(', ')} ${ids.length === 1 ? 'is' : 'are'} not met, so Fix gets ${ids.length === 1 ? 'it as a [must] finding' : 'them as [must] findings'}.`,
} as const

function acc(s: RunState): AcceptanceState {
  s.acceptance ??= { criteria: [] }
  return s.acceptance
}

/** acceptance.json (the checklist as it stands) with an `output acceptance` body; the renderer reads the snapshot again. */
function writeAcceptance(tx: Tx): void {
  const s = tx.s
  const v = acceptanceView(s)
  if (v === undefined) return
  const doc: AcceptanceFile = {
    schemaVersion: 1,
    runId: s.runId,
    review: v.review,
    criteria: v.items,
    counts: v.counts,
  }
  writeOutput(tx, 'acceptance', JSON.stringify(doc, null, 2))
  tx.transition = true
}

/** The decided plan's acceptance criteria (none when it lists none), once; acceptance.json when it has some. */
function decideCriteria(tx: Tx): void {
  const s = tx.s
  const parsed = parseCriteria(s.plan.text)
  s.acceptance = { criteria: parsed.criteria }
  if (parsed.dropped > 0) {
    s.acceptance.dropped = parsed.dropped
    addNotes(tx, [ACCEPTANCE_NOTE.dropped(parsed.dropped)])
  }
  if (parsed.criteria.length > 0) writeAcceptance(tx)
  tx.transition = true
}

/** The acceptance review's [must] findings (Fix until green): they join the reviewers' at R8 and block the skip rule. */
export function acceptanceFindings(s: RunState): Finding[] {
  return s.acceptance?.findings ?? []
}

/** The acceptance review did not run: its note, and the checklist says why. */
function noteAcceptanceSkipped(tx: Tx, note: string): void {
  const a = acc(tx.s)
  a.review = 'skipped'
  a.note = note
  addNotes(tx, [note])
  if (a.criteria.length > 0) writeAcceptance(tx)
}

/**
 * The acceptance review, after verify:1 and the scan and before the reviewers. True once the reviewers may start (also
 * when it is not used, skipped, or the user went on without it).
 */
function acceptanceFlow(tx: Tx): boolean {
  const s = tx.s
  if (!acceptanceOn(s)) return true
  const st = s.steps.acceptance
  if (st.status === 'queued') {
    const skip = skipReason(tx, 'acceptance')
    const criteria = s.acceptance?.criteria ?? []
    if (skip === undefined && criteria.length > 0) {
      acc(s).review = 'checking'
      tx.transition = true
      if (holdLaunch(tx, 'acceptance')) return false
      startLaunch(tx, 'acceptance', {
        cause: 'initial',
        plan: freshPlan(tx, 'acceptance'),
        preflight: 'todo',
      })
      return false
    }
    if (skip === SKIP_REASON.disabled) noteAcceptanceSkipped(tx, ACCEPTANCE_NOTE.passesOff)
    else if (skip === undefined) noteAcceptanceSkipped(tx, ACCEPTANCE_NOTE.noCriteria)
    setStatus(tx, st, 'skipped', { reason: skip ?? SKIP_REASON.noCriteria })
  }
  return isTerminalPassStatus(st.status)
}

/**
 * The acceptance review's answer (its structured answer, else a fenced JSON block): a verdict per criterion. With Fix
 * until green, each unmet criterion becomes a [must] finding; otherwise the review is a summary note only. An
 * unreadable answer leaves every criterion unknown with a note (never a failure).
 */
function acceptanceDone(tx: Tx, result: string): void {
  const s = tx.s
  const st = s.steps.acceptance
  const a = acc(s)
  const structured = st.meta[META_STRUCTURED_OUTPUT]
  const parsed = parseAcceptanceAnswer(structured !== undefined ? structured : result, a.criteria)
  a.results = parsed.results
  a.review = 'done'
  delete a.note
  delete a.findings
  addNotes(tx, parsed.notes)
  if (fixLoopOn(s)) {
    const unmet = a.criteria.filter((c) => parsed.results[c.id]?.status === 'not-met')
    a.findings = unmet.map((c): Finding => {
      const evidence = parsed.results[c.id]?.evidence
      return {
        id: `acceptance-${c.id.toLowerCase()}`,
        n: 0,
        severity: 'must',
        source: 'acceptance',
        title: `Acceptance criterion ${c.id} is not met: ${c.text}`,
        body: evidence !== undefined ? `Evidence: ${evidence}` : '',
        flags: [],
        round: 1,
      }
    })
    if (unmet.length > 0) addNotes(tx, [ACCEPTANCE_NOTE.findings(unmet.map((c) => c.id))])
  }
  const view = acceptanceView(s)
  if (view !== undefined) addNotes(tx, [acceptanceSummaryText(acceptanceCounts(view.items))])
  writeAcceptance(tx)
  setStatus(tx, st, 'done', parsed.readable ? {} : { reason: 'answer unreadable' })
}

/** The Tests step's answer (Test-first): the tests it mapped to each criterion, best effort. */
function noteTestsMapping(tx: Tx, result: string): void {
  const a = tx.s.acceptance
  if (a === undefined || a.criteria.length === 0) return
  const tests = parseTestsMapping(result, a.criteria)
  if (Object.keys(tests).length > 0) a.tests = tests
  else delete a.tests
  writeAcceptance(tx)
}

// ---- Explain it to me (after the outcome is decided) -------------------------------------------------------------

/** Why Explain did not run, or how it ended (step reasons; UI copy, no em dashes). */
export const EXPLAIN_REASON = {
  noChanges: 'no changes',
  empty: 'empty answer',
} as const

export const EXPLAIN_NOTE = {
  noChanges: 'Explain it to me did not run: the run made no changes.',
  passesOff:
    "Explain it to me did not run: it uses the Plan pass's settings (or Review's), and both are off.",
  empty: 'Explain it to me gave an empty answer, so there is no summary for this run.',
} as const

/** Explain runs after this outcome: it is on, still queued, runnable, and the run made changes. */
function explainRuns(tx: Tx, outcome: RunOutcome): boolean {
  const s = tx.s
  return (
    explainOn(s) &&
    s.steps.explain.status === 'queued' &&
    skipReason(tx, 'explain') === undefined &&
    outcome !== 'no-changes'
  )
}

/** Explain's reason when it does not run (with its note when it was on). */
function explainSkipReason(tx: Tx, outcome: RunOutcome): string {
  const skip = skipReason(tx, 'explain')
  if (skip === SKIP_REASON.disabled) addNotes(tx, [EXPLAIN_NOTE.passesOff])
  if (skip !== undefined) return skip
  if (outcome === 'no-changes') {
    addNotes(tx, [EXPLAIN_NOTE.noChanges])
    return EXPLAIN_REASON.noChanges
  }
  return SKIP_REASON.notNeeded
}

/** Hold the outcome and start Explain (a relaunch hold pauses it instead; Resume launches it). */
function beginExplain(tx: Tx, outcome: RunOutcome): void {
  const s = tx.s
  s.explain = { pending: { outcome } }
  tx.transition = true
  if (holdLaunch(tx, 'explain')) return
  startLaunch(tx, 'explain', { cause: 'initial', plan: freshPlan(tx, 'explain'), preflight: 'todo' })
}

/**
 * While the outcome is held: wait for Explain to end (done, or the user went on without it), then complete with the
 * held outcome (an isolated run finalizes first).
 */
function explainFlow(tx: Tx): void {
  const s = tx.s
  const e = s.explain
  if (e?.pending === undefined || !isTerminalPassStatus(s.steps.explain.status)) return
  const outcome = e.pending.outcome
  delete e.pending
  tx.transition = true
  if (isolatedRun(s) && skipReason(tx, 'finalize') === undefined) {
    beginFinalize(tx, outcome)
    return
  }
  complete(tx, outcome)
}

/** Explain's answer becomes explain.md; an empty one is a note (never a failure). */
function explainDone(tx: Tx, result: string): void {
  const s = tx.s
  const st = s.steps.explain
  const text = result
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (text === '') {
    const e = (s.explain ??= {})
    e.note = EXPLAIN_NOTE.empty
    addNotes(tx, [EXPLAIN_NOTE.empty])
    setStatus(tx, st, 'done', { reason: EXPLAIN_REASON.empty })
    return
  }
  writeOutput(tx, 'explain', text)
  setStatus(tx, st, 'done')
}

// ---- the security advisor: the scan (runner step) and the re-check after Fix ----------------------------------

/** What the scan step reads while it waits on the user. */
export const SCAN_WAIT_REASON = { trust: 'trust needed' } as const

/** Per-audit reasons (UI copy, no em dashes). */
export const SCAN_REASON = {
  notTrusted: 'Not trusted for this project. Auto never trusts a command on its own.',
  changed: 'Its script changed since it was trusted. Auto never trusts a command on its own.',
  userSkipped: 'You skipped it this run.',
  grantFailed: (why: string): string => `Dim Factory could not save the trust for it: ${why}`,
  stopped: 'Stopped before it finished.',
  interrupted: 'Interrupted when Dim Factory closed. Resume runs the scan again.',
} as const

function sec(s: RunState): NonNullable<RunState['security']> {
  s.security ??= {}
  return s.security
}

/** `output scan`: the scan's facts changed (StepView.scan); the renderer reads the snapshot again. */
function announceScan(tx: Tx): void {
  const v = (tx.s.outputs.scan ?? 0) + 1
  tx.s.outputs.scan = v
  tx.emit({ t: 'output', file: 'scan', version: v })
  tx.transition = true
}

/** The scan's findings (source `scan`): they join the reviewers' at R8 and block the Fix skip rule. */
export function scanFindings(s: RunState): Finding[] {
  return s.security?.scan?.phase === 'done' ? s.security.scan.findings : []
}

/**
 * The security advisor's scan, between verify:1 (R7) and the pre-review reconcile. True once the reviewers may start
 * (also when the advisor is off, or the scan was skipped).
 */
function scanFlow(tx: Tx): boolean {
  const st = tx.s.steps.scan
  if (st.status === 'queued') {
    const reason = skipReason(tx, 'scan')
    if (reason === undefined) {
      startScan(tx)
      return false
    }
    setStatus(tx, st, 'skipped', { reason })
  }
  return isTerminalPassStatus(st.status)
}

/**
 * Start (or rerun) the scan: what applies and its audits' trust first. A relaunch hold pauses it instead; Resume
 * reruns it. Without the snapshots it diffs (a failed S1) the scan cannot read the run's changes: skipped with a note.
 */
function startScan(tx: Tx): void {
  const s = tx.s
  const st = s.steps.scan
  if (s.flow.hold !== undefined) {
    if (st.attempt === 0) st.attempt = 1
    setStatus(tx, st, 'paused', { pause: s.flow.hold })
    return
  }
  const from = runBaseSnap(s)
  const to = s.steps.implement.endSnap
  if (from === undefined || to === undefined) {
    addNotes(tx, ["The security scan did not run: Dim Factory could not record the run's changes."])
    setStatus(tx, st, 'skipped', { reason: 'no snapshot' })
    return
  }
  nextAttempt(tx, st)
  const prev = sec(s).scan
  sec(s).scan = {
    phase: 'check',
    attempt: st.attempt,
    // A rerun keeps the audits it knows (queued again) until the check answers, so its rows never empty.
    audits: (prev?.audits ?? []).map(requeuedAudit),
    secrets: [],
    advisories: [],
    existing: 0,
    notes: [],
    findings: [],
  }
  setStatus(tx, st, 'running', { force: true })
  const req = tx.request({ kind: 'scan-check', attempt: st.attempt })
  tx.push({ t: 'scanCheck', req, attempt: st.attempt, from: from.commit, to: to.commit })
  announceScan(tx)
}

function requeuedAudit(a: ScanAuditState): ScanAuditState {
  return {
    name: a.name,
    tool: a.tool,
    argv: [...a.argv],
    cwdRel: a.cwdRel,
    lockfile: a.lockfile,
    body: a.body,
    trust: a.trust,
    decision: 'run',
    status: 'queued',
  }
}

/** One audit after the trust check: run it, ask about it (non-Auto), skip it (Auto), or not runnable. */
function checkedAudit(c: ScanCheckAudit, auto: boolean): ScanAuditState {
  const base: ScanAuditState = {
    name: c.name,
    tool: c.tool,
    argv: [...c.argv],
    cwdRel: c.cwdRel,
    lockfile: c.lockfile,
    body: c.body,
    trust: c.trust,
    decision: 'run',
    status: 'queued',
  }
  if (c.grantedBody !== undefined) base.grantedBody = c.grantedBody
  switch (c.trust) {
    case 'trusted':
      return base
    case 'invalid':
      return {
        ...base,
        decision: 'invalid',
        status: 'skipped',
        reason: c.reason ?? 'It cannot run as configured.',
      }
    case 'untrusted':
    case 'changed':
      // Auto never implies trust: the audit is not run (an info note, never a finding).
      return auto
        ? {
            ...base,
            decision: 'auto-skip',
            status: 'skipped',
            reason: c.trust === 'changed' ? SCAN_REASON.changed : SCAN_REASON.notTrusted,
          }
        : { ...base, decision: 'ask' }
  }
}

/** The run's scan for an answer of this attempt (undefined: stale, or the run has stopped or ended). */
function currentScan(s: RunState, attempt: number): ScanState | undefined {
  const sc = s.security?.scan
  if (sc === undefined || sc.attempt !== attempt || s.steps.scan.attempt !== attempt) return undefined
  if (s.stop !== undefined || s.outcome !== undefined) return undefined
  return sc
}

function onScanCheckResult(tx: Tx, e: Extract<EngineEventBody, { t: 'scan-check-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'scan-check') return
  const s = tx.s
  const sc = currentScan(s, r.attempt)
  const st = s.steps.scan
  if (sc?.phase !== 'check' || st.status !== 'running') return
  tx.transition = true
  if (e.failure !== undefined) {
    sc.notes.push(`Dim Factory could not check which dependency audits apply: ${e.failure.message}`)
    sc.audits = []
  } else {
    sc.notes.push(...e.notes)
    sc.audits = e.audits.map((c) => checkedAudit(c, s.config.auto))
  }
  for (const a of sc.audits) {
    if (a.decision === 'auto-skip') {
      sc.notes.push(
        `Auto did not run ${a.name}: ${a.trust === 'changed' ? 'its script changed since it was trusted' : 'it is not trusted for this project'}. Trust it to audit the dependencies a run changes.`,
      )
    } else if (a.decision === 'ask') {
      const id = nextCardId(tx, 'trust')
      a.cardId = id
      openCard(
        tx,
        trustCard(id, {
          step: 'scan',
          name: a.name,
          argv: a.argv,
          cwdRel: a.cwdRel,
          body: a.body,
          trust: a.trust === 'changed' ? 'changed' : 'untrusted',
          ...(a.grantedBody !== undefined ? { grantedBody: a.grantedBody } : {}),
        }),
        'scan',
      )
    }
  }
  announceScan(tx)
  if (sc.audits.some((a) => a.decision === 'ask')) {
    sc.phase = 'trust'
    setStatus(tx, st, 'waiting', { reason: SCAN_WAIT_REASON.trust })
    return
  }
  runScan(tx)
}

/** trust (an audit): [Trust for this project] writes the command grant, [Skip] leaves the audit out. */
function chooseScanTrust(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  const sc = s.security?.scan
  const a = sc?.audits.find((x) => x.cardId === c.view.id)
  if (sc?.phase !== 'trust' || a === undefined || s.stop !== undefined || s.outcome !== undefined) return
  delete a.cardId
  if (choiceId === TRUST_CHOICE.trust) {
    a.decision = 'granting'
    const req = tx.request({ kind: 'scan-grant', attempt: sc.attempt, name: a.name })
    tx.push({ t: 'trustGrant', req, command: auditGrant(a) })
    return
  }
  a.decision = 'skip'
  a.status = 'skipped'
  a.reason = SCAN_REASON.userSkipped
  announceScan(tx)
  afterScanTrust(tx)
}

/** The grant an audit takes: the verify command grant shape (its argv, folder and the body its hash covers). */
function auditGrant(a: ScanAuditState): GrantCommand {
  return { kind: 'verify', argv: [...a.argv], cwdRel: a.cwdRel, ...(a.body !== null ? { body: a.body } : {}) }
}

function onScanGrantResult(
  tx: Tx,
  r: Extract<PendingRequest, { kind: 'scan-grant' }>,
  e: Extract<EngineEventBody, { t: 'trust-grant-result' }>,
): void {
  const sc = currentScan(tx.s, r.attempt)
  if (sc?.phase !== 'trust') return
  const a = sc.audits.find((x) => x.name === r.name && x.decision === 'granting')
  if (a === undefined) return
  tx.transition = true
  if (e.ok) {
    a.decision = 'run'
    a.trust = 'trusted'
    a.status = 'queued'
    addNotes(tx, [`Trusted ${a.name} for this project.`])
  } else {
    a.decision = 'skip'
    a.status = 'skipped'
    a.reason = SCAN_REASON.grantFailed(e.error ?? 'unknown error')
  }
  announceScan(tx)
  afterScanTrust(tx)
}

function afterScanTrust(tx: Tx): void {
  const sc = tx.s.security?.scan
  if (sc?.phase !== 'trust') return
  if (sc.audits.some((a) => a.decision === 'ask' || a.decision === 'granting')) return
  runScan(tx)
}

/** The scan itself: the secret scanner, then the audits it may run (trust is checked again before each spawn). */
function runScan(tx: Tx): void {
  const s = tx.s
  const st = s.steps.scan
  const sc = s.security?.scan
  const from = runBaseSnap(s)
  const to = s.steps.implement.endSnap
  if (sc === undefined || from === undefined || to === undefined) return
  sc.phase = 'running'
  if (st.status !== 'running') setStatus(tx, st, 'running')
  for (const a of sc.audits) if (a.decision === 'run') a.status = 'running'
  const req = tx.request({ kind: 'scan', attempt: sc.attempt })
  tx.push({
    t: 'scan',
    req,
    attempt: sc.attempt,
    from: from.commit,
    to: to.commit,
    audits: sc.audits.map((a): ScanRunAudit => {
      const out: ScanRunAudit = {
        name: a.name,
        tool: a.tool,
        argv: [...a.argv],
        cwdRel: a.cwdRel,
        lockfile: a.lockfile,
        run: a.decision === 'run',
      }
      if (a.decision !== 'run') {
        out.status = 'skipped'
        if (a.reason !== undefined) out.reason = a.reason
      }
      return out
    }),
  })
  announceScan(tx)
}

/** The scan's results: its findings (source `scan`, critical and high `[must]`), notes, the step done. */
function onScanResult(tx: Tx, e: Extract<EngineEventBody, { t: 'scan-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'scan') return
  const s = tx.s
  const sc = currentScan(s, r.attempt)
  const st = s.steps.scan
  if (sc?.phase !== 'running' || st.status !== 'running') return
  tx.transition = true
  sc.phase = 'done'
  if (e.failure !== undefined) {
    sc.notes.push(`The security scan could not run: ${e.failure.message}`)
    // Nothing was read, so nothing says the changes are safe: a reviewer kept for sensitive changes still runs.
    sc.sensitive = true
  } else {
    sc.secrets = e.secrets.map((x) => ({ ...x }))
    sc.advisories = e.advisories.map((x) => ({ ...x }))
    sc.existing = e.existing
    sc.notes.push(...e.notes)
    for (const res of e.audits) {
      const a = sc.audits.find((x) => x.name === res.name)
      if (a === undefined) continue
      a.status = res.status
      if (res.reason !== undefined) a.reason = res.reason
      if (res.introduced !== undefined) a.introduced = res.introduced
      if (res.existing !== undefined) a.existing = res.existing
    }
    sc.findings = toFindings(e.findings, 'scan')
    if (e.sensitive === true) sc.sensitive = true
  }
  for (const a of sc.audits) {
    if (a.status !== 'running' && a.status !== 'queued') continue
    a.status = 'skipped'
    a.reason ??= 'It did not run.'
  }
  const n = sc.findings.length
  addNotes(tx, [
    n === 0
      ? 'The security scan found no secrets and no advisories for dependencies this run added or changed.'
      : `The security scan found ${n === 1 ? 'one problem' : `${n} problems`} (listed with the findings).`,
  ])
  setStatus(tx, st, 'done')
  announceScan(tx)
}

/** Stop / quit: cancel the scan in flight (its running audit's tree is killed). */
function stopScans(tx: Tx): void {
  for (const [req, r] of Object.entries(tx.s.requests)) if (r.kind === 'scan') tx.push({ t: 'scanStop', req })
}

/** A scan that stops being live settles its rows (never a spinner for good). */
function settleScanRows(s: RunState, reason: string): void {
  const sc = s.security?.scan
  if (sc === undefined || sc.phase === 'done') return
  for (const a of sc.audits) {
    if (a.status !== 'running' && a.status !== 'queued') continue
    a.status = 'skipped'
    a.reason = reason
  }
}

/**
 * The security [must] findings Fix was given (the Security pass's and the scan's): what the re-check after Fix
 * confirms, in list order.
 */
export function recheckTargets(s: RunState): Finding[] {
  const fs = s.findings
  if (fs === undefined) return []
  // Fix until green: every [must] Fix got this round, but verify's (the round's verify decides those).
  const given = selectedFindings(s).filter((f) => f.severity === 'must')
  if (recheckAll(s)) return given.filter((f) => f.source !== 'verify')
  // The security advisor's re-check: the security ones (in a later round, those still open).
  return given.filter((f) => isSecurityFinding(f))
}

/**
 * After Fix and verify:2: the re-check, when the advisor is on, it is not turned off, Fix ran and it was given a
 * security [must]. True once the run may complete.
 */
function recheckFlow(tx: Tx): boolean {
  const s = tx.s
  const st = s.steps.recheck
  if (st.status === 'queued') {
    const skip = skipReason(tx, 'recheck')
    const targets = recheckTargets(s)
    const fixDone = s.steps.fix.status === 'done' && s.steps.fix.endSnap !== undefined
    if (skip !== undefined || targets.length === 0 || !fixDone) {
      setStatus(tx, st, 'skipped', { reason: skip ?? SKIP_REASON.notNeeded })
      return true
    }
    // Fix until green: a round that changed nothing resolved nothing; no re-check is needed to say so.
    const fix = s.steps.fix
    if (fixLoopOn(s) && fix.endSnapStatus === 'done' && sameSnap(fix.startSnap, fix.endSnap)) {
      setStatus(tx, st, 'skipped', { reason: SKIP_REASON.noChanges })
      return true
    }
    sec(s).recheck = { checks: targets.map((f) => f.n), status: 'checking', resolved: [], open: [] }
    tx.transition = true
    // Each round's re-check is a new attempt of the step.
    if (st.attempt > 0) nextAttempt(tx, st)
    if (holdLaunch(tx, 'recheck')) return false
    startLaunch(tx, 'recheck', { cause: 'initial', plan: freshPlan(tx, 'recheck'), preflight: 'todo' })
    return false
  }
  return isTerminalPassStatus(st.status)
}

/** The re-check's answer: each checked finding resolved or still open (one it does not name stays open). */
function recheckDone(tx: Tx, result: string): void {
  const s = tx.s
  writeOutput(tx, 'recheck', result)
  const checks = sec(s).recheck?.checks ?? recheckTargets(s).map((f) => f.n)
  const verdict = parseRecheck(result, checks)
  sec(s).recheck = {
    checks,
    status: verdict.named === 0 ? 'unclear' : verdict.open.length > 0 ? 'open' : 'resolved',
    resolved: verdict.resolved,
    open: verdict.open,
  }
  setStatus(tx, s.steps.recheck, 'done')
}

// ---- Fix until green (rounds of Fix → verify:2 → re-check) ------------------------------------------------------

/** `output rounds`: Fix until green's rounds changed (RunSnapshot.fixLoop); the renderer reads them again. */
function announceRounds(tx: Tx): void {
  const v = (tx.s.outputs.rounds ?? 0) + 1
  tx.s.outputs.rounds = v
  tx.emit({ t: 'output', file: 'rounds', version: v })
  tx.transition = true
}

/** The run's working time so far (every step's running and stalled time, every attempt). */
export function activeTotal(s: RunState, at: number): number {
  let ms = 0
  for (const k of STEP_KEYS) ms += activeMsAt(s.steps[k], at)
  return ms
}

function newRound(tx: Tx, n: number): FixRoundState {
  const s = tx.s
  return {
    n,
    status: 'running',
    startedAt: tx.at,
    base: { usd: totalCost(s), activeMs: activeTotal(s, tx.at) },
    spawnFrom: s.steps.fix.spawnNo,
    resolved: [],
    open: [],
    usd: null,
    activeMs: 0,
  }
}

/** Fix has not spawned in its current round (or ever): its launch redoes R10 (reconcile, F0, the session). */
export function fixUnspawned(s: RunState): boolean {
  const round = s.fixLoop?.rounds[s.fixLoop.rounds.length - 1]
  return s.steps.fix.spawnNo === (round !== undefined && round.n > 1 ? round.spawnFrom : 0)
}

/** UI copy for a stop (no em dashes). */
export const FIX_STOP_TEXT = {
  green: (n: number): string =>
    `Fix until green: green after round ${n}. No [must] finding is open and verify passes.`,
  cap: (n: number, max: number): string =>
    `Fix until green stopped at the round cap (${n} of ${max} rounds) before the run was green.`,
  noChange: (n: number): string => `Fix until green stopped: round ${n} made no changes.`,
  noShrink: (n: number, open: number): string =>
    `Fix until green stopped: round ${n} did not reduce what is open (${open} still open).`,
  budget: (what: string): string =>
    `Fix until green stopped: another round would go past the budget (${what}).`,
} as const

/** Close the round that just ended: what changed, what still fails, what the re-check resolved, what it spent. */
function closeRound(tx: Tx, round: FixRoundState): void {
  const s = tx.s
  const fix = s.steps.fix
  const v2 = s.steps['verify:2']
  round.status = 'done'
  // A failed end snapshot counts as changed: never report "no progress" without proof.
  round.changed = fix.endSnapStatus !== 'done' || !sameSnap(fix.startSnap, fix.endSnap)
  const failing = v2.status === 'done' ? blockingFailures(s, v2.verify).map((c) => c.name) : []
  // verify:1's failures that did not run and pass after this round stay open too (R11: only a pass is evidence).
  const unverified = v2.status === 'done' ? unverifiedAfterFix(s).map((u) => u.name) : []
  if (v2.status === 'done') round.failing = [...new Set([...failing, ...unverified])]
  else delete round.failing
  // The re-check's verdict over the round's targets (verify's are decided by verify:2 above).
  const targets = recheckTargets(s).map((f) => f.n)
  const rc = s.security?.recheck
  const rcStep = s.steps.recheck
  let resolved: number[] = []
  let open: number[] = []
  if (rcStep.status === 'done' && rc !== undefined) {
    resolved = [...rc.resolved]
    open = rc.status === 'unclear' ? [...rc.checks] : rc.open.map((o) => o.n)
  } else if (rcStep.status === 'skipped' && rcStep.reason === SKIP_REASON.noChanges) {
    open = targets
  } else if (rcStep.status === 'skipped' && rcStep.reason === SKIP_REASON.user) {
    // You went on without the re-check: nothing is confirmed resolved.
    open = targets
  }
  // The round's failing verify commands as their findings (listed after Fix by completeRound).
  const verifyOpen = verifyFindingNumbers(s, round.failing ?? [])
  round.resolved = resolved
  round.open = [...new Set([...open, ...verifyOpen])].sort((a, b) => a - b)
  round.count = open.length + (round.failing?.length ?? 0)
  const now = totalCost(s)
  round.usd = now === null ? null : Math.round((now - (round.base.usd ?? 0)) * 1e10) / 1e10
  round.activeMs = Math.max(0, activeTotal(s, tx.at) - round.base.activeMs)
  round.views = roundViews(s, tx.at, round.n)
  // The round's own diff (the Diff tab's per-round segment): its Fix start to its end snapshot.
  const from = fix.startSnap ?? (round.n === 1 ? s.fixLoop?.firstStart : undefined)
  const to = fix.endSnap ?? s.snapshots.S2
  if (from !== undefined && to !== undefined && to.at >= from.at) {
    round.startSnap = { ...from }
    round.endSnap = { ...to }
  }
  announceRounds(tx)
}

/**
 * The round's Fix, Final verify and Re-check as they ended: the next round is a new attempt of the same steps, and the
 * Run view keeps the earlier round's cards as they were from these.
 */
function roundViews(s: RunState, at: number, n: number): NonNullable<FixRoundState['views']> {
  const of = fixRoundsMax(s)
  const view = (k: 'fix' | 'verify:2' | 'recheck'): StepView => ({
    ...toStepView(s.steps[k], at),
    round: { n, of },
  })
  const out = { fix: view('fix'), verify: view('verify:2'), recheck: view('recheck') }
  const rc = s.security?.recheck
  if (rc !== undefined && s.steps.recheck.status === 'done') {
    out.recheck.recheck = {
      status: rc.status,
      resolved: [...rc.resolved],
      open: rc.open.map((o) => ({ ...o })),
    }
  }
  return structuredClone(out)
}

/** The F-numbers of verify:2's latest findings for these failing commands (each one's [must]). */
function verifyFindingNumbers(s: RunState, names: readonly string[]): number[] {
  const fs = s.findings
  if (fs?.verify?.step !== 'verify:2' || names.length === 0) return []
  const ids = new Set(fs.verify.findings.filter((f) => f.severity === 'must').map((f) => f.id))
  const byId = s.fixLoop?.verifyN ?? {}
  const out: number[] = []
  for (const id of ids) {
    const n = byId[id] ?? fs.list.find((f) => f.id === id)?.n
    if (n !== undefined) out.push(n)
  }
  return out
}

/** Why the loop stops after this (not green) round, or undefined when another round may run. */
function stopAfter(
  tx: Tx,
  loop: FixLoopState,
  round: FixRoundState,
): { reason: FixStopReason; text: string } | undefined {
  const s = tx.s
  const max = fixRoundsMax(s)
  if (round.n >= max) return { reason: 'cap', text: FIX_STOP_TEXT.cap(round.n, max) }
  if (round.changed === false) return { reason: 'no-progress', text: FIX_STOP_TEXT.noChange(round.n) }
  const prev = round.n === 1 ? loop.before : (loop.rounds[round.n - 2]?.count ?? loop.before)
  const count = round.count ?? 0
  if (count >= prev) return { reason: 'no-progress', text: FIX_STOP_TEXT.noShrink(round.n, count) }
  // The budget: the next round is expected to cost what this one did (cost and working time).
  const cfg = s.config.fixLoop
  if (cfg?.maxUsd !== undefined) {
    const spent = totalCost(s)
    if (spent !== null && spent + (round.usd ?? 0) > cfg.maxUsd)
      return { reason: 'budget', text: FIX_STOP_TEXT.budget(`$${cfg.maxUsd.toFixed(2)} per run`) }
  }
  if (cfg?.maxMinutes !== undefined) {
    const used = activeTotal(s, tx.at)
    if (used + round.activeMs > cfg.maxMinutes * 60_000)
      return {
        reason: 'budget',
        text: FIX_STOP_TEXT.budget(`${cfg.maxMinutes} min of working time per run`),
      }
  }
  return undefined
}

/**
 * A round is over (Fix, its end snapshot, verify:2 and the re-check): green → fixed; else the round cap, a round
 * without progress or the budget stops the loop ("Completed with failures"); else the post-round snapshot, then the
 * next round.
 */
function afterRound(tx: Tx, loop: FixLoopState): void {
  const s = tx.s
  const round = loop.rounds[loop.rounds.length - 1]
  if (round === undefined) return
  if (round.status === 'running') closeRound(tx, round)
  if (loop.stop !== undefined) return
  const green = (round.failing ?? []).length === 0 && round.open.length === 0
  if (green) {
    loop.stop = { reason: 'green', text: FIX_STOP_TEXT.green(round.n) }
    addNotes(tx, [loop.stop.text])
    notePreexisting(tx)
    announceRounds(tx)
    finish(tx, 'fixed')
    return
  }
  const stop = stopAfter(tx, loop, round)
  if (stop !== undefined) {
    loop.stop = stop
    const what: string[] = []
    if ((round.failing ?? []).length > 0) {
      const f = round.failing ?? []
      what.push(`${f.join(', ')} still ${f.length === 1 ? 'fails' : 'fail'}`)
    }
    const musts = round.open.filter((n) => !verifyFindingNumbers(s, round.failing ?? []).includes(n))
    if (musts.length > 0) what.push(`${musts.map((n) => `F${n}`).join(', ')} still open`)
    tx.note(`Completed with failures: ${stop.text}${what.length > 0 ? ` ${what.join('; ')}.` : ''}`)
    notePreexisting(tx)
    announceRounds(tx)
    finish(tx, 'fix-stopped')
    return
  }
  // The next round: the folder as this round's checks left it first (the next reconcile compares with it).
  loop.postRound = 'requested'
  s.boundary = { name: 'post-round', step: 'fix' }
  requestSnapshot(tx, 'post-round', 'post-round')
  tx.transition = true
}

/** The next round: Fix again (a new attempt from its own start snapshot) on what is still open, then verify:2 and the re-check. */
function beginRound(tx: Tx): void {
  const s = tx.s
  const loop = s.fixLoop
  const prev = loop?.rounds[loop.rounds.length - 1]
  if (loop === undefined || prev === undefined) return
  const n = prev.n + 1
  const fix = s.steps.fix
  loop.round = n
  loop.targets = [...prev.open]
  loop.rounds.push(newRound(tx, n))
  nextAttempt(tx, fix)
  fix.autoRetryUsed = false
  fix.snagOpen = false
  delete fix.startSnap
  delete fix.endSnap
  delete fix.endSnapStatus
  delete fix.endCheck
  delete fix.attemptEnd
  delete fix.failure
  delete fix.result
  const v2 = s.steps['verify:2']
  if (v2.status !== 'queued') setStatus(tx, v2, 'queued')
  const rc = s.steps.recheck
  const settled =
    rc.status === 'skipped' && (rc.reason === SKIP_REASON.notUsed || rc.reason === SKIP_REASON.disabled)
  if (!settled && rc.status !== 'queued') setStatus(tx, rc, 'queued')
  if (s.security?.recheck !== undefined) delete s.security.recheck
  tx.note(
    `Fix until green: round ${n} of ${fixRoundsMax(s)} works on what is still open (${prev.open.map((x) => `F${x}`).join(', ')}).`,
  )
  announceRounds(tx)
  if (holdLaunch(tx, 'fix')) return
  startLaunch(
    tx,
    'fix',
    { cause: 'initial', decide: 'session', reconcile: 'todo', preflight: 'todo' },
    { force: true },
  )
}

/**
 * The security outcome after the re-check: the open security [must] F-numbers (a re-check that named none of them
 * leaves them all open), or undefined when it confirmed them all or did not run.
 */
function openSecurityMusts(s: RunState): number[] | undefined {
  const rc = s.security?.recheck
  if (s.steps.recheck.status !== 'done' || rc === undefined) return undefined
  if (rc.status === 'resolved') return undefined
  return rc.status === 'unclear' ? [...rc.checks] : rc.open.map((o) => o.n)
}

// ---- verify rounds (R6/R7/R11, runner steps) -------------------------------------------------------------------

export const VERIFY_ROUNDS = [
  'verify:0',
  'verify:red',
  'verify:1',
  'verify:2',
] as const satisfies readonly VerifyRound[]

export function isVerifyRound(k: StepKey): k is VerifyRound {
  return k === 'verify:0' || k === 'verify:1' || k === 'verify:2' || k === 'verify:red'
}

/** A round's combined output, relative to the run folder (runs.output `verify:<n>`, findings.json's rawFile). */
export function verifyOutputRel(step: VerifyRound): string {
  return `verify/${fileSafe(step)}/output.log`
}

/** What a verify round's step reads while it waits on the user. */
export const VERIFY_WAIT_REASON = {
  trust: 'trust needed',
  env: 'checks could not run',
} as const

/** Per-command reasons (UI copy, no em dashes). */
export const VERIFY_REASON = {
  notTrusted: 'Not trusted for this project. Auto never trusts a command on its own.',
  changed: 'Its script changed since it was trusted. Auto never trusts a command on its own.',
  userSkipped: 'You skipped it this round.',
  grantFailed: (why: string): string => `Dim Factory could not save the trust for it: ${why}`,
  notRun: 'It did not run.',
  couldNotRun: 'Verify could not run.',
  stopped: { running: 'Stopped before it finished.', queued: 'Stopped before it ran.' },
  interrupted: {
    running: 'Interrupted when Dim Factory closed. Resume runs it again.',
    queued: 'Not run yet: Dim Factory closed. Resume runs it.',
  },
} as const

/** The latest round's failing commands (a `[must]` each, unless the baseline failed too: blockingFailures). */
export function failingCommands(v: VerifyRoundState | undefined): VerifyCommandState[] {
  return (v?.commands ?? []).filter((c) => c.status === 'fail')
}

/**
 * A command that failed in verify:0 too is "already failing before this run": a `[should]` that neither
 * blocks the Fix skip rule nor makes the run verify-failed. Absent baseline (in-place runs): none.
 */
export function preexistingFailure(s: RunState, name: string): boolean {
  return s.isolation?.baseline?.[name] === 'fail'
}

/** A round's failing commands that count against the run: failing now and not already failing before it. */
export function blockingFailures(s: RunState, v: VerifyRoundState | undefined): VerifyCommandState[] {
  return failingCommands(v).filter((c) => !preexistingFailure(s, c.name))
}

/**
 * R11: verify:1's failing commands that verify:2 did not run and pass, each with why (its row's reason;
 * undefined when the round had no row for it). Empty when every one of them passed after Fix. A failure that is
 * pre-existing (the baseline) never counts.
 */
export function unverifiedAfterFix(s: RunState): { name: string; reason?: string }[] {
  const after = s.steps['verify:2'].verify?.commands ?? []
  return blockingFailures(s, s.steps['verify:1'].verify)
    .map((c) => ({ name: c.name, row: after.find((x) => x.name === c.name) }))
    .filter(({ row }) => row?.status !== 'pass')
    .map(({ name, row }) =>
      row?.reason !== undefined && row.reason !== '' ? { name, reason: row.reason } : { name },
    )
}

/**
 * A round that stops being live (Stop, quit, a relaunch) settles the rows it would never report: the
 * command it was running and those still queued read `skipped` with why, never a spinner for good.
 */
function settleVerifyRows(st: StepState, why: { running: string; queued: string }): void {
  const v = st.verify
  if (v === undefined || v.phase === 'done') return
  for (const c of v.commands) {
    if (c.status === 'running') {
      c.status = 'skipped'
      c.reason = why.running
    } else if (c.status === 'queued') {
      c.status = 'skipped'
      c.reason ??= why.queued
    }
  }
}

/**
 * "The latest verify has no `[must]` failures" (the latest round with results). A pre-existing failure (the
 * baseline) is a `[should]` and does not block the skip rule.
 */
export function latestVerifyHasMust(s: RunState): boolean {
  for (const k of ['verify:2', 'verify:1'] as const) {
    const v = s.steps[k].verify
    if (v?.phase === 'done') return blockingFailures(s, v).length > 0
  }
  return false
}

/** A configured command before its round's first trust check: its name, queued (argv, body and trust follow). */
function placeholderCommand(name: string): VerifyCommandState {
  return { name, argv: [], cwdRel: '.', body: null, trust: 'untrusted', decision: 'run', status: 'queued' }
}

/** A command as a rerun shows it until its trust check answers: queued, no result. */
function requeuedCommand(c: VerifyCommandState): VerifyCommandState {
  return {
    name: c.name,
    argv: [...c.argv],
    cwdRel: c.cwdRel,
    body: c.body,
    trust: c.trust,
    decision: 'run',
    status: 'queued',
  }
}

/**
 * Start (or rerun) a verify round: its trust check first, with every body re-read. A relaunch hold (never
 * auto-resume) pauses it instead; Resume reruns it.
 */
function startVerify(tx: Tx, key: VerifyRound): void {
  const s = tx.s
  const st = s.steps[key]
  if (s.flow.hold !== undefined) {
    if (st.attempt === 0) st.attempt = 1
    setStatus(tx, st, 'paused', { pause: s.flow.hold })
    return
  }
  if (st.attempt === 0 || st.verify !== undefined) nextAttempt(tx, st)
  // A rerun keeps the commands it knows (queued again) until the check answers, so the list never empties. A
  // first round starts with the configured names as its rows (the check fills them in place), so the card
  // never grows rows above what follows it in the flow.
  const known = st.verify?.commands ?? (s.config.verify.names ?? []).map(placeholderCommand)
  st.verify = { phase: 'check', commands: known.map(requeuedCommand) }
  setStatus(tx, st, 'running', { force: true })
  const req = tx.request({ kind: 'verify-check', step: key, attempt: st.attempt })
  tx.push({ t: 'verifyCheck', req, step: key, attempt: st.attempt })
  tx.transition = true
}

/** One configured command after the trust check: run it, ask about it (non-Auto), skip it (Auto), or not runnable. */
function checkedCommand(c: VerifyCheckCommand, auto: boolean): VerifyCommandState {
  const base: VerifyCommandState = {
    name: c.name,
    argv: [...c.argv],
    cwdRel: c.cwdRel,
    body: c.body,
    trust: c.trust,
    decision: 'run',
    status: 'queued',
  }
  if (c.grantedBody !== undefined) base.grantedBody = c.grantedBody
  switch (c.trust) {
    case 'trusted':
      return base
    case 'invalid':
      return {
        ...base,
        decision: 'invalid',
        status: 'skipped',
        reason: c.reason ?? 'It cannot run as configured.',
      }
    case 'untrusted':
    case 'changed':
      // Auto never implies trust: skipped, with a `[should]` finding from the round.
      return auto
        ? {
            ...base,
            decision: 'auto-skip',
            status: 'skipped-untrusted',
            reason: c.trust === 'changed' ? VERIFY_REASON.changed : VERIFY_REASON.notTrusted,
          }
        : { ...base, decision: 'ask' }
  }
}

/** The round's trust check answered: trust cards for what needs the user, else the round runs. */
function onVerifyCheckResult(tx: Tx, e: Extract<EngineEventBody, { t: 'verify-check-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'verify-check') return
  const s = tx.s
  const st = s.steps[r.step]
  const v = st.verify
  if (s.stop !== undefined || s.outcome !== undefined) return
  if (v?.phase !== 'check' || st.attempt !== r.attempt || st.status !== 'running') return
  tx.transition = true
  if (e.failure !== undefined) {
    if (r.step === 'verify:0') {
      addNotes(tx, [`The baseline check could not run: ${e.failure.message}`])
      completeRound(tx, r.step)
      return
    }
    openVerifyEnv(tx, r.step, [], e.failure.message)
    return
  }
  v.commands = e.commands.map((c) => checkedCommand(c, s.config.auto))
  for (const c of v.commands) {
    // The baseline says nothing of its own about an untrusted command (verify:1 notes it, with its [should]).
    if (c.decision === 'auto-skip' && r.step !== 'verify:0') {
      tx.note(
        `Auto skipped the verify command ${c.name}: ${c.trust === 'changed' ? 'its script changed since it was trusted' : 'it is not trusted for this project'}. Trust it in Settings to run it.`,
      )
    } else if (c.decision === 'ask') {
      const id = nextCardId(tx, 'trust')
      c.cardId = id
      const trust = c.trust === 'changed' ? 'changed' : 'untrusted'
      openCard(
        tx,
        trustCard(id, {
          step: r.step,
          name: c.name,
          argv: c.argv,
          cwdRel: c.cwdRel,
          body: c.body,
          trust,
          ...(c.grantedBody !== undefined ? { grantedBody: c.grantedBody } : {}),
        }),
        r.step,
      )
    }
  }
  if (v.commands.some((c) => c.decision === 'ask')) {
    v.phase = 'trust'
    setStatus(tx, st, 'waiting', { reason: VERIFY_WAIT_REASON.trust })
    return
  }
  startRound(tx, r.step)
}

/** trust: [Trust for this project] writes the command grant, [Skip] leaves the command out. */
function chooseTrust(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  resolveCard(tx, c.view.id, choiceId)
  const p = trustPayloadOf(c.view)
  if (p === undefined || s.stop !== undefined || s.outcome !== undefined) return
  if (p.step === 'scan') {
    chooseScanTrust(tx, c, choiceId)
    return
  }
  const st = s.steps[p.step]
  const v = st.verify
  const cmd = v?.commands.find((x) => x.cardId === c.view.id)
  if (v?.phase !== 'trust' || cmd === undefined) return
  delete cmd.cardId
  if (choiceId === TRUST_CHOICE.trust) {
    cmd.decision = 'granting'
    const req = tx.request({ kind: 'trust-grant', step: p.step, attempt: st.attempt, name: cmd.name })
    // The body the user was shown: a script that changes after this click is not covered.
    tx.push({
      t: 'trustGrant',
      req,
      command: {
        kind: 'verify',
        argv: [...cmd.argv],
        cwdRel: cmd.cwdRel,
        ...(cmd.body !== null ? { body: cmd.body } : {}),
      },
    })
    return
  }
  cmd.decision = 'skip'
  cmd.status = 'skipped'
  cmd.reason = VERIFY_REASON.userSkipped
  afterTrustDecision(tx, p.step)
}

function onTrustGrantResult(tx: Tx, e: Extract<EngineEventBody, { t: 'trust-grant-result' }>): void {
  const r = tx.take(e.req)
  // The depsConsent card's [Install] wrote (or could not write) the `deps` grant.
  if (r?.kind === 'deps-grant') {
    onDepsGrantResult(tx, e)
    return
  }
  // An audit of the security scan.
  if (r?.kind === 'scan-grant') {
    onScanGrantResult(tx, r, e)
    return
  }
  if (r === undefined || r.kind !== 'trust-grant') return
  const s = tx.s
  const st = s.steps[r.step]
  const v = st.verify
  if (s.stop !== undefined || s.outcome !== undefined || v?.phase !== 'trust' || st.attempt !== r.attempt)
    return
  const cmd = v.commands.find((c) => c.name === r.name && c.decision === 'granting')
  if (cmd === undefined) return
  tx.transition = true
  if (e.ok) {
    cmd.decision = 'run'
    cmd.trust = 'trusted'
    cmd.status = 'queued'
    addNotes(tx, [`Trusted the verify command ${cmd.name} for this project.`])
  } else {
    const why = e.error ?? 'unknown error'
    cmd.decision = 'skip'
    cmd.status = 'skipped'
    cmd.reason = VERIFY_REASON.grantFailed(why)
    tx.note(
      `The verify command ${cmd.name} was skipped: Dim Factory could not save the trust for it (${why}).`,
    )
  }
  afterTrustDecision(tx, r.step)
}

/** Every trust card answered and every grant written: the round runs. */
function afterTrustDecision(tx: Tx, key: VerifyRound): void {
  const v = tx.s.steps[key].verify
  if (v?.phase !== 'trust') return
  if (v.commands.some((c) => c.decision === 'ask' || c.decision === 'granting')) return
  startRound(tx, key)
}

function runCommandOf(c: VerifyCommandState): VerifyRunCommand {
  const out: VerifyRunCommand = {
    name: c.name,
    argv: [...c.argv],
    cwdRel: c.cwdRel,
    run: c.decision === 'run',
  }
  if (c.decision === 'run') return out
  out.status = c.decision === 'auto-skip' ? 'skipped-untrusted' : 'skipped'
  if (c.reason !== undefined) out.reason = c.reason
  return out
}

/** The round itself (the controller checks trust again right before each spawn). */
function startRound(tx: Tx, key: VerifyRound): void {
  const st = tx.s.steps[key]
  const v = st.verify
  if (v === undefined) return
  v.phase = 'running'
  if (st.status !== 'running') setStatus(tx, st, 'running')
  // The baseline's commands run in the isolated copy alongside Plan (see onPlanEndSnapshot).
  if (key === 'verify:0') iso(tx.s).copyWritten = true
  const req = tx.request({ kind: 'verify', step: key, attempt: st.attempt })
  tx.push({ t: 'verify', req, step: key, attempt: st.attempt, commands: v.commands.map(runCommandOf) })
  tx.transition = true
}

/** A command's result onto its row. */
function applyResult(c: VerifyCommandState, res: VerifyResultInput): void {
  c.status = res.status
  c.exitCode = res.exitCode
  c.durationMs = res.durationMs
  if (res.excerpt !== '') c.excerpt = res.excerpt
  else delete c.excerpt
  if (res.logPath !== '') c.logPath = res.logPath
  if (res.reason !== undefined) c.reason = res.reason
  if (res.timedOut === true) c.timedOut = true
  else delete c.timedOut
  // Dim Factory's play-test: its scenarios as passed or failed.
  if (res.scenarios !== undefined) c.scenarios = res.scenarios.map((x) => ({ ...x }))
  else delete c.scenarios
  // The round checks trust again right before each spawn: what it found there is the command's trust now.
  if (res.trust !== undefined) c.trust = res.trust
}

/** A command of a finished round as src/core/verify reads it ({{verify}}). */
export function verifyResultOf(c: VerifyCommandState): VerifyResultInput | undefined {
  if (c.status === 'queued' || c.status === 'running') return undefined
  const out: VerifyResultInput = {
    name: c.name,
    argv: [...c.argv],
    status: c.status,
    exitCode: c.exitCode ?? null,
    durationMs: c.durationMs ?? 0,
    excerpt: c.excerpt ?? '',
    logPath: c.logPath ?? '',
  }
  if (c.reason !== undefined) out.reason = c.reason
  if (c.timedOut === true) out.timedOut = true
  if (c.scenarios !== undefined) out.scenarios = c.scenarios.map((x) => ({ ...x }))
  if (c.status === 'skipped-untrusted') out.trust = c.trust === 'changed' ? 'changed' : 'untrusted'
  return out
}

/**
 * The results of the latest verify round done before `step`'s prompt (`{{verify}}`), or [] when none ran: verify:1's,
 * or for a later Fix until green round (and its re-check) the last round's verify:2.
 */
export function verifyResultsFor(s: RunState, step: AgentStep): VerifyResultInput[] {
  const round = s.fixLoop?.round ?? 1
  // Explain reads the run's last round: verify:2's when it ran, else verify:1's.
  if (step === 'explain') {
    for (const k of ['verify:2', 'verify:1'] as const) {
      const v = s.steps[k].verify
      if (v?.phase === 'done' && s.steps[k].status === 'done')
        return v.commands.map(verifyResultOf).filter((r): r is VerifyResultInput => r !== undefined)
    }
    return []
  }
  if (step === 'recheck' || (step === 'fix' && round > 1)) {
    const v2 = s.steps['verify:2'].verify
    if (v2?.phase !== 'done' || (step === 'fix' && s.steps['verify:2'].status === 'running')) return []
    return v2.commands.map(verifyResultOf).filter((r): r is VerifyResultInput => r !== undefined)
  }
  if (
    step !== 'review' &&
    step !== 'critic' &&
    step !== 'security' &&
    step !== 'fix' &&
    step !== 'acceptance'
  )
    return []
  const v = s.steps['verify:1'].verify
  if (v?.phase !== 'done') return []
  return v.commands.map(verifyResultOf).filter((r): r is VerifyResultInput => r !== undefined)
}

/** `output verify:<n>`: the round's output file (and its command rows) changed; the renderer reads them again. */
function announceVerifyOutput(tx: Tx, key: VerifyRound): void {
  const version = (tx.s.outputs[key] ?? 0) + 1
  tx.s.outputs[key] = version
  tx.emit({ t: 'output', file: key, version })
}

/** A round in progress: the command now running, one that finished, new output. Not a transition. */
function onVerifyProgress(tx: Tx, e: Extract<EngineEventBody, { t: 'verify-progress' }>): void {
  const r = tx.s.requests[e.req]
  if (r?.kind !== 'verify') return
  const st = tx.s.steps[r.step]
  const v = st.verify
  if (v?.phase !== 'running' || st.attempt !== r.attempt || st.status !== 'running') return
  if (e.done !== undefined) {
    const done = e.done
    const c = v.commands.find((x) => x.name === done.name)
    if (c !== undefined) applyResult(c, done)
  }
  if (e.running !== undefined) {
    const c = v.commands.find((x) => x.name === e.running)
    if (c !== undefined && c.status === 'queued') c.status = 'running'
  }
  announceVerifyOutput(tx, r.step)
}

/** The parser-shaped verify findings as the run keeps them (source verify; ids unique; numbered at the join). */
function verifyFindingsOf(input: readonly FindingInput[], round: number): Finding[] {
  return toFindings(input, 'verify').map((f) => ({ ...f, round }))
}

/** The round's results: environment failures open verifyEnv; otherwise the round is done. */
function onVerifyResult(tx: Tx, e: Extract<EngineEventBody, { t: 'verify-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'verify') return
  const s = tx.s
  const st = s.steps[r.step]
  const v = st.verify
  if (s.stop !== undefined || s.outcome !== undefined) return
  if (v?.phase !== 'running' || st.attempt !== r.attempt || st.status !== 'running') return
  tx.transition = true
  announceVerifyOutput(tx, r.step)
  if (e.failure !== undefined) {
    // A baseline that could not run is no baseline (later failures then count as the run's); never a card.
    if (r.step === 'verify:0') {
      addNotes(tx, [`The baseline check could not run: ${e.failure.message}`])
      v.phase = 'done'
      completeRound(tx, r.step)
      return
    }
    openVerifyEnv(tx, r.step, [], e.failure.message)
    return
  }
  for (const res of e.results) {
    const c = v.commands.find((x) => x.name === res.name)
    if (c !== undefined) applyResult(c, res)
    else {
      const added: VerifyCommandState = {
        name: res.name,
        argv: [...res.argv],
        cwdRel: '.',
        body: null,
        trust: 'trusted',
        decision: 'run',
        status: 'queued',
      }
      applyResult(added, res)
      v.commands.push(added)
    }
  }
  if (e.aborted === true) v.aborted = true
  else delete v.aborted
  // The baseline's results are a map (verify/baseline.json), never findings; an environment failure there is
  // recorded as `env` (step 5, isolation.verifyReady, asks about the environment).
  if (r.step === 'verify:0') {
    completeRound(tx, r.step)
    return
  }
  v.findings = verifyFindingsOf(e.findings, r.step === 'verify:2' ? 2 : 1)
  const env = v.commands.filter((c) => c.status === 'env')
  // Commands skipped on the isolated copy's readiness card are not asked about again.
  if (readySkippedAll(s, env)) {
    const names = env.map((c) => c.name)
    tx.note(
      `${stepLabel(r.step)} went on without ${names.join(', ')}: ${names.length === 1 ? 'it cannot' : 'they cannot'} run in the isolated copy (Skip verify before Implement), so ${names.length === 1 ? 'it is' : 'they are'} not a finding.`,
    )
    completeRound(tx, r.step)
    return
  }
  if (env.length > 0) {
    openVerifyEnv(tx, r.step, env)
    return
  }
  completeRound(tx, r.step)
}

/** Environment failures are never findings; they open verifyEnv [Retry] [Skip verify]. */
function openVerifyEnv(
  tx: Tx,
  key: Exclude<VerifyRound, 'verify:0'>,
  env: readonly VerifyCommandState[],
  failure?: string,
): void {
  const st = tx.s.steps[key]
  const v = st.verify
  if (v === undefined) return
  v.phase = 'env'
  const id = nextCardId(tx, 'verifyEnv')
  v.envCardId = id
  setStatus(tx, st, 'waiting', { reason: VERIFY_WAIT_REASON.env })
  const commands = env.map((c): VerifyEnvCommand => {
    const out: VerifyEnvCommand = { name: c.name, argv: [...c.argv], exitCode: c.exitCode ?? null }
    if (c.reason !== undefined) out.reason = c.reason
    if (c.excerpt !== undefined) out.excerpt = c.excerpt
    return out
  })
  openCard(tx, verifyEnvCard(id, { step: key, commands, ...(failure !== undefined ? { failure } : {}) }), key)
}

/** verifyEnv: [Retry] reruns the round from its trust check; [Skip verify] goes on without what could not run. */
function chooseVerifyEnv(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  resolveCard(tx, c.view.id, choiceId)
  const key = verifyEnvStepOf(c.view)
  if (key === undefined || s.stop !== undefined || s.outcome !== undefined) return
  // The isolated run's readiness check before Implement (step 5).
  if (key === 'prepare') {
    chooseReadyEnv(tx, c.view.id, choiceId)
    return
  }
  const v = s.steps[key].verify
  if (v?.phase !== 'env' || v.envCardId !== c.view.id) return
  delete v.envCardId
  if (choiceId === VERIFY_ENV_CHOICE.retry) {
    startVerify(tx, key)
    return
  }
  const env = v.commands.filter((x) => x.status === 'env').map((x) => x.name)
  tx.note(
    env.length > 0
      ? `${stepLabel(key)} went on without ${env.join(', ')}: ${env.length === 1 ? 'it' : 'they'} could not run here, so ${env.length === 1 ? 'it is' : 'they are'} not a finding.`
      : `${stepLabel(key)} was skipped: it could not run.`,
  )
  completeRound(tx, key)
}

/** The ids of `extra` made unique against `list` (`-2`, `-3`…). */
function uniqueIds(list: readonly Finding[], extra: readonly Finding[]): Finding[] {
  const seen = new Set(list.map((f) => f.id))
  return extra.map((f) => {
    let id = f.id
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`
    seen.add(id)
    return { ...f, id }
  })
}

/**
 * The round is over: its findings become the latest verify's (verify:1's join the reviewers' at R8; verify:2's are
 * listed after Fix, not sent to it). A round where nothing ran reads skipped.
 */
function completeRound(tx: Tx, key: VerifyRound): void {
  const s = tx.s
  const st = s.steps[key]
  const v = st.verify
  if (v === undefined) return
  for (const c of v.commands) {
    if (c.status !== 'queued' && c.status !== 'running') continue
    c.status = 'skipped'
    c.reason ??= v.commands.some((x) => x.status === 'pass' || x.status === 'fail')
      ? VERIFY_REASON.notRun
      : VERIFY_REASON.couldNotRun
  }
  v.phase = 'done'
  if (key === 'verify:0') {
    completeBaseline(tx)
    return
  }
  if (key === 'verify:red') {
    // Test-first: failing commands are expected here (the new tests are red), never findings.
    const ran = v.commands.some((c) => c.status === 'pass' || c.status === 'fail')
    if (ran) setStatus(tx, st, 'done')
    else
      setStatus(tx, st, 'skipped', {
        reason: v.commands.length === 0 ? 'no commands to run' : 'no command ran',
      })
    afterRedRound(tx)
    return
  }
  const findings = v.findings ?? []
  const fs = ensureFindings(s)
  fs.verify = { step: key, findings: findings.map((f) => ({ ...f, flags: [...f.flags] })) }
  if (key === 'verify:2') {
    // After Fix: listed (counts, findings.json, Re-run from Fix) but not part of Fix's selection; findings.json's
    // verify source is the latest round's. Fix until green: a command that still fails keeps the finding an earlier
    // round listed for it.
    const loop = s.fixLoop
    const known = loop?.verifyN ?? {}
    const fresh = findings.filter((f) => known[f.id] === undefined)
    const start = fs.list.reduce((m, f) => Math.max(m, f.n), 0)
    const added = uniqueIds(fs.list, fresh).map((f, i) => ({ ...f, n: start + i + 1 }))
    if (loop !== undefined) {
      loop.verifyN = { ...known }
      fresh.forEach((f, i) => {
        const a = added[i]
        if (a !== undefined && loop.verifyN !== undefined) loop.verifyN[f.id] = a.n
      })
    }
    fs.list = [...fs.list, ...added]
    writeFindingsFile(tx)
  }
  const ran = v.commands.some((c) => c.status === 'pass' || c.status === 'fail')
  if (ran) setStatus(tx, st, 'done')
  else
    setStatus(tx, st, 'skipped', {
      reason: v.commands.length === 0 ? 'no commands to run' : 'no command ran',
    })
}

// ---- step status ---------------------------------------------------------------------------------------------

interface StatusOpts {
  reason?: string
  pause?: PauseReason
  force?: boolean
}

/**
 * A new user-visible attempt (P16 / P21, a retry or a re-plan): its active time counts from now, so a retried step's
 * estimate sample and live ETA are the final attempt's alone. Fallbacks and resumes keep the attempt.
 */
function nextAttempt(tx: Tx, st: StepState): void {
  st.attempt += 1
  st.attemptActiveFrom = activeMsAt(st, tx.at)
}

function setStatus(tx: Tx, st: StepState, status: PassStatus, o: StatusOpts = {}): void {
  const prev = { status: st.status, reason: st.reason, pause: st.pause }
  const wasActive = st.status === 'running' || st.status === 'stalled'
  const nowActive = status === 'running' || status === 'stalled'
  if (wasActive && !nowActive && st.activeSince !== undefined) {
    st.activeMs += Math.max(0, tx.at - st.activeSince)
    delete st.activeSince
  }
  if (!wasActive && nowActive) st.activeSince = tx.at
  st.status = status
  if (o.reason !== undefined) st.reason = o.reason
  else delete st.reason
  if (o.pause !== undefined) st.pause = o.pause
  else delete st.pause
  if (status === 'running' && st.startedAt === undefined) st.startedAt = tx.at
  if (isTerminalPassStatus(status) || status === 'failed') st.endedAt = tx.at
  else delete st.endedAt
  if (o.force || prev.status !== status || prev.reason !== st.reason || prev.pause !== st.pause) {
    emitStepStatus(tx, st)
  }
}

function emitStepStatus(tx: Tx, st: StepState, extra: { route?: string; argv?: string[] } = {}): void {
  const body: RunEventBody = { t: 'step-status', step: st.key, attempt: st.attempt, status: st.status }
  if (st.reason !== undefined) body.reason = st.reason
  if (st.pause !== undefined) body.pause = st.pause
  if (st.sessionNote !== undefined) body.sessionNote = st.sessionNote
  if (st.sessionNote !== undefined && st.freshDetail !== undefined) body.freshDetail = st.freshDetail
  if (st.planMode !== undefined && st.key === 'plan') body.planMode = st.planMode
  if (st.planFallbackReason !== undefined) body.planFallbackReason = st.planFallbackReason
  if (st.modelUsed !== undefined) body.modelUsed = st.modelUsed
  if (st.modelReplaced !== undefined) body.modelReplaced = st.modelReplaced
  if (st.modelAsked !== undefined) body.modelAsked = st.modelAsked
  if (st.modelRerouted !== undefined) body.modelRerouted = st.modelRerouted
  if (extra.route !== undefined) body.route = extra.route
  if (extra.argv !== undefined) body.argv = extra.argv
  tx.emit(body)
  tx.transition = true
}

function refreshRunFailure(tx: Tx): void {
  const s = tx.s
  if (s.outcome === 'failed') return
  const failed = STEP_KEYS.find((k) => s.steps[k].status === 'failed')
  if (failed === undefined) delete s.failure
  else {
    const f = s.steps[failed].failure
    s.failure = { step: failed, category: f?.category ?? 'unknown' }
  }
}

function liveCountOff(tx: Tx): void {
  if (!tx.s.liveCount) return
  tx.s.liveCount = false
  tx.push({ t: 'liveCount', on: false })
}

function armKill(tx: Tx, key: AgentStep, spawnNo: number, after = KILL_GRACE_MS): void {
  const id = timerId.kill(key, spawnNo)
  if (tx.s.timers[id] === undefined) tx.armTimer(id, tx.at + after)
}

/** Arm, move earlier, or clear the stall/hard timers. Later deadlines are re-armed lazily when the timer fires. */
function syncTimers(tx: Tx, key: StepKey, force = false): void {
  const s = tx.s
  const st = s.steps[key]
  const want = inactivityTimersWanted(st, s.suspendedAt !== undefined)
  const t = s.config.timeouts
  const sync = (id: string, desired: number | undefined): void => {
    if (desired === undefined) {
      tx.clearTimer(id)
      return
    }
    const cur = s.timers[id]
    if (force || cur === undefined || desired < cur) tx.armTimer(id, desired)
  }
  sync(timerId.stall(key), want.stall ? stallDeadline(st, t) : undefined)
  sync(timerId.hard(key), want.hard ? hardDeadline(st, t) : undefined)
}

function clearStepTimers(tx: Tx, key: AgentStep): void {
  const st = tx.s.steps[key]
  tx.clearTimer(timerId.stall(key))
  tx.clearTimer(timerId.hard(key))
  tx.clearTimer(timerId.launch(key))
  clearWait(tx, key)
  for (const a of st.asks) {
    tx.clearTimer(timerId.ask(key, a.requestId))
    tx.clearTimer(timerId.deny(key, a.requestId))
  }
}

// ---- cards ---------------------------------------------------------------------------------------------------

function nextCardId(tx: Tx, kind: CardKind): string {
  tx.s.counters.card += 1
  return cardId(kind, tx.s.counters.card)
}

function openCard(tx: Tx, view: CardView, step?: StepKey): void {
  const c: CardState = { view, openedAt: tx.at }
  if (step !== undefined) c.step = step
  tx.s.cards.push(c)
  tx.emit({ t: 'card', card: view, state: 'open' })
  tx.transition = true
  const auto = tx.s.config.auto && view.defaultChoice !== undefined
  if (auto) tx.autoQueue.push(view.id)
  else if (view.kind === 'gate:afterPlan' || view.kind === 'gate:beforeFix') {
    tx.push({ t: 'notify', kind: 'gate', cardId: view.id })
  } else if (view.blocking && (tx.s.endedAt === undefined || view.kind === 'interruptedApply')) {
    // An ended run's card (the conflicts of an apply asked for from its Diff tab) is no Needs-you notification; an
    // apply a crash stopped part way still is (the folder may be part written).
    tx.push(
      step !== undefined
        ? { t: 'notify', kind: 'card', cardId: view.id, step }
        : { t: 'notify', kind: 'card', cardId: view.id },
    )
  }
}

function resolveCard(tx: Tx, id: string, choiceId?: string): CardState | undefined {
  const i = tx.s.cards.findIndex((c) => c.view.id === id)
  if (i < 0) return undefined
  const [c] = tx.s.cards.splice(i, 1)
  if (c === undefined) return undefined
  const body: RunEventBody = { t: 'card', card: c.view, state: 'resolved' }
  if (choiceId !== undefined) body.choiceId = choiceId
  tx.emit(body)
  tx.transition = true
  return c
}

function resolveStepCards(tx: Tx, key: StepKey, kind: CardKind, choiceId?: string): void {
  for (const c of [...tx.s.cards]) {
    if (c.step === key && c.view.kind === kind) resolveCard(tx, c.view.id, choiceId)
  }
}

function openSnag(tx: Tx, key: StepKey, failure: Failure): void {
  const s = tx.s
  const st = s.steps[key]
  st.snagOpen = CATEGORY_INFO[failure.category].snag
  const hints = Array.isArray(st.meta['failureHints'])
    ? (st.meta['failureHints'] as unknown[]).filter((h): h is string => typeof h === 'string')
    : []
  const actions = tx.ctx.recoveryActions(key, failure, {
    hasSession: st.sessionId !== undefined,
    hints,
    at: tx.at,
  })
  // A new failure: the previous diagnosis and wait belonged to the last one.
  delete st.heal
  if (isAgentStep(key)) clearWait(tx, key)
  if (st.snagOpen) tx.emit({ t: 'snag', step: key, failure, actions })
  if (st.snagOpen && isAgentStep(key)) offerWait(tx, key, actions)
  s.failure = { step: key, category: failure.category }
  tx.push({ t: 'notify', kind: 'failed', step: key })
}

// ---- requests ------------------------------------------------------------------------------------------------

function requestSnapshot(
  tx: Tx,
  label: SnapshotLabel,
  purpose: SnapshotPurpose,
  step?: StepKey,
  diffFrom?: string,
): string {
  const r: PendingRequest =
    step !== undefined ? { kind: 'snapshot', label, purpose, step } : { kind: 'snapshot', label, purpose }
  const req = tx.request(r)
  tx.push({
    t: 'snapshot',
    req,
    label,
    ...(step !== undefined ? { step } : {}),
    ...(diffFrom !== undefined ? { diffFrom } : {}),
  })
  return req
}

/**
 * Reconcile at a boundary. `awaitEnd`: P15's check, whose `last` is the end snapshot taken alongside; `hold`: the
 * run waits for the answer (a recheck the user chose after an end-of-pass card).
 */
function requestReconcile(
  tx: Tx,
  boundary: ReconcileBoundary,
  step?: StepKey,
  o: { awaitEnd?: boolean; hold?: boolean } = {},
): string {
  const r: PendingRequest = {
    kind: 'reconcile',
    boundary,
    ...(step !== undefined ? { step } : {}),
    ...(o.hold === true ? { hold: true } : {}),
  }
  const req = tx.request(r)
  const input = reconcileInput(tx.s, boundary, step, o.awaitEnd === true)
  tx.push({ t: 'reconcile', req, boundary, ...(step !== undefined ? { step } : {}), input })
  return req
}

/** The run's last snapshot at a reconcile boundary (external edits are the folder now against it). */
function lastSnapshotAt(s: RunState, boundary: ReconcileBoundary, step?: StepKey): SnapshotRef | undefined {
  const s1 = s.steps.implement.endSnap ?? s.snapshots.S1
  switch (boundary) {
    case 'pre-implement':
      // Test-first: Implement starts from where the Tests step and its red check left the folder.
      if (step === 'implement' && testFirstOn(s)) {
        const after = s.snapshots['post-red'] ?? s.steps.tests.endSnap ?? s.snapshots.T1
        if (after !== undefined) return after
      }
      return s.snapshots['plan-end'] ?? s.snapshots['run-start']
    // R7: what the verify commands wrote is in post-verify-1 (noted there), not an external edit.
    case 'pre-review':
      return s.snapshots['post-verify-1'] ?? s1
    case 'pre-fix':
      // Fix until green, rounds ≥ 2: the folder as the last round's checks left it.
      if ((s.fixLoop?.round ?? 1) > 1) {
        const after = s.snapshots['post-round'] ?? s.snapshots.S2
        if (after !== undefined) return after
      }
      // Re-run from Fix: the source run's last result snapshot, the folder as that run left it.
      return s.rerunOf?.base ?? s.snapshots['post-review'] ?? s.snapshots['post-verify-1'] ?? s1
    case 'end-of-pass':
      return step !== undefined ? s.steps[step].endSnap : undefined
    case 'pre-apply':
      return s.steps.fix.endSnap ?? s.snapshots.S2 ?? s.snapshots['post-review'] ?? s1
  }
}

/** What the controller needs to gather a boundary's reconcile facts (types.ts ReconcileInput). */
export function reconcileInput(
  s: RunState,
  boundary: ReconcileBoundary,
  step?: StepKey,
  awaitEnd = false,
): ReconcileInput {
  const input: ReconcileInput = { branchMode: s.config.branch }
  if (s.branch !== undefined) input.runBranch = { ...s.branch }
  const head = s.git?.expectedHead
  if (head !== undefined) input.expectedHead = { ...head }
  const own = s.git?.ownPaths ?? []
  if (own.length > 0) input.ownPaths = [...own]
  if (awaitEnd) input.awaitEnd = true
  else {
    const last = lastSnapshotAt(s, boundary, step)
    if (last !== undefined) input.last = last.commit
  }
  // The run's own changes: from its base (Test-first: T0), so Implement's pre-implement check knows the tests are
  // the run's, not external edits.
  const base = runBaseSnap(s)
  const ownSoFar =
    boundary !== 'pre-implement' || (step === 'implement' && s.steps.tests.startSnap !== undefined)
  if (ownSoFar && base !== undefined) input.runStart = base.commit
  if (boundary === 'end-of-pass' && step !== undefined) {
    const start = s.steps[step].startSnap
    if (start !== undefined) input.deletionBase = start.commit
  }
  return input
}

function hasRequest(tx: Tx, pred: (r: PendingRequest) => boolean): boolean {
  return Object.values(tx.s.requests).some(pred)
}

// ---- R1 / R2 / R2b ---------------------------------------------------------------------------------------------

function onCreated(tx: Tx): void {
  const s = tx.s
  if (s.started) return
  s.started = true
  s.lock = 'requested'
  tx.emit({ t: 'run-status', status: 'queued', phase: 'queued' })
  if (s.rerunOf?.from === 'fix') announceCarried(tx)
  tx.push({ t: 'index' })
  tx.push({ t: 'lock' })
  tx.transition = true
}

/**
 * Re-run from Fix (R14): the steps carried from the source run (skipped "carried from run #N") reach
 * the log with the run's start, and findings.json is written with the findings Fix gets.
 */
function announceCarried(tx: Tx): void {
  for (const k of STEP_KEYS) {
    const st = tx.s.steps[k]
    if (st.status !== 'queued') emitStepStatus(tx, st)
  }
  writeFindingsFile(tx)
}

function onLockAcquired(tx: Tx): void {
  const s = tx.s
  if (s.lock !== 'requested') {
    // A grant that crossed our `unlock` (Stop while queued, R2b): hand it straight back. No process can be alive.
    if (s.lock === 'none' && !anyLiveProc(s)) tx.push({ t: 'unlock' })
    return
  }
  s.lock = 'held'
  tx.transition = true
  if (s.stop !== undefined) return
  const pf = s.steps.preflight
  if (pf.status === 'queued' || pf.status === 'running') startPreflight(tx)
}

function startPreflight(tx: Tx): void {
  const pf = tx.s.steps.preflight
  if (pf.status !== 'running') {
    nextAttempt(tx, pf)
    setStatus(tx, pf, 'running')
  }
  if (hasRequest(tx, (r) => r.kind === 'preflight' && r.mode === 'authoritative')) return
  const req = tx.request({ kind: 'preflight', mode: 'authoritative' })
  tx.push({ t: 'preflight', req, mode: 'authoritative' })
}

/**
 * R2b Recheck (or Resume) without the folder lock: the preflight step waits `queued` until the scheduler grants
 * the lock (`lock-acquired` → startPreflight), so the run reads queued and the CLI can say what it queues behind.
 */
function requeuePreflight(tx: Tx): void {
  const s = tx.s
  setStatus(tx, s.steps.preflight, 'queued')
  if (s.lock === 'none') {
    s.lock = 'requested'
    tx.push({ t: 'lock' })
  }
}

function onPreflightResult(tx: Tx, req: string, report: PreflightReport): void {
  const r = tx.take(req)
  if (r === undefined || r.kind !== 'preflight') return
  const s = tx.s
  if (r.mode === 'passBoundary') {
    const st = s.steps[r.step]
    const L = st.launch
    if (L === undefined || L.req !== req) return
    delete L.req
    if (report.ok) {
      L.preflight = 'done'
      pump(tx, r.step)
      return
    }
    const first = report.blocking[0]
    const failure: Failure = {
      category: first?.category ?? 'capability_missing',
      message: first?.title ?? 'A pass check failed.',
      raw: first?.detail ?? '',
      classifiedBy: 'app',
      step: r.step,
    }
    // passBoundary preflight: the pass fails with that category; nothing is spawned.
    failPass(tx, r.step, failure, { noRetry: true })
    return
  }
  const pf = s.steps.preflight
  if (pf.status !== 'running' || s.stop !== undefined) return
  if (report.ok) {
    setStatus(tx, pf, 'done')
    afterPreflight(tx)
    return
  }
  // R2b: failed(first blocker) + preflight card; the lock is released while failed, no snapshot.
  const first = report.blocking[0]
  const failure: Failure = {
    category: first?.category ?? 'unknown',
    message: first?.title ?? 'Preflight blocked the run.',
    raw: first?.detail ?? '',
    classifiedBy: 'app',
    step: 'preflight',
  }
  pf.failure = failure
  setStatus(tx, pf, 'failed', { reason: failure.category })
  s.failure = { step: 'preflight', category: failure.category }
  openCard(tx, preflightCard(nextCardId(tx, 'preflight'), report), 'preflight')
  if (s.lock === 'held') {
    s.lock = 'none'
    tx.push({ t: 'unlock' })
  }
}

/** R2 after a passing preflight: in place → prepare is skipped; isolated → prepare steps 1–2 first. */
function afterPreflight(tx: Tx): void {
  const s = tx.s
  delete s.failure
  const prep = s.steps.prepare
  const v0 = s.steps['verify:0']
  if (s.config.isolation === 'inPlace') {
    setStatus(tx, prep, 'skipped', { reason: SKIP_REASON.inPlace })
    setStatus(tx, v0, 'skipped', { reason: SKIP_REASON.inPlace })
    s.flow.prepared = 'all'
    return
  }
  const v0Skip = skipReason(tx, 'verify:0')
  if (v0Skip !== undefined) setStatus(tx, v0, 'skipped', { reason: v0Skip })
  if (!tx.ctx.buildSteps.includes('prepare')) {
    prep.attempt = 1
    failRunner(tx, 'prepare', {
      category: 'capability_missing',
      message: 'Isolated runs are not in this build.',
      raw: '',
      classifiedBy: 'app',
      step: 'prepare',
    })
    return
  }
  if (prep.attempt === 0) prep.attempt = 1
  setStatus(tx, prep, 'running')
  // R2 isolated: steps 1 and 2 first; run-start (in the worktree), Plan and the rest of prepare follow them.
  setRow(tx, 'worktree', 'running', makingCopyDetail(tx.s))
  requestPrepare(tx, 'setup')
}

function requestPrepare(
  tx: Tx,
  stage: PrepareStage,
  o: { command?: string; deps?: DepsCommandState } = {},
): void {
  const req = tx.request({ kind: 'prepare', stage })
  tx.push({
    t: 'prepare',
    req,
    stage,
    ...(o.command !== undefined ? { command: o.command } : {}),
    ...(o.deps !== undefined ? { deps: structuredClone(o.deps) } : {}),
  })
}

function onPrepareResult(tx: Tx, e: Extract<EngineEventBody, { t: 'prepare-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'prepare') return
  const s = tx.s
  // A worktree made while the run was being stopped is still the run's: it is never deleted on its own, so
  // the run must know it (the Dashboard's "Isolated: not applied", Apply and Discard).
  if (r.stage === 'setup' && e.worktree !== undefined && s.isolation?.worktree === undefined) {
    iso(s).worktree = { ...e.worktree }
    tx.transition = true
  }
  const prep = s.steps.prepare
  if (prep.status !== 'running' || s.stop !== undefined) return
  switch (r.stage) {
    case 'setup':
      onSetupResult(tx, e)
      return
    case 'rest':
      onDepsDecision(tx, e)
      return
    case 'install':
      onInstallResult(tx, e)
      return
    case 'ready':
      onReadyResult(tx, e)
      return
  }
}

function failRunner(tx: Tx, key: 'prepare' | 'preflight', failure: Failure): void {
  const st = tx.s.steps[key]
  const f: Failure = failure.step === undefined ? { ...failure, step: key } : failure
  st.failure = f
  setStatus(tx, st, 'failed', { reason: f.category })
  openSnag(tx, key, f)
}

// ---- snapshots / reconcile -------------------------------------------------------------------------------------

/**
 * The end snapshot's `diffFrom`: the pass's start, while a card revert's Undo is still offered, so the paths the
 * pass changed can retire it (markStaleReverts). Otherwise none (no extra diff).
 */
function staleCheckFrom(s: RunState, st: StepState): string | undefined {
  if (st.startSnap === undefined) return undefined
  const live = (s.git?.reverts ?? []).some((r) => isCardRevert(r) && r.undone !== true && r.stale !== true)
  return live ? st.startSnap.commit : undefined
}

/** Snapshots that start a new reconcile baseline: Dim Factory's own writes before them are part of them. */
const BASELINE_PURPOSES: readonly SnapshotPurpose[] = [
  'run-start',
  'start',
  'end',
  'post-review',
  'plan-end',
  'post-verify-1',
  'post-red',
  'post-round',
]

function gitState(s: RunState): RunGitState {
  s.git ??= {}
  return s.git
}

function onSnapshotResult(
  tx: Tx,
  req: string,
  ok: { commit: string; tree: string; nested?: string; head?: GitHead; changed?: string[] } | undefined,
  failure: Failure | undefined,
): void {
  const r = tx.take(req)
  if (r === undefined || r.kind !== 'snapshot') return
  const s = tx.s
  const ref: SnapshotRef | undefined = ok
    ? {
        label: r.label,
        commit: ok.commit,
        tree: ok.tree,
        at: tx.at,
        ...(ok.nested !== undefined ? { nested: ok.nested } : {}),
      }
    : undefined
  if (ref) s.snapshots[r.label] = ref
  if (ref && BASELINE_PURPOSES.includes(r.purpose) && s.git?.ownPaths !== undefined) delete s.git.ownPaths
  const why = failure?.message ?? 'unknown error'
  switch (r.purpose) {
    case 'run-start':
      s.flow.runStart = ref ? 'done' : 'failed'
      if (!ref) tx.note(`The run-start snapshot failed: ${why}`)
      // Where HEAD is at the run's start is where reconcile expects it (until branch prep or a Continue).
      if (ok?.head !== undefined && s.git?.expectedHead === undefined)
        gitState(s).expectedHead = { ...ok.head }
      // R2: Plan's launch waits for this answer before it spawns (and Clarify's, before it).
      if (s.steps.plan.launch !== undefined) pump(tx, 'plan')
      if (s.steps.clarify.launch !== undefined) pump(tx, 'clarify')
      if (s.steps.research.launch !== undefined) pump(tx, 'research')
      return
    case 'plan-end':
      onPlanEndSnapshot(tx, ref, ok?.changed ?? [], why)
      return
    case 'start': {
      if (r.step === undefined || !isAgentStep(r.step)) return
      const key = r.step
      const st = s.steps[key]
      const L = st.launch
      if (L === undefined || L.req !== req) return
      delete L.req
      if (ref) {
        st.startSnap = ref
        // Fix until green: round 1's start is where the Fix diff segment starts (it spans every round).
        const loop = s.fixLoop
        if (key === 'fix' && loop !== undefined && loop.round === 1 && loop.firstStart === undefined)
          loop.firstStart = ref
        pump(tx, key)
        return
      }
      // Hard rule: a mutating pass never spawns without its start snapshot.
      failPass(tx, key, {
        category: failure?.category ?? 'snapshot_failed',
        message: failure?.message ?? 'The start snapshot failed.',
        raw: failure?.raw ?? '',
        classifiedBy: failure?.classifiedBy ?? 'app',
        step: key,
      })
      return
    }
    case 'end': {
      if (r.step === undefined) return
      const st = s.steps[r.step]
      if (ref) {
        st.endSnap = ref
        st.endSnapStatus = 'done'
        if (ok?.changed !== undefined) markStaleReverts(s, ok.changed)
        // Test-first: the files the Tests step changed (T0..T1) are the tests Implement must keep.
        if (r.step === 'tests') {
          const t = tf(s)
          t.files = [...(ok?.changed ?? [])]
          delete t.guard
          delete t.findings
          announceTests(tx)
        }
        // The Deploy step: the files it changed (deploy-start..deploy-end), for its card and the Run view's Deploy panel.
        if (r.step === 'deploy' && s.deploy !== undefined) {
          s.deploy.written = [...(ok?.changed ?? [])]
          announceDeploy(tx)
        }
      } else {
        st.endSnapStatus = 'failed'
        tx.note(`The ${r.label} snapshot failed: ${why}`)
      }
      return
    }
    case 'pre-retry':
    case 'resume': {
      if (r.step === undefined || !isAgentStep(r.step)) return
      const key = r.step
      const L = s.steps[key].launch
      if (L === undefined || L.req !== req) return
      delete L.req
      if (L.preSnapshot) {
        L.preSnapshot.done = true
        if (ref) L.preSnapshot.tree = ref.tree
        if (ref && L.preSnapshot.attemptEnd === true) s.steps[key].attemptEnd = ref
      }
      if (!ref) tx.note(`The ${r.label} snapshot failed: ${why}`)
      pump(tx, key)
      return
    }
    case 'recovery':
      if (r.label === 'stopped' && s.stop?.snapshot === 'requested') s.stop.snapshot = 'done'
      if (!ref) tx.note(`The ${r.label} snapshot failed: ${why}`)
      // A mutating pass's recovery snapshot is where its attempt ended (revert-then-fresh's scope); a retry
      // waiting for it goes on.
      if (r.step !== undefined && isAgentStep(r.step) && isMutatingStep(r.step)) {
        if (ref) s.steps[r.step].attemptEnd = ref
        if (s.steps[r.step].launch !== undefined) pump(tx, r.step)
      }
      return
    case 'post-verify-1': {
      // R7: should equal S1; verify commands that wrote files (build output, caches) are kept, with a note.
      if (s.flow.postVerify1 !== 'requested') return
      const s1 = s.steps.implement.endSnap ?? s.snapshots.S1
      if (!ref) tx.note(`The post-verify-1 snapshot failed: ${why}`)
      else if (s1 !== undefined && !sameSnap(ref, s1)) {
        tx.note('Files changed while the verify commands ran; the changes are kept.')
      }
      s.flow.postVerify1 = 'done'
      delete s.boundary
      tx.transition = true
      return
    }
    case 'post-red': {
      // Test-first: should equal T1; what the checks wrote (caches, build output) is kept, with a note.
      if (s.flow.postRed !== 'requested') return
      const t1 = s.steps.tests.endSnap ?? s.snapshots.T1
      if (!ref) tx.note(`The post-red snapshot failed: ${why}`)
      else if (t1 !== undefined && !sameSnap(ref, t1)) {
        tx.note('Files changed while the red check ran; the changes are kept.')
      }
      s.flow.postRed = 'done'
      if (s.boundary?.name === 'post-red') delete s.boundary
      tx.transition = true
      return
    }
    case 'post-round': {
      // Fix until green: the folder after a round's checks; the next round starts from it.
      const loop = s.fixLoop
      if (loop?.postRound !== 'requested') return
      if (!ref) tx.note(`The post-round snapshot failed: ${why}`)
      delete loop.postRound
      if (s.boundary?.name === 'post-round') delete s.boundary
      tx.transition = true
      if (s.stop === undefined && s.outcome === undefined) beginRound(tx)
      return
    }
    case 'post-review': {
      // R8: should equal S1 (read-only passes; post-verify-1 when verify:1 ran); a difference is kept (it reaches
      // Fix's diff) with a warning.
      if (s.flow.review !== 'post-review') return
      const s1 = s.snapshots['post-verify-1'] ?? s.steps.implement.endSnap ?? s.snapshots.S1
      if (!ref) tx.note(`The post-review snapshot failed: ${why}`)
      else if (s1 !== undefined && !sameSnap(ref, s1)) {
        tx.note(
          'Files changed while Review/Critic ran (they should not change anything); the changes are kept.',
        )
      }
      s.flow.review = 'joined'
      delete s.boundary
      tx.transition = true
      return
    }
  }
}

function addNotes(tx: Tx, notes: readonly string[]): void {
  for (const n of notes) if (!tx.s.notes.includes(n)) tx.note(n)
}

/** The Fix prompt's `Notes:` list (the template rendering rules): "User edited outside the run: …", reverts. */
function addFixNotes(s: RunState, notes: readonly string[]): void {
  if (notes.length === 0) return
  const fs = ensureFindings(s)
  for (const n of notes) if (!fs.notes.includes(n)) fs.notes.push(n)
}

const promptNotesOf = (res: Extract<ReconcileResult, { verdict: 'info' }>): string[] =>
  res.promptNotes ?? res.notes

/** HEAD as a verdict observed it. A commit move on the expected ref is accepted (diffs compare trees). */
function acceptHead(tx: Tx, head: GitHead | undefined): void {
  if (head === undefined) return
  const g = gitState(tx.s)
  const exp = g.expectedHead
  if (exp !== undefined && exp.ref !== head.ref) return
  if (exp?.commit === head.commit && exp.ref === head.ref) return
  g.expectedHead = { ...head }
}

/** A HEAD as UI copy (git/branch.ts headLabel): the branch, or "detached HEAD at abc1234". */
function headText(head: GitHead): string {
  if (head.ref !== null) return head.ref.startsWith('refs/heads/') ? head.ref.slice(11) : head.ref
  return head.commit === null ? 'detached HEAD' : `detached HEAD at ${head.commit.slice(0, 7)}`
}

/** Open a reconcile card; returns its id. */
function openReconcileCard(
  tx: Tx,
  boundary: ReconcileBoundary,
  step: StepKey | undefined,
  input: ReconcileCardInput,
  head: GitHead | undefined,
  branchPrep = false,
): string {
  const id = nextCardId(tx, 'reconcile')
  const view = reconcileCard(id, {
    boundary,
    input,
    ...(step !== undefined ? { step } : {}),
    ...(head !== undefined ? { head } : {}),
    ...(branchPrep ? { branchPrep: true } : {}),
  })
  openCard(tx, view, step)
  return id
}

/** The reason a step reads while its launch waits on a reconcile card (PassCard and timeline: "Waiting · …"). */
export const RECONCILE_WAIT_REASON = 'folder check'

/**
 * A launch parked on its reconcile card (R5, R10, branch prep): the step waits on the user, as it does on the other
 * cards a step waits on (insufficientContext, emptyFindings), so it does not read `running` nor count active time.
 */
function waitOnReconcile(tx: Tx, st: StepState): void {
  if (st.status === 'running') setStatus(tx, st, 'waiting', { reason: RECONCILE_WAIT_REASON })
}

/** The card was answered: the launch goes on (it reads `running` again while Dim Factory works towards the spawn). */
function doneWaitingOnReconcile(tx: Tx, st: StepState): void {
  if (st.status === 'waiting' && st.reason === RECONCILE_WAIT_REASON && st.asks.length === 0)
    setStatus(tx, st, 'running')
}

function openReconcileFor(s: RunState, boundary: ReconcileBoundary, step?: StepKey): boolean {
  return s.cards.some((c) => {
    const p = reconcilePayloadOf(c.view)
    return p !== undefined && p.boundary === boundary && (step === undefined || p.step === step)
  })
}

/**
 * reconcile(pre-implement / pre-review / pre-fix / end-of-pass) answered: `clean` / `info` let the
 * boundary go on (notes; pre-fix's are the Fix prompt's; pre-implement's chip goes on Implement); `choice` / `block`
 * open a reconcile card the boundary waits on. The first end-of-pass check holds the run only when it opens a card.
 */
/**
 * Guardrails fired. Each finding reaches the log and the run's notes; a rule that says stop ends the run as Stop does,
 * keeping what it made. A rule that says ask waits on the end-of-pass card instead (the controller adds it).
 */
function onGuardrailFindings(tx: Tx, e: Extract<EngineEventBody, { t: 'guardrail-findings' }>): void {
  const s = tx.s
  const undone = new Set(e.undone)
  const tally = (s.guardrails ??= { fired: 0, undone: 0, stopped: false })
  for (const finding of e.findings) {
    const put = undone.has(finding.subject)
    tally.fired++
    if (put) tally.undone++
    if (e.blocked === true) tally.blocked = (tally.blocked ?? 0) + 1
    tx.emit({
      t: 'guardrail',
      step: e.step,
      finding,
      undone: put,
      ...(e.blocked === true ? { blocked: true } : {}),
    })
    addNotes(tx, [
      `Guardrail: ${finding.rule}. ${finding.subject}. ${e.blocked === true ? 'Refused before it ran.' : finding.detail}${put ? ' It was put back.' : ''}`,
    ])
    if (e.blocked === true || put) addRefused(tally, refusedNote(finding, e.blocked === true))
  }
  tx.transition = true
  if (
    e.blocked !== true &&
    e.findings.some((f) => f.onBreak === 'stop') &&
    s.stop === undefined &&
    s.outcome === undefined
  ) {
    tally.stopped = true
    stopRun(tx, 'stop')
  }
}

/** At most this many refusals are kept for the prompts; a run that hits more has a bigger problem than its review. */
const REFUSED_KEEP = 20

/** A refusal in the words a reviewer is given. */
export function refusedNote(f: GuardrailFinding, blocked: boolean): string {
  const what = blocked ? `refused ${f.subject}` : `put back a change to ${f.subject}`
  return `Dim Factory's guardrail ${what} (${f.rule}); this was on purpose, so do not report its absence as a finding.`
}

function addRefused(tally: NonNullable<RunState['guardrails']>, line: string): void {
  const list = (tally.refused ??= [])
  if (!list.includes(line) && list.length < REFUSED_KEEP) list.push(line)
}

function onReconcileResult(tx: Tx, e: Extract<EngineEventBody, { t: 'reconcile-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'reconcile') return
  const s = tx.s
  const res = e.result
  acceptHead(tx, res.head)
  if (res.verdict === 'info') addNotes(tx, res.notes)
  const card = res.verdict === 'choice' || res.verdict === 'block' ? res.card : undefined
  switch (r.boundary) {
    case 'pre-review': {
      // R6/R7 → Review ∥ Critic.
      if (s.flow.review !== 'reconcile' || s.stop !== undefined || s.outcome !== undefined) return
      if (card !== undefined) {
        openReconcileCard(tx, 'pre-review', undefined, card, res.head)
        return
      }
      // "User edited outside the run": the edits reach Fix's diff too, so Fix is told about them.
      if (res.verdict === 'info') addFixNotes(s, promptNotesOf(res))
      launchReviewers(tx)
      return
    }
    case 'pre-implement':
    case 'pre-fix': {
      if (r.step === undefined || !isAgentStep(r.step)) return
      const st = s.steps[r.step]
      const L = st.launch
      if (L === undefined || L.req !== e.req) return
      delete L.req
      if (card !== undefined) {
        L.card = openReconcileCard(tx, r.boundary, r.step, card, res.head)
        waitOnReconcile(tx, st)
        return
      }
      L.reconcile = 'done'
      // "External edits, no overlap with the run": the Fix prompt's `Notes:` list (the template rendering rules).
      if (r.boundary === 'pre-fix' && res.verdict === 'info') addFixNotes(s, promptNotesOf(res))
      // "External edits at pre-implement": folded into S0, chip "N files changed during planning" (the latest
      // check's: a redone R5 replaces it).
      if (r.boundary === 'pre-implement') {
        if (res.verdict === 'info' && res.chip !== undefined) st.chip = res.chip
        else delete st.chip
      }
      pump(tx, r.step)
      return
    }
    case 'end-of-pass': {
      if (r.step === undefined || !isMutatingStep(r.step)) return
      const st = s.steps[r.step]
      if (card !== undefined) {
        const movedOn =
          s.stop !== undefined ||
          s.outcome !== undefined ||
          st.status !== 'done' ||
          (r.step === 'implement' && s.flow.review !== undefined)
        // The run went past the pass already: what the check found becomes notes (the next boundary checks again).
        if (movedOn) {
          addNotes(tx, card.reasons.map(reasonLine))
          return
        }
        st.endCheck = 'hold'
        openReconcileCard(tx, 'end-of-pass', r.step, card, res.head)
        return
      }
      if (st.endCheck === 'hold' && !openReconcileFor(s, 'end-of-pass', r.step)) {
        delete st.endCheck
        tx.transition = true
      }
      return
    }
    case 'pre-apply':
      return
  }
}

/** R5: the run branch was made (or not). Implement's launch goes on to S0, or waits on a block card. */
/** R5 write-ahead: the run branch about to be made, persisted before its ref writes. */
function onBranchIntent(tx: Tx, e: Extract<EngineEventBody, { t: 'branch-intent' }>): void {
  const r = tx.s.requests[e.req]
  if (r === undefined || r.kind !== 'branch') return
  tx.s.branchPending = { ...e.branch }
  tx.transition = true
}

function onBranchResult(tx: Tx, e: Extract<EngineEventBody, { t: 'branch-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'branch') return
  const s = tx.s
  tx.transition = true
  // A ref Dim Factory made that is still there stays pending (Recheck adopts it; a stopped run can delete it). An
  // unexpected failure keeps what is pending: the next settle finds out (a missing ref is simply gone).
  if (e.branch !== undefined) delete s.branchPending
  else if (e.leftover !== undefined) s.branchPending = { ...e.leftover }
  else if (e.failure === undefined) delete s.branchPending
  if (e.branch !== undefined) {
    // Recorded even when the run stopped meanwhile: the branch exists, and the run's end offers return / delete.
    s.branch = { ...e.branch }
    gitState(s).expectedHead = { ref: `refs/heads/${e.branch.name}`, commit: e.branch.base }
    addNotes(tx, [`Working on the run branch ${e.branch.name}.`, ...(e.notes ?? [])])
  } else if (e.notes !== undefined) {
    addNotes(tx, e.notes)
  }
  // A relaunch's settle: R5 (if it is waiting) goes on with whatever is known now.
  if (r.settle === true) {
    for (const k of ['tests', 'implement'] as const) if (s.steps[k].launch !== undefined) pump(tx, k)
    return
  }
  // R5's step: Implement, or Test-first's Tests step (the run's first mutating pass).
  const key = (['tests', 'implement'] as const).find((k) => s.steps[k].launch?.req === e.req)
  const L = key !== undefined ? s.steps[key].launch : undefined
  if (key === undefined || L === undefined) return
  delete L.req
  if (e.branch !== undefined) {
    pump(tx, key)
    return
  }
  if (e.blocked !== undefined) {
    L.card = openReconcileCard(tx, 'pre-implement', key, e.blocked, undefined, true)
    waitOnReconcile(tx, s.steps[key])
    return
  }
  failPass(
    tx,
    key,
    {
      category: e.failure?.category ?? 'git_state',
      message: e.failure?.message ?? 'The run branch could not be made.',
      raw: e.failure?.raw ?? '',
      classifiedBy: e.failure?.classifiedBy ?? 'app',
      step: key,
    },
    { noRetry: true },
  )
}

/** Reconcile card choices (the reconcile table): Continue on <branch> · Include my edits · Restore · Stop · Recheck. */
function chooseReconcile(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  const id = c.view.id
  const p = reconcilePayloadOf(c.view)
  resolveCard(tx, id, choiceId)
  if (p === undefined) return
  if (choiceId === RECONCILE_CHOICE.stop) {
    stopRun(tx, 'stop')
    return
  }
  if (choiceId === RECONCILE_CHOICE.continueOnBranch && p.head !== undefined) {
    // The new expected HEAD; the boundary reconciles again (another row may follow).
    gitState(s).expectedHead = { ...p.head }
    addNotes(tx, [`The run continues on ${headText(p.head)}.`])
  }
  const act =
    choiceId === RECONCILE_CHOICE.includeEdits
      ? 'proceed'
      : choiceId === RECONCILE_CHOICE.restoreRun
        ? 'restore'
        : 'recheck'
  reconcileFollowUp(tx, p, id, act)
}

/** What a reconcile card's boundary does after the user's choice: go on, reconcile again, or restore first. */
function reconcileFollowUp(
  tx: Tx,
  p: ReconcileCardPayload,
  cardId: string,
  act: 'proceed' | 'recheck' | 'restore',
): void {
  const s = tx.s
  if (s.stop !== undefined) return
  switch (p.boundary) {
    case 'pre-implement':
    case 'pre-fix': {
      if (p.step === undefined || !isAgentStep(p.step)) return
      const L = s.steps[p.step].launch
      if (L === undefined || L.card !== cardId) return
      delete L.card
      doneWaitingOnReconcile(tx, s.steps[p.step])
      if (act === 'restore') {
        const req = requestRestore(tx, p)
        if (req !== undefined) {
          L.req = req
          return
        }
      }
      if (act === 'proceed') {
        L.reconcile = 'done'
        addNotes(tx, p.notes)
        if (p.boundary === 'pre-fix') addFixNotes(s, p.notes)
      } else L.reconcile = 'todo'
      pump(tx, p.step)
      return
    }
    case 'pre-review': {
      if (s.flow.review !== 'reconcile' || s.outcome !== undefined) return
      if (act === 'restore' && requestRestore(tx, p) !== undefined) return
      if (act === 'proceed') {
        addNotes(tx, p.notes)
        addFixNotes(s, p.notes)
        launchReviewers(tx)
        return
      }
      requestReconcile(tx, 'pre-review')
      return
    }
    case 'end-of-pass': {
      if (p.step === undefined || !isMutatingStep(p.step)) return
      const st = s.steps[p.step]
      if (st.endCheck !== 'hold') return
      if (act === 'restore' && requestRestore(tx, p) !== undefined) return
      if (act === 'proceed') {
        addNotes(tx, p.notes)
        delete st.endCheck
        tx.transition = true
        return
      }
      requestReconcile(tx, 'end-of-pass', p.step, { hold: true })
      return
    }
    case 'pre-apply':
      return
  }
}

/** [Restore run's version]: the overlapping paths back to the boundary's last snapshot (undoable). */
function requestRestore(tx: Tx, p: ReconcileCardPayload): string | undefined {
  const last = lastSnapshotAt(tx.s, p.boundary, p.step)
  if (last === undefined || p.paths.overlapping.length === 0) return undefined
  return requestRevert(tx, {
    why: 'restore',
    to: last.commit,
    paths: p.paths.overlapping,
    boundary: p.boundary,
    ...(p.step !== undefined ? { step: p.step } : {}),
  })
}

// ---- reverts (revert to S0; P21 revert-then-fresh; planMutated; reconcile restore) -------------------------------

/** Revert records kept for undo (oldest dropped first). */
export const REVERTS_MAX = 20
/** Paths a snapshot with `diffFrom` reports (`changed`), at most this many; a list this long may be cut. */
export const CHANGED_PATHS_MAX = 200

function nextRevertToken(tx: Tx): string {
  const n = (tx.s.counters.revert ?? 0) + 1
  tx.s.counters.revert = n
  return `revert-${n}`
}

function requestRevert(
  tx: Tx,
  o: {
    why: RevertWhy
    to: string
    paths?: readonly string[]
    /** Both ends explicit: the shadow's latest ref may be a `pre-revert` (never a range end). */
    scope?: { from: string; to: string }
    step?: StepKey
    boundary?: ReconcileBoundary
    /** `undo`: the record undone (the undo creates its own record under a new token). */
    token?: string
    /** `undo`: what the paths must still hold (the undone revert's target). */
    expect?: string
    /** `user`: the whole segment (Revert all). */
    all?: boolean
  },
): string {
  const token = o.token ?? nextRevertToken(tx)
  const undoToken = o.why === 'undo' ? nextRevertToken(tx) : undefined
  const req = tx.request({
    kind: 'revert',
    why: o.why,
    token,
    to: o.to,
    ...(undoToken !== undefined ? { undoToken } : {}),
    ...(o.all === true ? { all: true } : {}),
    ...(o.step !== undefined ? { step: o.step } : {}),
    ...(o.boundary !== undefined ? { boundary: o.boundary } : {}),
    ...(tx.s.flow.fix === 'gate' ? { atGate: true } : {}),
  })
  tx.push({
    t: 'revert',
    req,
    to: o.to,
    ...(o.paths !== undefined ? { paths: [...o.paths] } : {}),
    ...(o.scope !== undefined ? { scope: { from: o.scope.from, to: o.scope.to } } : {}),
    why: o.why,
    token,
    ...(undoToken !== undefined ? { undoToken } : {}),
    ...(o.expect !== undefined ? { expect: o.expect } : {}),
  })
  tx.transition = true
  return req
}

/**
 * Why a revert cannot run now ("Allowed only when no process holds the folder"), or undefined. Dim Factory's
 * own git work in flight (a snapshot, a reconcile, another revert) counts too: a revert must never interleave with it.
 */
export function folderBusyReason(s: RunState): string | undefined {
  if (AGENT_STEPS.some((k) => s.steps[k].proc?.live === true)) {
    return 'A step is still working in this folder. Revert when it has stopped.'
  }
  const reqs = Object.values(s.requests)
  if (reqs.some((r) => r.kind === 'revert')) return 'A revert is already running in this folder.'
  if (reqs.some((r) => r.kind === 'verify')) {
    return 'The verify commands are running in this folder. Revert when they have finished.'
  }
  if (AGENT_STEPS.some((k) => stepIsActive(s.steps[k]) && !awaitsFindings(s, k))) {
    return 'A step is about to start in this folder. Revert when it has stopped.'
  }
  if (reqs.some((r) => r.kind !== 'findings'))
    return 'Dim Factory is still recording the folder. Try again in a moment.'
  return undefined
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function pathList(paths: readonly string[], max = 20): string {
  const shown = paths.slice(0, max).join(', ')
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

const REVERT_LABEL: Readonly<Record<RevertWhy, string>> = {
  user: 'Revert',
  undo: 'Undo',
  plan: "Revert Plan's changes",
  retry: 'Revert partial changes',
  restore: "Restore run's version",
}

/**
 * What a revert put back, as RunSnapshot.revertUndo.label reads it after "Reverted" ("Reverted Plan's changes",
 * "Reverted your edits outside the run": a restore reverts the user's edits to the run's version).
 */
function revertedWhat(why: Exclude<RevertWhy, 'undo'>, step: StepKey | undefined, all = false): string {
  switch (why) {
    case 'user':
      return all ? "the run's changes" : 'the selected files'
    case 'plan':
      return "Plan's changes"
    case 'retry':
      return step !== undefined ? `${stepLabel(step)}'s partial changes` : 'the partial changes'
    case 'restore':
      return 'your edits outside the run'
  }
}

/**
 * `diff.revert`: to S0 (F0 for the `fix` segment), for the given paths or every path the segment changed. The
 * segment's ends are the ones `diff.files` shows (diff-segments.ts): Combined ends at the run's last result snapshot,
 * never at a `pre-revert`, so a second Revert all (or one after an Undo) reverts the run's changes again and not the
 * user's later edits.
 */
function onRevertCmd(tx: Tx, cmd: Extract<UserCommand, { kind: 'revert' }>): void {
  const s = tx.s
  // An isolated run changed only its copy. Reverting would change the copy, never the folder, while
  // reading as if the folder were back: Apply to folder and its Undo are what change the folder.
  if (isolatedRun(s) && s.isolation?.worktree !== undefined) {
    tx.reject('CONFLICT', ISOLATED_REVERT_TEXT)
    return
  }
  const seg = cmd.seg ?? 'combined'
  const start =
    seg === 'fix'
      ? (s.steps.fix.startSnap ?? s.snapshots['fix-start'])
      : seg === 'deploy'
        ? (s.steps.deploy.startSnap ?? s.snapshots['deploy-start'])
        : runBaseSnap(s)
  if (start === undefined) {
    tx.reject('NOT_FOUND', missingSegmentText(seg))
    return
  }
  const busy = folderBusyReason(s)
  if (busy !== undefined) {
    tx.reject('FOLDER_BUSY', busy)
    return
  }
  const ends = segmentEnds(s, seg)
  if (ends === undefined) {
    tx.reject('NOT_FOUND', missingSegmentText(seg))
    return
  }
  requestRevert(tx, {
    why: 'user',
    to: ends.from.commit,
    ...(cmd.paths !== undefined ? { paths: cmd.paths } : { all: true }),
    scope: { from: ends.from.commit, to: ends.to.commit },
  })
}

/** `diff.undoRevert`: the reverted paths back to the `pre-revert` snapshot. */
function onUndoRevertCmd(tx: Tx, token: string): void {
  const s = tx.s
  const rec = s.git?.reverts?.find((r) => r.token === token)
  if (rec === undefined) {
    tx.reject('NOT_FOUND', 'This revert can no longer be undone.')
    return
  }
  if (rec.undone === true) {
    tx.reject('CONFLICT', 'This revert was already undone.')
    return
  }
  const busy = folderBusyReason(s)
  if (busy !== undefined) {
    tx.reject('FOLDER_BUSY', busy)
    return
  }
  if (rec.target === undefined) {
    tx.reject('CONFLICT', 'Dim Factory cannot check what this revert wrote, so it can no longer be undone.')
    return
  }
  // Only while every path still holds what the revert wrote (revert.ts `expect`): newer work is never overwritten.
  requestRevert(tx, {
    why: 'undo',
    to: rec.preRevert,
    paths: rec.paths,
    token: rec.token,
    expect: rec.target,
  })
}

/** gate:beforeFix shows the Fix notes (reverted files): rebuild it in place with the same id. */
function refreshFixGate(tx: Tx): void {
  const s = tx.s
  const c = s.cards.find((x) => x.view.kind === 'gate:beforeFix')
  if (c === undefined) return
  const fs = ensureFindings(s)
  c.view = beforeFixGateCard(c.view.id, fs.list, fs.selected, fs.notes)
  tx.emit({ t: 'card', card: c.view, state: 'open' })
  tx.transition = true
}

/** A new RevertRecord for a revert request (pending while its files are written, final with its outcome). */
function newRevertRecord(
  tx: Tx,
  r: Extract<PendingRequest, { kind: 'revert' }>,
  preRevert: string,
  paths: string[],
): RevertRecord {
  const s = tx.s
  if (r.why === 'undo') {
    const undone = s.git?.reverts?.find((x) => x.token === r.token)
    return {
      token: r.undoToken ?? r.token,
      why: 'undo',
      preRevert,
      target: r.to,
      paths,
      label: undone !== undefined ? `Undo "${undone.label}"` : REVERT_LABEL.undo,
      what: 'the undo',
      at: tx.at,
      undoes: r.token,
    }
  }
  return {
    token: r.token,
    why: r.why,
    preRevert,
    target: r.to,
    paths,
    label: REVERT_LABEL[r.why],
    what: revertedWhat(r.why, r.step, r.all === true),
    at: tx.at,
  }
}

/** The record a revert request creates (for `undo`: the undo's own record, not the one it undoes). */
const recordTokenOf = (r: Extract<PendingRequest, { kind: 'revert' }>): string =>
  r.why === 'undo' ? (r.undoToken ?? r.token) : r.token

function pushRevertRecord(s: RunState, rec: RevertRecord): void {
  const g = gitState(s)
  g.reverts = [...(g.reverts ?? []).filter((x) => x.token !== rec.token), rec].slice(-REVERTS_MAX)
}

/**
 * Write-ahead: the undo point is taken and the paths are known, nothing is written yet. The record exists from
 * here (`pending`), persisted before the controller lets the writes go on, so a crash part way still leaves an Undo.
 */
function onRevertStarted(tx: Tx, e: Extract<EngineEventBody, { t: 'revert-started' }>): void {
  const r = tx.s.requests[e.req]
  if (r === undefined || r.kind !== 'revert') return
  const rec = newRevertRecord(tx, r, e.preRevert, [...e.paths])
  rec.pending = true
  pushRevertRecord(tx.s, rec)
  tx.transition = true
}

function onRevertResult(tx: Tx, e: Extract<EngineEventBody, { t: 'revert-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'revert') return
  const s = tx.s
  tx.transition = true
  const o = e.outcome
  const why = e.busy ?? e.conflict ?? e.failure?.message ?? 'unknown error'
  if (o !== undefined) {
    const changed = [...o.restored, ...o.deleted]
    // Dim Factory's own writes: never external edits at the next reconcile (until the next boundary snapshot).
    if (changed.length > 0) {
      const g = gitState(s)
      g.ownPaths = [...new Set([...(g.ownPaths ?? []), ...changed])].sort()
    }
    recordRevert(tx, r, o, changed)
    if (r.why === 'undo') undoneRevert(tx, r.token, changed)
  } else {
    // A revert that started writing and then failed: its record stays, undoable (the paths it was about to change).
    const pending = s.git?.reverts?.find((x) => x.token === recordTokenOf(r) && x.pending === true)
    if (pending !== undefined) {
      delete pending.pending
      pending.interrupted = true
      if (pending.paths.length > 0) {
        tx.note(
          `${REVERT_LABEL[r.why]} stopped part way: ${why}. Undo puts back the ${plural(pending.paths.length, 'file')} it was changing.`,
        )
      }
    } else if (r.why !== 'user' && r.why !== 'undo') {
      tx.note(`${REVERT_LABEL[r.why]} did not run: ${why}`)
    }
  }
  switch (r.why) {
    case 'plan':
      if (s.flow.planEnd === 'reverting') {
        s.flow.planEnd = 'done'
        openPlanGate(tx)
      }
      break
    case 'retry': {
      if (r.step === undefined || !isAgentStep(r.step)) break
      const L = s.steps[r.step].launch
      if (L === undefined || L.req !== e.req) break
      delete L.req
      if (o !== undefined) {
        L.revert = 'done'
        break
      }
      failPass(
        tx,
        r.step,
        {
          category: e.failure?.category ?? 'snapshot_failed',
          message: `Reverting the partial changes failed: ${why}`,
          raw: e.failure?.raw ?? '',
          classifiedBy: 'app',
          step: r.step,
        },
        { noRetry: true },
      )
      break
    }
    case 'restore':
      afterRestore(tx, r, e.req)
      break
    case 'user':
    case 'undo':
      break
  }
  // Launches held while the folder was being written go on.
  for (const k of AGENT_STEPS) if (s.steps[k].launch !== undefined) pump(tx, k)
}

/** The revert's record, final: what changed, its notes (run notes; the Fix note at the gate). */
function recordRevert(
  tx: Tx,
  r: Extract<PendingRequest, { kind: 'revert' }>,
  o: NonNullable<Extract<EngineEventBody, { t: 'revert-result' }>['outcome']>,
  changed: string[],
): void {
  const s = tx.s
  const token = recordTokenOf(r)
  const prior = s.git?.reverts?.find((x) => x.token === token)
  const rec = prior ?? newRevertRecord(tx, r, o.preRevert, changed)
  rec.preRevert = o.preRevert
  rec.paths = changed
  delete rec.pending
  delete rec.interrupted
  const n = changed.length
  switch (r.why) {
    case 'user':
      if (n > 0) addNotes(tx, [`Reverted ${plural(n, 'file')}: ${pathList(changed)}.`])
      // Reverts made at the before-fix gate (or later, before Fix spawned) become notes in the Fix prompt.
      // Fix never spawns while a revert runs, so a Continue pressed meanwhile still gets the note.
      if ((r.atGate === true || s.flow.fix !== undefined) && s.steps.fix.spawnNo === 0 && n > 0) {
        const note = `User reverted after review: ${pathList(changed)}`
        addFixNotes(s, [note])
        rec.note = note
        refreshFixGate(tx)
      }
      break
    case 'plan':
      addNotes(tx, [`Reverted Plan's changes (${plural(n, 'file')}). You can undo this.`])
      break
    case 'retry':
      addNotes(tx, [
        `Reverted ${r.step !== undefined ? `${stepLabel(r.step)}'s` : 'the'} partial changes (${plural(n, 'file')}) before the fresh retry.`,
      ])
      break
    case 'restore':
      if (n > 0) addNotes(tx, [`Restored the run's version of ${pathList(changed)}.`])
      break
    case 'undo':
      break
  }
  pushRevertRecord(s, rec)
}

function undoneRevert(tx: Tx, token: string, changed: string[]): void {
  const s = tx.s
  const rec = s.git?.reverts?.find((r) => r.token === token)
  if (rec === undefined) return
  rec.undone = true
  addNotes(tx, [`Undid "${rec.label}" (${plural(changed.length, 'file')}).`])
  if (rec.note !== undefined && s.steps.fix.spawnNo === 0 && s.findings !== undefined) {
    const note = rec.note
    s.findings.notes = s.findings.notes.filter((x) => x !== note)
    refreshFixGate(tx)
  }
}

/**
 * Card reverts a later pass touched: that pass's end snapshot changed one of their paths (`changed`; a capped
 * list counts as touching), so the run's end no longer offers their Undo. The undo itself still checks each path.
 */
function markStaleReverts(s: RunState, changed: readonly string[]): void {
  const capped = changed.length >= CHANGED_PATHS_MAX
  const set = new Set(changed)
  for (const rec of s.git?.reverts ?? []) {
    if (!isCardRevert(rec) || rec.undone === true || rec.stale === true) continue
    if (capped || rec.paths.some((p) => set.has(p))) rec.stale = true
  }
}

/** After [Restore run's version] the boundary reconciles again (the restored paths are Dim Factory's own now). */
function afterRestore(tx: Tx, r: Extract<PendingRequest, { kind: 'revert' }>, req: string): void {
  const s = tx.s
  if (s.stop !== undefined) return
  switch (r.boundary) {
    case 'pre-implement':
    case 'pre-fix': {
      if (r.step === undefined || !isAgentStep(r.step)) return
      const L = s.steps[r.step].launch
      if (L === undefined || L.req !== req) return
      delete L.req
      L.reconcile = 'todo'
      return
    }
    case 'pre-review':
      if (s.flow.review === 'reconcile' && s.outcome === undefined) requestReconcile(tx, 'pre-review')
      return
    case 'end-of-pass':
      if (r.step !== undefined && isMutatingStep(r.step) && s.steps[r.step].endCheck === 'hold') {
        requestReconcile(tx, 'end-of-pass', r.step, { hold: true })
      }
      return
    case 'pre-apply':
    case undefined:
      return
  }
}

// ---- R4 plan-end guard -------------------------------------------------------------------------------------------

/** Tool names that write files or run commands (Claude Edit/Write/…/Bash/PowerShell; Codex and ACP equivalents). */
const WRITE_TOOL =
  /^(?:edit|write|multiedit|notebookedit|bash|powershell|shell|local_shell|exec|exec_command|execute|apply_patch|filechange|commandexecution)$/i

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL.test(name)
}

function addPlanWrite(st: StepState, id: string): void {
  const w = st.writes ?? []
  if (!w.includes(id)) st.writes = [...w, id]
}

/** Plan's tool events: an edit/write/shell tool counts as a reported write unless it ended declined. */
function trackPlanTool(st: StepState, ev: NormalizedEventOf<'tool'>): void {
  if (!isWriteTool(ev.name)) return
  const id = ev.id ?? ev.name
  if (ev.phase === 'end' && ev.status === 'declined') {
    const left = (st.writes ?? []).filter((x) => x !== id)
    if (left.length > 0) st.writes = left
    else delete st.writes
    return
  }
  addPlanWrite(st, id)
}

/** R4 after Plan's output: the plan-end guard when Plan reported a write, else the gate. */
function afterPlanOutput(tx: Tx): void {
  const s = tx.s
  if (s.flow.planEnd === undefined && (s.steps.plan.writes?.length ?? 0) > 0) {
    planEndGuard(tx)
    return
  }
  openPlanGate(tx)
}

/** R4: `gate:afterPlan` unless Auto or the gate is off (then the plan is decided at once). */
function openPlanGate(tx: Tx): void {
  const s = tx.s
  if (s.plan.decided || s.plan.text === null || s.stop !== undefined) return
  if (s.config.gates.afterPlan && !s.config.auto) {
    openCard(tx, afterPlanGateCard(nextCardId(tx, 'gate:afterPlan'), s.plan.text), 'plan')
  } else {
    s.plan.decided = true
  }
}

/**
 * The `plan-end` snapshot, compared with `run-start` (R4). R2 spawns Plan only after run-start has answered, so the
 * wait is for a run.json an earlier build wrote while Plan ran in parallel with it.
 */
function planEndGuard(tx: Tx): void {
  const s = tx.s
  if (s.flow.runStart === 'none' || s.flow.runStart === 'requested') {
    s.flow.planEnd = 'wait'
    return
  }
  const base = s.snapshots['run-start']
  if (s.flow.runStart === 'failed' || base === undefined) {
    s.flow.planEnd = 'done'
    tx.note(
      'Plan reported file writes, but there is no run-start snapshot to compare with, so any changes it made are kept.',
    )
    openPlanGate(tx)
    return
  }
  s.flow.planEnd = 'requested'
  requestSnapshot(tx, 'plan-end', 'plan-end', 'plan', base.commit)
  tx.transition = true
}

/** tree(plan-end) ≠ tree(run-start) after a reported write → planMutated; otherwise the gate. */
function onPlanEndSnapshot(tx: Tx, ref: SnapshotRef | undefined, changed: string[], why: string): void {
  const s = tx.s
  if (s.flow.planEnd !== 'requested' || s.stop !== undefined) return
  const base = s.snapshots['run-start']
  if (ref === undefined) {
    s.flow.planEnd = 'done'
    tx.note(`The plan-end snapshot failed: ${why}`)
    openPlanGate(tx)
    return
  }
  if (base !== undefined && base.tree !== ref.tree) {
    // R2: an isolated run's install and baseline write in its copy while Plan runs, so the trees cannot tell Plan's
    // changes from theirs, so nothing is reverted; they stay in the isolated copy and are part of S0, which Apply never
    // copies to the folder (it copies S0..last).
    if (s.config.isolation === 'worktree' && s.isolation?.copyWritten === true) {
      s.flow.planEnd = 'done'
      tx.note(PLAN_WROTE_IN_COPY)
      openPlanGate(tx)
      return
    }
    // Dependency and build output folders (node_modules, .venv, dist …) are left out: an install, a package
    // manager's link step or a dev server's cache can write there while Plan runs, and the card would ask the user to
    // revert files Plan never touched. Only the rest is Plan's to answer for (and the only paths Revert touches).
    const own = changed.filter((p) => !isGeneratedPath(p))
    if (own.length === 0 && changed.length > 0) {
      s.flow.planEnd = 'done'
      tx.note(planWroteGeneratedNote(changed))
      openPlanGate(tx)
      return
    }
    s.flow.planEnd = 'card'
    openCard(tx, planMutatedCard(nextCardId(tx, 'planMutated'), own), 'plan')
    return
  }
  s.flow.planEnd = 'done'
  openPlanGate(tx)
}

/** The plan-end guard's note when an isolated run's install or baseline wrote in its copy during Plan. */
export const PLAN_WROTE_IN_COPY =
  'Plan reported file writes while the dependency install or the baseline check was also writing in the isolated copy, so Dim Factory cannot tell their changes apart. They stay in the isolated copy and are not applied to your folder: Apply copies only what Implement and Fix change.'

/** The plan-end guard's note when everything that changed during Plan is dependency or build output. */
export function planWroteGeneratedNote(paths: readonly string[]): string {
  const dirs = [
    ...new Set(paths.map((p) => p.split(/[\\/]/).find((seg) => isGeneratedPath(`${seg}/x`)) ?? p)),
  ]
  return `Only dependency or build folders changed while Plan ran (${dirs.join(', ')}), so the plan is checked as usual and those files are kept.`
}

/** The paths a planMutated card named (its payload). */
function cardPaths(c: CardState): string[] {
  const p = (c.view.payload as { paths?: unknown } | undefined)?.paths
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

/** planMutated: [Revert Plan's changes] (back to run-start for the paths Plan changed; undoable) · [Keep]. */
function choosePlanMutated(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  resolveCard(tx, c.view.id, choiceId)
  if (s.stop !== undefined) return
  const base = s.snapshots['run-start']
  const end = s.snapshots['plan-end']
  // The card opens only on a plan-end snapshot, so both ends exist; Plan's changes are run-start..plan-end.
  if (choiceId === PLAN_MUTATED_CHOICE.revert && base !== undefined && end !== undefined) {
    s.flow.planEnd = 'reverting'
    // Only the paths the card named: a dependency or build folder written meanwhile stays as it is.
    const paths = cardPaths(c)
    requestRevert(tx, {
      why: 'plan',
      to: base.commit,
      scope: { from: base.commit, to: end.commit },
      ...(paths.length > 0 ? { paths } : {}),
      step: 'plan',
    })
    return
  }
  s.flow.planEnd = 'done'
  addNotes(tx, ['Kept the changes the Plan step made.'])
  openPlanGate(tx)
}

// ---- launch pipeline (P1 / P16 / P19 / P20 / P21) --------------------------------------------------------------

function startLaunch(tx: Tx, key: AgentStep, launch: PendingLaunch, o: { force?: boolean } = {}): void {
  const st = tx.s.steps[key]
  st.launch = launch
  if (st.attempt === 0) st.attempt = 1
  setStatus(tx, st, 'running', o.force ? { force: true } : {})
  pump(tx, key)
}

/** Advance a pending launch as far as possible; stops at the first stage that must wait. */
function pump(tx: Tx, key: AgentStep): void {
  const s = tx.s
  const st = s.steps[key]
  const L = st.launch
  if (L === undefined || L.req !== undefined || L.card !== undefined || s.stop !== undefined) return
  if (st.proc?.live) return // never two live processes per step: wait for the exit
  // A revert is writing the folder; nothing is snapshotted, reconciled or spawned until it is done.
  if (hasRequest(tx, (r) => r.kind === 'revert')) return
  if (L.preSnapshot && !L.preSnapshot.done) {
    L.req = requestSnapshot(tx, L.preSnapshot.label, L.preSnapshot.label, key)
    return
  }
  if (L.plan === undefined && L.decide === undefined) {
    const plan = resolveRetry(tx, key, L)
    if (plan === undefined) return
    L.plan = plan
  }
  // R5 runs in the run's first mutating pass: Implement, or Test-first's Tests step before it.
  const firstMutating = key === 'implement' || key === 'tests'
  // A relaunch is settling the run's pending branch (it may adopt it): R5 waits for that answer.
  if (firstMutating && hasRequest(tx, (r) => r.kind === 'branch')) return
  if (L.reconcile === 'todo') {
    L.req = requestReconcile(tx, key === 'fix' ? 'pre-fix' : 'pre-implement', key)
    return
  }
  // R5: runBranch ⇒ create the branch after reconcile(pre-implement), before S0 (T0). Never earlier, so a run
  // cancelled at the plan gate leaves no run branch.
  // An isolated run works on its worktree's own branch; it never makes a run branch in the folder.
  if (firstMutating && s.config.branch === 'runBranch' && s.branch === undefined && !isolatedRun(s)) {
    const req = tx.request({ kind: 'branch' })
    tx.push({
      t: 'branch',
      req,
      ...(s.branchPending !== undefined ? { pending: { ...s.branchPending } } : {}),
    })
    L.req = req
    return
  }
  if (L.delayUntil !== undefined) {
    if (L.delayUntil > tx.at) {
      tx.armTimer(timerId.launch(key), L.delayUntil)
      return
    }
    delete L.delayUntil
  }
  if (isMutatingStep(key) && st.startSnap === undefined) {
    L.req = requestSnapshot(tx, startLabel(key), 'start', key)
    return
  }
  if (L.preflight === 'todo') {
    const req = tx.request({ kind: 'preflight', mode: 'passBoundary', step: key })
    tx.push({ t: 'preflight', req, mode: 'passBoundary', step: key })
    L.req = req
    return
  }
  // R2: Plan spawns only once the run-start snapshot has answered (taken, or failed with its note), so a write Plan
  // makes is never folded into run-start and the plan-end guard (R4) always sees it. Its pass-boundary preflight
  // runs meanwhile; the run-start result pumps the launch again. Clarify, before it, waits the same way.
  if ((key === 'plan' || key === 'clarify' || key === 'research') && !runStartSettled(s)) return
  // R10: decideSession after F0, right before Fix P1. The controller sends its `session-check` (canResume, Fix's
  // folder, the vendor's capabilities) before it answers the pass-boundary preflight, so the check is in the launch.
  L.plan ??= sessionPlan(tx, key, L.sessionCheck)
  if (isReviewerStep(key) && L.cause === 'initial') {
    if (L.ready !== true) {
      L.ready = true
      tx.transition = true
    }
    if (joinWaits(tx, key, L)) return
    // Barrier released: every ready initial reviewer launch spawns now, in step order.
    for (const k of REVIEWER_PASSES) {
      const KL = s.steps[k].launch
      if (KL?.ready === true && KL.cause === 'initial' && KL.plan !== undefined) spawn(tx, k, KL.plan)
    }
    return
  }
  spawn(tx, key, L.plan)
}

/**
 * Review ∥ Critic is one join node: an initial launch that is ready to spawn waits while its sibling's initial
 * launch is still in its pipeline, so both spawn in the same reduction. A sibling that failed, paused or was
 * stopped has no launch any more and releases the barrier.
 */
function joinWaits(tx: Tx, key: ReviewerPass, L: PendingLaunch): boolean {
  if (L.cause !== 'initial') return false
  // Every sibling of the join (Review ∥ Critic ∥ Security) still on its way to its first spawn holds this one.
  return REVIEWER_PASSES.some((k) => {
    if (k === key) return false
    const other = tx.s.steps[k].launch
    return other !== undefined && other.cause === 'initial' && other.ready !== true
  })
}

/**
 * R10 decideSession v1 → Fix's launch plan (resume Implement's session, or fresh with the reason). `check` is the
 * controller's `session-check` for this launch; without one (or for another session) canResume counts as ok and the
 * folder and capabilities as unknown — a resume the CLI then rejects still falls back fresh (resume_failed).
 */
function sessionPlan(tx: Tx, key: AgentStep, check: SessionCheck | undefined): LaunchPlan {
  const s = tx.s
  // Continuity: Implement continues Plan's session under the same rules (Plan standing in for Implement).
  if (key === 'implement') {
    const inputs = implementSessionInputs(s, check)
    const d = decideImplementSession(inputs, canResumeFrom(check))
    if (!d.reuse) {
      const L = s.steps.implement.launch
      if (L !== undefined && decidedByCapability(inputs, d)) L.freshDetail = 'vendor-cannot-resume'
      return { fresh: { reason: d.reason }, session: d }
    }
    const prior = s.sessions[d.sessionId]?.lastTotals
    return {
      resume:
        prior !== undefined ? { sessionId: d.sessionId, priorUsage: prior } : { sessionId: d.sessionId },
      session: d,
    }
  }
  // Fix until green, rounds ≥ 2: the previous round's session stands in for Implement's (the same rules).
  const inputs = fixLaunchSessionInputs(s, check)
  const d = decideSession(inputs, canResumeFrom(check))
  if (!d.reuse) {
    const L = s.steps.fix.launch
    if (L !== undefined && decidedByCapability(inputs, d)) L.freshDetail = 'vendor-cannot-resume'
    return { fresh: { reason: d.reason }, session: d }
  }
  const prior = s.sessions[d.sessionId]?.lastTotals
  return {
    resume: prior !== undefined ? { sessionId: d.sessionId, priorUsage: prior } : { sessionId: d.sessionId },
    session: d,
  }
}

/**
 * The initial pipeline of a pass that never spawned: Implement redoes R5 (reconcile(pre-implement)), Fix redoes R10
 * (reconcile(pre-fix) and decideSession after F0); other passes start fresh.
 */
function initialLaunch(tx: Tx, key: AgentStep, cause: 'initial' | 'retry'): PendingLaunch {
  if (key === 'fix') return { cause, decide: 'session', reconcile: 'todo', preflight: 'todo' }
  // Continuity: a first Implement that never spawned decides its session again (Plan's, or fresh).
  if (
    key === 'implement' &&
    tx.s.config.continuity === true &&
    tx.s.config.passes.plan.enabled &&
    tx.s.steps.implement.spawnNo === 0
  )
    return { cause, decide: 'session', reconcile: 'todo', preflight: 'todo' }
  const L: PendingLaunch = { cause, plan: freshPlan(tx, key), preflight: 'todo' }
  if (key === 'implement' || key === 'tests') L.reconcile = 'todo'
  return L
}

function planExtras(
  tx: Tx,
  key: AgentStep,
): Pick<LaunchPlan, 'planMode' | 'planFallbackReason' | 'keepSession'> {
  if (key !== 'plan') return {}
  const st = tx.s.steps.plan
  const out: Pick<LaunchPlan, 'planMode' | 'planFallbackReason' | 'keepSession'> = {
    planMode: st.planMode ?? tx.s.config.planMode,
  }
  if (st.planFallbackReason !== undefined) out.planFallbackReason = st.planFallbackReason
  // Continuity: every Plan attempt keeps its session for Implement.
  if (planKeepsSession(tx.s)) out.keepSession = true
  return out
}

function freshPlan(tx: Tx, key: AgentStep, reason?: FreshReason): LaunchPlan {
  return { fresh: reason !== undefined ? { reason } : {}, ...planExtras(tx, key) }
}

function resumePlan(tx: Tx, st: StepState, sessionId: string, continuation: string): LaunchPlan {
  const prior = tx.s.sessions[sessionId]?.lastTotals
  return {
    resume: prior !== undefined ? { sessionId, priorUsage: prior } : { sessionId },
    continuation,
    ...(st.key === 'plan' ? planExtras(tx, 'plan') : {}),
  }
}

/** "Retry `auto` resolves to". Returns undefined while the retryPartial card is open. */
function resolveRetry(tx: Tx, key: AgentStep, L: PendingLaunch): LaunchPlan | undefined {
  const st = tx.s.steps[key]
  const strategy: RetryStrategy = L.strategy ?? 'fresh'
  const continuation = L.continuation ?? CONTINUATION.failed(L.failure?.message ?? 'unknown error')
  switch (strategy) {
    case 'revert-then-fresh':
      // What the failed attempt changed (start..attemptEnd) back to the pass's start snapshot (undoable), then
      // fresh. Edits made while the pass sat failed are not the attempt's and stay. A read-only pass, or one that
      // never spawned, has nothing to revert.
      if (isMutatingStep(key) && st.startSnap !== undefined && st.spawnNo > 0 && L.revert !== 'done') {
        if (L.revert === undefined) {
          // The snapshot taken when the attempt ended may still be on its way.
          if (hasRequest(tx, (r) => r.kind === 'snapshot' && r.purpose === 'recovery' && r.step === key)) {
            return undefined
          }
          const end = st.attemptEnd
          if (end === undefined) {
            failPass(
              tx,
              key,
              {
                category: 'snapshot_failed',
                message:
                  'Dim Factory has no snapshot of where the failed attempt ended, so it cannot tell its changes from yours. Nothing was reverted. Retry with Fresh or Keep changes instead.',
                raw: '',
                classifiedBy: 'app',
                step: key,
              },
              { noRetry: true },
            )
            return undefined
          }
          L.revert = 'requested'
          L.req = requestRevert(tx, {
            why: 'retry',
            to: st.startSnap.commit,
            scope: { from: st.startSnap.commit, to: end.commit },
            step: key,
          })
        }
        return undefined
      }
      return freshPlan(tx, key, L.failure?.category === 'resume_failed' ? 'resume-failed' : undefined)
    case 'fresh':
    case 'keep-changes':
      return freshPlan(tx, key, L.failure?.category === 'resume_failed' ? 'resume-failed' : undefined)
    case 'resume':
      // Read-only passes never resume (their sessions are not persisted); they overwrite their output.
      if (!isMutatingStep(key)) return freshPlan(tx, key)
      return st.sessionId !== undefined
        ? resumePlan(tx, st, st.sessionId, continuation)
        : freshPlan(tx, key, 'no-session')
    case 'auto': {
      if (!isMutatingStep(key)) return freshPlan(tx, key)
      const tree = L.preSnapshot?.tree
      const unchanged = st.startSnap === undefined || (tree !== undefined && tree === st.startSnap.tree)
      if (unchanged) return freshPlan(tx, key)
      if (st.sessionId !== undefined) return resumePlan(tx, st, st.sessionId, continuation)
      const id = nextCardId(tx, 'retryPartial')
      L.card = id
      openCard(tx, retryPartialCard(id, key, L.failure), key)
      return undefined
    }
  }
}

function spawn(tx: Tx, key: AgentStep, plan: LaunchPlan): void {
  const s = tx.s
  const st = s.steps[key]
  const pc = passCfg(s, key)
  st.spawnNo += 1
  if (st.attempt === 0) st.attempt = 1
  st.proc = { spawnNo: st.spawnNo, live: true, spawnedAt: tx.at, terminal: false }
  delete st.attemptEnd
  if (plan.fresh?.reason !== undefined) st.proc.freshReason = plan.fresh.reason
  st.lastEventAt = tx.at
  delete st.keepWaitingAt
  st.inFlightTools = []
  delete st.result
  delete st.planCaptured
  // `usage` is replaced by this spawn's `done`; its approximation flag (meta usageApprox) belongs to that usage.
  delete st.usageApprox
  // The context meter: a fresh session starts anew; one that continues (a resume, Fix reusing Implement's session)
  // keeps what its session holds, and reports again for the new attempt.
  if (plan.resume === undefined || st.context === undefined) st.context = newContextState()
  else delete st.context.sent
  // The grounding evidence is this spawn's; a session that continues keeps what it read.
  if (isMutatingStep(key)) {
    const from = key === 'fix' && plan.session?.reuse === true ? s.steps.implement.grounding : st.grounding
    const reads = plan.resume !== undefined ? (from?.reads ?? []) : []
    st.grounding = { ...newGroundingTrack(), reads: [...reads] }
  }
  st.vendor = pc.vendor
  st.model = pc.model
  // The effort it runs at (absent: the vendor's default, or a vendor without an effort setting).
  const effort =
    pc.effort !== undefined && pc.effort !== null && supportsEffort(pc.vendor) ? pc.effort : undefined
  if (effort !== undefined) st.effort = effort
  else delete st.effort
  // Live balanced run: the model a pass that names none runs is this spawn's to report again.
  delete st.modelUsed
  delete st.modelReplaced
  delete st.modelAsked
  delete st.modelRerouted
  delete st.modelUnreported
  st.mode = pc.mode
  if (key === 'plan') {
    st.planMode = plan.planMode ?? s.config.planMode
    if (plan.planFallbackReason !== undefined) st.planFallbackReason = plan.planFallbackReason
  }
  if (plan.fresh) delete st.sessionId
  // Clarify's, Research's and the acceptance review's structured answers belong to the spawn that gives them.
  if (key === 'clarify' || key === 'research' || key === 'acceptance') delete st.meta[META_STRUCTURED_OUTPUT]
  const round = key === 'fix' ? (s.fixLoop?.round ?? 1) : 1
  if (plan.session?.reuse === true)
    st.sessionNote =
      key === 'implement'
        ? SESSION_NOTE.reusedPlan
        : round > 1
          ? SESSION_NOTE.reusedRound
          : SESSION_NOTE.reusedImplement
  else if (plan.resume) st.sessionNote = SESSION_NOTE.resumed
  else if (plan.fresh?.reason !== undefined) st.sessionNote = SESSION_NOTE.fresh(plan.fresh.reason)
  else delete st.sessionNote
  // The fact behind the fresh start ("Why?"), kept only with the reason it belongs to.
  const detail = st.launch?.freshDetail
  if (detail !== undefined && plan.fresh?.reason === FRESH_DETAIL_REASON[detail]) st.freshDetail = detail
  else delete st.freshDetail
  // context_exceeded "retry fresh with a trimmed diff": a fresh retry after the prompt was too
  // long halves the diff budget once more; the trim stays for the step's later attempts.
  if (
    plan.fresh !== undefined &&
    st.launch?.cause === 'retry' &&
    st.failure?.category === 'context_exceeded'
  ) {
    st.diffTrim = (st.diffTrim ?? 0) + 1
  }
  // Fix: the `Notes:` list of `{{findings}}` goes with every launch (retries and resumes included); a later round
  // of Fix until green says which round it is first.
  let launch: LaunchPlan = key === 'fix' ? { ...plan, notes: fixNotes(s) } : plan
  if (st.diffTrim !== undefined && st.diffTrim > 0) launch = { ...launch, diffTrim: st.diffTrim }
  delete st.launch
  tx.clearTimer(timerId.launch(key))
  if (isMutatingStep(key) && !s.liveCount) {
    s.liveCount = true
    tx.push({ t: 'liveCount', on: true })
  }
  emitStepStatus(tx, st)
  tx.push({
    t: 'spawn',
    step: key,
    attempt: st.attempt,
    spawnNo: st.spawnNo,
    launch,
    vendor: pc.vendor,
    model: pc.model,
    ...(effort !== undefined ? { effort } : {}),
    mode: pc.mode,
  })
  syncTimers(tx, key)
}

/** The Fix prompt's `Notes:` list: the run's Fix notes, after the round note of a later Fix until green round. */
function fixNotes(s: RunState): string[] {
  const notes = [...(s.findings?.notes ?? [])]
  const loop = s.fixLoop
  if (loop !== undefined && loop.round > 1) {
    notes.unshift(
      `Fix until green, round ${loop.round} of ${fixRoundsMax(s)}: the findings below are still open after round ${loop.round - 1} (its changes are already in the folder). Fix their root causes.`,
    )
  }
  return notes
}

// ---- failures (P14 / P16 / P17) --------------------------------------------------------------------------------

interface FailOpts {
  ranMs?: number
  /** passBoundary preflight failures never retry. */
  noRetry?: boolean
  /** P14: interrupt → kill after the grace, instead of an immediate kill. */
  interrupt?: boolean
  /** The failure came from a process that has already exited (snapshot right away). */
  fromExit?: boolean
}

function failPass(tx: Tx, key: AgentStep, failure: Failure, o: FailOpts = {}): void {
  const s = tx.s
  const st = s.steps[key]
  const p = st.proc
  const procLive = p?.live === true
  const f: Failure = failure.step === undefined ? { ...failure, step: key } : failure
  if (p) p.terminal = true
  dropAsks(tx, key, 'vendor-cancel')
  clearStepTimers(tx, key)
  resolveStepCards(tx, key, 'stall')
  resolveReactionCards(tx, key)
  const carriedReconcile = st.launch?.reconcile === 'todo'
  if (st.launch?.card !== undefined) resolveCard(tx, st.launch.card)
  delete st.launch

  const rctx: RetryContext = o.ranMs !== undefined ? { ranMs: o.ranMs, now: tx.at } : { now: tx.at }
  let decision = o.noRetry ? undefined : tx.ctx.retryPolicy(f.category, f, rctx)
  // "Don't consume the budget: … resume rejected at startup → fresh": that fallback is free once. The fallback
  // spawn failing with resume_failed again is an ordinary failure, so it spends the budget and cannot loop.
  if (decision !== undefined && f.category === 'resume_failed' && p?.freshReason === 'resume-failed') {
    decision = { ...decision, consumesBudget: true }
  }
  const budgetOk = decision !== undefined && (!decision.consumesBudget || !st.autoRetryUsed)
  if (decision?.auto && budgetOk && f.category !== 'user_cancelled') {
    // P16
    if (decision.consumesBudget) {
      st.autoRetryUsed = true
      nextAttempt(tx, st)
    }
    st.failure = f
    const L: PendingLaunch = {
      cause: 'retry',
      strategy: decision.strategy ?? 'auto',
      failure: f,
      preflight: 'todo',
    }
    if (decision.delayMs > 0) L.delayUntil = tx.at + decision.delayMs
    // A resume_failed retry that spent the budget is a new attempt, not the free fallback ("Why?").
    if (f.category === 'resume_failed' && decision.consumesBudget) L.freshDetail = 'new-attempt'
    // Taken as soon as the process has exited: where this attempt ended (`attemptEnd`, revert-then-fresh's scope).
    if (isMutatingStep(key) && st.startSnap !== undefined)
      L.preSnapshot = { label: 'pre-retry', done: false, attemptEnd: true }
    if (carriedReconcile) L.reconcile = 'todo'
    if (key === 'fix' && fixUnspawned(s)) {
      // Fix failed before its first spawn (F0): its plan is still R10's session decision.
      delete L.strategy
      L.decide = 'session'
    }
    if (procLive && p) armKill(tx, key, p.spawnNo)
    st.launch = L
    setStatus(tx, st, 'running', { reason: `retrying after ${f.category}`, force: true })
    pump(tx, key)
    return
  }
  // P17 (and P14 through `interrupt`)
  if (isMutatingStep(key)) liveCountOff(tx)
  if (procLive && p) {
    if (o.interrupt) {
      tx.push({ t: 'interrupt', step: key, spawnNo: p.spawnNo })
      armKill(tx, key, p.spawnNo)
    } else {
      tx.push({ t: 'kill', step: key, spawnNo: p.spawnNo })
    }
    if (isMutatingStep(key)) st.exitSnapshot = 'stopped'
  } else if (o.fromExit && isMutatingStep(key)) {
    requestSnapshot(tx, 'stopped', 'recovery', key)
  }
  st.failure = f
  setStatus(tx, st, 'failed', { reason: f.category })
  openSnag(tx, key, f)
  // P17: heal if (unknown ∨ heuristic) ∧ selfHeal.enabled; never for a category kept from the healer.
  const autoHeal = f.category === 'unknown' || f.classifiedBy === 'heuristic'
  if (autoHeal && s.config.selfHeal && st.snagOpen && CATEGORY_INFO[f.category].heal !== 'never') {
    startHeal(tx, key, f, 'auto')
  }
}

function exitFailure(e: { code: number | null; signal: string | null }): Failure {
  if (e.code === 0) {
    return {
      category: 'stream_malformed',
      message: 'The CLI exited without a result.',
      raw: '',
      classifiedBy: 'exit',
    }
  }
  const how = e.code !== null ? `code ${e.code}` : `signal ${e.signal ?? 'unknown'}`
  return { category: 'process_crash', message: `The CLI exited with ${how}.`, raw: '', classifiedBy: 'exit' }
}

// ---- pause (P9b / P10 / P26) -----------------------------------------------------------------------------------

function pause(
  tx: Tx,
  key: AgentStep,
  reason: PauseReason,
  o: { continuation?: string; interrupt?: boolean } = {},
): void {
  const st = tx.s.steps[key]
  const p = st.proc
  clearStepTimers(tx, key)
  resolveStepCards(tx, key, 'stall')
  resolveReactionCards(tx, key)
  if (st.launch?.card !== undefined) resolveCard(tx, st.launch.card)
  delete st.launch
  if (p?.live) {
    if (o.interrupt && !p.terminal) tx.push({ t: 'interrupt', step: key, spawnNo: p.spawnNo })
    armKill(tx, key, p.spawnNo)
    if (isMutatingStep(key)) st.exitSnapshot = reason === 'interrupted-by-quit' ? 'interrupted' : 'paused'
    p.terminal = true
  }
  if (isMutatingStep(key)) liveCountOff(tx)
  if (o.continuation !== undefined) st.resumeContinuation = o.continuation
  setStatus(tx, st, 'paused', { pause: reason })
}

// ---- process events --------------------------------------------------------------------------------------------

function currentProc(tx: Tx, key: AgentStep, spawnNo: number): StepState | undefined {
  const st = tx.s.steps[key]
  return st.proc !== undefined && st.proc.spawnNo === spawnNo ? st : undefined
}

/** The step reacts to vendor output (not just logs it). */
function reacting(st: StepState): boolean {
  return st.proc !== undefined && st.proc.live && !st.proc.terminal && isLiveStatus(st.status)
}

function onSpawned(tx: Tx, e: Extract<EngineEventBody, { t: 'spawned' }>): void {
  const st = currentProc(tx, e.step, e.spawnNo)
  if (!st || !st.proc) return
  if (e.pid !== undefined) st.proc.pid = e.pid
  if (e.inBytes !== undefined) st.inBytes = e.inBytes
  if (e.cwd !== undefined) st.proc.cwd = e.cwd
  const extra: { route?: string; argv?: string[] } = {}
  if (e.route !== undefined) {
    st.route = e.route
    extra.route = e.route
  }
  if (e.argv !== undefined) {
    st.argv = e.argv
    extra.argv = e.argv
  }
  if (e.sessionId !== undefined && reacting(st)) recordSession(tx, e.step, e.sessionId)
  if (isLiveStatus(st.status)) emitStepStatus(tx, st, extra)
}

/**
 * P4: persist the session id (forced write: a resume after a crash needs it), with the folder it was started
 * in (a continued session keeps its own), where canResume looks for it and decideSession's cwd rule compares.
 */
function recordSession(tx: Tx, key: AgentStep, id: string): void {
  const st = tx.s.steps[key]
  if (st.sessionId === id) return
  st.sessionId = id
  const prev = tx.s.sessions[id]
  const cwd = prev?.cwd ?? st.proc?.cwd
  tx.s.sessions[id] = {
    vendor: st.vendor ?? passCfg(tx.s, key).vendor,
    step: key,
    ...(prev?.lastTotals !== undefined ? { lastTotals: prev.lastTotals } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  }
  tx.transition = true
}

/**
 * Session id persistence: the session id an adapter learned from the vendor before its first turn
 * (StartOptions.onSession). Recorded like P4 (a forced run.json write), only while the process still reacts.
 */
function onSessionAssigned(tx: Tx, e: Extract<EngineEventBody, { t: 'session-assigned' }>): void {
  const st = currentProc(tx, e.step, e.spawnNo)
  if (!st || e.sessionId === '' || !reacting(st)) return
  // The folder the session lives in (canResume / cwd rule), when the `spawned` event has not named it yet.
  if (st.proc !== undefined && st.proc.cwd === undefined && e.cwd !== undefined && e.cwd !== '')
    st.proc.cwd = e.cwd
  recordSession(tx, e.step, e.sessionId)
}

/** R10: the controller's facts for Fix's (or, continuity, Implement's) session decision; kept in the deciding launch. */
function onSessionCheck(tx: Tx, step: 'fix' | 'implement', check: SessionCheck): void {
  const L = tx.s.steps[step].launch
  if (L?.decide !== 'session' || L.plan !== undefined) return
  L.sessionCheck = check
}

/** P5 / P13 (event while stalled). */
function touch(tx: Tx, key: AgentStep): void {
  const st = tx.s.steps[key]
  st.lastEventAt = tx.at
  if (st.status === 'stalled') {
    resolveStepCards(tx, key, 'stall')
    setStatus(tx, st, 'running')
  }
  syncTimers(tx, key)
}

function onAdapter(tx: Tx, e: Extract<EngineEventBody, { t: 'adapter' }>): void {
  const st = currentProc(tx, e.step, e.spawnNo)
  if (!st) return
  tx.emit({ t: 'ev', step: e.step, attempt: st.attempt, ev: e.ev })
  if (!reacting(st)) {
    // The process is being stopped; an ask it raises now is never shown or answered.
    if (e.ev.type === 'ask') emitAskResolved(tx, e.step, e.ev.requestId, 'stop')
    return
  }
  const ev = e.ev
  switch (ev.type) {
    case 'session':
      recordSession(tx, e.step, ev.id)
      touch(tx, e.step)
      return
    case 'text':
      touch(tx, e.step)
      return
    case 'tool': {
      const id = ev.id ?? ev.name
      if (ev.phase === 'start' && !st.inFlightTools.includes(id)) st.inFlightTools.push(id)
      else if (ev.phase === 'end') st.inFlightTools = st.inFlightTools.filter((x) => x !== id)
      // R4: what Plan reported writing decides whether the plan-end guard runs.
      if (e.step === 'plan') trackPlanTool(st, ev)
      // The context health detectors' tool counters (repeats, rereads, steps without a change, big outputs).
      applyToolEvent((st.context ??= newContextState()), ev)
      // Grounding: what the pass ran and edited (claims against evidence, failed edits, edits to unread files).
      noteGroundingTool(st, ev)
      touch(tx, e.step)
      // Context health: one call repeated too often (the loop card, the hard stop).
      checkLoop(tx, e.step)
      return
    }
    case 'ask':
      onAsk(tx, e.step, ev)
      return
    case 'done':
      onDone(tx, e.step, ev)
      return
    case 'error': {
      if (!ev.fatal) {
        touch(tx, e.step)
        return
      }
      const failure: Failure = {
        category: ev.category ?? 'unknown',
        message: ev.message,
        raw: ev.raw,
        // An unknown category is the classifier's last stage; a known one is structured unless it says otherwise.
        classifiedBy:
          ev.classifiedBy ??
          (ev.category === undefined || ev.category === 'unknown' ? 'heuristic' : 'structured'),
        step: e.step,
      }
      // A limit's reset feeds wait_until (and P16's retry-after rule).
      if (ev.resetsAt !== undefined) failure.resetsAt = ev.resetsAt
      if (ev.retryAfterMs !== undefined) failure.retryAfterMs = ev.retryAfterMs
      failPass(tx, e.step, failure, { ranMs: tx.at - (st.proc?.spawnedAt ?? tx.at) })
      return
    }
  }
}

function sameRule(a: AllowRule, b: AllowRule): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Structural check of an AllowRule that arrived as an untyped `meta` value. */
function asAllowRule(v: unknown): AllowRule | undefined {
  if (!isRecord(v) || !isRecord(v['match'])) return undefined
  const { vendor, kind, tool, source, nativeRules } = v
  const isKind = (k: unknown): k is AskKind => (ASK_KINDS as readonly unknown[]).includes(k)
  if (typeof vendor !== 'string' || !isKind(kind) || typeof tool !== 'string') return undefined
  if (source !== 'exact' && source !== 'vendor-suggestion') return undefined
  if (nativeRules !== undefined && !isStringArray(nativeRules)) return undefined
  const m = v['match']
  const match: AllowRule['match'] = {}
  if (m['argv'] !== undefined) {
    if (!isStringArray(m['argv'])) return undefined
    match.argv = [...m['argv']]
  }
  if (m['argvPrefix'] !== undefined) {
    if (!isStringArray(m['argvPrefix'])) return undefined
    match.argvPrefix = [...m['argvPrefix']]
  }
  if (m['pathGlob'] !== undefined) {
    if (typeof m['pathGlob'] !== 'string') return undefined
    match.pathGlob = m['pathGlob']
  }
  if (m['host'] !== undefined) {
    if (typeof m['host'] !== 'string') return undefined
    match.host = m['host']
  }
  if (Object.keys(match).length === 0) return undefined
  const rule: AllowRule = { vendor, kind, tool, match, source }
  if (nativeRules !== undefined) rule.nativeRules = [...nativeRules]
  return rule
}

/** Claude plan-file hygiene's meta key (adapters/claude/plan-hygiene.ts `META_PLAN_FILES`). */
const META_PLAN_FILES = 'planFiles'

const PLAN_FILE_KEPT: Record<string, string> = {
  'outside-plans-dir': "it is outside Claude's plans folder",
  'older-than-pass': 'it is older than this pass',
  'content-differs': 'it differs from the plan Dim Factory captured',
  'not-a-file': 'it is not a regular file',
  unreadable: 'it could not be read',
  'delete-failed': 'deleting it failed',
}

/**
 * Plan-file hygiene: a plan file Claude left behind that Dim Factory did not delete becomes a run note
 * (`{deleted, kept:[{path, reason}]}`; deletions need no note).
 */
function notePlanFilesKept(tx: Tx, value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value['kept'])) return
  for (const k of value['kept'] as unknown[]) {
    if (!isRecord(k) || typeof k['path'] !== 'string') continue
    const why = typeof k['reason'] === 'string' ? PLAN_FILE_KEPT[k['reason']] : undefined
    const note = `Claude's plan file ${k['path']} was left in place${why !== undefined ? ` (${why})` : ''}.`
    if (!tx.s.notes.includes(note)) tx.note(note)
  }
}

/** Meta `planFallback` `{reason, detail?}`: the Plan step ran emulated; the card says why. */
function notePlanFallback(tx: Tx, st: StepState, value: unknown): void {
  const reason = isRecord(value) && typeof value['reason'] === 'string' ? value['reason'].trim() : ''
  const text = reason !== '' ? reason : 'The vendor refused its plan mode'
  if (st.planMode === 'emulated' && st.planFallbackReason === text) return
  st.planMode = 'emulated'
  st.planFallbackReason = text
  emitStepStatus(tx, st)
}

/**
 * Meta `modelUsed` `{model, replaced?}` (live balanced run): the model a pass that names none runs, as the vendor
 * said (Codex: the model its thread answered with, or the account's default Dim Factory ran in place of `replaced`). The
 * card shows it, and the pass is priced at it. `{model: null}`: the vendor named no model for this spawn, so the card
 * stops expecting one (StepState.modelUnreported). `{asked, replaced}` is the default asked for, not yet confirmed
 * (StepState.modelAsked); `{model, rerouted, replaced?}` is a turn the vendor moved to `model` from
 * `rerouted` (StepState.modelRerouted).
 */
function noteModelUsed(tx: Tx, st: StepState, value: unknown): void {
  if (isRecord(value) && value['model'] === null) {
    if (
      st.modelUnreported === true &&
      st.modelUsed === undefined &&
      st.modelAsked === undefined &&
      st.modelRerouted === undefined
    )
      return
    st.modelUnreported = true
    delete st.modelUsed
    delete st.modelReplaced
    delete st.modelAsked
    delete st.modelRerouted
    emitStepStatus(tx, st)
    return
  }
  const text = (k: string): string => (isRecord(value) && typeof value[k] === 'string' ? value[k].trim() : '')
  const replaced = text('replaced')
  // The default Dim Factory asked for, not yet confirmed (`{asked, replaced}`).
  const asked = isRecord(value) && !('model' in value) ? text('asked') : ''
  if (asked !== '') {
    if (
      st.modelAsked === asked &&
      st.modelUsed === undefined &&
      (st.modelReplaced ?? '') === replaced &&
      st.modelRerouted === undefined
    )
      return
    st.modelAsked = asked
    delete st.modelUsed
    delete st.modelUnreported
    delete st.modelRerouted
    if (replaced !== '' && replaced !== asked) st.modelReplaced = replaced
    else delete st.modelReplaced
    emitStepStatus(tx, st)
    return
  }
  const model = text('model')
  if (model === '') return
  // Codex moved the turn to `model` from `rerouted` (`{model, rerouted, replaced?}`).
  const rerouted = text('rerouted')
  if (
    st.modelUsed === model &&
    (st.modelReplaced ?? '') === replaced &&
    (st.modelRerouted ?? '') === rerouted &&
    st.modelAsked === undefined
  )
    return
  st.modelUsed = model
  delete st.modelUnreported
  delete st.modelAsked
  if (replaced !== '' && replaced !== model) st.modelReplaced = replaced
  else delete st.modelReplaced
  if (rerouted !== '' && rerouted !== model) st.modelRerouted = rerouted
  else delete st.modelRerouted
  emitStepStatus(tx, st)
}

/**
 * The model the vendor names when its session starts (META_SESSION_MODEL, Claude's
 * init) is the model a pass that names none runs. Recorded as META_MODEL_USED would, unless this spawn's model used is
 * already known (the adapter said which, or replaced it); a pass that names its model records nothing.
 */
function noteSessionModel(tx: Tx, st: StepState, value: unknown): void {
  if (st.model !== null || st.modelUsed !== undefined) return
  if (typeof value !== 'string' || value.trim() === '') return
  noteModelUsed(tx, st, { model: value })
}

/** Meta `planSource` `{source, warning?}`: a warning about where the plan came from is a run note. */
function notePlanSource(tx: Tx, value: unknown): void {
  const warning = isRecord(value) && typeof value['warning'] === 'string' ? value['warning'].trim() : ''
  if (warning !== '' && !tx.s.notes.includes(warning)) {
    tx.note(warning)
    tx.transition = true
  }
}

/** Meta `lateAllowRule` `{requestId, rule}`: kept with the timed-out ask it belongs to (P19 "Allow & resume"). */
function recordLateAllowRule(st: StepState, value: unknown): void {
  if (!isRecord(value) || st.timedOutAsk === undefined) return
  if (st.timedOutAsk.requestId !== value['requestId']) return
  const rule = asAllowRule(value['rule'])
  if (rule !== undefined) st.timedOutAsk.rule = rule
}

function onSignal(tx: Tx, e: Extract<EngineEventBody, { t: 'signal' }>): void {
  const st = currentProc(tx, e.step, e.spawnNo)
  if (!st) return
  const sig = e.signal
  const live = reacting(st)
  switch (sig.type) {
    case 'liveness':
      if (live) touch(tx, e.step)
      return
    // The controller acts on these; to the run they say the pass is alive.
    case 'guardrail-blocked':
    case 'shell-command':
      if (live) touch(tx, e.step)
      return
    case 'waiting':
      // The answer waits on background work (shells, sub-agents) the CLI started: the pass is alive, not stalled.
      if (live) touch(tx, e.step)
      return
    case 'context':
    case 'compaction':
    case 'context-breakdown':
    case 'subagent-tokens':
      noteContext(tx, st, sig)
      if (live) touch(tx, e.step)
      return
    case 'ask-withdrawn':
      if (live) onAskWithdrawn(tx, e.step, sig.requestId)
      return
    case 'allow-rule':
      // P8 "persist allow-rule": the run's allow cache, passed back in StartOptions.allowRules.
      if (!tx.s.allowRules.some((r) => sameRule(r, sig.rule))) {
        tx.s.allowRules.push(sig.rule)
        tx.transition = true
      }
      if (live) touch(tx, e.step)
      return
    case 'plan-captured':
      st.planCaptured = sig.markdown
      if (live) touch(tx, e.step)
      return
    case 'auto-answered':
      // P6 (counted for "AUTO approved N")
      addAutoAnswered(st, sig.decision, sig.why)
      // R4: an auto-answered write during Plan counts as a reported write.
      if (
        e.step === 'plan' &&
        (sig.decision === 'allow' || sig.decision === 'allow-session') &&
        isWriteTool(sig.tool)
      ) {
        addPlanWrite(st, `auto:${sig.requestId}`)
      }
      tx.emit({
        t: 'auto-answered',
        step: e.step,
        attempt: st.attempt,
        requestId: sig.requestId,
        tool: sig.tool,
        decision: sig.decision,
        why: sig.why,
      })
      if (live) touch(tx, e.step)
      return
    case 'meta': {
      st.meta[sig.key] = sig.value
      // Adapters send a reason object (e.g. `{reason:'resumed-without-base', source}`); any present value flags.
      const flagged = sig.value !== undefined && sig.value !== null && sig.value !== false
      if (sig.key === META_USAGE_APPROX && flagged) st.usageApprox = true
      if (sig.key === META_RESUME_IGNORED && flagged) {
        const note = 'the CLI ignored --resume and started a fresh session'
        if (st.sessionNote !== note) {
          st.sessionNote = note
          delete st.freshDetail
          emitStepStatus(tx, st)
        }
      }
      if (sig.key === META_LATE_ALLOW_RULE) recordLateAllowRule(st, sig.value)
      if (sig.key === META_PLAN_FILES) notePlanFilesKept(tx, sig.value)
      // A native plan the vendor ran emulated (Codex refused its plan mode before any model call, X12)
      // reads as a fallback on the Plan card ("Fell back to template: …"), never as native.
      if (sig.key === META_PLAN_FALLBACK && e.step === 'plan') notePlanFallback(tx, st, sig.value)
      // "The final message (with a warning)": the warning becomes a run note.
      if (sig.key === META_PLAN_SOURCE && e.step === 'plan') notePlanSource(tx, sig.value)
      // Live balanced run: the model a pass that names none runs is the step's model used.
      if (sig.key === META_MODEL_USED) noteModelUsed(tx, st, sig.value)
      if (sig.key === META_SESSION_MODEL) noteSessionModel(tx, st, sig.value)
      if (sig.key === META_USAGE) {
        // A failed attempt's usage (an error result still bills): it counts toward the run's spend only; the
        // step's `usage` stays the last done attempt's.
        const usage = asUsage(sig.value)
        if (usage !== undefined) {
          addSpend(st, e.spawnNo, usage, passCost(tx, e.step, usage))
          tx.transition = true
        }
      }
      if (live) touch(tx, e.step)
      return
    }
  }
}

/** The controller's facts about a spawn's setup (its prompt size, the catalog window, the project's memory files). */
function onContextFacts(tx: Tx, e: Extract<EngineEventBody, { t: 'context-facts' }>): void {
  const st = currentProc(tx, e.step, e.spawnNo)
  if (!st) return
  const cs = (st.context ??= newContextState())
  cs.facts = e.facts
  emitContext(tx, st)
  tx.transition = true
}

/** A context-family adapter signal: the meter, a compaction, Claude's breakdown, a subagent's tokens. */
function noteContext(tx: Tx, st: StepState, sig: AdapterSignal): void {
  const cs = (st.context ??= newContextState())
  if (!applyContextSignal(cs, sig, tx.at)) return
  emitContext(tx, st)
  if (sig.type === 'context-breakdown') tx.transition = true
  // Context health: a pass that compacted often enough restarts fresh with a summary (a card, or once in Auto).
  if (sig.type === 'compaction' && sig.phase === 'end') checkCompactions(tx, st)
}

// ---- context reactions (restart after compactions, the loop stop) ----------------------------------------------

/** The passes the restart after compactions applies to. */
const RESTARTABLE: ReadonlySet<StepKey> = new Set<StepKey>(['implement', 'fix'])

/**
 * A pass that compacted often enough (Implement or Fix, `restartAfter` compactions, once per pass): Auto restarts it
 * fresh with a summary, spending its automatic retry (a note when that is spent); otherwise the restartFresh card.
 */
function checkCompactions(tx: Tx, st: StepState): void {
  const key = st.key
  if (!isAgentStep(key) || !RESTARTABLE.has(key) || !reacting(st)) return
  const after = contextHealthOf(tx.s).restartAfter
  const n = st.context?.compactions ?? 0
  if (after === null || n < after) return
  const r = (st.reactions ??= {})
  if (r.restart !== undefined) return
  const label = stepLabel(key)
  if (tx.s.config.auto) {
    if (st.autoRetryUsed) {
      r.restart = 'noted'
      tx.note(
        `${label} summarised its notes ${n} times; its automatic retry was already used, so it goes on in the same session.`,
      )
      return
    }
    st.autoRetryUsed = true
    r.restart = 'restarted'
    tx.note(`Auto: restarted ${label} fresh with a summary after ${n} compactions.`)
    restartFresh(tx, key, { reason: `restarting fresh after ${n} compactions`, restart: { compactions: n } })
    return
  }
  r.restart = 'offered'
  openCard(tx, restartFreshCard(nextCardId(tx, 'restartFresh'), key, n), key)
}

/**
 * Stop the pass's process and start it again in a fresh session (a new attempt): context health's restart after
 * compactions (`restart`: its `{{state}}` note) and Auto's retry after a loop stop. A mutating pass takes its pre-retry
 * snapshot once the process has exited, as a failed attempt's retry does.
 */
function restartFresh(
  tx: Tx,
  key: AgentStep,
  o: { reason: string; restart?: { compactions: number }; failure?: Failure },
): void {
  const st = tx.s.steps[key]
  const p = st.proc
  dropAsks(tx, key, 'vendor-cancel', p?.live === true ? { decision: 'cancel' } : undefined)
  clearStepTimers(tx, key)
  resolveStepCards(tx, key, 'stall')
  resolveReactionCards(tx, key)
  if (st.launch?.card !== undefined) resolveCard(tx, st.launch.card)
  if (p !== undefined) {
    p.terminal = true
    if (p.live) tx.push({ t: 'kill', step: key, spawnNo: p.spawnNo })
  }
  nextAttempt(tx, st)
  if (o.failure !== undefined) st.failure = o.failure
  const plan: LaunchPlan = { fresh: {}, ...(o.restart !== undefined ? { restart: { ...o.restart } } : {}) }
  const L: PendingLaunch = { cause: 'retry', plan, preflight: 'todo' }
  if (isMutatingStep(key) && st.startSnap !== undefined)
    L.preSnapshot = { label: 'pre-retry', done: false, attemptEnd: true }
  st.launch = L
  setStatus(tx, st, 'running', { reason: o.reason, force: true })
  pump(tx, key)
}

/** Resolve a pass's open context-health cards (the pass ended, failed, paused or restarted). */
function resolveReactionCards(tx: Tx, key: StepKey): void {
  resolveStepCards(tx, key, 'restartFresh')
  resolveStepCards(tx, key, 'loop')
}

/**
 * One call repeated too often in a pass: at `loopWarnAt` the loop card (Auto: stop and retry fresh once instead), at
 * `loopStopAt` the hard stop (a runaway_loop failure; its snag offers a fresh retry).
 */
function checkLoop(tx: Tx, key: AgentStep): void {
  const st = tx.s.steps[key]
  if (!reacting(st)) return
  const t = st.context?.tools
  const fp = t?.recent[t.recent.length - 1]
  if (t === undefined || fp === undefined) return
  const count = t.fpCounts[fp] ?? 0
  const policy = contextHealthOf(tx.s)
  if (count < policy.loopWarnAt) return
  const loop = ((st.reactions ??= {}).loop ??= { warned: [] })
  if (count >= policy.loopStopAt) {
    loopStop(tx, key)
    return
  }
  // Warned per spawn: a fresh attempt's counters start anew, and so do its warnings.
  const mark = `${st.proc?.spawnNo ?? st.spawnNo}:${fp}`
  if (loop.warned.includes(mark)) return
  loop.warned = [...loop.warned, mark].slice(-50)
  if (tx.s.config.auto) {
    if (loop.retried === true) {
      loopStop(tx, key)
      return
    }
    loop.retried = true
    loop.stoppedSpawn = st.proc?.spawnNo ?? st.spawnNo
    tx.note(
      `Auto: ${stepLabel(key)} kept repeating the same step, so Dim Factory stopped it and retried it fresh.`,
    )
    restartFresh(tx, key, { reason: 'retrying fresh after a loop', failure: loopFailure(key) })
    return
  }
  const tool = t.looping[fp]?.name ?? 'tool'
  openCard(tx, loopCard(nextCardId(tx, 'loop'), key, { tool, count, stopAt: policy.loopStopAt }), key)
}

function loopFailure(key: AgentStep): Failure {
  return { category: 'runaway_loop', message: LOOP_STOP_MESSAGE, raw: '', classifiedBy: 'app', step: key }
}

/** The loop stop: the pass fails as runaway_loop (its process is killed; the snag offers a fresh retry). */
function loopStop(tx: Tx, key: AgentStep): void {
  const st = tx.s.steps[key]
  const loop = ((st.reactions ??= {}).loop ??= { warned: [] })
  loop.stoppedSpawn = st.proc?.spawnNo ?? st.spawnNo
  resolveReactionCards(tx, key)
  failPass(tx, key, loopFailure(key), { noRetry: true })
}

/** restartFresh: [Restart fresh with a summary] restarts the pass (a user click: no budget), [Keep going] goes on. */
function chooseRestartFresh(tx: Tx, c: CardState, choiceId: string): void {
  resolveCard(tx, c.view.id, choiceId)
  const key = c.step
  if (key === undefined || !isAgentStep(key)) return
  const st = tx.s.steps[key]
  if (choiceId !== REACTION_CHOICE.restart) {
    if (st.reactions?.restart === 'offered') st.reactions.restart = 'declined'
    return
  }
  if (!reacting(st)) return
  const n = st.context?.compactions ?? 0
  ;(st.reactions ??= {}).restart = 'restarted'
  tx.note(`Restarted ${stepLabel(key)} fresh with a summary after ${n} compactions.`)
  restartFresh(tx, key, { reason: `restarting fresh after ${n} compactions`, restart: { compactions: n } })
}

/** loop: [Stop] stops the pass now (runaway_loop), [Keep going] goes on (the hard stop still applies). */
function chooseLoop(tx: Tx, c: CardState, choiceId: string): void {
  resolveCard(tx, c.view.id, choiceId)
  const key = c.step
  if (key === undefined || !isAgentStep(key)) return
  if (choiceId === REACTION_CHOICE.stop && reacting(tx.s.steps[key])) loopStop(tx, key)
}

// ---- grounding checks (evidence the pass leaves) -----------------------------------------------------------------

/** What a tool call tells the grounding checks (a shell command run, an edit that failed, a file read). */
function noteGroundingTool(st: StepState, ev: NormalizedEventOf<'tool'>): void {
  if (!isMutatingStep(st.key)) return
  noteTool((st.grounding ??= newGroundingTrack()), ev)
}

/** The throttled `context` body: a new percent point, a compaction beginning or ending, the window becoming known. */
function emitContext(tx: Tx, st: StepState): void {
  if (st.context === undefined) return
  const due = contextEventDue(st.context)
  if (due === undefined) return
  tx.emit({ t: 'context', step: st.key, attempt: st.attempt, ...due })
  tx.transition = true
}

function onExit(tx: Tx, e: Extract<EngineEventBody, { t: 'exit' }>): void {
  const s = tx.s
  const st = currentProc(tx, e.step, e.spawnNo)
  if (!st || !st.proc || !st.proc.live) return
  const p = st.proc
  p.live = false
  tx.clearTimer(timerId.kill(e.step, p.spawnNo))
  tx.transition = true
  if (e.cumulative !== undefined && st.sessionId !== undefined) {
    const prev = s.sessions[st.sessionId]
    s.sessions[st.sessionId] = {
      vendor: prev?.vendor ?? st.vendor ?? passCfg(s, e.step).vendor,
      step: prev?.step ?? e.step,
      lastTotals: e.cumulative,
      ...(prev?.cwd !== undefined ? { cwd: prev.cwd } : {}),
    }
  }
  if (!p.terminal && isLiveStatus(st.status)) {
    p.terminal = true
    failPass(tx, e.step, e.failure ?? exitFailure(e), { ranMs: e.ranMs, fromExit: true })
  }
  if (st.exitSnapshot !== undefined) {
    requestSnapshot(tx, st.exitSnapshot, 'recovery', e.step)
    delete st.exitSnapshot
  }
  syncTimers(tx, e.step)
  pump(tx, e.step)
}

// ---- P15 done ----------------------------------------------------------------------------------------------------

function onDone(tx: Tx, key: AgentStep, ev: NormalizedEventOf<'done'>): void {
  const s = tx.s
  const st = s.steps[key]
  const p = st.proc
  if (!p) return
  p.terminal = true
  resolveStepCards(tx, key, 'stall')
  resolveReactionCards(tx, key)
  dropAsks(tx, key, 'vendor-cancel')
  clearStepTimers(tx, key)
  st.lastEventAt = tx.at
  if (ev.usage !== undefined) {
    const cost = passCost(tx, key, ev.usage)
    // Added before `usage` is replaced: a state from before `spent` existed seeds it from its last usage.
    addSpend(st, p.spawnNo, ev.usage, cost)
    st.usage = ev.usage
    st.cost = cost
    tx.emit({
      t: 'usage',
      step: key,
      attempt: st.attempt,
      usage: ev.usage,
      costBasis: st.cost.basis,
    })
  }
  st.result = ev.result
  if (p.live) armKill(tx, key, p.spawnNo, EXIT_GRACE_MS)
  if (key === 'plan') {
    planDone(tx, ev.result, tx.at - p.spawnedAt)
    return
  }
  if (isMutatingStep(key)) {
    liveCountOff(tx)
    // The Deploy step's answer (what it wrote, what the user must fill in) is kept for its card.
    if (key === 'deploy') writeOutput(tx, 'deploy', ev.result)
    // Test-first: the tests the Tests step mapped to the acceptance criteria (best effort).
    if (key === 'tests') noteTestsMapping(tx, ev.result)
    setStatus(tx, st, 'done')
    st.endSnapStatus = 'requested'
    // Test-first: T1 lists what the Tests step changed (its test files), always; deploy-end the Deploy step's files.
    const from = listsChanged(key) ? st.startSnap?.commit : staleCheckFrom(s, st)
    requestSnapshot(tx, endLabel(key), 'end', key, from)
    // Reconcile(end-of-pass) on the end snapshot (the controller answers it before the snapshot's result).
    requestReconcile(tx, 'end-of-pass', key, { awaitEnd: true })
    return
  }
  if (isReviewerStep(key)) {
    reviewerDone(tx, key, ev.result)
    return
  }
  if (key === 'recheck') {
    recheckDone(tx, ev.result)
    return
  }
  if (key === 'clarify') {
    clarifyDone(tx, ev.result)
    return
  }
  if (key === 'research') {
    researchDone(tx, ev.result)
    return
  }
  if (key === 'acceptance') {
    acceptanceDone(tx, ev.result)
    return
  }
  if (key === 'explain') {
    explainDone(tx, ev.result)
    return
  }
  setStatus(tx, st, 'done')
}

/**
 * The pass's cost, frozen at `done`. `ctx.cost` (catalog/cost.ts, wired by the controller) decides;
 * without it the vendor's own figure counts, and approximate usage has none.
 */
function passCost(tx: Tx, key: AgentStep, usage: Usage): StepCost {
  const st = tx.s.steps[key]
  const approx = st.usageApprox === true
  const configured = st.model !== undefined ? st.model : passCfg(tx.s, key).model
  const priced = tx.ctx.cost?.({
    step: key,
    vendor: st.vendor ?? passCfg(tx.s, key).vendor,
    // Live balanced run: a pass that names no model is priced at the model it ran, when its vendor said which.
    model: configured ?? st.modelUsed ?? null,
    usage,
    usageApprox: approx,
    at: tx.at,
  })
  if (priced !== undefined) return priced
  return !approx && usage.costUsd !== undefined
    ? { usd: usage.costUsd, basis: 'vendor', apiEquivalent: false }
    : { usd: null, basis: 'none', apiEquivalent: false }
}

/**
 * Add one spawn's usage and cost to the step's spend (run totals); each spawn counts once. `spawnNo` null
 * = unknown (recovery.ts projecting `usage` bodies, each a distinct `done` after the run.json checkpoint).
 */
export function addSpend(st: StepState, spawnNo: number | null, usage: Usage, cost: StepCost): void {
  const legacy = st.spent === undefined ? stepSpend(st) : undefined
  const prev = st.spent ?? (legacy !== undefined ? { ...legacy, spawnNo: 0 } : undefined)
  if (prev !== undefined && spawnNo !== null && prev.spawnNo >= spawnNo) return
  const tokens = usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const usd =
    cost.usd === null ? (prev?.usd ?? null) : Math.round(((prev?.usd ?? 0) + cost.usd) * 1e10) / 1e10
  const bases = [...(prev?.bases ?? [])]
  if (cost.usd !== null && !bases.includes(cost.basis)) bases.push(cost.basis)
  st.spent = {
    tokens: (prev?.tokens ?? 0) + tokens,
    usd,
    bases,
    apiEquivalent: (prev?.apiEquivalent ?? false) || (cost.usd !== null && cost.apiEquivalent),
    approx: (prev?.approx ?? false) || st.usageApprox === true,
    spawnNo: spawnNo ?? prev?.spawnNo ?? 0,
  }
}

/** A `Usage` that arrived as an untyped `meta` value (a failed attempt's usage). */
function asUsage(v: unknown): Usage | undefined {
  if (!isRecord(v)) return undefined
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  const { input, output } = v
  if (!num(input) || !num(output)) return undefined
  const u: Usage = { input, output }
  for (const k of ['cacheRead', 'cacheWrite', 'reasoning', 'costUsd'] as const) {
    const x = v[k]
    if (x === undefined) continue
    if (!num(x)) return undefined
    u[k] = x
  }
  return u
}

// ---- P15 read-only ⇒ parse findings ----------------------------------------------------------------------------

/**
 * P15 for Review / Critic: write review.md / critic.md and ask for the findings parse. The step stays `running`
 * (its process is terminal) until `findings-result`, because an empty output retries the pass and a done
 * step never leaves done.
 */
function reviewerDone(tx: Tx, key: ReviewerPass, result: string): void {
  const st = tx.s.steps[key]
  writeOutput(tx, key, result)
  const fs = ensureFindings(tx.s)
  const empties = fs.sources[key]?.emptyOutputs
  fs.sources[key] = {
    status: 'parsing',
    attempt: st.attempt,
    findings: [],
    ...(empties !== undefined ? { emptyOutputs: empties } : {}),
  }
  requestFindings(tx, key)
  tx.transition = true
}

function requestFindings(tx: Tx, key: ReviewerPass): void {
  const st = tx.s.steps[key]
  const spawnNo = st.proc?.spawnNo ?? st.spawnNo
  const req = tx.request({ kind: 'findings', step: key, spawnNo, attempt: st.attempt })
  tx.push({ t: 'parseFindings', req, step: key, attempt: st.attempt, text: st.result ?? '' })
}

/** Waiting only for its findings parse: the vendor finished (`done`), nothing else is in flight. */
function awaitsFindings(s: RunState, key: StepKey): key is ReviewerPass {
  if (!isReviewerStep(key)) return false
  const st = s.steps[key]
  return st.status === 'running' && st.launch === undefined && s.findings?.sources[key]?.status === 'parsing'
}

/** The parser's findings for one source (a pass, or verify): numbering later, ids unique within the source. */
function toFindings(input: readonly FindingInput[], source: FindingSource): Finding[] {
  const seen = new Set<string>()
  return input.map((f) => {
    let id = f.id
    for (let n = 2; seen.has(id); n++) id = `${f.id}-${n}`
    seen.add(id)
    return {
      id,
      n: 0,
      severity: f.severity === 'must' ? 'must' : 'should',
      source,
      title: f.title,
      body: f.body,
      flags: [...(f.flags ?? [])],
      round: f.round ?? 1,
      ...(f.level !== undefined ? { level: f.level } : {}),
    }
  })
}

/**
 * Run & Preview's smoke check of this run: its `[should]` findings (source `preview`) join the run's findings, so the
 * findings list and Re-run from Fix see them. The latest check replaces the earlier one's (no duplicates on a repeat
 * check); a joined run lists them after the join's findings, renumbered, with ids kept clear of the others.
 */
function onPreviewFindings(tx: Tx, e: Extract<EngineEventBody, { t: 'preview-findings' }>): void {
  const s = tx.s
  if (s.findings === undefined && e.findings.length === 0) return
  const fs = ensureFindings(s)
  const prevIds = new Set((fs.preview ?? []).map((f) => f.id))
  const others = fs.list.filter((f) => !prevIds.has(f.id))
  const taken = new Set(others.map((f) => f.id))
  const seenTitles = new Set<string>()
  const next: Finding[] = []
  for (const f of toFindings(e.findings, 'preview')) {
    if (seenTitles.has(f.title)) continue
    seenTitles.add(f.title)
    let id = f.id
    for (let n = 2; taken.has(id); n++) id = `${f.id}-${n}`
    taken.add(id)
    next.push({ ...f, id, severity: 'should' })
  }
  const same = (a: readonly Finding[], b: readonly Finding[]): boolean =>
    a.length === b.length &&
    a.every((f, i) => f.id === b[i]!.id && f.title === b[i]!.title && f.body === b[i]!.body)
  if (same(fs.preview ?? [], next)) return
  if (next.length > 0) fs.preview = next
  else delete fs.preview
  // Only a joined list (one with findings of its own) carries them; before the join, carriedFindings adds them.
  fs.list = others.length > 0 ? [...others, ...next].map((f, i) => ({ ...f, n: i + 1 })) : others
  const nextIds = new Set(next.map((f) => f.id))
  fs.selected = fs.selected.filter((id) => !prevIds.has(id) || nextIds.has(id))
  writeFindingsFile(tx)
  tx.transition = true
}

function onFindingsResult(tx: Tx, e: Extract<EngineEventBody, { t: 'findings-result' }>): void {
  const r = tx.take(e.req)
  if (r === undefined || r.kind !== 'findings') return
  const s = tx.s
  const key = r.step
  const st = s.steps[key]
  const src = s.findings?.sources[key]
  if (s.stop !== undefined || src === undefined || !awaitsFindings(s, key)) return
  if (src.attempt !== r.attempt || (st.proc !== undefined && st.proc.spawnNo !== r.spawnNo)) return
  tx.transition = true
  const findings = toFindings(e.findings, key)
  // A `none` verdict that still lists findings is read as `ok`: findings are never dropped.
  const status = e.status === 'none' && findings.length > 0 ? 'ok' : e.status
  if (status !== 'empty') {
    const next: SourceFindings = { status, attempt: src.attempt, findings }
    if (src.emptyOutputs !== undefined) next.emptyOutputs = src.emptyOutputs
    ensureFindings(s).sources[key] = next
    if (status === 'failed') tx.note(`${stepLabel(key)}'s output could not be read as findings.`)
    setStatus(tx, st, 'done')
    return
  }
  src.status = 'empty'
  src.emptyOutputs = (src.emptyOutputs ?? 0) + 1
  if (!st.autoRetryUsed) {
    // "Empty: retry once (uses the budget)": attempt 2, fresh (a read-only pass), after the old process exits.
    st.autoRetryUsed = true
    nextAttempt(tx, st)
    // A relaunch hold: the retry waits paused for Resume (a fresh read-only spawn then).
    if (holdLaunch(tx, key)) return
    st.launch = { cause: 'retry', plan: freshPlan(tx, key), preflight: 'todo' }
    setStatus(tx, st, 'running', { reason: 'retrying after an empty output', force: true })
    pump(tx, key)
    return
  }
  const facts = { emptyOutputs: src.emptyOutputs, attempt: st.attempt }
  if (s.config.auto) {
    treatAsNone(tx, key)
    tx.note(`Auto: ${stepLabel(key)} ${emptyOutputText(facts)}; treated as no findings.`)
    return
  }
  setStatus(tx, st, 'waiting', { reason: 'empty output' })
  openCard(tx, emptyFindingsCard(nextCardId(tx, 'emptyFindings'), key, facts), key)
}

/** An empty output read as `none` (counts as zero for the skip rule); the step is done. */
function treatAsNone(tx: Tx, key: ReviewerPass): void {
  const st = tx.s.steps[key]
  const fs = ensureFindings(tx.s)
  const empties = fs.sources[key]?.emptyOutputs
  fs.sources[key] = {
    status: 'none',
    attempt: st.attempt,
    findings: [],
    treatedAsNone: true,
    ...(empties !== undefined ? { emptyOutputs: empties } : {}),
  }
  setStatus(tx, st, 'done', { reason: 'empty output treated as no findings' })
}

function chooseEmptyFindings(tx: Tx, c: CardState, choiceId: string): void {
  const key = c.step
  resolveCard(tx, c.view.id, choiceId)
  if (key === undefined || !isReviewerStep(key)) return
  const st = tx.s.steps[key]
  if (st.status !== 'waiting') return
  if (choiceId === CHOICE.treatAsNone) {
    treatAsNone(tx, key)
    return
  }
  // Retry: a user click, so no budget is spent.
  nextAttempt(tx, st)
  startLaunch(tx, key, { cause: 'retry', plan: freshPlan(tx, key), preflight: 'todo' }, { force: true })
}

/** P15 for Plan + R3 / R4. */
function planDone(tx: Tx, result: string, ranMs: number): void {
  const s = tx.s
  const st = s.steps.plan
  const text = normalizePlanText(st.planCaptured ?? result)
  if (text === '') {
    if (st.planMode === 'native' && st.planFallbackReason === undefined) {
      // An empty native plan retries once with the template; no budget is used, the attempt is unchanged.
      startLaunch(tx, 'plan', {
        cause: 'fallback',
        plan: {
          fresh: {},
          planMode: 'emulated',
          planFallbackReason: 'Native plan mode returned an empty plan.',
        },
        preflight: 'todo',
      })
      return
    }
    failPass(
      tx,
      'plan',
      {
        category: 'stream_malformed',
        message: 'The plan was empty.',
        raw: '',
        classifiedBy: 'app',
        step: 'plan',
      },
      { ranMs },
    )
    return
  }
  writeOutput(tx, 'plan', text)
  const insufficient = insufficientContextOf(text)
  if (insufficient !== null) {
    // R3: the card opens even in Auto; the step waits on the user (it is not terminal until the choice).
    s.plan = { decided: false, text: null, edited: false, insufficient }
    setStatus(tx, st, 'waiting', { reason: 'insufficient context' })
    openCard(tx, insufficientContextCard(nextCardId(tx, 'insufficientContext'), insufficient, s.task), 'plan')
    return
  }
  setStatus(tx, st, 'done')
  s.plan = { decided: false, text, original: text, edited: false }
  // R4: the plan-end guard (when Plan reported a write), then the gate.
  afterPlanOutput(tx)
}

function writeOutput(tx: Tx, file: RunOutputFile, text: string): void {
  const version = (tx.s.outputs[file] ?? 0) + 1
  tx.s.outputs[file] = version
  tx.push({ t: 'writeOutput', file, text, version })
  tx.emit({ t: 'output', file, version })
}

// ---- asks (P7–P11) -------------------------------------------------------------------------------------------------

function findAsk(
  s: RunState,
  requestId: string,
): { key: AgentStep; st: StepState; ask: AskState } | undefined {
  for (const key of AGENT_STEPS) {
    const st = s.steps[key]
    const ask = st.asks.find((a) => a.requestId === requestId)
    if (ask) return { key, st, ask }
  }
  return undefined
}

function onAsk(tx: Tx, key: AgentStep, ev: NormalizedEventOf<'ask'>): void {
  const s = tx.s
  const st = s.steps[key]
  if (st.asks.some((a) => a.requestId === ev.requestId)) return
  if (autoApproves(s, key)) {
    // Switched to Auto while this spawn ran in its earlier mode: Auto answers for the user.
    autoApprove(tx, key, ev.requestId)
    touch(tx, key)
    tx.transition = true
    return
  }
  const ask: AskState = {
    requestId: ev.requestId,
    kind: ev.kind,
    detail: ev.detail,
    expiresAt: ev.expiresAt,
    allowSession: ev.allowSession,
    raisedAt: tx.at,
  }
  if (ev.reason !== undefined) ask.reason = ev.reason
  if (ev.defaultToNo !== undefined) ask.defaultToNo = ev.defaultToNo
  st.asks.push(ask)
  st.lastEventAt = tx.at
  if (s.suspendedAt === undefined) tx.armTimer(timerId.ask(key, ev.requestId), ev.expiresAt)
  resolveStepCards(tx, key, 'stall')
  setStatus(tx, st, 'waiting')
  syncTimers(tx, key)
  tx.push({ t: 'notify', kind: 'ask', step: key, requestId: ev.requestId })
  tx.transition = true
}

function removeAsk(tx: Tx, key: AgentStep, requestId: string): void {
  const st = tx.s.steps[key]
  st.asks = st.asks.filter((a) => a.requestId !== requestId)
  tx.clearTimer(timerId.ask(key, requestId))
  tx.clearTimer(timerId.deny(key, requestId))
}

/** P8 / P11 tail: back to running once the queue is empty; timers re-arm from now. */
function afterAskRemoved(tx: Tx, key: AgentStep): void {
  const st = tx.s.steps[key]
  if (st.asks.length === 0 && st.status === 'waiting' && st.proc?.live && !st.proc.terminal) {
    st.lastEventAt = tx.at
    setStatus(tx, st, 'running')
  }
  syncTimers(tx, key)
  tx.transition = true
}

function answerEffect(
  tx: Tx,
  key: AgentStep,
  requestId: string,
  decision: AskDecision,
  why?: AskCancelReason,
): void {
  const p = tx.s.steps[key].proc
  if (!p?.live) return
  tx.push(
    why !== undefined
      ? { t: 'answer', step: key, spawnNo: p.spawnNo, requestId, decision, why }
      : { t: 'answer', step: key, spawnNo: p.spawnNo, requestId, decision },
  )
}

function emitAskResolved(
  tx: Tx,
  key: AgentStep,
  requestId: string,
  by: AskResolvedBy,
  decision?: AskDecision,
  via?: AnswerVia,
): void {
  const body: RunEventBody = { t: 'ask-resolved', step: key, requestId, by }
  if (via !== undefined) body.via = via
  if (decision !== undefined) body.decision = decision
  tx.emit(body)
}

/** Resolve every pending ask of a step. `answer` = the cancel to send (P9b/P10/P18); none for quit / vendor end. */
function dropAsks(
  tx: Tx,
  key: AgentStep,
  by: AskResolvedBy,
  answer?: { decision: 'cancel'; why?: AskCancelReason },
): void {
  const st = tx.s.steps[key]
  for (const a of st.asks) {
    tx.clearTimer(timerId.ask(key, a.requestId))
    tx.clearTimer(timerId.deny(key, a.requestId))
    if (answer) answerEffect(tx, key, a.requestId, answer.decision, answer.why)
    emitAskResolved(tx, key, a.requestId, by, answer?.decision)
  }
  if (st.asks.length > 0) tx.transition = true
  st.asks = []
}

function onAnswer(tx: Tx, cmd: Extract<UserCommand, { kind: 'answer' }>): void {
  const found = findAsk(tx.s, cmd.requestId)
  if (!found) {
    tx.reject('NOT_FOUND', 'This question was already answered or has expired.')
    return
  }
  const { key, st, ask } = found
  if (!reacting(st)) {
    tx.reject('CONFLICT', 'This question can no longer be answered.')
    return
  }
  if (cmd.decision === 'deny') {
    if (ask.pendingDeny) return
    const grace = Math.max(0, cmd.graceMs ?? defaultDenyGraceMs(cmd.via))
    tx.clearTimer(timerId.ask(key, ask.requestId))
    if (grace > 0) {
      // P9
      ask.pendingDeny = { until: tx.at + grace, via: cmd.via }
      tx.armTimer(timerId.deny(key, ask.requestId), ask.pendingDeny.until)
      tx.transition = true
      return
    }
    applyDeny(tx, key, ask, cmd.via)
    return
  }
  // P8 (a pending deny is overridden by a later Allow)
  if (ask.pendingDeny) {
    tx.clearTimer(timerId.deny(key, ask.requestId))
    delete ask.pendingDeny
  }
  const decision = cmd.decision === 'allow-session' && !ask.allowSession ? 'allow' : cmd.decision
  answerEffect(tx, key, ask.requestId, decision)
  emitAskResolved(tx, key, ask.requestId, 'user', decision, cmd.via)
  removeAsk(tx, key, ask.requestId)
  afterAskRemoved(tx, key)
}

/** Grace over: P9a (vendor continues) or P9b (denyPauses). */
function applyDeny(tx: Tx, key: AgentStep, ask: AskState, via: AnswerVia): void {
  if (!tx.s.config.denyPauses) {
    answerEffect(tx, key, ask.requestId, 'deny')
    emitAskResolved(tx, key, ask.requestId, 'user', 'deny', via)
    removeAsk(tx, key, ask.requestId)
    afterAskRemoved(tx, key)
    return
  }
  answerEffect(tx, key, ask.requestId, 'cancel', 'denied')
  emitAskResolved(tx, key, ask.requestId, 'user', 'cancel', via)
  removeAsk(tx, key, ask.requestId)
  dropAsks(tx, key, 'stop', { decision: 'cancel', why: 'denied' })
  pause(tx, key, 'denied', { continuation: CONTINUATION.denied(ask.detail) })
}

function onUndoDeny(tx: Tx, requestId: string): void {
  const found = findAsk(tx.s, requestId)
  if (!found?.ask.pendingDeny) {
    tx.reject('NOT_FOUND', 'There is no deny to undo.')
    return
  }
  const { key, ask } = found
  tx.clearTimer(timerId.deny(key, requestId))
  delete ask.pendingDeny
  if (tx.s.suspendedAt === undefined) tx.armTimer(timerId.ask(key, requestId), ask.expiresAt)
  tx.transition = true
}

function onAskWithdrawn(tx: Tx, key: AgentStep, requestId: string): void {
  const st = tx.s.steps[key]
  if (!st.asks.some((a) => a.requestId === requestId)) return
  removeAsk(tx, key, requestId)
  emitAskResolved(tx, key, requestId, 'vendor-cancel')
  afterAskRemoved(tx, key)
}

// ---- timers ----------------------------------------------------------------------------------------------------------

function onTimer(tx: Tx, id: string, due: number): void {
  const s = tx.s
  if (s.timers[id] !== due) return
  delete s.timers[id]
  // Discard's deferred deletion (a run-level timer).
  if (id === DISCARD_TIMER) {
    onDiscardDue(tx)
    return
  }
  const t = parseTimerId(id)
  if (t === null || !isAgentStep(t.step)) return
  const key = t.step
  const st = s.steps[key]
  switch (t.kind) {
    case 'wait':
      return onWaitDue(tx, key)
    case 'stall': {
      // P12
      if (st.status !== 'running' || !inactivityTimersWanted(st, s.suspendedAt !== undefined).stall) return
      const at = stallDeadline(st, s.config.timeouts)
      if (at === undefined) return
      if (at > tx.at) {
        tx.armTimer(id, at)
        return
      }
      const idle = tx.at - (idleBase(st) ?? tx.at)
      openCard(tx, stallCard(nextCardId(tx, 'stall'), key, idle), key)
      setStatus(tx, st, 'stalled')
      syncTimers(tx, key)
      return
    }
    case 'hard': {
      // P14
      if (!inactivityTimersWanted(st, s.suspendedAt !== undefined).hard) return
      const at = hardDeadline(st, s.config.timeouts)
      if (at === undefined) return
      if (at > tx.at) {
        tx.armTimer(id, at)
        return
      }
      failPass(
        tx,
        key,
        {
          category: 'timeout_hard',
          message: 'No output for too long; Dim Factory stopped the pass.',
          raw: '',
          classifiedBy: 'app',
          step: key,
        },
        { interrupt: true, ranMs: tx.at - (st.proc?.spawnedAt ?? tx.at) },
      )
      return
    }
    case 'ask': {
      // P10. Never while asleep: the resume re-arms it at the shifted expiry.
      const ask = st.asks.find((a) => a.requestId === t.arg)
      if (!ask || ask.pendingDeny || !reacting(st) || s.suspendedAt !== undefined) return
      answerEffect(tx, key, ask.requestId, 'cancel', 'ask-timeout')
      emitAskResolved(tx, key, ask.requestId, 'timeout', 'cancel')
      removeAsk(tx, key, ask.requestId)
      st.timedOutAsk = { requestId: ask.requestId, kind: ask.kind, detail: ask.detail }
      dropAsks(tx, key, 'stop', { decision: 'cancel', why: 'ask-timeout' })
      pause(tx, key, 'ask-timeout', { continuation: CONTINUATION.askTimeout })
      return
    }
    case 'deny': {
      // P9a / P9b
      const ask = st.asks.find((a) => a.requestId === t.arg)
      if (!ask?.pendingDeny || !reacting(st)) return
      const via = ask.pendingDeny.via
      delete ask.pendingDeny
      applyDeny(tx, key, ask, via)
      return
    }
    case 'kill': {
      const p = st.proc
      if (p?.live && String(p.spawnNo) === t.arg) tx.push({ t: 'kill', step: key, spawnNo: p.spawnNo })
      return
    }
    case 'launch':
      pump(tx, key)
      return
  }
}

function onSuspend(tx: Tx): void {
  const s = tx.s
  if (s.suspendedAt !== undefined) return
  s.suspendedAt = tx.at
  for (const key of AGENT_STEPS) {
    const st = s.steps[key]
    tx.clearTimer(timerId.stall(key))
    tx.clearTimer(timerId.hard(key))
    for (const a of st.asks) tx.clearTimer(timerId.ask(key, a.requestId))
    // An armed wait's platform timer may not count the time asleep; the resume arms it again at its own time.
    tx.clearTimer(timerId.wait(key))
  }
}

/**
 * Sleep: shift lastEventAt, keepWaitingAt and each ask's expiresAt by the suspended time; emit ask-extended. Time
 * observed after the suspend (a vendor line that arrived before the resume was seen, an ask raised then) moves only
 * up to now, and the sleep does not count as active time.
 */
function onResumePower(tx: Tx): void {
  const s = tx.s
  const since = s.suspendedAt
  if (since === undefined) return
  const d = Math.max(0, tx.at - since)
  delete s.suspendedAt
  for (const key of STEP_KEYS) {
    const st = s.steps[key]
    if (st.activeSince !== undefined) st.activeSince = Math.min(st.activeSince + d, tx.at)
  }
  for (const key of AGENT_STEPS) {
    const st = s.steps[key]
    if (st.proc?.live) {
      if (st.lastEventAt !== undefined) st.lastEventAt = Math.min(st.lastEventAt + d, tx.at)
      if (st.keepWaitingAt !== undefined) st.keepWaitingAt = Math.min(st.keepWaitingAt + d, tx.at)
    }
    for (const a of st.asks) {
      a.expiresAt += Math.max(0, tx.at - Math.max(a.raisedAt, since))
      tx.emit({ t: 'ask-extended', step: key, requestId: a.requestId, expiresAt: a.expiresAt })
      if (!a.pendingDeny) tx.armTimer(timerId.ask(key, a.requestId), a.expiresAt)
    }
    syncTimers(tx, key, true)
    // An armed wait is a wall-clock deadline (the vendor's reset), not an idle time: it does not move, but its
    // platform timer may have paused while asleep, so it is armed again (a reset that passed while asleep fires now).
    if (st.wait?.armed === true) tx.armTimer(timerId.wait(key), st.wait.until)
  }
  // Discard's deletion is a wall-clock deadline too: armed again (one that passed while asleep fires now).
  const discard = s.isolation?.finalize?.discard
  if (s.isolation?.finalize?.state === 'discarding' && discard !== undefined && discard.removing !== true) {
    delete s.timers[DISCARD_TIMER]
    tx.armTimer(DISCARD_TIMER, discard.deleteAt)
  }
}

// ---- relaunch (P24) / quit (P26) ------------------------------------------------------------------------------------

/**
 * A launch parked on its `retryPartial` card: no process and nothing in flight, only the user's choice. Like gates
 * and other cards it is left as it is by relaunch (crash relaunch) and quit.
 */
function waitsOnCard(st: StepState): boolean {
  return st.launch?.card !== undefined && st.proc?.live !== true
}

/**
 * A process exists or is being launched for the step (P24/P26 "live"). Gates and cards are not live work, and
 * neither is a launch waiting on its retryPartial card.
 */
export function stepIsActive(st: StepState): boolean {
  if (waitsOnCard(st)) return false
  return (
    st.launch !== undefined ||
    st.status === 'running' ||
    st.status === 'stalled' ||
    (st.status === 'waiting' && st.asks.length > 0)
  )
}

function onRelaunch(tx: Tx): void {
  const s = tx.s
  s.timers = {}
  delete s.suspendedAt
  s.liveCount = false
  s.requests = {}
  let anyLive = false
  for (const key of STEP_KEYS) {
    const st = s.steps[key]
    // Armed waits come back disarmed (their timers died with the old process); a running heal with it.
    if (st.wait?.armed === true) {
      st.wait = { actionId: st.wait.actionId, until: st.wait.until, armed: false, disarmed: 'relaunch' }
    }
    if (st.heal?.status === 'running')
      st.heal = { ...st.heal, status: 'failed', error: HEAL_INTERRUPTED, at: tx.at }
    if (st.proc?.live) {
      st.proc.live = false
      st.proc.terminal = true
      anyLive = true
    }
    delete st.exitSnapshot
    // Its card stays open and the launch resumes from the user's choice (the timers re-arm on the next pump).
    if (st.launch !== undefined && waitsOnCard(st)) delete st.launch.req
    // The vendor finished; only the findings parse was outstanding: ask again (the output is in the state).
    if (awaitsFindings(s, key)) {
      requestFindings(tx, key)
      continue
    }
    // Finalize is not paused: an apply that was writing opens interruptedApply (relaunchFinalize below).
    if (key === 'finalize') continue
    if (isTerminalPassStatus(st.status) || !stepIsActive(st)) continue
    anyLive = true
    if (isAgentStep(key)) {
      for (const a of st.asks) emitAskResolved(tx, key, a.requestId, 'stop')
      st.asks = []
    }
    delete st.launch
    delete st.keepWaitingAt
    st.inFlightTools = []
    resolveStepCards(tx, key, 'stall')
    // The dead instance's round never answers; its live rows are settled (Resume reruns the round).
    if (isVerifyRound(key)) settleVerifyRows(st, VERIFY_REASON.interrupted)
    if (key === 'scan') settleScanRows(s, SCAN_REASON.interrupted)
    setStatus(tx, st, 'paused', { pause: 'interrupted' })
  }
  // Run-level boundary work (S1 / S2, the pre-review reconcile, the post-review snapshot, a findings parse) is
  // git or parser work and is re-issued below; the pass it leads to waits for the user's Resume (never auto-resume).
  if (boundaryPending(s)) s.flow.hold = 'interrupted'
  // Run-level work of the dead instance that nothing else would re-issue. Derived from the state, not from its
  // request ids: those are missing when run.json was projected from events.jsonl (recovery.ts).
  if (s.flow.runStart === 'requested') requestSnapshot(tx, 'run-start', 'run-start')
  for (const k of MUTATING_PASSES) {
    const st = s.steps[k]
    if (st.status === 'done' && st.endSnapStatus === 'requested')
      requestSnapshot(
        tx,
        endLabel(k),
        'end',
        k,
        listsChanged(k) ? st.startSnap?.commit : staleCheckFrom(s, st),
      )
  }
  // Write-ahead: a revert that was writing the folder when Dim Factory closed keeps its Undo.
  for (const n of interruptPendingReverts(s)) tx.note(n)
  // R5 write-ahead: a run branch recorded before its ref writes. Adopted at once when HEAD is on it (so R5's
  // reconcile does not read it as a switch); otherwise R5's branch prep settles it.
  if (s.branchPending !== undefined && s.branch === undefined) {
    const req = tx.request({ kind: 'branch', settle: true })
    tx.push({ t: 'branch', req, pending: { ...s.branchPending }, settle: true })
  }
  if (s.stop === undefined && s.outcome === undefined) {
    // A reconcile card left open keeps waiting for the user (its choice reconciles again).
    if (s.flow.review === 'reconcile' && !openReconcileFor(s, 'pre-review'))
      requestReconcile(tx, 'pre-review')
    if (s.flow.review === 'post-review') requestSnapshot(tx, 'post-review', 'post-review')
    // R7: the post-verify-1 snapshot (the reviewers it leads to wait for Resume: the hold above).
    if (s.flow.postVerify1 === 'requested') requestSnapshot(tx, 'post-verify-1', 'post-verify-1')
    // Fix until green: the post-round snapshot (the round it leads to waits for Resume: the hold above).
    if (s.fixLoop?.postRound === 'requested') requestSnapshot(tx, 'post-round', 'post-round')
    // Test-first: the post-red snapshot, and the tests check after Implement.
    if (s.flow.postRed === 'requested') requestSnapshot(tx, 'post-red', 'post-red')
    if (s.testFirst?.guard === 'requested') {
      const t1 = s.steps.tests.endSnap ?? s.snapshots.T1
      const s1 = s.steps.implement.endSnap
      if (t1 !== undefined && s1 !== undefined) {
        const req = tx.request({ kind: 'tests-check' })
        tx.push({ t: 'testsCheck', req, from: t1.commit, to: s1.commit, paths: [...s.testFirst.files] })
      } else delete s.testFirst.guard
    }
    // The grounding checks that were outstanding are asked again (the same pass, the same snapshots).
    for (const [key, c] of Object.entries(s.grounding?.checks ?? {})) {
      if (c.phase !== 'requested') continue
      if (!groundingOn(tx)) {
        c.phase = 'failed'
        continue
      }
      delete s.grounding?.checks[key]
      requestGrounding(tx, key)
    }
    // A [Trust for this project] grant that was being written is written again (the same grant).
    for (const k of VERIFY_ROUNDS) {
      const st = s.steps[k]
      const v = st.verify
      if (v?.phase !== 'trust' || st.status !== 'waiting') continue
      for (const c of v.commands) {
        if (c.decision !== 'granting') continue
        const req = tx.request({ kind: 'trust-grant', step: k, attempt: st.attempt, name: c.name })
        tx.push({
          t: 'trustGrant',
          req,
          command: {
            kind: 'verify',
            argv: [...c.argv],
            cwdRel: c.cwdRel,
            ...(c.body !== null ? { body: c.body } : {}),
          },
        })
      }
    }
    // The same for an audit of the security scan.
    const scan = s.security?.scan
    if (scan?.phase === 'trust' && s.steps.scan.status === 'waiting') {
      for (const a of scan.audits) {
        if (a.decision !== 'granting') continue
        const req = tx.request({ kind: 'scan-grant', attempt: scan.attempt, name: a.name })
        tx.push({ t: 'trustGrant', req, command: auditGrant(a) })
      }
    }
    // An end-of-pass recheck or restore the user chose, lost with the old process: check again.
    for (const k of MUTATING_PASSES) {
      const st = s.steps[k]
      if (st.endCheck === 'hold' && !openReconcileFor(s, 'end-of-pass', k)) {
        requestReconcile(tx, 'end-of-pass', k, { hold: true })
      }
    }
    // R4: the plan-end snapshot (or Revert Plan's changes) was in flight: compare again (a finished revert
    // leaves nothing to show; an unfinished one shows the card again).
    if (s.flow.planEnd === 'requested' || s.flow.planEnd === 'reverting') {
      delete s.flow.planEnd
      planEndGuard(tx)
    }
  }
  if (s.stop?.snapshot === 'requested') requestSnapshot(tx, 'stopped', 'recovery')
  // R12: finalize after a crash (interruptedApply for an apply that was writing; never auto-resumed).
  relaunchFinalize(tx)
  if (anyLive) {
    tx.push({ t: 'sweep' })
    if (s.lock === 'held' && s.flow.runStart !== 'none') requestSnapshot(tx, 'interrupted', 'recovery')
  }
  if (s.lock === 'requested') tx.push({ t: 'lock' })
  tx.transition = true
}

/** Cancel every verify round in flight (Stop, quit). */
function stopVerifyRounds(tx: Tx): void {
  for (const [req, r] of Object.entries(tx.s.requests))
    if (r.kind === 'verify') tx.push({ t: 'verifyStop', req })
}

/** Cancel the prepare stage in flight (Stop, quit): a dependency install's tree is killed. */
function stopPrepare(tx: Tx): void {
  for (const [req, r] of Object.entries(tx.s.requests))
    if (r.kind === 'prepare') tx.push({ t: 'prepareStop', req })
}

function onQuit(tx: Tx): void {
  const s = tx.s
  // Boundary work still answering in this process (or re-issued by the next relaunch) must not launch a pass.
  if (boundaryPending(s)) s.flow.hold = 'interrupted-by-quit'
  // A verify round is killed with the app; Resume reruns it. So is a dependency install.
  stopVerifyRounds(tx)
  stopScans(tx)
  settleScanRows(s, SCAN_REASON.interrupted)
  stopPrepare(tx)
  for (const key of STEP_KEYS) {
    if (unusedStep(s, key)) continue
    const st = s.steps[key]
    // A reviewer waiting only for its findings parse has no live work (relaunch asks for the parse again).
    if (isTerminalPassStatus(st.status) || !stepIsActive(st) || awaitsFindings(s, key)) continue
    // Finalize is not paused (an apply that was writing opens interruptedApply at the next launch).
    if (key === 'finalize') continue
    if (isAgentStep(key)) {
      dropAsks(tx, key, 'stop')
      pause(tx, key, 'interrupted-by-quit', { interrupt: true })
    } else {
      // The round is killed with the app; Resume reruns it from its trust check.
      if (isVerifyRound(key)) settleVerifyRows(st, VERIFY_REASON.interrupted)
      setStatus(tx, st, 'paused', { pause: 'interrupted-by-quit' })
    }
  }
  liveCountOff(tx)
  tx.transition = true
}

// ---- user commands -------------------------------------------------------------------------------------------------

function onUser(tx: Tx, cmd: UserCommand): void {
  switch (cmd.kind) {
    case 'answer':
      return onAnswer(tx, cmd)
    case 'undo-deny':
      return onUndoDeny(tx, cmd.requestId)
    case 'card':
      return chooseCard(tx, cmd.cardId, cmd.choiceId, cmd.input, false)
    case 'keep-waiting':
      return onKeepWaiting(tx, cmd.step)
    case 'stop':
    case 'close':
      return stopRun(tx, cmd.kind)
    case 'resume':
      return onResumeCmd(tx, cmd)
    case 'retry':
      return onRetry(tx, cmd.step, cmd.strategy ?? 'auto', cmd.continuation)
    case 'skip':
      return onSkip(tx, cmd.step)
    case 'config-patch':
      return onConfigPatch(tx, cmd)
    case 'auto-on':
      return onAutoOn(tx, cmd)
    case 'heal':
      return onHealCmd(tx, cmd.step)
    case 'wait':
      return onWaitCmd(tx, cmd.step, cmd.arm)
    case 'revert':
      return onRevertCmd(tx, cmd)
    case 'undo-revert':
      return onUndoRevertCmd(tx, cmd.token)
    case 'apply':
      return onApplyCmd(tx, cmd)
    case 'undo-apply':
      return onUndoApplyCmd(tx, cmd.token)
    case 'discard':
      return onDiscardCmd(tx)
    case 'undo-discard':
      return onUndoDiscard(tx, cmd.token)
  }
}

function onKeepWaiting(tx: Tx, key: AgentStep, viaCard = false): void {
  const st = tx.s.steps[key]
  if (st.status === 'stalled') {
    // P13
    if (!viaCard) resolveStepCards(tx, key, 'stall', CHOICE.keepWaiting)
    st.keepWaitingAt = tx.at
    setStatus(tx, st, 'running')
    syncTimers(tx, key, true)
    return
  }
  if (st.status === 'running' && reacting(st)) {
    st.keepWaitingAt = tx.at
    syncTimers(tx, key, true)
    tx.transition = true
    return
  }
  tx.reject('CONFLICT', 'This pass is not waiting on output.')
}

/** R13 (+ P3 / P18 / P25): changes are kept; the lock is released after the `stopped` snapshot. */
function stopRun(tx: Tx, by: 'stop' | 'close'): void {
  const s = tx.s
  // While finalize is open (the outcome is fixed) Stop still ends the run; its worktree is kept.
  if (s.stop !== undefined || (s.outcome !== undefined && !finalizeOpen(s))) {
    tx.reject('CONFLICT', 'The run has already finished.')
    return
  }
  const f = s.isolation?.finalize
  if (f?.state === 'applying' || f?.state === 'undoing' || (f?.state === 'conflicts' && f.op !== undefined)) {
    tx.reject(
      'CONFLICT',
      'Dim Factory is writing the run into your folder. Stop it once that has finished (it takes a moment).',
    )
    return
  }
  // While the Deploy step holds the outcome, the run already ended without failures (the step only runs then), so a
  // failed Deploy pass is the step's own: Continue without it keeps the held outcome, and Stop cancels the run the
  // same as a Stop while the pass is running, never turning it into a failed run.
  const failed =
    s.deploy?.pending === undefined ? STEP_KEYS.find((k) => s.steps[k].status === 'failed') : undefined
  if (failed !== undefined && s.outcome === undefined) {
    s.outcome = 'failed'
    s.failure = { step: failed, category: s.steps[failed].failure?.category ?? 'unknown' }
  }
  s.stop = { at: tx.at, by, snapshot: 'none' }
  delete s.flow.hold
  // A verify round in flight is cancelled (tree kill); its result still answers the request, so the folder lock
  // is released only once its processes are gone.
  stopVerifyRounds(tx)
  // So is the security scan's audit.
  stopScans(tx)
  settleScanRows(s, SCAN_REASON.stopped)
  // A dependency install is cancelled the same way; finalize keeps the worktree (never deleted on its own).
  stopPrepare(tx)
  stopFinalize(tx)
  for (const key of STEP_KEYS) {
    if (unusedStep(s, key)) continue
    const st = s.steps[key]
    if (isTerminalPassStatus(st.status)) continue
    if (isAgentStep(key)) {
      const p = st.proc
      if (p?.live && !p.terminal) {
        dropAsks(tx, key, 'stop', { decision: 'cancel' })
        tx.push({ t: 'interrupt', step: key, spawnNo: p.spawnNo })
      } else {
        dropAsks(tx, key, 'stop')
      }
      if (p?.live) {
        armKill(tx, key, p.spawnNo)
        p.terminal = true
      }
      clearStepTimers(tx, key)
      delete st.exitSnapshot
    }
    delete st.launch
    st.snagOpen = false
    // The round's result is dropped once the run stopped; its live rows are settled now.
    if (isVerifyRound(key)) settleVerifyRows(st, VERIFY_REASON.stopped)
    setStatus(tx, st, 'cancelled', { reason: SKIP_REASON.user })
  }
  for (const c of [...s.cards]) resolveCard(tx, c.view.id)
  liveCountOff(tx)
  s.endedAt = tx.at
  tx.push({ t: 'notify', kind: 'stopped' })
  tx.transition = true
  if (s.lock === 'requested') {
    s.lock = 'none'
    tx.push({ t: 'unlock' })
  } else if (s.lock === 'held') {
    s.stop.snapshot = s.flow.runStart !== 'none' ? 'todo' : 'none'
  }
}

/** P19 / P20, and runner steps rerun idempotently. */
function onResumeCmd(tx: Tx, cmd: Extract<UserCommand, { kind: 'resume' }>): void {
  const s = tx.s
  // "Resume reruns them idempotently": a failed prepare (a worktree that could not be made) reruns.
  const paused = STEP_KEYS.filter(
    (k) => s.steps[k].status === 'paused' || (k === 'prepare' && s.steps[k].status === 'failed'),
  )
  if (s.stop !== undefined || paused.length === 0) {
    tx.reject('CONFLICT', 'Nothing is paused.')
    return
  }
  releaseHold(tx)
  for (const key of paused) {
    if (isAgentStep(key)) resumePass(tx, key, cmd)
    else resumeRunner(tx, key)
  }
}

function resumePass(tx: Tx, key: AgentStep, cmd: Extract<UserCommand, { kind: 'resume' }>): void {
  const s = tx.s
  const st = s.steps[key]
  const reason = st.pause
  const continuation =
    st.resumeContinuation ?? (reason === 'ask-timeout' ? CONTINUATION.askTimeout : CONTINUATION.interrupted)
  const late = cmd.allowTimedOutAsk === true && st.timedOutAsk !== undefined ? st.timedOutAsk : undefined
  delete st.resumeContinuation
  delete st.timedOutAsk
  // The Deploy step paused before its plan answered (a relaunch, or a hold): it plans again.
  if (key === 'deploy' && s.deploy?.pending !== undefined && s.deploy.phase === 'planning') {
    startDeployPlanning(tx)
    return
  }
  if (st.spawnNo === 0 || (key === 'fix' && fixUnspawned(s))) {
    // Paused before its first spawn (e.g. a relaunch during R5 / R10, or before a Fix round spawned): redo the whole
    // initial pipeline.
    startLaunch(tx, key, initialLaunch(tx, key, 'initial'))
    return
  }
  const can = cmd.canResume?.[key]
  let plan: LaunchPlan
  let preSnapshot: PendingLaunch['preSnapshot']
  if (isMutatingStep(key) && st.sessionId !== undefined && (can?.ok ?? true)) {
    plan = resumePlan(tx, st, st.sessionId, continuation)
    preSnapshot = { label: 'resume', done: false }
  } else {
    const fresh: FreshReason | undefined = !isMutatingStep(key)
      ? undefined
      : st.sessionId === undefined
        ? 'no-session'
        : (can?.reason ?? 'cannot-resume')
    plan = freshPlan(tx, key, fresh)
  }
  if (late !== undefined) {
    // P19: a late Allow becomes an allow-rule of the run (persisted; passed back in StartOptions.allowRules).
    plan.lateAllow = { kind: late.kind, detail: late.detail }
    if (late.rule !== undefined) {
      plan.lateAllow.rule = late.rule
      const rule = late.rule
      if (!s.allowRules.some((r) => sameRule(r, rule))) s.allowRules.push(rule)
    } else {
      tx.note(`Allow & resume: ${late.detail} could not be turned into a rule; the pass may ask again.`)
    }
  }
  const L: PendingLaunch = { cause: 'resume', plan, preflight: 'todo' }
  if (preSnapshot !== undefined) L.preSnapshot = preSnapshot
  startLaunch(tx, key, L)
}

function resumeRunner(tx: Tx, key: StepKey): void {
  const s = tx.s
  const st = s.steps[key]
  if (key === 'preflight') {
    if (s.lock === 'held') startPreflight(tx)
    else requeuePreflight(tx)
    return
  }
  if (key === 'prepare') {
    // The stage it stopped in runs again (an existing worktree is kept).
    resumePrepare(tx)
    return
  }
  // A verify round reruns from its trust check (bodies re-read), idempotently (verify:0 too).
  if (isVerifyRound(key)) {
    startVerify(tx, key)
    return
  }
  // The security scan reruns from its check (what applies, the audits' trust read again).
  if (key === 'scan') {
    startScan(tx)
    return
  }
  // finalize is never paused (relaunchFinalize); nothing else is a runner step.
  setStatus(tx, st, 'failed', { reason: 'capability_missing' })
}

/**
 * P21 (`revert-then-fresh` reverts to the pass's start snapshot first). A `resume` action's `continuation`
 * replaces "Previous attempt failed: …; continue." for a resume retry.
 */
function onRetry(tx: Tx, key: AgentStep, strategy: RetryStrategy, continuation?: string): void {
  const s = tx.s
  const st = s.steps[key]
  if (s.stop !== undefined || st.status !== 'failed') {
    tx.reject('CONFLICT', 'Only a failed pass can be retried.')
    return
  }
  if (strategy === 'resume' && st.sessionId === undefined) {
    tx.reject('CONFLICT', 'There is no session to resume.')
    return
  }
  releaseHold(tx)
  nextAttempt(tx, st)
  st.snagOpen = false
  // Fix that never spawned (in its round) redoes R10 (its session decision included).
  const L: PendingLaunch =
    key === 'fix' && fixUnspawned(s)
      ? initialLaunch(tx, key, 'retry')
      : { cause: 'retry', strategy, preflight: 'todo' }
  if (st.failure !== undefined) L.failure = st.failure
  if (continuation !== undefined && continuation.trim() !== '') L.continuation = continuation
  clearWait(tx, key)
  // Retry after a resume_failed failure is always a new attempt (a fresh start then says so in its "Why?").
  if (st.failure?.category === 'resume_failed') L.freshDetail = 'new-attempt'
  if (isMutatingStep(key) && st.startSnap !== undefined) L.preSnapshot = { label: 'pre-retry', done: false }
  if ((key === 'implement' || key === 'tests') && st.spawnNo === 0) L.reconcile = 'todo'
  startLaunch(tx, key, L, { force: true })
  refreshRunFailure(tx)
}

/** P23: Continue without [plan, review, critic, fix]. */
function onSkip(tx: Tx, key: AgentStep, reason: string = SKIP_REASON.user): void {
  const s = tx.s
  const st = s.steps[key]
  if (key === 'implement') {
    tx.reject('FORBIDDEN', 'Implement cannot be skipped.')
    return
  }
  if (s.stop !== undefined || (st.status !== 'failed' && st.status !== 'paused')) {
    tx.reject('CONFLICT', 'Only a failed or paused pass can be skipped.')
    return
  }
  releaseHold(tx)
  clearStepTimers(tx, key)
  st.snagOpen = false
  delete st.launch
  delete st.resumeContinuation
  delete st.timedOutAsk
  setStatus(tx, st, 'skipped', { reason })
  if (key === 'plan') s.plan = { decided: true, text: null, edited: false }
  refreshRunFailure(tx)
}

// ---- P22 config patches, self-heal, wait_until -----------------------------------------------------------------

/**
 * P22: the checked patch `cmd.config` (the controller applied the ops to its ResolvedConfig) becomes the run's config;
 * `apply-patch` lets the controller swap its copy and record resolved.json `patches[]` before the next effect. A failed
 * pass is then retried (P21), or skipped when the patch turned it off. `auto`: autoApplyConfigPatches did it (the
 * retry spends the pass's automatic retry).
 */
function onConfigPatch(
  tx: Tx,
  cmd: Extract<UserCommand, { kind: 'config-patch' }>,
  o: { auto?: boolean } = {},
): void {
  const s = tx.s
  if (s.stop !== undefined || s.outcome !== undefined) {
    tx.reject('CONFLICT', 'The run has already finished.')
    return
  }
  const key = cmd.step
  if (key !== undefined && s.steps[key].status !== 'failed') {
    tx.reject('CONFLICT', 'Only a failed pass can take this fix.')
    return
  }
  if (key === undefined && AGENT_STEPS.some((k) => isLiveStatus(s.steps[k].status))) {
    tx.reject('CONFLICT', 'A pass is running. Apply this fix once it has stopped.')
    return
  }
  swapConfig(tx, cmd)
  if (key === undefined) {
    tx.note(`Applied "${cmd.label}" to this run.`)
    return
  }
  tx.note(
    o.auto === true
      ? `Self-heal applied "${cmd.label}" and retried ${stepLabel(key)}.`
      : `Applied "${cmd.label}" to this run.`,
  )
  const st = s.steps[key]
  if (o.auto === true) st.autoRetryUsed = true
  if (!passCfg(s, key).enabled && key !== 'implement') {
    // The fix turned the pass off (capability_missing "Turn off <pass>"): the run continues without it.
    onSkip(tx, key, SKIP_REASON.disabled)
    return
  }
  onRetry(tx, key, cmd.strategy ?? 'auto')
}

/**
 * The run takes a patched config (P22 and the switch to Auto): `apply-patch` lets the controller swap its copy and
 * record resolved.json `patches[]` before the next effect.
 */
function swapConfig(
  tx: Tx,
  cmd: { config: RunConfig; patchId: string; entry?: ConfigPatchRecord | undefined },
): void {
  const s = tx.s
  // The run's depth is the run's own, not the config's: it stays (and a Quick run that escalated stays escalated).
  const depth = s.config.depth
  s.config = depth !== undefined ? structuredClone(cmd.config) : cmd.config
  if (depth !== undefined) {
    s.config.depth = structuredClone(depth)
    if (depth.escalated !== undefined) applyEscalation(s.config)
  }
  // Recorded with the transition, before the controller appends it to resolved.json (the next load
  // appends it there if Dim Factory closed in between).
  if (cmd.entry !== undefined) s.configPatches = [...(s.configPatches ?? []), structuredClone(cmd.entry)]
  tx.push({ t: 'apply-patch', patchId: cmd.patchId })
  tx.transition = true
}

/** The passes Auto lets approve everything (config/resolve.ts sets their mode to `full`). */
const AUTO_FULL_PASSES: ReadonlySet<AgentStep> = new Set<AgentStep>(['implement', 'fix'])

/**
 * An ask Auto approves on the run's behalf: one from Implement or Fix in an Auto run whose spawn was launched before
 * the switch (`st.mode` is the spawn's own, not `full`). A spawn launched in Auto asks as it always did.
 */
function autoApproves(s: RunState, key: AgentStep): boolean {
  const st = s.steps[key]
  return s.config.auto && AUTO_FULL_PASSES.has(key) && st.mode !== undefined && st.mode !== 'full'
}

/** An ask approved by Auto: answered `allow`, resolved `by: 'auto'`, counted for "AUTO approved N". */
function autoApprove(tx: Tx, key: AgentStep, requestId: string): void {
  const st = tx.s.steps[key]
  answerEffect(tx, key, requestId, 'allow')
  emitAskResolved(tx, key, requestId, 'auto', 'allow')
  addAutoApproved(st)
}

/**
 * `runs.switchToAuto`: the run goes on in Auto. Later spawns of Implement and Fix launch approving everything and
 * the gates still ahead are skipped; a pass already running keeps its process, so its pending asks are approved now
 * and its later ones as they come (autoApproves). A gate card already open stays for the user.
 */
function onAutoOn(tx: Tx, cmd: Extract<UserCommand, { kind: 'auto-on' }>): void {
  const s = tx.s
  if (s.stop !== undefined || s.outcome !== undefined) {
    tx.reject('CONFLICT', 'The run has already finished.')
    return
  }
  if (s.config.auto) {
    tx.reject('CONFLICT', 'This run is in Auto already.')
    return
  }
  swapConfig(tx, cmd)
  tx.note('Switched to Auto: Implement and Fix approve everything from now on, and the gates are off.')
  for (const key of AGENT_STEPS) {
    if (!autoApproves(s, key)) continue
    const st = s.steps[key]
    const live = st.proc?.live === true && reacting(st)
    for (const a of [...st.asks]) {
      if (!live || a.pendingDeny !== undefined) continue
      autoApprove(tx, key, a.requestId)
      removeAsk(tx, key, a.requestId)
    }
    afterAskRemoved(tx, key)
  }
}

/** `output heal`: StepView.heal changed (the renderer reads the snapshot again). */
function announceHeal(tx: Tx): void {
  const v = (tx.s.outputs.heal ?? 0) + 1
  tx.s.outputs.heal = v
  tx.emit({ t: 'output', file: 'heal', version: v })
  tx.transition = true
}

function startHeal(tx: Tx, key: AgentStep, failure: Failure, trigger: 'auto' | 'user'): void {
  const s = tx.s
  const healId = (s.counters.heal ?? 0) + 1
  s.counters.heal = healId
  s.steps[key].heal = { status: 'running', trigger, at: tx.at, actions: [], hidden: 0, healId }
  tx.push({ t: 'heal', step: key, failure, healId, trigger })
  announceHeal(tx)
}

/** `heal.diagnose` / a `heal` action: "Diagnose with AI" for the failed pass. */
function onHealCmd(tx: Tx, key: AgentStep): void {
  const s = tx.s
  const st = s.steps[key]
  const f = st.failure
  if (s.stop !== undefined || st.status !== 'failed' || !st.snagOpen || f === undefined) {
    tx.reject('CONFLICT', 'Only a failed pass can be diagnosed.')
    return
  }
  if (CATEGORY_INFO[f.category].heal === 'never') {
    tx.reject('FORBIDDEN', 'Dim Factory does not ask AI about this kind of failure.')
    return
  }
  if (st.heal?.status === 'running') {
    tx.reject('CONFLICT', 'A diagnosis is already running.')
    return
  }
  startHeal(tx, key, f, 'user')
}

/** The healer answered: keep its outcome; autoApplyConfigPatches applies its patch through P22 (budget permitting). */
function onHealResult(tx: Tx, e: Extract<EngineEventBody, { t: 'heal-result' }>): void {
  const s = tx.s
  const st = s.steps[e.step]
  if (st.heal === undefined || st.heal.healId !== e.healId || st.heal.status !== 'running') return
  const heal: HealState = { ...e.heal, healId: e.healId }
  if (heal.status === 'running') heal.status = 'failed'
  delete heal.autoApplied
  st.heal = heal
  announceHeal(tx)
  const a = e.autoApply
  if (a === undefined || !isAgentStep(e.step)) return
  if (s.stop !== undefined || s.outcome !== undefined) return
  if (st.status !== 'failed' || !st.snagOpen || st.autoRetryUsed) return
  if (!heal.actions.some((x) => x.id === a.actionId)) return
  heal.autoApplied = a.actionId
  onConfigPatch(
    tx,
    {
      kind: 'config-patch',
      step: e.step,
      config: a.config,
      label: a.label,
      patchId: a.patchId,
      ...(a.entry !== undefined ? { entry: a.entry } : {}),
    },
    { auto: true },
  )
}

function clearWait(tx: Tx, key: AgentStep): void {
  tx.clearTimer(timerId.wait(key))
  delete tx.s.steps[key].wait
}

/**
 * The snag's `wait_until`: Dim Factory arms it on its own only when the template says so (a rate limit) and the pass's
 * automatic retry is unspent; otherwise it is offered disarmed.
 */
function offerWait(tx: Tx, key: AgentStep, actions: readonly RecoveryAction[]): void {
  const st = tx.s.steps[key]
  const w = actions.find((a) => a.kind === 'wait_until')
  if (w === undefined || w.kind !== 'wait_until' || w.disabledReason !== undefined) return
  if (w.armed && !st.autoRetryUsed) {
    st.wait = { actionId: w.id, until: w.until, armed: true, auto: true }
    tx.armTimer(timerId.wait(key), w.until)
  } else {
    st.wait = { actionId: w.id, until: w.until, armed: false, disarmed: 'offered' }
  }
}

/** The armed wait is over: retry the pass (P21). A wait Dim Factory armed spends the automatic retry. */
function onWaitDue(tx: Tx, key: AgentStep): void {
  const s = tx.s
  const st = s.steps[key]
  const w = st.wait
  if (w === undefined || !w.armed || st.status !== 'failed' || !st.snagOpen || s.stop !== undefined) return
  // A platform timer may fire early (a long wait is armed in steps of at most ~24.8 days): not yet, arm again.
  if (tx.at < w.until) {
    tx.armTimer(timerId.wait(key), w.until)
    return
  }
  if (w.auto === true) {
    if (st.autoRetryUsed) {
      st.wait = { actionId: w.actionId, until: w.until, armed: false, disarmed: 'offered' }
      tx.transition = true
      return
    }
    st.autoRetryUsed = true
  }
  tx.note(`The wait is over: retrying ${stepLabel(key)}.`)
  onRetry(tx, key, 'auto')
}

/** `wait_until` executed: arm (re-arm after a relaunch) or disarm the failed pass's wait; toggles without `arm`. */
function onWaitCmd(tx: Tx, key: AgentStep, arm: boolean | undefined): void {
  const s = tx.s
  const st = s.steps[key]
  const w = st.wait
  if (s.stop !== undefined || st.status !== 'failed' || !st.snagOpen || w === undefined) {
    tx.reject('CONFLICT', 'There is no wait to change for this pass.')
    return
  }
  tx.transition = true
  if (!(arm ?? !w.armed)) {
    st.wait = { actionId: w.actionId, until: w.until, armed: false, disarmed: 'user' }
    tx.clearTimer(timerId.wait(key))
    return
  }
  st.wait = { actionId: w.actionId, until: w.until, armed: true }
  if (w.until <= tx.at) {
    // Its time has passed (e.g. re-armed after a relaunch): retry now.
    onRetry(tx, key, 'auto')
    return
  }
  tx.armTimer(timerId.wait(key), w.until)
}

// ---- card choices --------------------------------------------------------------------------------------------------

function chooseCard(
  tx: Tx,
  id: string,
  choiceId: string,
  input: CardChoiceValue | undefined,
  auto: boolean,
): void {
  const s = tx.s
  const c = s.cards.find((x) => x.view.id === id)
  if (!c) {
    if (!auto) tx.reject('NOT_FOUND', 'This card is no longer open.')
    return
  }
  const choice = c.view.choices.find((ch) => ch.id === choiceId)
  if (!choice) {
    tx.reject('VALIDATION', `Unknown choice "${choiceId}".`)
    return
  }
  const takesList =
    choice.input === 'findings' ||
    choice.input === 'paths' ||
    choice.input === 'answers' ||
    choice.input === 'research'
  if (input !== undefined && Array.isArray(input) !== takesList) {
    tx.reject(
      'VALIDATION',
      choice.input === 'findings'
        ? 'This choice takes finding ids.'
        : choice.input === 'paths'
          ? 'This choice takes file paths.'
          : choice.input === 'answers'
            ? 'This choice takes one answer per question.'
            : choice.input === 'research'
              ? 'This choice takes research item ids and answers.'
              : 'This choice takes text.',
    )
    return
  }
  const text = typeof input === 'string' ? input : undefined
  if (auto) tx.note(`Auto: "${c.view.title}" → ${choice.label}`)
  else releaseHold(tx)
  switch (c.view.kind) {
    case 'gate:afterPlan':
      return choosePlanGate(tx, id, choiceId, text)
    case 'insufficientContext':
      return chooseInsufficient(tx, id, choiceId, text)
    case 'gate:beforeFix':
      return chooseBeforeFix(tx, id, choiceId, Array.isArray(input) ? input : undefined)
    case 'emptyFindings':
      return chooseEmptyFindings(tx, c, choiceId)
    case 'preflight':
      resolveCard(tx, id, choiceId)
      if (choiceId === CHOICE.recheck) {
        if (s.lock === 'held') startPreflight(tx)
        else requeuePreflight(tx)
        delete s.failure
      } else stopRun(tx, 'close')
      return
    case 'stall': {
      const step = c.step
      if (choiceId === CHOICE.stop) {
        resolveCard(tx, id, choiceId)
        stopRun(tx, 'stop')
      } else if (step !== undefined && isAgentStep(step)) {
        resolveCard(tx, id, choiceId)
        onKeepWaiting(tx, step, true)
      }
      return
    }
    case 'retryPartial':
      return chooseRetryPartial(tx, c, choiceId)
    case 'planMutated':
      return choosePlanMutated(tx, c, choiceId)
    case 'reconcile':
      return chooseReconcile(tx, c, choiceId)
    case 'trust':
      return chooseTrust(tx, c, choiceId)
    case 'verifyEnv':
      return chooseVerifyEnv(tx, c, choiceId)
    case 'depsConsent':
    case 'depsFailed':
      return chooseDeps(tx, c, choiceId, text)
    case 'finalize':
      return chooseFinalize(tx, c, choiceId)
    case 'finalizeConflicts':
      return chooseConflicts(tx, c, choiceId, Array.isArray(input) ? input : undefined)
    case 'interruptedApply':
      return chooseInterrupted(tx, c, choiceId)
    case 'testsNotRed':
      return chooseTestsNotRed(tx, c, choiceId)
    case 'clarify':
      return chooseClarify(tx, c, choiceId, Array.isArray(input) ? input : undefined)
    case 'research':
      return chooseResearch(tx, c, choiceId, Array.isArray(input) ? input : undefined, auto)
    case 'restartFresh':
      return chooseRestartFresh(tx, c, choiceId)
    case 'loop':
      return chooseLoop(tx, c, choiceId)
  }
}

function choosePlanGate(tx: Tx, id: string, choiceId: string, input: string | undefined): void {
  const s = tx.s
  resolveCard(tx, id, choiceId)
  if (choiceId === CHOICE.cancel) {
    stopRun(tx, 'stop')
    return
  }
  // Approve [+ edits → plan.md + plan.original.md]
  const p = s.plan
  const edited = input?.replace(/\r\n?/g, '\n')
  if (edited !== undefined && edited.trim() !== '' && edited.trim() !== (p.text ?? '').trim()) {
    const original = p.original ?? p.text ?? ''
    if (s.outputs['plan.original'] === undefined) writeOutput(tx, 'plan.original', original)
    writeOutput(tx, 'plan', edited)
    p.text = edited
    p.edited = true
  }
  p.decided = true
}

/**
 * R9: Continue with N (`input` = the finding ids to fix, in any order; none ⇒ the default selection, all;
 * N = 0 → completed(findings-open)) · Skip Fix → completed(findings-open) · Cancel.
 */
function chooseBeforeFix(tx: Tx, id: string, choiceId: string, input: string[] | undefined): void {
  const s = tx.s
  if (choiceId === CHOICE.cancel) {
    resolveCard(tx, id, choiceId)
    stopRun(tx, 'stop')
    return
  }
  const fs = ensureFindings(s)
  let selected = fs.selected
  if (choiceId === CHOICE.continueFix && input !== undefined) {
    const known = new Set(fs.list.map((f) => f.id))
    const unknown = input.find((x) => !known.has(x))
    if (unknown !== undefined) {
      tx.reject('VALIDATION', `Unknown finding "${unknown}".`)
      return
    }
    const want = new Set(input)
    selected = fs.list.filter((f) => want.has(f.id)).map((f) => f.id)
  }
  resolveCard(tx, id, choiceId)
  if (s.flow.fix !== 'gate') return
  if (choiceId === CHOICE.skipFix) {
    finish(tx, 'findings-open', { fix: SKIP_REASON.user })
    return
  }
  fs.selected = selected
  writeFindingsFile(tx)
  if (selected.length === 0) {
    finish(tx, 'findings-open', { fix: SKIP_REASON.noneSelected })
    return
  }
  beginFix(tx)
}

function chooseInsufficient(tx: Tx, id: string, choiceId: string, input: string | undefined): void {
  const s = tx.s
  const st = s.steps.plan
  resolveCard(tx, id, choiceId)
  if (choiceId === CHOICE.cancel) {
    stopRun(tx, 'stop')
    return
  }
  delete s.plan.insufficient
  if (choiceId === CHOICE.proceed) {
    setStatus(tx, st, 'done', { reason: 'proceeded without a plan' })
    s.plan = { decided: true, text: null, edited: false }
    return
  }
  // Edit task & re-plan: a user click, so no retry budget is spent.
  if (input !== undefined && input.trim() !== '') {
    s.task = input
    tx.note('Task edited before re-planning.')
  }
  nextAttempt(tx, st)
  startLaunch(
    tx,
    'plan',
    { cause: 'replan', plan: { fresh: {}, planMode: s.config.planMode }, preflight: 'todo' },
    { force: true },
  )
}

function chooseRetryPartial(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  const key = c.step
  const id = c.view.id
  resolveCard(tx, id, choiceId)
  if (key === undefined || !isAgentStep(key)) return
  const st = s.steps[key]
  const L = st.launch
  if (L === undefined || L.card !== id) return
  delete L.card
  if (choiceId === CHOICE.revertThenFresh) {
    // Revert to the pass's start snapshot (undoable), then fresh (resolveRetry).
    L.strategy = 'revert-then-fresh'
    pump(tx, key)
    return
  }
  if (choiceId === CHOICE.keepChanges) {
    L.plan = freshPlan(tx, key)
    pump(tx, key)
    return
  }
  // Cancel the retry: back to failed with the original snag.
  delete st.launch
  const failure: Failure = L.failure ?? {
    category: 'unknown',
    message: 'Retry cancelled.',
    raw: '',
    classifiedBy: 'app',
    step: key,
  }
  st.failure = failure
  setStatus(tx, st, 'failed', { reason: failure.category })
  openSnag(tx, key, failure)
}

// ---- isolated runs (worktree; the verify:0 baseline; R2/R5/R12) ------------------------------------------------
//
// Prepare (R2 isolated): `setup` (eligibility, `worktree add` from HEAD, copy-ins) first; then Plan ∥ run-start (in the
// worktree) ∥ the rest: deps (installCommand or detection; a `deps` grant, else depsConsent: Auto never installs
// without one), the verify:0 baseline (a verify round of its own) and isolation.verifyReady (verifyEnv before
// Implement). R5 waits for all of it (`flow.prepared: 'all'`).
// Finalize (R12): the outcome is fixed first and never changes. A preview, then the finalize card [Apply to folder]
// [Keep for later] [Discard] (Auto takes Keep for later; autoApply ∧ Auto ∧ no conflicts applies without the card).
// Apply leases the SOURCE folder's lock (FIFO with the runs there), then git/finalize writes it with the journal in
// run.json; conflicts open finalizeConflicts (Keep mine / Take run's, file by file, never a default); a relaunch while
// it wrote opens interruptedApply [Finish apply]. Discard deletes the worktree after 10 s (undoable until then). The
// worktree is never deleted otherwise.

/** The deferred deletion of Discard ("deletion deferred 10 s; undoable"). */
export const DISCARD_DEFER_MS = 10_000

/** Apply records kept for undo (oldest dropped first). */
export const APPLIES_MAX = 20

/** The run-level timer of Discard's deferred deletion. */
export const DISCARD_TIMER = 'discard|finalize'

/** What the prepare step reads while it waits on the user (PassCard and timeline: "Waiting · …"). */
export const PREPARE_WAIT_REASON = {
  consent: 'install consent',
  depsFailed: 'install failed',
  env: VERIFY_WAIT_REASON.env,
} as const

/** What the finalize step reads while it waits. */
export const FINALIZE_WAIT_REASON = {
  choice: 'waiting for your choice',
  folder: 'waiting for the folder',
  conflicts: 'files changed in your folder',
  interrupted: 'apply interrupted',
} as const

/** Why diff.revert is refused for an isolated run (UI copy; the renderer says the same). */
export const ISOLATED_REVERT_TEXT =
  "This run changed only its isolated copy, not your folder. Apply to folder puts its changes in your folder, and that apply's Undo takes them out again."

/** The finalize step's skip reason when the run changed no files (nothing to apply). */
export const FINALIZE_NOTHING_REASON = 'nothing to apply'

/** Prepare rows' details (UI copy, no em dashes). */
export const PREPARE_DETAIL = {
  makingWorktree: 'Making the isolated copy from the last commit.',
  deciding: 'Looking for what to install.',
  consent: 'Waiting for your consent to install.',
  granting: 'Trusting the install command for this project.',
  baseline: 'Running the verify commands before the run changes anything.',
  ready: 'Checking that the verify commands can run here.',
  readyOk: 'The verify commands can run here.',
  readyEnv: 'Some verify commands cannot run here.',
  readySkipped: 'Skipped: verify reports what cannot run when it runs.',
} as const

/** The first prepare row's words while the copy is made: a worktree from the last commit, or a snapshot's files. */
function makingCopyDetail(s: RunState): string {
  return s.copyFrom !== undefined ? MATCH_TEXT.copyDetail : PREPARE_DETAIL.makingWorktree
}

export function isolatedRun(s: RunState): boolean {
  return s.config.isolation === 'worktree'
}

/** RunState.isolation (made with its planned rows when an earlier state has none). */
function iso(s: RunState): IsolationState {
  s.isolation ??= { rows: plannedPrepareRows(s.config) }
  return s.isolation
}

/** One prepare row's status and detail; an `output prepare` body tells the renderer to read the rows again. */
function setRow(tx: Tx, id: PrepareStepId, status: PassStatus, detail?: string): void {
  const r = iso(tx.s).rows.find((x) => x.id === id)
  if (r === undefined || (r.status === status && r.detail === detail)) return
  r.status = status
  if (detail !== undefined) r.detail = detail
  else delete r.detail
  announcePrepare(tx)
}

function announcePrepare(tx: Tx): void {
  const version = (tx.s.outputs.prepare ?? 0) + 1
  tx.s.outputs.prepare = version
  tx.emit({ t: 'output', file: 'prepare', version })
  tx.transition = true
}

/** "3 uncommitted changes not included" (the worktree starts from HEAD). */
export function uncommittedNote(n: number): string {
  return `${plural(n, 'uncommitted change')} not included: the isolated run starts from the last commit.`
}

function depsLine(c: { argv: readonly string[] }): string {
  return c.argv.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

function depsCardInput(c: DepsCommandState): DepsCardInput {
  return {
    manager: c.manager,
    argv: c.argv,
    cwdRel: c.cwdRel,
    source: c.source,
    ...(c.lockfile !== undefined ? { lockfile: c.lockfile } : {}),
  }
}

/** The prepare step goes back to running (a card it waited on was answered). */
function prepareRunning(tx: Tx): void {
  const prep = tx.s.steps.prepare
  if (prep.status !== 'running') setStatus(tx, prep, 'running')
}

// ---- prepare steps 1 and 2 ---------------------------------------------------------------------------------------

function onSetupResult(tx: Tx, e: Extract<EngineEventBody, { t: 'prepare-result' }>): void {
  const s = tx.s
  const I = iso(s)
  if (!e.ok) {
    const f: Failure = e.failure ?? {
      category: 'worktree_failed',
      message: 'Dim Factory could not make the isolated copy.',
      raw: '',
      classifiedBy: 'app',
    }
    setRow(tx, I.worktree === undefined ? 'worktree' : 'copy', 'failed', f.message)
    failRunner(tx, 'prepare', f)
    return
  }
  if (e.worktree !== undefined) I.worktree = { ...e.worktree }
  const wt = I.worktree
  setRow(
    tx,
    'worktree',
    'done',
    wt === undefined
      ? undefined
      : wt.branch === ''
        ? MATCH_TEXT.copyRow
        : `On the branch ${wt.branch}, from ${wt.base.slice(0, 7)}.`,
  )
  if (e.uncommitted !== undefined) {
    I.uncommitted = e.uncommitted
    if (e.uncommitted > 0) addNotes(tx, [uncommittedNote(e.uncommitted)])
  }
  if (e.copied === undefined) setRow(tx, 'copy', 'skipped', PREPARE_SKIP.noCopies)
  else setRow(tx, 'copy', 'done', `${plural(e.copied, 'file')} copied into the isolated copy.`)
  if (e.notes !== undefined) addNotes(tx, e.notes)
  s.flow.prepared = 'setup'
  tx.transition = true
  startDeps(tx)
}

// ---- prepare step 3: deps ------------------------------------------------------------------------------------------

/** Decide what to install (installCommand, the user's edit, or detection) and check its `deps` grant. */
function startDeps(tx: Tx): void {
  const s = tx.s
  const I = iso(s)
  if (s.config.worktree?.install === 'never') {
    I.deps = { phase: 'skipped', installs: I.deps?.installs ?? 0 }
    setRow(tx, 'deps', 'skipped', PREPARE_SKIP.installOff)
    afterDeps(tx)
    return
  }
  const edited = I.deps?.edited
  I.deps = {
    phase: 'deciding',
    installs: I.deps?.installs ?? 0,
    ...(edited !== undefined ? { edited } : {}),
  }
  prepareRunning(tx)
  setRow(tx, 'deps', 'running', PREPARE_DETAIL.deciding)
  requestPrepare(tx, 'rest', edited !== undefined ? { command: edited } : {})
}

function onDepsDecision(tx: Tx, e: Extract<EngineEventBody, { t: 'prepare-result' }>): void {
  const d = tx.s.isolation?.deps
  if (d?.phase !== 'deciding') return
  if (!e.ok) {
    failDeps(tx, { reason: e.failure?.message ?? 'Dim Factory could not work out what to install.' })
    return
  }
  if (e.skip !== undefined || e.deps === undefined || e.deps === null) {
    d.phase = 'skipped'
    setRow(tx, 'deps', 'skipped', e.skip ?? PREPARE_SKIP.nothingToInstall)
    afterDeps(tx)
    return
  }
  d.command = structuredClone(e.deps.command)
  if (e.deps.body !== undefined) d.body = e.deps.body
  else delete d.body
  if (e.deps.trust !== undefined) d.trust = e.deps.trust
  switch (e.deps.trust) {
    case 'trusted':
      startInstall(tx)
      return
    case 'invalid':
      failDeps(tx, {
        reason:
          e.deps.reason ??
          'Dim Factory cannot check everything this command runs, so it does not run it. Edit the command or skip install.',
      })
      return
    case 'untrusted':
    case 'changed':
    case undefined:
      openDepsConsent(tx, e.deps.reason)
  }
}

/** No `deps` grant (or one for other files): depsConsent. Auto takes its default, Skip install. */
function openDepsConsent(tx: Tx, reason?: string): void {
  const s = tx.s
  const d = s.isolation?.deps
  if (d?.command === undefined) return
  d.phase = 'consent'
  const id = nextCardId(tx, 'depsConsent')
  d.cardId = id
  setRow(tx, 'deps', 'waiting', PREPARE_DETAIL.consent)
  setStatus(tx, s.steps.prepare, 'waiting', { reason: PREPARE_WAIT_REASON.consent })
  const trust = d.trust === 'changed' ? 'changed' : d.trust === 'invalid' ? 'invalid' : 'untrusted'
  openCard(
    tx,
    depsConsentCard(id, {
      deps: depsCardInput(d.command),
      trust,
      ...(reason !== undefined ? { reason } : {}),
    }),
    'prepare',
  )
}

function startInstall(tx: Tx): void {
  const d = tx.s.isolation?.deps
  if (d?.command === undefined) return
  d.installs += 1
  d.phase = 'installing'
  delete d.result
  // The install writes in the isolated copy alongside Plan (see onPlanEndSnapshot).
  iso(tx.s).copyWritten = true
  prepareRunning(tx)
  setRow(tx, 'deps', 'running', `Running ${depsLine(d.command)}.`)
  requestPrepare(tx, 'install', { deps: d.command })
}

/** The install's progress: new output in its live log (`output prepare`). Not a transition. */
function onPrepareProgress(tx: Tx, e: Extract<EngineEventBody, { t: 'prepare-progress' }>): void {
  const r = tx.s.requests[e.req]
  if (r?.kind !== 'prepare' || r.stage !== 'install' || e.output !== true) return
  const version = (tx.s.outputs.prepare ?? 0) + 1
  tx.s.outputs.prepare = version
  tx.emit({ t: 'output', file: 'prepare', version })
}

function installFacts(o: InstallOutcome): string {
  const secs = Math.max(0, Math.round(o.durationMs / 1000))
  if (o.timedOut === true) return `timed out after ${secs}s`
  return o.exitCode !== null ? `failed (exit ${o.exitCode})` : 'did not start'
}

function onInstallResult(tx: Tx, e: Extract<EngineEventBody, { t: 'prepare-result' }>): void {
  const d = tx.s.isolation?.deps
  if (d?.phase !== 'installing' || d.command === undefined) return
  const o = e.install
  if (!e.ok || o === undefined) {
    failDeps(tx, { reason: e.failure?.message ?? 'The install could not run.' })
    return
  }
  d.result = { ...o }
  switch (o.status) {
    case 'pass':
      d.phase = 'done'
      setRow(
        tx,
        'deps',
        'done',
        `Installed with ${depsLine(d.command)} in ${Math.max(0, Math.round(o.durationMs / 1000))}s.`,
      )
      afterDeps(tx)
      return
    case 'skipped-untrusted':
      // The grant was gone (or the lockfile changed) right before it spawned: nothing ran, ask again.
      d.trust = 'untrusted'
      openDepsConsent(tx, o.reason)
      return
    case 'fail':
    case 'env':
    case 'skipped':
      failDeps(tx, {
        exitCode: o.exitCode,
        ...(o.timedOut === true ? { timedOut: true } : {}),
        reason: o.reason ?? `The install ${installFacts(o)}.`,
        ...(o.excerpt !== '' ? { excerpt: o.excerpt } : {}),
      })
      return
  }
}

/** depsFailed [Retry] [Edit command] [Skip install] [Cancel]; Auto takes its default, Skip install. */
function failDeps(
  tx: Tx,
  o: { exitCode?: number | null; timedOut?: boolean; reason?: string; excerpt?: string },
): void {
  const s = tx.s
  const I = iso(s)
  const d: DepsState = I.deps ?? { phase: 'failed', installs: 0 }
  I.deps = d
  d.phase = 'failed'
  const id = nextCardId(tx, 'depsFailed')
  d.cardId = id
  setRow(tx, 'deps', 'failed', o.reason ?? 'Installing dependencies failed.')
  setStatus(tx, s.steps.prepare, 'waiting', { reason: PREPARE_WAIT_REASON.depsFailed })
  openCard(
    tx,
    depsFailedCard(id, { ...(d.command !== undefined ? { deps: depsCardInput(d.command) } : {}), ...o }),
    'prepare',
  )
}

/** depsConsent / depsFailed choices. An edited command is checked before the card is answered. */
function chooseDeps(tx: Tx, c: CardState, choiceId: string, input: string | undefined): void {
  const s = tx.s
  if (choiceId === DEPS_CHOICE.editCommand) {
    const line = input?.trim() ?? ''
    if (line === '') {
      tx.reject('VALIDATION', 'Type the install command.')
      return
    }
    const t = tokenizeCommandLine(line)
    if (!t.ok) {
      tx.reject(
        'VALIDATION',
        `Dim Factory runs the install command without a shell: ${t.error.replace(/verify command/g, 'install command')}.`,
      )
      return
    }
  }
  resolveCard(tx, c.view.id, choiceId)
  const d = s.isolation?.deps
  if (d?.cardId !== c.view.id || s.stop !== undefined || s.outcome !== undefined) return
  delete d.cardId
  prepareRunning(tx)
  switch (choiceId) {
    case DEPS_CHOICE.install:
      // Nothing the grant could cover was read: decide again (the controller reads the files now).
      if (d.command === undefined || d.body === undefined) {
        startDeps(tx)
        return
      }
      d.phase = 'granting'
      setRow(tx, 'deps', 'running', PREPARE_DETAIL.granting)
      requestDepsGrant(tx)
      return
    case DEPS_CHOICE.retry:
      if (d.command !== undefined && d.trust === 'trusted') startInstall(tx)
      else startDeps(tx)
      return
    case DEPS_CHOICE.editCommand:
      d.edited = (input ?? '').trim()
      addNotes(tx, [`Install command changed for this run: ${d.edited}`])
      startDeps(tx)
      return
    case DEPS_CHOICE.skipInstall:
      d.phase = 'skipped'
      setRow(tx, 'deps', 'skipped', PREPARE_SKIP.skipped)
      addNotes(tx, ['The isolated copy has no installed dependencies: checks that need them may not run.'])
      afterDeps(tx)
      return
    case DEPS_CHOICE.cancel:
      stopRun(tx, 'stop')
      return
  }
}

function requestDepsGrant(tx: Tx): void {
  const d = tx.s.isolation?.deps
  if (d?.command === undefined || d.body === undefined) return
  const req = tx.request({ kind: 'deps-grant', installs: d.installs })
  // Exactly what the user was shown: a lockfile that changes after this click is not covered.
  tx.push({
    t: 'trustGrant',
    req,
    command: { kind: 'deps', argv: [...d.command.argv], cwdRel: d.command.cwdRel, body: d.body },
  })
}

function onDepsGrantResult(tx: Tx, e: Extract<EngineEventBody, { t: 'trust-grant-result' }>): void {
  const s = tx.s
  const d = s.isolation?.deps
  if (d?.phase !== 'granting' || d.command === undefined || s.stop !== undefined || s.outcome !== undefined)
    return
  tx.transition = true
  if (!e.ok) {
    failDeps(tx, {
      reason: `Dim Factory could not save the trust for the install command: ${e.error ?? 'unknown error'}`,
    })
    return
  }
  d.trust = 'trusted'
  addNotes(tx, [`Trusted the install command ${depsLine(d.command)} for this project.`])
  startInstall(tx)
}

// ---- prepare step 4: the verify:0 baseline ---------------------------------------------------------------------------

/** After deps: the baseline round when the run's config runs it, else step 5. */
function afterDeps(tx: Tx): void {
  const s = tx.s
  const v0 = s.steps['verify:0']
  if (v0.status === 'queued') {
    const skip = skipReason(tx, 'verify:0')
    if (skip === undefined) {
      setRow(tx, 'baseline', 'running', PREPARE_DETAIL.baseline)
      startVerify(tx, 'verify:0')
      return
    }
    setStatus(tx, v0, 'skipped', { reason: skip })
  }
  if (!isTerminalPassStatus(v0.status)) return
  afterBaseline(tx)
}

/** verify:0 is over: its results are the baseline map (verify/baseline.json), never findings. */
function completeBaseline(tx: Tx): void {
  const s = tx.s
  const st = s.steps['verify:0']
  const v = st.verify
  const baseline: Record<string, 'pass' | 'fail' | 'env'> = {}
  for (const c of v?.commands ?? []) {
    if (c.status === 'pass' || c.status === 'fail' || c.status === 'env') baseline[c.name] = c.status
  }
  iso(s).baseline = baseline
  tx.push({ t: 'writeBaseline', baseline: { ...baseline } })
  const values = Object.values(baseline)
  const ran = values.some((x) => x === 'pass' || x === 'fail')
  if (ran) setStatus(tx, st, 'done')
  else setStatus(tx, st, 'skipped', { reason: values.length === 0 ? 'no command ran' : 'could not run here' })
  const fails = values.filter((x) => x === 'fail').length
  const passes = values.filter((x) => x === 'pass').length
  setRow(
    tx,
    'baseline',
    ran ? 'done' : 'skipped',
    !ran
      ? 'No baseline: no command could run.'
      : fails > 0
        ? `${plural(fails, 'check')} already ${fails === 1 ? 'fails' : 'fail'} before the run (${passes} pass).`
        : `All ${plural(passes, 'check')} pass before the run.`,
  )
  if (fails > 0) {
    const names = Object.entries(baseline)
      .filter(([, x]) => x === 'fail')
      .map(([n]) => n)
    addNotes(tx, [
      `Already failing before this run: ${names.join(', ')}. These are listed as should, not must, and do not make the run fail.`,
    ])
  }
  afterBaseline(tx)
}

// ---- prepare step 5: isolation.verifyReady ---------------------------------------------------------------------------

function afterBaseline(tx: Tx): void {
  const s = tx.s
  const I = iso(s)
  if (!s.config.verify.enabled) {
    I.ready = { phase: 'skipped' }
    prepareDone(tx)
    return
  }
  I.ready = { phase: 'checking' }
  prepareRunning(tx)
  setRow(tx, 'ready', 'running', PREPARE_DETAIL.ready)
  requestPrepare(tx, 'ready')
}

function onReadyResult(tx: Tx, e: Extract<EngineEventBody, { t: 'prepare-result' }>): void {
  const s = tx.s
  const I = iso(s)
  if (I.ready?.phase !== 'checking') return
  if (!e.ok) {
    // A check that cannot run is no reason to stop the run: the rounds say what cannot run when they run.
    addNotes(tx, [
      `Dim Factory could not check that the verify commands can run in the isolated copy: ${e.failure?.message ?? 'unknown error'}`,
    ])
    I.ready = { phase: 'done' }
    setRow(tx, 'ready', 'done', PREPARE_DETAIL.readySkipped)
    prepareDone(tx)
    return
  }
  const missing = e.missing ?? []
  if (missing.length === 0) {
    I.ready = { phase: 'done' }
    setRow(tx, 'ready', 'done', PREPARE_DETAIL.readyOk)
    prepareDone(tx)
    return
  }
  // run.isolation.verifyReady: "failure opens verifyEnv before Implement".
  const id = nextCardId(tx, 'verifyEnv')
  I.ready = { phase: 'env', cardId: id, skipped: missing.map((m) => m.name) }
  setRow(tx, 'ready', 'waiting', PREPARE_DETAIL.readyEnv)
  setStatus(tx, s.steps.prepare, 'waiting', { reason: PREPARE_WAIT_REASON.env })
  openCard(
    tx,
    verifyEnvCard(id, {
      step: 'prepare',
      commands: missing.map((m) => ({
        name: m.name,
        argv: [...m.argv],
        exitCode: null,
        ...(m.reason !== undefined ? { reason: m.reason } : {}),
      })),
    }),
    'prepare',
  )
}

/**
 * The readiness card: [Retry] checks again; [Skip verify] goes on, and the rounds report those commands as not run
 * when they cannot run there either, without asking again.
 */
function chooseReadyEnv(tx: Tx, cardId: string, choiceId: string): void {
  const I = tx.s.isolation
  if (I?.ready?.phase !== 'env' || I.ready.cardId !== cardId) return
  if (choiceId === VERIFY_ENV_CHOICE.retry) {
    afterBaseline(tx)
    return
  }
  I.ready = { phase: 'done', skipped: [...(I.ready.skipped ?? [])] }
  setRow(tx, 'ready', 'skipped', PREPARE_DETAIL.readySkipped)
  addNotes(tx, [
    'Went on although some verify commands cannot run in the isolated copy: they read "not run" when verify runs.',
  ])
  prepareDone(tx)
}

/** The env failures of a round that the readiness card's [Skip verify] already covered. */
function readySkippedAll(s: RunState, env: readonly VerifyCommandState[]): boolean {
  const skipped = s.isolation?.ready?.skipped ?? []
  return env.length > 0 && env.every((c) => skipped.includes(c.name))
}

/** Steps 3 to 5 are over: R5 (Implement) may go on. */
function prepareDone(tx: Tx): void {
  const s = tx.s
  s.flow.prepared = 'all'
  const prep = s.steps.prepare
  if (!isTerminalPassStatus(prep.status)) setStatus(tx, prep, 'done')
  tx.transition = true
}

/**
 * Resume (or Retry) of the prepare step: the stage it stopped in runs again. Idempotent: an existing worktree is kept
 * (setup only copies again), a granted install installs again, a card still open keeps waiting.
 */
function resumePrepare(tx: Tx): void {
  const s = tx.s
  const prep = s.steps.prepare
  const I = iso(s)
  delete prep.failure
  prep.snagOpen = false
  if (prep.attempt === 0) prep.attempt = 1
  setStatus(tx, prep, 'running', { force: true })
  refreshRunFailure(tx)
  if (s.flow.prepared === 'none') {
    if (I.worktree === undefined) setRow(tx, 'worktree', 'running', makingCopyDetail(s))
    requestPrepare(tx, 'setup')
    return
  }
  const d = I.deps
  switch (d?.phase) {
    case undefined:
    case 'deciding':
      startDeps(tx)
      return
    case 'granting':
      requestDepsGrant(tx)
      return
    case 'installing':
      startInstall(tx)
      return
    case 'consent':
    case 'failed':
      // Its card is still open: the step waits on it.
      setStatus(tx, prep, 'waiting', {
        reason: d.phase === 'consent' ? PREPARE_WAIT_REASON.consent : PREPARE_WAIT_REASON.depsFailed,
      })
      return
    case 'done':
    case 'skipped':
      break
  }
  const v0 = s.steps['verify:0']
  if (v0.status === 'queued') {
    afterDeps(tx)
    return
  }
  // A paused baseline is resumed as a runner step of its own; its end goes on to step 5.
  if (!isTerminalPassStatus(v0.status)) return
  if (I.ready?.phase === 'env') {
    setStatus(tx, prep, 'waiting', { reason: PREPARE_WAIT_REASON.env })
    return
  }
  afterBaseline(tx)
}

// ---- R12 finalize -----------------------------------------------------------------------------------------------

/** The outcome is fixed and the finalize step has not finished (the run is not completed yet). */
export function finalizeOpen(s: RunState): boolean {
  return (
    s.isolation?.finalize !== undefined &&
    s.outcome !== undefined &&
    s.stop === undefined &&
    s.endedAt === undefined
  )
}

function fin(s: RunState): FinalizeRunState | undefined {
  return s.isolation?.finalize
}

/**
 * The finalize step's status, unless the run has ended: a stopped run keeps its step cancelled, and a completed one
 * keeps the step as it completed (a later apply or undo from the Diff tab shows in its finalize view only).
 */
function finalizeStep(tx: Tx, status: PassStatus, reason?: string): void {
  if (tx.s.stop !== undefined || tx.s.endedAt !== undefined) return
  const st = tx.s.steps.finalize
  if (st.attempt === 0) st.attempt = 1
  setStatus(tx, st, status, reason !== undefined ? { reason } : {})
}

/** R12: the outcome is fixed; the finalize step runs (its preview first). Without a worktree there is nothing to do. */
function beginFinalize(tx: Tx, outcome: RunOutcome): void {
  const s = tx.s
  const I = iso(s)
  const st = s.steps.finalize
  if (I.worktree === undefined) {
    setStatus(tx, st, 'skipped', { reason: 'no isolated copy' })
    complete(tx, outcome)
    return
  }
  s.outcome = outcome
  delete s.flow.hold
  // The checklist as the outcome is fixed (an isolated run completes later, after finalize).
  if ((s.acceptance?.criteria.length ?? 0) > 0) writeAcceptance(tx)
  I.finalize = { state: 'preview', lease: 'none', applies: [], applyNo: 0 }
  finalizeStep(tx, 'running')
  requestFinalize(tx, { op: 'preview' })
  tx.transition = true
}

type FinalizeRequest =
  | { op: 'preview' }
  | { op: 'remove' }
  | { op: 'undo'; token: string }
  | {
      op: 'apply'
      no: number
      paths?: string[]
      resolutions?: Record<string, 'mine' | 'theirs'>
      resume?: true
    }

function requestFinalize(tx: Tx, o: FinalizeRequest): void {
  switch (o.op) {
    case 'preview': {
      const req = tx.request({ kind: 'finalize', op: 'preview' })
      tx.push({ t: 'finalizePreview', req })
      return
    }
    case 'remove': {
      const req = tx.request({ kind: 'finalize', op: 'remove' })
      tx.push({ t: 'removeWorktree', req })
      return
    }
    case 'undo': {
      const req = tx.request({ kind: 'finalize', op: 'undo', token: o.token })
      tx.push({ t: 'undoApply', req, token: o.token })
      return
    }
    case 'apply': {
      const req = tx.request({ kind: 'finalize', op: 'apply', no: o.no })
      tx.push({
        t: 'apply',
        req,
        no: o.no,
        ...(o.paths !== undefined ? { paths: [...o.paths] } : {}),
        ...(o.resolutions !== undefined ? { resolutions: { ...o.resolutions } } : {}),
        ...(o.resume === true ? { resume: true as const } : {}),
      })
      return
    }
  }
}

function onFinalizePreview(tx: Tx, e: Extract<EngineEventBody, { t: 'finalize-preview' }>): void {
  const r = tx.take(e.req)
  if (r?.kind !== 'finalize' || r.op !== 'preview') return
  const s = tx.s
  const f = fin(s)
  if (f?.state !== 'preview' || s.stop !== undefined) return
  tx.transition = true
  if (e.failure !== undefined)
    f.error = `Dim Factory could not read what Apply would change: ${e.failure.message}`
  else delete f.error
  if (e.files !== undefined) f.files = e.files
  f.conflicts = (e.conflicts ?? []).map((c) => ({ ...c }))
  // A run that changed no files in its copy has nothing to apply: no card, no "not applied" chip.
  if (e.failure === undefined && e.files === 0 && f.conflicts.length === 0) {
    nothingToApply(tx)
    return
  }
  // autoApply ∧ Auto ∧ no conflicts → apply without the card.
  if (
    s.config.auto &&
    s.config.worktree?.autoApply === true &&
    e.failure === undefined &&
    f.conflicts.length === 0
  ) {
    startApply(tx, { auto: true })
    return
  }
  // A rematch's side started from an old state of the folder: it is kept to be read, never offered to be applied.
  if (s.matchOf?.rematch === true) {
    keepIsolated(tx)
    addNotes(tx, [MATCH_TEXT.notApplied])
    return
  }
  openFinalizeCard(tx)
}

function openFinalizeCard(tx: Tx): void {
  const s = tx.s
  const f = fin(s)
  if (f === undefined) return
  f.state = 'pending'
  finalizeStep(tx, 'waiting', FINALIZE_WAIT_REASON.choice)
  if (s.cards.some((c) => c.view.kind === 'finalize')) return
  const wt = s.isolation?.worktree
  openCard(
    tx,
    finalizeCard(nextCardId(tx, 'finalize'), {
      folder: s.folder,
      ...(wt !== undefined && wt.branch !== '' ? { branch: wt.branch } : {}),
      ...(f.files !== undefined ? { files: f.files } : {}),
      conflicts: f.conflicts ?? [],
      ...(f.error !== undefined ? { error: f.error } : {}),
    }),
    'finalize',
  )
}

/** The finalize card: Apply to folder · Keep for later · Discard. */
function chooseFinalize(tx: Tx, c: CardState, choiceId: string): void {
  const s = tx.s
  resolveCard(tx, c.view.id, choiceId)
  const f = fin(s)
  if (f?.state !== 'pending' || s.stop !== undefined) return
  switch (choiceId) {
    case FINALIZE_CHOICE.apply:
      startApply(tx, {})
      return
    case FINALIZE_CHOICE.keep:
      keepIsolated(tx)
      return
    case FINALIZE_CHOICE.discard:
      startDiscard(tx)
      return
  }
}

/** The run completes once finalize is over (Apply, Discard, Keep for later), unless it ended before. */
function completeAfterFinalize(tx: Tx): void {
  const s = tx.s
  // Never while an apply that stopped part way waits for [Finish apply].
  if (s.cards.some((c) => c.view.kind === 'interruptedApply')) return
  if (s.endedAt === undefined && s.stop === undefined && s.outcome !== undefined) complete(tx, s.outcome)
}

/** Nothing to apply (the run changed no files): finalize skipped, the run completes; the copy stays until discarded. */
function nothingToApply(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined) return
  f.state = 'kept'
  f.files = 0
  finalizeStep(tx, 'skipped', FINALIZE_NOTHING_REASON)
  addNotes(tx, [
    "The run changed no files in its isolated copy, so there is nothing to apply. Discard the copy from the run's Diff tab when you no longer need it.",
  ])
  completeAfterFinalize(tx)
}

/** Keep for later: finalize skipped(kept); the run completes and its worktree stays ("Isolated: not applied"). */
function keepIsolated(tx: Tx): void {
  const s = tx.s
  const f = fin(s)
  if (f === undefined) return
  f.state = 'kept'
  finalizeStep(tx, 'skipped', 'kept')
  addNotes(tx, [
    `Kept the isolated copy for later: its changes are not in ${s.folder}. Apply or discard it from the run's Diff tab.`,
  ])
  completeAfterFinalize(tx)
}

/** Finalize is done (applied or discarded): the run completes when it had not yet. */
function finalizeDone(tx: Tx, state: 'applied' | 'discarded'): void {
  const f = fin(tx.s)
  if (f === undefined) return
  f.state = state
  finalizeStep(tx, 'done', state)
  completeAfterFinalize(tx)
}

/** Apply (the card, Finish apply, autoApply, worktree.apply): lease the SOURCE folder's lock first. */
function startApply(
  tx: Tx,
  o: {
    paths?: string[]
    resolutions?: Record<string, 'mine' | 'theirs'>
    resume?: true
    ipc?: true
    auto?: true
  },
): void {
  const f = fin(tx.s)
  if (f === undefined) return
  f.applyNo += 1
  const op: FinalizeOp = { kind: 'apply', no: f.applyNo, from: f.state }
  if (o.paths !== undefined) op.paths = [...o.paths]
  if (o.resolutions !== undefined) op.resolutions = { ...o.resolutions }
  if (o.resume === true) op.resume = true
  if (o.ipc === true) op.ipc = true
  f.op = op
  if (o.auto === true)
    addNotes(tx, ['Auto applied the run to your folder (autoApply, and no file conflicts).'])
  delete f.error
  delete f.failedNo
  requestLease(tx)
}

/** The SOURCE folder's lease (FIFO with the runs there); the operation starts once it is granted. */
function requestLease(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined) return
  if (f.state !== 'conflicts') f.state = 'waiting'
  finalizeStep(tx, 'running', FINALIZE_WAIT_REASON.folder)
  tx.transition = true
  if (f.lease === 'held') {
    leaseGranted(tx)
    return
  }
  if (f.lease === 'none') {
    f.lease = 'requested'
    tx.push({ t: 'lease' })
  }
}

function releaseLease(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined || f.lease === 'none') return
  f.lease = 'none'
  tx.push({ t: 'unlease' })
}

function onLeaseAcquired(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined || f.lease !== 'requested') {
    // A grant that crossed our `unlease` (or one for nothing): hand it straight back.
    tx.push({ t: 'unlease' })
    return
  }
  f.lease = 'held'
  tx.transition = true
  leaseGranted(tx)
}

/** Write-ahead: `applying` / `undoing` reaches run.json (a transition) before the effect writes anything. */
function leaseGranted(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined) return
  const op = f.op
  if (op === undefined) {
    releaseLease(tx)
    return
  }
  finalizeStep(tx, 'running')
  if (op.kind === 'apply') {
    if (f.state !== 'conflicts') f.state = 'applying'
    requestFinalize(tx, {
      op: 'apply',
      no: op.no,
      ...(op.paths !== undefined ? { paths: op.paths } : {}),
      ...(op.resolutions !== undefined ? { resolutions: op.resolutions } : {}),
      ...(op.resume === true ? { resume: true as const } : {}),
    })
  } else {
    f.state = 'undoing'
    requestFinalize(tx, { op: 'undo', token: op.token })
  }
  tx.transition = true
}

/** An apply or undo is on its way (waiting for the lease, or its effect in flight). */
function applyBusy(f: FinalizeRunState | undefined): boolean {
  return f?.op !== undefined
}

function onApplyResult(tx: Tx, e: Extract<EngineEventBody, { t: 'apply-result' }>): void {
  const r = tx.take(e.req)
  if (r?.kind !== 'finalize' || r.op !== 'apply') return
  const s = tx.s
  const f = fin(s)
  const op = f?.op
  if (f === undefined || op?.kind !== 'apply' || op.no !== r.no) return
  delete f.op
  releaseLease(tx)
  tx.transition = true
  if (e.failure !== undefined) {
    f.error = e.failure.message
    f.failedNo = op.no
    if (e.interrupted === true) {
      // The journal knows how far it got: Finish apply carries on without writing a file twice.
      f.resume = resumeOf(op)
      addNotes(tx, [`Applying the run to the folder stopped part way: ${e.failure.message}`])
      openInterrupted(tx, e.failure.message)
      return
    }
    // Nothing was written: back to where the apply was asked for, saying why.
    addNotes(tx, [`The run was not applied to the folder: ${e.failure.message}`])
    applyFailedBack(tx, op.from)
    return
  }
  const applied = e.applied ?? []
  const found = (e.conflicts ?? []).map((c) => ({ ...c }))
  delete f.resume
  if (e.notes !== undefined) addNotes(tx, e.notes)
  if (e.undoToken !== undefined) {
    const rec: ApplyRecord = {
      no: op.no,
      token: e.undoToken,
      at: tx.at,
      applied: [...applied],
      conflicts: found.map((c) => c.path),
    }
    f.applies = [...f.applies.filter((x) => x.token !== rec.token), rec].slice(-APPLIES_MAX)
  }
  if (applied.length > 0) {
    addNotes(tx, [
      `Applied ${plural(applied.length, 'file')} to the folder (Undo puts them back): ${pathListShort(applied)}.`,
    ])
  } else if (found.length === 0 && op.paths === undefined) {
    addNotes(tx, ["Nothing needed applying: the folder already has the run's changes."])
  }
  // Conflicts still to decide: earlier ones this apply did not cover, and those it found.
  const partial = op.paths !== undefined || op.resolutions !== undefined
  const covered = new Set([...(op.paths ?? []), ...Object.keys(op.resolutions ?? {}), ...applied])
  const earlier = partial ? (f.conflicts ?? []).filter((c) => !covered.has(c.path)) : []
  const open = [...earlier, ...found.filter((c) => !earlier.some((x) => x.path === c.path))]
  f.conflicts = open
  resolveKinds(tx, 'interruptedApply')
  if (open.length > 0) {
    openConflicts(tx)
    return
  }
  resolveKinds(tx, 'finalizeConflicts')
  finalizeDone(tx, 'applied')
}

/** finalizeConflicts: opened, or rebuilt in place with the files still to decide (the card keeps its id). */
function openConflicts(tx: Tx): void {
  const s = tx.s
  const f = fin(s)
  if (f === undefined) return
  f.state = 'conflicts'
  finalizeStep(tx, 'waiting', FINALIZE_WAIT_REASON.conflicts)
  const list = f.conflicts ?? []
  const open = s.cards.find((c) => c.view.kind === 'finalizeConflicts')
  if (open !== undefined) {
    open.view = finalizeConflictsCard(open.view.id, list)
    tx.emit({ t: 'card', card: open.view, state: 'open' })
    tx.transition = true
    return
  }
  openCard(tx, finalizeConflictsCard(nextCardId(tx, 'finalizeConflicts'), list), 'finalize')
}

/** Keep mine (nothing is written) / Take run's (an apply of those files with `theirs`), file by file or all. */
function chooseConflicts(tx: Tx, c: CardState, choiceId: string, input: string[] | undefined): void {
  const s = tx.s
  const f = fin(s)
  if (f === undefined || f.state !== 'conflicts') {
    resolveCard(tx, c.view.id, choiceId)
    return
  }
  if (applyBusy(f)) {
    tx.reject('CONFLICT', 'Dim Factory is applying files to your folder. Choose again when it has finished.')
    return
  }
  // An apply that stopped part way may have written some of these files already: it is finished first, and its
  // result says which files are still to decide.
  if (s.cards.some((x) => x.view.kind === 'interruptedApply')) {
    tx.reject(
      'CONFLICT',
      'An apply to your folder stopped part way. Finish it first (Finish apply), then choose.',
    )
    return
  }
  const all = (f.conflicts ?? []).map((x) => x.path)
  const paths = input === undefined || input.length === 0 ? all : input
  const unknown = paths.find((p) => !all.includes(p))
  if (unknown !== undefined) {
    tx.reject('VALIDATION', `${unknown} is not one of the files to decide.`)
    return
  }
  if (choiceId === CONFLICT_CHOICE.takeTheirs) {
    startApply(tx, {
      paths,
      resolutions: Object.fromEntries(paths.map((p) => [p, 'theirs' as const])),
    })
    return
  }
  // Keep mine: the folder's version stays; nothing is written.
  const chosen = new Set(paths)
  f.conflicts = (f.conflicts ?? []).filter((x) => !chosen.has(x.path))
  addNotes(tx, [`Kept your version of ${pathListShort(paths)}.`])
  tx.transition = true
  if (f.conflicts.length > 0) {
    openConflicts(tx)
    return
  }
  resolveCard(tx, c.view.id, choiceId)
  finalizeDone(tx, 'applied')
}

/** interruptedApply [Finish apply] (a relaunch while applying, or an apply that stopped part way). */
function openInterrupted(tx: Tx, error?: string): void {
  const s = tx.s
  const f = fin(s)
  if (f === undefined) return
  if (f.state !== 'conflicts') f.state = 'interrupted'
  finalizeStep(tx, 'waiting', FINALIZE_WAIT_REASON.interrupted)
  if (s.cards.some((c) => c.view.kind === 'interruptedApply')) return
  openCard(
    tx,
    interruptedApplyCard(nextCardId(tx, 'interruptedApply'), {
      ...(f.files !== undefined ? { files: f.files } : {}),
      ...(error !== undefined ? { error } : {}),
    }),
    'finalize',
  )
}

function chooseInterrupted(tx: Tx, c: CardState, choiceId: string): void {
  const f = fin(tx.s)
  if (applyBusy(f)) {
    tx.reject('CONFLICT', 'Dim Factory is already applying the run.')
    return
  }
  resolveCard(tx, c.view.id, choiceId)
  if (f === undefined || choiceId !== INTERRUPTED_APPLY_CHOICE.finish) return
  const r = f.resume
  startApply(tx, {
    resume: true,
    ...(r?.paths !== undefined ? { paths: r.paths } : {}),
    ...(r?.resolutions !== undefined ? { resolutions: r.resolutions } : {}),
  })
}

/** An apply that wrote nothing failed: the finalize state goes back to where it was asked for. */
function applyFailedBack(tx: Tx, from: FinalizeState | undefined): void {
  const f = fin(tx.s)
  if (f === undefined) return
  switch (from) {
    case 'pending':
    case 'preview':
      openFinalizeCard(tx)
      return
    case 'conflicts':
      openConflicts(tx)
      return
    case 'interrupted':
      openInterrupted(tx, f.error)
      return
    case 'applied':
      f.state = 'applied'
      finalizeStep(tx, 'done', 'applied')
      completeAfterFinalize(tx)
      return
    case 'kept':
    case 'waiting':
    case 'applying':
    case 'undoing':
    case 'discarding':
    case 'discarded':
    case undefined:
      f.state = 'kept'
      finalizeStep(tx, 'skipped', 'kept')
      completeAfterFinalize(tx)
  }
}

/** The files and resolutions an interrupted apply was for (Finish apply carries them on). */
function resumeOf(op: Extract<FinalizeOp, { kind: 'apply' }>): NonNullable<FinalizeRunState['resume']> {
  return {
    ...(op.paths !== undefined ? { paths: [...op.paths] } : {}),
    ...(op.resolutions !== undefined ? { resolutions: { ...op.resolutions } } : {}),
  }
}

function resolveKinds(tx: Tx, kind: CardKind): void {
  for (const c of [...tx.s.cards]) if (c.view.kind === kind) resolveCard(tx, c.view.id)
}

function pathListShort(paths: readonly string[]): string {
  return pathList(paths, 5)
}

/** Discard: the worktree is deleted in 10 s (undoable until then); the timer starts the deletion. */
function startDiscard(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined) return
  const token = `discard-${tx.at}`
  const deleteAt = tx.at + DISCARD_DEFER_MS
  f.discard = { token, deleteAt, back: f.state }
  f.state = 'discarding'
  finalizeStep(tx, 'running', 'discarding')
  tx.armTimer(DISCARD_TIMER, deleteAt)
  tx.transition = true
}

function onDiscardDue(tx: Tx): void {
  const f = fin(tx.s)
  const d = f?.discard
  if (f === undefined || f.state !== 'discarding' || d === undefined || d.removing === true) return
  if (tx.at < d.deleteAt) {
    tx.armTimer(DISCARD_TIMER, d.deleteAt)
    return
  }
  d.removing = true
  requestFinalize(tx, { op: 'remove' })
  tx.transition = true
}

function onRemoveResult(tx: Tx, e: Extract<EngineEventBody, { t: 'remove-result' }>): void {
  const r = tx.take(e.req)
  if (r?.kind !== 'finalize' || r.op !== 'remove') return
  const f = fin(tx.s)
  if (f === undefined || f.state !== 'discarding') return
  delete f.discard
  tx.transition = true
  if (!e.ok) {
    f.error = `Dim Factory could not delete the isolated copy: ${e.error ?? 'unknown error'}`
    addNotes(tx, [f.error])
    f.state = 'kept'
    finalizeStep(tx, 'skipped', 'kept')
    completeAfterFinalize(tx)
    return
  }
  addNotes(tx, ['Discarded the isolated copy.', ...(e.notes ?? [])])
  finalizeDone(tx, 'discarded')
}

/** worktree.undoDiscard: before the deletion started, back to where Discard was chosen. */
function onUndoDiscard(tx: Tx, token: string): void {
  const f = fin(tx.s)
  const d = f?.discard
  if (f === undefined || f.state !== 'discarding' || d === undefined || d.token !== token) {
    tx.reject('NOT_FOUND', 'This discard can no longer be undone.')
    return
  }
  if (d.removing === true) {
    tx.reject('CONFLICT', 'The isolated copy is already being deleted.')
    return
  }
  tx.clearTimer(DISCARD_TIMER)
  delete f.discard
  tx.transition = true
  switch (d.back) {
    case 'pending':
      openFinalizeCard(tx)
      return
    case 'applied':
      f.state = 'applied'
      finalizeStep(tx, 'done', 'applied')
      return
    case 'preview':
    case 'waiting':
    case 'applying':
    case 'conflicts':
    case 'interrupted':
    case 'kept':
    case 'undoing':
    case 'discarding':
    case 'discarded':
      f.state = 'kept'
      finalizeStep(tx, 'skipped', 'kept')
  }
}

/** Why the run's worktree cannot be applied or discarded now (undefined: it can). */
function isolationRefusal(s: RunState): { code: ResultCode; message: string } | undefined {
  if (!isolatedRun(s) || s.isolation?.worktree === undefined)
    return { code: 'NOT_FOUND', message: 'This run has no isolated copy.' }
  if (s.outcome === undefined && s.stop === undefined)
    return {
      code: 'CONFLICT',
      message:
        'The run is still working in its isolated copy. Apply or discard it once the run has finished, or stop it first.',
    }
  const f = fin(s)
  if (f?.state === 'discarded') return { code: 'NOT_FOUND', message: 'The isolated copy was discarded.' }
  if (f?.state === 'discarding')
    return { code: 'CONFLICT', message: 'The isolated copy is being discarded. Undo the discard first.' }
  if (f?.state === 'preview')
    return {
      code: 'CONFLICT',
      message: 'Dim Factory is still reading what Apply would change. Try again in a moment.',
    }
  if (applyBusy(f))
    return { code: 'CONFLICT', message: 'Dim Factory is already applying or undoing in this folder.' }
  return undefined
}

/** A stopped run's worktree gets its finalize state when the user first acts on it (its step stays cancelled). */
function finalizeFor(s: RunState): FinalizeRunState {
  const I = iso(s)
  I.finalize ??= { state: 'kept', lease: 'none', applies: [], applyNo: 0 }
  return I.finalize
}

/** worktree.apply (the Diff tab's "Apply to folder…"): all files, or `paths` (the reviewed ones). */
function onApplyCmd(tx: Tx, cmd: Extract<UserCommand, { kind: 'apply' }>): void {
  const s = tx.s
  const refusal = isolationRefusal(s)
  if (refusal !== undefined) {
    tx.reject(refusal.code, refusal.message)
    return
  }
  if (s.matchOf?.rematch === true) {
    tx.reject('CONFLICT', MATCH_TEXT.notApplied)
    return
  }
  const f = finalizeFor(s)
  if (f.state === 'interrupted') {
    tx.reject('CONFLICT', 'An apply was interrupted. Finish it first (its card in the run).')
    return
  }
  if (f.state === 'pending') resolveKinds(tx, 'finalize')
  startApply(tx, {
    ...(cmd.paths !== undefined ? { paths: cmd.paths } : {}),
    ...(cmd.resolutions !== undefined ? { resolutions: cmd.resolutions } : {}),
    ipc: true,
  })
}

/** worktree.undoApply: the applied files back to the `pre-apply` snapshot P, under the lease. */
function onUndoApplyCmd(tx: Tx, token: string): void {
  const f = fin(tx.s)
  const rec = f?.applies.find((a) => a.token === token)
  if (f === undefined || rec === undefined) {
    tx.reject('NOT_FOUND', 'This apply can no longer be undone.')
    return
  }
  if (rec.undone === true) {
    tx.reject('CONFLICT', 'This apply was already undone.')
    return
  }
  if (applyBusy(f) || f.state === 'discarding') {
    tx.reject(
      'CONFLICT',
      'Dim Factory is applying, undoing or discarding in this folder. Try again in a moment.',
    )
    return
  }
  f.op = { kind: 'undo', token }
  requestLease(tx)
}

function onUndoApplyResult(tx: Tx, e: Extract<EngineEventBody, { t: 'undo-apply-result' }>): void {
  const r = tx.take(e.req)
  if (r?.kind !== 'finalize' || r.op !== 'undo') return
  const f = fin(tx.s)
  const op = f?.op
  if (f === undefined || op?.kind !== 'undo' || op.token !== r.token) return
  delete f.op
  releaseLease(tx)
  tx.transition = true
  const rec = f.applies.find((a) => a.token === op.token)
  if (!e.ok) {
    f.error =
      e.conflict === true
        ? `Undo refused: ${e.error ?? 'a file changed since the apply'}. Nothing was written.`
        : `The undo failed: ${e.error ?? 'unknown error'}`
    addNotes(tx, [f.error])
    f.state = 'applied'
    finalizeStep(tx, 'done', 'applied')
    return
  }
  if (rec !== undefined) rec.undone = true
  delete f.error
  addNotes(tx, [`Undid the apply: ${plural(rec?.applied.length ?? 0, 'file')} back as before it.`])
  // Nothing of the run is in the folder any more (unless another apply is): isolated, not applied.
  if (f.applies.some((a) => a.undone !== true)) {
    f.state = 'applied'
    finalizeStep(tx, 'done', 'applied')
    return
  }
  f.state = 'kept'
  finalizeStep(tx, 'skipped', 'kept')
}

/** worktree.discard. */
function onDiscardCmd(tx: Tx): void {
  const s = tx.s
  const refusal = isolationRefusal(s)
  if (refusal !== undefined) {
    tx.reject(refusal.code, refusal.message)
    return
  }
  const f = finalizeFor(s)
  if (f.state === 'interrupted') {
    tx.reject('CONFLICT', 'An apply was interrupted. Finish it first, then discard.')
    return
  }
  if (f.state === 'pending') resolveKinds(tx, 'finalize')
  if (f.state === 'conflicts') resolveKinds(tx, 'finalizeConflicts')
  startDiscard(tx)
}

/**
 * Relaunch (crash relaunch): an apply that was writing opens interruptedApply (never auto-resumed); an
 * undo that was running is reported (Undo can be asked again: git/finalize counts what it already restored as done); a
 * preview or a lease is asked for again; a deferred deletion that had not begun gets its 10 s again from now (its Undo
 * stays possible meanwhile), and one that had begun is finished.
 */
function relaunchFinalize(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined) return
  const held = f.lease !== 'none'
  f.lease = 'none'
  const op = f.op
  switch (f.state) {
    case 'preview':
      requestFinalize(tx, { op: 'preview' })
      return
    case 'applying':
      if (op?.kind === 'apply') f.resume = resumeOf(op)
      delete f.op
      openInterrupted(tx)
      return
    case 'undoing':
      delete f.op
      addNotes(tx, ['Dim Factory closed while it was undoing an apply. Undo again to finish it.'])
      f.state = 'applied'
      finalizeStep(tx, 'done', 'applied')
      return
    case 'waiting':
    case 'conflicts':
      if (op === undefined) return
      // An apply of conflicting files that held the lease may have written some of them: finish it like any apply.
      if (held && op.kind === 'apply' && f.state === 'conflicts') {
        f.resume = resumeOf(op)
        delete f.op
        openInterrupted(tx)
        return
      }
      requestLease(tx)
      return
    case 'discarding': {
      const d = f.discard
      if (d === undefined) return
      // The deletion had begun (part of the copy may be gone): it is finished, never offered for Undo again.
      if (d.removing === true) {
        requestFinalize(tx, { op: 'remove' })
        return
      }
      d.deleteAt = Math.max(d.deleteAt, tx.at + DISCARD_DEFER_MS)
      tx.armTimer(DISCARD_TIMER, d.deleteAt)
      return
    }
    case 'pending':
    case 'interrupted':
    case 'applied':
    case 'kept':
    case 'discarded':
      return
  }
}

/** Stop while finalize is open: the worktree is kept, never deleted (a discard waiting is called off). */
function stopFinalize(tx: Tx): void {
  const f = fin(tx.s)
  if (f === undefined) return
  tx.clearTimer(DISCARD_TIMER)
  releaseLease(tx)
  delete f.op
  delete f.discard
  if (f.state === 'discarded') return
  // Part of it may be in the folder already (an apply before a conflict was decided).
  f.state = f.applies.some((a) => a.undone !== true) ? 'applied' : 'kept'
}
