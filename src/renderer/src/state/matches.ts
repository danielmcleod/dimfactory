// Matches the renderer was told about: core says when a match's record changed (the `match` event: side B started, a
// result was picked, the names were hidden or shown), and the Match page reads `matches.get` again. Nothing of a match
// is kept here but a counter per match; the page holds what it read.
import { create } from 'zustand'

interface MatchesState {
  /** matchId to the number of changes heard. */
  epoch: Readonly<Record<string, number>>
}

export const useMatchesStore = create<MatchesState>(() => ({ epoch: {} }))

/** The `match` event. */
export function bumpMatch(matchId: string): void {
  useMatchesStore.setState((s) => ({ epoch: { ...s.epoch, [matchId]: (s.epoch[matchId] ?? 0) + 1 } }))
}

/** Changes on every `match` event for this match. */
export function useMatchEpoch(matchId: string): number {
  return useMatchesStore((s) => s.epoch[matchId] ?? 0)
}

/** Tests: forget every counter. */
export function resetMatchesForTests(): void {
  useMatchesStore.setState({ epoch: {} })
}
