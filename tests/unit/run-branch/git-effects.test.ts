// Controller-side mapping (src/core/supervisor/git-effects.ts) and the reconcile / planMutated card builders
// (src/core/supervisor/cards.ts): git/reconcile.ts verdicts → the engine's ReconcileResult, copyable commands as
// shell_copy actions, branch-prep blockers as a block card, a revert's paths (renames on both sides).
import { describe, expect, it } from 'vitest'
import type { FileChange } from '@shared/ipc.ts'
import { reconcileVerdict } from '@core/git/reconcile.ts'
import type { ReconcileFacts } from '@core/git/reconcile.ts'
import type { Shadow } from '@core/git/shadow.ts'
import { planMutatedCard, reconcileCard, reconcilePayloadOf } from '@core/supervisor/cards.ts'
import { branchBlockedCard, engineReconcileResult, revertPaths } from '@core/supervisor/git-effects.ts'
import { payloadActions } from '@core/recovery/dispatcher.ts'

const MAIN = { ref: 'refs/heads/main', commit: 'a'.repeat(40) }

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
      head: MAIN,
      expected: MAIN,
      ...git,
    },
    deletion: { deleted: 0, tracked: 10 },
    external: [],
    overlapping: [],
    ...over,
  }
}

const map = (f: ReconcileFacts) => engineReconcileResult(reconcileVerdict(f, { os: 'win32' }), f)

describe('engineReconcileResult', () => {
  it('clean carries the observed HEAD', () => {
    expect(map(facts())).toEqual({ verdict: 'clean', head: MAIN })
    expect(map(facts({ git: null }))).toEqual({ verdict: 'clean' })
  })

  it('info at pre-implement: a run note and the chip; no prompt notes', () => {
    const r = map(facts({ boundary: 'pre-implement', external: ['a.ts', 'b.ts'] }))
    expect(r).toEqual({
      verdict: 'info',
      notes: ['2 files changed during planning: Implement starts from the folder as it is now.'],
      promptNotes: [],
      chip: '2 files changed during planning',
      head: MAIN,
    })
  })

  it('info with external edits apart from the run: the prompt note "User edited outside the run: …"', () => {
    const r = map(facts({ external: ['README.md'] }))
    expect(r).toMatchObject({
      verdict: 'info',
      notes: ['1 file edited outside the run: README.md. The next step is told about them.'],
      promptNotes: ['User edited outside the run: README.md'],
    })
  })

  it('block (merge in progress): the copyable abort as a shell_copy action recovery.execute finds; no default', () => {
    const r = map(facts({}, { operation: 'merge', unmergedPaths: ['src/a.ts'] }))
    if (r.verdict !== 'block') throw new Error(r.verdict)
    expect(r.card.defaultChoice).toBeUndefined()
    expect(r.card.choices.map((c) => c.id)).toEqual(['recheck', 'stop'])
    expect(r.card.reasons.map((x) => x.row)).toEqual(['operation', 'unmerged'])
    expect(r.card.reasons[0]?.actions).toEqual([
      {
        id: 'reconcile.operation.0',
        label: 'Copy "git merge --abort"',
        kind: 'shell_copy',
        command: 'git merge --abort',
        shell: 'powershell',
        reason: 'A git merge is in progress',
        recheck: 'folder.git',
      },
    ])
    const view = reconcileCard('reconcile-1', { boundary: 'pre-fix', step: 'fix', input: r.card, head: MAIN })
    expect(payloadActions(view.payload).map((a) => a.id)).toEqual(['reconcile.operation.0'])
    expect(view.title).toBe('A git merge is in progress (and 1 more)')
    expect(view.body.split('\n')[0]).toBe('Dim Factory checked the folder before Fix.')
  })

  it('choice (ref switched, branch none): Continue on <branch> is the default; runBranch makes it a block', () => {
    const switched = facts({}, { head: { ref: 'refs/heads/feature', commit: 'b'.repeat(40) } })
    const r = map(switched)
    if (r.verdict !== 'choice') throw new Error(r.verdict)
    expect(r.card.defaultChoice).toBe('continue-on-branch')
    expect(r.card.choices[0]).toEqual({
      id: 'continue-on-branch',
      label: 'Continue on feature',
      primary: true,
    })
    const strict = map({ ...switched, branchMode: 'runBranch', boundary: 'pre-implement' })
    expect(strict.verdict).toBe('block')
    if (strict.verdict === 'block') expect(strict.card.defaultChoice).toBeUndefined()
  })

  it('choice (overlap): Include my edits by default; the prompt notes go with the card', () => {
    const r = map(facts({ external: ['src/a.ts'], overlapping: ['src/a.ts'] }))
    if (r.verdict !== 'choice') throw new Error(r.verdict)
    expect(r.card).toMatchObject({
      defaultChoice: 'include-my-edits',
      external: ['src/a.ts'],
      overlapping: ['src/a.ts'],
      notes: ['User edited outside the run: src/a.ts'],
    })
  })
})

