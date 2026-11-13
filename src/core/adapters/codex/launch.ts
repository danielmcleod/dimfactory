// Codex argv, env and the extraArgs / flagMap rules (app-server and exec fallback; extraArgs are root `-c` only).
// Prompts never go in argv: JSON-RPC turn/start, or exec's stdin.
import type { LocalPreset } from '../../../shared/vendors.ts'
import { codexEffortConfigKey, codexEffortKeyMessage, isEffortLevel } from '../../../shared/vendors.ts'
import type { ExtensionLevel } from '../../../shared/extensions.ts'
import type { ToolPolicy } from '../../../shared/guardrails.ts'
import type { EnvInput } from '../../proc/env.ts'
import { sanitizeEnv } from '../../proc/env.ts'
import type { StartStep } from '../types.ts'
import {
  CLI_FLAGS,
  FORBIDDEN_CONFIG_KEYS,
  FORBIDDEN_FLAGS,
  LOCAL_PROVIDER_FORM,
  LOCAL_PROVIDER_ID,
  MANAGED_FLAGS,
} from './capabilities.ts'
import { isSafeServerName } from './mcp-isolation.ts'
import type { SandboxMode } from './wire.ts'

// ---- extraArgs / flagMap ----------------------------------------------------------------------------------------

const flagName = (arg: string): string =>
  arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
/** Spelling-insensitive identity of a flag (`--skip-git-repo-check` ≡ `--skip_git_repo_check`). */
const flagKey = (arg: string): string => flagName(arg).replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')
const MANAGED_KEYS = new Set(MANAGED_FLAGS.map(flagKey))
const FORBIDDEN_KEYS = new Set(FORBIDDEN_FLAGS.map(flagKey))
const CLI_FLAG_KEYS = new Set(CLI_FLAGS.map(flagKey))
const isManaged = (arg: string): boolean => (MANAGED_FLAGS as readonly string[]).includes(flagName(arg))

const CONFIG_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/

/** A `-c key=value` override extraArgs may carry: a plain dotted key that leaves the sandbox and approvals alone. */
export function configOverrideProblem(kv: string): string | undefined {
  const eq = kv.indexOf('=')
  if (eq <= 0) return `"${kv.slice(0, 40)}" is not key=value`
  const key = kv.slice(0, eq).trim()
  if (!CONFIG_KEY.test(key)) return `"${key.slice(0, 40)}" is not a plain dotted config key`
  const head = (key.split('.')[0] ?? '').toLowerCase()
  if (codexEffortConfigKey(kv) !== undefined) return codexEffortKeyMessage(key)
  if ((FORBIDDEN_CONFIG_KEYS as readonly string[]).includes(head)) {
    return `extraArgs may not set ${key}; Dim Factory sets the sandbox, approvals, provider and tools per pass`
  }
  return undefined
}

/**
 * Codex extraArgs are root `-c` overrides only: `-c key=value` / `--config key=value` / `--config=key=value`
 * pairs, never a flag, and never a key that changes the sandbox, approvals, provider or tools.
 */
export function extraArgsProblem(extraArgs: readonly string[] | undefined): string | undefined {
  const list = extraArgs ?? []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (/[\r\n\0]/.test(a)) return `extraArgs entry ${JSON.stringify(a.slice(0, 40))} contains a newline`
    let kv: string | undefined
    if (a === '-c' || a === '--config') {
      kv = list[++i]
      if (kv === undefined) return `extraArgs ends with ${a} and no key=value`
      if (/[\r\n\0]/.test(kv)) return `extraArgs entry ${JSON.stringify(kv.slice(0, 40))} contains a newline`
    } else if (a.startsWith('--config=')) kv = a.slice('--config='.length)
    else if (a.startsWith('-')) {
      const name = flagName(a)
      if (MANAGED_KEYS.has(flagKey(a))) return `extraArgs may not set ${name}; Dim Factory manages it`
      if (FORBIDDEN_KEYS.has(flagKey(a)) || /^dangerously/.test(flagKey(a)))
        return `extraArgs may not set ${name}; it widens what a pass may do`
      return `extraArgs for Codex are -c key=value overrides only (got ${name})`
    } else
      return `extraArgs for Codex are -c key=value overrides only (got ${JSON.stringify(a.slice(0, 40))})`
    const problem = configOverrideProblem(kv)
    if (problem !== undefined) return problem
  }
  return undefined
}

const LONG_FLAG = /^--[A-Za-z][\w-]*$/

