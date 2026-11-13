// Live vendor streams, kept outside React (performance: streams live in streamBuffer
// with one version bump per animation frame; StreamPane keeps the last 400 blocks). Per run, per (step, attempt):
// ordered blocks built from RunEnvelopes. Applying is idempotent by seq (envelopes with seq ≤ the run's last
// applied seq are ignored), so a replay may overlap live delivery without duplicating anything (reload-mid-stream.spec.ts).
import { useCallback, useSyncExternalStore } from 'react'
import type { AskDecision, AskKind, AutoAnswerReason, ToolStatus, Usage } from '@shared/events.ts'
import type { FailureCategory } from '@shared/failure.ts'
import type { AnswerVia, AskResolvedBy, RunEnvelope, StepKey } from '@shared/run.ts'

export const STREAM_BLOCK_CAP = 400
/** A text block past this many characters ends at the next newline (keeps blocks small for the 400-block cap). */
export const TEXT_BLOCK_SOFT_CHARS = 2000
/** No text block grows past this, newline or not. */
export const TEXT_BLOCK_HARD_CHARS = 8000
/** Unfocused runs whose streams stay cached (re-opening a run replays only what it missed). */
export const CACHED_RUNS = 6

interface BlockBase {
  /** Unique and increasing within one stream; use it as the React key. */
  id: number
  /** Seq of the envelope that created the block. */
  seq: number
  /** Envelope timestamp (core clock) of the envelope that created the block. */
  ts: number
}

export type ToolRowStatus = 'running' | ToolStatus

export interface AskResolution {
  by: AskResolvedBy
  decision?: AskDecision
  via?: AnswerVia
  at: number
}

export type StreamBlock =
  /** Consecutive deltas, coalesced. A long run of text continues in the next text block (split after a newline). */
  | (BlockBase & { kind: 'text'; text: string })
  | (BlockBase & {
      kind: 'tool'
      toolId?: string
      name: string
      summary: string
      status: ToolRowStatus
      startedAt: number
      endedAt?: number
    })
  | (BlockBase & {
      kind: 'ask'
      requestId: string
      askKind: AskKind
      detail: string
      reason?: string
      expiresAt: number
      allowSession: boolean
      defaultToNo?: boolean
      resolved?: AskResolution
    })
  /** An ask Dim Factory answered itself (read-only pass, allow-cache, plan capture). */
  | (BlockBase & {
      kind: 'auto'
      requestId?: string
      tool: string
      decision: AskDecision
      why: AutoAnswerReason
    })
  | (BlockBase & { kind: 'error'; message: string; fatal: boolean; category?: FailureCategory })
  | (BlockBase & { kind: 'done'; result: string; usage?: Usage })

export type StreamBlockKind = StreamBlock['kind']

/** Immutable view of one stream; a new object only after a change (at most one per animation frame). */
export interface StreamSnapshot {
  runId: string
  step: StepKey
  /** The attempt shown; null while the step has no stream yet. */
  attempt: number | null
  /** Every attempt of this step seen so far, ascending. */
  attempts: readonly number[]
  /** The last STREAM_BLOCK_CAP blocks. */
  blocks: readonly StreamBlock[]
  /** Blocks dropped from the front by the cap. */
  dropped: number
  version: number
  /** Timestamp of the first vendor event of this attempt (null before any output). */
  firstOutputAt: number | null
  /** A `done` event arrived. */
  done: boolean
}

type Scheduler = (cb: () => void) => void

export interface StreamBufferOptions {
  /** How a notification is deferred (default: requestAnimationFrame, else a 16 ms timeout). */
  schedule?: Scheduler
  cap?: number
}

