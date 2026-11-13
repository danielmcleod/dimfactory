// Run branch names and labels (branch prep: `<prefix><YYYYMMDD>-<slug≤40>`), the held-lock test
// the run-branch writes retry on, and the copyable git commands in heal/commands.ts.
import { describe, expect, it } from 'vitest'
import {
  RUN_BRANCH_SLUG_MAX,
  branchShortName,
  headLabel,
  isHeldLockError,
  runBranchBaseName,
  runBranchSlug,
} from '../../../src/core/git/branch.ts'
import { GitError } from '../../../src/core/git/exec.ts'
import { repairCommand } from '../../../src/core/heal/commands.ts'

const gitErr = (stderr: string): GitError =>
  new GitError('exit', 'git failed', { args: [], stderr, exitCode: 128, category: 'git_state' })

describe('run branch names', () => {
  it('slug: ASCII, lowercase, dash separated', () => {
    expect(runBranchSlug('Add a --version flag')).toBe('add-a-version-flag')
    expect(runBranchSlug('  Fix: crash in Ünïcödé café (#42)!  ')).toBe('fix-crash-in-unicode-cafe-42')
    expect(runBranchSlug('Line one\nline two')).toBe('line-one-line-two')
  })

  it('slug: at most 40 chars, cut at a word end when that keeps half of it', () => {
    const slug = runBranchSlug('Refactor the configuration loader so that it supports nested profiles')
    expect(slug).toBe('refactor-the-configuration-loader-so')
    expect(slug.length).toBeLessThanOrEqual(RUN_BRANCH_SLUG_MAX)
    const oneWord = runBranchSlug('a'.repeat(60))
    expect(oneWord).toBe('a'.repeat(40))
    expect(runBranchSlug('x'.repeat(39) + ' yz')).toBe('x'.repeat(39))
  })

  it('slug: a task with no ASCII letters or digits becomes "run"', () => {
    expect(runBranchSlug('修复登录')).toBe('run')
    expect(runBranchSlug('---')).toBe('run')
  })

  it('base name: prefix, local date, slug', () => {
    expect(runBranchBaseName('dim/', new Date(2026, 0, 5, 23, 59), 'Add tests')).toBe(
      'dim/20260105-add-tests',
    )
    expect(runBranchBaseName('wip-', new Date(2026, 11, 31), 'x')).toBe('wip-20261231-x')
  })

  it('labels', () => {
    expect(branchShortName('refs/heads/dim/x')).toBe('dim/x')
    expect(branchShortName('refs/remotes/o/x')).toBe('refs/remotes/o/x')
    expect(headLabel({ ref: 'refs/heads/main', commit: null })).toBe('main')
    expect(headLabel({ ref: null, commit: 'abcdef0123456789abcdef0123456789abcdef01' })).toBe(
      'detached HEAD at abcdef0',
    )
  })

  it('only a held *.lock is retried, never "already exists" or a moved ref', () => {
    expect(
      isHeldLockError(
        gitErr(
          "fatal: cannot lock ref 'refs/heads/x': Unable to create '/r/.git/refs/heads/x.lock': File exists.",
        ),
      ),
    ).toBe(true)
    expect(isHeldLockError(gitErr("error: Unable to create 'C:/r/.git/HEAD.lock': File exists."))).toBe(true)
    expect(isHeldLockError(gitErr("fatal: cannot lock ref 'refs/heads/x': reference already exists"))).toBe(
      false,
    )
    expect(isHeldLockError(gitErr("error: cannot lock ref 'refs/heads/x': is at a but expected b"))).toBe(
      false,
    )
    expect(isHeldLockError(new Error("Unable to create 'x.lock': File exists"))).toBe(false)
  })
})

describe('copyable git commands', () => {
  it('checkout a branch: bare when safe, quoted per shell otherwise, refused when not a branch name', () => {
    expect(repairCommand('checkoutBranch', 'linux', 'refs/heads/main')).toEqual({
      command: 'git checkout main',
      shell: 'sh',
    })
    expect(repairCommand('checkoutBranch', 'win32', 'feature/a.b-c_d')?.command).toBe(
      'git checkout feature/a.b-c_d',
    )
    expect(repairCommand('checkoutBranch', 'linux', "it's$x")?.command).toBe("git checkout 'it'\\''s$x'")
    expect(repairCommand('checkoutBranch', 'win32', "it's$x")?.command).toBe("git checkout 'it''s$x'")
    for (const bad of ['', '-rf', 'a b', 'a~1', 'a:b', 'a\nb', 'a\u0007b', 'a\\b', 'a*']) {
      expect(repairCommand('checkoutBranch', 'linux', bad), JSON.stringify(bad)).toBeNull()
    }
    expect(repairCommand('checkoutBranch', 'linux')).toBeNull()
  })

  it('checkout --detach takes only a hex object id', () => {
    expect(repairCommand('checkoutDetach', 'darwin', 'abc1234')?.command).toBe(
      'git checkout --detach abc1234',
    )
    expect(repairCommand('checkoutDetach', 'linux', 'HEAD; rm -rf ~')).toBeNull()
    expect(repairCommand('checkoutDetach', 'linux', 'abc')).toBeNull()
  })

  it('delete a branch with the safe -d', () => {
    expect(repairCommand('deleteBranch', 'win32', 'dim/20261008-x')).toEqual({
      command: 'git branch -d dim/20261008-x',
      shell: 'powershell',
    })
    expect(repairCommand('deleteBranch', 'linux', '--force')).toBeNull()
  })
})
