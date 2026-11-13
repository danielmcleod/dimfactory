// The Grok ACP configuration (`grok agent stdio` with
// GROK_DISABLE_AUTOUPDATER=1; the "Grok ACP" mode row: readonly = the adapter rejects every ask, autoedit
// unsupported until GR03, full = `_meta.yoloMode:true` (Auto only), plan emulated; the probe's Grok checks).
// The GR fixtures are SYNTHESIZED until they are recorded live (tests/fixtures/grok/README.md).
import type { AcpVendorConfig } from '../acp-base/config.ts'
import { applyAcpFlagMap } from '../acp-base/launch.ts'
import { scanGrokAllowRules } from './allow-rules.ts'
import { grokAccount, grokAuthCheck } from './auth.ts'
import { GROK_DISPLAY_NAME, GROK_VENDOR, grokCliSpec } from './cli-spec.ts'
import { grokSessionExists } from './home.ts'
import { GROK_EXIT_CODES, GROK_REGEX } from './signals.ts'
import { GROK_ASK_META, GROK_FORBIDDEN_OPTION_NAME, GROK_YOLO_META, grokMetaUsage } from './wire.ts'

/** Grok version: "record". No floor, no recommended version, nothing tested live yet. */
export const VERSION_FLOOR = ''
export const VERSION_RECOMMENDED = ''
export const TESTED_UP_TO = ''

/**
 * GR03 (fixture-gated, SYNTHESIZED): Grok over ACP has no edits-only approval posture Dim Factory can set before the
 * turn (session/new `_meta` knows `yoloMode` and `autoMode` only; its interactive "Allow all edits this session" is an
 * answer to an edit already asked, which would widen the session from inside it). A synthesized GR03 cannot show
 * otherwise, so autoedit stays unsupported until a live GR03 does.
 */
export const GROK_AUTOEDIT_SUPPORTED = false

// ---- mode copy (the ONLY source of mode text; the mode table; no em dashes) -------------------------------------

export const GROK_COPY = {
  readonly:
    'Reads and searches only: every edit, command and web fetch Grok asks for is denied by Dim Factory, not prompted. Grok applies your own allow rules and hooks (its own and those in your Claude settings) before it asks, so Dim Factory does not run a read-only pass whose rules would let Grok change files.',
  autoedit:
    "Not supported until Dim Factory has seen it work: Grok's agent mode has no setting that approves edits only.",
  full: 'Everything runs without asking (Grok always-approve, for this session only).',
} as const

// ---- flags ----------------------------------------------------------------------------------------------------

/**
 * Flags Dim Factory's launch owns (`--model`, `--no-leader`), and the ones that would take the session or the prompt
 * out of ACP or start a sign-in that waits on a person (headless `-p` and its session flags, `--reauth`, the
 * serve and headless transports' flags).
 */
export const MANAGED_FLAGS = [
  '--model',
  '-m',
  '--no-leader',
  '--reauth',
  '--single',
  '-p',
  '--prompt-file',
  '--prompt-json',
  '--session-id',
  '-s',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--output-format',
  '--cwd',
  '--bind',
  '--secret',
  '--grok-ws-url',
  '--no-exit-on-disconnect',
] as const

/**
 * Flags that widen what a pass may do: always-approve (and its alias), a permission mode, allow rules, the folder's
 * own config (`--trust`), another folder, and a shared leader process the pass's kill would not stop.
 */
export const FORBIDDEN_FLAGS = [
  '--always-approve',
  '--yolo',
  '--permission-mode',
  '--allow',
  '--trust',
  '--leader',
  '--worktree',
  '-w',
] as const

/** Every flag the CLI defines that Dim Factory knows of (a flagMap target may not be one). */
export const CLI_FLAGS = [
  ...MANAGED_FLAGS,
  ...FORBIDDEN_FLAGS,
  '--agent-profile',
  '--sandbox',
  '--deny',
  '--rules',
  '--no-auto-update',
  '--version',
  '--help',
  '-h',
] as const

/**
 * Child env names never passed to Grok, in any spelling: `GROK_FOLDER_TRUST` switches Grok's folder-trust gate (which
 * keeps a repository's own Grok config, hooks and permission rules out of an untrusted folder; xai-grok-shell
 * agent/folder_trust.rs), and `GROK_SANDBOX_AUTO_ALLOW_BASH` skips shell prompts under a sandbox (config reference).
 * The config key with that effect (`sandbox.auto_allow_bash`) cannot be dropped: the read-only scan finds it
 * (allow-rules.ts).
 */
