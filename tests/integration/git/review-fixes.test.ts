// Review fixes against real git (revert to S0, branch prep): Revert all
// over explicit snapshot ends after an undo; an undo refused while a reverted path changed since; files git could not
// read for the undo point are never written or deleted; a write whose folder is a file now is skipped (not silently
// deleted); restored versus skipped decided on disk, not by stderr substrings; symbolic links reverted as links (or
// skipped); the write-ahead callback; a run branch rollback that cannot delete its ref names it and a Recheck adopts
// it; a pending branch settled. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRunBranch,
  prepareRunBranch,
  readHead,
  settlePendingBranch,
} from '../../../src/core/git/branch.ts'
import { detectRepo } from '../../../src/core/git/repo.ts'
import type { RepoInfo } from '../../../src/core/git/repo.ts'
import { NO_SYMLINKS_REASON, UNREADABLE_REASON, revertTo, undoRevert } from '../../../src/core/git/revert.ts'
import { openShadow } from '../../../src/core/git/shadow.ts'
import type { Shadow } from '../../../src/core/git/shadow.ts'
import { revertPaths } from '../../../src/core/supervisor/git-effects.ts'
import {
  TEST_GIT,
  cleanupTemps,
  git,
  initRepo,
  isWin,
  shadowGit,
  tempDir,
  testGitVersion,
  write,
} from './helpers.ts'
import { dotGitFingerprint, waitFor } from './fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] review-fixes suite: ${version.raw} (${TEST_GIT})`)

const RUN = '20261008T120000Z-rvfx'
const DATE = new Date(2026, 9, 8, 12, 0, 0)
const NAME = 'dim/20261008-add-a-version-flag'
const TASK = 'Add a --version flag'

/** Can this process make symbolic links in the temp folder (win32: developer mode)? */
function canSymlinkHere(): boolean {
  const dir = tempDir('symlink-probe')
  try {
    symlinkSync('target', join(dir, 'probe'), 'file')
    return true
  } catch {
    return false
  }
}
const SYMLINKS = canSymlinkHere()
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c()
    } catch {
      // best effort: the temp folder goes next
    }
  }
  cleanupTemps()
})

const text = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')

async function shadowOf(
  prefix: string,
  files: Record<string, string>,
): Promise<{ dir: string; shadow: Shadow }> {
  const dir = tempDir(prefix)
  initRepo(dir)
  for (const [rel, data] of Object.entries(files)) write(dir, rel, data)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  return { dir, shadow: await openShadow(dir, { home: tempDir(`${prefix}-home`) }) }
}

/**
 * Hold `abs` open sharing reads only (win32): git can still read it (the undo point has its bytes) but nothing can
 * delete or write it, until the returned stop().
 */
async function holdAgainstWrites(abs: string): Promise<() => void> {
  const script = `$f=[System.IO.File]::Open('${abs.replace(/'/g, "''")}','Open','Read','Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Seconds 300`
  const child: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
  await waitFor(() => out.includes('held') || child.exitCode !== null, 60_000)
  if (!out.includes('held')) throw new Error('could not hold the file')
  const stop = (): void => {
    if (child.pid !== undefined && child.exitCode === null) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    }
  }
  cleanups.push(stop)
  return stop
}

