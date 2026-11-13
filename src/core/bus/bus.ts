// The event bus: seq, text coalescer, ring, single JSONL writer.
// It owns `seq` per run and is the single writer of runs/<id>/events.jsonl. Fan-out is synchronous on the emitting
// tick: writer enqueue → ring → sinks. Sinks only enqueue and never throw into the bus.
import type { AppEvent } from '../../shared/ipc.ts'
import type { NormalizedEvent } from '../../shared/events.ts'
import type { RunEnvelope, RunEventBody, StepKey } from '../../shared/run.ts'
import { DimFactoryError } from '../errors.ts'
import { homePaths } from '../home.ts'
import type { HomePaths } from '../home.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import { JsonlWriter, SeqOffsetIndex, fileSize, readJsonlTail, scanJsonl } from '../store/jsonl.ts'
import type { JsonlWriterOptions } from '../store/jsonl.ts'
import { CURRENT_SCHEMA_VERSION } from '../store/versions.ts'
import { TextCoalescer } from './coalesce.ts'
import type { CoalescedText } from './coalesce.ts'
import { RingBuffer } from './ring.ts'
import type { RingOptions } from './ring.ts'
import { BRAND } from '../../shared/brand.ts'

export type GlobalEvent = Exclude<AppEvent, { kind: 'run' }>

/** A consumer of bus traffic (IPC push, CLI printer, index updater, attention, notifier). Must only enqueue. */
export interface BusSink {
  name: string
  run?(env: RunEnvelope): void
  global?(ev: GlobalEvent): void
}

export interface EventBusOptions {
  /** DIM_FACTORY_HOME or its paths; a run's log is `runs/<id>/events.jsonl`. */
  home: string | HomePaths
  log?: Logger
  /** App version recorded in new event-log headers. */
  app?: string
  /** Envelope timestamps (default Date.now). */
  now?: () => number
  ring?: RingOptions
  coalesce?: { flushMs?: number; maxBytes?: number }
  /** How long a closed run's ring stays in memory (default 10 min). */
  ringTtlMs?: number
  /** Offset index granularity in seqs (default 500). */
  indexEvery?: number
  writer?: Pick<JsonlWriterOptions, 'retryDelaysMs' | 'backlogWarnBytes'>
}

export interface OpenRunOptions {
  /** `run.json` lastSeq: numbering continues from max(lastSeq, last seq in the file). */
  lastSeq?: number
  /** Header `createdAt` for a new log (default now). */
  createdAt?: number
}

export interface OpenRunResult {
  lastSeq: number
  /** A new log was started (header written). */
  created: boolean
  /** The log was written by a newer Dim Factory: replay works, emit throws NEWER_SCHEMA. */
  readOnly: boolean
  /** Bytes of a torn trailing line dropped at open. */
  truncatedBytes: number
}

export interface ReplayPage {
  /** Envelopes with seq > sinceSeq, at most `limit`. */
  events: RunEnvelope[]
  lastSeq: number
  more: boolean
}

export interface EventsHeader {
  seq: 0
  t: 'header'
  schemaVersion: number
  runId: string
  app: string
  createdAt: number
}

export const REPLAY_MAX_LIMIT = 2000
export const RING_TTL_MS = 10 * 60 * 1000
export const TAIL_WINDOW_BYTES = 64 * 1024
export const OFFSET_INDEX_EVERY = 500

interface RunChannel {
  runId: string
  file: string
  writer: JsonlWriter | null
  seq: number
  ring: RingBuffer
  /** Offsets of lines written by this bus instance. */
  hot: SeqOffsetIndex
  /** Bytes in the file before this session appended anything. */
  coldEnd: number
  readOnly: boolean
  open: boolean
  ttl: ReturnType<typeof setTimeout> | null
}

interface EnvelopeLine {
  seq: number
  ts: number
  body: RunEventBody
}

