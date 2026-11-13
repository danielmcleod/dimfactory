// Per-folderKey and per-common-dir mutexes.
import { describe, expect, it } from 'vitest'
import { GitError } from '../../../src/core/git/exec.ts'
import {
  AsyncMutex,
  MutexMap,
  commonDirKey,
  isFolderBusy,
  retryOnLock,
  tryWithFolderLock,
  withCommonDirLock,
  withFolderLock,
} from '../../../src/core/git/mutex.ts'

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AsyncMutex', () => {
  it('runs holders one at a time in FIFO order', async () => {
    const m = new AsyncMutex()
    const order: string[] = []
    let active = 0
    const job = (name: string) => async (): Promise<string> => {
      active++
      expect(active).toBe(1)
      order.push(`start ${name}`)
      await tick()
      order.push(`end ${name}`)
      active--
      return name
    }
    const results = await Promise.all([m.run(job('a')), m.run(job('b')), m.run(job('c'))])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(m.busy).toBe(false)
  })

  it('releases on throw and reports busy/waiting; tryRun skips while busy', async () => {
    const m = new AsyncMutex()
    await expect(m.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(m.busy).toBe(false)
    let release: () => void = () => undefined
    const held = m.run(() => new Promise<void>((r) => (release = r)))
    expect(m.busy).toBe(true)
    expect(m.tryRun(() => 1)).toBeUndefined()
    const queued = m.run(() => 2)
    expect(m.waiting).toBe(1)
    await tick()
    release()
    await held
    expect(await queued).toBe(2)
    expect(await m.tryRun(() => 3)).toBe(3)
  })
})

describe('MutexMap and folder locks', () => {
  it('serializes per key, runs different keys in parallel, and forgets idle keys', async () => {
    const map = new MutexMap()
    const log: string[] = []
    let release: () => void = () => undefined
    const a = map.run('k1', () => new Promise<void>((r) => (release = r)).then(() => log.push('k1')))
    const b = map.run('k2', () => log.push('k2'))
    await b
    await tick()
    expect(log).toEqual(['k2'])
    expect(map.isBusy('k1')).toBe(true)
    expect(map.keys()).toEqual(['k1'])
    release()
    await a
    expect(map.keys()).toEqual([])
  })

  it('withFolderLock / tryWithFolderLock / isFolderBusy share one registry', async () => {
    let release: () => void = () => undefined
    const held = withFolderLock('abcd1234abcd1234', () => new Promise<void>((r) => (release = r)))
    expect(isFolderBusy('abcd1234abcd1234')).toBe(true)
    expect(tryWithFolderLock('abcd1234abcd1234', () => 'x')).toBeUndefined()
    expect(await tryWithFolderLock('ffff0000ffff0000', () => 'y')).toBe('y')
    await tick()
    release()
    await held
    expect(isFolderBusy('abcd1234abcd1234')).toBe(false)
  })
})

describe('common-dir lock', () => {
  it('normalizes keys (case folded on win32/darwin)', () => {
    expect(commonDirKey('C:\\Repo\\.git\\', 'win32')).toBe(commonDirKey('c:\\repo\\.git', 'win32'))
    expect(commonDirKey('/Repo/.git', 'linux')).not.toBe(commonDirKey('/repo/.git', 'linux'))
  })

  const lockErr = (): GitError =>
    new GitError('exit', 'update-ref failed', {
      args: ['update-ref'],
      exitCode: 128,
      stderr: "fatal: Unable to create '/r/.git/refs/heads/x.lock': File exists.",
      category: 'git_state',
    })

  it('retries 3× while a *.lock is held, then gives up', async () => {
    let calls = 0
    await expect(
      retryOnLock(
        () => {
          calls++
          return Promise.reject(lockErr())
        },
        { delayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(GitError)
    expect(calls).toBe(3)
    calls = 0
    const value = await withCommonDirLock(
      '/repo/.git',
      () => {
        calls++
        return calls < 2 ? Promise.reject(lockErr()) : Promise.resolve('done')
      },
      { delayMs: 1 },
    )
    expect(value).toBe('done')
    expect(calls).toBe(2)
  })

  it('does not retry unrelated errors', async () => {
    let calls = 0
    await expect(
      retryOnLock(
        () => {
          calls++
          return Promise.reject(new Error('other'))
        },
        { delayMs: 1 },
      ),
    ).rejects.toThrow('other')
    expect(calls).toBe(1)
  })
})
