// Supervisor state, events and effects (the reducer, the controller and the state machine rows).
// `reduce(state, EngineEvent) → {state, effects}` is pure: time comes only from `event.at`, ids come from counters
// in the state, and nothing here performs I/O. RunState is plain JSON (it is run.json's `state`).
import type { GuardrailFinding } from '../../shared/guardrails.ts'
import type { VerifyScenarioLine } from '../../shared/playtest.ts'
import type { Timeouts } from '../../shared/config-schema.ts'
import type { CostBasis } from '../../shared/estimates.ts'
import type { ExtensionLevel } from '../../shared/extensions.ts'
import type { RunDepthView } from '../../shared/depth.ts'
import type {
  AdapterSignal,
  AllowRule,
  AskDecision,
  AskKind,
  NormalizedEvent,
  Usage,
} from '../../shared/events.ts'
import type {
  Failure,
  FailureCategory,
  GrantCommand,
  HealView,
  JsonPatchOp,
  RecoveryAction,
  RetryStrategy,
} from '../../shared/failure.ts'
import type { Finding, FindingsFile, SourceParseStatus } from '../../shared/findings.ts'
import type { DiffSegment, ResultCode } from '../../shared/ipc.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'
import type { PreflightReport } from '../../shared/preflight.ts'
import type { ResearchResult, ResearchRunConfig, ResearchView } from '../../shared/research.ts'
import type { DeployPlanFacts } from '../../shared/deploy.ts'
import type { AcceptanceCriterion } from '../../shared/acceptance.ts'
import type { RunRecipe } from '../../shared/recipes.ts'
import type { QualityGatesView } from '../../shared/factory.ts'
import type {
  AgentStep,
  AnswerVia,
  AutoAnsweredCounts,
  CardChoice,
  CardChoiceValue,
  CardView,
  ClarifyQuestion,
  ClarifyView,
  DepsCommandView,
  FixRoundView,
  FixStopReason,
  FinalizeState,
  FreshDetail,
  FreshReason,
  IsolationMode,
  Mode,
  PassName,
  PassStatus,
  PauseReason,
  PlanMode,
  PrepareStepId,
  RunEventBody,
  RunOutcome,
  RunBranchInfo,
  RecheckView,
  RunOutputFile,
  RunPhase,
  RunStatus,
  RoutedStep,
  ScanAdvisoryView,
  ScanAuditView,
  ScanSecretView,
  StepCost,
  StepKey,
  VerifyCommandStatus,
  WaitView,
} from '../../shared/run.ts'
import type { MatchRef } from '../../shared/match.ts'
import type { AskCancelReason } from '../adapters/types.ts'
import type { RetryContext, RetryDecision } from '../heal/categories.ts'
import type { SessionCheck, SessionDecision } from './sessions.ts'
import type { ContextFacts, ContextState } from '../context/state.ts'
import type { GroundingTrack } from '../grounding/evidence.ts'
import type { VerifyFact } from '../grounding/checks.ts'

export type { AskCancelReason, Finding, FindingsFile, SessionCheck, SessionDecision, SourceParseStatus }

// ---- configuration the reducer needs (a projection of ResolvedConfig) ---------------------------------------

export interface RunPassConfig {
  enabled: boolean
  vendor: string
  model: string | null
  /** `passes.<p>.effort` (null or absent: the vendor's default effort). */
  effort?: string | null
  /** `passes.<p>.extensions` (absent in a run started before Extensions existed: the pass's default level). */
  extensions?: ExtensionLevel
  mode: Mode
  /** Fix only: `passes.fix.reuseSession` (absent ⇒ true, the default). */
  reuseSession?: boolean
  /** Security only: `passes.security.recheck`, the re-check after Fix (absent ⇒ true, the default). */
  recheck?: boolean
  /**
   * Security only: `passes.security.review: 'sensitive'`, the reviewer runs only when the scan found the changes touch
   * keys, sign-in, payments or people's data (or found a secret). Absent: it always runs.
   */
  review?: 'sensitive'
}

export interface RunConfig {
  /** How many guardrails were in force when the run was made. Absent in a run from before they existed. */
  guardrailRules?: number
  auto: boolean
  gates: { afterPlan: boolean; beforeFix: boolean }
  /** `ask.denyPauses`: a Deny pauses the pass (P9b) instead of letting the vendor continue (P9a). */
  denyPauses: boolean
  timeouts: Timeouts
  /** `selfHeal.enabled`. */
  selfHeal: boolean
  isolation: IsolationMode
  branch: 'none' | 'runBranch'
  verify: {
    enabled: boolean
    runAfter: ('implement' | 'fix')[]
    baseline: boolean
    /**
     * The enabled `verify.commands` names, in order and made unique as a round names them
     * (uniqueVerifyNames), so a round shows its rows from its start (the trust check fills them in place). Absent
     * when there is none (and in an earlier build's run.json).
     */
    names?: string[]
  }
  passes: Record<PassName, RunPassConfig>
  /** How the Plan pass starts: `native` when `planning.native:'auto'` and the adapter declares it safe. */
  planMode: PlanMode
  /**
   * Test-first (the Brief's approach): the `tests` step writes failing tests after Plan, the `verify:red` round shows
   * them failing, and Implement must make verify green. Absent: off (and in an earlier build's run.json).
   */
  testFirst?: true
  /**
   * `isolation.worktree` (isolated runs): the install policy and `autoApply`. Absent (an earlier build's run.json,
   * an in-place run): install `ask`, autoApply off.
   */
  worktree?: { install: 'ask' | 'auto' | 'never'; autoApply: boolean }
  /**
   * Clarify before Plan (`passes.plan.clarify`): at most `questions` questions; `inAuto` = Auto still asks (else Auto
   * skips Clarify). Absent: off (and in an earlier build's run.json).
   */
  clarify?: {
    questions: number
    inAuto: boolean
    /** Plain questions (`passes.plan.clarifyPlain`): about the outcome, never the technology. Absent: off. */
    plain?: true
  }
  /**
   * Research before Plan (`passes.plan.research`): the lenses resolved when the run started (generic and the pack's)
   * and whether its vendor may search the web. Absent: off (and in an earlier build's run.json).
   */
  research?: ResearchRunConfig
  /**
   * Fix until green (`passes.fix.rounds` ≥ 2): at most `rounds` Fix rounds, each re-checked when `recheck`, within the
   * budget (`maxUsd`, `maxMinutes` of working time). Absent: a single Fix (and in an earlier build's run.json).
   */
  fixLoop?: { rounds: number; recheck: boolean; maxUsd?: number; maxMinutes?: number }
  /**
   * The Deploy helper's Deploy step (`passes.implement.deploy`): at the end of a run that completed without failures, an
   * editing pass on the Implement pass's config writes the config files the deploy target needs (`target`: the one
   * the run or the project names, null: the pack's pick for the deliverable). Absent: off (and in an earlier build's
   * run.json).
   */
  deploy?: { target: string | null }
  /**
   * The acceptance review (`passes.review.acceptance`): after Implement's checks and before Review, a read-only pass
   * marks each of the plan's acceptance criteria met, not met or unknown. Absent: off (and in an earlier build's
   * run.json).
   */
  acceptance?: true
  /**
   * Explain it to me (`passes.plan.explain`): once the outcome is decided, a read-only pass writes explain.md, a
   * plain-language summary of the run. Absent: off (and in an earlier build's run.json).
   */
  explain?: true
  /**
   * Explain's summary for a result that is not a program (`passes.plan.explainPlain`): "How to open it" instead of
   * "How to run it" (explain-easy.md). Absent: off (and in an earlier build's run.json).
   */
  explainPlain?: true
  /**
   * The project's quality gates (`quality`, when enabled): the verify commands that must pass, and whether the
   * security review and the acceptance review must pass. A run that would be done but misses one completes as
   * `gates-failed`. Absent: none (and in an earlier build's run.json).
   */
  quality?: { verify: string[]; security: boolean; acceptance: boolean }
  /**
   * Model routing: the model and effort a routed step (Research, Clarify, Explain, the acceptance review, the
   * re-check) runs at on its pass's vendor, where the profile names one. Absent: every step runs as its pass.
   */
  routing?: Partial<Record<RoutedStep, { model?: string | null; effort?: string | null }>>
  /**
   * Context health's reactions and checks (`contextHealth`, user settings), as the run started with them. Absent in an
   * earlier build's run.json: their defaults (contextHealthOf).
   */
  contextHealth?: ContextHealthRunConfig
  /**
   * Adaptive depth: Quick (direct: Plan and Critic off, Implement on the direct prompt, one reviewer) or Thorough, who
   * decided and why, and, for a Quick run whose check failed, why it switched to thorough checks (escalated). Absent:
   * no decision recorded (an earlier build's run.json, a hand-made state).
   */
  depth?: RunDepthView
  /**
   * Quieter reviews (`passes.fix.trigger: 'evidence'`, the default): only a [must] with evidence (a `file:line`, a failing
   * check or a grounding flag) is sent to Fix (and with Fix until green a [should] with evidence); the rest is listed.
   * Absent: every finding is sent to Fix (an earlier build's run.json, or `trigger: 'all'`).
   */
  fixTrigger?: 'evidence'
  /**
   * Continuity (`passes.implement.continuePlan`, on by default): Plan keeps its session and Implement resumes it when
   * both run on the same vendor and the session can carry on. Absent: Implement starts fresh (an earlier build's
   * run.json, or the key off).
   */
  continuity?: true
}

/** RunConfig.contextHealth. */
export interface ContextHealthRunConfig {
  /** Implement or Fix restarts fresh with a summary after this many compactions (null: never). */
  restartAfter: number | null
  /** The loop card from this many repeats of one call; the hard stop at `loopStopAt`. */
  loopWarnAt: number
  loopStopAt: number
  /** Fix starts fresh (`context-heavy`) when Implement ended at least this full, or compacted this often. */
  heavyPercent: number
  heavyCompactions: number
  /** The post-compaction reminder is sent in this run (the setting, and Auto for `auto`). */
  reminder: boolean
  /** The grounding checks after Implement and Fix (absent in an earlier build's run.json: on). */
  grounding?: boolean
  /** The online registry check of new dependencies. */
  registryCheck: boolean
  /** The optional AI judge after Implement. */
  aiJudge: boolean
}

/** Everything `initRunState` needs; R1 (`{t:'created'}`) then announces the run. */
export interface RunInit {
  runId: string
  displayNo: number
  folder: string
  folderKey: string
  task: string
  /** Defaults to the first line of the task, capped at 80 characters. */
  title?: string
  profile: string
  createdAt: number
  config: RunConfig
  /** The run's rendered Brief (`{{brief}}`); absent without one. */
  brief?: string
  /** The Brief's category (its pack id); absent without a Brief. */
  category?: string
  /** The Brief's pack's security focus (`{{focus}}` for Security and the critic); absent when it has none. */
  securityFocus?: string
  /** The recipe the run used (shown on the Run view and in the history); absent without one. */
  recipe?: RunRecipe
  /** The project memory as the run read it (`{{memory}}`, capped); absent without one. */
  memory?: string
  /** A match's side: the match and the side this run builds. */
  matchOf?: MatchRef
  /** An isolated run whose copy is written from a snapshot of the folder, not made as a git worktree. */
  copyFrom?: SnapshotCopySource
}

/**
 * Where an isolated run's copy comes from when it is not a git worktree of HEAD: a tree in the folder's shadow (a
 * match's starting point). The copy then holds the folder as it was at that snapshot, uncommitted changes included,
 * and works for a folder that is not a repository.
 */
export interface SnapshotCopySource {
  tree: string
}

// ---- snapshots, requests, launches --------------------------------------------------------------------------

