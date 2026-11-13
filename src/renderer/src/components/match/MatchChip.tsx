// "Head to head: side A" on a run that is one side of a match (RunSummary.matchOf). A link to the Match page where the
// chip is not already inside a link (a run card's header, the run's own header); plain text inside a row that is one.
import { MATCH_SIDE_LABEL } from '@shared/match.ts'
import type { RunSummary } from '@shared/run.ts'
import { href } from '../../lib/router.ts'
import { Badge } from '../ui/Badge.tsx'

/** The Re-run menus' item that opens the Rematch page for a run. */
export const REMATCH_LABEL = 'Rematch…'
export const REMATCH_HINT = 'Build it again with another model, from where this run began, and compare'

export const MATCH_CHIP_HINT = 'This run is one side of a Head to head: the same task built twice, to compare'

export function matchChipText(summary: Pick<RunSummary, 'matchOf'>): string | null {
  const m = summary.matchOf
  if (m === undefined) return null
  return `${m.rematch === true ? 'Rematch' : 'Head to head'}: ${MATCH_SIDE_LABEL[m.side].toLowerCase()}`
}

export function MatchChip({
  summary,
  link = false,
}: {
  summary: RunSummary
  link?: boolean
}): React.JSX.Element | null {
  const text = matchChipText(summary)
  const m = summary.matchOf
  if (text === null || m === undefined) return null
  const badge = (
    <Badge
      variant="outline"
      data-testid={`match-chip-${summary.runId}`}
      title={link ? `${MATCH_CHIP_HINT}. Opens the comparison.` : MATCH_CHIP_HINT}
      className="shrink-0 font-normal text-muted-foreground"
    >
      {text}
    </Badge>
  )
  if (!link) return badge
  return (
    <a
      href={href({ name: 'match', matchId: m.matchId })}
      data-testid={`match-link-${summary.runId}`}
      className="shrink-0 rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {badge}
    </a>
  )
}
