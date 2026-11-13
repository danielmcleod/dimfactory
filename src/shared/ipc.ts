// IPC contract between renderer (via preload) and main/core. Types and string constants ONLY: no zod here, so
// the sandboxed preload never bundles it. Request schemas live in ipc-schemas.ts and `satisfies` Commands.
import type { GuardrailProof, GuardrailSuggestion, GuardrailsState, ProveKind } from './guardrails.ts'
import type { ShareFilesReport, SharePageReport } from './share-check.ts'
import type { TryItReport } from './try-it.ts'
import type {
  CatalogDiff,
  CatalogEventState,
  CatalogRefreshPlan,
  CatalogSchedule,
  CatalogScheduleUpdate,
  CatalogState,
  PriceEdit,
} from './catalog.ts'
import type {
  Accent,
  ConfigScope,
  Experience,
  ProvenanceMap,
  ResolvedConfig,
  RunOverrides,
  Theme,
} from './config-schema.ts'
import type { BriefContext, BriefInput, BriefSuggestResult } from './brief.ts'
import type { RecipesList } from './recipes.ts'
import type { DepthDecision, DepthSetting } from './depth.ts'
import type { PromptCheckView, PromptSharpened } from './prompt-check.ts'
import type {
  BatchAdded,
  BatchPlan,
  MatchCompare,
  MatchContestant,
  NewModelOffer,
  MatchPatchSaved,
  MatchPickResult,
  MatchPickSide,
  MatchRematchRequest,
  MatchSide,
  MatchStarted,
  MatchView,
  RematchCheck,
} from './match.ts'
import type { Scoreboard } from './scoreboard.ts'
import type {
  CommitPreview,
  CommitResult,
  DeployReport,
  DeployTarget,
  DeployUploadResult,
  DeployUploadRequest,
  DeployBuildRequest,
  DeployBuildResult,
  PrCreateRequest,
  PrPreview,
  PrResult,
} from './deploy.ts'
import type { DashboardData, AttentionItem, RunEstimate, StatsData, StatsRange } from './estimates.ts'
import type { UsageData, UsageRange } from './usage.ts'
import type { ContextReport } from './context.ts'
import type { StepPromptName } from './prompt-names.ts'
import type { AskDecision } from './events.ts'
import type { ConnectorsListResult, DiscoveredExtensions } from './extensions.ts'
import type { HealView, JsonPatchOp, RecoveryActionKind, RetryStrategy } from './failure.ts'
import type { PreflightReport } from './preflight.ts'
import type { PreviewInfo, PreviewPlaytestView, PreviewSessionView, PreviewSmokeView } from './preview.ts'
import type { ProjectCreated, ProjectCreateRequest, TemplatesList } from './templates.ts'
import type {
  EasyAskAnswer,
  EasyAttachment,
  EasyChangeEstimate,
  EasyChangeRequest,
  EasyCreateRequest,
  EasyFolderView,
  EasyHelper,
  EasyHelperCost,
  EasyIntentAnswer,
  EasyKind,
  EasyPermissionState,
  EasyPermissionView,
  EasyProjectView,
  EasyQueueAddRequest,
  EasyQueueStartRequest,
  EasyQueueView,
  EasyResolveRequest,
  EasyResolved,
  EasyStarted,
  EasyState,
  EasyThinkAnswer,
  EasyThinkRequest,
  EasyVisualResult,
  EasyVisualState,
  EasyWorkRequest,
  RunLimitsView,
} from './easy.ts'
import type { DailyReportView, GithubCheckView, MemoryView, QueueImportResult, QueueView } from './factory.ts'
import type {
  AgentStep,
  CardChoiceValue,
  FreshReason,
  PassName,
  RunEnvelope,
  RunOutputFile,
  RunSnapshot,
  RunStatus,
  RunSummary,
  StepKey,
  WaitView,
} from './run.ts'
import type { ModelOption, ProbeView, VendorId } from './vendors.ts'
import type { VerifyCommand } from './verify.ts'
import { BRAND } from './brand.ts'

export const CMD_CHANNEL = `${BRAND.ipcPrefix}:cmd`
export const EVT_CHANNEL = `${BRAND.ipcPrefix}:evt`
export const IPC_PROTOCOL = 1

// ---- results ------------------------------------------------------------------------

export const RESULT_CODES = [
  'VALIDATION',
  'FORBIDDEN',
  'UNKNOWN_COMMAND',
  'NOT_FOUND',
  'CONFLICT',
  'FOLDER_BUSY',
  'PREFLIGHT_BLOCKED',
  'HOME_LOCKED',
  'NEWER_SCHEMA',
  'UNSUPPORTED',
  'STORAGE',
  'GIT',
  'SPAWN',
  'TIMEOUT',
  'INTERNAL',
] as const
export type ResultCode = (typeof RESULT_CODES)[number]

export interface ResultError {
  code: ResultCode
  message: string
  /** e.g. the PreflightReport for PREFLIGHT_BLOCKED, ConfigIssue[] for VALIDATION of a config write. */
  details?: unknown
}

/** The invoke promise never rejects; handlers' throws are mapped to `{ok:false}`. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ResultError }

export interface CmdEnvelope {
  cmd: Cmd
  req: unknown
  /** Correlation id for logs. */
  cid: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

// ---- app / shell DTOs ------------------------------------------------------------------

export type Platform = 'win32' | 'darwin' | 'linux'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  theme: Theme
  resolved: ResolvedTheme
  accent: Accent
}

export interface AppInfo {
  name: string
  version: string
  platform: Platform
  arch: string
  versions: { electron: string | null; chrome: string | null; node: string }
  home: string
  logsDir: string
  packaged: boolean
  e2e: boolean
  ipcProtocol: number
  git: { path: string; version: string } | null
  /** Windows toast identity (AUMID / ToastActivatorCLSID shortcut); null off Windows. */
  notifications: { aumid: boolean; clsid: boolean } | null
}

/** DIM_FACTORY_HOME/state.json (UI/app state that is not configuration). */
export interface AppState {
  schemaVersion: 1
  setupDismissed: boolean
  firstLaunchCompletedAt: number | null
  catalog: { lastRefreshAt: number | null; snoozedUntil: number | null }
  notifications: { pausedUntil: number | null }
}

export interface AppStatePatch {
  setupDismissed?: boolean
  notificationsPausedUntil?: number | null
}

export type ShellOpenRequest =
  | { target: 'runFolder' | 'worktree' | 'rawLog'; runId: string; step?: StepKey }
  | { target: 'folder'; path: string }
  | { target: 'logs' | 'home' }
  /** https only, host allowlist. */
  | { target: 'url'; url: string }
  /** Settings → Config file "Open in editor": the dimfactory.json `config.read` reads, with the system's editor. */
  | { target: 'configFile'; scope: ConfigScope; folder?: string }
  /** "Show the file": an upload file (an existing .zip) shown selected in the system's file manager. */
  | { target: 'uploadFile'; path: string }

export type LogLevel = 'info' | 'warn' | 'error'

export interface DiagnosticsRequest {
  runId?: string
  /** Opt-in: include redacted raw vendor lines. */
  includeRaw?: boolean
}

export interface DiagnosticsBundle {
  text: string
  /** Replacements per redaction rule id. */
  redactions: Record<string, number>
}

export type AppLifecycleState = 'quit-requested' | 'recovered' | 'unclean-exit'

// ---- runs DTOs ---------------------------------------------------------------------

export interface RunStartRequest {
  folder: string
  task: string
  overrides?: RunOverrides
  /** The composer's Brief (absent: none). Core checks it against its pack and the folder's facts. */
  brief?: BriefInput
  /**
   * A recipe id (recipes.list): its switches are a config layer below `overrides`, and its brief defaults stand in
   * for a missing `brief`. An unknown id is VALIDATION.
   */
  recipe?: string
}

/** `depth.decide`: Quick or Thorough for a task as runs.start would decide it now (no model call). */
export interface DepthRequest extends FolderChecksRequest {
  task: string
}

/**
 * `task.check` and `task.sharpen`: the task as typed, the folder it would run in and the recipe's id. The check makes
 * no model call; Sharpen it is one read-only call, only on the user's click.
 */