/** Snapshot labels. */
export type SnapshotLabel =
  | 'run-start'
  | 'plan-end'
  | 'S0'
  | 'S1'
  | 'post-verify-1'
  | 'post-review'
  | 'fix-start'
  | 'S2'
  | 'pre-revert'
  | 'pre-retry'
  | 'stopped'
  | 'paused'
  | 'interrupted'
  | 'resume'
  | 'pre-apply'
  /** Test-first: the Tests step's start (the run's base when it runs) and end, and the folder after the red check. */
  | 'T0'
  | 'T1'
  | 'post-red'
  /** Fix until green: the folder after a round's checks, before the next round (its reconcile compares with it). */
  | 'post-round'
  /** The Deploy step's start and end (its segment of the Diff tab). */
  | 'deploy-start'
  | 'deploy-end'

export interface SnapshotRef {
  label: SnapshotLabel
  commit: string
  tree: string
  at: number
  /**
   * Fingerprint of the nested git repositories' working state (their files are not in `tree`); absent when the
   * scope has none. Part of "did the pass change anything" (R6).
   */
  nested?: string
}

/** Why the reducer asked for a snapshot; decides what the result unblocks. */
export type SnapshotPurpose =
  | 'run-start'
  | 'start'
  | 'end'
  | 'pre-retry'
  | 'resume'
  | 'recovery'
  /** R8: the Review ∥ Critic join (`post-review`, should equal S1). */
  | 'post-review'
  /** R4: the plan-end guard (Plan reported a write; compared with `run-start`). */
  | 'plan-end'
  /** R7: after verify:1 (`post-verify-1`, should equal S1). */
  | 'post-verify-1'
  /** Test-first: after the red check (`post-red`, should equal T1). */
  | 'post-red'
  /** Fix until green: after a round's verify and re-check, before the next round (`post-round`). */
  | 'post-round'

export type ReconcileBoundary = 'pre-implement' | 'pre-review' | 'pre-fix' | 'pre-apply' | 'end-of-pass'

/**
 * Isolated runs (prepare): `setup` = eligibility, the worktree and copy-ins (steps 1 and 2); `rest` = step
 * 3's deps decision (installCommand or detection, and its `deps` trust against the SOURCE folder's grants); `install` =
 * the dependency install (only with a `deps` grant: the controller checks it again right before anything spawns);
 * `ready` = step 5, `isolation.verifyReady` (every enabled verify command's program resolves in the worktree). Step 4,
 * the verify:0 baseline, is a verify round of its own.
 */
export type PrepareStage = 'setup' | 'rest' | 'install' | 'ready'

/** Why a revert runs: the user's diff.revert or its undo, or a card choice core carries out. */
export type RevertWhy =
  /** `diff.revert` (revert to S0). */
  | 'user'
  /** `diff.undoRevert`: the paths back to the `pre-revert` snapshot. */
  | 'undo'
  /** planMutated [Revert Plan's changes] (R4): back to `run-start`. */
  | 'plan'
  /** P21 `revert-then-fresh` / retryPartial [Revert partial then fresh]: back to the pass's start snapshot. */
  | 'retry'
  /** reconcile [Restore run's version]: the overlapping paths back to the run's last snapshot. */
  | 'restore'

/** An effect the controller must answer with a matching `*-result` event carrying the same `req`. */
export type PendingRequest =
  | { kind: 'preflight'; mode: 'authoritative' }
  | { kind: 'preflight'; mode: 'passBoundary'; step: AgentStep }
  | { kind: 'prepare'; stage: PrepareStage }
  | { kind: 'snapshot'; label: SnapshotLabel; purpose: SnapshotPurpose; step?: StepKey }
  /**
   * `hold`: the run waits for this answer (an end-of-pass recheck after a reconcile card). The first end-of-pass
   * check (P15) holds the run only when its verdict needs the user.
   */
  | { kind: 'reconcile'; boundary: ReconcileBoundary; step?: StepKey; hold?: boolean }
  /** P15 read-only ⇒ parse findings: answered by `findings-result`. */
  | { kind: 'findings'; step: ReviewerPass; spawnNo: number; attempt: number }
  /**
   * The security advisor's scan: what applies and how its audits stand against trust.json (answered by
   * `scan-check-result`), the scan itself (`scan-result`), and a [Trust for this project] grant for an audit
   * (`trust-grant-result`). `attempt`: the scan step's attempt (a stale answer is dropped).
   */
  | { kind: 'scan-check'; attempt: number }
  | { kind: 'scan'; attempt: number }
  | { kind: 'scan-grant'; attempt: number; name: string }
  /**
   * R5: create the run branch (`isolation.branch: runBranch`); answered by `branch-result`. `settle`: only settle
   * the run's pending branch (a relaunch; RunState.branchPending), never make a new one.
   */
  | { kind: 'branch'; settle?: true }
  /**
   * A revert (answered by `revert-result`). `token` = the RevertRecord it creates (for `undo`, the record it
   * undoes). `boundary`/`step`: the reconcile card a restore belongs to. `atGate`: asked for at the gate before Fix
   * (its paths become a Fix note even if Continue was pressed while it ran).
   */
  | {
      kind: 'revert'
      why: RevertWhy
      token: string
      /** The snapshot it reverts to (RevertRecord.target). */
      to: string
      /** `undo`: the token of the record the undo itself creates (so it can be undone in turn). */
      undoToken?: string
      /** `user`: the whole segment (Revert all), not chosen paths. */
      all?: true
      step?: StepKey
      boundary?: ReconcileBoundary
      atGate?: boolean
    }
  /**
   * A verify round's trust check (every configured command's body re-read and compared with its
   * grant), answered by `verify-check-result`; the round itself, answered by `verify-result`; a [Trust for this
   * project] grant write, answered by `trust-grant-result`. `attempt`: the round's attempt (a stale answer is dropped).
   */
  | { kind: 'verify-check'; step: VerifyRound; attempt: number }
  | { kind: 'verify'; step: VerifyRound; attempt: number }
  | { kind: 'trust-grant'; step: VerifyRound; attempt: number; name: string }
  /** The depsConsent card's [Install] writes the `deps` grant (answered by `trust-grant-result`). */
  | { kind: 'deps-grant'; installs: number }
  /**
   * Finalize (R12): `preview` (what Apply would do), `apply` (the `no`-th apply), `undo` (worktree.undoApply of
   * `token`), `remove` (Discard's deletion once its 10 s are over).
   */
  | { kind: 'finalize'; op: 'preview' | 'apply' | 'undo' | 'remove'; no?: number; token?: string }
  /** Test-first: compare the Tests step's files at T1 with Implement's end (answered by `tests-check-result`). */
  | { kind: 'tests-check' }
  /** The Deploy step's planning: classify the folder, pick the target, list the missing config (`deploy-plan-result`). */
  | { kind: 'deploy-plan'; attempt: number }
  // ---- grounding checks (core/grounding) ----
  /** The grounding checks after a pass (`key`: GroundingRunState.checks), answered by `grounding-result`. */
  | { kind: 'grounding'; key: string }
// ---- context reactions (core/context/reactions) ----

// ---- verify rounds (R6/R7/R11) ----------------------------------------------------------------------------------

/** The verify rounds: verify:1 / verify:2, verify:0 (the isolated-run baseline) and Test-first's verify:red. */
export type VerifyRound = 'verify:0' | 'verify:red' | 'verify:1' | 'verify:2'

/** How a configured command stands against trust.json, read before each round. */
export type VerifyTrust = 'trusted' | 'untrusted' | 'changed' | 'invalid'

/** What the controller's trust check found for one configured, enabled command (`verify-check-result`). */
export interface VerifyCheckCommand {
  name: string
  argv: string[]
  /** Relative to the scope root, `/` separators (`.` for the root). */
  cwdRel: string
  /** The script text the grant's hash covers (e.g. the package.json script); null when there is none. */
  body: string | null
  trust: VerifyTrust
  /** `changed`: the body the existing grant covered (the trust card shows the difference). */
  grantedBody?: string | null
  /** `invalid`: why it cannot run as configured (UI copy, e.g. shell metacharacters). */
  reason?: string
}

/** One command's result as the round reports it (src/core/verify runVerifyRound). */
export type VerifyResultInput = VerifyCommandResult

/**
 * The reducer's decision for one command of a round: `run` · `ask` (its trust card is open) · `granting` ([Trust for
 * this project] is writing the grant) · `skip` (the user's [Skip]) · `auto-skip` (Auto never trusts: skipped with a
 * `[should]` finding) · `invalid` (it cannot run as configured).
 */
export type VerifyDecision = 'run' | 'ask' | 'granting' | 'skip' | 'auto-skip' | 'invalid'

export interface VerifyCommandState {
  name: string
  argv: string[]
  cwdRel: string
  body: string | null
  trust: VerifyTrust
  grantedBody?: string | null
  decision: VerifyDecision
  status: VerifyCommandStatus
  exitCode?: number | null
  durationMs?: number
  excerpt?: string
  reason?: string
  logPath?: string
  /** `fail` by its timeout. */
  timedOut?: boolean
  /** Dim Factory's play-test: each scenario as passed or failed. */
  scenarios?: VerifyScenarioLine[]
  /** The trust card asking about it (decision `ask`). */
  cardId?: string
}

/**
 * StepState.verify of verify:1 / verify:2. `check` = the trust check outstanding · `trust` = trust cards open or grants
 * being written · `running` = the round runs · `env` = the verifyEnv card is open · `done` = results in.
 */
export interface VerifyRoundState {
  phase: 'check' | 'trust' | 'running' | 'env' | 'done'
  commands: VerifyCommandState[]
  /** failFast stopped the round after a failure. */
  aborted?: boolean
  /** The verifyEnv card ([Retry] [Skip verify]) asking about this round. */
  envCardId?: string
  /** The round's findings (`verifyFindings`), kept from its results until the round is done. */
  findings?: Finding[]
}

/** A command as the round effect hands it to the controller, in configured order. */
export interface VerifyRunCommand {
  name: string
  argv: string[]
  cwdRel: string
  /** false: not run; `status` / `reason` are its result (the controller still reports it, for the findings). */
  run: boolean
  status?: 'skipped-untrusted' | 'skipped'
  reason?: string
}

/** A HEAD as reconcile reads it (git/branch.ts HeadState): the symbolic ref (null = detached) and its commit. */
export interface GitHead {
  ref: string | null
  commit: string | null
}

/**
 * What the controller needs to gather one boundary's reconcile facts (git/reconcile.ts
 * GatherReconcileOptions). The reducer fills it from the run's snapshots and git state.
 */
export interface ReconcileInput {
  branchMode: 'none' | 'runBranch'
  /** The run branch once created (R5). */
  runBranch?: RunBranchInfo
  /** Where HEAD should be: at run start, on the run branch, or after [Continue on <branch>]. Absent: unknown. */
  expectedHead?: GitHead
  /** Commit of the run's last snapshot at this boundary (external edits are the folder now against it). */
  last?: string
  /**
   * End of a mutating pass (P15): `last` and the folder now are the pass's end snapshot (S1 / S2), still being taken
   * when the check is asked for; the controller waits for it and answers before the snapshot's own result.
   */
  awaitEnd?: boolean
  /** The run's own changes are `runStart..last` (S0). Absent before Implement. */
  runStart?: string
  /** Mass-deletion base (end of a pass: its start snapshot; default `last`). */
  deletionBase?: string
  /** Paths Dim Factory itself wrote since `last` (reverts, restores): never external edits. */
  ownPaths?: string[]
}

/** One row of the reconciliation table that applies, as card copy (no em dashes) with its copyable commands. */
export interface ReconcileReasonView {
  /** git/reconcile.ts ReconcileRowId, or `branch-<kind>` for a branch-prep blocker. */
  row: string
  severity: 'block' | 'choice' | 'info'
  title: string
  detail: string
  /** `shell_copy` actions (recovery.execute finds them in the card payload); never run by Dim Factory. */
  actions: RecoveryAction[]
}

