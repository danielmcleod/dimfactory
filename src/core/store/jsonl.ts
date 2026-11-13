// JSONL files: a single-handle append writer that batches lines per tick and never drops
// one, a tolerant byte-exact reader (trailing partial line ignored, bad lines counted), a tail reader and the
// seq → byte-offset index used by bus replay.
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DimFactoryError, errnoCode, storageError } from '../errors.ts'

const NL = 0x0a
const CR = 0x0d
const READ_CHUNK = 64 * 1024
/** Unwritten backlog above this logs a warning (lines are still kept). */
export const JSONL_BACKLOG_WARN_BYTES = 8 * 1024 * 1024
/** Backoff for retrying a failed append; the last value repeats until the disk recovers. */
export const JSONL_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1000]

// ---- writer ---------------------------------------------------------------------------------------------------

export interface JsonlWriterOptions {
  backlogWarnBytes?: number
  /** Called (never throws) for warnings such as a large backlog. */
  onWarn?: (msg: string, data?: Record<string, unknown>) => void
  /** Called for each failed write attempt; the lines stay queued and are retried. */
  onError?: (err: DimFactoryError) => void
  retryDelaysMs?: readonly number[]
  /** Test seam: replaces `handle.write` (e.g. to simulate ENOSPC/EBUSY). */
  write?: (
    handle: FileHandle,
    buf: Buffer,
    offset: number,
    length: number,
  ) => Promise<{ bytesWritten: number }>
}

interface Waiter {
  resolve: () => void
  reject: (err: unknown) => void
}

/** Find the length of the file prefix that ends with a newline (drops a torn trailing line). */
async function completePrefixLength(handle: FileHandle, size: number): Promise<number> {
  let end = size
  const buf = Buffer.allocUnsafe(READ_CHUNK)
  while (end > 0) {
    const start = Math.max(0, end - READ_CHUNK)
    const { bytesRead } = await handle.read(buf, 0, end - start, start)
    for (let i = bytesRead - 1; i >= 0; i--) if (buf[i] === NL) return start + i + 1
    end = start
  }
  return 0
}

/**
 * Append-only JSONL writer for one file. One FileHandle opened `'a'`; every line appended in the same tick is
 * joined into a single `write()`, writes are serialized, and a failed write keeps its lines queued and retries
 * with backoff (flush() rejects meanwhile). `datasync()` makes everything appended so far durable.
 */
export class JsonlWriter {
  readonly file: string
  /** Bytes of a torn trailing line removed at open (a crash mid-write). */
  readonly truncatedBytes: number
  readonly #opts: JsonlWriterOptions
  #handle: FileHandle
  #queue: Buffer[] = []
  #queuedBytes = 0
  #size: number
  #lines = 0
  #scheduled = false
  #draining: Promise<void> | null = null
  #waiters: Waiter[] = []
  #retryAttempt = 0
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #warned = false
  #closed = false

  private constructor(
    file: string,
    handle: FileHandle,
    size: number,
    truncated: number,
    opts: JsonlWriterOptions,
  ) {
    this.file = file
    this.#handle = handle
    this.#size = size
    this.truncatedBytes = truncated
    this.#opts = opts
  }