export interface TaskCheckRequest {
  folder: string
  task: string
  recipe?: string
}

/** What the live checks and the estimate are asked for: the folder, the run overrides and the brief. */
export interface FolderChecksRequest {
  folder: string
  overrides?: RunOverrides
  /** The Brief: Test-first adds the `tests` step (preflight: it needs Verify; the estimate: its steps). */
  brief?: BriefInput
  /** A recipe id, as runs.start takes it. */
  recipe?: string
}

/** `matches.start`: a Head to head. Everything but `sides` is what `runs.start` takes, and applies to both sides. */
export interface MatchStartRequest extends RunStartRequest {
  /** Who builds each side: side A, then side B. */
  sides: [MatchContestant, MatchContestant]
  /** Hide the builders' names on the Match page until a result is picked. */
  blind?: boolean
}

export interface RunStarted {
  runId: string
  displayNo: number
}

export interface RunListQuery {
  folder?: string
  status?: RunStatus[]
  vendor?: VendorId
  text?: string
  from?: number
  to?: number
  cursor?: string
  /** Default 100. */
  limit?: number
}

/** Largest `runs.events` page (the bus's replay cap); the renderer pages with it. */
export const RUN_EVENTS_MAX_LIMIT = 2000

export interface RunEventsPage {
  /** Envelopes with seq > sinceSeq, at most `limit` (≤ RUN_EVENTS_MAX_LIMIT). */
  events: RunEnvelope[]
  lastSeq: number
  more: boolean
}

export interface RunOutput {
  text: string
  mtime: number
  version: number
}

export interface BranchActionResult {
  done: boolean
  reason?: string
  /** Copyable git commands when Dim Factory may not act itself. */
  commands: string[]
}

export interface RecoveryResult {
  kind: RecoveryActionKind
  /** settings_link: renderer route to open. */
  route?: string
  /** shell_copy: text placed on the clipboard. */
  copied?: string
  /** open_docs: the checked https URL the host opens in the default browser (main re-checks the allowlist). */
  url?: string
  message?: string
  /**
   * config_patch `runOverrides` outside a run (a composer preflight fix): the checked ops the composer applies to
   * its run overrides. Nothing was written.
   */
  overrides?: JsonPatchOp[]
  /** config_patch with `persist`: the file written (undo toast: `config.restoreBackup{scope, folder?, backupId}`). */
  persisted?: ConfigPatchPersisted[]
  /** heal outside a run: the outcome (a run's heal arrives as StepView.heal instead). */
  heal?: HealView
  /** wait_until: the wait as it is now. */
  wait?: WaitView
  /** vendor_setup: what the vendor's setup answered and how the forced re-probe reads the sandbox now. */
  setup?: VendorSetupOutcome
}

/**
 * `vendor_setup`: a finished setup. `ok`: the vendor's setup reported success; `ready`: and the re-probe
 * after it reads the sandbox ready (its `vendor.<v>.winSandbox` check passes). The re-probe also reaches the vendor
 * rows as the `probe` AppEvent.
 */
export interface VendorSetupOutcome {
  vendor: VendorId
  ok: boolean
  ready: boolean
  /** The vendor's own words (its error when the setup failed). */
  detail: string
  /** The re-probe after the setup finished (false: it failed; vendor health keeps the earlier probe). */
  probed: boolean
  /** The re-probe's sandbox check detail while the sandbox is still not ready. */
  stillNotReady?: string
}

/** One config file a persisted `config_patch` wrote. */
export interface ConfigPatchPersisted {
  scope: ConfigScope
  folder?: string
  path: string
  backupId: string | null
  diff: string
}

// ---- diff / worktree DTOs ------------------------------------------------------------

/** Review/Critic `{{diff}}` = S0..S1 (implement), Fix card = F0..S2 (fix), S0..last (combined). */
/**
 * The Diff tab's segments, in their order. `fix-round-<n>`: round n of Fix until green alone (only in a run whose loop
 * ran a second round; `fix` spans every round).
 */
export const DIFF_SEGMENTS = [
  'implement',
  'fix',
  'fix-round-1',
  'fix-round-2',
  'fix-round-3',
  'deploy',
  'combined',
] as const
export type DiffSegment = (typeof DIFF_SEGMENTS)[number]

/** Diff tab: a file with more changed lines than this is `large` and starts collapsed. */
export const LARGE_DIFF_LINES = 3000
/** Diff tab: `diff.blob` serves images up to this size. */
export const DIFF_BLOB_MAX_BYTES = 2 * 1024 * 1024

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'T'
  path: string
  oldPath?: string
  oldMode: string
  newMode: string
  oldSha: string
  newSha: string
  /** null for binary files. */
  added: number | null
  deleted: number | null
  binary: boolean
  gitlink: boolean
  eolOnly: boolean
  /**
   * The folder changed after the run produced this file: its content now differs from the segment's new side (a
   * deleted file is back, an added one is gone). Absent when core did not check (a nested repository, a folder that
   * is gone, or too many bytes to hash).
   */
  editedAfterRun?: boolean
  /**
   * The Implement segment only: Fix changed this file later in the same run, and the folder holds what Fix left
   * (so it is not `editedAfterRun`). The Fix and Combined segments show the later change. Absent otherwise.
   */
  changedByFix?: boolean
  /** A rename's similarity, 0 to 100 (git `-M`). */
  similarity?: number
  /** The file's mode changed (the exec bit, or file to link), both sides present. */
  modeChanged?: boolean
  /** More than LARGE_DIFF_LINES lines changed; the viewer starts it collapsed. */
  large?: boolean
}

export interface DiffFiles {
  seg: DiffSegment
  files: FileChange[]
  /** Paths marked reviewed (runs/<id>/review-state.json). */
  reviewed: string[]
  /** Segments this run has. */
  available: DiffSegment[]
  /** Rendered from the persisted .patch (shadow snapshots cleared or history run). */
  persisted: boolean
  /** Why this view's files cannot be reverted (a persisted diff); absent when they can. */
  revertUnavailable?: string
}

export interface DiffFilePatch {
  patch: string
  truncated: boolean
}

/**
 * Images ≤ 2 MB only (png, jpeg, gif, webp, bmp, ico by their bytes; an SVG is text, never an image here). A file
 * that is no image answers `mime: null` and no bytes (`base64` ''), with its size.
 */
export interface DiffBlob {
  base64: string
  bytes: number
  mime: string | null
}

export interface RevertResult {
  undoToken: string
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
}

/** What Apply does with one changed path (a rename is a delete plus an add). */
export const WORKTREE_APPLY_ACTIONS = ['noop', 'write', 'delete', 'conflict', 'skip'] as const
export type WorktreeApplyAction = (typeof WORKTREE_APPLY_ACTIONS)[number]

/** [Keep mine] keeps the folder's file; [Take run's] writes (or deletes) as the run did. */
export type WorktreeConflictChoice = 'mine' | 'theirs'

export interface WorktreePreview {
  files: FileChange[]
  conflicts: string[]
  /**
   * Each changed path's action against the folder now (noop: it already has the run's version; write / delete:
   * it still has the run's starting point; conflict: anything else; skip: a gitlink, a link or file in the place of a
   * folder, unreadable), with the reason for a conflict or a skip.
   */
  actions?: { path: string; action: WorktreeApplyAction; reason?: string }[]
  /**
   * The changed paths whose reviewed mark (any segment) names the version Apply writes, both sides of a
   * rename included: what `worktree.apply {reviewedOnly: true}` applies. Absent when core could not read the marks.
   */
  reviewed?: string[]
}

export interface WorktreeApplyResult {
  applied: string[]
  conflicts: string[]
  undoToken: string
  /** Paths left alone, with why (a gitlink, a link in the place of a folder, unreadable). */
  skipped?: { path: string; reason: string }[]
  /** Conflicts resolved [Keep mine]. */
  kept?: string[]
  /** This call finished an apply a crash had stopped (its own selection and token). */
  resumed?: boolean
}

export interface WorktreeDiscardResult {
  undoToken: string
  /** Deletion is deferred 10 s. */
  deleteAt: number
}

// ---- config / prompts / trust / verify DTOs -----------------------------------------------

