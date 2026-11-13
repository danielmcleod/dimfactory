// Vendor adapter contract. Serializable parts live in src/shared/vendors.ts and
// src/shared/events.ts; this file adds the runtime surface. The process layer stays behind RunHandle.
import type { ToolPolicy } from '../../shared/guardrails.ts'
import type { AdapterSignal, AllowRule, AskDecision, NormalizedEvent, Usage } from '../../shared/events.ts'
import type { AllowSource } from './allow-cache.ts'
import type { ExtensionLevel } from '../../shared/extensions.ts'
import type { CheckResult } from '../../shared/preflight.ts'
import type { FreshReason, Mode, PauseReason, StepKey } from '../../shared/run.ts'
import type {
  Capabilities,
  LocalPreset,
  ModelInfo,
  ProbeResult,
  ReadinessNeed,
  Route,
  Support,
  Transport,
  VendorId,
} from '../../shared/vendors.ts'

export type {
  AdapterSignal,
  AllowRule,
  AskDecision,
  Capabilities,
  CheckResult,
  LocalPreset,
  ModelInfo,
  NormalizedEvent,
  ProbeResult,
  ReadinessNeed,
  Support,
  Usage,
}

/** What a process runs for: a run step, or a run-less heal / catalog refresh. */
export type StartStep = StepKey | 'heal' | 'catalog'

/** Why the engine stops a process: the user, a timer, a quit, or the loop stop (one call repeated too often). */
export type StopReason = 'user' | 'timeout' | 'shutdown' | 'loop'

/**
 * Why the engine answers an ask `cancel` (state machine rows): P10 ask timer → `ask-timeout` (ask_timeout); P9b deny
 * under `ask.denyPauses` → `denied` (permission_denied). Default `ask-timeout`. Additive to the `answer()` contract.
 */
export type AskCancelReason = Extract<PauseReason, 'ask-timeout' | 'denied'>

/** `meta` signal: the pass's usage is approximate. Any present value flags it; the value carries the reason. */
export const META_USAGE_APPROX = 'usageApprox'
/**
 * The post-compaction reminder (StartOptions.compactionReminder) after a compaction: `{ sent: boolean }`, or
 * `{ unsupported: true }` from a vendor that has no way to add it (ACP). Never the reminder's text.
 */
export const META_COMPACTION_REMINDER = 'compactionReminder'
/** `meta` signal: a resume was requested but the CLI started a fresh session (value: `{route, reason}`). */
export const META_RESUME_IGNORED = 'resumeIgnored'
/**
 * `meta` signal after an ask timed out (`cancel` with why `ask-timeout`): `{requestId, rule}` = the exact AllowRule
 * that "Allow & resume" adds to the run (P19 "a late Allow becomes an allow-rule"). Never applied on its own.
 */
export const META_LATE_ALLOW_RULE = 'lateAllowRule'
/**
 * `meta` signal: the usage (a `Usage`) a FAILED attempt reported (an error result still bills). Never sent with
 * `done`, whose own `usage` carries it; the engine adds it to the step's spend.
 */
export const META_USAGE = 'usage'
/**
 * `meta` signal: the vendor's structured answer for a pass started with `outputSchema` (Claude: a successful
 * `result.structured_output`, C17). Sent in the same step as `done`, just before it (consumers emit signals before
 * events), so a listener has it when `done` arrives. `value` is the JSON as the CLI reported it: untrusted data that
 * the caller validates. Absent when the CLI answered without one (C18: the caller falls back to the final message).
 */
export const META_STRUCTURED_OUTPUT = 'structuredOutput'
/**
 * `meta` signal (Codex X12): a native plan ran emulated, because the vendor refused its plan mode before any model
 * call. `value: {reason, detail?}`: `reason` is one plain sentence for the Plan card ("Fell back to template: …"),
 * `detail` the vendor's own words. The engine records it as the step's plan fallback.
 */
export const META_PLAN_FALLBACK = 'planFallback'
/**
 * `meta` signal: where a captured plan came from (`{source, warning?}`). A `warning` (Codex finished without a
 * proposed plan, so its final message is the plan, with a warning) becomes a run note.
 */
