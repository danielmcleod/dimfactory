// Review (finding 2; Apply writes the folder only where Undo can restore it): a file the
// run turned into a symbolic link is written as a link made under a temp name and renamed over the file, so where links
// cannot be made (a volume without them, an account that may not make them: EPERM) the folder's file is left as it was,
// with the reason, and nothing is left beside it. node:fs/promises `symlink` is wrapped here to fail with EPERM for
// paths in the user's folder only. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyRun, undoApply } from '../../../../src/core/git/finalize.ts'
import { NO_SYMLINKS_REASON } from '../../../../src/core/git/revert.ts'
import { TEST_GIT, cleanupTemps, testGitVersion, tempDir } from '../../git/helpers.ts'
import { isolated, textOf } from './fixture.ts'

// The folder in both spellings: Apply writes the folder by its real name (an 8.3 short name or a linked temp folder
// in the fixture's path is the same folder).
const ctl = vi.hoisted(() => ({ failIn: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  return {
    ...real,
    symlink: async (target: string, p: string, type?: 'file' | 'dir' | 'junction' | null) => {
      if (ctl.failIn.some((dir) => String(p).startsWith(dir))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${p}'`), {
          code: 'EPERM',
        })
      }
      return real.symlink(target, p, type)
    },
  }
})

const version = await testGitVersion()
console.info(`[git-compat] finalize symlink suite: ${version.raw} (${TEST_GIT})`)

/** Links can be made here at all (the run's copy needs one). */
function canSymlinkHere(): boolean {
  const d = tempDir('link-probe')
  try {
    symlinkSync('target', join(d, 'probe'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}
const SYMLINKS = canSymlinkHere()

afterEach(() => {
  ctl.failIn = []
  cleanupTemps()
})

describe.runIf(SYMLINKS)(`a file the run turned into a link (${version.raw})`, () => {
  it('where links cannot be made, the folder keeps its file (skipped, with why) and no temp file', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' })
    rmSync(join(f.wt.path, 'a.txt'))
    symlinkSync('b.txt', join(f.wt.path, 'a.txt'), 'file')
    const target = await f.finish()
    ctl.failIn = [f.repo, realpathSync.native(f.repo)]
    const r = await applyRun(target)
    expect(r.written).toEqual([])
    expect(r.skipped).toEqual([{ path: 'a.txt', reason: NO_SYMLINKS_REASON }])
    expect(lstatSync(join(f.repo, 'a.txt')).isFile()).toBe(true)
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
    expect(readdirSync(f.repo).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(await undoApply(target, r.undoToken)).toEqual({ restored: [], deleted: [], skipped: [] })
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
  })

  it('where they can, the link takes the file’s place (renamed over it); Undo brings the file back', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' })
    rmSync(join(f.wt.path, 'a.txt'))
    symlinkSync('b.txt', join(f.wt.path, 'a.txt'), 'file')
    const target = await f.finish()
    const r = await applyRun(target)
    expect(r.written).toEqual(['a.txt'])
    expect(lstatSync(join(f.repo, 'a.txt')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(f.repo, 'a.txt')).replace(/\\/g, '/')).toBe('b.txt')
    expect(readdirSync(f.repo).filter((n) => n.endsWith('.tmp'))).toEqual([])
    await undoApply(target, r.undoToken)
    expect(lstatSync(join(f.repo, 'a.txt')).isFile()).toBe(true)
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
    expect(existsSync(join(f.repo, 'b.txt'))).toBe(true)
  })
})