export interface ConfigIssue {
  file: string
  pointer: string
  line: number
  col: number
  endLine: number
  endCol: number
  code: string
  message: string
  severity: 'error' | 'warning'
  /** "did you mean …" (edit distance ≤ 2). */
  suggestion?: string
}

export interface ConfigLayerInfo {
  scope: ConfigScope
  path: string
  exists: boolean
  sha256: string | null
  valid: boolean
}

export interface ResolvedWithProvenance {
  config: ResolvedConfig
  provenance: ProvenanceMap
  issues: ConfigIssue[]
  layers: { user: ConfigLayerInfo; project: ConfigLayerInfo | null }
  scopeRoot: string | null
  folderKey: string | null
  /** Profile names the layers define (built-ins first): the composer's profile picker. */
  profiles?: string[]
  /** Core's readiness-based suggestions for this config (the composer formats them; absent from older cores). */
  suggestions?: ComposerSuggestions
}

/** The Fix row's session choice: reuse Implement's session, start fresh, or fresh on another vendor. */
export type FixSessionChoice = 'reuse' | 'fresh' | 'fresh-other'

/** What core suggests for a resolved config from the vendors' readiness (the Critic swap, the Fix session). */
export interface ComposerSuggestions {
  /** [Swap Critic to X]: Critic runs on Implement's vendor and X is ready and can review read-only. */
  criticSwap: { to: string } | null
  /**
   * How Fix's session will start, as decideSession decides it once Implement finished with a session: `reason` is
   * the FreshReason when it starts fresh (e.g. `vendor-differs` for a Fix vendor override).
   */
  fixSession: { choice: FixSessionChoice; reason?: FreshReason }
  /** "Fresh, different vendor": the first ready vendor other than Implement's that can run Fix's mode. */
  otherFixVendor: string | null
}

export interface ConfigBackup {
  /** `last-good` or a write backup id. */
  id: string
  at: number
  bytes: number
  kind: 'write' | 'last-good'
}

export interface ConfigReadResult {
  path: string
  exists: boolean
  text: string
  value: unknown
  issues: ConfigIssue[]
  /** dimfactory.json `version` (absent ⇒ 1). */
  version: number
  backups: ConfigBackup[]
  /** A last-good copy of this file exists (`config.restoreBackup{backupId:'last-good'}` restores it first). */
  lastGood?: boolean
  /** "Restore last good" has something to restore (a last-good copy, else a write backup). */
  restorable?: boolean
}

export interface ConfigWriteResult {
  path: string
  changed: boolean
  /** Unified diff of the write. */
  diff: string
  /** For the undo toast (`config.restoreBackup`). */
  backupId: string | null
}

export type ConfigSaveRequest = { scope: ConfigScope; folder?: string; overrides: RunOverrides } & (
  { mode: 'row'; pass: PassName } | { mode: 'projectDefault' }
)

/**
 * A prompt template by name: a pass's, Test-first's Tests step's, an optional step's (Clarify, Research, the acceptance
 * review, Explain, Deploy, and the plain-words twins), or one of Dim Factory's own.
 */
export type PromptName = PassName | 'tests' | StepPromptName | 'heal' | 'catalog'

/** A prompt Settings › Prompts may save: a pass's or an optional step's. */
export type EditablePromptName = PassName | StepPromptName

/** A template problem in a prompt's text (prompts/template.ts). Errors refuse a save; warnings do not. */
export interface PromptIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
  /** 1-based; absent for issues about the whole text (a missing required placeholder). */
  line?: number
  col?: number
  /** The placeholder or section involved. */
  name?: string
}

export interface PromptView {
  name: PromptName
  text: string
  source: 'builtin' | 'user' | 'project'
  path: string | null
  defaultText: string
  allowed: string[]
  required: string[]
  wordCount: number
  /** Internal prompts (heal, catalog) are read-only. */
  editable: boolean
  /** The placeholders the text uses, in order of first use (the Prompts tab's chips). */
  placeholders?: string[]
  /**
   * The text's template issues: errors (an unknown placeholder, a syntax slip; line-numbered) and warnings (a
   * required placeholder the text leaves out: Dim Factory appends the default section for it).
   */
  issues?: PromptIssue[]
  /** Which scopes hold an override of this prompt (`project` null when no folder was given). */
  overrides?: { user: boolean; project: boolean | null }
  /**
   * `prompts.save` only: what the saved scope held before (`text` null: no override), for the undo toast
   * (`prompts.save{name, scope, folder?, text: previous.text}`).
   */
  previous?: { scope: ConfigScope; text: string | null }
}

export interface RecentFolder {
  folder: string
  scopeRoot: string | null
  lastRunAt: number
  isGit: boolean
  exists: boolean
}

/** trust.json command grant; key = sha256(JSON{kind,argv,cwdRel,body}) so a changed script body needs re-trust. */
export interface TrustCommandGrant {
  kind: 'verify' | 'deps' | 'preview'
  argv: string[]
  cwdRel: string
  body?: string
  at: number
}

export interface TrustGrants {
  vendorFolder?: Record<VendorId, { at: number }>
  largeFolder?: { at: number; files: number; bytes: number }
  /**
   * The scope root's project file may turn Auto on (bound to its bytes' sha256). In a folder's view (`trust.get`,
   * preflight) it is the grant of the project file that folder uses, wherever that file is.
   */
  projectAuto?: { at: number; projectSha: string }
  /** Stored only: grants for subfolders' own project files, keyed by the folder relative to the scope root. */
  nestedProjectAuto?: Record<string, { at: number; projectSha: string }>
  /**
   * A project recipe (`.dimfactory/recipes/<id>.json`) may turn Auto on, per recipe id, bound to the sha256 of the
   * file's text the user was shown: an edit to the file voids the grant.
   */
  recipeAuto?: Record<string, { at: number; sha: string }>
  commands?: Record<string, TrustCommandGrant>
  /**
   * Easy mode's project permission: the folder Dim Factory created for a new Easy project, where the user ticked
   * "Allow these for this project". Bound to that folder (its path as created and its file id); only Easy runs in that
   * very folder use it, and only for what core/easy/ask-tier.ts covers. Revoked from Settings or Easy settings.
   */
  easyProject?: EasyProjectGrant
  /** In memory only (see PROJECT_PERMISSION). */
  [PROJECT_PERMISSION]?: true
}

/** trust.json `easyProject`: when it was given, the folder as created, and its file id then (null: none known). */
export interface EasyProjectGrant {
  at: number
  folder: string
  ino?: string
}

/**
 * Marks grants an Easy run read while its project permission held: its own verify, install and preview commands count
 * as trusted (core/config/trust.ts coveredByProject). A symbol, so it never comes from trust.json, a hand-edited file
 * or IPC: only core adds it, and only for that run, at the moment it reads the grants.
 */
export const PROJECT_PERMISSION: unique symbol = Symbol('dimf.projectPermission')

/** DIM_FACTORY_HOME/trust.json; folderKey = sha256(lockKey(scopeRoot)).slice(0,16) (same key as the shadow repo). */
export interface TrustFile {
  schemaVersion: 1
  folders: Record<string, { path: string; grants: TrustGrants }>
  /** Your guardrails loosened in the app (shared/guardrails.ts GuardrailLoosening), newest last. */
  guardrails?: { loosened: { at: number; what: string }[] }
}

export interface TrustState {
  folder: string
  folderKey: string
  scopeRoot: string
  grants: TrustGrants
}

export type TrustGrantInput =
  | { kind: 'vendorFolder'; vendor: VendorId }
  | { kind: 'largeFolder' }
  /** `projectSha`: the version of the file the user was shown (the preflight's); CONFLICT when it changed since. */
  | { kind: 'projectAuto'; projectSha?: string }
  /** `recipeSha`: the version of the project recipe file the user was shown; CONFLICT when it changed since. */
  | { kind: 'recipeAuto'; recipeId: string; recipeSha?: string }
  /**
   * `command`: core adds the script body its hash covers (verify: the package.json script or Makefile recipe read
   * now). `hash`: the grant hash the user was shown (verify.detect); CONFLICT when the body changed since.
   */
  | {
      kind: 'command'
      command: { kind: 'verify' | 'deps' | 'preview'; argv: string[]; cwdRel: string; hash?: string }
    }

