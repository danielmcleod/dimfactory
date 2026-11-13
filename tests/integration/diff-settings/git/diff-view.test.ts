// Diff tab reads against real git: git/diff-view.ts ShadowReader over
// a shadow with every special row (CRLF edit under autocrlf, EOL-only, binary image, SVG, delete, add, rename,
// large, gitlink; mode change on POSIX), one file's patch (Ignore line endings, the size cap), blobs, object checks;
// and the persisted patch parsed back (git/patch.ts parsePatchFiles) gives the same rows as the shadow. Review fixes:
// with the project folder as its work tree the reader honours the project's .gitattributes (`-diff`) exactly as the
// controller's Shadow does; a type change (file to link) is one row read live or from the saved patch, and its
// section from the saved patch is what diff.file reads live. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { chmodSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ShadowReader,
  clearDiffViewCaches,
  imageMime,
  markEditedAfterRun,
  sameBlobId,
} from '../../../../src/core/git/diff-view.ts'
import { parsePatchFiles, patchSectionFor } from '../../../../src/core/git/patch.ts'
import { openShadow } from '../../../../src/core/git/shadow.ts'
import type { FileChange } from '../../../../src/shared/ipc.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  gitBuf,
  initRepo,
  isWin,
  tempDir,
  testGitVersion,
  write,
} from '../../git/helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] diff view suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261008T120000Z-m11d'
const PNG_OLD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 2, 3, 0, 255])
const PNG_NEW = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 9, 9, 9, 0, 254, 13, 10,
])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\n'

