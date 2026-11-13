import { readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ProcSnapshot } from '../../../src/core/proc/ps.ts'
import { homePaths } from '../../../src/core/home.ts'
import {
  LOCK_FRESH_MS,
  acquireHomeLock,
  beginSession,
  checkLockHolder,
  endSession,
  openHomeSession,
  readHomeLock,
  readSession,
} from '../../../src/core/store/home-lock.ts'
import type { HomeLockDeps, LockInfo } from '../../../src/core/store/home-lock.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const lockFile = (): string => homePaths(home()).instanceLock

const T0 = 1_700_000_000_000
const OTHER = 424_242

const holder = (over: Partial<LockInfo> = {}): LockInfo => ({
  schemaVersion: 1,
  pid: OTHER,
  startMs: T0,
  kind: 'app',
  acquiredAt: T0 + 1000,
  ...over,
})

const snap =
  (procs: { pid: number; startMs: number | null }[]): (() => Promise<ProcSnapshot>) =>
  () =>
    Promise.resolve({
      source: 'cim',
      at: T0,
      procs: procs.map((p) => ({ ...p, ppid: 1, exe: 'electron.exe' })),
    })

const me: HomeLockDeps = { pid: 1000, startMs: T0 + 50_000 }

describe('checkLockHolder', () => {
  it('dead pid → stale', async () => {
    expect(await checkLockHolder(holder(), { ...me, isAlive: () => false })).toEqual({
      stale: true,
      reason: 'dead',
    })
  })

  it('alive pid with the recorded start time → held', async () => {
    const v = await checkLockHolder(holder(), {
      ...me,
      isAlive: () => true,
      snapshot: snap([{ pid: OTHER, startMs: T0 - 300 }]),
    })
    expect(v).toEqual({ stale: false, reason: 'alive' })
  })

  it('alive pid with a different start time → stale (pid reuse)', async () => {
    const v = await checkLockHolder(holder(), {
      ...me,
      isAlive: () => true,
      snapshot: snap([{ pid: OTHER, startMs: T0 + 3_600_000 }]),
    })
    expect(v).toEqual({ stale: true, reason: 'pid-reused' })
  })

  it('pid missing from the snapshot → stale; unknown start or snapshot failure → held', async () => {
    expect(await checkLockHolder(holder(), { ...me, isAlive: () => true, snapshot: snap([]) })).toMatchObject(
      {
        stale: true,
      },
    )
    expect(
      await checkLockHolder(holder(), {
        ...me,
        isAlive: () => true,
        snapshot: snap([{ pid: OTHER, startMs: null }]),
      }),
    ).toEqual({ stale: false, reason: 'unknown-start' })
    expect(
      await checkLockHolder(holder(), {
        ...me,
        isAlive: () => true,
        snapshot: () => Promise.reject(new Error('x')),
      }),
    ).toEqual({ stale: false, reason: 'unknown-start' })
  })

  it('our own pid: same start → self; different start → stale', async () => {
    expect(await checkLockHolder(holder({ pid: 1000, startMs: T0 + 50_000 }), me)).toEqual({
      stale: false,
      reason: 'self',
    })
    expect(await checkLockHolder(holder({ pid: 1000, startMs: T0 }), me)).toEqual({
      stale: true,
      reason: 'pid-reused',
    })
  })
})

