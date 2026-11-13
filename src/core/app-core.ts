// The composition root: Main hosts createCore({home, host}), pure Node and host-agnostic. The same core serves the
// app, the dev CLI and the integration tests.
//
// Boot: home → home lock + session (writable cores) → config (editor schema, user dimfactory.json) → adapters
// (Claude and Codex from the user file's `vendors` + registry stubs) → bus → runs index → scheduler →
// preflight engine → catalog (pass cost) → recovery (orphan sweep, paused(interrupted), held locks) → config file
// watcher.
// Read-only cores (CLI show / runs / preflight / doctor / config resolve) take no lock, run no recovery and write
// nothing.
//
// Every run resolves its config from the files as they are (builtin → user → project → run); an
// invalid user file blocks runs (app.config.user), an invalid project file blocks its folder (folder.project.config).
//
// Estimates: the aggregate is built from the runs index once and follows its put/del changes; each
// run's estimate is frozen at runs.start into runs/<id>/estimate.json (the source of StepView.eta and
// RunSummary.progress.etaMs, re-read when the run is loaded). Attention covers the loaded runs plus the runs boot
// recovery left waiting, paused or failed without loading them (`dormant`, from their run.json): nothing is
// spawned or locked for them, and a dormant run gives way to its controller once something opens it.
//
// Timers and attention surfaces: the host drives sleep (`power`), answers asks from desktop
// notifications (`answerAsk`, deny at once, `via:'notification'`; a stale ask is CONFLICT {stale:true}), moves the E2E
// clock (`advanceClock`, DIM_FACTORY_E2E=1 only), and gets each notification's facts (CoreNotification.run/ask/…).
//
// Revert: `diff.revert` / `diff.undoRevert` go through the run's controller (its reducer refuses while a process
// holds the folder) after checking that no other loaded run works in the same folder; `runs.branch` acts on a
// finished run's branch with git/branch.ts's guards (copyable commands otherwise); `diff.files` / `diff.file` read a
// segment (S0..S1, F0..S2, S0..last) from the run's snapshots in the shadow.
//
// Recovery: each run's controller gets the recovery facts (vendor names and testedUpTo, switch_vendor readiness,
// managed flags) and the healer (heal/healer.ts runHealer over the user's current selfHeal settings, its evidence read
// with readHealTail); a run loaded from disk gets its resolved.json `patches[]` applied and its armed waits disarmed.
//
// Diffs (the Diff tab, Settings → Diagnostics): diff.files / file / blob / markReviewed read through
// run-diffs.ts (the shadow by commit and blob id, never re-created; the run's saved patches once its snapshots are
// gone, when diff.revert answers why it cannot); storage.usage sizes the home, and storage.clearShadow saves the
// folder's runs' missing patches, then removes its shadow, refused while a run holds or waits for the folder.
//
// Runs history (history.ts): runs/history.json's pins and pending
// removals overlay every list and index write (a removed run is hidden at once); runs.pin / runs.remove /
// runs.undoRemove go through history.ts, which deletes runs for real after the undo window (or at the next start), and
// the app runs retention 2 minutes after boot, then daily, while idle (`dimf gc` on demand: Core.history).
import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { CatalogStatus } from '../shared/catalog.ts'
import type { ResolvedConfig, RunLimits, RunOverrides } from '../shared/config-schema.ts'
import { ResolvedConfigZ, RUN_LIMITS_NONE, RunLimitsZ } from '../shared/config-schema.ts'
import type { RunEstimate } from '../shared/estimates.ts'
import type { Finding, FindingsFile } from '../shared/findings.ts'
import { newRunId } from '../shared/ids.ts'
import type { AskDecision } from '../shared/events.ts'
import type { Cmd, InvokeArgs, McpBridgeCommand, Req, Res, Result, StorageUsage } from '../shared/ipc.ts'
import type { PreflightReport } from '../shared/preflight.ts'
import type { AnswerVia, Mode, PassName, RunEnvelope, RunSummary, StepCost, StepKey } from '../shared/run.ts'
import { AGENT_STEPS, PASS_NAMES, configPassOf } from '../shared/run.ts'
import type { ProbeResult, Support } from '../shared/vendors.ts'
import { accountDefaultMayDiffer, isKnownVendor, localPresetIdOf } from '../shared/vendors.ts'
import { createClaudeAdapter } from './adapters/claude/index.ts'
import type { ClaudeAdapter } from './adapters/claude/index.ts'
import type { PassExtensions } from './adapters/types.ts'
import type { ExtensionLevel } from '../shared/extensions.ts'
import { claudeCliSpec } from './adapters/claude/cli-spec.ts'
import { codexCliSpec } from './adapters/codex/cli-spec.ts'
import { createCodexAdapter } from './adapters/codex/index.ts'
import type { CodexAdapter } from './adapters/codex/index.ts'
import { createGeminiAdapter, geminiCliSpec } from './adapters/gemini/index.ts'
import type { GeminiAdapter } from './adapters/gemini/index.ts'
import { createGrokAdapter, grokCliSpec } from './adapters/grok/index.ts'
import type { GrokAdapter } from './adapters/grok/index.ts'
import { createMuseAdapter, museCliSpec } from './adapters/muse/index.ts'
import type { MuseAdapter } from './adapters/muse/index.ts'
import { AdapterRegistry, VENDOR_DISPLAY_NAMES } from './adapters/registry.ts'
import { vendorArgsCheck } from './adapters/vendor-args.ts'
import { EventBus, forEachEnvelope } from './bus/bus.ts'
import { catalogCostUsd, costForUsage, isSubscriptionAuth, toStepCost } from './catalog/cost.ts'
import { CatalogLive } from './catalog/live.ts'
import { lookupPrice, parsePricingRef, pricingRefFor, resolveModelId, runPassPrice } from './catalog/store.ts'
import type { CatalogData, PricingRef } from './catalog/store.ts'
import { CatalogJobs } from './catalog/refresh-jobs.ts'
import type { RefreshSettings } from './catalog/refresh-jobs.ts'
import { buildCatalogDiff } from './catalog/diff.ts'
import { BUILTIN_DEFAULTS, BUILTIN_PROFILE_NAMES } from './config/defaults.ts'
import type { FirstLaunchOutcome } from './config/firstLaunch.ts'
import { selectFirstLaunchProfile } from './config/firstLaunch.ts'
import { checkAttachments, copyAttachments } from './easy/attach.ts'
import { discoverCommands } from './verify/discover.ts'
import type { AttachContext } from './easy/attach.ts'
import { ProjectPermissions } from './easy/permission.ts'
import type { PermitRun } from './easy/permission.ts'
import { EasyService, homeLooksNew } from './easy/service.ts'
import { inspectExisting } from './easy/existing.ts'
import { saveFirst } from './easy/save-first.ts'
import type { MemorySeed } from './factory/memory.ts'
import { detectRepo } from './git/repo.ts'
import {
  INTENT_BAD_ANSWER,
  INTENT_LABEL,
  INTENT_NO_VENDOR,
  INTENT_TOKENS,
  intentPrompt,
  parseIntentAnswer,
} from './easy/intent.ts'
import {
  VISUAL_BAD_ANSWER,
  VISUAL_LABEL,
  VISUAL_NO_PICTURE,
  VISUAL_NO_VENDOR,
  VISUAL_TOKENS,
  gameplayPicture,
  parseVisualAnswer,
  readVisual,
  recordVisual,
  smokePicture,
  visualPrompt,
} from './easy/visual.ts'
import { EASY_THINK_ROUNDS } from '../shared/easy.ts'
import {
  THINK_BAD_ANSWER,
  THINK_LABEL,
  THINK_NO_VENDOR,
  THINK_TOKENS,
  parseThinkAnswer,
  thinkPrompt,
} from './easy/think.ts'
import {
  ASK_LABEL,
  ASK_NO_ANSWER,
  ASK_NO_VENDOR,
  ASK_TIMEOUT_MS,
  ASK_TOKENS,
  askAnswerText,
  askPrompt,
} from './easy/ask.ts'
import { shareFiles } from './easy/share-files.ts'
import { chooseSuggester, readOnlyAnswer } from './brief/suggest.ts'
import { cheapestModel } from './grounding/judge.ts'
import { PROVE_VENDOR, proveRule } from './guardrails/prove.ts'
import type { ProveKind } from '../shared/guardrails.ts'
import type { SuggestDeps } from './brief/suggest.ts'
import { initRepository } from './recovery/git-init.ts'
import { grantTrust, readEasyProjectGrants, revokeEasyProject } from './config/trust.ts'
import { detectToolchain, e2eToolchain, forgetNodeVersions } from './easy/toolchain.ts'
import { RunLimitsWatcher, readLimitStop } from './factory/run-limits.ts'
import type { EasyHost } from './handlers-easy.ts'
import { loadConfigFile } from './config/load.ts'
import { ConfigService, vendorSettings } from './config/service.ts'
import type { ConfigSnapshot } from './config/service.ts'
import type { ConfigChangedEvent } from './config/watch.ts'
import { armChaos } from './chaos.ts'
import { catalogStatus, readCatalogState } from './dashboard/dashboard.ts'
import type { SpendPricing } from './dashboard/stats.ts'
import { DimFactoryError, errorMessage, fail, ok } from './errors.ts'
import { EstimateAggregate } from './estimates/aggregate.ts'
import { estimateRun, readRunEstimate, writeRunEstimate } from './estimates/estimate.ts'
import type { PriceLookup } from './estimates/estimate.ts'
import { deleteRunBranch, returnToPrevious } from './git/branch.ts'
import { ShadowReader, forgetDiffView } from './git/diff-view.ts'
import { isFolderBusy, withFolderLock } from './git/mutex.ts'
import { folderKeyOf, lockKeysOverlap, resolveScope } from './git/repo.ts'
import { deleteRunRefs, forgetShadows, shadowFor, sizePreflightReadOnly } from './git/shadow.ts'
import type { HandlerContext, HandlerMap, RunGitHost } from './handlers.ts'
import type { DiffViewHost, StorageHost } from './handlers-diff-settings.ts'
import { createWorktreeHost } from './handlers-worktree.ts'
import { createRunDiffs, persistFailedText } from './run-diffs.ts'
import { resolvedConfigWithPatches, withAcceptedPatches } from './resolved-json.ts'
import { removeShadow, shadowScopeRoot, storageUsage } from './store/storage.ts'
import { createHandlers, dispatch, probeView, readRunDoc } from './handlers.ts'
import type { RecoveryHost } from './handlers-recovery.ts'
import { ensureHome, homePaths, resolveHome } from './home.ts'
import type { HomePaths } from './home.ts'
import { createHomeLogger, silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import {
  authRecheckers,
  claudeAuthRechecker,
  createPreflightEngine,
  runPreflight,
} from './preflight/engine.ts'
import type {
  FolderLockInfo,
  FolderSizeResult,
  PreflightDeps,
  PreflightEngine,
  PreflightInput,
} from './preflight/engine.ts'
import { PreflightCache } from './preflight/cache.ts'
import { planNativeFor } from './preflight/checks/pass.ts'
import { guardCheckResult, isGuarded, sameGuardPath, scopeRootGuardDetail } from './preflight/guard.ts'
import { ProcTable } from './proc/proc-table.ts'
import { resolvePathEnv } from './proc/path-env.ts'
import { readHealTail, runHealer } from './heal/healer.ts'
import type { HealerDeps } from './heal/healer.ts'
import type { HealApi } from './recovery/heal-api.ts'
import { switchTargetFor } from './recovery/switch-vendor.ts'
import type { Readiness, VendorReadiness } from './recovery/switch-vendor.ts'
import { RecoveryActionStore, folderPassesOf, folderStoreKey } from './recovery/store.ts'
import type { FolderPasses } from './recovery/store.ts'
import { vendorFailureSink } from './recovery/vendor-failure.ts'
import { validateCliPath } from './recovery/vendor-path.ts'
import type { VendorPathCheck } from './recovery/vendor-path.ts'
import type { Shadow, SnapshotRecord } from './git/shadow.ts'
import { IndexStore } from './store/index-store.ts'
import { HistoryState } from './store/history-state.ts'
import { RetentionScheduler, retentionPolicyOf } from './store/retention.ts'
import { createHistory } from './history.ts'
import type { CoreHistory } from './history.ts'
import { removeStaleTemps, writeFileAtomic } from './store/atomic.ts'
import { scanJsonl } from './store/jsonl.ts'
import { listRunIds, removeRunDir, RunStore } from './store/run-store.ts'
import { openHomeSession } from './store/home-lock.ts'
import type { HomeSession } from './store/home-lock.ts'
import { isPlainObject, readVersionedJson } from './store/versions.ts'
import { RunController } from './supervisor/controller.ts'
import type { ControllerRecovery, RunDoc, RunScope } from './supervisor/controller.ts'
import { FINALIZE_CHOICE, stepLabel } from './supervisor/cards.ts'
import { disarmOnLoad } from './supervisor/loaded-state.ts'
import { aggregateAttention } from './supervisor/attention.ts'
import type { Attention } from './supervisor/attention.ts'
import { awaitsModelWord, deriveStatus, runEtaOf, toRunSummary } from './supervisor/derive.ts'
import type { RunViewInputs } from './supervisor/derive.ts'
import { clockFromEnv, gitFactsFor } from './supervisor/effects.ts'
import type { Clock, TimerHandle } from './supervisor/effects.ts'
import { folderBusyReason, initRunState, runConfigFromResolved } from './supervisor/machine.ts'
import { notificationFacts } from './supervisor/notify-facts.ts'
import type {
  NotificationAskFacts,
  NotificationCardFacts,
  NotificationCompletedFacts,
  NotificationFailedFacts,
  NotificationRunFacts,
} from './supervisor/notify-facts.ts'
import { defaultDenyGraceMs } from './supervisor/timers.ts'
import {
  emptyRecoveryReport,
  isFinishedState,
  recoverRuns,
  summaryStale,
  summaryWorkPending,
  withoutStaleSuspend,
} from './supervisor/recovery.ts'
import type { RecoveryReport } from './supervisor/recovery.ts'
import { FolderScheduler } from './supervisor/scheduler.ts'
import { runLockKeyOf, workFolderOf, workScopeOf } from './supervisor/controller.ts'
import type { IsolationApi } from './supervisor/isolation.ts'
import { checkEligibility, isolatedCopyRun, uncommittedCount, worktreeKeys } from './git/worktree.ts'
import type { CostInput, EffectOf, RunInit, RunState } from './supervisor/types.ts'
import type { SessionCapabilities } from './supervisor/sessions.ts'
import { rerunRun } from './rerun.ts'
import { BriefService } from './brief/service.ts'
import type { BriefHost } from './handlers-brief.ts'
import { resolvePromptTemplate, resolveStepTemplates, toResolvedTemplate } from './prompts/resolve.ts'
import type { StepTemplates } from './prompts/resolve.ts'
import { isStepPromptName } from '../shared/prompt-names.ts'
import type { BriefInput } from '../shared/brief.ts'
import { BriefInputZ } from '../shared/brief.ts'
import { readSavedBrief } from './brief/store.ts'
import { planDeploy } from './deploy/report.ts'
import { ghCommandFor } from './deploy/pr.ts'
import type { DeployHost } from './handlers-deploy.ts'
import type { ProjectHost } from './handlers-project.ts'
import { loadTemplates, templateById } from './templates/load.ts'
import { copyTemplateFiles } from './templates/files.ts'
import { prepareProjectFolder, projectCreated } from './templates/project.ts'
import type { ControllerDeploy } from './supervisor/controller.ts'
import { segmentEnds } from './supervisor/diff-segments.ts'
import { DEFAULT_CATEGORY, GAMES_CATEGORY } from '../shared/brief.ts'
import { researchSupport } from './research/lenses.ts'
import type { ResolvedTemplate } from '../shared/config-schema.ts'
import { ResolvedTemplateZ } from '../shared/config-schema.ts'
import { sweepMcpScratch } from './extensions/scratch.ts'
import {
  discoverExtensions,
  discoverVendor,
  withConnectors,
  withHandshakeNames,
} from './extensions/discover.ts'
import type { CreatedRun, NewRunSpec, RerunHost, RerunRequest } from './rerun.ts'
import { ExternalMcp } from './mcp/external.ts'
import type { ClaudeRunner } from './mcp/claude-plugin.ts'
import type { CodexRunner } from './mcp/codex-plugin.ts'
import { claudeRunner, codexRunner } from './mcp/cli-runner.ts'
import { BRAND, envName } from '../shared/brand.ts'
import type { PreviewPlaytestView, PreviewSessionView, PreviewSmokeView } from '../shared/preview.ts'
import type { PreviewHost } from './handlers-preview.ts'
import { loadPacks } from './packs/load.ts'
import { resolveRecipe } from './recipes/load.ts'
import { briefWithRecipe, recipeSummary, runRecipeOf } from '../shared/recipes.ts'
import type { RecipeRecord, RecipeView } from '../shared/recipes.ts'
import { PreviewService } from './preview/service.ts'
import { pdfNameOf } from './preview/document.ts'
import { FACTORY_DEFAULTS } from '../shared/config-schema.ts'
import type { FactorySettings } from '../shared/config-schema.ts'
import { FactoryService } from './factory/service.ts'
import { MemoryService } from './factory/memory-service.ts'
import { FallbackService } from './factory/fallback.ts'
import type { FactoryHost } from './handlers-factory.ts'
import { commitPreview, commitRun, commitWhere } from './deploy/run-git.ts'
import { switchBack } from './factory/branch-back.ts'
import { readRunSmoke, recordSmoke } from './preview/smoke.ts'
import { gamePageRoot } from './preview/game.ts'
import { checkGameNames } from './preview/names.ts'
import type { MainPlaytester } from './preview/game.ts'
import { startStaticServer } from './preview/static-server.ts'
import { PLAYTEST_NOT_HERE, PLAYTEST_NO_FILE, readPlaytestFile } from './verify/playtest.ts'
import { PAGELOAD_NOT_HERE } from './verify/pageload.ts'
import { runVerifyRound } from './verify/run.ts'
import { BUILD_COMMAND_NAME } from './deploy/build.ts'
import type { PageChecker } from './verify/pageload.ts'
import type { Playtester } from './verify/playtest.ts'
import type { GameCheck, PlaytestReport, PlaytestSpec } from '../shared/playtest.ts'
import type { SmokeObservation } from './preview/smoke.ts'
import { decideDepth } from './depth/decide.ts'
import { folderSize as depthFolderSize } from './depth/folder.ts'
import { isNewFolder } from './depth/classify.ts'
import { listCatalogHistory } from './catalog/apply.ts'
import { planRematchSide } from './match/rematch.ts'
import { MatchService } from './match/service.ts'
import { MatchTurns } from './match/turns.ts'
import type { MatchRef } from '../shared/match.ts'
import { PROMPT_SHARPEN_MAX, checkPrompt } from '../shared/prompt-check.ts'
import type { PromptFolder } from '../shared/prompt-check.ts'
import {
  SHARPEN_BAD_ANSWER,
  SHARPEN_EMPTY,
  SHARPEN_LABEL,
  SHARPEN_NO_VENDOR,
  SHARPEN_TOKENS,
  SHARPEN_TOO_LONG,
  parseSharpenAnswer,
  sharpenPrompt,
} from './prompt-check/sharpen.ts'
import type { DepthDecision } from '../shared/depth.ts'

export const APP_NAME = BRAND.slug
/** A local preset's pricing is 0: what a local model's tokens are estimated at. */
const LOCAL_PRESET_RATES = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }
/** The passes a folder's report was checked for (a run-less switch_vendor moves them). */
const passesOfConfig = (c: ResolvedConfig | undefined): FolderPasses | undefined =>
  c !== undefined ? folderPassesOf(c) : undefined
/** `Lead. Copy.`: a lead clause and an adapter's support copy as whole sentences (no reason codes). */
function sentences(lead: string, copy: string): string {
  const c = copy.trim()
  if (c === '') return `${lead}.`
  return `${lead}. ${/[.!?]$/.test(c) ? c : `${c}.`}`
}
/** At quit, a run delete in flight gets this long to finish before the index closes. */
const HISTORY_SHUTDOWN_WAIT_MS = 5000
/**
 * At quit, the queue's work already queued (a run's end: its memory note, its commit, the queue file) gets this long to
 * finish. It runs git in the user's folder; a quit that returned first left that git running there (on Windows its
 * working directory keeps the folder from being deleted or renamed) and its writes landing after the index closed.
 */
const FACTORY_SHUTDOWN_WAIT_MS = 10_000

export type {
  NotificationAskFacts,
  NotificationCardFacts,
  NotificationCompletedFacts,
  NotificationFailedFacts,
  NotificationRunFacts,
}

export interface CoreNotification {
  runId: string
  kind: EffectOf<'notify'>['kind']
  step?: string
  requestId?: string
  cardId?: string
  state: RunState
  // What the host presents, stated by core (supervisor/notify-facts.ts). Core always sets
  // `run`, and the member for the kind when its subject still exists: `ask` (kind ask), `card` (gate, card),
  // `completed`, `failed`.
  run?: NotificationRunFacts
  ask?: NotificationAskFacts
  card?: NotificationCardFacts
  completed?: NotificationCompletedFacts
  failed?: NotificationFailedFacts
}

/** An ask answered from outside the app window (a desktop notification's action). */
export interface AskAnswerInput {
  runId: string
  requestId: string
  decision: Exclude<AskDecision, 'cancel'>
  /** Default `notification`. A Deny from a notification or the CLI is sent at once (graceMs 0: no undo grace). */
  via?: AnswerVia
}

/** Why `answerAsk` refused an ask that is no longer pending: answered elsewhere, timed out, withdrawn, run over. */
export const STALE_ASK_MESSAGE = 'This question was already answered or has expired.'

/** A `Result` error from `answerAsk` for an ask that is no longer pending ("already answered/expired"). */
export function isStaleAsk(r: Result<unknown>): boolean {
  if (r.ok || r.error.code !== 'CONFLICT') return false
  const d = r.error.details
  return typeof d === 'object' && d !== null && (d as { stale?: unknown }).stale === true
}

export interface CoreHost {
  kind: 'app' | 'cli'
  /** Asks, gates, cards, completed/failed/stopped (the host applies focus and rate rules). */
  notify?: (n: CoreNotification) => void
  /** Default: `logs/<main|cli>.log` (writable cores), silent otherwise. */
  log?: Logger
  /**
   * The `catalog` event: a catalog refresh became due ("Model prices may be out of date"). Once per due
   * date; the host applies `notifications.events.catalog`, the focus rule and the pause.
   */
  notifyCatalog?: () => void
}

export interface CreateCoreOptions {
  /** DIM_FACTORY_HOME (default resolveHome()). */
  home?: string
  host: CoreHost
  /** No home lock, no recovery, no writes. */
  readOnly?: boolean
  /** Default: DIM_FACTORY_E2E_TIME_SCALE (with DIM_FACTORY_E2E=1) or the system clock. */
  clock?: Clock
  /** Dim Factory's own environment (default process.env). */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * The healer (HEAL_API). Default: heal/healer.ts runHealer over the user's selfHeal settings; tests pass a fake.
   * `null`: no healer (a heal answers failed).
   */
  heal?: HealApi | null
  /**
   * ISO_API: an isolated run's prepare and finalize (supervisor/isolation.ts). Default: the real modules
   * (git/worktree.ts, git/finalize.ts, src/core/prepare); tests pass fakes with the same signatures.
   */
  isolation?: IsolationApi
  /**
   * Background retention at boot: run retention 2 minutes after boot, then daily, while idle.
   * Default: on for the app (not under DIM_FACTORY_E2E=1); `dimf gc` runs it on demand through `Core.history`.
   * Tests may pass other delays.
   */
  retention?: boolean | { bootDelayMs?: number; intervalMs?: number }
  /**
   * Catalog scheduler: look at the catalog refresh schedule at launch and every 6 h on the core's clock,
   * raising the consent card (never starting a refresh). Default: on for an app host that takes catalog notices
   * (`host.notifyCatalog`, as main does); tests opt in, with other delays if they like.
   */
  catalogScheduler?: boolean | { bootDelayMs?: number; intervalMs?: number }
  /** The live files-changed count's poll intervals (RunController's; default 15 s, then 60 s). Tests shorten them. */
  livePollMs?: { fast: number; slow: number }
  /**
   * How long a finished run (completed or cancelled) with nothing in flight stays loaded after its last
   * change before it is unloaded like a run from an earlier launch (default UNLOAD_FINISHED_AFTER_MS). Tests shorten it.
   */
  unloadFinishedAfterMs?: number
  /**
   * Outside agents (mcp/external.ts, app hosts only): the `Dim Factory --mcp` bridge command main reports (default
   * null), and the Codex and Claude Code CLI runners for the plugin installs (default: the user's CLI, found like the
   * adapter's; tests pass a fake).
   */
  externalMcp?: { bridge?: McpBridgeCommand | null; runCodex?: CodexRunner; runClaude?: ClaudeRunner }
  /**
   * Easy mode: the user's Documents folder, where the default projects folder goes (main passes the OS's; default the
   * home directory's Documents). Under DIM_FACTORY_E2E=1 it is DIM_FACTORY_E2E_DOCUMENTS, else a folder beside the
   * test's home, so a test never writes into a real Documents folder.
   */
  documentsDir?: string
}

