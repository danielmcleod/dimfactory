// Links to folders are left out of snapshots ("snapshots descend into Windows junctions: exclude junctions (and
// symlinks to directories) from the shadow's add -A"): a junction on Windows,
// a symbolic link to a folder elsewhere. A link's target never enters a snapshot, a diff, the tree reconcile reads, a
// revert or an apply; a link the walk does not reach is dropped after `add -A`; a folder that becomes a link (and back)
// is followed. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRun, previewApply } from '../../../src/core/git/finalize.ts'
import { revertTo } from '../../../src/core/git/revert.ts'
import { openShadow, sizePreflightReadOnly } from '../../../src/core/git/shadow.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import {
  TEST_GIT,
  cleanupTemps,
  initRepo,
  isWin,
  shadowTreePaths,
  tempDir,
  testGitVersion,
  write,
} from '../git/helpers.ts'
import { isolated } from '../isolated-runs/git/fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] links-to-folders suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

const RUN = '20261009T140000Z-link'
const KIND = isWin ? 'a directory junction' : 'a symbolic link to a folder'

/** A junction on Windows (no privilege needed), a symbolic link to a folder elsewhere. */
function folderLink(target: string, at: string): void {
  symlinkSync(target, at, isWin ? 'junction' : 'dir')
}

/** Remove the link itself, never what it points at. */
function unlink(at: string): void {
  if (isWin) rmdirSync(at)
  else unlinkSync(at)
}

const text = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')
const isLink = (p: string): boolean => existsSync(p) && lstatSync(p).isSymbolicLink()

