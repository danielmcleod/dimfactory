// "Make two and pick", as Easy shows it (pure): how each version stands, the page's one status line, and which version
// can be kept. A version is a match's side; the page never says who built it.
import { shownOrder } from '@shared/match.ts'
import type { MatchSide, MatchSideView, MatchView } from '@shared/match.ts'
import type { TwoState, TwoStatus } from './text.ts'

/** A copy still being made, worked in, or having its changes read: not something to decide about yet. */
const BUILDING: ReadonlySet<string> = new Set(['preparing', 'working', 'preview'])

/** The side the folder holds, or the person's pick (which may be "neither"). */
function chosen(view: MatchView): MatchSide | 'none' | undefined {
  return view.pick?.side ?? view.kept
}

/**
 * How a version stands. `needs`: what waits for the person in its run (questions, asks, a failure's choices), not
 * counting its "keep or throw away" card, which this page answers.
 */
export function twoSideState(view: MatchView, side: MatchSideView, needs: number): TwoState {
  const pick = chosen(view)
  if (pick !== undefined) return pick === side.side ? 'kept' : 'notKept'
  if (side.runId === undefined) return side.notStarted !== undefined ? 'stopped' : 'waiting'
  // The run is no longer in the history.
  if (side.status === undefined) return 'stopped'
  // A run that failed is not building, even while its failure waits for an answer on its own page.
  if (side.status === 'cancelled') return 'stopped'
  if (side.status === 'failed') return 'failed'
  if (needs > 0) return 'needsYou'
  const settled =
    side.endedAt !== undefined ||
    (side.copyState !== undefined ? !BUILDING.has(side.copyState) : side.outcome !== undefined)
  if (!settled) return 'working'
  return side.notApplied === true ? 'ready' : 'failed'
}

/** The version can be kept now: both have settled, nothing is picked, and it built something that is not in the folder. */
export function canKeep(view: MatchView, state: TwoState): boolean {
  return view.ready && chosen(view) === undefined && state === 'ready'
}

/** The page's status line, from the two versions' states in the order they are shown. */
export function twoStatus(view: MatchView, states: readonly [TwoState, TwoState]): TwoStatus {
  const pick = chosen(view)
  if (pick === 'none') return 'keptNone'
  if (pick !== undefined) return shownOrder(view)[0] === pick ? 'keptFirst' : 'keptSecond'
  if (states.includes('needsYou')) return 'needsYou'
  // A version failed and its run has not ended: what happened, and what can be done, is on its own page.
  if (!view.ready && states.includes('failed')) return 'failed'
  if (view.waiting) return 'waiting'
  if (!view.ready) return 'working'
  const ready = states.filter((s) => s === 'ready').length
  return ready === 2 ? 'ready' : ready === 1 ? 'readyOne' : 'readyNone'
}

/** The run of the version the folder holds; undefined when none is kept. */
export function keptRunId(view: MatchView): string | undefined {
  const pick = chosen(view)
  if (pick === undefined || pick === 'none') return undefined
  return view.sides.find((s) => s.side === pick)?.runId
}
