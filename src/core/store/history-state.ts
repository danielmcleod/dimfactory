// Pins and pending removals of the Runs history (Pin / Remove (undo); the
// table `runs/index.jsonl`). `runs/history.json` is the durable record the runs index is checked against: a pin
// survives an index rebuild, and a removal still inside its undo window (or left by an app that quit) stays hidden and
// is deleted for real later. The index carries the same facts (`pinned`, a `del` line) for fast reads.
// A damaged or unreadable file never reads as "no pins". A corrupt file is kept as `history.json.bad` and
// the state is degraded: the pins come from the runs index (adoptPins, a union), boot never unpins from it, and
// retention deletes no run in this process. A file that cannot be read (after retries) also makes the state read-only:
// nothing is written over it.
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunSummary } from '../../shared/run.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { HomePaths } from '../home.ts'
import { CURRENT_SCHEMA_VERSION, isPlainObject, readVersionedJson, writeVersionedJson } from './versions.ts'
import type { VersionedRead } from './versions.ts'

/** Reads of runs/history.json tried before it counts as unreadable (antivirus or sync software may hold it). */
export const HISTORY_READ_ATTEMPTS = 5
const HISTORY_READ_RETRY_MS = 150

/** Why runs/history.json could not be used at load: `corrupt` (kept as history.json.bad) or `unreadable`. */
export interface HistoryDegraded {
  kind: 'corrupt' | 'unreadable'
  error: string
}

/** UI copy (no em dashes): why retention deletes no run while the record of pins is degraded. */
export function degradedText(d: HistoryDegraded): string {
  return d.kind === 'corrupt'
    ? 'runs/history.json was damaged, so retention deletes no run until Dim Factory restarts (pins come from the runs list meanwhile).'
    : 'runs/history.json could not be read, so retention deletes no run until it can (pins come from the runs list meanwhile).'
}

/** A Remove waiting for its undo window to pass (then the runs are deleted for real). */
export interface PendingRemoval {
  token: string
  runIds: string[]
  requestedAt: number
  /** When the deferred delete runs (an app that quit deletes them at its next start). */
  deleteAt: number
  /** The runs as they were listed, put back by an Undo. */
  summaries: RunSummary[]
}

interface HistoryFile {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  /** runId → when it was pinned. */
  pinned: Record<string, number>
  removals: PendingRemoval[]
}

const EMPTY: Readonly<HistoryFile> = { schemaVersion: CURRENT_SCHEMA_VERSION, pinned: {}, removals: [] }

/** `runs/history.json` */
export function historyStateFile(paths: HomePaths): string {
  return join(paths.runsDir, 'history.json')
}

function parseRemoval(v: unknown): PendingRemoval | null {
  if (!isPlainObject(v)) return null
  const { token, runIds, requestedAt, deleteAt, summaries } = v
  if (typeof token !== 'string' || token === '') return null
  if (!Array.isArray(runIds) || !runIds.every((id) => typeof id === 'string')) return null
  if (typeof requestedAt !== 'number' || typeof deleteAt !== 'number') return null
  const rows = Array.isArray(summaries)
    ? summaries.filter(
        (s): s is RunSummary =>
          isPlainObject(s) && typeof s['runId'] === 'string' && typeof s['createdAt'] === 'number',
      )
    : []
  return { token, runIds, requestedAt, deleteAt, summaries: rows }
}

function parseFile(doc: Record<string, unknown>): HistoryFile {
  const pinned: Record<string, number> = {}
  const p = doc['pinned']
  if (isPlainObject(p)) for (const [id, at] of Object.entries(p)) if (typeof at === 'number') pinned[id] = at
  const removals = Array.isArray(doc['removals'])
    ? doc['removals'].map(parseRemoval).filter((r): r is PendingRemoval => r !== null)
    : []
  return { schemaVersion: CURRENT_SCHEMA_VERSION, pinned, removals }
}

/**
 * The pins and pending removals in memory, written through to `runs/history.json` (atomic, serialized). Read-only
 * cores load it without ever writing; a file from a newer Dim Factory is read-only too.
 */
export class HistoryState {
  readonly file: string
  readonly readOnly: boolean
  /** Set when the file was damaged or unreadable at load (see the header): retention deletes no run then. */
  readonly degraded: HistoryDegraded | undefined
  #pinned: Map<string, number>
  #removals: PendingRemoval[]
  #hidden = new Set<string>()
  #chain: Promise<void> = Promise.resolve()

  private constructor(file: string, data: HistoryFile, readOnly: boolean, degraded?: HistoryDegraded) {
    this.file = file
    this.readOnly = readOnly
    this.degraded = degraded
    this.#pinned = new Map(Object.entries(data.pinned))
    this.#removals = [...data.removals]
    this.#reindex()
  }

