// Which runs a rematch can replay, and what it starts from (pure). A rematch builds the task again from the folder as
// it was when the run began, so the run has to have ended, to have started from a task (not from another run's work),
// and to have worked in the folder itself: its starting snapshot is then in the folder's own shadow repository, which
// is where a match's copies are written from.
import type { MatchContestant } from '../../shared/match.ts'
import { runBaseSnap } from '../supervisor/diff-segments.ts'
import type { RunState, SnapshotRef, StepState } from '../supervisor/types.ts'

const no = (s: Pick<RunState, 'displayNo'>): string => `Run #${s.displayNo}`

/** The folder as it was when the run began: its run-start snapshot, else the start of its first building step. */
export function startSnapOf(s: Pick<RunState, 'steps' | 'snapshots' | 'config'>): SnapshotRef | undefined {
  return s.snapshots['run-start'] ?? runBaseSnap(s)
}

/** Who built the run: the vendor, model and effort its Implement step ran on (else its Plan's). */
export function builderOf(s: Pick<RunState, 'steps'>): MatchContestant | undefined {
  const of = (st: StepState | undefined): MatchContestant | undefined =>
    st?.vendor === undefined
      ? undefined
      : {
          vendor: st.vendor,
          ...(typeof st.model === 'string' && st.model !== '' ? { model: st.model } : {}),
          ...(st.effort !== undefined ? { effort: st.effort } : {}),
        }
  return of(s.steps.implement) ?? of(s.steps.plan)
}

/** UI copy: why the run cannot be replayed; undefined when it can (its snapshot still has to exist: asked apart). */
export function rematchUnavailable(s: RunState): string | undefined {
  if (s.status !== 'completed' && s.status !== 'failed' && s.status !== 'cancelled') {
    return `${no(s)} is still going. A rematch replays a run that has ended.`
  }
  if (s.rerunOf?.from === 'fix') {
    return `${no(s)} was a Re-run from Fix: it started from another run's work, not from a task.`
  }
  if (s.matchOf !== undefined) return `${no(s)} is already one side of a match.`
  if (s.config.isolation === 'worktree') {
    return `${no(s)} worked in an isolated copy. A rematch replays a run that worked in the folder itself.`
  }
  if (builderOf(s) === undefined) {
    return `${no(s)} never started building, so there is nothing to compare a new build with.`
  }
  if (startSnapOf(s) === undefined) {
    return `${no(s)} ended before it took a snapshot of where it started, so it cannot be replayed.`
  }
  return undefined
}

/** UI copy: the run's starting snapshot is not kept any more. */
export function startGoneText(s: Pick<RunState, 'displayNo'>): string {
  return `${no(s)}'s starting snapshot was cleared, so there is nothing to replay it from.`
}
