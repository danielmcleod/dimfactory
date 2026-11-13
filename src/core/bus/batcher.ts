// Time-window batcher for the IPC push sink: flush 16 ms after the first enqueue; the
// next window is 33 ms when the previous flush took > 4 ms or the queue grew past 500 items. Overflow (> 5000 items
// or > 2 MB) hands the queue to an overflow policy (the sink drops run envelopes and queues a `resync`).

export const BATCH_FAST_MS = 16
export const BATCH_SLOW_MS = 33
export const BATCH_SLOW_FLUSH_MS = 4
export const BATCH_BIG_QUEUE = 500
export const BATCH_OVERFLOW_ITEMS = 5000
export const BATCH_OVERFLOW_BYTES = 2 * 1024 * 1024

export interface BatcherOptions<T> {
  /** Deliver one batch. Errors are caught and reported to onError; the batch is not retried. */
  flush: (items: T[]) => void
  /** Bytes of one item for the overflow bound (default: 0, i.e. count-only). */
  sizeOf?: (item: T) => number
  /** Given the queue at overflow, return what to keep queued (default: nothing). */
  onOverflow?: (queued: T[]) => T[]
  onError?: (err: unknown) => void
  fastMs?: number
  slowMs?: number
  slowFlushMs?: number
  bigQueue?: number
  overflowItems?: number
  overflowBytes?: number
  /** Monotonic clock in ms (default `performance.now`). */
  now?: () => number
}

export class TimeWindowBatcher<T> {
  readonly #o: Required<Omit<BatcherOptions<T>, 'sizeOf' | 'onOverflow' | 'onError'>> &
    Pick<BatcherOptions<T>, 'sizeOf' | 'onOverflow' | 'onError'>
  #queue: T[] = []
  #bytes = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #slow = false
  #disposed = false
  #overflows = 0

  constructor(opts: BatcherOptions<T>) {
    this.#o = {
      fastMs: BATCH_FAST_MS,
      slowMs: BATCH_SLOW_MS,
      slowFlushMs: BATCH_SLOW_FLUSH_MS,
      bigQueue: BATCH_BIG_QUEUE,
      overflowItems: BATCH_OVERFLOW_ITEMS,
      overflowBytes: BATCH_OVERFLOW_BYTES,
      now: () => performance.now(),
      ...opts,
    }
  }

  get length(): number {
    return this.#queue.length
  }

  get bytes(): number {
    return this.#bytes
  }

  /** How many times the overflow policy ran. */
  get overflows(): number {
    return this.#overflows
  }

  /** The window the next flush will use (ms). */
  get windowMs(): number {
    return this.#slow ? this.#o.slowMs : this.#o.fastMs
  }

  get pending(): boolean {
    return this.#timer !== null
  }

  push(item: T): void {
    if (this.#disposed) return
    this.#queue.push(item)
    this.#bytes += this.#o.sizeOf?.(item) ?? 0
    if (this.#queue.length > this.#o.bigQueue) this.#slow = true
    if (this.#queue.length > this.#o.overflowItems || this.#bytes > this.#o.overflowBytes) this.#overflow()
    if (this.#timer === null && this.#queue.length > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.flushNow()
      }, this.windowMs)
    }
  }

  /** Deliver the queue now (no-op when empty). */
  flushNow(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#queue.length === 0) return
    const items = this.#queue
    const bigQueue = items.length > this.#o.bigQueue
    this.#queue = []
    this.#bytes = 0
    const started = this.#o.now()
    try {
      this.#o.flush(items)
    } catch (err) {
      this.#report(err)
    }
    this.#slow = bigQueue || this.#o.now() - started > this.#o.slowFlushMs
  }

  /** Drop everything queued (e.g. the window is reloading). */
  clear(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#queue = []
    this.#bytes = 0
  }

  dispose(): void {
    this.clear()
    this.#disposed = true
  }

  #overflow(): void {
    this.#overflows++
    let keep: T[] = []
    try {
      keep = this.#o.onOverflow?.(this.#queue) ?? []
    } catch (err) {
      this.#report(err)
    }
    this.#queue = [...keep]
    this.#bytes = 0
    for (const item of this.#queue) this.#bytes += this.#o.sizeOf?.(item) ?? 0
  }

  #report(err: unknown): void {
    try {
      this.#o.onError?.(err)
    } catch {
      // never throw from the batcher
    }
  }
}
