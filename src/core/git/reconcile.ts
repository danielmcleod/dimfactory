// Reconciliation at pass boundaries (R5, R6/R7, R10, P15). Two parts:
// gatherReconcileFacts reads the user's repo (`--no-optional-locks`) and compares shadow trees (no ref moves), and
// reconcileVerdict is a pure function from those facts to the table's verdict, reasons and card choices.
import { osFamily, repairCommand } from '../heal/commands.ts'
import type { OsFamily, ShellCommand } from '../heal/commands.ts'
import type { RunBranchInfo } from '../../shared/run.ts'
import { INDEX_LOCK_WAIT_MS, headLabel, lockPersists, readRepoState } from './branch.ts'
import type { GitOp, HeadState } from './branch.ts'
import { GitError, splitNul } from './exec.ts'
import { parseRawZ } from './patch.ts'
import { revertTo } from './revert.ts'
import type { RevertToResult } from './revert.ts'
import type { Shadow } from './shadow.ts'
import { BRAND } from '../../shared/brand.ts'

/** Where reconcile runs (same union as supervisor/types.ts `ReconcileBoundary`). */
export type ReconcileBoundary = 'pre-implement' | 'pre-review' | 'pre-fix' | 'pre-apply' | 'end-of-pass'

/** One row of the reconciliation table. */
export type ReconcileRowId =
  | 'operation'
  | 'unmerged'
  | 'mass-deletion'
  | 'index-lock'
  | 'head-moved'
  | 'bisect'
  | 'ref-switched'
  | 'run-branch-not-checked-out'
  | 'external-planning'
  | 'external-edits'
  | 'external-overlap'

export type ReconcileChoiceId =
  'continue-on-branch' | 'include-my-edits' | 'restore-run-version' | 'stop' | 'recheck'

export type ReconcileVerdict = 'clean' | 'info' | 'choice' | 'block'

/** More than this share of the base snapshot's files gone is a mass deletion (> 50%). */
export const MASS_DELETION_SHARE = 0.5
/** Paths named in a prompt note before "and N more". */
const NOTE_PATHS_MAX = 20

export interface ReconcileFacts {
  boundary: ReconcileBoundary
  branchMode: 'none' | 'runBranch'
  /** The run branch once created (runBranch mode). Absent before creation. */
  runBranch?: Pick<RunBranchInfo, 'name'>
  /** Git facts; null for a folder that is not a git repository (or one git refuses to read). */
  git: {
    operation: Exclude<GitOp, 'bisect'> | null
    bisect: boolean
    unmergedPaths: string[]
    /** `index.lock` existed and was still there after the 3 s wait. */
    indexLock: boolean
    head: HeadState
    /** Where HEAD was at the run's start, after branch creation, or after a [Continue on <branch>]. */
    expected: HeadState | null
  } | null
  /** Files of the deletion base missing now, out of the base's file count. */
  deletion: { deleted: number; tracked: number }
  /** Paths changed outside the run since its last snapshot (Dim Factory's own reverts excluded). */
  external: string[]
  /** The external paths the run itself changed too. */
  overlapping: string[]
}

export interface ReconcileReason {
  row: ReconcileRowId
  severity: 'block' | 'choice' | 'info'
  /** UI copy (no em dashes). */
  title: string
  detail: string
  op?: GitOp
  /** Copyable commands (`shell_copy`), never run by Dim Factory. */
  commands: ShellCommand[]
}

/** Card choices, shaped like CardChoice. */
export interface ReconcileChoice {
  id: ReconcileChoiceId
  label: string
  primary?: boolean
}

/**
 * What the engine turns into a reconcile card (or a note). `choices` and `defaultChoice` belong to the first row of
 * the deciding severity; every row found is in `reasons`. A block has no default, so Auto never takes it. After
 * [Continue on <branch>] the engine records the new expected HEAD and reconciles again (another row may follow).
 */
export interface ReconcileResult {
  verdict: ReconcileVerdict
  reasons: ReconcileReason[]
  paths: { external: string[]; overlapping: string[] }
  choices: ReconcileChoice[]
  defaultChoice?: ReconcileChoiceId
  /**
   * Prompt notes for the next pass ("User edited outside the run: …"): applied as is for an info verdict, and with
   * [Include my edits] for the overlap choice.
   */
  notes: string[]
  /** pre-implement: the "N files changed during planning" chip. */
  chip?: string
  /** The branch [Continue on <branch>] names. */
  branch?: string
}

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, NOTE_PATHS_MAX).join(', ')
  return paths.length > NOTE_PATHS_MAX ? `${shown} and ${paths.length - NOTE_PATHS_MAX} more` : shown
}

