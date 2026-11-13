// Vendor/adapter contracts shared with the renderer. The Adapter interface,
// StartOptions and RunHandle live in src/core/adapters/types.ts; this file holds their serializable parts.
import type { CheckResult } from './preflight.ts'
import type { ExtensionLevel } from './extensions.ts'
import type { Mode, PassName, PlanMode } from './run.ts'

/** Vendors with an adapter or a registry stub in this build. Ids stay open strings (`local-<preset>`, user additions). */
export const KNOWN_VENDORS = ['claude', 'codex', 'gemini', 'grok', 'muse'] as const
export type KnownVendor = (typeof KNOWN_VENDORS)[number]
export type VendorId = string

export const VENDOR_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/** `vendor: "local-<presetId>"` selects the Codex adapter with `local.presets[presetId]`. */
export const LOCAL_VENDOR_PREFIX = 'local-'

export function isKnownVendor(v: string): v is KnownVendor {
  return (KNOWN_VENDORS as readonly string[]).includes(v)
}

/**
 * Readiness `trust` (trust.json `vendorFolder`): vendors that run in a user folder only after the user
 * trusted that folder for them (Gemini launches with `--skip-trust` only then). A Dim Factory-owned working folder
 * (probe, heal, catalog) needs no grant. Muse (`--trust-workspace` only with the grant; never without one, since
 * its full mode `--yolo` would trust the folder by itself).
 */
export const FOLDER_TRUST_VENDORS = ['gemini', 'muse'] as const satisfies readonly KnownVendor[]

/** Whether `vendor` needs a trust.json `vendorFolder` grant for a user folder (a `local-<preset>` is Codex: no). */
export function needsFolderTrust(vendor: VendorId): boolean {
  return (FOLDER_TRUST_VENDORS as readonly string[]).includes(vendor)
}

/**
 * Self-heal execution (the Claude and Codex rows): the vendors the healer runs on. A `selfHeal.vendor`
 * outside this list falls back to the first ready one, like a vendor that is not ready.
 */
export const HEAL_VENDORS = ['claude', 'codex'] as const satisfies readonly KnownVendor[]

/**
 * Live balanced run: vendors whose pass with no model of its own may run a model other than the account's default
 * (Codex: the model its own configuration names for the folder, which the account may not be offered). Only these offer
 * "Use <the account's default>" when such a pass fails `model_unavailable`. Not Gemini: its default is the session's
 * current model, which is what such a pass ran. Not a `local-<preset>`: it always runs its preset's model.
 */
export const ACCOUNT_DEFAULT_VENDORS = ['codex'] as const satisfies readonly KnownVendor[]

/** Whether `vendor`'s pass with no model may run a model other than the account's default (ACCOUNT_DEFAULT_VENDORS). */
export function accountDefaultMayDiffer(vendor: VendorId | undefined): boolean {
  return vendor !== undefined && (ACCOUNT_DEFAULT_VENDORS as readonly string[]).includes(vendor)
}

/**
 * Live balanced run: the routes on which a pass with no model says which model it runs before its turn (Codex's
 * app-server: the adapter's META_MODEL_USED, sent before turn/start; Claude's `stdio`,
 * whose init names the session's model before any output of the turn). Until it has said, such a pass still names the
 * model core expects (StepView.expectedModel); on any other route (Codex exec, Gemini's ACP) nothing is said, so a pass
 * that has started names none.
 */
export const MODEL_REPORT_ROUTES = ['app-server', 'stdio'] as const satisfies readonly Route[]

/** Whether a pass on `route` says which model it runs before its turn (MODEL_REPORT_ROUTES). */
export function reportsModelBeforeTurn(route: string | undefined): boolean {
  return route !== undefined && (MODEL_REPORT_ROUTES as readonly string[]).includes(route)
}

/**
 * Whether `text` names `model` as a whole id: not inside a longer one ("gpt-5.6-sol" is not named by
 * "gpt-5.6-sol-pro"), so a vendor's refusal is read for the model it is about.
 */
