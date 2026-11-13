// The scoreboard: what the matches a person has played say about their builders (pure). Per kind of task and per
// builder (a vendor and its model): matches played, how often its result was the pick, checks passed, and the typical
// cost and time of its builds. One try is noise, so under SCORE_MIN_MATCHES matches a row says "not enough to tell",
// and a suggestion needs that many judged matches between the same two builders. Nothing here changes a setting: a
// suggestion is words, with the matches behind it.
import type { MatchContestant, MatchKind, MatchPickSide } from './match.ts'

/** Fewer matches than this tell nothing about a builder. */
export const SCORE_MIN_MATCHES = 5
/** A builder picked in at least this share of the judged matches against another is worth a suggestion. */
export const SCORE_SUGGEST_SHARE = 0.8

/** One side of a match as it ended, kept in the match's record so it outlives its run. */
export interface MatchResultSide {
  builder: MatchContestant
  /** The run ended by finishing its work (not stopped, not failed). */
  finished: boolean
  checks?: { passed: number; failed: number }
  costUsd?: number | null
  /** Time the building steps were at work. */
  buildMs?: number
}

/** `MatchRecord.result`: how a match ended, for the scoreboard. */
export interface MatchResult {
  at: number
  /** The kind of task: the Brief's category (software, documents, ...). */
  category: string
  sides: [MatchResultSide, MatchResultSide]
}

export interface ScoredMatch extends MatchResult {
  matchId: string
  kind: MatchKind
  pick?: MatchPickSide
}

export interface ScoreRow {
  category: string
  builder: MatchContestant
  /** Matches this builder was a side of. */
  matches: number
  /** Matches against another builder that got a pick. */
  judged: number
  /** Of those, the ones where this builder's result was the pick. */
  picked: number
  checksPassed: number
  checksTotal: number
  /** The median cost and build time of its sides; null when none was priced or timed. */
  typicalCostUsd: number | null
  typicalMs: number | null
  /** At least SCORE_MIN_MATCHES matches. */
  enough: boolean
}

export interface ScoreSuggestion {
  category: string
  better: MatchContestant
  than: MatchContestant
  picked: number
  of: number
  /** The judged matches between the two, newest first. */
  matchIds: string[]
}

/** One match in the scoreboard's list. */
export interface ScoreMatchLine {
  matchId: string
  kind: MatchKind
  category: string
  at: number
  task: string
  sides: [MatchContestant, MatchContestant]
  pick?: MatchPickSide
  /** Both sides have ended. */
  ended: boolean
}

/** `matches.scoreboard`. */
export interface Scoreboard {
  rows: ScoreRow[]
  suggestions: ScoreSuggestion[]
  /** Every match, newest first. */
  matches: ScoreMatchLine[]
}

/** A builder for the scoreboard: the vendor and its model (the effort level is not told apart). */
export function builderKey(c: MatchContestant): string {
  return `${c.vendor}:${typeof c.model === 'string' ? c.model : ''}`
}

const builderOnly = (c: MatchContestant): MatchContestant => ({
  vendor: c.vendor,
  ...(typeof c.model === 'string' ? { model: c.model } : {}),
})

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

interface Acc {
  category: string
  builder: MatchContestant
  matchIds: Set<string>
  judged: number
  picked: number
  passed: number
  total: number
  costs: number[]
  times: number[]
}

/** The rows (by kind, then most matches first) and the suggestions the matches support. */
export function score(matches: readonly ScoredMatch[]): Pick<Scoreboard, 'rows' | 'suggestions'> {
  const acc = new Map<string, Acc>()
  const pairs = new Map<
    string,
    {
      category: string
      a: MatchContestant
      b: MatchContestant
      wins: [number, number]
      ids: { id: string; at: number }[]
    }
  >()
  for (const m of matches) {
    const keys = [builderKey(m.sides[0].builder), builderKey(m.sides[1].builder)] as const
    const twoTries = keys[0] === keys[1]
    m.sides.forEach((side, i) => {
      const key = `${m.category}\u0000${keys[i] as string}`
      let a = acc.get(key)
      if (a === undefined) {
        a = {
          category: m.category,
          builder: builderOnly(side.builder),
          matchIds: new Set(),
          judged: 0,
          picked: 0,
          passed: 0,
          total: 0,
          costs: [],
          times: [],
        }
        acc.set(key, a)
      }
      const first = !a.matchIds.has(m.matchId)
      a.matchIds.add(m.matchId)
      if (side.checks !== undefined) {
        a.passed += side.checks.passed
        a.total += side.checks.passed + side.checks.failed
      }
      if (typeof side.costUsd === 'number') a.costs.push(side.costUsd)
      if (side.buildMs !== undefined) a.times.push(side.buildMs)
      // A pick between two tries of one builder says nothing about the builder.
      if (!twoTries && m.pick !== undefined && first) {
        a.judged++
        if (m.pick === (i === 0 ? 'a' : 'b')) a.picked++
      }
    })
    if (!twoTries && m.pick !== undefined) {
      // The pair in a fixed order, so A against B and B against A are the same pair.
      const swap = keys[0] > keys[1]
      const [ka, kb] = swap ? [keys[1], keys[0]] : keys
      const pk = `${m.category}\u0000${ka}\u0000${kb}`
      let p = pairs.get(pk)
      if (p === undefined) {
        p = {
          category: m.category,
          a: builderOnly(m.sides[swap ? 1 : 0].builder),
          b: builderOnly(m.sides[swap ? 0 : 1].builder),
          wins: [0, 0],
          ids: [],
        }
        pairs.set(pk, p)
      }
      p.ids.push({ id: m.matchId, at: m.at })
      if (m.pick !== 'none') p.wins[(m.pick === 'a') !== swap ? 0 : 1]++
    }
  }
  const rows: ScoreRow[] = [...acc.values()]
    .map((a) => ({
      category: a.category,
      builder: a.builder,
      matches: a.matchIds.size,
      judged: a.judged,
      picked: a.picked,
      checksPassed: a.passed,
      checksTotal: a.total,
      typicalCostUsd: median(a.costs),
      typicalMs: median(a.times),
      enough: a.matchIds.size >= SCORE_MIN_MATCHES,
    }))
    .sort(
      (x, y) =>
        x.category.localeCompare(y.category) ||
        y.matches - x.matches ||
        builderKey(x.builder).localeCompare(builderKey(y.builder)),
    )
  const suggestions: ScoreSuggestion[] = []
  for (const p of pairs.values()) {
    const of = p.ids.length
    if (of < SCORE_MIN_MATCHES) continue
    const best = p.wins[0] >= p.wins[1] ? 0 : 1
    if (p.wins[best] / of < SCORE_SUGGEST_SHARE) continue
    suggestions.push({
      category: p.category,
      better: best === 0 ? p.a : p.b,
      than: best === 0 ? p.b : p.a,
      picked: p.wins[best],
      of,
      matchIds: p.ids.sort((x, y) => y.at - x.at).map((x) => x.id),
    })
  }
  suggestions.sort((x, y) => x.category.localeCompare(y.category) || y.of - x.of)
  return { rows, suggestions }
}
