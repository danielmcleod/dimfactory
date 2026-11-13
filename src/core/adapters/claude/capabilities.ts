// Claude Code adapter constants. Values settled by the recordings carry their fixture id
// (tests/fixtures/claude/stdio/<ID>-*).
import type { Mode } from '../../../shared/run.ts'
import type { Capabilities, Support } from '../../../shared/vendors.ts'

export const CLAUDE_VENDOR = 'claude'
export const CLAUDE_DISPLAY_NAME = 'Claude'

export const VERSION_FLOOR = '2.1.281'
/**
 * The version the live re-record used (C01 to C18d, 2026-10-12; C01 to C16 were first recorded with it too). No
 * recording showed an older version failing, so the floor stays.
 */
export const VERSION_RECOMMENDED = '2.1.289'
/** C01 to C16 were recorded with 2.1.289, and re-recorded with it, C17 to C18d too, on 2026-10-12. */
export const TESTED_UP_TO = '2.1.289'

/** C05a–d: asks need only `--permission-prompt-tool stdio`; initialize is kept for models[] (0 tokens, C16). */
export const SEND_INITIALIZE = true
export const INITIALIZE_TIMEOUT_MS = 15_000
/** C06: after the ExitPlanMode deny + interrupt the CLI ends the turn in ~250 ms; kill if it does not. */
export const PLAN_RESULT_TIMEOUT_MS = 10_000
/** C10a: the interrupt is acknowledged in ~15 ms and the result follows ~35 ms later. */
export const STOP_RESULT_WAIT_MS = 3_000
export const STOP_STDIN_WAIT_MS = 2_000
/**
 * C09c: an invalid API key is retried 10× over ~3 min before the error result. The pass stops at this
 * api_retry attempt when the retry is an authentication failure (attempt 1 is tolerated as a transient).
 */
export const AUTH_RETRY_FAIL_FAST_ATTEMPT = 2
/** C08a/C08b: modelUsage and total_cost_usd are cumulative across --resume; per-pass usage is a delta. */
export const USAGE_CUMULATIVE = true
/** C04d: an interrupted turn can report `modelUsage: {}` and cost 0; that is unknown, not a reset. */
export const EMPTY_MODEL_USAGE_IS_UNKNOWN = true
/** C06: the deny + interrupt that captures the plan ends with an error result and exit 1; still a success. */
export const PLAN_CAPTURE_IS_SUCCESS = true
/**
 * A discarded C05a run showed that claude.ai connectors load in -p and leak into answers.
 * Read-only and plan passes (and the probe) run with --strict-mcp-config (no MCP at all, hermetic);
 * edit passes keep the user's own MCP servers and only switch the claude.ai connectors off. Those are the defaults of
 * a pass's Extensions level (None, Pass through); launch.ts builds every level from them.
 */
export const STRICT_MCP_READONLY = true
export const CLAUDEAI_MCP_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } as const
/** C07/C06b/C07b: shell may stay enabled in Plan; the adapter's read-only deny covers host asks. */
export const PLAN_DISALLOWS_SHELL = false

// Exact strings the CLI receives (recorded in C04b/C04d/C06/C06b; replay compares them byte for byte).
export const DENY_MESSAGE = 'Denied by the user in Dim Factory.'
export const READONLY_DENY_MESSAGE = 'Read-only pass'
export const PLAN_CAPTURED_MESSAGE = 'Plan captured by Dim Factory. Stop now; do not implement.'
export const PLAN_EMPTY_MESSAGE =
  'ExitPlanMode was called without plan text. Call it again with the complete plan.'
export const UNSUPPORTED_ASK_MESSAGE =
  'This tool needs an interactive prompt that Dim Factory cannot show. Continue without it.'

export const PLAN_SETTINGS = '{"useAutoModeDuringPlan":false}'
/** A native plan below Pass through (None and Allowed list): hooks off too. */
export const PLAN_ALLOWED_SETTINGS = '{"useAutoModeDuringPlan":false,"disableAllHooks":true}'
/**
 * The None level's skills switch: `claude --help` (2.1.289) "Disable all skills". Checked token-free on 2.1.289: with it
 * the initialize reply lists no command, `system/init` lists no skill and no slash command, and the Skill tool is gone
 * from `init.tools`; an initialize `skills: []` (the Allowed list's filter) still lists every skill there and keeps the
 * Skill tool.
 */
