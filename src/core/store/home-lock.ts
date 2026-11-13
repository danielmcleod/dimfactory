// One Dim Factory process per DIM_FACTORY_HOME: `instance.lock` is created with
// open('wx') and holds {pid, startMs, kind}. It is stale when the pid is dead or its start time does not match
// (pid reuse), checked against a proc/ps snapshot. `session.json {pid, startedAt, clean}` records whether the last
// session exited cleanly. The app and CLI run/resume take the lock; read-only CLI commands do not.
import * as fs from 'node:fs'
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAlive as procIsAlive, snapshotProcesses } from '../proc/ps.ts'
import type { ProcSnapshot } from '../proc/ps.ts'
import { DimFactoryError, errnoCode, storageError } from '../errors.ts'
import { ensureDir, homePaths } from '../home.ts'
import type { HomePaths } from '../home.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import { writeFileAtomic, writeFileAtomicSync } from './atomic.ts'
import { isPlainObject } from './versions.ts'

export type InstanceKind = 'app' | 'cli'

export interface LockInfo {
  schemaVersion: 1
  pid: number
  /** Process start (epoch ms) of the holder, for pid-reuse detection. */
  startMs: number
  kind: InstanceKind
  acquiredAt: number
}

export interface SessionInfo {
  schemaVersion: 1
  pid: number
  kind: InstanceKind
  startedAt: number
  clean: boolean
  endedAt?: number
}

/** A holder whose OS start time is within this of the recorded startMs is the same process. */
export const LOCK_START_TOLERANCE_MS = 10_000
/** An empty/unparsable lock younger than this is being written by its creator (not stale yet). */
export const LOCK_FRESH_MS = 5_000

export interface HomeLockDeps {
  isAlive?: (pid: number) => boolean
  snapshot?: () => Promise<ProcSnapshot>
  now?: () => number
  /** This process (tests). */
  pid?: number
  startMs?: number
  log?: Logger
}

/** This process's start time, epoch ms. */
export function processStartMs(): number {
  return Math.round(performance.timeOrigin)
}

function parseLock(v: unknown): LockInfo | null {
  if (!isPlainObject(v)) return null
  const { pid, startMs, kind } = v
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof startMs !== 'number' || (kind !== 'app' && kind !== 'cli')) return null
  const acquiredAt = typeof v['acquiredAt'] === 'number' ? v['acquiredAt'] : startMs
  return { schemaVersion: 1, pid, startMs, kind, acquiredAt }
}

export type LockFileRead =
  | { kind: 'none' }
  | { kind: 'ok'; info: LockInfo; text: string; mtimeMs: number }
  | { kind: 'corrupt'; text: string; mtimeMs: number }

export async function readLockFile(file: string): Promise<LockFileRead> {
  let text: string
  let mtimeMs: number
  try {
    ;[text, mtimeMs] = await Promise.all([readFile(file, 'utf8'), stat(file).then((s) => s.mtimeMs)])
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { kind: 'none' }
    throw storageError(`cannot read ${file}`, err)
  }
  try {
    const info = parseLock(JSON.parse(text))
    return info === null ? { kind: 'corrupt', text, mtimeMs } : { kind: 'ok', info, text, mtimeMs }
  } catch {
    return { kind: 'corrupt', text, mtimeMs }
  }
}

/** Who holds the home lock right now (null when unlocked or unreadable). For read-only commands and messages. */
export async function readHomeLock(home: string | HomePaths): Promise<LockInfo | null> {
  const p = typeof home === 'string' ? homePaths(home) : home
  const r = await readLockFile(p.instanceLock)
  return r.kind === 'ok' ? r.info : null
}

export type HolderVerdict =
  | { stale: true; reason: 'dead' | 'pid-reused' }
  | { stale: false; reason: 'alive' | 'self' | 'unknown-start' }