/** A finished, idle run is unloaded this long after its last change (createCore `unloadFinishedAfterMs`). */
export const UNLOAD_FINISHED_AFTER_MS = 5 * 60_000

/** resolved.json `config` with its `patches[]` applied (resolved-json.ts, shared with Re-run). */
export { resolvedConfigWithPatches }

/** The user file's `profile` and `vendors` (empty when the file is invalid), and its errors as `file:line:col msg`. */
export interface UserSettings {
  profile?: string
  vendors: ResolvedConfig['vendors']
  issues: string[]
}

export interface Core {
  readonly paths: HomePaths
  readonly bus: EventBus
  readonly clock: Clock
  readonly log: Logger
  readonly adapters: AdapterRegistry
  readonly scheduler: FolderScheduler
  readonly preflight: PreflightEngine
  readonly recovery: RecoveryReport
  readonly readOnly: boolean
  /** The user dimfactory.json as last loaded. */
  readonly settings: UserSettings
  /** Config load/resolve/save, prompts and trust. */
  readonly config: ConfigService
  /**
   * First launch: once per home, pick a profile from the ready vendors and write it to the user file when
   * it has none. Probes the built primary vendors not probed yet. Null on read-only cores.
   */
  firstLaunch(): Promise<FirstLaunchOutcome | null>
  invoke<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Result<Res<C>>>
  /** The live controller of a run loaded in this process. */
  controller(runId: string): RunController | undefined
  /** A run's summary (live state, else the runs index). */
  summary(runId: string): RunSummary | undefined
  /**
   * Who needs the user now, over every loaded run: the same aggregate the `attention` event carries. A host that
   * attaches to the bus late (or a renderer that reloaded) starts from this, since the event is sent on change only.
   */
  attention(): Attention
  /**
   * Sleep (powerMonitor drives the timers): the machine is going to sleep / woke up. Suspend
   * holds every stall, hard and ask timer; resume shifts lastEventAt, keepWaitingAt and each pending ask's expiresAt
   * by the time asleep (`ask-extended` bodies) and re-arms them. Resolves once every loaded run has reduced it.
   */
  power(state: 'suspend' | 'resume'): Promise<void>
  /**
   * E2E only (`e2e.clock`): move the clock forward by `ms`; the timers then due fire in order and their events
   * are reduced before this resolves (their effects may still run). UNSUPPORTED unless DIM_FACTORY_E2E=1.
   */
  advanceClock(ms: number): Promise<Result<{ now: number }>>
  /**
   * Answer an ask from a desktop notification. It is recorded `via` (default `notification`) in its
   * `ask-resolved` body; a Deny takes effect at once. An ask that is no longer pending answers
   * `{code:'CONFLICT', message: STALE_ASK_MESSAGE, details:{stale:true}}` (`isStaleAsk`).
   */
  answerAsk(a: AskAnswerInput): Promise<Result<void>>
  /** Whether the ask still waits for an answer (a Deny in its undo grace counts as answered). */
  askPending(runId: string, requestId: string): boolean
  /** Hard-kill every live vendor process tree (CLI second Ctrl+C). */
  killAll(): Promise<void>
  /** Quit: interrupt live passes (P26), flush run.json, close logs and release the home lock. */
  shutdown(): Promise<void>
  /**
   * Storage retention and shadow GC: retention on demand (`dimf gc`; a read-only core answers a dry run
   * only) and the deferred deletes in flight (Remove's, the boot's leftovers).
   */
  readonly history: CoreHistory
  /** The live catalog (catalog/live.ts): prices, models, apply/undo/edits, the schedule. Undefined when read-only. */
  readonly catalog: CatalogLive | undefined
  /** Run & Preview for main: a session's view (its URL), and recording a smoke check main ran. */
  readonly preview: CorePreview
  /**
   * The factory (task queues, budgets, the schedule, the daily report): main tells it whether the computer runs on
   * battery (a due schedule waits for power unless the user allowed it). Undefined on read-only cores.
   */
  readonly factory: { setOnBattery(onBattery: boolean): Promise<void>; settled(): Promise<void> } | undefined
}

/** Run & Preview as main uses it (the preview window and the smoke check are main's). */
export interface CorePreview {
  session(id: string): PreviewSessionView | undefined
  /** Record what the smoke check saw: a run's console errors become [should] findings kept with the run. */
  recordSmoke(sessionId: string, seen: SmokeObservation): Promise<PreviewSmokeView>
  /**
   * Save a document preview's PDF (main printed it) next to the document in its project folder: `memo.pdf`,
   * `docs.pdf`. Answers the path written. NOT_FOUND unless the session is a running document view.
   */
  savePdf(sessionId: string, pdf: Uint8Array): Promise<string>
  /** A request to another computer a loopback-only (game) preview's page made: blocked, counted on the session. */
  recordBlocked(sessionId: string, url: string): void
  /** A game's preview window went to Phone size, or back (main's window; the session view says so). */
  setPhone(sessionId: string, on: boolean): void
  /**
   * Main's play-tester (its hidden play-test window): the built-in Verify play-test plays games through it. null
   * detaches it. Without one (the command-line tool) the play-test says "not checked here".
   */
  attachPlaytester(p: MainPlaytester | null): void
  /** The playtest.json of a running preview's folder, read and checked (Play-test), or why there is none to play. */
  playtestSpec(sessionId: string): Promise<{ spec: PlaytestSpec } | { problem: string }>
  /**
   * Keep a session's latest play-test (the Run it panel and the Done screen show it), with the name check (the game's
   * title, README title and file names against the Games pack's famous names) added to its checks.
   */
  recordPlaytest(
    sessionId: string,
    report: PlaytestReport | null,
    problem?: string,
  ): Promise<PreviewPlaytestView>
}

// ---- user settings ----------------------------------------------------------------------------------------------

/**
 * Read `profile` and `vendors` from the user's dimfactory.json with the full loader (strict schema, semantic rules).
 * Missing file → empty settings; an invalid file → empty settings plus its errors. Writes nothing.
 */
export async function loadUserSettings(paths: HomePaths): Promise<UserSettings> {
  return vendorSettings(await loadConfigFile(paths.userConfig, { scope: 'user' }))
}

// ---- read-only index ---------------------------------------------------------------------------------------------

/**
 * runs/index.jsonl without writing (read-only cores); falls back to the run.json files when it is missing (with
 * runs/history.json's pins, and without the runs a Remove is deleting).
 */
async function readIndexReadOnly(paths: HomePaths, history: HistoryState): Promise<Map<string, RunSummary>> {
  const map = new Map<string, RunSummary>()
  const stats = await scanJsonl(paths.runIndex, (l) => {
    const v = l.value
    if (!isPlainObject(v)) return
    if (v['op'] === 'put' && isPlainObject(v['s']) && typeof v['s']['runId'] === 'string') {
      map.set(v['s']['runId'], v['s'] as unknown as RunSummary)
    } else if (v['op'] === 'del' && typeof v['id'] === 'string') map.delete(v['id'])
  })
  if (stats.exists) return map
  for (const id of await listRunIds(paths)) {
    const doc = await readRunDoc(paths, id)
    const s = doc !== null ? history.overlay(toRunSummary(doc.state)) : null
    if (s !== null) map.set(id, s)
  }
  return map
}

// ---- Chaos: leftovers of a crash -----------------------------------------------------------------------------------

/**
 * The temp files of atomic writes (`<name>.<pid>.<hex>.tmp`) a crashed Dim Factory left: in the home, runs/, catalog/
 * (its history and jobs), backups/, each shadow's metadata and the folders of `runIds` (with their subfolders).
 * Logged once; never throws.
 */
async function sweepStaleTemps(paths: HomePaths, runIds: readonly string[], log: Logger): Promise<void> {
  const dirs: [string, number][] = [
    [paths.home, 0],
    [paths.runsDir, 0],
    [paths.catalogDir, 2],
    [paths.backupsDir, 2],
    ...runIds.map((id): [string, number] => [paths.run(id).dir, 1]),
  ]
  const keys = await readdir(paths.shadowDir).catch(() => [] as string[])
  for (const k of keys) {
    dirs.push([join(paths.shadowDir, k), 0], [join(paths.shadowDir, k, 'repo.git'), 0])
    dirs.push([join(paths.shadowDir, k, 'repo.git', 'info'), 0])
  }
  const removed = (await Promise.all(dirs.map(([d, depth]) => removeStaleTemps(d, { depth })))).flat()
  if (removed.length > 0) log.info('removed temp files a closed Dim Factory left', { count: removed.length })
}

// ---- createCore ------------------------------------------------------------------------------------------------

export async function createCore(o: CreateCoreOptions): Promise<Core> {
  const env = o.env ?? process.env
  const paths = homePaths(o.home ?? resolveHome({ env }))
  const readOnly = o.readOnly === true
  const clock = o.clock ?? clockFromEnv(env)
  // Chaos (DIM_FACTORY_E2E=1 only, an E2E-only hook): the suite's kill switch, disarmed otherwise.
  if (!readOnly) armChaos(env, join(paths.home, 'e2e', 'chaos.json'))
  let session: HomeSession | undefined
  if (!readOnly) {
    await ensureHome(paths)
    session = await openHomeSession(paths, { kind: o.host.kind })
  }
  const ownLog =
    o.host.log === undefined && !readOnly
      ? createHomeLogger(paths, o.host.kind === 'app' ? 'main' : 'cli')
      : undefined
  const log: Logger = o.host.log ?? ownLog ?? silentLogger
  try {
    return await bootCore({ o, env, paths, readOnly, clock, session, log, ownLog })
  } catch (err) {
    await session?.close().catch(() => undefined)
    await ownLog?.close().catch(() => undefined)
    throw err
  }
}

interface BootInput {
  o: CreateCoreOptions
  env: Readonly<Record<string, string | undefined>>
  paths: HomePaths
  readOnly: boolean
  clock: Clock
  session: HomeSession | undefined
  log: Logger
  ownLog: { close(): Promise<void> } | undefined
}

