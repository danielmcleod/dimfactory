// Per-run in-memory ring of recent envelopes for cheap replay (5000 envelopes or 8 MB per run).
import type { RunEnvelope } from '../../shared/run.ts'

export const RING_MAX_ITEMS = 5000
export const RING_MAX_BYTES = 8 * 1024 * 1024

export interface RingOptions {
  maxItems?: number
  maxBytes?: number
}

/**
 * FIFO of the most recent envelopes of one run, bounded by count and by serialized bytes (the newest envelope is
 * always kept, even when it alone exceeds the byte bound). Seqs must be pushed in increasing order.
 */
export class RingBuffer {
  readonly maxItems: number
  readonly maxBytes: number
  #items: (RunEnvelope | undefined)[]
  #sizes: number[]
  #head = 0
  #count = 0
  #bytes = 0

  constructor(opts: RingOptions = {}) {
    this.maxItems = Math.max(1, opts.maxItems ?? RING_MAX_ITEMS)
    this.maxBytes = Math.max(1, opts.maxBytes ?? RING_MAX_BYTES)
    this.#items = new Array<RunEnvelope | undefined>(this.maxItems)
    this.#sizes = new Array<number>(this.maxItems).fill(0)
  }

  get length(): number {
    return this.#count
  }

  get bytes(): number {
    return this.#bytes
  }

  /** Seq of the oldest envelope held, or undefined when empty. */
  get firstSeq(): number | undefined {
    return this.#count === 0 ? undefined : this.#at(0).seq
  }

  get lastSeq(): number | undefined {
    return this.#count === 0 ? undefined : this.#at(this.#count - 1).seq
  }

  #at(i: number): RunEnvelope {
    return this.#items[(this.#head + i) % this.maxItems]!
  }

  #dropOldest(): void {
    const idx = this.#head
    this.#bytes -= this.#sizes[idx]!
    this.#items[idx] = undefined
    this.#sizes[idx] = 0
    this.#head = (this.#head + 1) % this.maxItems
    this.#count--
  }

  push(env: RunEnvelope, bytes: number): void {
    if (this.#count === this.maxItems) this.#dropOldest()
    const idx = (this.#head + this.#count) % this.maxItems
    this.#items[idx] = env
    this.#sizes[idx] = bytes
    this.#count++
    this.#bytes += bytes
    while (this.#bytes > this.maxBytes && this.#count > 1) this.#dropOldest()
  }

  /** True when the ring holds every envelope with seq > sinceSeq (up to its newest). */
  covers(sinceSeq: number): boolean {
    const first = this.firstSeq
    return first !== undefined && sinceSeq >= first - 1
  }

  /**
   * Envelopes with seq > sinceSeq, at most `limit`, or null when the ring cannot serve that range (it starts
   * later than sinceSeq + 1).
   */
  since(sinceSeq: number, limit: number): RunEnvelope[] | null {
    if (this.#count === 0) return null
    if (!this.covers(sinceSeq)) return null
    // Binary search for the first seq > sinceSeq.
    let lo = 0
    let hi = this.#count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.#at(mid).seq <= sinceSeq) lo = mid + 1
      else hi = mid
    }
    const out: RunEnvelope[] = []
    for (let i = lo; i < this.#count && out.length < limit; i++) out.push(this.#at(i))
    return out
  }

  clear(): void {
    this.#items = new Array<RunEnvelope | undefined>(this.maxItems)
    this.#sizes.fill(0)
    this.#head = 0
    this.#count = 0
    this.#bytes = 0
  }
}
