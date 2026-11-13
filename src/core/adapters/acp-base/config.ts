// The per-vendor configuration of the ACP base (Gemini and Grok; Cursor, OpenCode and Copilot can be added on request
// as ~40-line ACP configs). Everything vendor-specific lives here; the base
// (index.ts, run.ts, normalize.ts, probe.ts) is generic over it. Gemini is gemini/index.ts; Grok is grok/index.ts.
import type { Usage } from '../../../shared/events.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import type { FailureCategory } from '../../../shared/failure.ts'
import type { Mode, PlanMode } from '../../../shared/run.ts'
import type { ModelInfo, ProbeAccount, SupportStatus, VendorId } from '../../../shared/vendors.ts'
import type { RegexRule } from '../../heal/signals/generic.ts'
import type { EnvInput } from '../../proc/env.ts'
import type { CliSpec, ResolvedCli } from '../../proc/resolve-cli.ts'
import type { Rec } from './wire.ts'

/** How one Dim Factory mode runs on the vendor (the vendor's mode table). */
export interface AcpModeSpec {
  /** `session/set_mode` id sent after every new, load or resume; null: none (the vendor's default stands). */
  acpMode: string | null
  /**
   * `_meta` for `session/new`, and also for `session/load` and `session/resume`: a vendor that sets the approval
   * posture per session (Grok `yoloMode`) reads it on every setup, so a continued session never keeps the posture an
   * earlier pass gave it.
   */
  meta?: Readonly<Record<string, unknown>>
  /** `support().copy` (the ONLY source of mode text; plain words, no em dashes). */
  copy: string
  /** Default `supported`; Grok autoedit is `unsupported` until GR03. */
  status?: SupportStatus
}

export interface AcpLaunchInput {
  /** The resolved binary (`node <entry>` for an npm shim: command = system node, prefixArgs = [entry]). */
  cli: Pick<ResolvedCli, 'command' | 'prefixArgs' | 'version'>
  /** `null`/absent: the vendor's default model. */
  model?: string | null | undefined
  /** The folder may run without the vendor's own trust prompt (`trustFlag`): a grant or a Dim Factory-owned cwd. */
  trust: boolean
  /** The user's `vendors.<id>.extraArgs` (validated before this is called; ACP places them at the end of argv). */
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
  /** The child env, already sanitized (PATH, vendors.<id>.env, StartOptions.env). */
  env: Record<string, string>
  purpose: 'pass' | 'probe'
  /**
   * The MCP servers the pass may use, by name (its Extensions level: none = an empty list, allowed = the allow list).
   * Absent: every server the vendor's own settings define (Pass through, and every launch before Extensions). A
   * vendor that cannot limit them (Grok) ignores it.
   */
  mcpAllow?: readonly string[] | undefined
}

/** What to spawn (no shell; the prompt never goes in argv). */
export interface AcpLaunch {
  exe: string
  /** Everything after `exe`, the JS entry of a node-entry CLI included. */
  args: string[]
  env: Record<string, string>
}

/** One probe handshake: initialize, then (when the vendor's probe asks for it) session/new. No prompt, no tokens. */
export interface AcpHandshake {
  /** initialize answered. */
  ok: boolean
  ms: number
  error?: string
  /** Why the handshake failed, when Dim Factory can tell (a refused initialize is flag_drift). */
  category?: FailureCategory
  protocolVersion?: number
  loadSession: boolean
  resume: boolean
  /** session/new answered ACP `authRequired` (the agent needs a sign-in). */
  authRequired: boolean
  /** session/new answered (undefined: not tried). */
  sessionOk?: boolean
  sessionError?: string
  /** `availableModes` ids and `currentModeId` of the probe session. */
  modes?: string[]
  currentMode?: string
  models: ModelInfo[]
  stderr: string[]
}

/** What the probe learned about the agent (support(), start(), canResume() and listModels() read it). */
export interface AcpFacts {
  /** A probe handshake completed (initialize answered). */
  probed: boolean
  loadSession: boolean
  resume: boolean
  /** `availableModes` ids from session/new (undefined: not known yet; nothing is refused on that). */
  modes?: readonly string[]
  /** `planAcpMode` is one of the modes (the probe's plan check: plan ∈ availableModes). */
  plan: boolean
}