export function namesModel(text: string, model: string): boolean {
  const id = model.trim()
  if (id === '') return false
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`).test(text)
}

/**
 * Live balanced run: the vendor did not run the account's default Dim Factory sent in place of its own settings'
 * model. The step's model used is that default (`modelUsed`, with `modelReplaced` the model the vendor's settings
 * chose), and the pass failed `model_unavailable` with words that name the replaced model and not the default: the
 * vendor ran its own choice, and the account refused it. The card then names the replaced model as the one that ran,
 * and the snag offers the default on the pass (sent on thread/start).
 */
export function modelOverrideIgnored(o: {
  modelUsed?: string | undefined
  modelReplaced?: string | undefined
  failure?: { category: string; message: string; raw?: string | undefined } | undefined
}): boolean {
  const { modelUsed, modelReplaced, failure } = o
  if (modelUsed === undefined || modelReplaced === undefined || failure === undefined) return false
  if (failure.category !== 'model_unavailable') return false
  const words = `${failure.message}\n${failure.raw ?? ''}`
  return namesModel(words, modelReplaced) && !namesModel(words, modelUsed)
}

/** A reasoning effort level as the vendor CLIs take it (`low`, `high`, `xhigh`, `max`): lower-case letters only. */
export const EFFORT_PATTERN = /^[a-z]{1,20}$/

/** Whether `v` is an effort level a vendor argument may carry (EFFORT_PATTERN). */
export function isEffortLevel(v: unknown): v is string {
  return typeof v === 'string' && EFFORT_PATTERN.test(v)
}

/**
 * Why a launch may not send `effort` (anything but null/absent or a plain level: `high --x` would smuggle an argument
 * in), or undefined when it may.
 */
export function effortProblem(effort: string | null | undefined): string | undefined {
  if (effort === undefined || effort === null || isEffortLevel(effort)) return undefined
  return `"${String(effort).slice(0, 40)}" is not an effort level (lower-case letters only, such as high)`
}

/**
 * Vendors whose adapter sends a pass's effort (Claude `--effort`; Codex turn/start `effort` and exec
 * `model_reasoning_effort`). The others have no effort setting: their pass rows offer none and a configured effort is
 * left out of their launch (preflight warns). A `local-<preset>` runs on Codex against a local server, which takes none.
 */
export const EFFORT_VENDORS = ['claude', 'codex'] as const satisfies readonly KnownVendor[]

/**
 * Codex `-c` keys that carry the reasoning effort. Effort is a managed setting (the pass's Effort, or the vendor's
 * default effort), so `vendors.codex.extraArgs` may not set it: a root override would silently win over the pass.
 */
export const CODEX_EFFORT_CONFIG_KEYS = ['model_reasoning_effort', 'plan_mode_reasoning_effort'] as const

/** What to say when Codex extraArgs set the effort through `-c`. */
export const codexEffortKeyMessage = (key: string): string =>
  `extraArgs may not set ${key}; effort is managed by Dim Factory. Choose it with the pass's Effort or Settings, Vendors, Codex default effort`

/**
 * The effort key a Codex `-c key=value` override sets, or undefined. The key is read as Codex reads a dotted key, the
 * first segment, case-insensitively, so `Model_Reasoning_Effort=high` is caught too.
 */
export function codexEffortConfigKey(kv: string): string | undefined {
  const eq = kv.indexOf('=')
  const key = (eq < 0 ? kv : kv.slice(0, eq)).trim()
  const head = (key.split('.')[0] ?? '').toLowerCase()
  return (CODEX_EFFORT_CONFIG_KEYS as readonly string[]).includes(head) ? key : undefined
}

/**
 * Every `-c key=value` / `--config key=value` / `--config=key=value` pair in Codex extraArgs that sets the effort, with
 * the index of the entry that names the key (the value entry for the two-entry forms).
 */
export function codexEffortOverrides(extraArgs: readonly string[]): { index: number; key: string }[] {
  const out: { index: number; key: string }[] = []
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i]!
    let kv: string | undefined
    let at = i
    if (a === '-c' || a === '--config') {
      kv = extraArgs[i + 1]
      at = i + 1
      i++
    } else if (a.startsWith('--config=')) kv = a.slice('--config='.length)
    else if (a.startsWith('-c') && a.length > 2 && a.includes('=')) kv = a.slice(2)
    if (kv === undefined) continue
    const key = codexEffortConfigKey(kv)
    if (key !== undefined) out.push({ index: at, key })
  }
  return out
}

