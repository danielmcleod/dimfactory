// Run branch prep against real git: create-only update-ref, symbolic-ref on a
// dirty tree byte-identical, the blocking conditions, end-of-run return/delete guards, the *.lock retries, and a
// user .git that changes only in the refs the run-branch functions own. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  branchBlockers,
  createRunBranch,
  deleteRunBranch,
  pickRunBranchName,
  prepareRunBranch,
  readHead,
  readRepoState,
  returnToPrevious,
} from '../../../src/core/git/branch.ts'
import { detectRepo } from '../../../src/core/git/repo.ts'
import type { RepoInfo } from '../../../src/core/git/repo.ts'
import { TEST_GIT, cleanupTemps, git, initRepo, tempDir, testGitVersion, write } from './helpers.ts'
import { dotGitFingerprint, ownedByRunBranch, waitFor, workTreeHashes } from './fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] branch suite: ${version.raw} (${TEST_GIT})`)

const DATE = new Date(2026, 9, 8, 12, 0, 0)
const NAME = 'dim/20261008-add-a-version-flag'

afterEach(() => cleanupTemps())

/** A repo with two commits on its default branch; returns its RepoInfo and that branch's ref. */
async function repoWithHistory(prefix: string): Promise<{ dir: string; repo: RepoInfo; mainRef: string }> {
  const dir = tempDir(prefix)
  initRepo(dir)
  write(dir, 'src/app.ts', 'export const v = 1\n')
  git(dir, ['add', 'src/app.ts'])
  git(dir, ['commit', '-q', '-m', 'app'])
  const mainRef = git(dir, ['symbolic-ref', 'HEAD']).trim()
  return { dir, repo: await detectRepo(dir), mainRef }
}

const headFile = (dir: string): string => readFileSync(join(dir, '.git', 'HEAD'), 'utf8')
const tip = (dir: string, ref: string): string | null => {
  const out = git(dir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true }).trim()
  return out === '' ? null : out
}

