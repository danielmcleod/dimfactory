// Folder-lock scheduler. In memory, one per Dim Factory process.
//
//  - A run's lock key is `lockKey(scopeRoot)` (git/repo.ts). Two keys conflict when one equals, contains or is
//    contained by the other (`lockKeysOverlap`).
//  - A queued run is granted iff no holder conflicts with it AND no earlier-queued run conflicts with it, so order
//    is FIFO inside a conflict set while runs in unrelated folders proceed in parallel.
//  - Holders are rebuilt at relaunch from each run.json (`restoreHolder`); the reducer decides when a run holds,
//    releases (completed / cancelled after the `stopped` snapshot, R2b) or re-requests the lock.
//  - Isolated runs lock their own worktree path, and an apply leases the folder lock: an isolated run's
//    own lock is its worktree's; applying it to the folder (or undoing that) takes a lease of the folder's lock, an
//    entry of its own in the same queue (FIFO with the runs there). A run holds at most one lock and one lease.
import { lockKeysOverlap } from '../git/repo.ts'

export interface LockEntry {
  runId: string
  lockKey: string
  /** When the run entered the queue or became the holder (epoch ms). */
  since: number
  /** An isolated run's lease of a folder's lock for an apply (not the run's own lock). */
  lease?: true
}

interface Entry extends LockEntry {
  /** The run id, or `<runId>#lease` for a lease. */
  id: string
}

interface QueueEntry extends Entry {
  grant: () => void
}

export interface SchedulerOptions {
  platform?: NodeJS.Platform
  now?: () => number
}

/** What a folder would queue behind: the conflicting holder first, else the earliest conflicting queued run. */
export interface BlockingRun {
  runId: string
  state: 'holder' | 'queued'
  since: number
}

const leaseId = (runId: string): string => `${runId}#lease`

const view = (e: Entry): LockEntry =>
  e.lease === true
    ? { runId: e.runId, lockKey: e.lockKey, since: e.since, lease: true }
    : { runId: e.runId, lockKey: e.lockKey, since: e.since }

export class FolderScheduler {
  readonly #platform: NodeJS.Platform
  readonly #now: () => number
  readonly #holders = new Map<string, Entry>()
  #queue: QueueEntry[] = []
  /** When each lock key was last released (shadow GC runs only when the key had no lock for 5 min). */
  readonly #released = new Map<string, number>()
  /** Runs whose next lock request enters at the head of the queue (`takeOverNext`). */
  readonly #front = new Set<string>()

  constructor(o: SchedulerOptions = {}) {
    this.#platform = o.platform ?? process.platform
    this.#now = o.now ?? Date.now
  }

  #conflicts(a: string, b: string): boolean {
    return lockKeysOverlap(a, b, this.#platform)
  }

