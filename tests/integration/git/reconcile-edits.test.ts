// Reconciliation against real git, the outside-edit rows (edits made outside the run): edits during
// planning (info + chip), edits that do not touch the run's paths (info + prompt note), edits overlapping the run's
// paths (choice; [Restore run's version] is undoable and keeps the edit out of the Combined diff, as reconcile-restore.spec.ts), and the
// scratch-index `treeNow` that moves no ref. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { createHash } from 'node:crypto'
import { readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcile, restoreRunVersion } from '../../../src/core/git/reconcile.ts'
import type { GatherReconcileOptions, ReconcileResult } from '../../../src/core/git/reconcile.ts'
import { undoRevert } from '../../../src/core/git/revert.ts'
import { TEST_GIT, cleanupTemps, shadowGit, testGitVersion, write } from './helpers.ts'
import { RECONCILE_RUN, dotGitFingerprint, reconcileScenario } from './fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] reconcile edits suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

type Scenario = Awaited<ReturnType<typeof reconcileScenario>>

async function check(sc: Scenario, over: Partial<GatherReconcileOptions> = {}): Promise<ReconcileResult> {
  const { result } = await reconcile({
    shadow: sc.shadow,
    boundary: 'pre-fix',
    branchMode: 'none',
    expectedHead: sc.expected,
    lastSnapshot: sc.s1.commit,
    runStart: sc.s0.commit,
    lockWaitMs: 300,
    os: 'linux',
    ...over,
  })
  return result
}

const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')
const runRef = (sc: Scenario): string =>
  shadowGit(sc.shadow.gitDir, ['rev-parse', `refs/dimfactory/runs/${RECONCILE_RUN}`]).trim()