/** The verify DTOs live in ./verify.ts (verify.detect answers VerifyCommand[]). */
export { VERIFY_SOURCES } from './verify.ts'
export type { VerifyCommand, VerifySource } from './verify.ts'

// ---- storage / notifications / e2e DTOs ------------------------------------------------------

export interface StorageUsage {
  home: string
  totalBytes: number
  freeBytes: number | null
  runs: { count: number; bytes: number }
  shadows: {
    folderKey: string
    path: string | null
    bytes: number
    /**
     * Why the folder's snapshots cannot be cleared now (a run holds or waits for its lock, or works there), as
     * UI copy; absent when they can be. storage.clearShadow refuses with the same reason.
     */
    busy?: string
  }[]
  worktrees: { count: number; bytes: number }
  catalogBytes: number
  logsBytes: number
}

export interface NotificationTestResult {
  shown: boolean
  surface: 'native' | 'in-app'
  reason?: string
}

export interface NotificationShortcutStatus {
  applicable: boolean
  aumid: boolean
  clsid: boolean
  /**
   * Repair without admin rights: the shortcut is the all-users one a per-machine install made, and
   * writing it failed (it needs administrator rights), so Settings says so instead of a plain "did not fix it".
   */
  needsAdmin?: true
}

export interface E2EState {
  now: number
  timeScale: number
  activeRuns: number
  procs: { runId: string; step: StepKey; pid: number }[]
  windowFocused: boolean
  notifications: { title: string; body: string; actions: string[] }[]
  tray: { icon: string; tooltip: string }
  extra?: Record<string, unknown>
}

// ---- outside agents (MCP) DTOs ----------------------------------------------------------------

/** `Dim Factory --mcp`: the stdio bridge an MCP client runs (this executable, plus the app folder in development). */
export interface McpBridgeCommand {
  command: string
  args: string[]
}

/** Settings → Outside agents: the loopback MCP endpoint as core runs it (state.json `externalMcp`). */
export interface ExternalMcpView {
  enabled: boolean
  port: number
  /** Listening now. */
  running: boolean
  /** `http://127.0.0.1:<port>/mcp/dim-factory` while listening. */
  url: string | null
  /** The bearer token (null until access is first turned on). The renderer shows it masked by default. */
  token: string | null
  /** Why it is not listening (a port in use), as UI copy. */
  error: string | null
  /** When an agent last called (epoch ms), null when none has. */
  lastCall: number | null
  /** The stdio bridge command (null when this host has none, e.g. a test core). */
  bridge: McpBridgeCommand | null
}

export interface ExternalMcpSetRequest {
  enabled?: boolean
  port?: number
  /** Replace the token (agents set up with the old one stop working). */
  regenerate?: boolean
}

export interface AgentPluginStep {
  command: string
  ok: boolean
  output: string
}

/**
 * An agent plugin (Codex, Claude Code): `install: false` only lists what an install writes and runs (nothing is
 * written); `install: true` writes the local marketplace and runs the agent's CLI commands.
 */
export interface AgentPluginResult {
  dir: string
  files: string[]
  commands: string[]
  installed: boolean
  steps: AgentPluginStep[]
}

export type CodexPluginStep = AgentPluginStep
export type CodexPluginResult = AgentPluginResult
export type ClaudePluginResult = AgentPluginResult

export const MCP_REQUEST_STATUSES = ['pending', 'approved', 'declined', 'expired'] as const
export type McpRequestStatus = (typeof MCP_REQUEST_STATUSES)[number]

/** A run an outside agent asked for. Nothing starts until the user approves it in Dim Factory. */
export interface McpRunRequest {
  id: string
  folder: string
  task: string
  profile?: string
  notes?: string
  /** The client's own name for itself (as it said in its MCP handshake or in the request). */
  requestedBy: string
  requestedAt: number
  expiresAt: number
  status: McpRequestStatus
  /** The run the approval created. */
  runId?: string
  displayNo?: number
  resolvedAt?: number
}

// ---- commands ---------------------------------------------------------------------------

type Run = { runId: string }

