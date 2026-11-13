// Gemini renderer fixtures (the ACP base + Gemini, the Gemini probe checks, the "Gemini ACP" mode row,
// readiness `trust`; trust.json `vendorFolder`; the commands table). Core's words, copied: geminiCopy.test.ts keeps them equal.
import type { RecoveryActionOf } from '@shared/failure.ts'
import type { TrustState } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { Mode } from '@shared/run.ts'
import type { Capabilities, ModelInfo, ModelOption, ProbeView, VendorHealth } from '@shared/vendors.ts'

export const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()

export const FOLDER = 'C:\\work\\repo'
export const OTHER_FOLDER = 'C:\\work\\site'

/** The commands table: the Gemini install command (core heal/commands.ts GEMINI_INSTALL). */
export const GEMINI_INSTALL = 'npm install -g @google/gemini-cli@latest'

/** The npm shim the resolver finds, and how core starts it (system node with the shim's JS entry). */
export const GEMINI_SHIM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.cmd'
export const SYSTEM_NODE = 'C:\\Program Files\\nodejs\\node.exe'
export const GEMINI_ENTRY =
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js'

/**
 * Gemini's mode copy as the adapter states it (src/core/adapters/gemini/config.ts GEMINI_COPY, word for word; the
 * "Gemini ACP" mode row: read-only = default + the adapter rejects every ask; autoedit "edits auto; shell and other
 * tools ask you"; full = yolo).
 */
export const GEMINI_COPY: Readonly<Record<Mode, string>> = {
  readonly:
    'Reads and searches only: every edit, command and web fetch Gemini asks for is denied by Dim Factory, not prompted.',
  autoedit: 'Edits auto; shell and other tools ask you.',
  full: 'Everything runs without asking (Gemini YOLO mode).',
}

/** Gemini's versions (gemini/config.ts: no floor, 0.62.0 recommended, tested up to 0.64.0). */
export const GEMINI_RECOMMENDED = '0.62.0'
export const GEMINI_TESTED_UP_TO = '0.64.0'

export function geminiCaps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    planMode: 'native',
    askRelay: true,
    resume: 'load',
    preassignSessionId: false,
    modelList: 'cli',
    usageCumulative: false,
    allowSession: 'app',
    web: true,
    resumeModelSwitch: true,
    reasoningIncludedInOutput: false,
    modes: {
      readonly: { status: 'supported', copy: GEMINI_COPY.readonly },
      autoedit: { status: 'supported', copy: GEMINI_COPY.autoedit },
      full: { status: 'supported', copy: GEMINI_COPY.full },
    },
    ...over,
  }
}

/** The models the probe's ACP session/new listed (`availableModels`), Gemini's own ids and aliases. */
export const GEMINI_MODELS: ModelInfo[] = [
  { id: 'auto', label: 'Auto', source: 'cli', isDefault: true },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', source: 'cli' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', source: 'cli' },
]

/** vendors.models for Gemini: the CLI's list with the catalog's pricing (one without a price). */
export const GEMINI_MODEL_OPTIONS: ModelOption[] = [
  { id: 'auto', label: 'Auto', source: 'cli', isDefault: true, hasPricing: false },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', source: 'cli', hasPricing: true },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', source: 'cli', hasPricing: true },
]

export function gcheck(id: string, over: Partial<CheckResult> = {}): CheckResult {
  const status = over.status ?? 'pass'
  return {
    id: `vendor.gemini.${id}`,
    scope: 'vendor',
    status,
    blocking: over.blocking ?? status === 'fail',
    title: id,
    detail: '',
    recovery: [],
    at: NOW,
    ttlMs: 0,
    ...over,
  }
}

/** acp-base/probe.ts installActions (the copy command first). */
export const INSTALL_ACTION: RecoveryActionOf<'shell_copy'> = {
  id: 'gemini.install',
  label: 'Copy the install command',
  kind: 'shell_copy',
  command: GEMINI_INSTALL,
  shell: 'powershell',
  reason: 'Gemini is not installed',
  recheck: 'vendor.gemini.bin',
}

/** gemini/auth.ts: the sign-in command (the commands table's "run gemini once and sign in"). */
export const LOGIN_ACTION: RecoveryActionOf<'shell_copy'> = {
  id: 'gemini.login',
  label: 'Copy the sign-in command',
  kind: 'shell_copy',
  command: 'gemini',
  shell: 'powershell',
  reason: 'Gemini is not signed in. Run it once and sign in.',
  recheck: 'vendor.gemini.auth',
}

/** acp-base/probe.ts updateActions. */
export const UPDATE_ACTION: RecoveryActionOf<'shell_copy'> = {
  id: 'gemini.update',
  label: 'Copy the update command',
  kind: 'shell_copy',
  command: GEMINI_INSTALL,
  shell: 'powershell',
  reason: 'Update Gemini',
  recheck: 'vendor.gemini.version',
}

/** core's vendor.gemini.auth failure detail (gemini/auth.ts). */
export const NOT_SIGNED_IN_DETAIL =
  'Run the sign-in command in a terminal (it opens a browser once), then re-check. A GEMINI_API_KEY in the environment works too.'

/** core's vendor.gemini.version failure for a CLI without `--acp` (acp-base/probe.ts). */
export const NO_ACP_DETAIL = 'This Gemini has no --acp option, which Dim Factory needs. Update Gemini.'

export type GeminiState = 'ready' | 'not-installed' | 'login-needed' | 'no-acp'

export interface GeminiOptions {
  state?: GeminiState
  version?: string
  checks?: CheckResult[]
  over?: Partial<ProbeView>
}

