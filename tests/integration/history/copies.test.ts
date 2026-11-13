// Isolated copies and retention against real git ("Unfinalized worktrees are never auto-deleted"; worktrees are
// removed only when finalized; "a kept copy of a run that changed nothing is not finalized for retention"): a run
// whose copy was applied
// is deleted with its copy, the copy's branch and its shadow, and its pre-apply snapshot ref in the folder's shadow;
// a run whose copy has changes not in the folder is refused by Remove and kept by retention, copy and all; a copy
// that changed nothing is removed. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { applyRun, fileJournal, journalFile, recordWorktree } from '../../../src/core/git/finalize.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import type { ScopeInfo } from '../../../src/core/git/repo.ts'
import { listRunRefs, listShadowKeys } from '../../../src/core/git/shadow.ts'
import { readRunDoc } from '../../../src/core/handlers.ts'
import { createHistory } from '../../../src/core/history.ts'
import type { History } from '../../../src/core/history.ts'
import { homePaths } from '../../../src/core/home.ts'
import { silentLogger } from '../../../src/core/log.ts'
import { createRunDiffs } from '../../../src/core/run-diffs.ts'
import { HistoryState } from '../../../src/core/store/history-state.ts'
import { IndexStore } from '../../../src/core/store/index-store.ts'
import type { RetentionPolicy } from '../../../src/core/store/retention.ts'
import { RunStore } from '../../../src/core/store/run-store.ts'
import { isPlainObject } from '../../../src/core/store/versions.ts'
import type { RunDoc, RunScope } from '../../../src/core/supervisor/controller.ts'
import { toRunSummary } from '../../../src/core/supervisor/derive.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { TEST_GIT, cleanupTemps, git, shadowGit, tempDir, testGitVersion, write } from '../git/helpers.ts'
import { isolated } from '../isolated-runs/git/fixture.ts'
import type { Isolated } from '../isolated-runs/git/fixture.ts'
import { DAY, ManualTimers, seedState } from '../../unit/history/helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] isolated copies suite: ${version.raw} (${TEST_GIT})`)

const indexes: IndexStore[] = []
afterEach(async () => {
  for (const i of indexes.splice(0)) await i.close()
  cleanupTemps()
})

const COPY_REFUSED =
  "still has its isolated copy with changes that are not in your folder. Apply or discard the copy in the run's Diff tab first."

const scopeOf = (s: ScopeInfo): RunScope => ({
  folder: s.folder,
  scopeRoot: s.scopeRoot,
  lockKey: s.lockKey,
  folderKey: s.folderKey,
  isRepo: s.isRepo,
})

/**
 * An isolated run recorded as a finished run of the history, 10 days old: its copy changed `rel` (or, with
 * `unchanged`, nothing), its journal records the worktree, and run.json names both scopes and S0/S1.
 */
async function copyRun(
  home: string,
  n: number,
  rel: string,
  o: { unchanged?: boolean } = {},
): Promise<Isolated> {
  const f = await isolated({ [rel]: `${rel} 1\n` }, { home })
  if (o.unchanged !== true) write(f.wt.path, rel, `${rel} 2\n`)
  const target = await f.finish()
  const [src, work] = await Promise.all([resolveScope(f.repo), resolveScope(f.wt.path)])
  const createdAt = Date.now() - 10 * DAY
  const state = seedState({
    runId: f.runId,
    displayNo: n,
    createdAt,
    folder: src.folder,
    folderKey: src.folderKey,
    isolation: 'worktree',
  })
  const tree = (commit: string): string =>
    shadowGit(f.shadow.gitDir, ['rev-parse', `${commit}^{tree}`]).trim()
  state.snapshots.S0 = { label: 'S0', commit: f.s0, tree: tree(f.s0), at: createdAt + 1 }
  state.snapshots.S1 = { label: 'S1', commit: target.to, tree: tree(target.to), at: createdAt + 2 }
  const doc: RunDoc = {
    runId: f.runId,
    state,
    lastSeq: 0,
    scope: { ...scopeOf(src), runLockKey: work.lockKey },
    createdBy: 'app',
    work: scopeOf(work),
  }
  await RunStore.create(homePaths(home), f.runId, doc)
  // The journal (runs/<id>/finalize.json) records the worktree, as createWorktree's write-ahead does in a run.
  await recordWorktree(fileJournal(journalFile(home, f.runId)), f.wt, 'created')
  return f
}