/** Every command, with request and response types. A missing handler or schema is a compile error. */
export interface Commands {
  // app / shell
  'app.info': { req: void; res: AppInfo }
  'app.ready': { req: { route?: string }; res: void }
  'app.quit': { req: { confirm: boolean }; res: { quitting: boolean; activeRuns: number } }
  'dialog.pickFolder': { req: { defaultPath?: string }; res: string | null }
  /** The native file picker for Easy's Add files: files only, several at once (empty when cancelled). */
  'dialog.pickFiles': { req: { defaultPath?: string }; res: string[] }
  'shell.open': { req: ShellOpenRequest; res: void }
  'log.write': { req: { level: LogLevel; msg: string; data?: unknown }; res: void }
  'diagnostics.build': { req: DiagnosticsRequest; res: DiagnosticsBundle }
  'diagnostics.copy': { req: DiagnosticsRequest; res: void }
  'diagnostics.save': { req: DiagnosticsRequest; res: { path: string } | null }
  'events.focus': { req: { runIds: string[] }; res: void }
  'state.get': { req: void; res: AppState }
  'state.set': { req: AppStatePatch; res: AppState }
  // runs
  'runs.start': { req: RunStartRequest; res: RunStarted }
  'runs.list': { req: RunListQuery; res: Page<RunSummary> }
  'runs.get': { req: Run; res: RunSnapshot }
  'runs.events': { req: Run & { sinceSeq: number; limit?: number; condensed?: boolean }; res: RunEventsPage }
  'runs.output': { req: Run & { file: RunOutputFile }; res: RunOutput }
  'runs.stop': { req: Run; res: void }
  'runs.close': { req: Run; res: void }
  'runs.resume': { req: Run & { allowTimedOutAsk?: boolean }; res: void }
  'runs.retryPass': { req: Run & { pass: AgentStep; strategy?: RetryStrategy }; res: void }
  'runs.skipPass': { req: Run & { pass: AgentStep }; res: void }
  'runs.keepWaiting': { req: Run & { pass: AgentStep }; res: void }
  /** The run goes on in Auto: Implement and Fix approve everything, the gates ahead are off. */
  'runs.switchToAuto': { req: Run; res: void }
  'runs.rerun': { req: Run & { from: 'start' | 'fix'; findingIds?: string[] }; res: RunStarted }
  'runs.pin': { req: Run & { pinned: boolean }; res: void }
  'runs.remove': { req: { runIds: string[] }; res: { undoToken: string; removed: string[] } }
  'runs.undoRemove': { req: { undoToken: string }; res: void }
  'runs.branch': { req: Run & { action: 'return' | 'delete' }; res: BranchActionResult }
  /** The run's own limits (config `limits`) and the stop one of them caused. */
  'runs.limits': { req: Run; res: RunLimitsView }
  /** Head to head: one task, two builders, each side an isolated run in its own copy of the folder as it is now. */
  'matches.start': { req: MatchStartRequest; res: MatchStarted }
  'matches.get': { req: { matchId: string }; res: MatchView }
  'matches.list': { req: void; res: MatchView[] }
  /** Replay a run that ended against another builder, from where it started. Nothing is applied. */
  'matches.rematch': { req: MatchRematchRequest; res: MatchStarted }
  /** Whether a run can be replayed, who built it, and which vendors have run in its project. */
  'matches.rematchCheck': { req: { runId: string }; res: RematchCheck }
  /** Save one side's whole change as a patch file beside the match's record. */
  'matches.savePatch': { req: { matchId: string; side: MatchSide }; res: MatchPatchSaved }
  /** Which past runs a batch of rematches against a builder would replay, and about what it would cost. */
  'matches.batchPlan': { req: { challenger: MatchContestant }; res: BatchPlan }
  /** Put those rematches in the queue (it starts them within its budgets and schedule). */
  'matches.batchAdd': { req: { challenger: MatchContestant; runIds: string[] }; res: BatchAdded }
  /** Models the catalog got lately that no match has tried, each with the batch that would try it. */
  'matches.offers': { req: void; res: NewModelOffer[] }
  /** Set a new model's offer aside for good. */
  'matches.dismissOffer': { req: { vendor: string; model: string }; res: void }
  /** What the matches played so far say about the builders, and the matches themselves. */
  'matches.scoreboard': { req: void; res: Scoreboard }
  /** Keep one side's result (applied to the folder, with an undo) or neither. */
  'matches.pick': { req: { matchId: string; side: MatchPickSide }; res: MatchPickResult }
  /** Take the pick back: the kept side's changes leave the folder again. */
  'matches.undoPick': { req: { matchId: string }; res: MatchView }
  /** Hide the builders' names until a result is picked, or show them again. */
  'matches.blind': { req: { matchId: string; on: boolean }; res: MatchView }
  /** What each side changed against the start, path by path. */
  'matches.compare': { req: { matchId: string }; res: MatchCompare }
  /** One file of side A's result against side B's (the old side is A's). */
  'matches.compareFile': { req: { matchId: string; path: string; ignoreEol?: boolean }; res: DiffFilePatch }
  // asks / cards / recovery
  'asks.answer': {
    req: Run & { requestId: string; decision: Exclude<AskDecision, 'cancel'>; graceMs?: number }
    res: void
  }
  'asks.undo': { req: Run & { requestId: string }; res: void }
  'cards.resolve': { req: Run & { cardId: string; choiceId: string; input?: CardChoiceValue }; res: void }
  'recovery.execute': { req: { actionId: string; runId?: string; folder?: string }; res: RecoveryResult }
  'heal.diagnose': { req: Run & { step: StepKey }; res: void }
  // diff / worktree
  'diff.files': { req: Run & { seg: DiffSegment }; res: DiffFiles }
  'diff.file': { req: Run & { seg: DiffSegment; path: string; ignoreEol?: boolean }; res: DiffFilePatch }
  'diff.blob': { req: Run & { seg: DiffSegment; side: 'old' | 'new'; path: string }; res: DiffBlob }
  'diff.revert': { req: Run & { seg?: DiffSegment; paths: string[] | 'all' }; res: RevertResult }
  'diff.undoRevert': { req: Run & { undoToken: string }; res: void }
  /** `seg`: the segment the marks are for (absent: every segment of the run that lists the path). */
  'diff.markReviewed': { req: Run & { paths: string[]; reviewed: boolean; seg?: DiffSegment }; res: void }
  'worktree.preview': { req: Run; res: WorktreePreview }
  'worktree.apply': {
    /**
     * `paths` (scope-relative; either side of a rename takes both) or `reviewedOnly` (the files marked reviewed in
     * review-state.json); `resolutions` settles conflicts.
     */
    req: Run & {
      paths?: string[]
      resolutions?: Record<string, WorktreeConflictChoice>
      reviewedOnly?: boolean
    }
    res: WorktreeApplyResult
  }
  'worktree.undoApply': { req: Run & { undoToken: string }; res: void }
  'worktree.discard': { req: Run; res: WorktreeDiscardResult }
  'worktree.undoDiscard': { req: Run & { undoToken: string }; res: void }
  // preflight / vendors
  'preflight.run': { req: FolderChecksRequest; res: PreflightReport }
  'depth.decide': { req: DepthRequest; res: DepthDecision }
  /** The prompt check: what the task might leave out (no model call), and who could sharpen it. */
  'task.check': { req: TaskCheckRequest; res: PromptCheckView }
  /** "Sharpen it": one read-only model call that proposes a clearer task (only on a click; nothing is changed). */
  'task.sharpen': { req: TaskCheckRequest; res: PromptSharpened }
  'vendors.list': { req: void; res: ProbeView[] }
  'vendors.probe': { req: { vendor?: VendorId; force?: boolean }; res: ProbeView[] }
  'vendors.setPath': { req: { vendor: VendorId; path: string | null }; res: ProbeView }
  'vendors.models': { req: { vendor: VendorId; force?: boolean }; res: ModelOption[] }
  // config / prompts / ui / folders / git / trust / verify
  'config.resolve': {
    req: { folder?: string; overrides?: RunOverrides; recipe?: string }
    res: ResolvedWithProvenance
  }
  'config.read': { req: { scope: ConfigScope; folder?: string }; res: ConfigReadResult }
  'config.save': { req: ConfigSaveRequest; res: ConfigWriteResult }
  'config.patch': { req: { scope: ConfigScope; folder?: string; ops: JsonPatchOp[] }; res: ConfigWriteResult }
  'config.restoreBackup': {
    req: { scope: ConfigScope; folder?: string; backupId: string }
    res: ConfigWriteResult
  }
  /**
   * Settings > Extensions: the MCP servers, skills and plugins each vendor's own settings define (for `folder`'s
   * project and local scopes too), names only. Read in memory; nothing is logged or stored.
   */
  'extensions.discover': { req: { folder?: string }; res: DiscoveredExtensions }
  /**
   * Lists Claude's claude.ai connectors (no tokens; only where that starts no other MCP server) and keeps them in
   * memory for this app session: the next `extensions.discover` shows them. `force` lists again.
   */
  'extensions.claudeConnectors': { req: { force?: boolean }; res: ConnectorsListResult }
  'prompts.get': { req: { name: PromptName; folder?: string }; res: PromptView }
  'prompts.save': {
    /** text null = reset to the inherited template. */
    req: { name: EditablePromptName; scope: ConfigScope; folder?: string; text: string | null }
    res: PromptView
  }
  'ui.setTheme': { req: { theme?: Theme; accent?: Accent }; res: ThemeState }
  'folders.recent': { req: void; res: RecentFolder[] }
  'git.init': { req: { folder: string }; res: void }
  /** Rules worth offering for a project, from the names in its folder (no tokens). */
  'guardrails.suggest': { req: { folder: string }; res: GuardrailSuggestion[] }
  /** Settings > Guardrails: the last proof of each rule, the Claude version now, and the loosenings on record. */
  'guardrails.state': { req: void; res: GuardrailsState }
  /** Prove it: a tiny real Claude session asked to break one rule (spends tokens). */
  'guardrails.prove': { req: { kind: ProveKind }; res: GuardrailProof }
  'trust.get': { req: { folder: string }; res: TrustState }
  'trust.set': { req: { folder: string; grant: TrustGrantInput; trusted: boolean }; res: TrustState }
  'verify.detect': { req: { folder: string }; res: VerifyCommand[] }
  // dashboard / stats / estimates
  'dashboard.get': { req: void; res: DashboardData }
  'stats.get': { req: { range: StatsRange }; res: StatsData }
  /** The Plops page: tokens and cost per vendor and model over the last 7 or 30 days, with the previous period. */
  'usage.get': { req: { range: UsageRange }; res: UsageData }
  /** Settings > Extensions: the project's Context report over its recent runs (names are for the app only). */
  'context.report': { req: { folder: string }; res: ContextReport }
  'estimates.get': { req: FolderChecksRequest; res: RunEstimate }
  // the Brief (packs, detection, per-folder briefs, Suggest choices)
  /** The packs, the detected category and facts, the task text's keyword choices and the folder's saved brief. */
  'brief.detect': { req: { folder?: string; task?: string }; res: BriefContext }
  // Recipes (saved pipelines plus briefs: built in, the user's and the folder's own files)
  /** Every recipe with its layer, path and sha256, and the files that could not be used. */
  'recipes.list': { req: { folder?: string }; res: RecipesList }
  /** Save the folder's brief (null: Reset, forget it). */
  'brief.save': { req: { folder: string; brief: BriefInput | null }; res: void }
  /**
   * "Suggest choices": one read-only, tool-less model call (the Plan pass's vendor and model as resolved for the
   * folder) that answers field values with a reason each, checked against the pack. Only on the user's click.
   */
  'brief.suggest': {
    req: { folder: string; task: string; brief: BriefInput; overrides?: RunOverrides }
    res: BriefSuggestResult
  }
  // catalog
  'catalog.get': { req: void; res: CatalogState }
  'catalog.refreshPlan': { req: void; res: CatalogRefreshPlan }
  /** Never auto-runs: `consent` is z.literal(true). */
  'catalog.refresh': {
    req: { consent: true; vendor?: VendorId; model?: string | null }
    res: { jobId: string }
  }
  'catalog.cancel': { req: { jobId: string }; res: void }
  'catalog.apply': { req: { jobId: string; rowIds: string[] }; res: CatalogState }
  'catalog.undo': { req: void; res: CatalogState }
  'catalog.savePrice': { req: { entry: PriceEdit }; res: CatalogState }
  'catalog.setSchedule': { req: CatalogScheduleUpdate; res: CatalogSchedule }
  // storage / notifications
  'storage.usage': { req: void; res: StorageUsage }
  'storage.clearShadow': { req: { folderKey: string }; res: StorageUsage }
  'notifications.test': { req: void; res: NotificationTestResult }
  'notifications.repairShortcut': { req: void; res: NotificationShortcutStatus }
  // E2E only (registered only when DIM_FACTORY_E2E=1)
  'e2e.state': { req: void; res: E2EState }
  'e2e.power': { req: { event: 'suspend' | 'resume' }; res: void }
  'e2e.clock': { req: { advanceMs: number }; res: { now: number } }
  // outside agents (MCP)
  'mcp.external.get': { req: void; res: ExternalMcpView }
  'mcp.external.set': { req: ExternalMcpSetRequest; res: ExternalMcpView }
  'mcp.external.codexPlugin': { req: { install: boolean }; res: CodexPluginResult }
  'mcp.external.claudePlugin': { req: { install: boolean }; res: ClaudePluginResult }
  /** Main-owned: opens the editor's MCP install link, built in main from the bridge command only. */
  'mcp.addToEditor': { req: { editor: 'vscode' | 'cursor' }; res: void }
  /** Pending run requests from outside agents (the Dashboard's Needs you). */
  'mcp.requests.list': { req: void; res: McpRunRequest[] }
  /** Start the requested run as runs.start would (authoritative preflight); a blocked start keeps it pending. */
  'mcp.requests.approve': { req: { id: string }; res: RunStarted }
  'mcp.requests.decline': { req: { id: string }; res: void }
  // Run & Preview
  /** How a folder (or a run's folder) can be run, its RUN.md, its previews and a run's last smoke check. */
  'preview.detect': { req: PreviewTarget; res: PreviewInfo }
  /** Start one of `preview.detect`'s commands (a trusted command, or the static server). */
  'preview.start': { req: PreviewTarget & { commandId: string }; res: PreviewSessionView }
  /**
   * Trust (or untrust) one of `preview.detect`'s commands for the folder (the run's folder for its isolated copy):
   * core reads what it runs now; `hash` is the one the user was shown (CONFLICT when it changed since).
   */
  'preview.trust': { req: PreviewTarget & { commandId: string; hash?: string; trusted: boolean }; res: void }
  /**
   * Stop a preview: its process tree is killed (the static server closes). `containers` (a docker compose preview, on
   * the user's "Stop containers too"): then `docker compose down` for its compose files, through the same trusted runner.
   */
  'preview.stop': { req: { sessionId: string; containers?: true }; res: void }
  /** Every preview this process started that is still listed. */
  'preview.list': { req: void; res: PreviewSessionView[] }
  /** Main-owned: show a running preview's page in Dim Factory's preview window or the system browser. */
  'preview.open': { req: { sessionId: string; target: 'app' | 'browser' }; res: void }
  /**
   * Main-owned: show two running previews' pages next to each other in one window, each under its label (a match's
   * two results).
   */
  'preview.openPair': { req: { sessionIds: [string, string]; labels: [string, string] }; res: void }
  /** Main-owned: load the preview's page in a hidden window and record console errors, failed loads and a screenshot. */
  'preview.smoke': { req: { sessionId: string }; res: PreviewSmokeView }
  /** Play the game's playtest.json in the hidden play-test window (main; a game preview only). */
  'preview.playtest': { req: { sessionId: string }; res: PreviewPlaytestView }
  /** Try it for me: walk the page in a hidden window with no internet (main). */
  'preview.tryIt': { req: { sessionId: string }; res: TryItReport }
  /** Before I share it: read the page at a phone's width and open its own links in a hidden window, no internet (main). */
  'preview.shareCheck': { req: { sessionId: string }; res: SharePageReport }
  /** "Allow internet for this preview" (`internet: true`), or back to this computer only. */
  'preview.network': { req: { sessionId: string; internet: boolean }; res: PreviewSessionView }
  /**
   * Main-owned: a game's preview window at Phone size (390 by 844 with touch emulation; opened first when it is not
   * open), or back to its own size.
   */
  'preview.phone': { req: { sessionId: string; phone: boolean }; res: PreviewSessionView }
  /**
   * Save a rendered document preview as a PDF (main prints its page in a hidden sandboxed window of its own) into the
   * project folder, next to the document: the path written.
   */
  'preview.savePdf': { req: { sessionId: string }; res: { path: string } }
  // Deploy helper (copyable commands only: Dim Factory never runs a deploy, signs in to a provider or stores a token)
  /** Classify the deliverable, the options with their copyable steps, the env vars and the pre-flight checklist. */
  'deploy.inspect': { req: DeployTarget; res: DeployReport }
  /** Tick (or untick) a manual checklist item for the folder (the run's folder for a run). */
  'deploy.tick': {
    req: { folder?: string; runId?: string; item: string; ticked: boolean }
    res: { ticks: Record<string, number> }
  }
  /**
   * "Make an upload file": zip a static deliverable's files next to the project folder for drag-and-drop hosting
   * (secret-scanned first; refused with the list when the scanner finds one). Nothing is uploaded.
   */
  'deploy.uploadFile': { req: DeployUploadRequest; res: DeployUploadResult }
  'deploy.build': { req: DeployBuildRequest; res: DeployBuildResult }
  /** "Commit to run branch" (opt-in per project): whether it is offered, the message and the files. */
  'git.commitPreview': { req: Run; res: CommitPreview }
  /** Commit the run's changes on its run branch or isolated copy's branch (the user's index stays as it was). */
  'git.commit': { req: Run & { message?: string }; res: CommitResult }
  /** "Create PR" (opt-in per project): the repository, branch, text, copyable commands and the gh check. */
  'git.prPreview': { req: Run; res: PrPreview }
  /** Push and open the pull request, only with a confirmation that names the repository and branch shown. */
  'git.prCreate': { req: PrCreateRequest; res: PrResult }
  // New project (templates are data; Dim Factory never runs a create command)
  /** The built-in and user templates, checked against their packs, grouped by pack. */
  'templates.list': { req: void; res: TemplatesList }
  /** Check and create a new or empty folder, git init it (no commit), and answer the run's task, Brief and recipe. */
  'project.create': { req: ProjectCreateRequest; res: ProjectCreated }
  // The factory: task queues per folder, budgets and stop rules, the schedule, the daily report, project memory
  /** Every queue, the limits, the schedule, today's spending and the launch notice (pending tasks priced). */
  'queue.get': { req: void; res: QueueView }
  /** Add tasks to a folder's queue (each with an optional recipe). Nothing starts unless the queue runs. */
  'queue.add': { req: { folder: string; tasks: QueueTaskInput[] }; res: QueueView }
  'queue.remove': { req: { folder: string; id: string }; res: QueueView }
  /** Move a task to position `to` (0-based) in its queue. */
  'queue.move': { req: { folder: string; id: string; to: number }; res: QueueView }
  /** Put a failed, stopped or blocked task back to pending (its next run is a new run). */
  'queue.retry': { req: { folder: string; id: string }; res: QueueView }
  /** Remove the done tasks from a folder's queue. */
  'queue.clear': { req: { folder: string }; res: QueueView }
  /** Add the open checkbox items (`- [ ] …`) of a markdown TODO file (default: the folder's TODO.md). */
  'queue.importTodo': { req: { folder: string; file?: string }; res: QueueImportResult }
  /** The GitHub CLI check before an import (installed, signed in; copyable fixes). Never blocking. */
  'queue.githubCheck': { req: { folder: string }; res: GithubCheckView }
  /** Add the folder's open GitHub issues (`gh issue list --json`). Runs only on the user's click. */
  'queue.importGithub': { req: { folder: string }; res: QueueImportResult }
  /** Start (or resume) the queues of `folders` (every queue with something pending when absent). */
  'queue.start': { req: { folders?: string[]; noticeId?: string }; res: QueueView }
  /** Pause the queues of `folders` (every running one when absent); runs already working go on. */
  'queue.pause': { req: { folders?: string[] }; res: QueueView }
  'queue.dismissNotice': { req: { id: string }; res: QueueView }
  /** The daily report (default today), written to `<home>/reports/<date>.md`. */
  'queue.report': { req: { date?: string }; res: DailyReportView }
  /** The folder's project memory file and the updates waiting for approval. */
  'memory.get': { req: { folder: string }; res: MemoryView }
  /** Write an update you approved (only while no run works in the folder, and only onto the file it was made from). */
  'memory.apply': { req: { folder: string; id: string }; res: MemoryView }
  'memory.dismiss': { req: { folder: string; id: string }; res: MemoryView }
  // Easy mode (easy/service.ts): how the app is used, an idea resolved locally, a new project and its run, follow-ups
  'easy.state': { req: void; res: EasyState }
  'easy.setExperience': { req: { experience: Experience }; res: EasyState }
  'easy.resolve': { req: EasyResolveRequest; res: EasyResolved }
  'easy.create': { req: EasyCreateRequest; res: EasyStarted }
  'easy.change': { req: EasyChangeRequest; res: EasyStarted }
  /** What a change would cost and take, and how it would run (lighter models, the security review): no tokens. */
  'easy.changeEstimate': {
    req: { folder: string; change: string; depth?: DepthSetting }
    res: EasyChangeEstimate
  }
  'easy.projects': { req: void; res: EasyProjectView[] }
  /** Added files checked as easy.create would copy them (nothing is copied). */
  'easy.attachCheck': { req: { paths: string[] }; res: EasyAttachment[] }
  /** Every Easy project folder with the project permission, with how often it was used. */
  'easy.permissions': { req: void; res: EasyPermissionView[] }
  /** One folder's project permission (and its uses during a run). */
  'easy.permission': { req: { folder: string; runId?: string }; res: EasyPermissionState }
  /** Take a project permission back: it stops covering anything at once, a running run included. */
  'easy.revokePermission': { req: { folder: string }; res: EasyPermissionView[] }
  /** A folder the user already has, as a run would work there (read only: nothing is changed). */
  'easy.inspectFolder': { req: { folder: string }; res: EasyFolderView }
  /** A run in a folder the user already has: an isolated copy, or in place with undo; never the project permission. */
  'easy.work': { req: EasyWorkRequest; res: EasyStarted }
  /** "Help me choose": one cheap read-only model call that suggests one of a vague idea's kinds (only on a click). */
  'easy.intent': { req: { idea: string; candidates: EasyKind[] }; res: EasyIntentAnswer }
  /** Whether a run's page can be looked at, by whom, and what the last look found (no tokens). */
  'easy.visual': { req: { runId: string }; res: EasyVisualState }
  /** "Look it over": one read-only look at the picture of the run's page; adds `[should]` findings (only on a click). */
  'easy.visualReview': { req: { runId: string }; res: EasyVisualResult }
  /** Who would answer a beginner helper and about what one call costs (no tokens); `runId`: Ask about it's project. */
  'easy.helperCost': { req: { helper: EasyHelper; runId?: string }; res: EasyHelperCost }
  /** "Help me think it through": one round, read-only (only on a click); the next question, or the brief. */
  'easy.think': { req: EasyThinkRequest; res: EasyThinkAnswer }
  /** "Ask about it": one read-only question about a run's project on a cheap model (only on a click). */
  'easy.ask': { req: { runId: string; question: string }; res: EasyAskAnswer }
  /** Before I share it: a run's project files read for secrets and people's details (no tokens, nothing sent). */
  'easy.shareFiles': { req: { runId: string }; res: ShareFilesReport }
  /** The overnight list: Easy's queued projects. */
  'easy.queue': { req: void; res: EasyQueueView }
  /** Each idea becomes a new project and a task on its own queue (nothing starts). */
  'easy.queueAdd': { req: EasyQueueAddRequest; res: EasyQueueView }
  /** Start the list now (one after another), or every day at a time (the factory's schedule). */
  'easy.queueStart': { req: EasyQueueStartRequest & { noticeId?: string }; res: EasyQueueView }
  'easy.queuePause': { req: void; res: EasyQueueView }
  /** Take an idea that has not started off the list. */
  'easy.queueRemove': { req: { folder: string }; res: EasyQueueView }
}

