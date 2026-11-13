// One step of the run: header with status, vendor/model/mode chips (mode copy from
// StepView.modeCopy, amber when degraded), the plan-mode chip, elapsed vs ETA, tokens and cost with its basis, and
// the attempt; a ⋯ menu (Retry, Continue without, Copy launch command, Open raw log); the session line (Fix, and any
// pass core resumed: SessionLine.tsx); the live stream from the first byte, with a status line instead of a spinner
// before output; collapsed once finished (when the Run view opens on it).
// Plan shows its plan (and the gate edit); Review and Critic list their own findings from core's findings.json (their
// report when core could not structure it). Everything shown is core's, including the step's chip, such as
// Implement's "3 files changed during planning" (edits during planning fold into S0).
// Test-first's Tests step is an agent step like Implement (its vendor, stream, asks and pass actions); once its end
// snapshot is in, its card lists the test files it wrote (in a disclosure) and keeps one line for Dim Factory's check
// that Implement left them whole, so the check's answer fills that line instead of adding one.
// UI standard (nothing moves on its own): time, tokens and cost have a line of their own that never
// wraps, so the header keeps its height as they grow (the context meter keeps a slot of one width at its end from the
// step's start); the stream is an inner region with its live height from the
// start (StreamPane); what core reports after the step started (the session line, a pause, a snag) goes after the
// output, so it never pushes the stream down; and a step that finishes while the view is open keeps its card open
// until the user collapses it (collapsing on its own would move the page, or the scroller under the user).
import { ChevronDown, ChevronRight, Ellipsis } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { Finding } from '@shared/findings.ts'
import type { AgentStep, RunSnapshot, StepCost, StepKey, StepView, TestFirstView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { costPricingFacts, pricingTitle, usePricingFacts } from '../../lib/pricing.ts'
import {
  PASS_STATUS_LABEL,
  PAUSE_REASON_LABEL,
  costTitle,
  formatCost,
  formatDuration,
  formatElapsedVsEta,
  formatUsage,
  runStepLabel,
  securityAdvisorUsed,
  stepLabel,
  vendorName,
} from '../../lib/format.ts'
import { useNow } from '../../lib/ticker.ts'
import { isActiveStatus } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'
import { reviewerFindings } from '../cards/payload.ts'
import { GROUNDING_SOURCE_LABEL, HALLUCINATION_LABEL, isGroundingFinding } from '../cards/BeforeFixBody.tsx'
import { PlanDiff, editCounts } from '../cards/PlanDiff.tsx'
import { ClarifyFacts } from './ClarifyFacts.tsx'
import { ResearchFacts } from './ResearchFacts.tsx'
import { DeployFacts } from './DeployFacts.tsx'
import { AcceptanceChecklist } from './AcceptanceChecklist.tsx'
import { RoundChip } from './FixRounds.tsx'
import { RecheckFacts, SecurityFindings } from './SecurityCard.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { liveActiveMs } from './clock.ts'
import { copyText, runCommand, useBusy } from './commands.ts'
import { LightMarkdown, renderInline } from './LightMarkdown.tsx'
import { useRunOutput } from './outputs.ts'
import { PausedNotice } from './PausedNotice.tsx'
import { SessionLine } from './SessionLine.tsx'
import { usePlanInfo } from './plan.ts'
import type { PlanInfo } from './plan.ts'
import { JUMP_MARGIN } from './follow.tsx'
import { findLastEnvelope, useLastEnvelope } from './runLog.ts'
import { SnagCard } from './SnagCard.tsx'
import { StepStatus } from './StepStatus.tsx'
import { StreamPane } from './StreamPane.tsx'
import {
  MODE_TEXT,
  SKIPPABLE,
  commandName,
  contextMeterText,
  contextMeterTitle,
  formatCommandLine,
  isAgent,
  modelChipReserve,
  modelChipText,
  modelChipTitle,
  planModeText,
  skipReasonText,
} from './text.ts'

const FINISHED = new Set(['done', 'skipped', 'cancelled'])

/**
 * A pass's cost with its basis. A catalog-priced figure names its pricing ("est. from
 * pricing fetched <date> (unverified)") and is amber when those prices were stale. The facts are the
 * ones core froze with the figure (the run's own prices); only a figure without them, while the run goes on, names
 * the pricing core describes now; otherwise the plain words.
 */
function PassCost({ cost, live }: { cost: StepCost; live: boolean }): React.JSX.Element {
  const facts = usePricingFacts()
  const priced = costPricingFacts(cost) ?? (live ? facts : null)
  const stale = cost.basis === 'catalog' && priced?.stale === true
  return (
    <Tooltip content={costTitle(cost, priced !== null ? pricingTitle(priced) : undefined)}>
      <span
        tabIndex={0}
        data-stale-prices={stale || undefined}
        className={cn('shrink-0', stale && 'text-warning')}
      >
        {formatCost(cost)}
      </span>
    </Tooltip>
  )
}

/**
 * The context meter ("Context 42% · 2 summaries", "Context n/a", "Summarising…"): a slot of one fixed width at the
 * end of the metrics line, there from the step's start (UI standard: nothing moves on its own), amber from 80% or two
 * summaries. Its tooltip names the tokens, the window, the peak and the baseline.
 */
function ContextMeter({
  cardId,
  context,
}: {
  cardId: string
  context: StepView['context']
}): React.JSX.Element {
  const text = contextMeterText(context)
  return (
    <Tooltip content={contextMeterTitle(context)}>
      <span
        tabIndex={0}
        data-testid={`pass-context-${cardId}`}
        data-warn={context?.warn === true || undefined}
        data-compacting={context?.compacting === true || undefined}
        className={cn(
          'ml-auto w-[24ch] shrink-0 truncate text-right',
          context?.warn === true && 'text-warning',
        )}
      >
        {text}
      </span>
    </Tooltip>
  )
}

function Chip({
  children,
  title,
  tone,
  testId,
  reserve,
}: {
  children: React.ReactNode
  title?: string
  tone?: 'auto' | 'warn'
  testId?: string
  /**
   * Texts whose widest the chip keeps whatever it shows (UI standard: nothing moves on its own): each is an invisible
   * sizer in one grid cell, and the shown text sits over them, cut with an ellipsis when longer; the tooltip should
   * then name it in full.
   */
  reserve?: readonly string[]
}): React.JSX.Element {
  // A chip may shrink and truncate (a long model id), so the header wraps instead of widening the card.
  const badge = (
    <Badge
      variant={tone === 'auto' ? 'auto' : 'outline'}
      data-testid={testId}
      className={cn(
        'min-w-0 max-w-full shrink font-normal',
        tone === 'warn' && 'border-warning/50 text-warning',
      )}
      {...(title !== undefined ? { tabIndex: 0 } : {})}
    >
      {reserve === undefined ? (
        <span className="truncate">{children}</span>
      ) : (
        <span
          className="relative grid min-w-0 grid-cols-[minmax(0,max-content)] overflow-hidden"
          data-chip-reserve=""
        >
          {reserve.map((r) => (
            <span
              key={r}
              aria-hidden
              data-label={r}
              className="pointer-events-none invisible col-start-1 row-start-1 overflow-hidden whitespace-nowrap select-none after:content-[attr(data-label)]"
            />
          ))}
          <span className="absolute inset-0 truncate">{children}</span>
        </span>
      )}
    </Badge>
  )
  return title !== undefined ? <Tooltip content={title}>{badge}</Tooltip> : badge
}

/**
 * The model chip (UI standard: nothing moves on its own). It keeps the widths of the texts it reserved at its first
 * render for this pass and configured model (text.ts modelChipReserve): a queued pass with no model names the model
 * core expects (StepView.expectedModel) and reserves "default model" too, so whether its vendor then names that model,
 * another (cut to the width kept, the tooltip naming it in full) or none, the chips after it stay where they are.
 */
function ModelChip({ runId, view }: { runId: string; view: StepView }): React.JSX.Element | null {
  const text = modelChipText(view)
  const identity = `${runId}:${view.key}:${view.model === undefined ? 'unset' : view.model === null ? 'none' : `=${view.model}`}`
  const [first, setFirst] = useState(() => ({ identity, reserve: modelChipReserve(view) }))
  if (first.identity !== identity) setFirst({ identity, reserve: modelChipReserve(view) })
  if (view.model === undefined) return null
  const title = modelChipTitle(view)
  return (
    <Chip
      testId={`model-chip-${view.key}`}
      reserve={first.identity === identity ? first.reserve : modelChipReserve(view)}
      {...(title !== undefined ? { title } : {})}
    >
      {text}
    </Chip>
  )
}

/**
 * "claude.exe spawned 3 s ago · waiting for first output" (the spawn time is the launch envelope's). Before the spawn,
 * what the launch waits on where core names it (e.g. Plan waits for the run-start snapshot, StepView.launchWait).
 */
function LaunchLine({
  runId,
  step,
  attempt,
  vendor,
  wait,
}: {
  runId: string
  step: StepKey
  attempt: number
  vendor: string | undefined
  wait: StepView['launchWait']
}): React.JSX.Element {
  const now = useNow()
  const launch = useLastEnvelope(
    runId,
    'step-status',
    (b) => b.step === step && b.attempt === attempt && b.argv !== undefined && b.argv.length > 0,
    { key: attempt },
  )
  // Before the step reports its vendor (the first moments of a launch), say what is starting in plain words.
  const name = vendor !== undefined ? vendorName(vendor) : 'the vendor CLI'
  if (launch === undefined || launch === null) {
    return (
      <span data-testid={`launch-line-${step}`}>
        {wait === 'run-start'
          ? `Taking the run-start snapshot · ${name} starts after it`
          : `Starting ${name} · waiting for first output`}
      </span>
    )
  }
  const bin = commandName(launch.body.argv?.[0] ?? name)
  const ago = Math.max(0, Math.round((now - launch.ts) / 1000))
  return (
    <span data-testid={`launch-line-${step}`}>
      {bin} spawned {ago} s ago · waiting for first output
    </span>
  )
}

function PassMenu({
  runId,
  view,
  frozen,
}: {
  runId: string
  view: StepView
  /** An earlier round's card: Retry and Continue without (they act on the latest attempt) stay disabled. */
  frozen: boolean
}): React.JSX.Element | null {
  const [, run] = useBusy()
  if (!isAgent(view.key)) return null
  const pass: AgentStep = view.key
  const stuck = !frozen && (view.status === 'failed' || view.status === 'paused')
  const label = stepLabel(pass)
  const started = view.attempt > 0
  const copyLaunch = async (): Promise<void> => {
    const env = await findLastEnvelope(
      runId,
      (b) =>
        b.t === 'step-status' &&
        b.step === pass &&
        (!frozen || b.attempt === view.attempt) &&
        b.argv !== undefined &&
        b.argv.length > 0,
    )
    const argv = env?.body.t === 'step-status' ? env.body.argv : undefined
    if (argv === undefined) {
      toast({ level: 'warn', message: `No launch command was recorded for ${label}.` })
      return
    }
    await copyText(formatCommandLine(argv), 'Launch command')
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`More actions for ${label}`}
          data-testid={`pass-menu-${pass}`}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={!stuck}
          data-testid="pass-retry"
          onSelect={() => run('retry', () => runCommand(runId, 'runs.retryPass', { runId, pass }))}
        >
          Retry {label}
        </DropdownMenuItem>
        {SKIPPABLE.has(pass) && (
          <DropdownMenuItem
            disabled={!stuck}
            data-testid="pass-skip"
            onSelect={() => run('skip', () => runCommand(runId, 'runs.skipPass', { runId, pass }))}
          >
            Continue without {label}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!started}
          data-testid="pass-copy-launch"
          onSelect={() => run('copy', copyLaunch)}
        >
          Copy launch command
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!started}
          data-testid="pass-raw-log"
          onSelect={() =>
            run('raw', () => runCommand(null, 'shell.open', { target: 'rawLog', runId, step: pass }))
          }
        >
          Open raw log
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FindingsList({
  findings,
  testId,
}: {
  findings: readonly Finding[]
  testId: string
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid={testId}>
      {findings.map((f) => (
        <li key={f.id} className="flex items-baseline gap-2">
          <Badge variant={f.severity === 'must' ? 'failed' : 'secondary'} className="uppercase">
            {f.severity}
          </Badge>
          <span className="text-muted-foreground tabular-nums">F{f.n}</span>
          <span className="min-w-0 break-words">{renderInline(f.title)}</span>
          {isGroundingFinding(f) && (
            <Badge variant="outline" className="font-normal" data-testid={`pass-finding-grounding-${f.id}`}>
              {GROUNDING_SOURCE_LABEL}
            </Badge>
          )}
          {Array.isArray(f.flags) && f.flags.includes('possible-hallucination') && (
            <Badge variant="outline" className="border-warning/60 font-normal text-foreground">
              {HALLUCINATION_LABEL}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The guard line's words: Dim Factory's check that Implement left the tests whole (StepView.testFirst.guard). */
export function testGuardText(t: TestFirstView): string {
  if (t.guard === undefined) return 'Dim Factory checks these tests once Implement ends.'
  if (t.guard === 'checking') return 'Checking that Implement kept the tests whole…'
  if (t.guard === 'ok') return 'Implement kept the tests whole'
  if (t.guard === 'failed') return 'The check could not run'
  const n = t.weakened ?? 0
  return `Implement weakened the tests: ${n} ${n === 1 ? 'finding' : 'findings'}`
}

const GUARD_TONE: Readonly<Record<NonNullable<TestFirstView['guard']> | 'pending', string>> = {
  pending: 'text-muted-foreground',
  checking: 'text-muted-foreground',
  ok: 'text-st-done',
  weakened: 'text-st-failed',
  failed: 'text-warning',
}

/** The Tests step's facts: the test files it wrote, and the guard's line (there from the moment the files are known). */
function TestFirstFacts({ facts }: { facts: TestFirstView }): React.JSX.Element {
  const n = facts.files.length
  const guard = facts.guard
  return (
    <div className="flex flex-col gap-1" data-testid="tests-facts">
      <details className="text-sm" data-testid="tests-files">
        <summary className="cursor-pointer text-xs text-muted-foreground select-none">
          {`Wrote ${n} test ${n === 1 ? 'file' : 'files'}`}
        </summary>
        {n > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 pl-4" data-testid="tests-files-list">
            {facts.files.map((f) => (
              <li key={f} className="min-w-0 truncate font-mono text-xs" title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}
      </details>
      <p
        data-testid="tests-guard"
        data-guard={guard ?? 'pending'}
        className={cn('h-4 truncate text-xs', GUARD_TONE[guard ?? 'pending'])}
      >
        {testGuardText(facts)}
      </p>
    </div>
  )
}

function PlanBody({ info }: { info: PlanInfo }): React.JSX.Element | null {
  if (info.gateOpen)
    return <p className="text-sm text-muted-foreground">The plan is waiting for your review below.</p>
  if (info.plan.status === 'loading')
    return <p className="text-sm text-muted-foreground">Loading the plan…</p>
  if (info.plan.status !== 'ready') return null
  return <LightMarkdown text={info.plan.output.text} className="text-sm" />
}

function ReviewerBody({
  runId,
  view,
  snap,
}: {
  runId: string
  view: StepView
  snap: RunSnapshot
}): React.JSX.Element | null {
  const source = view.key === 'critic' ? 'critic' : 'review'
  const done = view.status === 'done'
  const { review, critic } = snap.steps
  // findings.json is rewritten as each reviewer's parse lands (F-numbers span both), and core says so with an `output`
  // body: its version keys the read, so a card open since its step finished shows the findings once they are written.
  const written = useLastEnvelope(runId, 'output', (b) => b.file === 'findings', { enabled: done })
  const version = written?.body.version ?? 0
  const key = `${review.attempt}:${review.status}|${critic.attempt}:${critic.status}|${version}`
  const file = useRunOutput(runId, 'findings', key, done)
  const mine = file.status === 'ready' ? reviewerFindings(file.output.text, source) : null
  // `none` is core's "no findings"; other statuses (untagged, unstructured, empty, failed) keep the report.
  const listed = mine !== null && (mine.findings.length > 0 || mine.status === 'none')
  const report = useRunOutput(
    runId,
    source,
    `${view.attempt}:${view.status}`,
    done && file.status !== 'loading' && !listed,
  )
  if (!done) return null
  if (file.status === 'loading') return <p className="text-sm text-muted-foreground">Loading the findings…</p>
  if (listed) {
    return mine.findings.length === 0 ? (
      <p className="text-sm text-muted-foreground" data-testid={`no-findings-${source}`}>
        No findings from {stepLabel(view.key)}.
      </p>
    ) : (
      <FindingsList findings={mine.findings} testId={`findings-${source}`} />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {report.status === 'ready' && <LightMarkdown text={report.output.text} className="text-sm" />}
      {report.status === 'loading' && <p className="text-sm text-muted-foreground">Loading the report…</p>}
    </div>
  )
}

export interface PassCardProps {
  runId: string
  snap: RunSnapshot
  view: StepView
  /**
   * The step was already over when the Run view opened (RunPage), so the card starts collapsed. Absent: decided by the
   * step's status when the card mounts.
   */
  finishedAtOpen?: boolean
  /**
   * Fix until green: the view is an earlier round's, frozen as it ended (FixRoundView.views). The card shows that
   * round's attempt and offers nothing that would act on the step's latest attempt.
   */
  frozen?: boolean
  /** Names a second card of the same step in the flow (`round-2`): its ids are `pass-card-<step>-<instance>`. */
  instance?: string
}

export const PassCard = memo(function PassCard({
  runId,
  snap,
  view,
  finishedAtOpen,
  frozen = false,
  instance,
}: PassCardProps) {
  const cardId = instance !== undefined ? `${view.key}-${instance}` : view.key
  const counting = view.status === 'running' || view.status === 'stalled'
  const now = useNow(counting)
  const finished = FINISHED.has(view.status)
  const [open, setOpen] = useState<boolean | null>(null)
  // The card collapses after done as the view opens: a step already finished then starts
  // collapsed. One that finishes while the view is open stays as it is until the user collapses it (UI
  // standard: nothing moves on its own; a card collapsing above the view would still move the page scroller). A card
  // mounts once its step begins, so a step that begins and ends between two renders mounts finished: the view's own
  // record (finishedAtOpen) keeps it open.
  const [startCollapsed] = useState(finishedAtOpen ?? finished)
  const expanded = open ?? !startCollapsed
  const pass = isAgent(view.key)
  const label = runStepLabel(view.key, snap.steps)
  const elapsed = liveActiveMs(view, snap, now)
  const planInfo = usePlanInfo(runId, snap, view.key === 'plan')
  const [showEdit, setShowEdit] = useState(false)

  const reason = (() => {
    switch (view.status) {
      case 'skipped':
        return skipReasonText(view.reason)
      case 'paused':
        return view.pause !== undefined ? PAUSE_REASON_LABEL[view.pause] : view.reason
      case 'failed':
        // The snag below says what went wrong.
        return undefined
      case 'cancelled':
        return view.reason === 'user' ? 'You stopped the run' : view.reason
      case 'queued':
      case 'running':
      case 'waiting':
      case 'stalled':
      case 'done':
        return view.reason
    }
  })()
  const planChip =
    view.key === 'plan' ? planModeText(view.planMode, view.vendor, view.planFallbackReason) : undefined
  // The chip names the mode in a word or two; core's support().copy (a sentence) is the line under the header and the
  // chip's tooltip, so it wraps with the card instead of stretching a one-line chip.
  const modeLabel = view.mode !== undefined ? MODE_TEXT[view.mode] : undefined
  const modeCopyText = view.modeCopy?.copy
  const degraded = view.modeCopy !== undefined && view.modeCopy.status !== 'supported'
  const modeTitle = [modeCopyText, view.modeCopy?.reason].filter((s) => s !== undefined && s !== '').join(' ')
  const time =
    view.attempt === 0 && view.activeMs === 0
      ? null
      : counting
        ? formatElapsedVsEta(elapsed, view.eta)
        : formatDuration(view.activeMs)

  // Stable between ticks and snapshots, so the memoized StreamPane re-renders only for its own stream.
  const liveStep = view.status === 'running' || view.status === 'waiting' || view.status === 'stalled'
  const waiting = useMemo(
    () =>
      liveStep ? (
        <LaunchLine
          runId={runId}
          step={view.key}
          attempt={view.attempt}
          vendor={view.vendor}
          wait={view.launchWait}
        />
      ) : (
        'No output was recorded.'
      ),
    [liveStep, runId, view.key, view.attempt, view.vendor, view.launchWait],
  )

  const body = (() => {
    if (!pass || view.attempt === 0) return null
    // A step of Fix until green shows its own round's attempt (the next round's stream starts before the snapshot
    // says the round changed); other steps show their latest.
    const attempt = frozen || view.round !== undefined ? view.attempt : undefined
    const live = (
      <StreamPane
        runId={runId}
        step={view.key}
        waiting={waiting}
        live={liveStep}
        {...(attempt !== undefined ? { attempt } : {})}
      />
    )
    if (view.key === 'plan' && view.status === 'done') {
      return (
        <>
          <PlanBody info={planInfo} />
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground select-none">
              Vendor output
            </summary>
            <div className="mt-1">{live}</div>
          </details>
        </>
      )
    }
    if ((view.key === 'review' || view.key === 'critic') && view.status === 'done') {
      return (
        <>
          <ReviewerBody runId={runId} view={view} snap={snap} />
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground select-none">
              Vendor output
            </summary>
            <div className="mt-1">{live}</div>
          </details>
        </>
      )
    }
    if (
      (view.key === 'clarify' ||
        view.key === 'research' ||
        view.key === 'acceptance' ||
        view.key === 'explain') &&
      view.status === 'done'
    ) {
      // The questions and answers (Research: what was kept) are the card's facts below; the vendor's own answer stays one click away.
      return (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none">
            Vendor output
          </summary>
          <div className="mt-1">{live}</div>
        </details>
      )
    }
    if (view.key === 'security' && view.status === 'done') {
      return (
        <>
          <SecurityFindings runId={runId} snap={snap} done />
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground select-none">
              Vendor output
            </summary>
            <div className="mt-1">{live}</div>
          </details>
        </>
      )
    }
    return live
  })()

  return (
    <article
      id={`pass-card-${cardId}`}
      data-testid={`pass-card-${cardId}`}
      data-status={view.status}
      aria-label={`${label}: ${PASS_STATUS_LABEL[view.status]}`}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground',
        JUMP_MARGIN,
      )}
    >
      <header className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {body !== null ? (
            // Accessibility: the heading holds the disclosure button, not the reverse (a button's content is
            // presentational, so a heading inside it was left out of the page's headings).
            <h3 className="flex text-sm font-semibold">
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
                {label}
              </button>
            </h3>
          ) : (
            <h3 className="text-sm font-semibold">{label}</h3>
          )}
          <StepStatus status={view.status} reserve />
          {view.vendor !== undefined && <Chip>{vendorName(view.vendor)}</Chip>}
          <ModelChip runId={runId} view={view} />
          {/* Known with the model (the run's config): it never appears on its own later. */}
          {view.effort !== undefined && (
            <Chip testId={`effort-chip-${view.key}`}>{`${view.effort} effort`}</Chip>
          )}
          {modeLabel !== undefined && (
            <Chip
              {...(degraded ? { tone: 'auto' as const } : {})}
              {...(modeTitle !== '' ? { title: modeTitle } : {})}
              testId={`mode-chip-${view.key}`}
            >
              {modeLabel}
            </Chip>
          )}
          {planChip !== undefined && (
            <Chip
              testId="plan-mode-chip"
              {...(view.planFallbackReason !== undefined ? { tone: 'warn' as const } : {})}
            >
              {planChip}
            </Chip>
          )}
          {/* Fix until green's rounds are attempts of Fix, Final verify and the re-check: the round chip says which. */}
          {view.attempt > 1 && view.round === undefined && <Chip>attempt {view.attempt}</Chip>}
          {/* Core's fact about how the step started ("3 files changed during planning"), set before it starts. */}
          {view.chip !== undefined && view.chip !== '' && (
            <Chip testId={`step-chip-${view.key}`} title={view.chip}>
              {view.chip}
            </Chip>
          )}
          {planInfo.edit !== null && (
            <button
              type="button"
              data-testid="plan-edited-chip"
              aria-expanded={showEdit}
              aria-controls="plan-edit-diff"
              onClick={() => setShowEdit((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-primary/40 px-1.5 py-px text-xs hover:bg-accent"
            >
              Edited {editCounts(planInfo.edit)}
              {showEdit ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )}
            </button>
          )}
          {/* Last in the row, so its arrival moves no other chip; one width for every round. */}
          {view.round !== undefined && <RoundChip round={view.round} testId={`round-chip-${cardId}`} />}
        </div>
        <PassMenu runId={runId} view={view} frozen={frozen} />
      </header>
      {/* Time, tokens and cost on a line of their own that never wraps, so the header keeps its height as they
          appear and grow (UI standard). Present from the step's start. */}
      {(time !== null || view.usage !== undefined || view.cost !== undefined) && (
        <p
          data-testid={`pass-metrics-${cardId}`}
          className="-mt-1 flex h-4 min-w-0 items-center gap-3 overflow-clip text-xs whitespace-nowrap text-muted-foreground tabular-nums [overflow-clip-margin:0.25rem]"
        >
          {time !== null && (
            <span className="shrink-0" data-testid={`pass-time-${cardId}`}>
              {time}
            </span>
          )}
          {view.usage !== undefined && (
            // Cut to the line where the card is narrow (two cards side by side, a wider font), so the title says the
            // counts in full.
            <span
              className="min-w-0 truncate"
              title={
                view.usageApprox === true
                  ? `Approximate token counts: ${formatUsage(view.usage)}`
                  : formatUsage(view.usage)
              }
            >
              {view.usageApprox === true ? '≈ ' : ''}
              {formatUsage(view.usage)}
            </span>
          )}
          {view.cost !== undefined && view.cost.usd !== null && (
            <PassCost cost={view.cost} live={isActiveStatus(snap.summary.status)} />
          )}
          {pass && view.attempt > 0 && <ContextMeter cardId={cardId} context={view.context} />}
        </p>
      )}
      {/* Shown while the step runs, and after while the card stays open (a step finishing in view keeps the line). */}
      {modeCopyText !== undefined &&
        modeCopyText !== '' &&
        (!FINISHED.has(view.status) || (body !== null && expanded)) && (
          <p
            data-testid={`mode-copy-${view.key}`}
            className={cn('text-xs break-words text-muted-foreground', degraded && 'text-warning')}
          >
            {modeCopyText}
            {view.modeCopy?.reason !== undefined && view.modeCopy.reason !== '' && ` ${view.modeCopy.reason}`}
          </p>
        )}
      {reason !== undefined && reason !== '' && (
        <p className="text-xs text-muted-foreground" data-testid={`pass-reason-${view.key}`}>
          {view.status === 'skipped' ? `Skipped · ${reason}` : reason}
        </p>
      )}
      {showEdit && planInfo.edit !== null && (
        <div id="plan-edit-diff">
          <PlanDiff diff={planInfo.edit} testId="plan-edit-diff" />
        </div>
      )}
      {body !== null && expanded && (
        <div id={`pass-body-${cardId}`} className="flex flex-col gap-2">
          {body}
        </div>
      )}
      {view.key === 'tests' && view.testFirst !== undefined && <TestFirstFacts facts={view.testFirst} />}
      {view.key === 'clarify' && view.clarify !== undefined && <ClarifyFacts view={view.clarify} />}
      {view.key === 'research' && view.research !== undefined && <ResearchFacts view={view.research} />}
      {view.key === 'deploy' && view.deploy !== undefined && <DeployFacts view={view.deploy} />}
      {view.key === 'acceptance' && view.acceptance !== undefined && (
        <AcceptanceChecklist view={view.acceptance} testId="acceptance-facts" />
      )}
      {view.key === 'recheck' && view.attempt > 0 && (
        <RecheckFacts view={view.recheck} security={securityAdvisorUsed(snap.steps)} />
      )}
      {/* After the output: core decides these once the step is under way, and a line appearing here moves nothing. */}
      <SessionLine runId={runId} snap={snap} view={view} />
      {/* Their actions act on the step's latest attempt: never on an earlier round's card. */}
      {!frozen && <PausedNotice runId={runId} view={view} />}
      {!frozen && <SnagCard runId={runId} view={view} />}
    </article>
  )
})
