// Git effects for the controller (reconciliation, branch prep, revert to S0): run
// git/reconcile.ts for a `reconcile` effect and map its verdict to the engine's ReconcileResult (card copy, copyable
// commands as shell_copy actions), turn branch-prep blockers into a block card, and work out a revert's paths.
import type { RecoveryAction } from '../../shared/failure.ts'
import type { Failure } from '../../shared/failure.ts'
import type { BranchBlocker } from '../git/branch.ts'
import { GitError } from '../git/exec.ts'
import { reconcile } from '../git/reconcile.ts'
import type {
  ReconcileReason,
  ReconcileResult as GitReconcileResult,
  ReconcileFacts,
} from '../git/reconcile.ts'
import type { Shadow } from '../git/shadow.ts'
import type { OsFamily, ShellCommand } from '../heal/commands.ts'
import { RECONCILE_CHOICE } from './cards.ts'
import type {
  EffectOf,
  ReconcileBoundary,
  ReconcileCardInput,
  ReconcileInput,
  ReconcileReasonView,
  ReconcileResult,
} from './types.ts'

/** A copyable command as a `shell_copy` action (recovery.execute finds it in the card payload; never run). */
export function shellCopyAction(id: string, cmd: ShellCommand, reason: string): RecoveryAction {
  return {
    id,
    label: `Copy "${cmd.command}"`,
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason,
    recheck: 'folder.git',
    ...(cmd.elevated === true ? { elevated: true } : {}),
  }
}

function reasonView(r: ReconcileReason): ReconcileReasonView {
  return {
    row: r.row,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    actions: r.commands.map((c, i) => shellCopyAction(`reconcile.${r.row}.${i}`, c, r.title)),
  }
}

/** "A git merge is in progress: Finish or abort …" (cards.ts reasonLine, for run notes). */
const lineOf = (r: { title: string; detail: string }): string =>
  r.detail === '' ? r.title : `${r.title}: ${r.detail}`

/** git/reconcile.ts's verdict as the reducer takes it (types.ts ReconcileResult). */
export function engineReconcileResult(r: GitReconcileResult, facts: ReconcileFacts): ReconcileResult {
  const g = facts.git
  const head = g !== null ? { head: { ref: g.head.ref, commit: g.head.commit } } : {}
  const reasons = r.reasons.map(reasonView)
  switch (r.verdict) {
    case 'clean':
      return { verdict: 'clean', ...head }
    case 'info':
      return {
        verdict: 'info',
        notes: reasons.map(lineOf),
        promptNotes: [...r.notes],
        ...(r.chip !== undefined ? { chip: r.chip } : {}),
        ...head,
      }
    case 'choice':
    case 'block': {
      const card: ReconcileCardInput = {
        verdict: r.verdict,
        reasons,
        external: [...r.paths.external],
        overlapping: [...r.paths.overlapping],
        choices: r.choices.map((c) => ({
          id: c.id,
          label: c.label,
          ...(c.primary === true ? { primary: true } : {}),
        })),
        notes: [...r.notes],
      }
      if (r.defaultChoice !== undefined) card.defaultChoice = r.defaultChoice
      return { verdict: r.verdict, card, ...head }
    }
  }
}

export interface ReconcileRun {
  shadow: Shadow
  boundary: ReconcileBoundary
  input: ReconcileInput
  /** The run's last snapshot (commit or tree), resolved by the controller. */
  last: string
  /** The folder's tree now, when the controller already has it (the end snapshot); else `treeNow`. */
  nowTree?: string
  os: OsFamily
}

/** gatherReconcileFacts → reconcileVerdict → the engine's result. Throws GitError when git cannot be read. */
export async function runReconcile(o: ReconcileRun): Promise<ReconcileResult> {
  const i = o.input
  const { facts, result } = await reconcile({
    shadow: o.shadow,
    boundary: o.boundary,
    branchMode: i.branchMode,
    ...(i.runBranch !== undefined ? { runBranch: i.runBranch } : {}),
    expectedHead:
      i.expectedHead !== undefined ? { ref: i.expectedHead.ref, commit: i.expectedHead.commit } : null,
    lastSnapshot: o.last,
    ...(i.runStart !== undefined ? { runStart: i.runStart } : {}),
    ...(i.ownPaths !== undefined ? { ownPaths: i.ownPaths } : {}),
    ...(i.deletionBase !== undefined ? { deletionBase: i.deletionBase } : {}),
    ...(o.nowTree !== undefined ? { nowTree: o.nowTree } : {}),
    os: o.os,
  })
  return engineReconcileResult(result, facts)
}

/** Branch-prep blockers (git/branch.ts) as a block card: [Recheck] [Stop], each with its copyable commands. */
export function branchBlockedCard(blockers: readonly BranchBlocker[]): ReconcileCardInput {
  return {
    verdict: 'block',
    reasons: blockers.map((b) => ({
      row: `branch-${b.kind}`,
      severity: 'block' as const,
      title: b.title,
      detail: b.detail,
      actions: b.commands.map((c, i) => shellCopyAction(`branch.${b.kind}.${i}`, c, b.title)),
    })),
    external: [],
    overlapping: [],
    choices: [
      { id: RECONCILE_CHOICE.recheck, label: 'Recheck', primary: true },
      { id: RECONCILE_CHOICE.stop, label: 'Stop' },
    ],
    notes: [],
  }
}

/** A git failure of a branch / revert step as a Failure (GitError keeps its category; anything else git_state). */
export function gitFailure(err: unknown, fallback: Failure['category'] = 'git_state'): Failure {
  if (err instanceof GitError) {
    return {
      category: err.category === 'unknown' ? fallback : err.category,
      message: err.message,
      raw: err.stderr.slice(0, 4000),
      classifiedBy: 'app',
    }
  }
  return {
    category: fallback,
    message: err instanceof Error ? err.message : String(err),
    raw: '',
    classifiedBy: 'app',
  }
}

/**
 * The paths a `revert` effect touches (git/revert.ts compares per path, without rename detection): the listed paths
 * plus the other side of any rename among them, or every path the scope changed (both sides of a rename). Both
 * ends of the scope are explicit snapshots: never the shadow's latest ref, which a `pre-revert` may have moved.
 * undefined = every difference (no scope and no paths).
 */
export async function revertPaths(
  shadow: Shadow,
  e: Pick<EffectOf<'revert'>, 'paths' | 'scope'>,
): Promise<string[] | undefined> {
  if (e.scope === undefined) return e.paths !== undefined ? [...e.paths] : undefined
  const changes = await shadow.changes(e.scope.from, e.scope.to)
  const groups = changes.map((c) => (c.oldPath !== undefined ? [c.path, c.oldPath] : [c.path]))
  if (e.paths === undefined) return [...new Set(groups.flat())].sort()
  const want = new Set(e.paths)
  const out = new Set(e.paths)
  for (const g of groups) if (g.some((p) => want.has(p))) for (const p of g) out.add(p)
  return [...out].sort()
}
