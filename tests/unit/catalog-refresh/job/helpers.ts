// Refresh-job test helpers: an in-process scripted adapter (records StartOptions,
// answers, stops) and a catalog built from the shipped seed.
import { BufferedEmitter } from '../../../../src/core/adapters/errors.ts'
import type {
  Adapter,
  ExitInfo,
  RunHandle,
  StartOptions,
  StopReason,
} from '../../../../src/core/adapters/types.ts'
import { MANAGED_FLAGS } from '../../../../src/core/adapters/claude/capabilities.ts'
import type { CatalogData } from '../../../../src/core/catalog/store.ts'
import { loadSeedPricing } from '../../../../src/core/catalog/store.ts'
import type { AdapterSignal, NormalizedEvent } from '../../../../src/shared/events.ts'

export type Script = (h: ScriptedHandle, o: StartOptions) => void

export class ScriptedHandle implements RunHandle {
  readonly id = 'h1'
  readonly vendor = 'claude'
  readonly route = 'stdio' as const
  readonly pid = 4242
  readonly events = new BufferedEmitter<NormalizedEvent>()
  readonly signals = new BufferedEmitter<AdapterSignal>()
  readonly exited: Promise<ExitInfo>
  answers: { requestId: string; decision: string }[] = []
  stopped: StopReason[] = []
  done = false
  #exit: (e: ExitInfo) => void = () => undefined
  constructor() {
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
    return undefined
  }
  cumulativeUsage(): undefined {
    return undefined
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

export class ScriptedAdapter implements Adapter {
  readonly id = 'claude'
  readonly displayName = 'Claude'
  readonly transport = 'claude-stdio' as const
  readonly managedFlags: readonly string[] = MANAGED_FLAGS
  readonly testedUpTo = '2.1.289'
  readonly versionFloor = '2.1.281'
  readonly versionRecommended = '2.1.287'
  starts: StartOptions[] = []
  handles: ScriptedHandle[] = []
  #script: Script
  constructor(script: Script) {
    this.#script = script
  }
  set script(s: Script) {
    this.#script = s
  }
  probe(): ReturnType<Adapter['probe']> {
    return Promise.resolve({
      vendor: 'claude',
      at: 0,
      ok: true,
      checks: [],
      capabilities: {} as never,
      models: [],
    })
  }
  readiness(): ReturnType<Adapter['readiness']> {
    return Promise.resolve([])
  }
  support(): ReturnType<Adapter['support']> {
    return { status: 'supported', copy: '' }
  }
  canResume(): ReturnType<Adapter['canResume']> {
    return Promise.resolve({ ok: false })
  }
  start(o: StartOptions): RunHandle {
    this.starts.push(o)
    const h = new ScriptedHandle()
    this.handles.push(h)
    this.#script(h, o)
    return h
  }
  answer(h: RunHandle, requestId: string, decision: string): void {
    ;(h as ScriptedHandle).answers.push({ requestId, decision })
  }
  stop(h: RunHandle, reason: StopReason): Promise<void> {
    const s = h as ScriptedHandle
    s.stopped.push(reason)
    // As the real adapter does: the stop ends the turn with a fatal error, then the process exits.
    s.events.emit({
      type: 'error',
      message: reason === 'timeout' ? 'Stopped (timeout)' : 'Stopped by the user',
      raw: '',
      fatal: true,
      category: reason === 'timeout' ? 'timeout_hard' : 'user_cancelled',
    })
    s.exit(null, reason)
    return Promise.resolve()
  }
  listModels(): ReturnType<Adapter['listModels']> {
    return Promise.resolve([])
  }
}

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'

export const PROPOSAL = {
  generatedAt: '2026-10-09T09:14:02Z',
  entries: [
    {
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      aliases: ['sonnet'],
      inputPerMTok: 2.5,
      outputPerMTok: 12.5,
      cacheReadPerMTok: 0.25,
      cacheWritePerMTok: 5,
      sourceUrl: PRICING_URL,
      sourceQuote: 'Claude Sonnet 5.5 | $2.50 / MTok',
    },
  ],
  newModels: [],
  unverifiable: [],
}

/** Answer with structured output (C17's shape), after a web search and an official page. */
export const answersStructured =
  (
    value: unknown = PROPOSAL,
    usage = { input: 10, output: 1600, cacheRead: 175_310, cacheWrite: 27_600, costUsd: 0.15 },
  ): Script =>
  (h) => {
    queueMicrotask(() => {
      h.events.emit({ type: 'session', id: 's' })
      h.events.emit({ type: 'tool', id: 't1', name: 'WebSearch', summary: 'claude pricing', phase: 'start' })
      h.events.emit({
        type: 'tool',
        id: 't1',
        name: 'WebSearch',
        summary: 'claude pricing',
        phase: 'end',
        status: 'ok',
      })
      h.events.emit({ type: 'tool', id: 't2', name: 'WebFetch', summary: PRICING_URL, phase: 'start' })
      h.events.emit({
        type: 'tool',
        id: 't2',
        name: 'WebFetch',
        summary: PRICING_URL,
        phase: 'end',
        status: 'ok',
      })
      h.events.emit({
        type: 'tool',
        id: 't3',
        name: 'StructuredOutput',
        summary: 'answer ready',
        phase: 'start',
      })
      h.signals.emit({ type: 'meta', key: 'structuredOutput', value })
      h.events.emit({ type: 'done', result: '', usage })
      h.exit(0)
    })
  }

/** Answer in text only (C18a's shape). */
export const answersText =
  (text: string): Script =>
  (h) => {
    queueMicrotask(() => {
      h.events.emit({ type: 'session', id: 's' })
      h.events.emit({ type: 'text', delta: text })
      h.events.emit({ type: 'done', result: text })
      h.exit(0)
    })
  }

/** Never answers (the timeout or a cancel stops it). */
export const hangs: Script = (h) => {
  queueMicrotask(() => h.events.emit({ type: 'session', id: 's' }))
}

export async function seedCatalog(): Promise<CatalogData> {
  return {
    pricing: await loadSeedPricing(),
    models: { schemaVersion: 1, updatedAt: 0, vendors: {} },
  }
}

export const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
