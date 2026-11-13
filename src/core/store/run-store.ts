// runs/<id>/ persistence (run.json is written debounced (250 ms) and forced on
// transitions). The run.json shape belongs to the supervisor; this store is generic over it and only adds
// `schemaVersion`. A run.json from a newer Dim Factory opens read-only and every save throws NEWER_SCHEMA.
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { DimFactoryError, errnoCode, storageError } from '../errors.ts'
import { assertSafeSegment, homePaths } from '../home.ts'
import type { HomePaths, RunPaths, RunTextOutput } from '../home.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import { writeFileAtomic, writeJsonAtomic } from './atomic.ts'
import {
  CURRENT_SCHEMA_VERSION,
  assertWritable,
  readVersionedJson,
  withSchemaVersion,
  writeVersionedJson,
} from './versions.ts'
import type { Upgraders, VersionedRead, VersionedReadOptions } from './versions.ts'

export const RUN_JSON_DEBOUNCE_MS = 250

/** Versioned JSON side files of a run (procs.json belongs to proc-table). */
export type RunJsonFile = 'resolved' | 'findings' | 'snapshots' | 'review-state'

export interface RunStoreOptions<T> {
  /** Narrow the (upgraded) run.json object; return null or throw to treat it as corrupt. */
  validate?: (doc: Record<string, unknown>) => T | null
  upgraders?: Upgraders
  debounceMs?: number
  log?: Logger
}

const toPaths = (home: string | HomePaths): HomePaths => (typeof home === 'string' ? homePaths(home) : home)

function jsonFileOf(paths: RunPaths, name: RunJsonFile): string {
  switch (name) {
    case 'resolved':
      return paths.resolvedJson
    case 'findings':
      return paths.findingsJson
    case 'snapshots':
      return paths.snapshotsJson
    case 'review-state':
      return paths.reviewStateJson
  }
}

/** Run ids that have a folder under runs/ (unsorted; invalid names skipped). */
export async function listRunIds(home: string | HomePaths): Promise<string[]> {
  const p = toPaths(home)
  let entries
  try {
    entries = await readdir(p.runsDir, { withFileTypes: true })
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return []
    throw storageError(`cannot list ${p.runsDir}`, err)
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      out.push(assertSafeSegment(e.name, 'run id'))
    } catch {
      // not a run folder
    }
  }
  return out
}

export async function runExists(home: string | HomePaths, runId: string): Promise<boolean> {
  try {
    return (await stat(toPaths(home).run(runId).runJson)).isFile()
  } catch {
    return false
  }
}

/** Delete a run folder (retention / remove). Retries Windows sharing errors. */
export async function removeRunDir(home: string | HomePaths, runId: string): Promise<void> {
  const dir = toPaths(home).run(runId).dir
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    throw storageError(`cannot delete ${dir}`, err)
  }
}

/** Non-throwing read of a run's run.json (missing / corrupt / ok + readOnly). */
export function readRunJson<T = Record<string, unknown>>(
  home: string | HomePaths,
  runId: string,
  opts: VersionedReadOptions<T> = {},
): Promise<VersionedRead<T>> {
  return readVersionedJson<T>(toPaths(home).run(runId).runJson, opts)
}

/**
 * One run's folder. `set()` updates the in-memory run.json and writes it at most 250 ms later (the first change
 * arms the timer; later changes ride along, so a busy run still checkpoints every 250 ms); `checkpoint()` and
 * `flush()` write now. Writes are serialized and atomic.
 */
export class RunStore<T extends object = Record<string, unknown>> {
  readonly runId: string
  readonly paths: RunPaths
  /** run.json was written by a newer Dim Factory. */
  readonly readOnly: boolean
  /** schemaVersion found on disk (CURRENT for a new run). */
  readonly version: number
  readonly #debounceMs: number
  readonly #log: Logger
  #doc: T
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | null = null
  #chain: Promise<void> = Promise.resolve()
  #closed = false

  private constructor(paths: RunPaths, doc: T, readOnly: boolean, version: number, opts: RunStoreOptions<T>) {
    this.runId = paths.runId
    this.paths = paths
    this.#doc = doc
    this.readOnly = readOnly
    this.version = version
    this.#debounceMs = opts.debounceMs ?? RUN_JSON_DEBOUNCE_MS
    this.#log = opts.log ?? silentLogger
  }

