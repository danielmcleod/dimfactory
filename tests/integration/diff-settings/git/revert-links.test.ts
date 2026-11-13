// Review fix: Revert never reaches through a link (revert to S0, the Diff tab's Revert). Git
// for Windows snapshots a directory junction's target as if it were a folder of the project, so a revert's plan can
// name files that live outside it. A delete under a junction (or any link) is skipped with the reason, emptied folders
// are pruned only up to the first link, and the junction itself survives a revert and its undo. Honors
// DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneEmptyParents, revertTo, undoRevert } from '../../../../src/core/git/revert.ts'
import { openShadow } from '../../../../src/core/git/shadow.ts'
import {
  TEST_GIT,
  cleanupTemps,
  initRepo,
  isWin,
  shadowTreePaths,
  tempDir,
  testGitVersion,
  write,
} from '../../git/helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] revert-through-links suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261009T120000Z-m11l'

afterEach(() => cleanupTemps())

const text = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')
const isLink = (p: string): boolean => existsSync(p) && lstatSync(p).isSymbolicLink()

describe(`pruning emptied folders stops at a link (${version.raw})`, () => {
  it('a junction (a folder link on POSIX) whose target is empty is never removed', async () => {
    const root = tempDir('prune')
    const outside = tempDir('prune-outside')
    mkdirSync(join(root, 'real', 'deeper'), { recursive: true })
    symlinkSync(outside, join(root, 'linked'), 'junction')
    await pruneEmptyParents(root, 'linked/gone.txt')
    expect(isLink(join(root, 'linked'))).toBe(true)
    // Real folders are still pruned, up to the scope root.
    await pruneEmptyParents(root, 'real/deeper/gone.txt')
    expect(existsSync(join(root, 'real'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })
})

describe.runIf(isWin)(`a directory junction in the project (${version.raw})`, () => {
  it('Revert all deletes nothing behind the junction, keeps it, and its undo keeps it too', async () => {
    const dir = tempDir('junction')
    const shared = tempDir('junction-shared')
    initRepo(dir)
    write(shared, 'lib.h', 'int shared(void);\n')
    write(dir, 'main.c', 'int main(void) { return 0; }\n')
    symlinkSync(shared, join(dir, 'vendor'), 'junction')
    const shadow = await openShadow(dir, { home: tempDir('junction-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'main.c', 'int main(void) { return 1; }\n')
    await shadow.snapshot(RUN, 'S1')
    // After the run, another project's tool adds a file to the shared folder.
    write(shared, 'other-project.h', 'belongs to another project\n')

    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error(r.message)
    expect(r.outcome.restored).toEqual(['main.c'])
    expect(r.outcome.deleted).toEqual([])
    // Git for Windows reads the junction as a folder: when the undo point holds the file behind it, the delete it
    // plans is skipped with the reason.
    if (shadowTreePaths(shadow.gitDir, r.outcome.preRevert.commit).includes('vendor/other-project.h')) {
      expect(r.outcome.skipped).toEqual([
        { path: 'vendor/other-project.h', reason: 'a link is in the place of its folder vendor' },
      ])
    }
    expect(text(dir, 'main.c')).toBe('int main(void) { return 0; }\n')
    expect(readdirSync(shared).sort()).toEqual(['lib.h', 'other-project.h'])
    expect(isLink(join(dir, 'vendor'))).toBe(true)

    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    if (!u.ok) throw new Error(u.message)
    expect(text(dir, 'main.c')).toBe('int main(void) { return 1; }\n')
    expect(isLink(join(dir, 'vendor'))).toBe(true)
    expect(readdirSync(shared).sort()).toEqual(['lib.h', 'other-project.h'])
  })

  it('a folder replaced by a junction after the run: nothing outside is written or deleted', async () => {
    const dir = tempDir('junction-docs')
    const outside = tempDir('junction-outside')
    initRepo(dir)
    write(dir, 'docs/a.txt', 'S0 docs\n')
    write(dir, 'main.c', 'S0 main\n')
    const shadow = await openShadow(dir, { home: tempDir('junction-docs-home') })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'main.c', 'run main\n')
    await shadow.snapshot(RUN, 'S1')
    // The user swaps docs/ for a junction to a folder outside the project.
    rmSync(join(dir, 'docs'), { recursive: true })
    write(outside, 'precious.txt', 'not the project’s\n')
    symlinkSync(outside, join(dir, 'docs'), 'junction')

    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error(r.message)
    expect(r.outcome.restored).toEqual(['main.c'])
    expect(r.outcome.deleted).toEqual([])
    expect(r.outcome.skipped).toContainEqual({
      path: 'docs/a.txt',
      reason: 'a link is in the place of its folder docs',
    })
    for (const s of r.outcome.skipped) expect(s.reason).toBe('a link is in the place of its folder docs')
    expect(readdirSync(outside)).toEqual(['precious.txt'])
    expect(text(outside, 'precious.txt')).toBe('not the project’s\n')
    expect(isLink(join(dir, 'docs'))).toBe(true)
    expect(text(dir, 'main.c')).toBe('S0 main\n')
  })
})