  #request(
    id: string,
    runId: string,
    lockKey: string,
    grant: () => void,
    lease: boolean,
  ): 'granted' | 'queued' {
    if (this.#holders.has(id)) {
      grant()
      return 'granted'
    }
    if (!this.#queue.some((q) => q.id === id)) {
      const e: QueueEntry = { id, runId, lockKey, since: this.#now(), grant }
      if (lease) e.lease = true
      // R14: a re-run taking over its source's folder goes ahead of the runs queued behind that source.
      if (this.#front.delete(id)) this.#queue.unshift(e)
      else this.#queue.push(e)
    }
    this.#pump()
    return this.#holders.has(id) ? 'granted' : 'queued'
  }

  #release(id: string): void {
    this.#front.delete(id)
    const holder = this.#holders.get(id)
    if (holder !== undefined) this.#released.set(holder.lockKey, this.#now())
    const held = this.#holders.delete(id)
    const before = this.#queue.length
    this.#queue = this.#queue.filter((q) => q.id !== id)
    if (held || this.#queue.length !== before) this.#pump()
  }

  /**
   * Enter the queue for `lockKey`. `grant` is called (synchronously from here or from a later `release`) once the
   * run may hold the lock. A run already holding or queued is left as it is (its first callback stays).
   */
  request(runId: string, lockKey: string, grant: () => void): 'granted' | 'queued' {
    return this.#request(runId, runId, lockKey, grant, false)
  }

  /**
   * R14 (Re-run from Fix): the run's next `request` enters at the head of the queue, so when
   * the holder it takes over from (its source run, being cancelled) releases the folder, no run queued behind that
   * source takes it first. Call it before the run requests; a run that never requests is forgotten on `release`.
   */
  takeOverNext(runId: string): void {
    this.#front.add(runId)
  }

  /** Relaunch: the run's run.json says it holds the lock (running, waiting, paused or failed). */
  restoreHolder(runId: string, lockKey: string, since: number = this.#now()): void {
    this.#queue = this.#queue.filter((q) => q.id !== runId)
    this.#holders.set(runId, { id: runId, runId, lockKey, since })
  }

  /** Release the lock or leave the queue; the next eligible runs are granted. Unknown runs are ignored. */
  release(runId: string): void {
    this.#release(runId)
  }

  /**
   * Queue for a lease of `lockKey` (an isolated run's apply to its folder), FIFO with the runs there. `grant` is
   * called once it is held. A lease already held or queued is left as it is.
   */
  lease(runId: string, lockKey: string, grant: () => void): 'granted' | 'queued' {
    return this.#request(leaseId(runId), runId, lockKey, grant, true)
  }

  /** Give the lease back, or leave its queue. */
  releaseLease(runId: string): void {
    this.#release(leaseId(runId))
  }

  isLeaseHolder(runId: string): boolean {
    return this.#holders.has(leaseId(runId))
  }

  isHolder(runId: string): boolean {
    return this.#holders.has(runId)
  }

  isQueued(runId: string): boolean {
    return this.#queue.some((q) => q.id === runId)
  }

  /** Every held lock and lease (a lease is marked `lease`). */
  holders(): LockEntry[] {
    return [...this.#holders.values()].map(view)
  }

  queued(): LockEntry[] {
    return this.#queue.map(view)
  }

  /** Every lock key released in this process, with when it was last released (a lease counts too). */
  released(): { lockKey: string; at: number }[] {
    return [...this.#released].map(([lockKey, at]) => ({ lockKey, at }))
  }

  /** Why a queued run (or, with `lease`, its queued lease) waits: the conflicting holder, else the earliest ahead. */
  blockedBy(runId: string, o: { lease?: boolean } = {}): BlockingRun | undefined {
    const id = o.lease === true ? leaseId(runId) : runId
    const i = this.#queue.findIndex((q) => q.id === id)
    if (i < 0) return undefined
    const me = this.#queue[i]!
    for (const h of this.#holders.values()) {
      if (this.#conflicts(h.lockKey, me.lockKey)) return { runId: h.runId, state: 'holder', since: h.since }
    }
    for (const q of this.#queue.slice(0, i)) {
      if (this.#conflicts(q.lockKey, me.lockKey)) return { runId: q.runId, state: 'queued', since: q.since }
    }
    return undefined
  }

  /** The run a new run in `lockKey` would queue behind (preflight `folder.lock`), optionally ignoring one run. */
  blockerFor(lockKey: string, ignore?: string): BlockingRun | undefined {
    for (const h of this.#holders.values()) {
      if (h.runId !== ignore && this.#conflicts(h.lockKey, lockKey)) {
        return { runId: h.runId, state: 'holder', since: h.since }
      }
    }
    for (const q of this.#queue) {
      if (q.runId !== ignore && this.#conflicts(q.lockKey, lockKey)) {
        return { runId: q.runId, state: 'queued', since: q.since }
      }
    }
    return undefined
  }

  #pump(): void {
    const granted: QueueEntry[] = []
    const waiting: QueueEntry[] = []
    for (const q of this.#queue) {
      // A run never waits for itself: its lease is not blocked by its own lock (an isolated run from a run.json without
      // a worktree lock key holds the folder itself), nor its lock by its own lease.
      const blocked =
        [...this.#holders.values()].some(
          (h) => h.runId !== q.runId && this.#conflicts(h.lockKey, q.lockKey),
        ) || waiting.some((w) => w.runId !== q.runId && this.#conflicts(w.lockKey, q.lockKey))
      if (blocked) {
        waiting.push(q)
        continue
      }
      const held: Entry = { id: q.id, runId: q.runId, lockKey: q.lockKey, since: this.#now() }
      if (q.lease === true) held.lease = true
      this.#holders.set(q.id, held)
      granted.push(q)
    }
    this.#queue = waiting
    for (const g of granted) g.grant()
  }
}