function isEnvelopeLine(v: unknown): v is EnvelopeLine {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r['seq'] === 'number' &&
    r['seq'] >= 1 &&
    typeof r['ts'] === 'number' &&
    r['body'] !== null &&
    typeof r['body'] === 'object'
  )
}

function isHeader(v: unknown): v is EventsHeader {
  return v !== null && typeof v === 'object' && (v as Record<string, unknown>)['t'] === 'header'
}

/** Last envelope seq in an events file (0 when none). Reads the last 64 KB; widens only for giant lines. */
export async function lastSeqInFile(file: string): Promise<number> {
  for (let window = TAIL_WINDOW_BYTES; ; window *= 16) {
    const { lines, size, windowStart } = await readJsonlTail(file, window)
    for (let i = lines.length - 1; i >= 0; i--) {
      const v = lines[i]!.value
      if (isEnvelopeLine(v)) return v.seq
    }
    if (windowStart === 0 || window >= size) return 0
  }
}

/** The header line of an events file, or null when missing/unreadable. */
export async function readEventsHeader(file: string): Promise<EventsHeader | null> {
  let header: EventsHeader | null = null
  await scanJsonl(file, (l) => {
    if (isHeader(l.value)) header = l.value
    return false
  })
  return header
}

/**
 * Stream every envelope with seq > sinceSeq from a run's events.jsonl, in file order and without the replay cap:
 * for `projectFromLog` recovery when run.json is behind the log. Unparsable lines are skipped and counted.
 */
export async function forEachEnvelope(
  home: string | HomePaths,
  runId: string,
  sinceSeq: number,
  fn: (env: RunEnvelope) => void,
): Promise<{ lastSeq: number; bad: number }> {
  const file = (typeof home === 'string' ? homePaths(home) : home).run(runId).eventsJsonl
  let lastSeq = 0
  const stats = await scanJsonl(file, (l) => {
    const v = l.value
    if (!isEnvelopeLine(v)) return
    lastSeq = Math.max(lastSeq, v.seq)
    if (v.seq > sinceSeq) fn({ runId, seq: v.seq, ts: v.ts, body: v.body })
  })
  return { lastSeq, bad: stats.bad }
}

export class EventBus {
  readonly paths: HomePaths
  readonly #log: Logger
  readonly #app: string
  readonly #now: () => number
  readonly #ringOpts: RingOptions
  readonly #ringTtlMs: number
  readonly #indexEvery: number
  readonly #writerOpts: Pick<JsonlWriterOptions, 'retryDelaysMs' | 'backlogWarnBytes'>
  readonly #runs = new Map<string, RunChannel>()
  readonly #opening = new Map<string, Promise<OpenRunResult>>()
  readonly #coldIndexes = new Map<string, { end: number; index: SeqOffsetIndex }>()
  readonly #sinks = new Set<BusSink>()
  readonly #coalescer: TextCoalescer
  #dispatchQueue: (() => void)[] = []
  #dispatching = false