export const META_PLAN_SOURCE = 'planSource'
/**
 * `meta` signal (Codex, live X17): the pages a finished web search item read, `{id, urls}` (the item id and the
 * URLs as the CLI named them, distinct, in order). Codex 0.160.1 names an opened page in the item's `results` (action
 * `other`, or `findInPage` without a url), which no tool line can hold whole. The catalog refresh counts their hosts
 * as read (`fetchedHosts`); untrusted data like the rest of the answer. Never sent for a plain search (its results
 * are search hits, not pages read).
 */
export const META_PAGES_READ = 'pagesRead'
/**
 * `meta` signal (live balanced run): the model a pass with no model of its own runs, `{model, replaced?}`, once the
 * vendor has said which (Codex's app-server: the model thread/start or thread/resume answered, after the folder's
 * project layers, profiles and overrides; codex/default-model.ts). `replaced`: the account does not list that model,
 * so Dim Factory ran model/list's default (`model`) instead, sent on turn/start. The engine records it as the step's model
 * used (StepView.modelUsed, modelReplaced) and prices the pass at it. `{model: null}`: the thread answered without a
 * model, so the step stops expecting one (StepState.modelUnreported). Live X18a/b:
 * `{asked, replaced}`, sent before the turn starts, is the default Dim Factory asked for on turn/start in place of
 * `replaced`, not yet confirmed (StepView.modelAsked); `{model, replaced}` follows once Codex says it runs it (a
 * thread/settings/updated naming it, or the turn's first usage total). `{model, rerouted, replaced?}` when
 * Codex moved the turn to `model` from `rerouted` (its `model/rerouted`), which ends any wait (StepView.modelRerouted).
 * Never sent when the pass names a model or runs a local preset, nor where the vendor never says (Codex's exec route:
 * the CLI chooses).
 */
export const META_MODEL_USED = 'modelUsed'
/**
 * The model the vendor names when its session starts (Claude's `system/init` `model`). For a pass that names no
 * model the engine records it as the step's model used, as META_MODEL_USED would
 * (Claude's init arrives before any output of the turn, so the card's expected model is confirmed, not replaced).
 */
export const META_SESSION_MODEL = 'model'

/**
 * Web access for a read-only pass (the catalog refresh): the vendor's web search plus page
 * fetches limited to `allowedDomains` (exact hosts, catalog/sources.ts). Claude: `--allowedTools
 * WebSearch,WebFetch(domain:<host>),…`. `true` is web search alone (no page fetches).
 */
export interface WebAccess {
  allowedDomains: readonly string[]
}

export type TapDir = 'in' | 'out' | 'err'