/** A task to queue: its text and an optional recipe id. */
export interface QueueTaskInput {
  task: string
  recipe?: string
}

/** What a preview command is about: a folder on demand, or a finished run (its folder, or its isolated copy). */
export interface PreviewTarget {
  folder?: string
  runId?: string
}

export type Cmd = keyof Commands
export type Req<C extends Cmd> = Commands[C]['req']
export type Res<C extends Cmd> = Commands[C]['res']
/** Commands whose request is `void` may omit it. */
export type InvokeArgs<C extends Cmd> = Req<C> extends void ? [req?: undefined] : [req: Req<C>]
/** A concrete command call, e.g. a toast's action button. */
export type CommandCall = { [C in Cmd]: { cmd: C; req: Req<C> } }[Cmd]

export const COMMAND_AREAS = [
  'app',
  'runs',
  'asks',
  'diff',
  'vendors',
  'config',
  'dashboard',
  'catalog',
  'storage',
  'notifications',
  'e2e',
  'mcp',
  'preview',
  'deploy',
  'factory',
  'easy',
] as const
export type CommandArea = (typeof COMMAND_AREAS)[number]

/** Runtime list of every command (exhaustive both ways via `satisfies`). Main registers `e2e` only under DIM_FACTORY_E2E=1. */
export const COMMAND_AREA = {
  'app.info': 'app',
  'app.ready': 'app',
  'app.quit': 'app',
  'dialog.pickFolder': 'app',
  'dialog.pickFiles': 'app',
  'shell.open': 'app',
  'log.write': 'app',
  'diagnostics.build': 'app',
  'diagnostics.copy': 'app',
  'diagnostics.save': 'app',
  'events.focus': 'app',
  'state.get': 'app',
  'state.set': 'app',
  'runs.start': 'runs',
  'matches.start': 'runs',
  'matches.get': 'runs',
  'matches.list': 'runs',
  'matches.rematch': 'runs',
  'matches.rematchCheck': 'runs',
  'matches.savePatch': 'diff',
  'matches.scoreboard': 'runs',
  'matches.batchPlan': 'runs',
  'matches.batchAdd': 'runs',
  'matches.offers': 'runs',
  'matches.dismissOffer': 'runs',
  'matches.pick': 'runs',
  'matches.undoPick': 'runs',
  'matches.blind': 'runs',
  'matches.compare': 'diff',
  'matches.compareFile': 'diff',
  'runs.list': 'runs',
  'runs.get': 'runs',
  'runs.events': 'runs',
  'runs.output': 'runs',
  'runs.stop': 'runs',
  'runs.close': 'runs',
  'runs.resume': 'runs',
  'runs.retryPass': 'runs',
  'runs.skipPass': 'runs',
  'runs.keepWaiting': 'runs',
  'runs.switchToAuto': 'runs',
  'runs.rerun': 'runs',
  'runs.pin': 'runs',
  'runs.remove': 'runs',
  'runs.undoRemove': 'runs',
  'runs.branch': 'runs',
  'runs.limits': 'runs',
  'asks.answer': 'asks',
  'asks.undo': 'asks',
  'cards.resolve': 'asks',
  'recovery.execute': 'asks',
  'heal.diagnose': 'asks',
  'diff.files': 'diff',
  'diff.file': 'diff',
  'diff.blob': 'diff',
  'diff.revert': 'diff',
  'diff.undoRevert': 'diff',
  'diff.markReviewed': 'diff',
  'worktree.preview': 'diff',
  'worktree.apply': 'diff',
  'worktree.undoApply': 'diff',
  'worktree.discard': 'diff',
  'worktree.undoDiscard': 'diff',
  'preflight.run': 'vendors',
  'depth.decide': 'vendors',
  'task.check': 'vendors',
  'task.sharpen': 'vendors',
  'vendors.list': 'vendors',
  'vendors.probe': 'vendors',
  'vendors.setPath': 'vendors',
  'vendors.models': 'vendors',
  'config.resolve': 'config',
  'config.read': 'config',
  'config.save': 'config',
  'config.patch': 'config',
  'config.restoreBackup': 'config',
  'extensions.discover': 'config',
  'extensions.claudeConnectors': 'config',
  'prompts.get': 'config',
  'prompts.save': 'config',
  'ui.setTheme': 'config',
  'folders.recent': 'config',
  'git.init': 'config',
  'guardrails.suggest': 'config',
  'guardrails.state': 'config',
  'guardrails.prove': 'config',
  'trust.get': 'config',
  'trust.set': 'config',
  'verify.detect': 'config',
  'dashboard.get': 'dashboard',
  'stats.get': 'dashboard',
  'usage.get': 'dashboard',
  'context.report': 'dashboard',
  'estimates.get': 'dashboard',
  'brief.detect': 'config',
  'brief.save': 'config',
  'brief.suggest': 'config',
  'recipes.list': 'config',
  'catalog.get': 'catalog',
  'catalog.refreshPlan': 'catalog',
  'catalog.refresh': 'catalog',
  'catalog.cancel': 'catalog',
  'catalog.apply': 'catalog',
  'catalog.undo': 'catalog',
  'catalog.savePrice': 'catalog',
  'catalog.setSchedule': 'catalog',
  'storage.usage': 'storage',
  'storage.clearShadow': 'storage',
  'notifications.test': 'notifications',
  'notifications.repairShortcut': 'notifications',
  'e2e.state': 'e2e',
  'e2e.power': 'e2e',
  'e2e.clock': 'e2e',
  'mcp.external.get': 'mcp',
  'mcp.external.set': 'mcp',
  'mcp.external.codexPlugin': 'mcp',
  'mcp.external.claudePlugin': 'mcp',
  'mcp.addToEditor': 'mcp',
  'mcp.requests.list': 'mcp',
  'mcp.requests.approve': 'mcp',
  'mcp.requests.decline': 'mcp',
  'preview.detect': 'preview',
  'preview.start': 'preview',
  'preview.trust': 'preview',
  'preview.stop': 'preview',
  'preview.list': 'preview',
  'preview.open': 'preview',
  'preview.openPair': 'preview',
  'preview.smoke': 'preview',
  'preview.playtest': 'preview',
  'preview.tryIt': 'preview',
  'preview.shareCheck': 'preview',
  'preview.network': 'preview',
  'preview.phone': 'preview',
  'preview.savePdf': 'preview',
  'deploy.inspect': 'deploy',
  'deploy.tick': 'deploy',
  'deploy.uploadFile': 'deploy',
  'deploy.build': 'deploy',
  'git.commitPreview': 'deploy',
  'git.commit': 'deploy',
  'git.prPreview': 'deploy',
  'git.prCreate': 'deploy',
  'templates.list': 'config',
  'project.create': 'config',
  'queue.get': 'factory',
  'queue.add': 'factory',
  'queue.remove': 'factory',
  'queue.move': 'factory',
  'queue.retry': 'factory',
  'queue.clear': 'factory',
  'queue.importTodo': 'factory',
  'queue.githubCheck': 'factory',
  'queue.importGithub': 'factory',
  'queue.start': 'factory',
  'queue.pause': 'factory',
  'queue.dismissNotice': 'factory',
  'queue.report': 'factory',
  'memory.get': 'factory',
  'memory.apply': 'factory',
  'memory.dismiss': 'factory',
  'easy.state': 'easy',
  'easy.setExperience': 'easy',
  'easy.resolve': 'easy',
  'easy.create': 'easy',
  'easy.change': 'easy',
  'easy.changeEstimate': 'easy',
  'easy.projects': 'easy',
  'easy.attachCheck': 'easy',
  'easy.permissions': 'easy',
  'easy.permission': 'easy',
  'easy.revokePermission': 'easy',
  'easy.inspectFolder': 'easy',
  'easy.work': 'easy',
  'easy.intent': 'easy',
  'easy.visual': 'easy',
  'easy.visualReview': 'easy',
  'easy.helperCost': 'easy',
  'easy.think': 'easy',
  'easy.ask': 'easy',
  'easy.shareFiles': 'easy',
  'easy.queue': 'easy',
  'easy.queueAdd': 'easy',
  'easy.queueStart': 'easy',
  'easy.queuePause': 'easy',
  'easy.queueRemove': 'easy',
} as const satisfies Record<Cmd, CommandArea>

