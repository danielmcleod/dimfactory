// The scoreboard's arithmetic: rows per kind of task and builder, "not enough to tell" under five matches, picks only
// between different builders, and a suggestion only when five judged matches between the same two say the same thing.
import { describe, expect, it } from 'vitest'
import { SCORE_MIN_MATCHES, builderKey, score } from '@shared/scoreboard.ts'
import type { MatchResultSide, ScoredMatch } from '@shared/scoreboard.ts'
import type { MatchContestant, MatchPickSide } from '@shared/match.ts'

const CLAUDE: MatchContestant = { vendor: 'claude', model: 'opus' }
const CODEX: MatchContestant = { vendor: 'codex', model: 'gpt-x' }

let n = 0
const side = (builder: MatchContestant, over: Partial<MatchResultSide> = {}): MatchResultSide => ({
  builder,
  finished: true,
  checks: { passed: 2, failed: 0 },
  costUsd: 1,
  buildMs: 60_000,
  ...over,
})
const match = (
  a: MatchResultSide,
  b: MatchResultSide,
  pick?: MatchPickSide,
  over: Partial<ScoredMatch> = {},
): ScoredMatch => ({
  matchId: `m${++n}`,
  kind: 'rematch',
  category: 'software',
  at: n,
  sides: [a, b],
  ...(pick !== undefined ? { pick } : {}),
  ...over,
})

describe('the scoreboard', () => {
  it('counts each builder’s matches, picks, checks and typical cost and time, per kind of task', () => {
    const { rows } = score([
      match(side(CLAUDE, { costUsd: 1, buildMs: 10 }), side(CODEX, { costUsd: 4, buildMs: 40 }), 'b'),
      match(
        side(CLAUDE, { costUsd: 3, buildMs: 30 }),
        side(CODEX, { checks: { passed: 1, failed: 1 } }),
        'a',
      ),
      match(side(CLAUDE, { costUsd: 2, buildMs: 20 }), side(CODEX, { costUsd: null }), 'none'),
      // Not judged yet: counted as played, not as a pick either way.
      match(side(CLAUDE), side(CODEX)),
      // Another kind of task is another row.
      match(side(CLAUDE), side(CODEX), 'a', { category: 'documents' }),
    ])
    expect(rows.map((r) => [r.category, builderKey(r.builder), r.matches])).toEqual([
      ['documents', 'claude:opus', 1],
      ['documents', 'codex:gpt-x', 1],
      ['software', 'claude:opus', 4],
      ['software', 'codex:gpt-x', 4],
    ])
    const claude = rows.find((r) => r.category === 'software' && r.builder.vendor === 'claude')
    expect(claude).toMatchObject({
      matches: 4,
      judged: 3,
      picked: 1,
      checksPassed: 8,
      checksTotal: 8,
      // The median of 1, 3, 2 and 1.
      typicalCostUsd: 1.5,
      typicalMs: 25,
      enough: false,
    })
    const codex = rows.find((r) => r.category === 'software' && r.builder.vendor === 'codex')
    expect(codex).toMatchObject({ judged: 3, picked: 1, checksPassed: 7, checksTotal: 8 })
    // An unpriced side is left out of the typical cost: 4, 1 and 1.
    expect(codex?.typicalCostUsd).toBe(1)
  })

  it('five matches are enough to read a row; the effort level is not told apart', () => {
    const matches = Array.from({ length: SCORE_MIN_MATCHES }, () =>
      match(side({ ...CLAUDE, effort: 'high' }), side(CODEX), 'a'),
    )
    const { rows } = score(matches)
    expect(rows.every((r) => r.enough)).toBe(true)
    expect(rows[0]?.builder).toEqual({ vendor: 'claude', model: 'opus' })
    expect(score(matches.slice(1)).rows.every((r) => !r.enough)).toBe(true)
  })

  it('two tries of one builder count as one match for it, and its pick says nothing', () => {
    const { rows, suggestions } = score(
      Array.from({ length: 6 }, () => match(side(CLAUDE, { costUsd: 1 }), side(CLAUDE, { costUsd: 3 }), 'a')),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ matches: 6, judged: 0, picked: 0, checksTotal: 24, typicalCostUsd: 2 })
    expect(suggestions).toEqual([])
  })

  it('suggests only when five judged matches between the same two builders mostly agree', () => {
    const four = [
      match(side(CLAUDE), side(CODEX), 'b'),
      match(side(CODEX), side(CLAUDE), 'a'),
      match(side(CLAUDE), side(CODEX), 'b'),
      match(side(CLAUDE), side(CODEX), 'b'),
    ]
    expect(score(four).suggestions).toEqual([])
    // The fifth: Codex picked 4 of 5, whichever side it was on.
    const five = [...four, match(side(CLAUDE), side(CODEX), 'a')]
    const { suggestions } = score(five)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      category: 'software',
      better: { vendor: 'codex', model: 'gpt-x' },
      than: { vendor: 'claude', model: 'opus' },
      picked: 4,
      of: 5,
    })
    // Newest first, so the latest evidence is one click away.
    expect(suggestions[0]?.matchIds).toEqual([...five].reverse().map((m) => m.matchId))
    // 3 of 5 is not enough, and "neither" counts as a judged match nobody won.
    const split = [
      ...four.slice(0, 3),
      match(side(CLAUDE), side(CODEX), 'a'),
      match(side(CLAUDE), side(CODEX), 'none'),
    ]
    expect(score(split).suggestions).toEqual([])
    // Matches of another kind do not add up with these.
    const other = [...four, match(side(CLAUDE), side(CODEX), 'b', { category: 'documents' })]
    expect(score(other).suggestions).toEqual([])
  })

  it('no matches, no rows', () => {
    expect(score([])).toEqual({ rows: [], suggestions: [] })
  })
})
