// ISO_API (isolated runs, the verify:0 baseline, run.isolation.verifyReady): what the run
// controller calls to prepare an isolated run (worktree, copy-ins, deps, readiness, the baseline file) and to finalize it
// (preview, apply with its journal, finish, undo, discard). The default is the real modules (git/worktree.ts,
// git/finalize.ts, src/core/prepare); tests inject fakes with the same signatures, as HEAL_API does for the healer.
import { runBranchBaseName } from '../git/branch.ts'
import {
  applyRun,
  completeDiscard,
  discardRun,
  fileJournal,
  finishApply,
  interruptedOp,
  journalFile,
  lastAppliedOp,
  previewApply,
  recordWorktree,
  undoApply,
} from '../git/finalize.ts'
import { createSnapshotCopy } from '../git/snapshot-copy.ts'
import { checkEligibility, createWorktree, uncommittedCount } from '../git/worktree.ts'
import { checkVerifyReady, copyIns, decideDepsStage, runInstall, writeBaseline } from '../prepare/index.ts'

export interface IsolationApi {
  checkEligibility: typeof checkEligibility
  createWorktree: typeof createWorktree
  /** A copy written from a snapshot of the folder instead of a git worktree (a match's sides). */
  createCopy: typeof createSnapshotCopy
  recordWorktree: typeof recordWorktree
  uncommittedCount: typeof uncommittedCount
  copyIns: typeof copyIns
  decideDepsStage: typeof decideDepsStage
  runInstall: typeof runInstall
  checkVerifyReady: typeof checkVerifyReady
  writeBaseline: typeof writeBaseline
  previewApply: typeof previewApply
  applyRun: typeof applyRun
  finishApply: typeof finishApply
  undoApply: typeof undoApply
  discardRun: typeof discardRun
  completeDiscard: typeof completeDiscard
  /**
   * The journal's apply a crash left part way, and its latest finished one (git/finalize.ts). Chaos: `removed`
   * once the journal says the worktree was deleted, and `undone`, the applies it says were undone (work that finished
   * before Dim Factory could record it).
   */
  journalState: (
    home: string,
    runId: string,
  ) => Promise<{ open?: string; lastApplied?: JournalApply; removed?: true; undone?: string[] }>
}

/** A finished apply as the journal holds it (the engine reads it back when a relaunch lost its result). */
export interface JournalApply {
  token: string
  applied: string[]
  conflicts: string[]
}

export const ISO_API: IsolationApi = {
  checkEligibility,
  createWorktree,
  createCopy: createSnapshotCopy,
  recordWorktree,
  uncommittedCount,
  copyIns,
  decideDepsStage,
  runInstall,
  checkVerifyReady,
  writeBaseline,
  previewApply,
  applyRun,
  finishApply,
  undoApply,
  discardRun,
  completeDiscard,
  journalState: async (home, runId) => {
    const j = await fileJournal(journalFile(home, runId)).read()
    const open = interruptedOp(j)
    const last = lastAppliedOp(j)
    const entries = last?.entries ?? []
    const undone = j.ops.filter((o) => o.state === 'undone').map((o) => o.token)
    return {
      ...(open !== undefined ? { open: open.token } : {}),
      ...(j.discard?.state === 'removed' || j.worktree?.state === 'removed'
        ? { removed: true as const }
        : {}),
      ...(undone.length > 0 ? { undone } : {}),
      ...(last !== undefined
        ? {
            lastApplied: {
              token: last.token,
              applied: entries
                .filter((e) => e.outcome === 'written' || e.outcome === 'deleted')
                .map((e) => e.path),
              conflicts: entries.filter((e) => e.outcome === 'conflict').map((e) => e.path),
            },
          }
        : {}),
    }
  },
}

/**
 * The isolated run's branch (`worktree add -b`): the run-branch name of its creation date and task plus the run id's
 * last four characters, so it is the same on every Resume (createWorktree adopts the run's own worktree by it) and two
 * runs of one task the same day never collide.
 */
export function worktreeBranchName(prefix: string, createdAt: number, task: string, runId: string): string {
  return `${runBranchBaseName(prefix, new Date(createdAt), task)}-${runId.slice(-4)}`
}
