// Run log access for the Run view (snag buttons, Copy launch command, the Log tab). The
// snapshot does not carry every persisted body (snag actions, launch argv, diff line totals), so the view reads them
// from runs.events: the newest match by walking the log backwards in windows (or the first one, forwards from the
// start, for facts early in a run), then live envelopes from the push channel. The Log tab follows the whole log once
// (last 2,000 rows kept, AUTO answers counted) and stays live.
import { useEffect, useRef, useState } from 'react'
import type { AppEvent } from '@shared/ipc.ts'
import { RUN_EVENTS_MAX_LIMIT } from '@shared/ipc.ts'
import type { RunEnvelope, RunEventBody, RunEventOf, RunEventType } from '@shared/run.ts'
import { invoke, logToMain, subscribeEvents } from '../../ipc/client.ts'

/** How far back a newest-match search reads before giving up (windows of RUN_EVENTS_MAX_LIMIT). */
export const FIND_MAX_WINDOWS = 50

export type EnvelopeOf<T extends RunEventType> = RunEnvelope & { body: RunEventOf<T> }

/** The run's last seq as core has it now (0 when the log is empty), or null when the run cannot be read. */
export async function fetchLastSeq(runId: string): Promise<number | null> {
  const r = await invoke('runs.events', { runId, sinceSeq: Number.MAX_SAFE_INTEGER, limit: 1 })
  return r.ok ? r.value.lastSeq : null
}

/** The newest envelope whose body matches, reading the log backwards; null when none (or the log is unreadable). */
export async function findLastEnvelope(
  runId: string,
  match: (body: RunEventBody) => boolean,
  opts: { maxWindows?: number } = {},
): Promise<RunEnvelope | null> {
  let hi = await fetchLastSeq(runId)
  if (hi === null) return null
  const maxWindows = opts.maxWindows ?? FIND_MAX_WINDOWS
  for (let w = 0; w < maxWindows && hi > 0; w++) {
    const lo = Math.max(0, hi - RUN_EVENTS_MAX_LIMIT)
    const r = await invoke('runs.events', { runId, sinceSeq: lo, limit: hi - lo })
    if (!r.ok) {
      logToMain('warn', `runs.events failed for ${runId}`, r.error)
      return null
    }
    const events = r.value.events
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e !== undefined && e.seq <= hi && match(e.body)) return e.runId === runId ? e : { ...e, runId }
    }
    hi = lo
  }
  return null
}

/**
 * The first envelope whose body matches, reading the log forwards from the start (facts early in a run, which a
 * backwards search would reach only after the whole rest of the log). null when none matched before `until` did,
 * the log ended or `maxWindows` windows were read; undefined when the log cannot be read.
 */
export async function findFirstEnvelope(
  runId: string,
  match: (body: RunEventBody) => boolean,
  opts: { until?: (body: RunEventBody) => boolean; maxWindows?: number } = {},
): Promise<RunEnvelope | null | undefined> {
  let since = 0
  const maxWindows = opts.maxWindows ?? FIND_MAX_WINDOWS
  for (let w = 0; w < maxWindows; w++) {
    const r = await invoke('runs.events', { runId, sinceSeq: since, limit: RUN_EVENTS_MAX_LIMIT })
    if (!r.ok) {
      logToMain('warn', `runs.events failed for ${runId}`, r.error)
      return undefined
    }
    for (const e of r.value.events) {
      if (match(e.body)) return e.runId === runId ? e : { ...e, runId }
      if (opts.until?.(e.body) === true) return null
    }
    const last = r.value.events.at(-1)?.seq
    if (last === undefined || !r.value.more) return null
    since = last
  }
  return null
}

/** Live envelopes of one run from the push channel (stream bodies arrive only while the run is focused). */
export function subscribeRunEnvelopes(runId: string, cb: (envs: RunEnvelope[]) => void): () => void {
  return subscribeEvents((batch: AppEvent[]) => {
    const mine: RunEnvelope[] = []
    for (const ev of batch) if (ev.kind === 'run' && ev.env.runId === runId) mine.push(ev.env)
    if (mine.length > 0) cb(mine)
  })
}

/**
 * The newest envelope of type `type` matching `match`, kept current by live envelopes. undefined while the first
 * search runs, null when there is none. `key` restarts the search (e.g. a new attempt of the step).
 */
