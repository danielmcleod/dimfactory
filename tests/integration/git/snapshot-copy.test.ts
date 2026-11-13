// An isolated copy made from a snapshot, against real git: every file of the tree byte for byte (CRLF, binary, deep
// folders), uncommitted changes included, ignored files left out, a folder that is not a repository, an earlier
// attempt replaced, and neither the user's folder nor its .git touched. Removing it never runs git.
// Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openShadow } from '../../../src/core/git/shadow.ts'
import { createSnapshotCopy, isSnapshotCopy, treeSize } from '../../../src/core/git/snapshot-copy.ts'
import { isWorktreeError, removeWorktree } from '../../../src/core/git/worktree.ts'
import { homePaths } from '../../../src/core/home.ts'
import { TEST_GIT, cleanupTemps, git, initRepo, listTree, tempDir, testGitVersion, write } from './helpers.ts'
import { dotGitFingerprint, workTreeHashes } from './fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] snapshot copy suite: ${version.raw} (${TEST_GIT})`)

const MATCH = '20261110T120000Z-mtch'
const RUN_A = '20261110T120001Z-aaaa'
const RUN_B = '20261110T120002Z-bbbb'

afterEach(() => cleanupTemps())

const FILES: Record<string, Buffer> = {
  'crlf.txt': Buffer.from('one\r\ntwo\r\n'),
  'lf.txt': Buffer.from('lf only\nstill lf\n'),
  'bin.dat': Buffer.from([0, 1, 2, 13, 10, 255, 254, 0, 13]),
  'sub/deep/nested.txt': Buffer.from('deep\r\nfile\n'),
  'with space/naïve file.txt': Buffer.from('names survive\n'),
}

function expectFiles(dir: string, files: Record<string, Buffer>): void {
  for (const [rel, data] of Object.entries(files)) {
    expect(readFileSync(join(dir, rel)).equals(data), rel).toBe(true)
  }
}

