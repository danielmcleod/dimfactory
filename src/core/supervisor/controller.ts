// Run controller: one serial event loop per run around the pure reducer.
//
//   event → reduce → writeOutput files → bus.emit bodies (text through the coalescer) → await bus.sync when the
//   reduction is a transition (write-ahead) → the remaining effects in order
//
// Effects that need I/O (preflight, snapshots, spawns, timers, the findings parse) run detached and answer with new
// events carrying the effect's `req` / `spawnNo` / `due`. run.json is written debounced (250 ms) and forced on
// transitions; the bus owns `seq`. Exactly one `exit` event follows every `spawn` effect — also for a Review /
// Critic / fresh Fix spawn that is stopped while its `{{diff}}` (a git prompt patch) is still being prepared.
// review.md / critic.md and findings.json are written before the `output` bodies that announce them; S1 and
// S2 persist the diff segments (S0..S1, F0..S2, S0..S2); a pass's cost comes from `deps.cost` (catalog/cost.ts).
// Before answering Fix's pass-boundary preflight it sends a `session-check` (adapter.canResume for Implement's
// session, Fix's folder, the vendor's capabilities from resolved.json) for decideSession; `spawned` carries the cwd.
// `reconcile` runs git/reconcile.ts (P15's end-of-pass check waits for the end snapshot and is answered before
// the snapshot's own result, so a card it opens holds the run); `branch` makes the run branch (git/branch.ts) with
// `<home>/empty-hooks`; `revert` runs git/revert.ts, and `revert()` hands diff.revert its RevertResult. The run-start
// snapshot reports HEAD (the run's expected HEAD); a plan-end snapshot reports the paths Plan changed.
// Snags carry their category's recovery list (recovery/snag-actions.ts; rows P17/P22);
// `applyConfigPatch` checks a recovery patch against the allowlist and the run's resolved config, and the reducer's
// `apply-patch` swaps the patched config in and appends it to resolved.json `patches[]` before the next effect (the
// retry's preflight and spawn read it); `heal` runs the healer (recovery/heal-api.ts HealApi) on the failed spawn's
// filtered raw log and answers `heal-result`, with a suggested patch inside the autoApplyConfigPatches subset already
// checked and applied to a copy (the reducer applies it only while the pass's automatic retry is unspent).
// Verify: `verifyCheck` reads the round's configured commands and their bodies against trust.json, `trustGrant`
// writes a trust card's command grant (the config grant path), `verify` runs the round through src/core/verify
// (children in procs.json, progress as `verify-progress`, Stop as `verifyStop` → abort), and its findings come from
// verifyFindings; findings.json keeps Fix's report when verify:2 writes it again.
// Isolated runs (worktree; verify:0 is their baseline): an isolated run works in its worktree once prepare made it:
// spawns, snapshots (the worktree's own shadow), reconciles, reverts and verify rounds use the worktree's copy of the
// run's folder, while trust is the SOURCE folder's. `prepare` runs ISO_API's stages (worktree with its write-ahead in
// the finalize journal, copy-ins, the deps decision and install, readiness) with the install's output streamed;
// `lease` takes the SOURCE folder's lock for an apply; `apply` / `undoApply` / `removeWorktree` / `finalizePreview`
// run git/finalize.ts against the worktree's combined segment; the run's own lock is its worktree path.
import type { GuardrailFinding } from '../../shared/guardrails.ts'
import { checkCommands, rulesInForce } from '../../shared/guardrails.ts'
import { RECONCILE_CHOICE } from './cards.ts'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ResolvedConfig, ResolvedTemplate } from '../../shared/config-schema.ts'
import type {
  Failure,
  GrantCommand,
  HealView,
  JsonPatchOp,
  RecoveryAction,
  RetryStrategy,
} from '../../shared/failure.ts'
import type { FindingsFile, SourceParseStatus } from '../../shared/findings.ts'
import type { FileChange, Result, RevertResult, TrustGrants, WorktreeApplyResult } from '../../shared/ipc.ts'
import type { PreflightMode, PreflightReport } from '../../shared/preflight.ts'
import type {
  AgentStep,
  FreshReason,
  Mode,
  PassName,
  RunEventBody,
  RunSummary,
  StepKey,
} from '../../shared/run.ts'
import { AGENT_STEPS, configPassOf, isAgentStep } from '../../shared/run.ts'
import type { Capabilities } from '../../shared/vendors.ts'
import { needsFolderTrust } from '../../shared/vendors.ts'
import type {
  Adapter,
  ExitInfo,
  PassExtensions,
  RunHandle,
  SessionRecorded,
  StartOptions,
  StopReason,
} from '../adapters/types.ts'
import { defaultExtensionLevel } from '../../shared/extensions.ts'
import type { ExtensionLevel } from '../../shared/extensions.ts'
import { contextFacts } from '../context/facts.ts'
import { contextHealthOf } from '../context/policy.ts'
import { stateNote } from '../context/summary.ts'
import { buildContextHealth } from '../context/health.ts'
import type { ContextFacts } from '../context/state.ts'
import { readRunEstimate } from '../estimates/estimate.ts'
import { writeFileAtomic } from '../store/atomic.ts'

/** runs/<id>/context-health.json: the run's Context health report, written once the run is over. */
export const CONTEXT_HEALTH_FILE = 'context-health.json'
import type { EventBus } from '../bus/bus.ts'
import { COALESCE_MAX_BYTES } from '../bus/coalesce.ts'
import { chaosArmed, chaosPoint } from '../chaos.ts'
import { DimFactoryError, DISK_FULL_ERRNO, errnoCode, errorMessage, fail, ok } from '../errors.ts'
import { fixReportById, parseFindings, parseFixReport } from '../findings/parse.ts'
import { reviewArtifactText } from '../findings/render.ts'
import { prepareRunBranch, readHead, settlePendingBranch } from '../git/branch.ts'
import { resolveScope } from '../git/repo.ts'
import { fileJournal, journalFile } from '../git/finalize.ts'
import type { ApplyStep, FinalizeTarget } from '../git/finalize.ts'
import { isWorktreeError } from '../git/worktree.ts'
import type { DepsPlan } from '../prepare/index.ts'
import { programName, readCommandBody } from '../verify/discover.ts'
import { planScan, runSecurityScan } from '../security/scan.ts'
import type { AuditRun, ScanIo } from '../security/scan.ts'
import { DEFAULT_CONTEXT_WINDOW, promptPatchCap } from '../git/patch.ts'
import { revertTo } from '../git/revert.ts'
import { checkPassChanges } from '../guardrails/check.ts'
import { linksLeftOutNote } from '../git/folder-links.ts'
import { nestedReposKey, shadowFor } from '../git/shadow.ts'
import type { Shadow, SnapshotRecord } from '../git/shadow.ts'
import { classify } from '../heal/classify.ts'
import { osFamily } from '../heal/commands.ts'
import { AUTO_SWITCH_LABEL, autoSwitchConfig } from '../auto-switch.ts'
import { isAutoApplicable, patchResolved } from '../recovery/config-patch.ts'
import type { GuardOptions, VendorArgsCheck } from '../recovery/config-patch.ts'
import { failedHeal, healTail, healViewOf, parseRawLog } from '../recovery/heal-api.ts'
import type { HealApi } from '../recovery/heal-api.ts'
import { snagActions } from '../recovery/snag-actions.ts'
import type { SwitchTarget } from '../recovery/switch-vendor.ts'
import type { HomePaths, RunTextOutput } from '../home.ts'
import { relativeInside } from '../real-path.ts'
import type { Logger } from '../log.ts'
import { killTree } from '../proc/kill.ts'
import { procRecordFor } from '../proc/proc-table.ts'
import type { ProcTable } from '../proc/proc-table.ts'
import type { ChildHandle } from '../proc/spawn.ts'
import { diffBudgetBytes } from '../prompts/template.ts'
import { weakenedTests } from '../testfirst/guard.ts'
import { existsSync } from 'node:fs'
import { runGrounding } from '../grounding/run.ts'
import type { GroundingIo } from '../grounding/run.ts'
import type { RegistryFetcher } from '../grounding/packages.ts'
import { httpRegistryFetcher } from '../grounding/packages.ts'
import { importedNames } from '../grounding/imports.ts'
import { addedLinesByFile } from '../grounding/patch.ts'
import type { RunStore } from '../store/run-store.ts'
import { isVendorFolderGranted, trustGrantsFor, withProjectPermission } from '../config/trust.ts'
import type { AllowSource } from '../adapters/allow-cache.ts'
import type { PermitRun } from '../easy/permission.ts'
import { configCommands, cwdRelOf, runVerifyRound, trustOf, verifyFindings } from '../verify/index.ts'
import { playtestCommand } from '../verify/discover.ts'
import type { PageChecker } from '../verify/pageload.ts'
import type { Playtester } from '../verify/playtest.ts'
import { isPlaytestArgv } from '../../shared/playtest.ts'
import { displayArgv } from '../verify/argv.ts'
import type {
  VerifyDeps,
  VerifyOutputEvent,
  VerifyRoundCommand,
  VerifyRoundOptions,
  VerifyRoundResult,
} from '../verify/index.ts'
import { boundaryText, stepLabel } from './cards.ts'
import { anyLiveProc, isRunOver, selectedFindings } from './derive.ts'
import { segmentEnds } from './diff-segments.ts'
import { ISO_API, worktreeBranchName } from './isolation.ts'
import type { IsolationApi } from './isolation.ts'
import type { Clock, PromptInputs, TimerHandle } from './effects.ts'
import { branchBlockedCard, gitFailure, revertPaths, runReconcile } from './git-effects.ts'
import {
  RawLog,
  buildPrompt,
  explainChangeRange,
  defaultRecoveryActions,
  missingDiffText,
  presetSessionId,
  promptDiffRange,
  snapshotFailure,
  startOptionsFor,
  writePromptFile,
} from './effects.ts'
import { runInstructionsHint } from '../preview/run-hint.ts'
import { gatherExplainInputs } from '../explain/context.ts'
import { planDeploy } from '../deploy/report.ts'
import { readBuiltinPacks } from '../packs/load.ts'
import type { DeployPlanFacts } from '../../shared/deploy.ts'
import {
  CHANGED_PATHS_MAX,
  DEFAULT_CONTEXT,
  isMutatingStep,
  passCfg,
  reduce,
  runBaseSnap,
  runConfigFromResolved,
  uniqueVerifyNames,
} from './machine.ts'
import type { FolderScheduler } from './scheduler.ts'
import { scratchDirOf } from '../extensions/scratch.ts'
import { fixLaunchSessionInputs, implementSessionInputs, sessionCandidate } from './sessions.ts'
import type { SessionCapabilities, SessionCheck } from './sessions.ts'
import type {
  ConfigPatchRecord,
  Effect,
  EffectOf,
  EngineEvent,
  EngineEventBody,
  FindingInput,
  GitHead,
  ReconcileCardInput,
  ReconcileResult,
  ReducerContext,
  RunState,
  ScanCheckAudit,
  ScanRunAudit,
  SnagInfo,
  UserCommand,
  VerifyCheckCommand,
} from './types.ts'

/** The most of a run's patch the secret scanner reads (characters). */
const SCAN_PATCH_MAX_CHARS = 32 * 1024 * 1024
/** A dependency audit's timeout (it may fetch the advisory database). */
const AUDIT_TIMEOUT_MS = 300_000

/** A promise with its resolve (end snapshot ↔ end-of-pass check ordering). */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** The smallest prompt diff budget a trim leaves. */
export const PROMPT_DIFF_MIN_BYTES = 2048

/**
 * The `{{diff}}` byte budget (the prompt patch): min(150 KB, 0.25 × contextWindow × 3.5), shrunk so
 * the whole prompt stays under 60% of the window, then halved `trim` times (context_exceeded "retry
 * fresh with a trimmed diff": LaunchPlan.diffTrim, at most 8), never below 2 KB.
 */
export function promptDiffCap(window: number, otherBytes: number, trim = 0): number {
  const halvings = Math.min(8, Math.max(0, Math.floor(trim)))
  const full = Math.min(promptPatchCap(window), diffBudgetBytes(window, otherBytes))
  return Math.max(PROMPT_DIFF_MIN_BYTES, Math.floor(full / 2 ** halvings))
}

/** The end snapshot of a mutating pass (P15: S1 / S2), keyed by its pass. */
function endSnapshotStep(e: EffectOf<'snapshot'>): AgentStep | undefined {
  if (
    (e.label !== 'S1' && e.label !== 'S2' && e.label !== 'deploy-end') ||
    e.step === undefined ||
    !isAgentStep(e.step)
  )
    return undefined
  return isMutatingStep(e.step) ? e.step : undefined
}

/** Guardrails that say ask, as the end-of-pass card: the choice stays with the user, in Auto too (no default choice). */
function withGuardrailAsks(result: ReconcileResult, asks: readonly GuardrailFinding[]): ReconcileResult {
  if (asks.length === 0) return result
  const reasons = asks.map((f) => ({
    row: 'guardrail',
    severity: 'choice' as const,
    title: `Guardrail: ${f.rule}`,
    detail: `${f.subject}. ${f.detail}`,
    actions: [],
  }))
  const prior = result.verdict === 'choice' || result.verdict === 'block' ? result.card : undefined
  const card: ReconcileCardInput =
    prior !== undefined
      ? { ...prior, reasons: [...reasons, ...prior.reasons] }
      : {
          verdict: 'choice',
          reasons,
          external: [],
          overlapping: [],
          choices: [
            { id: RECONCILE_CHOICE.includeEdits, label: 'Keep going', primary: true },
            { id: RECONCILE_CHOICE.stop, label: 'Stop run' },
          ],
          notes: result.verdict === 'info' ? result.notes : [],
        }
  return { verdict: card.verdict, card, ...(result.head !== undefined ? { head: result.head } : {}) }
}

/** The longest an end snapshot's result waits for its end-of-pass check (real ms). */
const END_CHECK_WAIT_MS = 120_000

/** Where a run works: the folder the user chose and the scope its snapshots and lock cover. */
export interface RunScope {
  folder: string
  scopeRoot: string
  lockKey: string
  folderKey: string
  isRepo: boolean
  /**
   * The key the run's own lock takes when it is not `lockKey`: an isolated run locks its worktree path,
   * and leases `lockKey` (its folder's) only to apply.
   */
  runLockKey?: string
}

/**
 * The folder a run's passes and checks work in: the worktree's copy of `folder` once it exists, else `folder`
 * itself. App-core's mode copy reads the same folder a pass spawns in (Claude's shell allow-rules).
 */
export function workFolderOf(folder: string, isolation: RunState['isolation']): string {
  const wt = isolation?.worktree
  if (wt === undefined) return folder
  const rel = wt.rel ?? ''
  return rel === '' ? wt.path : join(wt.path, ...rel.split('/'))
}

/** The key a run's own lock takes (an isolated run's worktree path). */
export function runLockKeyOf(scope: RunScope): string {
  return scope.runLockKey ?? scope.lockKey
}

/** run.json (schemaVersion is added by the store). `lastSeq` lets the bus continue numbering after a restart. */
export interface RunDoc {
  runId: string
  state: RunState
  lastSeq: number
  scope: RunScope
  createdBy: 'app' | 'cli'
  /**
   * An isolated run's worktree as a scope (its copy of the run's folder, its root, its own folder key: the shadow
   * its snapshots are in). Absent for in-place runs and until the worktree exists.
   */
  work?: RunScope
}

/** The scope a run's snapshots and diffs are in: its worktree's, else its folder's. */
export function workScopeOf(doc: Pick<RunDoc, 'scope' | 'work'>): RunScope {
  return doc.work ?? doc.scope
}

export type PreflightRunner = (
  mode: Extract<PreflightMode, 'authoritative' | 'passBoundary'>,
  o: { runId: string; folder: string; config: ResolvedConfig; pass?: PassName },
) => Promise<PreflightReport>

export interface ControllerDeps {
  /** Test-first: the Tests step's template as resolved when the run was made (default: the builtin tests.md). */
  testsTemplate?: Pick<ResolvedTemplate, 'path'>
  /** The optional steps' templates as resolved when the run was made (default: each step's built-in). */
  stepTemplates?: PromptInputs['stepTemplates']
  /** The Deploy step's planning with the core's packs and the run's brief (absent: the built-in packs, no brief). */
  deploy?: ControllerDeploy
  paths: HomePaths
  bus: EventBus
  store: RunStore<RunDoc>
  config: ResolvedConfig
  scope: RunScope
  createdBy: 'app' | 'cli'
  adapters: { get(id: string): Adapter | undefined }
  preflight: PreflightRunner
  scheduler: FolderScheduler
  /** runs/index.jsonl upserts (absent in read-only cores). */
  putSummary?: (summary: RunSummary, debounced: boolean) => void
  /** RunSummary with fields owned outside the reducer (blockedBy). */
  summarize: (state: RunState) => RunSummary
  clock: Clock
  log: Logger
  shadow: () => Promise<Shadow>
  procTable: ProcTable
  notify?: (runId: string, e: EffectOf<'notify'>, state: RunState) => void
  /** Real ms between procs.json heartbeats while children run (default 5000). */
  touchEveryMs?: number
  /** Live files-changed poll (default 15 s, backing off to 60 s). */
  livePollMs?: { fast: number; slow: number }
  platform?: NodeJS.Platform
  /** Pass cost (catalog/cost.ts over the loaded catalog and the vendor's auth); see ReducerContext. */
  cost?: ReducerContext['cost']
  /** The model's context window in tokens when the catalog or the CLI knows it (prompt diff cap; else 200000). */
  contextWindow?: (vendor: string, model: string | null) => number | null
  /**
   * The names of the user's MCP servers and skills a pass at `level` has (the existing discovery, names only), for the
   * Context health contributors of a vendor that reports no breakdown. Absent: none known. Never logged.
   */
  contextNames?: (
    vendor: string,
    cwd: string,
    level: ExtensionLevel,
    extensions: PassExtensions | undefined,
  ) => { mcp: readonly string[]; skills: readonly string[] } | undefined
  /** Ask Claude for its context breakdown at each pass's start and end (default on; StartOptions.contextBreakdown). */
  contextBreakdown?: boolean
  /** The grounding checks after Implement and Fix (default on). */
  grounding?: boolean
  /**
   * The registry lookup of new dependencies when the run's contextHealth.registryCheck is on (default: an HTTPS GET to
   * npm, PyPI or crates.io). Tests pass a fake.
   */
  registryFetcher?: RegistryFetcher
  /**
   * The optional AI judge: one read-only answer from the vendor's cheapest catalog model (app-core wires the read-only
   * route). Absent: the judge does not run even when the setting is on.
   */
  judge?: (vendor: string, prompt: string) => Promise<string>
  /**
   * The vendor's capabilities from its launch probe (`local-<preset>` → Codex's). `preassignSessionId: false`
   * (Codex, ACP): no session id is made up for a fresh mutating pass; the adapter reports the vendor's through
   * `StartOptions.onSession` before its first turn. Absent or unknown: pre-assigned.
   */
  capabilities?: (vendor: string) => Pick<Capabilities, 'preassignSessionId'> | undefined
  /** What snags, config patches and self-heal need from the core (absent: defaults, no healer). */
  recovery?: ControllerRecovery
  /** What verify rounds need from the core (absent: trust.json under `paths.home`, the real round runner). */
  verify?: ControllerVerify
  /** Easy mode's project permission (core/easy/permission.ts); absent: it never applies. */
  permission?: ControllerPermission
  /** ISO_API: an isolated run's prepare and finalize (default: the real modules). */
  isolation?: IsolationApi
  /** The shadow of a worktree folder (default: resolveScope + shadowFor under `paths.home`). */
  workShadow?: (folder: string) => Promise<Shadow>
  /** An isolated run's worktree scope as run.json recorded it (RunDoc.work). */
  work?: RunScope
  /**
   * DIM_FACTORY_E2E=1 only (an E2E-only hook for the "kill during apply" test): while this file exists,
   * an apply waits after each file it wrote or deleted, so a test can kill the app with part of the folder written.
   */
  e2eApplyHold?: string
}

