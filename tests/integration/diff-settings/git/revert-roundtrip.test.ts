// Revert and undo round trips against real git (the Diff tab's "Revert shows an undo toast and is disabled while
// the folder is busy"; restore works on git 2.17.1): per file (a CRLF file under
// core.autocrlf=true with eol=crlf attributes, a deleted file, an added file, a binary) and for the whole segment,
// each revert puts the S0 bytes back and its undo the S1 bytes, checked by sha256 of every work-tree file; the
// user's .git is never touched; a held folder refuses with a reason. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { revertTo, undoRevert } from '../../../../src/core/git/revert.ts'
import { openShadow } from '../../../../src/core/git/shadow.ts'
import { TEST_GIT, cleanupTemps, git, initRepo, tempDir, testGitVersion, write } from '../../git/helpers.ts'
import { dotGitFingerprint, workTreeHashes } from '../../git/fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] revert round-trip suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261008T120000Z-m11r'

afterEach(() => cleanupTemps())

const S0_FILES: Record<string, Buffer> = {
  'crlf.txt': Buffer.from('line one\r\nline two\r\nété\r\n', 'utf8'),
  'gone.txt': Buffer.from('the run deletes me\r\nsecond line\n'),
  'bin.dat': Buffer.from([0, 1, 2, 13, 10, 255, 254, 0, 13, 0x89, 0x50]),
  'keep.txt': Buffer.from('never touched\n'),
}

async function scenario() {
  const dir = tempDir('rv')
  initRepo(dir, { autocrlf: true })
  write(dir, '.gitattributes', '*.txt text eol=crlf\n*.dat binary\n')
  for (const [rel, data] of Object.entries(S0_FILES)) write(dir, rel, data)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  const shadow = await openShadow(dir, { home: tempDir('rv-home') })
  const s0 = await shadow.snapshot(RUN, 'S0')
  const atS0 = workTreeHashes(dir)
  write(dir, 'crlf.txt', Buffer.from('line one\r\nline TWO\nété\r\nadded\r\n', 'utf8'))
  rmSync(join(dir, 'gone.txt'))
  write(dir, 'added.txt', 'added by the run\r\n')
  write(dir, 'bin.dat', Buffer.from([9, 9, 0, 13, 10, 0, 255]))
  write(dir, 'newdir/deep/new.bin', Buffer.from([0, 0, 1, 2]))
  const s1 = await shadow.snapshot(RUN, 'S1')
  const atS1 = workTreeHashes(dir)
  return { dir, shadow, s0, s1, atS0, atS1 }
}

describe(`revert round trips (${version.raw})`, () => {
  it('per file: each revert restores its S0 bytes alone, each undo the S1 bytes (sha256 of every file)', async () => {
    const { dir, shadow, s0, atS0, atS1 } = await scenario()
    const dotGit = dotGitFingerprint(dir)
    for (const rel of ['crlf.txt', 'gone.txt', 'added.txt', 'bin.dat']) {
      const r = await revertTo(shadow, s0.commit, { runId: RUN, paths: [rel] })
      if (!r.ok) throw new Error(`${rel}: ${r.message}`)
      expect(r.outcome.skipped, rel).toEqual([])
      const now = workTreeHashes(dir)
      // The reverted file is as at S0 (or absent, for the file the run added); every other file is as at S1.
      expect(now[rel], rel).toBe(atS0[rel])
      for (const other of Object.keys({ ...atS1, ...atS0 }).filter((p) => p !== rel)) {
        expect(now[other], `${rel} → ${other}`).toBe(atS1[other])
      }
      if (rel === 'crlf.txt')
        expect(readFileSync(join(dir, rel)).equals(S0_FILES['crlf.txt'] as Buffer)).toBe(true)
      if (rel === 'added.txt') expect(existsSync(join(dir, rel))).toBe(false)
      const u = await undoRevert(shadow, r.outcome, { runId: RUN })
      if (!u.ok) throw new Error(`undo ${rel}: ${u.message}`)
      expect(workTreeHashes(dir), `undo ${rel}`).toEqual(atS1)
    }
    expect(dotGitFingerprint(dir)).toEqual(dotGit)
  })

  it('the whole segment: revert is byte-exact S0 (folders the run made go), undo byte-exact S1', async () => {
    const { dir, shadow, s0, atS0, atS1 } = await scenario()
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error(r.message)
    expect(r.outcome.restored).toEqual(['bin.dat', 'crlf.txt', 'gone.txt'])
    expect(r.outcome.deleted).toEqual(['added.txt', 'newdir/deep/new.bin'])
    expect(workTreeHashes(dir)).toEqual(atS0)
    expect(existsSync(join(dir, 'newdir'))).toBe(false)
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    if (!u.ok) throw new Error(u.message)
    expect(workTreeHashes(dir)).toEqual(atS1)
    // A second revert after the undo is the same revert again.
    const again = await revertTo(shadow, s0.commit, { runId: RUN })
    expect(again.ok && workTreeHashes(dir)).toEqual(atS0)
  })

  it('refused while a process holds the folder, with a reason to show; nothing is written', async () => {
    const { dir, shadow, s0, atS1 } = await scenario()
    const r = await revertTo(shadow, s0.commit, { runId: RUN, folderHeld: true })
    expect(r).toEqual({
      ok: false,
      refused: 'folder-busy',
      message: 'A step is still working in this folder. Revert when it has stopped.',
    })
    expect(workTreeHashes(dir)).toEqual(atS1)
  })

  it('an undo is refused once a reverted file changed again, naming it; nothing is written', async () => {
    const { dir, shadow, s0 } = await scenario()
    const r = await revertTo(shadow, s0.commit, { runId: RUN, paths: ['crlf.txt', 'bin.dat'] })
    if (!r.ok) throw new Error(r.message)
    write(dir, 'crlf.txt', 'the user typed here\n')
    const before = workTreeHashes(dir)
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    expect(u).toMatchObject({ ok: false, refused: 'conflict', paths: ['crlf.txt'] })
    expect(u.ok ? '' : u.message).toContain('crlf.txt')
    expect(workTreeHashes(dir)).toEqual(before)
  })
})