/** The reconciliation table, row by row, as reasons in table order. */
function rowsOf(f: ReconcileFacts, os: OsFamily): ReconcileReason[] {
  const out: ReconcileReason[] = []
  const g = f.git
  if (g !== null && g.operation !== null) {
    const fix = repairCommand('abort', os, g.operation)
    out.push({
      row: 'operation',
      severity: 'block',
      op: g.operation,
      title: `A git ${g.operation} is in progress`,
      detail: `Finish or abort the ${g.operation}, then recheck. The run waits until then.`,
      commands: fix === null ? [] : [fix],
    })
  }
  if (g !== null && g.unmergedPaths.length > 0) {
    out.push({
      row: 'unmerged',
      severity: 'block',
      title: 'The folder has unresolved merge conflicts',
      detail: `${plural(g.unmergedPaths.length, 'file')} with conflicts: ${pathList(g.unmergedPaths)}. Resolve them, then recheck.`,
      commands: [],
    })
  }
  const { deleted, tracked } = f.deletion
  if (tracked > 0 && deleted / tracked > MASS_DELETION_SHARE) {
    out.push({
      row: 'mass-deletion',
      severity: 'block',
      title: `${deleted} of ${plural(tracked, 'file')} were deleted`,
      detail:
        'More than half of the folder is gone since the last snapshot. Restore the files, then recheck, or stop the run.',
      commands: [],
    })
  }
  if (g !== null && g.indexLock) {
    const beforeCreation =
      f.branchMode === 'runBranch' && f.runBranch === undefined && f.boundary === 'pre-implement'
    out.push({
      row: 'index-lock',
      severity: beforeCreation ? 'block' : 'info',
      title: 'Another git process holds the index lock',
      detail: beforeCreation
        ? 'index.lock has existed for more than 3 seconds, so the run branch cannot be made. Wait for the other git command to finish; if none is running, delete the index.lock file in the .git folder.'
        : 'index.lock has existed for more than 3 seconds. The run does not need it.',
      commands: [],
    })
  }
  if (g !== null) {
    const head = g.head
    const expected = g.expected
    if (f.branchMode === 'runBranch') {
      if (f.runBranch !== undefined) {
        const ref = `refs/heads/${f.runBranch.name}`
        if (head.ref !== ref) {
          const fix = repairCommand('checkoutBranch', os, ref)
          out.push({
            row: 'run-branch-not-checked-out',
            severity: 'block',
            title: `The run branch ${f.runBranch.name} is not checked out`,
            detail: `The folder is on ${headLabel(head)}. Check out ${f.runBranch.name} again, then recheck, or stop the run.`,
            commands: fix === null ? [] : [fix],
          })
        }
      } else if (expected !== null && head.ref !== expected.ref) {
        const fix = expected.ref !== null ? repairCommand('checkoutBranch', os, expected.ref) : null
        out.push({
          row: 'ref-switched',
          severity: 'block',
          title: `The folder switched to ${headLabel(head)}`,
          detail: `The run started on ${headLabel(expected)} and makes its branch from there. Switch back, then recheck, or stop the run.`,
          commands: fix === null ? [] : [fix],
        })
      }
    } else if (expected !== null && head.ref !== expected.ref && !g.bisect) {
      out.push({
        row: 'ref-switched',
        severity: 'choice',
        title: `The folder switched to ${headLabel(head)}`,
        detail: `The run started on ${headLabel(expected)}. Diffs compare snapshots, so the run can continue on ${headLabel(head)}.`,
        commands: [],
      })
    }
    if (expected !== null && head.ref === expected.ref && head.commit !== expected.commit && !g.bisect) {
      out.push({
        row: 'head-moved',
        severity: 'info',
        title: `HEAD moved on ${headLabel(head)}`,
        detail: 'New commits do not change the run: diffs compare snapshots, not commits.',
        commands: [],
      })
    }
    if (g.bisect) {
      out.push({
        row: 'bisect',
        severity: 'info',
        title: 'A git bisect is in progress',
        detail: 'Diffs compare snapshots, so the bisect does not change the run.',
        commands: [],
      })
    }
  }
  const n = f.external.length
  if (n > 0) {
    if (f.boundary === 'pre-implement') {
      out.push({
        row: 'external-planning',
        severity: 'info',
        title: `${plural(n, 'file')} changed during planning`,
        detail: 'Implement starts from the folder as it is now.',
        commands: [],
      })
    } else if (f.overlapping.length > 0) {
      const m = f.overlapping.length
      out.push({
        row: 'external-overlap',
        severity: 'choice',
        title: `${plural(m, 'file')} the run changed ${m === 1 ? 'was' : 'were'} edited outside it`,
        detail: `${pathList(f.overlapping)}. Include your edits, or restore the run's version (you can undo that).`,
        commands: [],
      })
    } else {
      out.push({
        row: 'external-edits',
        severity: 'info',
        title: `${plural(n, 'file')} edited outside the run`,
        detail: `${pathList(f.external)}. The next step is told about them.`,
        commands: [],
      })
    }
  }
  return out
}

