// Coverage: the home lock and session marker on the paths a crash or a quit takes (storage:
// instance.lock, session.json; quit: the synchronous exit handler). A lock file of the wrong shape is corrupt
// (never trusted), the exit handler marks the session clean and frees only its own lock, and a boot that cannot write
// session.json never keeps the lock it took.
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { writeFileAtomicSync } from '../../../src/core/store/atomic.ts'
import {
  LOCK_FRESH_MS,
  acquireHomeLock,
  beginSession,
  endSessionSync,
  openHomeSession,
  readHomeLock,
  readSession,
} from '../../../src/core/store/home-lock.ts'
import type { HomeLockDeps } from '../../../src/core/store/home-lock.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''
const paths = (): ReturnType<typeof homePaths> => homePaths(home())

const T0 = 1_700_000_000_000
const me: HomeLockDeps = { pid: 1000, startMs: T0 }

describe('closeSync (the exit handler)', () => {
  it('marks the session clean and removes the lock; a second close does nothing', async () => {
    const s = await openHomeSession(home(), { kind: 'app', ...me })
    expect(await readHomeLock(home())).toMatchObject({ pid: 1000, kind: 'app' })
    s.closeSync()
    expect(await readHomeLock(home())).toBeNull()
    expect(await readSession(home())).toMatchObject({ pid: 1000, clean: true })
    expect(typeof (await readSession(home()))?.endedAt).toBe('number')
    expect(s.lock.released).toBe(true)
    // Already released: neither path touches a lock another process took since.
    await writeFile(paths().instanceLock, JSON.stringify({ pid: 2000, startMs: T0, kind: 'cli' }))
    s.closeSync()
    await s.lock.release()
    expect(await readHomeLock(home())).toMatchObject({ pid: 2000 })
  })

  it('releaseSync leaves a lock that is no longer ours, and a lock file it cannot parse', async () => {
    const lock = await acquireHomeLock(home(), { kind: 'cli', ...me })
    await writeFile(paths().instanceLock, JSON.stringify({ pid: 2000, startMs: T0, kind: 'app' }))
    lock.releaseSync()
    expect(await readHomeLock(home())).toMatchObject({ pid: 2000 })

    await writeFile(paths().instanceLock, '')
    const other = await acquireHomeLock(home(), {
      kind: 'cli',
      ...me,
      // The empty lock is old enough to be stale: taken over.
      now: () => Date.now() + LOCK_FRESH_MS + 5_000,
    })
    await writeFile(paths().instanceLock, '{not json')
    expect(() => other.releaseSync()).not.toThrow()
    expect(await readFile(paths().instanceLock, 'utf8')).toBe('{not json')
  })

  it('endSessionSync never throws, even where session.json cannot be written', async () => {
    const start = await beginSession(home(), { kind: 'app', pid: 7, startedAt: 10 })
    endSessionSync(home(), start.current, 20)
    expect(await readSession(home())).toMatchObject({ pid: 7, clean: true, endedAt: 20 })
    // A home that is a file: the marker cannot be written, and the exit handler goes on.
    const file = join(home(), 'not-a-folder')
    await writeFile(file, 'x')
    expect(() => endSessionSync(file, start.current, 30)).not.toThrow()
  })
})

describe('lock files of the wrong shape are corrupt, never a holder', () => {
  const shapes: [string, unknown][] = [
    ['an array', [1000, T0, 'app']],
    ['pid 0', { pid: 0, startMs: T0, kind: 'app' }],
    ['a fractional pid', { pid: 1.5, startMs: T0, kind: 'app' }],
    ['a string startMs', { pid: 4242, startMs: String(T0), kind: 'app' }],
    ['an unknown kind', { pid: 4242, startMs: T0, kind: 'daemon' }],
  ]

  it.each(shapes)(
    '%s: unreadable as a holder; "starting" while fresh, then broken and taken',
    async (_, body) => {
      await mkdir(home(), { recursive: true })
      await writeFile(paths().instanceLock, JSON.stringify(body))
      expect(await readHomeLock(home())).toBeNull()
      const now = Date.now()
      await expect(acquireHomeLock(home(), { kind: 'cli', ...me, now: () => now })).rejects.toMatchObject({
        code: 'HOME_LOCKED',
        message: expect.stringMatching(/starting/) as string,
      })
      const old = new Date(now - LOCK_FRESH_MS - 5_000)
      await utimes(paths().instanceLock, old, old)
      const lock = await acquireHomeLock(home(), { kind: 'cli', ...me, now: () => now })
      expect(await readHomeLock(home())).toMatchObject({ pid: 1000, kind: 'cli' })
      await lock.release()
      expect(await readdir(home())).not.toContain('instance.lock')
    },
  )

  it('a lock without acquiredAt reads its start time in its place', async () => {
    await mkdir(home(), { recursive: true })
    await writeFile(paths().instanceLock, JSON.stringify({ pid: 4242, startMs: T0, kind: 'app' }))
    expect(await readHomeLock(home())).toEqual({
      schemaVersion: 1,
      pid: 4242,
      startMs: T0,
      kind: 'app',
      acquiredAt: T0,
    })
  })
})

describe('session.json the boot cannot use', () => {
  it('a session file of the wrong shape reads as no previous session (not an unclean exit)', async () => {
    await mkdir(home(), { recursive: true })
    for (const body of ['{"pid":"7","startedAt":1,"clean":false}', '[]', '{bad']) {
      await writeFile(paths().session, body)
      expect(await readSession(home())).toBeNull()
      const s = await beginSession(home(), { kind: 'cli', pid: 8, startedAt: 2 })
      expect(s).toMatchObject({ previous: null, uncleanExit: false })
    }
  })

  it('a boot that cannot write session.json gives the lock back and reports STORAGE', async () => {
    // session.json is a folder holding a file: the atomic rename onto it fails on every OS.
    await mkdir(join(paths().session, 'inside'), { recursive: true })
    await expect(openHomeSession(home(), { kind: 'app', ...me })).rejects.toMatchObject({ code: 'STORAGE' })
    expect(await readHomeLock(home())).toBeNull()
    // The next boot is not blocked by a lock nobody holds.
    await expect(acquireHomeLock(home(), { kind: 'app', ...me })).resolves.toMatchObject({
      info: { pid: 1000 },
    })
  })
})

describe('writeFileAtomicSync (the shutdown writer)', () => {
  it('a target it cannot replace: STORAGE naming the file, the old target kept, no temp file left', async () => {
    const dir = join(home(), 'w')
    const target = join(dir, 'state.json')
    await mkdir(join(target, 'inside'), { recursive: true })
    let thrown: unknown
    try {
      writeFileAtomicSync(target, '{}', { retryDelaysMs: [1, 1] })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ code: 'STORAGE', message: expect.stringContaining(target) as string })
    expect(await readdir(dir)).toEqual(['state.json'])
    expect(await readdir(target)).toEqual(['inside'])
  })

  it('a folder it cannot create: STORAGE, nothing written', async () => {
    const blocker = join(home(), 'blocker')
    await mkdir(home(), { recursive: true })
    await writeFile(blocker, 'a file where a folder should be')
    expect(() => writeFileAtomicSync(join(blocker, 'sub', 'x.json'), '{}')).toThrow(
      expect.objectContaining({ code: 'STORAGE' }) as Error,
    )
    expect(await readFile(blocker, 'utf8')).toBe('a file where a folder should be')
  })
})