/** A `choice` / `block` verdict as the reconcile card needs it (core-built choices; a block has no default). */
export interface ReconcileCardInput {
  verdict: 'choice' | 'block'
  reasons: ReconcileReasonView[]
  external: string[]
  overlapping: string[]
  choices: CardChoice[]
  defaultChoice?: string
  /** Prompt notes for the next pass, applied with [Include my edits] ("User edited outside the run: …"). */
  notes: string[]
}

/**
 * The answer to a `reconcile` effect (`clean`, or a card verdict). `head` = HEAD as
 * observed: a commit move on the expected ref is accepted, and [Continue on <branch>] adopts it.
 *  - `info.notes`: run notes. `promptNotes`: the next pass's prompt notes (absent: `notes` themselves,
 *    at pre-fix). `chip`: pre-implement's "N files changed during planning" on Implement.
 *  - `choice` / `block`: a reconcile card (Auto takes a choice's default, never a block's).
 */
export type ReconcileResult =
  | { verdict: 'clean'; head?: GitHead }
  | { verdict: 'info'; notes: string[]; promptNotes?: string[]; chip?: string; head?: GitHead }
  | { verdict: 'choice' | 'block'; card: ReconcileCardInput; head?: GitHead }

/** A revert as carried out (git/revert.ts RevertOutcome): the undo point and what changed in the folder. */
export interface RevertOutcomeView {
  /** The `pre-revert` snapshot commit: an undo puts the paths back to it. */
  preRevert: string
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
}

/** A revert the run made, kept so `diff.undoRevert{undoToken}` can undo it (most recent last, at most 20). */
export interface RevertRecord {
  token: string
  /** `undo`: an undo of another record (`undoes`), itself undoable. */
  why: RevertWhy
  /** The `pre-revert` snapshot commit. */
  preRevert: string
  /**
   * The snapshot the revert wrote from: its undo checks that every path still holds this (else CONFLICT, nothing
   * written). Absent in a record written before it existed: its undo is then refused.
   */
  target?: string
  /**
   * restored + deleted: what an undo puts back. While `pending` or after `interrupted`: the paths it was about to
   * change (some may not have changed).
   */
  paths: string[]
  /** The choice that made it, as run notes name it ("Revert Plan's changes", `Undid "…"`). */
  label: string
  /**
   * What was reverted, for RunSnapshot.revertUndo.label ("Plan's changes", "your edits outside the run"). Absent in a
   * run.json written before it existed: the view then falls back to `label`.
   */
  what?: string
  at: number
  /** The Fix note it added at the gate before Fix ("User reverted after review: …"); its undo takes it back. */
  note?: string
  undone?: boolean
  /** `undo` records: the token of the record undone. */
  undoes?: string
  /**
   * Write-ahead: recorded when its undo point was taken and before any file was written (`revert-started`); cleared
   * by its result. A relaunch or a failed result turns it into `interrupted`.
   */
  pending?: true
  /** The revert stopped part way (Dim Factory closed, or git failed while writing): its undo still applies. */
  interrupted?: true
  /**
   * A later pass changed one of its paths (that pass's end snapshot): RunSnapshot.revertUndo no longer offers it. Its
   * undo is still checked path by path (CONFLICT).
   */
  stale?: true
}

/** Git facts the reducer keeps (run.json `state.git`). */
export interface RunGitState {
  /** Where HEAD should be (run start, the run branch, an accepted switch); reconcile compares with it. */
  expectedHead?: GitHead
  /** Paths Dim Factory wrote since the last boundary snapshot (reverts, restores); the next one resets them. */
  ownPaths?: string[]
  reverts?: RevertRecord[]
}

/** What the controller passes to `adapter.start` beyond the resolved pass config. */
export interface LaunchPlan {
  /** Start a new session. `reason` feeds the session line ("fresh session: …"). */
  fresh?: { reason?: FreshReason }
  /** `--resume=<id>` (Claude) / `thread/resume` (Codex). `priorUsage` = the session's last cumulative totals. */
  resume?: { sessionId: string; priorUsage?: Usage }
  /**
   * User message for a resumed turn (P19, a retry's "Previous attempt failed: …"). The prompt is this text alone.
   * Absent on a resume ⇒ the pass template is rendered (Fix reusing Implement's session, see `session`).
   */
  continuation?: string
  /**
   * Fix's first launch only (R10): `decideSession`'s verdict. `{reuse:true}` comes with `resume` (Implement's
   * session): render fix.md with `task`/`plan`/`diff` empty. `{reuse:false, reason}` comes with `fresh`.
   */
  session?: SessionDecision
  /**
   * Fix only: the `Notes:` list at the top of `{{findings}}` (the template rendering rules), e.g. "User reverted after
   * review: …", "User edited outside the run: …". Empty without reverts or reconcile notes.
   */
  notes?: string[]
  /** Plan pass only: native planning mode or the read-only template (fallback). */
  planMode?: PlanMode
  /**
   * Plan pass only (continuity): keep the session when Plan ends (Claude persists it, Codex keeps a thread that is not
   * ephemeral), so Implement can continue it.
   */
  keepSession?: true
  planFallbackReason?: string
  /**
   * P19 "Allow & resume": the timed-out ask the user allowed late. Its exact rule (when the adapter reported one) is
   * already in `RunState.allowRules`, which reach the adapter as `StartOptions.allowRules`.
   */
  lateAllow?: { kind: AskKind; detail: string; rule?: AllowRule }
  /**
   * context_exceeded "retry fresh with a trimmed diff": the prompt's `{{diff}}` budget is halved this
   * many times (StepState.diffTrim). Absent: the full budget.
   */
  diffTrim?: number
  /**
   * Context health's fresh restart of Implement or Fix after its session compacted `compactions` times: the prompt
   * carries `{{state}}`, a short note of where the work stands (the plan, the criteria, the files changed so far).
   */
  restart?: { compactions: number }
}

/** Why a launch pipeline exists. */
export type LaunchCause = 'initial' | 'resume' | 'retry' | 'fallback' | 'replan'

/**
 * A step on its way to `spawn`. `pump` walks the stages in order and stops at the first one that must wait:
 * process exit → pre-snapshot → strategy → reconcile → delay → start snapshot → pass-boundary preflight → spawn.
 */
export interface PendingLaunch {
  cause: LaunchCause
  /** Retries only: resolved into `plan` once the pre-retry snapshot is known ("Retry auto resolves to"). */
  strategy?: RetryStrategy
  plan?: LaunchPlan
  /** R5 / R10: reconcile(pre-implement) before Implement's first spawn, reconcile(pre-fix) before Fix's. */
  reconcile?: 'todo' | 'done'
  /**
   * R10: `plan` is decideSession's verdict, taken right before Fix P1: after the start snapshot (F0) and the
   * pass-boundary preflight, whose answer the controller sends after its `session-check`.
   */
  decide?: 'session'
  /** R10: the controller's `session-check` for this launch (canResume, Fix's folder, capabilities). */
  sessionCheck?: SessionCheck
  /**
   * The fact behind this launch's fresh start that its FreshReason does not carry (shared FreshDetail), set by
   * the stage that knows it: decideSession's rule 4 (sessionPlan), a resume_failed retry that began a new attempt
   * (failPass, Retry). spawn() keeps it on the step only when the plan starts fresh for the matching reason.
   */
  freshDetail?: FreshDetail
  /**
   * Review ∥ Critic join: every stage is done and the launch waits for its sibling's initial launch, so both spawn
   * in the same reduction.
   */
  ready?: boolean
  /** `attemptEnd`: this snapshot is where the failed attempt ended (P16: taken right after it, not at a Retry). */
  preSnapshot?: { label: 'pre-retry' | 'resume'; done: boolean; tree?: string; attemptEnd?: true }
  delayUntil?: number
  preflight: 'todo' | 'done'
  /** Outstanding request this launch waits on. */
  req?: string
  /** Open card this launch waits on: `retryPartial`, or a reconcile card at R5 / R10. */
  card?: string
  /** `revert-then-fresh`: the revert to the pass's start snapshot, before the fresh spawn. */
  revert?: 'requested' | 'done'
  /** The failure being retried (continuation text; restored when the retry is cancelled). */
  failure?: Failure
  /** A `resume` action's own continuation for this retry (else "Previous attempt failed: …; continue."). */
  continuation?: string
}

// ---- per-step state ------------------------------------------------------------------------------------------

export interface ProcState {
  /** Correlates adapter events / exits with this process (events for another spawnNo are stale). */
  spawnNo: number
  live: boolean
  spawnedAt: number
  /** A terminal adapter event (`done` or fatal `error`) was seen. */
  terminal: boolean
  pid?: number
  /** The folder the process runs in (`spawned`); recorded with its session (decideSession's cwd rule). */
  cwd?: string
  /**
   * The FreshReason this spawn started fresh for. A `resume-failed` fallback that itself fails with
   * resume_failed is an ordinary failure (it spends the budget), so the free fallback cannot loop.
   */
  freshReason?: FreshReason
}

export interface AskState {
  requestId: string
  kind: AskKind
  detail: string
  reason?: string
  expiresAt: number
  allowSession: boolean
  defaultToNo?: boolean
  raisedAt: number
  /** P9: the Deny sits in its undo grace; the vendor has not been answered yet. */
  pendingDeny?: { until: number; via: AnswerVia }
}