  /** Open (creating parents and the file) for append. A torn trailing partial line is truncated away first. */
  static async open(file: string, opts: JsonlWriterOptions = {}): Promise<JsonlWriter> {
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      let size = 0
      try {
        size = (await stat(file)).size
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw err
      }
      let truncated = 0
      if (size > 0) {
        const rh = await open(file, 'r')
        let keep: number
        try {
          keep = await completePrefixLength(rh, size)
        } finally {
          await rh.close()
        }
        if (keep < size) {
          await truncate(file, keep)
          truncated = size - keep
          size = keep
        }
      }
      const handle = await open(file, 'a', 0o600)
      return new JsonlWriter(file, handle, size, truncated, opts)
    } catch (err) {
      throw storageError(`cannot open ${file} for append`, err)
    }
  }

  /** Byte offset where the next appended line will start (bytes on disk + queued). */
  get size(): number {
    return this.#size
  }

  /** Bytes appended but not yet written. */
  get pendingBytes(): number {
    return this.#queuedBytes
  }

  /** Lines appended through this writer instance. */
  get linesAppended(): number {
    return this.#lines
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Serialize and append one value; returns the byte offset where its line starts. */
  append(value: unknown): number {
    return this.appendLine(JSON.stringify(value))
  }

  /** Append one pre-serialized line (must not contain a newline); returns its byte offset. */
  appendLine(line: string): number {
    if (this.#closed) throw new DimFactoryError('INTERNAL', `JSONL writer for ${this.file} is closed`)
    if (line.includes('\n')) throw new DimFactoryError('INTERNAL', 'a JSONL line must not contain a newline')
    const buf = Buffer.from(`${line}\n`, 'utf8')
    const offset = this.#size
    this.#queue.push(buf)
    this.#queuedBytes += buf.length
    this.#size += buf.length
    this.#lines++
    const warnAt = this.#opts.backlogWarnBytes ?? JSONL_BACKLOG_WARN_BYTES
    if (this.#queuedBytes > warnAt && !this.#warned) {
      this.#warned = true
      this.#warn('jsonl backlog is large', { file: this.file, bytes: this.#queuedBytes })
    }
    this.#schedule()
    return offset
  }

  /** Resolves once every line appended so far is written (not necessarily durable). */
  flush(): Promise<void> {
    if (this.#queue.length === 0 && this.#draining === null) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
      if (this.#retryTimer !== null) {
        // An explicit flush retries a failed write now instead of waiting for the backoff.
        clearTimeout(this.#retryTimer)
        this.#retryTimer = null
        this.#kick()
      } else {
        this.#schedule()
      }
    })
  }

  /** flush() then fdatasync: everything appended so far survives a crash. */
  async datasync(): Promise<void> {
    await this.flush()
    try {
      await this.#handle.datasync()
    } catch (err) {
      throw storageError(`cannot sync ${this.file}`, err)
    }
  }

  /** Flush and close. If the final flush fails the handle is still closed and the error is thrown. */
  async close(): Promise<void> {
    if (this.#closed) return
    let failure: Error | undefined
    try {
      await this.datasync()
    } catch (err) {
      failure = err instanceof Error ? err : storageError(`cannot close ${this.file}`, err)
    }
    this.#closed = true
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    await this.#handle.close().catch(() => undefined)
    if (failure !== undefined) throw failure
  }

  #warn(msg: string, data?: Record<string, unknown>): void {
    try {
      this.#opts.onWarn?.(msg, data)
    } catch {
      // warnings never throw
    }
  }

  #schedule(): void {
    if (this.#scheduled || this.#draining !== null || this.#retryTimer !== null) return
    this.#scheduled = true
    // One write per tick: everything appended synchronously before the microtask runs is joined.
    queueMicrotask(() => {
      this.#scheduled = false
      this.#kick()
    })
  }

  #kick(): void {
    if (this.#draining !== null) return
    this.#draining = this.#drain().finally(() => {
      this.#draining = null
      if (this.#queue.length === 0) {
        // Waiters that arrived while the last write was finishing.
        for (const w of this.#waiters.splice(0)) w.resolve()
      } else if (this.#retryTimer === null && !this.#closed) {
        this.#schedule()
      }
    })
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.length === 1 ? this.#queue[0]! : Buffer.concat(this.#queue)
      const count = this.#queue.length
      let written = 0
      try {
        while (written < batch.length) {
          const { bytesWritten } =
            this.#opts.write !== undefined
              ? await this.#opts.write(this.#handle, batch, written, batch.length - written)
              : await this.#handle.write(batch, written, batch.length - written, null)
          written += bytesWritten
        }
      } catch (err) {
        // Keep the unwritten remainder at the head of the queue; never drop a line.
        this.#queue.splice(0, count, batch.subarray(written))
        this.#queuedBytes -= written
        const wrapped = storageError(`cannot append to ${this.file}`, err)
        try {
          this.#opts.onError?.(wrapped)
        } catch {
          // callbacks never throw into the writer
        }
        const waiters = this.#waiters.splice(0)
        for (const w of waiters) w.reject(wrapped)
        const delays = this.#opts.retryDelaysMs ?? JSONL_RETRY_DELAYS_MS
        const wait = delays[Math.min(this.#retryAttempt, delays.length - 1)] ?? 1000
        this.#retryAttempt++
        if (!this.#closed) {
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null
            this.#kick()
          }, wait)
        }
        return
      }
      this.#queue.splice(0, count)
      this.#queuedBytes -= batch.length
      this.#retryAttempt = 0
      if (this.#queuedBytes <= (this.#opts.backlogWarnBytes ?? JSONL_BACKLOG_WARN_BYTES)) this.#warned = false
    }
    const waiters = this.#waiters.splice(0)
    for (const w of waiters) w.resolve()
  }
}

