// The reconciliation table as a pure function (src/core/git/reconcile.ts reconcileVerdict): one case
// per row, then how rows combine (the most severe decides; a block never has a default, so Auto never takes it).
import { describe, expect, it } from 'vitest'
import { MASS_DELETION_SHARE, reconcileVerdict } from '../../../src/core/git/reconcile.ts'
import type { ReconcileFacts } from '../../../src/core/git/reconcile.ts'

const C1 = 'a'.repeat(40)
const C2 = 'b'.repeat(40)
const MAIN = 'refs/heads/main'

function facts(
  over: Partial<ReconcileFacts> = {},
  git: Partial<NonNullable<ReconcileFacts['git']>> = {},
): ReconcileFacts {
  return {
    boundary: 'pre-fix',
    branchMode: 'none',
    git: {
      operation: null,
      bisect: false,
      unmergedPaths: [],
      indexLock: false,
      head: { ref: MAIN, commit: C1 },
      expected: { ref: MAIN, commit: C1 },
      ...git,
    },
    deletion: { deleted: 0, tracked: 10 },
    external: [],
    overlapping: [],
    ...over,
  }
}

const rowsOf = (f: ReconcileFacts): string[] =>
  reconcileVerdict(f, { os: 'linux' }).reasons.map((r) => `${r.severity}:${r.row}`)