/** Decide whether the recorded holder is still running (pid alive and start time matching). */
export async function checkLockHolder(info: LockInfo, deps: HomeLockDeps = {}): Promise<HolderVerdict> {
  const selfPid = deps.pid ?? process.pid
  const selfStart = deps.startMs ?? processStartMs()
  if (info.pid === selfPid) {
    return Math.abs(info.startMs - selfStart) <= LOCK_START_TOLERANCE_MS
      ? { stale: false, reason: 'self' }
      : { stale: true, reason: 'pid-reused' }
  }
  if (!(deps.isAlive ?? procIsAlive)(info.pid)) return { stale: true, reason: 'dead' }
  let snap: ProcSnapshot
  try {
    snap = await (deps.snapshot ?? (() => snapshotProcesses()))()
  } catch {
    // Cannot tell: assume the holder is alive (never break a live lock).
    return { stale: false, reason: 'unknown-start' }
  }
  const p = snap.procs.find((x) => x.pid === info.pid)
  if (p === undefined) return { stale: true, reason: 'dead' }
  if (p.startMs === null) return { stale: false, reason: 'unknown-start' }
  return Math.abs(p.startMs - info.startMs) <= LOCK_START_TOLERANCE_MS
    ? { stale: false, reason: 'alive' }
    : { stale: true, reason: 'pid-reused' }
}

/**
 * Remove a stale lock without clobbering one a racing process just created: move it aside atomically, and if what
 * we moved is not the content we judged stale, put it back with link() (which fails if yet another lock exists).
 */
async function breakStaleLock(file: string, judgedText: string): Promise<void> {
  const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await rename(file, aside)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return
    throw storageError(`cannot remove the stale lock ${file}`, err)
  }
  const moved = await readFile(aside, 'utf8').catch(() => judgedText)
  if (moved !== judgedText) await link(aside, file).catch(() => undefined)
  await rm(aside, { force: true }).catch(() => undefined)
}

export class HomeLock {
  readonly file: string
  readonly info: LockInfo
  #released = false

  constructor(file: string, info: LockInfo) {
    this.file = file
    this.info = info
  }

  get released(): boolean {
    return this.#released
  }