describe(`Revert all over explicit ends, after an undo (${version.raw})`, () => {
  it('a second Revert all reverts the run’s file again and keeps the user’s later file', async () => {
    const { dir, shadow } = await shadowOf('again', { 'a.txt': 'S0 a\n' })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'a.txt', 'run a\n')
    const s2 = await shadow.snapshot(RUN, 'S2')
    write(dir, 'U.txt', 'U v1\n') // the user's own file, after the run
    const scope = { scope: { from: s0.commit, to: s2.commit } }
    const one = await revertTo(shadow, s0.commit, {
      runId: RUN,
      ...pathsOf(await revertPaths(shadow, scope)),
    })
    if (!one.ok) throw new Error('refused')
    expect(one.outcome.restored).toEqual(['a.txt'])
    const undo = await undoRevert(shadow, one.outcome, { runId: RUN })
    if (!undo.ok) throw new Error(`undo refused: ${JSON.stringify(undo)}`)
    expect(text(dir, 'a.txt')).toBe('run a\n')
    // The shadow's latest ref is now a pre-revert; the range ends stay S0..S2.
    expect(shadowGit(shadow.gitDir, ['log', '-1', '--format=%s', `refs/dimfactory/runs/${RUN}`])).toMatch(
      /pre-revert/,
    )
    const two = await revertTo(shadow, s0.commit, {
      runId: RUN,
      ...pathsOf(await revertPaths(shadow, scope)),
    })
    if (!two.ok) throw new Error('refused')
    expect(two.outcome.restored).toEqual(['a.txt'])
    expect(two.outcome.deleted).toEqual([])
    expect(text(dir, 'a.txt')).toBe('S0 a\n')
    expect(text(dir, 'U.txt')).toBe('U v1\n')
  })
})

const pathsOf = (p: string[] | undefined): { paths?: string[] } => (p !== undefined ? { paths: p } : {})

describe(`undo checks what the revert wrote (${version.raw})`, () => {
  it('refuses (conflict, nothing written) while a reverted path changed since; applies once it is back', async () => {
    const { dir, shadow } = await shadowOf('undo-conflict', { 'a.txt': 'S0 a\n', 'b.txt': 'S0 b\n' })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'a.txt', 'run a\n')
    write(dir, 'b.txt', 'run b\n')
    write(dir, 'new.txt', 'run new\n')
    await shadow.snapshot(RUN, 'S1')
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    expect([...r.outcome.restored, ...r.outcome.deleted].sort()).toEqual(['a.txt', 'b.txt', 'new.txt'])
    // A later pass (or the user) writes a.txt and recreates new.txt.
    write(dir, 'a.txt', 'later work\n')
    write(dir, 'new.txt', 'user new\n')
    const refused = await undoRevert(shadow, r.outcome, { runId: RUN })
    expect(refused).toMatchObject({ ok: false, refused: 'conflict', paths: ['a.txt', 'new.txt'] })
    if (refused.ok) return
    expect(refused.message).toBe(
      '2 files changed after the revert (a.txt, new.txt), so undoing it would overwrite that work. Nothing was undone.',
    )
    expect(refused.message).not.toContain('—')
    expect(text(dir, 'a.txt')).toBe('later work\n')
    expect(text(dir, 'b.txt')).toBe('S0 b\n')
    expect(text(dir, 'new.txt')).toBe('user new\n')
    // Back to what the revert left: the undo goes through.
    write(dir, 'a.txt', 'S0 a\n')
    rmSync(join(dir, 'new.txt'))
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    if (!u.ok) throw new Error('undo refused')
    expect(text(dir, 'a.txt')).toBe('run a\n')
    expect(text(dir, 'b.txt')).toBe('run b\n')
    expect(text(dir, 'new.txt')).toBe('run new\n')
  })

  it('a path partly reverted (an interrupted revert) or untouched since counts as unchanged', async () => {
    const { dir, shadow } = await shadowOf('undo-partial', { 'a.txt': 'S0 a\n', 'b.txt': 'S0 b\n' })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'a.txt', 'run a\n')
    write(dir, 'b.txt', 'run b\n')
    await shadow.snapshot(RUN, 'S1')
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    // As if the revert had stopped after a.txt: b.txt still holds the pre-revert bytes.
    write(dir, 'b.txt', 'run b\n')
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    if (!u.ok) throw new Error(`undo refused: ${JSON.stringify(u)}`)
    expect(u.outcome.restored).toEqual(['a.txt'])
    expect(text(dir, 'a.txt')).toBe('run a\n')
    expect(text(dir, 'b.txt')).toBe('run b\n')
  })
})

