// Coverage: an isolated run's worktree when it cannot be made, and removal that never follows a link
// (Prepare step 1 refuses a folder that is not a repository, a repository without a
// commit and a branch name git rejects, before writing anything; Cleanup removes links, never their targets). Real
// git (DIM_FACTORY_TEST_GIT honoured).
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkEligibility, createWorktree, removeTree } from '../../../src/core/git/worktree.ts'
import { homePaths } from '../../../src/core/home.ts'
import { cleanupTemps, git, initRepo, isWin, tempDir, write } from '../git/helpers.ts'

afterEach(() => cleanupTemps())

const RUN = '20261012T120000Z-wt17'

function committedRepo(): string {
  const repo = tempDir('wt-repo')
  initRepo(repo)
  write(repo, 'a.txt', 'a\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'one'])
  return repo
}

const refs = (repo: string): string => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])

describe('createWorktree refuses before writing anything', () => {
  it('a folder that is not a repository: not-repo, no worktrees folder', async () => {
    const home = tempDir('wt-home')
    const plain = tempDir('wt-plain')
    await expect(createWorktree({ home, runId: RUN, folder: plain, branch: 'dim/x' })).rejects.toMatchObject({
      name: 'WorktreeError',
      kind: 'not-repo',
      category: 'worktree_failed',
    })
    expect(existsSync(homePaths(home).worktreesDir)).toBe(false)
  })

  it.each([['bad..name'], ['has space'], ['-starts-with-dash'], ['ends.lock'], ['dim/x~1']])(
    'a branch name git rejects (%s): invalid-name; no worktree, no branch',
    async (branch) => {
      const home = tempDir('wt-home')
      const repo = committedRepo()
      const before = refs(repo)
      await expect(createWorktree({ home, runId: RUN, folder: repo, branch })).rejects.toMatchObject({
        kind: 'invalid-name',
        message: `git does not accept "${branch}" as a branch name.`,
      })
      expect(existsSync(homePaths(home).worktree(RUN))).toBe(false)
      expect(refs(repo)).toBe(before)
      expect(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
    },
  )

  it('a repository without a commit: no-commit; no worktree, no branch', async () => {
    const home = tempDir('wt-home')
    const repo = tempDir('wt-empty')
    git(repo, ['init', '-q'])
    await expect(
      createWorktree({ home, runId: RUN, folder: repo, branch: 'dim/first' }),
    ).rejects.toMatchObject({
      kind: 'no-commit',
    })
    expect(existsSync(homePaths(home).worktree(RUN))).toBe(false)
    expect(refs(repo).trim()).toBe('')
  })
})

describe('checkEligibility on a folder Dim Factory cannot read', () => {
  it('a folder that does not exist: one git blocker saying so, not eligible', async () => {
    const home = tempDir('wt-home')
    const gone = join(tempDir('wt-parent'), 'gone')
    const r = await checkEligibility(gone, { home })
    expect(r.ok).toBe(false)
    expect(r.blockers).toEqual([
      expect.objectContaining({ kind: 'git', title: 'Dim Factory could not read the folder', commands: [] }),
    ])
  })
})

describe('removeTree', () => {
  it('removes nested folders and read-only files', async () => {
    const root = join(tempDir('rt'), 'tree')
    write(root, 'deep/er/file.txt', 'x')
    write(root, 'ro.txt', 'read only')
    chmodSync(join(root, 'ro.txt'), 0o444)
    chmodSync(join(root, 'deep', 'er', 'file.txt'), 0o444)
    await removeTree(root)
    expect(existsSync(root)).toBe(false)
  })

  it('a path that is already gone is nothing to do', async () => {
    await expect(removeTree(join(tempDir('rt'), 'never-there'))).resolves.toBeUndefined()
  })

  it('a link (a junction on Windows) is removed itself; its target and the target’s files stay', async () => {
    const base = tempDir('rt-link')
    const target = join(base, 'outside')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const link = join(base, 'link')
    symlinkSync(target, link, isWin ? 'junction' : 'dir')
    await removeTree(link)
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('a folder holding a link: the link goes, what it points to stays', async () => {
    const base = tempDir('rt-inner')
    const target = join(base, 'outside')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const tree = join(base, 'tree')
    write(tree, 'own.txt', 'own')
    symlinkSync(target, join(tree, 'into-outside'), isWin ? 'junction' : 'dir')
    await removeTree(tree)
    expect(existsSync(tree)).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })
})