describe(`a copy from a snapshot (${version.raw})`, () => {
  it('writes the folder as it was, uncommitted changes included, and touches neither the folder nor its .git', async () => {
    const dir = tempDir('copy-repo')
    initRepo(dir, { autocrlf: true })
    write(dir, '.gitattributes', '*.txt text eol=crlf\n*.dat binary\n')
    write(dir, '.gitignore', 'node_modules/\n.env\n')
    for (const [rel, data] of Object.entries(FILES)) write(dir, rel, data)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'base'])
    // Not committed: an edit, a new file. Ignored: a dependency folder and a secret.
    write(dir, 'lf.txt', 'edited, not committed\n')
    write(dir, 'untracked.txt', 'new, not added\n')
    write(dir, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    write(dir, '.env', 'SECRET=1\n')
    const home = tempDir('copy-home')
    const shadow = await openShadow(dir, { home })
    const start = await shadow.snapshot(MATCH, 'match-start')
    const before = workTreeHashes(dir)
    const dotGit = dotGitFingerprint(dir)

    const intents: string[] = []
    const copy = await createSnapshotCopy({
      home,
      runId: RUN_A,
      source: shadow,
      tree: start.tree,
      onIntent: (w) => {
        intents.push(w.path)
        expect(existsSync(w.path)).toBe(false)
        return Promise.resolve()
      },
    })
    expect(copy.path).toBe(homePaths(home).worktree(RUN_A))
    expect(intents).toEqual([copy.path])
    expect(copy.branch).toBe('')
    expect(copy.base).toBe(start.tree)
    expect(isSnapshotCopy(copy)).toBe(true)
    expectFiles(copy.path, { ...FILES, 'lf.txt': Buffer.from('edited, not committed\n') })
    expect(readFileSync(join(copy.path, 'untracked.txt'), 'utf8')).toBe('new, not added\n')
    // What the snapshot leaves out, the copy leaves out; and it is a plain folder, not a worktree.
    expect(existsSync(join(copy.path, 'node_modules'))).toBe(false)
    expect(existsSync(join(copy.path, '.env'))).toBe(false)
    expect(existsSync(join(copy.path, '.git'))).toBe(false)
    expect(copy.files).toBe(listTree(copy.path).length)
    expect((await treeSize(shadow, start.tree)).files).toBe(copy.files)
    // The user's side: nothing changed.
    expect(workTreeHashes(dir)).toEqual(before)
    expect(dotGitFingerprint(dir)).toEqual(dotGit)
    expect(git(dir, ['worktree', 'list']).trim().split('\n')).toHaveLength(1)
  })

  it('two sides get the same bytes, and a later edit of the folder changes neither', async () => {
    const dir = tempDir('copy-two')
    initRepo(dir)
    for (const [rel, data] of Object.entries(FILES)) write(dir, rel, data)
    const home = tempDir('copy-two-home')
    const shadow = await openShadow(dir, { home })
    const start = await shadow.snapshot(MATCH, 'match-start')
    const a = await createSnapshotCopy({ home, runId: RUN_A, source: shadow, tree: start.tree })
    write(dir, 'lf.txt', 'the folder moved on\n')
    const b = await createSnapshotCopy({ home, runId: RUN_B, source: shadow, tree: start.tree })
    expect(workTreeHashes(a.path)).toEqual(workTreeHashes(b.path))
    expectFiles(b.path, FILES)
  })

  it('works for a folder that is not a repository', async () => {
    const dir = tempDir('copy-plain')
    write(dir, 'index.html', '<!doctype html><title>Plain</title>\n')
    write(dir, 'data/sales.csv', 'a,b\r\n1,2\r\n')
    write(dir, 'node_modules/x/y.js', '1\n')
    const home = tempDir('copy-plain-home')
    const shadow = await openShadow(dir, { home })
    expect(shadow.isRepo).toBe(false)
    const start = await shadow.snapshot(MATCH, 'match-start')
    const copy = await createSnapshotCopy({ home, runId: RUN_A, source: shadow, tree: start.tree })
    expect(listTree(copy.path).map((f) => f.split(sep).join('/'))).toEqual(['data/sales.csv', 'index.html'])
    expect(readFileSync(join(copy.path, 'data/sales.csv')).equals(Buffer.from('a,b\r\n1,2\r\n'))).toBe(true)
  })

  it("replaces this run's own earlier attempt", async () => {
    const dir = tempDir('copy-again')
    write(dir, 'a.txt', 'a\n')
    const home = tempDir('copy-again-home')
    const shadow = await openShadow(dir, { home })
    const start = await shadow.snapshot(MATCH, 'match-start')
    const at = homePaths(home).worktree(RUN_A)
    mkdirSync(join(at, 'half'), { recursive: true })
    writeFileSync(join(at, 'half', 'left-over.txt'), 'from a crashed attempt')
    const copy = await createSnapshotCopy({ home, runId: RUN_A, source: shadow, tree: start.tree })
    expect(listTree(copy.path)).toEqual(['a.txt'])
  })

  it('refuses a tree that is not there, and a drive without room, before writing anything', async () => {
    const dir = tempDir('copy-refuse')
    write(dir, 'a.txt', 'a\n')
    const home = tempDir('copy-refuse-home')
    const shadow = await openShadow(dir, { home })
    const start = await shadow.snapshot(MATCH, 'match-start')
    const at = homePaths(home).worktree(RUN_A)
    const gone = await createSnapshotCopy({ home, runId: RUN_A, source: shadow, tree: '0'.repeat(40) }).catch(
      (e: unknown) => e,
    )
    expect(isWorktreeError(gone) && gone.message).toMatch(/not there any more/)
    const full = await createSnapshotCopy({
      home,
      runId: RUN_A,
      source: shadow,
      tree: start.tree,
      freeBytes: () => Promise.resolve(1024),
    }).catch((e: unknown) => e)
    expect(isWorktreeError(full) && full.category).toBe('disk_full')
    expect(isWorktreeError(full) && full.message).toMatch(/Not enough free space/)
    expect(existsSync(at)).toBe(false)
    const notATree = await createSnapshotCopy({ home, runId: RUN_A, source: shadow, tree: 'HEAD' }).catch(
      (e: unknown) => e,
    )
    expect(isWorktreeError(notATree)).toBe(true)
  })

  it('removing a copy deletes its folder and its shadow and never runs git in the user repository', async () => {
    const dir = tempDir('copy-remove')
    initRepo(dir)
    write(dir, 'a.txt', 'a\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'base'])
    const home = tempDir('copy-remove-home')
    const shadow = await openShadow(dir, { home })
    const start = await shadow.snapshot(MATCH, 'match-start')
    const copy = await createSnapshotCopy({ home, runId: RUN_A, source: shadow, tree: start.tree })
    // The run's own snapshots live in the copy's shadow.
    const own = await openShadow(copy.path, { home })
    await own.snapshot(RUN_A, 'run-start')
    expect(existsSync(homePaths(home).shadowRepo(own.folderKey))).toBe(true)
    const dotGit = dotGitFingerprint(dir)
    const r = await removeWorktree({
      home,
      worktree: { path: copy.path, branch: copy.branch, base: copy.base, folder: dir },
    })
    expect(r).toMatchObject({
      removed: true,
      branchDeleted: true,
      shadowDropped: true,
      notes: [],
      commands: [],
    })
    expect(existsSync(copy.path)).toBe(false)
    expect(existsSync(homePaths(home).shadowRepo(own.folderKey))).toBe(false)
    expect(dotGitFingerprint(dir)).toEqual(dotGit)
    // The folder's own shadow (the match's starting point) is still there.
    expect(existsSync(shadow.gitDir)).toBe(true)
  })
})
