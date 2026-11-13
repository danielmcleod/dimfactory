// Worktree lifecycle against real git (eligibility, Prepare step 1, Cleanup; the user's index, refs and objects are
// never written): a dirty user repo keeps its index, HEAD and refs byte-identical; hooks off; lock retry; removal never
// reaches through a link. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveScope } from '../../../../src/core/git/repo.ts'
import {
  DISK_MARGIN_BYTES,
  LONG_PATH_LIMIT,
  WorktreeError,
  checkEligibility,
  createWorktree,
  openWorktreeShadow,
  removeWorktree,
  uncommittedCount,
  uncommittedPaths,
  worktreeKeys,
} from '../../../../src/core/git/worktree.ts'
import { homePaths } from '../../../../src/core/home.ts'
import { TEST_GIT, cleanupTemps, git, initRepo, tempDir, testGitVersion, write } from '../../git/helpers.ts'
import { testRunId } from './fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] worktree suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

/** Every file under `.git/refs` plus packed-refs, HEAD and the index, as bytes (relative path → hex). */
function repoState(repo: string): Record<string, string> {
  const gitDir = join(repo, '.git')
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(gitDir, p).replace(/\\/g, '/')] = readFileSync(p).toString('hex')
    }
  }
  walk(join(gitDir, 'refs'))
  for (const f of ['packed-refs', 'HEAD', 'index']) {
    const p = join(gitDir, f)
    if (existsSync(p)) out[f] = readFileSync(p).toString('hex')
  }
  return out
}