/** flagMap may rename a managed flag only to a long flag the CLI does not already define. */
export function flagMapProblem(flagMap: Readonly<Record<string, string>> | undefined): string | undefined {
  const targets = new Set<string>()
  for (const [from, to] of Object.entries(flagMap ?? {})) {
    if (!isManaged(from)) return `flagMap key ${from} is not a flag Dim Factory manages`
    if (!LONG_FLAG.test(to)) return `flagMap value ${JSON.stringify(to)} is not a long flag name (--name)`
    const key = flagKey(to)
    if (FORBIDDEN_KEYS.has(key) || /^dangerously/.test(key))
      return `flagMap may not rename ${from} to ${to}; that flag widens what a pass may do`
    if (key !== flagKey(from) && MANAGED_KEYS.has(key))
      return `flagMap may not rename ${from} to ${to}; Dim Factory manages ${to} itself`
    if (key !== flagKey(from) && CLI_FLAG_KEYS.has(key))
      return `flagMap may not rename ${from} to ${to}; Codex already uses ${to} for something else`
    if (targets.has(key)) return `flagMap renames two flags to ${to}`
    targets.add(key)
  }
  return undefined
}

export function applyFlagMap(
  argv: readonly string[],
  flagMap: Readonly<Record<string, string>> | undefined,
): string[] {
  if (flagMap === undefined || Object.keys(flagMap).length === 0) return [...argv]
  return argv.map((arg) => {
    const name = flagName(arg)
    const to = flagMap[name]
    if (to === undefined || !isManaged(name)) return arg
    return name === arg ? to : `${to}${arg.slice(name.length)}`
  })
}

// ---- passes -----------------------------------------------------------------------------------------------------

/** Steps that run read-only and ephemeral (read-only passes = read-only sandbox, approvals never, ephemeral). */
export const READ_ONLY_STEPS: readonly StartStep[] = [
  'plan',
  'review',
  'critic',
  'heal',
  'catalog',
  'research',
]

/**
 * The `web_search` setting a step sends: the catalog refresh searches live (X17); Research searches live when the run
 * may use the web and has web search off otherwise (the repository lens only); other steps leave the user's setting.
 */
export function webSearchFor(step: StartStep, web: boolean | undefined): 'live' | 'disabled' | undefined {
  if (step === 'catalog') return 'live'
  if (step === 'research') return web === true ? 'live' : 'disabled'
  return undefined
}

export const isReadOnlyStep = (step: StartStep): boolean => READ_ONLY_STEPS.includes(step)

/**
 * The No network guardrail's settings, as `-c` spells them: the workspace-write sandbox's network off (the read-only
 * sandbox has none to begin with) and web search off, since Codex's search runs on OpenAI's side, not in the sandbox.
 * thread/start's answer says whether the sandbox really runs without network (appserver.ts networkProblem).
 */
export function noNetworkConfig(): Record<string, boolean | string> {
  return { 'sandbox_workspace_write.network_access': false, web_search: 'disabled' }
}

/** The pass keeps the No network guardrail. */
export const noNetworkOf = (o: { guardrails?: ToolPolicy | undefined }): boolean =>
  o.guardrails?.rules.some((r) => r.kind === 'network') === true

/** The mode table: sandbox + approval policy per pass. Full mode comes only from Auto (the engine's rule). */
export function sandboxFor(
  step: StartStep,
  mode: 'readonly' | 'autoedit' | 'full',
): {
  sandbox: SandboxMode
  approvalPolicy: 'never' | 'on-request'
} {
  if (isReadOnlyStep(step) || mode === 'readonly') return { sandbox: 'read-only', approvalPolicy: 'never' }
  if (mode === 'full') return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
}

/**
 * The effort level a pass sends (exec `model_reasoning_effort`, app-server turn/start `effort`): a plain level only,
 * and none for a local preset, whose server takes no effort setting.
 */
export function effortFor(i: {
  effort?: string | null | undefined
  local?: LocalPreset | undefined
}): string | undefined {
  return i.local === undefined && isEffortLevel(i.effort) ? i.effort : undefined
}

/**
 * Ephemeral threads cannot be resumed: only read-only steps, never Implement or Fix, and never a Plan that keeps its
 * thread for Implement (continuity: its sandbox stays read-only; Implement's turn runs in its own).
 */
export const ephemeralFor = (step: StartStep, keepSession?: boolean): boolean =>
  isReadOnlyStep(step) && !(keepSession === true && step === 'plan')

/**
 * `mcp_servers.<name>.enabled` keys that switch the user's MCP servers off, and only names that are one safe bare key
 * segment, so no name can address another config key. `level` is the pass's Extensions level: at `passthrough` nothing
 * is switched off, at `none` and `allowed` every name given is (the caller leaves the allowed ones out of `names`).
 * Without a level, the step decides as it always has: read-only steps switch them off, Implement and Fix keep them.
 */
