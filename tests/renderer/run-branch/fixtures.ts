// Git card fixtures, shaped as core builds them: a reconcile card carries core's git/reconcile.ts ReconcileResult
// (reasons, paths, choices, defaultChoice) in its payload; planMutated lists the files Plan changed; retryPartial is
// supervisor/cards.ts retryPartialCard.
import type { RecoveryAction } from '@shared/failure.ts'
import type { CardChoice, CardView, RunBranchInfo } from '@shared/run.ts'

export const BASE_SHA = 'a'.repeat(40)

export const RUN_BRANCH: RunBranchInfo = {
  name: 'dim/20261008-add-version-flag',
  base: BASE_SHA,
  previous: 'refs/heads/main',
}

export function overlapCard(
  o: { external?: string[]; overlapping?: string[]; choices?: CardChoice[] } = {},
): CardView {
  const overlapping = o.overlapping ?? ['src/cli.ts', 'src/version.ts']
  return {
    id: 'reconcile-3',
    kind: 'reconcile',
    title: '2 files the run changed were edited outside it',
    body:
      'Dim Factory checked the folder before Review.\n' +
      "- 2 files the run changed were edited outside it: src/cli.ts, src/version.ts. Include your edits, or restore the run's version (you can undo that).",
    // core supervisor/cards.ts reconcileCard's payload (ReconcileCardPayload).
    payload: {
      boundary: 'pre-review',
      step: 'review',
      verdict: 'choice',
      reasons: [
        {
          row: 'external-overlap',
          severity: 'choice',
          title: '2 files the run changed were edited outside it',
          detail:
            "src/cli.ts, src/version.ts. Include your edits, or restore the run's version (you can undo that).",
          actions: [],
        },
      ],
      paths: { external: o.external ?? [...overlapping, 'README.md'], overlapping },
      notes: ['User edited outside the run: README.md, src/cli.ts, src/version.ts'],
    },
    blocking: true,
    defaultChoice: 'include-my-edits',
    choices: o.choices ?? [
      { id: 'include-my-edits', label: 'Include my edits', primary: true },
      { id: 'restore-run-version', label: "Restore run's version" },
      { id: 'stop', label: 'Stop run', danger: true },
    ],
  }
}

export const mergeAbortAction: RecoveryAction = {
  id: 'reconcile.operation.abort',
  label: 'Copy "git merge --abort"',
  kind: 'shell_copy',
  command: 'git merge --abort',
  shell: 'powershell',
  reason: '',
  recheck: '',
}

/**
 * Merge in progress: a block (no default) with Recheck and Stop; the abort command as a `shell_copy` action (core's
 * card) or as git/reconcile.ts's plain `{command, shell}` (an engine that passes the reasons through as they are).
 * Its paths come as git/reconcile.ts ReconcileResult has them (`paths: {external, overlapping}`).
 */
export function blockCard(o: { action?: boolean } = {}): CardView {
  return {
    id: 'reconcile-5',
    kind: 'reconcile',
    title: 'A git merge is in progress',
    body: 'A git merge is in progress in the folder.',
    payload: {
      boundary: 'pre-fix',
      verdict: 'block',
      reasons: [
        {
          row: 'operation',
          severity: 'block',
          op: 'merge',
          title: 'A git merge is in progress',
          detail: 'Finish or abort the merge, then recheck. The run waits until then.',
          ...(o.action === true
            ? { actions: [mergeAbortAction] }
            : { commands: [{ command: 'git merge --abort', shell: 'powershell' }] }),
        },
      ],
      paths: { external: [], overlapping: [] },
    },
    blocking: true,
    choices: [
      { id: 'recheck', label: 'Recheck', primary: true },
      { id: 'stop', label: 'Stop' },
    ],
  }
}

export function planMutatedCard(over: Partial<CardView> = {}): CardView {
  return {
    id: 'planMutated-1',
    kind: 'planMutated',
    title: 'Plan changed files',
    body: 'Plan is meant to only read the folder, but it reported an edit and 2 files changed while it ran.',
    payload: { step: 'plan', paths: ['src/cli.ts', 'notes.md'] },
    blocking: true,
    defaultChoice: 'keep',
    choices: [
      { id: 'revert-plan', label: "Revert Plan's changes" },
      { id: 'keep', label: 'Keep', primary: true },
    ],
    ...over,
  }
}

export function retryPartialCard(): CardView {
  return {
    id: 'retryPartial-1',
    kind: 'retryPartial',
    title: 'Implement left partial changes',
    body: 'Implement changed files before it failed. There is no session to resume, so the retry starts fresh.',
    payload: { step: 'implement', category: 'process_crash' },
    blocking: true,
    defaultChoice: 'keep-changes',
    choices: [
      { id: 'revert-then-fresh', label: 'Revert partial then fresh' },
      { id: 'keep-changes', label: 'Keep changes, fresh', primary: true },
      { id: 'cancel', label: 'Cancel', danger: true },
    ],
  }
}