export interface StepState {
  key: StepKey
  status: PassStatus
  reason?: string
  pause?: PauseReason
  /** User-visible attempt (P16 / P21). Fallbacks and resumes keep it. 0 until the first launch. */
  attempt: number
  /** Processes spawned for this step so far (correlation id, raw log name). */
  spawnNo: number
  startedAt?: number
  endedAt?: number
  /** Running + stalled time over every attempt; waits on the user are excluded. */
  activeMs: number
  activeSince?: number
  /**
   * `activeMs` when the current attempt began (absent = 0, the first attempt). The views, estimates and the live ETA
   * use the final attempt's active time, `activeMs − attemptActiveFrom` (final attempt only).
   */
  attemptActiveFrom?: number
  vendor?: string
  model?: string | null
  /** The effort level the last spawn sent (absent: the vendor's default, or not spawned yet). */
  effort?: string
  /**
   * Live balanced run: the model this spawn ran because the pass names none, as the vendor said (adapters/types.ts
   * META_MODEL_USED); with `modelReplaced`, the model its own settings named, which the account is not offered (so
   * Dim Factory ran the account's default, modelUsed). Cleared at each spawn; the pass is priced at modelUsed.
   */
  modelUsed?: string
  modelReplaced?: string
  /**
   * The account's default Dim Factory asked the vendor to run on turn/start in place of
   * modelReplaced (META_MODEL_USED `{asked, replaced}`), which the vendor has not confirmed running: modelUsed stays
   * unset until it does (`{model, replaced}`), and this is cleared then. Cleared at each spawn.
   */
  modelAsked?: string
  /**
   * With modelUsed, the model the vendor moved this turn away from (Codex's `model/rerouted`: modelUsed is
   * its `toModel`, this its `fromModel`; META_MODEL_USED `{model, rerouted, replaced?}`). Cleared at each spawn.
   */
  modelRerouted?: string
  /**
   * Live balanced run: the vendor said, for this spawn, that it names no model (META_MODEL_USED `{model: null}`:
   * Codex's thread answered without one), so the card stops expecting one (derive.ts awaitsModelWord). Cleared at each
   * spawn and when a model is said.
   */
  modelUnreported?: boolean
  mode?: Mode
  planMode?: PlanMode
  planFallbackReason?: string
  route?: string
  argv?: string[]
  sessionId?: string
  sessionNote?: string
  /** StepView.freshDetail, set with a fresh spawn's note from its launch's `freshDetail`. */
  freshDetail?: FreshDetail
  proc?: ProcState
  lastEventAt?: number
  keepWaitingAt?: number
  /** Tool ids (or names) between `tool{phase:'start'}` and its `end`. */
  inFlightTools: string[]
  /** FIFO. */
  asks: AskState[]
  /** The last `done`'s usage (per-attempt views and estimates); every attempt's spend is in `spent`. */
  usage?: Usage
  usageApprox?: boolean
  /** The cost of `usage`, frozen at `done` (`ReducerContext.cost`, else the vendor's figure or none). */
  cost?: StepCost
  /** What every attempt of the step spent so far (run totals); absent until the first usage arrives. */
  spent?: StepSpend
  /** UTF-8 bytes of the last spawn's prompt (`RunSummary.steps[].inBytesBucket`, estimates). */
  inBytes?: number
  result?: string
  planCaptured?: string
  failure?: Failure
  /**
   * How many fresh retries after `context_exceeded` the step has made; each halves its prompt diff budget once
   * more (LaunchPlan.diffTrim). Absent: none.
   */
  diffTrim?: number
  /** A snag card is showing for this failed step. */
  snagOpen: boolean
  /** The pass's one automatic retry has been spent. */
  autoRetryUsed: boolean
  startSnap?: SnapshotRef
  endSnap?: SnapshotRef
  endSnapStatus?: 'requested' | 'done' | 'failed'
  /**
   * The folder when the pass's last attempt ended without finishing (P17's `stopped` / a pause's snapshot, or
   * P16's `pre-retry`), cleared by the next spawn. `revert-then-fresh` reverts only what `startSnap..attemptEnd`
   * changed, so edits made while the pass sat failed stay.
   */
  attemptEnd?: SnapshotRef
  launch?: PendingLaunch
  /** Recovery snapshot to take once the process has exited (P9b/P10/P14/P17/P26). */
  exitSnapshot?: SnapshotLabel
  /** P19 continuation chosen when the step paused. */
  resumeContinuation?: string
  /**
   * P10: the ask that timed out (for "Allow & resume"). `rule` = the exact AllowRule the adapter reported for it
   * (meta `lateAllowRule`); Resume with `allowTimedOutAsk` adds it to `allowRules` (P19).
   */
  timedOutAsk?: { requestId?: string; kind: AskKind; detail: string; rule?: AllowRule }
  /** Adapter `meta` signals (failureHints, usageApprox, resumeIgnored, …). */
  meta: Record<string, unknown>
  /** Asks the adapter answered itself over every attempt (StepView.autoAnswered); absent while none. */
  autoAnswered?: AutoAnsweredCounts
  /** StepView.chip (Implement: "N files changed during planning"). */
  chip?: string
  /**
   * Plan-end guard (Plan only): the edit/write/shell tool events (ids) and auto-answered writes the step
   * reported, a declined tool left out. Non-empty ⇒ the `plan-end` snapshot is compared with `run-start` (R4).
   */
  writes?: string[]
  /**
   * P15 (mutating passes): `hold` while the end-of-pass reconcile needs the user (its card is open, or the
   * recheck or restore the user chose is running); the run's next step waits.
   */
  endCheck?: 'hold'
  /**
   * The step's AI diagnosis (StepView.heal), kept until the step's next snag. `healId` names the `heal` effect a
   * `running` heal waits for (a result for another id is stale).
   */
  heal?: HealState
  /** wait_until: the retry this failed step waits for (StepView.wait); cleared with its snag. */
  wait?: WaitState
  /** A verify round (verify:1 / verify:2 only): its commands, trust decisions and results (StepView.verify). */
  verify?: VerifyRoundState
  /**
   * The pass's context: the vendor's reports (meter, compactions, breakdown), the spawn's setup and the detectors' tool
   * counters (core/context/state.ts). Reset by a fresh spawn, kept by one that continues the session.
   */
  context?: ContextState
  /**
   * What the pass's tools left for the grounding checks (shell commands by kind, failed edits, reads, edits without a
   * read: counts and paths, never commands). Reset by a spawn; a resumed session keeps what it read.
   */
  grounding?: GroundingTrack
  /** Context health's reactions in this pass (StepReactions): the restart after compactions, the loop card. */
  reactions?: StepReactions
}

/**
 * StepState.reactions. `restart`: what became of the restart after compactions (once per pass): the card is open
 * (`offered`), the user kept going (`declined`), it restarted (`restarted`), or Auto's budget was spent (`noted`).
 * `loop`: the calls the loop card warned about (`<spawnNo>:<fingerprint>`; Keep going keeps them quiet), the spawn the loop stop
 * ended, and whether Auto's one fresh retry after a loop was spent.
 */
export interface StepReactions {
  restart?: 'offered' | 'declined' | 'restarted' | 'noted'
  loop?: { warned: string[]; stoppedSpawn?: number; retried?: true }
}

/** StepState.heal. */
export type HealState = HealView & { healId: number }

/**
 * StepState.wait. `auto`: Dim Factory armed it on its own (a rate limit, while the pass's automatic retry was
 * unspent); the retry it fires spends that budget. A wait the user armed never does.
 */
export type WaitState = WaitView & { auto?: true }

/**
 * Spend of one step over all its attempts: each `done`'s usage and cost, and the usage a failed attempt
 * reported (adapter meta `usage`: an error result still bills). Each spawn counts once.
 */
export interface StepSpend {
  /** input + output + cache read + cache write, summed. */
  tokens: number
  /** Summed cost of the priced attempts; null while no attempt had a price. */
  usd: number | null
  /** The cost bases of the priced attempts (the footer says "reported" / "estimated" from these). */
  bases: CostBasis[]
  /** Some priced attempt's figure is what its tokens would cost on the API (a subscription covers it). */
  apiEquivalent: boolean
  /** Some counted attempt's usage was approximate. */
  approx: boolean
  /** The last spawn counted. */
  spawnNo: number
}

export interface CardState {
  view: CardView
  step?: StepKey
  openedAt: number
}

export interface PlanState {
  /** The plan stage is over: approved, skipped, or proceeding without a plan. */
  decided: boolean
  /** The text Implement receives (`{{plan}}`); null = Implement gets the task only. */
  text: string | null
  /** The plan as produced, before gate edits. */
  original?: string
  edited: boolean
  /** INSUFFICIENT_CONTEXT message while the R3 card is open. */
  insufficient?: string
}

export interface SessionState {
  vendor: string
  step: StepKey
  /** `handle.cumulativeUsage()` at the last exit; passed back as `resume.priorUsage`. */
  lastTotals?: Usage
  /** The folder the session was started in (where canResume looks; decideSession's cwd rule). */
  cwd?: string
}

export interface StopState {
  at: number
  by: 'stop' | 'close'
  /** R13: the `stopped` snapshot, taken once every process has exited; the lock is released after it. */
  snapshot: 'none' | 'todo' | 'requested' | 'done'
}

export interface FlowState {
  runStart: 'none' | 'requested' | 'done' | 'failed'
  /** `all` for in-place runs as soon as preflight passes. */
  prepared: 'none' | 'setup' | 'all'
  /**
   * R6/R7 → R8 (absent until R6 passes S1 with changes): `reconcile` = reconcile(pre-review) outstanding ·
   * `running` = Review ∥ Critic launched, the join waits for both · `post-review` = the join's snapshot outstanding ·
   * `joined` = R8 decides (skip rule, gate, pre-Fix).
   */
  review?: 'reconcile' | 'running' | 'post-review' | 'joined'
  /** R9/R10: `gate` = gate:beforeFix open · `started` = the pre-Fix boundary began (Fix's launch pipeline). */
  fix?: 'gate' | 'started'
  /**
   * R4 plan-end guard (only when Plan reported a write): `wait` = for `run-start` (an earlier build's run.json;
   * R2 now spawns Plan after it) · `requested` = the plan-end snapshot · `card` = planMutated open · `reverting` =
   * Revert Plan's changes running · `done`.
   */
  planEnd?: 'wait' | 'requested' | 'card' | 'reverting' | 'done'
  /**
   * "Crash relaunch … Never auto-resume" for run-level boundary work: a relaunch (or quit) found the
   * S1 / S2 end snapshot, the pre-review reconcile, the post-review snapshot or a findings parse outstanding. That
   * git and parser work is re-issued, but the next pass it leads to (Review ∥ Critic, Fix, a reviewer's retry after
   * an empty output) is set paused(<hold>) instead of launched. Cleared by the user continuing the run (Resume,
   * Retry, Continue without, a card choice), by Stop and by completion.
   */
  hold?: Extract<PauseReason, 'interrupted' | 'interrupted-by-quit'>
  /**
   * R7: verify:1 is over and the `post-verify-1` snapshot is `requested`, then `done` (reconcile(pre-review) and
   * Review ∥ Critic follow). Absent while verify:1 did not run.
   */
  postVerify1?: 'requested' | 'done'
  /** Test-first: the red check is over and the `post-red` snapshot is `requested`, then `done` (Implement follows). */
  postRed?: 'requested' | 'done'
}

/** Run-level boundary work, counted as its step running (derive.ts). */
export type BoundaryName =
  | 'post-implement'
  | 'pre-review'
  | 'post-review'
  | 'post-fix'
  /** R7: the post-verify-1 snapshot (counts as verify:1 running). */
  | 'post-verify-1'
  /** Test-first: the Tests step's end snapshot and end-of-pass check (counts as the Tests step running). */
  | 'post-tests'
  /** Test-first: the post-red snapshot (counts as verify:red running). */
  | 'post-red'
  /** Test-first: comparing the tests before and after Implement (counts as Implement running). */
  | 'tests-check'
  /** Fix until green: the post-round snapshot before the next round (counts as Fix running). */
  | 'post-round'
  /** The Deploy step's end snapshot and end-of-pass check (counts as the Deploy step running). */
  | 'post-deploy'
  // ---- grounding checks (core/grounding) ----
  /** The grounding checks after Implement (counts as Implement running). */
  | 'grounding-check'

// ---- findings (the findings parser; contracts in src/shared/findings.ts) ---------------------------------------

/** The read-only passes whose output is parsed into findings (P15); the same set as shared `ReviewerSource`. */
export type ReviewerPass = Extract<PassName, 'review' | 'critic' | 'security'>

/**
 * A finding as the parser reports it (`ParsedSource.findings` of findings/parse.ts fits as is). The reducer sets
 * `source` to the pass, `n` at the join, `round` 1 when absent, `flags` [] when absent.
 */
export type FindingInput = Pick<Finding, 'id' | 'severity' | 'title' | 'body'> &
  Partial<Pick<Finding, 'n' | 'source' | 'flags' | 'round' | 'level'>>

export interface SourceFindings {
  /** `parsing` while the `parseFindings` effect is outstanding; then the parser's verdict. */
  status: 'parsing' | SourceParseStatus
  /** The attempt whose output this is. */
  attempt: number
  findings: Finding[]
  /** An `empty` output treated as none (the user's [Treat as none], or Auto with a warning). */
  treatedAsNone?: boolean
  /** How many of this reviewer's outputs so far were empty (the emptyFindings card and Auto note say so). */
  emptyOutputs?: number
}

export interface FindingsState {
  /** Latest parse per reviewer. A failed reviewer keeps its previous entry (or none). */
  sources: Partial<Record<ReviewerPass, SourceFindings>>
  /** Merged at the join (R8): must first, numbered F1…. */
  list: Finding[]
  /** Finding ids Fix addresses, in list order: the gate's selection (R9), else every finding. */
  selected: string[]
  /** The Fix prompt's `Notes:` list (LaunchPlan.notes): reconcile(pre-fix) info notes and reverts. */
  notes: string[]
  /**
   * The latest verify round's findings (`[must]` per failing command, `[should]` per command Auto skipped as
   * untrusted; source `verify`). verify:1's join the reviewers' at R8; verify:2's are listed after Fix.
   */
  verify?: { step: VerifyRound; findings: Finding[] }
  /**
   * The run's latest preview smoke check (`[should]`, source `preview`: console errors on the page, and a look at its
   * picture). A repeat check replaces the earlier one's, so the same error is never listed twice. Joined runs list them
   * after the join's findings; Re-run from Fix offers them either way.
   */
  preview?: Finding[]
  /**
   * Findings that turned out wrong: Fix disputed them and the checks after Fix confirm the code was fine (verify
   * passed and no re-check kept them open). `disputed` counts every finding Fix disputed, confirmed or not.
   */
  wrong?: WrongFindings
}

