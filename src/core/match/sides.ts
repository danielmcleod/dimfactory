// What makes a run a match's side, as run overrides (pure). A side builds with its contestant: Plan, Implement and Fix
// run on its vendor, model and effort. It works in its own copy (an isolated run), never applies itself (the person
// chooses which side to keep) and makes no branch. Everything else is what the person set for the match, the same on
// both sides.
//
// Clarify and Research are asked once: side A keeps them as the person set them ('asks'), and side B has them off
// ('given'), because it is started with side A's answers and notes already in place (shared.ts).
import type { RunOverrides } from '../../shared/config-schema.ts'
import { MATCH_BUILD_PASSES, MATCH_SIDE_LABEL, MATCH_TEXT, sameContestant } from '../../shared/match.ts'
import type { MatchContestant, MatchSide } from '../../shared/match.ts'
import { deepMerge } from '../config/merge.ts'

/** The side's layer over the match's own overrides (the side's builder and the copy always win). */
export function sideOverrides(
  base: RunOverrides | undefined,
  c: MatchContestant,
  shared: 'asks' | 'given' = 'given',
): RunOverrides {
  const builder = {
    vendor: c.vendor,
    model: c.model ?? null,
    ...(c.effort !== undefined ? { effort: c.effort } : {}),
  }
  const layer: RunOverrides = {
    passes: {
      plan: { ...builder, ...(shared === 'given' ? { clarify: false, research: false } : {}) },
      implement: { ...builder },
      fix: { ...builder },
    },
    isolation: { mode: 'worktree', branch: 'none', worktree: { autoApply: false } },
  }
  return deepMerge<RunOverrides>(base ?? {}, layer)
}

export interface ContestantCheck {
  ok: boolean
  /** UI copy: why the match cannot start. */
  problems: string[]
  /** UI copy: worth knowing, never blocking. */
  notes: string[]
}

/** The two contestants as given: exactly two, each a vendor Dim Factory knows. Same on both sides is allowed. */
export function checkContestants(
  sides: readonly MatchContestant[],
  known: (vendor: string) => boolean,
): ContestantCheck {
  const problems: string[] = []
  const notes: string[] = []
  if (sides.length !== 2) return { ok: false, problems: [MATCH_TEXT.twoSides], notes }
  const labels: MatchSide[] = ['a', 'b']
  sides.forEach((c, i) => {
    const label = MATCH_SIDE_LABEL[labels[i] as MatchSide]
    if (typeof c.vendor !== 'string' || c.vendor.trim() === '' || !known(c.vendor)) {
      problems.push(MATCH_TEXT.unknownVendor(label, String(c.vendor)))
    }
  })
  const [a, b] = sides as [MatchContestant, MatchContestant]
  if (problems.length === 0 && sameContestant(a, b)) notes.push(MATCH_TEXT.sameSides)
  return { ok: problems.length === 0, problems, notes }
}

/** The passes a side's contestant runs, for a view that says who built what. */
export const BUILD_PASSES: readonly string[] = MATCH_BUILD_PASSES