describe('acquireHomeLock', () => {
  it('creates instance.lock with pid/startMs/kind and releases it', async () => {
    const lock = await acquireHomeLock(home(), { kind: 'cli', ...me, now: () => T0 + 60_000 })
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toEqual({
      schemaVersion: 1,
      pid: 1000,
      startMs: T0 + 50_000,
      kind: 'cli',
      acquiredAt: T0 + 60_000,
    })
    expect(await readHomeLock(home())).toMatchObject({ pid: 1000, kind: 'cli' })
    await lock.release()
    expect(await readdir(home())).toEqual([])
    expect(await readHomeLock(home())).toBeNull()
  })

  it('throws HOME_LOCKED naming the live holder', async () => {
    await writeFile(lockFile(), JSON.stringify(holder()))
    const err = await acquireHomeLock(home(), {
      kind: 'cli',
      ...me,
      isAlive: () => true,
      snapshot: snap([{ pid: OTHER, startMs: T0 }]),
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'HOME_LOCKED', details: { pid: OTHER, kind: 'app' } })
    expect(String((err as Error).message)).toContain('Dim Factory app')
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: OTHER })
  })

  it('breaks a stale lock (dead pid) and takes it', async () => {
    await writeFile(lockFile(), JSON.stringify(holder()))
    const lock = await acquireHomeLock(home(), { kind: 'app', ...me, isAlive: () => false })
    expect(lock.info.pid).toBe(1000)
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: 1000 })
    expect((await readdir(home())).sort()).toEqual(['instance.lock'])
    await lock.release()
  })

  it('breaks a stale lock whose pid was reused by another process', async () => {
    await writeFile(lockFile(), JSON.stringify(holder()))
    const lock = await acquireHomeLock(home(), {
      kind: 'app',
      ...me,
      isAlive: () => true,
      snapshot: snap([{ pid: OTHER, startMs: T0 + 86_400_000 }]),
    })
    expect(lock.info.pid).toBe(1000)
    await lock.release()
  })

  it('a corrupt lock is "starting" while fresh, stale once older than 5 s', async () => {
    await writeFile(lockFile(), '')
    const now = Date.now()
    await expect(acquireHomeLock(home(), { kind: 'cli', ...me, now: () => now })).rejects.toMatchObject({
      code: 'HOME_LOCKED',
    })
    const old = new Date(now - LOCK_FRESH_MS - 5000)
    await utimes(lockFile(), old, old)
    const lock = await acquireHomeLock(home(), { kind: 'cli', ...me, now: () => now })
    expect(lock.info.kind).toBe('cli')
    await lock.release()
  })

  it('release() leaves a lock that is no longer ours', async () => {
    const lock = await acquireHomeLock(home(), { kind: 'cli', ...me })
    await writeFile(lockFile(), JSON.stringify(holder()))
    await lock.release()
    expect(JSON.parse(await readFile(lockFile(), 'utf8'))).toMatchObject({ pid: OTHER })
  })
})

describe('session.json', () => {
  it('detects an unclean previous exit and records a clean one', async () => {
    const first = await beginSession(home(), { kind: 'app', pid: 1, startedAt: 10 })
    expect(first).toMatchObject({ previous: null, uncleanExit: false })
    // Crash: no endSession.
    const second = await beginSession(home(), { kind: 'app', pid: 2, startedAt: 20 })
    expect(second.uncleanExit).toBe(true)
    expect(second.previous).toMatchObject({ pid: 1, clean: false })
    await endSession(home(), second.current, 30)
    expect(await readSession(home())).toMatchObject({ pid: 2, clean: true, endedAt: 30 })
    const third = await beginSession(home(), { kind: 'cli', pid: 3 })
    expect(third.uncleanExit).toBe(false)
  })

  it('openHomeSession takes the lock, then the session; close() releases both', async () => {
    const s = await openHomeSession(home(), { kind: 'app', ...me })
    expect(s.session.current).toMatchObject({ pid: 1000, clean: false })
    await expect(
      openHomeSession(home(), {
        kind: 'cli',
        pid: 2000,
        startMs: T0,
        isAlive: () => true,
        snapshot: snap([{ pid: 1000, startMs: T0 + 50_000 }]),
      }),
    ).rejects.toMatchObject({ code: 'HOME_LOCKED' })
    await s.close()
    expect(await readHomeLock(home())).toBeNull()
    expect(await readSession(home())).toMatchObject({ clean: true })
  })
})
