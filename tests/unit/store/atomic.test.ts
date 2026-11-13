import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import {
  ATOMIC_RETRY_DELAYS_MS,
  nodeAtomicFs,
  readJsonFile,
  writeFileAtomic,
  writeFileAtomicSync,
  writeJsonAtomic,
} from '../../../src/core/store/atomic.ts'
import type { AtomicFs } from '../../../src/core/store/atomic.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code })

/** A real fs whose rename fails with `codes` (in order) before succeeding. */
function flakyRename(codes: string[]): AtomicFs & { renames: number } {
  const queue = [...codes]
  const fs = {
    ...nodeAtomicFs,
    renames: 0,
    rename: async (from: string, to: string): Promise<void> => {
      fs.renames++
      const code = queue.shift()
      if (code !== undefined) throw errno(code)
      await nodeAtomicFs.rename(from, to)
    },
  }
  return fs
}

const fastDelays = [1, 2, 3, 4, 5]

describe('writeFileAtomic', () => {
  it('writes through a temp file, creating parent folders, and leaves no temp behind', async () => {
    const file = join(home(), 'a', 'b', 'x.json')
    await writeFileAtomic(file, 'one')
    await writeFileAtomic(file, 'two')
    expect(await readFile(file, 'utf8')).toBe('two')
    expect(await readdir(join(home(), 'a', 'b'))).toEqual(['x.json'])
  })

  it('uses the retry schedule 50/100/200/400/800 ms', () => {
    expect(ATOMIC_RETRY_DELAYS_MS).toEqual([50, 100, 200, 400, 800])
  })

  it('retries a rename that fails with EPERM/EBUSY/EACCES (Windows sharing violations)', async () => {
    const file = join(home(), 'retry.txt')
    const fs = flakyRename(['EPERM', 'EBUSY', 'EACCES'])
    await writeFileAtomic(file, 'ok', { fs, retryDelaysMs: fastDelays })
    expect(fs.renames).toBe(4)
    expect(await readFile(file, 'utf8')).toBe('ok')
    expect(await readdir(home())).toEqual(['retry.txt'])
  })

  it('gives up after five retries with STORAGE and removes the temp file', async () => {
    const file = join(home(), 'stuck.txt')
    await writeFile(file, 'old')
    const fs = flakyRename(['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM'])
    const err = await writeFileAtomic(file, 'new', { fs, retryDelaysMs: fastDelays }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('STORAGE')
    expect((err as DimFactoryError).details).toEqual({ errno: 'EPERM' })
    expect(fs.renames).toBe(6)
    expect(await readFile(file, 'utf8')).toBe('old')
    expect(await readdir(home())).toEqual(['stuck.txt'])
  })

  it('does not retry other errors; ENOSPC carries the disk_full category', async () => {
    const file = join(home(), 'full.txt')
    const fs = flakyRename(['ENOSPC'])
    const err = await writeFileAtomic(file, 'x', { fs, retryDelaysMs: fastDelays }).catch((e: unknown) => e)
    expect(fs.renames).toBe(1)
    expect((err as DimFactoryError).code).toBe('STORAGE')
    expect((err as DimFactoryError).details).toEqual({ errno: 'ENOSPC', category: 'disk_full' })
    expect(await readdir(home())).toEqual([])
  })

  it('retries an EPERM on the temp-file open too', async () => {
    const file = join(home(), 'open.txt')
    let opens = 0
    const fs: AtomicFs = {
      ...nodeAtomicFs,
      open: (path, flags, mode) => {
        opens++
        if (opens === 1) return Promise.reject(errno('EBUSY'))
        return nodeAtomicFs.open(path, flags, mode)
      },
    }
    await writeFileAtomic(file, 'y', { fs, retryDelaysMs: fastDelays })
    expect(opens).toBe(2)
    expect(await readFile(file, 'utf8')).toBe('y')
  })

  it('writeJsonAtomic pretty-prints with a trailing newline', async () => {
    const file = join(home(), 'j.json')
    await writeJsonAtomic(file, { a: 1 })
    expect(await readFile(file, 'utf8')).toBe('{\n  "a": 1\n}\n')
  })

  it('writeFileAtomicSync writes and cleans up', async () => {
    const file = join(home(), 's', 'sync.txt')
    writeFileAtomicSync(file, 'sync')
    expect(await readFile(file, 'utf8')).toBe('sync')
    expect(await readdir(join(home(), 's'))).toEqual(['sync.txt'])
  })
})

describe('readJsonFile', () => {
  it('distinguishes missing, corrupt and ok (BOM tolerated)', async () => {
    const dir = join(home(), 'r')
    await mkdir(dir)
    expect(await readJsonFile(join(dir, 'none.json'))).toEqual({ kind: 'missing' })
    await writeFile(join(dir, 'bad.json'), '{nope')
    expect((await readJsonFile(join(dir, 'bad.json'))).kind).toBe('corrupt')
    await writeFile(join(dir, 'ok.json'), '﻿{"x":2}')
    const ok = await readJsonFile(join(dir, 'ok.json'))
    expect(ok.kind === 'ok' && ok.value).toEqual({ x: 2 })
  })
})
