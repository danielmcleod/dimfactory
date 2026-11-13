// Codex engine test helpers (the Codex adapter, refresh X17, self-heal and `vendor_setup`): an
// in-process Codex stand-in that records StartOptions and plays a script, runs a scripted Windows sandbox setup, and
// probe results shaped like the Codex adapter's (the winSandbox check carries the adapter's sandbox fixes).
import { BufferedEmitter } from '@core/adapters/errors.ts'
import type { Adapter, ExitInfo, RunHandle, StartOptions, StopReason } from '@core/adapters/types.ts'
import { unsupportedCapabilities } from '@core/adapters/registry.ts'
import type { AdapterSignal, NormalizedEvent, Usage } from '@shared/events.ts'
import type { RecoveryAction } from '@shared/failure.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { Mode } from '@shared/run.ts'
import type { Capabilities, ProbeResult, ReadinessNeed, Support } from '@shared/vendors.ts'

export type CodexScript = (h: CodexHandle, o: StartOptions) => void

export class CodexHandle implements RunHandle {
  readonly id = 'codex-h'
  readonly vendor = 'codex'
  readonly route: 'app-server' | 'exec'
  readonly pid = 5151
  readonly events = new BufferedEmitter<NormalizedEvent>()
  readonly signals = new BufferedEmitter<AdapterSignal>()
  readonly exited: Promise<ExitInfo>
  stopped: StopReason[] = []
  answers: { requestId: string; decision: string }[] = []
  done = false
  /** The thread id once the script assigned it (`thread/start` / `thread/resume` answered). */
  thread: string | undefined
  /** The thread's cumulative totals as last reported (`thread/tokenUsage/updated`). */
  total: Usage | undefined
  #exit: (e: ExitInfo) => void = () => undefined
  constructor(route: 'app-server' | 'exec' = 'app-server') {
    this.route = route
    this.exited = new Promise((resolve) => {
      this.#exit = resolve
    })
  }
  onEvent(cb: (e: NormalizedEvent) => void): () => void {
    return this.events.subscribe(cb)
  }
  onSignal(cb: (s: AdapterSignal) => void): () => void {
    return this.signals.subscribe(cb)
  }
  sessionId(): string | undefined {
    return this.thread
  }
  cumulativeUsage(): Usage | undefined {
    return this.total
  }
  pendingAsks(): string[] {
    return []
  }
  exit(code: number | null = 0, stoppedBy?: StopReason): void {
    if (this.done) return
    this.done = true
    this.#exit({
      code,
      signal: null,
      sawTerminal: true,
      ranMs: 5,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    })
  }
}

/** The Windows sandbox as the Codex probe reports it (`vendor.codex.winSandbox`). */
export type Sandbox = 'ready' | 'notConfigured'

const WIN_SANDBOX_COPY: Record<Mode, Support> = {
  readonly: {
    status: 'degraded',
    copy: 'Cannot run shell reads; reviews from the diff.',
    reason: 'winSandbox',
  },
  autoedit: {
    status: 'unsupported',
    copy: 'Needs the Codex Windows sandbox.',
    reason: 'winSandbox-notConfigured',
  },
  // Full waits for the live X11 recording too (capabilities.ts FULL_WITHOUT_WIN_SANDBOX).
  full: {
    status: 'unsupported',
    copy: 'Full access without the Codex Windows sandbox is not confirmed yet.',
    reason: 'winSandbox-notConfigured',
  },
}

/** The mode table for Codex app-server, with the "Windows sandbox not ready" row. */
export function codexSupportFor(sandbox: Sandbox, mode: Mode): Support {
  if (sandbox === 'notConfigured') return WIN_SANDBOX_COPY[mode]
  return { status: 'supported', copy: `codex ${mode}` }
}

export function codexCaps(sandbox: Sandbox = 'ready'): Capabilities {
  const caps = unsupportedCapabilities({ status: 'supported', copy: 'ok' })
  return {
    ...caps,
    planMode: 'native',
    askRelay: true,
    resume: 'id',
    preassignSessionId: false,
    modelList: 'cli',
    usageCumulative: true,
    allowSession: 'native',
    web: true,
    resumeModelSwitch: true,
    reasoningIncludedInOutput: true,
    modes: {
      readonly: codexSupportFor(sandbox, 'readonly'),
      autoedit: codexSupportFor(sandbox, 'autoedit'),
      full: codexSupportFor(sandbox, 'full'),
    },
  }
}

const check = (id: string, status: CheckResult['status'], o: Partial<CheckResult> = {}): CheckResult => ({
  id,
  scope: 'vendor',
  status,
  blocking: status === 'fail' && o.blocking !== false,
  title: id,
  detail: '',
  recovery: [],
  at: 1,
  ttlMs: 600_000,
  ...o,
})

/** The fixes the Codex probe offers on a sandbox that is not ready (vendor_setup, then the elevated copy). */
export function sandboxFixes(): RecoveryAction[] {
  return [
    {
      id: 'vendor.codex.winSandbox.setup',
      label: 'Set up the Codex sandbox',
      kind: 'vendor_setup',
      vendor: 'codex',
      call: 'windowsSandbox/setupStart',
      params: { mode: 'unelevated' },
    },
    {
      id: 'vendor.codex.winSandbox.elevated',
      label: 'Copy elevated setup command',
      kind: 'shell_copy',
      command: 'codex sandbox setup --elevated --current-user',
      shell: 'powershell',
      reason: 'Run in an administrator terminal, then re-check.',
      recheck: 'vendor.codex.winSandbox',
      elevated: true,
    },
  ]
}