function dirtyRepo(): string {
  const repo = tempDir('wt-repo')
  initRepo(repo)
  write(repo, 'tracked.txt', 't1\n')
  write(repo, 'staged.txt', 's1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'two files'])
  git(repo, ['branch', 'feature'])
  // Dirty: a modified file, a staged change, a deleted file, an untracked file.
  write(repo, 'tracked.txt', 't2-uncommitted\n')
  write(repo, 'staged.txt', 's2-staged\n')
  git(repo, ['add', 'staged.txt'])
  rmSync(join(repo, 'README.md'))
  write(repo, 'untracked.txt', 'u\n')
  return repo
}

describe(`create and remove on a dirty user repo (${version.raw})`, () => {
  it("leaves the user's index, HEAD and refs byte-identical, then removes the worktree, its branch and its shadow", async () => {
    const repo = dirtyRepo()
    const home = tempDir('wt-home')
    const before = repoState(repo)
    const files = {
      tracked: readFileSync(join(repo, 'tracked.txt')),
      staged: readFileSync(join(repo, 'staged.txt')),
    }
    const runId = testRunId()
    const keys = await worktreeKeys(home, runId)
    const branch = 'dim/20261009-dirty'
    let intent: unknown
    const wt = await createWorktree({
      home,
      runId,
      folder: repo,
      branch,
      onIntent: async (w) => {
        intent = w
        // Write-ahead: nothing exists yet.
        expect(existsSync(w.path)).toBe(false)
        await Promise.resolve()
      },
    })
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    expect(intent).toMatchObject({ path: wt.path, branch, base: head })
    expect(wt).toMatchObject({ path: homePaths(home).worktree(runId), branch, base: head })
    // The keys computed before the worktree existed are its keys now.
    expect(wt.folderKey).toBe(keys.folderKey)
    expect((await resolveScope(wt.path)).lockKey).toBe(keys.lockKey)
    // The worktree is a clean checkout of HEAD: uncommitted work is not in it.
    expect(readFileSync(join(wt.path, 'tracked.txt'), 'utf8')).toBe('t1\n')
    expect(readFileSync(join(wt.path, 'staged.txt'), 'utf8')).toBe('s1\n')
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true)
    expect(existsSync(join(wt.path, 'untracked.txt'))).toBe(false)
    expect(git(wt.path, ['symbolic-ref', 'HEAD']).trim()).toBe(`refs/heads/${branch}`)

    const during = repoState(repo)
    const added = Object.keys(during).filter((k) => !(k in before))
    expect(added).toEqual([`refs/heads/${branch}`])
    for (const [k, v] of Object.entries(before)) expect(during[k], k).toBe(v)
    expect(readFileSync(join(repo, 'tracked.txt')).equals(files.tracked)).toBe(true)
    expect(readFileSync(join(repo, 'staged.txt')).equals(files.staged)).toBe(true)

    // A shadow for the worktree, so removal has one to drop.
    await (await openWorktreeShadow(home, wt.path)).snapshot(runId, 'S0')
    const shadowDir = join(homePaths(home).shadowDir, wt.folderKey)
    expect(existsSync(shadowDir)).toBe(true)

    const r = await removeWorktree({ home, worktree: wt })
    expect(r).toMatchObject({ removed: true, branchDeleted: true, shadowDropped: true, notes: [] })
    expect(existsSync(wt.path)).toBe(false)
    expect(existsSync(shadowDir)).toBe(false)
    expect(repoState(repo)).toEqual(before)
    const worktrees = join(repo, '.git', 'worktrees')
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([])
    expect(readFileSync(join(repo, 'tracked.txt')).equals(files.tracked)).toBe(true)
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true)
    // Removing again is a no-op.
    const again = await removeWorktree({ home, worktree: wt })
    expect(again).toMatchObject({ removed: true, branchDeleted: true })
  })

  it('runs no user hook (core.hooksPath points at an empty folder)', async () => {
    const repo = tempDir('wt-hooks')
    initRepo(repo)
    const hooks = join(repo, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const marker = join(repo, 'hook-ran.txt')
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, {
      mode: 0o755,
    })
    // Is the hook live with this git? A plain `git worktree add` runs it (MinGit has no shell to run one).
    git(repo, ['worktree', 'add', '-b', 'plain', join(tempDir('wt-hooks-plain'), 'wt'), 'HEAD'])
    const live = existsSync(marker)
    // The git on PATH (a full install) runs it; only a minimal CI git may not.
    if (TEST_GIT === 'git') expect(live).toBe(true)
    else if (!live) console.info(`[git-compat] post-checkout hooks do not run with ${version.raw}`)
    rmSync(marker, { force: true })
    const home = tempDir('wt-hooks-home')
    const wt = await createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/hooks' })
    expect(existsSync(marker)).toBe(false)
    await removeWorktree({ home, worktree: wt })
    expect(existsSync(marker)).toBe(false)
  })

  it('adopts its own worktree on a second create (Resume), and refuses a taken branch or a foreign path', async () => {
    const repo = tempDir('wt-adopt')
    initRepo(repo)
    const home = tempDir('wt-adopt-home')
    const runId = testRunId()
    const wt = await createWorktree({ home, runId, folder: repo, branch: 'dim/adopt' })
    const again = await createWorktree({ home, runId, folder: repo, branch: 'dim/adopt' })
    expect(again).toEqual(wt)
    await expect(
      createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/adopt' }),
    ).rejects.toMatchObject({ kind: 'branch-exists', category: 'worktree_failed' })
    const foreign = testRunId()
    mkdirSync(homePaths(home).worktree(foreign), { recursive: true })
    await expect(
      createWorktree({ home, runId: foreign, folder: repo, branch: 'dim/foreign' }),
    ).rejects.toMatchObject({ kind: 'path-exists' })
    // A refused create made no branch.
    expect(git(repo, ['branch', '--list', 'dim/foreign']).trim()).toBe('')
  })

  it('uses the branch a crash inside worktree add left (at HEAD, in no worktree); a branch elsewhere is taken', async () => {
    const repo = tempDir('wt-leftover')
    initRepo(repo)
    const home = tempDir('wt-leftover-home')
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['branch', 'dim/leftover'])
    const wt = await createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/leftover' })
    expect(wt.base).toBe(head)
    expect(git(wt.path, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/dim/leftover')
    // A branch of that name with other commits is not the run's.
    write(repo, 'more.txt', 'm\n')
    git(repo, ['add', 'more.txt'])
    git(repo, ['commit', '-q', '-m', 'more'])
    git(repo, ['branch', 'dim/elsewhere', head])
    await expect(
      createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/elsewhere' }),
    ).rejects.toMatchObject({ kind: 'branch-exists' })
    expect(git(repo, ['rev-parse', 'dim/elsewhere']).trim()).toBe(head)
  })

  it('retries while another git process holds a ref lock, and reports a lock that persists', async () => {
    const repo = tempDir('wt-lock')
    initRepo(repo)
    const home = tempDir('wt-lock-home')
    const lock = join(repo, '.git', 'refs', 'heads', 'dim', 'locked.lock')
    mkdirSync(join(repo, '.git', 'refs', 'heads', 'dim'), { recursive: true })
    writeFileSync(lock, '')
    const release = delay(700).then(() => rmSync(lock, { force: true }))
    const wt = await createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/locked' })
    await release
    expect(existsSync(wt.path)).toBe(true)

    const lock2 = join(repo, '.git', 'refs', 'heads', 'dim', 'stuck.lock')
    writeFileSync(lock2, '')
    const runId = testRunId()
    let caught: unknown
    try {
      await createWorktree({ home, runId, folder: repo, branch: 'dim/stuck', retry: { delayMs: 100 } })
    } catch (err) {
      caught = err
    }
    rmSync(lock2, { force: true })
    expect(caught).toBeInstanceOf(WorktreeError)
    expect(caught).toMatchObject({ kind: 'locked', category: 'git_state' })
    // Each failed attempt cleaned up after itself.
    expect(existsSync(homePaths(home).worktree(runId))).toBe(false)
    expect(git(repo, ['branch', '--list', 'dim/stuck']).trim()).toBe('')
  })
})