/** FindingsState.wrong (findings.json `metrics`, RunSnapshot.findingsWrong). */
export interface WrongFindings {
  /** Finding ids Fix disputed, in the order it said so. */
  disputed: string[]
  /** Of those, the ids the checks after Fix confirmed were fine. */
  wrong: string[]
}

// ---- isolated runs (worktree; the verify:0 baseline; R2/R5/R12) ------------------------------------------------

/**
 * The worktree an isolated run works in: `<home>/worktrees/<runId>` on `branch`, made from HEAD (`base`). A copy made
 * from a snapshot (RunState.copyFrom) has no branch (an empty string), and its `base` is the snapshot's tree.
 */
export interface WorktreeInfo {
  path: string
  branch: string
  base: string
  /**
   * The run's folder inside the worktree, relative to its root (`/` separators; '' for the root): the run's folder may
   * be a subfolder of its repository, and the worktree is the whole repository.
   */
  rel?: string
}

/** One prepare row as the reducer keeps it (StepView.prepare.steps). */
export interface PrepareRowState {
  id: PrepareStepId
  status: PassStatus
  detail?: string
}

/**
 * The install the deps row runs: the view, plus the prepare module's own plan (`DepsPlan`, opaque here: the controller
 * made it and gets it back for the install and the grant).
 */
export interface DepsCommandState extends DepsCommandView {
  plan: unknown
}

/** An install's result (src/core/prepare runInstall), as the deps row and depsFailed show it. */
export interface InstallOutcome {
  status: 'pass' | 'fail' | 'env' | 'skipped' | 'skipped-untrusted'
  exitCode: number | null
  durationMs: number
  excerpt: string
  reason?: string
  timedOut?: boolean
}

/**
 * Step 3 (deps). `deciding` = the `rest` effect is out (installCommand or detection, and the grant check) · `consent`
 * = depsConsent is open · `granting` = [Install] writes the grant · `installing` · `failed` = depsFailed is open ·
 * `done` · `skipped` (install off, nothing to install, [Skip install]).
 */
export interface DepsState {
  phase: 'deciding' | 'consent' | 'granting' | 'installing' | 'failed' | 'done' | 'skipped'
  command?: DepsCommandState
  /** The text the `deps` grant's hash covers, as read for this command (the consent card grants exactly it). */
  body?: string
  /** How the command stands against the SOURCE folder's `deps` grants. */
  trust?: 'trusted' | 'untrusted' | 'changed' | 'invalid'
  /** [Edit command]: the user's command line, used instead of installCommand or detection from then on. */
  edited?: string
  /** The open depsConsent / depsFailed card. */
  cardId?: string
  /** Installs started so far (a stale result is dropped). */
  installs: number
  result?: InstallOutcome
}

/** One apply (worktree.undoApply undoes it by `token`). */
export interface ApplyRecord {
  no: number
  token: string
  at: number
  applied: string[]
  /** Files left as they are in the folder (a conflict kept as the user's, or not chosen yet). */
  conflicts: string[]
  undone?: true
}

/** An Apply or Undo waiting for the folder lease, or running. */
export type FinalizeOp =
  | {
      kind: 'apply'
      no: number
      paths?: string[]
      resolutions?: Record<string, 'mine' | 'theirs'>
      /** [Finish apply]: the journal in run.json carries on where the crashed apply stopped. */
      resume?: true
      /** worktree.apply (the Diff tab), not the finalize card. */
      ipc?: true
      /** The finalize state before it (an apply that fails before writing anything goes back to it). */
      from?: FinalizeState
    }
  | { kind: 'undo'; token: string }

/**
 * R12 finalize (finalize and apply). `state` is FinalizeView.state. The run's outcome is fixed before this
 * starts (RunState.outcome) and never changes here; the run completes once finalize is done or skipped (kept).
 */
export interface FinalizeRunState {
  state: FinalizeState
  /** The preview's count of files the run changed, and the conflicts the last preview or apply found. */
  files?: number
  conflicts?: { path: string; reason?: string }[]
  /** The SOURCE folder's lock, leased for an apply or its undo ("Lease the folder lock"). */
  lease: 'none' | 'requested' | 'held'
  op?: FinalizeOp
  /** Applies so far (latest last, at most 20). */
  applies: ApplyRecord[]
  applyNo: number
  /** The finalize / finalizeConflicts / interruptedApply card open now. */
  cardId?: string
  /** Discard: the deferred deletion (10 s), what Undo goes back to, and whether the deletion has begun. */
  discard?: { token: string; deleteAt: number; back: FinalizeState; removing?: true }
  /** UI copy: why the last apply, undo or deletion did not finish. */
  error?: string
  /** The `no` of an apply that failed (the IPC waiter reads it with `error`). */
  failedNo?: number
  /** The files and resolutions of the apply a crash interrupted ([Finish apply] carries them on). */
  resume?: { paths?: string[]; resolutions?: Record<string, 'mine' | 'theirs'> }
}

/** RunState.isolation (isolated runs only). */
export interface IsolationState {
  rows: PrepareRowState[]
  worktree?: WorktreeInfo
  /** Uncommitted changes in the folder the worktree does not include (it starts from HEAD). */
  uncommitted?: number
  deps?: DepsState
  /** verify:0's results by command name (runs/<id>/verify/baseline.json): a failure there is pre-existing. */
  baseline?: Record<string, 'pass' | 'fail' | 'env'>
  /** Step 5 (`isolation.verifyReady`): `checking` · `env` = its verifyEnv card is open · `done` · `skipped`. */
  /**
   * Step 5. `skipped`: the verify commands the user chose [Skip verify] for on the readiness card; verify:1 and
   * verify:2 report them as not run without asking again.
   */
  ready?: { phase: 'checking' | 'env' | 'done' | 'skipped'; cardId?: string; skipped?: string[] }
  /**
   * The dependency install or the verify:0 baseline started writing in the isolated copy (R2: alongside Plan). The
   * plan-end guard cannot tell their changes from Plan's then, so it notes them instead of opening planMutated (whose
   * Revert would also undo the install).
   */
  copyWritten?: true
  finalize?: FinalizeRunState
}

/**
 * RunState.rerunOf (Re-run, Re-run from Fix, R14). `from: 'fix'`: Plan,
 * Implement, Review and Critic are carried from the source (skipped "carried from run #N", with their snapshots,
 * findings and sessions), and the run starts at the pre-Fix boundary (R10).
 */
export interface RerunOf {
  runId: string
  displayNo: number
  from: 'start' | 'fix'
  /** `fix`: the source's last result snapshot, what R10's reconcile compares the folder with. */
  base?: SnapshotRef
}

/**
 * One resolved.json `patches[]` entry (Re-run applies them in order). RunState.configPatches
 * keeps the entries the reducer accepted, so a patch whose resolved.json append a crash cut short is appended at the
 * run's next load.
 */
export interface ConfigPatchRecord {
  at: number
  ops: JsonPatchOp[]
  label: string
  /** `recovery`: a fix the user clicked; `self-heal`: autoApplyConfigPatches; `auto`: the user switched the run to Auto. */
  source: 'recovery' | 'self-heal' | 'auto'
  step?: AgentStep
  actionId?: string
}

export interface RunState {
  schemaVersion: 1
  /** What guardrails did in this run. Absent until one fires. */
  guardrails?: {
    fired: number
    undone: number
    stopped: boolean
    blocked?: number
    /**
     * What a guardrail refused or put back, one line each, for the Review, Critic, Security and Fix prompts: a reviewer
     * that sees a change missing must not ask Fix to make it again. Absent until one does.
     */
    refused?: string[]
  }
  runId: string
  displayNo: number
  folder: string
  folderKey: string
  title: string
  task: string
  profile: string
  /** The recipe the run used; absent without one (and in an earlier build's run.json). */
  recipe?: RunRecipe
  createdAt: number
  config: RunConfig
  /** R1 applied. */
  started: boolean
  /** Folder lock: `requested` = queued in the scheduler, `held` = owned. */
  lock: 'none' | 'requested' | 'held'
  /** Cached derivation (derive.ts); `run-status` is emitted when it changes. */
  status: RunStatus
  phase: RunPhase
  outcome?: RunOutcome
  failure?: { step: StepKey; category: FailureCategory }
  steps: Record<StepKey, StepState>
  /** Open cards only. */
  cards: CardState[]
  /** Armed timers: id → due. A timer event whose `due` differs is stale. */
  timers: Record<string, number>
  requests: Record<string, PendingRequest>
  /** `revert`: revert tokens; `heal`: heal ids (absent = 0). */
  counters: { req: number; card: number; revert?: number; heal?: number }
  flow: FlowState
  /** Run-level work that belongs to a step (counts as that step running for status/phase). */
  boundary?: { name: BoundaryName; step: StepKey }
  plan: PlanState
  /** Review/Critic findings (created when the first reviewer finishes; absent in runs without reviewers). */
  findings?: FindingsState
  allowRules: AllowRule[]
  sessions: Record<string, SessionState>
  snapshots: Partial<Record<SnapshotLabel, SnapshotRef>>
  /** Output file versions (the `output` body). */
  outputs: Partial<Record<RunOutputFile, number>>
  notes: string[]
  diffStats?: { files: number; added: number; deleted: number; live: boolean }
  /** Expected HEAD, Dim Factory's own writes, reverts (absent until the first fact). */
  git?: RunGitState
  /** R5: the run branch (`isolation.branch: runBranch`) once created; RunSnapshot.branch. */
  branch?: RunBranchInfo
  /**
   * R5 write-ahead: the run branch about to be made (recorded before its ref writes), or one Dim Factory made and
   * could not remove again. Settled at the next branch prep or relaunch (git/branch.ts settlePendingBranch).
   */
  branchPending?: RunBranchInfo
  /** An isolated run's worktree, prepare rows, deps, baseline and finalize (absent for in-place runs). */
  isolation?: IsolationState
  /** R14: the run this one re-runs (Re-run, or Re-run from Fix); absent for a run started anew. */
  rerunOf?: RerunOf
  /** A match's side: the match and the side this run builds (absent for a run of its own). */
  matchOf?: MatchRef
  /** An isolated run whose copy is written from a snapshot (a match's starting point), not a git worktree. */
  copyFrom?: SnapshotCopySource
  /** The run's rendered Brief (`{{brief}}` in every pass prompt); absent without one. */
  brief?: string
  /** The Brief's category (its pack id); absent without a Brief (and in an earlier build's run.json). */
  category?: string
  /** The Brief's pack's security focus (`{{focus}}` for Security and the critic); absent when it has none. */
  securityFocus?: string
  /** The project memory as the run read it at its start (`{{memory}}` in every pass prompt); absent without one. */
  memory?: string
  /** The project's quality gates as the run ended (RunConfig.quality); absent without gates or before the end. */
  gates?: QualityGatesView
  /** Test-first: what the Tests step wrote and the check of them after Implement (absent until the step ends). */
  testFirst?: TestFirstState
  /** The grounding checks after Implement and after each Fix round (absent until the first one starts). */
  grounding?: GroundingRunState
  /** The security advisor: its scan and the re-check after Fix (absent until the scan starts). */
  security?: SecurityRunState
  /** Clarify: its questions and the answers (absent until it has answered). */
  clarify?: ClarifyState
  /** Research: its parsed answer and what was kept for Plan (absent until it has answered). */
  research?: ResearchState
  /** Fix until green: its rounds (absent until Fix's first round starts, and in a run without it). */
  fixLoop?: FixLoopState
  /** The Deploy step: the outcome it holds back, its plan and what it wrote (absent until it begins). */
  deploy?: DeployRunState
  /** The plan's acceptance criteria and the acceptance review's verdicts (absent until the plan is decided). */
  acceptance?: AcceptanceState
  /** Explain it to me: the outcome it holds back (absent until it begins). */
  explain?: ExplainRunState
  /**
   * Write-ahead: the recovery patches this run accepted (P22), in order, as resolved.json `patches[]` records them;
   * absent until the first. resolved.json is written after the reducer accepts a patch, so this is the write-ahead.
   */
  configPatches?: ConfigPatchRecord[]
  stop?: StopState
  liveCount: boolean
  suspendedAt?: number
  endedAt?: number
}