  constructor(opts: EventBusOptions) {
    this.paths = typeof opts.home === 'string' ? homePaths(opts.home) : opts.home
    this.#log = opts.log ?? silentLogger
    this.#app = opts.app ?? BRAND.slug
    this.#now = opts.now ?? Date.now
    this.#ringOpts = opts.ring ?? {}
    this.#ringTtlMs = opts.ringTtlMs ?? RING_TTL_MS
    this.#indexEvery = opts.indexEvery ?? OFFSET_INDEX_EVERY
    this.#writerOpts = opts.writer ?? {}
    this.#coalescer = new TextCoalescer({
      onFlush: (t) => this.#emitText(t),
      ...(opts.coalesce?.flushMs !== undefined ? { flushMs: opts.coalesce.flushMs } : {}),
      ...(opts.coalesce?.maxBytes !== undefined ? { maxBytes: opts.coalesce.maxBytes } : {}),
    })
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------

  /**
   * Open a run's event log for writing. Creates the file with its header (seq 0) when new; otherwise drops a torn
   * trailing line and continues numbering at max(opts.lastSeq, last seq in the file). Idempotent while open.
   */
  openRun(runId: string, opts: OpenRunOptions = {}): Promise<OpenRunResult> {
    const ch = this.#runs.get(runId)
    if (ch?.open === true) {
      return Promise.resolve({ lastSeq: ch.seq, created: false, readOnly: ch.readOnly, truncatedBytes: 0 })
    }
    const pending = this.#opening.get(runId)
    if (pending !== undefined) return pending
    const p = this.#openRun(runId, opts).finally(() => this.#opening.delete(runId))
    this.#opening.set(runId, p)
    return p
  }

  async #openRun(runId: string, opts: OpenRunOptions): Promise<OpenRunResult> {
    const file = this.paths.run(runId).eventsJsonl
    const header = await readEventsHeader(file)
    const readOnly = header !== null && header.schemaVersion > CURRENT_SCHEMA_VERSION
    let writer: JsonlWriter | null = null
    let truncatedBytes = 0
    if (!readOnly) {
      writer = await JsonlWriter.open(file, {
        ...this.#writerOpts,
        onWarn: (msg, data) => this.#log.warn(msg, { runId, ...data }),
        onError: (err) => this.#log.error('events.jsonl write failed; retrying', { runId, err }),
      })
      truncatedBytes = writer.truncatedBytes
      if (truncatedBytes > 0) this.#log.warn('events.jsonl had a torn tail', { runId, bytes: truncatedBytes })
    }
    const fileSeq = await lastSeqInFile(file)
    const created = writer !== null && writer.size === 0
    if (writer !== null && created) {
      const head: EventsHeader = {
        seq: 0,
        t: 'header',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        runId,
        app: this.#app,
        createdAt: opts.createdAt ?? this.#now(),
      }
      writer.append(head)
    }
    const prev = this.#runs.get(runId)
    if (prev !== undefined && prev.ttl !== null) clearTimeout(prev.ttl)
    const seq = Math.max(opts.lastSeq ?? 0, fileSeq, prev?.seq ?? 0)
    const ch: RunChannel = {
      runId,
      file,
      writer,
      seq,
      // A ring kept from an earlier close in this process stays valid (same numbering).
      ring: prev !== undefined && prev.seq === seq ? prev.ring : new RingBuffer(this.#ringOpts),
      hot: new SeqOffsetIndex(this.#indexEvery),
      coldEnd: writer?.size ?? 0,
      readOnly,
      open: true,
      ttl: null,
    }
    this.#runs.set(runId, ch)
    this.#coldIndexes.delete(runId)
    return { lastSeq: seq, created, readOnly, truncatedBytes }
  }

  /** Flush the run's text, make its log durable and close the writer. The ring stays for replay ~10 min. */
  async closeRun(runId: string): Promise<void> {
    const pending = this.#opening.get(runId)
    if (pending !== undefined) await pending.catch(() => undefined)
    const ch = this.#runs.get(runId)
    if (ch === undefined || !ch.open) return
    this.#coalescer.flushRun(runId)
    ch.open = false
    const writer = ch.writer
    ch.writer = null
    try {
      if (writer !== null) await writer.close()
    } finally {
      ch.ttl = setTimeout(() => {
        if (this.#runs.get(runId) === ch && !ch.open) this.#runs.delete(runId)
      }, this.#ringTtlMs)
      ch.ttl.unref()
    }
  }

  /** Forget a closed run's ring now (e.g. the run was removed). */
  forget(runId: string): void {
    const ch = this.#runs.get(runId)
    if (ch === undefined || ch.open) return
    if (ch.ttl !== null) clearTimeout(ch.ttl)
    this.#runs.delete(runId)
    this.#coldIndexes.delete(runId)
  }

  /** Close every open run (shutdown). */
  async close(): Promise<void> {
    this.#coalescer.flushAll()
    const results = await Promise.allSettled([...this.#runs.keys()].map((id) => this.closeRun(id)))
    for (const ch of this.#runs.values()) if (ch.ttl !== null) clearTimeout(ch.ttl)
    this.#runs.clear()
    this.#coldIndexes.clear()
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }

  isOpen(runId: string): boolean {
    return this.#runs.get(runId)?.open === true
  }

  /** Last assigned seq of a run known to this bus (open or recently closed). */
  lastSeq(runId: string): number | undefined {
    return this.#runs.get(runId)?.seq
  }

  // ---- emit -------------------------------------------------------------------------------------------------

  /**
   * Route one normalized adapter event. Text deltas are coalesced (returns null); any other event first flushes
   * that step's pending text, then is emitted as `{t:'ev'}`.
   */
  pass(runId: string, step: StepKey, attempt: number, ev: NormalizedEvent): RunEnvelope | null {
    if (ev.type === 'text') {
      this.#channel(runId)
      this.#coalescer.push(runId, step, attempt, ev.delta)
      return null
    }
    return this.emit(runId, { t: 'ev', step, attempt, ev })
  }

  /**
   * Assign the next seq and fan out synchronously: writer enqueue → ring → sinks. Pending text of the same step
   * (or of the whole run, for a run-level body) is emitted first so text never crosses another event.
   */
  emit(runId: string, body: RunEventBody): RunEnvelope {
    const ch = this.#channel(runId)
    if ('step' in body) this.#coalescer.flushStep(runId, body.step)
    else this.#coalescer.flushRun(runId)
    return this.#emitNow(ch, body)
  }

  /** App-level event (no seq, not persisted) to every sink with a `global` handler. */
  global(ev: GlobalEvent): void {
    this.#dispatch(() => {
      for (const sink of this.#sinks) {
        if (sink.global === undefined) continue
        try {
          sink.global(ev)
        } catch (err) {
          this.#log.error('bus sink threw', { sink: sink.name, kind: ev.kind, err })
        }
      }
    })
  }

  attach(sink: BusSink): () => void {
    this.#sinks.add(sink)
    return () => {
      this.#sinks.delete(sink)
    }
  }

  /** Write-ahead point: emit pending text of the run, then fdatasync its log. */
  async sync(runId: string): Promise<void> {
    const ch = this.#runs.get(runId)
    if (ch === undefined || !ch.open) return
    this.#coalescer.flushRun(runId)
    if (ch.writer !== null) await ch.writer.datasync()
  }

  #channel(runId: string): RunChannel {
    const ch = this.#runs.get(runId)
    if (ch === undefined || !ch.open) {
      throw new DimFactoryError('INTERNAL', `run ${runId} is not open on the event bus`)
    }
    if (ch.readOnly || ch.writer === null) {
      throw new DimFactoryError(
        'NEWER_SCHEMA',
        `run ${runId} was created by a newer Dim Factory; it is read-only`,
      )
    }
    return ch
  }

  #emitText(t: CoalescedText): void {
    const ch = this.#runs.get(t.runId)
    if (ch === undefined || !ch.open || ch.writer === null) {
      this.#log.warn('dropped coalesced text for a closed run', { runId: t.runId, step: t.step })
      return
    }
    try {
      this.#emitNow(ch, { t: 'ev', step: t.step, attempt: t.attempt, ev: { type: 'text', delta: t.delta } })
    } catch (err) {
      this.#log.error('coalesced text emit failed', { runId: t.runId, err })
    }
  }

  #emitNow(ch: RunChannel, body: RunEventBody): RunEnvelope {
    const seq = ch.seq + 1
    const ts = this.#now()
    const line = JSON.stringify({ seq, ts, body })
    const offset = ch.writer!.appendLine(line)
    ch.seq = seq
    ch.hot.note(seq, offset)
    const env: RunEnvelope = { runId: ch.runId, seq, ts, body }
    ch.ring.push(env, line.length + 1)
    this.#dispatch(() => {
      for (const sink of this.#sinks) {
        if (sink.run === undefined) continue
        try {
          sink.run(env)
        } catch (err) {
          this.#log.error('bus sink threw', { sink: sink.name, runId: ch.runId, seq, err })
        }
      }
    })
    return env
  }

  /** Sinks that emit from inside a callback are queued, so every sink sees envelopes in seq order. */
  #dispatch(fn: () => void): void {
    this.#dispatchQueue.push(fn)
    if (this.#dispatching) return
    this.#dispatching = true
    try {
      while (this.#dispatchQueue.length > 0) this.#dispatchQueue.shift()!()
    } finally {
      this.#dispatching = false
    }
  }

  // ---- replay -----------------------------------------------------------------------------------------------

  /**
   * Envelopes with seq > sinceSeq (at most `limit`, capped at 2000): from the ring when it covers the range,
   * otherwise from events.jsonl through the seq offset index. Works for runs that are not open (cold files).
   */
  async replay(runId: string, sinceSeq: number, limit: number = REPLAY_MAX_LIMIT): Promise<ReplayPage> {
    const max = Math.max(1, Math.min(REPLAY_MAX_LIMIT, Math.trunc(limit)))
    const since = Math.max(0, Math.trunc(sinceSeq))
    const ch = this.#runs.get(runId)
    if (ch !== undefined) {
      if (since >= ch.seq) return { events: [], lastSeq: ch.seq, more: false }
      const fromRing = ch.ring.since(since, max)
      if (fromRing !== null) return this.#page(fromRing, ch.seq, since)
      if (ch.writer !== null) await ch.writer.flush()
      const hot = ch.hot.floor(since + 1)
      const start = hot?.offset ?? (await this.#coldOffset(runId, ch.file, ch.coldEnd, since + 1))
      const events = await this.#readFrom(ch.file, runId, since, max, start)
      return this.#page(events, ch.seq, since)
    }
    const file = this.paths.run(runId).eventsJsonl
    const lastSeq = await lastSeqInFile(file)
    if (since >= lastSeq) return { events: [], lastSeq, more: false }
    const size = await fileSize(file)
    const start = await this.#coldOffset(runId, file, size, since + 1)
    const events = await this.#readFrom(file, runId, since, max, start)
    return this.#page(events, lastSeq, since)
  }

  #page(events: RunEnvelope[], lastSeq: number, since: number): ReplayPage {
    const last = events.at(-1)?.seq ?? since
    return { events, lastSeq, more: last < lastSeq }
  }

  async #coldOffset(runId: string, file: string, end: number, seq: number): Promise<number> {
    let cached = this.#coldIndexes.get(runId)
    if (cached === undefined || cached.end !== end) {
      const index = new SeqOffsetIndex(this.#indexEvery)
      await scanJsonl(
        file,
        (l) => {
          if (isEnvelopeLine(l.value)) index.note(l.value.seq, l.offset)
        },
        { end },
      )
      cached = { end, index }
      this.#coldIndexes.set(runId, cached)
    }
    return cached.index.floor(seq)?.offset ?? 0
  }

  async #readFrom(
    file: string,
    runId: string,
    since: number,
    limit: number,
    start: number,
  ): Promise<RunEnvelope[]> {
    const out: RunEnvelope[] = []
    let bad = 0
    await scanJsonl(
      file,
      (l) => {
        const v = l.value
        if (!isEnvelopeLine(v) || v.seq <= since) return
        out.push({ runId, seq: v.seq, ts: v.ts, body: v.body })
        if (out.length >= limit) return false
      },
      { start, onBad: () => void bad++ },
    )
    if (bad > 0) this.#log.warn('events.jsonl has unparsable lines', { runId, bad })
    return out
  }
}
