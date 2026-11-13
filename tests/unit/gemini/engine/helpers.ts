// Gemini engine test helpers (the ACP base + Gemini, the Gemini ACP mode row, Readiness
// `trust`, sessions "ACP: from the session/new response, before session/prompt", trust.json `vendorFolder`): an
// in-process Gemini stand-in shaped like the ACP adapter as the engine sees it. It records StartOptions, answers its
// readiness `trust` check from `ReadinessNeed.trustFolder` (a grant action when the folder is not trusted), rejects every
// permission request itself on a read-only pass (an `auto-answered` signal, never an ask), and plays a script.
import { BufferedEmitter } from '@core/adapters/errors.ts'
import type { Adapter, ExitInfo, RunHandle, StartOptions, StopReason } from '@core/adapters/types.ts'
import { unsupportedCapabilities } from '@core/adapters/registry.ts'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '@shared/events.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { Mode } from '@shared/run.ts'
import type { Capabilities, ProbeResult, ReadinessNeed, Support } from '@shared/vendors.ts'

export type GeminiScript = (h: GeminiHandle, o: StartOptions, g: ScriptedGemini) => void

export class GeminiHandle implements RunHandle {
  readonly id: string
  readonly vendor = 'gemini'
  readonly route = 'acp' as const
  readonly pid = 6161
  readonly events = new BufferedEmitter<NormalizedEvent>()
  readonly signals = new BufferedEmitter<AdapterSignal>()
  readonly exited: Promise<ExitInfo>
  stopped: StopReason[] = []
  answers: { requestId: string; decision: AskDecision }[] = []
  done = false
  session: string | undefined
  #pending = new Set<string>()
  #exit: (e: ExitInfo) => void = () => undefined
  constructor(id: string) {
    this.id = id
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
    return this.session
  }
  /** ACP PromptResponse usage is per prompt (not a running total): nothing cumulative to report. */
  cumulativeUsage(): Usage | undefined {
    return undefined
  }
  pendingAsks(): string[] {
    return [...this.#pending]
  }
  raise(requestId: string): void {
    this.#pending.add(requestId)
  }
  settle(requestId: string): void {
    this.#pending.delete(requestId)
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

/** The mode table, Gemini ACP row (plain words, no em dashes). */
export const GEMINI_MODE_COPY: Record<Mode, Support> = {
  readonly: {
    status: 'supported',
    copy: 'reads and searches; every request to change something is rejected',
  },
  autoedit: { status: 'supported', copy: 'edits auto; shell and other tools ask you' },
  full: { status: 'supported', copy: 'everything auto (yolo)' },
}

/** What the agent advertised at initialize ("session/resume if advertised, else session/load"). */
export type GeminiResume = 'load' | 'none'

export function geminiCaps(resume: GeminiResume = 'load'): Capabilities {
  return {
    ...unsupportedCapabilities({ status: 'supported', copy: 'ok' }),
    planMode: 'native',
    askRelay: true,
    resume,
    preassignSessionId: false,
    modelList: 'cli',
    usageCumulative: false,
    allowSession: 'native',
    web: false,
    resumeModelSwitch: false,
    reasoningIncludedInOutput: false,
    modes: GEMINI_MODE_COPY,
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

export const GEMINI_DEFAULT_MODEL = 'gemini-3-pro-preview'

/** A Gemini probe: installed (system node), signed in with Google, the ACP handshake and `plan` mode present. */
export function geminiProbe(
  o: { ok?: boolean; auth?: 'pass' | 'fail'; resume?: GeminiResume; models?: ProbeResult['models'] } = {},
): ProbeResult {
  const auth = o.auth ?? 'pass'
  const checks: CheckResult[] = [
    check('vendor.gemini.bin', 'pass'),
    check('vendor.gemini.version', 'pass'),
    check(
      'vendor.gemini.auth',
      auth,
      auth === 'fail' ? { title: 'Gemini sign-in needed', category: 'auth_required' } : {},
    ),
    check('vendor.gemini.protocol', 'pass'),
    check('vendor.gemini.plan', 'pass'),
  ]
  return {
    vendor: 'gemini',
    at: 1,
    ok: o.ok ?? !checks.some((c) => c.status === 'fail' && c.blocking),
    route: 'acp',
    transport: 'acp',
    version: '0.62.0',
    checks,
    capabilities: geminiCaps(o.resume ?? 'load'),
    models: o.models ?? [{ id: GEMINI_DEFAULT_MODEL, isDefault: true, source: 'cli' }],
    account: { method: 'oauth-personal' },
  }
}

/** The ACP adapter's readiness TTL (acp-base READINESS_TTL_MS): a grant must not wait for it to run out. */
export const READINESS_TTL_MS = 60_000

/**
 * The readiness `trust` check: pass with a grant, else a blocking failure offering the grant. Like the ACP
 * adapter's: one action id for every pass (`gemini.trust-folder`) and cached for READINESS_TTL_MS, so a grant has to
 * clear the cached checks of every pass it covers.
 */
export function trustCheck(need: ReadinessNeed, cwd: string): CheckResult {
  const id = `pass.${need.pass}.readiness.trust`
  if (need.trustFolder) {
    return check(id, 'pass', { scope: 'pass', title: 'Folder trusted for Gemini', ttlMs: READINESS_TTL_MS })
  }
  return check(id, 'fail', {
    scope: 'pass',
    category: 'trust_required',
    title: 'Folder not trusted for Gemini',
    detail: `Gemini runs in ${cwd} only once you trust this folder for it.`,
    ttlMs: READINESS_TTL_MS,
    recovery: [
      {
        id: 'gemini.trust-folder',
        label: 'Trust this folder for Gemini',
        kind: 'grant',
        grant: 'vendorFolder',
        vendor: 'gemini',
        detail: cwd,
      },
    ],
  })
}

/** An in-process Gemini over ACP as the engine sees it. */
export class ScriptedGemini implements Adapter {
  readonly id = 'gemini'
  readonly displayName = 'Gemini'
  readonly transport = 'acp' as const
  readonly managedFlags: readonly string[] = ['--acp', '--model', '-m', '--skip-trust']
  readonly testedUpTo = '0.62.0'
  readonly versionFloor = '0.62.0'
  readonly versionRecommended = '0.62.0'
  starts: StartOptions[] = []
  handles: GeminiHandle[] = []
  readinessCalls: { cwd: string; need: ReadinessNeed }[] = []
  canResumeCalls: { sessionId: string; cwd: string }[] = []
  probes = 0
  resume: GeminiResume
  auth: 'pass' | 'fail'
  /** Readiness runs the `trust` check (false: a stand-in whose readiness never asks, so only the CLI's exit 55 can). */
  checkTrust: boolean
  /** canResume's answers by session id (absent: ok). */
  resumable = new Map<string, { ok: boolean; reason?: 'cannot-resume' }>()
  #script: GeminiScript
  #n = 0
  constructor(
    script: GeminiScript,
    o: { resume?: GeminiResume; auth?: 'pass' | 'fail'; checkTrust?: boolean } = {},
  ) {
    this.#script = script
    this.resume = o.resume ?? 'load'
    this.auth = o.auth ?? 'pass'
    this.checkTrust = o.checkTrust ?? true
  }
  set script(s: GeminiScript) {
    this.#script = s
  }
  probe(): Promise<ProbeResult> {
    this.probes++
    return Promise.resolve(geminiProbe({ auth: this.auth, resume: this.resume }))
  }
  readiness(cwd: string, need: ReadinessNeed): Promise<CheckResult[]> {
    this.readinessCalls.push({ cwd, need })
    return Promise.resolve(this.checkTrust ? [trustCheck(need, cwd)] : [])
  }
  support(need: ReadinessNeed): Support {
    const readOnlyStep = ['plan', 'review', 'critic', 'heal', 'catalog'].includes(need.pass)
    return GEMINI_MODE_COPY[readOnlyStep ? 'readonly' : need.mode]
  }
  canResume(sessionId: string, cwd: string): Promise<{ ok: boolean; reason?: 'cannot-resume' }> {
    this.canResumeCalls.push({ sessionId, cwd })
    return Promise.resolve(this.resumable.get(sessionId) ?? { ok: true })
  }
  start(o: StartOptions): RunHandle {
    this.starts.push(o)
    const h = new GeminiHandle(`gemini-h${++this.#n}`)
    this.handles.push(h)
    this.#script(h, o, this)
    return h
  }
  answer(h: RunHandle, requestId: string, decision: AskDecision): void {
    const g = h as GeminiHandle
    g.answers.push({ requestId, decision })
    g.settle(requestId)
  }
  stop(h: RunHandle, reason: StopReason): Promise<void> {
    const g = h as GeminiHandle
    g.stopped.push(reason)
    g.events.emit({ type: 'error', message: 'Stopped', raw: '', fatal: true, category: 'user_cancelled' })
    g.exit(null, reason)
    return Promise.resolve()
  }
  listModels(): Promise<ProbeResult['models']> {
    return Promise.resolve([{ id: GEMINI_DEFAULT_MODEL, isDefault: true, source: 'cli' }])
  }
}

/**
 * Permissions order 2: a read-only pass rejects every request itself (`reject_once`), reported as an
 * `auto-answered` signal with why `readonly` and the tool line declined; the engine never sees an ask.
 */
export function rejectReadOnly(h: GeminiHandle, toolCallId: string, tool: string, title: string): void {
  h.events.emit({ type: 'tool', id: toolCallId, name: tool, summary: title, phase: 'start' })
  h.signals.emit({
    type: 'auto-answered',
    requestId: `${h.id}:${toolCallId}`,
    decision: 'deny',
    tool,
    why: 'readonly',
  })
  h.events.emit({
    type: 'tool',
    id: toolCallId,
    name: tool,
    summary: title,
    phase: 'end',
    status: 'declined',
  })
}

/** One Gemini prompt turn: session/new (or the resumed id) → onSession awaited → the turn's events → done. */
export interface GeminiTurn {
  text?: string
  file?: string
  usage?: Usage
  /** Permission requests the agent raises during the turn (a read-only pass rejects them itself). */
  asks?: { toolCallId: string; tool: string; title: string }[]
}