export interface AcpAuthInput {
  /** Dim Factory's env layered with `vendors.<id>.env` (what the child sees, before sanitizing). */
  env: EnvInput
  /** The user's home folder (credential files are checked for existence only, never read). */
  home: string
  /** The probe's handshake, when one ran (an `authRequired` answer overrides what the files say). */
  handshake: AcpHandshake | undefined
  at: number
}

export interface AcpProbeSpec {
  /** Arguments that print help (`--help`): `required` flags missing fail vendor.<v>.version, `optional` ones warn. */
  help?: { args: readonly string[]; required: readonly string[]; optional?: readonly string[] }
  /** vendor.<v>.auth. */
  auth(o: AcpAuthInput): CheckResult
  /**
   * Subscription auth is shown as an API-equivalent cost: how the vendor signs in, as `ProbeResult.account` (a
   * method name only: never an email, a key or a credential file's contents). undefined: unknown or not signed in.
   */
  account?(o: AcpAuthInput): ProbeAccount | undefined
  /**
   * The probe also runs `session/new` (modes, models, auth) in the Dim Factory-owned probe folder. `'forced'` (Grok:
   * "ACP authRequired on Test"): only on a forced probe (the vendor's Test or a Re-check), the launch probe stops at
   * initialize.
   */
  newSession: boolean | 'forced'
}

/**
 * A vendor's own token totals in a PromptResponse (AcpUsageSpec.metaUsage). `approx` says why they are only
 * approximate (`usageApprox` reason); absent: `no-cached-split` (Gemini's `_meta.quota`, input with the cached reads in
 * it); `false`: exact (Grok's `_meta.usage`, cached reads apart), so no `usageApprox` is flagged.
 */
export type AcpMetaUsage = Usage & { approx?: string | false }

export interface AcpUsageSpec {
  /** PromptResponse.usage.inputTokens includes cachedReadTokens (subtracted so `input` is uncached; G05). */
  inputIncludesCached: boolean
  /** PromptResponse.usage is the session's running total (else it is this prompt's). */
  cumulative: boolean
  /**
   * The vendor's own token totals in a PromptResponse that carries no `usage` (Gemini 0.62 and 0.63 send only
   * `_meta.quota.token_count`). `input` includes the cached reads (no split is reported), so the pass's
   * usage is flagged approximate unless the vendor says otherwise (`approx: false`, Grok). undefined: the answer
   * has none.
   */
  metaUsage?: ((result: unknown) => AcpMetaUsage | undefined) | undefined
}

/**
 * What a shell (`execute`) permission request runs and where, read the vendor's way (AcpVendorConfig.shellRequest).
 * The allow cache keys "Allow for this run" on it, so only what is read with certainty counts.
 */
export interface AcpShellRequest {
  /** The command line, when the request names it with certainty; undefined: the request is asked, never cached. */
  command?: string | undefined
  /**
   * The folder it runs in, as the vendor names it (absolute, or relative to the session's folder); `''` for the
   * session's own folder; undefined when Dim Factory cannot tell for certain (asked, never cached).
   */
  dir?: string | undefined
  /** A line the ask shows under the command (Gemini's explanation: the folder and the model's description). */
  note?: string | undefined
}

/** One setting that lets the agent act unasked (AcpVendorConfig.readonlyAllowRules). */
export interface AcpAllowRule {
  /** The settings file that holds it. */
  file: string
  /** The rule as written, or the setting's name. */
  rule: string
}

export interface AcpTiming {
  /** initialize must answer within this, else the CLI drifted (flag_drift). */
  initializeMs: number
  /** session/new, session/load, session/resume, session/set_mode (no model call). */
  requestMs: number
  /** After a session/load: updates are dropped until this long passes without one ... */
  loadQuietMs: number
  /** ... or this long after the load answered, whichever comes first. */
  loadQuietCapMs: number
  /** Stop: pending permissions cancelled and session/cancel sent, then this long for the prompt to answer. */
  stopTurnMs: number
  stopStdinMs: number
  /** After the terminal event stdin is closed; the process is killed if it lingers. */
  exitAfterTerminalMs: number
  /** onSession (the engine's run.json write) must answer within this before session/prompt. */
  sessionPersistMs: number
  /** A plan was captured and session/cancel sent: the prompt must answer within this, else the pass ends anyway. */
  planCancelMs: number
}

