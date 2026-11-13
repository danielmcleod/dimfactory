// Finalize cases against real git (Apply from a worktree started at HEAD): noop, write, delete, conflict,
// rename, exec bit, gitlink, CRLF bytes, never through a link or junction, case-only renames. Honors DIM_FACTORY_TEST_GIT
// (CI's git-compat job: 2.17.1).
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GITLINK_REASON, applyRun, previewApply, undoApply } from '../../../../src/core/git/finalize.ts'
import { resetCaseProbeCache, probeCaseInsensitive } from '../../../../src/core/git/repo.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  isWin,
  shadowTreePaths,
  tempDir,
  testGitVersion,
  write,
} from '../../git/helpers.ts'
import { bytesOf, isolated, textOf } from './fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] finalize suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => {
  cleanupTemps()
  resetCaseProbeCache()
})

const exists = (root: string, rel: string): boolean => existsSync(join(root, rel))

describe(`apply: noop, write, delete, conflict (${version.raw})`, () => {
  it('writes and deletes what still holds the run start, leaves a conflict untouched, and no-ops what already matches', async () => {
    const f = await isolated({
      'a.txt': 'a1\n',
      'b.txt': 'b1\n',
      'c.txt': 'c1\n',
      'd.txt': 'd1\n',
      'keep.txt': 'same\n',
    })
    // The run (in its worktree).
    write(f.wt.path, 'a.txt', 'a2\n')
    rmSync(join(f.wt.path, 'b.txt'))
    write(f.wt.path, 'c.txt', 'c-run\n')
    write(f.wt.path, 'd.txt', 'd2\n')
    write(f.wt.path, 'new/n.txt', 'n\n')
    const target = await f.finish()
    // The user, meanwhile, in the folder: c changed differently, d changed the same way.
    write(f.repo, 'c.txt', 'c-user\n')
    write(f.repo, 'd.txt', 'd2\n')

    const preview = await previewApply(target)
    const action = (p: string): string | undefined => preview.actions.find((a) => a.path === p)?.action
    expect(action('a.txt')).toBe('write')
    expect(action('b.txt')).toBe('delete')
    expect(action('c.txt')).toBe('conflict')
    expect(action('d.txt')).toBe('noop')
    expect(action('new/n.txt')).toBe('write')
    expect(preview.conflicts).toEqual(['c.txt'])
    expect(preview.files.map((x) => x.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'new/n.txt'])
    // A preview writes nothing.
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')

    const r = await applyRun(target)
    expect(r.applied.sort()).toEqual(['a.txt', 'b.txt', 'new/n.txt'])
    expect(r.written.sort()).toEqual(['a.txt', 'new/n.txt'])
    expect(r.deleted).toEqual(['b.txt'])
    expect(r.unchanged).toEqual(['d.txt'])
    expect(r.conflicts).toEqual(['c.txt'])
    expect(r.resumed).toBe(false)
    expect(r.undoToken).not.toBe('')
    expect(textOf(f.repo, 'a.txt')).toBe('a2\n')
    expect(exists(f.repo, 'b.txt')).toBe(false)
    expect(textOf(f.repo, 'c.txt')).toBe('c-user\n')
    expect(textOf(f.repo, 'd.txt')).toBe('d2\n')
    expect(textOf(f.repo, 'new/n.txt')).toBe('n\n')
    expect(textOf(f.repo, 'keep.txt')).toBe('same\n')
  })

  it("resolves conflicts: [Take run's] writes the run's version, [Keep mine] leaves the folder's", async () => {
    const f = await isolated({ 'x.txt': 'x1\n', 'y.txt': 'y1\n', 'z.txt': 'z1\n' })
    write(f.wt.path, 'x.txt', 'x-run\n')
    write(f.wt.path, 'y.txt', 'y-run\n')
    rmSync(join(f.wt.path, 'z.txt'))
    const target = await f.finish()
    write(f.repo, 'x.txt', 'x-user\n')
    write(f.repo, 'y.txt', 'y-user\n')
    write(f.repo, 'z.txt', 'z-user\n')
    const r = await applyRun(target, {
      resolutions: { 'x.txt': 'theirs', 'y.txt': 'mine', 'z.txt': 'theirs' },
    })
    expect(r.written).toEqual(['x.txt'])
    expect(r.deleted).toEqual(['z.txt'])
    expect(r.kept).toEqual(['y.txt'])
    expect(r.conflicts).toEqual([])
    expect(textOf(f.repo, 'x.txt')).toBe('x-run\n')
    expect(textOf(f.repo, 'y.txt')).toBe('y-user\n')
    expect(exists(f.repo, 'z.txt')).toBe(false)
    // Undo puts the user's versions back (they are in the pre-apply snapshot).
    await undoApply(target, r.undoToken)
    expect(textOf(f.repo, 'x.txt')).toBe('x-user\n')
    expect(textOf(f.repo, 'z.txt')).toBe('z-user\n')
  })

  it('a folder deleted by the user conflicts with a modified file; a file the user added conflicts with an add', async () => {
    const f = await isolated({ 'm.txt': 'm1\n' })
    write(f.wt.path, 'm.txt', 'm2\n')
    write(f.wt.path, 'added.txt', 'run\n')
    const target = await f.finish()
    rmSync(join(f.repo, 'm.txt'))
    write(f.repo, 'added.txt', 'user\n')
    const r = await applyRun(target)
    expect(r.conflicts.sort()).toEqual(['added.txt', 'm.txt'])
    expect(r.applied).toEqual([])
    expect(exists(f.repo, 'm.txt')).toBe(false)
    expect(textOf(f.repo, 'added.txt')).toBe('user\n')
  })

  it('applies only the selected paths (Apply reviewed only)', async () => {
    const f = await isolated({ 'p.txt': 'p1\n', 'q.txt': 'q1\n', 'dir/r.txt': 'r1\n' })
    write(f.wt.path, 'p.txt', 'p2\n')
    write(f.wt.path, 'q.txt', 'q2\n')
    write(f.wt.path, 'dir/r.txt', 'r2\n')
    const target = await f.finish()
    const r = await applyRun(target, { paths: ['p.txt', 'dir'] })
    expect(r.applied.sort()).toEqual(['dir/r.txt', 'p.txt'])
    expect(textOf(f.repo, 'q.txt')).toBe('q1\n')
    // The rest later: a second apply finds the first's files already applied.
    const r2 = await applyRun(target)
    expect(r2.applied).toEqual(['q.txt'])
    expect(r2.unchanged.sort()).toEqual(['dir/r.txt', 'p.txt'])
  })
})

