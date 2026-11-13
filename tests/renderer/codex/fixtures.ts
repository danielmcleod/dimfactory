// Codex renderer fixtures (the Codex probe and mode table, the local preset; vendor_setup; the
// Codex Windows sandbox procedure X11b/X11c): Codex probe views as core reports them (route, versions, the
// vendor.codex.* checks, the winSandbox check with core's setup and elevated command, capabilities with core's own mode
// copy), and the answers recovery.execute gives for vendor_setup. The copy and the elevated command are core's
// (src/core/adapters/codex/capabilities.ts, src/core/heal/commands.ts), copied because the renderer project's types
// have no Node; codexCopy.test.ts keeps them equal.
import type { CheckResult } from '@shared/preflight.ts'
import type { RecoveryActionOf } from '@shared/failure.ts'
import type { RecoveryResult, VendorSetupOutcome } from '@shared/ipc.ts'
import type { Mode } from '@shared/run.ts'
import type { Capabilities, ModelInfo, ProbeView, Support, VendorHealth } from '@shared/vendors.ts'

export const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime()

export const CODEX_EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'

/** Core's unelevated setup (the only one Dim Factory runs, on a click). */
export const SETUP_ACTION: RecoveryActionOf<'vendor_setup'> = {
  id: 'vendor.codex.winSandbox.setup',
  label: 'Set up the Codex sandbox',
  kind: 'vendor_setup',
  vendor: 'codex',
  call: 'windowsSandbox/setupStart',
  params: { mode: 'unelevated' },
}

/** core heal/commands.ts `commandFor('sandboxSetup', 'codex', 'win32')`. */
export const ELEVATED_COMMAND = 'codex sandbox setup --elevated --current-user'

/** Core's elevated fallback: a command to copy (the X11c procedure), never run by Dim Factory. */
export const ELEVATED_ACTION: RecoveryActionOf<'shell_copy'> = {
  id: 'vendor.codex.winSandbox.elevated',
  label: 'Copy elevated setup command',
  kind: 'shell_copy',
  command: ELEVATED_COMMAND,
  shell: 'powershell',
  reason: 'Run in an administrator terminal, then re-check.',
  elevated: true,
  recheck: 'vendor.codex.winSandbox',
}

export function vcheck(id: string, over: Partial<CheckResult> = {}): CheckResult {
  const status = over.status ?? 'pass'
  return {
    id: `vendor.codex.${id}`,
    scope: 'vendor',
    status,
    blocking: over.blocking ?? false,
    title: id,
    detail: '',
    recovery: [],
    at: NOW,
    ttlMs: 0,
    ...over,
  }
}

/** `vendor.codex.winSandbox` as the probe reports it on win32. */
export function sandboxCheck(state: 'ready' | 'notConfigured' | 'unavailable'): CheckResult {
  if (state === 'ready') return vcheck('winSandbox', { title: 'Codex Windows sandbox ready' })
  if (state === 'unavailable')
    return vcheck('winSandbox', {
      status: 'fail',
      category: 'sandbox_unavailable',
      title: 'Codex Windows sandbox unavailable',
      detail: 'This Codex cannot report its Windows sandbox.',
      recovery: [ELEVATED_ACTION],
    })
  return vcheck('winSandbox', {
    status: 'fail',
    category: 'sandbox_unavailable',
    title: 'Codex Windows sandbox not set up',
    detail: WIN_SANDBOX_SETUP_DETAIL,
    recovery: [SETUP_ACTION, ELEVATED_ACTION],
  })
}

/** core's vendor.codex.winSandbox detail for notConfigured (probe.ts, plain words). */
export const WIN_SANDBOX_SETUP_DETAIL =
  'The Codex Windows sandbox is not set up. Without it Codex cannot edit (it would silently run read-only) and cannot run shell reads.'

export const CODEX_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    source: 'cli',
    isDefault: true,
    efforts: ['low', 'medium', 'high'],
  },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', source: 'cli' },
]

// ---- core's mode copy (src/core/adapters/codex/capabilities.ts, word for word) ------------------------------------

export const APP_SERVER_COPY: Readonly<Record<Mode, string>> = {
  // The MCP gap is said in the read-only copy.
  readonly:
    'Read-only sandbox: reads files and runs commands that do not write; nothing asks you. ' +
    'MCP servers from your Codex settings still load, outside the sandbox.',
  autoedit:
    'Sandbox-gated: edits and in-sandbox commands run unprompted; network, outside writes and escalations ask you.',
  full: 'No sandbox and no questions: every command and edit runs without asking.',
}

export const EXEC_COPY: Readonly<Record<Mode, string>> = {
  readonly: APP_SERVER_COPY.readonly,
  autoedit:
    'Sandbox-gated: edits and in-sandbox commands run; escalations are auto-denied (no relay on this route).',
  full: APP_SERVER_COPY.full,
}

export const WIN_SANDBOX_READONLY_COPY =
  'Cannot run shell reads: the Codex Windows sandbox is not set up, so it reviews from the diff. ' +
  'MCP servers from your Codex settings still load, outside the sandbox.'
export const WIN_SANDBOX_AUTOEDIT_COPY =
  'Needs the Codex Windows sandbox, which is not set up: without it Codex silently runs read-only. ' +
  'Set it up from the Codex sandbox check.'