async function bootCore(b: BootInput): Promise<Core> {
  const { o, env, paths, readOnly, clock, log } = b
  // Easy mode: whether this home is a new user's, read before first launch writes anything (DIM_FACTORY_E2E_NEW_USER
  // makes an E2E home one, whose harness writes a user file first), and where new projects go by default.
  const e2eOn = env[envName('E2E')] === '1'
  const easyNewHome =
    !readOnly && ((e2eOn && env[envName('E2E_NEW_USER')] === '1') || (await homeLooksNew(paths)))
  const documentsDir = e2eOn
    ? (env[envName('E2E_DOCUMENTS')] ?? join(dirname(paths.home), 'documents'))
    : (o.documentsDir ?? join(homedir(), 'Documents'))
  const controllers = new Map<string, RunController>()
  const adapters = new AdapterRegistry({ now: clock.now })
  // The launch-probe store and check cache, shared by the preflight engine and the config (vendor readiness).
  const preflightCache = new PreflightCache()

  // Scope lookups (git spawns) are shared by config, one runs.start and its preflight checks; 30 s is long enough
  // for that and short enough that `git init` in a folder is noticed by the next run.
  const scopes = new Map<string, { at: number; p: Promise<RunScope> }>()
  const scopeOf = (folder: string): Promise<RunScope> => {
    const key = resolve(folder)
    const hit = scopes.get(key)
    if (hit !== undefined && Date.now() - hit.at < 30_000) return hit.p
    const p = resolveScope(key).then((s) => ({
      folder: key,
      scopeRoot: s.scopeRoot,
      lockKey: s.lockKey,
      folderKey: s.folderKey,
      isRepo: s.isRepo,
    }))
    scopes.set(key, { at: Date.now(), p })
    p.catch(() => scopes.delete(key))
    return p
  }
  const folderSize = async (folder: string): Promise<FolderSizeResult> => {
    const scope = await resolveScope(folder)
    // Read-only cores hold no home lock: they must not write a shadow a running Dim Factory is snapshotting.
    const r = readOnly
      ? await sizePreflightReadOnly(scope, { home: paths.home })
      : await (await shadowFor(scope, { home: paths.home })).sizePreflight()
    return { files: r.files, bytes: r.bytes, largeFiles: r.largeFiles }
  }

  // ---- config -------------------------------------------------------------------------------------------------
  let onConfigChange: (ev: ConfigChangedEvent) => void = () => undefined
  const configService = new ConfigService({
    paths,
    readOnly,
    log: log.child({ part: 'config' }),
    adapters,
    probeOf: (vendor) => preflightCache.effectiveProbe(adapters.resolveId(vendor)),
    recordProbe: (probe) => preflightCache.setProbe(probe),
    scopeOf,
    folderSize,
    onChange: (ev) => onConfigChange(ev),
    now: clock.now,
  })
  const boot = await configService.init()

  // ---- adapters: Claude from the user file's vendors.claude (re-created when that section changes) ---------
  type VendorCfg = ResolvedConfig['vendors'][string]
  const vendorEnvOf = (cfg: VendorCfg | undefined): Record<string, string> | undefined =>
    cfg !== undefined && Object.keys(cfg.env).length > 0 ? cfg.env : undefined
  // E2E-only hook (DIM_FACTORY_E2E=1 with DIM_FACTORY_E2E_VENDOR_SEARCH=configured): vendor CLIs are
  // looked up only at their `vendors.<id>.path` (the fakes), so an E2E app never finds, probes or runs a real install
  // (a vendor without a path reads "not installed").
  const vendorSearch: 'all' | 'configured' =
    env[envName('E2E')] === '1' && env[envName('E2E_VENDOR_SEARCH')] === 'configured' ? 'configured' : 'all'
  const makeClaude = (cfg: VendorCfg | undefined): ClaudeAdapter => {
    const vendorEnv = vendorEnvOf(cfg)
    return createClaudeAdapter({
      configuredPath: cfg?.path ?? null,
      search: vendorSearch,
      ...(vendorEnv !== undefined ? { vendorEnv } : {}),
      ...(cfg !== undefined && cfg.extraArgs.length > 0 ? { extraArgs: cfg.extraArgs } : {}),
      ...(cfg !== undefined && Object.keys(cfg.flagMap).length > 0 ? { flagMap: cfg.flagMap } : {}),
      env,
      probeCwd: paths.probeCwd,
      now: clock.now,
      onSpawn: (so, child) => controllers.get(so.runId)?.onChildSpawned(so, child),
      // A pass that allows a claude.ai connector not listed yet lists them first (never with a fake CLI's E2E host).
      connectorsOnDemand: vendorSearch === 'all',
    })
  }
  let claudeCfg = boot.vendors['claude']
  let claude = makeClaude(claudeCfg)
  adapters.register(claude)
  // Codex from the user file's vendors.codex, in place of its registry stub (re-created when that section changes).
  const makeCodex = (cfg: VendorCfg | undefined): CodexAdapter => {
    const vendorEnv = vendorEnvOf(cfg)
    return createCodexAdapter({
      configuredPath: cfg?.path ?? null,
      search: vendorSearch,
      ...(vendorEnv !== undefined ? { vendorEnv } : {}),
      ...(cfg !== undefined && cfg.extraArgs.length > 0 ? { extraArgs: cfg.extraArgs } : {}),
      ...(cfg !== undefined && Object.keys(cfg.flagMap).length > 0 ? { flagMap: cfg.flagMap } : {}),
      env,
      probeCwd: paths.probeCwd,
      tmpDir: paths.tmpDir,
      now: clock.now,
      onSpawn: (so, child) => controllers.get(so.runId)?.onChildSpawned(so, child),
    })
  }
  let codexCfg = boot.vendors['codex']
  let codex = makeCodex(codexCfg)
  adapters.register(codex)
  // Gemini (ACP) from the user file's vendors.gemini, in place of its registry stub (re-created when that section
  // changes). Its probe and Dim Factory's own working folders (probe, heal) run with --skip-trust; a user folder only with
  // its trust.json vendorFolder grant (the engine's StartOptions.trustFolder, preflight's ReadinessNeed.trustFolder).
  const makeGemini = (cfg: VendorCfg | undefined): GeminiAdapter => {
    const vendorEnv = vendorEnvOf(cfg)
    return createGeminiAdapter({
      configuredPath: cfg?.path ?? null,
      search: vendorSearch,
      ...(vendorEnv !== undefined ? { vendorEnv } : {}),
      ...(cfg !== undefined && cfg.extraArgs.length > 0 ? { extraArgs: cfg.extraArgs } : {}),
      ...(cfg !== undefined && Object.keys(cfg.flagMap).length > 0 ? { flagMap: cfg.flagMap } : {}),
      env,
      dimFactoryHome: paths.home,
      probeCwd: paths.probeCwd,
      now: clock.now,
      onSpawn: (so, child) => controllers.get(so.runId)?.onChildSpawned(so, child),
    })
  }
  let geminiCfg = boot.vendors['gemini']
  let gemini = makeGemini(geminiCfg)
  adapters.register(gemini)
  // Grok (ACP, `grok agent stdio`) from the user file's vendors.grok, in place of its registry stub (re-created when
  // that section changes). No folder grant: Grok's own folder trust keeps a repository's Grok config out by itself.
  // E2E-only hook (DIM_FACTORY_E2E=1 with DIM_FACTORY_E2E_USER_HOME): the user home Grok's
  // read-only allow-rules scan reads (`~/.claude/settings*.json`), a folder inside the test's root, so an E2E app never
  // reads the developer's own Claude settings.
  const e2eUserHome =
    env[envName('E2E')] === '1' && (env[envName('E2E_USER_HOME')] ?? '') !== ''
      ? env[envName('E2E_USER_HOME')]
      : undefined
  const makeGrok = (cfg: VendorCfg | undefined): GrokAdapter => {
    const vendorEnv = vendorEnvOf(cfg)
    return createGrokAdapter({
      configuredPath: cfg?.path ?? null,
      search: vendorSearch,
      ...(e2eUserHome !== undefined ? { home: e2eUserHome } : {}),
      ...(vendorEnv !== undefined ? { vendorEnv } : {}),
      ...(cfg !== undefined && cfg.extraArgs.length > 0 ? { extraArgs: cfg.extraArgs } : {}),
      ...(cfg !== undefined && Object.keys(cfg.flagMap).length > 0 ? { flagMap: cfg.flagMap } : {}),
      env,
      dimFactoryHome: paths.home,
      probeCwd: paths.probeCwd,
      now: clock.now,
      onSpawn: (so, child) => controllers.get(so.runId)?.onChildSpawned(so, child),
    })
  }
  let grokCfg = boot.vendors['grok']
  let grok = makeGrok(grokCfg)
  adapters.register(grok)
  // Muse (`muse exec`, no relay) from the user file's vendors.muse, in place of its registry stub (re-created when
  // that section changes). Experimental (the registry's EXPERIMENTAL_VENDORS) and in no built-in profile. It runs
  // in a user folder only with its vendorFolder grant (`--trust-workspace`); its prompt file goes under runs/<id>/prompts.
  const makeMuse = (cfg: VendorCfg | undefined): MuseAdapter => {
    const vendorEnv = vendorEnvOf(cfg)
    return createMuseAdapter({
      configuredPath: cfg?.path ?? null,
      search: vendorSearch,
      ...(vendorEnv !== undefined ? { vendorEnv } : {}),
      ...(cfg !== undefined && cfg.extraArgs.length > 0 ? { extraArgs: cfg.extraArgs } : {}),
      ...(cfg !== undefined && Object.keys(cfg.flagMap).length > 0 ? { flagMap: cfg.flagMap } : {}),
      env,
      dimFactoryHome: paths.home,
      probeCwd: paths.probeCwd,
      now: clock.now,
      onSpawn: (so, child) => controllers.get(so.runId)?.onChildSpawned(so, child),
    })
  }
  let museCfg = boot.vendors['muse']
  let muse = makeMuse(museCfg)
  adapters.register(muse, { experimental: true })

  // ---- Extensions: what each vendor's own settings define (names only, read in memory, never logged) ------------
  // Read with the env the vendor's child gets (vendors.<id>.env), and in an E2E app under its test user home.
  const extensionsEnvFor = (vendor: string): Record<string, string | undefined> => {
    const cfg =
      vendor === 'claude'
        ? claudeCfg
        : vendor === 'codex'
          ? codexCfg
          : vendor === 'gemini'
            ? geminiCfg
            : undefined
    return { ...env, ...(cfg?.env ?? {}) }
  }
  const extensionsHome = e2eUserHome ?? homedir()
  const extensionNames = async (
    vendor: string,
    folder: string | undefined,
  ): Promise<{ mcp: string[]; complete: boolean } | null> => {
    const d = discoverVendor(vendor, { envFor: extensionsEnvFor, home: extensionsHome, folder })
    if (d === null) return null
    const mcp = d.mcp.map((m) => m.name)
    // Claude: an allowed name may be a claude.ai connector. They are listed once per app session (no tokens, only
    // where that starts no other MCP server), as a pass that allows one would.
    if (vendor === 'claude' && vendorSearch === 'all') {
      const listed =
        claude.listedConnectors() ?? (await claude.listConnectors().then((r) => (r.ok ? r.connectors : [])))
      for (const c of listed ?? []) if (!mcp.includes(c.name)) mcp.push(c.name)
    }
    return { mcp, complete: d.complete }
  }

  const bus = new EventBus({ home: paths, log: log.child({ part: 'bus' }), app: APP_NAME, now: clock.now })
  // AppEvent `probe`: every stored probe result (first launch, vendors.probe, a preflight probe) reaches the
  // vendor health rows without the page asking again.
  preflightCache.onProbe((r) => {
    const vendor = adapters.resolveId(r.vendor)
    bus.global({ kind: 'probe', vendor, view: probeView(adapters, vendor, r) })
  })
  const scheduler = new FolderScheduler({ now: clock.now })
  // The Runs history's pins and pending removals (runs/history.json), checked by every list and index write.
  const historyState = await HistoryState.load(paths, { readOnly })
  // Estimates frozen at run start (estimate.json) of the runs this process knows: the live ETA.
  const runEstimates = new Map<string, RunEstimate>()
  // Each known run's frozen prices (resolved.json `pricingRef`, the pricing it used
  // used"): its passes are costed at these, so an apply, an Undo or a manual price mid-run never reprices it.
  const runPricing = new Map<string, PricingRef | null>()
  // Live balanced run: each known run's expected model per pass and vendor (StepView.expectedModel), the probe's
  // default when the run first needed it and the probe knew it (its start, for a run this process starts), so a re-probe
  // mid-run never changes the model a queued pass names.
  const runExpectedModels = new Map<string, Map<string, string>>()
  // The Fix vendor's resume capabilities (RunSummary.rerunFromFix), set once the probe cache exists below.
  let fixCapabilities: (state: RunState) => SessionCapabilities | undefined = () => undefined
  const summarize = (state: RunState): RunSummary => {
    const caps = fixCapabilities(state)
    const s = toRunSummary(state, clock.now(), {
      estimate: runEstimates.get(state.runId) ?? null,
      ...(caps !== undefined ? { fixCapabilities: caps } : {}),
    })
    s.pinned = historyState.isPinned(state.runId)
    if (state.lock === 'requested') {
      const blocker = scheduler.blockedBy(state.runId)
      if (blocker !== undefined) s.blockedBy = blocker.runId
    }
    return s
  }
  // A queued run's `blockedBy` ("Queued · blocked by run #N") is the scheduler's, not part of the run's
  // state: it changes when another run takes or releases the folder while the queued run itself stays the same. After
  // every structural summary, the queued runs whose blocker changed are published again.
  const publishedBlocker = new Map<string, string | undefined>()
  // A live run's ETA changes rule when an active step crosses its p50 or p80 ("longer than
  // usual" past p80). Nothing else republishes a run in a quiet stretch, so one timer per live run does, re-armed
  // whenever its summary is published.
  const etaTimers = new Map<string, { timer: TimerHandle; due: number }>()
  const armEtaTimer = (idx: IndexStore, runId: string): void => {
    const c = controllers.get(runId)
    const now = clock.now()
    const next = c !== undefined ? runEtaOf(c.state, runEstimates.get(runId), now)?.nextChangeMs : undefined
    const prev = etaTimers.get(runId)
    const due = next !== undefined ? now + next + 1 : undefined
    // A streaming step publishes many summaries with the same crossing ahead: keep the armed timer then.
    if (prev !== undefined && due !== undefined && Math.abs(prev.due - due) < 100) return
    if (prev !== undefined) clock.clearTimer(prev.timer)
    etaTimers.delete(runId)
    if (due === undefined) return
    const timer = clock.setTimer(() => {
      etaTimers.delete(runId)
      const live = controllers.get(runId)
      if (live !== undefined) putSummary(idx, summarize(live.state), true)
    }, due)
    ;(timer as { unref?: () => void }).unref?.()
    etaTimers.set(runId, { timer, due })
  }
  const putSummary = (idx: IndexStore, s: RunSummary, debounced: boolean): void => {
    publishedBlocker.set(s.runId, s.blockedBy)
    armEtaTimer(idx, s.runId)
    if (debounced) {
      idx.putDebounced(s)
      return
    }
    void idx.put(s).catch((err: unknown) => log.error('index put failed', { err }))
    for (const c of controllers.values()) {
      if (c.runId === s.runId || c.state.lock !== 'requested') continue
      const queued = summarize(c.state)
      if (publishedBlocker.get(c.runId) === queued.blockedBy) continue
      publishedBlocker.set(c.runId, queued.blockedBy)
      void idx.put(queued).catch((err: unknown) => log.error('index put failed', { err }))
    }
  }
  // The estimates' data: every finished run's steps, kept current from the index's own changes.
  const estimates = new EstimateAggregate()
  // Set once the match service exists: a side's summary may mean the other side is due to start.
  let onMatchSummary: (s: RunSummary) => void = () => undefined
  const index = readOnly
    ? null
    : await IndexStore.open(paths, {
        log: log.child({ part: 'index' }),
        summarize: (doc) =>
          isPlainObject(doc['state']) ? toRunSummary(doc['state'] as unknown as RunState) : null,
        // Pins kept and removed runs left out, a rebuild included.
        overlay: (s) => historyState.overlay(s),
        onChange: (c) => {
          if (c.op === 'put') {
            bus.global({ kind: 'run-summary', summary: c.summary })
            onMatchSummary(c.summary)
          }
          try {
            estimates.apply(c)
          } catch (err) {
            log.warn('estimates update failed', { err })
          }
        },
      })
  const roIndex = readOnly ? await readIndexReadOnly(paths, historyState) : null
  // A damaged or unreadable runs/history.json takes its pins from the index before anything writes a
  // summary (recovery below puts summaries through `summarize`), so no pin is lost and no pinned run is deleted.
  if (historyState.degraded !== undefined) {
    log.warn('runs/history.json could not be used; pins are taken from the runs index', {
      kind: historyState.degraded.kind,
      err: historyState.degraded.error,
    })
    const listed = index?.list() ?? [...(roIndex?.values() ?? [])]
    historyState.adoptPins(
      listed.filter((s) => s.pinned).map((s) => s.runId),
      clock.now(),
    )
  }
  // The index lists newest first; putAll sorts, so the boot build stays O(n log n) on the main process.
  estimates.putAll(index?.list() ?? roIndex?.values() ?? [])

  // ---- preflight --------------------------------------------------------------------------------------------
  const statusOf = (runId: string): Pick<FolderLockInfo, 'displayNo' | 'status'> | undefined => {
    const live = controllers.get(runId)?.state
    if (live !== undefined) return { displayNo: live.displayNo, status: live.status }
    const s = index?.get(runId) ?? roIndex?.get(runId)
    return s !== undefined ? { displayNo: s.displayNo, status: s.status } : undefined
  }
  const lockQuery =
    (ignore?: string) =>
    async (folder: string): Promise<FolderLockInfo | null> => {
      const scope = await scopeOf(folder).catch(() => undefined)
      if (scope === undefined) return null
      const blocker = scheduler.blockerFor(scope.lockKey, ignore)
      if (blocker === undefined) return null
      const st = statusOf(blocker.runId)
      return {
        runId: blocker.runId,
        displayNo: st?.displayNo ?? 0,
        status: st?.status ?? (blocker.state === 'queued' ? 'queued' : 'running'),
        since: blocker.since,
      }
    }
  const preflightDeps: PreflightDeps = {
    adapters,
    home: paths.home,
    now: clock.now,
    recheckAuth: authRecheckers({
      // The current adapter and vendors.claude.env (both change when the user file's vendors.claude does).
      claude: (vendor, ro) => {
        const vendorEnv = vendorEnvOf(claudeCfg)
        return claudeAuthRechecker(claude, {
          env,
          ...(vendorEnv !== undefined ? { vendorEnv } : {}),
          now: clock.now,
        })(vendor, ro)
      },
      // `codex login status` with the current adapter (vendors.codex.env), token-free. The registered one: the
      // adapter a pass runs with is the adapter whose login is checked (an adapter without the check keeps its probe).
      codex: (_vendor, ro) => {
        const a = adapters.get('codex')
        return a !== undefined && 'recheckAuth' in a && typeof a.recheckAuth === 'function'
          ? (a as CodexAdapter).recheckAuth(ro)
          : Promise.resolve([])
      },
    }),
    gitFacts: (folder, fo) =>
      gitFactsFor(folder, fo.timeoutMs !== undefined ? { timeoutMs: fo.timeoutMs } : {}),
    folderSize: (folder) => folderSize(folder),
    hasLargeFolderGrant: (folder, size) => configService.hasLargeFolderGrant(folder, size),
    trustGrants: (folder) => configService.trustGrants(folder),
    extensionNames,
    lockQuery: lockQuery(),
    scopeRoot: async (folder) => (await scopeOf(folder)).scopeRoot,
    // run.memory: the memory file at the project root (else the repository's).
    memoryRoot: async (folder) => {
      const snap = await configService.snapshot({ folder }).catch(() => null)
      return snap?.loaded.projectRoot ?? (await scopeOf(folder)).scopeRoot
    },
    // run.isolation.worktree (the composer warns "N uncommitted changes not included"):
    // the folder's eligibility, and how many uncommitted changes an isolated run would leave out (reads only).
    worktreeEligibility: async (folder) => {
      const [e, uncommitted] = await Promise.all([
        checkEligibility(folder, { home: paths.home }),
        uncommittedCount(folder).catch(() => undefined),
      ])
      return uncommitted !== undefined ? { ...e, uncommitted } : e
    },
  }
  const engine = createPreflightEngine(preflightDeps, { cache: preflightCache })

  // ---- recovery actions (and the probe cache they invalidate) -----------------------------------------------------
  // recovery.execute looks a folder's actions up in its latest preflight report; a pass failing with a
  // vendor-scoped category (its snag) marks that vendor's probe stale.
  const recoveryActions = new RecoveryActionStore()
  bus.attach(
    vendorFailureSink({
      vendorOf: (runId, step) => controllers.get(runId)?.state.steps[step].vendor,
      resolveId: (v) => adapters.resolveId(v),
      invalidateVendor: (v) => engine.cache.invalidateVendor(v),
    }),
  )
  /** After `git init`: the folder's (and its subfolders') cached scope and last report no longer hold. */
  const forgetFolder = (folder: string): void => {
    const key = folderStoreKey(folder)
    for (const k of [...scopes.keys()]) {
      const kk = folderStoreKey(k)
      if (kk === key || kk.startsWith(`${key}${sep}`)) scopes.delete(k)
    }
    recoveryActions.forget(folder)
  }
  /**
   * vendors.setPath: only the picked file is examined, with a launch's env. Claude, Codex, Gemini, Grok.
   */
  const validateVendorPath = (vendor: string, path: string): Promise<VendorPathCheck> | null => {
    // Muse too.
    const built = {
      claude: { cfg: claudeCfg, spec: claudeCliSpec },
      codex: { cfg: codexCfg, spec: codexCliSpec },
      gemini: { cfg: geminiCfg, spec: geminiCliSpec },
      grok: { cfg: grokCfg, spec: grokCliSpec },
      muse: { cfg: museCfg, spec: museCliSpec },
    } as const
    if (!Object.hasOwn(built, vendor)) return null
    const { cfg, spec } = built[vendor as keyof typeof built]
    const vendorEnv = vendorEnvOf(cfg)
    return resolvePathEnv({ env }).then((pe) =>
      validateCliPath(spec, path, {
        env,
        pathEnv: pe.path,
        ...(vendorEnv !== undefined ? { vendorEnv } : {}),
      }),
    )
  }

  // ---- config changes (watcher, config.* writes) ------------------------------------------------------------
  // `config-changed` drops the cached run/pass/folder checks and tells the renderer to re-resolve. A changed
  // vendors.claude re-creates the Claude adapter for the next probe and spawn (a run in flight keeps its process).
  const refreshUserVendors = async (): Promise<void> => {
    const load = await configService.reloadUser()
    if (load.exists && load.value === undefined) return // invalid: keep the adapter; app.config.user blocks runs
    const vendors = vendorSettings(load).vendors
    const next = vendors['claude']
    if (JSON.stringify(next ?? null) !== JSON.stringify(claudeCfg ?? null)) {
      claudeCfg = next
      claude = makeClaude(claudeCfg)
      adapters.register(claude)
      engine.cache.invalidateVendor('claude')
      log.info('vendors.claude changed; the Claude adapter was re-created')
    }
    const nextCodex = vendors['codex']
    if (JSON.stringify(nextCodex ?? null) !== JSON.stringify(codexCfg ?? null)) {
      codexCfg = nextCodex
      codex = makeCodex(codexCfg)
      adapters.register(codex)
      engine.cache.invalidateVendor('codex')
      log.info('vendors.codex changed; the Codex adapter was re-created')
    }
    const nextGemini = vendors['gemini']
    if (JSON.stringify(nextGemini ?? null) !== JSON.stringify(geminiCfg ?? null)) {
      geminiCfg = nextGemini
      gemini = makeGemini(geminiCfg)
      adapters.register(gemini)
      engine.cache.invalidateVendor('gemini')
      log.info('vendors.gemini changed; the Gemini adapter was re-created')
    }
    const nextGrok = vendors['grok']
    if (JSON.stringify(nextGrok ?? null) !== JSON.stringify(grokCfg ?? null)) {
      grokCfg = nextGrok
      grok = makeGrok(grokCfg)
      adapters.register(grok)
      engine.cache.invalidateVendor('grok')
      log.info('vendors.grok changed; the Grok adapter was re-created')
    }
    const nextMuse = vendors['muse']
    if (JSON.stringify(nextMuse ?? null) !== JSON.stringify(museCfg ?? null)) {
      museCfg = nextMuse
      muse = makeMuse(museCfg)
      adapters.register(muse, { experimental: true })
      engine.cache.invalidateVendor('muse')
      log.info('vendors.muse changed; the Muse adapter was re-created')
    }
  }
  // One refresh at a time, in order: vendors.setPath awaits a refresh that starts after its own save.
  let vendorsSync: Promise<void> = Promise.resolve()
  const syncUserVendors = (): Promise<void> => {
    const next = vendorsSync.catch(() => undefined).then(refreshUserVendors)
    vendorsSync = next
    return next
  }
  onConfigChange = (ev) => {
    engine.cache.invalidateConfig()
    bus.global({
      kind: 'config-changed',
      scope: ev.scope,
      ...(ev.folder !== undefined ? { folder: ev.folder } : {}),
    })
    if (ev.scope === 'user') {
      void syncUserVendors().catch((err: unknown) => log.warn('user config reload failed', { err }))
    }
  }

  // ---- catalog and cost ---------------------------------------------------------------------------------
  // Writable cores load catalog/{pricing,models}.json once (seeded from pricing.seed.json on first use); a pass's
  // cost is frozen at its `done`. Read-only cores never price anything and must not write the seed.
  // The catalog is live (catalog/live.ts): an apply, a manual price or an Undo replaces it in memory as it
  // commits, so every cost, estimate, pricingRef and model picker below reads the new prices from the next call on
  // (`catalogData()` is read per call; nothing caches prices).
  const catalogSettings = (): {
    refresh: { enabled: boolean; intervalDays: number; vendor: string; model: string | null }
    notifyCatalog: boolean
  } => {
    const user = configService.user?.value
    const builtin = BUILTIN_DEFAULTS.catalog.refresh
    const r = user?.catalog?.refresh
    return {
      refresh: {
        enabled: r?.enabled ?? builtin.enabled,
        intervalDays: r?.intervalDays ?? builtin.intervalDays,
        vendor: r?.vendor ?? builtin.vendor,
        model: r?.model !== undefined ? r.model : builtin.model,
      },
      notifyCatalog: user?.notifications?.events?.catalog ?? BUILTIN_DEFAULTS.notifications.events.catalog,
    }
  }
  const catalogLive = readOnly
    ? undefined
    : new CatalogLive({
        paths,
        clock,
        log: log.child({ part: 'catalog' }),
        settings: catalogSettings,
        patchUserConfig: async (ops) => {
          await configService.patch({ scope: 'user', ops })
          await configService.reloadUser()
        },
        cliModels: (vendor) => probeOf(vendor)?.models,
        emit: (ev) => bus.global(ev),
        notify: () => o.host.notifyCatalog?.(),
      })
  if (catalogLive !== undefined) {
    try {
      await catalogLive.load()
    } catch (err) {
      log.warn('catalog unavailable; costs fall back to vendor figures', { err })
    }
  }
  const catalogData = (): CatalogData | undefined => catalogLive?.data()
  const probeOf = (vendor: string): ProbeResult | undefined =>
    engine.cache.vendor(adapters.resolveId(vendor))?.probe
  /** The concrete model a configured one runs as: a CLI alias (`opus`) or `null` (the CLI default) resolved. */
  const concreteModel = (vendor: string, model: string | null): string | null => {
    const models = probeOf(vendor)?.models ?? []
    const m = model === null ? models.find((x) => x.isDefault === true) : models.find((x) => x.id === model)
    if (m === undefined) return model
    // Claude lists its default as the pseudo-model `default` (the concrete id, when known, is its alias); Codex's
    // model/list marks a real model id `isDefault`, which is the model the CLI default runs (`model: null`
    // resolves to the probe's isDefault model).
    return m.aliases?.[0] ?? (model === null && m.id === 'default' ? null : m.id)
  }
  /**
   * Subscription auth (a Claude.ai or a ChatGPT login): any dollar figure is what the tokens would cost on the
   * API ("API-equiv.").
   */
  const subscriptionAuth = (probe: ProbeResult | undefined): boolean => isSubscriptionAuth(probe?.account)
  /**
   * A pass's cost at its end. Priced at the run's own frozen prices (`ref`, its pricingRef) for the model
   * it recorded; the live catalog only for a model the run recorded no price for (a model switched mid-run). A catalog
   * figure carries the facts its labels show (when those prices were fetched, their confidence, stale then).
   */
  const passCost = (i: CostInput, ref: PricingRef | null = null): StepCost => {
    // A local preset's pricing is 0: a local model costs nothing.
    if (localPresetIdOf(i.vendor) !== null) return { usd: 0, basis: 'catalog', apiEquivalent: false }
    const probe = probeOf(i.vendor)
    const vendor = adapters.resolveId(i.vendor)
    const model = concreteModel(i.vendor, i.model)
    const requested = i.model ?? concreteModel(i.vendor, null)
    const price = runPassPrice(ref, catalogData(), vendor, requested, model)
    const c = costForUsage(i.usage, {
      priceEntry: price,
      reasoningIncludedInOutput: probe?.capabilities.reasoningIncludedInOutput ?? true,
      subscription: subscriptionAuth(probe),
      usageApprox: i.usageApprox,
      intervalDays: catalogSettings().refresh.intervalDays,
      now: i.at,
    })
    const out = toStepCost(c)
    if (c.basis === 'catalog' && c.pricingFetchedAt !== undefined && c.confidence !== undefined) {
      out.pricing = {
        fetchedAt: c.pricingFetchedAt,
        confidence: c.confidence,
        stale: c.pricingStale === true,
      }
    }
    return out
  }
  /** The model's context window when the CLI or the catalog knows it; null → the 200,000-token assumption. */
  const contextWindow = (vendor: string, model: string | null): number | null => {
    const concrete = concreteModel(vendor, model)
    const probeHit = probeOf(vendor)?.models.find(
      (x) => (x.id === model || x.id === concrete) && x.contextWindow !== undefined,
    )
    if (probeHit?.contextWindow !== undefined) return probeHit.contextWindow
    const catalog = catalogData()
    if (catalog === undefined || concrete === null) return null
    const id = adapters.resolveId(vendor)
    const cid = resolveModelId(catalog.models, id, concrete) ?? concrete
    const hit = catalog.models.vendors[id]?.models.find((x) => x.id === cid)
    return hit?.contextWindow ?? null
  }

  // ---- estimates and spend ---------------------------------------------------------------------------------------
  /** The rates a pass's tokens are estimated at (current catalog; `model: null` = the probe's default model). */
  const estimatePrice: PriceLookup = (vendor, model) => {
    // A local preset's tokens are free (and Codex's default model is not the one it runs).
    if (localPresetIdOf(vendor) !== null)
      return { rates: LOCAL_PRESET_RATES, reasoningIncludedInOutput: true }
    const concrete = concreteModel(vendor, model)
    if (concrete === null) return { missing: `${vendor}/default` }
    const catalog = catalogData()
    const entry = catalog !== undefined ? lookupPrice(catalog, adapters.resolveId(vendor), concrete) : null
    if (entry === null) return { missing: `${vendor}/${model ?? concrete}` }
    return {
      rates: entry,
      reasoningIncludedInOutput: probeOf(vendor)?.capabilities.reasoningIncludedInOutput ?? true,
    }
  }
  const estimateFor = (config: ResolvedConfig, folderKey: string | null, testFirst = false): RunEstimate =>
    estimateRun(estimates, {
      config: testFirst ? { ...config, testFirst: true } : config,
      folderKey,
      price: estimatePrice,
    })
  /** A step's final-attempt cost for the spend-by-vendor split: the vendor's figure, else the catalog's. */
  const spendPricing: SpendPricing = {
    stepUsd: (row) => {
      const u = row.usage
      if (u === undefined || row.usageApprox === true) return null
      if (row.costBasis === 'vendor') return u.costUsd ?? null
      if (row.costBasis !== 'catalog' || row.vendor === undefined) return null
      const p = estimatePrice(row.vendor, row.model ?? null)
      return 'rates' in p ? catalogCostUsd(u, p.rates, p.reasoningIncludedInOutput) : null
    },
    apiEquivalent: (vendor) => subscriptionAuth(probeOf(vendor)),
  }

  /** StepView.modeCopy: `adapter.support(need)` for each enabled pass, with the need the spawn uses. */
  const modeCopyOf = (state: RunState): Partial<Record<StepKey, Support>> => {
    const out: Partial<Record<StepKey, Support>> = {}
    // Live balanced run: copy that depends on how a pass was launched (Claude's shell tool cut) is read from the argv a
    // started pass ran with; only a pass not started yet reads the settings of the folder it will spawn in.
    const cwd = workFolderOf(state.folder, state.isolation)
    for (const p of AGENT_STEPS) {
      // Test-first's Tests step runs as the Implement pass (and only in a Test-first run); Clarify as the Plan pass
      // (only when the run asks).
      if (p === 'tests' && state.config.testFirst !== true) continue
      if (p === 'clarify' && state.config.clarify === undefined) continue
      if (p === 'research' && state.config.research === undefined) continue
      // The acceptance review and Explain only in a run that uses them.
      if (p === 'acceptance' && state.config.acceptance !== true) continue
      if (p === 'explain' && state.config.explain !== true) continue
      const pass = configPassOf(p, state.config.passes)
      const pc = state.config.passes[pass]
      if (!pc.enabled) continue
      const st = state.steps[p]
      const adapter = adapters.get(st.vendor ?? pc.vendor)
      if (adapter === undefined) continue
      // Research runs confined (Dim Factory's own copy: no adapter has a mode row for it).
      if (p === 'research') {
        out[p] = researchSupport(state.config.research?.web === true)
        continue
      }
      out[p] = adapter.support({
        pass,
        mode: st.mode ?? pc.mode,
        planNative: p === 'plan' && (st.planMode ?? state.config.planMode) === 'native',
        trustFolder: false,
        cwd,
        ...(st.argv !== undefined ? { argv: st.argv } : {}),
        // The acceptance review and Explain run with none of the user's extensions, whatever their pass allows.
        ...(p === 'acceptance' || p === 'explain'
          ? { extensions: 'none' as const }
          : pc.extensions !== undefined
            ? { extensions: pc.extensions }
            : {}),
      })
    }
    return out
  }
  /**
   * The model a pass that names none is expected to run on `vendor`, frozen for the run (runExpectedModels) once known:
   * a probe that has not answered yet (a run loaded at launch) freezes nothing, so a later answer still counts.
   */
  const frozenExpected = (runId: string, pass: PassName, vendor: string): string | null => {
    let run = runExpectedModels.get(runId)
    if (run === undefined) {
      run = new Map()
      runExpectedModels.set(runId, run)
    }
    const key = `${pass}:${vendor}`
    const frozen = run.get(key)
    if (frozen !== undefined) return frozen
    const now = concreteModel(vendor, null)
    if (now !== null && now !== '') run.set(key, now)
    return now
  }
  /**
   * StepView.expectedModel (live balanced run): for each enabled pass that names no model and still awaits its vendor's
   * word (derive.ts awaitsModelWord: queued, or running on a route that says which model it runs before its turn and
   * has not said yet), the model it is expected to run, the one its estimate is priced at (the probe's default for the
   * account, frozen for the run), so the card names it before the pass starts and the vendor's word at the start
   * (modelUsed) confirms it. A pass that has ended, or has started where its vendor never says, expects nothing. Not a
   * local preset's pass: it runs its preset's model and its card keeps "default model" (no vendor word follows).
   */
  const expectedModelOf = (state: RunState): Partial<Record<StepKey, string>> => {
    const out: Partial<Record<StepKey, string>> = {}
    const status = deriveStatus(state)
    if (status === 'completed' || status === 'cancelled') return out
    for (const p of AGENT_STEPS) {
      if (p === 'tests' && state.config.testFirst !== true) continue
      if (p === 'clarify' && state.config.clarify === undefined) continue
      if (p === 'research' && state.config.research === undefined) continue
      // The acceptance review and Explain only in a run that uses them.
      if (p === 'acceptance' && state.config.acceptance !== true) continue
      if (p === 'explain' && state.config.explain !== true) continue
      const pass = configPassOf(p, state.config.passes)
      const pc = state.config.passes[pass]
      const st = state.steps[p]
      if (!pc.enabled || (st.model !== undefined ? st.model : pc.model) !== null) continue
      const vendor = st.vendor ?? pc.vendor
      if (localPresetIdOf(vendor) !== null) continue
      if (!awaitsModelWord(st, st.route ?? probeOf(vendor)?.route)) continue
      const expected = frozenExpected(state.runId, pass, vendor)
      if (expected !== null && expected !== '') out[p] = expected
    }
    return out
  }
  /** A vendor's display name for host-facing text ("Claude needs approval"). */
  const vendorName = (vendor: string): string =>
    adapters.get(vendor)?.displayName ?? (isKnownVendor(vendor) ? VENDOR_DISPLAY_NAMES[vendor] : vendor)
  /**
   * The Fix vendor's resume capabilities as probed now, which a Re-run from Fix records in its resolved.json and
   * decides its session with (RunSnapshot.rerunFromFix).
   */
  const fixCapabilitiesOf = (state: RunState): SessionCapabilities | undefined => {
    const caps = probeOf(state.config.passes.fix.vendor)?.capabilities
    return caps !== undefined ? { resume: caps.resume, resumeModelSwitch: caps.resumeModelSwitch } : undefined
  }
  fixCapabilities = fixCapabilitiesOf
  const viewInputs = (state: RunState): RunViewInputs => {
    const fixCapabilities = fixCapabilitiesOf(state)
    return {
      estimate: runEstimates.get(state.runId) ?? null,
      modeCopy: modeCopyOf(state),
      expectedModel: expectedModelOf(state),
      ...(fixCapabilities !== undefined ? { fixCapabilities } : {}),
    }
  }

  // ---- switch_vendor readiness, the healer, each run's recovery facts --------------------------------------------
  const vendorReadiness: VendorReadiness = {
    vendors: () =>
      adapters.list().map((e) => ({
        id: e.id,
        displayName: e.adapter.displayName,
        built: e.built,
        // An Experimental vendor (Muse) is never a switch target.
        ...(e.experimental ? { experimental: true } : {}),
      })),
    readyFor: (vendor: string, pass: PassName, mode: Mode): Readiness => {
      const name = vendorName(vendor)
      const adapter = adapters.get(vendor)
      if (adapter === undefined || !adapters.isBuilt(vendor)) {
        return { ok: false, reason: `${name} is not available in this build.` }
      }
      const probe = engine.cache.effectiveProbe(adapters.resolveId(vendor))
      if (probe === undefined) return { ok: false, reason: `${name} has not been checked yet.` }
      const blocker = probe.checks.find((c) => c.status === 'fail' && c.blocking)
      if (blocker !== undefined) return { ok: false, reason: `${name} is not ready: ${blocker.title}.` }
      const support = adapter.support({ pass, mode, planNative: false, trustFolder: false })
      if (support.status === 'unsupported') {
        // The adapter's human copy, never its reason code (winSandbox-notConfigured stays in logs).
        return {
          ok: false,
          reason: sentences(`${name} cannot run ${stepLabel(pass)} this way`, support.copy),
        }
      }
      return { ok: true }
    },
  }
  /**
   * Whether a vendor can run a read-only, Dim Factory-owned pass now (the catalog refresh X17, the healer): built,
   * its effective probe without a blocking failure, and `support({pass, mode:'readonly'})` not unsupported. A vendor
   * not probed yet counts as ready (its own job reports what fails). `web`: the pass searches the web.
   */
  const readOnlyReady = (
    vendor: string,
    pass: 'catalog' | 'heal',
    o: { web?: boolean } = {},
  ): { ok: true } | { ok: false; reason: string; unbuilt?: boolean } => {
    const name = vendorName(vendor)
    const adapter = adapters.get(vendor)
    if (adapter === undefined || !adapters.isBuilt(vendor)) {
      return { ok: false, reason: `${name} is not available in this build.`, unbuilt: true }
    }
    const probe = engine.cache.effectiveProbe(adapters.resolveId(vendor))
    if (probe === undefined) return { ok: true }
    const blocker = probe.checks.find((c) => c.status === 'fail' && c.blocking)
    if (blocker !== undefined) return { ok: false, reason: `${name} is not ready: ${blocker.title}.` }
    if (o.web === true && !probe.capabilities.web) {
      return { ok: false, reason: `${name} cannot search the web from Dim Factory.` }
    }
    const support = adapter.support({
      pass,
      mode: 'readonly',
      planNative: false,
      trustFolder: false,
      ...(o.web === true ? { web: true } : {}),
    })
    if (support.status === 'unsupported') {
      return { ok: false, reason: sentences(`${name} cannot run this read-only pass`, support.copy) }
    }
    return { ok: true }
  }
  /** `vendors.<id>.flagMap` as the vendor's adapter was made with it (Claude, Codex), else the user file's now. */
  const vendorFlagMap = (vendor: string): Readonly<Record<string, string>> | undefined =>
    vendor === 'claude'
      ? claudeCfg?.flagMap
      : vendor === 'codex'
        ? codexCfg?.flagMap
        : vendor === 'gemini'
          ? geminiCfg?.flagMap
          : vendor === 'grok'
            ? grokCfg?.flagMap
            : vendor === 'muse'
              ? museCfg?.flagMap
              : configService.user?.value?.vendors?.[vendor]?.flagMap
  /** The user's selfHeal settings now (Settings → Self-heal applies to the next heal). */
  const selfHealSettings = (): HealerDeps['selfHeal'] => {
    const u = configService.user?.value?.selfHeal
    const b = BUILTIN_DEFAULTS.selfHeal
    return {
      enabled: u?.enabled ?? b.enabled,
      vendor: u?.vendor ?? b.vendor,
      model: u?.model !== undefined ? u.model : b.model,
      autoApplyConfigPatches: u?.autoApplyConfigPatches ?? b.autoApplyConfigPatches,
    }
  }
  const healApi: HealApi | undefined =
    o.heal === null || readOnly
      ? undefined
      : (o.heal ?? {
          diagnose: (req) =>
            runHealer(
              {
                home: paths.home,
                registry: adapters,
                selfHeal: selfHealSettings(),
                probe: (vendor) => Promise.resolve(probeOf(vendor) ?? null),
                // The selfHeal vendor, else the first ready of Claude and Codex; ready =
                // its launch probe passing (probed now when it has none) and the read-only heal pass supported.
                isReady: async (vendor) => {
                  const adapter = adapters.get(vendor)
                  if (adapter === undefined || !adapters.isBuilt(vendor)) return false
                  if (engine.cache.effectiveProbe(adapters.resolveId(vendor)) === undefined) {
                    engine.recordProbe(await adapter.probe())
                  }
                  return readOnlyReady(vendor, 'heal').ok
                },
                flagMap: (vendor) => vendorFlagMap(vendor),
                now: clock.now,
                log: log.child({ part: 'heal' }),
              },
              req,
            ),
          tail: (file) => readHealTail(file),
        })
  // The recovery guard's vendor rules (adapters/vendor-args.ts): Claude's, and Gemini's and Grok's ACP rules.
  const controllerRecovery: ControllerRecovery = {
    ...(healApi !== undefined ? { heal: healApi } : {}),
    vendorName,
    testedUpTo: (vendor) => {
      const t = adapters.get(vendor)?.testedUpTo
      return t !== undefined && t !== '' ? t : undefined
    },
    vendorVersion: (vendor) => probeOf(vendor)?.version ?? null,
    // Live balanced run: the account's default (Codex's model/list `isDefault`), which model_unavailable offers a
    // pass with no model whose vendor may run another (ACCOUNT_DEFAULT_VENDORS: never Gemini, whose default is the model
    // such a pass ran, nor a local preset).
    accountDefaultModel: (vendor) =>
      accountDefaultMayDiffer(vendor)
        ? probeOf(vendor)?.models.find((x) => x.isDefault === true && x.source === 'cli')?.id
        : undefined,
    switchTarget: (vendor, pass, mode) => switchTargetFor(vendor, pass, mode, vendorReadiness),
    managedFlags: () => configService.managedFlags(),
    autoApplyConfigPatches: () => selfHealSettings().autoApplyConfigPatches,
    vendorArgs: vendorArgsCheck,
  }

  /** Test-first's template a run recorded in resolved.json (absent: none, or not a Test-first run). */
  const testsTemplateOf = (
    resolvedDoc: Record<string, unknown> | undefined,
  ): ResolvedTemplate | undefined => {
    const r = ResolvedTemplateZ.safeParse(resolvedDoc?.['testsTemplate'])
    return r.success ? r.data : undefined
  }

  /** The optional steps' templates a run recorded in resolved.json (absent: a run made before they could be overridden). */
  const stepTemplatesOf = (resolvedDoc: Record<string, unknown> | undefined): StepTemplates | undefined => {
    const raw = resolvedDoc?.['stepTemplates']
    if (!isPlainObject(raw)) return undefined
    const out: StepTemplates = {}
    for (const [k, v] of Object.entries(raw)) {
      const r = ResolvedTemplateZ.safeParse(v)
      if (isStepPromptName(k) && r.success) out[k] = r.data
    }
    return out
  }

  /** The brief a run was made with (its resolved.json record), or null without one. */
  const runBriefInput = async (runId: string): Promise<BriefInput | null> => {
    const r = await readVersionedJson(paths.run(runId).resolvedJson).catch(() => null)
    if (r === null || r.kind !== 'ok' || !isPlainObject(r.value)) return null
    const rec = r.value['brief']
    const parsed = BriefInputZ.safeParse(isPlainObject(rec) ? rec['input'] : undefined)
    return parsed.success ? parsed.data : null
  }
  /** The Deploy step's planning for a run: the folder's packs, the run's brief and task (deploy/report.ts). */
  const deployPlanner = (scopeFolder: string): ControllerDeploy => ({
    plan: async ({ folder, target, state }) =>
      planDeploy({
        folder,
        packs: (await loadPacks({ home: paths.home, folder: scopeFolder })).packs.map((v) => v.pack),
        brief: await runBriefInput(state.runId),
        task: state.task,
        target,
      }),
  })

  // ---- the Brief ---------------------------------------------------------------------------------------------------
  /** A vendor ready for a read-only, tool-less call (the healer's readiness; probed now when it has no probe). */
  const readOnlyCallReady = async (vendor: string): Promise<boolean> => {
    const adapter = adapters.get(vendor)
    if (adapter === undefined || !adapters.isBuilt(vendor)) return false
    if (engine.cache.effectiveProbe(adapters.resolveId(vendor)) === undefined) {
      engine.recordProbe(await adapter.probe())
    }
    return readOnlyReady(vendor, 'heal').ok
  }
  const briefs = new BriefService({
    home: paths.home,
    now: clock.now,
    suggest: {
      registry: adapters,
      isReady: readOnlyCallReady,
      flagMap: (vendor) => vendorFlagMap(vendor),
      log: log.child({ part: 'brief' }),
    },
    // The cost hint: about three quarters of the call's tokens in, the rest out, at the catalog's price.
    price: (vendor, model, tokens) => {
      const p = estimatePrice(vendor, model)
      if (!('rates' in p)) return null
      const input = Math.round(tokens * 0.75)
      return catalogCostUsd({ input, output: tokens - input }, p.rates, p.reasoningIncludedInOutput)
    },
  })
  /** The Plan pass's vendor and model for the folder (who "Suggest choices" asks); null when nothing resolves. */
  const planWho = async (
    folder: string | undefined,
    overrides?: RunOverrides,
  ): Promise<{ vendor: string; model: string | null } | null> => {
    const snap = await configService
      .snapshot({
        ...(folder !== undefined ? { folder } : {}),
        ...(overrides !== undefined ? { overrides } : {}),
      })
      .catch(() => null)
    const plan = snap?.config?.passes.plan
    return plan !== undefined ? { vendor: plan.vendor, model: plan.model } : null
  }
  /** Test-first in the brief (its pack's approach group offers it as a pipeline change). */
  const testFirstOf = async (folder: string, brief: BriefInput | undefined): Promise<boolean> =>
    brief !== undefined && (await briefs.testFirst(folder, brief))
  /**
   * The run's overrides with Research turned on when its brief's pack researches by default (`research.on`) and the
   * run does not say otherwise (`passes.plan.research` in its overrides wins).
   */
  const researchOverrides = async (
    folder: string,
    overrides: RunOverrides | undefined,
    brief: BriefInput | undefined,
    recipe?: RecipeView,
  ): Promise<RunOverrides | undefined> => {
    if (overrides?.passes?.plan?.research !== undefined) return overrides
    // A recipe that says whether to research decides it over the pack's default (its layer sits below the run's).
    if (recipe?.recipe.toggles.research !== undefined) return overrides
    if (!(await briefs.researchByDefault(folder, brief))) return overrides
    return {
      ...overrides,
      passes: { ...overrides?.passes, plan: { ...overrides?.passes?.plan, research: true } },
    }
  }
  /**
   * Whether the Research pass's vendor (the Plan pass's) can search the web from Dim Factory, as last probed;
   * undefined before its first probe.
   */
  const researchWeb = (config: ResolvedConfig): boolean | undefined =>
    engine.cache.vendor(adapters.resolveId(config.passes.plan.vendor))?.probe?.capabilities.web
  /**
   * PreflightInput.research: the lenses a run with Research would research (`category`: its brief's pack), the ones
   * no pack defines, and the web lenses it leaves out because its vendor cannot search the web.
   */
  const researchFacts = async (
    folder: string,
    config: ResolvedConfig | undefined,
    category: string | undefined,
  ): Promise<PreflightInput['research']> => {
    if (config === undefined || !config.passes.plan.research) return undefined
    const web = researchWeb(config)
    // Resolved as if the web were there, so the web lenses it would leave out can be named.
    const r = await briefs.researchLenses(
      folder,
      category ?? DEFAULT_CATEGORY,
      config.passes.plan.researchLenses,
      true,
    )
    const offWeb = web === false ? r.config.lenses.filter((l) => l.web).map((l) => l.label) : []
    return {
      vendor: vendorName(config.passes.plan.vendor),
      ...(web !== undefined ? { web } : {}),
      unknown: r.unknown,
      offWeb,
    }
  }
  const briefHost: BriefHost = {
    detect: async (req) => briefs.detect(req, await planWho(req.folder)),
    save: (folder, brief) => briefs.save(folder, brief),
    suggest: async (req) => {
      const who = await planWho(req.folder, req.overrides)
      if (who === null) throw new DimFactoryError('VALIDATION', 'The configuration could not be resolved.')
      return briefs.suggest(req, who)
    },
  }
  // ---- project memory (DIM_FACTORY.md at the project root): read by each run, updated with your approval ------------
  /** The folder's resolved config and the root its memory file lives at: the project root, else the repository's. */
  const folderInfo = async (folder: string): Promise<{ config: ResolvedConfig | null; root: string }> => {
    const snap = await configService.snapshot({ folder }).catch(() => null)
    const scope = await scopeOf(folder).catch(() => null)
    return {
      config: snap?.config ?? null,
      root: snap?.loaded.projectRoot ?? scope?.scopeRoot ?? resolve(folder),
    }
  }
  /** Why a folder cannot be written now: a run holds or waits for its lock (UI copy). */
  const folderBusy = async (folder: string): Promise<string | undefined> => {
    const scope = await scopeOf(folder).catch(() => null)
    if (scope === null) return undefined
    const b = scheduler.blockerFor(scope.lockKey)
    return b !== undefined ? `${runNo(b.runId)} is using this folder.` : undefined
  }
  const memoryService = new MemoryService({
    home: paths.home,
    log: log.child({ part: 'memory' }),
    folderInfo,
    readDoc: async (runId) => controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId)),
    busy: folderBusy,
    changed: (folder) => bus.global({ kind: 'memory', folder }),
    now: clock.now,
    // A project Easy made starts its first memory note with what it is and the rules its changes keep.
    firstNote: (folder: string): Promise<MemorySeed | null> => easyService.memorySeed(folder),
  })

  // ---- Run & Preview: previews this process starts (never on its own), killed on quit ----------------------------
  const previewService = new PreviewService({
    paths,
    log: log.child({ part: 'preview' }),
    emit: (session) => bus.global({ kind: 'preview', session }),
    env,
    recordProcs: !readOnly && o.host.kind === 'app',
  })
  const previewHost: PreviewHost = {
    service: previewService,
    packs: async (folder) => (await loadPacks({ home: paths.home, folder })).packs.map((v) => v.pack),
    openIn: () => configService.user?.value?.preview?.openIn ?? 'ask',
    ...(!readOnly && o.host.kind === 'app'
      ? {
          permission: {
            covers: (r: PermitRun) => permissions.covers(r),
            record: (u: { folder: string; runId: string; what: 'command'; label: string }) =>
              permissions.record(u),
          },
        }
      : {}),
  }
  // A crash's leftover previews (recorded children only) are killed at launch.
  if (!readOnly && o.host.kind === 'app') {
    void previewService.sweepOrphans().catch((err: unknown) => log.warn('preview sweep failed', { err }))
  }
  /** Main's play-tester, once main attached it (the app only). */
  let mainPlaytester: MainPlaytester | null = null
  /** The built-in name check for a game folder: the Games pack's famous names (with the user's and project's packs). */
  const gameNamesCheck = async (folder: string): Promise<GameCheck> => {
    const packs = await loadPacks({ home: paths.home, folder }).catch(() => null)
    const names = packs?.packs.find((v) => v.pack.id === GAMES_CATEGORY)?.pack.namesToAvoid ?? []
    return checkGameNames(folder, names)
  }
  const lastPlaytests = new Map<string, PreviewPlaytestView>()
  /**
   * The built-in Verify play-test (verify/playtest.ts): the game's folder (or its build) on a private read-only
   * loopback server of its own (not a listed preview), played by main's play-tester, then closed.
   */
  const verifyPlaytester: Playtester = async (r) => {
    const player = mainPlaytester
    if (player === null) return { kind: 'skipped', reason: PLAYTEST_NOT_HERE }
    const root = await gamePageRoot(r.folder)
    if ('reason' in root) return { kind: 'skipped', reason: root.reason }
    const server = await startStaticServer(root.dir)
    try {
      const report = await player.playUrl({
        url: server.url,
        spec: r.spec,
        shotsDir: r.dir,
        signal: r.signal,
      })
      return {
        kind: 'report',
        report: { ...report, checks: [...report.checks, await gameNamesCheck(r.folder)] },
      }
    } finally {
      await server.close().catch(() => undefined)
    }
  }
  /**
   * The built-in Verify page-load check (verify/pageload.ts): the page's folder on a private read-only loopback server
   * of its own (not a listed preview), opened by main in its hidden window with no internet, then closed.
   */
  const verifyPageChecker: PageChecker = async (r) => {
    const player = mainPlaytester
    if (player === null || player.checkPage === undefined)
      return { kind: 'skipped', reason: PAGELOAD_NOT_HERE }
    const server = await startStaticServer(r.folder)
    try {
      const url = new URL(encodeURIComponent(r.page), server.url).href
      return { kind: 'report', report: await player.checkPage({ url, signal: r.signal }) }
    } finally {
      await server.close().catch(() => undefined)
    }
  }
  const previewApi: CorePreview = {
    session: (id) => previewService.get(id),
    recordSmoke: async (sessionId, seen) => {
      const session = previewService.get(sessionId)
      if (session === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not running.')
      // A game's smoke check also gets the name check (its findings come with the other game checks').
      const withNames: SmokeObservation =
        seen.checks !== undefined
          ? { ...seen, checks: [...seen.checks, await gameNamesCheck(session.folder)] }
          : seen
      const view = await recordSmoke(paths, {
        sessionId,
        ...(session.runId !== undefined ? { runId: session.runId } : {}),
        at: Date.now(),
        seen: withNames,
      })
      previewService.setSmoke(sessionId, view)
      if (session.runId !== undefined) await mergePreviewFindings(session.runId, view.findings)
      return view
    },
    recordBlocked: (sessionId, url) => previewService.recordBlocked(sessionId, url),
    setPhone: (sessionId, on) => previewService.setPhone(sessionId, on),
    attachPlaytester: (p) => {
      mainPlaytester = p
    },
    playtestSpec: async (sessionId) => {
      const session = previewService.get(sessionId)
      if (session === undefined) throw new DimFactoryError('NOT_FOUND', 'That preview is not running.')
      const file = await readPlaytestFile(session.folder)
      if ('missing' in file) return { problem: PLAYTEST_NO_FILE }
      if ('error' in file) return { problem: file.error }
      return { spec: file.spec }
    },
    recordPlaytest: async (sessionId, report, problem) => {
      const folder = previewService.get(sessionId)?.folder
      const view: PreviewPlaytestView = {
        sessionId,
        at: Date.now(),
        report:
          report !== null && folder !== undefined
            ? { ...report, checks: [...report.checks, await gameNamesCheck(folder)] }
            : report,
        ...(problem !== undefined ? { problem } : {}),
      }
      lastPlaytests.set(sessionId, view)
      return view
    },
    savePdf: async (sessionId, pdf) => {
      const doc = previewService.documentOf(sessionId)
      if (doc === undefined) throw new DimFactoryError('NOT_FOUND', 'That document is not open.')
      const target = join(doc.folder, pdfNameOf(doc.docPath))
      // Next to the document, inside the project folder: never anywhere else.
      if (dirname(target) !== doc.folder)
        throw new DimFactoryError('VALIDATION', 'The PDF has no place to go.')
      await writeFileAtomic(target, pdf)
      log.info('document saved as PDF', { sessionId, bytes: pdf.byteLength })
      return target
    },
  }

  /**
   * Test-first's Tests step template as it resolves for the folder (project `.dimfactory/prompts/tests.md`, then
   * `DIM_FACTORY_HOME/prompts/tests.md`, then the builtin), recorded in resolved.json.
   */
  const testsTemplateFor = (projectRoot: string | null): ResolvedTemplate =>
    toResolvedTemplate(
      resolvePromptTemplate(null, {
        pass: 'tests',
        home: paths.home,
        ...(projectRoot !== null ? { folder: projectRoot } : {}),
      }),
    )

  /**
   * The optional steps' templates for a run made in `projectRoot` (project, then yours, then the built-in), recorded in
   * resolved.json so the run keeps them. An override with template errors is passed over for the built-in, with a log
   * line.
   */
  const stepTemplatesFor = (projectRoot: string | null): StepTemplates =>
    resolveStepTemplates(
      { home: paths.home, ...(projectRoot !== null ? { folder: projectRoot } : {}) },
      (name, path) =>
        log.warn('step prompt override has template errors; using the built-in', { name, path }),
    )

  // ---- config per run --------------------------------------------------------------------------------------------
  /**
   * Load + resolve the folder's config with the run layer, and the preflight input that carries the config files
   * (app.config.user, folder.project.config, folder.trust.projectAuto) and a resolve failure (run.profile,
   * run.passes, run.templates). Invalid run overrides are the request's own fault: VALIDATION.
   */
  const configForRun = async (
    folder: string,
    overrides: RunOverrides | undefined,
    recipe?: RecipeView,
  ): Promise<{ snap: ConfigSnapshot; input: PreflightInput }> => {
    const snap = await configService.snapshot({
      folder,
      ...(overrides !== undefined ? { overrides } : {}),
      ...(recipe !== undefined ? { recipe } : {}),
    })
    if (snap.error?.code === 'invalid-overrides') {
      throw new DimFactoryError('VALIDATION', snap.error.message, { details: { issues: snap.error.issues } })
    }
    // While the user file is broken, the run/vendor/pass checks have nothing reliable to check (its `vendors`
    // section names the binaries): app.config.user is the one reason Run is disabled.
    const userBroken = snap.loaded.user.issues.some((i) => i.severity === 'error')
    const input: PreflightInput = {
      folder,
      owner: 'run',
      ...(snap.config !== undefined && !userBroken ? { config: snap.config } : {}),
      profiles: snap.profiles,
      configFiles: await configService.preflightFiles(snap),
      ...(recipe !== undefined ? { recipe: recipeFacts(recipe, overrides, snap) } : {}),
    }
    return { snap, input }
  }
  /**
   * What Easy knows about a run that the task alone does not say (adaptive depth): it is Easy's, a new project from an
   * idea, what the idea needs, and the words the user wrote (an Easy task also carries Easy's own notes).
   */
  type DepthHints = { easy?: boolean; newProject?: boolean; needs?: readonly string[]; words?: string }
  /**
   * Adaptive depth for a run as runs.start would decide it now: the depth a layer forces, an explicit profile, else
   * the classifier (task, folder, Easy, the Brief, needs). Undefined when the config does not resolve.
   */
  const decideRunDepth = async (
    folder: string,
    task: string,
    overrides: RunOverrides | undefined,
    brief: BriefInput | undefined,
    recipe: RecipeView | undefined,
    hints: DepthHints = {},
  ): Promise<DepthDecision | undefined> => {
    const { snap } = await configForRun(folder, overrides, recipe)
    const cfg = snap.config
    if (cfg === undefined) return undefined
    const from = snap.provenance['/depth']?.source
    return decideDepth({
      setting: cfg.depth,
      settingFrom: from === 'run' ? 'run' : 'settings',
      profile: cfg.profile,
      // Easy picks its profile by readiness: that is not the user choosing a pipeline.
      profileChosen: hints.easy !== true && overrides?.profile !== undefined,
      input: {
        task: hints.words ?? task,
        folder: await depthFolderSize(folder),
        ...(hints.easy === true ? { easy: true } : {}),
        ...(hints.newProject === true ? { newProject: true } : {}),
        ...((await testFirstOf(folder, brief)) ? { testFirst: true } : {}),
        ...(hints.needs !== undefined ? { needs: hints.needs } : {}),
      },
    })
  }
  /**
   * configForRun with the run's depth applied: a run decided Quick resolves with `depth: direct`, which gives it the Quick
   * shape (ConfigService.snapshot). Without a decision (the live checks and the estimate, which have no task) the
   * shape follows the config's own `depth` (the composer sends the depth it shows).
   */
  const configForDepth = async (
    folder: string,
    overrides: RunOverrides | undefined,
    recipe: RecipeView | undefined,
    decision?: DepthDecision,
  ): Promise<{ snap: ConfigSnapshot; input: PreflightInput; overrides: RunOverrides | undefined }> => {
    const shaped: RunOverrides | undefined =
      decision?.depth === 'direct' && overrides?.depth !== 'direct'
        ? { ...overrides, depth: 'direct' }
        : overrides
    return { ...(await configForRun(folder, shaped, recipe)), overrides: shaped }
  }
  /** The run's recipe by id for the folder (VALIDATION with a did-you-mean for an unknown id); undefined: none. */
  const recipeFor = async (folder: string, id: string | undefined): Promise<RecipeView | undefined> =>
    id === undefined ? undefined : resolveRecipe({ home: paths.home, folder, id })
  /**
   * PreflightInput.recipe: the recipe, and whether it is what turns Auto on from the folder's own files (a project
   * recipe setting `auto: true` while neither the run nor the user's file decides Auto).
   */
  const recipeFacts = (
    v: RecipeView,
    overrides: RunOverrides | undefined,
    snap: ConfigSnapshot,
  ): NonNullable<PreflightInput['recipe']> => ({
    id: v.recipe.id,
    label: v.recipe.label,
    layer: v.layer,
    path: v.path,
    sha256: v.sha256,
    summary: recipeSummary(v.recipe),
    setsAuto:
      v.layer === 'project' &&
      v.recipe.auto === true &&
      overrides?.auto === undefined &&
      snap.loaded.user.value?.auto !== true,
    verifyCommands: v.recipe.verify?.commands?.length ?? 0,
  })
  /** resolved.json `recipe` (Re-run shows the same recipe and re-checks a project recipe's Auto grant). */
  const recipeRecord = (facts: NonNullable<PreflightInput['recipe']>, v: RecipeView): RecipeRecord => ({
    ...runRecipeOf(v),
    path: v.path,
    ...(v.recipe.auto !== undefined ? { auto: v.recipe.auto } : {}),
    setsAuto: facts.setsAuto,
  })

  // ---- controllers --------------------------------------------------------------------------------------------
  const preflightRunner =
    // `snapshotCopy`: the run's isolated copy is written from a snapshot (a match's side), so its own checks do not
    // ask for a git repository either.
    (runId: string, snapshotCopy = false) =>
      (
        mode: 'authoritative' | 'passBoundary',
        r: {
          folder: string
          config: ResolvedConfig
          pass?: PassName
        },
      ): Promise<PreflightReport> =>
        runPreflight(
          mode,
          {
            folder: r.folder,
            owner: 'run',
            config: r.config,
            // The run's profile was resolved (so known) when the run was made. Without it run.profile checks
            // the built-in names only, and a run of a user or project profile stops at "Unknown profile" for good.
            profiles: [...new Set<string>([...BUILTIN_PROFILE_NAMES, r.config.profile])],
            ...(r.pass !== undefined ? { pass: r.pass } : {}),
            ...(snapshotCopy ? { snapshotCopy: true } : {}),
          },
          { ...preflightDeps, lockQuery: lockQuery(runId) },
          { cache: engine.cache },
        )

  // ---- Easy mode's project permission (easy/permission.ts): trust.json's easyProject grants, held in memory too so
  // every ask is checked against them as they are now (a revoke takes effect during a run).
  const permissions = new ProjectPermissions({
    home: paths.home,
    log: log.child({ part: 'easy-permission' }),
    now: clock.now,
    readGrants: () => readEasyProjectGrants({ home: paths.home }),
    writeGrant: async (folder, ino) => {
      const st = await grantTrust(
        folder,
        { kind: 'easyProject', ...(ino !== undefined ? { ino } : {}) },
        { home: paths.home },
      )
      const g = st.grants.easyProject
      if (g === undefined) throw new DimFactoryError('INTERNAL', 'The project permission was not saved.')
      return g
    },
    removeGrant: (folder) => revokeEasyProject(folder, { home: paths.home }),
    changed: (folder) => bus.global({ kind: 'easy-permission', folder }),
  })
  void permissions.load()

  /** A match's sides take turns at Dim Factory's own checks (match/turns.ts). */
  const matchTurns = new MatchTurns()
  const makeController = (
    state: RunState,
    store: RunStore<RunDoc>,
    config: ResolvedConfig,
    scope: RunScope,
    createdBy: 'app' | 'cli',
    procTable: ProcTable,
    snapshots: SnapshotRecord[],
    work?: RunScope,
    testsTemplate?: Pick<ResolvedTemplate, 'path'>,
    stepTemplates?: StepTemplates,
  ): RunController => {
    let shadowP: Promise<Shadow> | undefined
    const shadow = (): Promise<Shadow> => {
      if (shadowP === undefined) {
        const p = resolveScope(scope.folder).then((info) => shadowFor(info, { home: paths.home }))
        shadowP = p
        p.catch(() => {
          if (shadowP === p) shadowP = undefined
        })
      }
      return shadowP
    }
    const c = new RunController(
      state,
      {
        paths,
        bus,
        store,
        config,
        scope,
        createdBy,
        adapters,
        preflight: preflightRunner(state.runId, state.copyFrom !== undefined),
        scheduler,
        ...(index !== null
          ? { putSummary: (s: RunSummary, debounced: boolean) => putSummary(index, s, debounced) }
          : {}),
        summarize,
        clock,
        log: log.child({ runId: state.runId }),
        shadow,
        procTable,
        ...(o.livePollMs !== undefined ? { livePollMs: o.livePollMs } : {}),
        // An isolated run's worktree (RunDoc.work) and ISO_API (tests inject fakes).
        ...(work !== undefined ? { work } : {}),
        // Test-first: the Tests step's template as resolved when the run was made.
        ...(testsTemplate !== undefined ? { testsTemplate } : {}),
        // The optional steps' templates as resolved when the run was made.
        ...(stepTemplates !== undefined ? { stepTemplates } : {}),
        // The Deploy step's planning (the folder's packs, the run's brief).
        deploy: deployPlanner(scope.folder),
        // Easy mode's project permission: runs the app started only (a CLI run never uses it).
        ...(createdBy === 'app' && !readOnly ? { permission: permissions } : {}),
        ...(o.isolation !== undefined ? { isolation: o.isolation } : {}),
        // E2E hook (DIM_FACTORY_E2E=1 only): `<home>/e2e/apply-hold` pauses an apply between files while it exists.
        ...(env[envName('E2E')] === '1' ? { e2eApplyHold: join(paths.home, 'e2e', 'apply-hold') } : {}),
        // The run's own frozen prices (set when it is created or reopened).
        cost: (i: CostInput) => passCost(i, runPricing.get(state.runId) ?? null),
        contextWindow,
        // The grounding checks after Implement and Fix (DIM_FACTORY_GROUNDING=off turns them off: the test cores, whose
        // fake vendors replay recorded words that do not match the files they write).
        grounding: env[envName('GROUNDING')] !== 'off',
        // The optional AI judge of the grounding checks (contextHealth.aiJudge): the cheapest catalog model of the Review
        // pass's vendor, on the read-only route in a Dim Factory-owned folder.
        judge: async (vendor: string, prompt: string): Promise<string> => {
          const model = cheapestModel(catalogData()?.pricing.entries ?? [], adapters.resolveId(vendor))
          const r = await readOnlyAnswer(
            {
              home: paths.home,
              now: clock.now,
              registry: adapters,
              isReady: readOnlyCallReady,
              flagMap: (v) => vendorFlagMap(v),
              log: log.child({ part: 'judge' }),
            },
            {
              vendor,
              model,
              prompt,
              area: 'judge',
              label: 'The AI judge',
              noVendor: 'No AI vendor is ready to check the claims.',
            },
          )
          return r.text
        },
        // Context health: the names a pass's level makes active, for a vendor without a breakdown (Claude has one).
        contextNames: (
          vendor: string,
          cwd: string,
          level: ExtensionLevel,
          ext: PassExtensions | undefined,
        ) => {
          if (vendor === 'claude' || level === 'none') return undefined
          if (level === 'allowed') return { mcp: ext?.mcp ?? [], skills: ext?.skills ?? [] }
          const d = discoverVendor(adapters.resolveId(vendor), {
            envFor: extensionsEnvFor,
            home: extensionsHome,
            folder: cwd,
          })
          return d === null
            ? undefined
            : { mcp: d.mcp.map((m) => m.name), skills: d.skills.map((s) => s.name) }
        },
        // Codex and ACP assign the session id; Claude takes Dim Factory's.
        capabilities: (vendor: string) => probeOf(vendor)?.capabilities,
        recovery: controllerRecovery,
        // A round's trust is read where trust.get reads it; a trust card's grant takes the recovery command grant
        // path (trust.json with the body the user was shown; config-changed drops the cached checks).
        verify: {
          trustGrants: (folder) => configService.trustGrants(folder),
          grant: async (folder, c) => {
            await configService.trustSet({
              folder,
              grant: { kind: 'command', command: { kind: c.kind, argv: [...c.argv], cwdRel: c.cwdRel } },
              trusted: true,
              ...(c.body !== undefined ? { body: c.body } : {}),
            })
          },
          env,
          // A match's sides take turns at the checks Dim Factory runs itself (two test suites or dev servers at once
          // fight over a port and the machine); the model passes still run side by side.
          ...(state.matchOf !== undefined
            ? {
                runRound: (deps, opts) =>
                  matchTurns.run((state.matchOf as MatchRef).matchId, opts.signal, () =>
                    runVerifyRound(deps, opts),
                  ),
              }
            : {}),
          // A game's playtest.json: played in main's hidden play-test window (the app), "not checked here" otherwise.
          playtest: verifyPlaytester,
          // A page's load check: opened in main's hidden window (the app), "not checked here" otherwise.
          pageload: verifyPageChecker,
        },
        notify: (runId, e, st) => {
          if (o.host.notify === undefined) return
          o.host.notify({
            runId,
            kind: e.kind,
            state: st,
            ...(e.step !== undefined ? { step: e.step } : {}),
            ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
            ...(e.cardId !== undefined ? { cardId: e.cardId } : {}),
            ...notificationFacts(e, st, { vendorName, at: clock.now() }),
          })
        },
      },
      snapshots,
    )
    controllers.set(state.runId, c)
    dormant.delete(state.runId)
    c.subscribe(() => {
      emitAttention()
      armUnload(c)
    })
    return c
  }

  // ---- Finished runs leave memory --------------------------------------------------------------------------------
  // A finished run (completed or cancelled) stays loaded while it may still be acted on at once (the Completed toast's
  // Revert all, the Diff tab). `unloadFinishedAfterMs` after its last change, with nothing in flight, it is unloaded the
  // way a run from an earlier launch is: run.json flushed, its controller and timers gone, its events.jsonl closed (the
  // bus keeps the ring its usual ~10 minutes). An action on it later loads it again (attach); a read goes to its files.
  // Before, every run of a session stayed loaded until it was removed: about 0.7 MB of heap and an open file each, and
  // every engine event walked all of them for the attention count (the soak's steady growth).
  const unloadAfterMs = o.unloadFinishedAfterMs ?? UNLOAD_FINISHED_AFTER_MS
  const unloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const unloading = new Map<string, Promise<void>>()
  const clearUnloadTimer = (runId: string): void => {
    const t = unloadTimers.get(runId)
    if (t !== undefined) clearTimeout(t)
    unloadTimers.delete(runId)
  }
  const armUnload = (c: RunController): void => {
    clearUnloadTimer(c.runId)
    if (c.closed || !isFinishedState(c.state)) return
    const timer = setTimeout(() => {
      unloadTimers.delete(c.runId)
      void unloadRun(c)
    }, unloadAfterMs)
    timer.unref()
    unloadTimers.set(c.runId, timer)
  }
  const unloadRun = async (c: RunController): Promise<void> => {
    const runId = c.runId
    if (controllers.get(runId) !== c || c.closed || !isFinishedState(c.state)) return
    // Something still in flight (an effect, a process, a recorded sleep): look again later.
    if (!c.idle || c.liveProcs().length > 0 || c.state.suspendedAt !== undefined) {
      armUnload(c)
      return
    }
    controllers.delete(runId)
    const p = (async () => {
      await c.close().catch((err: unknown) => log.warn('unloading a finished run failed', { runId, err }))
      forgetRunCaches(runId)
      await bus.closeRun(runId).catch(() => undefined)
    })().finally(() => unloading.delete(runId))
    unloading.set(runId, p)
    await p
  }
  /**
   * A run's per-run caches of a loaded run (its prices, expected models, published blocker, ETA timer). Its estimate
   * stays while the run exists: a read of an unloaded run shows its steps' ETAs from it (StepView.eta).
   */
  const forgetRunCaches = (runId: string): void => {
    runPricing.delete(runId)
    runExpectedModels.delete(runId)
    publishedBlocker.delete(runId)
    const eta = etaTimers.get(runId)
    if (eta !== undefined) clock.clearTimer(eta.timer)
    etaTimers.delete(runId)
  }

  // AppEvent `attention`: re-sent whenever the set of things that need the user changes.
  // Runs boot recovery left waiting, paused or failed without loading them count from their run.json state
  // (`dormant`) until a controller loads them; nothing else changes a run that is not loaded.
  const dormant = new Map<string, RunState>()
  let attentionKey = ''
  const currentAttention = (): Attention =>
    aggregateAttention([
      ...[...controllers.values()].map((x) => x.state),
      ...[...dormant].filter(([id]) => !controllers.has(id)).map(([, s]) => s),
    ])
  const emitAttention = (): void => {
    const a = currentAttention()
    // An ask's expiry moves with a sleep (ask-extended): the Dashboard, tray and toasts count down from it.
    const key = `${a.needsYou}|${a.items.map((i) => (i.kind === 'ask' ? `${i.id}@${i.ask.expiresAt}` : i.id)).join(',')}`
    if (key === attentionKey) return
    attentionKey = key
    bus.global({ kind: 'attention', needsYou: a.needsYou, items: a.items })
  }

  const attaching = new Map<string, Promise<RunController>>()
  /**
   * A run's preview smoke check findings (smoke.json's, the latest check's) join the run's findings, so the findings
   * list and Re-run from Fix see them. Best effort: the smoke record stands even when the run cannot take them.
   */
  const mergePreviewFindings = async (runId: string, findings: readonly Finding[]): Promise<void> => {
    try {
      const c = await attach(runId)
      await c.enqueue({
        t: 'preview-findings',
        findings: findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          body: f.body,
          flags: [...f.flags],
          round: f.round,
        })),
      })
    } catch (err) {
      log.warn('preview findings not added to the run', { runId, err })
    }
  }
  const attach = async (runId: string, given?: RunDoc): Promise<RunController> => {
    // A run being unloaded is loaded again once its run.json is flushed and its events.jsonl closed.
    const unload = unloading.get(runId)
    if (unload !== undefined) await unload
    const live = controllers.get(runId)
    if (live !== undefined) return live
    if (readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    let p = attaching.get(runId)
    if (p === undefined) {
      p = (async () => {
        const store = await RunStore.open<RunDoc>(paths, runId, {
          validate: (doc) =>
            isPlainObject(doc['state']) && isPlainObject(doc['scope']) ? (doc as unknown as RunDoc) : null,
          log,
        })
        if (store.readOnly) {
          throw new DimFactoryError(
            'NEWER_SCHEMA',
            `Run ${runId} was written by a newer Dim Factory; it is read-only.`,
          )
        }
        const doc = given ?? store.doc
        const resolvedRead = await store.readJson('resolved')
        // Chaos: a patch the run accepted that resolved.json never got (Dim Factory closed in between) goes in now.
        let resolvedDoc = resolvedRead.kind === 'ok' ? resolvedRead.value : undefined
        if (resolvedDoc !== undefined) {
          const repaired = withAcceptedPatches(resolvedDoc, doc.state.configPatches)
          if (repaired !== resolvedDoc) {
            resolvedDoc = repaired
            await store.writeJson('resolved', repaired).catch((err: unknown) => {
              log.warn('resolved.json could not take the run accepted patches', { runId, err })
            })
          }
        }
        // The run's config as patched by its recovery fixes (resolved.json `patches[]`).
        const cfgParse =
          resolvedDoc !== undefined
            ? ResolvedConfigZ.safeParse(
                resolvedConfigWithPatches(resolvedDoc, (index, error) => {
                  log.warn('a recorded recovery patch no longer applies; left out', { runId, index, error })
                }),
              )
            : undefined
        if (cfgParse === undefined || !cfgParse.success) {
          throw new DimFactoryError('STORAGE', `Run ${runId}: resolved.json is missing or invalid.`)
        }
        // The prices this run recorded (its passes are costed at them).
        runPricing.set(runId, parsePricingRef(resolvedDoc?.['pricingRef']))
        const snapRead = await store.readJson('snapshots')
        const snapshots =
          snapRead.kind === 'ok' && Array.isArray(snapRead.value['snapshots'])
            ? (snapRead.value['snapshots'] as SnapshotRecord[])
            : []
        if (!runEstimates.has(runId)) {
          const est = await readRunEstimate(paths.run(runId).dir)
          if (est !== null) runEstimates.set(runId, est)
        }
        await bus.openRun(runId, { lastSeq: doc.lastSeq })
        const procTable = await ProcTable.open(paths.run(runId).procsJson)
        // A sleep recorded by an earlier process is over: this one starts awake. Its armed waits
        // load disarmed and a diagnosis it was running is over too (their timers and processes were the old one's).
        const c = makeController(
          disarmOnLoad(withoutStaleSuspend(doc.state), clock.now()),
          store,
          cfgParse.data,
          doc.scope,
          doc.createdBy,
          procTable,
          snapshots,
          doc.work,
          testsTemplateOf(resolvedDoc),
          stepTemplatesOf(resolvedDoc),
        )
        if (doc.state.lock === 'held') scheduler.restoreHolder(runId, runLockKeyOf(doc.scope))
        else if (doc.state.lock === 'requested' && !scheduler.isQueued(runId) && given === undefined) {
          // Left queued by an earlier process: loading it re-enters the queue (the relaunch re-requests the lock).
          await c.enqueue({ t: 'relaunch' })
        }
        return c
      })().finally(() => attaching.delete(runId))
      attaching.set(runId, p)
    }
    return p
  }

  // ---- runs.start ---------------------------------------------------------------------------------------------
  let lastDisplayNo = 0
  const startRun = async (req: Req<'runs.start'>, hints?: DepthHints): Promise<Res<'runs.start'>> => {
    const planned = await planRun(req, hints)
    const made = await planned.create()
    await made.controller.enqueue({ t: 'created' })
    return { runId: made.runId, displayNo: made.displayNo }
  }
  /**
   * runs.start up to and including its authoritative preflight (PREFLIGHT_BLOCKED with the report when it does not
   * pass): what a run would be, checked, with nothing made yet. `create` makes it (R1); `created` is the caller's to
   * send. A match plans both of its sides before it makes either (`snapshotCopy`: the copy comes from a snapshot).
   */
  const planRun = async (
    req: Req<'runs.start'>,
    hints?: DepthHints,
    o: { snapshotCopy?: boolean } = {},
  ): Promise<{
    create(extra?: Pick<NewRunSpec, 'matchOf' | 'copyFrom' | 'initState' | 'prepare'>): Promise<CreatedRun>
  }> => {
    if (index === null) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    const folder = resolve(req.folder)
    // The recipe (VALIDATION for an unknown id): its config layer, and its brief defaults when the run sends none.
    const recipe = await recipeFor(folder, req.recipe)
    const briefIn = briefWithRecipe(req.brief, recipe?.recipe)
    const researched = await researchOverrides(folder, req.overrides, briefIn, recipe)
    // Adaptive depth: Quick (one strong session plus checks) or Thorough, decided now and applied as the run's shape.
    const decision = await decideRunDepth(folder, req.task, researched, briefIn, recipe, hints)
    const { snap, input } = await configForDepth(folder, researched, recipe, decision)
    // The Brief: checked against its pack and the folder's facts (VALIDATION when it does not fit).
    const brief = await briefs.forRun(folder, briefIn, req.task)
    if (brief?.testFirst === true) input.testFirst = true
    const research = await researchFacts(folder, input.config, briefIn?.category)
    if (research !== undefined) input.research = research
    if (o.snapshotCopy === true) input.snapshotCopy = true
    const report = await runPreflight('authoritative', input, preflightDeps, { cache: engine.cache })
    if (!report.ok) {
      // The composer shows this report's fixes; recovery.execute{folder} finds them here (with the passes they were
      // checked for, so a run-less switch_vendor knows which passes it moves).
      recoveryActions.record(folder, report, passesOfConfig(input.config))
      const first = report.blocking[0]
      throw new DimFactoryError(
        'PREFLIGHT_BLOCKED',
        first !== undefined ? `${first.title}: ${first.detail}` : 'Preflight blocked the run.',
        { details: report },
      )
    }
    const config = snap.config
    if (config === undefined) {
      // A failed resolve always fails one of run.profile / run.passes / run.templates; this is a backstop.
      throw new DimFactoryError('VALIDATION', snap.error?.message ?? 'The config could not be resolved.', {
        details: { issues: snap.error?.issues ?? [] },
      })
    }
    const { user, project } = snap.loaded
    const create = (
      extra: Pick<NewRunSpec, 'matchOf' | 'copyFrom' | 'initState' | 'prepare'> = {},
    ): Promise<CreatedRun> =>
      createRun({
        ...extra,
        folder,
        task: req.task,
        config,
        report,
        ...(brief !== undefined ? { brief } : {}),
        ...(recipe !== undefined && input.recipe !== undefined
          ? { recipe: recipeRecord(input.recipe, recipe) }
          : {}),
        projectRoot: snap.loaded.projectRoot ?? null,
        ...(decision !== undefined
          ? { depth: { depth: decision.depth, source: decision.source, reason: decision.reason } }
          : {}),
        resolvedMeta: {
          provenance: snap.provenance,
          layerHashes: { user: user.sha256, project: project?.sha256 ?? null },
          layers: {
            user: { path: user.file, exists: user.exists, sha256: user.sha256 },
            project:
              project !== null
                ? { path: project.file, exists: project.exists, sha256: project.sha256 }
                : null,
            run: req.overrides ?? {},
          },
        },
      })
    return { create }
  }

  /**
   * R1 after a passed authoritative preflight (runs.start; runs.rerun, rerun.ts): the scope (with the guard's
   * backstop), the run's id and number, its state, run.json, resolved.json (the config, `resolvedMeta`, this start's
   * vendor facts, prices and warnings), the frozen estimate and the controller. `created` is the caller's to send.
   */
  const createRun = async (spec: NewRunSpec): Promise<CreatedRun> => {
    if (index === null) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
    const { folder, config, report } = spec
    const scope = await scopeOf(folder).catch((err: unknown) => {
      throw new DimFactoryError('GIT', `Cannot read the folder's repository: ${errorMessage(err)}`)
    })
    // Belt and braces for folder.guard: never create a run whose snapshots and lock would cover a guarded scope
    // root (a project folder inside a repository at ~ or at a drive root).
    if (!sameGuardPath(scope.scopeRoot, folder)) {
      const g = await isGuarded(scope.scopeRoot, { owner: 'run', dimFactoryHome: paths.home, env })
      if (g.guarded) {
        const detail = scopeRootGuardDetail(folder, scope.scopeRoot, g)
        const check = { ...guardCheckResult(g, clock.now()), detail }
        const blocked: PreflightReport = {
          mode: 'authoritative',
          ok: false,
          blocking: [check],
          warnings: [],
          info: [],
        }
        throw new DimFactoryError('PREFLIGHT_BLOCKED', `${check.title}: ${detail}`, { details: blocked })
      }
    }
    // Re-run from Fix: the carried snapshots are in the shadow of the folder key the source ran under.
    if (spec.folderKey !== undefined && scope.folderKey !== spec.folderKey) {
      throw new DimFactoryError(
        'CONFLICT',
        "The folder's repository changed since that run (a git repository was made around it), so its snapshots are not where Fix would look for them. Re-run starts the whole run again.",
      )
    }
    const createdAt = clock.now()
    const runId = newRunId(new Date(createdAt))
    const displayNo = Math.max(index.nextDisplayNo(), lastDisplayNo + 1)
    lastDisplayNo = displayNo
    const planVendor = adapters.resolveId(config.passes.plan.vendor)
    const planSnap = engine.cache.vendor(planVendor)
    const planMode = planNativeFor(config, planSnap) ? 'native' : 'emulated'
    const testFirst = spec.brief?.testFirst === true
    // Project memory: the file at the project root (else the repository's), capped, as the run's `{{memory}}`.
    const memory = await memoryService
      .forRun(spec.projectRoot ?? scope.scopeRoot, config)
      .catch((err: unknown) => {
        log.warn('project memory could not be read; the run goes on without it', { err })
        return undefined
      })
    // Research: the lenses resolved now (generic and the brief's pack's), the web lenses left out when the Plan pass's
    // vendor cannot search the web from Dim Factory (it then reads the repository only).
    const research = config.passes.plan.research
      ? (
          await briefs.researchLenses(
            folder,
            spec.brief?.record.input.category ?? DEFAULT_CATEGORY,
            config.passes.plan.researchLenses,
            planSnap?.probe?.capabilities.web === true,
          )
        ).config
      : undefined
    const init: RunInit = {
      runId,
      displayNo,
      folder,
      folderKey: scope.folderKey,
      task: spec.task.replace(/\r\n?/g, '\n'),
      profile: config.profile,
      createdAt,
      config: {
        ...runConfigFromResolved(config, planMode),
        ...(testFirst ? { testFirst: true as const } : {}),
        ...(research !== undefined ? { research } : {}),
        // How deep the run goes and why (the Run view shows it; a Quick run may escalate on a failed check).
        ...(spec.depth !== undefined ? { depth: { ...spec.depth } } : {}),
      },
      ...(spec.brief !== undefined && spec.brief.text !== '' ? { brief: spec.brief.text } : {}),
      // The Brief's category, and its pack's security focus for Security and the critic (`{{focus}}`).
      ...(spec.brief !== undefined ? { category: spec.brief.record.input.category } : {}),
      ...(spec.brief?.record.focus !== undefined && spec.brief.record.focus !== ''
        ? { securityFocus: spec.brief.record.focus }
        : {}),
      ...(memory !== undefined ? { memory } : {}),
      // The recipe the run used (the Run view's header and the history show it).
      ...(spec.recipe !== undefined
        ? {
            recipe: {
              id: spec.recipe.id,
              label: spec.recipe.label,
              layer: spec.recipe.layer,
              sha256: spec.recipe.sha256,
            },
          }
        : {}),
      // A match's side: the match it belongs to, and the snapshot its copy starts from.
      ...(spec.matchOf !== undefined ? { matchOf: spec.matchOf } : {}),
      ...(spec.copyFrom !== undefined ? { copyFrom: spec.copyFrom } : {}),
    }
    const testsTemplate = testFirst
      ? (spec.brief?.testsTemplate ?? testsTemplateFor(spec.projectRoot ?? null))
      : undefined
    const stepTemplates = stepTemplatesFor(spec.projectRoot ?? null)
    const state = spec.initState !== undefined ? spec.initState(init) : initRunState(init)
    const createdBy = o.host.kind
    // Isolated runs lock their own worktree path: the run's own lock is its worktree's
    // (`<home>/worktrees/<runId>`, known before it exists); it leases the folder's lock only to apply.
    const runScope: RunScope =
      config.isolation.mode === 'worktree'
        ? { ...scope, runLockKey: (await worktreeKeys(paths.home, runId)).lockKey }
        : scope
    const doc: RunDoc = { runId, state, lastSeq: 0, scope: runScope, createdBy }
    const store = await RunStore.create<RunDoc>(paths, runId, doc, { log })
    const vendors: Record<string, unknown> = {}
    for (const v of new Set(
      PASS_NAMES.filter((p) => config.passes[p].enabled).map((p) => config.passes[p].vendor),
    )) {
      const snap = engine.cache.vendor(adapters.resolveId(v))
      const probe: ProbeResult | undefined = snap?.probe
      vendors[v] = {
        route: probe?.route ?? null,
        version: probe?.version ?? null,
        capabilities: probe?.capabilities ?? null,
        failingChecks: (snap?.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id),
      }
    }
    const priced = PASS_NAMES.filter((p) => config.passes[p].enabled).map((p) => {
      const { vendor, model } = config.passes[p]
      // Live balanced run: a pass with no model is priced, and expected (StepView.expectedModel), at the same model.
      return { vendor: adapters.resolveId(vendor), model: model ?? frozenExpected(runId, p, vendor) }
    })
    // Frozen here (runs/<id>/estimate.json): the composer showed the same figure (estimates.get), and the live
    // ETA counts down from it.
    const estimate = estimateFor(config, scope.folderKey, testFirst)
    runEstimates.set(runId, estimate)
    const catalog = catalogData()
    const pricingRef = catalog !== undefined ? pricingRefFor(catalog, priced) : null
    runPricing.set(runId, pricingRef)
    await store.writeJson('resolved', {
      config,
      ...spec.resolvedMeta,
      scopeRoot: scope.scopeRoot,
      folderKey: scope.folderKey,
      vendors,
      pricingRef,
      preflightWarnings: report.warnings,
      estimate: null,
      patches: [],
      // The Brief as the run took it (choices, the folder's facts, `{{brief}}`, Test-first), and Test-first's template.
      ...(spec.brief !== undefined ? { brief: spec.brief.record } : {}),
      ...(testsTemplate !== undefined ? { testsTemplate } : {}),
      // The optional steps' templates (Clarify, Research, acceptance, Explain, Deploy) the run renders.
      stepTemplates,
      // The recipe the run used (id, label, layer, file and sha256): Re-run takes the frozen config and shows it.
      ...(spec.recipe !== undefined ? { recipe: spec.recipe } : {}),
      // The run this one re-runs (resolved-json.ts leaves it out of the re-run equality).
      ...(spec.rerunOf !== undefined ? { rerunOf: spec.rerunOf } : {}),
      // A match's side (the match and the side), and the snapshot its copy was written from.
      ...(spec.matchOf !== undefined ? { matchOf: spec.matchOf } : {}),
      ...(spec.copyFrom !== undefined ? { copyFrom: spec.copyFrom } : {}),
      // Adaptive depth's decision (a re-run shows it again; its frozen config already has the shape).
      ...(spec.depth !== undefined ? { depth: spec.depth } : {}),
    })
    // A run without its estimate file just shows no ETA: a failed write must not fail runs.start.
    await writeRunEstimate(paths.run(runId).dir, estimate).catch((err: unknown) =>
      log.warn('estimate.json write failed', { runId, err }),
    )
    // Re-run from Fix: the carried artifacts and the shadow ref. A run that cannot start with them is removed.
    if (spec.prepare !== undefined) {
      try {
        await spec.prepare(runId, paths.run(runId))
      } catch (err) {
        await store.close().catch(() => undefined)
        await removeRunDir(paths, runId).catch(() => undefined)
        runEstimates.delete(runId)
        runPricing.delete(runId)
        runExpectedModels.delete(runId)
        throw new DimFactoryError('STORAGE', `The re-run could not be set up: ${errorMessage(err)}`)
      }
    }
    await bus.openRun(runId, { createdAt })
    const procTable = await ProcTable.open(paths.run(runId).procsJson)
    const controller = makeController(
      state,
      store,
      config,
      runScope,
      createdBy,
      procTable,
      [],
      undefined,
      testsTemplate,
      stepTemplates,
    )
    return { runId, displayNo, controller }
  }

  // ---- revert, undo, run branch (Revert to S0; the run branch's end-of-run actions) -------------------------------
  /** Another loaded run working in the same folder (a process, a launch, git work in flight), as UI copy. */
  const otherRunWorking = (runId: string, lockKey: string): string | undefined => {
    for (const c of controllers.values()) {
      if (c.runId === runId || c.closed) continue
      // An isolated run works in its worktree; it writes the folder only while it applies (or undoes) there.
      const f = c.state.isolation?.finalize
      if (
        f !== undefined &&
        (f.op !== undefined || f.lease !== 'none') &&
        lockKeysOverlap(c.deps.scope.lockKey, lockKey)
      )
        return `Run #${c.state.displayNo} is applying its changes to this folder.`
      if (!lockKeysOverlap(runLockKeyOf(c.deps.scope), lockKey)) continue
      if (folderBusyReason(c.state) !== undefined) return `Run #${c.state.displayNo} is using this folder.`
    }
    return undefined
  }
  const writableOnly = (): void => {
    if (readOnly) throw new DimFactoryError('FORBIDDEN', 'This Dim Factory process is read-only.')
  }
  // Diff tab: segment rows, one file's patch, an image's bytes and the reviewed marks,
  // read from the folder's shadow without opening (or re-creating) it; persisted patches once its snapshots are gone.
  const runDiffs = createRunDiffs({
    paths,
    readDoc: async (runId) => controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId)),
    log,
  })
  const runGit: RunGitHost = {
    revert: async (runId, req) => {
      writableOnly()
      const c = await attach(runId)
      const busy = otherRunWorking(runId, runLockKeyOf(c.deps.scope))
      if (busy !== undefined) throw new DimFactoryError('FOLDER_BUSY', busy)
      // A run whose snapshots were cleared shows its saved patch and cannot be reverted (after the busy check,
      // which the controller's reducer makes for its own run).
      if (folderBusyReason(c.state) === undefined) await runDiffs.assertRevertable(runId, req.seg)
      const r = await c.revert({
        kind: 'revert',
        ...(req.seg !== undefined ? { seg: req.seg } : {}),
        ...(req.paths !== undefined ? { paths: req.paths } : {}),
      })
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
      return r.value
    },
    undoRevert: async (runId, undoToken) => {
      writableOnly()
      const c = await attach(runId)
      const busy = otherRunWorking(runId, runLockKeyOf(c.deps.scope))
      if (busy !== undefined) throw new DimFactoryError('FOLDER_BUSY', busy)
      if (folderBusyReason(c.state) === undefined) await runDiffs.assertUndoable(runId)
      const r = await c.revert({ kind: 'undo-revert', token: undoToken })
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
    },
    branch: async (runId, action) => {
      writableOnly()
      const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
      if (doc === null) throw new DimFactoryError('NOT_FOUND', `Run ${runId} not found.`)
      const b = doc.state.branch
      if (b === undefined) throw new DimFactoryError('NOT_FOUND', 'This run did not make a run branch.')
      if (!isFinishedState(doc.state)) {
        throw new DimFactoryError(
          'CONFLICT',
          'The run branch can be left or deleted once the run has finished. Stop the run first.',
        )
      }
      const busy = otherRunWorking(runId, runLockKeyOf(doc.scope))
      if (busy !== undefined) throw new DimFactoryError('FOLDER_BUSY', busy)
      const repo = (await resolveScope(doc.scope.folder)).repo
      const opts = { hooksPath: paths.emptyHooksDir }
      try {
        return action === 'return'
          ? await returnToPrevious(repo, b, opts)
          : await deleteRunBranch(repo, b, opts)
      } catch (err) {
        throw new DimFactoryError('GIT', `git could not change the run branch: ${errorMessage(err)}`)
      }
    },
    // diff.files / diff.file: a segment's ends from the run's snapshots, the diff from the shadow
    // (run-diffs.ts; the viewer's row facts, reviewed marks and the persisted fallback).
    files: (runId, seg) => {
      writableOnly()
      return runDiffs.files(runId, seg)
    },
    file: (runId, seg, rel, ignoreEol) => {
      writableOnly()
      return runDiffs.file(runId, seg, rel, ignoreEol)
    },
  }
  const diffView: DiffViewHost = {
    blob: (runId, seg, side, rel) => {
      writableOnly()
      return runDiffs.blob(runId, seg, side, rel)
    },
    markReviewed: (runId, req) => {
      writableOnly()
      return runDiffs.markReviewed(runId, req)
    },
  }

  // ---- storage (Settings → Diagnostics: storage sizes, Clear snapshots) -------------------------------------------
  /**
   * Why a folder's snapshots cannot be cleared now (a run holds or waits for its lock, or works there; with `mutex`,
   * shadow work is running), as UI copy.
   */
  /** "Run #12", or "A run" when its number is not known. */
  const runNo = (runId: string): string => {
    const s = controllers.get(runId)?.state.displayNo ?? (index?.get(runId) ?? roIndex?.get(runId))?.displayNo
    return s !== undefined ? `Run #${s}` : 'A run'
  }
  const folderInUse = (folderKey: string, o: { mutex: boolean }): string | undefined => {
    for (const e of [...scheduler.holders(), ...scheduler.queued()]) {
      if (folderKeyOf(e.lockKey) === folderKey) {
        return `${runNo(e.runId)} is using this folder. Clear its snapshots once the run has finished.`
      }
    }
    for (const c of controllers.values()) {
      if (c.closed) continue
      if (c.deps.scope.folderKey !== folderKey && workScopeOf(c.doc()).folderKey !== folderKey) continue
      if (!isFinishedState(c.state) || folderBusyReason(c.state) !== undefined) {
        return `${runNo(c.runId)} is using this folder. Clear its snapshots once the run has finished.`
      }
    }
    if (o.mutex && isFolderBusy(folderKey)) {
      return 'Dim Factory is recording this folder right now. Try again in a moment.'
    }
    return undefined
  }
  /**
   * Worktree shadows go with their worktree: an isolated copy's shadow holds the
   * snapshots its Apply, preview and Diff tab read, whether or not the run is loaded, so it is cleared only by Discard.
   */
  const isolatedCopyHold = async (
    folderKey: string,
    scopeRoot: string | null,
  ): Promise<string | undefined> => {
    const root = scopeRoot ?? (await shadowScopeRoot(paths, folderKey))
    if (root === null) return undefined
    const runId = await isolatedCopyRun(paths.home, root)
    if (runId === undefined) return undefined
    return `${runNo(runId)} still has its isolated copy, which needs these snapshots. Discard the copy (in the run's Diff tab) to clear them.`
  }
  /** storage.usage: each shadow says why it cannot be cleared now (core's own check; Settings never decides it). */
  const usageView = async (): Promise<StorageUsage> => {
    const u = await storageUsage(paths)
    return {
      ...u,
      shadows: await Promise.all(
        u.shadows.map(async (s) => {
          const busy =
            folderInUse(s.folderKey, { mutex: false }) ?? (await isolatedCopyHold(s.folderKey, s.path))
          return busy !== undefined ? { ...s, busy } : s
        }),
      ),
    }
  }
  const storage: StorageHost = {
    usage: usageView,
    clearShadow: async (folderKey) => {
      writableOnly()
      const before = folderInUse(folderKey, { mutex: true }) ?? (await isolatedCopyHold(folderKey, null))
      if (before !== undefined) throw new DimFactoryError('FOLDER_BUSY', before)
      // The runs that used this folder keep reading the same diffs: what they have no saved copy of is saved first.
      const runIds = ctx
        .summaries()
        .filter((x) => x.folderKey === folderKey)
        .map((x) => x.runId)
      // A run whose copy could not be saved (a full drive, a patch too large) keeps its snapshots: nothing is cleared.
      const saved = await runDiffs.persistRuns(runIds)
      if (saved.failed.length > 0) {
        throw new DimFactoryError(
          'STORAGE',
          persistFailedText(saved.failed.map((f) => ({ label: runNo(f.runId), reason: f.reason }))),
          { details: { runs: saved.failed.map((f) => f.runId) } },
        )
      }
      await withFolderLock(folderKey, async () => {
        // Under the folder's shadow mutex (held here): only a run that started meanwhile can stop it now.
        const now = folderInUse(folderKey, { mutex: false })
        if (now !== undefined) throw new DimFactoryError('FOLDER_BUSY', now)
        await removeShadow(paths, folderKey)
        forgetShadows(folderKey)
        forgetDiffView(paths.shadowRepo(folderKey))
      })
      log.info('cleared the snapshots of a folder', { folderKey, runs: runIds.length })
      return usageView()
    },
  }

  // ---- Re-run and Re-run from Fix (rerun.ts) ---------------------------------------------------------------------
  const rerunHost: RerunHost = {
    paths,
    scheduler,
    log: log.child({ part: 'rerun' }),
    readDoc: async (runId) => {
      const live = controllers.get(runId)
      if (live !== undefined) return live.doc()
      const doc = await readRunDoc(paths, runId)
      return doc !== null ? { ...doc, state: disarmOnLoad(doc.state, clock.now()) } : null
    },
    controller: (runId) => attach(runId),
    readResolved: async (runId) => {
      const r = await readVersionedJson(paths.run(runId).resolvedJson).catch(() => null)
      return r !== null && r.kind === 'ok' ? r.value : null
    },
    // The authoritative preflight with the re-run's settings: the files as they are now say whether the project turns
    // Auto on (trust), and any profile name stands (the settings are resolved already).
    preflight: async (folder, config, runLayer, testFirst, category, recipe, snapshotCopy) => {
      let input: PreflightInput
      try {
        // The source's run layer (validated again here: an invalid one falls back to none).
        input = (await configForRun(folder, isPlainObject(runLayer) ? runLayer : undefined)).input
      } catch {
        input = (await configForRun(folder, undefined)).input
      }
      const files = input.configFiles
      const rerunInput: PreflightInput = {
        ...input,
        config,
        profiles: [...new Set([...(input.profiles ?? []), config.profile])],
        ...(testFirst === true ? { testFirst: true } : {}),
        ...(snapshotCopy === true ? { snapshotCopy: true } : {}),
      }
      // A re-run from the start researches again (a Re-run from Fix carries its source's research: no category).
      if (category !== undefined) {
        const research = await researchFacts(folder, config, category)
        if (research !== undefined) rerunInput.research = research
      }
      // A resolve of the files that fails now (a profile renamed since) says nothing about these settings.
      if (files !== undefined) {
        // The source's recipe decided Auto over the project file: that file is not what turns it on.
        const project =
          files.project !== null && recipe?.auto !== undefined
            ? { ...files.project, setsAuto: false }
            : files.project
        rerunInput.configFiles = { user: files.user, project }
      }
      // The source's recipe (as recorded: the settings are frozen); a project recipe's Auto grant is checked again.
      if (recipe !== undefined) {
        rerunInput.recipe = {
          id: recipe.id,
          label: recipe.label,
          layer: recipe.layer,
          path: recipe.path,
          sha256: recipe.sha256,
          summary: 'Re-run keeps the settings this recipe gave the first run.',
          setsAuto: recipe.setsAuto && config.auto,
          verifyCommands: 0,
        }
      }
      const report = await runPreflight('authoritative', rerunInput, preflightDeps, { cache: engine.cache })
      if (!report.ok) recoveryActions.record(folder, report, passesOfConfig(rerunInput.config))
      return report
    },
    createRun,
    shadow: async (folder, folderKey) => {
      try {
        await stat(paths.shadowRepo(folderKey))
      } catch {
        return null
      }
      const scope = await resolveScope(folder).catch(() => null)
      if (scope === null || scope.folderKey !== folderKey) return null
      return shadowFor(scope, { home: paths.home })
    },
  }

  // ---- Pin, Remove (undo), retention, shadow gc ------------------------------------------------------------------
  /** Close a loaded run before its folder is deleted: its controller (run.json flushed), events log and timers. */
  const detachRun = async (runId: string): Promise<void> => {
    clearUnloadTimer(runId)
    await unloading.get(runId)
    const c = controllers.get(runId)
    if (c !== undefined) {
      await c.close().catch((err: unknown) => log.warn('closing a removed run failed', { runId, err }))
      controllers.delete(runId)
    }
    dormant.delete(runId)
    runEstimates.delete(runId)
    forgetRunCaches(runId)
    await bus.closeRun(runId).catch(() => undefined)
    bus.forget(runId)
  }
  const history = createHistory({
    paths,
    log: log.child({ part: 'history' }),
    now: clock.now,
    state: historyState,
    index,
    summaries: () => ctx.summaries(),
    readDoc: async (runId) => controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId)),
    summarizeDoc: (doc) => summarize(doc.state),
    lockOf: (runId) =>
      scheduler.isHolder(runId) || scheduler.isLeaseHolder(runId)
        ? 'held'
        : scheduler.isQueued(runId)
          ? 'requested'
          : undefined,
    detach: detachRun,
    persistRuns: (runIds) => runDiffs.persistRuns(runIds),
    // Not the shadow mutex: gcIfIdle checks that before taking it, and asks again while it holds it.
    folderInUse: (folderKey) => folderInUse(folderKey, { mutex: false }) !== undefined,
    lastLockAt: (folderKey) => {
      let at: number | undefined
      for (const r of scheduler.released()) {
        if (folderKeyOf(r.lockKey) === folderKey) at = Math.max(at ?? 0, r.at)
      }
      return at
    },
    policy: () => retentionPolicyOf(configService.user?.value?.storage),
  })

  // ---- catalog refresh job (catalog/refresh-jobs.ts, catalog/refresh.ts) -----------------------------------------
  // Writable cores only. A job starts only through catalog.refresh{consent:true} (handlers-catalog-job.ts); nothing
  // else here, the scheduler included, ever starts one. Settings are read fresh for each plan and start: the
  // `catalog.refresh` config, the vendors the user's passes use (their prices are refreshed) and each vendor's flagMap.
  const catalogStatusNow = async (): Promise<CatalogStatus> => {
    // The live catalog's status (its due date counts a finished refresh; jobRunning from the job below).
    if (catalogLive !== undefined) return catalogLive.status()
    const refresh = configService.user?.value?.catalog?.refresh
    const builtin = BUILTIN_DEFAULTS.catalog.refresh
    return catalogStatus({
      pricing: catalogData()?.pricing ?? null,
      refresh: {
        enabled: refresh?.enabled ?? builtin.enabled,
        intervalDays: refresh?.intervalDays ?? builtin.intervalDays,
      },
      state: await readCatalogState(paths.state),
      now: clock.now(),
      jobRunning: catalogJobs?.running() ?? false,
    })
  }
  const refreshSettings = async (): Promise<RefreshSettings> => {
    const cfg = (await configService.snapshot({})).config
    const vendors = new Set<string>()
    for (const p of PASS_NAMES) {
      const pc = cfg?.passes[p]
      if (pc === undefined || !pc.enabled) continue
      const id = adapters.resolveId(pc.vendor)
      if (isKnownVendor(id)) vendors.add(id)
    }
    const flagMaps: Record<string, Record<string, string>> = {}
    for (const [id, v] of Object.entries(cfg?.vendors ?? {})) {
      if (Object.keys(v.flagMap).length > 0) flagMaps[id] = v.flagMap
    }
    return {
      refresh: cfg?.catalog.refresh ?? BUILTIN_DEFAULTS.catalog.refresh,
      vendors: [...vendors],
      flagMaps,
    }
  }
  const catalogJobs: CatalogJobs | undefined = readOnly
    ? undefined
    : new CatalogJobs({
        home: paths.home,
        adapter: (vendor) => (adapters.isBuilt(vendor) ? adapters.get(vendor) : undefined),
        // Codex (X17) refreshes only while it is ready (a web-capable, read-only pass).
        ready: (vendor) => readOnlyReady(vendor, 'catalog', { web: true }),
        settings: refreshSettings,
        catalog: catalogData,
        status: catalogStatusNow,
        price: estimatePrice,
        apiEquivalent: (vendor) => subscriptionAuth(probeOf(vendor)),
        // The consent card names the CLI default it prices (the same resolution as estimatePrice).
        defaultModel: (vendor) => concreteModel(vendor, null),
        emit: (ev) => bus.global(ev),
        // The diff review against the catalog as it is when the job ends (validate.ts), with the entries the answer's
        // schema check refused (refresh.ts) listed as rejected.
        buildDiff: (i) => {
          const diff = buildCatalogDiff(
            { jobId: i.jobId, generatedAt: i.at, vendor: i.vendor, model: i.model },
            catalogData() ?? {
              models: { schemaVersion: 1, updatedAt: 0, vendors: {} },
              pricing: { schemaVersion: 1, updatedAt: 0, entries: [] },
            },
            i.proposal,
            {
              vendors: i.vendors,
              cliModels: Object.fromEntries(i.vendors.map((v) => [v, probeOf(v)?.models ?? []])),
              // The pages the job read and the models it named (catalog.get and apply read the same
              // from its status.json, so all three show the same review).
              fetchedHosts: i.fetchedHosts,
              mentioned: i.mentioned,
            },
          )
          return i.rejected.length > 0 ? { ...diff, rejected: [...i.rejected, ...diff.rejected] } : diff
        },
        now: clock.now,
        log: log.child({ part: 'catalog-refresh' }),
      })
  void catalogJobs?.init()
  // catalog.get shows the running refresh (its progress) from the job runner, the rest from status.json.
  catalogLive?.setJobSource(() => catalogJobs?.current() ?? null)

  // ---- handlers -----------------------------------------------------------------------------------------------
  const recoveryHost: RecoveryHost = {
    actions: recoveryActions,
    validateVendorPath,
    syncUserVendors,
    catalog: catalogData,
    forgetFolder,
    env,
    vendors: vendorReadiness,
    ...(healApi !== undefined ? { heal: healApi } : {}),
    vendorVersion: (vendor) => probeOf(vendor)?.version ?? null,
    vendorArgs: vendorArgsCheck,
  }
  // ---- the Deploy helper (deploy.*; a finished run's commit and pull request, opt-in per project) ------------------
  const deployHost: DeployHost = {
    packs: async (folder) => (await loadPacks({ home: paths.home, folder })).packs.map((v) => v.pack),
    brief: async ({ folder, runId }) =>
      (runId !== undefined ? await runBriefInput(runId) : null) ?? (await readSavedBrief(paths.home, folder)),
    runFacts: async (runId) => {
      const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
      return doc !== null ? { target: doc.state.config.deploy?.target ?? null, task: doc.state.task } : null
    },
    runRecipe: async (runId) => {
      const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
      return doc?.state.recipe
    },
    // "Get it ready to share": the build as one Verify command, its log under deploy/build/ (never a run's folder).
    runBuild: async (b) => {
      const key = createHash('sha256').update(resolve(b.folder).toLowerCase()).digest('hex').slice(0, 16)
      const round = await runVerifyRound(
        { paths, grants: () => Promise.resolve(b.grants), env },
        {
          runId: b.runId ?? 'share',
          round: 'verify:1',
          folder: b.folder,
          scopeRoot: b.scopeRoot,
          commands: [{ name: BUILD_COMMAND_NAME, run: b.argv, cwdRel: '.' }],
          failFast: true,
          logDir: join(paths.home, 'deploy', 'build', key),
        },
      )
      const r = round.results[0]
      if (r === undefined) throw new DimFactoryError('INTERNAL', 'The build did not report a result.')
      return r
    },
    ...(!readOnly && o.host.kind === 'app'
      ? {
          permission: {
            covers: (r: PermitRun) => permissions.covers(r),
            record: (u: { folder: string; runId: string; what: 'command'; label: string }) =>
              permissions.record(u),
          },
        }
      : {}),
    runGit: {
      paths,
      readDoc: async (runId) => controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId)),
      summarize: (doc) => summarize(doc.state),
      busy: (doc) => {
        const own = controllers.get(doc.runId)
        if (own !== undefined && folderBusyReason(own.state) !== undefined)
          return 'The run is still working in its folder. Try again in a moment.'
        return otherRunWorking(doc.runId, runLockKeyOf(doc.scope))
      },
      settings: async (folder) => {
        const snap = await configService.snapshot({ folder }).catch(() => null)
        return snap?.config?.git ?? { commit: false, pullRequest: false, remote: 'origin' }
      },
      changes: async (doc) => {
        const ends = segmentEnds(doc.state, 'combined')
        if (ends === undefined) return null
        const scope = workScopeOf(doc)
        try {
          await stat(paths.shadowRepo(scope.folderKey))
        } catch {
          return null
        }
        const shadow = await shadowFor(await resolveScope(scope.folder), { home: paths.home })
        const set = new Set<string>()
        for (const c of await shadow.changes(ends.from.commit, ends.to.commit)) {
          set.add(c.path)
          if (c.oldPath !== undefined) set.add(c.oldPath)
        }
        const now = await shadow.treeNow()
        const since = new Set<string>()
        for (const c of await shadow.changes(ends.to.commit, now.tree)) {
          if (set.has(c.path)) since.add(c.path)
          if (c.oldPath !== undefined && set.has(c.oldPath)) since.add(c.oldPath)
        }
        return { paths: [...set].sort(), since: [...since].sort() }
      },
      hooksPath: paths.emptyHooksDir,
      gh: () => ghCommandFor(env),
      now: clock.now,
      env,
    },
  }

  // ---- New project (templates.list, project.create): templates are data; no create command, no network ---------
  const projectHost: ProjectHost = {
    templates: () => loadTemplates({ home: paths.home }),
    create: async (req) => {
      const list = await loadTemplates({ home: paths.home })
      const view = templateById(list, req.templateId)
      if (view === undefined) {
        throw new DimFactoryError(
          'VALIDATION',
          `There is no template "${req.templateId}". Choose one from the list.`,
        )
      }
      const folder = await prepareProjectFolder(req.folder, {
        home: paths.home,
        emptyHooksDir: paths.emptyHooksDir,
        env,
      })
      // The folder is a repository now: its scope and folder.git are read again, as after git.init.
      forgetFolder(folder)
      engine.cache.invalidateConfig()
      // A built-in template's bundled files (a game's starter engine), hash-checked, before the run starts.
      await copyTemplateFiles(view, folder).catch((err: unknown) => {
        throw new DimFactoryError(
          'VALIDATION',
          `The starter files could not be copied into the project: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      const created = projectCreated(folder, view.template, req.goal)
      // Saved as the folder's brief, so the composer restores the template's choices like any saved brief.
      await briefs.save(folder, created.brief)
      return created
    },
  }

  // ---- the factory: task queues, budgets and stop rules, the schedule, the daily report ---------------------------
  /** The user file's `factory` over the defaults (the schedule key by key). */
  const factorySettings = (): FactorySettings => {
    const u = configService.user?.value?.factory
    const d = FACTORY_DEFAULTS
    return {
      ...d,
      ...(u ?? {}),
      schedule: { ...d.schedule, ...(u?.schedule ?? {}), days: [...(u?.schedule?.days ?? d.schedule.days)] },
    } as FactorySettings
  }
  const factoryService = new FactoryService({
    home: paths.home,
    clock,
    log: log.child({ part: 'factory' }),
    bus,
    settings: factorySettings,
    folderConfig: async (folder, recipeId) => {
      const recipe = await recipeFor(folder, recipeId).catch(() => undefined)
      const snap = await configService
        .snapshot({ folder, ...(recipe !== undefined ? { recipe } : {}) })
        .catch(() => null)
      return snap?.config ?? null
    },
    startRun: (req) => startRun(req),
    stopRun: async (runId) => {
      const c = await attach(runId)
      const r = await c.command({ kind: 'stop' })
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
    },
    summaries: () => ctx.summaries(),
    summary: (runId) => {
      const c = controllers.get(runId)
      return c !== undefined ? summarize(c.state) : (index?.get(runId) ?? roIndex?.get(runId))
    },
    estimate: async (req) => {
      const est = await ctx.dashboard?.estimate(req.folder, req.overrides, req.brief, req.recipe)
      return est?.total.costUsd?.p50 ?? null
    },
    // A queued rematch: started as any rematch is; the queue follows the challenger's build.
    startRematch: async (r) => {
      const m = await matchService.rematch({
        runId: r.runId,
        challenger: r.challenger,
        ...(r.blind === true ? { blind: true } : {}),
      })
      const b = m.sides[1]
      if (b.runId === undefined || b.displayNo === undefined) {
        throw new DimFactoryError('INTERNAL', 'The rematch started without its new build.')
      }
      return { runId: b.runId, displayNo: b.displayNo, matchId: m.matchId }
    },
    estimateRematch: (runId) =>
      Promise.resolve((index?.get(runId) ?? roIndex?.get(runId))?.progress.costUsd ?? null),
    // A completed task's work goes on its branch when the project opted into commits; the run branch is then left
    // for the branch the run came from, so the next task starts from there.
    commitTask: async (runId) => {
      const git = deployHost.runGit
      if (git === undefined) return null
      const p = await commitPreview(git, runId)
      if (!p.enabled || p.where === null || p.blocked !== undefined || p.committed !== undefined) return null
      const commit = p.paths.length > 0 ? await commitRun(git, runId) : undefined
      const doc = await git.readDoc(runId)
      const b = doc?.state.branch
      if (doc !== null && b !== undefined && p.where === 'run-branch' && !('blocked' in commitWhere(doc))) {
        // Never under another run working in the folder.
        const busy = await folderBusy(doc.scope.folder)
        if (busy !== undefined)
          throw new DimFactoryError('FOLDER_BUSY', `${busy} The run branch was left as it is.`)
        await switchBack({ folder: doc.scope.folder, branch: b, hooksPath: paths.emptyHooksDir })
      }
      const branch = commit?.branch ?? p.branch
      return branch !== null ? { branch, ...(commit !== undefined ? { commit: commit.sha } : {}) } : null
    },
    afterRun: (s) => memoryService.onRunEnded(s),
    schedule: !readOnly && o.host.kind === 'app',
    readOnly,
  })
  const fallbackService = readOnly
    ? undefined
    : new FallbackService({
        bus,
        log: log.child({ part: 'fallback' }),
        controller: (runId) => controllers.get(runId),
        vendors: vendorReadiness,
        vendorName,
        withinBudget: (runId) => factoryService.withinBudget(runId),
        record: (f) => factoryService.recordFallback(f),
        now: clock.now,
      })
  const factoryHost: FactoryHost = {
    service: factoryService,
    memory: memoryService,
    gh: () => ghCommandFor(env),
    env,
  }

  // ---- Easy mode: an idea resolved locally, a new project from its template, the run; and run limits --------------
  /** The profile for the vendors that are ready now (balanced, claude-only or codex-only). */
  const easyReadiness = () => {
    const sel = selectFirstLaunchProfile(configService.readiness())
    return { claude: sel.claudeReady, codex: sel.codexReady, profile: sel.profile, runnable: sel.runnable }
  }
  const easyService = new EasyService({
    home: paths.home,
    documentsDir,
    // The default projects folder moves out of a OneDrive-synced Documents into the user's own folder (an E2E app's
    // user folder is the test's own).
    userDir: e2eOn ? (env[envName('E2E_USER_HOME')] ?? dirname(documentsDir)) : homedir(),
    env,
    newHome: easyNewHome,
    log: log.child({ part: 'easy' }),
    now: clock.now,
    readUser: async () => (await configService.read({ scope: 'user' })).value,
    patchUser: async (ops) => {
      await configService.patch({ scope: 'user', ops })
    },
    packs: async () => (await loadPacks({ home: paths.home })).packs.map((v) => v.pack),
    templates: () => loadTemplates({ home: paths.home }),
    readiness: easyReadiness,
    toolchain: async (t) => {
      const lookup = { entries: (await resolvePathEnv({ env })).entries, env }
      // An E2E test may say which Node.js is installed (none, or a version); Python is still looked up.
      const forced = e2eOn ? e2eToolchain(env[envName('E2E_NODE')], false) : undefined
      if (forced !== undefined) return { ...forced, python: (await detectToolchain(lookup)).python }
      if (t?.fresh === true) forgetNodeVersions()
      return detectToolchain(lookup)
    },
    // The estimate for the run as runs.start would shape it (its depth decided the same way).
    estimate: async (req, hints) => {
      const folder = resolve(req.folder)
      const recipe = await recipeFor(folder, req.recipe)
      const brief = briefWithRecipe(req.brief, recipe?.recipe)
      const researched = await researchOverrides(folder, req.overrides, brief, recipe)
      const decision = await decideRunDepth(folder, req.task, researched, brief, recipe, hints)
      const { snap } = await configForDepth(folder, researched, recipe, decision)
      if (snap.config === undefined) return null
      return estimateFor(snap.config, snap.folderKey, await testFirstOf(folder, brief))
    },
    // Quick or Thorough for an Easy run, as runs.start will decide it (the confirm screen shows it).
    depth: async (req, hints) => {
      const folder = resolve(req.folder)
      const recipe = await recipeFor(folder, req.recipe)
      const brief = briefWithRecipe(req.brief, recipe?.recipe)
      const researched = await researchOverrides(folder, req.overrides, brief, recipe)
      return (await decideRunDepth(folder, req.task, researched, brief, recipe, hints)) ?? null
    },
    prepareFolder: async (folder) => {
      const made = await prepareProjectFolder(folder, {
        home: paths.home,
        emptyHooksDir: paths.emptyHooksDir,
        env,
      })
      // The folder is a repository now: its scope and folder.git are read again, as after git.init.
      forgetFolder(made)
      engine.cache.invalidateConfig()
      return made
    },
    saveBrief: (folder, brief) => briefs.save(folder, brief),
    readBrief: (folder) => readSavedBrief(paths.home, folder),
    copyTemplateFiles: (view, folder) => copyTemplateFiles(view, folder),
    startRun: (req, hints) => startRun(req, hints),
    // "Make two and pick": a match with the names hidden, its sides shaped by the same hints as an Easy run.
    startTwo: async (req, sides, hints) => {
      const m = await matchService.start({
        ...req,
        sides,
        blind: true,
        ...(hints !== undefined ? { hints: { ...hints } } : {}),
      })
      return { matchId: m.matchId, runId: m.sides[0].runId, displayNo: m.sides[0].displayNo }
    },
    summaries: () => ctx.summaries(),
    closeRun: async (runId) => {
      const c = await attach(runId)
      const r = await c.command({ kind: 'close' })
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
    },
    runTask: async (runId) => {
      const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
      return doc !== null ? { task: doc.state.task, folder: doc.state.folder } : null
    },
    exists: (p) => existsSync(p),
    grantPermission: async (folder) => {
      await permissions.grant(folder)
    },
    checkAttachments: async (list) => checkAttachments(list, await attachContext()),
    copyAttachments: async (list, project) => copyAttachments(list, project, await attachContext()),
    checks: async (folder) =>
      (await discoverCommands(folder, { scopeRoot: folder }))
        .filter((c) => c.enabledByDefault && c.run.length > 0)
        .map((c) => ({ name: c.name, run: [...c.run], ...(c.cwdRel !== '.' ? { cwd: c.cwdRel } : {}) })),
    inspectFolder: (folder) => inspectExisting(folder, { home: paths.home, env }),
    turnOnUndo: async (folder) => {
      await initRepository(folder, { dimFactoryHome: paths.home, emptyHooksDir: paths.emptyHooksDir, env })
      // The folder is a repository now: its scope and folder.git are read again, as after git.init.
      forgetFolder(folder)
      engine.cache.invalidateConfig()
    },
    saveFirst: async (folder) => {
      const top = (await detectRepo(folder)).toplevel ?? folder
      await saveFirst(top, { emptyHooksDir: paths.emptyHooksDir })
    },
    intentHelper: async () => {
      const who = await planWho(undefined)
      if (who === null) return null
      const c = await chooseSuggester(easyCallDeps, who.vendor, who.model)
      return c === null ? null : { ...c, usd: readOnlyPrice(c.vendor, c.model, INTENT_TOKENS) }
    },
    ...(readOnly
      ? {}
      : {
          queue: {
            add: async (folder, task) => {
              await factoryService.add(folder, [task])
            },
            view: () => factoryService.view(),
            start: async (folders, noticeId) => {
              await factoryService.start(folders, noticeId !== undefined ? { noticeId } : {})
            },
            pause: async (folders) => {
              await factoryService.pause(folders)
            },
            remove: async (folder, id) => {
              await factoryService.remove(folder, id)
            },
            schedule: async (at) => {
              // Every day from `at`, with no end: the list runs until it is done. The other schedule keys stay.
              await configService.patch({
                scope: 'user',
                ops: [
                  { op: 'add', path: '/factory/schedule/enabled', value: true },
                  { op: 'add', path: '/factory/schedule/start', value: at },
                  { op: 'add', path: '/factory/schedule/end', value: null },
                  { op: 'add', path: '/factory/schedule/days', value: [0, 1, 2, 3, 4, 5, 6] },
                ],
              })
            },
          },
        }),
  })
  /** The read-only one-off calls Easy makes on the user's click ("Help me choose", "Look it over"). */
  const easyCallDeps: SuggestDeps = {
    home: paths.home,
    now: clock.now,
    registry: adapters,
    isReady: readOnlyCallReady,
    flagMap: (vendor) => vendorFlagMap(vendor),
    log: log.child({ part: 'easy' }),
  }
  /** One read-only call's cost at the catalog's price: about three quarters of its tokens in, the rest out. */
  const readOnlyPrice = (vendor: string, model: string | null, tokens: number): number | null => {
    try {
      const p = estimatePrice(vendor, model)
      if (!('rates' in p)) return null
      const input = Math.round(tokens * 0.75)
      return catalogCostUsd({ input, output: tokens - input }, p.rates, p.reasoningIncludedInOutput)
    } catch {
      return null
    }
  }
  /** The folder as the prompt check reads it: nothing yet, only data to work on, or a project. */
  const promptFolder = async (folder: string): Promise<PromptFolder> => {
    const f = await depthFolderSize(folder)
    return isNewFolder(f) ? 'new' : f.dataOnly === true ? 'data' : 'project'
  }
  /** A run's folder (live, or from its saved document); NOT_FOUND when there is no such run. */
  const runFolder = async (runId: string): Promise<string> => {
    const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
    if (doc === null) throw new DimFactoryError('NOT_FOUND', 'That run is not here any more.')
    return doc.state.folder
  }
  /** The cheapest model the catalog prices for a vendor (null: none priced, so the vendor's default). */
  const cheapModel = (vendor: string): string | null =>
    cheapestModel(catalogData()?.pricing.entries ?? [], adapters.resolveId(vendor))
  /** Who answers "Ask about it" in a folder: its Plan pass's vendor (else the first ready one) on its cheapest model. */
  const askWho = async (folder: string): Promise<{ vendor: string; model: string | null } | null> => {
    const vendor = (await planWho(folder))?.vendor ?? 'claude'
    const c = await chooseSuggester(easyCallDeps, vendor, cheapModel(vendor))
    return c === null ? null : { vendor: c.vendor, model: c.model ?? cheapModel(c.vendor) }
  }
  /** Whether a run made a game (its Brief's category). */
  const isGameRun = async (runId: string): Promise<boolean> => {
    const live = controllers.get(runId)
    const state = live !== undefined ? live.state : (await readRunDoc(paths, runId))?.state
    return (state as { category?: string } | undefined)?.category === GAMES_CATEGORY
  }
  /** Who would look at a run's page: a ready vendor that takes pictures (the Plan pass's first). */
  const visualWho = async (): Promise<{ vendor: string; model: string | null } | null> => {
    const who = await planWho(undefined)
    return chooseSuggester(easyCallDeps, who?.vendor ?? 'claude', who?.model ?? null, { images: true })
  }
  /** Where added files may not come from: the OS home's and Dim Factory's own folders, real paths (attach.ts). */
  const attachContext = async (): Promise<AttachContext> => ({
    platform: process.platform,
    home: await realpath(extensionsHome).catch(() => extensionsHome),
    dimFactoryHome: await realpath(paths.home).catch(() => paths.home),
    env,
  })
  /** A run's own limits: its config's, live or from resolved.json (null: none, or unreadable). */
  const runLimitsOf = async (runId: string): Promise<RunLimits | null> => {
    const live = controllers.get(runId)
    if (live !== undefined) return (live.deps.config as Partial<ResolvedConfig>).limits ?? null
    try {
      const raw = JSON.parse(await readFile(paths.run(runId).resolvedJson, 'utf8')) as {
        config?: { limits?: unknown }
      }
      const parsed = RunLimitsZ.safeParse(raw.config?.limits)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  const runLimits = readOnly
    ? undefined
    : new RunLimitsWatcher({
        clock,
        log: log.child({ part: 'limits' }),
        bus,
        limitsOf: (runId) =>
          (controllers.get(runId)?.deps.config as Partial<ResolvedConfig> | undefined)?.limits ?? null,
        summary: (runId) => {
          const c = controllers.get(runId)
          return c !== undefined ? summarize(c.state) : (index?.get(runId) ?? roIndex?.get(runId))
        },
        stopRun: async (runId) => {
          const c = await attach(runId)
          const r = await c.command({ kind: 'stop' })
          if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
        },
        stopFile: (runId) => join(paths.run(runId).dir, 'limit-stop.json'),
      })
  const easyHost: EasyHost = {
    state: () => easyService.state(),
    setExperience: (experience) => easyService.setExperience(experience),
    resolve: (req) => easyService.resolve(req),
    create: (req) => easyService.create(req),
    change: (req) => easyService.change(req),
    changeEstimate: (req) => easyService.changeEstimate(req),
    projects: () => easyService.projects(),
    limits: async (runId) => {
      const limits = (await runLimitsOf(runId)) ?? { ...RUN_LIMITS_NONE }
      const stop = await readLimitStop(join(paths.run(runId).dir, 'limit-stop.json'))
      return { limits, ...(stop !== undefined ? { stop } : {}) }
    },
    attachCheck: (list) => easyService.checkAttachments(list),
    permissions: async () => {
      await permissions.load()
      return permissions.list()
    },
    permission: async (folder, runId) => {
      await permissions.load()
      return permissions.view(folder, runId)
    },
    revokePermission: async (folder) => {
      await permissions.revoke(folder)
      return permissions.list()
    },
    inspectFolder: (folder) => easyService.inspectFolder(folder),
    work: (req) => easyService.work(req),
    intent: async (idea, candidates) => {
      const who = await planWho(undefined)
      const r = await readOnlyAnswer(easyCallDeps, {
        vendor: who?.vendor ?? 'claude',
        model: who?.model ?? null,
        prompt: intentPrompt(idea, candidates),
        area: 'easy-intent',
        label: INTENT_LABEL,
        noVendor: INTENT_NO_VENDOR,
      })
      const answer = parseIntentAnswer(r.text, candidates)
      if (answer === null) throw new DimFactoryError('VALIDATION', INTENT_BAD_ANSWER)
      return { ...answer, vendor: r.vendor }
    },
    visual: async (runId) => {
      const [who, last, game] = await Promise.all([visualWho(), readVisual(paths, runId), isGameRun(runId)])
      return {
        ...(game ? { game: true as const } : {}),
        vendor: who?.vendor ?? null,
        ...(who === null ? { reason: VISUAL_NO_VENDOR } : {}),
        usd: who !== null ? readOnlyPrice(who.vendor, who.model, VISUAL_TOKENS) : null,
        picture: existsSync(smokePicture(paths, runId)),
        findings: last?.findings ?? [],
      }
    },
    visualReview: async (runId) => {
      const picture = smokePicture(paths, runId)
      if (!existsSync(picture)) throw new DimFactoryError('VALIDATION', VISUAL_NO_PICTURE)
      const who = await visualWho()
      if (who === null) throw new DimFactoryError('UNSUPPORTED', VISUAL_NO_VENDOR)
      // A game is looked at in two pictures: its title screen and a moment of play (when the game checks took one).
      const play = gameplayPicture(paths, runId)
      const game = (await isGameRun(runId)) && existsSync(play)
      const r = await readOnlyAnswer(easyCallDeps, {
        vendor: who.vendor,
        model: who.model,
        prompt: visualPrompt(game ? 'game' : 'page'),
        area: 'easy-visual',
        images: game ? [picture, play] : [picture],
        label: VISUAL_LABEL,
        noVendor: VISUAL_NO_VENDOR,
      })
      const findings = parseVisualAnswer(r.text)
      if (findings === null) throw new DimFactoryError('VALIDATION', VISUAL_BAD_ANSWER)
      const merged = await recordVisual(paths, runId, { at: clock.now(), vendor: r.vendor, findings })
      if (merged !== null) await mergePreviewFindings(runId, merged)
      return { vendor: r.vendor, findings }
    },
    helperCost: async (helper, runId) => {
      if (helper === 'ask') {
        if (runId === undefined) throw new DimFactoryError('VALIDATION', 'Ask about it needs a project.')
        const who = await askWho(await runFolder(runId))
        return who === null
          ? { helper: null, reason: ASK_NO_VENDOR }
          : { helper: { ...who, usd: readOnlyPrice(who.vendor, who.model, ASK_TOKENS) } }
      }
      const who = await planWho(undefined)
      const c = await chooseSuggester(easyCallDeps, who?.vendor ?? 'claude', who?.model ?? null)
      return c === null
        ? { helper: null, reason: THINK_NO_VENDOR }
        : { helper: { ...c, usd: readOnlyPrice(c.vendor, c.model, THINK_TOKENS) } }
    },
    think: async (req) => {
      const last = req.finish === true || req.turns.length >= EASY_THINK_ROUNDS
      const who = await planWho(undefined)
      const r = await readOnlyAnswer(easyCallDeps, {
        vendor: who?.vendor ?? 'claude',
        model: who?.model ?? null,
        prompt: thinkPrompt(req.idea, req.turns, last),
        area: 'easy-think',
        label: THINK_LABEL,
        noVendor: THINK_NO_VENDOR,
      })
      const answer = parseThinkAnswer(r.text, { idea: req.idea, turns: req.turns, last })
      if (answer === null) throw new DimFactoryError('VALIDATION', THINK_BAD_ANSWER)
      return { ...answer, vendor: r.vendor }
    },
    ask: async (runId, question) => {
      const folder = await runFolder(runId)
      const who = await askWho(folder)
      if (who === null) throw new DimFactoryError('UNSUPPORTED', ASK_NO_VENDOR)
      const r = await readOnlyAnswer(easyCallDeps, {
        vendor: who.vendor,
        model: who.model,
        prompt: askPrompt(question),
        area: 'easy-ask',
        folder,
        timeoutMs: ASK_TIMEOUT_MS,
        label: ASK_LABEL,
        noVendor: ASK_NO_VENDOR,
      })
      const answer = askAnswerText(r.text)
      if (answer === '') throw new DimFactoryError('VALIDATION', ASK_NO_ANSWER)
      return { answer, vendor: r.vendor, model: r.model }
    },
    shareFiles: async (runId) => shareFiles(await runFolder(runId)),
    queue: () => easyService.queueView(),
    queueAdd: (req) => easyService.queueAdd(req),
    queueStart: (req) => easyService.queueStart(req),
    queuePause: () => easyService.queuePause(),
    queueRemove: (folder) => easyService.queueRemove(folder),
  }

  // Isolated runs: worktree.* through the run's controller; the preview reads directly. A match keeps a side with it.
  const worktreeHost = createWorktreeHost({
    paths,
    controller: (runId) => attach(runId),
    readDoc: async (runId) => controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId)),
  })

  // ---- matches (match/service.ts): Head to head, each side an isolated run in a copy made from one snapshot --------
  const matchService = new MatchService({
    paths,
    now: clock.now,
    log: log.child({ part: 'match' }),
    knownVendor: (vendor) => adapters.get(adapters.resolveId(vendor)) !== undefined,
    planRun: (req, hints) => planRun(req, hints, { snapshotCopy: true }),
    snapshot: async (folder, id) => {
      const sh = await shadowFor(await resolveScope(folder), { home: paths.home })
      const rec = await sh.snapshot(id, 'match-start')
      return { tree: rec.tree, commit: rec.commit, folderKey: sh.folderKey }
    },
    dropStartRef: async (folderKey, id) => {
      await deleteRunRefs(paths.home, folderKey, [id], { now: clock.now() })
    },
    summary: (runId) => {
      const c = controllers.get(runId)
      return c !== undefined ? summarize(c.state) : (index?.get(runId) ?? roIndex?.get(runId))
    },
    runExists: (id) =>
      Promise.resolve(
        controllers.has(id) ||
          index?.get(id) !== undefined ||
          roIndex?.get(id) !== undefined ||
          existsSync(paths.run(id).dir),
      ),
    stopRun: async (runId) => {
      const c = await attach(runId)
      const r = await c.command({ kind: 'stop' })
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
    },
    state: async (runId) => controllers.get(runId)?.state ?? (await readRunDoc(paths, runId))?.state,
    worktree: worktreeHost,
    keepForLater: async (runId) => {
      const c = await attach(runId)
      // The card that asks what to do with the copy is open only while the copy waits for that answer.
      const card = c.state.cards.find((x) => x.view.kind === 'finalize')?.view
      if (c.state.isolation?.finalize?.state !== 'pending' || card === undefined) return
      const r = await c.command({ kind: 'card', cardId: card.id, choiceId: FINALIZE_CHOICE.keep })
      if (!r.ok) throw new DimFactoryError(r.error.code, r.error.message)
    },
    files: async (runId) => (await runDiffs.files(runId, 'combined')).files,
    result: async (runId) => {
      const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
      if (doc === null) return null
      const ends = segmentEnds(doc.state, 'combined')
      if (ends === undefined) return null
      const scope = workScopeOf(doc)
      return { gitDir: paths.shadowRepo(scope.folderKey), workTree: scope.scopeRoot, to: ends.to.commit }
    },
    saveDiffs: async (runId) => (await runDiffs.persistRuns([runId])).failed.length === 0,
    thumbnail: async (runId) => (await readRunSmoke(paths, runId))?.thumbnail ?? null,
    changed: (matchId) => bus.global({ kind: 'match', matchId }),
    random: Math.random,
    autoStart: !readOnly && o.host.kind === 'app',
    planRematch: (runId, c) => planRematchSide(rerunHost, runId, c),
    hasStart: async (src, commit) => {
      const reader = await ShadowReader.open(paths.shadowRepo(src.folderKey))
      return reader !== null && (await reader.has([commit]))
    },
    vendorsRanIn: (folderKey) => {
      const seen = new Set<string>()
      const all = index !== null ? index.list() : [...(roIndex?.values() ?? [])]
      for (const s of all) {
        if (s.folderKey !== folderKey) continue
        for (const st of s.steps) if (st.vendor !== undefined && st.status !== 'queued') seen.add(st.vendor)
      }
      return [...seen]
    },
    pin: (runId) => history.pin(runId, true),
    patchOf: async (runId) => {
      const doc = controllers.get(runId)?.doc() ?? (await readRunDoc(paths, runId))
      const ends = doc !== null ? segmentEnds(doc.state, 'combined') : undefined
      if (doc === null || ends === undefined) return null
      const scope = workScopeOf(doc)
      const reader = await ShadowReader.open(paths.shadowRepo(scope.folderKey), scope.scopeRoot)
      if (reader === null) return null
      const p = await reader.patch(ends.from.commit, ends.to.commit)
      return p.truncated ? null : p.text
    },
    runs: () => ctx.summaries(),
    queueAdd: async (folder, tasks) => {
      await factoryService.add(folder, tasks)
    },
    addedModels: async () =>
      (await listCatalogHistory(paths))
        .filter((h) => h.source === 'refresh' && h.undone !== true && h.added !== undefined)
        .flatMap((h) => (h.added ?? []).map((a) => ({ vendor: a.vendor, model: a.model, at: h.at }))),
    openTask: async (folder, task) =>
      checkPrompt({ task, folder: await promptFolder(folder), recipe: undefined }).length > 0,
  })
  onMatchSummary = (s) => matchService.onSummary(s)

  const ctx: HandlerContext = {
    kind: o.host.kind,
    readOnly,
    paths,
    bus,
    adapters,
    preflight: engine,
    now: clock.now,
    startRun,
    controller: (runId) => attach(runId),
    liveController: (runId) => controllers.get(runId),
    readDoc: async (runId) => {
      const live = controllers.get(runId)
      if (live !== undefined) return live.doc()
      // A run this process has not loaded shows its waits disarmed and no heal running (as loading it would).
      const doc = await readRunDoc(paths, runId)
      return doc !== null ? { ...doc, state: disarmOnLoad(doc.state, clock.now()) } : null
    },
    summaries: () => {
      const map = new Map<string, RunSummary>(
        (index?.list() ?? [...(roIndex?.values() ?? [])]).map((s) => [s.runId, s]),
      )
      for (const c of controllers.values()) map.set(c.runId, summarize(c.state))
      // A run removed and waiting for its undo window is not listed.
      return [...map.values()].filter((s) => !historyState.isHidden(s.runId))
    },
    summarize,
    // depth.decide: Quick or Thorough for the composer's task, exactly as runs.start would decide it.
    decideDepth: async (req) => {
      const recipe = await recipeFor(req.folder, req.recipe)
      const brief = briefWithRecipe(req.brief, recipe?.recipe)
      const d = await decideRunDepth(
        req.folder,
        req.task,
        await researchOverrides(req.folder, req.overrides, brief, recipe),
        brief,
        recipe,
      )
      if (d === undefined) throw new DimFactoryError('VALIDATION', 'The configuration could not be resolved.')
      return d
    },
    matches: matchService,
    // task.check: what the task as typed might leave out (no model call), and who could sharpen it.
    checkTask: async (req) => {
      const hints = checkPrompt({
        task: req.task,
        folder: await promptFolder(req.folder),
        recipe: req.recipe,
      })
      if (hints.length === 0) return { hints, sharpen: null }
      const who = await askWho(req.folder)
      return who === null
        ? { hints, sharpen: null, sharpenReason: SHARPEN_NO_VENDOR }
        : { hints, sharpen: { ...who, usd: readOnlyPrice(who.vendor, who.model, SHARPEN_TOKENS) } }
    },
    // task.sharpen: one read-only call (never in the project's folder) that proposes a clearer task.
    sharpenTask: async (req) => {
      const task = req.task.trim()
      if (task === '') throw new DimFactoryError('VALIDATION', SHARPEN_EMPTY)
      if (task.length > PROMPT_SHARPEN_MAX) throw new DimFactoryError('VALIDATION', SHARPEN_TOO_LONG)
      const who = await askWho(req.folder)
      if (who === null) throw new DimFactoryError('UNSUPPORTED', SHARPEN_NO_VENDOR)
      const hints = checkPrompt({ task, folder: await promptFolder(req.folder), recipe: req.recipe })
      const r = await readOnlyAnswer(easyCallDeps, {
        vendor: who.vendor,
        model: who.model,
        prompt: sharpenPrompt(task, hints),
        area: 'task-sharpen',
        label: SHARPEN_LABEL,
        noVendor: SHARPEN_NO_VENDOR,
      })
      const sharpened = parseSharpenAnswer(r.text)
      if (sharpened === null) throw new DimFactoryError('VALIDATION', SHARPEN_BAD_ANSWER)
      return { task: sharpened, vendor: r.vendor }
    },
    livePreflight: async (folder, overrides, given, recipeId) => {
      const recipe = await recipeFor(folder, recipeId)
      const brief = briefWithRecipe(given, recipe?.recipe)
      const { input } = await configForDepth(
        folder,
        await researchOverrides(folder, overrides, brief, recipe),
        recipe,
      )
      if (await testFirstOf(folder, brief)) input.testFirst = true
      const research = await researchFacts(folder, input.config, brief?.category)
      if (research !== undefined) input.research = research
      const report = await engine.run('live', input)
      recoveryActions.record(folder, report, passesOfConfig(input.config))
      return report
    },
    config: configService,
    brief: briefHost,
    preview: previewHost,
    deploy: deployHost,
    project: projectHost,
    factory: factoryHost,
    easy: easyHost,
    // Prove it: Claude only, the catalog's cheapest Claude model, in a folder under this home.
    ...(readOnly
      ? {}
      : {
          guardrails: {
            prove: (kind: ProveKind) =>
              proveRule(
                {
                  home: paths.home,
                  adapter: adapters.isBuilt(PROVE_VENDOR) ? adapters.get(PROVE_VENDOR) : undefined,
                  model: cheapestModel(
                    catalogData()?.pricing.entries ?? [],
                    adapters.resolveId(PROVE_VENDOR),
                  ),
                  now: clock.now,
                },
                kind,
              ),
            claudeVersion: () =>
              engine.cache.effectiveProbe(adapters.resolveId(PROVE_VENDOR))?.version ?? null,
          },
        }),
    recovery: recoveryHost,
    runGit,
    diffView,
    storage,
    // runs.pin, runs.remove, runs.undoRemove (history.ts).
    history,
    // catalog.get / apply / undo / savePrice / setSchedule (handlers-catalog-data.ts, catalog/live.ts).
    ...(catalogLive !== undefined ? { catalog: catalogLive } : {}),
    // runs.rerun (Re-run with same config, Re-run from Fix).
    ...(readOnly ? {} : { rerun: (req: RerunRequest) => rerunRun(rerunHost, req) }),
    // catalog.refreshPlan / refresh{consent:true} / cancel (refresh-jobs.ts).
    ...(catalogJobs !== undefined ? { catalogJobs } : {}),
    worktree: worktreeHost,
    viewInputs,
    dashboard: {
      attention: () => currentAttention(),
      vendorHealth: () =>
        adapters.list().map((e) => probeView(adapters, e.id, engine.cache.effectiveProbe(e.id) ?? null)),
      // The setup card's git row (the setup card probes vendors and git): a folder-less live preflight runs the app
      // checks only (app.git is cached for an hour, re-run after its install command was copied). Writable cores
      // only: app.home.writable writes a probe file.
      ...(readOnly
        ? {}
        : {
            appChecks: async () => {
              const r = await engine.run('live', {})
              const results = [...r.blocking, ...r.warnings, ...r.info].filter((c) => c.scope === 'app')
              recoveryActions.recordApp(results)
              return results
            },
          }),
      catalogData,
      catalogStatus: catalogStatusNow,
      pricing: spendPricing,
      // The config exactly as runs.start resolves it (invalid overrides: VALIDATION from configForRun).
      estimate: async (folder, overrides, given, recipeId) => {
        const recipe = await recipeFor(folder, recipeId)
        const brief = briefWithRecipe(given, recipe?.recipe)
        const { snap } = await configForDepth(
          folder,
          await researchOverrides(folder, overrides, brief, recipe),
          recipe,
        )
        if (snap.config === undefined) {
          throw new DimFactoryError(
            'VALIDATION',
            snap.error?.message ?? 'The config could not be resolved.',
            {
              details: { issues: snap.error?.issues ?? [] },
            },
          )
        }
        return estimateFor(snap.config, snap.folderKey, await testFirstOf(folder, brief))
      },
    },
  }
  const handlers: HandlerMap = createHandlers(ctx)
  // Settings > Extensions: names only, read now (a vendor's settings may change at any time), never logged.
  handlers['extensions.discover'] = (req) =>
    Promise.resolve(
      withConnectors(
        withHandshakeNames(
          discoverExtensions({
            envFor: extensionsEnvFor,
            home: extensionsHome,
            ...(req.folder !== undefined ? { folder: req.folder } : {}),
          }),
          claude.handshakeNames(),
        ),
        claude.listedConnectors(),
      ),
    )
  // The claude.ai connectors: an initialize-only Claude session (no tokens), only where it starts no other MCP server.
  handlers['extensions.claudeConnectors'] = async (req) => {
    const r = await claude.listConnectors(req.force === true ? { force: true } : {})
    if (r.ok) return { ok: true, count: r.connectors.length }
    return {
      ok: false,
      count: 0,
      ...(r.blocked !== undefined ? { blocked: r.blocked } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
    }
  }

  // ---- outside agents (MCP): app hosts only; it listens only once the user turned it on --------------------------
  const externalMcp =
    !readOnly && o.host.kind === 'app'
      ? new ExternalMcp({
          paths,
          log: log.child({ part: 'mcp' }),
          now: clock.now,
          env,
          invoke: (cmd, req) => dispatch(handlers, cmd, req),
          startRun,
          readTask: async (runId) => {
            const live = controllers.get(runId)
            if (live !== undefined) return live.state.task
            return (await readRunDoc(paths, runId).catch(() => null))?.state.task ?? null
          },
          emit: (pending) => bus.global({ kind: 'mcp-requests', requests: pending }),
          bridge: o.externalMcp?.bridge ?? null,
          runCodex:
            o.externalMcp?.runCodex ??
            codexRunner({
              env,
              vendor: () => ({ path: codexCfg?.path ?? null, env: vendorEnvOf(codexCfg) }),
              search: vendorSearch,
            }),
          runClaude:
            o.externalMcp?.runClaude ??
            claudeRunner({
              env,
              vendor: () => ({ path: claudeCfg?.path ?? null, env: vendorEnvOf(claudeCfg) }),
              search: vendorSearch,
            }),
        })
      : undefined
  if (externalMcp !== undefined) Object.assign(handlers, externalMcp.handlers())

  // ---- recovery -------------------------------------------------------------------------------------------------
  let recovery = emptyRecoveryReport()
  if (!readOnly && index !== null) {
    // Attention at boot: the state of every unfinished run recovery looked at. Those it did not load
    // (left waiting on a card, paused, failed) become `dormant`; restoreHolder hands over a lock holder's state as
    // projected from its log.
    const seen = new Map<string, RunState>()
    // Chaos: after a crash, a finished run the crashed session wrote to may have finalize work in flight (an undo
    // or a discard of a completed run) or an index line behind its run.json: those runs are looked at too, and the
    // temp files of atomic writes the crash cut short are removed from the home and those runs' folders.
    const crashedSince =
      b.session?.session.uncleanExit === true ? b.session.session.previous?.startedAt : undefined
    recovery = await recoverRuns({
      candidates: async () => {
        const ids = await listRunIds(paths)
        const touched = async (id: string): Promise<boolean> =>
          crashedSince !== undefined &&
          (await stat(paths.run(id).runJson).then(
            (st) => st.mtimeMs >= crashedSince,
            () => false,
          ))
        const picked: string[] = []
        for (const id of ids) {
          const s = index.get(id)
          if (
            s === undefined ||
            (s.status !== 'completed' && s.status !== 'cancelled') ||
            s.endedAt === undefined ||
            summaryWorkPending(s) ||
            (await touched(id))
          )
            picked.push(id)
        }
        if (crashedSince !== undefined) await sweepStaleTemps(paths, picked, log)
        // A pass that never finished may have left its allowed MCP servers file (the user's secrets) behind.
        await sweepMcpScratch(picked.map((id) => paths.run(id).dir))
        return picked.sort()
      },
      readDoc: async (runId) => {
        const doc = await readRunDoc(paths, runId)
        if (doc !== null) seen.set(runId, doc.state)
        return doc
      },
      readLog: async (runId, sinceSeq) => {
        const envelopes: RunEnvelope[] = []
        const r = await forEachEnvelope(paths, runId, sinceSeq, (env) => envelopes.push(env))
        return { envelopes, lastSeq: r.lastSeq }
      },
      readText: (runId, file) => readFile(paths.run(runId).output(file), 'utf8').catch(() => null),
      readFindings: async (runId) => {
        try {
          const v: unknown = JSON.parse(await readFile(paths.run(runId).findingsJson, 'utf8'))
          return isPlainObject(v) &&
            Array.isArray(v['findings']) &&
            isPlainObject(v['selected']) &&
            isPlainObject(v['sources'])
            ? (v as unknown as FindingsFile)
            : null
        } catch {
          return null
        }
      },
      attach: (runId, doc) => attach(runId, doc),
      restoreHolder: (doc) => {
        seen.set(doc.runId, doc.state)
        scheduler.restoreHolder(doc.runId, runLockKeyOf(doc.scope))
      },
      log,
    })
    for (const c of controllers.values()) {
      if (isFinishedState(c.state)) continue
      void index.put(summarize(c.state)).catch(() => undefined)
    }
    // Chaos: an index line the dead instance never wrote (it was killed between a run's transition and the
    // line) is written now from run.json, for every run recovery read and did not load.
    for (const [runId, state] of seen) {
      if (controllers.has(runId)) continue
      const fresh = summarize(state)
      if (summaryStale(index.get(runId), fresh)) void index.put(fresh).catch(() => undefined)
    }
    const left = [...seen].filter(([id, s]) => !controllers.has(id) && s.started && !isFinishedState(s))
    for (const [runId, state] of left) dormant.set(runId, state)
    // Their run views get their ETA figures too (runs.get on a run nobody opened yet).
    await Promise.all(
      left.map(async ([runId]) => {
        const est = await readRunEstimate(paths.run(runId).dir)
        if (est !== null && !runEstimates.has(runId)) runEstimates.set(runId, est)
      }),
    )
    emitAttention()
  }

  // The watcher starts last: a change event needs the bus and the preflight engine.
  await configService.startWatching()

  // The factory's queues, after recovery (their tasks follow the runs as recovery left them): a queue that was running
  // comes back paused; a due schedule raises a notice (it goes on by itself only with "resume automatically").
  await factoryService.init().catch((err: unknown) => log.error('the factory could not start', { err }))
  // Run limits: every run with a cost or time limit of its own is followed from here on.
  runLimits?.start()

  // ---- history at boot, and the retention schedule (background probes and retention) -----------------------------
  // Pins and removals are checked against the index; removals an app that quit left are deleted (in the background).
  const historyBoot: Promise<void> = readOnly
    ? Promise.resolve()
    : history
        .boot()
        .catch((err: unknown) => log.error('runs history check at boot failed', { err }))
        // Then the matches' own leftovers (a starting ref both copies no longer need, a record whose runs are gone).
        .then(() => matchService.sweep())
        .then(
          () => undefined,
          (err: unknown) => log.warn('match sweep at boot failed', { err }),
        )
  /** No run is working: retention waits for this (paused and finished runs do not count). */
  const retentionIdle = (): boolean =>
    scheduler.queued().length === 0 &&
    [...controllers.values()].every((c) => c.closed || folderBusyReason(c.state) === undefined)
  const retentionOpt = o.retention ?? (o.host.kind === 'app' && env[envName('E2E')] !== '1')
  const retentionScheduler =
    !readOnly && retentionOpt !== false
      ? new RetentionScheduler({
          ...(typeof retentionOpt === 'object' && retentionOpt.bootDelayMs !== undefined
            ? { bootDelayMs: retentionOpt.bootDelayMs }
            : {}),
          ...(typeof retentionOpt === 'object' && retentionOpt.intervalMs !== undefined
            ? { intervalMs: retentionOpt.intervalMs }
            : {}),
          run: async () => {
            const r = await history.retention()
            // A match's own leftovers: its starting ref once both copies exist, its record once both runs are gone.
            await matchService.sweep().catch((err: unknown) => log.warn('match sweep failed', { err }))
            log.info('retention pass', {
              removed: r.removed.length,
              kept: r.kept.length,
              failed: r.failed.length,
              copies: r.copies.length,
              rawLogs: r.rawLogs.files,
              gc: r.gc.map((g) => `${g.folderKey}:${g.action}`),
            })
            return { gcPending: r.gcPending }
          },
          gc: async () => ({ gcPending: (await history.gcPending()).gcPending }),
          idle: retentionIdle,
          log: log.child({ part: 'retention' }),
        })
      : undefined
  retentionScheduler?.start()

  // ---- the catalog refresh schedule: launch + every 6 h; it never starts a refresh -------------------------------
  const catalogSchedulerOpt =
    o.catalogScheduler ?? (o.host.kind === 'app' && o.host.notifyCatalog !== undefined)
  if (catalogLive !== undefined && catalogSchedulerOpt !== false) {
    catalogLive.startScheduler(typeof catalogSchedulerOpt === 'object' ? catalogSchedulerOpt : {})
  }

  // ---- Sleep, the E2E clock, answers from notifications --------------------------------------------------------
  const askPending = (runId: string, requestId: string): boolean => {
    const c = controllers.get(runId)
    if (c === undefined || c.closed) return false
    return AGENT_STEPS.some((p) =>
      c.state.steps[p].asks.some((a) => a.requestId === requestId && a.pendingDeny === undefined),
    )
  }
  const staleAsk = (): Result<void> => fail('CONFLICT', STALE_ASK_MESSAGE, { stale: true })
  const answerAsk = async (a: AskAnswerInput): Promise<Result<void>> => {
    if (readOnly) return fail('FORBIDDEN', 'This Dim Factory process is read-only.')
    // Asks live only with their process, in a loaded run: anything else was answered, timed out or withdrawn.
    const c = controllers.get(a.runId)
    if (c === undefined || !askPending(a.runId, a.requestId)) return staleAsk()
    const via = a.via ?? 'notification'
    const r = await c.command({
      kind: 'answer',
      requestId: a.requestId,
      decision: a.decision,
      via,
      graceMs: defaultDenyGraceMs(via),
    })
    // Answered meanwhile (the window, the timer, the vendor): the same "already answered/expired".
    if (!r.ok && (r.error.code === 'NOT_FOUND' || r.error.code === 'CONFLICT')) return staleAsk()
    return r
  }
  const power = async (state: 'suspend' | 'resume'): Promise<void> => {
    // Finished runs have no timers left; a resume still reaches a run that recorded the suspend.
    const runs = [...controllers.values()].filter(
      (c) => !isFinishedState(c.state) || c.state.suspendedAt !== undefined,
    )
    await Promise.all(runs.map((c) => c.enqueue({ t: 'power', state })))
    // No queued task starts while the machine sleeps; at wake the schedule is looked at again.
    if (!readOnly) await factoryService.power(state)
  }
  const advanceClock = async (ms: number): Promise<Result<{ now: number }>> => {
    if (clock.advance === undefined)
      return fail('UNSUPPORTED', 'The clock can only be moved in E2E mode (DIM_FACTORY_E2E=1).')
    if (!Number.isFinite(ms) || ms < 0) return fail('VALIDATION', 'advanceMs must be a number ≥ 0.')
    const now = clock.advance(ms)
    await Promise.all([...controllers.values()].map((c) => c.drained()))
    return ok({ now })
  }

  // Outside agents: the pending requests, and the endpoint when the user turned it on (a taken port is reported in
  // Settings, never thrown).
  await externalMcp?.start().catch((err: unknown) => log.warn('outside agents did not start', { err }))

  let shutdown: Promise<void> | undefined
  const core: Core = {
    paths,
    bus,
    clock,
    log,
    adapters,
    scheduler,
    preflight: engine,
    recovery,
    readOnly,
    get settings(): UserSettings {
      const user = configService.user
      return user !== undefined ? vendorSettings(user) : { vendors: boot.vendors, issues: boot.issues }
    },
    config: configService,
    firstLaunch: () => configService.firstLaunch(),
    invoke: <C extends Cmd>(cmd: C, ...args: InvokeArgs<C>) => dispatch(handlers, cmd, args[0] as Req<C>),
    controller: (runId) => controllers.get(runId),
    summary: (runId) => {
      const c = controllers.get(runId)
      return c !== undefined ? summarize(c.state) : (index?.get(runId) ?? roIndex?.get(runId))
    },
    attention: () => currentAttention(),
    power,
    advanceClock,
    answerAsk,
    askPending,
    killAll: async () => {
      await Promise.all([...controllers.values()].map((c) => c.killAll()))
    },
    catalog: catalogLive,
    preview: previewApi,
    factory: readOnly
      ? undefined
      : {
          setOnBattery: (onBattery: boolean) => factoryService.setOnBattery(onBattery),
          settled: async () => {
            await factoryService.settled()
            await fallbackService?.settled()
          },
        },
    history: {
      retention: async (ro = {}) => {
        if (readOnly && ro.dryRun !== true) {
          throw new DimFactoryError(
            'FORBIDDEN',
            'This Dim Factory process is read-only: only a dry run is possible.',
          )
        }
        await historyBoot
        const report = await history.retention(ro)
        // `dimf gc` and a pass on demand tidy the matches' own leftovers too (never on a dry run).
        if (ro.dryRun !== true) {
          await matchService.sweep().catch((err: unknown) => log.warn('match sweep failed', { err }))
        }
        return report
      },
      settled: async () => {
        await historyBoot
        await history.settled()
      },
    },
    shutdown: () => {
      shutdown ??= (async () => {
        // No outside agent reaches a core that is closing.
        await externalMcp?.stop().catch(() => undefined)
        // No queued task starts and no fallback switches once the core is closing.
        factoryService.close()
        fallbackService?.close()
        runLimits?.close()
        // The work they had queued finishes first (closed, they start nothing new): see FACTORY_SHUTDOWN_WAIT_MS.
        await Promise.race([
          Promise.all([factoryService.settled(), fallbackService?.settled()]).catch(() => undefined),
          new Promise((r) => setTimeout(r, FACTORY_SHUTDOWN_WAIT_MS).unref()),
        ])
        // Previews never outlive the app: every running one's process tree is killed, its server closed.
        await previewService.stopAll().catch((err: unknown) => log.warn('preview stop failed', { err }))
        configService.dispose()
        for (const t of etaTimers.values()) clock.clearTimer(t.timer)
        etaTimers.clear()
        for (const t of unloadTimers.values()) clearTimeout(t)
        unloadTimers.clear()
        await Promise.all([...unloading.values()])
        // No new pass starts; removals still in their undo window are deleted at the next start; a delete in
        // flight gets a few seconds to finish before the index closes.
        retentionScheduler?.stop()
        catalogLive?.stop()
        history.close()
        await Promise.race([
          (async () => {
            await historyBoot
            await history.settled()
          })(),
          new Promise((r) => setTimeout(r, HISTORY_SHUTDOWN_WAIT_MS).unref()),
        ])
        // A running price refresh is stopped (its status reads cancelled).
        await catalogJobs?.dispose().catch(() => undefined)
        await Promise.all([...controllers.values()].map((c) => c.shutdown().catch(() => undefined)))
        await index?.close().catch((err: unknown) => log.error('index close failed', { err }))
        await bus.close().catch((err: unknown) => log.error('bus close failed', { err }))
        await b.session?.close().catch(() => undefined)
        await log.flush().catch(() => undefined)
        await b.ownLog?.close().catch(() => undefined)
      })()
      return shutdown
    },
  }
  return core
}