  /**
   * Load. A missing file is an empty state. A corrupt one is kept as `history.json.bad` and gives a degraded state
   * (writable unless `readOnly`, or the copy could not be made); a file that cannot be read after
   * HISTORY_READ_ATTEMPTS tries gives a degraded, read-only one. Never throws.
   */
  static async load(
    paths: HomePaths,
    o: { readOnly?: boolean; retryMs?: number } = {},
  ): Promise<HistoryState> {
    const file = historyStateFile(paths)
    const readOnly = o.readOnly === true
    let r: VersionedRead<Record<string, unknown>> | undefined
    let lastError = ''
    for (let attempt = 1; attempt <= HISTORY_READ_ATTEMPTS && r === undefined; attempt++) {
      try {
        r = await readVersionedJson<Record<string, unknown>>(file)
      } catch (err) {
        lastError = errorMessage(err)
        if (attempt < HISTORY_READ_ATTEMPTS) {
          await new Promise((res) => setTimeout(res, (o.retryMs ?? HISTORY_READ_RETRY_MS) * attempt))
        }
      }
    }
    if (r === undefined) return new HistoryState(file, EMPTY, true, { kind: 'unreadable', error: lastError })
    if (r.kind === 'missing') return new HistoryState(file, EMPTY, readOnly)
    if (r.kind === 'corrupt') {
      // Kept for diagnosis (and recovery by hand) before anything is written over it.
      const kept = readOnly
        ? false
        : await copyFile(file, `${file}.bad`).then(
            () => true,
            () => false,
          )
      // A copy that could not be made: nothing may be written over the only one.
      return new HistoryState(file, EMPTY, readOnly || !kept, { kind: 'corrupt', error: r.error })
    }
    return new HistoryState(file, parseFile(r.value), readOnly || r.readOnly)
  }

  /**
   * A degraded state takes the pins the runs index still holds (memory only; a union, never an unpin): the index
   * mirrors every pin, so the pins survive a damaged runs/history.json. No-op for a healthy state.
   */
  adoptPins(runIds: Iterable<string>, at: number): void {
    if (this.degraded === undefined) return
    for (const id of runIds) if (!this.#pinned.has(id)) this.#pinned.set(id, at)
  }

  /** Write the pins and removals in memory to the file (boot, once a damaged file's pins were adopted). */
  repair(): Promise<void> {
    return this.#write((_pins, removals) => [...removals])
  }

  #reindex(): void {
    this.#hidden = new Set(this.#removals.flatMap((r) => r.runIds))
  }

  isPinned(runId: string): boolean {
    return this.#pinned.has(runId)
  }

  pinnedIds(): string[] {
    return [...this.#pinned.keys()]
  }

  /** Removed and waiting for its undo window (or the next start): lists leave it out. */
  isHidden(runId: string): boolean {
    return this.#hidden.has(runId)
  }

  removals(): readonly PendingRemoval[] {
    return this.#removals
  }

  removal(token: string): PendingRemoval | undefined {
    return this.#removals.find((r) => r.token === token)
  }

  /** The summary as lists show it: pinned from the pins; null while it is removed. */
  overlay(s: RunSummary): RunSummary | null {
    if (this.#hidden.has(s.runId)) return null
    const pinned = this.#pinned.has(s.runId)
    return s.pinned === pinned ? s : { ...s, pinned }
  }

  setPinned(runId: string, pinned: boolean, at: number): Promise<void> {
    return this.#write((pins, removals) => {
      if (pinned) pins.set(runId, pins.get(runId) ?? at)
      else pins.delete(runId)
      return [...removals]
    })
  }

  addRemoval(r: PendingRemoval): Promise<void> {
    return this.#write((_pins, removals) => [...removals.filter((x) => x.token !== r.token), r])
  }

  /** Drop a removal record (its Undo, or its runs are gone). */
  dropRemoval(token: string): Promise<void> {
    return this.#write((_pins, removals) => removals.filter((x) => x.token !== token))
  }

  /** Runs deleted for real: their pins, and their place in any removal record, go. */
  forget(runIds: readonly string[]): Promise<void> {
    const gone = new Set(runIds)
    return this.#write((pins, removals) => {
      for (const id of gone) pins.delete(id)
      return removals
        .map((r) => ({
          ...r,
          runIds: r.runIds.filter((id) => !gone.has(id)),
          summaries: r.summaries.filter((s) => !gone.has(s.runId)),
        }))
        .filter((r) => r.runIds.length > 0)
    })
  }

  /**
   * Work out the next pins and removals from copies of the current ones, write the file, and only then make them
   * current: memory never says more than the disk does. Writes are serialized; a failed write rejects.
   */
  #write(
    change: (pins: Map<string, number>, removals: readonly PendingRemoval[]) => PendingRemoval[],
  ): Promise<void> {
    if (this.readOnly) {
      if (this.degraded?.kind === 'unreadable') {
        return Promise.reject(
          new DimFactoryError(
            'STORAGE',
            `runs/history.json could not be read (${this.degraded.error}), so pins and removals cannot be saved now. Restart Dim Factory to try again.`,
          ),
        )
      }
      return Promise.reject(new Error('runs/history.json is read-only in this Dim Factory process'))
    }
    const run = this.#chain.then(async () => {
      const pins = new Map(this.#pinned)
      const removals = change(pins, this.#removals)
      const doc: Omit<HistoryFile, 'schemaVersion'> = { pinned: Object.fromEntries(pins), removals }
      await writeVersionedJson(this.file, doc, { knownWritable: true })
      this.#pinned = pins
      this.#removals = removals
      this.#reindex()
    })
    this.#chain = run.catch(() => undefined)
    return run
  }

  /** Wait for pending writes. */
  async flush(): Promise<void> {
    await this.#chain
  }
}