function defaultSchedule(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

class Stream {
  readonly runId: string
  readonly step: StepKey
  readonly attempt: number
  blocks: StreamBlock[] = []
  dropped = 0
  nextId = 1
  version = 0
  snap: StreamSnapshot | null = null
  firstOutputAt: number | null = null
  done = false
  readonly tools = new Map<string, number>()
  readonly #text: string[] = []
  #textJoined: string | null = ''

  constructor(runId: string, step: StepKey, attempt: number) {
    this.runId = runId
    this.step = step
    this.attempt = attempt
  }

  appendFullText(delta: string): void {
    this.#text.push(delta)
    this.#textJoined = null
  }

  fullText(): string {
    if (this.#textJoined === null) {
      const joined = this.#text.join('')
      this.#text.length = 0
      this.#text.push(joined)
      this.#textJoined = joined
    }
    return this.#textJoined
  }

  indexOf(blockId: number): number {
    const first = this.blocks[0]
    if (first === undefined) return -1
    const i = blockId - first.id
    return i >= 0 && i < this.blocks.length ? i : -1
  }
}

class RunStreams {
  lastSeq = 0
  touched = 0
  readonly steps = new Map<StepKey, Map<number, Stream>>()
  /** requestId → the stream holding its ask marker. */
  readonly asks = new Map<string, Stream>()
}

const EMPTY_ATTEMPTS: readonly number[] = Object.freeze([])

export class StreamBuffer {
  readonly #runs = new Map<string, RunStreams>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #anyListeners = new Set<() => void>()
  readonly #dirty = new Set<Stream>()
  readonly #empty = new Map<string, StreamSnapshot>()
  readonly #schedule: Scheduler
  readonly #cap: number
  #scheduled = false
  #tick = 0

  constructor(opts: StreamBufferOptions = {}) {
    this.#schedule = opts.schedule ?? defaultSchedule
    this.#cap = Math.max(1, opts.cap ?? STREAM_BLOCK_CAP)
  }

  /** Highest seq applied for a run (0 when nothing was). Replays start here. */
  lastSeq(runId: string): number {
    return this.#runs.get(runId)?.lastSeq ?? 0
  }

  hasRun(runId: string): boolean {
    return this.#runs.has(runId)
  }

  /** Apply one envelope. Returns false when it was already applied (seq ≤ the run's last seq). */
  apply(env: RunEnvelope): boolean {
    let run = this.#runs.get(env.runId)
    if (run === undefined) {
      run = new RunStreams()
      this.#runs.set(env.runId, run)
    }
    if (env.seq <= run.lastSeq) return false
    run.lastSeq = env.seq
    run.touched = ++this.#tick
    this.#applyBody(run, env)
    return true
  }

  applyAll(envs: readonly RunEnvelope[]): void {
    for (const e of envs) this.apply(e)
  }

  #stream(run: RunStreams, runId: string, step: StepKey, attempt: number): Stream {
    let byAttempt = run.steps.get(step)
    if (byAttempt === undefined) {
      byAttempt = new Map()
      run.steps.set(step, byAttempt)
    }
    let s = byAttempt.get(attempt)
    if (s === undefined) {
      s = new Stream(runId, step, attempt)
      byAttempt.set(attempt, s)
      // Every snapshot of this step lists the attempts, so all of them change.
      for (const other of byAttempt.values()) this.#markDirty(other)
    }
    return s
  }

  #applyBody(run: RunStreams, env: RunEnvelope): void {
    const b = env.body
    switch (b.t) {
      case 'ev': {
        const s = this.#stream(run, env.runId, b.step, b.attempt)
        const ev = b.ev
        switch (ev.type) {
          case 'session':
            return
          case 'text':
            if (ev.delta === '') return
            this.#output(s, env)
            s.appendFullText(ev.delta)
            this.#appendText(s, ev.delta, env)
            break
          case 'tool':
            this.#output(s, env)
            this.#tool(s, ev, env)
            break
          case 'ask':
            this.#output(s, env)
            this.#push(s, {
              kind: 'ask',
              id: 0,
              seq: env.seq,
              ts: env.ts,
              requestId: ev.requestId,
              askKind: ev.kind,
              detail: ev.detail,
              ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
              expiresAt: ev.expiresAt,
              allowSession: ev.allowSession,
              ...(ev.defaultToNo !== undefined ? { defaultToNo: ev.defaultToNo } : {}),
            })
            run.asks.set(ev.requestId, s)
            break
          case 'done':
            this.#output(s, env)
            s.done = true
            this.#push(s, {
              kind: 'done',
              id: 0,
              seq: env.seq,
              ts: env.ts,
              result: ev.result,
              ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
            })
            break
          case 'error':
            this.#output(s, env)
            this.#push(s, {
              kind: 'error',
              id: 0,
              seq: env.seq,
              ts: env.ts,
              message: ev.message,
              fatal: ev.fatal,
              ...(ev.category !== undefined ? { category: ev.category } : {}),
            })
            break
        }
        this.#markDirty(s)
        return
      }
      case 'auto-answered': {
        const s = this.#stream(run, env.runId, b.step, b.attempt)
        this.#push(s, {
          kind: 'auto',
          id: 0,
          seq: env.seq,
          ts: env.ts,
          ...(b.requestId !== undefined ? { requestId: b.requestId } : {}),
          tool: b.tool,
          decision: b.decision,
          why: b.why,
        })
        this.#markDirty(s)
        return
      }
      case 'ask-resolved': {
        const resolved: AskResolution = {
          by: b.by,
          at: env.ts,
          ...(b.decision !== undefined ? { decision: b.decision } : {}),
          ...(b.via !== undefined ? { via: b.via } : {}),
        }
        this.#updateAsk(run, b.requestId, (blk) => ({ ...blk, resolved }))
        return
      }
      case 'ask-extended':
        this.#updateAsk(run, b.requestId, (blk) => ({ ...blk, expiresAt: b.expiresAt }))
        return
      case 'step-status':
        // A new attempt gets its (empty) stream at once, so the view switches to it before any output.
        if (b.attempt >= 1) this.#stream(run, env.runId, b.step, b.attempt)
        return
      case 'run-status':
      case 'card':
      case 'snag':
      case 'usage':
      case 'context':
      case 'diff-stats':
      case 'output':
      case 'guardrail':
        return
    }
  }

  #output(s: Stream, env: RunEnvelope): void {
    if (s.firstOutputAt === null) s.firstOutputAt = env.ts
  }

  #updateAsk(
    run: RunStreams,
    requestId: string,
    f: (b: Extract<StreamBlock, { kind: 'ask' }>) => StreamBlock,
  ): void {
    const s = run.asks.get(requestId)
    if (s === undefined) return
    for (let i = s.blocks.length - 1; i >= 0; i--) {
      const blk = s.blocks[i]
      if (blk?.kind === 'ask' && blk.requestId === requestId) {
        s.blocks[i] = f(blk)
        this.#markDirty(s)
        return
      }
    }
  }

  #push(s: Stream, block: StreamBlock): StreamBlock {
    const b = { ...block, id: s.nextId++ }
    s.blocks.push(b)
    const over = s.blocks.length - this.#cap
    if (over > 0) {
      s.blocks.splice(0, over)
      s.dropped += over
    }
    return b
  }

  #appendText(s: Stream, delta: string, env: RunEnvelope): void {
    let rest = delta
    let forceNew = false
    while (rest.length > 0) {
      const last = s.blocks.at(-1)
      if (forceNew || last?.kind !== 'text' || last.text.length >= TEXT_BLOCK_HARD_CHARS) {
        const take = Math.min(rest.length, TEXT_BLOCK_HARD_CHARS)
        this.#push(s, { kind: 'text', id: 0, seq: env.seq, ts: env.ts, text: rest.slice(0, take) })
        rest = rest.slice(take)
        forceNew = false
        continue
      }
      const len = last.text.length
      let take = Math.min(rest.length, TEXT_BLOCK_HARD_CHARS - len)
      if (len >= TEXT_BLOCK_SOFT_CHARS) {
        const nl = rest.indexOf('\n')
        if (nl !== -1 && nl + 1 <= take) {
          take = nl + 1
          forceNew = true
        }
      }
      s.blocks[s.blocks.length - 1] = { ...last, text: last.text + rest.slice(0, take) }
      rest = rest.slice(take)
    }
  }

  #tool(
    s: Stream,
    ev: { id?: string; name: string; summary: string; phase?: 'start' | 'end'; status?: ToolStatus },
    env: RunEnvelope,
  ): void {
    if (ev.phase === 'end' && ev.id !== undefined) {
      const blockId = s.tools.get(ev.id)
      s.tools.delete(ev.id)
      const i = blockId === undefined ? -1 : s.indexOf(blockId)
      const blk = i === -1 ? undefined : s.blocks[i]
      if (blk?.kind === 'tool') {
        s.blocks[i] = {
          ...blk,
          status: ev.status ?? 'ok',
          endedAt: env.ts,
          summary: blk.summary !== '' ? blk.summary : ev.summary,
        }
        return
      }
    }
    // A `start` for a row that is still running is its progress (a subagent's type, last tool and tokens): the row
    // keeps its place and takes the new summary.
    if (ev.phase === 'start' && ev.id !== undefined) {
      const blockId = s.tools.get(ev.id)
      const i = blockId === undefined ? -1 : s.indexOf(blockId)
      const blk = i === -1 ? undefined : s.blocks[i]
      if (blk?.kind === 'tool') {
        s.blocks[i] = { ...blk, name: ev.name, summary: ev.summary }
        return
      }
    }
    const running = ev.phase === 'start'
    const b = this.#push(s, {
      kind: 'tool',
      id: 0,
      seq: env.seq,
      ts: env.ts,
      ...(ev.id !== undefined ? { toolId: ev.id } : {}),
      name: ev.name,
      summary: ev.summary,
      status: running ? 'running' : (ev.status ?? 'ok'),
      startedAt: env.ts,
      ...(running ? {} : { endedAt: env.ts }),
    })
    if (running && ev.id !== undefined) s.tools.set(ev.id, b.id)
  }

  #markDirty(s: Stream): void {
    this.#dirty.add(s)
    if (this.#scheduled) return
    this.#scheduled = true
    this.#schedule(() => this.flush())
  }

  /** Publish pending changes now: one version bump per changed stream, then notify. */
  flush(): void {
    this.#scheduled = false
    if (this.#dirty.size === 0) return
    const keys = new Set<string>()
    for (const s of this.#dirty) {
      s.version++
      s.snap = null
      keys.add(stepKey(s.runId, s.step))
    }
    this.#dirty.clear()
    if (this.#empty.size > 0) {
      for (const k of [...this.#empty.keys()])
        if (keys.has(k.slice(0, k.lastIndexOf('\u0000')))) this.#empty.delete(k)
    }
    for (const k of keys) for (const l of [...(this.#listeners.get(k) ?? [])]) l()
    for (const l of [...this.#anyListeners]) l()
  }

  /** `published`: only streams a flush has announced (readers never see a stream before its notification). */
  #find(runId: string, step: StepKey, attempt: number | undefined, published: boolean): Stream | undefined {
    const byAttempt = this.#runs.get(runId)?.steps.get(step)
    if (byAttempt === undefined) return undefined
    if (attempt !== undefined) {
      const s = byAttempt.get(attempt)
      return s !== undefined && (!published || s.version > 0) ? s : undefined
    }
    let best: Stream | undefined
    for (const s of byAttempt.values()) {
      if (published && s.version === 0) continue
      if (best === undefined || s.attempt > best.attempt) best = s
    }
    return best
  }

  /** The stream of a step: the given attempt, or the latest one. Stable until the next flush that changes it. */
  snapshot(runId: string, step: StepKey, attempt?: number): StreamSnapshot {
    const s = this.#find(runId, step, attempt, true)
    if (s === undefined) {
      const key = `${runId}\u0000${step}\u0000${attempt ?? '*'}`
      let e = this.#empty.get(key)
      if (e === undefined) {
        e = Object.freeze({
          runId,
          step,
          attempt: null,
          attempts: this.#attempts(runId, step),
          blocks: [],
          dropped: 0,
          version: 0,
          firstOutputAt: null,
          done: false,
        })
        this.#empty.set(key, e)
      }
      return e
    }
    if (s.snap === null) {
      s.snap = Object.freeze({
        runId,
        step,
        attempt: s.attempt,
        attempts: this.#attempts(runId, step),
        blocks: Object.freeze(s.blocks.slice()),
        dropped: s.dropped,
        version: s.version,
        firstOutputAt: s.firstOutputAt,
        done: s.done,
      })
    }
    return s.snap
  }

  #attempts(runId: string, step: StepKey): readonly number[] {
    const byAttempt = this.#runs.get(runId)?.steps.get(step)
    if (byAttempt === undefined) return EMPTY_ATTEMPTS
    const published = [...byAttempt.values()].filter((s) => s.version > 0).map((s) => s.attempt)
    return published.length === 0 ? EMPTY_ATTEMPTS : Object.freeze(published.sort((a, b) => a - b))
  }

  /** Full text of a stream (the latest attempt by default), including text the block cap dropped. Immediate. */
  streamText(runId: string, step: StepKey, attempt?: number): string {
    return this.#find(runId, step, attempt, false)?.fullText() ?? ''
  }

  /** Steps of a run that have a stream, in no particular order. */
  steps(runId: string): StepKey[] {
    return [...(this.#runs.get(runId)?.steps.keys() ?? [])]
  }

  /** Listen to one step of a run (any attempt). */
  subscribe(runId: string, step: StepKey, cb: () => void): () => void {
    const k = stepKey(runId, step)
    let set = this.#listeners.get(k)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(k, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) this.#listeners.delete(k)
    }
  }

  /** Listen to every flush. */
  subscribeAll(cb: () => void): () => void {
    this.#anyListeners.add(cb)
    return () => this.#anyListeners.delete(cb)
  }

  /** Forget the least recently updated runs beyond `max`, never one in `keep` (the focused runs). */
  evict(keep: ReadonlySet<string>, max = CACHED_RUNS): void {
    const candidates = [...this.#runs.entries()]
      .filter(([id]) => !keep.has(id))
      .sort((a, b) => a[1].touched - b[1].touched)
    for (const [id] of candidates.slice(0, Math.max(0, candidates.length - max))) this.clearRun(id)
  }

  clearRun(runId: string): void {
    const run = this.#runs.get(runId)
    if (run === undefined) return
    this.#runs.delete(runId)
    for (const byAttempt of run.steps.values()) for (const s of byAttempt.values()) this.#dirty.delete(s)
    for (const k of [...this.#empty.keys()]) if (k.startsWith(`${runId}\u0000`)) this.#empty.delete(k)
    for (const step of run.steps.keys())
      for (const l of [...(this.#listeners.get(stepKey(runId, step)) ?? [])]) l()
  }

  /** Tests: drop everything (listeners stay). */
  reset(): void {
    this.#runs.clear()
    this.#dirty.clear()
    this.#empty.clear()
    this.#scheduled = false
  }
}

function stepKey(runId: string, step: StepKey): string {
  return `${runId}\u0000${step}`
}

/** The app's buffer (the bridge feeds it). */
export const streamBuffer = new StreamBuffer()

/** One step's stream for React: the given attempt, or the latest. Re-renders at most once per frame. */
export function useStream(runId: string, step: StepKey, attempt?: number): StreamSnapshot {
  const subscribe = useCallback((cb: () => void) => streamBuffer.subscribe(runId, step, cb), [runId, step])
  const get = useCallback(() => streamBuffer.snapshot(runId, step, attempt), [runId, step, attempt])
  return useSyncExternalStore(subscribe, get)
}

/** Full text of a step's latest attempt (tests, E2E). */
export function streamText(runId: string, step: StepKey, attempt?: number): string {
  return streamBuffer.streamText(runId, step, attempt)
}
