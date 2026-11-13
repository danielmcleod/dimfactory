// Coverage: proc-table's atomic write (src/core/proc/atomic-lite.ts) under Windows sharing violations
// (atomic writes: temp file, fsync, rename retried 50/100/200/400/800 ms on EPERM/EBUSY/EACCES; anything else
// fails at once). The rename is the only seam: node:fs/promises is the real module with `rename` scripted.
import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ATOMIC_RETRY_DELAYS_MS, writeFileAtomicLite } from '../../../src/core/proc/atomic-lite.ts'

const script = vi.hoisted(() => ({ failures: [] as Error[], renames: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  return {
    ...real,
    rename: async (from: string, to: string): Promise<void> => {
      script.renames++
      const next = script.failures.shift()
      if (next !== undefined) throw next
      await real.rename(from, to)
    },
  }
})

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code })

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atomic-lite-'))
}

beforeEach(() => {
  script.failures = []
  script.renames = 0
})

describe('writeFileAtomicLite: the rename retry (Windows sharing violations)', () => {
  it('keeps the standard retry schedule as its default', () => {
    expect(ATOMIC_RETRY_DELAYS_MS).toEqual([50, 100, 200, 400, 800])
  })

  it('retries EBUSY, EPERM and EACCES, then replaces the file and leaves no temp file', async () => {
    const dir = await folder()
    const file = join(dir, 'procs.json')
    await writeFile(file, 'old')
    script.failures = [errno('EBUSY'), errno('EPERM'), errno('EACCES')]
    await writeFileAtomicLite(file, 'new', { retryDelaysMs: [1, 1, 1] })
    expect(script.renames).toBe(4)
    expect(await readFile(file, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['procs.json'])
  })

  it('gives up once the schedule is used: the last error is thrown, the temp file removed, the old file kept', async () => {
    const dir = await folder()
    const file = join(dir, 'procs.json')
    await writeFile(file, 'old')
    script.failures = [errno('EBUSY'), errno('EBUSY'), errno('EBUSY')]
    await expect(writeFileAtomicLite(file, 'new', { retryDelaysMs: [1, 1] })).rejects.toMatchObject({
      code: 'EBUSY',
    })
    expect(script.renames).toBe(3)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect(await readdir(dir)).toEqual(['procs.json'])
  })

  it.each([['ENOSPC'], ['EXDEV']])('%s is not retried: thrown at once, temp file removed', async (code) => {
    const dir = await folder()
    const file = join(dir, 'procs.json')
    script.failures = [errno(code)]
    await expect(writeFileAtomicLite(file, 'new', { retryDelaysMs: [1, 1, 1] })).rejects.toMatchObject({
      code,
    })
    expect(script.renames).toBe(1)
    expect(await readdir(dir)).toEqual([])
  })

  it('an error without an errno code is not retried either', async () => {
    const dir = await folder()
    const file = join(dir, 'procs.json')
    script.failures = [new Error('no code')]
    await expect(writeFileAtomicLite(file, 'new', { retryDelaysMs: [1] })).rejects.toThrow('no code')
    expect(script.renames).toBe(1)
    expect(await readdir(dir)).toEqual([])
  })

  it('creates the parent folders and writes bytes as given', async () => {
    const dir = await folder()
    const file = join(dir, 'a', 'b', 'procs.bin')
    await writeFileAtomicLite(file, new Uint8Array([0, 255, 10, 13]))
    expect([...(await readFile(file))]).toEqual([0, 255, 10, 13])
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['procs.bin'])
  })
})