const lines = (n: number, tag: string, eol = '\n'): string =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} with some text to make it realistic`).join(eol) + eol

afterEach(() => {
  cleanupTemps()
  clearDiffViewCaches()
})

async function scenario() {
  const dir = tempDir('dv')
  initRepo(dir, { autocrlf: true })
  write(dir, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n')
  write(dir, 'eol.txt', lines(5, 'eol'))
  write(dir, 'gone.txt', 'the run deletes me\n')
  write(dir, 'ren-old.txt', lines(40, 'rename'))
  write(dir, 'img.png', PNG_OLD)
  write(dir, 'run.sh', '#!/bin/sh\necho hi\n')
  // A nested repository with a commit: the shadow records it as a gitlink.
  const sub = join(dir, 'sub')
  write(sub, 'inner.txt', 'inner v1\n')
  git(sub, ['init', '-q'])
  git(sub, ['add', '-A'])
  git(sub, ['commit', '-q', '-m', 'inner'])
  const shadow = await openShadow(dir, { home: tempDir('dv-home') })
  const s0 = await shadow.snapshot(RUN, 'S0')

  write(dir, 'crlf.txt', 'one\r\nTWO changed\r\nthree\r\n')
  write(dir, 'eol.txt', lines(5, 'eol', '\r\n'))
  rmSync(join(dir, 'gone.txt'))
  write(dir, 'dir/ren-new.txt', lines(40, 'rename'))
  rmSync(join(dir, 'ren-old.txt'))
  write(dir, 'img.png', PNG_NEW)
  write(dir, 'logo.svg', SVG)
  write(dir, 'new.txt', 'brand new\n')
  write(dir, 'big.txt', lines(3001, 'big'))
  if (!isWin) chmodSync(join(dir, 'run.sh'), 0o755)
  write(sub, 'inner.txt', 'inner v2\n')
  git(sub, ['commit', '-q', '-am', 'inner 2'])
  const s1 = await shadow.snapshot(RUN, 'S1')
  return { dir, shadow, s0, s1, reader: new ShadowReader(shadow.gitDir) }
}

const facts = (c: FileChange) => ({
  status: c.status,
  path: c.path,
  oldPath: c.oldPath,
  added: c.added,
  deleted: c.deleted,
  binary: c.binary,
  gitlink: c.gitlink,
  eolOnly: c.eolOnly,
  similarity: c.similarity,
  large: c.large,
  modeChanged: c.modeChanged,
})

describe(`diff view (${version.raw})`, () => {
  it('rows carry every special row the viewer draws', async () => {
    const { reader, s0, s1 } = await scenario()
    const rows = await reader.changes(s0.commit, s1.commit)
    const by = new Map(rows.map((r) => [r.path, r]))
    expect(rows.map((r) => `${r.status} ${r.path}`).sort()).toEqual(
      [
        'A big.txt',
        'M crlf.txt',
        'R dir/ren-new.txt',
        'M eol.txt',
        'D gone.txt',
        'M img.png',
        'A logo.svg',
        'A new.txt',
        ...(isWin ? [] : ['M run.sh']),
        'M sub',
      ].sort(),
    )
    expect(by.get('crlf.txt')).toMatchObject({ added: 1, deleted: 1, eolOnly: false, binary: false })
    expect(by.get('eol.txt')).toMatchObject({ eolOnly: true, added: 5, deleted: 5 })
    expect(by.get('img.png')).toMatchObject({ binary: true, added: null, deleted: null })
    expect(by.get('dir/ren-new.txt')).toMatchObject({ oldPath: 'ren-old.txt', similarity: 100 })
    expect(by.get('big.txt')).toMatchObject({ large: true, added: 3001 })
    expect(by.get('sub')).toMatchObject({ gitlink: true, oldMode: '160000', newMode: '160000' })
    expect(by.get('new.txt')?.large).toBeUndefined()
    if (!isWin)
      expect(by.get('run.sh')).toMatchObject({ modeChanged: true, oldMode: '100644', newMode: '100755' })
    // Cached per commit pair: the same rows again without git.
    expect(await reader.changes(s0.commit, s1.commit)).toBe(rows)
  })

  it('the persisted patch parses back to the same rows (paths, counts, flags, abbreviated ids)', async () => {
    const { reader, s0, s1 } = await scenario()
    const live = await reader.changes(s0.commit, s1.commit)
    const saved = await reader.patch(s0.commit, s1.commit)
    expect(saved.truncated).toBe(false)
    const parsed = parsePatchFiles(saved.text)
    const strip = (c: FileChange) => ({ ...facts(c), large: undefined, modeChanged: undefined })
    expect(parsed.map(strip)).toEqual(live.map(strip))
    for (const [i, p] of parsed.entries()) {
      const l = live[i] as FileChange
      // git prints no index line when the content did not change: a pure rename, and a mode-only change (POSIX:
      // run.sh made executable). Such a row has no ids in the patch, and live its two blobs are the same.
      const noIndexLine =
        p.oldSha === '' &&
        p.newSha === '' &&
        (p.status === 'R' ||
          (p.status === 'M' && p.oldMode !== p.newMode && p.added === 0 && p.deleted === 0))
      if (noIndexLine) expect(l.oldSha, p.path).toBe(l.newSha)
      else expect(sameBlobId(p.newSha, l.newSha) || /^0+$/.test(l.newSha), p.path).toBe(true)
      expect(p.newMode === '' || p.newMode === l.newMode, p.path).toBe(true)
    }
  })

  it('one file’s patch: CRs kept, Ignore line endings drops an EOL-only file, renames, the size cap', async () => {
    const { reader, s0, s1 } = await scenario()
    const crlf = await reader.filePatch(s0.commit, s1.commit, { path: 'crlf.txt' })
    expect(crlf.truncated).toBe(false)
    expect(crlf.patch).toContain('-two\r\n+TWO changed\r\n')
    expect(crlf.patch.match(/^diff --git /gm)).toHaveLength(1)
    const eol = await reader.filePatch(s0.commit, s1.commit, { path: 'eol.txt' })
    expect(eol.patch).toContain('@@')
    const eolIgnored = await reader.filePatch(s0.commit, s1.commit, { path: 'eol.txt' }, { ignoreEol: true })
    expect(eolIgnored.patch).not.toContain('@@')
    const ren = await reader.filePatch(s0.commit, s1.commit, {
      path: 'dir/ren-new.txt',
      oldPath: 'ren-old.txt',
    })
    expect(ren.patch).toContain('rename from ren-old.txt')
    expect(ren.patch).toContain('rename to dir/ren-new.txt')
    const big = await reader.filePatch(s0.commit, s1.commit, { path: 'big.txt' }, { maxBytes: 4000 })
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.patch)).toBeLessThanOrEqual(4000)
    expect(big.patch.endsWith('\n')).toBe(true)
  })

  it('blobs by id: the image’s exact bytes, its size, an SVG that is no image', async () => {
    const { reader, s0, s1 } = await scenario()
    const rows = await reader.changes(s0.commit, s1.commit)
    const img = rows.find((r) => r.path === 'img.png') as FileChange
    const newBytes = await reader.blob(img.newSha)
    expect(newBytes.equals(PNG_NEW)).toBe(true)
    expect((await reader.blob(img.oldSha)).equals(PNG_OLD)).toBe(true)
    expect(await reader.blobSize(img.newSha)).toBe(PNG_NEW.length)
    expect(imageMime(newBytes)).toBe('image/png')
    const svg = rows.find((r) => r.path === 'logo.svg') as FileChange
    expect(imageMime(await reader.blob(svg.newSha))).toBeNull()
  })

  it('object checks, a missing shadow, and files edited after the run', async () => {
    const { reader, s0, s1, dir, shadow } = await scenario()
    expect(await reader.has([s0.commit, s1.commit])).toBe(true)
    expect(await reader.has([s0.commit, '1'.repeat(40)])).toBe(false)
    const rows = await reader.changes(s0.commit, s1.commit)
    write(dir, 'crlf.txt', 'edited by hand afterwards\n')
    write(dir, 'gone.txt', 'back again\n')
    rmSync(join(dir, 'new.txt'))
    const edited = new Map((await markEditedAfterRun(dir, rows)).map((r) => [r.path, r.editedAfterRun]))
    expect(edited.get('crlf.txt')).toBe(true)
    expect(edited.get('gone.txt')).toBe(true)
    expect(edited.get('new.txt')).toBe(true)
    expect(edited.get('eol.txt')).toBe(false)
    expect(edited.get('img.png')).toBe(false)
    expect(edited.get('sub')).toBeUndefined()
    // A shadow that is gone is never re-created by a read.
    renameSync(shadow.root, `${shadow.root}-moved`)
    expect(await ShadowReader.open(shadow.gitDir)).toBeNull()
  })

  it('honours the project’s .gitattributes like the controller’s Shadow: rows, saved patch and the file’s patch', async () => {
    const dir = tempDir('dv-attr')
    initRepo(dir)
    write(dir, '.gitattributes', '*.dat -diff\n')
    write(dir, 'data.dat', 'one\ntwo\n')
    write(dir, 'note.txt', 'plain\n')
    const shadow = await openShadow(dir, { home: tempDir('dv-attr-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'data.dat', 'one\nTWO\n')
    write(dir, 'note.txt', 'plain changed\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    const reader = await ShadowReader.open(shadow.gitDir, dir)
    if (reader === null) throw new Error('no shadow')
    expect(reader.workTree).not.toBeNull()
    const live = await reader.changes(s0.commit, s1.commit)
    const controller = await shadow.changes(s0.commit, s1.commit)
    const pick = (rows: FileChange[]) =>
      rows.map((r) => ({ path: r.path, binary: r.binary, added: r.added, deleted: r.deleted }))
    expect(pick(live)).toEqual(pick(controller))
    expect(live.find((r) => r.path === 'data.dat')).toMatchObject({
      binary: true,
      added: null,
      deleted: null,
    })
    // The controller's saved copy (Shadow.patch) parses back to the same rows, and diff.file's read agrees.
    const controllerPatch = await shadow.patch(s0.commit, s1.commit)
    expect(pick(parsePatchFiles(controllerPatch.text))).toEqual(pick(live))
    const one = await reader.filePatch(s0.commit, s1.commit, { path: 'data.dat' })
    expect(one.patch).toMatch(/^Binary files /m)
    // A history run whose folder is gone reads with GIT_DIR alone (the attributes are not there to read).
    const noTree = await ShadowReader.open(shadow.gitDir, join(dir, 'missing'))
    expect(noTree?.workTree).toBeNull()
    expect((await noTree?.changes(s0.commit, s1.commit))?.map((r) => r.path).sort()).toEqual([
      'data.dat',
      'note.txt',
    ])
  })

  it('a type change (a file became a link) is one row, live and from the saved patch, with the same patch', async () => {
    const dir = tempDir('dv-type')
    initRepo(dir)
    write(dir, 'x', 'a file first\nsecond line\n')
    const shadow = await openShadow(dir, { home: tempDir('dv-type-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    // The next snapshot, made with plumbing (a link cannot be made everywhere): x is now a link to `target`.
    const env = { GIT_DIR: shadow.gitDir }
    const run = (args: string[], input?: string): string =>
      gitBuf(dir, args, { env, ...(input !== undefined ? { input } : {}) })
        .toString('utf8')
        .trim()
    const link = run(['hash-object', '-w', '--stdin'], 'target')
    const tree0 = run(['rev-parse', `${s0.commit}^{tree}`])
    const entries = run(['ls-tree', tree0])
      .split('\n')
      .filter((l) => !l.endsWith('\tx'))
    const tree1 = run(['mktree'], [...entries, `120000 blob ${link}\tx`].join('\n') + '\n')
    const c1 = run(['commit-tree', tree1, '-p', s0.commit, '-m', 'type change'])
    const reader = new ShadowReader(shadow.gitDir, dir)
    const live = await reader.changes(s0.commit, c1)
    expect(live.map((r) => `${r.status} ${r.path} ${r.oldMode} ${r.newMode}`)).toEqual(['T x 100644 120000'])
    const saved = (await reader.patch(s0.commit, c1)).text
    expect(saved.match(/^diff --git a\/x b\/x$/gm)).toHaveLength(2)
    const parsed = parsePatchFiles(saved)
    expect(parsed).toHaveLength(1)
    const [row] = parsed
    const [l] = live
    if (row === undefined || l === undefined) throw new Error('no rows')
    expect({ ...facts(row), large: undefined, modeChanged: undefined }).toEqual({
      ...facts(l),
      large: undefined,
      modeChanged: undefined,
    })
    expect(row).toMatchObject({ oldMode: '100644', newMode: '120000' })
    expect(sameBlobId(row.oldSha, l.oldSha)).toBe(true)
    expect(sameBlobId(row.newSha, l.newSha)).toBe(true)
    // The saved patch's section for the row is both of git's sections, as diff.file reads live.
    const section = patchSectionFor(saved, row)
    const filePatch = await reader.filePatch(s0.commit, c1, l)
    expect(section?.text).toBe(filePatch.patch)
    expect(section?.text).toContain('deleted file mode 100644')
    expect(section?.text).toContain('new file mode 120000')
  })
})
