// Reconciliation against real git, the git-state rows (one test per row):
// operation in progress (merge for real, with the copyable abort), unmerged paths, mass deletion > 50%, index.lock
// before/after branch creation, HEAD moved, bisect, ref switched (branch:none choice, runBranch block). Gathering the
// facts never changes the user's .git. Honors DIM_FACTORY_TEST_GIT (CI: 2.17.1).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunBranch, readHead } from '../../../src/core/git/branch.ts'
import { reconcile } from '../../../src/core/git/reconcile.ts'
import type { GatherReconcileOptions, ReconcileResult } from '../../../src/core/git/reconcile.ts'
import { openShadow } from '../../../src/core/git/shadow.ts'
import { TEST_GIT, cleanupTemps, git, tempDir, testGitVersion, write } from './helpers.ts'
import { RECONCILE_RUN, dotGitFingerprint, reconcileScenario } from './fingerprint.ts'

const version = await testGitVersion()
console.info(`[git-compat] reconcile rows suite: ${version.raw} (${TEST_GIT})`)

afterEach(() => cleanupTemps())

type Scenario = Awaited<ReturnType<typeof reconcileScenario>>

/** reconcile() at pre-fix, branch:none, against the scenario's S0..S1 (copyable commands for sh). */
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

const rows = (r: ReconcileResult): string[] => r.reasons.map((x) => `${x.severity}:${x.row}`)

