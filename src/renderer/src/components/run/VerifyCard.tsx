// One verify round in the Run view's flow.
// The header has the round's status (core's StepView); the line under it, which never wraps, its time and a summary of
// core's per-command results ("1 failed · 2 passed"). Each command has a row: its state in words beside an icon, how long it took (and the exit code of a
// failure), the command itself, and core's reason (why it was skipped or could not run). A failing command's excerpt
// shows under its row; a command Auto skipped because it is not trusted links to Settings, where it is trusted.
// The round's combined output is an inner region (VerifyOutput).
// UI standard (nothing moves on its own): while the view watches the round run, its output pane comes
// first at its full height and the rows follow, each with one fixed line for core's note, so a command finishing
// changes words in place; an excerpt opens there on a click. In a watched round the failFast fact joins
// the never-wrapping metrics line (core's per-row reason already says why each was skipped) instead of a paragraph
// under the rows, and core gives a first round its rows from its start, so the card never grows above notes that
// follow it. A round already over when the card mounts shows its rows
// first with the first failure's excerpt open (the others on a click: two inner regions stacked would leave the wheel
// no page between them) and its output in a disclosure: nothing is live, so nothing can move. Like a pass's
// card, it collapses only when the view opened on it finished, and what core reports after the round began (a pause,
// a snag) goes last.
// Test-first's red check (verify:red) reads the other way round: a one-line note above its rows says its checks should
// fail before Implement, a failing command there is not styled as a failure, and a round where none failed is the
// warning (core opens its card).
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { memo, useState } from 'react'
import type { RunSnapshot, StepView, VerifyCommandStatus, VerifyCommandView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, formatDuration, formatElapsedVsEta, stepLabel } from '../../lib/format.ts'
import { useNow } from '../../lib/ticker.ts'
import { Badge } from '../ui/Badge.tsx'
import { RoundChip } from './FixRounds.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { isCounting, liveActiveMs } from './clock.ts'
import { JUMP_MARGIN, REGION } from './follow.tsx'
import { PausedNotice } from './PausedNotice.tsx'
import { SnagCard } from './SnagCard.tsx'
import { StepStatus } from './StepStatus.tsx'
import { skipReasonText } from './text.ts'
import { VerifyOutput, VERIFY_REGION_MAX } from './VerifyOutput.tsx'
import {
  VERIFY_STATUS_LABEL,
  isRedCheck,
  showsExcerpt,
  verifyAborted,
  verifyCommandLine,
  verifyCommandsOf,
  verifyFactsText,
  verifySettingsHref,
  verifySummaryText,
} from './VerifyModel.ts'

const FINISHED = new Set(['done', 'skipped', 'cancelled'])

const SCENARIOS_SHOW = 'Show the scenarios'
const SCENARIOS_HIDE = 'Hide the scenarios'
const SCENARIO_NOT_REQUIRED = '(not required)'
const SCENARIO_WORD: Readonly<Record<'pass' | 'fail' | 'error', string>> = {
  pass: 'Passed',
  fail: 'Failed',
  error: 'Not played',
}

/** Every command status word, so a row's word keeps one width as the command runs and ends. */
const STATUS_WORDS: readonly string[] = Object.values(VERIFY_STATUS_LABEL)

const COMMAND_ICON: Readonly<Record<VerifyCommandStatus, LucideIcon>> = {
  queued: Circle,
  running: LoaderCircle,
  pass: CircleCheck,
  fail: CircleX,
  env: TriangleAlert,
  'skipped-untrusted': ShieldAlert,
  skipped: CircleMinus,
}

const COMMAND_TONE: Readonly<Record<VerifyCommandStatus, string>> = {
  queued: 'text-st-queued',
  running: 'text-st-running',
  pass: 'text-st-done',
  fail: 'text-st-failed',
  env: 'text-warning',
  'skipped-untrusted': 'text-st-waiting',
  skipped: 'text-st-skipped',
}