export interface AcpVendorConfig {
  id: VendorId
  displayName: string
  /** How resolve-cli finds and validates the binary (an npm shim runs as system `node <entry>`). */
  cliSpec: CliSpec
  versionFloor: string
  versionRecommended: string
  testedUpTo: string
  /** Flags the base's launch owns: extraArgs may not repeat them, flagMap may only rename them. */
  managedFlags: readonly string[]
  /** Flags that widen what a pass may do: never in extraArgs, never a flagMap target. */
  forbiddenFlags: readonly string[]
  /** Every flag the CLI defines (a flagMap target may not be one). */
  cliFlags?: readonly string[]
  /** argv and env for one process (`--acp [-m model] [trustFlag] [extraArgs…]` for Gemini). */
  resolveLaunch(o: AcpLaunchInput): AcpLaunch
  modes: Readonly<Record<Mode, AcpModeSpec>>
  /**
   * How much runs without asking in each of the vendor's modes (higher = more). A `current_mode_update` to a mode
   * ranked above the pass's own stops the pass (never a silent widening). A mode not listed counts as the highest.
   */
  modeRank?: Readonly<Record<string, number>>
  planMode: PlanMode
  /** The native plan mode's id (`plan`) and the copy of a native Plan pass. */
  plan?: { acpMode: string; copy: string }
  /**
   * The permission decision table: allow-session takes the first of these offered; `forbidden` is never chosen; nor is
   * an option whose name matches `forbiddenName` (Grok: one that turns on always-approve or auto mode for the session).
   */
  optionPrefs: { allowSession: readonly string[]; forbidden: readonly string[]; forbiddenName?: RegExp }
  /** Exit code → failure category (the ACP exit-code rows); the classifier's vendor table is built from it. */
  exitCodes: Readonly<Record<number, FailureCategory>>
  /**
   * The vendor's own failure texts (its sign-in, rate-limit and model errors), checked before the ACP rows in the
   * classifier's table for this vendor. Absent: the ACP rows and the exit codes only.
   */
  signalRegex?: readonly RegexRule[]
  /** The flag that skips the vendor's own folder trust prompt (Gemini `--skip-trust`), only with a grant. */
  trustFlag?: string
  /**
   * How an `execute` permission request names its command and folder when its rawInput does not (Gemini: the title is
   * the command, the text content its explanation `[in <dir>] (<description>)`). Absent: rawInput's
   * `command` and folder keys.
   */
  shellRequest?: ((toolCall: Rec) => AcpShellRequest) | undefined
  /**
   * A plan exit the vendor names only in its title (Gemini's exit_plan_mode: kind `other`, title `Requesting plan
   * approval for: <plan file>`). Group 1 is the plan file, read only inside `planFileRoots`.
   */
  planExitTitle?: RegExp
  /**
   * An agent_message_chunk whose whole text reports a mode change instead of `current_mode_update` (Gemini sends
   * `[MODE_UPDATE] <mode>`). Group 1 is the mode id. Never printed; a widening stops the pass.
   */
  modeUpdateText?: RegExp
  usage: AcpUsageSpec
  /** Reported reasoning tokens are part of `output` (Gemini: no, thoughts are counted apart). */
  reasoningIncludedInOutput: boolean
  probe: AcpProbeSpec
  /**
   * A token-free look for a session the vendor could load (Gemini: its chats folder), or undefined when it cannot
   * tell. false: canResume answers `cannot-resume` without spawning.
   */
  sessionExists?(o: { sessionId: string; cwd: string; env: EnvInput; home: string }): boolean | undefined
  /**
   * Grok: the user's own settings the agent applies before it asks (its allow rules, and for Grok the user's
   * Claude settings too), each of which would let a read-only pass change files or run a command unasked. Rejecting
   * every ask cannot stop them, so while any is found readiness `<id>` fails a read-only pass and start() refuses it
   * before spawning. Absent: the vendor asks for everything a read-only pass could change (Gemini).
   */
  readonlyAllowRules?: {
    /** The readiness check id (`pass.<p>.readiness.<id>`). */
    id: string
    scan(o: { cwd: string; env: EnvInput; home: string }): readonly AcpAllowRule[]
  }
  /** Static models when the agent names none (Gemini's `-m` aliases). */
  staticModels?: readonly { id: string; label?: string; isDefault?: boolean }[]
  /** Folders whose plan files may be read for a plan exit's text (Gemini `~/.gemini/tmp`); absent: none. */
  planFileRoots?(o: { env: EnvInput; home: string }): string[]
  timing?: Partial<AcpTiming>
}