// ---- push events ----------------------------------------------------------------------------

export type ToastLevel = 'info' | 'warn' | 'error'

export interface ToastAction {
  label: string
  call: CommandCall
}

export const APP_EVENT_KINDS = [
  'run',
  'resync',
  'run-summary',
  'attention',
  'probe',
  'catalog',
  'config-changed',
  'theme',
  'toast',
  'app',
  'heartbeat',
  'mcp-requests',
  'preview',
  'queue',
  'memory',
  'easy-permission',
  'match',
] as const

/** Batched over EVT_CHANNEL every 16–33 ms. */
export type AppEvent =
  | { kind: 'run'; env: RunEnvelope }
  /** Renderer refetches with runs.events from its lastSeq. */
  | { kind: 'resync'; runIds: string[] }
  /** Index upsert with progress; debounced 1 s. */
  | { kind: 'run-summary'; summary: RunSummary }
  | { kind: 'attention'; needsYou: number; items: AttentionItem[] }
  | { kind: 'probe'; vendor: VendorId; view: ProbeView }
  | {
      kind: 'catalog'
      state: CatalogEventState
      jobId?: string
      progress?: string
      diff?: CatalogDiff
      /** A `failed` refresh's reason, as the user reads it. */
      error?: string
    }
  | { kind: 'config-changed'; scope: ConfigScope; folder?: string }
  | { kind: 'theme'; theme: ThemeState }
  | {
      kind: 'toast'
      level: ToastLevel
      message: string
      action?: ToastAction
      /**
       * The run whose Run view already shows what this toast says (a gate's card, its jump pill and the view's
       * assertive announcement): the renderer leaves the toast out while that run's view is open, where it would only
       * cover the card's sticky actions.
       */
      skipInRunView?: string
      /**
       * An approval's toast (asks waiting in this run): the renderer keeps one per run, leaves it out while Easy's view
       * of the run is open (its ask card says it in place), and takes it down once nothing waits there any more.
       */
      askRunId?: string
    }
  | { kind: 'app'; state: AppLifecycleState; activeRuns: number; runIds?: string[]; detail?: string }
  /** Every 5 s while runs are active or the window is shown; the renderer warns after 15 s of silence. */
  | { kind: 'heartbeat'; at: number }
  /** The pending outside-agent run requests changed (the whole pending list). */
  | { kind: 'mcp-requests'; requests: McpRunRequest[] }
  /** A preview started, printed output, found its URL or ended (throttled per session). */
  | { kind: 'preview'; session: PreviewSessionView }
  /** The queues, limits, schedule, today's spending or the launch notice changed (the whole view). */
  | { kind: 'queue'; view: QueueView }
  /** A folder's project memory changed (an update proposed, written or dismissed): read memory.get again. */
  | { kind: 'memory'; folder: string }
  /** An Easy project's permission was given, used or revoked: read easy.permission(s) again. */
  | { kind: 'easy-permission'; folder: string }
  /** A match's record changed (side B started, a pick, the names hidden or shown): read matches.get again. */
  | { kind: 'match'; matchId: string }

export type AppEventKind = AppEvent['kind']
export type AppEventOf<K extends AppEventKind> = Extract<AppEvent, { kind: K }>

/** `window.dimFactory`, exposed by the preload. */
export interface DimFactoryApi {
  invoke<C extends Cmd>(cmd: C, ...args: InvokeArgs<C>): Promise<Result<Res<C>>>
  subscribe(cb: (batch: AppEvent[]) => void): () => void
  readonly platform: Platform
  /** Applied before createRoot so the first paint matches main's backgroundColor. */
  readonly initialTheme: ThemeState
}