describe(`files the undo point could not read are left alone (${version.raw})`, () => {
  it.skipIf(isRoot)('neither overwritten nor deleted; reported skipped with the reason', async () => {
    const { dir, shadow } = await shadowOf('unreadable', {
      'secret.txt': 'S0\n',
      'secret-dir/inner.txt': 'S0 inner\n',
      'plain.txt': 'S0 plain\n',
    })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'secret.txt', 'run wrote S1\n')
    write(dir, 'plain.txt', 'run plain\n')
    write(dir, 'secret-dir/inner.txt', 'run inner\n')
    await shadow.snapshot(RUN, 'S1')
    write(dir, 'secret.txt', 'USER CURRENT CONTENT\n')
    const secret = join(dir, 'secret.txt')
    if (isWin) {
      const who = spawnSync('whoami', [], { encoding: 'utf8', windowsHide: true }).stdout.trim()
      const deny = spawnSync('icacls', [secret, '/deny', `${who}:(RD)`], {
        encoding: 'utf8',
        windowsHide: true,
      })
      expect(deny.status, deny.stdout + deny.stderr).toBe(0)
      cleanups.push(() => spawnSync('icacls', [secret, '/remove:d', who], { windowsHide: true }))
    } else {
      chmodSync(secret, 0o000)
      cleanups.push(() => chmodSync(secret, 0o644))
    }
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.preRevert.unreadable).toEqual(['secret.txt'])
    expect(r.outcome.skipped).toEqual([{ path: 'secret.txt', reason: UNREADABLE_REASON }])
    expect(r.outcome.restored).toEqual(['plain.txt', 'secret-dir/inner.txt'])
    for (const c of cleanups.splice(0)) c()
    expect(text(dir, 'secret.txt')).toBe('USER CURRENT CONTENT\n')
    expect(text(dir, 'plain.txt')).toBe('S0 plain\n')
    // The undo leaves it alone too (it was never written).
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    if (!u.ok) throw new Error('undo refused')
    expect(text(dir, 'secret.txt')).toBe('USER CURRENT CONTENT\n')
    expect(text(dir, 'plain.txt')).toBe('run plain\n')
  })
})

describe(`a file where a written path needs its folder (${version.raw})`, () => {
  it('is never removed: the write is skipped with the reason, and the undo has nothing to lose', async () => {
    const { dir, shadow } = await shadowOf('parent-file', { 'keep.txt': 'k\n' })
    await shadow.snapshot(RUN, 'S0')
    write(dir, 'd/a.txt', 'run made d/a.txt\n')
    write(dir, 'x/y/z.txt', 'run made x/y/z.txt\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    // At the gate the user replaces the folder d/ with a file d, and x/y/ with a file x/y.
    rmSync(join(dir, 'd'), { recursive: true })
    write(dir, 'd', 'USER NOTES - precious\n')
    rmSync(join(dir, 'x', 'y'), { recursive: true })
    write(dir, 'x/y', 'more user notes\n')
    // Restore run's version for the paths the run made (the files in the way are not selected).
    const r = await revertTo(shadow, s1.commit, { runId: RUN, paths: ['d/a.txt', 'x/y/z.txt'] })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.restored).toEqual([])
    expect(r.outcome.deleted).toEqual([])
    expect(r.outcome.skipped).toEqual([
      { path: 'd/a.txt', reason: 'a file is in the place of its folder d' },
      { path: 'x/y/z.txt', reason: 'a file is in the place of its folder x/y' },
    ])
    expect(lstatSync(join(dir, 'd')).isFile()).toBe(true)
    expect(text(dir, 'd')).toBe('USER NOTES - precious\n')
    expect(text(dir, 'x/y')).toBe('more user notes\n')
  })

  it('a selected file in the way is deleted first (recorded, so its undo brings it back)', async () => {
    const { dir, shadow } = await shadowOf('parent-selected', { 'keep.txt': 'k\n' })
    await shadow.snapshot(RUN, 'S0')
    write(dir, 'd/a.txt', 'run made d/a.txt\n')
    const s1 = await shadow.snapshot(RUN, 'S1')
    rmSync(join(dir, 'd'), { recursive: true })
    write(dir, 'd', 'USER NOTES\n')
    const r = await revertTo(shadow, s1.commit, { runId: RUN, paths: ['d', 'd/a.txt'] })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.deleted).toEqual(['d'])
    expect(r.outcome.restored).toEqual(['d/a.txt'])
    expect(text(dir, 'd/a.txt')).toBe('run made d/a.txt\n')
    const u = await undoRevert(shadow, r.outcome, { runId: RUN })
    if (!u.ok) throw new Error('undo refused')
    expect(text(dir, 'd')).toBe('USER NOTES\n')
  })
})