/**
 * RunState.testFirst. `files`: the paths the Tests step changed (T0..T1, at most CHANGED_PATHS_MAX). `guard`: the
 * comparison of those files at T1 and at Implement's end: `requested` while it runs, then `ok`, `weakened` (its
 * `[must]` findings, source `tests`, join the reviewers' at R8) or `failed` (a note says why).
 */
export interface TestFirstState {
  files: string[]
  guard?: 'requested' | 'ok' | 'weakened' | 'failed'
  findings?: Finding[]
  /** How many times the tests were sent back to be rewritten (the testsNotRed card's Auto default reads it). */
  rewrites?: number
}

/**
 * RunState.deploy. `pending`: the outcome the run reached before the Deploy step (it completes with it once the step
 * is over). `phase`: `planning` (the deploy-plan request is out) · `generating` (the editing pass) · `done`. `plan`: what
 * planning found; `written`: the files the pass changed (deploy-start..deploy-end).
 */
export interface DeployRunState {
  pending?: { outcome: RunOutcome }
  phase: 'planning' | 'generating' | 'done'
  plan?: DeployPlanFacts
  written?: string[]
  note?: string
}

/**
 * RunState.acceptance. `criteria`: the decided plan's (AC1…ACn; none when it has no such section). `tests`: the tests
 * the Tests step mapped to each. `results`: the acceptance review's verdicts. `findings`: the [must] findings its unmet
 * criteria became (Fix until green on); they join the reviewers' at R8. `review`: `checking` while the review runs,
 * `done`, `skipped` (with `note`).
 */
export interface AcceptanceState {
  criteria: AcceptanceCriterion[]
  dropped?: number
  tests?: Record<string, string[]>
  review?: 'checking' | 'done' | 'skipped'
  results?: Record<string, { status: 'met' | 'not-met' | 'unknown'; evidence?: string }>
  findings?: Finding[]
  note?: string
}

/** One run of the grounding checks (RunState.grounding.checks): requested, then its findings and notes. */
export interface GroundingCheckState {
  phase: 'requested' | 'done' | 'failed'
  findings: Finding[]
  notes: string[]
}

/**
 * RunState.grounding: the checks after Implement (`implement`) and after each Fix round (`fix:<round>`), and the Fix
 * report's contradictions already raised (finding ids), so a round raises each once.
 */
export interface GroundingRunState {
  checks: Record<string, GroundingCheckState>
  contradicted?: string[]
}

/** RunState.explain. `pending`: the outcome the run reached before Explain (it completes with it once Explain is over). */
export interface ExplainRunState {
  pending?: { outcome: RunOutcome }
  note?: string
}

/** One dependency audit of the scan, with its trust decision (as VerifyCommandState's) and its result. */
export interface ScanAuditState {
  name: string
  /** The audit tool (security/audit.ts AuditTool). */
  tool: string
  argv: string[]
  cwdRel: string
  /** The lockfile it audits (the added-vs-existing diff reads it at the run's base and after Implement). */
  lockfile: string
  body: string | null
  trust: VerifyTrust
  grantedBody?: string | null
  decision: VerifyDecision
  status: ScanAuditView['status']
  reason?: string
  introduced?: number
  existing?: number
  /** The trust card asking about it (decision `ask`). */
  cardId?: string
}

/**
 * RunState.security.scan: `check` = the scan-check is out · `trust` = trust cards open or grants being written ·
 * `running` = the scan runs · `done`. The scan's findings join the reviewers' at R8 (source `scan`).
 */
export interface ScanState {
  phase: 'check' | 'trust' | 'running' | 'done'
  attempt: number
  audits: ScanAuditState[]
  secrets: ScanSecretView[]
  advisories: ScanAdvisoryView[]
  existing: number
  notes: string[]
  findings: Finding[]
  /** The run's changes touch code that handles keys, sign-in, payments or people's data (security/sensitive.ts). */
  sensitive?: boolean
}

/** RunState.security.recheck: the re-check after Fix, over the security [must] findings Fix was given. */
export interface RecheckState {
  /** The F-numbers it checks. */
  checks: number[]
  status: RecheckView['status']
  resolved: number[]
  open: { n: number; reason?: string }[]
}

/** RunState.security. */
export interface SecurityRunState {
  scan?: ScanState
  recheck?: RecheckState
}

/** RunState.research (StepView.research; `cardId`: the research card while it is open). */
export interface ResearchState {
  status: ResearchView['status']
  result?: ResearchResult
  chosen?: string[]
  answers?: Record<string, string>
  auto?: boolean
  note?: string
  cardId?: string
}

/** RunState.clarify (StepView.clarify; `cardId`: the Clarify card while it is open). */
export interface ClarifyState {
  status: ClarifyView['status']
  questions: ClarifyQuestion[]
  answers?: string[]
  note?: string
  cardId?: string
}

/**
 * One round of Fix until green. `base`: the run's spend and working time when it began (what it spent is the
 * difference at its end). `count`: the [must] findings and failing verify commands still open after it.
 */
export interface FixRoundState {
  n: number
  status: FixRoundView['status']
  startedAt: number
  base: { usd: number | null; activeMs: number }
  /** Fix's spawn count when the round began (a round that has not spawned yet redoes R10 on Resume or Retry). */
  spawnFrom: number
  changed?: boolean
  failing?: string[]
  resolved: number[]
  open: number[]
  count?: number
  usd: number | null
  activeMs: number
  /** FixRoundView.views: the round's three steps as they ended (kept in run.json; absent while it runs). */
  views?: FixRoundView['views']
  /**
   * Where the round's Fix started and ended (its start snapshot and its end snapshot S2), recorded when the round
   * closes: the Diff tab's per-round segment (`fix-round-<n>`). Absent while it runs and in a run.json written before.
   */
  startSnap?: SnapshotRef
  endSnap?: SnapshotRef
}

/**
 * RunState.fixLoop. `round`: the round under way (1-based). `before`: what was open before round 1 (the [must]
 * findings Fix got). `targets`: the F-numbers Fix gets in this round (rounds ≥ 2: what is still open). `firstStart`:
 * Fix's start snapshot in round 1 (the Fix diff segment spans every round). `postRound`: the post-round snapshot
 * before the next round.
 */
export interface FixLoopState {
  round: number
  rounds: FixRoundState[]
  before: number
  targets?: number[]
  firstStart?: SnapshotRef
  postRound?: 'requested'
  stop?: { reason: FixStopReason; text: string }
  /**
   * verify:2's [must] findings by id, as first listed (F-number): a command that still fails in a later round keeps
   * its finding instead of listing it again.
   */
  verifyN?: Record<string, number>
}

/** An audit as the scan-check reports it: the trust check's fields plus what it audits. */
export interface ScanCheckAudit extends VerifyCheckCommand {
  tool: string
  lockfile: string
}

/** An audit as the scan effect hands it to the controller. */
export interface ScanRunAudit {
  name: string
  tool: string
  argv: string[]
  cwdRel: string
  lockfile: string
  /** false: not run (`status` / `reason` are its result). */
  run: boolean
  status?: 'skipped'
  reason?: string
}

/** One audit's result from the scan. */
export interface ScanAuditResult {
  name: string
  status: ScanAuditView['status']
  reason?: string
  introduced?: number
  existing?: number
}

// ---- events ---------------------------------------------------------------------------------------------------

export type UserCommand =
  /** `asks.answer`. `graceMs` defaults to 3000 for `app`, 0 for `notification` / `cli` (P9). */
  | {
      kind: 'answer'
      requestId: string
      decision: Exclude<AskDecision, 'cancel'>
      via: AnswerVia
      graceMs?: number
    }
  /** `asks.undo` (P9u). */
  | { kind: 'undo-deny'; requestId: string }
  /** `cards.resolve`. */
  | { kind: 'card'; cardId: string; choiceId: string; input?: CardChoiceValue }
  /** `runs.keepWaiting` (P13). */
  | { kind: 'keep-waiting'; step: AgentStep }
  /** `runs.stop` / `runs.close` (R13, P3/P18/P25). */
  | { kind: 'stop' }
  | { kind: 'close' }
  /**
   * `runs.resume` (P19/P20, runner steps rerun). `canResume` = `adapter.canResume()` per paused pass, checked by
   * the controller before dispatching (absent ⇒ assumed ok; a startup `resume_failed` still falls back to fresh).
   */
  | {
      kind: 'resume'
      allowTimedOutAsk?: boolean
      canResume?: Partial<Record<AgentStep, { ok: boolean; reason?: FreshReason }>>
    }
  /**
   * `runs.retryPass` (P21). `continuation`: a `resume` action's own text for a resume retry (else "Previous attempt
   * failed: …; continue.").
   */
  | { kind: 'retry'; step: AgentStep; strategy?: RetryStrategy; continuation?: string }
  /** `runs.skipPass` = Continue without (P23). */
  | { kind: 'skip'; step: AgentStep }
  /**
   * P22: a `config_patch` (or switch_vendor) was applied to the run's resolved config. `config` is the patched
   * projection; the controller swaps its ResolvedConfig and records resolved.json `patches[]` when the reducer accepts
   * it (`apply-patch` effect with `patchId`). With `step` (a failed pass) the pass is retried (P21), or skipped when the
   * patch turned it off; without one (a preflight card's fix) only the config changes.
   */
  | {
      kind: 'config-patch'
      step?: AgentStep
      config: RunConfig
      label: string
      patchId: string
      strategy?: RetryStrategy
      /** The resolved.json entry the patch becomes (RunState.configPatches). */
      entry?: ConfigPatchRecord
    }
  /**
   * `runs.switchToAuto`: the run goes on in Auto (auto-switch.ts). `config` is the run's config in Auto; like a
   * `config-patch`, the controller swaps its ResolvedConfig and records `entry` in resolved.json `patches[]` when the
   * reducer accepts it. Unlike one, it is taken while passes run: their pending asks are approved, and so is every
   * later ask of a spawn launched before the switch (it still runs in its earlier mode).
   */
  | { kind: 'auto-on'; config: RunConfig; patchId: string; entry: ConfigPatchRecord }
  /** `heal.diagnose` / a `heal` action: diagnose the failed pass's failure with AI. */
  | { kind: 'heal'; step: AgentStep }
  /** `wait_until`: arm or disarm the failed pass's wait (`arm` absent: toggle). */
  | { kind: 'wait'; step: AgentStep; arm?: boolean }
  /**
   * `diff.revert`: revert to S0 (F0 for the `fix` segment) for `paths`, or for every path the segment changed.
   * Refused (FOLDER_BUSY) while a process holds the folder or Dim Factory is working in it.
   */
  | { kind: 'revert'; seg?: DiffSegment; paths?: string[] }
  /** `diff.undoRevert`. */
  | { kind: 'undo-revert'; token: string }
  /**
   * `worktree.apply` (the Diff tab's "Apply to folder…": all files, or the reviewed ones): apply the isolated run's
   * changes to the folder under the folder's lease. `resolutions` settles conflicts (Keep mine / Take run's).
   */
  | { kind: 'apply'; paths?: string[]; resolutions?: Record<string, 'mine' | 'theirs'> }
  /** `worktree.undoApply`: restore the applied files to the `pre-apply` snapshot. */
  | { kind: 'undo-apply'; token: string }
  /** `worktree.discard`: delete the worktree in 10 s (undoable until then). */
  | { kind: 'discard' }
  /** `worktree.undoDiscard`. */
  | { kind: 'undo-discard'; token: string }