describe(`reconcile: outside edits (${version.raw})`, () => {
  it('edits during planning: info, folded into S0, with the "N files changed during planning" chip', async () => {
    const sc = await reconcileScenario('planning')
    write(sc.dir, 'b.txt', 'user edit while planning\n')
    // Before Implement the run has changed nothing: everything since run-start is the user's.
    const r = await check(sc, {
      boundary: 'pre-implement',
      lastSnapshot: sc.s0.commit,
      runStart: sc.s0.commit,
    })
    expect(r.verdict).toBe('info')
    expect(r.reasons.map((x) => x.row)).toEqual(['external-planning'])
    expect(r.chip).toBe('2 files changed during planning')
    expect(r.paths.external).toEqual(['a.txt', 'b.txt'])
    expect(r.notes).toEqual([])
    expect(r.choices).toEqual([])
  })

  it('edits that do not touch the run’s paths: info with the prompt note', async () => {
    const sc = await reconcileScenario('apart')
    write(sc.dir, 'b.txt', 'user edit\n')
    write(sc.dir, 'notes/new.md', 'user file\n')
    const before = dotGitFingerprint(sc.dir)
    const r = await check(sc)
    expect(r.verdict).toBe('info')
    expect(r.reasons.map((x) => x.row)).toEqual(['external-edits'])
    expect(r.paths).toEqual({ external: ['b.txt', 'notes/new.md'], overlapping: [] })
    expect(r.notes).toEqual(['User edited outside the run: b.txt, notes/new.md'])
    expect(r.choices).toEqual([])
    expect(dotGitFingerprint(sc.dir)).toEqual(before)
  })

  it('edits overlapping the run: choice; Restore run’s version keeps the edit out of the Combined diff; undo', async () => {
    const sc = await reconcileScenario('overlap')
    write(sc.dir, 'a.txt', 'user edit of a\n')
    write(sc.dir, 'b.txt', 'user edit of b\n')
    const r = await check(sc)
    expect(r.verdict).toBe('choice')
    expect(r.reasons.map((x) => `${x.severity}:${x.row}`)).toEqual(['choice:external-overlap'])
    expect(r.paths).toEqual({ external: ['a.txt', 'b.txt'], overlapping: ['a.txt'] })
    expect(r.choices).toEqual([
      { id: 'include-my-edits', label: 'Include my edits', primary: true },
      { id: 'restore-run-version', label: "Restore run's version" },
      { id: 'stop', label: 'Stop' },
    ])
    expect(r.defaultChoice).toBe('include-my-edits')
    expect(r.notes).toEqual(['User edited outside the run: a.txt, b.txt'])

    const restored = await restoreRunVersion(sc.shadow, {
      runId: RECONCILE_RUN,
      lastSnapshot: sc.s1.commit,
      paths: r.paths.overlapping,
    })
    if (!restored.ok) throw new Error('refused')
    expect(restored.outcome.restored).toEqual(['a.txt'])
    expect(read(sc.dir, 'a.txt')).toBe('a.txt changed by the run\n')
    expect(read(sc.dir, 'b.txt')).toBe('user edit of b\n')
    // The restore is Dim Factory's own write: reconciling again sees only the edit that does not overlap.
    const again = await check(sc, { ownPaths: restored.outcome.restored })
    expect(again.verdict).toBe('info')
    expect(again.paths).toEqual({ external: ['b.txt'], overlapping: [] })
    // F0 and the Combined diff (S0..F0) carry the run's version of a.txt, not the outside edit.
    const f0 = await sc.shadow.snapshot(RECONCILE_RUN, 'fix-start')
    const combined = await sc.shadow.patch(sc.s0.commit, f0.commit)
    expect(combined.text).toContain('+a.txt changed by the run')
    expect(combined.text).not.toContain('user edit of a')
    // Undo brings the user's edit back.
    const undone = await undoRevert(sc.shadow, restored.outcome, { runId: RECONCILE_RUN })
    if (!undone.ok) throw new Error('refused')
    expect(read(sc.dir, 'a.txt')).toBe('user edit of a\n')
  })

  it('treeNow sees a same-size edit made in the second the shadow index was written', async () => {
    // Git checks again the content of a file changed in the second its index was written, judged by the index file's
    // own time; treeNow works on a copy of that index, which must keep its time. A copy on Linux is new (Windows keeps
    // the time), so there a same-size edit in that second matched the cached stat and was missed.
    const sc = await reconcileScenario('treenow-racy')
    // Size and mtime only (no ctime, inode or nanoseconds): the same-second case on every system.
    shadowGit(sc.shadow.gitDir, ['config', 'core.trustctime', 'false'])
    shadowGit(sc.shadow.gitDir, ['config', 'core.checkStat', 'minimal'])
    const T = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    utimesSync(join(sc.dir, 'a.txt'), T, T)
    const last = await sc.shadow.snapshot(RECONCILE_RUN, 'resume')
    utimesSync(join(sc.shadow.gitDir, 'index'), T, T)
    write(sc.dir, 'a.txt', 'a.txt edited by the user\n')
    expect(read(sc.dir, 'a.txt')).toHaveLength('a.txt changed by the run\n'.length)
    utimesSync(join(sc.dir, 'a.txt'), T, T)
    const now = await sc.shadow.treeNow()
    expect(now.tree).not.toBe(last.tree)
  })

  it('treeNow: the folder’s tree without a snapshot; no ref moves and the shadow index is untouched', async () => {
    const sc = await reconcileScenario('treenow')
    write(sc.dir, 'b.txt', 'later edit\n')
    const indexFile = join(sc.shadow.gitDir, 'index')
    const hash = (): string => createHash('sha256').update(readFileSync(indexFile)).digest('hex')
    const ref = runRef(sc)
    const index = hash()
    const now = await sc.shadow.treeNow()
    expect(runRef(sc)).toBe(ref)
    expect(hash()).toBe(index)
    const snap = await sc.shadow.snapshot(RECONCILE_RUN, 'resume')
    expect(now.tree).toBe(snap.tree)
    expect(now.tree).not.toBe(sc.s1.tree)
    // A tree passed by the caller is used as is.
    const r = await check(sc, { nowTree: sc.s1.tree })
    expect(r.verdict).toBe('clean')
  })
})
