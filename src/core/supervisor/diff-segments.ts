// The diff segments of a run (Review/Critic `{{diff}}` = S0..S1, Fix card = F0..S2, each Fix until green round alone =
// its Fix start..its end snapshot, Deploy = deploy-start..deploy-end,
// Combined = S0..last), read from the run's state for `diff.files` / `diff.file`. Pure: the snapshots' commits come
// from RunState, the diffs themselves from the shadow (app-core.ts).
import type { DiffSegment } from '../../shared/ipc.ts'
import { DIFF_SEGMENTS } from '../../shared/ipc.ts'
import type { RunState, SnapshotLabel, SnapshotRef } from './types.ts'

/**
 * Snapshots that hold the run's own work, the candidates for the Combined segment's `last`: the end of a pass, the
 * checks that should equal S1, and the recovery points a stopped, paused, interrupted or retried run leaves. Not
 * `pre-revert` (an undo point taken before Dim Factory wrote the folder), `resume`, `run-start`, `plan-end`, `S0`,
 * `fix-start` (Fix's start, before S2) or `pre-apply`.
 */
const RESULT_LABELS: readonly SnapshotLabel[] = [
  'S1',
  'post-verify-1',
  'post-review',
  'S2',
  'post-round',
  'deploy-end',
  'pre-retry',
  'stopped',
  'paused',
  'interrupted',
]

export interface SegmentEnds {
  from: SnapshotRef
  to: SnapshotRef
}

/**
 * The base of the run's own changes: Test-first's Tests step start (T0) when it ran, else Implement's (S0). The Review
 * and Fix diffs, the Diff tab's segments and Revert all start here.
 */
export function runBaseSnap(
  s: Pick<RunState, 'steps' | 'snapshots'> & { config?: Pick<RunState['config'], 'testFirst'> },
): SnapshotRef | undefined {
  // A state an earlier build wrote (or a partial one) may lack the config flag or the Tests step's row.
  if (s.config?.testFirst === true) {
    const tests = (s.steps as Partial<RunState['steps']>).tests
    const t0 = tests?.startSnap ?? s.snapshots.T0
    if (t0 !== undefined) return t0
  }
  return s.steps.implement.startSnap ?? s.snapshots.S0
}

/** The run's latest result snapshot (RESULT_LABELS), the Combined segment's end. */
export function lastResultSnapshot(s: RunState): SnapshotRef | undefined {
  let last: SnapshotRef | undefined
  for (const label of RESULT_LABELS) {
    const ref = s.snapshots[label]
    if (ref !== undefined && (last === undefined || ref.at >= last.at)) last = ref
  }
  return last
}

/** The round a `fix-round-<n>` segment shows, or null for any other segment. */
export function segmentRound(seg: DiffSegment): number | null {
  const m = /^fix-round-(\d)$/.exec(seg)
  return m !== null ? Number(m[1]) : null
}

/**
 * Round n of Fix until green alone: only in a run whose loop ran a second round (with one round it is the Fix
 * segment). A closed round's recorded start and end; the round under way, once its Fix has its end snapshot.
 */
function roundEnds(s: RunState, n: number): SegmentEnds | undefined {
  const loop = s.fixLoop
  if (loop === undefined || loop.rounds.length < 2) return undefined
  const r = loop.rounds[n - 1]
  if (r === undefined) return undefined
  if (r.startSnap !== undefined && r.endSnap !== undefined) return { from: r.startSnap, to: r.endSnap }
  if (r.status !== 'running' || n !== loop.rounds.length) return undefined
  const from = s.steps.fix.startSnap
  const to = s.steps.fix.endSnap
  return from !== undefined && to !== undefined && to.at >= from.at ? { from, to } : undefined
}

/** Where a segment starts and ends, or undefined while the run has not reached both. */
export function segmentEnds(s: RunState, seg: DiffSegment): SegmentEnds | undefined {
  const s0 = runBaseSnap(s)
  switch (seg) {
    case 'fix-round-1':
    case 'fix-round-2':
    case 'fix-round-3':
      return roundEnds(s, segmentRound(seg) ?? 0)
    case 'implement': {
      const s1 = s.steps.implement.endSnap ?? s.snapshots.S1
      return s0 !== undefined && s1 !== undefined ? { from: s0, to: s1 } : undefined
    }
    case 'fix': {
      // Fix until green: the segment spans every round, from round 1's start.
      const f0 = s.fixLoop?.firstStart ?? s.steps.fix.startSnap ?? s.snapshots['fix-start']
      const s2 = s.steps.fix.endSnap ?? s.snapshots.S2
      return f0 !== undefined && s2 !== undefined ? { from: f0, to: s2 } : undefined
    }
    case 'deploy': {
      // A state an earlier build wrote has no Deploy row.
      const deploy = (s.steps as Partial<RunState['steps']>).deploy
      const d0 = deploy?.startSnap ?? s.snapshots['deploy-start']
      const d1 = deploy?.endSnap ?? s.snapshots['deploy-end']
      return d0 !== undefined && d1 !== undefined ? { from: d0, to: d1 } : undefined
    }
    case 'combined': {
      const last = lastResultSnapshot(s)
      return s0 !== undefined && last !== undefined && last.at >= s0.at ? { from: s0, to: last } : undefined
    }
  }
}

/** The segments this run has (DiffFiles.available), in DIFF_SEGMENTS order. */
export function availableSegments(s: RunState): DiffSegment[] {
  return DIFF_SEGMENTS.filter((seg) => segmentEnds(s, seg) !== undefined)
}

/** Why a segment is not there yet, as UI copy. */
export function missingSegmentText(seg: DiffSegment): string {
  switch (seg) {
    case 'implement':
      return 'Implement has not finished, so its changes cannot be shown yet.'
    case 'fix':
      return 'Fix has not run, so there are no Fix changes to show.'
    case 'fix-round-1':
    case 'fix-round-2':
    case 'fix-round-3':
      return `Fix until green has not finished round ${segmentRound(seg) ?? ''}'s Fix, so its changes cannot be shown yet.`
    case 'deploy':
      return 'The Deploy step has not written any config, so there are no Deploy changes to show.'
    case 'combined':
      return 'The run has not recorded any changes yet.'
  }
}