export const DISABLE_SKILLS_FLAG = '--disable-slash-commands'
/**
 * The CLI's own subagents (2.1.289; the initialize reply's `agents` does not mark them, unlike its built-in commands).
 * Any other name there is the user's, the project's or a plugin's. Kept in step with scripts/redact-claude.mjs.
 */
export const BUILTIN_AGENTS: readonly string[] = [
  'claude',
  'Explore',
  'general-purpose',
  'Plan',
  'statusline-setup',
  'output-style-setup',
  'claude-code-guide',
]
export const READONLY_SETTINGS = '{"disableAllHooks":true}'
/** C02: the read-only tool cut. */
export const READONLY_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'AskUserQuestion', 'Monitor'] as const
export const SHELL_TOOLS = ['Bash', 'PowerShell'] as const
export const WEB_TOOLS = ['WebFetch', 'WebSearch'] as const
/** C13: the subagent tool is called `Agent` (init.tools lists it as `Task`). */
export const AGENT_TOOLS = ['Agent'] as const
export const WEB_SEARCH_TOOL = 'WebSearch'
/**
 * Catalog refresh: the read-only cut plus shell and subagents, never a host or a prompt. Web
 * search is allowed, and page fetches only on the official hosts (`WebFetch(domain:<host>)`, catalog/sources.ts).
 * Kept as defence in depth: the pass's tool set is the allow list {@link CATALOG_TOOLS}.
 */
export const CATALOG_DISALLOWED = [...READONLY_DISALLOWED, ...SHELL_TOOLS, ...AGENT_TOOLS] as const
/**
 * The refresh's built-in tools (`--tools`), an allow list rather than a cut, so tools a newer CLI adds
 * (Workflow, Skill, EnterWorktree, RemoteTrigger, CronCreate, SendMessage… in 2.1.289) never reach it. A logged-out
 * 2.1.289 with the refresh's argv and initialize `jsonSchema` reported init.tools [WebFetch, WebSearch,
 * StructuredOutput] (probe 2026-10-09): the answer tool comes with the schema and needs no listing.
 */
export const CATALOG_TOOLS = ['WebSearch', 'WebFetch'] as const
/**
 * The refresh's allow list is exactly its `--allowedTools`. With this variable the CLI (2.1.289 and 2.1.293,
 * read in the binaries) drops every settings allow-rule (only cliArg rules count) and turns off WebFetch's built-in
 * "preapproved hosts" (docs.python.org, github.com/anthropics, … about 100), which would otherwise be fetched under
 * dontAsk without any rule. It only narrows: worktrees, cloud sessions, plugin network access and settings `env` are
 * off as well. Set after vendorEnv, so no user setting can unset it. The live re-record includes a fetch it must deny.
 */
export const CATALOG_CONFINED_ENV = { CLAUDE_CODE_EVAL_CONFINED: '1' } as const
/**
 * Research before Plan: the catalog refresh's confinement (no edits, shell or agents, no settings rules or
 * preapproved hosts, never a prompt), with the repository's read tools, and web search plus page fetches on any host
 * when the run may use the web (research reads what it finds; web content is untrusted, and the prompt says so).
 * `--tools` is an allow list, so tools a newer CLI adds never reach the pass.
 */
export const RESEARCH_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const
/** A host a `WebFetch(domain:…)` rule may name: lower-case DNS labels, at least one dot, nothing else. */
export const WEB_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/** `WebFetch(domain:<host>)`, the Claude permission rule for page fetches on one exact host. */
export const webFetchRule = (host: string): string => `WebFetch(domain:${host})`

/** Flags the adapter owns; extraArgs may not repeat them and flagMap may only rename them. */
export const MANAGED_FLAGS = [
  '-p',
  '--print',
  '--input-format',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  '--model',
  // A pass's effort level (config `passes.<p>.effort`).
  '--effort',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--settings',
  '--no-session-persistence',
  '--disallowedTools',
  '--disallowed-tools',
  '--allowedTools',
  '--allowed-tools',
  // The catalog refresh's and Research's tool allow list.
  '--tools',
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--strict-mcp-config',
] as const

/**
 * Every flag the CLI already defines (the 2.1.289 commander definitions, hidden ones included, plus the documented
 * ones of nearby releases, and every option of the 2.1.289 `claude --help`, tests/fixtures/claude/meta/help.txt). A
 * flagMap rename ("the CLI renamed this flag") may never point a managed flag at one of
 * them: `--disallowedTools` renamed to `--fallback-model` would turn the read-only tool cut into a harmless option
 * value. Compared by spelling-insensitive flag identity.
 */