describe('reconcileVerdict: one case per table row', () => {
  it('nothing to report: clean', () => {
    expect(reconcileVerdict(facts(), { os: 'linux' })).toEqual({
      verdict: 'clean',
      reasons: [],
      paths: { external: [], overlapping: [] },
      choices: [],
      notes: [],
    })
  })

  it.each(['merge', 'rebase', 'am', 'cherry-pick', 'revert'] as const)(
    '%s in progress: block [Recheck] [Stop] with the copyable abort',
    (op) => {
      const r = reconcileVerdict(facts({}, { operation: op }), { os: 'win32' })
      expect(r.verdict).toBe('block')
      expect(r.reasons).toEqual([
        expect.objectContaining({
          row: 'operation',
          severity: 'block',
          op,
          commands: [{ command: `git ${op} --abort`, shell: 'powershell' }],
        }),
      ])
      expect(r.choices).toEqual([
        { id: 'recheck', label: 'Recheck', primary: true },
        { id: 'stop', label: 'Stop' },
      ])
      expect(r.defaultChoice).toBeUndefined()
    },
  )

  it('unmerged paths: block', () => {
    const r = reconcileVerdict(facts({}, { unmergedPaths: ['x.ts', 'y.ts'] }), { os: 'linux' })
    expect(r.verdict).toBe('block')
    expect(r.reasons[0]).toMatchObject({
      row: 'unmerged',
      title: 'The folder has unresolved merge conflicts',
    })
    expect(r.reasons[0]?.detail).toContain('2 files with conflicts: x.ts, y.ts')
  })

  it('mass deletion over 50%: block; exactly half is not', () => {
    expect(MASS_DELETION_SHARE).toBe(0.5)
    const over = reconcileVerdict(facts({ deletion: { deleted: 6, tracked: 10 } }), { os: 'linux' })
    expect(over.verdict).toBe('block')
    expect(over.reasons[0]).toMatchObject({ row: 'mass-deletion', title: '6 of 10 files were deleted' })
    expect(rowsOf(facts({ deletion: { deleted: 5, tracked: 10 } }))).toEqual([])
    expect(rowsOf(facts({ deletion: { deleted: 0, tracked: 0 } }))).toEqual([])
  })

  it('index.lock persists: block before the run branch is made, info after (and for branch:none)', () => {
    const before = facts({ boundary: 'pre-implement', branchMode: 'runBranch' }, { indexLock: true })
    expect(rowsOf(before)).toEqual(['block:index-lock'])
    const after = facts(
      { boundary: 'pre-fix', branchMode: 'runBranch', runBranch: { name: 'dim/x' } },
      {
        indexLock: true,
        head: { ref: 'refs/heads/dim/x', commit: C1 },
        expected: { ref: 'refs/heads/dim/x', commit: C1 },
      },
    )
    expect(rowsOf(after)).toEqual(['info:index-lock'])
    expect(rowsOf(facts({ boundary: 'pre-implement' }, { indexLock: true }))).toEqual(['info:index-lock'])
  })

  it('HEAD moved on the same ref: info', () => {
    const r = reconcileVerdict(facts({}, { head: { ref: MAIN, commit: C2 } }), { os: 'linux' })
    expect(r.verdict).toBe('info')
    expect(r.reasons).toEqual([expect.objectContaining({ row: 'head-moved', title: 'HEAD moved on main' })])
    expect(r.choices).toEqual([])
  })

  it('bisect: info, and it hides the switch to a detached HEAD (branch:none)', () => {
    const f = facts({}, { bisect: true, head: { ref: null, commit: C2 } })
    expect(rowsOf(f)).toEqual(['info:bisect'])
  })

  it('ref switched, branch:none: choice [Continue on <branch>] (default) [Stop] [Recheck]', () => {
    const r = reconcileVerdict(facts({}, { head: { ref: 'refs/heads/feature', commit: C2 } }), {
      os: 'linux',
    })
    expect(r.verdict).toBe('choice')
    expect(r.reasons.map((x) => x.row)).toEqual(['ref-switched'])
    expect(r.choices).toEqual([
      { id: 'continue-on-branch', label: 'Continue on feature', primary: true },
      { id: 'stop', label: 'Stop' },
      { id: 'recheck', label: 'Recheck' },
    ])
    expect(r.defaultChoice).toBe('continue-on-branch')
    expect(r.branch).toBe('feature')
    // A switch to a detached HEAD names the commit.
    const detached = reconcileVerdict(facts({}, { head: { ref: null, commit: C2 } }), { os: 'linux' })
    expect(detached.choices[0]?.label).toBe('Continue on detached HEAD at bbbbbbb')
  })

  it('ref switched, runBranch: block even in Auto (no default)', () => {
    const r = reconcileVerdict(
      facts(
        { boundary: 'pre-implement', branchMode: 'runBranch' },
        { head: { ref: 'refs/heads/feature', commit: C1 } },
      ),
      { os: 'linux' },
    )
    expect(r.verdict).toBe('block')
    expect(r.reasons).toEqual([
      expect.objectContaining({
        row: 'ref-switched',
        commands: [{ command: 'git checkout main', shell: 'sh' }],
      }),
    ])
    expect(r.defaultChoice).toBeUndefined()
  })

  it('the run branch not checked out: block with the copyable checkout, no default', () => {
    const r = reconcileVerdict(
      facts(
        { branchMode: 'runBranch', runBranch: { name: 'dim/20261008-x' } },
        {
          head: { ref: MAIN, commit: C1 },
          expected: { ref: 'refs/heads/dim/20261008-x', commit: C1 },
        },
      ),
      { os: 'linux' },
    )
    expect(r.verdict).toBe('block')
    expect(r.reasons).toEqual([
      expect.objectContaining({
        row: 'run-branch-not-checked-out',
        title: 'The run branch dim/20261008-x is not checked out',
        commands: [{ command: 'git checkout dim/20261008-x', shell: 'sh' }],
      }),
    ])
    expect(r.defaultChoice).toBeUndefined()
  })

  it('external edits at pre-implement: info, folded into S0, chip, no prompt note (even overlapping)', () => {
    const r = reconcileVerdict(
      facts({ boundary: 'pre-implement', external: ['a.ts', 'b.ts'], overlapping: ['a.ts'] }),
      { os: 'linux' },
    )
    expect(r.verdict).toBe('info')
    expect(r.reasons.map((x) => x.row)).toEqual(['external-planning'])
    expect(r.chip).toBe('2 files changed during planning')
    expect(r.notes).toEqual([])
    expect(reconcileVerdict(facts({ boundary: 'pre-implement', external: ['a.ts'] })).chip).toBe(
      '1 file changed during planning',
    )
  })

  it('external edits without overlap: info with the prompt note "User edited outside the run"', () => {
    const r = reconcileVerdict(facts({ external: ['docs/x.md'] }), { os: 'linux' })
    expect(r.verdict).toBe('info')
    expect(r.reasons.map((x) => x.row)).toEqual(['external-edits'])
    expect(r.notes).toEqual(['User edited outside the run: docs/x.md'])
    expect(r.chip).toBeUndefined()
  })

  it("external edits overlapping run paths: choice [Include my edits] (default) [Restore run's version] [Stop]", () => {
    const r = reconcileVerdict(facts({ external: ['a.ts', 'b.ts'], overlapping: ['a.ts'] }), { os: 'linux' })
    expect(r.verdict).toBe('choice')
    expect(r.reasons).toEqual([
      expect.objectContaining({
        row: 'external-overlap',
        title: '1 file the run changed was edited outside it',
      }),
    ])
    expect(r.choices).toEqual([
      { id: 'include-my-edits', label: 'Include my edits', primary: true },
      { id: 'restore-run-version', label: "Restore run's version" },
      { id: 'stop', label: 'Stop' },
    ])
    expect(r.defaultChoice).toBe('include-my-edits')
    expect(r.paths).toEqual({ external: ['a.ts', 'b.ts'], overlapping: ['a.ts'] })
  })
})

