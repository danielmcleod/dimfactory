// runs/index.jsonl (index maintenance): `{v:1,op:'put',s:RunSummary}` and
// `{v:1,op:'del',id}` lines streamed into an in-memory Map at boot (last write wins). A missing file or a corrupt
// non-trailing line triggers a rebuild from runs/*/run.json (16-way). Compaction rewrites one line per live run when
// lines > 2 × live + 100 or the file exceeds 8 MB. runs.list, the dashboard and stats are served from the Map.
// An `overlay` (runs/history.json's pins and pending removals) applies to every summary the index takes in, a
// rebuild included, so a rebuild keeps pins and never brings back a removed run, and a late upsert of a removed run is
// dropped. A corrupt file is kept beside the rebuilt one as `index.jsonl.bad` for diagnosis.
import { copyFile } from 'node:fs/promises'
import type { RunSummary } from '../../shared/run.ts'
import { chaosArmed, chaosPoint } from '../chaos.ts'
import { DimFactoryError } from '../errors.ts'
import { homePaths } from '../home.ts'
import type { HomePaths } from '../home.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import { writeFileAtomic } from './atomic.ts'
import { JsonlWriter, scanJsonl } from './jsonl.ts'
import type { JsonlWriterOptions } from './jsonl.ts'
import { listRunIds, readRunJson } from './run-store.ts'
import { isPlainObject } from './versions.ts'

export type IndexOp = { v: 1; op: 'put'; s: RunSummary } | { v: 1; op: 'del'; id: string }

export const INDEX_COMPACT_BYTES = 8 * 1024 * 1024
export const INDEX_COMPACT_SLACK = 100
export const INDEX_SUMMARY_DEBOUNCE_MS = 1000
export const INDEX_REBUILD_CONCURRENCY = 16

export type IndexChange = { op: 'put'; summary: RunSummary } | { op: 'del'; runId: string }

export interface IndexStoreOptions {
  log?: Logger
  /**
   * Derive a run's summary from its run.json during a rebuild. Default: `doc.summary` when it looks like a
   * RunSummary. The supervisor should pass its own projection.
   */
  summarize?: (runJson: Record<string, unknown>, runId: string) => RunSummary | null
  /** Called after each put/del line is appended (wire to `bus.global({kind:'run-summary'})`). Never throws. */
  onChange?: (change: IndexChange) => void
  /** Debounce for putDebounced (default 1 s). */
  debounceMs?: number
  compactBytes?: number
  compactSlack?: number
  /**
   * Every summary the index takes in (put, putDebounced, a rebuild) passes through this first: the result is
   * stored (e.g. `pinned` from runs/history.json), and null leaves the run out (a removal waiting for its undo window).
   * Must not throw.
   */
  overlay?: (s: RunSummary) => RunSummary | null
}

export interface IndexOpenInfo {
  source: 'file' | 'rebuilt'
  rebuildReason?: 'missing' | 'corrupt'
  /** Complete op lines read from the file. */
  lines: number
  /** Unparsable / invalid non-trailing lines. */
  bad: number
  /** A torn trailing line was ignored (and truncated). */
  partialTail: boolean
}

function looksLikeSummary(v: unknown): v is RunSummary {
  return (
    isPlainObject(v) &&
    typeof v['runId'] === 'string' &&
    typeof v['status'] === 'string' &&
    typeof v['createdAt'] === 'number'
  )
}

function parseOp(v: unknown): IndexOp | null {
  if (!isPlainObject(v)) return null
  if (v['op'] === 'put' && looksLikeSummary(v['s'])) return { v: 1, op: 'put', s: v['s'] }
  if (v['op'] === 'del' && typeof v['id'] === 'string') return { v: 1, op: 'del', id: v['id'] }
  return null
}

export function defaultSummarize(runJson: Record<string, unknown>): RunSummary | null {
  const s = runJson['summary']
  return looksLikeSummary(s) ? s : null
}

