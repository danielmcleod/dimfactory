// Stop (the run is cancelled; toast "Run stopped · changes kept [Revert all]"; R13, stop.spec.ts).
// After a user Stop, the toast appears once core reports the run cancelled, wherever the user is by then. Revert all
// is diff.revert for the run with an Undo toast (revert.ts). It waits, disabled with the reason beside it, while
// the folder is busy: the stopped run's process is still ending (core's phase `stopping`), or another run holds the
// folder; the toast follows core's summaries, so the action turns available while it shows.
// A stopped isolated run keeps its copy, never auto-deleted: an isolated run
// changed only its isolated copy, so its toast says where the changes are and offers the Diff tab's "Apply to folder…"
// panel instead of Revert all (which would revert the copy, never the folder). The words follow core's
// finalize state (RunSummary.worktree): a run stopped after part of it was applied says so and offers that apply's
// Undo (core's token from the run's snapshot; the Diff tab's panel when the snapshot is not loaded).
// A stopped run (user_cancelled) continues only through Re-run and Re-run from Fix: while core says Re-run from
// Fix is available for the run, the toast offers it too; it opens the findings picker in the run's Flow tab. Core's
// word is the summary's (RunSummary.rerunFromFix), which arrives with the cancelled status the toast waits for.
import { navigate } from '../../lib/router.ts'
import { useStore } from '../../state/store.ts'
import type { StoreState } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import type { ToastActionSpec } from '../../state/toasts.ts'
import { APPLY_TITLE } from '../diff/text.ts'
import { runCommand } from './commands.ts'
import { finalizeInfoOf } from './isolation.ts'
import {
  openFixPicker,
  RERUN_FROM_FIX_LABEL,
  rerunFromFixOf,
  rerunFromFixUnavailableReason,
} from './rerun.ts'
import type { RerunFromFixFacts } from './rerun.ts'
import { folderBusyReason, REVERT_ALL_LABEL, revertAll } from './revert.ts'
import { undoApply } from './worktree.ts'

export const STOPPED_MESSAGE = 'Run stopped · changes kept'
/** An isolated run stopped with its copy kept (what it changed there is not in the folder). */
export const STOPPED_ISOLATED_MESSAGE = 'Run stopped · its isolated copy is kept'
/** An isolated run stopped with no copy, a discarded copy, or nothing to apply: the folder has none of it. */
export const STOPPED_ISOLATED_CLEAN = 'Run stopped · your folder is unchanged'
/** An isolated run stopped after part of it was applied to the folder. */
export const STOPPED_ISOLATED_APPLIED = 'Run stopped · some of its changes are in your folder'
export const UNDO_APPLY_LABEL = 'Undo the apply'
/** Give up waiting for the cancelled status after this long (core stops within seconds; kill after 3 s). */
const WATCH_MS = 120_000
/** The stopped toast stays a while: Revert all may wait for the process to end first. */
const STOPPED_TOAST_MS = 15_000

const watching = new Map<string, () => void>()

/**
 * Core's Re-run from Fix facts for the run: its summary's (core sends them with the summary that says cancelled, the
 * one the toast waits for), else its loaded snapshot's (refetched a moment later, so it may still describe the run
 * before the Stop).
 */
function fixFacts(s: StoreState, runId: string): RerunFromFixFacts | null {
  return rerunFromFixOf(s.summaries.byId[runId], s.runs.byId[runId]?.snapshot ?? null)
}

/** Why Re-run from Fix is not available now (core's facts). */
function fixUnavailable(s: StoreState, runId: string): string | undefined {
  const facts = fixFacts(s, runId)
  const summary = s.summaries.byId[runId] ?? s.runs.byId[runId]?.snapshot?.summary
  if (facts === null || facts.available || summary === undefined) return undefined
  return rerunFromFixUnavailableReason(facts, summary)
}

/**
 * The toast's Re-run from Fix, offered while core says it is available: it opens the picker in the run's Flow tab (and
 * stays disabled with core's reason should that change while the toast shows).
 */
function rerunFromFixAction(runId: string): { secondary?: ToastActionSpec } {
  if (fixFacts(useStore.getState(), runId)?.available !== true) return {}
  return {
    secondary: {
      label: RERUN_FROM_FIX_LABEL,
      onClick: async () => {
        navigate({ name: 'run', runId, tab: 'flow' })
        await openFixPicker(runId)
      },
      liveDisabledReason: (s) => fixUnavailable(s, runId),
    },
  }
}

function stoppedToast(runId: string): void {
  const s = useStore.getState().summaries.byId[runId]
  const fromFix = rerunFromFixAction(runId)
  if (s?.isolation === 'worktree') {
    const openApply = { label: APPLY_TITLE, onClick: () => navigate({ name: 'run', runId, tab: 'diff' }) }
    // Core's facts: an apply of the run is in the folder (finalize state `applied`), or the copy is there and none of
    // it is (RunSummary.worktree.notApplied); otherwise nothing of the run is in the folder.
    if (s.worktree?.state === 'applied') {
      const fin = finalizeInfoOf(useStore.getState().runs.byId[runId]?.snapshot?.steps.finalize)
      const token = fin.state === 'applied' ? fin.undoToken : null
      toast({
        id: `stopped:${runId}`,
        level: 'info',
        message: STOPPED_ISOLATED_APPLIED,
        durationMs: STOPPED_TOAST_MS,
        action:
          token !== null ? { label: UNDO_APPLY_LABEL, onClick: () => undoApply(runId, token) } : openApply,
        ...fromFix,
      })
      return
    }
    const notApplied = s.worktree?.notApplied === true
    toast({
      id: `stopped:${runId}`,
      level: 'info',
      message: notApplied ? STOPPED_ISOLATED_MESSAGE : STOPPED_ISOLATED_CLEAN,
      durationMs: STOPPED_TOAST_MS,
      // With nothing to apply, Re-run from Fix (when offered) is the toast's one action.
      ...(notApplied
        ? { action: openApply, ...fromFix }
        : fromFix.secondary !== undefined
          ? { action: fromFix.secondary }
          : {}),
    })
    return
  }
  toast({
    id: `stopped:${runId}`,
    level: 'info',
    message: STOPPED_MESSAGE,
    durationMs: STOPPED_TOAST_MS,
    action: {
      label: REVERT_ALL_LABEL,
      onClick: () => revertAll(runId),
      liveDisabledReason: (s) => folderBusyReason(s, runId),
    },
    ...fromFix,
  })
}

/** Toast once the run's summary says cancelled (immediately if it already does). */
export function watchStop(runId: string): void {
  watching.get(runId)?.()
  const isCancelled = (): boolean => useStore.getState().summaries.byId[runId]?.status === 'cancelled'
  if (isCancelled()) {
    stoppedToast(runId)
    return
  }
  const timer = setTimeout(() => done(), WATCH_MS)
  const unsubscribe = useStore.subscribe(() => {
    if (!isCancelled()) return
    done()
    stoppedToast(runId)
  })
  function done(): void {
    clearTimeout(timer)
    unsubscribe()
    watching.delete(runId)
  }
  watching.set(runId, done)
}

/** runs.stop, then the stopped toast when the run is cancelled. */
export async function stopRun(runId: string): Promise<boolean> {
  const r = await runCommand(runId, 'runs.stop', { runId })
  if (r.ok) watchStop(runId)
  return r.ok
}

/** Tests: forget pending watches. */
export function resetStopWatches(): void {
  for (const done of [...watching.values()]) done()
}
