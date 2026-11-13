// The Gemini ACP configuration (`gemini --acp [-m]`, `--skip-trust` only with the
// vendorFolder grant or for Dim Factory-owned cwds, spawned as system `node <entry>`; modes default / autoEdit / yolo /
// plan; optionPrefs; exit codes 41/42/44/52/53/54/55; the "Gemini ACP" mode row; the probe's Gemini checks).
// Values a fixture decides name it; the G fixtures are SYNTHESIZED until they are recorded live (tests/fixtures/gemini).
import { GEMINI_EXIT_CODES } from '../../heal/signals/acp-gemini.ts'
import type { AcpVendorConfig } from '../acp-base/config.ts'
import { applyAcpFlagMap } from '../acp-base/launch.ts'
import { isAllowableMcpName } from '../../../shared/extensions.ts'
import { geminiAccount, geminiAuthCheck } from './auth.ts'
import { GEMINI_DISPLAY_NAME, GEMINI_VENDOR, geminiCliSpec } from './cli-spec.ts'
import { geminiSessionExists, geminiTmpDir } from './home.ts'
import { GEMINI_MODE_UPDATE, GEMINI_PLAN_EXIT_TITLE, geminiMetaUsage, geminiShellRequest } from './wire.ts'

/** Warn below 0.62.0 (no floor; a CLI without `--acp` fails vendor.gemini.version instead). */
export const VERSION_FLOOR = ''
export const VERSION_RECOMMENDED = '0.62.0'
/**
 * The newest source the synthesized G fixtures were read from (gemini-cli main, 0.64.0-nightly; the
 * stable 0.62.0). Nothing was recorded live yet: a newer CLI warns until the G fixtures are re-recorded on it.
 */
export const TESTED_UP_TO = '0.64.0'

/** `session/set_mode` ids (Gemini ApprovalMode: DEFAULT, AUTO_EDIT, YOLO, PLAN). */
export const GEMINI_MODES = { readonly: 'default', autoedit: 'autoEdit', full: 'yolo', plan: 'plan' } as const

/** The decision table: allow-session takes the first offered of these, in order. */
export const GEMINI_ALLOW_SESSION = [
  'proceed_always_tool',
  'proceed_always',
  'proceed_always_server',
] as const
/** Never chosen: "Allow for all future sessions" writes the approval into Gemini's own settings. */
export const GEMINI_FORBIDDEN_OPTIONS = ['proceed_always_and_save'] as const

/**
 * G05 (fixture-gated, SYNTHESIZED): Gemini's PromptResponse.usage.inputTokens is the API's promptTokenCount, which
 * includes the cached tokens (cachedReadTokens), so they come off `input` (Dim Factory's `input` is uncached input).
 * The headless stream's own stats say so (input_tokens = prompt incl. cached), and gemini-cli 0.64's
 * buildPromptResponse sends promptTokenCount as inputTokens. Its totalTokens (input + output) cannot tell,
 * so a live G05a re-record confirms the field, not the total. Thought tokens are counted apart from outputTokens.
 * Gemini 0.62 and 0.63 send no `usage` at all: their `_meta.quota.token_count` stands in, approximate (wire.ts).
 */
export const USAGE_INPUT_INCLUDES_CACHED = true

// ---- mode copy (the ONLY source of mode text; the mode table; no em dashes) -------------------------------------

export const GEMINI_COPY = {
  readonly:
    'Reads and searches only: every edit, command and web fetch Gemini asks for is denied by Dim Factory, not prompted.',
  autoedit: 'Edits auto; shell and other tools ask you.',
  full: 'Everything runs without asking (Gemini YOLO mode).',
  plan: "Gemini's own plan mode: it reads and plans, Dim Factory captures the plan and never lets it leave plan mode.",
} as const

// ---- flags ----------------------------------------------------------------------------------------------------

/** Flags Dim Factory's launch owns (and the ones that would take the session or the prompt out of ACP). */
export const MANAGED_FLAGS = [
  '--acp',
  '--experimental-acp',
  '--model',
  '-m',
  '--skip-trust',
  '--prompt',
  '-p',
  '--prompt-interactive',
  '-i',
  '--resume',
  '-r',
  '--session-id',
  '--session-file',
  '--output-format',
  '-o',
  '--list-sessions',
  '--delete-session',
  // A pass's Extensions level: which MCP servers may load (geminiMcpArgs).
  '--allowed-mcp-server-names',
] as const

/** Flags that widen what a pass may do: approvals, tool allowances, policies, more folders. */
export const FORBIDDEN_FLAGS = [
  '--yolo',
  '-y',
  '--approval-mode',
  '--allowed-tools',
  '--policy',
  '--admin-policy',
  '--include-directories',
  '--worktree',
  '-w',
] as const

/** Every flag the CLI defines that Dim Factory knows of (a flagMap target may not be one). */
export const CLI_FLAGS = [
  ...MANAGED_FLAGS,
  ...FORBIDDEN_FLAGS,
  '--sandbox',
  '-s',
  '--debug',
  '-d',
  '--extensions',
  '-e',
  '--list-extensions',
  '-l',
  '--raw-output',
  '--screen-reader',
  '--proxy',
  '--checkpointing',
  '-c',
  '--version',
  '-v',
  '--help',
  '-h',
] as const