export const CLI_FLAGS = [
  '-p',
  '--print',
  '-c',
  '--continue',
  '-r',
  '--resume',
  '-d',
  '--debug',
  '--debug-file',
  '-h',
  '--help',
  '-v',
  '--version',
  '-w',
  '--worktree',
  '-n',
  '--name',
  '--add-dir',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--ax-screen-reader',
  '--background',
  '--bare',
  '--betas',
  '--bg',
  '--brief',
  '--channels',
  '--chrome',
  '--cloud',
  '--dangerously-skip-permissions',
  '--desktop',
  '--disable-slash-commands',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--environment',
  '--exclude-dynamic-system-prompt-sections',
  '--fallback-model',
  '--file',
  '--fork-session',
  '--forward-subagent-text',
  '--from-pr',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--init',
  '--init-only',
  '--input-format',
  '--json-schema',
  '--maintenance',
  '--managed-settings',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--max-turns',
  '--mcp-config',
  '--mcp-debug',
  '--model',
  '--no-chrome',
  '--no-session-persistence',
  '--output-format',
  '--output-style',
  '--permission-mode',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--prompt-suggestions',
  '--remote',
  '--remote-control',
  '--remote-control-session-name-prefix',
  '--replay-user-messages',
  '--restricted',
  '--safe-mode',
  '--sdk-url',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--strict-mcp-config',
  '--system-prompt',
  '--system-prompt-file',
  '--system-prompt-snapshot',
  '--teleport',
  '--thinking-display',
  '--tmux',
  '--tools',
  '--verbose',
] as const

/**
 * Flags that widen what a pass may do (no mode escalation). extraArgs may not carry them and a
 * flagMap rename may not target them; `--dangerously-*` / `--allow-dangerously-*` are refused by prefix too.
 */
export const ESCALATION_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--add-dir',
  '--mcp-config',
  '--plugin-dir',
  '--setting-sources',
  '--agents',
] as const

export const MODE_COPY: Readonly<Record<Mode, string>> = {
  readonly: 'Reads and read-only commands; everything else is denied, not prompted.',
  autoedit:
    'Edits and basic file operations (mkdir, mv, rm, cp) in the folder run automatically; other commands, ' +
    'network and outside-folder access ask you.',
  full: 'Everything runs automatically except your own ask rules and critical deletions.',
}
/** C03: on Windows the model may pick PowerShell, where New-Item and Move-Item still ask. */
export const AUTOEDIT_WIN32_NOTE =
  ' On Windows, PowerShell file commands (New-Item, Move-Item) may still ask.'
export const PLAN_NATIVE_COPY =
  "Claude's own plan mode: reads freely, never edits, and Dim Factory captures the plan when it is ready."
/**
 * Live balanced run: when the user's or the folder's Claude settings allow shell commands that can change files,
 * a read-only pass (and a native Plan) runs without Bash and PowerShell (launch.ts `disallowShell`), so its copy says
 * so instead of MODE_COPY.readonly's "read-only commands" (the readiness check `claude-allow-rules` warns as well).
 */
export const SHELL_OFF_NOTE =
  'Shell commands are off because your Claude settings allow commands that can change files.'
export const READONLY_NO_SHELL_COPY =
  'Reads only; shell commands are off because your Claude settings allow commands that can change files.'
export const PLAN_NATIVE_NO_SHELL_COPY = `${PLAN_NATIVE_COPY} ${SHELL_OFF_NOTE}`

export function modeSupport(mode: Mode, platform: NodeJS.Platform = process.platform): Support {
  const copy =
    mode === 'autoedit' && platform === 'win32' ? MODE_COPY.autoedit + AUTOEDIT_WIN32_NOTE : MODE_COPY[mode]
  return { status: 'supported', copy }
}

export function claudeCapabilities(platform: NodeJS.Platform = process.platform): Capabilities {
  return {
    planMode: 'native',
    askRelay: true,
    resume: 'id',
    preassignSessionId: true,
    modelList: 'cli',
    usageCumulative: USAGE_CUMULATIVE,
    allowSession: 'native',
    web: true,
    resumeModelSwitch: true,
    // Continuity: Implement resumes Plan's session in its own mode (the mode is set per launch / per turn).
    resumeModeSwitch: true,
    reasoningIncludedInOutput: true,
    effort: true,
    modes: {
      readonly: modeSupport('readonly', platform),
      autoedit: modeSupport('autoedit', platform),
      full: modeSupport('full', platform),
    },
  }
}
