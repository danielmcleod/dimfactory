// Isolated-run fixtures: a user repo, the run's worktree made by
// git/worktree.ts, and its own shadow with S0 and the run's last snapshot. Honors DIM_FACTORY_TEST_GIT through the
// shared git helpers (CI's git-compat job runs these suites on 2.17.1).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWorktree, openWorktreeShadow } from '../../../../src/core/git/worktree.ts'
import type { WorktreeInfo } from '../../../../src/core/git/worktree.ts'
import type { Shadow } from '../../../../src/core/git/shadow.ts'
import type { FinalizeTarget } from '../../../../src/core/git/finalize.ts'
import { git, initRepo, tempDir, write } from '../../git/helpers.ts'

let seq = 0

/** A run id in the `newRunId` shape, unique per call. */
export function testRunId(): string {
  seq++
  return `20261009T12${String(seq % 100).padStart(2, '0')}00Z-${(seq + 0x1000).toString(16).slice(-4)}`
}

export interface Isolated {
  home: string
  /** The user's folder (the repository's top level). */
  repo: string
  runId: string
  wt: WorktreeInfo
  shadow: Shadow
  /** W.S0's commit. */
  s0: string
  /** Snapshot the worktree as the run's last result (S1) and return the finalize target S0..S1. */
  finish(): Promise<FinalizeTarget>
}

/**
 * A repo with `files` committed (`autocrlf` sets the repo's core.autocrlf; the files are then checked out again by git
 * so the folder holds what git writes), a worktree for a new run and its S0 snapshot.
 */
export async function isolated(
  files: Record<string, string | Buffer>,
  opts: { autocrlf?: boolean; home?: string } = {},
): Promise<Isolated> {
  const home = opts.home ?? tempDir('home')
  const repo = tempDir('repo')
  initRepo(repo)
  for (const [rel, data] of Object.entries(files)) write(repo, rel, data)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'fixture'])
  if (opts.autocrlf === true) {
    git(repo, ['config', 'core.autocrlf', 'true'])
    // Check every file out again so the folder holds git's conversion (as a user's clone does).
    git(repo, ['rm', '-q', '-r', '--cached', '.'])
    git(repo, ['reset', '-q', '--hard'])
  }
  const runId = testRunId()
  const wt = await createWorktree({
    home,
    runId,
    folder: repo,
    branch: `dim/test-${runId.toLowerCase()}`,
  })
  const shadow = await openWorktreeShadow(home, wt.path)
  const s0 = (await shadow.snapshot(runId, 'S0')).commit
  return {
    home,
    repo,
    runId,
    wt,
    shadow,
    s0,
    finish: async () => {
      const s1 = await shadow.snapshot(runId, 'S1')
      return { home, runId, folder: repo, worktree: wt, from: s0, to: s1.commit }
    },
  }
}

export const bytesOf = (root: string, rel: string): Buffer => readFileSync(join(root, rel))
export const textOf = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')