describe(`run branch (${version.raw})`, () => {
  it('names: <prefix><YYYYMMDD>-<slug>, -2/-3 on collision, check-ref-format refuses a bad prefix', async () => {
    const { dir, repo } = await repoWithHistory('names')
    const task = 'Add a --version flag'
    expect(await pickRunBranchName(repo, { prefix: 'dim/', date: DATE, task })).toEqual({
      ok: true,
      name: NAME,
    })
    git(dir, ['branch', NAME])
    expect(await pickRunBranchName(repo, { prefix: 'dim/', date: DATE, task })).toEqual({
      ok: true,
      name: `${NAME}-2`,
    })
    git(dir, ['branch', `${NAME}-2`])
    expect(await pickRunBranchName(repo, { prefix: 'dim/', date: DATE, task })).toEqual({
      ok: true,
      name: `${NAME}-3`,
    })
    const bad = await pickRunBranchName(repo, { prefix: 'bad..prefix/', date: DATE, task })
    expect(bad).toMatchObject({ ok: false, blocker: { kind: 'invalid-name' } })
    // prepareRunBranch picks the free name and makes it.
    const made = await prepareRunBranch(repo, { prefix: 'dim/', date: DATE, task })
    expect(made).toMatchObject({ ok: true, branch: { name: `${NAME}-3` } })
  })

  it('create-only update-ref refuses an existing name and changes nothing', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('exists')
    const first = git(dir, ['rev-parse', 'HEAD~1']).trim()
    git(dir, ['branch', NAME, first])
    const before = dotGitFingerprint(dir)
    const r = await createRunBranch(repo, NAME)
    expect(r).toMatchObject({ ok: false, blockers: [{ kind: 'name-taken' }] })
    expect(tip(dir, `refs/heads/${NAME}`)).toBe(first)
    expect(headFile(dir).trim()).toBe(`ref: ${mainRef}`)
    expect(dotGitFingerprint(dir)).toEqual(before)
  })

  it('symbolic-ref on a dirty tree leaves every file and the user index byte-identical', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('dirty')
    git(dir, ['config', 'core.autocrlf', 'true'])
    write(dir, 'staged.txt', 'staged\r\n')
    git(dir, ['add', 'staged.txt'])
    write(dir, 'src/app.ts', 'export const v = 2 // unstaged\r\n')
    rmSync(join(dir, 'README.md'))
    write(dir, 'untracked/notes.md', 'mine\n')
    write(dir, 'bin.dat', Buffer.from([0, 255, 13, 10, 0]))
    const base = git(dir, ['rev-parse', 'HEAD']).trim()
    const files = workTreeHashes(dir)
    const owned = ownedByRunBranch()
    const gitBefore = dotGitFingerprint(dir, owned)
    const r = await createRunBranch(repo, NAME)
    expect(r).toEqual({ ok: true, branch: { name: NAME, base, previous: mainRef }, notes: [] })
    // Only HEAD and the new ref changed; the index is byte-identical (and not even rewritten).
    expect(dotGitFingerprint(dir, owned)).toEqual(gitBefore)
    expect(workTreeHashes(dir)).toEqual(files)
    expect(headFile(dir).trim()).toBe(`ref: refs/heads/${NAME}`)
    expect(tip(dir, `refs/heads/${NAME}`)).toBe(base)
    expect(tip(dir, mainRef)).toBe(base)
    // Staged and unstaged changes read exactly as before (the branch points at the same commit).
    const status = git(dir, ['--no-optional-locks', 'status', '--porcelain', '-uall'])
      .split(/\r?\n/)
      .filter((l) => l !== '')
      .sort()
    expect(status).toEqual([
      ' D README.md',
      ' M src/app.ts',
      '?? bin.dat',
      '?? untracked/notes.md',
      'A  staged.txt',
    ])
  })

  it('a detached HEAD is info only: previous = detached:<sha>; return refuses with git checkout --detach', async () => {
    const { dir, repo } = await repoWithHistory('detached')
    git(dir, ['checkout', '-q', '--detach'])
    const sha = git(dir, ['rev-parse', 'HEAD']).trim()
    const r = await createRunBranch(repo, NAME, { os: 'linux' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.branch).toEqual({ name: NAME, base: sha, previous: `detached:${sha}` })
    expect(r.notes).toEqual([`HEAD was detached at ${sha.slice(0, 7)}. The run branch starts there.`])
    const back = await returnToPrevious(repo, r.branch, { os: 'linux' })
    expect(back).toMatchObject({ done: false, commands: [`git checkout --detach ${sha}`] })
    expect(headFile(dir).trim()).toBe(`ref: refs/heads/${NAME}`)
  })

  it('blocks on an unborn HEAD', async () => {
    const dir = tempDir('unborn')
    git(dir, ['init', '-q'])
    write(dir, 'a.txt', 'a\n')
    const repo = await detectRepo(dir)
    const r = await createRunBranch(repo, NAME)
    expect(r).toMatchObject({ ok: false, blockers: [{ kind: 'unborn-head' }] })
    expect(existsSync(join(dir, '.git', 'refs', 'heads', 'dim'))).toBe(false)
  })

  it('blocks on a merge in progress with the copyable abort, and on its unmerged paths', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('merge')
    git(dir, ['checkout', '-q', '-b', 'other'])
    write(dir, 'src/app.ts', 'export const v = "other"\n')
    git(dir, ['commit', '-q', '-am', 'other'])
    git(dir, ['checkout', '-q', mainRef.replace('refs/heads/', '')])
    write(dir, 'src/app.ts', 'export const v = "main"\n')
    git(dir, ['commit', '-q', '-am', 'main'])
    git(dir, ['merge', 'other'], { allowFail: true })
    const state = await readRepoState(repo)
    expect(state).toMatchObject({ operation: 'merge', bisect: false, unmergedPaths: ['src/app.ts'] })
    const r = await createRunBranch(repo, NAME, { os: 'win32' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.blockers.map((b) => b.kind)).toEqual(['operation', 'unmerged'])
    expect(r.blockers[0]).toMatchObject({
      op: 'merge',
      title: 'A git merge is in progress',
      commands: [{ command: 'git merge --abort', shell: 'powershell' }],
    })
    expect(tip(dir, `refs/heads/${NAME}`)).toBeNull()
  })

  it('detects every operation marker through rev-parse --git-path (rebase, am, cherry-pick, revert, sequencer, bisect)', async () => {
    const { dir, repo } = await repoWithHistory('markers')
    const gitDir = join(dir, '.git')
    const cases: [string, string, string][] = [
      ['rebase-merge/', 'rebase', 'git rebase --abort'],
      ['rebase-apply/applying', 'am', 'git am --abort'],
      ['rebase-apply/', 'rebase', 'git rebase --abort'],
      ['CHERRY_PICK_HEAD', 'cherry-pick', 'git cherry-pick --abort'],
      ['REVERT_HEAD', 'revert', 'git revert --abort'],
      ['sequencer/todo', 'revert', 'git revert --abort'],
      ['BISECT_LOG', 'bisect', 'git bisect reset'],
    ]
    for (const [marker, op, abort] of cases) {
      const p = join(gitDir, marker)
      if (marker.endsWith('/')) mkdirSync(p, { recursive: true })
      else {
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, marker === 'sequencer/todo' ? 'revert 0123456 undo it\n' : '0123\n')
      }
      const { blockers } = await branchBlockers(repo, { os: 'linux' })
      expect(blockers, marker).toEqual([
        expect.objectContaining({ kind: 'operation', op, commands: [{ command: abort, shell: 'sh' }] }),
      ])
      rmSync(join(gitDir, marker.split('/')[0] ?? marker), { recursive: true, force: true })
    }
    expect((await branchBlockers(repo)).blockers).toEqual([])
  })

  it('blocks on unmerged paths without an operation (conflict stages in the index)', async () => {
    const { dir, repo } = await repoWithHistory('unmerged')
    const blob = git(dir, ['rev-parse', 'HEAD:src/app.ts']).trim()
    git(dir, ['update-index', '-z', '--index-info'], {
      input: [
        `0 ${'0'.repeat(40)}\tsrc/app.ts`,
        `100644 ${blob} 1\tsrc/app.ts`,
        `100644 ${blob} 2\tsrc/app.ts`,
        `100644 ${blob} 3\tsrc/app.ts`,
        '',
      ].join('\0'),
    })
    const { blockers } = await branchBlockers(repo)
    expect(blockers.map((b) => b.kind)).toEqual(['unmerged'])
  })

  it('dubious ownership blocks with the copyable safe.directory command', async () => {
    const { dir, repo } = await repoWithHistory('dubious')
    const { blockers } = await branchBlockers({ ...repo, dubiousOwnership: true }, { os: 'linux' })
    expect(blockers).toEqual([
      expect.objectContaining({
        kind: 'dubious-ownership',
        commands: [
          {
            command: `git config --global --add safe.directory "${(repo.toplevel ?? dir).replace(/\\/g, '/')}"`,
            shell: 'sh',
          },
        ],
      }),
    ])
  })

  it('index.lock blocks only when it persists for the wait (3 s by default)', async () => {
    const { dir, repo } = await repoWithHistory('lock')
    const lock = join(dir, '.git', 'index.lock')
    writeFileSync(lock, '')
    const t0 = Date.now()
    const held = await createRunBranch(repo, NAME)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900)
    expect(held).toMatchObject({ ok: false, blockers: [{ kind: 'index-lock' }] })
    // A lock that goes away within the wait does not block.
    setTimeout(() => rmSync(lock, { force: true }), 300)
    const ok = await createRunBranch(repo, NAME, { lockWaitMs: 10_000 })
    expect(ok.ok).toBe(true)
  })

  it('retries a held *.lock (3 attempts, 500 ms apart) and rolls the ref back when it never frees', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('reflock')
    const headLock = join(dir, '.git', 'HEAD.lock')
    writeFileSync(headLock, '')
    const t0 = Date.now()
    const r = await createRunBranch(repo, NAME)
    expect(r).toMatchObject({ ok: false, blockers: [{ kind: 'ref-locked' }] })
    // Three attempts: at least the two 500 ms pauses between them.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000)
    expect(tip(dir, `refs/heads/${NAME}`)).toBeNull()
    expect(headFile(dir).trim()).toBe(`ref: ${mainRef}`)

    // Freed between attempts: the run branch is made. The ref appears just before HEAD's first try.
    const refFile = join(dir, '.git', 'refs', 'heads', ...NAME.split('/'))
    const pending = createRunBranch(repo, NAME, { retry: { delayMs: 4000 } })
    await waitFor(() => existsSync(refFile))
    const appearedAt = Date.now()
    await new Promise((res) => setTimeout(res, 2500))
    rmSync(headLock)
    const done = await pending
    expect(done.ok).toBe(true)
    expect(Date.now() - appearedAt).toBeGreaterThanOrEqual(4000)
    expect(headFile(dir).trim()).toBe(`ref: refs/heads/${NAME}`)
  })

  it('return: only while HEAD is the run branch and <prev> still points at HEAD; otherwise copyable commands', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('return')
    const made = await createRunBranch(repo, NAME, { os: 'linux' })
    if (!made.ok) throw new Error('create failed')
    const branch = made.branch
    const main = mainRef.replace('refs/heads/', '')
    // The user switched away: Dim Factory leaves HEAD alone.
    git(dir, ['checkout', '-q', main])
    expect(await returnToPrevious(repo, branch, { os: 'linux' })).toMatchObject({ done: false, commands: [] })
    // Back on the run branch with a new commit: <prev> no longer points at HEAD.
    git(dir, ['checkout', '-q', NAME])
    write(dir, 'src/app.ts', 'export const v = 3\n')
    git(dir, ['commit', '-q', '-am', 'on the run branch'])
    expect(await returnToPrevious(repo, branch, { os: 'linux' })).toMatchObject({
      done: false,
      commands: [`git checkout ${main}`],
    })
    git(dir, ['reset', '-q', '--hard', branch.base])
    // <prev> deleted: nothing to return to.
    git(dir, ['branch', '-m', main, 'renamed'])
    expect(await returnToPrevious(repo, branch, { os: 'linux' })).toMatchObject({
      done: false,
      reason: `${main} no longer exists.`,
    })
    git(dir, ['branch', '-m', 'renamed', main])
    // The happy path: symbolic-ref back, files and index untouched.
    write(dir, 'dirty.txt', 'dirty\n')
    const files = workTreeHashes(dir)
    const index = dotGitFingerprint(dir, ownedByRunBranch())
    expect(await returnToPrevious(repo, branch)).toEqual({ done: true, commands: [] })
    expect(headFile(dir).trim()).toBe(`ref: ${mainRef}`)
    expect(workTreeHashes(dir)).toEqual(files)
    expect(dotGitFingerprint(dir, ownedByRunBranch())).toEqual(index)
    expect((await readHead(dir)).ref).toBe(mainRef)
  })

  it('delete: only when not checked out (any worktree) and the tip still equals base', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('delete')
    const made = await createRunBranch(repo, NAME, { os: 'linux' })
    if (!made.ok) throw new Error('create failed')
    const branch = made.branch
    const main = mainRef.replace('refs/heads/', '')
    expect(await deleteRunBranch(repo, branch, { os: 'linux' })).toMatchObject({
      done: false,
      commands: [`git checkout ${main}`, `git branch -d ${NAME}`],
    })
    // New commits on the run branch: kept.
    write(dir, 'src/app.ts', 'export const v = 4\n')
    git(dir, ['commit', '-q', '-am', 'user commit on the run branch'])
    git(dir, ['checkout', '-q', main])
    expect(await deleteRunBranch(repo, branch, { os: 'linux' })).toMatchObject({
      done: false,
      commands: [`git branch -d ${NAME}`],
    })
    git(dir, ['update-ref', `refs/heads/${NAME}`, branch.base])
    // Checked out in a linked worktree: kept.
    const wt = join(tempDir('wt'), 'linked')
    git(dir, ['worktree', 'add', wt, NAME])
    expect(await deleteRunBranch(repo, branch)).toMatchObject({ done: false, commands: [] })
    git(dir, ['worktree', 'remove', '--force', wt])
    git(dir, ['worktree', 'prune'])
    // Not checked out, tip = base: deleted (old-value guarded); deleting again is a no-op.
    expect(await deleteRunBranch(repo, branch)).toEqual({ done: true, commands: [] })
    expect(tip(dir, `refs/heads/${NAME}`)).toBeNull()
    expect(await deleteRunBranch(repo, branch)).toMatchObject({ done: true })
  })

  it('create → return → delete changes nothing in .git but HEAD, its reflog and the run branch refs', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('cycle')
    write(dir, 'src/app.ts', 'export const v = "dirty"\n')
    write(dir, 'new.txt', 'new\n')
    const head = headFile(dir)
    const before = dotGitFingerprint(dir, ownedByRunBranch())
    const files = workTreeHashes(dir)
    const made = await createRunBranch(repo, NAME)
    if (!made.ok) throw new Error('create failed')
    expect(await returnToPrevious(repo, made.branch)).toMatchObject({ done: true })
    expect(await deleteRunBranch(repo, made.branch)).toMatchObject({ done: true })
    expect(headFile(dir)).toBe(head)
    expect(dotGitFingerprint(dir, ownedByRunBranch())).toEqual(before)
    expect(workTreeHashes(dir)).toEqual(files)
    expect(tip(dir, mainRef)).toBe(made.branch.base)
    expect(existsSync(join(dir, '.git', 'refs', 'heads', ...NAME.split('/')))).toBe(false)
  })
})
