// Revert to a snapshot against real git: modified files restored, files the run
// added deleted, files it deleted restored, binary and CRLF bytes exact, a case-only rename reverted as one rename,
// undo byte-exact, gitlinks skipped, refused while a process holds the folder, and the user's .git never touched.
// Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeCaseInsensitive, resolveScope } from '../../../src/core/git/repo.ts'
import { revertTo, undoRevert } from '../../../src/core/git/revert.ts'
import { Shadow, openShadow } from '../../../src/core/git/shadow.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  initRepo,
  isWin,
  sha256File,
  shadowGit,
  tempDir,
  testGitVersion,
  write,
} from './helpers.ts'
import { dotGitFingerprint, workTreeHashes } from './fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] revert suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261008T120000Z-rvrt'
/** Temp folders fold case here (Windows, macOS defaults): the case-only rename case applies. */
const caseInsensitiveTmp = await probeCaseInsensitive(tmpdir())

afterEach(() => cleanupTemps())

const ORIGINAL: Record<string, Buffer> = {
  'crlf.txt': Buffer.from('one\r\ntwo\r\n'),
  'lf-in-crlf-attr.txt': Buffer.from('lf only\nstill lf\n'),
  'bin.dat': Buffer.from([0, 1, 2, 13, 10, 255, 254, 0, 13]),
  'keep.txt': Buffer.from('unchanged\n'),
  'gone.txt': Buffer.from('the run deletes me\r\n'),
  'sub/deep/nested.txt': Buffer.from('deep\r\nfile\n'),
}

/**
 * A repo whose attributes and autocrlf would convert line endings (the shadow must not), S0, then a run that edits,
 * deletes and adds files, then S1.
 */
async function scenario(prefix: string): Promise<{
  dir: string
  shadow: Shadow
  s0: { commit: string; tree: string }
  s1: { commit: string; tree: string }
  s1Files: Record<string, string>
}> {
  const dir = tempDir(prefix)
  initRepo(dir, { autocrlf: true })
  write(dir, '.gitattributes', '*.txt text eol=crlf\n*.dat binary\n')
  for (const [rel, data] of Object.entries(ORIGINAL)) write(dir, rel, data)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  const shadow = await openShadow(dir, { home: tempDir(`${prefix}-home`) })
  const s0 = await shadow.snapshot(RUN, 'S0')
  write(dir, 'crlf.txt', 'one\r\nTWO changed\r\n')
  write(dir, 'lf-in-crlf-attr.txt', 'lf only\nedited\n')
  write(dir, 'bin.dat', Buffer.from([9, 9, 9, 0, 13, 10]))
  rmSync(join(dir, 'gone.txt'))
  write(dir, 'new.txt', 'added by the run\n')
  write(dir, 'newdir/inner/x.txt', 'x\n')
  const s1 = await shadow.snapshot(RUN, 'S1')
  return { dir, shadow, s0, s1, s1Files: workTreeHashes(dir) }
}

function expectOriginal(dir: string): void {
  for (const [rel, data] of Object.entries(ORIGINAL)) {
    expect(readFileSync(join(dir, rel)).equals(data), rel).toBe(true)
  }
}