export type EngineEventBody =
  /** R1: `runs.start` passed the authoritative preflight and resolved.json is written. */
  | { t: 'created' }
  /** R2: the scheduler granted the folder lock. */
  | { t: 'lock-acquired' }
  /** The scheduler granted the SOURCE folder's lease for an apply or its undo (an isolated run). */
  | { t: 'lease-acquired' }
  | { t: 'preflight-result'; req: string; report: PreflightReport }
  /**
   * A prepare stage's answer. `setup`: the worktree, the folder's uncommitted changes it
   * does not include, the copy-ins and their notes. `rest`: the deps decision (`deps` absent or null: nothing to install;
   * `skip`: why the row is skipped, e.g. install off). `install`: the install's outcome. `ready`: the verify commands
   * whose program does not resolve in the worktree. `ok: false` + `failure`: the stage itself could not run.
   */
  | {
      t: 'prepare-result'
      req: string
      ok: boolean
      failure?: Failure
      worktree?: WorktreeInfo
      uncommitted?: number
      copied?: number
      notes?: string[]
      deps?: { command: DepsCommandState; body?: string; trust: DepsState['trust']; reason?: string } | null
      skip?: string
      install?: InstallOutcome
      missing?: { name: string; argv: string[]; reason?: string }[]
    }
  /** The install wrote new output (announced as an `output` body for `prepare`). */
  | { t: 'prepare-progress'; req: string; output?: true }
  /** R12: what Apply would do (worktree preview): the files the run changed and the conflicts now. */
  | {
      t: 'finalize-preview'
      req: string
      files?: number
      conflicts?: { path: string; reason?: string }[]
      failure?: Failure
    }
  /** An apply's outcome (git/finalize applyRun), or why it did not run (`failure`; nothing written past P). */
  | {
      t: 'apply-result'
      req: string
      applied?: string[]
      conflicts?: { path: string; reason?: string }[]
      undoToken?: string
      /** Files left alone with why (gitlinks, links, unreadable), as run notes. */
      notes?: string[]
      failure?: Failure
      /** With `failure`: the journal holds an apply left part way ([Finish apply] carries it on). */
      interrupted?: true
    }
  /** worktree.undoApply's outcome (`error`: refused or failed; `conflict`: a file changed since the apply). */
  | { t: 'undo-apply-result'; req: string; ok: boolean; error?: string; conflict?: true }
  /** Discard's deletion (worktree remove → update-ref -d → prune); `error` when it could not finish. */
  | { t: 'remove-result'; req: string; ok: boolean; error?: string; notes?: string[] }
  /**
   * `warnings`: e.g. unreadable files, nested repositories (SnapshotRecord.unreadable/nested); they become run notes
   * (each once). `nested` = nestedReposKey(SnapshotRecord).
   */
  | {
      t: 'snapshot-done'
      req: string
      commit: string
      tree: string
      warnings?: string[]
      nested?: string
      /** HEAD as read with the `run-start` snapshot (the run's expected HEAD); absent outside a repo. */
      head?: GitHead
      /** Paths changed since the effect's `diffFrom` (plan-end: Plan's changes), at most 200. */
      changed?: string[]
    }
  | { t: 'snapshot-failed'; req: string; failure: Failure }
  | { t: 'reconcile-result'; req: string; result: ReconcileResult }
  /** Guardrails fired on a pass's changes or commands. `undone`: the paths put back before its end snapshot. */
  | {
      t: 'guardrail-findings'
      step: StepKey
      findings: GuardrailFinding[]
      undone: string[]
      /** Refused before it ran: nothing to undo, and the pass goes on knowing why. */
      blocked?: boolean
    }
  /**
   * R5: the run branch was created (`branch`, with notes such as a detached start), or not: `blocked` = a block
   * card (branch-prep blockers with their commands), `failure` = git failed unexpectedly.
   */
  | {
      t: 'branch-result'
      req: string
      branch?: RunBranchInfo
      notes?: string[]
      blocked?: ReconcileCardInput
      failure?: Failure
      /** A ref Dim Factory made is still there (HEAD not on it): it stays the run's pending branch. */
      leftover?: RunBranchInfo
    }
  /** R5 write-ahead: the run branch about to be made (before its ref writes); RunState.branchPending. */
  | { t: 'branch-intent'; req: string; branch: RunBranchInfo }
  /**
   * A revert's outcome, or why it did not happen (`busy`: a process held the folder; `conflict`: an undo whose
   * paths changed since the revert, nothing written; `failure`: git failed).
   */
  | {
      t: 'revert-result'
      req: string
      outcome?: RevertOutcomeView
      busy?: string
      conflict?: string
      failure?: Failure
    }
  /**
   * Write-ahead: the revert's undo point is taken and these paths are about to change; no file is written yet.
   * The reducer records the RevertRecord (`pending`) before the controller lets the writes go on.
   */
  | { t: 'revert-started'; req: string; preRevert: string; paths: string[] }
  /**
   * Answer to a `parseFindings` effect: findings/parse.ts over the pass output. A parser crash is `status:'failed'`
   * (salvaged findings may still be listed).
   */
  | { t: 'findings-result'; req: string; status: SourceParseStatus; findings: FindingInput[] }
  /**
   * Optional: what `adapter.start` launched (pid, route, argv for "Copy launch command"). `sessionId` = a
   * pre-assigned session (Claude `--session-id`), recorded like P4 so it is persisted before the first stdin write.
   */
  | {
      t: 'spawned'
      step: AgentStep
      spawnNo: number
      pid?: number
      route?: string
      argv?: string[]
      sessionId?: string
      /** UTF-8 bytes of the prompt sent on stdin (StepState.inBytes). */
      inBytes?: number
      /** `StartOptions.cwd`, the folder the process runs in (kept with its session). */
      cwd?: string
    }
  /**
   * R10: the facts decideSession needs from outside the reducer — `adapter.canResume` for Implement's session, the
   * folder Fix will run in and the Fix vendor's capabilities. The controller sends it right before it answers Fix's
   * pass-boundary preflight, so it is in the launch when the session is decided. Ignored unless Fix's launch is
   * still deciding; absent ⇒ unknown (canResume assumed ok; a rejected resume still falls back fresh).
   */
  | { t: 'session-check'; step: 'fix' | 'implement'; check: SessionCheck }
  /**
   * Session id persistence: an adapter learned the session id from the vendor (Codex thread/start,
   * ACP session/new) and waits (`StartOptions.onSession`) until it is recorded and run.json is written, before it
   * sends the first turn. Recorded like P4; ignored once the process no longer reacts. `cwd`: the folder the pass
   * was started in (StartOptions.cwd), kept with the session when the `spawned` event has not named it yet, so
   * canResume and decideSession's cwd rule know where the thread lives.
   */
  | { t: 'session-assigned'; step: AgentStep; spawnNo: number; sessionId: string; cwd?: string }
  | { t: 'adapter'; step: AgentStep; spawnNo: number; ev: NormalizedEvent }
  | { t: 'signal'; step: AgentStep; spawnNo: number; signal: AdapterSignal }
  /** What the controller knows of a spawn's setup for its context meter and health (sent right after the spawn). */
  | { t: 'context-facts'; step: AgentStep; spawnNo: number; facts: ContextFacts }
  /**
   * `handle.exited`. The controller MUST send exactly one per spawn effect. `failure` = the classifier's verdict
   * when no terminal event was seen (`classify({failed:true, protocol:{noTerminal:true}, …})`); `cumulative` =
   * `handle.cumulativeUsage()`.
   */
  | {
      t: 'exit'
      step: AgentStep
      spawnNo: number
      code: number | null
      signal: string | null
      ranMs: number
      failure?: Failure
      cumulative?: Usage
    }
  /** Live files-changed count (liveCount poller); re-emitted as a `diff-stats` body. */
  | { t: 'diff-stats'; files: number; added: number; deleted: number; live: boolean }
  /** A timer armed by a `timer` effect fired; `due` echoes the effect's `at` (stale timers are ignored). */
  | { t: 'timer'; id: string; due: number }
  | { t: 'power'; state: 'suspend' | 'resume' }
  /** Crash relaunch (P24): the state was loaded from run.json; every process of the old instance is gone. */
  | { t: 'relaunch' }
  /** App quit (P26). */
  | { t: 'quit' }
  | { t: 'user'; cmd: UserCommand }
  /**
   * The healer's answer to a `heal` effect (`healId`). `autoApply`: a suggested config patch inside the
   * autoApplyConfigPatches subset, already checked and applied to a copy of the run's config by the controller; the
   * reducer applies it (P22, spending the pass's automatic retry) only while the snag is open and the budget unspent.
   */
  | {
      t: 'heal-result'
      step: StepKey
      healId: number
      heal: HealView
      autoApply?: {
        patchId: string
        actionId: string
        label: string
        config: RunConfig
        /** The resolved.json entry the patch becomes (RunState.configPatches). */
        entry?: ConfigPatchRecord
      }
    }
  /**
   * The trust check of a verify round: every enabled configured command with its body (re-read now) against
   * trust.json. `failure`: the check itself could not run (the verifyEnv card offers Retry / Skip verify).
   */
  | { t: 'verify-check-result'; req: string; commands: VerifyCheckCommand[]; failure?: Failure }
  /** A [Trust for this project] grant was written (or not: `error`). */
  | { t: 'trust-grant-result'; req: string; ok: boolean; error?: string }
  /**
   * A verify round in progress: `running` = the command now running; `done` = a command's result as soon as it
   * finished; `output` = new output was written to the round's output file. Each is announced by an `output` body.
   */
  | { t: 'verify-progress'; req: string; running?: string; done?: VerifyResultInput; output?: true }
  /**
   * The round's results in configured order (the commands it did not run included) and their findings
   * (`verifyFindings`). `failure`: the round could not run at all (treated like an environment failure).
   */
  | {
      t: 'verify-result'
      req: string
      results: VerifyResultInput[]
      findings: FindingInput[]
      aborted?: boolean
      failure?: Failure
    }
  /**
   * Test-first: the Tests step's files compared at T1 and at Implement's end (testfirst/guard.ts): a `[must]` per file
   * deleted or weakened. `failure`: the comparison could not run.
   */
  | { t: 'tests-check-result'; req: string; findings: FindingInput[]; failure?: Failure }
  /**
   * The Deploy step's plan (deploy/report.ts planDeploy over the run's folder): the class, the target and the config
   * files it lacks. `failure`: the folder could not be read (the step is skipped with a note).
   */
  | { t: 'deploy-plan-result'; req: string; plan?: DeployPlanFacts; failure?: Failure }
  /** Run & Preview's smoke check of this run found these (its smoke.json findings, the latest check's). */
  | { t: 'preview-findings'; findings: FindingInput[] }
  /**
   * The scan's plan: the audits that apply (each against trust.json) and notes (no audit applies, a subfolder not
   * audited, …). `failure`: the check itself could not run (the scan then goes on with the secret scanner only).
   */
  | { t: 'scan-check-result'; req: string; audits: ScanCheckAudit[]; notes: string[]; failure?: Failure }
  /**
   * The scan's results: secrets in the run's added lines, each audit's result, the advisories for dependencies the
   * run added or changed, how many advisories were already there, notes, and the findings (source `scan`, with their
   * security level). `failure`: the scan could not run at all (a note; never a finding).
   */
  | {
      t: 'scan-result'
      req: string
      secrets: ScanSecretView[]
      audits: ScanAuditResult[]
      advisories: ScanAdvisoryView[]
      existing: number
      notes: string[]
      findings: FindingInput[]
      /** The changes touch code that handles keys, sign-in, payments or people's data. */
      sensitive?: boolean
      failure?: Failure
    }
  // ---- grounding checks (core/grounding) ----
  /** The grounding checks' answer: findings (source grounding) and notes; `failure`: they could not run (a note). */
  | { t: 'grounding-result'; req: string; findings: FindingInput[]; notes: string[]; failure?: Failure }