/** Full mode waits for the live X11 recording while the sandbox is not ready. */
export const WIN_SANDBOX_FULL_COPY =
  'Full access without the Codex Windows sandbox is not confirmed yet, so Dim Factory does not run it. ' +
  'Set the sandbox up from the Codex sandbox check.'

export type SandboxState = 'ready' | 'notConfigured' | 'unavailable' | 'n/a'

/** Codex's support per mode as core's table states it (the "Codex, Windows sandbox not ready" row). */
function codexSupport(mode: Mode, winSandbox: SandboxState, route: 'app-server' | 'exec'): Support {
  const notReady = winSandbox === 'notConfigured' || winSandbox === 'unavailable'
  if (notReady && mode === 'readonly')
    return { status: 'degraded', copy: WIN_SANDBOX_READONLY_COPY, reason: `winSandbox-${winSandbox}` }
  if (notReady && mode === 'autoedit')
    return { status: 'unsupported', copy: WIN_SANDBOX_AUTOEDIT_COPY, reason: `winSandbox-${winSandbox}` }
  if (notReady && mode === 'full')
    return { status: 'unsupported', copy: WIN_SANDBOX_FULL_COPY, reason: `winSandbox-${winSandbox}` }
  if (route === 'exec')
    return mode === 'autoedit'
      ? { status: 'degraded', copy: EXEC_COPY.autoedit, reason: 'no-relay' }
      : { status: 'supported', copy: EXEC_COPY[mode] }
  return { status: 'supported', copy: APP_SERVER_COPY[mode] }
}

/** Codex's capabilities as core's probe reports them (codexCapabilities). */
export function codexCaps(
  winSandbox: SandboxState,
  route: 'app-server' | 'exec' = 'app-server',
): Capabilities {
  return {
    planMode: route === 'app-server' ? 'native' : 'emulated',
    askRelay: route === 'app-server',
    resume: 'id',
    preassignSessionId: false,
    modelList: route === 'app-server' ? 'cli' : 'static',
    usageCumulative: true,
    allowSession: route === 'app-server' ? 'native' : 'app',
    web: true,
    resumeModelSwitch: true,
    reasoningIncludedInOutput: true,
    modes: {
      readonly: codexSupport('readonly', winSandbox, route),
      autoedit: codexSupport('autoedit', winSandbox, route),
      full: codexSupport('full', winSandbox, route),
    },
  }
}

export interface CodexOptions {
  sandbox?: 'ready' | 'notConfigured' | 'unavailable' | 'none'
  health?: VendorHealth
  route?: 'app-server' | 'exec'
  checks?: CheckResult[]
  over?: Partial<ProbeView>
}

/** Codex as core's probeView reports it: installed, logged in, 0.160.1 on the app-server route. */
export function codex(o: CodexOptions = {}): ProbeView {
  const sandbox = o.sandbox ?? 'notConfigured'
  const route = o.route ?? 'app-server'
  const checks = o.checks ?? [
    vcheck('bin', { title: 'Codex found' }),
    vcheck('version', { title: 'Codex 0.160.1' }),
    vcheck('auth', { title: 'Logged in with ChatGPT' }),
    vcheck('protocol', { title: 'app-server protocol 0.160.0' }),
    vcheck('plan', { title: 'Native plan mode' }),
    ...(sandbox === 'none' ? [] : [sandboxCheck(sandbox)]),
  ]
  const health: VendorHealth =
    o.health ?? (sandbox === 'notConfigured' || sandbox === 'unavailable' ? 'sandbox-needed' : 'ready')
  const state: SandboxState = sandbox === 'none' ? 'n/a' : sandbox
  return {
    vendor: 'codex',
    displayName: 'Codex',
    built: true,
    experimental: false,
    health,
    healthDetail: health === 'sandbox-needed' ? 'Sandbox setup needed' : 'Ready · 0.160.1',
    checking: false,
    versionFloor: '0.147.0',
    versionRecommended: '0.160.0',
    testedUpTo: '0.160.1',
    probe: {
      vendor: 'codex',
      at: NOW,
      ok: health === 'ready' || health === 'warning',
      route,
      transport: route === 'exec' ? 'codex-exec' : 'codex-app-server',
      version: '0.160.1',
      binary: {
        path: CODEX_EXE,
        command: CODEX_EXE,
        argvPrefix: [],
        kind: 'native',
        source: 'path',
        mtimeMs: 0,
        size: 0,
        pathPrepend: [],
        warnings: [],
      },
      checks,
      capabilities: codexCaps(state, route),
      models: CODEX_MODELS,
      account: { method: 'chatgpt' },
    },
    candidates: [CODEX_EXE],
    ...o.over,
  }
}

/** The same view, probed again later (core's re-probe after a setup). */
export function reprobed(view: ProbeView, dt = 1000): ProbeView {
  return view.probe === null ? view : { ...view, probe: { ...view.probe, at: view.probe.at + dt } }
}

export function setupOutcome(over: Partial<VendorSetupOutcome> = {}): VendorSetupOutcome {
  return { vendor: 'codex', ok: true, ready: true, detail: '', probed: true, ...over }
}

/** recovery.execute's answer for vendor_setup (core's message names the next step). */
export function setupResult(o: VendorSetupOutcome, message: string): RecoveryResult {
  return { kind: 'vendor_setup', message, setup: o }
}

export const SET_UP_MESSAGE = 'The Codex sandbox is set up.'
export const FAILED_MESSAGE =
  'The Codex sandbox setup failed. Access is denied. Try the elevated setup command.'
