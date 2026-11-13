// The Prepare step of an isolated run (its stages, streamed to this card: 1 the worktree, 2 copy-ins, 3 deps, 4 the
// verify:0 baseline, 5 isolation.verifyReady; R2/R5).
// The header has the step's status (core's StepView); the line under it, which never wraps, its time. Then one row per
// prepare step as core lists them (StepView.prepare.steps, planned from the run's start): its state in words beside an
// icon, and one fixed line for core's detail, so a step finishing changes words in place. The dependency install's
// output streams into an inner region (data-scroll-region="prepare-output") with its full height from the start when
// core's rows say an install will run: it follows new output only while the user is at its bottom ("Jump to latest"
// otherwise) and never scrolls the page.
// UI standard (nothing moves on its own): nothing is inserted into the card while it is watched; a step
// already over when the card mounts shows its rows and keeps its output in a disclosure. What core reports after the
// step began (a pause, a snag) goes last.
import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useState } from 'react'
import type { PassStatus, RunSnapshot, StepView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, formatDuration, formatElapsedVsEta, stepLabel } from '../../lib/format.ts'
import { useStream } from '../../lib/streamBuffer.ts'
import { useNow } from '../../lib/ticker.ts'
import { Badge } from '../ui/Badge.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { isCounting, liveActiveMs } from './clock.ts'
import { JUMP_MARGIN, JumpToLatest, REGION, useFollowBottom } from './follow.tsx'
import { PREPARE_STEP_LABEL, prepareOutputFile, prepareRowsOf } from './isolation.ts'
import type { PrepareRow } from './isolation.ts'
import { PausedNotice } from './PausedNotice.tsx'
import { useLastEnvelope } from './runLog.ts'
import { SnagCard } from './SnagCard.tsx'
import { StatusIcon, STATUS_TEXT_TONE, StepStatus } from './StepStatus.tsx'
import { skipReasonText } from './text.ts'
import { tailText, useOutputText, VERIFY_REGION_MAX } from './VerifyOutput.tsx'

const FINISHED = new Set<PassStatus>(['done', 'skipped', 'cancelled'])

/** Every status word, so a row's word keeps one width as its step runs and ends. */
const STATUS_WORDS: readonly string[] = Object.values(PASS_STATUS_LABEL)

/** The install pane's height: fixed from the start while the step is watched (Run view: --run-region-max). */
const LIVE_HEIGHT = `h-[min(20rem,var(--run-region-max,50vh))] ${VERIFY_REGION_MAX}`

export const INSTALL_WAITING = 'The install has not started yet.'
export const INSTALL_WAITING_CARD = 'Waiting for your choice below'
export const INSTALL_NO_OUTPUT = 'No install output was recorded.'

/** The install will run, or ran: core lists its step and has not skipped it. */
function installPlanned(rows: readonly PrepareRow[] | null): boolean {
  const deps = rows?.find((r) => r.id === 'deps')
  return deps !== undefined && deps.status !== 'skipped' && deps.status !== 'cancelled'
}

/**
 * The dependency install's output: core's run output file when it serves one (announced by `output` bodies), else the
 * step's own stream. One pane either way, so the source never changes its size.
 */
export const PrepareOutput = memo(function PrepareOutput({
  runId,
  attempt,
  live,
  waiting,
}: {
  runId: string
  attempt: number
  /** The step is live: the pane takes its full height and keeps it. */
  live: boolean
  waiting: string
}): React.JSX.Element {
  const file = prepareOutputFile()
  const announced = useLastEnvelope(runId, 'output', (b) => b.file === file, {
    enabled: file !== null,
    key: attempt,
  })
  const version =
    announced !== undefined && announced !== null
      ? String(announced.body.version)
      : announced === null && !live
        ? 'final'
        : null
  const out = useOutputText(runId, file, version)
  const stream = useStream(runId, 'prepare')
  const streamed = stream.blocks
    .map((b) => (b.kind === 'text' ? b.text : b.kind === 'error' ? b.message : ''))
    .join('')
  const text = out.text ?? (streamed !== '' ? streamed : null)
  const shown = text !== null ? tailText(text) : null
  const { ref, innerRef, onScroll, atBottom, jumpToLatest } = useFollowBottom<HTMLDivElement>(
    shown?.text.length ?? 0,
    true,
  )
  // Once the pane has had its live height it keeps it while shown: a step that finishes never shrinks it.
  const [fixed, setFixed] = useState(live)
  if (live && !fixed) setFixed(true)
  return (
    <div className="relative">
      <div
        ref={ref}
        role="log"
        aria-live="off"
        aria-label="Output of the dependency install"
        tabIndex={0}
        data-testid="prepare-output"
        data-scroll-region="prepare-output"
        onScroll={onScroll}
        className={cn(
          'stream-text rounded-md bg-muted/40 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          REGION,
          fixed ? LIVE_HEIGHT : VERIFY_REGION_MAX,
        )}
      >
        <div ref={innerRef}>
          {shown?.cut === true && (
            <p className="pb-1 text-xs text-muted-foreground" data-testid="prepare-output-cut">
              Showing the newest output only. The whole log is kept with the run.
            </p>
          )}
          {shown !== null && shown.text !== '' ? (
            <pre className="break-words whitespace-pre-wrap">{shown.text}</pre>
          ) : (
            <div className="text-xs text-muted-foreground">
              {out.error !== null ? `The output could not be read: ${out.error}` : waiting}
            </div>
          )}
        </div>
      </div>
      {!atBottom && <JumpToLatest testId="prepare-output-jump" onClick={jumpToLatest} />}
    </div>
  )
})