/** Whether `vendor` takes an effort level (EFFORT_VENDORS). */
export function supportsEffort(vendor: VendorId | undefined): boolean {
  return vendor !== undefined && (EFFORT_VENDORS as readonly string[]).includes(vendor)
}

/** The model entry `model` names (by id or alias), or the list's default for a null model. */
function modelEntry(
  models: readonly Pick<ModelInfo, 'id' | 'aliases' | 'isDefault' | 'efforts'>[],
  model: string | null,
): Pick<ModelInfo, 'id' | 'aliases' | 'isDefault' | 'efforts'> | undefined {
  if (model === null) return models.find((m) => m.isDefault === true)
  return models.find((m) => m.id === model || m.aliases?.includes(model) === true)
}

/**
 * The effort levels `model` lists, or undefined when the list does not say (the model is not in it, or names no
 * levels). A null model is the list's default.
 */
export function modelEfforts(
  models: readonly Pick<ModelInfo, 'id' | 'aliases' | 'isDefault' | 'efforts'>[],
  model: string | null,
): string[] | undefined {
  const efforts = modelEntry(models, model)?.efforts
  return efforts !== undefined && efforts.length > 0 ? [...efforts] : undefined
}

/**
 * The effort levels a picker offers for `model`: the ones it lists, else (a model the list does not describe) every
 * level any listed model takes, in first-seen order.
 */
export function effortsFor(
  models: readonly Pick<ModelInfo, 'id' | 'aliases' | 'isDefault' | 'efforts'>[],
  model: string | null,
): string[] {
  const own = modelEfforts(models, model)
  if (own !== undefined) return own
  return [...new Set(models.flatMap((m) => m.efforts ?? []))]
}

/** Preset id for a `local-<id>` vendor, else null. */
export function localPresetIdOf(vendor: string): string | null {
  return vendor.startsWith(LOCAL_VENDOR_PREFIX) && vendor.length > LOCAL_VENDOR_PREFIX.length
    ? vendor.slice(LOCAL_VENDOR_PREFIX.length)
    : null
}

export const TRANSPORTS = ['claude-stdio', 'codex-app-server', 'codex-exec', 'acp', 'muse-exec'] as const
export type Transport = (typeof TRANSPORTS)[number]

/** Route family, also the `<route>` segment of `tests/fixtures/<vendor>/<route>/`. */
export const ROUTES = ['stdio', 'app-server', 'exec', 'acp'] as const
export type Route = (typeof ROUTES)[number]

export const TRANSPORT_ROUTE = {
  'claude-stdio': 'stdio',
  'codex-app-server': 'app-server',
  'codex-exec': 'exec',
  acp: 'acp',
  'muse-exec': 'exec',
} as const satisfies Record<Transport, Route>

export const SUPPORT_STATUSES = ['supported', 'degraded', 'unsupported'] as const
export type SupportStatus = (typeof SUPPORT_STATUSES)[number]

/** The ONLY source of mode copy in the UI. */
export type Support = { status: SupportStatus; copy: string; reason?: string }

export type ResumeKind = 'id' | 'load' | 'none'

export interface Capabilities {
  planMode: PlanMode
  askRelay: boolean
  resume: ResumeKind
  preassignSessionId: boolean
  modelList: 'cli' | 'static'
  usageCumulative: boolean
  allowSession: 'native' | 'app'
  web: boolean
  resumeModelSwitch: boolean
  /**
   * A resumed session can run in another permission mode than it started in (Plan read-only, then Implement editing:
   * continuity). Claude takes its mode per launch, Codex its sandbox per thread and turn. Absent: unknown.
   */
  resumeModeSwitch?: boolean
  reasoningIncludedInOutput: boolean
  /** The route sends a pass's effort level (EFFORT_VENDORS). Absent: no effort setting. */
  effort?: boolean
  modes: Record<Mode, Support>
}