describe(`${KIND} in the folder (${version.raw})`, () => {
  it('its target never enters a snapshot, a diff, the tree now, the size check or a revert', async () => {
    const dir = tempDir('links')
    const outside = tempDir('links-outside')
    initRepo(dir)
    write(dir, 'src/a.txt', 'a1\n')
    write(outside, 'lib/secret.h', 's1\n')
    folderLink(outside, join(dir, 'vendor'))
    const home = tempDir('links-home')
    // The size check before any snapshot counts the project's files only.
    const size = await sizePreflightReadOnly(await resolveScope(dir), { home })
    expect(size.files).toBe(2)

    const shadow = await openShadow(dir, { home })
    const s0 = await shadow.snapshot(RUN, 'S0')
    expect(s0.links).toEqual(['vendor'])
    expect(shadowTreePaths(shadow.gitDir, s0.commit)).toEqual(['README.md', 'src/a.txt'])
    expect(readFileSync(join(shadow.gitDir, 'info', 'exclude'), 'utf8')).toContain('\n/vendor\n')

    write(outside, 'lib/secret.h', 's2\n')
    write(outside, 'lib/new.h', 'n\n')
    write(dir, 'src/a.txt', 'a2\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    expect(shadowTreePaths(shadow.gitDir, s1.commit)).toEqual(['README.md', 'src/a.txt'])
    expect((await shadow.changes(s0.commit, s1.commit)).map((c) => c.path)).toEqual(['src/a.txt'])
    const patch = await shadow.patch(s0.commit, s1.commit)
    expect(patch.text).not.toContain('secret')
    expect((await shadow.treeNow()).tree).toBe(s1.tree)

    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error(r.message)
    expect(r.outcome.restored).toEqual(['src/a.txt'])
    expect(r.outcome.deleted).toEqual([])
    expect(shadowTreePaths(shadow.gitDir, r.outcome.preRevert.commit)).toEqual(['README.md', 'src/a.txt'])
    expect(text(dir, 'src/a.txt')).toBe('a1\n')
    expect(readdirSync(join(outside, 'lib')).sort()).toEqual(['new.h', 'secret.h'])
    expect(text(outside, 'lib/secret.h')).toBe('s2\n')
    expect(isLink(join(dir, 'vendor'))).toBe(true)
  })

  it('a link inside a folder the walk leaves unread is dropped after add, and excluded from then on', async () => {
    const dir = tempDir('links-nm')
    const outside = tempDir('links-nm-outside')
    initRepo(dir)
    // node_modules is not ignored here (no .gitignore), so add -A walks it; the link walk does not.
    write(dir, 'node_modules/real/index.js', 'module.exports = 1\n')
    write(outside, 'pkg/index.js', 'secret\n')
    folderLink(outside, join(dir, 'node_modules', 'dep'))
    const shadow = await openShadow(dir, { home: tempDir('links-nm-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    expect(s0.links).toEqual(['node_modules/dep'])
    expect(shadowTreePaths(shadow.gitDir, s0.commit)).toEqual(['README.md', 'node_modules/real/index.js'])
    expect(readFileSync(join(shadow.gitDir, 'info', 'exclude'), 'utf8')).toContain('\n/node_modules/dep\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    expect(s1.links).toEqual(['node_modules/dep'])
    expect(s1.tree).toBe(s0.tree)
    expect(s1.reused).toBe(true)
  })

  it('a link to another repository (or back to this one) in an unread folder never becomes a gitlink', async () => {
    const dir = tempDir('links-gl')
    const other = tempDir('links-gl-other')
    initRepo(dir)
    initRepo(other)
    write(other, 'secret.txt', 'other repo\n')
    write(dir, 'src/a.txt', 'a\n')
    // npm link of a local package: node_modules is not ignored here, and the walk leaves it unread.
    write(dir, 'node_modules/real/index.js', 'x\n')
    folderLink(other, join(dir, 'node_modules', 'mylib'))
    // A cycle: a link back to the folder itself.
    write(dir, 'node_modules/pkg/index.js', 'y\n')
    folderLink(dir, join(dir, 'node_modules', 'pkg', 'loop'))
    const shadow = await openShadow(dir, { home: tempDir('links-gl-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    expect(shadowTreePaths(shadow.gitDir, s0.commit)).toEqual([
      'README.md',
      'node_modules/pkg/index.js',
      'node_modules/real/index.js',
      'src/a.txt',
    ])
    expect(s0.nested).toBeUndefined()
    expect(s0.links).toEqual(['node_modules/mylib', 'node_modules/pkg/loop'])
    expect((await shadow.treeNow()).tree).toBe(s0.tree)
  })

  it("a forced path that is a link to a folder (Apply's undo point) never takes the target's files", async () => {
    const dir = tempDir('links-force')
    const outside = tempDir('links-force-outside')
    initRepo(dir)
    write(dir, 'src/a.txt', 'a1\n')
    write(outside, 'secret.txt', 'not the project’s\n')
    folderLink(outside, join(dir, 'vendor'))
    const shadow = await openShadow(dir, { home: tempDir('links-force-home') })
    const p = await shadow.snapshot(RUN, 'pre-apply', { force: ['vendor', 'vendor/secret.txt', 'src/a.txt'] })
    expect(shadowTreePaths(shadow.gitDir, p.commit)).toEqual(['README.md', 'src/a.txt'])
  })

  it('a folder replaced by a link leaves the next snapshot (nothing written behind it); a link replaced by a folder comes back', async () => {
    const dir = tempDir('links-swap')
    const outside = tempDir('links-swap-outside')
    initRepo(dir)
    write(dir, 'docs/a.txt', 'docs\n')
    write(outside, 'precious.txt', 'not the project’s\n')
    const shadow = await openShadow(dir, { home: tempDir('links-swap-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    expect(shadowTreePaths(shadow.gitDir, s0.commit)).toContain('docs/a.txt')

    rmSync(join(dir, 'docs'), { recursive: true })
    folderLink(outside, join(dir, 'docs'))
    const s1 = await shadow.snapshot(RUN, 'S1')
    expect(s1.links).toEqual(['docs'])
    expect(shadowTreePaths(shadow.gitDir, s1.commit)).toEqual(['README.md'])
    expect(await shadow.changes(s0.commit, s1.commit)).toMatchObject([{ path: 'docs/a.txt', status: 'D' }])

    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error(r.message)
    expect(r.outcome.restored).toEqual([])
    expect(r.outcome.skipped).toEqual([
      { path: 'docs/a.txt', reason: 'a link is in the place of its folder docs' },
    ])
    expect(readdirSync(outside)).toEqual(['precious.txt'])
    expect(isLink(join(dir, 'docs'))).toBe(true)

    unlink(join(dir, 'docs'))
    mkdirSync(join(dir, 'docs'))
    write(dir, 'docs/b.txt', 'real again\n')
    const s2 = await shadow.snapshot(RUN, 'S2')
    expect(s2.links).toBeUndefined()
    expect(shadowTreePaths(shadow.gitDir, s2.commit)).toEqual(['README.md', 'docs/b.txt'])
    expect(readFileSync(join(shadow.gitDir, 'info', 'exclude'), 'utf8')).not.toContain('/docs')
    expect(readdirSync(outside)).toEqual(['precious.txt'])
  })

  it('an isolated copy: Apply never reaches through a link (it is in no snapshot)', async () => {
    const f = await isolated({ 'a.txt': 'a1\n' })
    const outside = tempDir('links-iso-outside')
    write(outside, 'lib/secret.h', 'secret\n')
    folderLink(outside, join(f.wt.path, 'vendor'))
    write(f.wt.path, 'a.txt', 'a2\n')
    const target = await f.finish()
    const preview = await previewApply(target)
    expect(preview.files.map((c) => c.path)).toEqual(['a.txt'])
    expect(preview.actions.map((a) => a.path)).toEqual(['a.txt'])
    const done = await applyRun(target)
    expect(done.written).toEqual(['a.txt'])
    expect(text(f.repo, 'a.txt')).toBe('a2\n')
    expect(existsSync(join(f.repo, 'vendor'))).toBe(false)
    expect(readdirSync(join(outside, 'lib'))).toEqual(['secret.h'])
  })
})