describe('cards', () => {
  it('reconcileCard: Stop reads "Stop run" (danger); a block never carries a default; the payload reads back', () => {
    const r = map(facts({ external: ['src/a.ts'], overlapping: ['src/a.ts'] }))
    if (r.verdict !== 'choice') throw new Error(r.verdict)
    const view = reconcileCard('reconcile-2', {
      boundary: 'end-of-pass',
      step: 'implement',
      input: r.card,
      head: MAIN,
    })
    expect(view).toMatchObject({ kind: 'reconcile', blocking: true, defaultChoice: 'include-my-edits' })
    expect(view.choices.find((c) => c.id === 'stop')).toEqual({ id: 'stop', label: 'Stop run', danger: true })
    expect(view.body.split('\n')[0]).toBe('Dim Factory checked the folder after Implement.')
    expect(reconcilePayloadOf(view)).toEqual({
      boundary: 'end-of-pass',
      step: 'implement',
      verdict: 'choice',
      reasons: r.card.reasons,
      paths: { external: ['src/a.ts'], overlapping: ['src/a.ts'] },
      notes: ['User edited outside the run: src/a.ts'],
      head: MAIN,
    })
    const block = reconcileCard('reconcile-3', {
      boundary: 'pre-implement',
      input: { ...r.card, verdict: 'block' },
    })
    expect(block.defaultChoice).toBeUndefined()
    expect(reconcilePayloadOf({ ...block, kind: 'stall' })).toBeUndefined()
  })

  it('planMutated: names the files; Revert first, no default', () => {
    const c = planMutatedCard('planMutated-1', ['a.md', 'b.md'])
    expect(c.body).toBe(
      "The Plan step should only read, but 2 files changed while it ran: a.md, b.md. Revert Plan's changes (you can undo that), or keep them.",
    )
    expect(c.choices).toEqual([
      { id: 'revert-plan', label: "Revert Plan's changes", primary: true },
      { id: 'keep', label: 'Keep' },
    ])
    expect(c.defaultChoice).toBeUndefined()
    expect(planMutatedCard('planMutated-2', []).body).toContain('but files changed while it ran.')
  })

  it('branchBlockedCard: each blocker a block reason with its commands; Recheck / Stop', () => {
    const card = branchBlockedCard([
      {
        kind: 'operation',
        op: 'rebase',
        title: 'A git rebase is in progress',
        detail: 'Finish or abort the rebase first, then check again.',
        commands: [{ command: 'git rebase --abort', shell: 'sh' }],
      },
    ])
    expect(card).toMatchObject({
      verdict: 'block',
      reasons: [
        {
          row: 'branch-operation',
          severity: 'block',
          actions: [
            { id: 'branch.operation.0', kind: 'shell_copy', command: 'git rebase --abort', shell: 'sh' },
          ],
        },
      ],
      choices: [
        { id: 'recheck', label: 'Recheck', primary: true },
        { id: 'stop', label: 'Stop' },
      ],
    })
  })
})

describe('revertPaths', () => {
  const change = (path: string, oldPath?: string): FileChange => ({
    status: oldPath !== undefined ? 'R' : 'M',
    path,
    ...(oldPath !== undefined ? { oldPath } : {}),
    oldMode: '100644',
    newMode: '100644',
    oldSha: '0'.repeat(40),
    newSha: '1'.repeat(40),
    added: 1,
    deleted: 1,
    binary: false,
    gitlink: false,
    eolOnly: false,
  })
  const shadow = (changes: FileChange[], latest = 'c'.repeat(40)) =>
    ({
      changes: (a: string, b: string) => {
        expect(a).toBe('a'.repeat(40))
        expect(b).toBe(latest)
        return Promise.resolve(changes)
      },
      // The shadow's latest ref may be a `pre-revert`: never a range end (review finding).
      runRef: () => {
        throw new Error('revertPaths must not read the run ref')
      },
    }) as unknown as Shadow

  it('no scope: the listed paths, or every difference', async () => {
    expect(await revertPaths(shadow([]), { paths: ['x'] })).toEqual(['x'])
    expect(await revertPaths(shadow([]), {})).toBeUndefined()
  })

  it('scope without paths: every path the scope changed, both sides of a rename (both ends explicit)', async () => {
    const s = shadow([change('b.ts', 'a.ts'), change('c.ts')])
    expect(await revertPaths(s, { scope: { from: 'a'.repeat(40), to: 'c'.repeat(40) } })).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ])
  })

  it('listed paths take the other side of their rename along', async () => {
    const s = shadow([change('b.ts', 'a.ts'), change('c.ts')], 'd'.repeat(40))
    expect(
      await revertPaths(s, { paths: ['b.ts'], scope: { from: 'a'.repeat(40), to: 'd'.repeat(40) } }),
    ).toEqual(['a.ts', 'b.ts'])
  })
})
