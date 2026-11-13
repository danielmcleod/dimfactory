// Verify logs: runs/<id>/verify/<round>/<n>-<name>.log keeps the first 1 MB and the
// last 4 MB of a command's output. The head is written as it arrives; the tail is held in memory (at most 4 MB) and
// written, after an "omitted" marker, when the section ends. The round's combined output.log is one section per
// command (endSection), so a long first command never keeps the next one's output from showing as it runs. The live
// view reads live.log instead (LiveTail: the last 256 KB of everything, rewritten as output arrives).
import { mkdir, open, rename, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

export const LOG_HEAD_BYTES = 1024 * 1024
export const LOG_TAIL_BYTES = 4 * 1024 * 1024

export interface CappedLogOptions {
  headBytes?: number
  tailBytes?: number
}

export interface SectionSize {
  /** Bytes written to the section (kept or not). */
  bytes: number
  /** Bytes left out between its head and its tail. */
  omitted: number
}

export class CappedLog {
  readonly path: string
  readonly #file: FileHandle
  readonly #headMax: number
  readonly #tailMax: number
  #head = 0
  #headFull = false
  #total = 0
  #tail: Buffer[] = []
  #tailSize = 0
  #chain: Promise<void> = Promise.resolve()
  #closed = false

  private constructor(path: string, file: FileHandle, o: CappedLogOptions) {
    this.path = path
    this.#file = file
    this.#headMax = o.headBytes ?? LOG_HEAD_BYTES
    this.#tailMax = o.tailBytes ?? LOG_TAIL_BYTES
  }

  static async open(path: string, o: CappedLogOptions = {}): Promise<CappedLog> {
    await mkdir(dirname(path), { recursive: true })
    return new CappedLog(path, await open(path, 'w'), o)
  }

  /** Bytes written to the current section so far (kept or not). */
  get total(): number {
    return this.#total
  }

  write(text: string): void {
    if (this.#closed || text === '') return
    let buf = Buffer.from(text, 'utf8')
    this.#total += buf.length
    if (!this.#headFull) {
      const room = this.#headMax - this.#head
      let take = Math.min(room, buf.length)
      if (take < buf.length) while (take > 0 && ((buf[take] ?? 0) & 0xc0) === 0x80) take--
      this.#head += take
      this.#append(buf.subarray(0, take))
      buf = buf.subarray(take)
      if (buf.length === 0) return
      this.#headFull = true // the rest goes to the tail, so the head never resumes out of order
    }
    this.#tail.push(buf)
    this.#tailSize += buf.length
    while (this.#tailSize - (this.#tail[0]?.length ?? 0) >= this.#tailMax) {
      this.#tailSize -= this.#tail.shift()?.length ?? 0
    }
  }

  #append(buf: Buffer): void {
    if (buf.length === 0) return
    this.#chain = this.#chain
      .then(async () => {
        await this.#file.write(buf)
      })
      .catch(() => undefined) // a full disk loses log text, never the result
  }

  /**
   * Write the section's tail (its last 4 MB, from a line start when it has one) after an "omitted" marker, and start
   * a new section with its own 1 MB head. Never throws for write errors.
   */
  async endSection(): Promise<SectionSize> {
    if (this.#closed) return { bytes: 0, omitted: 0 }
    let tail = Buffer.concat(this.#tail)
    if (tail.length > this.#tailMax) {
      let start = tail.length - this.#tailMax
      const nl = tail.indexOf(0x0a, start - 1)
      if (nl !== -1 && nl + 1 < tail.length) start = nl + 1
      while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++
      tail = tail.subarray(start)
    }
    const omitted = Math.max(0, this.#total - this.#head - tail.length)
    if (omitted > 0) this.#append(Buffer.from(`\n[… ${omitted} bytes omitted by Dim Factory …]\n`, 'utf8'))
    this.#append(tail)
    const size = { bytes: this.#total, omitted }
    this.#tail = []
    this.#tailSize = 0
    this.#head = 0
    this.#headFull = false
    this.#total = 0
    await this.#chain
    return size
  }

  /** End the section and close the file. */
  async close(): Promise<SectionSize> {
    if (this.#closed) return { bytes: 0, omitted: 0 }
    const size = await this.endSection()
    this.#closed = true
    await this.#file.close().catch(() => undefined)
    return size
  }
}

/** The live view's share of a round's output (runs.output `verify:<n>` serves at most 256 KB). */
export const LIVE_TAIL_BYTES = 256 * 1024
/** How soon written output reaches the live file. */
export const LIVE_FLUSH_MS = 200

export interface LiveTailOptions {
  maxBytes?: number
  flushMs?: number
  /** The file was written (a reader now sees the output written before it). */
  onFlushed?: () => void
}

/**
 * The live view of a round's output, runs/<id>/verify/<round>/live.log. The capped logs write a command's
 * output past its first 1 MB only when the command ends, so a chatty suite's view froze for minutes. This keeps the
 * last `maxBytes` of everything written in memory and rewrites the file with them (whole, by a rename) within
 * `flushMs` of new output, after a line saying how much came before. Never throws for write errors.
 */
export class LiveTail {
  readonly path: string
  readonly #max: number
  readonly #flushMs: number
  readonly #onFlushed: (() => void) | undefined
  #chunks: Buffer[] = []
  #size = 0
  #total = 0
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #chain: Promise<void> = Promise.resolve()
  #closed = false

  constructor(path: string, o: LiveTailOptions = {}) {
    this.path = path
    this.#max = o.maxBytes ?? LIVE_TAIL_BYTES
    this.#flushMs = o.flushMs ?? LIVE_FLUSH_MS
    this.#onFlushed = o.onFlushed
  }

  write(text: string): void {
    if (this.#closed || text === '') return
    const buf = Buffer.from(text, 'utf8')
    this.#chunks.push(buf)
    this.#size += buf.length
    this.#total += buf.length
    while (this.#size - (this.#chunks[0]?.length ?? 0) >= this.#max) {
      this.#size -= this.#chunks.shift()?.length ?? 0
    }
    this.#dirty = true
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        void this.flush()
      }, this.#flushMs)
      this.#timer.unref?.()
    }
  }

  /** The file's text: the last `maxBytes` from a line start, after a line naming what came before. */
  text(): string {
    let buf = Buffer.concat(this.#chunks)
    if (buf.length > this.#max) {
      let start = buf.length - this.#max
      const nl = buf.indexOf(0x0a, start - 1)
      if (nl !== -1 && nl + 1 < buf.length) start = nl + 1
      while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++
      buf = buf.subarray(start)
    }
    const before = this.#total - buf.length
    const body = buf.toString('utf8')
    return before > 0
      ? `[Earlier output: ${Math.round(before / 1024)} KB, in the round's logs]\n${body}`
      : body
  }

  /** Write the file now when something new was written (and say so). */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#chain = this.#chain.then(async () => {
      if (!this.#dirty) return
      this.#dirty = false
      const tmp = `${this.path}.tmp`
      try {
        await writeFile(tmp, this.text())
        await rename(tmp, this.path)
      } catch {
        // A reader holding the file (antivirus) or a full disk: the next flush tries again.
        this.#dirty = true
        return
      }
      try {
        this.#onFlushed?.()
      } catch {
        // a listener's failure never stops the round
      }
    })
    return this.#chain
  }

  /** The last flush; nothing is written after it. */
  async close(): Promise<void> {
    if (this.#closed) return
    await this.flush()
    this.#closed = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
  }
}
