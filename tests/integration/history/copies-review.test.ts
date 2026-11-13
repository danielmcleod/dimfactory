// Review: isolated copies that still hold something of the run ("Unfinalized worktrees are never auto-deleted";
// "any kept copy WITH changes never is"
// removed): an apply whose conflict is still open, an apply of a selection, and a copy edited after the run all keep
// the copy (and Remove refuses; with no snapshot, `git status` decides, and a copy git cannot read stays); a selection
// completed by a later apply lets it go. A copy that cannot be removed right now (in use) keeps its run and the run's
// snapshot refs, so Apply's undo point survives the next gc. Real git, real worktrees, retention's clock two days on.
// Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyRun,
  fileJournal,
  journalFile,
  recordWorktree,
  undoApply,
} from '../../../src/core/git/finalize.ts'
import type { FinalizeTarget } from '../../../src/core/git/finalize.ts'
import { resolveScope } from '../../../src/core/git/repo.ts'
import type { ScopeInfo } from '../../../src/core/git/repo.ts'
import { gcIfIdle, listRunRefs } from '../../../src/core/git/shadow.ts'
import type { RemoveWorktreeOptions, RemoveWorktreeResult } from '../../../src/core/git/worktree.ts'
import { readRunDoc } from '../../../src/core/handlers.ts'
import { copyLoss, createHistory } from '../../../src/core/history.ts'
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
import {
  TEST_GIT,
  cleanupTemps,
  initRepo,
  shadowGit,
  tempDir,
  testGitVersion,
  write,
} from '../git/helpers.ts'
import { isolated } from '../isolated-runs/git/fixture.ts'
import type { Isolated } from '../isolated-runs/git/fixture.ts'
import { DAY, ManualTimers, seedState } from '../../unit/history/helpers.ts'

const version = await testGitVersion()
console.info(`[git-compat] isolated copies (review) suite: ${version.raw} (${TEST_GIT})`)

const indexes: IndexStore[] = []
afterEach(async () => {
  for (const i of indexes.splice(0)) await i.close()
  cleanupTemps()
})

const UNAPPLIED =
  "still has its isolated copy with changes that are not in your folder. Apply or discard the copy in the run's Diff tab first."

const scopeOf = (s: ScopeInfo): RunScope => ({
  folder: s.folder,
  scopeRoot: s.scopeRoot,
  lockKey: s.lockKey,
  folderKey: s.folderKey,
  isRepo: s.isRepo,
})

/** An isolated run of the history, 10 days old: `files` committed, `change` written in its copy (S0..S1). */
async function copyRun(
  home: string,
  n: number,
  files: Record<string, string>,
  change: Record<string, string>,
): Promise<{ f: Isolated; target: FinalizeTarget }> {
  const f = await isolated(files, { home })
  for (const [rel, text] of Object.entries(change)) write(f.wt.path, rel, text)
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
  await recordWorktree(fileJournal(journalFile(home, f.runId)), f.wt, 'created')
  return { f, target }
}