const RANK: Readonly<Record<ReconcileVerdict, number>> = { clean: 0, info: 1, choice: 2, block: 3 }

/** The reconciliation table as a pure function. */
export function reconcileVerdict(facts: ReconcileFacts, o: { os?: OsFamily } = {}): ReconcileResult {
  const os = o.os ?? osFamily()
  const reasons = rowsOf(facts, os)
  let verdict: ReconcileVerdict = 'clean'
  for (const r of reasons) if (RANK[r.severity] > RANK[verdict]) verdict = r.severity
  const result: ReconcileResult = {
    verdict,
    reasons,
    paths: { external: [...facts.external], overlapping: [...facts.overlapping] },
    choices: [],
    notes: [],
  }
  const planning = reasons.find((r) => r.row === 'external-planning')
  if (planning !== undefined) result.chip = planning.title
  if (facts.boundary !== 'pre-implement' && facts.external.length > 0) {
    result.notes.push(`User edited outside the run: ${pathList(facts.external)}`)
  }
  if (verdict === 'block') {
    result.choices = [
      { id: 'recheck', label: 'Recheck', primary: true },
      { id: 'stop', label: 'Stop' },
    ]
  } else if (verdict === 'choice') {
    const first = reasons.find((r) => r.severity === 'choice')
    if (first?.row === 'ref-switched' && facts.git !== null) {
      const branch = headLabel(facts.git.head)
      result.branch = branch
      result.choices = [
        { id: 'continue-on-branch', label: `Continue on ${branch}`, primary: true },
        { id: 'stop', label: 'Stop' },
        { id: 'recheck', label: 'Recheck' },
      ]
      result.defaultChoice = 'continue-on-branch'
    } else {
      result.choices = [
        { id: 'include-my-edits', label: 'Include my edits', primary: true },
        { id: 'restore-run-version', label: "Restore run's version" },
        { id: 'stop', label: 'Stop' },
      ]
      result.defaultChoice = 'include-my-edits'
    }
  }
  return result
}

// ---- fact gathering --------------------------------------------------------------------------------------------

export interface GatherReconcileOptions {
  shadow: Shadow
  boundary: ReconcileBoundary
  branchMode: 'none' | 'runBranch'
  /** The run branch once created (run.json `branch`). */
  runBranch?: RunBranchInfo | null
  /** Where HEAD was at the run's start (or after branch creation / an accepted switch); null: not recorded. */
  expectedHead: HeadState | null
  /** The run's last snapshot (commit or tree): external edits are the folder now against it. */
  lastSnapshot: string
  /** The run's own changes are `runStart..lastSnapshot` (S0, or run-start before Implement). Absent: none yet. */
  runStart?: string
  /** Paths Dim Factory itself wrote since lastSnapshot (a revert, a restore): never external. */
  ownPaths?: readonly string[]
  /** Mass-deletion base (default lastSnapshot; end-of-pass passes the pass's start snapshot). */
  deletionBase?: string
  /** The folder's tree now, when the caller has it (default: `shadow.treeNow()`, which moves no ref). */
  nowTree?: string
  /** How long `index.lock` may exist before it counts (default 3 s). */
  lockWaitMs?: number
}

/** One of the shadow's own refs. */
const OWN_REF = new RegExp(`^${BRAND.refNamespace}[A-Za-z0-9._/-]+$`)

function assertRev(rev: string): string {
  if (/^[0-9a-f]{40,64}$/i.test(rev) || OWN_REF.test(rev)) return rev
  throw new GitError('exit', `invalid snapshot: ${JSON.stringify(rev)}`, {
    args: [],
    category: 'snapshot_failed',
  })
}

const BIG_OUTPUT = 256 * 1024 * 1024
const GITLINK = '160000'