/** E2E: how often a held apply looks at its hold file again. */
const E2E_HOLD_POLL_MS = 100

/** How often an install's new output is announced (`output prepare`), at most. */
export const PREPARE_OUTPUT_EVERY_MS = 500

/** What the Deploy step's planning needs from the core. */
export interface ControllerDeploy {
  plan(o: { folder: string; target: string | null; state: RunState }): Promise<DeployPlanFacts>
}

/** Easy mode's project permission, as a run uses it (core/easy/permission.ts ProjectPermissions). */
export interface ControllerPermission {
  /** The live allow-rule source for a pass (StartOptions.permit), or undefined when the run is not covered. */
  permitFor(r: PermitRun): AllowSource | undefined
  /** Whether the run's own commands working in `cwd` are covered now. */
  covers(r: PermitRun): boolean
  /** Log one use (a command Dim Factory ran under it). */
  record(use: { folder: string; runId: string; what: 'command'; label: string }): void
}

/** The trust grants a round is checked against, the command grant path and the round runner. */
export interface ControllerVerify {
  /** The folder's trust.json grants (ConfigService.trustGrants). */
  trustGrants?: (folder: string) => Promise<TrustGrants>
  /** Write a command grant: the config command grant path (ConfigService.trustSet with the body it covers). */
  grant?: (folder: string, command: GrantCommand) => Promise<void>
  /** src/core/verify runVerifyRound (tests inject a fake with the same signature). */
  runRound?: (deps: VerifyDeps, opts: VerifyRoundOptions) => Promise<VerifyRoundResult>
  /** The resolved PATH the children get (default: path-env's). */
  pathEnv?: string
  /** The env the children's is built from (sanitized; default: process.env). */
  env?: Readonly<Record<string, string | undefined>>
  /** Dim Factory's own play-test of a game (the app's; absent in the command-line tool: "not checked here"). */
  playtest?: Playtester
  /** Dim Factory's own page-load check (the app's; absent in the command-line tool: "not checked here"). */
  pageload?: PageChecker
}

/** How often a running round's new output is announced (`output verify:<n>`), at most. */
export const VERIFY_OUTPUT_EVERY_MS = 500

/** The core facts behind a snag's recovery list, a config patch's checks and a heal request. */
export interface ControllerRecovery {
  /** The healer (HEAL_API); absent: a heal answers `failed` ("not available"). */
  heal?: HealApi
  vendorName?(vendor: string): string
  /** The adapter's testedUpTo (the pinned-install command). */
  testedUpTo?(vendor: string): string | undefined
  /** The vendor's CLI version from its launch probe. */
  vendorVersion?(vendor: string): string | null
  /**
   * Live balanced run: the vendor's default model for this account (its probe's model list), only for a vendor
   * whose pass with no model may run another (ACCOUNT_DEFAULT_VENDORS): model_unavailable's one-click fix when the
   * model the vendor's own settings chose was refused. Undefined otherwise.
   */
  accountDefaultModel?(vendor: string): string | undefined
  /** switch_vendor's target for a failed pass (null: no other vendor). */
  switchTarget?(vendor: string | undefined, pass: PassName, mode: Mode): SwitchTarget | null
  /** Per-vendor managed flags (the config patch checks). */
  managedFlags?(): Readonly<Record<string, readonly string[]>>
  /** The user's `selfHeal.autoApplyConfigPatches` now (default: the run's resolved config). */
  autoApplyConfigPatches?(): boolean
  /** The vendor adapter's own extraArgs / flagMap rules (a patch may not break them). */
  vendorArgs?: VendorArgsCheck
}

/** A recovery patch the reducer has not accepted yet (`apply-patch` swaps it in). */
interface PendingPatch {
  config: ResolvedConfig
  entry: ResolvedPatchEntry
}

/** One resolved.json `patches[]` entry (Re-run applies them in order). */
export type ResolvedPatchEntry = ConfigPatchRecord

/** What `applyConfigPatch` takes (recovery.execute config_patch / switch_vendor). */
export interface ConfigPatchRequest {
  ops: readonly unknown[]
  label: string
  step?: AgentStep
  strategy?: RetryStrategy
  actionId?: string
}

interface ActiveProc {
  step: AgentStep
  spawnNo: number
  handle: RunHandle
  adapter: Adapter
  start: StartOptions
  raw: RawLog
  /** UTF-8 size of the prompt (the `spawned` event's `inBytes`). */
  promptBytes: number
  pid?: number
  spawnAt?: number
  procId?: string
  exited: boolean
}

/** A spawn effect whose prompt is still being prepared (the S0..S1 diff); stopped before it starts. */
interface PendingSpawn {
  spawnNo: number
  cancelled: boolean
}

interface QueueItem {
  ev: EngineEvent
  resolve: (effects: Effect[]) => void
}

/**
 * Take `head` plus the text deltas of the same spawn queued right behind it (up to `maxChars` of text) as one
 * reducer event. A reduction costs the same for one delta or many (it clones the run state), and the bus coalesces
 * text anyway; a fast stream — thousands of deltas per stdout chunk — would otherwise cost thousands of reductions
 * and seconds of the host's event loop (performance.spec.ts). The merged event carries the last delta's time.
 */
export function takeQueuedText<T extends { ev: EngineEvent }>(
  head: T,
  queue: T[],
  maxChars: number = COALESCE_MAX_BYTES,
): { taken: T[]; ev: EngineEvent } {
  const first = head.ev
  if (first.t !== 'adapter' || first.ev.type !== 'text') return { taken: [head], ev: first }
  const taken = [head]
  const parts = [first.ev.delta]
  let size = first.ev.delta.length
  let at = first.at
  while (size < maxChars) {
    const next = queue[0]
    if (next === undefined) break
    const e = next.ev
    if (e.t !== 'adapter' || e.ev.type !== 'text' || e.step !== first.step || e.spawnNo !== first.spawnNo)
      break
    queue.shift()
    taken.push(next)
    parts.push(e.ev.delta)
    size += e.ev.delta.length
    at = e.at
  }
  if (taken.length === 1) return { taken, ev: first }
  return { taken, ev: { ...first, at, ev: { type: 'text', delta: parts.join('') } } }
}

type Listener = (state: RunState, effects: readonly Effect[]) => void

const TEXT_OUTPUTS: readonly string[] = [
  'plan',
  'plan.original',
  'review',
  'critic',
  'security',
  'recheck',
  'clarify',
  'research',
  'research.json',
  'deploy',
  'acceptance',
  'explain',
]

export class RunController {
  readonly runId: string
  readonly deps: ControllerDeps
  readonly ctx: ReducerContext
  #state: RunState
  #queue: QueueItem[] = []
  #draining = false
  /** `drained()` callers, released when the queue next runs empty. */
  #drainWaiters: (() => void)[] = []
  #closed = false
  readonly #procs = new Map<AgentStep, ActiveProc>()
  readonly #pendingSpawns = new Map<AgentStep, PendingSpawn>()
  /** Prompt patches by `<from>..<to>|<cap>` (Review and Critic share S0..S1). */
  readonly #promptDiffs = new Map<string, Promise<string>>()
  /** The last findings.json written (the Fix report is added to it after Fix). */
  #findingsDoc: FindingsFile | undefined
  readonly #timers = new Map<string, TimerHandle>()
  readonly #inflight = new Set<Promise<unknown>>()
  readonly #listeners = new Set<Listener>()
  #snapshots: SnapshotRecord[]
  #touchTimer: ReturnType<typeof setInterval> | undefined
  #liveTimer: ReturnType<typeof setTimeout> | undefined
  #liveOn = false
  #liveLast = -1
  #liveSame = 0
  #livePolling = false
  /** resolved.json `vendors` (read once it reads, for the session capabilities of R10). */
  #resolvedVendors: Promise<unknown> | undefined
  /** P15: a mutating pass's end snapshot in flight (its end-of-pass check reads it). */
  readonly #endSnaps = new Map<AgentStep, Deferred<SnapshotRecord | null>>()
  /** P15: the end-of-pass check in flight; the end snapshot's result waits for it (the check answers first). */
  readonly #endChecks = new Map<AgentStep, Deferred<void>>()
  /** Guardrails that say ask, waiting for their pass's end-of-pass check to put them on its card. */
  readonly #guardrailAsks = new Map<AgentStep, GuardrailFinding[]>()
  /** Forbidden commands already reported, so a repeat of the same tool event does not fire twice. */
  readonly #guardrailCommands = new Set<string>()
  /** What a `revert` effect returns to `diff.revert` / `diff.undoRevert`, by request id. */
  readonly #revertResults = new Map<string, Promise<Result<RevertResult>>>()
  /** Recovery patches waiting for the reducer's `apply-patch`. */
  readonly #pendingPatches = new Map<string, PendingPatch>()
  #patchSeq = 0
  /** resolved.json `patches[]` appends, one at a time. */
  #patchWrites: Promise<void> = Promise.resolve()
  /**
   * One recovery patch at a time, from its check against the config to the reducer's answer, so a second patch
   * (another failed pass's fix, an auto-applied heal) is checked against the config the first one left.
   */
  #patchLock: Promise<void> = Promise.resolve()
  /** Verify rounds running, by request id (Stop and quit abort them; their result still answers). */
  readonly #verifyRounds = new Map<string, AbortController>()
  /** Prepare stages running, by request id (Stop and quit abort an install; its result still answers). */
  readonly #prepareStops = new Map<string, AbortController>()
  /** The worktree's scope (RunDoc.work) and shadow, once known. */
  #work: RunScope | undefined
  #workShadowP: Promise<Shadow> | undefined
  #workShadowFolder: string | undefined

  constructor(state: RunState, deps: ControllerDeps, snapshots: SnapshotRecord[] = []) {
    this.runId = state.runId
    this.#state = state
    this.deps = deps
    this.#snapshots = [...snapshots]
    this.#work = deps.work
    this.ctx = {
      ...DEFAULT_CONTEXT,
      recoveryActions: (step, failure, info) => this.#snagActions(step, failure, info),
      ...(deps.cost !== undefined ? { cost: deps.cost } : {}),
      grounding: deps.grounding !== false,
    }
  }

  get state(): RunState {
    return this.#state
  }

  get closed(): boolean {
    return this.#closed
  }