  /** Remove instance.lock if it is still ours. */
  async release(): Promise<void> {
    if (this.#released) return
    this.#released = true
    const r = await readLockFile(this.file).catch(() => ({ kind: 'none' }) as const)
    if (r.kind === 'ok' && r.info.pid === this.info.pid && r.info.startMs === this.info.startMs) {
      await rm(this.file, { force: true }).catch(() => undefined)
    }
  }

  /** Synchronous release for `process.on('exit')` / session-end. */
  releaseSync(): void {
    if (this.#released) return
    this.#released = true
    try {
      const info = parseLock(JSON.parse(fs.readFileSync(this.file, 'utf8')))
      if (info !== null && info.pid === this.info.pid && info.startMs === this.info.startMs)
        fs.rmSync(this.file)
    } catch {
      // best effort
    }
  }
}

export interface AcquireOptions extends HomeLockDeps {
  kind: InstanceKind
}

/**
 * Take `instance.lock`. Breaks a stale lock (dead pid, reused pid, or a corrupt file older than 5 s) and retries;
 * otherwise throws HOME_LOCKED with the holder in `details` ({pid, kind, startMs}).
 */
export async function acquireHomeLock(home: string | HomePaths, opts: AcquireOptions): Promise<HomeLock> {
  const p = typeof home === 'string' ? homePaths(home) : home
  const log = opts.log ?? silentLogger
  const now = opts.now ?? Date.now
  const info: LockInfo = {
    schemaVersion: 1,
    pid: opts.pid ?? process.pid,
    startMs: opts.startMs ?? processStartMs(),
    kind: opts.kind,
    acquiredAt: now(),
  }
  await ensureDir(p.home)
  const text = `${JSON.stringify(info)}\n`
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await open(p.instanceLock, 'wx', 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return new HomeLock(p.instanceLock, info)
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw storageError(`cannot create ${p.instanceLock}`, err)
    }
    const cur = await readLockFile(p.instanceLock)
    if (cur.kind === 'none') continue
    if (cur.kind === 'corrupt') {
      if (now() - cur.mtimeMs < LOCK_FRESH_MS) {
        throw new DimFactoryError('HOME_LOCKED', 'Another Dim Factory is starting with this home folder', {
          details: { file: p.instanceLock },
        })
      }
      log.warn('breaking a corrupt home lock', { file: p.instanceLock })
      await breakStaleLock(p.instanceLock, cur.text)
      continue
    }
    const verdict = await checkLockHolder(cur.info, opts)
    if (!verdict.stale) {
      const who = cur.info.kind === 'app' ? 'the Dim Factory app' : 'a Dim Factory CLI command'
      throw new DimFactoryError(
        'HOME_LOCKED',
        `${who} (pid ${cur.info.pid}) is already using ${p.home}; close it or wait for it to finish`,
        {
          details: {
            pid: cur.info.pid,
            kind: cur.info.kind,
            startMs: cur.info.startMs,
            reason: verdict.reason,
          },
        },
      )
    }
    log.warn('breaking a stale home lock', { pid: cur.info.pid, kind: cur.info.kind, reason: verdict.reason })
    await breakStaleLock(p.instanceLock, cur.text)
  }
  throw new DimFactoryError('HOME_LOCKED', `could not take ${p.instanceLock} (contended)`, {
    details: { file: p.instanceLock },
  })
}

// ---- session.json ---------------------------------------------------------------------------------------------

function parseSession(v: unknown): SessionInfo | null {
  if (!isPlainObject(v)) return null
  const { pid, startedAt, clean, kind } = v
  if (typeof pid !== 'number' || typeof startedAt !== 'number' || typeof clean !== 'boolean') return null
  const out: SessionInfo = {
    schemaVersion: 1,
    pid,
    kind: kind === 'cli' ? 'cli' : 'app',
    startedAt,
    clean,
  }
  if (typeof v['endedAt'] === 'number') out.endedAt = v['endedAt']
  return out
}

export async function readSession(home: string | HomePaths): Promise<SessionInfo | null> {
  const p = typeof home === 'string' ? homePaths(home) : home
  try {
    return parseSession(JSON.parse(await readFile(p.session, 'utf8')))
  } catch {
    return null
  }
}

export interface SessionStart {
  previous: SessionInfo | null
  /** The previous session never marked a clean exit (crash, kill -9, power loss). */
  uncleanExit: boolean
  current: SessionInfo
}

/** Record a new session (`clean:false`) and report whether the previous one exited uncleanly. Hold the lock first. */
export async function beginSession(
  home: string | HomePaths,
  opts: { kind: InstanceKind; pid?: number; startedAt?: number },
): Promise<SessionStart> {
  const p = typeof home === 'string' ? homePaths(home) : home
  const previous = await readSession(p)
  const current: SessionInfo = {
    schemaVersion: 1,
    pid: opts.pid ?? process.pid,
    kind: opts.kind,
    startedAt: opts.startedAt ?? Date.now(),
    clean: false,
  }
  await writeFileAtomic(p.session, `${JSON.stringify(current, null, 2)}\n`)
  return { previous, uncleanExit: previous !== null && !previous.clean, current }
}

/** Mark the session clean (normal quit). */
export async function endSession(
  home: string | HomePaths,
  session: SessionInfo,
  endedAt = Date.now(),
): Promise<void> {
  const p = typeof home === 'string' ? homePaths(home) : home
  await writeFileAtomic(p.session, `${JSON.stringify({ ...session, clean: true, endedAt }, null, 2)}\n`)
}

/** Synchronous clean marker for best-effort shutdown paths. Never throws. */
export function endSessionSync(home: string | HomePaths, session: SessionInfo, endedAt = Date.now()): void {
  const p = typeof home === 'string' ? homePaths(home) : home
  try {
    writeFileAtomicSync(p.session, `${JSON.stringify({ ...session, clean: true, endedAt }, null, 2)}\n`)
  } catch {
    // best effort
  }
}

export interface HomeSession {
  lock: HomeLock
  session: SessionStart
  /** Mark the session clean and release the lock. */
  close(): Promise<void>
  /** Synchronous variant for exit handlers. */
  closeSync(): void
}

/** Acquire the home lock, then begin a session (the boot sequence for the app and CLI run/resume). */
export async function openHomeSession(home: string | HomePaths, opts: AcquireOptions): Promise<HomeSession> {
  const lock = await acquireHomeLock(home, opts)
  let session: SessionStart
  try {
    session = await beginSession(home, { kind: opts.kind, pid: lock.info.pid })
  } catch (err) {
    await lock.release()
    throw err
  }
  return {
    lock,
    session,
    close: async () => {
      try {
        await endSession(home, session.current)
      } finally {
        await lock.release()
      }
    },
    closeSync: () => {
      endSessionSync(home, session.current)
      lock.releaseSync()
    },
  }
}
