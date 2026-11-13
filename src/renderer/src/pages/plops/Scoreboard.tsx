// The Scoreboard on the Plops page: what the matches played so far (Head to head and Rematch) say about the builders.
// Per kind of task and per builder: matches played, how often its result was the pick, checks passed, the typical
// cost and build time. A row with too few matches says so instead of pretending to mean something. Under the table:
// what the picks suggest (words only, with the matches behind them; no setting is ever changed here), and every
// match, newest first. The section is the page's last, and keeps its room while it loads, so nothing above it moves.
import { Swords } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MatchContestant } from '@shared/match.ts'
import { SCORE_MIN_MATCHES } from '@shared/scoreboard.ts'
import type { ScoreMatchLine, ScoreRow, ScoreSuggestion, Scoreboard as Board } from '@shared/scoreboard.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { formatDuration, formatUsd, vendorName } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { SETTINGS_TABLE } from '../settings/kit.tsx'

export const SCOREBOARD_INTRO =
  'From your Head to head matches and rematches: what each builder made, what passed its checks, and which result you picked.'
export const SCOREBOARD_EMPTY =
  'No matches yet. Switch on Head to head in the composer, or choose Rematch in a finished run’s Re-run menu.'
export const SCOREBOARD_LOADING = 'Reading your matches…'
export const NOT_ENOUGH = 'Not enough to tell'
export const NO_SUGGESTION =
  'No suggestion yet. One needs 5 picks between the same two builders, with one of them picked at least 4 times in 5.'
/** The matches list shows this many, newest first. */
export const MATCHES_SHOWN = 20

const COLUMNS = ['Kind', 'Builder', 'Matches', 'You picked', 'Checks passed', 'Typical cost', 'Typical time']

/** `Claude`, `Claude (opus)`. */
export function builderName(c: MatchContestant): string {
  return typeof c.model === 'string' ? `${vendorName(c.vendor)} (${c.model})` : vendorName(c.vendor)
}

/** `Software`: the kind of task as a word. */
export function kindName(category: string): string {
  return category === ''
    ? 'Software'
    : `${category.charAt(0).toUpperCase()}${category.slice(1).replace(/-/g, ' ')}`
}

/** A row's "You picked" cell: its share of the judged matches, or that there are too few matches to tell. */
export function pickedText(r: ScoreRow): string {
  if (!r.enough) return `${NOT_ENOUGH} (${r.matches} of ${SCORE_MIN_MATCHES} matches)`
  if (r.judged === 0) return 'No picks yet'
  return `${r.picked} of ${r.judged}`
}

export function checksText(r: ScoreRow): string {
  return r.checksTotal === 0 ? 'No checks ran' : `${r.checksPassed} of ${r.checksTotal}`
}

/** What a suggestion says. It names what the picks show and where the setting is; it changes nothing. */
export function suggestionText(s: ScoreSuggestion): string {
  return `${kindName(s.category)}: you picked ${builderName(s.better)} over ${builderName(s.than)} in ${s.picked} of ${s.of} matches. If ${builderName(s.than)} builds these tasks for you today, ${builderName(s.better)} may be worth setting as the builder in your profile.`
}

export function matchLineText(m: ScoreMatchLine): string {
  const picked =
    m.pick === undefined
      ? m.ended
        ? 'no pick yet'
        : 'still going'
      : m.pick === 'none'
        ? 'picked neither'
        : `picked ${builderName(m.sides[m.pick === 'a' ? 0 : 1])}`
  return `${m.kind === 'rematch' ? 'Rematch' : 'Head to head'} · ${builderName(m.sides[0])} against ${builderName(m.sides[1])} · ${picked}`
}

type State = { kind: 'loading' } | { kind: 'ready'; board: Board } | { kind: 'error'; message: string }