/** Newest first: createdAt desc, then displayNo desc. */
export function compareSummaries(a: RunSummary, b: RunSummary): number {
  return b.createdAt - a.createdAt || b.displayNo - a.displayNo
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export class IndexStore {
  readonly paths: HomePaths
  readonly openInfo: IndexOpenInfo
  readonly #o: IndexStoreOptions
  readonly #log: Logger
  readonly #map: Map<string, RunSummary>
  #writer: JsonlWriter
  #lines: number
  #maxDisplayNo: number
  #chain: Promise<void> = Promise.resolve()
  #debounced = new Map<string, ReturnType<typeof setTimeout>>()
  #compacting = false
  #closed = false

  private constructor(
    paths: HomePaths,
    map: Map<string, RunSummary>,
    writer: JsonlWriter,
    lines: number,
    maxDisplayNo: number,
    info: IndexOpenInfo,
    opts: IndexStoreOptions,
  ) {
    this.paths = paths
    this.#map = map
    this.#writer = writer
    this.#lines = lines
    this.#maxDisplayNo = maxDisplayNo
    this.openInfo = info
    this.#o = opts
    this.#log = opts.log ?? silentLogger
  }

  static async open(home: string | HomePaths, opts: IndexStoreOptions = {}): Promise<IndexStore> {
    const paths = typeof home === 'string' ? homePaths(home) : home
    const log = opts.log ?? silentLogger
    const map = new Map<string, RunSummary>()
    let maxDisplayNo = 0
    let invalid = 0
    const stats = await scanJsonl(
      paths.runIndex,
      (l) => {
        const op = parseOp(l.value)
        if (op === null) {
          invalid++
          return
        }
        if (op.op === 'put') {
          map.set(op.s.runId, op.s)
          maxDisplayNo = Math.max(maxDisplayNo, op.s.displayNo)
        } else {
          map.delete(op.id)
        }
      },
      { onBad: (b) => log.warn('runs/index.jsonl: unparsable line', { lineNo: b.lineNo }) },
    )
    const bad = stats.bad + invalid
    const base = { lines: stats.lines - invalid, bad, partialTail: stats.partialTail }
    if (!stats.exists || bad > 0) {
      const reason = stats.exists ? 'corrupt' : 'missing'
      if (stats.exists) {
        log.warn('runs/index.jsonl is corrupt; rebuilding from run.json files', { bad })
        await copyFile(paths.runIndex, `${paths.runIndex}.bad`).catch((err: unknown) =>
          log.warn('could not keep a copy of the corrupt runs/index.jsonl', { err }),
        )
      }
      const summaries = await IndexStore.#collect(paths, opts, log)
      const rebuilt = new Map(summaries.map((s) => [s.runId, s]))
      for (const s of summaries) maxDisplayNo = Math.max(maxDisplayNo, s.displayNo)
      await IndexStore.#writeCompacted(paths, rebuilt)
      const writer = await JsonlWriter.open(paths.runIndex, IndexStore.#writerOpts(log))
      const info: IndexOpenInfo = { source: 'rebuilt', rebuildReason: reason, ...base }
      return new IndexStore(paths, rebuilt, writer, rebuilt.size, maxDisplayNo, info, opts)
    }
    const writer = await JsonlWriter.open(paths.runIndex, IndexStore.#writerOpts(log))
    if (writer.truncatedBytes > 0)
      log.warn('runs/index.jsonl had a torn tail', { bytes: writer.truncatedBytes })
    const store = new IndexStore(
      paths,
      map,
      writer,
      base.lines,
      maxDisplayNo,
      { source: 'file', ...base },
      opts,
    )
    if (store.#needsCompaction()) await store.compact()
    return store
  }

  static #writerOpts(log: Logger): JsonlWriterOptions {
    return {
      onWarn: (msg: string, data?: Record<string, unknown>) =>
        log.warn(msg, { file: 'index.jsonl', ...data }),
      onError: (err: unknown) => log.error('runs/index.jsonl write failed; retrying', { err }),
    }
  }

  static async #collect(paths: HomePaths, opts: IndexStoreOptions, log: Logger): Promise<RunSummary[]> {
    const summarize = opts.summarize ?? defaultSummarize
    const ids = await listRunIds(paths)
    const results = await mapLimit(ids, INDEX_REBUILD_CONCURRENCY, async (id) => {
      try {
        const r = await readRunJson(paths, id)
        if (r.kind !== 'ok') return null
        const s = summarize(r.value, id)
        if (s === null || s.runId !== id) return null
        return opts.overlay !== undefined ? opts.overlay(s) : s
      } catch (err) {
        log.warn('index rebuild: cannot read run', { runId: id, err })
        return null
      }
    })
    return results.filter((s): s is RunSummary => s !== null)
  }

  static async #writeCompacted(paths: HomePaths, map: ReadonlyMap<string, RunSummary>): Promise<void> {
    const ordered = [...map.values()].sort((a, b) => a.createdAt - b.createdAt || a.displayNo - b.displayNo)
    const text = ordered.map((s) => `${JSON.stringify({ v: 1, op: 'put', s } satisfies IndexOp)}\n`).join('')
    await writeFileAtomic(paths.runIndex, text)
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  /** Live runs. */
  get size(): number {
    return this.#map.size
  }

  /** Op lines currently in the file (for the compaction rule). */
  get lineCount(): number {
    return this.#lines
  }

  get(runId: string): RunSummary | undefined {
    return this.#map.get(runId)
  }

  /** Summaries newest first, optionally filtered. */
  list(filter?: (s: RunSummary) => boolean): RunSummary[] {
    const all = [...this.#map.values()]
    return (filter ? all.filter(filter) : all).sort(compareSummaries)
  }

  /** The next "#N" for a new run (highest displayNo seen + 1). */
  nextDisplayNo(): number {
    return this.#maxDisplayNo + 1
  }

  // ---- writes --------------------------------------------------------------------------------------------------

  /** The summary after the overlay (null: the index leaves this run out). */
  #overlaid(summary: RunSummary): RunSummary | null {
    return this.#o.overlay !== undefined ? this.#o.overlay(summary) : summary
  }

  /** Upsert now (status changes): the Map updates synchronously, the line is appended in order. */
  put(summary: RunSummary): Promise<void> {
    this.#assertOpen()
    this.#cancelDebounce(summary.runId)
    const s = this.#overlaid(summary)
    // A removed run (waiting for its undo window) is not listed again by a late upsert.
    if (s === null) return Promise.resolve()
    this.#map.set(s.runId, s)
    this.#maxDisplayNo = Math.max(this.#maxDisplayNo, s.displayNo)
    return this.#append({ v: 1, op: 'put', s }, { op: 'put', summary: s })
  }

  /** Upsert totals/estimates: the Map updates now, the line is written within 1 s (latest wins per run). */
  putDebounced(summary: RunSummary): void {
    this.#assertOpen()
    const s = this.#overlaid(summary)
    if (s === null) {
      this.#cancelDebounce(summary.runId)
      return
    }
    this.#map.set(s.runId, s)
    this.#maxDisplayNo = Math.max(this.#maxDisplayNo, s.displayNo)
    if (this.#debounced.has(s.runId)) return
    const runId = s.runId
    const timer = setTimeout(() => {
      this.#debounced.delete(runId)
      const latest = this.#map.get(runId)
      if (latest === undefined || this.#closed) return
      this.#append({ v: 1, op: 'put', s: latest }, { op: 'put', summary: latest }).catch((err: unknown) =>
        this.#log.error('index upsert failed', { runId, err }),
      )
    }, this.#o.debounceMs ?? INDEX_SUMMARY_DEBOUNCE_MS)
    this.#debounced.set(runId, timer)
  }

  del(runId: string): Promise<void> {
    this.#assertOpen()
    this.#cancelDebounce(runId)
    this.#map.delete(runId)
    return this.#append({ v: 1, op: 'del', id: runId }, { op: 'del', runId })
  }

  /** Write pending debounced upserts and wait until every line is written. */
  async flush(): Promise<void> {
    for (const [runId, timer] of [...this.#debounced]) {
      clearTimeout(timer)
      this.#debounced.delete(runId)
      const latest = this.#map.get(runId)
      if (latest === undefined) continue
      this.#append({ v: 1, op: 'put', s: latest }, { op: 'put', summary: latest }).catch((err: unknown) =>
        this.#log.error('index upsert failed', { runId, err }),
      )
    }
    await this.#chain
    await this.#writer.flush()
  }

  /** Rewrite the file as one put line per live run (atomic), then continue appending. */
  compact(): Promise<void> {
    const run = this.#chain.then(() => this.#compactNow())
    this.#chain = run.catch((err: unknown) => this.#log.error('index compaction failed', { err }))
    return run
  }

  /** Rebuild the Map and the file from runs/*\/run.json. */
  rebuild(): Promise<void> {
    const run = this.#chain.then(async () => {
      const summaries = await IndexStore.#collect(this.paths, this.#o, this.#log)
      this.#map.clear()
      for (const s of summaries) {
        this.#map.set(s.runId, s)
        this.#maxDisplayNo = Math.max(this.#maxDisplayNo, s.displayNo)
      }
      await this.#compactNow()
    })
    this.#chain = run.catch((err: unknown) => this.#log.error('index rebuild failed', { err }))
    return run
  }

  async close(): Promise<void> {
    if (this.#closed) return
    await this.flush()
    this.#closed = true
    await this.#writer.close()
  }

  #append(op: IndexOp, change: IndexChange): Promise<void> {
    const run = this.#chain.then(async () => {
      this.#writer.append(op)
      this.#lines++
      await this.#writer.flush()
      // Chaos: named by what the line says (a run's status, or del), so a kill can pick one line whatever the
      // debounced progress lines around it.
      if (chaosArmed()) chaosPoint(op.op === 'put' ? `index:appended:${op.s.status}` : 'index:appended:del')
      try {
        this.#o.onChange?.(change)
      } catch (err) {
        this.#log.error('index onChange threw', { err })
      }
      if (this.#needsCompaction()) await this.#compactNow()
    })
    this.#chain = run.catch(() => undefined)
    return run
  }

  #needsCompaction(): boolean {
    if (this.#compacting) return false
    const slack = this.#o.compactSlack ?? INDEX_COMPACT_SLACK
    const bytes = this.#o.compactBytes ?? INDEX_COMPACT_BYTES
    return this.#lines > 2 * this.#map.size + slack || this.#writer.size > bytes
  }

  async #compactNow(): Promise<void> {
    this.#compacting = true
    try {
      await this.#writer.close()
      chaosPoint('index:compact')
      try {
        await IndexStore.#writeCompacted(this.paths, this.#map)
        this.#lines = this.#map.size
      } finally {
        this.#writer = await JsonlWriter.open(this.paths.runIndex, IndexStore.#writerOpts(this.#log))
      }
    } finally {
      this.#compacting = false
    }
  }

  #cancelDebounce(runId: string): void {
    const t = this.#debounced.get(runId)
    if (t !== undefined) clearTimeout(t)
    this.#debounced.delete(runId)
  }

  #assertOpen(): void {
    if (this.#closed) throw new DimFactoryError('INTERNAL', 'index store is closed')
  }
}