describe('reconcileVerdict: rows combined', () => {
  it('the most severe row decides; every row is reported in table order', () => {
    const f = facts(
      { external: ['a.ts'], overlapping: ['a.ts'] },
      { operation: 'merge', unmergedPaths: ['a.ts'], head: { ref: 'refs/heads/other', commit: C2 } },
    )
    const r = reconcileVerdict(f, { os: 'linux' })
    expect(r.verdict).toBe('block')
    expect(r.reasons.map((x) => `${x.severity}:${x.row}`)).toEqual([
      'block:operation',
      'block:unmerged',
      'choice:ref-switched',
      'choice:external-overlap',
    ])
    expect(r.choices.map((c) => c.id)).toEqual(['recheck', 'stop'])
  })

  it('two choice rows: the branch question comes first; the overlap follows on the next reconcile', () => {
    const f = facts(
      { external: ['a.ts'], overlapping: ['a.ts'] },
      { head: { ref: 'refs/heads/other', commit: C1 } },
    )
    const r = reconcileVerdict(f, { os: 'linux' })
    expect(r.verdict).toBe('choice')
    expect(r.defaultChoice).toBe('continue-on-branch')
    const next = reconcileVerdict(
      facts(
        { external: ['a.ts'], overlapping: ['a.ts'] },
        {
          head: { ref: 'refs/heads/other', commit: C1 },
          expected: { ref: 'refs/heads/other', commit: C1 },
        },
      ),
      { os: 'linux' },
    )
    expect(next.defaultChoice).toBe('include-my-edits')
  })

  it('a folder that is not a git repository has only the folder rows', () => {
    expect(rowsOf(facts({ git: null, external: ['x'] }))).toEqual(['info:external-edits'])
    expect(rowsOf(facts({ git: null, deletion: { deleted: 3, tracked: 4 } }))).toEqual([
      'block:mass-deletion',
    ])
  })

  it('long path lists are cut in the prompt note', () => {
    const external = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
    const r = reconcileVerdict(facts({ external }), { os: 'linux' })
    expect(r.notes[0]).toMatch(/^User edited outside the run: f00\.ts, .*f19\.ts and 5 more$/)
  })

  it('no em dash in any text it produces', () => {
    const all = [
      facts({}, { operation: 'rebase', unmergedPaths: ['a'], indexLock: true, bisect: true }),
      facts({ external: ['a'], overlapping: ['a'] }, { head: { ref: 'refs/heads/x', commit: C2 } }),
      facts({ boundary: 'pre-implement', external: ['a'], deletion: { deleted: 9, tracked: 10 } }),
    ].map((f) => JSON.stringify(reconcileVerdict(f, { os: 'linux' })))
    for (const text of all) expect(text).not.toContain('—')
  })
})