describe(`restored versus skipped is checked on disk (${version.raw})`, () => {
  it.skipIf(isRoot)(
    'a path whose name is inside another’s error line is restored; the one git could not write is skipped',
    async () => {
      // `a.txt` is a substring of `ba.txt` / `ro/ba.txt`, whose write fails.
      const blocked = isWin ? 'ba.txt' : 'ro/ba.txt'
      const { dir, shadow } = await shadowOf('verify', {
        'a.txt': 'S0 a\n',
        [blocked]: 'S0 ba\n',
        'z.txt': 'S0 z\n',
      })
      const s0 = await shadow.snapshot(RUN, 'S0')
      write(dir, 'a.txt', 'run a\n')
      write(dir, blocked, 'run ba\n')
      write(dir, 'z.txt', 'run z\n')
      await shadow.snapshot(RUN, 'S1')
      if (isWin) {
        await holdAgainstWrites(join(dir, blocked))
      } else {
        chmodSync(join(dir, 'ro'), 0o555)
        cleanups.push(() => chmodSync(join(dir, 'ro'), 0o755))
      }
      const r = await revertTo(shadow, s0.commit, { runId: RUN })
      if (!r.ok) throw new Error('refused')
      for (const c of cleanups.splice(0)) c()
      expect(r.outcome.restored).toEqual(['a.txt', 'z.txt'])
      expect(r.outcome.skipped.map((x) => x.path)).toEqual([blocked])
      expect(r.outcome.skipped[0]?.reason).toContain('ba.txt')
      expect(text(dir, 'a.txt')).toBe('S0 a\n')
      expect(text(dir, 'z.txt')).toBe('S0 z\n')
      expect(text(dir, blocked)).toBe('run ba\n')
    },
    120_000,
  )
})

describe(`symbolic links (${version.raw})`, () => {
  it('the shadow says whether links can be made, and its core.symlinks follows', async () => {
    const { shadow } = await shadowOf('symlinks-cfg', { 'a.txt': 'a\n' })
    expect(shadow.symlinks).toBe(SYMLINKS)
    expect(shadowGit(shadow.gitDir, ['config', '--get', 'core.symlinks']).trim()).toBe(String(SYMLINKS))
  })

  it.skipIf(!SYMLINKS)('a link the run deleted comes back as a link with its target', async () => {
    const { dir, shadow } = await shadowOf('symlink', { 'target.txt': 'the target\n' })
    symlinkSync('target.txt', join(dir, 'link-to-target'), 'file')
    const s0 = await shadow.snapshot(RUN, 'S0')
    rmSync(join(dir, 'link-to-target'))
    await shadow.snapshot(RUN, 'S1')
    const r = await revertTo(shadow, s0.commit, { runId: RUN })
    if (!r.ok) throw new Error('refused')
    expect(r.outcome.restored).toEqual(['link-to-target'])
    expect(lstatSync(join(dir, 'link-to-target')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dir, 'link-to-target')).replace(/\\/g, '/')).toBe('target.txt')
    expect((await shadow.snapshot(RUN, 'resume')).tree).toBe(s0.tree)
  })

  it.skipIf(!SYMLINKS)(
    'where links cannot be made, a link is skipped, never written as a text file',
    async () => {
      const { dir, shadow } = await shadowOf('symlink-off', { 'target.txt': 'the target\n' })
      symlinkSync('target.txt', join(dir, 'link-to-target'), 'file')
      const s0 = await shadow.snapshot(RUN, 'S0')
      rmSync(join(dir, 'link-to-target'))
      await shadow.snapshot(RUN, 'S1')
      Object.defineProperty(shadow, 'symlinks', { value: false })
      const r = await revertTo(shadow, s0.commit, { runId: RUN })
      if (!r.ok) throw new Error('refused')
      expect(r.outcome.skipped).toEqual([{ path: 'link-to-target', reason: NO_SYMLINKS_REASON }])
      expect(existsSync(join(dir, 'link-to-target'))).toBe(false)
    },
  )
})