// ---- reader ---------------------------------------------------------------------------------------------------

export interface JsonlLine {
  value: unknown
  /** Byte offset of the line's first byte. */
  offset: number
  /** Byte length including the newline. */
  length: number
  /** 1-based physical line number counted from `start`. */
  lineNo: number
}

export interface JsonlScanStats {
  /** False when the file does not exist. */
  exists: boolean
  /** Complete lines that parsed. */
  lines: number
  /** Complete lines that did not parse (skipped). */
  bad: number
  /** First few bad line numbers, for logs. */
  badLineNos: number[]
  /** A trailing line without a newline was ignored. */
  partialTail: boolean
  /** Offset just past the last complete line scanned. */
  endOffset: number
  /** The callback stopped the scan early. */
  stopped: boolean
}

export interface ScanJsonlOptions {
  /** Byte offset to start at; must be the start of a line (default 0). */
  start?: number
  /** Stop before this byte offset (default: end of file). */
  end?: number
  onBad?: (info: { lineNo: number; offset: number; text: string; error: string }) => void
  chunkSize?: number
}

const MAX_BAD_LINE_NOS = 20

/**
 * Stream a JSONL file line by line (byte-exact offsets). Blank lines are skipped, `\r\n` is tolerated, a trailing
 * partial line is ignored and unparsable lines are counted. `onLine` returning `false` stops the scan.
 */
export async function scanJsonl(
  file: string,
  onLine: (line: JsonlLine) => boolean | void,
  opts: ScanJsonlOptions = {},
): Promise<JsonlScanStats> {
  const start = opts.start ?? 0
  const stats: JsonlScanStats = {
    exists: true,
    lines: 0,
    bad: 0,
    badLineNos: [],
    partialTail: false,
    endOffset: start,
    stopped: false,
  }
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { ...stats, exists: false }
    throw storageError(`cannot read ${file}`, err)
  }
  try {
    const end = opts.end ?? (await handle.stat()).size
    const buf = Buffer.allocUnsafe(opts.chunkSize ?? READ_CHUNK)
    let carry: Buffer | null = null
    let carryOffset = start
    let pos = start
    let lineNo = 0
    while (pos < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, end - pos), pos)
      if (bytesRead === 0) break
      let chunk = buf.subarray(0, bytesRead)
      if (carry !== null) {
        chunk = Buffer.concat([carry, chunk])
      } else {
        carryOffset = pos
      }
      pos += bytesRead
      let lineStart = 0
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== NL) continue
        lineNo++
        const offset = carryOffset + lineStart
        const length = i + 1 - lineStart
        let lineEnd = i
        if (lineEnd > lineStart && chunk[lineEnd - 1] === CR) lineEnd--
        const text = chunk.toString('utf8', lineStart, lineEnd)
        lineStart = i + 1
        stats.endOffset = offset + length
        if (text.trim() === '') continue
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch (err) {
          stats.bad++
          if (stats.badLineNos.length < MAX_BAD_LINE_NOS) stats.badLineNos.push(lineNo)
          opts.onBad?.({ lineNo, offset, text: text.slice(0, 200), error: (err as Error).message })
          continue
        }
        stats.lines++
        if (onLine({ value, offset, length, lineNo }) === false) {
          stats.stopped = true
          return stats
        }
      }
      if (lineStart < chunk.length) {
        carry = Buffer.from(chunk.subarray(lineStart))
        carryOffset += lineStart
      } else {
        carry = null
      }
    }
    if (carry !== null && carry.length > 0) stats.partialTail = true
    return stats
  } finally {
    await handle.close()
  }
}