describe(`removal (${version.raw})`, () => {
  it('never reaches through a link (a junction on Windows) inside the worktree', async () => {
    const repo = tempDir('rm-link')
    initRepo(repo)
    const home = tempDir('rm-link-home')
    const wt = await createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/links' })
    const outside = tempDir('rm-outside')
    write(outside, 'precious.txt', 'keep me\n')
    write(outside, 'nested/also.txt', 'keep me too\n')
    mkdirSync(join(wt.path, 'node_modules'), { recursive: true })
    symlinkSync(outside, join(wt.path, 'node_modules', 'linked'), 'junction')
    symlinkSync(outside, join(wt.path, 'top-link'), 'junction')
    const r = await removeWorktree({ home, worktree: wt })
    expect(r.removed).toBe(true)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me\n')
    expect(readFileSync(join(outside, 'nested', 'also.txt'), 'utf8')).toBe('keep me too\n')
  })

  it('keeps a branch the run committed on, with the command to delete it', async () => {
    const repo = tempDir('rm-commits')
    initRepo(repo)
    const home = tempDir('rm-commits-home')
    const wt = await createWorktree({ home, runId: testRunId(), folder: repo, branch: 'dim/committed' })
    write(wt.path, 'work.txt', 'w\n')
    git(wt.path, ['add', 'work.txt'])
    git(wt.path, ['commit', '-q', '-m', 'agent commit'])
    const r = await removeWorktree({ home, worktree: wt })
    expect(r.removed).toBe(true)
    expect(r.branchDeleted).toBe(false)
    expect(r.notes.join(' ')).toContain('dim/committed')
    expect(r.commands.map((c) => c.command)).toContain('git branch -d dim/committed')
    expect(git(repo, ['branch', '--list', 'dim/committed']).trim()).not.toBe('')
  })

  it('a worktree folder deleted by hand: its branch, its registration and its shadow still go', async () => {
    const repo = tempDir('rm-gone')
    initRepo(repo)
    const home = tempDir('rm-gone-home')
    const runId = testRunId()
    const wt = await createWorktree({ home, runId, folder: repo, branch: 'dim/gone' })
    await (await openWorktreeShadow(home, wt.path)).snapshot(runId, 'S0')
    rmSync(wt.path, { recursive: true, force: true })
    // The engine's record has no commonDir or folder key: they come from the user's folder and the run id.
    const r = await removeWorktree({
      home,
      worktree: { path: wt.path, branch: wt.branch, base: wt.base, folder: repo },
    })
    expect(r).toMatchObject({ removed: true, branchDeleted: true, shadowDropped: true })
    expect(git(repo, ['branch', '--list', 'dim/gone']).trim()).toBe('')
    const worktrees = join(repo, '.git', 'worktrees')
    expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([])
    expect(existsSync(join(homePaths(home).shadowDir, wt.folderKey))).toBe(false)
  })

  it('refuses a path outside <home>/worktrees', async () => {
    const home = tempDir('rm-outside-home')
    const elsewhere = tempDir('rm-elsewhere')
    await expect(
      removeWorktree({ home, worktree: { path: elsewhere, branch: 'x', base: '0'.repeat(40) } }),
    ).rejects.toMatchObject({ kind: 'outside-home' })
    expect(existsSync(elsewhere)).toBe(true)
  })
})

