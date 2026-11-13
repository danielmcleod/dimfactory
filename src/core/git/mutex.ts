// In-process async mutexes for git work:
// - a per-folderKey mutex serializes every shadow-repo write (snapshot, prepare, live-count refresh); the live-count
//   poll skips its tick while the mutex is busy;
// - a per-`--git-common-dir` mutex serializes Dim Factory's few writes to a user repo (worktree add/remove/prune,
//   run-branch update-ref/symbolic-ref), retrying 3× at 500 ms while a `*.lock` is held by someone else.
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isGitError, isLockContention } from './exec.ts'

/** FIFO async mutex. Not reentrant: a holder must not call run() on the same mutex again. */
export class AsyncMutex {
  private readonly queue: (() => void)[] = []
  private locked = false

  /** A holder is running. */
  get busy(): boolean {
    return this.locked
  }

  /** Callers waiting behind the holder. */
  get waiting(): number {
    return this.queue.length
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return Promise.resolve()
    }
    return new Promise((res) => this.queue.push(res))
  }

  private release(): void {
    const next = this.queue.shift()
    if (next !== undefined) next()
    else this.locked = false
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** Run only when free; undefined when another holder is active (the caller skips this tick). */
  tryRun<T>(fn: () => Promise<T> | T): Promise<T> | undefined {
    if (this.locked) return undefined
    return this.run(fn)
  }
}

/** A keyed set of mutexes; entries are dropped when idle so the map never grows without bound. */
export class MutexMap {
  private readonly map = new Map<string, { mutex: AsyncMutex; users: number }>()

  isBusy(key: string): boolean {
    return this.map.get(key)?.mutex.busy ?? false
  }

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let entry = this.map.get(key)
    if (entry === undefined) {
      entry = { mutex: new AsyncMutex(), users: 0 }
      this.map.set(key, entry)
    }
    entry.users++
    try {
      return await entry.mutex.run(fn)
    } finally {
      entry.users--
      if (entry.users === 0) this.map.delete(key)
    }
  }

  tryRun<T>(key: string, fn: () => Promise<T> | T): Promise<T> | undefined {
    if (this.isBusy(key)) return undefined
    return this.run(key, fn)
  }

  /** Keys with a holder or waiters (diagnostics). */
  keys(): string[] {
    return [...this.map.keys()]
  }
}

const folderLocks = new MutexMap()
const commonDirLocks = new MutexMap()

/** Serialize shadow-repo work for one folderKey. */
export function withFolderLock<T>(folderKey: string, fn: () => Promise<T> | T): Promise<T> {
  return folderLocks.run(folderKey, fn)
}

/** Run only if no shadow work holds this folderKey; undefined means "busy, skip this tick". */
export function tryWithFolderLock<T>(folderKey: string, fn: () => Promise<T> | T): Promise<T> | undefined {
  return folderLocks.tryRun(folderKey, fn)
}

export function isFolderBusy(folderKey: string): boolean {
  return folderLocks.isBusy(folderKey)
}

/** Mutex key for a git common dir: absolute, case-folded where the platform folds case by default. */
export function commonDirKey(commonDir: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolve(commonDir).replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs
}

export interface LockRetryOptions {
  /** Total attempts (default 3). */
  attempts?: number
  delayMs?: number
  /** Which errors are worth retrying (default: a GitError whose stderr names a `*.lock`). */
  isRetryable?: (err: unknown) => boolean
}

export function isLockFileError(err: unknown): boolean {
  return isGitError(err) && isLockContention(err.stderr)
}

/** Retry `fn` while another process holds a git lock file: 3 attempts, 500 ms apart. */
export async function retryOnLock<T>(fn: () => Promise<T>, opts: LockRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const wait = opts.delayMs ?? 500
  const retryable = opts.isRetryable ?? isLockFileError
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts || !retryable(err)) throw err
      await delay(wait)
    }
  }
}

/**
 * Serialize a write to a user repository per `--git-common-dir` (linked worktrees share one), retrying while a
 * `*.lock` file is held by another git process.
 */
export function withCommonDirLock<T>(
  commonDir: string,
  fn: () => Promise<T>,
  opts: LockRetryOptions = {},
): Promise<T> {
  return commonDirLocks.run(commonDirKey(commonDir), () => retryOnLock(fn, opts))
}