export interface StartOptions {
  /** Guardrails an adapter can hold before a tool runs. Absent: it refuses nothing. */
  guardrails?: ToolPolicy
  runId: string
  step: StartStep
  cwd: string
  /** Sent over stdin / JSON-RPC, never argv. */
  prompt: string
  /**
   * Pictures sent with the prompt (absolute paths of PNG or JPEG files, read when the turn starts). Only for an adapter
   * whose `acceptsImages()` answers true; the others never get any. Additive to the contract.
   */
  images?: readonly string[]
  /** New sessions only (Claude snapshots the system prompt). */
  systemAppend?: string
  /** `null` = omit the flag and use the vendor default. */
  model?: string | null
  /**
   * The pass's effort level (`passes.<p>.effort`); `null`/absent = the vendor's default effort. Claude and Codex send
   * it (a value that is not a plain level fails the launch, config_invalid); vendors without an effort setting
   * (capabilities.effort) leave it out.
   */
  effort?: string | null
  mode: Mode
  planNative: boolean
  /** Pre-assigned id (Claude `--session-id`), persisted by the engine before spawn. */
  sessionId?: string
  /** `priorUsage` = the session's last cumulative totals; the adapter emits deltas against it. */
  resume?: { sessionId: string; priorUsage?: Usage }
  /** The run's allow cache snapshot ("Allow for this run"). */
  allowRules: AllowRule[]
  /**
   * Easy mode's project permission for this pass (core/easy/permission.ts), asked after the run's own rules on every
   * ask (a revoke takes effect at once). Absent: nothing beyond the run's rules. Additive to the contract.
   */
  permit?: AllowSource
  /** Validated against `managedFlags` at load and again before spawn. */
  extraArgs?: string[]
  /** Renames a managed flag when building argv (user-only, heal-patchable). */
  flagMap?: Record<string, string>
  trustFolder: boolean
  local?: LocalPreset
  /** Web access for the `catalog` step only (other steps ignore it); see {@link WebAccess}. */
  web?: boolean | WebAccess
  /**
   * A JSON Schema for the answer. Claude sends it as the initialize request's `jsonSchema` and reports the
   * answer in a {@link META_STRUCTURED_OUTPUT} signal (C17).
   */
  outputSchema?: object
  ephemeral?: boolean
  /**
   * Plan only (continuity): keep the session when the pass ends, so the next pass can resume it (Claude: no
   * `--no-session-persistence`, a pre-assigned id; Codex: a thread that is not ephemeral). The pass still runs read-only.
   * Absent: a read-only pass's session is thrown away, as always. Additive to the contract.
   */
  keepSession?: boolean
  askTimeoutMs: number
  /**
   * The pass's Extensions (shared/extensions.ts): which of the user's own MCP servers, skills, plugins and hooks it may
   * use. Absent: the level the step always had (none for read-only steps, passthrough for Implement and Fix), so a
   * caller that predates Extensions launches exactly as before. Additive to the contract.
   */
  extensions?: PassExtensions
  /**
   * Ask the vendor for its context breakdown (Claude's get_context_usage, summary detail: no model call) after the
   * prompt and once the answer is in, before the session closes. Vendors without one ignore it. Additive to the contract.
   */
  contextBreakdown?: boolean
  /**
   * The post-compaction reminder (context health): after the vendor summarises the session's context, the adapter adds
   * this text back (Claude: a SessionStart hook answered when its source is `compact`; Codex: a `turn/steer` after the
   * `contextCompaction` item; ACP: not supported, a warning only). Read when the compaction happens; undefined or
   * empty: nothing is added. Absent: no hook is registered and nothing is sent. Additive to the contract.
   */
  compactionReminder?: () => Promise<string | undefined>
  /** `vendors.<id>.env` (user config only; E2E injects fakes this way). Additive to the contract. */
  env?: Record<string, string>
  /** Raw line tee for `raw/` and the fixture recorder. */
  tap?: (dir: TapDir, line: string) => void
  /**
   * Session id persistence (Codex: from the thread/start response, before turn/start; ACP: from
   * session/new, before session/prompt). An adapter that learns its session id from the vendor (no pre-assigned id)
   * awaits this with the id before it sends the first turn, so the engine has persisted it (run.json) by then. It
   * never rejects. The adapter still emits its `session` event as usual. Additive to the contract.
   *
   * It answers whether the id is durable. `{ok:true}` once the run recorded it and run.json is written;
   * `{ok:false}` when it could not be (a failed write, a run that no longer waits for this pass). The adapter then
   * ends the pass before its first turn (a Dim Factory failure, no model call), and never sends a turn after a wait it
   * gave up on (the adapter's own bound).
   */
  onSession?: (sessionId: string) => Promise<SessionRecorded>
}

/** A pass's Extensions as its launch needs them (StartOptions.extensions). */
export interface PassExtensions {
  level: ExtensionLevel
  /** The vendor's allow list (config `extensions.allowed.<vendor>`); only the `allowed` level reads it. */
  mcp: readonly string[]
  skills: readonly string[]
  /**
   * Claude: the allowed MCP servers whose tools run without asking (config `extensions.allowed.claude.mcpWithoutAsking`,
   * only names also on `mcp`). Absent: every MCP tool asks (a read-only pass's `dontAsk` denies it).
   */
  mcpWithoutAsking?: readonly string[]
  /**
   * A private folder of the run where an adapter writes what the launch needs and nobody else may read (Claude: the
   * allowed MCP servers' config, deleted once the process is gone). Absent: the OS temp folder.
   */
  scratchDir?: string
}