/** Files changed between two shadow trees, both sides of every change (`--no-renames`), gitlinks left out. */
async function changedPaths(
  shadow: Shadow,
  a: string,
  b: string,
): Promise<{ path: string; status: string }[]> {
  // The same object on both sides (an end-of-pass check compares the end snapshot's tree with itself).
  if (a === b) return []
  const r = await shadow.git(['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-ext-diff', a, b], {
    maxBytes: BIG_OUTPUT,
  })
  return parseRawZ(r.stdout)
    .filter((c) => c.oldMode !== GITLINK && c.newMode !== GITLINK)
    .map((c) => ({ path: c.path, status: c.status }))
}

/**
 * Facts for reconcileVerdict. Reads only: the user's repo (`--no-optional-locks`: HEAD, operation markers, unmerged
 * paths, index.lock) and shadow trees (the folder now via `treeNow`, a scratch index; no ref moves).
 */
export async function gatherReconcileFacts(o: GatherReconcileOptions): Promise<ReconcileFacts> {
  const shadow = o.shadow
  const last = assertRev(o.lastSnapshot)
  const fold = shadow.scope.caseInsensitive
  const key = (p: string): string => (fold ? p.toLowerCase() : p)
  let git: ReconcileFacts['git'] = null
  const repo = shadow.scope.repo
  const statePromise =
    shadow.scope.isRepo && !repo.dubiousOwnership ? readRepoState(repo) : Promise.resolve(null)
  const nowPromise =
    o.nowTree !== undefined ? Promise.resolve(assertRev(o.nowTree)) : shadow.treeNow().then((t) => t.tree)
  const [state, now] = await Promise.all([statePromise, nowPromise])
  if (state !== null && !state.dubiousOwnership) {
    const indexLock =
      state.indexLock && state.indexLockPath !== null
        ? await lockPersists(state.indexLockPath, o.lockWaitMs ?? INDEX_LOCK_WAIT_MS)
        : false
    git = {
      operation: state.operation,
      bisect: state.bisect,
      unmergedPaths: state.unmergedPaths,
      indexLock,
      head: { ref: state.ref, commit: state.commit },
      expected: o.expectedHead,
    }
  }
  const own = new Set((o.ownPaths ?? []).map(key))
  const sinceLast = (await changedPaths(shadow, last, now)).filter((c) => !own.has(key(c.path)))
  const external = [...new Set(sinceLast.map((c) => c.path))].sort()
  let runPaths = new Set<string>()
  // Only external edits can overlap: without any, the run's own paths are not read.
  if (o.runStart !== undefined && external.length > 0) {
    const start = assertRev(o.runStart)
    runPaths = new Set((await changedPaths(shadow, start, last)).map((c) => key(c.path)))
  }
  const overlapping = external.filter((p) => runPaths.has(key(p)))
  const base = o.deletionBase !== undefined ? assertRev(o.deletionBase) : last
  const deletedPaths =
    base === last
      ? sinceLast.filter((c) => c.status === 'D')
      : (await changedPaths(shadow, base, now)).filter((c) => c.status === 'D' && !own.has(key(c.path)))
  let tracked = 0
  if (deletedPaths.length > 0) {
    const ls = await shadow.git(['ls-tree', '-r', '-z', '--name-only', base], { maxBytes: BIG_OUTPUT })
    tracked = splitNul(ls.stdout).length
  }
  const facts: ReconcileFacts = {
    boundary: o.boundary,
    branchMode: o.branchMode,
    git,
    deletion: { deleted: deletedPaths.length, tracked },
    external,
    overlapping,
  }
  if (o.runBranch !== undefined && o.runBranch !== null) facts.runBranch = { name: o.runBranch.name }
  return facts
}

/** gatherReconcileFacts → reconcileVerdict. */
export async function reconcile(
  o: GatherReconcileOptions & { os?: OsFamily },
): Promise<{ facts: ReconcileFacts; result: ReconcileResult }> {
  const facts = await gatherReconcileFacts(o)
  return { facts, result: reconcileVerdict(facts, o.os !== undefined ? { os: o.os } : {}) }
}

/**
 * [Restore run's version] (undoable): the overlapping paths back to the run's last snapshot. The `pre-revert`
 * snapshot taken first holds the user's edits; undoRevert(outcome) brings them back.
 */
export function restoreRunVersion(
  shadow: Shadow,
  o: { runId: string; lastSnapshot: string; paths: readonly string[]; folderHeld?: boolean },
): Promise<RevertToResult> {
  return revertTo(shadow, o.lastSnapshot, {
    runId: o.runId,
    paths: o.paths,
    ...(o.folderHeld !== undefined ? { folderHeld: o.folderHeld } : {}),
  })
}