export function useLastEnvelope<T extends RunEventType>(
  runId: string,
  type: T,
  match: (body: RunEventOf<T>) => boolean,
  opts: { enabled?: boolean; key?: string | number } = {},
): EnvelopeOf<T> | null | undefined {
  const { enabled = true, key } = opts
  const matchRef = useRef(match)
  useEffect(() => {
    matchRef.current = match
  })
  const [state, setState] = useState<{ id: string; value: EnvelopeOf<T> | null | undefined }>({
    id: '',
    value: undefined,
  })
  const id = `${runId}\u0000${type}\u0000${String(key)}`

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let best: EnvelopeOf<T> | null = null
    const accepts = (b: RunEventBody): b is RunEventOf<T> =>
      b.t === type && matchRef.current(b as RunEventOf<T>)
    const offer = (e: RunEnvelope): boolean => {
      if (!accepts(e.body) || (best !== null && e.seq <= best.seq)) return false
      best = e as EnvelopeOf<T>
      return true
    }
    let searching = true
    const unsubscribe = subscribeRunEnvelopes(runId, (envs) => {
      let changed = false
      for (const e of envs) changed = offer(e) || changed
      if (changed && !searching && !cancelled) setState({ id, value: best })
    })
    void findLastEnvelope(runId, accepts).then((found) => {
      if (cancelled) return
      if (found !== null) offer(found)
      searching = false
      setState({ id, value: best })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [runId, type, enabled, id])

  return enabled && state.id === id ? state.value : enabled ? undefined : null
}

// ---- Log tab ----------------------------------------------------------------------------------------------------

/** Rows the Log tab keeps (the newest). */
export const LOG_TAIL_ROWS = 2000

export interface LogTail {
  rows: readonly RunEnvelope[]
  /**
   * auto-answered bodies that allowed the request (the "AUTO approved N" count), over the whole log. Counted as core
   * counts them (derive.ts addAutoAnswered): the native plan's capture (`why: 'plan-capture'`) is not one.
   */
  autoApproved: number
  /** auto-answered bodies that refused it (read-only passes), the plan capture left out as above. */
  autoDenied: number
  /** Envelopes read so far (the whole log once loading is done). */
  total: number
  status: 'loading' | 'ready' | 'error'
  error?: string
}

const EMPTY_TAIL: LogTail = { rows: [], autoApproved: 0, autoDenied: 0, total: 0, status: 'loading' }

/**
 * Follows a run's log: pages through it from seq 0 (keeping the last `max` rows), then applies live envelopes in
 * seq order; a gap (envelopes the push channel did not carry) is read back with runs.events first.
 */
export class LogFollower {
  readonly #runId: string
  readonly #max: number
  readonly #onChange: (tail: LogTail) => void
  #rows: RunEnvelope[] = []
  #last = 0
  #approved = 0
  #denied = 0
  #total = 0
  #status: LogTail['status'] = 'loading'
  #error: string | undefined
  #pending: RunEnvelope[] = []
  #chain: Promise<void> = Promise.resolve()
  #fetching = false
  #stopped = false
  #unsubscribe: (() => void) | null = null

  constructor(runId: string, onChange: (tail: LogTail) => void, max = LOG_TAIL_ROWS) {
    this.#runId = runId
    this.#onChange = onChange
    this.#max = max
  }

  start(): void {
    this.#unsubscribe = subscribeRunEnvelopes(this.#runId, (envs) => this.#onLive(envs))
    this.#catchUp()
  }

  stop(): void {
    this.#stopped = true
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  #onLive(envs: RunEnvelope[]): void {
    if (this.#stopped) return
    this.#pending.push(...envs)
    if (this.#fetching) return
    this.#drain()
  }

  /** Apply queued live envelopes in order; a gap queues one more catch-up first. */
  #drain(): void {
    const pending = this.#pending.sort((a, b) => a.seq - b.seq)
    this.#pending = []
    let changed = false
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i] as RunEnvelope
      if (e.seq <= this.#last) continue
      if (e.seq > this.#last + 1) {
        this.#pending = pending.slice(i)
        this.#catchUp()
        break
      }
      this.#add(e)
      changed = true
    }
    if (changed) this.#emit()
  }

  #catchUp(): void {
    this.#fetching = true
    this.#chain = this.#chain
      .then(async () => {
        for (;;) {
          if (this.#stopped) return
          const r = await invoke('runs.events', {
            runId: this.#runId,
            sinceSeq: this.#last,
            limit: RUN_EVENTS_MAX_LIMIT,
          })
          if (this.#stopped) return
          if (!r.ok) {
            this.#status = 'error'
            this.#error = r.error.message
            this.#emit()
            return
          }
          for (const e of r.value.events) if (e.seq > this.#last) this.#add(e)
          this.#status = 'ready'
          this.#emit()
          if (!r.value.more || r.value.events.length === 0) return
        }
      })
      .finally(() => {
        this.#fetching = false
        if (!this.#stopped && this.#pending.length > 0) this.#drain()
      })
  }

  #add(e: RunEnvelope): void {
    this.#last = e.seq
    this.#total++
    if (
      e.body.t === 'auto-answered' &&
      e.body.why !== 'plan-capture' &&
      e.body.why !== 'project-permission'
    ) {
      if (e.body.decision === 'allow' || e.body.decision === 'allow-session') this.#approved++
      else this.#denied++
    }
    this.#rows.push(e)
    if (this.#rows.length > this.#max * 2) this.#rows = this.#rows.slice(-this.#max)
  }

  #emit(): void {
    if (this.#stopped) return
    this.#onChange({
      rows: this.#rows.length > this.#max ? this.#rows.slice(-this.#max) : this.#rows.slice(),
      autoApproved: this.#approved,
      autoDenied: this.#denied,
      total: this.#total,
      status: this.#status,
      ...(this.#error !== undefined ? { error: this.#error } : {}),
    })
  }
}

/** Run `cb` on the next animation frame (a 16 ms timeout without one); returns the cancel function. */
function onNextFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb())
    return () => cancelAnimationFrame(id)
  }
  const t = setTimeout(cb, 16)
  return () => clearTimeout(t)
}

/** The Log tab's tail, re-rendered at most once per animation frame however often live batches arrive. */
export function useLogTail(runId: string): LogTail {
  const [tail, setTail] = useState<{ runId: string; tail: LogTail }>({ runId, tail: EMPTY_TAIL })
  useEffect(() => {
    let latest: LogTail | null = null
    let cancelFrame: (() => void) | null = null
    const f = new LogFollower(runId, (t) => {
      latest = t
      cancelFrame ??= onNextFrame(() => {
        cancelFrame = null
        if (latest !== null) setTail({ runId, tail: latest })
        latest = null
      })
    })
    f.start()
    return () => {
      f.stop()
      cancelFrame?.()
    }
  }, [runId])
  return tail.runId === runId ? tail.tail : EMPTY_TAIL
}