  /** run.json as it would be written now. */
  doc(): RunDoc {
    return {
      runId: this.runId,
      state: this.#state,
      lastSeq: this.deps.bus.lastSeq(this.runId) ?? 0,
      scope: this.deps.scope,
      createdBy: this.deps.createdBy,
      ...(this.#work !== undefined ? { work: this.#work } : {}),
    }
  }

  /** Called after every processed event. Listeners must not throw (errors are logged). */
  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  /** Resolves with the first state (now or later) matching `pred`; rejects after `timeoutMs` real ms. */
  waitFor(pred: (s: RunState) => boolean, timeoutMs?: number): Promise<RunState> {
    if (pred(this.#state)) return Promise.resolve(this.#state)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = this.subscribe((s) => {
        if (!pred(s)) return
        off()
        if (timer !== undefined) clearTimeout(timer)
        resolve(s)
      })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          off()
          reject(new Error(`run ${this.runId}: condition not reached within ${timeoutMs} ms`))
        }, timeoutMs)
      }
    })
  }

  /** Queue an engine event; resolves with that event's effects once it has been processed. */
  enqueue(body: EngineEventBody): Promise<Effect[]> {
    if (this.#closed) return Promise.resolve([])
    if (chaosArmed()) chaosPoint(body.t === 'adapter' ? `event:adapter:${body.ev.type}` : `event:${body.t}`)
    return new Promise((resolve) => {
      const ev = { ...body, at: this.deps.clock.now() }
      this.#queue.push({ ev, resolve })
      if (!this.#draining) {
        this.#draining = true
        // A text delta waits one event-loop turn, so the rest of its stdout chunk queues behind it and reduces
        // as one event (takeQueuedText); anything else drains at once.
        if (body.t === 'adapter' && body.ev.type === 'text') setImmediate(() => void this.#drain())
        else queueMicrotask(() => void this.#drain())
      }
    })
  }

  /** A user command; the reducer's `result` effect becomes the error. */
  async command(cmd: UserCommand): Promise<Result<void>> {
    let c = cmd
    if (c.kind === 'resume' && c.canResume === undefined) c = { ...c, canResume: await this.#canResume() }
    const effects = await this.enqueue({ t: 'user', cmd: c })
    const r = effects.find((e): e is EffectOf<'result'> => e.t === 'result')
    if (this.#closed && effects.length === 0) return fail('CONFLICT', 'The run is no longer active.')
    return r === undefined ? ok(undefined) : fail(r.code, r.message)
  }

  /**
   * `diff.revert` / `diff.undoRevert`: the user command through the reducer (it refuses while a process holds the
   * folder), then the revert itself; resolves with what it did (RevertResult, its undo token) or why not.
   */
  async revert(cmd: Extract<UserCommand, { kind: 'revert' | 'undo-revert' }>): Promise<Result<RevertResult>> {
    const effects = await this.enqueue({ t: 'user', cmd })
    if (this.#closed && effects.length === 0) return fail('CONFLICT', 'The run is no longer active.')
    const r = effects.find((e): e is EffectOf<'result'> => e.t === 'result')
    if (r !== undefined) return fail(r.code, r.message)
    const fx = effects.find((e): e is EffectOf<'revert'> => e.t === 'revert')
    const p = fx !== undefined ? this.#revertResults.get(fx.req) : undefined
    if (fx === undefined || p === undefined) return fail('INTERNAL', 'The revert did not start.')
    this.#revertResults.delete(fx.req)
    return p
  }

  // ---- snags, P22, self-heal -------------------------------------------------------------------------------------

  /** The category's recovery list for a failed step (the reducer's `recoveryActions`). */
  #snagActions(step: StepKey, failure: Failure, info: SnagInfo): RecoveryAction[] {
    const r = this.deps.recovery
    const st = this.#state.steps[step]
    const vendor = st.vendor ?? (isAgentStep(step) ? passCfg(this.#state, step).vendor : undefined)
    const pass = isAgentStep(step) ? step : undefined
    const mode = st.mode ?? (pass !== undefined ? passCfg(this.#state, pass).mode : undefined)
    try {
      const name = vendor !== undefined ? r?.vendorName?.(vendor) : undefined
      const tested = vendor !== undefined ? r?.testedUpTo?.(vendor) : undefined
      const account =
        vendor !== undefined && failure.category === 'model_unavailable'
          ? r?.accountDefaultModel?.(vendor)
          : undefined
      const target =
        pass !== undefined && mode !== undefined && r?.switchTarget !== undefined
          ? r.switchTarget(vendor, configPassOf(pass, this.#state.config.passes), mode)
          : undefined
      return snagActions({
        step,
        failure,
        hasSession: info.hasSession,
        hints: info.hints,
        at: info.at ?? this.deps.clock.now(),
        platform: this.deps.platform ?? process.platform,
        config: this.deps.config,
        folder: this.deps.scope.folder,
        ...(vendor !== undefined ? { vendor } : {}),
        ...(name !== undefined ? { vendorName: name } : {}),
        ...(tested !== undefined ? { testedUpTo: tested } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(target !== undefined ? { switchTarget: target } : {}),
        ...(st.modelUsed !== undefined ? { modelUsed: st.modelUsed } : {}),
        ...(st.modelReplaced !== undefined ? { modelReplaced: st.modelReplaced } : {}),
        ...(st.modelAsked !== undefined ? { modelAsked: st.modelAsked } : {}),
        ...(account !== undefined ? { accountDefaultModel: account } : {}),
      })
    } catch (err) {
      // A snag always has buttons: the default set when the list cannot be built.
      this.deps.log.error('snag actions failed', { runId: this.runId, step, err })
      return defaultRecoveryActions((k) => this.#state.steps[k].vendor, this.deps.platform)(
        step,
        failure,
        info,
      )
    }
  }

  #managedFlags(): Readonly<Record<string, readonly string[]>> | undefined {
    return this.deps.recovery?.managedFlags?.()
  }

  /** The config patch guards: managed flags and the vendor adapter's own extraArgs / flagMap rules. */
  #guard(): GuardOptions {
    return { managedFlags: this.#managedFlags(), vendorArgs: this.deps.recovery?.vendorArgs }
  }

  /**
   * P22: check a recovery patch (allowlist, the patched config parses, nothing protected changes) against the
   * run's resolved config, then hand the reducer the patched projection. When it accepts (a failed `step`, or no live
   * pass for a card's fix), `apply-patch` swaps the config in and records it in resolved.json before the retry runs.
   */
  applyConfigPatch(req: ConfigPatchRequest): Promise<Result<{ ops: JsonPatchOp[] }>> {
    return this.#withPatchLock(() => this.#applyConfigPatch(req))
  }

  #withPatchLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#patchLock.then(fn)
    this.#patchLock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #applyConfigPatch(req: ConfigPatchRequest): Promise<Result<{ ops: JsonPatchOp[] }>> {
    let patched: { config: ResolvedConfig; ops: JsonPatchOp[] }
    try {
      patched = patchResolved(this.deps.config, req.ops, this.#guard())
    } catch (err) {
      if (err instanceof DimFactoryError) return fail(err.code, err.message, err.details)
      throw err
    }
    const entry: ResolvedPatchEntry = {
      at: this.deps.clock.now(),
      ops: patched.ops,
      label: req.label,
      source: 'recovery',
      ...(req.step !== undefined ? { step: req.step } : {}),
      ...(req.actionId !== undefined ? { actionId: req.actionId } : {}),
    }
    const patchId = this.#addPendingPatch(patched.config, entry)
    try {
      const r = await this.command({
        kind: 'config-patch',
        config: runConfigFromResolved(patched.config, this.#state.config.planMode),
        label: req.label,
        patchId,
        entry,
        ...(req.step !== undefined ? { step: req.step } : {}),
        ...(req.strategy !== undefined ? { strategy: req.strategy } : {}),
      })
      return r.ok ? ok({ ops: patched.ops }) : r
    } finally {
      this.#pendingPatches.delete(patchId)
    }
  }

  /**
   * `runs.switchToAuto`: the run goes on in Auto (auto-switch.ts). Checked against the run's resolved config (in Auto
   * already: CONFLICT; a guardrail against full access: FORBIDDEN), then handed to the reducer like a config patch;
   * resolved.json records it in `patches[]` (source `auto`).
   */
  switchToAuto(): Promise<Result<void>> {
    return this.#withPatchLock(async () => {
      let next: { config: ResolvedConfig; ops: JsonPatchOp[] }
      try {
        next = autoSwitchConfig(this.deps.config)
      } catch (err) {
        if (err instanceof DimFactoryError) return fail(err.code, err.message, err.details)
        throw err
      }
      const entry: ResolvedPatchEntry = {
        at: this.deps.clock.now(),
        ops: next.ops,
        label: AUTO_SWITCH_LABEL,
        source: 'auto',
      }
      const patchId = this.#addPendingPatch(next.config, entry)
      try {
        const r = await this.command({
          kind: 'auto-on',
          config: runConfigFromResolved(next.config, this.#state.config.planMode),
          patchId,
          entry,
        })
        return r.ok ? ok(undefined) : r
      } finally {
        this.#pendingPatches.delete(patchId)
      }
    })
  }

  #addPendingPatch(config: ResolvedConfig, entry: ResolvedPatchEntry): string {
    this.#patchSeq += 1
    const patchId = `patch-${this.#patchSeq}`
    this.#pendingPatches.set(patchId, { config, entry })
    return patchId
  }

  /** `apply-patch`: the reducer accepted the patch; the next effects (preflight, spawn) see the new config. */
  async #applyPatch(patchId: string): Promise<void> {
    const p = this.#pendingPatches.get(patchId)
    if (p === undefined) {
      this.deps.log.warn('config patch not found', { runId: this.runId, patchId })
      return
    }
    this.#pendingPatches.delete(patchId)
    this.deps.config = p.config
    const write = this.#patchWrites.then(async () => {
      const r = await this.deps.store.readJson('resolved')
      if (r.kind !== 'ok') throw new Error(`resolved.json is ${r.kind}`)
      const doc = r.value
      const patches = Array.isArray(doc['patches']) ? [...(doc['patches'] as unknown[])] : []
      patches.push(p.entry)
      chaosPoint('patch:write')
      await this.deps.store.writeJson('resolved', { ...doc, patches })
      chaosPoint('patch:written')
    })
    this.#patchWrites = write.catch(() => undefined)
    try {
      await write
    } catch (err) {
      this.deps.log.error('resolved.json patch write failed', { runId: this.runId, err })
    }
  }

  /** `heal`: the healer over the failed spawn's filtered raw log; answers `heal-result` (never throws). */
  async #heal(e: EffectOf<'heal'>): Promise<void> {
    const d = this.deps
    const st = this.#state.steps[e.step]
    const vendor = st.vendor ?? (isAgentStep(e.step) ? passCfg(this.#state, e.step).vendor : 'claude')
    const api = d.recovery?.heal
    const managedFlags = this.#managedFlags()
    let view: HealView
    if (api === undefined) {
      view = failedHeal(e.trigger, d.clock.now(), 'Self-heal is not available in this build.', vendor, e.step)
    } else {
      try {
        const file = d.store.paths.raw(e.step, st.spawnNo)
        const tail =
          api.tail !== undefined
            ? await api.tail(file)
            : healTail(parseRawLog(await readFile(file, 'utf8').catch(() => '')))
        const outcome = await api.diagnose({
          runId: this.runId,
          step: e.step,
          failure: e.failure,
          trigger: e.trigger,
          vendor,
          vendorVersion: d.recovery?.vendorVersion?.(vendor) ?? null,
          passArgv: st.argv ?? [],
          tail,
        })
        const vendorArgs = d.recovery?.vendorArgs
        view = healViewOf(outcome, e.trigger, {
          step: e.step,
          config: d.config,
          vendor,
          ...(managedFlags !== undefined ? { managedFlags } : {}),
          ...(vendorArgs !== undefined ? { vendorArgs } : {}),
        })
      } catch (err) {
        view = failedHeal(e.trigger, d.clock.now(), errorMessage(err), vendor, e.step)
      }
    }
    await this.#withPatchLock(() => this.#healResult(e, view))
  }

  /** The heal's answer to the reducer, with a fix autoApplyConfigPatches may apply (checked under the patch lock). */
  async #healResult(e: EffectOf<'heal'>, view: HealView): Promise<void> {
    const d = this.deps
    // autoApplyConfigPatches: only the /passes/*/model, /timeouts/*, /vendors/*/{extraArgs,flagMap/*} subset.
    let autoApply: Extract<EngineEventBody, { t: 'heal-result' }>['autoApply']
    const autoApplyOn = d.recovery?.autoApplyConfigPatches?.() ?? d.config.selfHeal.autoApplyConfigPatches
    if ((view.status === 'ok' || view.status === 'cached') && autoApplyOn) {
      for (const a of view.actions) {
        if (a.kind !== 'config_patch' || !isAutoApplicable(a.ops)) continue
        try {
          const patched = patchResolved(d.config, a.ops, this.#guard())
          const entry: ResolvedPatchEntry = {
            at: d.clock.now(),
            ops: patched.ops,
            label: a.label,
            source: 'self-heal',
            ...(isAgentStep(e.step) ? { step: e.step } : {}),
            actionId: a.id,
          }
          const patchId = this.#addPendingPatch(patched.config, entry)
          autoApply = {
            patchId,
            actionId: a.id,
            label: a.label,
            config: runConfigFromResolved(patched.config, this.#state.config.planMode),
            entry,
          }
          break
        } catch {
          // Not applicable to this run's config: it stays a suggestion.
        }
      }
    }
    await this.enqueue({
      t: 'heal-result',
      step: e.step,
      healId: e.healId,
      heal: view,
      ...(autoApply !== undefined ? { autoApply } : {}),
    })
    if (autoApply !== undefined) this.#pendingPatches.delete(autoApply.patchId)
  }

  /** Live vendor processes of this run (pid known once spawned). */
  liveProcs(): { step: AgentStep; pid?: number }[] {
    return [...this.#procs.values()]
      .filter((p) => !p.exited)
      .map((p) => (p.pid !== undefined ? { step: p.step, pid: p.pid } : { step: p.step }))
  }

  /**
   * Resolves once every event queued so far has been reduced and its effects started (detached effects such as
   * snapshots or spawns may still be running). `e2e.clock` waits for the timers it fired.
   */
  drained(): Promise<void> {
    if (!this.#draining && this.#queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.#drainWaiters.push(resolve))
  }

  /** True when no event is queued and no detached effect is in flight. */
  get idle(): boolean {
    return !this.#draining && this.#queue.length === 0 && this.#inflight.size === 0
  }

  async settle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.idle && Date.now() < deadline) {
      await Promise.race([...this.#inflight, new Promise((r) => setTimeout(r, 25))])
    }
  }

  // ---- adapter hook ------------------------------------------------------------------------------------------

  /** `adapter.onSpawn`: procs.json entry, then `spawned` (session id persisted) before the first stdin write. */
  async onChildSpawned(
    o: StartOptions,
    child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
  ): Promise<void> {
    const step = o.step
    if (!isAgentStep(step)) return
    const ap = this.#procs.get(step)
    if (ap === undefined || ap.start !== o) return
    ap.pid = child.pid
    ap.spawnAt = child.spawnAt
    chaosPoint('spawn:spawned')
    const sid = isMutatingStep(step) ? presetSessionId(o) : undefined
    const spawned = this.enqueue({
      t: 'spawned',
      step,
      spawnNo: ap.spawnNo,
      pid: child.pid,
      route: ap.handle.route,
      argv: [child.command, ...child.argv],
      inBytes: ap.promptBytes,
      cwd: o.cwd,
      ...(sid !== undefined ? { sessionId: sid } : {}),
    })
    try {
      const rec = await this.deps.procTable.add(procRecordFor(child, step, ap.adapter.transport))
      ap.procId = rec.id
    } catch (err) {
      this.deps.log.warn('procs.json write failed', { runId: this.runId, step, err })
    }
    chaosPoint('spawn:recorded')
    this.#ensureTouch()
    await spawned
  }

  // ---- loop ------------------------------------------------------------------------------------------------

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const { taken, ev } = takeQueuedText(this.#queue.shift()!, this.#queue)
      let effects: Effect[] = []
      if (!this.#closed) {
        try {
          effects = await this.#process(ev)
        } catch (err) {
          this.deps.log.error('controller event failed', { runId: this.runId, event: ev.t, err })
        }
      }
      for (const item of taken) item.resolve(effects)
    }
    this.#draining = false
    for (const w of this.#drainWaiters.splice(0)) w()
  }

  async #process(ev: EngineEvent): Promise<Effect[]> {
    const wasOver = isRunOver(this.#state.status)
    const r = reduce(this.#state, ev, this.ctx)
    this.#state = r.state
    if (!wasOver && isRunOver(this.#state.status)) this.#track(this.#writeContextHealth())
    // Output files land before the `output` bodies that announce them.
    for (const e of r.effects) {
      if (e.t === 'writeOutput') await this.#writeOutput(e)
      else if (e.t === 'writeFindings') await this.#writeFindings(e.doc)
    }
    let progress = false
    for (const e of r.effects) {
      if (e.t !== 'emit') continue
      this.#emit(e.body)
      if (e.body.t === 'usage' || e.body.t === 'diff-stats') progress = true
    }
    // P15: the end snapshot and its end-of-pass check run side by side; both are registered before either starts,
    // so the check can read the snapshot and the snapshot's result can wait for the check's.
    for (const e of r.effects) {
      if (e.t === 'snapshot') {
        const step = endSnapshotStep(e)
        if (step !== undefined) this.#endSnaps.set(step, deferred())
      } else if (
        e.t === 'reconcile' &&
        e.input.awaitEnd === true &&
        e.step !== undefined &&
        isAgentStep(e.step)
      ) {
        this.#endChecks.set(e.step, deferred())
      }
    }
    let persisted = false
    /** Why run.json's write-ahead failed (no vendor process starts that the run cannot record). */
    let unsaved: unknown
    if (r.transition) {
      // Write-ahead: events.jsonl and run.json are both durable before any effect runs, so a crash can never
      // leave run.json behind work the effects started (a spawn, a snapshot, the lock). recovery.ts projects the
      // log onto run.json for the few milliseconds where one write landed and the other did not.
      const [synced, flushed] = await Promise.allSettled([
        this.deps.bus.sync(this.runId),
        (async () => {
          this.deps.store.set(this.doc())
          await this.deps.store.flush()
        })(),
      ])
      if (synced.status === 'rejected')
        this.deps.log.error('events.jsonl sync failed', { runId: this.runId, err: synced.reason })
      if (flushed.status === 'rejected') {
        this.deps.log.error('run.json write failed', { runId: this.runId, err: flushed.reason })
        unsaved = flushed.reason ?? new Error('run.json could not be written')
      } else persisted = true
    }
    if (ev.t === 'user' && chaosArmed()) chaosPoint(`command:${ev.cmd.kind}`)
    for (const e of r.effects) {
      if (e.t === 'emit' || e.t === 'writeOutput' || e.t === 'writeFindings') continue
      if (e.t === 'persist' && persisted) continue
      if (chaosArmed()) chaosPoint(`effect:${e.t}`)
      if (e.t === 'spawn' && unsaved !== undefined) {
        // Write-ahead: a pass the run could not record as started is not started. On a full drive the
        // run went on blind before, its passes' work unrecorded; now the pass fails with a snag the user can Retry.
        this.#synthFail(e, unsavedLaunchFailure(unsaved, e.step))
        continue
      }
      await this.#exec(e)
    }
    if (progress) this.deps.putSummary?.(this.deps.summarize(this.#state), true)
    for (const fn of [...this.#listeners]) {
      try {
        fn(this.#state, r.effects)
      } catch (err) {
        this.deps.log.error('run listener threw', { runId: this.runId, err })
      }
    }
    return r.effects
  }

  #emit(body: RunEventBody): void {
    try {
      if (body.t === 'ev' && body.ev.type === 'text')
        this.deps.bus.pass(this.runId, body.step, body.attempt, body.ev)
      else this.deps.bus.emit(this.runId, body)
    } catch (err) {
      this.deps.log.error('bus emit failed', { runId: this.runId, body: body.t, err })
    }
  }

  async #writeOutput(e: EffectOf<'writeOutput'>): Promise<void> {
    if (!TEXT_OUTPUTS.includes(e.file)) {
      this.deps.log.warn('unsupported output file', { runId: this.runId, file: e.file })
      return
    }
    // review.md / critic.md: the pass's raw output with LF endings (findings/render.ts).
    const text =
      e.file === 'review' || e.file === 'critic' || e.file === 'security' || e.file === 'recheck'
        ? reviewArtifactText(e.text)
        : e.text
    try {
      await this.deps.store.writeText(e.file as RunTextOutput, text.endsWith('\n') ? text : `${text}\n`)
    } catch (err) {
      this.deps.log.error('output write failed', { runId: this.runId, file: e.file, err })
    }
  }

  /** P15 read-only ⇒ parse findings (findings/parse.ts never throws; a crash still answers `failed`). */
  #parseFindings(e: EffectOf<'parseFindings'>): void {
    let status: SourceParseStatus
    let findings: FindingInput[]
    try {
      const parsed = parseFindings(e.text, e.step)
      status = parsed.parse.status
      findings = parsed.findings
    } catch (err) {
      this.deps.log.error('findings parse failed', { runId: this.runId, step: e.step, err })
      status = 'failed'
      findings = []
    }
    void this.enqueue({ t: 'findings-result', req: e.req, status, findings })
  }

  /** findings.json as an earlier process wrote it (undefined when missing or not a findings file). */
  async #readFindingsDoc(): Promise<FindingsFile | undefined> {
    try {
      const r = await this.deps.store.readJson('findings')
      if (r.kind !== 'ok') return undefined
      const v = r.value
      return Array.isArray(v['findings']) && typeof v['selected'] === 'object' && v['selected'] !== null
        ? (v as unknown as FindingsFile)
        : undefined
    } catch {
      return undefined
    }
  }

  async #writeFindings(doc: FindingsFile): Promise<void> {
    // The reducer writes findings.json again after Fix (verify:2's findings); Fix's report, added by the
    // controller at S2, stays (its keys are finding ids, which the new list keeps).
    let next = doc
    if (doc.fixReport === undefined) {
      const prev = this.#findingsDoc ?? (await this.#readFindingsDoc())
      if (prev?.fixReport !== undefined) next = { ...doc, fixReport: prev.fixReport }
    }
    this.#findingsDoc = next
    try {
      await this.deps.store.writeJson('findings', next)
    } catch (err) {
      this.deps.log.error('findings.json write failed', { runId: this.runId, err })
    }
  }

  #track(p: Promise<unknown>): void {
    const q = p.catch((err: unknown) =>
      this.deps.log.error('controller effect failed', { runId: this.runId, err }),
    )
    this.#inflight.add(q)
    void q.finally(() => this.#inflight.delete(q))
  }

  async #exec(e: Effect): Promise<void> {
    const d = this.deps
    switch (e.t) {
      case 'emit':
      case 'writeOutput':
      case 'writeFindings':
        return
      case 'parseFindings':
        this.#parseFindings(e)
        return
      case 'persist':
        try {
          d.store.set(this.doc())
          if (e.force) await d.store.flush()
        } catch (err) {
          d.log.error('run.json write failed', { runId: this.runId, err })
        }
        return
      case 'index':
        d.putSummary?.(d.summarize(this.#state), false)
        return
      case 'lock':
        d.scheduler.request(
          this.runId,
          runLockKeyOf(d.scope),
          () => void this.enqueue({ t: 'lock-acquired' }),
        )
        // Queued: the summary indexed before this request named no blocker yet ("Queued · blocked by run #N").
        if (d.scheduler.isQueued(this.runId)) d.putSummary?.(d.summarize(this.#state), false)
        return
      case 'unlock':
        d.scheduler.release(this.runId)
        // The release is not a status change (a stopped run is `cancelled` before its last snapshot lets the folder
        // go): publish it, so whoever asked core about the folder (the composer's folder.lock) asks again.
        d.putSummary?.(d.summarize(this.#state), false)
        return
      case 'preflight':
        this.#track(this.#preflight(e))
        return
      case 'prepare':
        this.#track(this.#prepare(e))
        return
      case 'prepareStop':
        this.#prepareStops.get(e.req)?.abort()
        return
      case 'lease':
        d.scheduler.lease(this.runId, d.scope.lockKey, () => void this.enqueue({ t: 'lease-acquired' }))
        return
      case 'unlease':
        d.scheduler.releaseLease(this.runId)
        return
      case 'finalizePreview':
        this.#track(this.#finalizePreview(e))
        return
      case 'apply':
        this.#track(this.#apply(e))
        return
      case 'undoApply':
        this.#track(this.#undoApply(e))
        return
      case 'removeWorktree':
        this.#track(this.#removeWorktree(e))
        return
      case 'writeBaseline':
        this.#track(
          this.#iso()
            .writeBaseline(d.paths, this.runId, e.baseline)
            .catch((err: unknown) => d.log.warn('baseline.json write failed', { runId: this.runId, err })),
        )
        return
      case 'snapshot':
        this.#track(this.#snapshot(e))
        return
      case 'reconcile':
        this.#track(this.#reconcile(e))
        return
      case 'branch':
        this.#track(this.#branch(e))
        return
      case 'revert': {
        const p = this.#revert(e)
        if (e.why === 'user' || e.why === 'undo') this.#revertResults.set(e.req, p)
        this.#track(p)
        return
      }
      case 'spawn':
        this.#spawn(e)
        return
      case 'answer': {
        const ap = this.#procs.get(e.step)
        if (ap === undefined || ap.spawnNo !== e.spawnNo || ap.exited) return
        try {
          ap.adapter.answer(ap.handle, e.requestId, e.decision, e.why)
        } catch (err) {
          d.log.error('adapter.answer failed', { runId: this.runId, step: e.step, err })
        }
        return
      }
      case 'interrupt': {
        if (this.#cancelPending(e.step, e.spawnNo)) return
        const ap = this.#procs.get(e.step)
        if (ap === undefined || ap.spawnNo !== e.spawnNo || ap.exited) return
        this.#track(ap.adapter.stop(ap.handle, this.#stopReason(e.step)))
        return
      }
      case 'kill': {
        if (this.#cancelPending(e.step, e.spawnNo)) return
        const ap = this.#procs.get(e.step)
        if (ap === undefined || ap.spawnNo !== e.spawnNo || ap.exited) return
        this.#track(this.#hardKill(ap))
        return
      }
      case 'timer': {
        const prev = this.#timers.get(e.id)
        if (prev !== undefined) d.clock.clearTimer(prev)
        const h = d.clock.setTimer(() => {
          if (this.#timers.get(e.id) !== h) return
          this.#timers.delete(e.id)
          void this.enqueue({ t: 'timer', id: e.id, due: e.at })
        }, e.at)
        this.#timers.set(e.id, h)
        return
      }
      case 'clearTimer': {
        const h = this.#timers.get(e.id)
        if (h !== undefined) d.clock.clearTimer(h)
        this.#timers.delete(e.id)
        return
      }
      case 'notify':
        try {
          d.notify?.(this.runId, e, this.#state)
        } catch (err) {
          d.log.error('notify failed', { runId: this.runId, err })
        }
        return
      case 'heal':
        this.#track(this.#heal(e))
        return
      case 'apply-patch':
        await this.#applyPatch(e.patchId)
        return
      case 'liveCount':
        this.#setLiveCount(e.on)
        return
      case 'sweep':
        try {
          const r = await d.procTable.sweep()
          if (r.killed.length > 0)
            d.log.info('swept orphaned processes', { runId: this.runId, pids: r.killed })
        } catch (err) {
          d.log.error('orphan sweep failed', { runId: this.runId, err })
        }
        return
      case 'verifyCheck':
        this.#track(this.#verifyCheck(e))
        return
      case 'trustGrant':
        this.#track(this.#trustGrant(e))
        return
      case 'verify':
        this.#track(this.#verifyRound(e))
        return
      case 'verifyStop':
        this.#verifyRounds.get(e.req)?.abort()
        return
      case 'testsCheck':
        this.#track(this.#testsCheck(e))
        return
      case 'groundingCheck':
        this.#track(this.#groundingCheck(e))
        return
      case 'scanCheck':
        this.#track(this.#scanCheck(e))
        return
      case 'scan':
        this.#track(this.#scan(e))
        return
      case 'scanStop':
        this.#verifyRounds.get(e.req)?.abort()
        return
      case 'deployPlan':
        this.#track(this.#deployPlan(e))
        return
      case 'result':
        return
    }
  }

  /** The run's folder relative to its scope root (`/` separators; '' for the root). */
  #folderRel(): string {
    // The scope root is a real path while the folder is as the user gave it (maybe an 8.3 short name or under a linked
    // temp folder): compared by real name, or the folder would read as outside its own repository.
    const rel = (relativeInside(this.#workRoot(), this.#workFolder()) ?? '').split(sep).join('/')
    return rel === '.' ? '' : rel
  }

  /** What the security scan reads: the shadow's commits (the run's folder only) and the folder itself. */
  #scanIo(): ScanIo {
    const rel = this.#folderRel()
    const prefix = rel === '' ? '' : `${rel}/`
    const scope = rel === '' ? '.' : rel
    return {
      patch: async (from, to) => {
        const shadow = await this.#shadow()
        const r = await shadow.git([
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-renames',
          '--unified=0',
          from,
          to,
          '--',
          scope,
        ])
        return r.stdout.length > SCAN_PATCH_MAX_CHARS ? r.stdout.slice(0, SCAN_PATCH_MAX_CHARS) : r.stdout
      },
      changedPaths: async (from, to) => {
        const shadow = await this.#shadow()
        const r = await shadow.git(['diff', '--name-only', '--no-renames', '-z', from, to, '--', scope])
        return r.stdout
          .split('\0')
          .filter((x) => x !== '' && x.startsWith(prefix))
          .map((x) => x.slice(prefix.length))
      },
      fileAt: async (commit, path) => {
        const shadow = await this.#shadow()
        try {
          return (await shadow.git(['cat-file', '-p', `${commit}:${prefix}${path}`])).stdout
        } catch {
          return null
        }
      },
      folderFiles: async () => {
        const folder = this.#workFolder()
        const top = await readdir(folder).catch((): string[] => [])
        const req = await readdir(join(folder, 'requirements')).catch((): string[] => [])
        return [...top, ...req.map((n) => `requirements/${n}`)]
      },
    }
  }

  /** An audit's working folder relative to the scope root (trust and the runner read it so). */
  #auditCwdRel(cwdRel: string): string {
    const rel = this.#folderRel()
    if (rel === '') return cwdRel
    return cwdRel === '.' || cwdRel === '' ? rel : `${rel}/${cwdRel}`
  }

  /**
   * The security scan's check: which audits apply to what the run changed, and how each stands against trust.json
   * (its body read now, as Verify's are). A failure goes back as such: the scan then runs its secret scanner alone.
   */
  async #scanCheck(e: EffectOf<'scanCheck'>): Promise<void> {
    let body: EngineEventBody
    try {
      const plan = await planScan(this.#scanIo(), e.from, e.to)
      const grants = await this.#trustGrants()
      const root = this.#workRoot()
      const audits = await Promise.all(
        plan.audits.map(async (a): Promise<ScanCheckAudit> => {
          const cmd = { argv: a.argv, cwdRel: this.#auditCwdRel(a.cwdRel) }
          const read = await readCommandBody(root, cmd)
          const base = {
            name: a.name,
            tool: a.tool,
            lockfile: a.lockfile,
            argv: [...a.argv],
            cwdRel: cmd.cwdRel,
            body: read.body,
          }
          if (read.error !== undefined) return { ...base, trust: 'invalid', reason: read.error }
          const t = trustOf(cmd, read.body, grants)
          if (t.via === 'project') this.#projectUse(displayArgv(a.argv))
          return t.trust === 'changed'
            ? { ...base, trust: 'changed', grantedBody: t.grantedBody ?? null }
            : { ...base, trust: t.trust }
        }),
      )
      body = { t: 'scan-check-result', req: e.req, audits, notes: plan.notes }
    } catch (err) {
      this.deps.log.warn('security scan check failed', { runId: this.runId, err })
      body = {
        t: 'scan-check-result',
        req: e.req,
        audits: [],
        notes: [],
        failure: gitFailure(err, 'snapshot_failed'),
      }
    }
    await this.enqueue(body)
  }

  /**
   * The security scan: the secret scanner over the run's changes, then each audit through the verify round runner
   * (trust checked again right before it spawns, no shell, its timeout, children in procs.json, Stop aborts it), its
   * standard output read as the tool's JSON. Exactly one `scan-result` goes back.
   */
  async #scan(e: EffectOf<'scan'>): Promise<void> {
    const d = this.deps
    const ac = new AbortController()
    this.#verifyRounds.set(e.req, ac)
    let body: EngineEventBody
    try {
      const runAudits = async (audits: readonly ScanRunAudit[]): Promise<Map<string, AuditRun>> => {
        const out = new Map<string, AuditRun>()
        const toRun = audits.filter((a) => a.run)
        if (toRun.length === 0) return out
        const stdout = new Map<number, string[]>()
        const v = d.verify
        const deps: VerifyDeps = {
          paths: d.paths,
          grants: () => this.#trustGrants(),
          procTable: d.procTable,
          ...(v?.pathEnv !== undefined ? { pathEnv: v.pathEnv } : {}),
          ...(v?.env !== undefined ? { env: v.env } : {}),
        }
        const r = await (v?.runRound ?? runVerifyRound)(deps, {
          runId: this.runId,
          round: 'scan',
          folder: this.#workFolder(),
          scopeRoot: this.#workRoot(),
          commands: toRun.map((a) => ({
            name: a.name,
            argv: [...a.argv],
            cwdRel: a.cwdRel,
            timeoutMs: AUDIT_TIMEOUT_MS,
          })),
          failFast: false,
          onOutput: (ev) => {
            if (ev.type !== 'line' || ev.stream !== 'stdout') return
            const list = stdout.get(ev.index) ?? []
            list.push(ev.line)
            stdout.set(ev.index, list)
          },
          signal: ac.signal,
        })
        toRun.forEach((a, i) => {
          const result = r.results[i]
          if (result !== undefined) out.set(a.name, { result, stdout: (stdout.get(i) ?? []).join('\n') })
        })
        return out
      }
      const res = await runSecurityScan(this.#scanIo(), {
        from: e.from,
        to: e.to,
        audits: e.audits,
        runAudits,
      })
      body = { t: 'scan-result', req: e.req, ...res }
    } catch (err) {
      d.log.warn('security scan failed', { runId: this.runId, err })
      body = {
        t: 'scan-result',
        req: e.req,
        secrets: [],
        audits: [],
        advisories: [],
        existing: 0,
        notes: [],
        findings: [],
        failure: {
          category: 'unknown',
          message: errorMessage(err),
          raw: '',
          classifiedBy: 'app',
          step: 'scan',
        },
      }
    } finally {
      this.#verifyRounds.delete(e.req)
    }
    await this.enqueue(body)
  }

  // ---- isolated runs (worktree) ----------------------------------------------------------------------------------

  #iso(): IsolationApi {
    return this.deps.isolation ?? ISO_API
  }

  /** The run's folder where its passes and checks work: the worktree's copy of it once it exists. */
  #workFolder(): string {
    return workFolderOf(this.deps.scope.folder, this.#state.isolation)
  }

  /** The scope root of the run's work (the worktree's root, else the folder's). */
  #workRoot(): string {
    return this.#state.isolation?.worktree?.path ?? this.deps.scope.scopeRoot
  }

  /**
   * The shadow the run's snapshots are in: the worktree's own (its folder key) once it exists (an isolated
   * run takes `run-start` after the worktree exists), else the folder's. RunDoc.work records the worktree's scope.
   */
  #shadow(): Promise<Shadow> {
    const wt = this.#state.isolation?.worktree
    if (wt === undefined) return this.deps.shadow()
    const folder = this.#workFolder()
    if (this.#workShadowP === undefined || this.#workShadowFolder !== folder) {
      const open =
        this.deps.workShadow ??
        ((f: string) => resolveScope(f).then((info) => shadowFor(info, { home: this.deps.paths.home })))
      const p = open(folder)
      this.#workShadowP = p
      this.#workShadowFolder = folder
      p.then(
        (sh) => {
          if (this.#work === undefined) {
            this.#work = {
              folder,
              scopeRoot: sh.scope.scopeRoot,
              lockKey: sh.scope.lockKey,
              folderKey: sh.scope.folderKey,
              isRepo: sh.scope.isRepo,
            }
            this.deps.store.set(this.doc())
          }
        },
        () => {
          if (this.#workShadowP === p) this.#workShadowP = undefined
        },
      )
    }
    return this.#workShadowP
  }

  /** A prepare stage (ISO_API), answered by exactly one `prepare-result`; an install streams its output. */
  async #prepare(e: EffectOf<'prepare'>): Promise<void> {
    const ac = new AbortController()
    this.#prepareStops.set(e.req, ac)
    let body: EngineEventBody
    try {
      switch (e.stage) {
        case 'setup':
          body = await this.#prepareSetup(e)
          break
        case 'rest':
          body = await this.#prepareDeps(e)
          break
        case 'install':
          body = await this.#prepareInstall(e, ac.signal)
          break
        case 'ready':
          body = await this.#prepareReady(e)
          break
      }
    } catch (err) {
      this.deps.log.warn('prepare failed', { runId: this.runId, stage: e.stage, err })
      body = { t: 'prepare-result', req: e.req, ok: false, failure: prepareFailure(err, e.stage) }
    } finally {
      this.#prepareStops.delete(e.req)
    }
    await this.enqueue(body)
  }

  /**
   * Steps 1 and 2: eligibility, the worktree from HEAD (its write-ahead in the finalize journal, so a crash between
   * `worktree add` and this answer leaves one the Resume adopts), the folder's uncommitted changes it leaves out, then
   * the copy-ins (ignored or untracked files only).
   */
  async #prepareSetup(e: EffectOf<'prepare'>): Promise<EngineEventBody> {
    const d = this.deps
    const iso = this.#iso()
    const s = this.#state
    const home = d.paths.home
    const notes: string[] = []
    let wt = s.isolation?.worktree
    const fromSnapshot = s.copyFrom
    if (wt === undefined && fromSnapshot !== undefined) {
      // A match's side: the files of the match's starting snapshot, read out of the folder's shadow. The folder need
      // not be a repository, and nothing is written to it or to its repository.
      const journal = fileJournal(journalFile(home, this.runId))
      const made = await iso.createCopy({
        home,
        runId: this.runId,
        source: await d.shadow(),
        tree: fromSnapshot.tree,
        onIntent: async (w) => {
          await iso.recordWorktree(journal, w, 'pending', d.clock.now())
          if (this.#closed) throw new Error('The run closed before its copy was made.')
        },
      })
      await iso.recordWorktree(journal, made, 'created', d.clock.now())
      wt = { path: made.path, branch: made.branch, base: made.base }
    }
    if (wt === undefined) {
      const elig = await iso.checkEligibility(d.scope.folder, {
        home,
        runId: this.runId,
        ...(d.platform !== undefined ? { platform: d.platform } : {}),
      })
      if (!elig.ok) {
        return {
          t: 'prepare-result',
          req: e.req,
          ok: false,
          failure: {
            category: 'worktree_failed',
            message: elig.reasons.join(' ') || 'This folder cannot have an isolated run.',
            raw: '',
            classifiedBy: 'app',
            step: 'prepare',
          },
        }
      }
      const lp = elig.longPathWarning
      if (lp !== undefined) notes.push(`${lp.title}: ${lp.detail} (${lp.command.command})`)
      const journal = fileJournal(journalFile(home, this.runId))
      const made = await iso.createWorktree({
        home,
        runId: this.runId,
        folder: d.scope.folder,
        branch: worktreeBranchName(d.config.isolation.branchPrefix, s.createdAt, s.task, this.runId),
        onIntent: async (w) => {
          await iso.recordWorktree(journal, w, 'pending', d.clock.now())
          if (this.#closed) throw new Error('The run closed before its worktree was made.')
        },
      })
      await iso.recordWorktree(journal, made, 'created', d.clock.now())
      wt = { path: made.path, branch: made.branch, base: made.base }
    }
    const rel = await folderRel(d.scope.folder, d.scope.scopeRoot)
    const workFolder = rel === '' ? wt.path : join(wt.path, ...rel.split('/'))
    // A snapshot's copy already holds the folder's uncommitted changes: there is nothing it leaves out to count.
    const uncommitted =
      fromSnapshot !== undefined
        ? undefined
        : await iso.uncommittedCount(d.scope.folder).catch(() => undefined)
    const globs = d.config.isolation.worktree.copy
    let copied: number | undefined
    if (globs.length > 0) {
      const r = await iso.copyIns(d.scope.folder, workFolder, globs, {
        ...(d.platform !== undefined ? { platform: d.platform } : {}),
        // A snapshot's copy has every file the snapshot held, tracked by git or not, and a file the copy already has
        // is never written over: so nothing needs git's list (which a folder that is no repository does not have).
        ...(fromSnapshot !== undefined
          ? { tracked: () => Promise.resolve({ files: new Set<string>(), gitlinks: [] }) }
          : {}),
      })
      copied = r.copied.length
      for (const g of r.refused) notes.push(`Copy-in ${g.glob} was not used: ${g.reason}`)
      const left = r.skipped.filter((x) => x.path !== '')
      if (left.length > 0) {
        notes.push(
          `Not copied into the isolated copy: ${left
            .slice(0, 5)
            .map((x) => `${x.path} (${x.reason})`)
            .join(', ')}${left.length > 5 ? ` and ${left.length - 5} more` : ''}.`,
        )
      }
    }
    return {
      t: 'prepare-result',
      req: e.req,
      ok: true,
      worktree: { path: wt.path, branch: wt.branch, base: wt.base, rel },
      ...(uncommitted !== undefined ? { uncommitted } : {}),
      ...(copied !== undefined ? { copied } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    }
  }

  /** Step 3's decision (an edited command, installCommand or detection) and its `deps` trust (SOURCE grants). */
  async #prepareDeps(e: EffectOf<'prepare'>): Promise<EngineEventBody> {
    const d = this.deps
    const w = d.config.isolation.worktree
    const r = await this.#iso().decideDepsStage(
      { install: w.install, installCommand: w.installCommand },
      {
        worktreeFolder: this.#workFolder(),
        worktreeRoot: this.#workRoot(),
        grants: () => this.#trustGrants(),
        ...(e.command !== undefined ? { edited: e.command } : {}),
        ...(d.platform !== undefined ? { platform: d.platform } : {}),
      },
    )
    if (r.error !== undefined) {
      return {
        t: 'prepare-result',
        req: e.req,
        ok: false,
        failure: {
          category: 'deps_missing',
          message: r.error,
          raw: '',
          classifiedBy: 'app',
          step: 'prepare',
        },
      }
    }
    if (r.via === 'project' && r.plan !== null) this.#projectUse(displayArgv(r.plan.argv))
    if (r.plan === null || r.view === undefined) {
      return {
        t: 'prepare-result',
        req: e.req,
        ok: true,
        deps: null,
        ...(r.skip !== undefined ? { skip: r.skip } : {}),
      }
    }
    return {
      t: 'prepare-result',
      req: e.req,
      ok: true,
      deps: {
        command: { ...r.view, plan: r.plan },
        trust: r.trust ?? 'untrusted',
        ...(r.body !== undefined ? { body: r.body } : {}),
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      },
    }
  }

  /**
   * The install (src/core/prepare runInstall): the `deps` grant is checked again right before anything spawns, no shell,
   * 15 min then a tree kill, Stop kills its tree. Its live output is announced as `prepare-progress` (at most every
   * 500 ms).
   */
  async #prepareInstall(e: EffectOf<'prepare'>, signal: AbortSignal): Promise<EngineEventBody> {
    const d = this.deps
    const plan = e.deps?.plan as DepsPlan | undefined
    if (plan === undefined) throw new Error('No install command was given.')
    let timer: ReturnType<typeof setTimeout> | undefined
    const announce = (): void => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void this.enqueue({ t: 'prepare-progress', req: e.req, output: true })
      }, PREPARE_OUTPUT_EVERY_MS)
      timer.unref()
    }
    try {
      const v = d.verify
      const r = await this.#iso().runInstall(
        {
          paths: d.paths,
          grants: () => this.#trustGrants(),
          procTable: d.procTable,
          ...(v?.pathEnv !== undefined ? { pathEnv: v.pathEnv } : {}),
          ...(v?.env !== undefined ? { env: v.env } : {}),
          ...(d.platform !== undefined ? { platform: d.platform } : {}),
        },
        { runId: this.runId, root: this.#workRoot(), plan, onOutputWritten: announce, signal },
      )
      return {
        t: 'prepare-result',
        req: e.req,
        ok: true,
        install: {
          status: r.status,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          excerpt: r.excerpt,
          ...(r.reason !== undefined ? { reason: r.reason } : {}),
          ...(r.timedOut === true ? { timedOut: true } : {}),
        },
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Step 5 (`isolation.verifyReady`): every enabled verify command's program resolves in the worktree. */
  async #prepareReady(e: EffectOf<'prepare'>): Promise<EngineEventBody> {
    const d = this.deps
    const rep = await this.#iso().checkVerifyReady(d.config, {
      worktreeFolder: this.#workFolder(),
      worktreeRoot: this.#workRoot(),
      ...(d.verify?.pathEnv !== undefined ? { pathEnv: d.verify.pathEnv } : {}),
      ...(d.platform !== undefined ? { platform: d.platform } : {}),
    })
    return {
      t: 'prepare-result',
      req: e.req,
      ok: true,
      missing: rep.missing.map((m) => ({
        name: m.name,
        argv: [...m.argv],
        reason: `${programName(m.argv[0] ?? m.name)} was not found in the isolated copy`,
      })),
    }
  }

  /**
   * The finalize target (git/finalize.ts): the run's worktree and its combined segment (W.S0..W.last, commits in the
   * worktree's shadow). Undefined when the run recorded no changes (nothing to apply).
   */
  #finalizeTarget(): FinalizeTarget | undefined {
    const s = this.#state
    const wt = s.isolation?.worktree
    const ends = segmentEnds(s, 'combined')
    if (wt === undefined || ends === undefined) return undefined
    return {
      home: this.deps.paths.home,
      runId: this.runId,
      folder: this.deps.scope.folder,
      worktree: { path: wt.path, branch: wt.branch, base: wt.base },
      from: ends.from.commit,
      to: ends.to.commit,
      now: this.deps.clock.now,
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
    }
  }

  /** R12: what Apply would do (no writes). */
  async #finalizePreview(e: EffectOf<'finalizePreview'>): Promise<void> {
    let body: EngineEventBody
    try {
      const t = this.#finalizeTarget()
      if (t === undefined) body = { t: 'finalize-preview', req: e.req, files: 0, conflicts: [] }
      else {
        const p = await this.#iso().previewApply(t)
        const reasons = new Map(
          p.actions.filter((a) => a.action === 'conflict').map((a) => [a.path, a.reason]),
        )
        body = {
          t: 'finalize-preview',
          req: e.req,
          files: p.files.length,
          conflicts: p.conflicts.map((path) => {
            const reason = reasons.get(path)
            return reason !== undefined ? { path, reason } : { path }
          }),
        }
      }
    } catch (err) {
      this.deps.log.warn('apply preview failed', { runId: this.runId, err })
      body = { t: 'finalize-preview', req: e.req, failure: finalizeFailure(err) }
    }
    await this.enqueue(body)
  }

  /**
   * Apply under the SOURCE folder's lease (the reducer took it): git/finalize.ts takes snapshot P, journals each step
   * and writes only files whose folder content still equals the base. [Finish apply] finishes the journal's
   * interrupted apply; when the journal has none, an apply that finished unrecorded (Dim Factory closed right after it)
   * is reported as it was, and only otherwise is the apply made again.
   */
  async #apply(e: EffectOf<'apply'>): Promise<void> {
    const iso = this.#iso()
    let body: EngineEventBody
    const t = this.#finalizeTarget()
    try {
      if (t === undefined) {
        body = { t: 'apply-result', req: e.req, applied: [], conflicts: [] }
      } else {
        const known = new Set((this.#state.isolation?.finalize?.applies ?? []).map((a) => a.token))
        let r:
          | (Pick<WorktreeApplyResult, 'applied' | 'conflicts' | 'undoToken'> & {
              skipped?: { path: string; reason: string }[]
              conflictDetails?: { path: string; reason: string }[]
            })
          | null = null
        const onStep = this.#e2eApplyHold()
        if (e.resume === true) {
          r = await iso.finishApply(t, onStep !== undefined ? { onStep } : {})
          if (r === null) {
            const j = await iso.journalState(t.home, this.runId)
            const last = j.lastApplied
            if (last !== undefined && !known.has(last.token)) r = { ...last, undoToken: last.token }
          }
        }
        r ??= await iso.applyRun(t, {
          ...(e.paths !== undefined ? { paths: e.paths } : {}),
          ...(e.resolutions !== undefined ? { resolutions: e.resolutions } : {}),
          ...(onStep !== undefined ? { onStep } : {}),
        })
        const skipped = r.skipped ?? []
        body = {
          t: 'apply-result',
          req: e.req,
          applied: [...r.applied],
          // Each conflict with git/finalize's reason when it gives one (the finalizeConflicts card shows it).
          conflicts: r.conflicts.map((path) => {
            const reason = r?.conflictDetails?.find((c) => c.path === path)?.reason
            return reason !== undefined ? { path, reason } : { path }
          }),
          undoToken: r.undoToken,
          ...(skipped.length > 0
            ? {
                notes: [
                  `Left alone in the folder: ${skipped
                    .slice(0, 5)
                    .map((x) => `${x.path} (${x.reason})`)
                    .join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}.`,
                ],
              }
            : {}),
        }
      }
    } catch (err) {
      this.deps.log.warn('apply failed', { runId: this.runId, err })
      const open = t !== undefined ? await iso.journalState(t.home, this.runId).catch(() => ({})) : {}
      body = {
        t: 'apply-result',
        req: e.req,
        failure: finalizeFailure(err),
        ...('open' in open && open.open !== undefined ? { interrupted: true as const } : {}),
      }
    }
    await this.enqueue(body)
  }

  /**
   * E2E only: the apply's per-file hook that waits while the hold file exists (see ControllerDeps.e2eApplyHold), and
   * the chaos points `apply:<step>` (armed only by DIM_FACTORY_E2E_CHAOS_KILL).
   */
  #e2eApplyHold(): ((step: ApplyStep) => Promise<void>) | undefined {
    const hold = this.deps.e2eApplyHold
    if (hold === undefined && !chaosArmed()) return undefined
    return async (step) => {
      chaosPoint(`apply:${step}`)
      if (hold === undefined || step !== 'file') return
      while (
        !this.#closed &&
        (await stat(hold).then(
          () => true,
          () => false,
        ))
      )
        await new Promise((r) => setTimeout(r, E2E_HOLD_POLL_MS))
    }
  }

  /** worktree.undoApply under the lease: the applied files back to P (refused when one changed since). */
  async #undoApply(e: EffectOf<'undoApply'>): Promise<void> {
    let body: EngineEventBody
    try {
      const t = this.#finalizeTarget() ?? this.#bareTarget()
      if (t === undefined) throw new DimFactoryError('NOT_FOUND', 'This run has no isolated copy.')
      const iso = this.#iso()
      // Chaos: an undo that finished before Dim Factory closed and could record it (the relaunch's "Undo again"):
      // the journal says it is done, so asking again answers as the first undo would have.
      const js = await iso.journalState(t.home, this.runId).catch(() => ({}))
      if (!('undone' in js && js.undone?.includes(e.token) === true)) await iso.undoApply(t, e.token)
      body = { t: 'undo-apply-result', req: e.req, ok: true }
    } catch (err) {
      const conflict = err instanceof DimFactoryError && err.code === 'CONFLICT'
      body = {
        t: 'undo-apply-result',
        req: e.req,
        ok: false,
        error: errorMessage(err),
        ...(conflict ? { conflict: true as const } : {}),
      }
    }
    await this.enqueue(body)
  }

  /** The worktree without a segment (a run stopped before it changed anything): enough to undo or discard. */
  #bareTarget(): FinalizeTarget | undefined {
    const wt = this.#state.isolation?.worktree
    if (wt === undefined) return undefined
    return {
      home: this.deps.paths.home,
      runId: this.runId,
      folder: this.deps.scope.folder,
      worktree: { path: wt.path, branch: wt.branch, base: wt.base },
      from: wt.base,
      to: wt.base,
      now: this.deps.clock.now,
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
    }
  }

  /**
   * Discard's deletion, once its 10 s are over (the reducer's timer): recorded in the finalize journal, then the
   * worktree removed (links unlinked first, never followed), its branch deleted when it still points at base, and its
   * shadow dropped (cleanup and shadow GC).
   */
  async #removeWorktree(e: EffectOf<'removeWorktree'>): Promise<void> {
    let body: EngineEventBody
    try {
      const t = this.#finalizeTarget() ?? this.#bareTarget()
      if (t === undefined) throw new DimFactoryError('NOT_FOUND', 'This run has no isolated copy.')
      const iso = this.#iso()
      // Chaos: the deletion finished, but Dim Factory closed before it was recorded (the relaunch asks again).
      const js = await iso.journalState(t.home, this.runId).catch(() => ({}))
      if ('removed' in js && js.removed === true) {
        this.#workShadowP = undefined
        await this.enqueue({ t: 'remove-result', req: e.req, ok: true })
        return
      }
      const pending = await iso.discardRun(t, {
        delayMs: 0,
        // The reducer's own timer already waited; the journal's record is written, not armed again.
        timers: { set: () => null, clear: () => undefined },
      })
      chaosPoint('finalize:discard-recorded')
      const r = await iso.completeDiscard(t, pending.undoToken)
      if (r !== null && !r.removed) {
        body = { t: 'remove-result', req: e.req, ok: false, error: r.notes.join(' ') || 'It is still there.' }
      } else {
        this.#workShadowP = undefined
        body = {
          t: 'remove-result',
          req: e.req,
          ok: true,
          ...(r !== null && r.notes.length > 0 ? { notes: r.notes } : {}),
        }
      }
    } catch (err) {
      this.deps.log.warn('worktree removal failed', { runId: this.runId, err })
      body = { t: 'remove-result', req: e.req, ok: false, error: errorMessage(err) }
    }
    await this.enqueue(body)
  }

  // ---- verify rounds ---------------------------------------------------------------------------------------------

  async #trustGrants(): Promise<TrustGrants> {
    const folder = this.deps.scope.folder
    const read = this.deps.verify?.trustGrants
    const grants = await (read !== undefined
      ? read(folder)
      : trustGrantsFor(folder, {
          home: this.deps.paths.home,
          folderScope: { scopeRoot: this.deps.scope.scopeRoot, folderKey: this.deps.scope.folderKey },
        }))
    // An Easy run's project permission covers its own commands while it holds (read again at every check).
    return this.deps.permission?.covers(this.#permitRun(this.#workFolder())) === true
      ? withProjectPermission(grants)
      : grants
  }

  /** The run as the project permission reads it, working in `cwd`. */
  #permitRun(cwd: string): PermitRun {
    return { runId: this.runId, folder: this.deps.scope.folder, cwd, recipe: this.#state.recipe }
  }

  /** A command trusted only by the project permission: logged as one use. */
  #projectUse(label: string): void {
    this.deps.permission?.record({
      folder: this.deps.scope.folder,
      runId: this.runId,
      what: 'command',
      label,
    })
  }

  /**
   * The round's trust check: every enabled `verify.commands[]` entry with its body read now and compared with
   * trust.json (Auto never implies trust; the reducer decides what to ask or skip). Never throws.
   */
  /** What the grounding checks read: the shadow's commits (the run's folder only) and the folder on disk. */
  #groundingIo(): GroundingIo {
    const scan = this.#scanIo()
    const rel = this.#folderRel()
    const prefix = rel === '' ? '' : `${rel}/`
    const scope = rel === '' ? '.' : rel
    return {
      patch: async (from, to) => {
        const text = await scan.patch(from, to)
        // Paths relative to the run's folder, as every other fact of the checks.
        return prefix === '' ? text : text.split(`+++ b/${prefix}`).join('+++ b/')
      },
      changedPaths: (from, to) => scan.changedPaths(from, to),
      files: async (commit) => {
        const shadow = await this.#shadow()
        const r = await shadow.git(['ls-tree', '-r', '-z', '--name-only', commit, '--', scope])
        return r.stdout
          .split('\0')
          .filter((x) => x !== '' && x.startsWith(prefix))
          .map((x) => x.slice(prefix.length))
      },
      fileAt: (commit, path) => scan.fileAt(commit, path),
      onDisk: (path) => {
        try {
          return existsSync(join(this.#workFolder(), path))
        } catch {
          return false
        }
      },
    }
  }

  /**
   * The grounding checks over a pass (grounding/run.ts): its claims against its diff, its tool evidence and the Verify
   * round after it, its imports and new dependencies, and the optional registry lookup and AI judge. A failure goes
   * back as such (the run notes it); exactly one `grounding-result`.
   */
  async #groundingCheck(e: EffectOf<'groundingCheck'>): Promise<void> {
    let body: EngineEventBody
    try {
      const r = await runGrounding(
        this.#groundingIo(),
        {
          step: e.step,
          from: e.from,
          to: e.to,
          finalText: e.finalText,
          plan: e.plan,
          evidence: e.evidence,
          verify: e.verify,
          registryCheck: e.registryCheck,
          judge: e.judge,
          sources: e.sources,
        },
        {
          ...(e.registryCheck ? { registry: this.deps.registryFetcher ?? httpRegistryFetcher() } : {}),
          ...(this.deps.judge !== undefined ? { judge: this.deps.judge } : {}),
        },
      )
      body = { t: 'grounding-result', req: e.req, findings: r.findings, notes: r.notes }
    } catch (err) {
      this.deps.log.warn('grounding check failed', { runId: this.runId, step: e.step, code: errnoCode(err) })
      body = {
        t: 'grounding-result',
        req: e.req,
        findings: [],
        notes: [],
        failure: gitFailure(err, 'snapshot_failed'),
      }
    }
    await this.enqueue(body)
  }

  /**
   * Test-first: the Tests step's files at T1 and at Implement's end (read from the shadow, never the folder), compared
   * by testfirst/guard.ts. A git failure answers `failure` (the run notes that the check could not run).
   */
  async #testsCheck(e: EffectOf<'testsCheck'>): Promise<void> {
    let body: EngineEventBody
    try {
      const shadow = await this.#shadow()
      const present = async (commit: string): Promise<Set<string>> => {
        if (e.paths.length === 0) return new Set()
        const r = await shadow.git(['ls-tree', '-r', '-z', '--name-only', commit, '--', ...e.paths])
        return new Set(r.stdout.split('\0').filter((p) => p !== ''))
      }
      const [before, after] = await Promise.all([present(e.from), present(e.to)])
      const read = async (commit: string, path: string, has: Set<string>): Promise<string | null> => {
        if (!has.has(path)) return null
        const r = await shadow.git(['cat-file', '-p', `${commit}:${path}`])
        return r.stdout
      }
      const files = await Promise.all(
        e.paths.map(async (path) => ({
          path,
          before: await read(e.from, path, before),
          after: await read(e.to, path, after),
        })),
      )
      body = { t: 'tests-check-result', req: e.req, findings: weakenedTests(files) }
    } catch (err) {
      this.deps.log.warn('tests check failed', { runId: this.runId, err })
      body = {
        t: 'tests-check-result',
        req: e.req,
        findings: [],
        failure: gitFailure(err, 'snapshot_failed'),
      }
    }
    await this.enqueue(body)
  }

  async #verifyCheck(e: EffectOf<'verifyCheck'>): Promise<void> {
    let body: EngineEventBody
    try {
      const folder = this.#workFolder()
      const scopeRoot = this.#workRoot()
      const [configured, grants, playtest] = await Promise.all([
        configCommands(this.deps.config.verify.commands, { folder, scopeRoot }),
        this.#trustGrants(),
        playtestCommand(folder, cwdRelOf(scopeRoot, folder) ?? '.'),
      ])
      // A game's playtest.json is played as Dim Factory's own check whenever Verify runs, unless it is configured.
      const commands =
        playtest !== null && !configured.some((c) => isPlaytestArgv(c.run))
          ? [...configured, playtest]
          : configured
      // A round's rows, results and logs are keyed by name: a repeated name becomes `name (2)` (the same names
      // RunConfig.verify.names gave the round's first rows).
      const enabled = commands.filter((c) => c.enabledByDefault)
      const names = uniqueVerifyNames(enabled.map((c) => c.name))
      body = {
        t: 'verify-check-result',
        req: e.req,
        commands: enabled.map((c, i): VerifyCheckCommand => {
          const base = { name: names[i] ?? c.name, argv: [...c.run], cwdRel: c.cwdRel, body: c.body }
          if (c.error !== undefined) return { ...base, trust: 'invalid', reason: c.error }
          const t = trustOf(c, c.body, grants)
          if (t.via === 'project') this.#projectUse(displayArgv(c.run))
          return t.trust === 'changed'
            ? { ...base, trust: 'changed', grantedBody: t.grantedBody ?? null }
            : { ...base, trust: t.trust }
        }),
      }
    } catch (err) {
      this.deps.log.warn('verify trust check failed', { runId: this.runId, step: e.step, err })
      body = {
        t: 'verify-check-result',
        req: e.req,
        commands: [],
        failure: {
          category: 'unknown',
          message: `Dim Factory could not read the verify commands: ${errorMessage(err)}`,
          raw: '',
          classifiedBy: 'app',
          step: e.step,
        },
      }
    }
    await this.enqueue(body)
  }

  /** [Trust for this project]: the command grant (trust.json; the body the user was shown). */
  async #trustGrant(e: EffectOf<'trustGrant'>): Promise<void> {
    let body: EngineEventBody
    try {
      const grant = this.deps.verify?.grant
      if (grant === undefined) throw new Error('trust grants cannot be written here')
      await grant(this.deps.scope.folder, e.command)
      body = { t: 'trust-grant-result', req: e.req, ok: true }
    } catch (err) {
      this.deps.log.warn('verify trust grant failed', { runId: this.runId, err })
      body = { t: 'trust-grant-result', req: e.req, ok: false, error: errorMessage(err) }
    }
    await this.enqueue(body)
  }

  /**
   * A round (src/core/verify runVerifyRound): trust is checked again right before each spawn, children are recorded in
   * procs.json for the relaunch sweep, Stop aborts it (tree kill). Its progress (a command starting or finishing, new
   * output at most every 500 ms) and then exactly one result go back to the reducer.
   */
  async #verifyRound(e: EffectOf<'verify'>): Promise<void> {
    const d = this.deps
    const ac = new AbortController()
    this.#verifyRounds.set(e.req, ac)
    let outputTimer: ReturnType<typeof setTimeout> | undefined
    const announceOutput = (): void => {
      if (outputTimer !== undefined) return
      outputTimer = setTimeout(() => {
        outputTimer = undefined
        void this.enqueue({ t: 'verify-progress', req: e.req, output: true })
      }, VERIFY_OUTPUT_EVERY_MS)
      outputTimer.unref()
    }
    const onOutput = (ev: VerifyOutputEvent): void => {
      if (ev.type === 'line') announceOutput()
      else if (ev.type === 'start') void this.enqueue({ t: 'verify-progress', req: e.req, running: ev.name })
      else void this.enqueue({ t: 'verify-progress', req: e.req, done: ev.result })
    }
    const timeouts = new Map(d.config.verify.commands.map((c) => [c.name, c.timeoutMs]))
    const commands = e.commands.map((c): VerifyRoundCommand => {
      const timeoutMs = timeouts.get(c.name)
      return {
        name: c.name,
        argv: [...c.argv],
        cwdRel: c.cwdRel,
        run: c.run,
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }
    })
    let body: EngineEventBody
    try {
      const v = d.verify
      const deps: VerifyDeps = {
        paths: d.paths,
        grants: () => this.#trustGrants(),
        procTable: d.procTable,
        ...(v?.pathEnv !== undefined ? { pathEnv: v.pathEnv } : {}),
        ...(v?.env !== undefined ? { env: v.env } : {}),
        ...(v?.playtest !== undefined ? { playtest: v.playtest } : {}),
        ...(v?.pageload !== undefined ? { pageload: v.pageload } : {}),
      }
      const introduced = await this.#introducedModules(e.step)
      const r = await (v?.runRound ?? runVerifyRound)(deps, {
        runId: this.runId,
        round: e.step,
        folder: this.#workFolder(),
        scopeRoot: this.#workRoot(),
        commands,
        // A baseline wants every command's state, so it never stops at the first failure.
        failFast: e.step === 'verify:0' ? false : d.config.verify.failFast,
        onOutput,
        // Announce once the live file holds the output (a burst before a quiet spell is shown too).
        onOutputWritten: announceOutput,
        signal: ac.signal,
        ...(introduced !== undefined ? { introduced: (name: string) => introduced.has(name) } : {}),
      })
      body = {
        t: 'verify-result',
        req: e.req,
        results: r.results,
        // A command already failing before the run (verify:0) is a [should] (`preexisting`).
        findings: verifyFindings(r.results, {
          round: e.step === 'verify:2' ? 2 : 1,
          ...(this.#state.isolation?.baseline !== undefined
            ? { baseline: this.#state.isolation.baseline }
            : {}),
        }),
        ...(r.aborted === true ? { aborted: true } : {}),
      }
    } catch (err) {
      d.log.warn('verify round failed', { runId: this.runId, step: e.step, err })
      body = {
        t: 'verify-result',
        req: e.req,
        results: [],
        findings: [],
        failure: {
          category: 'unknown',
          message: errorMessage(err),
          raw: '',
          classifiedBy: 'app',
          step: e.step,
        },
      }
    } finally {
      if (outputTimer !== undefined) clearTimeout(outputTimer)
      this.#verifyRounds.delete(e.req)
    }
    await this.enqueue(body)
  }

  /**
   * The modules the run's own added lines import, for verify:1 and verify:2 (the run's base to the pass's end): a
   * missing one of them is the code's failure (verify/classify.ts), never an environment problem. Undefined when it
   * cannot be read (the old rule applies).
   */
  async #introducedModules(round: string): Promise<Set<string> | undefined> {
    if (round !== 'verify:1' && round !== 'verify:2') return undefined
    const s = this.#state
    const base = runBaseSnap(s)
    const end = round === 'verify:2' ? s.steps.fix.endSnap : s.steps.implement.endSnap
    if (base === undefined || end === undefined) return undefined
    try {
      const patch = await this.#groundingIo().patch(base.commit, end.commit)
      return importedNames(addedLinesByFile(patch))
    } catch {
      return undefined
    }
  }

  #stopReason(step: AgentStep): StopReason {
    const st = this.#state.steps[step]
    if (this.#state.stop !== undefined) return 'user'
    if (st.pause === 'interrupted-by-quit') return 'shutdown'
    // Context health's loop stop ended this spawn (its exit classifies as runaway_loop, not a timeout).
    const stopped = st.reactions?.loop?.stoppedSpawn
    if (stopped !== undefined && stopped === st.proc?.spawnNo) return 'loop'
    return 'timeout'
  }

  async #hardKill(ap: ActiveProc): Promise<void> {
    const stopping = ap.adapter.stop(ap.handle, this.#stopReason(ap.step)).catch(() => undefined)
    if (ap.pid !== undefined && ap.pid > 0 && !ap.exited) {
      await killTree(ap.pid, ap.spawnAt !== undefined ? { spawnAt: ap.spawnAt } : {}).catch(() => undefined)
    }
    await stopping
  }

  // ---- preflight / snapshots --------------------------------------------------------------------------------

  async #preflight(e: EffectOf<'preflight'>): Promise<void> {
    // R10: Fix's session is decided once this preflight is answered; the facts it needs from the adapter go
    // in first, as an event, so the reducer decides without awaiting anything.
    if (e.mode === 'passBoundary' && e.step === 'fix') {
      const check = await this.#fixSessionCheck()
      if (check !== undefined) await this.enqueue({ t: 'session-check', step: 'fix', check })
    }
    // Continuity: Implement's session (Plan's, or fresh) is decided the same way, from the same facts.
    if (e.mode === 'passBoundary' && e.step === 'implement') {
      const check = await this.#implementSessionCheck()
      if (check !== undefined) await this.enqueue({ t: 'session-check', step: 'implement', check })
    }
    let report: PreflightReport
    try {
      report = await this.deps.preflight(e.mode, {
        runId: this.runId,
        folder: this.deps.scope.folder,
        config: this.deps.config,
        // The Tests step is checked as the Implement pass it runs as (Clarify as Plan, the re-check as its pass).
        ...(e.mode === 'passBoundary' ? { pass: configPassOf(e.step, this.#state.config.passes) } : {}),
      })
    } catch (err) {
      const at = this.deps.clock.now()
      report = {
        mode: e.mode,
        ok: false,
        blocking: [
          {
            id: 'app.preflight',
            scope: 'app',
            status: 'fail',
            blocking: true,
            category: 'unknown',
            title: 'Preflight could not run',
            detail: err instanceof Error ? err.message : String(err),
            recovery: [],
            at,
            ttlMs: 0,
          },
        ],
        warnings: [],
        info: [],
      }
    }
    await this.enqueue({ t: 'preflight-result', req: e.req, report })
  }

  /** Append a snapshot to snapshots.json (the run's own record; the shadow ref holds the commits). */
  async #recordSnapshot(rec: SnapshotRecord): Promise<void> {
    this.#snapshots.push(rec)
    try {
      await this.deps.store.writeJson('snapshots', { snapshots: this.#snapshots })
    } catch (err) {
      this.deps.log.error('snapshots.json write failed', { runId: this.runId, err })
    }
  }

  /** P15: an end snapshot's result waits for its end-of-pass check (answered first, see #reconcile). */
  async #afterEndCheck(step: AgentStep | undefined): Promise<void> {
    if (step === undefined) return
    const check = this.#endChecks.get(step)
    if (check !== undefined) {
      // Bounded: a check that never ran (an effect that failed to start) must not hold the snapshot forever.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        check.promise,
        new Promise<void>((r) => {
          timer = setTimeout(r, END_CHECK_WAIT_MS)
          timer.unref()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (this.#endChecks.get(step) === check) this.#endChecks.delete(step)
    }
  }

  async #snapshot(e: EffectOf<'snapshot'>): Promise<void> {
    const endStep = endSnapshotStep(e)
    const end = endStep !== undefined ? this.#endSnaps.get(endStep) : undefined
    // Where HEAD is at the run's start (the run's expected HEAD for reconcile). Reads only.
    const headP: Promise<GitHead | undefined> | undefined =
      e.label === 'run-start' && this.deps.scope.isRepo
        ? readHead(this.#workRoot()).then(
            (h) => ({ ref: h.ref, commit: h.commit }),
            () => undefined,
          )
        : undefined
    let rec: SnapshotRecord
    let shadow: Shadow
    try {
      shadow = await this.#shadow()
      if (endStep !== undefined && e.label !== 'deploy-end') await this.#guardrailsAtEnd(shadow, endStep)
      rec = await shadow.snapshot(this.runId, e.label)
    } catch (err) {
      this.deps.log.warn('snapshot failed', { runId: this.runId, label: e.label, err })
      end?.resolve(null)
      await this.#afterEndCheck(endStep)
      await this.enqueue({ t: 'snapshot-failed', req: e.req, failure: snapshotFailure(err, e.step) })
      return
    }
    await this.#recordSnapshot(rec)
    end?.resolve(rec)
    if (rec.warnings.length > 0) this.deps.log.info('snapshot notes', { label: e.label, notes: rec.warnings })
    if (e.label === 'S1') await this.#afterImplementSnapshot(shadow, rec)
    if (e.label === 'S2') await this.#afterFixSnapshot(shadow, rec)
    if (e.label === 'deploy-end') await this.#afterDeploySnapshot(shadow, rec)
    const warnings: string[] = []
    if (rec.unreadable.length > 0) {
      warnings.push(
        `${rec.unreadable.length} file${rec.unreadable.length === 1 ? '' : 's'} could not be read for the ` +
          `${e.label} snapshot: ${rec.unreadable.slice(0, 5).join(', ')}${rec.unreadable.length > 5 ? ', …' : ''}`,
      )
    }
    const nested = rec.nested ?? []
    if (nested.length > 0) {
      const names = nested.slice(0, 5).map((n) => `${n.path}/`)
      warnings.push(
        `Changes inside ${names.join(', ')}${nested.length > 5 ? ', …' : ''} (a separate git repositor` +
          `${nested.length === 1 ? 'y' : 'ies'}) are not in Dim Factory's snapshots: they do not show in diffs and ` +
          'cannot be undone from Dim Factory.',
      )
    }
    // Links to folders (junctions, symbolic links) are left out of every snapshot; the run says which.
    const linksNote = linksLeftOutNote(rec.links ?? [])
    if (linksNote !== undefined) warnings.push(linksNote)
    const nestedKey = nestedReposKey(rec)
    const head = headP !== undefined ? await headP : undefined
    let changed: string[] | undefined
    const fromTree = Object.values(this.#state.snapshots).find((x) => x?.commit === e.diffFrom)?.tree
    if (e.diffFrom !== undefined && fromTree === rec.tree) changed = []
    else if (e.diffFrom !== undefined) {
      try {
        const set = new Set<string>()
        for (const c of await shadow.changes(e.diffFrom, rec.commit)) {
          set.add(c.path)
          if (c.oldPath !== undefined) set.add(c.oldPath)
        }
        changed = [...set].sort().slice(0, CHANGED_PATHS_MAX)
      } catch (err) {
        this.deps.log.warn('changed paths failed', { runId: this.runId, label: e.label, err })
      }
    }
    await this.#afterEndCheck(endStep)
    await this.enqueue({
      t: 'snapshot-done',
      req: e.req,
      commit: rec.commit,
      tree: rec.tree,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(nestedKey !== undefined ? { nested: nestedKey } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(changed !== undefined ? { changed } : {}),
    })
  }

  // ---- reconcile, run branch, revert ---------------------------------------------------------------------------

  /**
   * reconcile(<boundary>) over git/reconcile.ts. P15's check (`awaitEnd`) compares the end snapshot itself (no
   * external edits by construction; git state and mass deletion against the pass's start) and is answered before that
   * snapshot's result. A check that cannot read git becomes a note: the snapshots' own hard rule still holds.
   */
  async #reconcile(e: EffectOf<'reconcile'>): Promise<void> {
    const step = e.step !== undefined && isAgentStep(e.step) ? e.step : undefined
    const awaitEnd = e.input.awaitEnd === true && step !== undefined
    const check = awaitEnd ? this.#endChecks.get(step) : undefined
    const end = awaitEnd ? this.#endSnaps.get(step) : undefined
    let result: ReconcileResult
    try {
      const shadow = await this.#shadow()
      let last = e.input.last
      let nowTree: string | undefined
      if (end !== undefined) {
        const rec = await end.promise
        if (rec !== null) {
          // The end snapshot is both sides: no external edits by construction, and no diff to run for them.
          last = rec.tree
          nowTree = rec.tree
        }
        if (this.#endSnaps.get(step as AgentStep) === end) this.#endSnaps.delete(step as AgentStep)
      }
      if (last === undefined) {
        const t = await shadow.treeNow()
        last = t.tree
        nowTree = t.tree
      }
      result = await runReconcile({
        shadow,
        boundary: e.boundary,
        input: e.input,
        last,
        ...(nowTree !== undefined ? { nowTree } : {}),
        os: osFamily(this.deps.platform ?? process.platform),
      })
    } catch (err) {
      this.deps.log.warn('reconcile failed', { runId: this.runId, boundary: e.boundary, err })
      const why = err instanceof Error ? err.message : String(err)
      result = {
        verdict: 'info',
        notes: [`Dim Factory could not check the folder ${boundaryText(e.boundary, e.step)}: ${why}`],
        promptNotes: [],
      }
    }
    if (step !== undefined && e.boundary === 'end-of-pass') {
      const asks = this.#guardrailAsks.get(step) ?? []
      this.#guardrailAsks.delete(step)
      result = withGuardrailAsks(result, asks)
    }
    try {
      await this.enqueue({ t: 'reconcile-result', req: e.req, result })
    } finally {
      check?.resolve()
    }
  }

  /**
   * The rules on what a pass changed, before its end snapshot: a change a rule undoes is put back here, so it never
   * reaches a diff or reads as an edit from outside the run. A check that cannot run reports nothing and says so in the
   * log; the end snapshot still goes ahead, because stopping every run over a read failure protects nothing.
   */
  async #guardrailsAtEnd(shadow: Shadow, step: AgentStep): Promise<void> {
    const g = this.deps.config.guardrails
    const start = this.#state.steps[step].startSnap?.commit
    if (start === undefined) return
    try {
      const now = await shadow.treeNow()
      const check = await checkPassChanges(
        shadow,
        start,
        now.tree,
        rulesInForce(g),
        g.allowAgentSettings === true,
      )
      if (check.findings.length === 0) return
      let undone: string[] = []
      if (check.undoPaths.length > 0) {
        const r = await revertTo(shadow, start, { runId: this.runId, paths: check.undoPaths })
        if (r.ok) undone = check.undoPaths
        else this.deps.log.warn('guardrail undo refused', { runId: this.runId, why: r.message })
      }
      const undoneSet = new Set(undone)
      // A rule whose undo was refused cannot keep its promise: the run stops rather than carry the change on.
      const findings = check.findings.map((f) =>
        f.onBreak === 'undo' && !undoneSet.has(f.subject) ? { ...f, onBreak: 'stop' as const } : f,
      )
      const asks = findings.filter((f) => f.onBreak === 'ask')
      if (asks.length > 0) this.#guardrailAsks.set(step, asks)
      await this.enqueue({ t: 'guardrail-findings', step, findings, undone })
    } catch (err) {
      this.deps.log.warn('guardrail check failed', { runId: this.runId, step, err })
    }
  }

  /** A command a pass reported running, against the forbidden commands. The Deploy step is asked to publish, so presets leave it alone. */
  #guardrailsOnCommand(step: StepKey, command: string): void {
    const g = this.deps.config.guardrails
    const rules = step === 'deploy' ? g.rules : rulesInForce(g)
    const findings = checkCommands(rules, [command]).filter((f) => {
      const key = `${step}|${f.rule}|${f.subject}`
      if (this.#guardrailCommands.has(key)) return false
      this.#guardrailCommands.add(key)
      return true
    })
    if (findings.length === 0) return
    const asks = findings.filter((f) => f.onBreak === 'ask')
    if (asks.length > 0 && isAgentStep(step)) {
      this.#guardrailAsks.set(step, [...(this.#guardrailAsks.get(step) ?? []), ...asks])
    }
    void this.enqueue({ t: 'guardrail-findings', step, findings, undone: [] })
  }

  /**
   * R5: the run branch (git/branch.ts prepareRunBranch), user hooks off (`<home>/empty-hooks`). Write-ahead: the
   * branch about to be made reaches run.json (`branch-intent`) before its ref is written, so a crash in between
   * leaves a branch the run adopts (a pending one is settled first). `settle`: a relaunch only settles it.
   */
  async #branch(e: EffectOf<'branch'>): Promise<void> {
    let body: EngineEventBody
    const opts = {
      hooksPath: this.deps.paths.emptyHooksDir,
      os: osFamily(this.deps.platform ?? process.platform),
    }
    try {
      const shadow = await this.#shadow()
      if (e.settle === true && e.pending !== undefined) {
        const r = await settlePendingBranch(shadow.scope.repo, e.pending, { ...opts, finish: false })
        body =
          r.state === 'adopted'
            ? { t: 'branch-result', req: e.req, branch: r.branch, notes: r.notes }
            : r.state === 'kept'
              ? { t: 'branch-result', req: e.req, leftover: e.pending }
              : { t: 'branch-result', req: e.req, ...(r.notes.length > 0 ? { notes: r.notes } : {}) }
      } else {
        const r = await prepareRunBranch(
          shadow.scope.repo,
          {
            prefix: this.deps.config.isolation.branchPrefix,
            date: new Date(this.deps.clock.now()),
            task: this.#state.task,
          },
          {
            ...opts,
            ...(e.pending !== undefined ? { pending: e.pending } : {}),
            onIntent: async (branch) => {
              await this.enqueue({ t: 'branch-intent', req: e.req, branch })
              chaosPoint('branch:intent')
              // Not recorded (the run closed meanwhile): make nothing a relaunch would not know about.
              if (this.#closed) throw new Error('The run closed before its branch was made.')
            },
          },
        )
        body = r.ok
          ? { t: 'branch-result', req: e.req, branch: r.branch, notes: r.notes }
          : {
              t: 'branch-result',
              req: e.req,
              blocked: branchBlockedCard(r.blockers),
              ...(r.leftover !== undefined ? { leftover: r.leftover } : {}),
            }
      }
    } catch (err) {
      this.deps.log.warn('run branch failed', { runId: this.runId, err })
      body = { t: 'branch-result', req: e.req, failure: { ...gitFailure(err), step: 'implement' } }
    }
    await this.enqueue(body)
  }

  /**
   * A revert (git/revert.ts revertTo): a `pre-revert` snapshot first (the undo point), then the paths written from
   * the target through a scratch index. Write-ahead: once the undo point is taken and the paths are known, it is
   * appended to snapshots.json and the reducer records the revert (`revert-started`, persisted) before any file is
   * written. An undo carries `expect`: refused (CONFLICT, nothing written) when a path changed since the revert. The
   * reducer checked that nothing holds the folder.
   */
  async #revert(e: EffectOf<'revert'>): Promise<Result<RevertResult>> {
    let body: EngineEventBody
    let res: Result<RevertResult>
    try {
      const shadow = await this.#shadow()
      const paths = await revertPaths(shadow, e)
      let recorded = false
      const r = await revertTo(shadow, e.to, {
        runId: this.runId,
        ...(paths !== undefined ? { paths } : {}),
        ...(e.expect !== undefined ? { expect: e.expect } : {}),
        onPlanned: async (p) => {
          await this.#recordSnapshot(p.preRevert)
          recorded = true
          await this.enqueue({
            t: 'revert-started',
            req: e.req,
            preRevert: p.preRevert.commit,
            paths: p.paths,
          })
          chaosPoint('revert:planned')
          // Not recorded (the run closed meanwhile): write nothing a relaunch could not undo.
          if (this.#closed) throw new Error('The run closed before the revert started.')
        },
      })
      if (!r.ok) {
        if (r.refused === 'conflict') {
          body = { t: 'revert-result', req: e.req, conflict: r.message }
          res = fail('CONFLICT', r.message)
        } else {
          body = { t: 'revert-result', req: e.req, busy: r.message }
          res = fail('FOLDER_BUSY', r.message)
        }
      } else {
        const o = r.outcome
        if (!recorded) await this.#recordSnapshot(o.preRevert)
        body = {
          t: 'revert-result',
          req: e.req,
          outcome: {
            preRevert: o.preRevert.commit,
            restored: o.restored,
            deleted: o.deleted,
            skipped: o.skipped,
          },
        }
        res = ok({
          undoToken: e.undoToken ?? e.token,
          restored: o.restored,
          deleted: o.deleted,
          skipped: o.skipped,
        })
      }
    } catch (err) {
      this.deps.log.warn('revert failed', { runId: this.runId, why: e.why, err })
      const failure = gitFailure(err, 'snapshot_failed')
      body = { t: 'revert-result', req: e.req, failure }
      res = fail('GIT', `The revert failed: ${failure.message}`)
    }
    await this.enqueue(body)
    return res
  }

  /** S1: persist `diffs/S0..S1.patch` and report the final files-changed numbers. */
  async #afterImplementSnapshot(shadow: Shadow, s1: SnapshotRecord): Promise<void> {
    // The run's base (Test-first: the Tests step's start), so the diff and its numbers include the tests.
    const s0 = runBaseSnap(this.#state)
    if (s0 === undefined) return
    try {
      const [patch, changes] = await Promise.all([
        shadow.patch(s0.commit, s1.commit),
        shadow.changes(s0.commit, s1.commit),
      ])
      await writePromptFile(this.deps.store.paths.diffPatch('S0..S1'), patch.text)
      let added = 0
      let deleted = 0
      for (const c of changes) {
        added += c.added ?? 0
        deleted += c.deleted ?? 0
      }
      await this.enqueue({ t: 'diff-stats', files: changes.length, added, deleted, live: false })
    } catch (err) {
      this.deps.log.warn('S0..S1 diff failed', { runId: this.runId, err })
    }
  }

  /**
   * S2: persist the Fix segment `diffs/F0..S2.patch` and the combined `diffs/S0..S2.patch`, report the run's final
   * files-changed numbers (S0..S2), and add Fix's report (`F<n> fixed|skipped|disputed`) to findings.json.
   */
  async #afterFixSnapshot(shadow: Shadow, s2: SnapshotRecord): Promise<void> {
    const s = this.#state
    const s0 = runBaseSnap(s)
    const f0 = s.steps.fix.startSnap ?? s.snapshots['fix-start']
    const paths = this.deps.store.paths
    try {
      if (f0 !== undefined) {
        const fixPatch = await shadow.patch(f0.commit, s2.commit)
        await writePromptFile(paths.diffPatch('F0..S2'), fixPatch.text)
      }
      if (s0 !== undefined) {
        const [patch, changes] = await Promise.all([
          shadow.patch(s0.commit, s2.commit),
          shadow.changes(s0.commit, s2.commit),
        ])
        await writePromptFile(paths.diffPatch('S0..S2'), patch.text)
        let added = 0
        let deleted = 0
        for (const c of changes) {
          added += c.added ?? 0
          deleted += c.deleted ?? 0
        }
        await this.enqueue({ t: 'diff-stats', files: changes.length, added, deleted, live: false })
      }
    } catch (err) {
      this.deps.log.warn('S2 diffs failed', { runId: this.runId, err })
    }
    const report = s.steps.fix.result
    const doc = report !== undefined ? (this.#findingsDoc ?? (await this.#readFindingsDoc())) : undefined
    if (doc !== undefined && report !== undefined) {
      const byId = fixReportById(doc.findings, parseFixReport(report))
      if (Object.keys(byId).length > 0) await this.#writeFindings({ ...doc, fixReport: byId })
    }
  }

  /**
   * deploy-end: persist the Deploy segment `diffs/deploy-start..deploy-end.patch` and the combined
   * `diffs/S0..deploy-end.patch`, and report the run's final files-changed numbers (the run's base to deploy-end).
   */
  async #afterDeploySnapshot(shadow: Shadow, d1: SnapshotRecord): Promise<void> {
    const s = this.#state
    const d0 = s.steps.deploy.startSnap ?? s.snapshots['deploy-start']
    const s0 = runBaseSnap(s)
    const paths = this.deps.store.paths
    try {
      if (d0 !== undefined) {
        const patch = await shadow.patch(d0.commit, d1.commit)
        await writePromptFile(paths.diffPatch('deploy-start..deploy-end'), patch.text)
      }
      if (s0 !== undefined) {
        const [patch, changes] = await Promise.all([
          shadow.patch(s0.commit, d1.commit),
          shadow.changes(s0.commit, d1.commit),
        ])
        await writePromptFile(paths.diffPatch('S0..deploy-end'), patch.text)
        let added = 0
        let deleted = 0
        for (const c of changes) {
          added += c.added ?? 0
          deleted += c.deleted ?? 0
        }
        await this.enqueue({ t: 'diff-stats', files: changes.length, added, deleted, live: false })
      }
    } catch (err) {
      this.deps.log.warn('deploy-end diffs failed', { runId: this.runId, err })
    }
  }

  /**
   * The Deploy step's plan over the run's work folder (its isolated copy once it has one): the class, the target and
   * the config files it lacks (deploy/report.ts planDeploy through the core's packs and the run's brief). Reads only.
   */
  async #deployPlan(e: EffectOf<'deployPlan'>): Promise<void> {
    let body: EngineEventBody
    try {
      const folder = this.#workFolder()
      const plan =
        this.deps.deploy !== undefined
          ? await this.deps.deploy.plan({ folder, target: e.target, state: this.#state })
          : await planDeploy({
              folder,
              packs: readBuiltinPacks().map((v) => v.pack),
              task: this.#state.task,
              target: e.target,
            })
      body = { t: 'deploy-plan-result', req: e.req, plan }
    } catch (err) {
      this.deps.log.warn('deploy plan failed', { runId: this.runId, err })
      body = {
        t: 'deploy-plan-result',
        req: e.req,
        failure: {
          category: 'unknown',
          message: err instanceof Error ? err.message : String(err),
          raw: '',
          classifiedBy: 'app',
          step: 'deploy',
        },
      }
    }
    await this.enqueue(body)
  }

  // ---- spawn / exit -----------------------------------------------------------------------------------------

  /** A spawn that never started: its failure as a fatal `error`, then the one `exit` every spawn owes. */
  #synthFail(e: EffectOf<'spawn'>, failure: Failure): void {
    void this.enqueue({
      t: 'adapter',
      step: e.step,
      spawnNo: e.spawnNo,
      ev: {
        type: 'error',
        message: failure.message,
        raw: failure.raw,
        fatal: true,
        category: failure.category,
      },
    })
    void this.enqueue({ t: 'exit', step: e.step, spawnNo: e.spawnNo, code: null, signal: null, ranMs: 0 })
  }

  /** A pending spawn (prompt still being prepared) is stopped before it starts: it will only owe its `exit`. */
  #cancelPending(step: AgentStep, spawnNo: number): boolean {
    const p = this.#pendingSpawns.get(step)
    if (p === undefined || p.spawnNo !== spawnNo) return false
    p.cancelled = true
    return true
  }

  #spawn(e: EffectOf<'spawn'>): void {
    const adapter = this.deps.adapters.get(e.vendor)
    if (adapter === undefined) {
      this.#synthFail(e, {
        category: 'capability_missing',
        message: `No adapter for vendor "${e.vendor}" in this build.`,
        raw: '',
        classifiedBy: 'app',
      })
      return
    }
    const range = promptDiffRange(this.#state, e)
    // A vendor that asks for folder trust (Gemini) starts once the folder's grant is read (trust.json).
    const trust = needsFolderTrust(adapter.id)
    // Explain's prompt needs the files the run changed and how to run the folder (read before it starts).
    // A fresh restart after compactions carries the files changed so far in its {{state}} note (read before it starts).
    const restart = e.launch.restart !== undefined
    if (range === undefined && !trust && e.step !== 'explain' && !restart) {
      this.#start(e, adapter, {})
      return
    }
    // {{diff}} needs git: the process starts once the prompt patch is ready (a Stop meanwhile cancels it).
    const pending: PendingSpawn = { spawnNo: e.spawnNo, cancelled: false }
    this.#pendingSpawns.set(e.step, pending)
    this.#track(this.#prepareAndStart(e, adapter, range, pending))
  }

  async #prepareAndStart(
    e: EffectOf<'spawn'>,
    adapter: Adapter,
    range: ReturnType<typeof promptDiffRange>,
    pending: PendingSpawn,
  ): Promise<void> {
    let inputs: PromptInputs | undefined = range === undefined ? {} : undefined
    let failure: Failure | undefined
    try {
      if (range !== undefined) inputs = { diff: await this.#promptDiff(e, range) }
      // Run & Preview: Implement and Fix are asked for a RUN.md when the folder shows no way to run it.
      if (inputs !== undefined && (e.step === 'implement' || e.step === 'fix')) {
        inputs.runHint = await runInstructionsHint(this.#workFolder())
      }
      // Explain: the files the run changed (names and counts) and how to run the result.
      if (inputs !== undefined && e.step === 'explain' && e.launch.resume === undefined) {
        inputs.explain = await gatherExplainInputs(this.#workFolder(), () => this.#runChanges())
      }
      // Context health's fresh restart: the files the run changed up to where the restarted attempt ended.
      if (inputs !== undefined && e.launch.restart !== undefined)
        inputs.changedFiles = await this.#changedSoFar(e.step)
    } catch (err) {
      this.deps.log.warn('prompt diff failed', { runId: this.runId, step: e.step, err })
      failure = {
        ...snapshotFailure(err, e.step),
        message: `Dim Factory could not prepare the ${range?.label ?? 'prompt'} diff for ${e.step}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const trustFolder = needsFolderTrust(adapter.id) ? await this.#folderTrusted(adapter.id) : false
    if (this.#pendingSpawns.get(e.step) === pending) this.#pendingSpawns.delete(e.step)
    if (pending.cancelled) {
      void this.enqueue({ t: 'exit', step: e.step, spawnNo: e.spawnNo, code: null, signal: null, ranMs: 0 })
      return
    }
    if (failure !== undefined || inputs === undefined) {
      this.#synthFail(
        e,
        failure ?? { category: 'snapshot_failed', message: 'No diff.', raw: '', classifiedBy: 'app' },
      )
      return
    }
    this.#start(e, adapter, inputs, { trustFolder })
  }

  /**
   * Gemini launch: whether the run's folder holds a trust.json `vendorFolder` grant for `vendor`
   * (an isolated run's worktree is the user's folder's copy: the folder's grant covers it). Never throws: an unreadable
   * trust.json grants nothing.
   */
  async #folderTrusted(vendor: string): Promise<boolean> {
    try {
      return isVendorFolderGranted(await this.#trustGrants(), vendor)
    } catch (err) {
      this.deps.log.warn('trust grants could not be read', { runId: this.runId, vendor, err })
      return false
    }
  }

  /**
   * `{{diff}}` (the prompt patch): `shadow.patch(from, to, {forPrompt})` capped at
   * min(150 KB, 0.25 × contextWindow × 3.5), shrunk so the whole prompt stays under 60% of the context window
   * and halved for each fresh retry after context_exceeded. Unknown context window: 200,000
   * tokens.
   */
  async #promptDiff(
    e: EffectOf<'spawn'>,
    range: NonNullable<ReturnType<typeof promptDiffRange>>,
  ): Promise<string> {
    const { from, to } = range
    if (from === undefined || to === undefined) return missingDiffText(range.label)
    const window = this.deps.contextWindow?.(e.vendor, e.model) ?? DEFAULT_CONTEXT_WINDOW
    let otherBytes = 0
    try {
      otherBytes = Buffer.byteLength(
        buildPrompt(this.#state, this.deps.config, e, { ...this.#promptExtras(), diff: '' }).text,
        'utf8',
      )
    } catch {
      // The template error surfaces when the real prompt is built (config_invalid).
    }
    const cap = promptDiffCap(window, otherBytes, e.launch.diffTrim)
    const key = `${from.commit}..${to.commit}|${cap}`
    let p = this.#promptDiffs.get(key)
    if (p === undefined) {
      const made = this.#shadow()
        .then((sh) => sh.patch(from.commit, to.commit, { forPrompt: true, maxBytes: cap }))
        .then((r) => r.text)
      made.catch(() => {
        if (this.#promptDiffs.get(key) === made) this.#promptDiffs.delete(key)
      })
      this.#promptDiffs.set(key, made)
      p = made
    }
    const text = await p
    return text.trim() === '' ? '(no file changes)' : text
  }

  /** The files the run changed, its base to its latest end snapshot (Explain's `{{files}}`); null without both. */
  async #runChanges(): Promise<FileChange[] | null> {
    const r = explainChangeRange(this.#state)
    if (r === undefined) return null
    const sh = await this.#shadow()
    return sh.changes(r.from, r.to)
  }

  /** The paths the run changed from its base to where step's last attempt ended (best effort: none on a git error). */
  async #changedSoFar(step: AgentStep): Promise<string[]> {
    const s = this.#state
    const base = runBaseSnap(s)
    const end = s.steps[step].attemptEnd
    if (base === undefined || end === undefined) return []
    try {
      const sh = await this.#shadow()
      return (await sh.changes(base.commit, end.commit)).map((c) => c.path)
    } catch {
      return []
    }
  }

  /** Prompt inputs every spawn shares: Test-first's template and the optional steps' templates. */
  #promptExtras(): PromptInputs {
    const t = this.deps.testsTemplate
    const st = this.deps.stepTemplates
    return {
      ...(t !== undefined ? { testsTemplate: t } : {}),
      ...(st !== undefined ? { stepTemplates: st } : {}),
    }
  }

  #start(
    e: EffectOf<'spawn'>,
    adapter: Adapter,
    inputs: PromptInputs,
    o: { trustFolder?: boolean } = {},
  ): void {
    const d = this.deps
    let prompt: string
    try {
      const built = buildPrompt(this.#state, d.config, e, { ...this.#promptExtras(), ...inputs })
      prompt = built.text
      if (built.warnings.length > 0)
        d.log.warn('prompt warnings', { runId: this.runId, step: e.step, warnings: built.warnings })
    } catch (err) {
      this.#synthFail(e, {
        category: 'config_invalid',
        message: err instanceof Error ? err.message : String(err),
        raw: '',
        classifiedBy: 'app',
      })
      return
    }
    const paths = d.store.paths
    this.#track(writePromptFile(paths.prompt(e.step, e.spawnNo), prompt))
    const raw = new RawLog(paths.raw(e.step, e.spawnNo))
    const cwd = this.#workFolder()
    const start = startOptionsFor({
      runId: this.runId,
      cwd,
      config: d.config,
      state: this.#state,
      spawn: e,
      prompt,
      tap: (dir, line) => raw.write(dir, line),
      // A vendor that assigns its own session id (Codex, ACP) reports it before its first turn.
      preassignSessionId: d.capabilities?.(e.vendor)?.preassignSessionId ?? true,
      onSession: (sessionId) => this.#sessionAssigned(e.step, e.spawnNo, sessionId, cwd),
      ...(o.trustFolder === true ? { trustFolder: true } : {}),
      scratchDir: scratchDirOf(paths.dir),
    })
    // Easy mode's project permission, checked on every ask of the pass (a revoke takes effect at once).
    const permit = d.permission?.permitFor(this.#permitRun(cwd))
    if (permit !== undefined) start.permit = permit
    // The context meter's breakdown (Claude get_context_usage, summary detail: no model call), at start and end.
    if (d.contextBreakdown !== false) start.contextBreakdown = true
    // The post-compaction reminder (context health, off by default): Implement and Fix only.
    if ((e.step === 'implement' || e.step === 'fix') && contextHealthOf(this.#state).reminder) {
      const step = e.step
      start.compactionReminder = () => this.#compactionReminder(step)
    }
    const g = this.deps.config.guardrails
    start.guardrails = {
      // The Deploy step is asked to publish, so presets leave it alone; your own rules still hold there.
      rules: e.step === 'deploy' ? g.rules : rulesInForce(g),
      allowAgentSettings: g.allowAgentSettings === true,
    }
    let handle: RunHandle
    try {
      handle = adapter.start(start)
    } catch (err) {
      void raw.close()
      this.#synthFail(e, {
        category: 'unknown',
        message: `Could not start ${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        raw: '',
        classifiedBy: 'heuristic',
      })
      return
    }
    const ap: ActiveProc = {
      step: e.step,
      spawnNo: e.spawnNo,
      handle,
      adapter,
      start,
      raw,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      exited: false,
    }
    this.#procs.set(e.step, ap)
    // Before the adapter's first event: what the context meter and health need to know of this spawn's setup.
    void this.enqueue({
      t: 'context-facts',
      step: e.step,
      spawnNo: e.spawnNo,
      facts: this.#contextFacts(e, start, prompt, cwd),
    })
    handle.onEvent((ev) => {
      void this.enqueue({ t: 'adapter', step: e.step, spawnNo: e.spawnNo, ev })
      if (ev.type === 'tool' && ev.phase === 'end' && this.#liveOn) this.#scheduleLivePoll(750)
    })
    handle.onSignal((signal) => {
      if (signal.type === 'shell-command') this.#guardrailsOnCommand(e.step, signal.command)
      if (signal.type === 'guardrail-blocked') {
        void this.enqueue({
          t: 'guardrail-findings',
          step: e.step,
          findings: [signal.finding],
          undone: [],
          blocked: true,
        })
      }
      void this.enqueue({ t: 'signal', step: e.step, spawnNo: e.spawnNo, signal })
    })
    this.#track(handle.exited.then((info) => this.#onExit(ap, info)))
  }

  /**
   * A spawn's ContextFacts: its prompt's size (the baseline subtracts it), the window the catalog or probe gives, the
   * project's own memory files (sizes only) and, for a vendor that reports no breakdown, the names its settings make
   * active for the pass. Never throws: a fact that cannot be read is left out.
   */
  #contextFacts(e: EffectOf<'spawn'>, start: StartOptions, prompt: string, cwd: string): ContextFacts {
    const level = start.extensions?.level ?? defaultExtensionLevel(configPassOf(e.step))
    let names: { mcp: readonly string[]; skills: readonly string[] } | undefined
    try {
      names = this.deps.contextNames?.(e.vendor, cwd, level, start.extensions)
    } catch {
      names = undefined
    }
    let window: number | null | undefined
    try {
      window = this.deps.contextWindow?.(e.vendor, e.model)
    } catch {
      window = undefined
    }
    return contextFacts({
      vendor: e.vendor,
      cwd,
      prompt,
      systemAppend: start.systemAppend,
      window,
      resumed: e.launch.resume !== undefined,
      extensions: level,
      names,
    })
  }

  /**
   * The post-compaction reminder's text when a compaction happens: the plan, the acceptance criteria, the files the run
   * changed so far (from its base, read now) and Fix's findings. Never throws: what cannot be read is left out.
   */
  async #compactionReminder(step: 'implement' | 'fix'): Promise<string> {
    const s = this.#state
    let files: string[]
    try {
      const base = runBaseSnap(s)
      const shadow = await this.#shadow()
      files =
        (await shadow.liveChanged({
          skipIfBusy: true,
          ...(base !== undefined ? { since: base.commit } : {}),
        })) ?? []
    } catch {
      files = []
    }
    const st = s.steps[step]
    return stateNote({
      step,
      why: 'reminder',
      compactions: st.context?.compactions ?? 0,
      plan: s.plan?.text ?? null,
      criteria: s.acceptance?.criteria ?? [],
      files,
      ...(step === 'fix' ? { findings: selectedFindings(s).map((f) => `F${f.n} ${f.title}`) } : {}),
    })
  }

  /** runs/<id>/context-health.json once the run is over (the end panel's Context health; never logged). */
  async #writeContextHealth(): Promise<void> {
    const dir = this.deps.store.paths.dir
    const estimate = await readRunEstimate(dir).catch(() => null)
    const report = buildContextHealth(this.#state, estimate)
    if (report === undefined) return
    try {
      await writeFileAtomic(join(dir, CONTEXT_HEALTH_FILE), `${JSON.stringify(report, null, 2)}\n`)
    } catch (err) {
      this.deps.log.warn('context-health.json write failed', { runId: this.runId, code: errnoCode(err) })
    }
  }

  /**
   * `StartOptions.onSession`: record the session id the vendor assigned (P4, a forced run.json write) and answer
   * once that is done, so the adapter sends its first turn only after the id is durable. Never rejects. It
   * answers whether run.json really holds the id now (the write-ahead in #process only logs a failed write), so the
   * adapter can end the pass before any model call when it does not.
   */
  async #sessionAssigned(
    step: AgentStep,
    spawnNo: number,
    sessionId: string,
    cwd: string,
  ): Promise<SessionRecorded> {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: 'no session id' }
    if (this.#closed) return { ok: false, reason: 'the run is closed' }
    try {
      await this.enqueue({ t: 'session-assigned', step, spawnNo, sessionId, cwd })
    } catch (err) {
      this.deps.log.warn('session id not recorded', { runId: this.runId, step, err })
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (this.#state.steps[step].sessionId !== sessionId) {
      // The pass no longer reacts (stopped, failed or replaced): nothing was recorded for it.
      return { ok: false, reason: 'the run no longer waits for this pass' }
    }
    try {
      // A no-op when the write-ahead already wrote it; otherwise (a failed or pending write) it is written now.
      await this.deps.store.flush()
      return { ok: true }
    } catch (err) {
      this.deps.log.error('run.json write failed', { runId: this.runId, step, err })
      const code = errnoCode((err as { cause?: unknown } | null)?.cause) ?? errnoCode(err)
      return {
        ok: false,
        reason: `run.json could not be written: ${err instanceof Error ? err.message : String(err)}`,
        ...(code !== undefined ? { code } : {}),
      }
    }
  }

  async #onExit(ap: ActiveProc, info: ExitInfo): Promise<void> {
    ap.exited = true
    await ap.raw.close()
    if (ap.procId !== undefined) {
      await this.deps.procTable
        .markExit(ap.procId, {
          code: info.code,
          signal: info.signal,
          at: Date.now(),
          how: info.stoppedBy !== undefined ? 'killed' : 'exited',
        })
        .catch(() => undefined)
    }
    if (this.#procs.get(ap.step) === ap) this.#procs.delete(ap.step)
    if (this.#procs.size === 0) this.#stopTouch()
    const classified = info.sawTerminal
      ? null
      : classify({
          vendor: ap.adapter.id,
          step: ap.step,
          failed: true,
          protocol: { noTerminal: true },
          exitCode: info.code,
          signal: info.signal,
          ranMs: info.ranMs,
          now: this.deps.clock.now(),
        })
    const cumulative = ap.handle.cumulativeUsage()
    await this.enqueue({
      t: 'exit',
      step: ap.step,
      spawnNo: ap.spawnNo,
      code: info.code,
      signal: info.signal,
      ranMs: info.ranMs,
      ...(classified !== null ? { failure: classified } : {}),
      ...(cumulative !== undefined ? { cumulative } : {}),
    })
  }

  /**
   * P19/P20: `adapter.canResume()` for each paused mutating pass with a session, in the folder the session was
   * started in. A refusal keeps the adapter's reason (default cannot-resume); the pass then starts fresh with it.
   */
  async #canResume(): Promise<Partial<Record<AgentStep, { ok: boolean; reason?: FreshReason }>>> {
    const out: Partial<Record<AgentStep, { ok: boolean; reason?: FreshReason }>> = {}
    for (const p of AGENT_STEPS) {
      const st = this.#state.steps[p]
      if (st.status !== 'paused' || !isMutatingStep(p) || st.sessionId === undefined) continue
      const adapter = this.deps.adapters.get(st.vendor ?? passCfg(this.#state, p).vendor)
      if (adapter === undefined) continue
      const where = this.#state.sessions[st.sessionId]?.cwd ?? this.#workFolder()
      try {
        const r = await adapter.canResume(st.sessionId, where)
        out[p] = r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'cannot-resume' }
      } catch {
        out[p] = { ok: false, reason: 'cannot-resume' }
      }
    }
    return out
  }

  /**
   * R10 `session-check`: for a Fix launch still deciding its session whose static rules allow reuse (choice,
   * vendor, Implement done with a session), ask the Fix adapter whether Implement's session can be resumed — in the
   * folder it was started in — and add the folder Fix will run in and the vendor's capabilities. undefined when
   * there is nothing to ask.
   */
  async #fixSessionCheck(): Promise<SessionCheck | undefined> {
    const s = this.#state
    const L = s.steps.fix.launch
    if (L?.decide !== 'session' || L.plan !== undefined) return undefined
    // Fix until green, rounds ≥ 2: the previous round's Fix session is the one asked about.
    const candidate = sessionCandidate(fixLaunchSessionInputs(s))
    if (!candidate.reuse) return undefined
    return this.#checkSession(candidate.sessionId, s.config.passes.fix.vendor)
  }

  /**
   * Continuity's `session-check`: for an Implement launch still deciding its session whose static rules allow it to
   * continue Plan's (the same vendor, Plan done with a session it kept), the adapter's canResume, Implement's folder and
   * the vendor's capabilities (the mode switch among them). undefined when there is nothing to ask.
   */
  async #implementSessionCheck(): Promise<SessionCheck | undefined> {
    const s = this.#state
    const L = s.steps.implement.launch
    if (L?.decide !== 'session' || L.plan !== undefined) return undefined
    const candidate = sessionCandidate(implementSessionInputs(s))
    if (!candidate.reuse) return undefined
    return this.#checkSession(candidate.sessionId, s.config.passes.implement.vendor)
  }

  /** canResume for a session in the folder it was started in, plus the folder the pass runs in and the capabilities. */
  async #checkSession(sessionId: string, vendor: string): Promise<SessionCheck> {
    const s = this.#state
    const cwd = this.#workFolder()
    const where = s.sessions[sessionId]?.cwd ?? cwd
    let r: { ok: boolean; reason?: FreshReason } = { ok: false, reason: 'cannot-resume' }
    const adapter = this.deps.adapters.get(vendor)
    if (adapter !== undefined) {
      try {
        r = await adapter.canResume(sessionId, where)
      } catch (err) {
        this.deps.log.warn('canResume failed', { runId: this.runId, vendor, err })
      }
    }
    const capabilities = await this.#sessionCapabilities(vendor)
    const check: SessionCheck = { sessionId, ok: r.ok, cwd }
    if (!r.ok) check.reason = r.reason ?? 'cannot-resume'
    if (capabilities !== undefined) check.capabilities = capabilities
    return check
  }

  /**
   * The vendor's resume capabilities as the run recorded them at start (resolved.json `vendors[v].capabilities`, the
   * launch probe's). undefined when the run has none (decideSession then treats them as unknown).
   */
  async #sessionCapabilities(vendor: string): Promise<SessionCapabilities | undefined> {
    this.#resolvedVendors ??= this.deps.store
      .readJson('resolved')
      .then((r) => (r.kind === 'ok' ? r.value['vendors'] : undefined))
      .catch(() => undefined)
    const vendors = await this.#resolvedVendors
    if (vendors === null || typeof vendors !== 'object') {
      // A read that failed (or found no `vendors`) is not kept: the next Fix decision reads the file again.
      this.#resolvedVendors = undefined
      return undefined
    }
    const caps = (vendors as Record<string, { capabilities?: unknown } | undefined>)[vendor]?.capabilities
    if (caps === null || typeof caps !== 'object') return undefined
    const { resume, resumeModelSwitch, resumeModeSwitch } = caps as Record<string, unknown>
    if (
      (resume !== 'id' && resume !== 'load' && resume !== 'none') ||
      typeof resumeModelSwitch !== 'boolean'
    ) {
      return undefined
    }
    // The mode switch on resume (continuity): absent in a run recorded before it existed (unknown).
    return {
      resume,
      resumeModelSwitch,
      ...(typeof resumeModeSwitch === 'boolean' ? { resumeModeSwitch } : {}),
    }
  }

  // ---- heartbeats / live count ------------------------------------------------------------------------------

  #ensureTouch(): void {
    if (this.#touchTimer !== undefined) return
    this.#touchTimer = setInterval(() => {
      void this.deps.procTable.touch().catch(() => undefined)
    }, this.deps.touchEveryMs ?? 5000)
    this.#touchTimer.unref()
  }

  #stopTouch(): void {
    if (this.#touchTimer !== undefined) clearInterval(this.#touchTimer)
    this.#touchTimer = undefined
  }

  #setLiveCount(on: boolean): void {
    this.#liveOn = on
    if (!on) {
      if (this.#liveTimer !== undefined) clearTimeout(this.#liveTimer)
      this.#liveTimer = undefined
      return
    }
    this.#liveSame = 0
    // Live balanced run: the count a new mutating step starts from is the run's last known one (S1's exact
    // figures when Fix starts), so a first poll that finds the same number does not replace them.
    this.#liveLast = this.#state.diffStats?.files ?? -1
    this.#scheduleLivePoll(this.deps.livePollMs?.fast ?? 15_000)
  }

  #scheduleLivePoll(ms: number): void {
    if (!this.#liveOn) return
    if (this.#liveTimer !== undefined) clearTimeout(this.#liveTimer)
    this.#liveTimer = setTimeout(() => void this.#pollLive(), ms)
    this.#liveTimer.unref()
  }

  async #pollLive(): Promise<void> {
    this.#liveTimer = undefined
    if (!this.#liveOn || this.#livePolling) return
    this.#livePolling = true
    try {
      const shadow = await this.#shadow()
      // The run's files, counted from S0 (the base of the run's diff-stats, as #afterImplementSnapshot and
      // #afterFixSnapshot count them): while Fix runs, the last snapshot is Fix's own start.
      const base = runBaseSnap(this.#state)
      const changed = await shadow.liveChanged({
        skipIfBusy: true,
        ...(base !== undefined ? { since: base.commit } : {}),
      })
      if (changed !== null) {
        if (changed.length !== this.#liveLast) {
          this.#liveLast = changed.length
          this.#liveSame = 0
          await this.enqueue({ t: 'diff-stats', files: changed.length, added: 0, deleted: 0, live: true })
        } else this.#liveSame++
      }
    } catch (err) {
      this.deps.log.debug('live count failed', { runId: this.runId, err })
    } finally {
      this.#livePolling = false
    }
    const p = this.deps.livePollMs ?? { fast: 15_000, slow: 60_000 }
    this.#scheduleLivePoll(this.#liveSame >= 4 ? p.slow : p.fast)
  }

  // ---- shutdown ---------------------------------------------------------------------------------------------

  /** Hard-kill every live process tree now (CLI second Ctrl+C), a verify round's too (it kills its child). */
  async killAll(): Promise<void> {
    for (const ac of this.#verifyRounds.values()) ac.abort()
    await Promise.all([...this.#procs.values()].filter((p) => !p.exited).map((p) => this.#hardKill(p)))
  }

  /**
   * App quit (P26): `quit` pauses every step with live work — a process, or a launch still waiting on a snapshot,
   * reconcile, preflight or retry delay, which would otherwise spawn during the shutdown — then wait for the exits
   * (budget) and the `interrupted` snapshot. Then stop timers and flush run.json.
   */
  async shutdown(budgetMs = 8000): Promise<void> {
    if (this.#closed) return
    const deadline = Date.now() + budgetMs
    const s = this.#state
    const unfinished = s.started && s.stop === undefined && s.outcome === undefined
    if (unfinished || this.#procs.size > 0 || anyLiveProc(s)) {
      await this.enqueue({ t: 'quit' })
      while (this.#procs.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      if (this.#procs.size > 0) await this.killAll()
    }
    await this.settle(Math.max(0, deadline - Date.now()))
    await this.close()
  }

  /** Stop timers and pollers, flush raw logs and run.json. Further events are ignored. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const h of this.#timers.values()) this.deps.clock.clearTimer(h)
    this.#timers.clear()
    this.#setLiveCount(false)
    this.#stopTouch()
    await Promise.all([...this.#procs.values()].map((p) => p.raw.close()))
    try {
      this.deps.store.set(this.doc())
      await this.deps.store.flush()
    } catch (err) {
      this.deps.log.error('run.json flush failed', { runId: this.runId, err })
    }
    for (const q of this.#queue.splice(0)) q.resolve([])
    for (const w of this.#drainWaiters.splice(0)) w()
  }
}

// ---- isolated run helpers --------------------------------------------------------------------------------------

/** The run's folder relative to its scope root (`/` separators, '' for the root), as the worktree has it. */
async function folderRel(folder: string, scopeRoot: string): Promise<string> {
  const real = await realpath(folder).catch(() => folder)
  const rel = relative(scopeRoot, real)
  if (rel === '' || rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) return ''
  return rel.split(/[\\/]+/).join('/')
}

/** A prepare stage that threw, as the step's failure (worktree_failed / deps_missing). */
function prepareFailure(err: unknown, stage: string): Failure {
  if (isWorktreeError(err)) {
    const fixes = err.commands.map((c) => c.command)
    return {
      category: err.category,
      message: fixes.length > 0 ? `${err.message} (${fixes.join('; ')})` : err.message,
      raw: err.stderr.slice(0, 4000),
      classifiedBy: 'app',
      step: 'prepare',
    }
  }
  return {
    category: stage === 'setup' ? 'worktree_failed' : stage === 'ready' ? 'unknown' : 'deps_missing',
    message: errorMessage(err),
    raw: '',
    classifiedBy: 'app',
    step: 'prepare',
  }
}

/**
 * Chaos: a pass not started because run.json could not record its launch (the write-ahead failed): `disk_full` on
 * a full drive (its recovery: Clear snapshots, Retry), else `unknown`, as Dim Factory's own write errors are classified.
 */
function unsavedLaunchFailure(err: unknown, step: AgentStep): Failure {
  const details = err instanceof DimFactoryError ? err.details : undefined
  const errno =
    (details !== null && typeof details === 'object' ? (details as { errno?: unknown }).errno : undefined) ??
    errnoCode((err as { cause?: unknown } | null)?.cause) ??
    errnoCode(err)
  const full = typeof errno === 'string' && DISK_FULL_ERRNO.has(errno)
  return {
    category: full ? 'disk_full' : 'unknown',
    message: full
      ? `The drive is full, so Dim Factory could not save this run's progress and did not start ${stepLabel(step)}. Free some space, then retry.`
      : `Dim Factory could not save this run's progress, so it did not start ${stepLabel(step)}: ${errorMessage(err)}`,
    raw: '',
    classifiedBy: 'app',
    step,
  }
}

/** A finalize operation that threw, as UI copy (git/finalize.ts throws DimFactoryError with its own words). */
function finalizeFailure(err: unknown): Failure {
  return {
    category: err instanceof DimFactoryError && err.code === 'STORAGE' ? 'disk_full' : 'git_state',
    message: errorMessage(err),
    raw: '',
    classifiedBy: 'app',
    step: 'finalize',
  }
}