/** Where a binary candidate came from, in resolver order. */
export const BINARY_SOURCES = ['config', 'known', 'path', 'npm-prefix', 'desktop-bundle'] as const
export type BinarySource = (typeof BINARY_SOURCES)[number]

/** `node-entry`: a `.cmd` shim's JS entry, spawned as system `node <entry>` (never Electron's execPath). */
export type BinaryKind = 'native' | 'node-entry' | 'shebang'

export interface ResolvedBinary {
  /** The candidate that was found (configured path, PATH hit, shim, …). */
  path: string
  /** The executable actually spawned (the native exe, or system node for a node-entry). */
  command: string
  /** Arguments placed before the adapter's argv, e.g. `[<entry.js>]` for node-entry. */
  argvPrefix: string[]
  kind: BinaryKind
  source: BinarySource
  version?: string
  mtimeMs: number
  size: number
  /** Directories prepended to the child's PATH (e.g. Codex `codex-path`). */
  pathPrepend: string[]
  warnings: string[]
}

export type ModelInfoSource = 'cli' | 'static' | 'local-server' | 'catalog'

export interface ModelInfo {
  id: string
  label?: string
  aliases?: string[]
  isDefault?: boolean
  efforts?: string[]
  contextWindow?: number
  source: ModelInfoSource
}

/** Model picker row: CLI list + catalog + free text. */
export interface ModelOption extends ModelInfo {
  hasPricing: boolean
  deprecated?: boolean
}

/** Never email, organization or uuid. */
export interface ProbeAccount {
  method: string
  plan?: string
}

export interface ProbeResult {
  vendor: VendorId
  at: number
  ok: boolean
  route?: Route
  transport?: Transport
  binary?: ResolvedBinary
  version?: string
  checks: CheckResult[]
  /** Effective capabilities for the selected route (adapter defaults when nothing resolved). */
  capabilities: Capabilities
  models: ModelInfo[]
  account?: ProbeAccount
}

/** Local OpenAI-compatible server reached through Codex `dim_factory_local` (Responses API). */
export interface LocalPreset {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKeyEnv?: string
  contextWindow?: number
}

export type ReadinessPurpose = PassName | 'heal' | 'catalog'

export interface ReadinessNeed {
  pass: ReadinessPurpose
  mode: Mode
  planNative: boolean
  resumeSessionId?: string
  web?: boolean
  local?: LocalPreset
  trustFolder: boolean
  /**
   * The folder the pass runs in, when the caller knows it (the composer's folder, a run's work folder for a pass that
   * has not started). An adapter whose copy depends on that folder's settings reads them (Claude: shell allow-rules turn
   * Bash and PowerShell off for a read-only pass). Absent: the copy does not depend on a folder.
   */
  cwd?: string
  /**
   * The argv a run's pass was launched with (StepState.argv), once it has started: copy that depends on how it was
   * launched is read from it, never from the folder's settings as they are now (Claude: Bash and PowerShell in its
   * `--disallowedTools`). Takes precedence over `cwd`.
   */
  argv?: readonly string[]
  /**
   * The pass's Extensions level (shared/extensions.ts), for copy that depends on it (Codex: whether the user's MCP
   * servers are off). Absent: the step's own default (none for read-only steps).
   */
  extensions?: ExtensionLevel
}

export const VENDOR_HEALTH_STATES = [
  'checking',
  'ready',
  'warning',
  'login-needed',
  'update-needed',
  'sandbox-needed',
  'not-installed',
  'not-built',
  'error',
] as const
export type VendorHealth = (typeof VENDOR_HEALTH_STATES)[number]

/** One vendor as the renderer sees it (Settings → Vendors, health strip, setup card). */
export interface ProbeView {
  vendor: VendorId
  displayName: string
  /** False for registry stubs of vendors not in this build. */
  built: boolean
  experimental: boolean
  health: VendorHealth
  /** One-line state copy, e.g. "Login needed". */
  healthDetail: string
  checking: boolean
  versionFloor: string | null
  versionRecommended: string | null
  testedUpTo: string | null
  /** Last completed probe; null until the first one finishes. */
  probe: ProbeResult | null
  /** Executable candidates found by the resolver (path picker). */
  candidates: string[]
}