const HEALTH: Readonly<Record<GeminiState, VendorHealth>> = {
  ready: 'ready',
  'not-installed': 'not-installed',
  'login-needed': 'login-needed',
  'no-acp': 'update-needed',
}

const DETAIL: Readonly<Record<GeminiState, string>> = {
  ready: 'Ready · 0.62.1',
  'not-installed': 'Not installed',
  'login-needed': 'Login needed',
  'no-acp': 'Update needed',
}

function checksFor(state: GeminiState, version: string): CheckResult[] {
  if (state === 'not-installed')
    return [
      gcheck('bin', {
        status: 'fail',
        category: 'cli_missing',
        title: 'Gemini is not installed',
        detail: 'No Gemini CLI was found on this computer.',
        recovery: [INSTALL_ACTION],
      }),
    ]
  return [
    gcheck('bin', {
      title: 'Gemini found',
      detail: `${GEMINI_SHIM} (npm global prefix; runs with ${SYSTEM_NODE})`,
    }),
    state === 'no-acp'
      ? gcheck('version', {
          status: 'fail',
          category: 'flag_drift',
          title: `Gemini ${version} cannot talk to Dim Factory`,
          detail: NO_ACP_DETAIL,
          recovery: [UPDATE_ACTION],
        })
      : gcheck('version', { title: `Gemini ${version}`, detail: `Tested up to ${GEMINI_TESTED_UP_TO}.` }),
    state === 'login-needed'
      ? gcheck('auth', {
          status: 'fail',
          category: 'auth_required',
          title: 'Gemini is not signed in',
          detail: NOT_SIGNED_IN_DETAIL,
          recovery: [LOGIN_ACTION],
        })
      : gcheck('auth', { title: 'Signed in', detail: 'Gemini signs in with a Google sign-in.' }),
    gcheck('protocol', { title: 'ACP protocol works' }),
    gcheck('plan', { title: 'Native plan mode' }),
  ]
}

/** Gemini as core's probeView reports it (built): the npm shim, run as system node <entry>. */
export function gemini(o: GeminiOptions = {}): ProbeView {
  const state = o.state ?? 'ready'
  const version = o.version ?? '0.62.1'
  const installed = state !== 'not-installed'
  return {
    vendor: 'gemini',
    displayName: 'Gemini',
    built: true,
    experimental: false,
    health: HEALTH[state],
    healthDetail: DETAIL[state],
    checking: false,
    versionFloor: null,
    versionRecommended: GEMINI_RECOMMENDED,
    testedUpTo: GEMINI_TESTED_UP_TO,
    probe: {
      vendor: 'gemini',
      at: NOW,
      ok: state === 'ready',
      route: 'acp',
      transport: 'acp',
      ...(installed
        ? {
            version,
            binary: {
              path: GEMINI_SHIM,
              command: SYSTEM_NODE,
              argvPrefix: [GEMINI_ENTRY],
              kind: 'node-entry' as const,
              source: 'npm-prefix' as const,
              version,
              mtimeMs: 0,
              size: 0,
              pathPrepend: [],
              warnings: [],
            },
          }
        : {}),
      checks: o.checks ?? checksFor(state, version),
      capabilities: geminiCaps(),
      models: installed ? GEMINI_MODELS : [],
    },
    candidates: installed ? [GEMINI_SHIM] : [],
    ...o.over,
  }
}

// ---- readiness `trust` ("Gemini without a grant → fail, with a grant vendorFolder action") ---------------
// acp-base/index.ts readiness(): one grant action (`gemini.trust-folder`) on every pass's check.

export const TRUST_ACTION_ID = 'gemini.trust-folder'
export const TRUST_CHECK_TITLE = 'Gemini needs your OK for this folder'
export const TRUST_CHECK_DETAIL =
  'Gemini only works in folders you trust. Trust this folder once and Dim Factory starts Gemini here without its own trust prompt; you can remove the trust in Settings.'
export const TRUST_ACTION_DETAIL =
  "Lets Gemini read and change files in this folder when a pass allows it. Dim Factory still asks you before edits and commands as each pass's mode says."

export function trustAction(over: Partial<RecoveryActionOf<'grant'>> = {}): RecoveryActionOf<'grant'> {
  return {
    id: TRUST_ACTION_ID,
    label: 'Trust this folder for Gemini',
    kind: 'grant',
    grant: 'vendorFolder',
    vendor: 'gemini',
    detail: TRUST_ACTION_DETAIL,
    ...over,
  }
}

/** A switch core might list beside the grant (the strip's "other fixes" order). */
export const SWITCH_TO_CLAUDE: RecoveryActionOf<'switch_vendor'> = {
  id: 'pass.implement.readiness.trust.switch',
  label: 'Use Claude for Implement',
  kind: 'switch_vendor',
  pass: 'implement',
  to: 'claude',
  model: null,
}

/** Core's blocking readiness check for a pass on Gemini in a folder without the grant. */
export function trustCheck(pass = 'implement', over: Partial<CheckResult> = {}): CheckResult {
  return {
    id: `pass.${pass}.readiness.trust`,
    scope: 'pass',
    status: 'fail',
    blocking: true,
    category: 'trust_required',
    title: TRUST_CHECK_TITLE,
    detail: TRUST_CHECK_DETAIL,
    recovery: [trustAction()],
    at: 0,
    ttlMs: 0,
    ...over,
  }
}

/** trust.get / trust.set answers for a folder (its scope root is itself), with or without Gemini's grant. */
export function trustState(folder: string, trusted: boolean, at = NOW - 2 * 86_400_000): TrustState {
  return {
    folder,
    folderKey: `key-${folder.replace(/[^a-z]/gi, '').toLowerCase()}`,
    scopeRoot: folder,
    grants: trusted ? { vendorFolder: { gemini: { at } } } : {},
  }
}
