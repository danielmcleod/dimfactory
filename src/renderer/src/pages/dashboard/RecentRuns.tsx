// Recent runs, Dashboard v0: the last 20 finished runs with core's outcome
// in the Recent-runs wording (`Fixed · 3 must · 5 should`, `Failed at Implement · Codex login expired`, …), folder, duration and
// cost, the amber AUTO badge for a run made in Auto and the chip "Isolated: not applied" from core's summary.
// A row opens the run.
import { History } from 'lucide-react'
import { AutoBadge } from '../../components/ui/Badge.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { StatusDot } from '../../components/ui/StatusDot.tsx'
import {
  costTitle,
  formatAgo,
  formatDuration,
  formatRunCost,
  outcomeText,
  RUN_STATUS_LABEL,
  runCostBasis,
} from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { useNow } from '../../lib/ticker.ts'
import { useRunIds, useSummariesLoaded, useSummary } from '../../state/selectors.ts'
import { folderBaseName } from './composer-model.ts'
import { MatchChip } from '../../components/match/MatchChip.tsx'
import { IsolatedChip } from './IsolatedChip.tsx'

export const RECENT_RUNS_SHOWN = 20

function RecentRow({ runId, now }: { runId: string; now: number }): React.JSX.Element | null {
  const s = useSummary(runId)
  if (s === undefined) return null
  const outcome = outcomeText(s) ?? RUN_STATUS_LABEL[s.status]
  const meta = [folderBaseName(s.folder)]
  if (s.recipe !== undefined) meta.push(s.recipe.label)
  if (s.endedAt !== undefined) meta.push(formatDuration(s.endedAt - s.createdAt))
  if (s.progress.costUsd !== null) meta.push(formatRunCost(s))
  meta.push(formatAgo(s.endedAt ?? s.createdAt, now))
  return (
    <li data-testid={`recent-run-${runId}`} data-status={s.status}>
      <a
        href={href({ name: 'run', runId })}
        className="flex items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StatusDot status={s.status} label="" />
        {s.auto && <AutoBadge data-testid="auto-badge" />}
        <IsolatedChip summary={s} />
        <MatchChip summary={s} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" title={`${outcome} · #${s.displayNo} ${s.title}`}>
            <span data-testid={`recent-outcome-${runId}`} className="font-medium">
              {outcome}
            </span>
            <span className="text-muted-foreground">
              {' '}
              · #{s.displayNo} {s.title}
            </span>
          </p>
          <p
            className="truncate text-xs text-muted-foreground tabular-nums"
            title={
              s.progress.costUsd !== null
                ? `${s.folder} · ${costTitle({ usd: s.progress.costUsd, basis: runCostBasis(s) })}`
                : s.folder
            }
          >
            {meta.join(' · ')}
          </p>
        </div>
      </a>
    </li>
  )
}

export function RecentRuns({
  exclude = [],
}: {
  /** Runs whose card is in Active runs for this visit (one that ended while the Dashboard was open). */
  exclude?: readonly string[]
}): React.JSX.Element {
  const finished = useRunIds('finished', RECENT_RUNS_SHOWN + exclude.length)
  const ids = finished.filter((id) => !exclude.includes(id)).slice(0, RECENT_RUNS_SHOWN)
  const any = useRunIds('all', 1).length > 0
  const loaded = useSummariesLoaded()
  // Relative times are as of opening the Dashboard; a ticking clock is not worth 20 re-renders a second.
  const now = useNow(false)
  return (
    <section aria-labelledby="recent-heading" data-testid="recent-runs" className="flex flex-col gap-2">
      <h2 id="recent-heading" className="text-sm font-semibold">
        Recent runs
      </h2>
      {ids.length > 0 ? (
        <ul className="-mx-2 flex flex-col">
          {ids.map((id) => (
            <RecentRow key={id} runId={id} now={now} />
          ))}
        </ul>
      ) : loaded ? (
        <EmptyState
          icon={History}
          title={any ? 'No finished runs yet' : 'No runs yet'}
          description={
            any
              ? 'Runs appear here with their outcome once they finish.'
              : 'Choose a folder, describe a task above and press Run. Finished runs appear here.'
          }
          className="rounded-lg border border-dashed py-8"
        />
      ) : null}
    </section>
  )
}