/** Read every parsable line of a JSONL file. A missing file reads as empty. */
export async function readJsonlAll(
  file: string,
  opts: Omit<ScanJsonlOptions, 'start' | 'end'> = {},
): Promise<{ values: unknown[]; stats: JsonlScanStats }> {
  const values: unknown[] = []
  const stats = await scanJsonl(file, (l) => void values.push(l.value), opts)
  return { values, stats }
}

/**
 * Parse the complete lines in the last `maxBytes` of a file (default 64 KB). The first line of the window is
 * skipped unless the window starts at offset 0 (it may be cut). Offsets are absolute.
 */
export async function readJsonlTail(
  file: string,
  maxBytes = 64 * 1024,
): Promise<{ lines: JsonlLine[]; size: number; windowStart: number }> {
  let size: number
  try {
    size = (await stat(file)).size
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { lines: [], size: 0, windowStart: 0 }
    throw storageError(`cannot read ${file}`, err)
  }
  let windowStart = Math.max(0, size - maxBytes)
  if (windowStart > 0) {
    // Advance to the first line boundary inside the window.
    const handle = await open(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(Math.min(maxBytes, size - windowStart))
      const { bytesRead } = await handle.read(buf, 0, buf.length, windowStart - 1)
      const idx = buf.subarray(0, bytesRead).indexOf(NL)
      if (idx < 0) return { lines: [], size, windowStart: size }
      windowStart = windowStart - 1 + idx + 1
    } finally {
      await handle.close()
    }
  }
  const lines: JsonlLine[] = []
  await scanJsonl(file, (l) => void lines.push(l), { start: windowStart, end: size })
  return { lines, size, windowStart }
}

/** Size of a file in bytes; 0 when it does not exist. */
export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 0
    throw storageError(`cannot stat ${file}`, err)
  }
}

// ---- seq offset index -----------------------------------------------------------------------------------------

export interface SeqOffset {
  seq: number
  offset: number
}

/**
 * Sparse seq → byte offset index: one entry every `every` seqs (the first noted seq always gets one). Replay seeks
 * to `floor(seq)` and scans forward. Notes must arrive in increasing seq order.
 */
export class SeqOffsetIndex {
  readonly every: number
  #seqs: number[] = []
  #offsets: number[] = []

  constructor(every = 500) {
    this.every = Math.max(1, Math.trunc(every))
  }

  get size(): number {
    return this.#seqs.length
  }

  get firstSeq(): number | undefined {
    return this.#seqs[0]
  }

  get lastSeq(): number | undefined {
    return this.#seqs.at(-1)
  }

  /** Record `seq` at `offset` if it is the first entry or `every` seqs past the last one. */
  note(seq: number, offset: number): void {
    const last = this.#seqs.at(-1)
    if (last !== undefined && seq < last + this.every) return
    this.#seqs.push(seq)
    this.#offsets.push(offset)
  }

  /** The entry with the greatest seq ≤ `seq`, or null. */
  floor(seq: number): SeqOffset | null {
    let lo = 0
    let hi = this.#seqs.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.#seqs[mid]! <= seq) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found < 0 ? null : { seq: this.#seqs[found]!, offset: this.#offsets[found]! }
  }

  clear(): void {
    this.#seqs = []
    this.#offsets = []
  }
}
