// Text-delta coalescer: vendor token deltas are merged per (run, step, attempt)
// and flushed after 40 ms, at 8 KB, or immediately before any other event of that step, so text is never
// reordered across a tool/ask/done event and disk carries ~25 text lines/s instead of hundreds.
import type { StepKey } from '../../shared/run.ts'

export const COALESCE_FLUSH_MS = 40
export const COALESCE_MAX_BYTES = 8 * 1024

export interface CoalescedText {
  runId: string
  step: StepKey
  attempt: number
  delta: string
}

export interface TextCoalescerOptions {
  /** Receives one merged delta; called synchronously from push()/flush*() or from the timer. */
  onFlush: (text: CoalescedText) => void
  flushMs?: number
  maxBytes?: number
}

interface Pending {
  runId: string
  step: StepKey
  attempt: number
  parts: string[]
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
}

const keyOf = (runId: string, step: string, attempt: number): string =>
  `${runId}\u0000${step}\u0000${attempt}`

export class TextCoalescer {
  readonly flushMs: number
  readonly maxBytes: number
  readonly #onFlush: (text: CoalescedText) => void
  // Insertion-ordered: flushRun/flushAll emit buffers in the order their first delta arrived.
  readonly #pending = new Map<string, Pending>()

  constructor(opts: TextCoalescerOptions) {
    this.#onFlush = opts.onFlush
    this.flushMs = opts.flushMs ?? COALESCE_FLUSH_MS
    this.maxBytes = opts.maxBytes ?? COALESCE_MAX_BYTES
  }

  /** Number of (run, step, attempt) buffers holding text. */
  get size(): number {
    return this.#pending.size
  }

  hasPending(runId: string, step?: StepKey): boolean {
    for (const p of this.#pending.values()) {
      if (p.runId === runId && (step === undefined || p.step === step)) return true
    }
    return false
  }

  push(runId: string, step: StepKey, attempt: number, delta: string): void {
    if (delta === '') return
    const key = keyOf(runId, step, attempt)
    let p = this.#pending.get(key)
    if (p === undefined) {
      p = { runId, step, attempt, parts: [], bytes: 0, timer: null }
      this.#pending.set(key, p)
      const entry = p
      p.timer = setTimeout(() => {
        entry.timer = null
        this.#flushKey(key)
      }, this.flushMs)
    }
    p.parts.push(delta)
    p.bytes += Buffer.byteLength(delta, 'utf8')
    if (p.bytes >= this.maxBytes) this.#flushKey(key)
  }

  /** Flush every buffer of (run, step), all attempts. Call before emitting any other event of that step. */
  flushStep(runId: string, step: StepKey): void {
    for (const [key, p] of [...this.#pending]) if (p.runId === runId && p.step === step) this.#flushKey(key)
  }

  /** Flush every buffer of a run (before a run-level event, sync or close). */
  flushRun(runId: string): void {
    for (const [key, p] of [...this.#pending]) if (p.runId === runId) this.#flushKey(key)
  }

  flushAll(): void {
    for (const key of [...this.#pending.keys()]) this.#flushKey(key)
  }

  /** Drop a run's buffered text without emitting it. */
  discardRun(runId: string): void {
    for (const [key, p] of [...this.#pending]) {
      if (p.runId !== runId) continue
      if (p.timer !== null) clearTimeout(p.timer)
      this.#pending.delete(key)
    }
  }

  #flushKey(key: string): void {
    const p = this.#pending.get(key)
    if (p === undefined) return
    this.#pending.delete(key)
    if (p.timer !== null) clearTimeout(p.timer)
    p.timer = null
    this.#onFlush({ runId: p.runId, step: p.step, attempt: p.attempt, delta: p.parts.join('') })
  }
}
