// Active run card: status, title,
// folder, AUTO, attention and stale badges, the phase line (`Implement · Codex · running 4m 12s` / `Queued · blocked
// by run #12 [Open] [Cancel it]`), a mini timeline sized by the steps' ETA p50 and the `elapsed · ETA · tokens ·
// $ est. · files` footer with Open and Stop. Everything shown is core's RunSummary (plus its snapshot's step ETAs);
// the ETA, "longer than usual" included, is core's `progress` (etaMs / etaState / etaEndsAt). An isolated run whose
// changes are not in its folder carries the chip "Isolated: not applied" (core's RunSummary.worktree).
import { Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PassStatus, RunStatus, RunSummary, RunSummaryStep } from '@shared/run.ts'
import { AutoBadge, Badge, STATUS_TONE, StatusBadge } from '../../components/ui/Badge.tsx'
import type { StatusTone } from '../../components/ui/Badge.tsx'
import { stopRun } from '../../components/run/stop.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Tooltip } from '../../components/ui/Tooltip.tsx'
import { cn } from '../../lib/cn.ts'
import {
  costTitle,
  formatDuration,
  etaRemainingMs,
  formatEta,
  formatFiles,
  formatRunCost,
  formatRunEta,
  formatTokens,
  LONGER_THAN_USUAL,
  outcomeText,
  PASS_STATUS_LABEL,
  RUN_PHASE_LABEL,
  RUN_STATUS_LABEL,
  runCostBasis,
  summaryStepLabel,
  vendorName,
} from '../../lib/format.ts'
import { pricingTitle, usePricingFacts } from '../../lib/pricing.ts'
import { href } from '../../lib/router.ts'
import { useNow } from '../../lib/ticker.ts'
import { isActiveStatus, useSummary } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { folderBaseName } from './composer-model.ts'
import { MatchChip } from '../../components/match/MatchChip.tsx'
import { IsolatedChip } from './IsolatedChip.tsx'

/** Step statuses that mean "this is where the run is now". */
const LIVE_STEP: ReadonlySet<PassStatus> = new Set(['running', 'waiting', 'stalled', 'paused'])

/** The step the run is on: the last one core reports as running, waiting, stalled or paused. */
export function currentStep(s: Pick<RunSummary, 'steps'>): RunSummaryStep | undefined {
  return s.steps.findLast((st) => LIVE_STEP.has(st.status))
}

// A summary's activeMs is as of when core built it; a running step keeps counting from when it arrived here.
const arrivedAt = new WeakMap<RunSummary, number>()
function arrival(s: RunSummary): number {
  let t = arrivedAt.get(s)
  if (t === undefined) {
    t = Date.now()
    arrivedAt.set(s, t)
  }
  return t
}

/** The current step's active time now: core's activeMs, plus the time since the summary arrived while running. */
function liveActiveMs(s: RunSummary, cur: RunSummaryStep, now: number): number {
  return cur.activeMs + (cur.status === 'running' ? Math.max(0, now - arrival(s)) : 0)
}

/** `Implement · Claude · running 4m 12s`; runner steps have no vendor. */
export function phaseText(s: RunSummary, now: number): string {
  // A run that finished while the Dashboard was open keeps its card until the next visit: it says how it ended.
  if (!isActiveStatus(s.status)) return outcomeText(s) ?? RUN_STATUS_LABEL[s.status]
  const cur = currentStep(s)
  if (cur === undefined) return RUN_PHASE_LABEL[s.phase]
  const ms = liveActiveMs(s, cur, now)
  const parts = [summaryStepLabel(cur.key, s)]
  if (cur.vendor !== undefined) parts.push(vendorName(cur.vendor))
  parts.push(`${PASS_STATUS_LABEL[cur.status].toLowerCase()} ${formatDuration(ms)}`)
  return parts.join(' · ')
}

const SEGMENT: Readonly<Record<StatusTone, string>> = {
  queued: 'bg-muted-foreground/25',
  running: 'bg-st-running',
  waiting: 'bg-st-waiting',
  stalled: 'bg-st-stalled',
  paused: 'bg-st-paused',
  done: 'bg-st-done',
  skipped: 'bg-st-skipped/40',
  failed: 'bg-st-failed',
  cancelled: 'bg-st-cancelled',
}

const STRIPES =
  'bg-[image:repeating-linear-gradient(135deg,transparent_0_4px,rgb(255_255_255/0.35)_4px_8px)] motion-safe:animate-pulse'

/** The last ETAs a run's mini timeline was sized by (per run and step): kept when the snapshot is gone again. */
const lastEtas = new Map<string, ReadonlyMap<string, number>>()

/** Tests: forget the ETAs seen so far. */
export function resetMiniTimelineForTests(): void {
  lastEtas.clear()
}

/**
 * One segment per step core reports. Widths follow the steps' ETA p50 once core sent any (the run has a frozen
 * estimate); a step core never estimates (preflight, finalize) gets a short fixed segment, a quarter of the
 * shortest estimated one. Without ETAs the segments are equal. The ETAs come with the run's snapshot, which the
 * Dashboard does not always hold (it is fetched and dropped as runs are opened elsewhere): the last ETAs seen for the
 * run stay in use, so the segments never jump between equal and proportional widths on their own (UI standard: nothing
 * moves on its own).
 */
