// worktree.preview and "Apply reviewed only" against real git (the Diff tab's "Apply to folder…"): the preview
// writes nothing; reviewed files come from review-state.json, with both sides of a rename. Honors
// DIM_FACTORY_TEST_GIT.
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShadowReader } from '../../../../src/core/git/diff-view.ts'
import { applyRun } from '../../../../src/core/git/finalize.ts'
import {
  createWorktreeHost,
  finalizeTargetOf,
  reviewedApplyPaths,
} from '../../../../src/core/handlers-worktree.ts'
import { homePaths } from '../../../../src/core/home.ts'
import { writeReviewMarks } from '../../../../src/core/store/review-state.ts'
import type { RunDoc } from '../../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import { TEST_GIT, cleanupTemps, testGitVersion, write } from '../../git/helpers.ts'
import { isolated, textOf } from './fixture.ts'

const version = await testGitVersion()
console.info(`[git-compat] worktree host suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

/** The run state the host reads: an isolated run with its worktree and the snapshots S0 and S1 (in its shadow). */
function stateOf(
  f: { runId: string; repo: string; wt: { path: string; branch: string; base: string } },
  s0: string,
  s1: string,
): RunState {
  const ref = (label: string, commit: string, at: number) => ({ label, commit, tree: '', at })
  return {
    runId: f.runId,
    folder: f.repo,
    config: { isolation: 'worktree' },
    isolation: { rows: [], worktree: { path: f.wt.path, branch: f.wt.branch, base: f.wt.base } },
    steps: { implement: { status: 'done' }, fix: { status: 'skipped' } },
    snapshots: { S0: ref('S0', s0, 1), S1: ref('S1', s1, 2) },
  } as unknown as RunState
}

describe(`worktree.preview and reviewed-only through the host (${version.raw})`, () => {
  it('previews what Apply would do, writing nothing', async () => {
    const f = await isolated({ 'a.txt': 'a1\n', 'b.txt': 'b1\n' })
    write(f.wt.path, 'a.txt', 'a2\n')
    write(f.wt.path, 'b.txt', 'b-run\n')
    const target = await f.finish()
    write(f.repo, 'b.txt', 'b-user\n')
    const state = stateOf(f, target.from, target.to)
    const host = createWorktreeHost({
      paths: homePaths(f.home),
      controller: () => Promise.reject(new Error('the preview never loads the run')),
      readDoc: () => Promise.resolve({ runId: f.runId, state } as unknown as RunDoc),
    })
    const p = await host.preview(f.runId)
    expect(p.conflicts).toEqual(['b.txt'])
    expect(p.actions).toEqual([
      { path: 'a.txt', action: 'write' },
      { path: 'b.txt', action: 'conflict', reason: 'It was changed in the folder after the run started.' },
    ])
    expect(p.files.map((x) => x.path)).toEqual(['a.txt', 'b.txt'])
    expect(textOf(f.repo, 'a.txt')).toBe('a1\n')
  })

  it('reviewed-only takes the files whose mark names the blob applied, with both sides of a rename', async () => {
    const f = await isolated({
      'keep.txt': 'k1\n',
      'stale.txt': 's1\n',
      'old-name.txt': 'moving file body\n',
    })
    write(f.wt.path, 'keep.txt', 'k2\n')
    write(f.wt.path, 'stale.txt', 's2\n')
    renameSync(join(f.wt.path, 'old-name.txt'), join(f.wt.path, 'new-name.txt'))
    const target = await f.finish()
    const t = finalizeTargetOf(f.home, stateOf(f, target.from, target.to))
    const paths = homePaths(f.home)
    const file = paths.run(f.runId).reviewStateJson
    expect(await reviewedApplyPaths(paths, t)).toEqual([])
    // keep.txt reviewed as it is now (combined); stale.txt reviewed on an older version (implement segment); the rename.
    const reader = await ShadowReader.open(paths.shadowRepo(f.wt.folderKey), f.wt.path)
    const changes = (await reader?.changes(target.from, target.to)) ?? []
    const sha = (p: string): string => changes.find((c) => c.path === p)?.newSha ?? ''
    await writeReviewMarks(file, 'combined', [{ path: 'keep.txt', sha: sha('keep.txt') }], true)
    await writeReviewMarks(file, 'implement', [{ path: 'stale.txt', sha: 'f'.repeat(40) }], true)
    await writeReviewMarks(file, 'fix', [{ path: 'new-name.txt', sha: sha('new-name.txt') }], true)
    const reviewed = await reviewedApplyPaths(paths, t)
    expect([...reviewed].sort()).toEqual(['keep.txt', 'new-name.txt', 'old-name.txt'])
    const r = await applyRun(t, { paths: reviewed })
    expect(r.applied.sort()).toEqual(['keep.txt', 'new-name.txt', 'old-name.txt'])
    expect(textOf(f.repo, 'stale.txt')).toBe('s1\n')
    expect(textOf(f.repo, 'new-name.txt')).toBe('moving file body\n')
  })

  it('a selection naming only the new side of a rename applies the whole rename, never a copy', async () => {
    const f = await isolated({ 'src.txt': 'renamed body\n' })
    renameSync(join(f.wt.path, 'src.txt'), join(f.wt.path, 'dst.txt'))
    const target = await f.finish()
    const r = await applyRun(target, { paths: ['dst.txt'] })
    expect(r.written).toEqual(['dst.txt'])
    expect(r.deleted).toEqual(['src.txt'])
  })
})