export function Scoreboard(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    void invoke('matches.scoreboard').then((r) => {
      if (!live) return
      setState(r.ok ? { kind: 'ready', board: r.value } : { kind: 'error', message: r.error.message })
    })
    return () => {
      live = false
    }
  }, [])
  const board = state.kind === 'ready' ? state.board : null
  return (
    <section
      data-testid="plops-scoreboard"
      aria-labelledby="plops-scoreboard-title"
      aria-busy={state.kind === 'loading'}
      className="flex min-h-48 flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground"
    >
      <h2 id="plops-scoreboard-title" className="flex items-center gap-2 text-base font-semibold">
        <Swords aria-hidden className="size-4 text-muted-foreground" />
        Scoreboard
      </h2>
      <p className="text-sm text-muted-foreground">{SCOREBOARD_INTRO}</p>
      {state.kind === 'loading' && (
        <p data-testid="scoreboard-loading" className="text-sm text-muted-foreground">
          {SCOREBOARD_LOADING}
        </p>
      )}
      {state.kind === 'error' && (
        <p data-testid="scoreboard-error" role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      {board !== null && board.matches.length === 0 && (
        <p data-testid="scoreboard-empty" className="text-sm text-muted-foreground">
          {SCOREBOARD_EMPTY}
        </p>
      )}
      {board !== null && board.matches.length > 0 && (
        <>
          <div className={SETTINGS_TABLE.frame}>
            <table aria-label="Scoreboard" data-testid="scoreboard-table" className={SETTINGS_TABLE.table}>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col" className={cn(SETTINGS_TABLE.cell, 'font-medium')}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-2 py-3 text-muted-foreground">
                      No match has ended yet.
                    </td>
                  </tr>
                ) : (
                  board.rows.map((r) => (
                    <tr
                      key={`${r.category}/${r.builder.vendor}/${r.builder.model ?? ''}`}
                      data-testid="scoreboard-row"
                      data-enough={r.enough}
                      className="border-t"
                    >
                      <td className={SETTINGS_TABLE.cell}>{kindName(r.category)}</td>
                      <td className={SETTINGS_TABLE.cell}>{builderName(r.builder)}</td>
                      <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>{r.matches}</td>
                      <td
                        className={cn(
                          SETTINGS_TABLE.cell,
                          'tabular-nums',
                          !r.enough && 'text-muted-foreground',
                        )}
                      >
                        {pickedText(r)}
                      </td>
                      <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>{checksText(r)}</td>
                      <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>
                        {r.typicalCostUsd !== null ? formatUsd(r.typicalCostUsd) : 'No price'}
                      </td>
                      <td className={cn(SETTINGS_TABLE.cell, 'tabular-nums')}>
                        {r.typicalMs !== null ? formatDuration(r.typicalMs) : 'Not timed'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div data-testid="scoreboard-suggestions" className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">What your picks suggest</h3>
            {board.suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{NO_SUGGESTION}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {board.suggestions.map((s) => (
                  <li
                    key={`${s.category}/${s.better.vendor}/${s.better.model ?? ''}/${s.than.vendor}/${s.than.model ?? ''}`}
                    data-testid="scoreboard-suggestion"
                    className="text-sm"
                  >
                    <p>{suggestionText(s)}</p>
                    <p className="text-xs text-muted-foreground">
                      The matches behind it:{' '}
                      {s.matchIds.map((id, i) => (
                        <span key={id}>
                          {i > 0 && ', '}
                          <a
                            className="underline underline-offset-2"
                            href={href({ name: 'match', matchId: id })}
                          >
                            match {i + 1}
                          </a>
                        </span>
                      ))}
                      . Profiles are in{' '}
                      <a
                        className="underline underline-offset-2"
                        href={href({ name: 'settings', section: 'profiles' })}
                      >
                        Settings
                      </a>
                      ; nothing is changed for you.
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div data-testid="scoreboard-matches" className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">
              Matches ({board.matches.length}
              {board.matches.length > MATCHES_SHOWN ? `, the newest ${MATCHES_SHOWN} shown` : ''})
            </h3>
            <ul className="flex flex-col">
              {board.matches.slice(0, MATCHES_SHOWN).map((m) => (
                <li key={m.matchId} data-testid={`scoreboard-match-${m.matchId}`}>
                  <a
                    href={href({ name: 'match', matchId: m.matchId })}
                    className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm" title={m.task}>
                      {m.task}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{matchLineText(m)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  )
}