export function MiniTimeline({ summary }: { summary: RunSummary }): React.JSX.Element | null {
  const live = useStore(
    useShallow((s) => {
      const snap = s.runs.byId[summary.runId]?.snapshot
      return summary.steps.map((st) => snap?.steps[st.key]?.eta?.p50 ?? 0)
    }),
  )
  const known = live.some((e) => e > 0)
  const kept = lastEtas.get(summary.runId)
  const etas = known ? live : kept !== undefined ? summary.steps.map((st) => kept.get(st.key) ?? 0) : live
  const stepKeys = summary.steps.map((st) => st.key).join(' ')
  const liveKey = live.join(' ')
  useEffect(() => {
    if (!known) return
    const keys = stepKeys.split(' ')
    const values = liveKey.split(' ').map(Number)
    lastEtas.set(summary.runId, new Map(keys.map((k, i) => [k, values[i] ?? 0])))
  }, [known, liveKey, stepKeys, summary.runId])
  if (summary.steps.length === 0) return null
  const sized = etas.filter((e) => e > 0)
  const proportional = sized.length > 0
  const unsized = proportional ? Math.max(1, Math.min(...sized) / 4) : 1
  const grow = (i: number): number => {
    const e = etas[i] ?? 0
    return proportional ? (e > 0 ? e : unsized) : 1
  }
  const cur = currentStep(summary)
  return (
    <ol
      aria-label="Steps"
      data-proportional={proportional || undefined}
      className="flex h-1.5 w-full gap-0.5"
    >
      {summary.steps.map((st, i) => {
        const label = `${summaryStepLabel(st.key, summary)}: ${PASS_STATUS_LABEL[st.status]}`
        return (
          <li
            key={st.key}
            aria-label={label}
            title={label}
            data-status={st.status}
            data-current={st === cur || undefined}
            style={{ flexGrow: grow(i), flexBasis: 0 }}
            className={cn(
              'h-full min-w-1.5 rounded-full',
              SEGMENT[STATUS_TONE[st.status]],
              st === cur && STRIPES,
            )}
          />
        )
      })}
    </ol>
  )
}

/** A run that is waiting on the user while it holds its folder (a queued run behind it "waits on you"). */
const WAITS_ON_USER: ReadonlySet<RunStatus> = new Set<RunStatus>(['waiting', 'paused', 'failed'])

/** Paused longer than this, a run is flagged stale on the Dashboard. */
export const STALE_MS = 24 * 60 * 60 * 1000

/** `45m`, `5h`, `2d`: how long something has been so. */
export function ageText(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** Since when core has had the run paused (its needs-you item), or undefined. */
function usePausedSince(runId: string | undefined): number | undefined {
  return useStore((s) =>
    runId === undefined
      ? undefined
      : s.attention.items.find((i) => i.runId === runId && i.kind === 'paused')?.since,
  )
}

/**
 * The footer's ETA, all from core's `progress`: `ETA ~6 min` (counting down to core's
 * `etaEndsAt`), "longer than usual" when core's `etaState` says so, and for a queued run "starts after run #N
 * (~ETA)" or "waits on you" from the run it queues behind. null when core has no ETA.
 */
export function etaText(s: RunSummary, now: number, blocker: RunSummary | undefined): string | null {
  if (s.status === 'queued') {
    if (blocker === undefined) return null
    if (WAITS_ON_USER.has(blocker.status)) return 'waits on you'
    const eta = etaRemainingMs(blocker.progress, now)
    return eta !== undefined
      ? `starts after run #${blocker.displayNo} (${formatEta(eta)})`
      : `starts after run #${blocker.displayNo}`
  }
  return formatRunEta(s.progress, now)
}

function BlockedLine({
  summary,
  blocker,
}: {
  summary: RunSummary
  blocker: RunSummary | undefined
}): React.JSX.Element {
  const now = useNow()
  const blockedBy = summary.blockedBy ?? ''
  const pausedSince = usePausedSince(blocker?.status === 'paused' ? blocker.runId : undefined)
  const [cancelling, setCancelling] = useState(false)
  // Stop is not undoable, so this is the Run view's Stop: core's error as a toast, then "Run stopped · changes kept".
  const cancel = async (): Promise<void> => {
    setCancelling(true)
    await stopRun(blockedBy)
    setCancelling(false)
  }
  const name = blocker !== undefined ? `run #${blocker.displayNo}` : 'another run'
  // What changes (the blocker's pause age, "Stopping…") comes AFTER the links, so Open and Cancel it never slide.
  const status = cancelling
    ? 'Stopping…'
    : pausedSince !== undefined
      ? `Paused ${ageText(now - pausedSince)}`
      : ''
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground" data-testid="phase-line">
      <span>Queued · blocked by {name}</span>
      <Button size="sm" variant="link" asChild className="h-auto text-xs">
        <a href={href({ name: 'run', runId: blockedBy })}>Open</a>
      </Button>
      <Button
        size="sm"
        variant="link"
        className="h-auto text-xs"
        loading={cancelling}
        data-testid={`blocked-cancel-${summary.runId}`}
        title={`Stop ${name} so this run can start`}
        onClick={() => void cancel()}
      >
        Cancel it
      </Button>
      {status !== '' && (
        <span className="text-xs tabular-nums" data-testid={`blocked-status-${summary.runId}`}>
          {status}
        </span>
      )}
    </p>
  )
}