async function historyOf(
  home: string,
  o: {
    policy?: RetentionPolicy
    removeWorktree?: (w: RemoveWorktreeOptions) => Promise<RemoveWorktreeResult>
  } = {},
): Promise<History> {
  const p = homePaths(home)
  const state = await HistoryState.load(p)
  const index = await IndexStore.open(p, {
    summarize: (doc) =>
      isPlainObject(doc['state']) ? toRunSummary(doc['state'] as unknown as RunState) : null,
    overlay: (s) => state.overlay(s),
  })
  indexes.push(index)
  const diffs = createRunDiffs({ paths: p, readDoc: (id) => readRunDoc(p, id) })
  return createHistory({
    paths: p,
    log: silentLogger,
    // Two days on: a finalized copy is past COPY_KEEP_MS.
    now: () => Date.now() + 2 * DAY,
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
    policy: () => o.policy ?? { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
    timers: new ManualTimers(),
    ...(o.removeWorktree !== undefined ? { removeWorktree: o.removeWorktree } : {}),
  })
}

describe(`isolated copies that still hold part of the run (${version.raw})`, () => {
  it("an apply whose conflict is still open keeps the copy, so [Take run's] still works afterwards", async () => {
    const home = tempDir('m14r-conflict-home')
    const { f, target } = await copyRun(
      home,
      1,
      { 'a.txt': 'a1\n', 'b.txt': 'b1\n' },
      { 'a.txt': 'a2 run\n', 'b.txt': 'b2 run\n' },
    )
    write(f.repo, 'a.txt', 'a mine\n')
    const r = await applyRun(target)
    expect(r.conflicts).toEqual(['a.txt'])
    const h = await historyOf(home)
    await expect(h.remove([f.runId])).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `Run #1 ${UNAPPLIED}`,
    })
    const rep = await h.retention()
    expect(rep.copies).toEqual([])
    expect(existsSync(f.wt.path)).toBe(true)
    const take = await applyRun(target, { resolutions: { 'a.txt': 'theirs' } })
    expect(take.applied).toContain('a.txt')
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe('a2 run\n')
    // Every change settled now: the copy goes a day later.
    const after = await (await historyOf(home)).retention()
    expect(after.copies.map((c) => c.displayNo)).toEqual([1])
    expect(existsSync(f.wt.path)).toBe(false)
  })

  it('an apply of a selection keeps the copy; applying the rest lets it go', async () => {
    const home = tempDir('m14r-sel-home')
    const { f, target } = await copyRun(
      home,
      1,
      { 'a.txt': 'a1\n', 'b.txt': 'b1\n' },
      { 'a.txt': 'a2 run\n', 'b.txt': 'b2 run\n' },
    )
    await applyRun(target, { paths: ['a.txt'] })
    const h = await historyOf(home)
    await expect(h.remove([f.runId])).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `Run #1 ${UNAPPLIED}`,
    })
    expect((await h.retention()).copies).toEqual([])
    expect(existsSync(f.wt.path)).toBe(true)
    expect(readFileSync(join(f.repo, 'b.txt'), 'utf8')).toBe('b1\n')
    // The rest, as a second selection: together they cover every change (checked against the copy's own shadow).
    await applyRun(target, { paths: ['b.txt'] })
    const after = await (await historyOf(home)).retention()
    expect(after.copies.map((c) => c.displayNo)).toEqual([1])
    expect(existsSync(f.wt.path)).toBe(false)
  })

  it('a copy edited after the run (no changes of its own, or applied) is kept; Remove says why', async () => {
    const home = tempDir('m14r-edit-home')
    const { f: quiet } = await copyRun(home, 1, { 'a.txt': 'a1\n' }, {})
    write(quiet.wt.path, 'notes/my-work.txt', 'typed by the user in the kept copy\n')
    write(quiet.wt.path, 'a.txt', 'a edited by the user\n')
    const { f: applied, target } = await copyRun(home, 2, { 'c.txt': 'c1\n' }, { 'c.txt': 'c2 run\n' })
    await applyRun(target)
    write(applied.wt.path, 'c.txt', 'c3 edited in the copy after the apply\n')
    const h = await historyOf(home)
    await expect(h.remove([quiet.runId])).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        "Run #1's isolated copy was changed after the run (a.txt, notes/my-work.txt), so Dim Factory leaves it alone. Discard the copy in the run's Diff tab once you no longer need those changes.",
    })
    await expect(h.remove([applied.runId])).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Run #2's isolated copy was changed after the run \(c\.txt\)/,
      ) as string,
    })
    const rep = await h.retention()
    expect(rep.copies).toEqual([])
    expect(existsSync(quiet.wt.path)).toBe(true)
    expect(readFileSync(join(quiet.wt.path, 'notes', 'my-work.txt'), 'utf8')).toContain('typed by the user')
    expect(existsSync(applied.wt.path)).toBe(true)
  })

  it('a copy with no snapshot: an edit in it keeps it, and a copy git cannot read as a repository is left alone', async () => {
    const home = tempDir('m14r-nosnap-home')
    const check = (path: string): Promise<string | undefined> =>
      copyLoss(home, { kind: 'unchanged', runId: 'run-nosnap', label: 'Run #7', path })
    const clean = tempDir('m14r-nosnap-repo')
    initRepo(clean)
    expect(await check(clean)).toBeUndefined()
    write(clean, 'notes.txt', 'typed by the user\n')
    expect(await check(clean)).toBe(
      "Run #7's isolated copy was changed after the run (notes.txt), so Dim Factory leaves it alone. Discard the copy in the run's Diff tab once you no longer need those changes.",
    )
    // Not a repository (its .git gone): `git status` cannot say what it holds, so it stays.
    const broken = tempDir('m14r-nosnap-plain')
    write(broken, 'notes.txt', 'typed by the user\n')
    expect(await check(broken)).toBe(
      "Dim Factory could not check what Run #7's isolated copy holds now, so it leaves the copy alone.",
    )
  })

  it('a copy that cannot be removed now keeps its run and its refs, so the apply can still be undone after a gc', async () => {
    const home = tempDir('m14r-busy-home')
    const { f, target } = await copyRun(home, 1, { 'a.txt': 'a1\n' }, { 'a.txt': 'a2 run\n' })
    const applied = await applyRun(target)
    await copyRun(home, 2, { 'z.txt': 'z\n' }, {})
    const srcKey = (await resolveScope(f.repo)).folderKey
    // Apply's undo point P is run 1's ref in the folder's own shadow.
    expect(await listRunRefs(home, srcKey)).toEqual([f.runId])
    // A terminal open in the copy: Windows refuses to delete it (here, the removal reports it as left).
    const h = await historyOf(home, {
      policy: { keepRuns: 1, keepDays: 1, rawLogDays: 14 },
      removeWorktree: () =>
        Promise.resolve({
          removed: false,
          branchDeleted: false,
          shadowDropped: false,
          notes: ['The copy is in use by another program.'],
          commands: [],
        }),
    })
    const rep = await h.retention({ force: true })
    expect(rep.removed).toEqual([])
    expect(rep.failed.map((x) => [x.displayNo, x.reason])).toEqual([
      [1, 'The copy is in use by another program.'],
    ])
    expect(existsSync(homePaths(home).run(f.runId).dir)).toBe(true)
    expect(existsSync(f.wt.path)).toBe(true)
    expect(await listRunRefs(home, srcKey)).toEqual([f.runId])
    // A gc of the folder's shadow keeps it (a ref is left), and the apply can still be undone.
    const g = await gcIfIdle({
      home,
      folderKey: srcKey,
      now: Date.now(),
      inUse: () => false,
      idleMs: 0,
      force: true,
    })
    expect(g.action).toBe('gc')
    await undoApply(target, applied.undoToken)
    expect(readFileSync(join(f.repo, 'a.txt'), 'utf8')).toBe('a1\n')
  })
})