describe(`renames, bytes, modes, gitlinks (${version.raw})`, () => {
  it('a rename is a delete plus an add, each with its own check', async () => {
    const f = await isolated({ 'old.txt': 'content that stays the same\n', 'old2.txt': 'second file\n' })
    renameSync(join(f.wt.path, 'old.txt'), join(f.wt.path, 'new.txt'))
    renameSync(join(f.wt.path, 'old2.txt'), join(f.wt.path, 'new2.txt'))
    const target = await f.finish()
    // The user edited the second file's old path: its delete conflicts, its add still applies.
    write(f.repo, 'old2.txt', 'second file, edited\n')
    const preview = await previewApply(target)
    // The Diff tab's rows keep the rename.
    expect(preview.files.find((x) => x.path === 'new.txt')?.status).toBe('R')
    const r = await applyRun(target)
    expect(r.deleted).toEqual(['old.txt'])
    expect(r.written.sort()).toEqual(['new.txt', 'new2.txt'])
    expect(r.conflicts).toEqual(['old2.txt'])
    expect(exists(f.repo, 'old.txt')).toBe(false)
    expect(textOf(f.repo, 'new.txt')).toBe('content that stays the same\n')
    expect(textOf(f.repo, 'old2.txt')).toBe('second file, edited\n')
    expect(textOf(f.repo, 'new2.txt')).toBe('second file\n')
  })

  it('writes CRLF, mixed endings and binary bytes exactly', async () => {
    const binary = Buffer.from([0, 1, 2, 0xff, 0x0d, 0x0a, 0x0a, 0x0d, 0])
    const f = await isolated({ 'crlf.txt': 'one\r\ntwo\r\n', 'bin.dat': binary })
    const nextText = Buffer.from('one\r\ntwo\r\nthree\nfour\r\n', 'utf8')
    const nextBin = Buffer.concat([binary, Buffer.from([0x0d, 0x0d, 0x0a])])
    write(f.wt.path, 'crlf.txt', nextText)
    write(f.wt.path, 'bin.dat', nextBin)
    const target = await f.finish()
    const r = await applyRun(target)
    expect(r.written.sort()).toEqual(['bin.dat', 'crlf.txt'])
    expect(bytesOf(f.repo, 'crlf.txt').equals(nextText)).toBe(true)
    expect(bytesOf(f.repo, 'bin.dat').equals(nextBin)).toBe(true)
  })

  it('a repository with core.autocrlf=true: the folder and the worktree hold the same checkout, applied exactly', async () => {
    const f = await isolated({ 'eol.txt': 'l1\nl2\n' }, { autocrlf: true })
    // Both checkouts converted the same way.
    expect(bytesOf(f.wt.path, 'eol.txt').equals(bytesOf(f.repo, 'eol.txt'))).toBe(true)
    const next = Buffer.concat([bytesOf(f.wt.path, 'eol.txt'), Buffer.from('l3\r\n')])
    write(f.wt.path, 'eol.txt', next)
    const target = await f.finish()
    const r = await applyRun(target)
    expect(r.written).toEqual(['eol.txt'])
    expect(bytesOf(f.repo, 'eol.txt').equals(next)).toBe(true)
  })

  it.skipIf(isWin)(
    'sets the exec bit on POSIX (win32 has no exec bit: core.filemode is false there)',
    async () => {
      const f = await isolated({ 'run.sh': '#!/bin/sh\necho hi\n', 'tool.sh': '#!/bin/sh\n' })
      chmodSync(join(f.wt.path, 'run.sh'), 0o755)
      write(f.wt.path, 'new.sh', '#!/bin/sh\necho new\n')
      chmodSync(join(f.wt.path, 'new.sh'), 0o755)
      const target = await f.finish()
      const r = await applyRun(target)
      expect(r.written.sort()).toEqual(['new.sh', 'run.sh'])
      expect(statSync(join(f.repo, 'run.sh')).mode & 0o111).not.toBe(0)
      expect(statSync(join(f.repo, 'new.sh')).mode & 0o111).not.toBe(0)
      expect(statSync(join(f.repo, 'tool.sh')).mode & 0o111).toBe(0)
      expect(textOf(f.repo, 'run.sh')).toBe('#!/bin/sh\necho hi\n')
    },
  )

  it('skips a nested repository (gitlink) with the reason', async () => {
    const f = await isolated({ 'top.txt': 't\n' })
    const sub = join(f.wt.path, 'sub')
    mkdirSync(sub)
    git(sub, ['init', '-q'])
    write(sub, 'inner.txt', 'inner\n')
    git(sub, ['add', 'inner.txt'])
    git(sub, ['commit', '-q', '-m', 'inner'])
    write(f.wt.path, 'top.txt', 't2\n')
    const target = await f.finish()
    const preview = await previewApply(target)
    expect(preview.actions.find((a) => a.path === 'sub')).toEqual({
      path: 'sub',
      action: 'skip',
      reason: GITLINK_REASON,
    })
    const r = await applyRun(target)
    expect(r.written).toEqual(['top.txt'])
    expect(r.skipped).toEqual([{ path: 'sub', reason: GITLINK_REASON }])
    expect(exists(f.repo, 'sub')).toBe(false)
  })
})