describe(`reconcile: git state rows (${version.raw})`, () => {
  it('clean: nothing changed outside the run', async () => {
    const sc = await reconcileScenario('clean')
    const before = dotGitFingerprint(sc.dir)
    const r = await check(sc)
    expect(r).toEqual({
      verdict: 'clean',
      reasons: [],
      paths: { external: [], overlapping: [] },
      choices: [],
      notes: [],
    })
    // Gathering only read the user's repo.
    expect(dotGitFingerprint(sc.dir)).toEqual(before)
  })

  it('merge in progress: block with [Recheck] [Stop], no default, and the copyable git merge --abort', async () => {
    const sc = await reconcileScenario('merge')
    git(sc.dir, ['checkout', '-q', '-b', 'other'])
    write(sc.dir, 'c.txt', 'c from other\n')
    git(sc.dir, ['commit', '-q', '-m', 'other', 'c.txt'])
    git(sc.dir, ['checkout', '-q', sc.mainName])
    write(sc.dir, 'c.txt', 'c from main\n')
    git(sc.dir, ['commit', '-q', '-m', 'main', 'c.txt'])
    git(sc.dir, ['merge', 'other'], { allowFail: true })
    const before = dotGitFingerprint(sc.dir)
    const r = await check(sc)
    expect(r.verdict).toBe('block')
    expect(rows(r)).toEqual(expect.arrayContaining(['block:operation', 'block:unmerged']))
    expect(r.reasons[0]).toMatchObject({
      row: 'operation',
      op: 'merge',
      title: 'A git merge is in progress',
      commands: [{ command: 'git merge --abort', shell: 'sh' }],
    })
    expect(r.choices.map((c) => c.id)).toEqual(['recheck', 'stop'])
    expect(r.defaultChoice).toBeUndefined()
    expect(dotGitFingerprint(sc.dir)).toEqual(before)
  })

  it('rebase, am, cherry-pick and revert in progress block with their aborts', async () => {
    const sc = await reconcileScenario('ops')
    const gitDir = join(sc.dir, '.git')
    const cases: [string, string][] = [
      ['rebase-merge/', 'git rebase --abort'],
      ['rebase-apply/applying', 'git am --abort'],
      ['CHERRY_PICK_HEAD', 'git cherry-pick --abort'],
      ['REVERT_HEAD', 'git revert --abort'],
    ]
    for (const [marker, abort] of cases) {
      const p = join(gitDir, marker)
      if (marker.endsWith('/')) mkdirSync(p, { recursive: true })
      else {
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, '0123\n')
      }
      const r = await check(sc)
      expect(r.verdict, marker).toBe('block')
      expect(r.reasons.map((x) => x.commands.map((c) => c.command)).flat(), marker).toEqual([abort])
      rmSync(join(gitDir, marker.split('/')[0] ?? marker), { recursive: true, force: true })
    }
  })

  it('unmerged paths without an operation block', async () => {
    const sc = await reconcileScenario('unmerged')
    const blob = git(sc.dir, ['rev-parse', 'HEAD:b.txt']).trim()
    git(sc.dir, ['update-index', '-z', '--index-info'], {
      input: [`0 ${'0'.repeat(40)}\tb.txt`, `100644 ${blob} 2\tb.txt`, `100644 ${blob} 3\tb.txt`, ''].join(
        '\0',
      ),
    })
    const r = await check(sc)
    expect(r.verdict).toBe('block')
    expect(rows(r)).toEqual(['block:unmerged'])
    expect(r.reasons[0]?.detail).toContain('b.txt')
  })

  it('mass deletion: more than half of the files gone blocks; fewer is just an outside edit', async () => {
    const sc = await reconcileScenario('mass')
    // S1 has 5 files (README.md, a-d). Two gone (40%): info.
    rmSync(join(sc.dir, 'b.txt'))
    rmSync(join(sc.dir, 'c.txt'))
    const few = await check(sc)
    expect(few.verdict).toBe('info')
    expect(rows(few)).toEqual(['info:external-edits'])
    // Three gone (60%): block.
    rmSync(join(sc.dir, 'd.txt'))
    const many = await check(sc)
    expect(many.verdict).toBe('block')
    expect(rows(many)).toEqual(['block:mass-deletion', 'info:external-edits'])
    expect(many.reasons[0]?.title).toBe('3 of 5 files were deleted')
    expect(many.choices.map((c) => c.id)).toEqual(['recheck', 'stop'])
    // End of pass: the base is the pass's start snapshot, so the run's own deletions count.
    const endOfPass = await check(sc, {
      boundary: 'end-of-pass',
      lastSnapshot: (await sc.shadow.snapshot(RECONCILE_RUN, 'S1')).commit,
      deletionBase: sc.s0.commit,
    })
    expect(endOfPass.verdict).toBe('block')
    expect(rows(endOfPass)).toEqual(['block:mass-deletion'])
  })

  it('index.lock: blocks before the run branch exists, info after', async () => {
    const sc = await reconcileScenario('lock')
    writeFileSync(join(sc.dir, '.git', 'index.lock'), '')
    const before = await check(sc, { boundary: 'pre-implement', branchMode: 'runBranch' })
    expect(before.verdict).toBe('block')
    expect(rows(before)).toEqual(['block:index-lock'])
    const after = await check(sc)
    expect(after.verdict).toBe('info')
    expect(rows(after)).toEqual(['info:index-lock'])
  })

  it('HEAD moved on the same ref: info (diffs are tree-based)', async () => {
    const sc = await reconcileScenario('moved')
    git(sc.dir, ['commit', '-q', '--allow-empty', '-m', 'user commit'])
    const r = await check(sc)
    expect(r.verdict).toBe('info')
    expect(rows(r)).toEqual(['info:head-moved'])
    expect(r.reasons[0]?.title).toBe(`HEAD moved on ${sc.mainName}`)
    expect(r.choices).toEqual([])
  })

  it('bisect in progress: info only, even though HEAD left the branch', async () => {
    const sc = await reconcileScenario('bisect')
    writeFileSync(join(sc.dir, '.git', 'BISECT_LOG'), 'git bisect start\n')
    git(sc.dir, ['checkout', '-q', '--detach'])
    const r = await check(sc)
    expect(r.verdict).toBe('info')
    expect(rows(r)).toEqual(['info:bisect'])
  })

  it('ref switched, branch:none: choice [Continue on <branch>] (default) [Stop] [Recheck]', async () => {
    const sc = await reconcileScenario('switch')
    git(sc.dir, ['checkout', '-q', '-b', 'feature'])
    const r = await check(sc)
    expect(r.verdict).toBe('choice')
    expect(rows(r)).toEqual(['choice:ref-switched'])
    expect(r.choices).toEqual([
      { id: 'continue-on-branch', label: 'Continue on feature', primary: true },
      { id: 'stop', label: 'Stop' },
      { id: 'recheck', label: 'Recheck' },
    ])
    expect(r.defaultChoice).toBe('continue-on-branch')
    expect(r.branch).toBe('feature')
    // After [Continue on feature] the engine records the new HEAD: the next reconcile is clean.
    expect((await check(sc, { expectedHead: await readHead(sc.dir) })).verdict).toBe('clean')
  })

  it('ref switched, runBranch: block even in Auto (no default), before and after the branch exists', async () => {
    const sc = await reconcileScenario('runbranch')
    git(sc.dir, ['checkout', '-q', '-b', 'elsewhere'])
    const beforeCreation = await check(sc, { boundary: 'pre-implement', branchMode: 'runBranch' })
    expect(beforeCreation.verdict).toBe('block')
    expect(rows(beforeCreation)).toEqual(['block:ref-switched'])
    expect(beforeCreation.defaultChoice).toBeUndefined()
    expect(beforeCreation.reasons[0]?.commands.map((c) => c.command)).toEqual([`git checkout ${sc.mainName}`])

    git(sc.dir, ['checkout', '-q', sc.mainName])
    const made = await createRunBranch(sc.repo, 'dim/20261008-reconcile')
    if (!made.ok) throw new Error('create failed')
    const onBranch = await readHead(sc.dir)
    const ok = await check(sc, { branchMode: 'runBranch', runBranch: made.branch, expectedHead: onBranch })
    expect(ok.verdict).toBe('clean')
    git(sc.dir, ['checkout', '-q', sc.mainName])
    const off = await check(sc, { branchMode: 'runBranch', runBranch: made.branch, expectedHead: onBranch })
    expect(off.verdict).toBe('block')
    expect(rows(off)).toEqual(['block:run-branch-not-checked-out'])
    expect(off.defaultChoice).toBeUndefined()
    expect(off.reasons[0]?.commands.map((c) => c.command)).toEqual(['git checkout dim/20261008-reconcile'])
  })

  it('not a git repository: only the folder rows apply', async () => {
    const dir = tempDir('plain')
    for (const f of ['a.txt', 'b.txt']) write(dir, f, `${f}\n`)
    const shadow = await openShadow(dir, { home: tempDir('plain-home') })
    const s0 = await shadow.snapshot('20261008T120000Z-plain', 'S0')
    write(dir, 'a.txt', 'run\n')
    const s1 = await shadow.snapshot('20261008T120000Z-plain', 'S1')
    write(dir, 'b.txt', 'user\n')
    const { result } = await reconcile({
      shadow,
      boundary: 'pre-fix',
      branchMode: 'none',
      expectedHead: null,
      lastSnapshot: s1.commit,
      runStart: s0.commit,
    })
    expect(result.verdict).toBe('info')
    expect(rows(result)).toEqual(['info:external-edits'])
  })
})