describe(`eligibility (${version.raw})`, () => {
  it('a folder that is not a repository, and a repository without a commit, are not eligible', async () => {
    const plain = tempDir('el-plain')
    const r1 = await checkEligibility(plain, { home: tempDir('el-home') })
    expect(r1.ok).toBe(false)
    expect(r1.blockers.map((b) => b.kind)).toEqual(['not-repo'])
    expect(r1.reasons[0]).toContain('Not a git repository')
    const empty = tempDir('el-empty')
    git(empty, ['init', '-q'])
    const r2 = await checkEligibility(empty, { home: tempDir('el-home') })
    expect(r2.blockers.map((b) => b.kind)).toEqual(['no-commit'])
  })

  it('needs 1.2 x the HEAD tree + 500 MB free on the worktrees volume', async () => {
    const repo = tempDir('el-disk')
    initRepo(repo)
    write(repo, 'big.bin', Buffer.alloc(100_000, 1))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'big'])
    const home = tempDir('el-disk-home')
    const ok = await checkEligibility(repo, { home, freeBytes: () => Promise.resolve(10 * 1024 ** 3) })
    expect(ok.ok).toBe(true)
    expect(ok.treeBytes).toBe(100_000 + '# test\n'.length)
    expect(ok.neededBytes).toBe(Math.ceil(1.2 * (100_000 + 7) + DISK_MARGIN_BYTES))
    const tight = await checkEligibility(repo, {
      home,
      freeBytes: () => Promise.resolve(DISK_MARGIN_BYTES + 100_000),
    })
    expect(tight.ok).toBe(false)
    expect(tight.blockers.map((b) => b.kind)).toEqual(['disk-space'])
    // Unknown free space never blocks.
    const unknown = await checkEligibility(repo, { home, freeBytes: () => Promise.resolve(null) })
    expect(unknown.ok).toBe(true)
  })

  it('win32: warns when a path would pass 240 characters while core.longpaths is off, with the command', async () => {
    const repo = tempDir('el-long')
    initRepo(repo)
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}/file.txt`
    write(repo, deep, 'x\n')
    // The fixture itself needs long paths to be committed on Windows.
    git(repo, ['-c', 'core.longpaths=true', 'add', '-A'])
    git(repo, ['-c', 'core.longpaths=true', 'commit', '-q', '-m', 'deep'])
    const home = tempDir('el-long-home')
    git(repo, ['config', 'core.longpaths', 'false'])
    const r = await checkEligibility(repo, {
      home,
      platform: 'win32',
      freeBytes: () => Promise.resolve(null),
    })
    expect(r.ok).toBe(true)
    expect(r.longPathWarning?.limit).toBe(LONG_PATH_LIMIT)
    expect(r.longPathWarning?.longest).toBeGreaterThan(LONG_PATH_LIMIT)
    expect(r.longPathWarning?.command.command).toBe('git config --global core.longpaths true')
    expect(r.longPathWarning?.detail).not.toMatch(/—/)
    git(repo, ['config', 'core.longpaths', 'true'])
    const on = await checkEligibility(repo, {
      home,
      platform: 'win32',
      freeBytes: () => Promise.resolve(null),
    })
    expect(on.longPathWarning).toBeUndefined()
    // Other platforms never warn.
    git(repo, ['config', 'core.longpaths', 'false'])
    const linux = await checkEligibility(repo, {
      home,
      platform: 'linux',
      freeBytes: () => Promise.resolve(null),
    })
    expect(linux.longPathWarning).toBeUndefined()
  })
})

describe(`uncommitted changes the worktree leaves out (${version.raw})`, () => {
  it('counts staged, modified, deleted and untracked files; not a touched file or an ignored one; writes nothing', async () => {
    const repo = tempDir('unc')
    initRepo(repo)
    write(repo, '.gitignore', 'ignored.log\n')
    write(repo, 'a.txt', 'a\n')
    write(repo, 'touched.txt', 'same\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'files'])
    expect(await uncommittedCount(repo)).toBe(0)
    write(repo, 'a.txt', 'a2\n')
    write(repo, 'new-staged.txt', 'n\n')
    git(repo, ['add', 'new-staged.txt'])
    rmSync(join(repo, 'README.md'))
    write(repo, 'untracked.txt', 'u\n')
    write(repo, 'ignored.log', 'log\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(join(repo, 'touched.txt'), later, later)
    const index = readFileSync(join(repo, '.git', 'index'))
    expect(await uncommittedPaths(repo)).toEqual(['README.md', 'a.txt', 'new-staged.txt', 'untracked.txt'])
    expect(await uncommittedCount(repo)).toBe(4)
    expect(readFileSync(join(repo, '.git', 'index')).equals(index)).toBe(true)
    expect(await uncommittedCount(tempDir('unc-plain'))).toBe(0)
  })
})