export const DROPPED_ENV = /^(?:GROK_FOLDER_TRUST|GROK_SANDBOX_AUTO_ALLOW_BASH)$/i

/** The ACP transport (`grok agent … stdio`): the last argument, after every agent option (user guide 15). */
export const GROK_TRANSPORT = 'stdio'

export const grokConfig: AcpVendorConfig = {
  id: GROK_VENDOR,
  displayName: GROK_DISPLAY_NAME,
  cliSpec: grokCliSpec,
  versionFloor: VERSION_FLOOR,
  versionRecommended: VERSION_RECOMMENDED,
  testedUpTo: TESTED_UP_TO,
  managedFlags: MANAGED_FLAGS,
  forbiddenFlags: FORBIDDEN_FLAGS,
  cliFlags: CLI_FLAGS,
  resolveLaunch(o) {
    // `grok agent stdio`. Agent options go between `agent` and `stdio` (user guide 15: "Agent options apply
    // to every transport and go after `agent` but before the mode name"): the model, `--no-leader` (a private agent per
    // pass: Grok's config may otherwise route stdio through a shared leader process that outlives the pass) and
    // the user's extraArgs, which are agent options too. `stdio` ends the argv (extraArgs go "at the end" means
    // "before the transport" for Grok). Native exe, no shell; no prompt in argv.
    const own = [
      'agent',
      ...(typeof o.model === 'string' && o.model !== '' ? ['--model', o.model] : []),
      '--no-leader',
    ]
    const env: Record<string, string> = { ...o.env }
    for (const k of Object.keys(env))
      if (DROPPED_ENV.test(k) || /^GROK_DISABLE_AUTOUPDATER$/i.test(k)) delete env[k]
    // Never update itself under a pass (a managed install's stdio agent may otherwise check and install).
    env['GROK_DISABLE_AUTOUPDATER'] = '1'
    return {
      exe: o.cli.command,
      args: [
        ...o.cli.prefixArgs,
        ...applyAcpFlagMap(grokConfig, own, o.flagMap),
        ...(o.extraArgs ?? []),
        GROK_TRANSPORT,
      ],
      env,
    }
  },
  modes: {
    // No ACP mode switch (Grok configOptions are model and reasoning_effort only): the posture is the session's
    // `_meta`, sent on every new, load and resume. readonly asks for everything and the adapter rejects every ask.
    readonly: { acpMode: null, meta: GROK_ASK_META, copy: GROK_COPY.readonly },
    autoedit: {
      acpMode: null,
      meta: GROK_ASK_META,
      copy: GROK_COPY.autoedit,
      ...(GROK_AUTOEDIT_SUPPORTED ? {} : { status: 'unsupported' as const }),
    },
    // Full mode comes only from Auto (config: mode full only with auto).
    full: { acpMode: null, meta: GROK_YOLO_META, copy: GROK_COPY.full },
  },
  planMode: 'emulated',
  // Grok's per-command "Always allow" is remembered for the project (permission.toml), not the session: never chosen,
  // so its asks never offer "Allow for this run". Options that widen the session are refused by name.
  optionPrefs: { allowSession: [], forbidden: [], forbiddenName: GROK_FORBIDDEN_OPTION_NAME },
  exitCodes: GROK_EXIT_CODES,
  signalRegex: GROK_REGEX,
  usage: { inputIncludesCached: false, cumulative: false, metaUsage: grokMetaUsage },
  // Grok Build's totals add input, cache and output with no reasoning term: reasoning is inside output.
  reasoningIncludedInOutput: true,
  probe: {
    // "--help lists agent stdio" (and the --no-leader the launch needs).
    help: { args: ['agent', '--help'], required: ['stdio', '--no-leader'] },
    auth: grokAuthCheck,
    account: grokAccount,
    // "ACP authRequired on Test": the launch probe stops at initialize; Test also starts a session.
    newSession: 'forced',
  },
  sessionExists: (o) => grokSessionExists(o),
  // Grok applies allow rules (its own config and the user's Claude settings) before it asks, so a read-only
  // pass whose rules would let it change files is not run (readiness `grok-allow-rules`, and refused at start()).
  readonlyAllowRules: { id: 'grok-allow-rules', scan: (o) => scanGrokAllowRules(o) },
}