function Row({ row }: { row: PrepareRow }): React.JSX.Element {
  const testId = `prepare-step-${row.id}`
  const label = PREPARE_STEP_LABEL[row.id]
  return (
    <li data-testid={testId} data-status={row.status} className="flex min-w-0 flex-col gap-0.5 py-1">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StatusIcon status={row.status} />
        <span className="min-w-0 truncate font-medium" title={label}>
          {label}
        </span>
        <span className="sr-only">: </span>
        <span
          className={cn('shrink-0 text-xs', STATUS_TEXT_TONE[row.status])}
          data-testid={`${testId}-status`}
        >
          <StableLabel labels={STATUS_WORDS} align="start">
            {PASS_STATUS_LABEL[row.status]}
          </StableLabel>
        </span>
      </div>
      {/* One line, always there: core's detail ("Copied 2 files", "pnpm install --frozen-lockfile"). */}
      <p
        className="h-4 min-w-0 truncate pl-6 text-xs text-muted-foreground"
        data-testid={`${testId}-detail`}
        title={row.detail ?? undefined}
      >
        {row.detail ?? ''}
      </p>
    </li>
  )
}

export interface PrepareCardProps {
  runId: string
  snap: RunSnapshot
  view: StepView
  /** The step was already over when the Run view opened: the card starts collapsed. */
  finishedAtOpen?: boolean
}

export const PrepareCard = memo(function PrepareCard({
  runId,
  snap,
  view,
  finishedAtOpen,
}: PrepareCardProps) {
  const counting = isCounting(view)
  const now = useNow(counting)
  const finished = FINISHED.has(view.status)
  const [open, setOpen] = useState<boolean | null>(null)
  const [startCollapsed] = useState(finishedAtOpen ?? finished)
  const expanded = open ?? !startCollapsed
  const live = view.status === 'running' || view.status === 'waiting' || view.status === 'stalled'
  // The view watched the step run: its layout stays the live one for as long as the card is shown.
  const [watched, setWatched] = useState(live)
  if (live && !watched) setWatched(true)

  const label = stepLabel(view.key)
  const rows = prepareRowsOf(view)
  // Whether the card has an install pane is decided once, from what core said when the card first showed: it never
  // appears later (it would push down the cards after this one).
  const [withOutput] = useState(() => installPlanned(rows))
  const time =
    view.attempt === 0 && view.activeMs === 0
      ? null
      : counting
        ? formatElapsedVsEta(liveActiveMs(view, snap, now), view.eta)
        : formatDuration(view.activeMs)
  const reason =
    view.status === 'skipped'
      ? skipReasonText(view.reason)
      : view.status === 'failed' || view.status === 'paused'
        ? undefined
        : view.reason
  const reasonText =
    reason === undefined || reason === '' ? '' : view.status === 'skipped' ? `Skipped · ${reason}` : reason
  const hasBody = rows !== null && rows.length > 0
  const [outputOpen, setOutputOpen] = useState(false)

  const output = withOutput ? (
    <PrepareOutput
      runId={runId}
      attempt={view.attempt}
      live={live}
      waiting={view.status === 'waiting' ? INSTALL_WAITING_CARD : live ? INSTALL_WAITING : INSTALL_NO_OUTPUT}
    />
  ) : null

  return (
    <article
      id={`pass-card-${view.key}`}
      data-testid={`pass-card-${view.key}`}
      data-kind="prepare"
      data-status={view.status}
      aria-label={`${label}: ${PASS_STATUS_LABEL[view.status]}`}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground',
        JUMP_MARGIN,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {hasBody ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="pass-body-prepare"
            onClick={() => setOpen(!expanded)}
            className="-ml-1 inline-flex items-center gap-1 rounded px-1 text-sm font-semibold hover:bg-accent"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="size-4" />
            ) : (
              <ChevronRight aria-hidden className="size-4" />
            )}
            <h3>{label}</h3>
          </button>
        ) : (
          <h3 className="text-sm font-semibold">{label}</h3>
        )}
        <StepStatus status={view.status} reserve />
        <Badge variant="outline" className="font-normal">
          Isolated copy
        </Badge>
        {view.attempt > 1 && (
          <Badge variant="outline" className="font-normal">
            attempt {view.attempt}
          </Badge>
        )}
      </header>
      {time !== null && (
        <p
          data-testid="pass-metrics-prepare"
          className="-mt-1 flex h-4 min-w-0 items-center gap-3 overflow-clip text-xs whitespace-nowrap text-muted-foreground tabular-nums [overflow-clip-margin:0.25rem]"
        >
          <span className="shrink-0" data-testid="pass-time-prepare">
            {time}
          </span>
        </p>
      )}
      {/* Core's reason ("waiting for your choice") comes and goes: in a step the view watched, its line is always
          there (one line, cut with a tooltip), so the rows and the output never move. */}
      {(watched || reasonText !== '') && (
        <p
          className={cn('text-xs text-muted-foreground', watched && 'h-4 truncate')}
          data-testid="pass-reason-prepare"
          title={reasonText !== '' ? reasonText : undefined}
        >
          {reasonText}
        </p>
      )}
      {hasBody && expanded && (
        <div id="pass-body-prepare" className="flex flex-col gap-2">
          <ul aria-label="Prepare steps" className="flex flex-col" data-testid="prepare-steps">
            {rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </ul>
          {output !== null &&
            (watched ? (
              output
            ) : (
              <details
                className="text-sm"
                data-testid="prepare-output-details"
                onToggle={(e) => setOutputOpen(e.currentTarget.open)}
              >
                <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                  Install output
                </summary>
                {outputOpen && <div className="mt-1">{output}</div>}
              </details>
            ))}
        </div>
      )}
      <PausedNotice runId={runId} view={view} />
      <SnagCard runId={runId} view={view} />
    </article>
  )
})