  /**
   * Create `runs/<id>/` (CONFLICT if it already exists) and write run.json immediately. Call only once the run is
   * accepted (R1): a blocked preflight must leave no run folder.
   */
  static async create<T extends object>(
    home: string | HomePaths,
    runId: string,
    doc: T,
    opts: RunStoreOptions<T> = {},
  ): Promise<RunStore<T>> {
    const p = toPaths(home)
    const paths = p.run(runId)
    try {
      await mkdir(p.runsDir, { recursive: true, mode: 0o700 })
      await mkdir(paths.dir, { mode: 0o700 })
    } catch (err) {
      if (errnoCode(err) === 'EEXIST') {
        throw new DimFactoryError('CONFLICT', `run folder ${runId} already exists`, { details: { runId } })
      }
      throw storageError(`cannot create run folder ${paths.dir}`, err)
    }
    const store = new RunStore<T>(paths, doc, false, CURRENT_SCHEMA_VERSION, opts)
    try {
      await writeJsonAtomic(paths.runJson, withSchemaVersion(doc))
    } catch (err) {
      await rm(paths.dir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    return store
  }

  /** Open an existing run. NOT_FOUND when run.json is missing; STORAGE (details.corrupt) when unparsable. */
  static async open<T extends object>(
    home: string | HomePaths,
    runId: string,
    opts: RunStoreOptions<T> = {},
  ): Promise<RunStore<T>> {
    const paths = toPaths(home).run(runId)
    const r = await readVersionedJson<T>(paths.runJson, {
      ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
      ...(opts.upgraders !== undefined ? { upgraders: opts.upgraders } : {}),
    })
    if (r.kind === 'missing') {
      throw new DimFactoryError('NOT_FOUND', `run ${runId} not found`, { details: { runId } })
    }
    if (r.kind === 'corrupt') {
      throw new DimFactoryError('STORAGE', `run ${runId}: run.json is unreadable (${r.error})`, {
        details: { runId, corrupt: true, error: r.error },
      })
    }
    return new RunStore<T>(paths, r.value, r.readOnly, r.version, opts)
  }

  get doc(): T {
    return this.#doc
  }

  /** True while a change has not been written yet. */
  get dirty(): boolean {
    return this.#dirty
  }

  /** Replace the in-memory run.json and schedule a write (≤ 250 ms). */
  set(next: T | ((prev: T) => T)): void {
    this.#assertWritable()
    this.#doc = typeof next === 'function' ? next(this.#doc) : next
    this.#dirty = true
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.flush().catch((err: unknown) =>
          this.#log.error('run.json write failed', { runId: this.runId, err }),
        )
      }, this.#debounceMs)
    }
  }

  /** Forced write (state transitions): optionally set, then write now. */
  async checkpoint(next?: T | ((prev: T) => T)): Promise<void> {
    if (next !== undefined) this.set(next)
    await this.flush()
  }

  /** Write run.json now if it changed. Rejects (STORAGE) on failure; the change stays dirty for a retry. */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const run = this.#chain.then(async () => {
      if (!this.#dirty) return
      this.#assertWritable()
      const doc = this.#doc
      this.#dirty = false
      try {
        await writeJsonAtomic(this.paths.runJson, withSchemaVersion(doc))
      } catch (err) {
        this.#dirty = true
        throw err
      }
    })
    this.#chain = run.catch(() => undefined)
    return run
  }

  /** Flush and stop accepting changes. */
  async close(): Promise<void> {
    if (this.#closed) return
    if (!this.readOnly) await this.flush()
    this.#closed = true
  }

  /** Write a pass output (`plan.md`, `plan.original.md`, `review.md`, `critic.md`) atomically. */
  async writeText(name: RunTextOutput, text: string): Promise<void> {
    this.#assertWritable()
    await writeFileAtomic(this.paths.output(name), text)
  }

  /** Read a pass output; null when it does not exist. */
  async readText(name: RunTextOutput): Promise<{ text: string; mtime: number } | null> {
    const file = this.paths.output(name)
    try {
      const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
      return { text, mtime: st.mtimeMs }
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null
      throw storageError(`cannot read ${file}`, err)
    }
  }

  /** Write a versioned side file (resolved/findings/snapshots/review-state) with `schemaVersion:1`. */
  async writeJson(name: RunJsonFile, value: object): Promise<void> {
    this.#assertWritable()
    await writeVersionedJson(jsonFileOf(this.paths, name), value)
  }

  readJson<U = Record<string, unknown>>(
    name: RunJsonFile,
    opts: VersionedReadOptions<U> = {},
  ): Promise<VersionedRead<U>> {
    return readVersionedJson<U>(jsonFileOf(this.paths, name), opts)
  }

  #assertWritable(): void {
    if (this.#closed) throw new DimFactoryError('INTERNAL', `run store ${this.runId} is closed`)
    assertWritable({ version: this.version, readOnly: this.readOnly }, `run ${this.runId}`)
  }
}