export function mcpOffKeys(
  step: StartStep,
  names: readonly string[] | undefined,
  level?: ExtensionLevel,
): string[] {
  if (names === undefined) return []
  if (level === undefined ? !isReadOnlyStep(step) : level === 'passthrough') return []
  return [...new Set(names)].filter(isSafeServerName).map((n) => `mcp_servers.${n}.enabled`)
}

/**
 * The feature switches a pass sends: the ones the run handle worked out (the Allowed list may keep the apps on), else
 * the level's own (no level: the step decides, read-only steps at None).
 */
export function featuresFor(i: {
  step: StartStep
  extensions?: ExtensionLevel | undefined
  featuresOff?: readonly string[] | undefined
}): readonly string[] {
  return i.featuresOff ?? featuresOffKeys(i.extensions ?? (isReadOnlyStep(i.step) ? 'none' : 'passthrough'))
}

/** Codex's built-in MCP server for the apps (connectors) linked to the account: it is not in config.toml. */
export const CODEX_APPS = 'codex_apps'

/**
 * The feature switches a pass below Pass through turns off (`features.<name>=false`; the names and their effect checked
 * with `codex features list -c ...` on codex-cli 0.160.1): `apps` (the account's apps, served by {@link CODEX_APPS}),
 * `plugins` (with the MCP servers and skills they bring) and `hooks`. At Allowed list the apps stay on only when the
 * user allowed {@link CODEX_APPS}. Read-only passes run with approvals never, so nothing they load can ask first: without
 * these they would not be hermetic.
 */
export function featuresOffKeys(level: ExtensionLevel, allowedMcp: readonly string[] = []): string[] {
  if (level === 'passthrough') return []
  // At None nothing is allowed, whatever the list holds.
  if (level === 'none') return ['features.apps', 'features.plugins', 'features.hooks']
  const apps = level === 'allowed' && allowedMcp.includes(CODEX_APPS) ? [] : ['features.apps']
  return [...apps, 'features.plugins', 'features.hooks']
}

// ---- local preset ------------------------------------------------------------------------------------------------

export interface ProviderTable {
  name: string
  base_url: string
  wire_api: 'responses'
  env_key?: string
}

export function providerTable(p: LocalPreset): ProviderTable {
  return {
    name: p.label,
    base_url: p.baseUrl,
    wire_api: 'responses',
    ...(p.apiKeyEnv !== undefined ? { env_key: p.apiKeyEnv } : {}),
  }
}

/** thread/start `config` entries for the preset (X13 decides inline table vs dotted keys). */
export function localProviderConfig(p: LocalPreset): Record<string, string | ProviderTable> {
  const t = providerTable(p)
  if (LOCAL_PROVIDER_FORM === 'inline') return { [`model_providers.${LOCAL_PROVIDER_ID}`]: t }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t) as [string, string][])
    out[`model_providers.${LOCAL_PROVIDER_ID}.${k}`] = v
  return out
}

/** A TOML basic string (JSON's escapes are valid TOML; no raw newline ever reaches argv). */
export const tomlString = (s: string): string => JSON.stringify(s)

function tomlInline(t: object): string {
  return `{${Object.entries(t)
    .map(([k, v]) => `${k}=${tomlString(String(v))}`)
    .join(',')}}`
}

/** exec: the same provider as `-c` overrides (never `--oss` / `--local-provider`). */
export function localProviderArgs(p: LocalPreset): string[] {
  const t = providerTable(p)
  const def =
    LOCAL_PROVIDER_FORM === 'inline'
      ? ['-c', `model_providers.${LOCAL_PROVIDER_ID}=${tomlInline(t)}`]
      : Object.entries(t).flatMap(([k, v]) => [
          '-c',
          `model_providers.${LOCAL_PROVIDER_ID}.${k}=${tomlString(String(v))}`,
        ])
  return [...def, '-c', `model_provider=${tomlString(LOCAL_PROVIDER_ID)}`]
}

// ---- argv -------------------------------------------------------------------------------------------------------

/** One private app-server per pass, never the shared daemon. Root `-c` extraArgs come first. */
export function appServerArgv(o: {
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
}): string[] {
  return applyFlagMap([...(o.extraArgs ?? []), 'app-server', '--listen', 'stdio://'], o.flagMap)
}