describe(`write-ahead (${version.raw})`, () => {
  it('onPlanned gets the undo point and the paths before any file is written; a throw writes nothing', async () => {
    const { dir, shadow } = await shadowOf('ahead', { 'a.txt': 'S0 a\n' })
    const s0 = await shadow.snapshot(RUN, 'S0')
    write(dir, 'a.txt', 'run a\n')
    write(dir, 'new.txt', 'run new\n')
    await shadow.snapshot(RUN, 'S1')
    const seen: { pre: string; paths: string[]; a: string; newExists: boolean }[] = []
    const r = await revertTo(shadow, s0.commit, {
      runId: RUN,
      onPlanned: async (p) => {
        seen.push({
          pre: p.preRevert.label,
          paths: p.paths,
          a: text(dir, 'a.txt'),
          newExists: existsSync(join(dir, 'new.txt')),
        })
        await Promise.resolve()
      },
    })
    if (!r.ok) throw new Error('refused')
    expect(seen).toEqual([{ pre: 'pre-revert', paths: ['a.txt', 'new.txt'], a: 'run a\n', newExists: true }])
    write(dir, 'a.txt', 'run a again\n')
    await expect(
      revertTo(shadow, s0.commit, {
        runId: RUN,
        onPlanned: () => Promise.reject(new Error('run.json write failed')),
      }),
    ).rejects.toThrow('run.json write failed')
    expect(text(dir, 'a.txt')).toBe('run a again\n')
  })
})

// ---- run branch --------------------------------------------------------------------------------------------------

async function repoWithHistory(prefix: string): Promise<{ dir: string; repo: RepoInfo; mainRef: string }> {
  const dir = tempDir(prefix)
  initRepo(dir)
  write(dir, 'src/app.ts', 'export const v = 1\n')
  git(dir, ['add', 'src/app.ts'])
  git(dir, ['commit', '-q', '-m', 'app'])
  const mainRef = git(dir, ['symbolic-ref', 'HEAD']).trim()
  return { dir, repo: await detectRepo(dir), mainRef }
}

const headFile = (dir: string): string => readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
const tip = (dir: string, ref: string): string | null => {
  const out = git(dir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true }).trim()
  return out === '' ? null : out
}