/**
 * `GEMINI_CLI_TRUST_WORKSPACE=true` trusts any folder like `--skip-trust` does (Gemini skips its trust check "unless
 * `--skip-trust` or GEMINI_CLI_TRUST_WORKSPACE=true is set"). Never passed to the child, in any spelling.
 */
export const TRUST_ENV = /^GEMINI_CLI_TRUST_WORKSPACE$/i

/**
 * A server name no settings file defines: `--allowed-mcp-server-names` with it alone lets no MCP server load. Gemini
 * loads the servers of its settings and extensions whatever session/new's `mcpServers` says (it merges them), and
 * an empty allow list means "no limit" to it, so the None level names this instead.
 */
export const GEMINI_NO_MCP = '__dimFactory_no_mcp__'

/**
 * `--allowed-mcp-server-names <list>` for a pass below Pass through: only the allowed servers (gemini-cli matches each
 * server of its settings, its extensions and session/new by name), or none at all. Nothing for Pass through.
 */
export function geminiMcpArgs(mcpAllow: readonly string[] | undefined): string[] {
  if (mcpAllow === undefined) return []
  const names = [...new Set(mcpAllow.filter(isAllowableMcpName))]
  return ['--allowed-mcp-server-names', names.length > 0 ? names.join(',') : GEMINI_NO_MCP]
}

export const geminiConfig: AcpVendorConfig = {
  id: GEMINI_VENDOR,
  displayName: GEMINI_DISPLAY_NAME,
  cliSpec: geminiCliSpec,
  versionFloor: VERSION_FLOOR,
  versionRecommended: VERSION_RECOMMENDED,
  testedUpTo: TESTED_UP_TO,
  managedFlags: MANAGED_FLAGS,
  forbiddenFlags: FORBIDDEN_FLAGS,
  cliFlags: CLI_FLAGS,
  resolveLaunch(o) {
    // `gemini --acp [-m model]`, `--skip-trust` only when the folder may skip Gemini's own trust; the user's
    // extraArgs at the end. Spawned as `node <entry>` for the npm shim (prefixArgs); no shell; no prompt in argv.
    const own = [
      '--acp',
      ...(typeof o.model === 'string' && o.model !== '' ? ['-m', o.model] : []),
      ...(o.trust ? ['--skip-trust'] : []),
      ...geminiMcpArgs(o.mcpAllow),
    ]
    // Gemini's env twin of --skip-trust: Dim Factory alone decides trust (the flag above), so an inherited one never
    // opens a folder the user did not trust for Gemini.
    const env = { ...o.env }
    for (const k of Object.keys(env)) if (TRUST_ENV.test(k)) delete env[k]
    return {
      exe: o.cli.command,
      args: [...o.cli.prefixArgs, ...applyAcpFlagMap(geminiConfig, own, o.flagMap), ...(o.extraArgs ?? [])],
      env,
    }
  },
  modes: {
    // The mode table: `default` + the adapter rejects every ask.
    readonly: { acpMode: GEMINI_MODES.readonly, copy: GEMINI_COPY.readonly },
    autoedit: { acpMode: GEMINI_MODES.autoedit, copy: GEMINI_COPY.autoedit },
    full: { acpMode: GEMINI_MODES.full, copy: GEMINI_COPY.full },
  },
  // plan and default ask for everything that writes; autoEdit lets edits through; yolo lets everything through.
  modeRank: { default: 0, plan: 0, autoEdit: 1, yolo: 2 },
  planMode: 'native',
  plan: { acpMode: GEMINI_MODES.plan, copy: GEMINI_COPY.plan },
  optionPrefs: { allowSession: GEMINI_ALLOW_SESSION, forbidden: GEMINI_FORBIDDEN_OPTIONS },
  exitCodes: GEMINI_EXIT_CODES,
  trustFlag: '--skip-trust',
  // gemini-cli v0.62.0 and main: a shell confirmation's title is its command and its text content the
  // explanation; exit_plan_mode is kind `other`, titled with the plan file; mode changes arrive as `[MODE_UPDATE]` text.
  shellRequest: geminiShellRequest,
  planExitTitle: GEMINI_PLAN_EXIT_TITLE,
  modeUpdateText: GEMINI_MODE_UPDATE,
  usage: { inputIncludesCached: USAGE_INPUT_INCLUDES_CACHED, cumulative: false, metaUsage: geminiMetaUsage },
  reasoningIncludedInOutput: false,
  probe: {
    help: { args: ['--help'], required: ['--acp'], optional: ['--skip-trust'] },
    auth: geminiAuthCheck,
    account: geminiAccount,
    newSession: true,
  },
  sessionExists: (o) => geminiSessionExists(o),
  // `-m` aliases (the CLI has no non-interactive model list; ACP session/new names the real ones when signed in).
  staticModels: [
    { id: 'auto', label: 'Auto', isDefault: true },
    { id: 'pro', label: 'Pro' },
    { id: 'flash', label: 'Flash' },
    { id: 'flash-lite', label: 'Flash Lite' },
  ],
  planFileRoots: (o) => [geminiTmpDir(o.env, o.home)],
}