/** A Codex probe: installed, logged in with ChatGPT, the sandbox as given (a non-blocking check). */
export function codexProbe(
  o: {
    sandbox?: Sandbox
    ok?: boolean
    auth?: 'pass' | 'fail'
    models?: ProbeResult['models']
    /** The route the probe found (default the app-server's; `exec` is the fallback, which reports no model). */
    route?: 'app-server' | 'exec'
  } = {},
): ProbeResult {
  const sandbox = o.sandbox ?? 'ready'
  const auth = o.auth ?? 'pass'
  const checks: CheckResult[] = [
    check('vendor.codex.bin', 'pass'),
    check('vendor.codex.version', 'pass'),
    check(
      'vendor.codex.auth',
      auth,
      auth === 'fail' ? { title: 'Login needed', category: 'auth_required' } : {},
    ),
    check('vendor.codex.protocol', 'pass'),
    check('vendor.codex.plan', 'pass'),
    check(
      'vendor.codex.winSandbox',
      sandbox === 'ready' ? 'pass' : 'fail',
      sandbox === 'ready'
        ? {}
        : {
            blocking: false,
            category: 'sandbox_unavailable',
            title: 'Codex Windows sandbox not set up',
            detail: 'The Codex Windows sandbox is not set up.',
            recovery: sandboxFixes(),
          },
    ),
  ]
  return {
    vendor: 'codex',
    at: 1,
    ok: o.ok ?? !checks.some((c) => c.status === 'fail' && c.blocking),
    route: o.route ?? 'app-server',
    transport: o.route === 'exec' ? 'codex-exec' : 'codex-app-server',
    version: '0.160.1',
    checks,
    capabilities: codexCaps(sandbox),
    models: o.models ?? [{ id: 'gpt-5.6-sol', isDefault: true, source: 'cli' }],
    account: { method: 'chatgpt' },
  }
}

/** What the scripted sandbox setup answers (default: it works and the sandbox reads ready afterwards). */
export type SetupScript = (
  call: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{
  ok: boolean
  detail: string
}>

/** An in-process Codex: probe and support() from the given sandbox state, scripted runs and sandbox setup. */
export class ScriptedCodex implements Adapter {
  readonly id = 'codex'
  readonly displayName = 'Codex'
  readonly transport = 'codex-app-server' as const
  readonly managedFlags: readonly string[] = ['--sandbox', '-s', '--model', '-m', '--ephemeral']
  readonly testedUpTo = '0.160.1'
  readonly versionFloor = '0.147.0'
  readonly versionRecommended = '0.160.0'
  starts: StartOptions[] = []
  handles: CodexHandle[] = []
  probes = 0
  sandbox: Sandbox
  auth: 'pass' | 'fail'
  /** Every vendorSetup call (call, params), in order. */
  setups: { call: string; params: Record<string, unknown> }[] = []
  /** canResume's answers by thread id (absent: ok). */
  resumable = new Map<string, { ok: boolean; reason?: 'cannot-resume' }>()
  setupScript: SetupScript = () => {
    this.sandbox = 'ready'
    return Promise.resolve({ ok: true, detail: 'The sandbox is set up.' })
  }
  /** The probe's model list (default codexProbe's; the live balanced run: the account's list, with its default). */
  models: ProbeResult['models'] | undefined
  /** The route the probe reports and each handle runs on (default the app-server's). */
  route: 'app-server' | 'exec'
  #script: CodexScript
  constructor(
    script: CodexScript,
    o: {
      sandbox?: Sandbox
      auth?: 'pass' | 'fail'
      models?: ProbeResult['models']
      route?: 'app-server' | 'exec'
    } = {},
  ) {
    this.#script = script
    this.sandbox = o.sandbox ?? 'ready'
    this.auth = o.auth ?? 'pass'
    this.models = o.models
    this.route = o.route ?? 'app-server'
  }
  set script(s: CodexScript) {
    this.#script = s
  }
  /** vendor_setup: `windowsSandbox/setupStart` over a private app-server (scripted here). */
  vendorSetup(
    call: 'windowsSandbox/setupStart',
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; detail: string }> {
    this.setups.push({ call, params })
    return this.setupScript(call, params, signal)
  }
  probe(): Promise<ProbeResult> {
    this.probes++
    return Promise.resolve(
      codexProbe({
        sandbox: this.sandbox,
        auth: this.auth,
        route: this.route,
        ...(this.models !== undefined ? { models: this.models } : {}),
      }),
    )
  }
  readiness(): Promise<CheckResult[]> {
    return Promise.resolve([])
  }
  support(need: ReadinessNeed): Support {
    const readOnlyStep = ['plan', 'review', 'critic', 'heal', 'catalog'].includes(need.pass)
    return codexSupportFor(this.sandbox, readOnlyStep ? 'readonly' : need.mode)
  }
  canResume(sessionId: string): Promise<{ ok: boolean; reason?: 'cannot-resume' }> {
    return Promise.resolve(this.resumable.get(sessionId) ?? { ok: true })
  }
  start(o: StartOptions): RunHandle {
    this.starts.push(o)
    const h = new CodexHandle(this.route)
    this.handles.push(h)
    this.#script(h, o)
    return h
  }
  answer(h: RunHandle, requestId: string, decision: string): void {
    ;(h as CodexHandle).answers.push({ requestId, decision })
  }
  stop(h: RunHandle, reason: StopReason): Promise<void> {
    const c = h as CodexHandle
    c.stopped.push(reason)
    c.events.emit({ type: 'error', message: 'Stopped', raw: '', fatal: true, category: 'user_cancelled' })
    c.exit(null, reason)
    return Promise.resolve()
  }
  listModels(): Promise<ProbeResult['models']> {
    return Promise.resolve([])
  }
}

/** A run that never answers (it only reports its thread). */
export const codexHangs: CodexScript = (h) => {
  queueMicrotask(() => h.events.emit({ type: 'session', id: 'thr_hang' }))
}