// ---- context reactions (core/context/reactions) ----

export type EngineEvent = EngineEventBody & { at: number }
export type EngineEventType = EngineEventBody['t']

// ---- effects --------------------------------------------------------------------------------------------------

export type NotifyKind = 'ask' | 'gate' | 'card' | 'completed' | 'failed' | 'stopped'

/** Executed by the controller in array order. */
export type Effect =
  /** run.json; `force` on transitions (else debounced 250 ms). */
  | { t: 'persist'; force: boolean }
  /** Append to the bus (seq is the bus's). `ev` bodies may go through the text coalescer. */
  | { t: 'emit'; body: RunEventBody }
  /** runs/index.jsonl upsert of `toRunSummary(state)`. */
  | { t: 'index' }
  /** Enter the scheduler queue for the folder lock (answered by `lock-acquired`). */
  | { t: 'lock' }
  /** Release the lock, or leave the queue. Never emitted while a process is alive. */
  | { t: 'unlock' }
  | { t: 'preflight'; req: string; mode: 'authoritative' }
  | { t: 'preflight'; req: string; mode: 'passBoundary'; step: AgentStep }
  /**
   * An isolated run's prepare stage. `rest`: `command` = the user's edited install command, else installCommand
   * or detection. `install`: the command to install (its `deps` grant is checked again before anything spawns).
   */
  | { t: 'prepare'; req: string; stage: PrepareStage; command?: string; deps?: DepsCommandState }
  /** Stop / quit: cancel the prepare stage `req` (the install's tree is killed); its result still follows. */
  | { t: 'prepareStop'; req: string }
  /** Enter the scheduler's queue for the SOURCE folder's lease (answered by `lease-acquired`). */
  | { t: 'lease' }
  /** Give the SOURCE folder's lease back (or leave its queue). */
  | { t: 'unlease' }
  /** R12: preview the apply (answered by `finalize-preview`). */
  | { t: 'finalizePreview'; req: string }
  /**
   * Apply the run to the folder under the lease: snapshot P (`pre-apply`) first, the journal in run.json, then
   * the writes (answered by `apply-result`). `resume`: [Finish apply] after a crash (the journal's plan).
   */
  | {
      t: 'apply'
      req: string
      no: number
      paths?: string[]
      resolutions?: Record<string, 'mine' | 'theirs'>
      resume?: true
    }
  /** Undo an apply (restore its files to P), under the lease (answered by `undo-apply-result`). */
  | { t: 'undoApply'; req: string; token: string }
  /** Discard's deletion of the worktree, its branch and its shadow (answered by `remove-result`). */
  | { t: 'removeWorktree'; req: string }
  /** Write runs/<id>/verify/baseline.json (verify:0's results by command name). */
  | { t: 'writeBaseline'; baseline: Record<string, 'pass' | 'fail' | 'env'> }
  /** `diffFrom` (plan-end): also report the paths changed since this commit (`changed`). */
  | { t: 'snapshot'; req: string; label: SnapshotLabel; step?: StepKey; diffFrom?: string }
  /** Reconcile at a boundary (git/reconcile.ts over `input`). */
  | { t: 'reconcile'; req: string; boundary: ReconcileBoundary; step?: StepKey; input: ReconcileInput }
  /**
   * R5: create the run branch (git/branch.ts prepareRunBranch), settling `pending` first. `settle`: only settle
   * `pending` (adopt it when HEAD is on it), never make a new one (a relaunch).
   */
  | { t: 'branch'; req: string; pending?: RunBranchInfo; settle?: true }
  /**
   * Revert the folder to the snapshot `to` (git/revert.ts revertTo; a `pre-revert` snapshot first). `paths`: these
   * paths (a rename's other side added from `scope`); else every path `scope.from..scope.to` changed (both ends
   * explicit: never the shadow's latest ref, which may be a `pre-revert`); else every difference. `token` names the
   * record (for `undo`, the one undone).
   */
  | {
      t: 'revert'
      req: string
      to: string
      paths?: string[]
      scope?: { from: string; to: string }
      why: RevertWhy
      token: string
      /** `undo`: the token of the record the undo creates (RevertResult.undoToken). */
      undoToken?: string
      /** `undo`: what the paths must still hold (the revert's target); a path that changed refuses the undo. */
      expect?: string
    }
  /** Start the vendor process; the prompt goes over stdin. Exactly one `exit` event must follow. */
  | {
      t: 'spawn'
      step: AgentStep
      attempt: number
      spawnNo: number
      launch: LaunchPlan
      vendor: string
      model: string | null
      /** The pass's effort level (absent: the vendor's default). */
      effort?: string
      mode: Mode
    }
  /** `adapter.answer(h, requestId, decision, why)`. */
  | {
      t: 'answer'
      step: AgentStep
      spawnNo: number
      requestId: string
      decision: AskDecision
      why?: AskCancelReason
    }
  /** Graceful stop (vendor interrupt). */
  | { t: 'interrupt'; step: AgentStep; spawnNo: number }
  /** Hard kill of the process tree. */
  | { t: 'kill'; step: AgentStep; spawnNo: number }
  /** (Re)arm: replaces a timer with the same id. Fire back `{t:'timer', id, due: at}`. */
  | { t: 'timer'; id: string; at: number }
  | { t: 'clearTimer'; id: string }
  /** Desktop/in-app notification; the controller applies focus and rate rules. */
  | { t: 'notify'; kind: NotifyKind; step?: StepKey; requestId?: string; cardId?: string }
  /** Self-heal: run the healer for this failure and answer `heal-result` with the same `healId`. */
  | { t: 'heal'; step: StepKey; failure: Failure; healId: number; trigger: 'auto' | 'user' }
  /**
   * P22: the reducer accepted the config patch `patchId`: the controller swaps in the patched ResolvedConfig and
   * appends it to resolved.json `patches[]` before the next effect runs (a preflight or spawn reads it).
   */
  | { t: 'apply-patch'; patchId: string }
  /** Write `runs/<id>/<file>.md`; an `output` body with the same version follows in the effect list. */
  | { t: 'writeOutput'; file: RunOutputFile; text: string; version: number }
  /**
   * P15 read-only ⇒ parse findings: run findings/parse.ts over `text` (the pass's `done.result`, also written as
   * review.md / critic.md) and answer `{t:'findings-result', req, status, findings}`.
   */
  | { t: 'parseFindings'; req: string; step: ReviewerPass; attempt: number; text: string }
  /** Write `runs/<id>/findings.json` (`writeJson('findings', doc)`); an `output` body `findings` follows. */
  | { t: 'writeFindings'; doc: FindingsFile; version: number }
  /** Live files-changed polling (mutating passes). */
  | { t: 'liveCount'; on: boolean }
  /** Relaunch: `ProcTable.sweep()` for this run's recorded processes. */
  | { t: 'sweep' }
  /**
   * Re-read the round's configured commands and their bodies and compare them with trust.json; answer
   * `verify-check-result`.
   */
  | { t: 'verifyCheck'; req: string; step: VerifyRound; attempt: number }
  /** Write a command grant (the config command grant path); answer `trust-grant-result`. */
  | { t: 'trustGrant'; req: string; command: GrantCommand }
  /**
   * Run a verify round (src/core/verify runVerifyRound; trust is checked again right before each spawn). Answer
   * `verify-progress` while it runs and exactly one `verify-result`.
   */
  | { t: 'verify'; req: string; step: VerifyRound; attempt: number; commands: VerifyRunCommand[] }
  /** Stop / quit: cancel the round `req` (tree kill); its `verify-result` still follows. */
  | { t: 'verifyStop'; req: string }
  /**
   * Test-first: compare `paths` (the Tests step's files) at commit `from` (T1) and `to` (Implement's end); answer
   * `tests-check-result`.
   */
  | { t: 'testsCheck'; req: string; from: string; to: string; paths: string[] }
  /**
   * The Deploy step's planning over the run's work folder: classify it (the run's brief and task), pick the target
   * (`target`, else the pack's for the class) and list the config files it lacks; answer `deploy-plan-result`.
   */
  | { t: 'deployPlan'; req: string; target: string | null }
  /**
   * The security advisor's scan-check: what the run changed between `from` (its base) and `to` (Implement's end),
   * which audits apply and how they stand against trust.json; answer `scan-check-result`.
   */
  | { t: 'scanCheck'; req: string; attempt: number; from: string; to: string }
  /**
   * The scan: the secret scanner over `from..to`, then each audit (`run: true`; trust is checked again right before it
   * spawns, no shell, its timeout); answer exactly one `scan-result`.
   */
  | { t: 'scan'; req: string; attempt: number; from: string; to: string; audits: ScanRunAudit[] }
  /** Stop / quit: cancel the scan `req` (tree kill of a running audit); its `scan-result` still follows. */
  | { t: 'scanStop'; req: string }
  // ---- grounding checks (core/grounding) ----
  /**
   * The grounding checks over one pass (`from..to`: its own start and end snapshots; `base`: the run's base, for the
   * imports and dependencies it added), with what the reducer knows of it; answer exactly one `grounding-result`.
   */
  | {
      t: 'groundingCheck'
      req: string
      step: 'implement' | 'fix'
      from: string
      to: string
      finalText: string
      plan?: string
      evidence?: GroundingTrack
      verify?: VerifyFact[]
      /** The online registry lookup of new dependencies (contextHealth.registryCheck). */
      registryCheck: boolean
      /** The optional AI judge (contextHealth.aiJudge), on the Review pass's vendor. */
      judge?: { vendor: string }
      /** A research memo's run: the web sources Research found, which the memo's links are checked against. */
      sources?: string[]
    }
  // ---- context reactions (core/context/reactions) ----
  /** The user command was rejected; the controller returns this as the IPC/CLI `Result` error. */
  | { t: 'result'; code: ResultCode; message: string }

export type EffectType = Effect['t']
export type EffectOf<T extends EffectType> = Extract<Effect, { t: T }>

export interface Reduction {
  state: RunState
  effects: Effect[]
  /** A transition happened: the controller awaits `bus.sync` before running effects (write-ahead rule). */
  transition: boolean
}

// ---- injected dependencies ----------------------------------------------------------------------------------

export interface SnagInfo {
  hasSession: boolean
  /** `failureHints` from the adapter's meta signal (e.g. `claude-env-key`). */
  hints: string[]
  /** When the failure happened (a wait_until's `retryAfterMs` counts from it). */
  at?: number
}

/** What `ReducerContext.cost` prices: one pass's usage at its `done`. */
export interface CostInput {
  step: AgentStep
  vendor: string
  /** As configured (`null` = the CLI's default model). */
  model: string | null
  usage: Usage
  /** The adapter flagged the usage as approximate (meta usageApprox): the basis is then `none`. */
  usageApprox: boolean
  /** The event's time (staleness of catalog prices). */
  at: number
}

export interface ReducerContext {
  /** The failure table (heal/categories.ts `retryPolicy`); the reducer always passes `ctx.now = event.at`. */
  retryPolicy: (category: FailureCategory, failure: Failure, ctx: RetryContext) => RetryDecision
  /** Snag buttons (recovery/snag-actions.ts through the controller; defaultSnagActions in tests). */
  recoveryActions: (step: StepKey, failure: Failure, info: SnagInfo) => RecoveryAction[]
  /** Steps implemented by this build; others are skipped with reason "not in this build" when reached. */
  buildSteps: readonly StepKey[]
  /**
   * Pass cost (catalog/cost.ts: vendor figure → catalog price → none; "API-equiv." under subscription
   * auth). Must be pure for a given input (catalog data loaded beforehand). Absent: the vendor-reported figure, or
   * none when the usage is approximate or unpriced.
   */
  cost?: (i: CostInput) => StepCost
  /**
   * Run the grounding checks after Implement and Fix (the controller answers them). Absent or false: they are
   * skipped, as a reducer driven without a controller has nobody to answer them.
   */
  grounding?: boolean
}