/** What the round says while it has no output yet. */
export const VERIFY_WAITING = 'Running the commands · waiting for output'
export const VERIFY_NO_OUTPUT = 'No output was recorded.'
export const TRUST_IN_SETTINGS = 'Trust it in Settings'
export const VERIFY_WAITING_CARD = 'Waiting for your choice below'
export const VERIFY_ABORTED = 'Stopped at the first failure: the remaining commands were skipped.'
/** The failFast fact on the metrics line of a round the view watched. */
export const VERIFY_ABORTED_SHORT = 'stopped at the first failure'
/** The red check's note above its rows. */
export const RED_CHECK_NOTE = 'Test-first: these checks should fail before Implement.'

function Excerpt({ text, testId }: { text: string; testId: string }): React.JSX.Element {
  return (
    <pre
      tabIndex={0}
      aria-label="Output excerpt"
      data-testid={testId}
      data-scroll-region="verify-output"
      className={cn(
        'stream-text rounded-md border bg-muted/40 px-2 py-1 break-words whitespace-pre-wrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
        REGION,
        VERIFY_REGION_MAX,
      )}
    >
      {text}
    </pre>
  )
}

function CommandRow({
  c,
  testId,
  folder,
  excerptOpen,
  expectFail = false,
}: {
  c: VerifyCommandView
  testId: string
  folder: string
  /** The excerpt shows at once (the round was over when the card mounted); else a click opens it. */
  excerptOpen: boolean
  /** The red check: a failing command is what the round expects, so it is not drawn as a failure. */
  expectFail?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(excerptOpen)
  // A play-test's scenarios open on a click, like an excerpt (the card never grows by itself).
  const [scenariosOpen, setScenariosOpen] = useState(false)
  const scenarios = c.scenarios ?? []
  const Icon = COMMAND_ICON[c.status]
  const tone = expectFail && c.status === 'fail' ? 'text-foreground' : COMMAND_TONE[c.status]
  const facts = verifyFactsText(c)
  const line = verifyCommandLine(c)
  const excerpt = showsExcerpt(c) ? (c.excerpt ?? '') : ''
  const note = c.reason ?? ''
  return (
    <li data-testid={testId} data-status={c.status} className="flex min-w-0 flex-col gap-0.5 py-1">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Icon
          aria-hidden
          className={cn('size-4 shrink-0', tone, c.status === 'running' && 'motion-safe:animate-spin')}
        />
        <span className="min-w-0 truncate font-medium" title={c.name}>
          {c.name}
        </span>
        <span className="sr-only">: </span>
        <span className={cn('shrink-0 text-xs', tone)} data-testid={`${testId}-status`}>
          <StableLabel labels={STATUS_WORDS} align="start">
            {VERIFY_STATUS_LABEL[c.status]}
          </StableLabel>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid={`${testId}-facts`}>
          {facts}
        </span>
      </div>
      <code className="min-w-0 truncate pl-6 font-mono text-xs text-muted-foreground" title={line}>
        {line}
      </code>
      {/* One line, always there: core's note, a way to see the failure, or the Settings link. */}
      <div className="flex h-5 min-w-0 items-center gap-2 pl-6 text-xs" data-testid={`${testId}-note`}>
        {note !== '' && (
          <span className="min-w-0 truncate text-muted-foreground" title={note}>
            {note}
          </span>
        )}
        {c.status === 'skipped-untrusted' && (
          <a
            href={verifySettingsHref(folder)}
            data-testid={`${testId}-trust`}
            className="shrink-0 text-primary underline-offset-4 hover:underline"
          >
            {TRUST_IN_SETTINGS}
          </a>
        )}
        {excerpt !== '' && (
          <button
            type="button"
            aria-expanded={open}
            data-testid={`${testId}-excerpt-toggle`}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex shrink-0 items-center gap-1 rounded text-primary hover:underline"
          >
            {open ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
            <StableLabel labels={['Show the failure', 'Hide the failure']} align="start">
              {open ? 'Hide the failure' : 'Show the failure'}
            </StableLabel>
          </button>
        )}
        {scenarios.length > 0 && (
          <button
            type="button"
            aria-expanded={scenariosOpen}
            data-testid={`${testId}-scenarios-toggle`}
            onClick={() => setScenariosOpen((v) => !v)}
            className="inline-flex shrink-0 items-center gap-1 rounded text-primary hover:underline"
          >
            {scenariosOpen ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
            <StableLabel labels={[SCENARIOS_SHOW, SCENARIOS_HIDE]} align="start">
              {scenariosOpen ? SCENARIOS_HIDE : SCENARIOS_SHOW}
            </StableLabel>
          </button>
        )}
      </div>
      {scenarios.length > 0 && scenariosOpen && (
        <ul
          className="flex flex-col gap-0.5 pl-6 text-xs"
          aria-label="Play-test scenarios"
          data-testid={`${testId}-scenarios`}
        >
          {scenarios.map((sc, i) => {
            const ScIcon = sc.status === 'pass' ? CircleCheck : CircleX
            return (
              <li
                key={`${i}-${sc.name}`}
                data-testid={`${testId}-scenario`}
                data-status={sc.status}
                className="flex min-w-0 items-center gap-2"
              >
                <ScIcon
                  aria-hidden
                  className={cn(
                    'size-3.5 shrink-0',
                    sc.status === 'pass' ? COMMAND_TONE.pass : COMMAND_TONE.fail,
                  )}
                />
                <span className="w-24 shrink-0">{SCENARIO_WORD[sc.status]}</span>
                <span className="min-w-0 truncate" title={sc.message ?? sc.name}>
                  {sc.name}
                  {sc.must ? '' : ` ${SCENARIO_NOT_REQUIRED}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {excerpt !== '' && open && (
        <div className="pl-6">
          <Excerpt text={excerpt} testId={`${testId}-excerpt`} />
        </div>
      )}
    </li>
  )
}

export interface VerifyCardProps {
  runId: string
  snap: RunSnapshot
  view: StepView
  /** The round was already over when the Run view opened (RunPage): the card starts collapsed. */
  finishedAtOpen?: boolean
  /** Fix until green: an earlier round's final verify, frozen as it ended (no actions on the latest attempt). */
  frozen?: boolean
  /** Names a second card of the same step in the flow (`round-2`): its ids are `pass-card-<step>-<instance>`. */
  instance?: string
}

export const VerifyCard = memo(function VerifyCard({
  runId,
  snap,
  view,
  finishedAtOpen,
  frozen = false,
  instance,
}: VerifyCardProps) {
  const cardId = instance !== undefined ? `${view.key}-${instance}` : view.key
  const counting = isCounting(view)
  const now = useNow(counting)
  const finished = FINISHED.has(view.status)
  const [open, setOpen] = useState<boolean | null>(null)
  const [startCollapsed] = useState(finishedAtOpen ?? finished)
  const expanded = open ?? !startCollapsed
  const live = view.status === 'running' || view.status === 'waiting' || view.status === 'stalled'
  // The view watched the round run: its layout stays the live one for as long as the card is shown.
  const [watched, setWatched] = useState(live)
  if (live && !watched) setWatched(true)

  const label = stepLabel(view.key)
  const commands = verifyCommandsOf(view)
  const isAborted = verifyAborted(view)
  const counts = verifySummaryText(commands)
  // In a watched round the failFast fact is part of the metrics line (no paragraph appears under the rows).
  const summary = counts !== null && isAborted && watched ? `${counts} · ${VERIFY_ABORTED_SHORT}` : counts
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
  const hasBody = view.attempt > 0 || commands.length > 0
  // A round over when the card mounts opens its first failure's excerpt (the rest on a click).
  const firstExcerpt = commands.findIndex(showsExcerpt)
  const failed = commands.some((c) => c.status === 'fail')
  const red = isRedCheck(view.key)
  // The red check needs a look when it ended with no failing command (the tests did not fail).
  const summaryTone = red
    ? view.status === 'done' && commands.length > 0 && !failed
      ? 'text-warning'
      : false
    : failed && 'text-st-failed'
  // A finished round's output is read only once the user opens it.
  const [outputOpen, setOutputOpen] = useState(false)

  const output = (
    <VerifyOutput
      runId={runId}
      step={view.key}
      attempt={view.attempt}
      live={live}
      waiting={view.status === 'waiting' ? VERIFY_WAITING_CARD : live ? VERIFY_WAITING : VERIFY_NO_OUTPUT}
    />
  )
  const rows =
    commands.length > 0 ? (
      <ul
        aria-label={`${label} commands`}
        className="flex flex-col"
        data-testid={`verify-commands-${cardId}`}
      >
        {commands.map((c, i) => (
          <CommandRow
            key={`${i}:${c.name}`}
            c={c}
            testId={`verify-command-${cardId}-${i}`}
            folder={snap.summary.folder}
            excerptOpen={!watched && i === firstExcerpt}
            expectFail={red}
          />
        ))}
      </ul>
    ) : null
  const aborted = isAborted ? (
    <p className="text-xs text-muted-foreground" data-testid={`verify-aborted-${cardId}`}>
      {VERIFY_ABORTED}
    </p>
  ) : null

  return (
    <article
      id={`pass-card-${cardId}`}
      data-testid={`pass-card-${cardId}`}
      data-kind="verify"
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
            aria-controls={`pass-body-${cardId}`}
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
        {view.attempt > 1 && view.round === undefined && (
          <Badge variant="outline" className="font-normal">
            attempt {view.attempt}
          </Badge>
        )}
        {/* Fix until green: the round this final verify belongs to (one width for every round). */}
        {view.round !== undefined && <RoundChip round={view.round} testId={`round-chip-${cardId}`} />}
      </header>
      {/* Time and core's results on a line of their own that never wraps, so the header keeps its height as the
          round's commands arrive and end (UI control standard). */}
      {(time !== null || summary !== null) && (
        <p
          data-testid={`pass-metrics-${cardId}`}
          className="-mt-1 flex h-4 min-w-0 items-center gap-3 overflow-clip text-xs whitespace-nowrap text-muted-foreground tabular-nums [overflow-clip-margin:0.25rem]"
        >
          {time !== null && (
            <span className="shrink-0" data-testid={`pass-time-${cardId}`}>
              {time}
            </span>
          )}
          {summary !== null && (
            <span
              data-testid={`verify-summary-${cardId}`}
              title={summary}
              className={cn('min-w-0 truncate', summaryTone)}
            >
              {summary}
            </span>
          )}
        </p>
      )}
      {/* Core's reason ("trust needed", "checks could not run") comes and goes as the round waits on a card and runs
          again: in a round the view watched, its line is always there (one line, cut with a tooltip), so the round's
          rows and output never move. */}
      {(watched || (reason !== undefined && reason !== '')) && (
        <p
          className={cn('text-xs text-muted-foreground', watched && 'h-4 truncate')}
          data-testid={`pass-reason-${cardId}`}
          title={reasonText !== '' ? reasonText : undefined}
        >
          {reasonText}
        </p>
      )}
      {hasBody && expanded && (
        <div id={`pass-body-${cardId}`} className="flex flex-col gap-2">
          {red && (
            <p className="h-4 truncate text-xs text-muted-foreground" data-testid="red-check-note">
              {RED_CHECK_NOTE}
            </p>
          )}
          {watched ? (
            <>
              {output}
              {rows}
            </>
          ) : (
            <>
              {rows}
              {aborted}
              {view.attempt > 0 && (
                <details
                  className="text-sm"
                  data-testid={`verify-output-details-${cardId}`}
                  onToggle={(e) => setOutputOpen(e.currentTarget.open)}
                >
                  <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                    Output
                  </summary>
                  {outputOpen && <div className="mt-1">{output}</div>}
                </details>
              )}
            </>
          )}
        </div>
      )}
      {/* Their actions act on the step's latest attempt: never on an earlier round's card. */}
      {!frozen && <PausedNotice runId={runId} view={view} />}
      {!frozen && <SnagCard runId={runId} view={view} />}
    </article>
  )
})