describe(`revert to a snapshot (${version.raw})`, () => {
  it('restores modified and deleted files byte-exact, deletes added ones, and never touches the user .git', async () => {
    const { dir, shadow, s0 } = await scenario('revert')
    const dotGit = dotGitFingerprint(dir)
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const o = r.outcome
    expect(o.restored).toEqual(['bin.dat', 'crlf.txt', 'gone.txt', 'lf-in-crlf-attr.txt'])
    expect(o.deleted).toEqual(['new.txt', 'newdir/inner/x.txt'])
    expect(o.skipped).toEqual([])
    expect(o.targetTree).toBe(s0.tree)
    expectOriginal(dir)
    expect(existsSync(join(dir, 'new.txt'))).toBe(false)
    // Emptied folders go too.
    expect(existsSync(join(dir, 'newdir'))).toBe(false)
    // The pre-revert snapshot is the undo point and now heads the run's chain.
    expect(o.preRevert.label).toBe('pre-revert')
    expect(shadowGit(shadow.gitDir, ['rev-parse', `refs/dimfactory/runs/${RUN}`]).trim()).toBe(
      o.preRevert.commit,
    )
    // The folder now snapshots to exactly S0.
    expect((await shadow.snapshot(RUN, 'resume')).tree).toBe(s0.tree)
    expect(dotGitFingerprint(dir)).toEqual(dotGit)
  })

  it('undo restores the reverted paths byte-exact', async () => {
    const { dir, shadow, s0, s1, s1Files } = await scenario('undo')
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    // An edit outside the reverted paths survives the undo.
    write(dir, 'keep.txt', 'edited after the revert\n')
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    expect(u.ok).toBe(true)
    if (!u.ok) return
    expect(u.outcome.restored.sort()).toEqual([
      'bin.dat',
      'crlf.txt',
      'lf-in-crlf-attr.txt',
      'new.txt',
      'newdir/inner/x.txt',
    ])
    expect(u.outcome.deleted).toEqual(['gone.txt'])
    expect(workTreeHashes(dir)).toEqual({ ...s1Files, 'keep.txt': sha256File(join(dir, 'keep.txt')) })
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('edited after the revert\n')
    write(dir, 'keep.txt', ORIGINAL['keep.txt'] ?? '')
    expect((await shadow.snapshot(RUN, 'resume')).tree).toBe(s1.tree)
  })

  it('reverts only the listed paths (a folder means everything under it)', async () => {
    const { dir, shadow, s0 } = await scenario('paths')
    const r = await revertTo(shadow, s0.commit, { runId: RUN, paths: ['crlf.txt', 'newdir'] })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.restored).toEqual(['crlf.txt'])
    expect(r.outcome.deleted).toEqual(['newdir/inner/x.txt'])
    expect(readFileSync(join(dir, 'crlf.txt')).equals(ORIGINAL['crlf.txt'] ?? Buffer.alloc(0))).toBe(true)
    expect(readFileSync(join(dir, 'bin.dat')).equals(ORIGINAL['bin.dat'] ?? Buffer.alloc(0))).toBe(false)
    expect(existsSync(join(dir, 'new.txt'))).toBe(true)
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false)
  })

  it('refuses while a process holds the folder, before taking any snapshot', async () => {
    const { dir, shadow, s0, s1, s1Files } = await scenario('busy')
    const r = await revertTo(shadow, s0.commit, { runId: RUN, folderHeld: true })
    expect(r).toMatchObject({ ok: false, refused: 'folder-busy' })
    expect(shadowGit(shadow.gitDir, ['rev-parse', `refs/dimfactory/runs/${RUN}`]).trim()).toBe(s1.commit)
    expect(workTreeHashes(dir)).toEqual(s1Files)
  })

  it('skips gitlinks (nested repositories) and leaves them alone', async () => {
    const dir = tempDir('gitlink')
    write(dir, 'top.txt', 'top\n')
    const shadow = await openShadow(dir, { home: tempDir('gitlink-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    const sub = join(dir, 'app')
    write(sub, 'main.c', 'int main(){}\n')
    initRepo(sub)
    write(dir, 'top.txt', 'changed\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    expect(shadowGit(shadow.gitDir, ['ls-tree', s1.commit, 'app'])).toMatch(/^160000 /)
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.restored).toEqual(['top.txt'])
    expect(r.outcome.skipped).toEqual([{ path: 'app', reason: 'nested repository (gitlink)' }])
    expect(readFileSync(join(sub, 'main.c'), 'utf8')).toBe('int main(){}\n')
    expect(existsSync(join(sub, '.git', 'HEAD'))).toBe(true)
  })

  it.skipIf(isWin)('restores the exec bit on POSIX', async () => {
    const dir = tempDir('exec')
    write(dir, 'run.sh', '#!/bin/sh\necho hi\n')
    chmodSync(join(dir, 'run.sh'), 0o755)
    write(dir, 'tool.sh', '#!/bin/sh\n')
    chmodSync(join(dir, 'tool.sh'), 0o755)
    const shadow = await openShadow(dir, { home: tempDir('exec-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    chmodSync(join(dir, 'run.sh'), 0o644)
    rmSync(join(dir, 'tool.sh'))
    await shadow.snapshot(RUN, 'S1')
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.restored).toEqual(['run.sh', 'tool.sh'])
    expect(statSync(join(dir, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(statSync(join(dir, 'tool.sh')).mode & 0o111).not.toBe(0)
  })

  it.skipIf(!caseInsensitiveTmp)(
    'a case-only rename on a case-insensitive volume reverts as one rename, and undoes as one',
    async () => {
      const dir = tempDir('case')
      initRepo(dir)
      write(dir, 'docs/Guide.md', 'guide\r\n')
      const scope = await resolveScope(dir)
      expect(scope.caseInsensitive).toBe(true)
      const shadow = await Shadow.open(scope, { home: tempDir('case-home') })
      const s0 = await shadow.snapshot(RUN, 'S0')
      renameSync(join(dir, 'README.md'), join(dir, 'readme.md'))
      renameSync(join(dir, 'docs', 'Guide.md'), join(dir, 'docs', 'GUIDE.md'))
      const s1 = await shadow.snapshot(RUN, 'S1')
      const renames = async (a: string, b: string): Promise<string[]> =>
        (await shadow.changes(a, b)).map((c) => `${c.status} ${c.oldPath ?? ''} -> ${c.path}`).sort()
      expect(await renames(s0.commit, s1.commit)).toEqual([
        'R README.md -> readme.md',
        'R docs/Guide.md -> docs/GUIDE.md',
      ])
      const names = (): string[] =>
        [...readdirSync(dir).filter((n) => n !== '.git'), ...readdirSync(join(dir, 'docs'))].sort()
      // Either spelling selects the file.
      const r = await revertTo(shadow, s0.commit, { runId: RUN, paths: ['README.md', 'docs/GUIDE.md'] })
      if (!r.ok) throw new Error('refused')
      expect(names()).toEqual(['Guide.md', 'README.md', 'docs'])
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# test\n')
      expect(readFileSync(join(dir, 'docs', 'Guide.md'), 'utf8')).toBe('guide\r\n')
      const after = await shadow.snapshot(RUN, 'resume')
      expect(after.tree).toBe(s0.tree)
      expect(await renames(r.outcome.preRevert.commit, after.commit)).toEqual([
        'R docs/GUIDE.md -> docs/Guide.md',
        'R readme.md -> README.md',
      ])
      const u = await undoRevert(shadow, r.outcome, { runId: RUN })
      if (!u.ok) throw new Error('refused')
      expect(names()).toEqual(['GUIDE.md', 'docs', 'readme.md'])
      expect((await shadow.snapshot(RUN, 'resume')).tree).toBe(s1.tree)
    },
  )
})