describe(`run branch write-ahead and rollback (${version.raw})`, () => {
  it('onIntent comes inside the lock before the ref exists', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('intent')
    const seen: { name: string; refExists: boolean; previous: string }[] = []
    const r = await createRunBranch(repo, NAME, {
      onIntent: async (b) => {
        seen.push({
          name: b.name,
          refExists: tip(dir, `refs/heads/${b.name}`) !== null,
          previous: b.previous,
        })
        await Promise.resolve()
      },
    })
    expect(r.ok).toBe(true)
    expect(seen).toEqual([{ name: NAME, refExists: false, previous: mainRef }])
  })

  it('a rollback that cannot delete the new ref names it (copyable command); Recheck adopts it, no -2', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('leftover')
    const gitDir = join(dir, '.git')
    const locks = [join(gitDir, 'HEAD.lock'), join(gitDir, 'packed-refs.lock')]
    for (const l of locks) writeFileSync(l, '')
    const refFile = join(gitDir, 'refs', 'heads', ...NAME.split('/'))
    // The ref's own lock once it exists, so its deletion fails on every git version.
    const pending = createRunBranch(repo, NAME, { os: 'linux', retry: { delayMs: 400 } })
    await waitFor(() => existsSync(refFile))
    writeFileSync(`${refFile}.lock`, '')
    locks.push(`${refFile}.lock`)
    const r = await pending
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.blockers.map((b) => b.kind)).toEqual(['ref-locked', 'ref-left'])
    expect(r.blockers[1]).toMatchObject({
      title: `The branch ${NAME} was left behind`,
      commands: [{ command: `git branch -d ${NAME}` }],
    })
    expect(r.blockers[1]?.detail).not.toContain('—')
    const base = tip(dir, mainRef)
    expect(r.leftover).toEqual({ name: NAME, base, previous: mainRef })
    expect(tip(dir, `refs/heads/${NAME}`)).toBe(base)
    expect(headFile(dir)).toBe(`ref: ${mainRef}`)
    for (const l of locks) rmSync(l, { force: true })
    if (r.leftover === undefined) throw new Error('no leftover')
    // Recheck: the pending branch is finished (HEAD pointed at it), not a new -2.
    const again = await prepareRunBranch(
      repo,
      { prefix: 'dim/', date: DATE, task: TASK },
      { pending: r.leftover },
    )
    expect(again).toMatchObject({ ok: true, branch: { name: NAME, base, previous: mainRef } })
    expect(headFile(dir)).toBe(`ref: refs/heads/${NAME}`)
    expect(tip(dir, `refs/heads/${NAME}-2`)).toBeNull()
  }, 60_000)

  it('settle: missing → gone; HEAD on it → adopted (no writes); HEAD where it started → finished or kept', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('settle')
    const base = tip(dir, mainRef) ?? ''
    const pending = { name: NAME, base, previous: mainRef }
    expect(await settlePendingBranch(repo, pending, { finish: true })).toEqual({ state: 'gone', notes: [] })
    git(dir, ['update-ref', `refs/heads/${NAME}`, base])
    // A crash between the two writes: the ref exists, HEAD is still on main.
    expect(await settlePendingBranch(repo, pending, { finish: false })).toEqual({
      state: 'kept',
      blockers: [],
    })
    expect(headFile(dir)).toBe(`ref: ${mainRef}`)
    // A crash after both: HEAD on it; adopted without touching .git.
    git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${NAME}`])
    const before = dotGitFingerprint(dir)
    expect(await settlePendingBranch(repo, pending, { finish: false })).toMatchObject({
      state: 'adopted',
      branch: pending,
    })
    expect(dotGitFingerprint(dir)).toEqual(before)
    git(dir, ['symbolic-ref', 'HEAD', mainRef])
    expect(await settlePendingBranch(repo, pending, { finish: true })).toMatchObject({ state: 'adopted' })
    expect((await readHead(dir)).ref).toBe(`refs/heads/${NAME}`)
  })

  it('settle: stale (HEAD moved on) → removed, then made again at the new HEAD; other commits → left alone', async () => {
    const { dir, repo, mainRef } = await repoWithHistory('stale')
    const base = tip(dir, mainRef) ?? ''
    const pending = { name: NAME, base, previous: mainRef }
    git(dir, ['update-ref', `refs/heads/${NAME}`, base])
    write(dir, 'src/app.ts', 'export const v = 2\n')
    git(dir, ['commit', '-q', '-am', 'user commit after the crash'])
    const newBase = tip(dir, mainRef)
    const made = await prepareRunBranch(repo, { prefix: 'dim/', date: DATE, task: TASK }, { pending })
    expect(made).toMatchObject({ ok: true, branch: { name: NAME, base: newBase, previous: mainRef } })
    // Someone committed on a pending branch and left it: it is not the run's any more.
    git(dir, ['checkout', '-q', mainRef.replace('refs/heads/', '')])
    git(dir, ['checkout', '-q', NAME])
    write(dir, 'src/app.ts', 'export const v = 3\n')
    git(dir, ['commit', '-q', '-am', 'on the branch'])
    git(dir, ['checkout', '-q', mainRef.replace('refs/heads/', '')])
    const settled = await settlePendingBranch(
      repo,
      { name: NAME, base: newBase ?? '', previous: mainRef },
      { finish: true },
    )
    expect(settled).toMatchObject({ state: 'gone' })
    expect(tip(dir, `refs/heads/${NAME}`)).not.toBeNull()
  })
})