function PhaseLine({
  summary,
  blocker,
}: {
  summary: RunSummary
  blocker: RunSummary | undefined
}): React.JSX.Element {
  const now = useNow()
  if (summary.status === 'queued' && summary.blockedBy !== undefined) {
    return <BlockedLine summary={summary} blocker={blocker} />
  }
  return (
    <p className="truncate text-sm text-muted-foreground" data-testid="phase-line">
      {phaseText(summary, now)}
    </p>
  )
}

function Footer({
  summary,
  blocker,
}: {
  summary: RunSummary
  blocker: RunSummary | undefined
}): React.JSX.Element {
  const now = useNow()
  const [stopping, setStopping] = useState(false)
  const p = summary.progress
  const eta = etaText(summary, now, blocker)
  // The pricing core describes now, amber when core says it is stale.
  const facts = usePricingFacts()
  const basis = runCostBasis(summary)
  const stalePrices = p.costUsd !== null && basis === 'catalog' && facts?.stale === true
  // The same Stop as the Run view's: core's error as a toast, then "Run stopped · changes kept" once cancelled.
  const stop = async (): Promise<void> => {
    setStopping(true)
    await stopRun(summary.runId)
    setStopping(false)
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums"
        title={
          p.costUsd !== null
            ? costTitle({ usd: p.costUsd, basis }, facts !== null ? pricingTitle(facts) : undefined)
            : undefined
        }
      >
        {formatDuration(now - summary.createdAt)} ·{' '}
        {eta !== null && (
          <>
            <span
              data-testid={`active-run-eta-${summary.runId}`}
              className={cn(eta === LONGER_THAN_USUAL && 'text-warning')}
            >
              {eta}
            </span>{' '}
            ·{' '}
          </>
        )}
        {`${formatTokens(p.tokens)} tokens · `}
        {p.costUsd !== null && (
          <>
            <span
              data-testid={`active-run-cost-${summary.runId}`}
              data-stale-prices={stalePrices || undefined}
              className={cn(stalePrices && 'text-warning')}
            >
              {formatRunCost(summary)}
            </span>
            {' · '}
          </>
        )}
        {formatFiles(p.filesChanged)}
      </p>
      <Button size="sm" variant="outline" asChild>
        <a href={href({ name: 'run', runId: summary.runId })}>Open</a>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon={<Square aria-hidden />}
        loading={stopping}
        disabled={!isActiveStatus(summary.status)}
        onClick={() => void stop()}
      >
        Stop
      </Button>
    </div>
  )
}

function StaleBadge({ summary }: { summary: RunSummary }): React.JSX.Element | null {
  const now = useNow()
  const since = usePausedSince(summary.status === 'paused' ? summary.runId : undefined)
  if (since === undefined || now - since <= STALE_MS) return null
  return (
    <Badge
      variant="paused"
      data-testid={`stale-${summary.runId}`}
      title={`Paused for ${ageText(now - since)}`}
    >
      Stale
    </Badge>
  )
}

export function ActiveRunCard({ runId }: { runId: string }): React.JSX.Element | null {
  const summary = useSummary(runId)
  const attention = useStore((s) => s.attention.items.filter((i) => i.runId === runId).length)
  const blocker = useStore((s) => {
    const id = s.summaries.byId[runId]?.blockedBy
    return id !== undefined ? s.summaries.byId[id] : undefined
  })
  if (summary === undefined) return null
  const titleId = `active-run-title-${runId}`
  return (
    <article
      aria-labelledby={titleId}
      data-testid={`active-run-${runId}`}
      data-status={summary.status}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge kind="run" status={summary.status} reserve className="shrink-0" />
        <a
          id={titleId}
          href={href({ name: 'run', runId })}
          // Cut to one line: the tooltip has it in full.
          title={`#${summary.displayNo} ${summary.title}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          <span className="text-muted-foreground tabular-nums">#{summary.displayNo}</span> {summary.title}
        </a>
        {summary.auto && <AutoBadge data-testid="auto-badge" />}
        <IsolatedChip summary={summary} />
        <MatchChip summary={summary} link />
        <StaleBadge summary={summary} />
        {attention > 0 && (
          <Badge variant="waiting">{attention === 1 ? 'Needs you' : `${attention} need you`}</Badge>
        )}
        <Tooltip content={summary.folder}>
          <span tabIndex={0} className="max-w-40 truncate text-xs text-muted-foreground outline-none">
            {folderBaseName(summary.folder)}
          </span>
        </Tooltip>
      </div>
      <PhaseLine summary={summary} blocker={blocker} />
      <MiniTimeline summary={summary} />
      <Footer summary={summary} blocker={blocker} />
    </article>
  )
}