/** What `StartOptions.onSession` answers. `code`: the errno of a failed run.json write, when known. */
export type SessionRecorded = { ok: true } | { ok: false; reason: string; code?: string }

export interface ExitInfo {
  code: number | null
  signal: string | null
  /** Set when Dim Factory initiated the stop. */
  stoppedBy?: StopReason
  /** A terminal event (`done` or fatal `error`) was emitted before exit. */
  sawTerminal: boolean
  /** Wall time from spawn to exit (feeds `retryPolicy` for process_crash). */
  ranMs: number
}

export type Unsubscribe = () => void

/** One vendor process (or JSON-RPC turn) for one step attempt. */
export interface RunHandle {
  readonly id: string
  readonly vendor: VendorId
  readonly route: Route
  readonly pid: number | undefined
  /** Events emitted before the first subscriber are buffered and replayed to it. */
  onEvent(cb: (e: NormalizedEvent) => void): Unsubscribe
  onSignal(cb: (s: AdapterSignal) => void): Unsubscribe
  sessionId(): string | undefined
  /** The session's cumulative totals as last reported (the engine stores them as `lastTotals`). */
  cumulativeUsage(): Usage | undefined
  /** Request ids of asks raised and not yet answered or withdrawn. */
  pendingAsks(): string[]
  readonly exited: Promise<ExitInfo>
}

export interface ProbeOptions {
  force?: boolean
}

export interface ListModelsOptions {
  force?: boolean
  /** Codex local presets list models from `{baseUrl}/models`. Additive to the contract. */
  local?: LocalPreset
}

export interface CanResumeResult {
  ok: boolean
  reason?: FreshReason
}

export interface Adapter {
  readonly id: VendorId
  readonly displayName: string
  readonly transport: Transport
  /** Flags the adapter owns; `extraArgs` may not repeat them and `flagMap` may only rename them. */
  readonly managedFlags: readonly string[]
  /**
   * Flags that widen what a pass may do (the spawn check refuses them in extraArgs, also as a
   * letter of a combined short flag). The config load check refuses them too (SemanticOptions.forbiddenFlags). Absent:
   * none known (registry stubs).
   */
  readonly forbiddenFlags?: readonly string[]
  /**
   * Every flag the CLI already defines (managed or not). A `flagMap` rename may not target one of them: that
   * would point a Dim Factory flag at an option the CLI reads for something else. Absent: not known (registry stubs).
   */
  readonly cliFlags?: readonly string[]
  readonly testedUpTo: string
  readonly versionFloor: string
  readonly versionRecommended: string
  /** Global; cached per launch. `checks` carries `vendor.<id>.*` results. */
  probe(o?: ProbeOptions): Promise<ProbeResult>
  /** Per folder + pass, < 1 s, no tokens. Ids are `pass.<p>.readiness.<id>`. */
  readiness(cwd: string, need: ReadinessNeed): Promise<CheckResult[]>
  /** The ONLY source of mode copy. */
  support(need: ReadinessNeed): Support
  canResume(sessionId: string, cwd: string): Promise<CanResumeResult>
  /**
   * Whether `StartOptions.images` reach the model now: Claude (stream-json user message image blocks, the pinned SDK's
   * MessageParam) and Codex on its app-server route (turn/start `localImage` input, the pinned 0.160 UserInput).
   * Absent or false: pictures are not sent. Additive to the contract.
   */
  acceptsImages?(): boolean
  /** Synchronous; spawn failures arrive as a fatal `error` event on the handle. */
  start(o: StartOptions): RunHandle
  answer(h: RunHandle, requestId: string, d: AskDecision, why?: AskCancelReason): void
  stop(h: RunHandle, reason: StopReason): Promise<void>
  listModels(o?: ListModelsOptions): Promise<ModelInfo[]>
}
