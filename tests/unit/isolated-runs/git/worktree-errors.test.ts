// `worktree add` failures as the failure table words them (worktree_failed: "worktree add
// non-zero, branch exists, path too long, LFS smudge failure" with the copyable `git worktree prune` /
// `core.longpaths true` / `git lfs install`; a held *.lock is git_state, retried by the common-dir mutex).
import { describe, expect, it } from 'vitest'
import { GitError } from '../../../../src/core/git/exec.ts'
import { WorktreeError, worktreeErrorOf } from '../../../../src/core/git/worktree.ts'

const failed = (stderr: string, kind: 'exit' | 'missing' = 'exit'): GitError =>
  new GitError(kind, `git worktree add failed (exit 128): ${stderr}`, {
    args: ['worktree', 'add'],
    exitCode: 128,
    stderr,
    category: 'worktree_failed',
  })

describe('worktreeErrorOf', () => {
  it('names the cause and offers the fix', () => {
    const cases: [string, string, string, string[]][] = [
      ["fatal: a branch named 'dim/x' already exists", 'branch-exists', 'worktree_failed', []],
      [
        'error: unable to create file deep/path/file.txt: Filename too long',
        'path-too-long',
        'worktree_failed',
        ['git config --global core.longpaths true'],
      ],
      [
        "Error downloading object: big.bin: Smudge error: git-lfs: command not found\nerror: external filter 'git-lfs filter-process' failed",
        'lfs',
        'worktree_failed',
        ['git lfs install'],
      ],
      [
        "fatal: Unable to create 'C:/r/.git/refs/heads/dim/x.lock': File exists.",
        'locked',
        'git_state',
        ['git worktree prune'],
      ],
      ['fatal: could not write: No space left on device', 'disk-full', 'disk_full', []],
      [
        "fatal: '/h/worktrees/x' is a missing but already registered worktree",
        'git',
        'worktree_failed',
        ['git worktree prune'],
      ],
    ]
    for (const [stderr, kind, category, commands] of cases) {
      const e = worktreeErrorOf(failed(stderr), 'linux')
      expect(e, stderr).toBeInstanceOf(WorktreeError)
      expect(
        { kind: e.kind, category: e.category, commands: e.commands.map((c) => c.command) },
        stderr,
      ).toEqual({
        kind,
        category,
        commands,
      })
      expect(e.message).not.toMatch(/\u2014/)
    }
  })

  it('git itself missing is git_missing', () => {
    const e = worktreeErrorOf(failed('', 'missing'), 'win32')
    expect(e.category).toBe('git_missing')
  })
})