export interface ExecArgvInput {
  step: StartStep
  mode: 'readonly' | 'autoedit' | 'full'
  cwd: string
  model?: string | null | undefined
  /**
   * `-c model_reasoning_effort="<level>"`; null/absent: the model's default. Anything but a plain level is never passed,
   * nor is any effort for a local preset (its server takes none).
   */
  effort?: string | null | undefined
  /** `-o` target (the final message; written only when the turn completes). */
  outFile: string
  /** `--output-schema` file (X17 catalog). */
  schemaFile?: string | undefined
  /** `resume <UUID>` (Fix reuse, P19 resume). */
  resumeId?: string | undefined
  local?: LocalPreset | undefined
  extraArgs?: readonly string[] | undefined
  flagMap?: Readonly<Record<string, string>> | undefined
  /** The user's MCP servers to switch off (`-c mcp_servers.<name>.enabled=false`); see mcpOffKeys. */
  mcpOff?: readonly string[] | undefined
  /** The pass's Extensions level (absent: the step decides, as before Extensions existed). */
  extensions?: ExtensionLevel | undefined
  /** Feature switches to turn off (`-c features.<name>=false`); absent: the level's (see featuresOffKeys). */
  featuresOff?: readonly string[] | undefined
  /** Research: it may search the web (webSearchFor). */
  web?: boolean | undefined
  /** Plan only (continuity): no `--ephemeral`, so Implement can resume the thread. */
  keepSession?: boolean | undefined
  /** The No network guardrail (noNetworkConfig); exec cannot confirm it took effect, as thread/start can. */
  noNetwork?: boolean | undefined
}

/**
 * Exec fallback:
 * `codex exec --json --color never --skip-git-repo-check --sandbox <m> --cd <cwd> -c approvals_reviewer="user" [-m]
 * -o <out> [resume <UUID>] -`. Every flag goes before `resume`; the prompt is stdin (`-`). Never `--full-auto`,
 * `--approve-for-me`, `--oss` or `--local-provider`, and never `--ephemeral` on Implement or Fix.
 */
export function execArgv(i: ExecArgvInput): string[] {
  const { sandbox } = sandboxFor(i.step, i.mode)
  // The pass's own model first, else the local preset's (params.ts modelOf).
  const model = i.model !== undefined && i.model !== null && i.model.trim() !== '' ? i.model : i.local?.model
  const a = [
    ...(i.extraArgs ?? []),
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--sandbox',
    sandbox,
    '--cd',
    i.cwd,
    '-c',
    `approvals_reviewer=${tomlString('user')}`,
  ]
  if (model !== undefined) a.push('-m', model)
  const effort = effortFor(i)
  if (effort !== undefined) a.push('-c', `model_reasoning_effort=${tomlString(effort)}`)
  if (i.local !== undefined) a.push(...localProviderArgs(i.local))
  // X17: the catalog refresh searches the web (Codex cannot limit hosts; the answer's sources are validated after).
  const web = i.noNetwork === true ? undefined : webSearchFor(i.step, i.web)
  if (web !== undefined) a.push('-c', `web_search=${tomlString(web)}`)
  if (i.noNetwork === true) {
    for (const [k, v] of Object.entries(noNetworkConfig()))
      a.push('-c', `${k}=${typeof v === 'string' ? tomlString(v) : String(v)}`)
  }
  for (const key of mcpOffKeys(i.step, i.mcpOff, i.extensions)) a.push('-c', `${key}=false`)
  for (const key of featuresFor(i)) a.push('-c', `${key}=false`)
  if (i.schemaFile !== undefined) a.push('--output-schema', i.schemaFile)
  if (ephemeralFor(i.step, i.keepSession) && i.resumeId === undefined) a.push('--ephemeral')
  a.push('-o', i.outFile)
  if (i.resumeId !== undefined) a.push('resume', i.resumeId)
  a.push('-')
  return applyFlagMap(a, i.flagMap)
}

// ---- env --------------------------------------------------------------------------------------------------------

export interface CodexEnvOptions {
  path?: string | undefined
  pathPrepend?: readonly string[] | undefined
  /** `vendors.codex.env` plus StartOptions.env, applied after everything Dim Factory sets. */
  vendorEnv?: EnvInput | undefined
  platform?: NodeJS.Platform
}

/** sanitizeEnv for a Codex child: CODEX_SANDBOX* and the rest of the sanitized list removed, `codex-path` first. */
export function codexEnv(base: EnvInput, o: CodexEnvOptions = {}): Record<string, string> {
  return sanitizeEnv(base, {
    purpose: 'vendor',
    vendor: 'codex',
    ...(o.path !== undefined ? { path: o.path } : {}),
    ...(o.pathPrepend !== undefined ? { pathPrepend: o.pathPrepend } : {}),
    ...(o.vendorEnv !== undefined ? { vendorEnv: o.vendorEnv } : {}),
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
  })
}