describe(`never through a link or a junction (${version.raw})`, () => {
  it('a write or delete under a folder that is now a link (a junction on Windows) is skipped; the outside folder is untouched', async () => {
    const f = await isolated({ 'lib/x.txt': 'x1\n', 'lib/y.txt': 'y1\n', 'main.txt': 'm1\n' })
    write(f.wt.path, 'lib/x.txt', 'x2\n')
    rmSync(join(f.wt.path, 'lib', 'y.txt'))
    write(f.wt.path, 'main.txt', 'm2\n')
    const target = await f.finish()
    // The user replaced lib with a link to a folder outside the project holding the same files.
    const outside = tempDir('outside')
    write(outside, 'x.txt', 'x1\n')
    write(outside, 'y.txt', 'y1\n')
    rmSync(join(f.repo, 'lib'), { recursive: true, force: true })
    symlinkSync(outside, join(f.repo, 'lib'), 'junction')
    const r = await applyRun(target)
    expect(r.written).toEqual(['main.txt'])
    expect(r.skipped.map((s) => s.path).sort()).toEqual(['lib/x.txt', 'lib/y.txt'])
    for (const s of r.skipped) expect(s.reason).toBe('a link is in the place of its folder lib')
    expect(textOf(outside, 'x.txt')).toBe('x1\n')
    expect(readdirSync(outside).sort()).toEqual(['x.txt', 'y.txt'])
    expect(lstatSync(join(f.repo, 'lib')).isSymbolicLink()).toBe(true)
  })

  it.runIf(isWin)(
    "files the run's snapshot reached through a junction in its worktree are never copied into the folder",
    async () => {
      const f = await isolated({ 'main.txt': 'm1\n' })
      const outside = tempDir('wt-outside')
      write(outside, 'shared.txt', 'not the project\n')
      symlinkSync(outside, join(f.wt.path, 'ext'), 'junction')
      write(f.wt.path, 'main.txt', 'm2\n')
      const target = await f.finish()
      const r = await applyRun(target)
      expect(r.written).toEqual(['main.txt'])
      // Git for Windows reads the junction as a folder: what it listed under it is skipped with the reason.
      const listed = shadowTreePaths(f.shadow.gitDir, target.to).includes('ext/shared.txt')
      expect(r.skipped.map((s) => s.path)).toEqual(listed ? ['ext/shared.txt'] : [])
      for (const s of r.skipped) {
        expect(s.path.startsWith('ext/')).toBe(true)
        expect(s.reason).toBe("in the run's copy a link is in the place of its folder ext")
      }
      expect(existsSync(join(f.repo, 'ext'))).toBe(false)
    },
  )

  // Review finding 8: the folder holds a link (a junction on Windows) next to what the run deletes. The emptied
  // folders are pruned; the link, the folder it points to and what that holds are never touched, and a delete under the
  // link is skipped.
  it('emptied folders are pruned; a link beside them, and the folder it points to, are untouched', async () => {
    const f = await isolated({ 'deep/a/only.txt': 'o\n', 'deep/b/x.txt': 'x\n', 'keep.txt': 'k\n' })
    rmSync(join(f.wt.path, 'deep'), { recursive: true })
    const target = await f.finish()
    // The user replaced deep/b with a link to a folder outside the project holding the same file.
    const outside = tempDir('prune-outside')
    write(outside, 'x.txt', 'x\n')
    rmSync(join(f.repo, 'deep', 'b'), { recursive: true, force: true })
    symlinkSync(outside, join(f.repo, 'deep', 'b'), 'junction')
    const r = await applyRun(target)
    expect(r.deleted).toEqual(['deep/a/only.txt'])
    expect(r.skipped).toEqual([
      { path: 'deep/b/x.txt', reason: 'a link is in the place of its folder deep/b' },
    ])
    expect(exists(f.repo, 'deep/a')).toBe(false)
    expect(lstatSync(join(f.repo, 'deep', 'b')).isSymbolicLink()).toBe(true)
    expect(readdirSync(outside)).toEqual(['x.txt'])
    expect(textOf(outside, 'x.txt')).toBe('x\n')
    expect(exists(f.repo, 'keep.txt')).toBe(true)
  })
})

const caseInsensitive = await probeCaseInsensitive(tempDir('case'))

describe.runIf(caseInsensitive)(`case-only renames on a case-insensitive volume (${version.raw})`, () => {
  it('a case-only rename comes out as one file with the new name', async () => {
    const f = await isolated({ 'Readme.md': 'r\n' })
    renameSync(join(f.wt.path, 'Readme.md'), join(f.wt.path, 'README.md'))
    const target = await f.finish()
    const preview = await previewApply(target)
    expect(preview.conflicts).toEqual([])
    const r = await applyRun(target)
    expect(r.conflicts).toEqual([])
    expect(readdirSync(f.repo).filter((n) => n.toLowerCase() === 'readme.md')).toEqual(['README.md'])
    expect(textOf(f.repo, 'README.md')).toBe('r\n')
  })
})