async function historyOf(
  home: string,
  policy: RetentionPolicy,
): Promise<{ h: History; timers: ManualTimers }> {
  const p = homePaths(home)
  const state = await HistoryState.load(p)
  const index = await IndexStore.open(p, {
    summarize: (doc) =>
      isPlainObject(doc['state']) ? toRunSummary(doc['state'] as unknown as RunState) : null,
    overlay: (s) => state.overlay(s),
  })
  indexes.push(index)
  const diffs = createRunDiffs({ paths: p, readDoc: (id) => readRunDoc(p, id) })
  const timers = new ManualTimers()
  const h = createHistory({
    paths: p,
    log: silentLogger,
    now: () => Date.now(),
    state,
    index,
    summaries: () => index.list(),
    readDoc: (id) => readRunDoc(p, id),
    summarizeDoc: (doc) => toRunSummary(doc.state),
    lockOf: () => undefined,
    detach: () => Promise.resolve(),
    persistRuns: (ids) => diffs.persistRuns(ids),
    folderInUse: () => false,
    lastLockAt: () => undefined,
    policy: () => policy,
    timers,
  })
  return { h, timers }
}

const runBranches = (repo: string): string[] =>
  git(repo, ['branch', '--list', '--format=%(refname:short)'])
    .split(/\r?\n/)
    .filter((b) => b.startsWith('dim/'))

describe(`isolated copies and retention (${version.raw})`, () => {
  it('Remove: an applied copy goes with its run; a copy with changes not in the folder refuses', async () => {
    const home = tempDir('copies-home')
    const applied = await copyRun(home, 1, 'a.txt')
    const appliedTarget = {
      home,
      runId: applied.runId,
      folder: applied.repo,
      worktree: applied.wt,
      from: applied.s0,
      to: (await applied.shadow.runRef(applied.runId))?.commit ?? '',
    }
    await applyRun(appliedTarget)
    const kept = await copyRun(home, 2, 'b.txt')
    const appliedKey = (await resolveScope(applied.wt.path)).folderKey
    const sourceKey = (await resolveScope(applied.repo)).folderKey
    // Apply's undo point P is a ref of this run in the folder's own shadow.
    expect(await listRunRefs(home, sourceKey)).toEqual([applied.runId])
    expect(runBranches(applied.repo)).toHaveLength(1)
    const { h, timers } = await historyOf(home, { keepRuns: 300, keepDays: 60, rawLogDays: 14 })

    await expect(h.remove([kept.runId])).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `Run #2 ${COPY_REFUSED}`,
    })
    await h.remove([applied.runId])
    timers.fireAll()
    await h.settled()
    expect(existsSync(applied.wt.path)).toBe(false)
    expect(runBranches(applied.repo)).toEqual([])
    expect(await listShadowKeys(home)).not.toContain(appliedKey)
    expect(await listRunRefs(home, sourceKey)).toEqual([])
    expect(existsSync(homePaths(home).run(applied.runId).dir)).toBe(false)
    // The applied change stays in the folder; the other run and its copy are untouched.
    expect(git(applied.repo, ['status', '--porcelain'])).toContain('a.txt')
    expect(existsSync(kept.wt.path)).toBe(true)
    expect(existsSync(homePaths(home).run(kept.runId).dir)).toBe(true)
  })

  it('retention keeps an unfinalized copy with changes (and its run) and removes a copy that changed nothing', async () => {
    const home = tempDir('copies-ret-home')
    const withChanges = await copyRun(home, 1, 'b.txt')
    const unchanged = await copyRun(home, 2, 'c.txt', { unchanged: true })
    // keepRuns 1: run 2 (the newest) is kept by the rule, run 1 is past both rules.
    const { h } = await historyOf(home, { keepRuns: 1, keepDays: 1, rawLogDays: 14 })
    const r = await h.retention()
    expect(r.removed).toEqual([])
    expect(r.kept.map((k) => [k.displayNo, k.reason])).toEqual([[1, `Run #1 ${COPY_REFUSED}`]])
    expect(existsSync(withChanges.wt.path)).toBe(true)
    expect(existsSync(homePaths(home).run(withChanges.runId).dir)).toBe(true)
    // A kept run whose copy changed nothing (10 days ago): the copy goes, the run stays.
    expect(r.copies.map((c) => c.displayNo)).toEqual([2])
    expect(existsSync(unchanged.wt.path)).toBe(false)
    expect(runBranches(unchanged.repo)).toEqual([])
    expect(existsSync(homePaths(home).run(unchanged.runId).dir)).toBe(true)
  })
})
