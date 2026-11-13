// PhaseTimeline (Run view): preflight → prepare(+verify:0) → plan → ◇ → tests → verify:red → implement → verify:1 →
// review‖critic → ◇ → fix → verify:2 → finalize, leaving out steps the run does not use (tests and verify:red are
// Test-first's). Each node shows the status
// as colour + icon + words, the actual duration or elapsed vs ETA, and a tooltip with tokens, cost and the skip
// reason. Review and Critic share a column, side by side. A node scrolls to its PassCard (a click: the one way a node
// moves the page). In Auto the gates are off, so their diamonds show as skipped, marked AUTO.
//
// Two forms, for the Run view's two sticky blocks (headerForm.ts):
// - PhaseTimeline (full): every node has one fixed width (UI control standard: a button never changes size), so
//   the row does not shift as a step's status and ticking time change, and the row is one node tall (two lines: the
//   step; its status and time), Review and Critic included, so nothing under a node is left empty. A line too long
//   for the node is cut with an ellipsis and read in full in the tooltip and by screen readers. When there are more
//   steps than fit, the row wraps instead of scrolling sideways. TimelineRuler is the same row, unseen, measured while
//   the compact strip shows (what the full block would take at the page's width now).
// - PhaseStrip (compact): one line of step chips (status icon and step; the status words and time in the tooltip and
//   for screen readers), gates as small diamonds, the step the run is at highlighted. A chip's width never changes
//   with its status. The line never wraps and never scrolls: when the steps do not fit, the oldest settled ones give
//   way behind a "+N" chip that names them (stripFit.ts), and a click on it goes to the first of them.
import { Diamond } from 'lucide-react'
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { PassStatus, RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import {
  PASS_STATUS_LABEL,
  formatCost,
  formatDuration,
  formatElapsedVsEta,
  formatUsage,
  runStepLabel,
  stepLabel,
} from '../../lib/format.ts'
import { useNow } from '../../lib/ticker.ts'
import { StableLabel } from '../ui/StableLabel.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { isCounting, liveActiveMs } from './clock.ts'
import { timelineColumns } from './steps.ts'
import type { TimelineColumn } from './steps.ts'
import { fitStrip } from './stripFit.ts'
import type { StripFit } from './stripFit.ts'
import { StatusIcon, STATUS_TEXT_TONE } from './StepStatus.tsx'
import { skipReasonText } from './text.ts'
import { isRedCheck, verifyCommandsOf, verifyOutcome, verifySummaryText } from './VerifyModel.ts'

function nodeTime(view: StepView, snap: RunSnapshot, now: number): string | null {
  if (isCounting(view)) return formatElapsedVsEta(liveActiveMs(view, snap, now), view.eta)
  if (view.attempt === 0 && view.activeMs === 0) return null
  return formatDuration(view.activeMs)
}

function nodeTip(view: StepView, label: string, time: string | null): string {
  const parts: string[] = [`${label}: ${PASS_STATUS_LABEL[view.status]}`]
  if (time !== null) parts.push(time)
  const why = view.status === 'skipped' ? skipReasonText(view.reason) : view.reason
  if (why !== undefined && why !== '') parts.push(view.status === 'skipped' ? `Skipped: ${why}` : why)
  // A verify round's results ("2 passed · 1 failed"), from core's per-command statuses.
  const verify = verifySummaryText(verifyCommandsOf(view))
  if (verify !== null) parts.push(`Commands: ${verify}`)
  if (view.usage !== undefined) parts.push(`Tokens: ${formatUsage(view.usage)}`)
  if (view.cost !== undefined && view.cost.usd !== null) parts.push(`Cost: ${formatCost(view.cost)}`)
  if (view.eta !== undefined)
    parts.push(`Usually ${formatDuration(view.eta.p50)}–${formatDuration(view.eta.p80)}`)
  return parts.join(' · ')
}

/** A click on a node or chip: the page goes to the step's card (the one way the timeline moves the page). */
function goToCard(key: StepKey): void {
  document.getElementById(`pass-card-${key}`)?.scrollIntoView({ block: 'start' })
}

/** The border that marks a step needing a look. */
function statusBorder(status: PassStatus): string | false {
  if (status === 'running') return 'border-st-running/50'
  if (status === 'waiting' || status === 'stalled') return 'border-st-waiting/60'
  if (status === 'failed') return 'border-st-failed/60'
  return false
}

/**
 * A node's border: its status's, or a finished verify round with a failing command reads as a failure. Test-first's
 * red check is the other way round: its failing commands are expected, and a round where none failed is a warning.
 */
function nodeBorder(view: StepView): string | false {
  const outcome = verifyOutcome(view)
  if (outcome === 'problem') return isRedCheck(view.key) ? 'border-st-waiting/60' : 'border-st-failed/60'
  return statusBorder(view.status)
}

/** The full node's box: one width whatever its status, two lines. */
const NODE = 'flex w-26 flex-col items-start gap-0.5 rounded-md border bg-card px-2 py-1 text-left'

function Node({
  view,
  snap,
  now,
  ruler = false,
}: {
  view: StepView
  snap: RunSnapshot
  now: number
  /** Drawn for TimelineRuler: the same box, with nothing to find, focus or name. */
  ruler?: boolean
}): React.JSX.Element {
  const time = nodeTime(view, snap, now)
  const label = runStepLabel(view.key, snap.steps)
  // In the ruler a line is clipped rather than cut with an ellipsis: the same height, and no cut text to explain.
  const cut = ruler ? 'overflow-clip whitespace-nowrap' : 'truncate'
  const content = (
    <>
      <span className={cn('w-full text-xs leading-4 font-semibold', cut)}>{label}</span>
      <span
        className={cn(
          'flex w-full min-w-0 items-center gap-1 text-[11px] leading-3.5',
          STATUS_TEXT_TONE[view.status],
        )}
      >
        <StatusIcon status={view.status} className="size-3 shrink-0" />
        <span className={cn('min-w-0', cut)}>
          <span className="sr-only">: </span>
          {PASS_STATUS_LABEL[view.status]}
          {time !== null && (
            <span aria-hidden className="text-muted-foreground">
              {' · '}
            </span>
          )}
          <span
            data-testid={ruler ? undefined : `timeline-time-${view.key}`}
            className="text-muted-foreground tabular-nums"
          >
            {time !== null && (
              <>
                <span className="sr-only">, </span>
                {time}
              </>
            )}
          </span>
        </span>
      </span>
    </>
  )
  if (ruler) return <span className={cn(NODE, nodeBorder(view))}>{content}</span>
  return (
    <Tooltip content={nodeTip(view, label, time)}>
      <button
        type="button"
        data-testid={`timeline-node-${view.key}`}
        data-status={view.status}
        // Accessibility: one clean name ("Plan: Done, 1s"); the node's two block lines read "Plan : Done , 1s" otherwise.
        aria-label={`${label}: ${PASS_STATUS_LABEL[view.status]}${time !== null ? `, ${time}` : ''}`}
        // As the compact strip's chip says it: the step the run is on now.
        aria-current={CURRENT.has(view.status) ? 'step' : undefined}
        onClick={() => goToCard(view.key)}
        className={cn(NODE, 'hover:bg-accent', nodeBorder(view))}
      >
        {content}
      </button>
    </Tooltip>
  )
}

type Gate = 'afterPlan' | 'beforeFix'

function gateName(gate: Gate): string {
  return gate === 'afterPlan' ? 'Plan review' : 'Findings review'
}

/** A gate mark's name for screen readers and its tooltip; none in a ruler (nothing there is found or read). */
function gateA11y(testId: string, label: string, ruler: boolean): Record<string, string> {
  return ruler ? {} : { 'data-testid': testId, role: 'img', 'aria-label': label, title: label }
}

function AutoGate({
  gate,
  compact = false,
  ruler = false,
}: {
  gate: Gate
  compact?: boolean | undefined
  ruler?: boolean | undefined
}): React.JSX.Element {
  const label = `${gateName(gate)}: skipped in Auto`
  return (
    <span
      {...gateA11y(`timeline-gate-auto-${gate}`, label, ruler)}
      data-skipped="auto"
      className={cn('flex shrink-0 flex-col items-center justify-center', compact ? 'h-6' : 'h-10.5')}
    >
      <Diamond aria-hidden className={cn('text-auto', compact ? 'size-3' : 'size-3.5')} />
      {!compact && (
        <span aria-hidden className="text-[9px] leading-none font-semibold tracking-wide text-auto">
          AUTO
        </span>
      )}
    </span>
  )
}

function OpenGate({
  gate,
  open,
  compact = false,
  ruler = false,
}: {
  gate: Gate
  open: boolean
  compact?: boolean | undefined
  ruler?: boolean | undefined
}): React.JSX.Element {
  const label = `${gateName(gate)}${open ? ': waiting for you' : ''}`
  return (
    <span
      {...gateA11y(`timeline-gate-${gate}`, label, ruler)}
      data-open={open}
      className={cn('flex shrink-0 items-center justify-center', compact ? 'h-6' : 'h-10.5')}
    >
      <Diamond
        aria-hidden
        className={cn(
          compact ? 'size-3' : 'size-3.5',
          open ? 'fill-st-waiting/30 text-st-waiting' : 'text-muted-foreground',
        )}
      />
    </span>
  )
}

function gateOpen(snap: RunSnapshot, gate: Gate): boolean {
  const kind = gate === 'afterPlan' ? 'gate:afterPlan' : 'gate:beforeFix'
  return snap.cards.some((c) => c.kind === kind)
}

function columnKey(col: TimelineColumn): string {
  return col.kind === 'gate' ? col.gate : col.steps.map((s) => s.key).join('+')
}

function GateMark({
  col,
  snap,
  compact,
  ruler,
}: {
  col: Extract<TimelineColumn, { kind: 'gate' }>
  snap: RunSnapshot
  compact?: boolean | undefined
  ruler?: boolean | undefined
}): React.JSX.Element {
  return col.auto === true ? (
    <AutoGate gate={col.gate} compact={compact} ruler={ruler} />
  ) : (
    <OpenGate gate={col.gate} open={gateOpen(snap, col.gate)} compact={compact} ruler={ruler} />
  )
}

/** The full timeline's row of columns: the timeline itself, or (ruler) the unseen copy TimelineRuler measures. */
function TimelineRow({
  cols,
  snap,
  now,
  ruler = false,
}: {
  cols: readonly TimelineColumn[]
  snap: RunSnapshot
  now: number
  ruler?: boolean
}): React.JSX.Element {
  return (
    <ol className="flex flex-wrap items-start gap-1.5">
      {cols.map((col, i) => (
        <Fragment key={columnKey(col)}>
          {i > 0 && col.kind === 'step' && cols[i - 1]?.kind === 'step' && (
            <li aria-hidden className="mt-5 h-px w-2 shrink-0 bg-border" />
          )}
          {/* Review ‖ Critic: one column, side by side, so the row stays one node tall. */}
          <li className={cn('flex shrink-0', col.kind === 'step' && col.steps.length > 1 && 'gap-1')}>
            {col.kind === 'gate' ? (
              <GateMark col={col} snap={snap} ruler={ruler} />
            ) : (
              col.steps.map((v) => <Node key={v.key} view={v} snap={snap} now={now} ruler={ruler} />)
            )}
          </li>
        </Fragment>
      ))}
    </ol>
  )
}

export function PhaseTimeline({
  snap,
  keep,
}: {
  snap: RunSnapshot
  /** Steps the Run view has shown before: they keep their node (steps.ts shownSteps). */
  keep?: ReadonlySet<StepKey>
}): React.JSX.Element {
  const live = Object.values(snap.steps).some(isCounting)
  const now = useNow(live)
  const cols = timelineColumns(snap, { autoGates: true, ...(keep !== undefined ? { keep } : {}) })
  return (
    <nav aria-label="Run steps" data-testid="phase-timeline" data-form="full">
      <TimelineRow cols={cols} snap={snap} now={now} />
    </nav>
  )
}

/**
 * The full timeline as it lays out at the width it is given, unseen (aria-hidden and invisible; nothing in it can be
 * found, focused or read): while the compact strip shows, the Run view measures its height, so going back to the full
 * block is decided on what that block would take at the page's width now (headerForm.ts), not at an earlier width.
 */
export function TimelineRuler({
  snap,
  keep,
  ref,
}: {
  snap: RunSnapshot
  keep?: ReadonlySet<StepKey>
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  // The nodes' times change only their text, never the row's height: the ruler needs no ticking clock.
  const now = useNow(false)
  const cols = timelineColumns(snap, { autoGates: true, ...(keep !== undefined ? { keep } : {}) })
  return (
    <div ref={ref} aria-hidden data-timeline-ruler="" className="pointer-events-none invisible">
      <TimelineRow cols={cols} snap={snap} now={now} ruler />
    </div>
  )
}

// ---- the compact strip ----------------------------------------------------------------------------------------------

/** The statuses of the step the run is at: its chip is highlighted. */
const CURRENT: ReadonlySet<PassStatus> = new Set(['running', 'waiting', 'stalled', 'paused'])
/** Steps done with: at the start of the line they give way first. */
const SETTLED: ReadonlySet<PassStatus> = new Set(['done', 'skipped'])

/** The gap between the strip's items (gap-1.5). */
const STRIP_GAP_PX = 6
/** A "+N" chip keeps the room of two digits. */
const MORE_RESERVE = ['+00'] as const

const CHIP =
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap'

function chipClass(status: PassStatus): string {
  return cn(
    CHIP,
    CURRENT.has(status) ? 'bg-accent text-foreground' : 'border-transparent text-muted-foreground',
    statusBorder(status),
  )
}

function StripChip({
  view,
  snap,
  now,
  ruler,
}: {
  view: StepView
  snap: RunSnapshot
  now: number
  ruler: boolean
}): React.JSX.Element {
  const label = runStepLabel(view.key, snap.steps)
  const content = (
    <>
      <StatusIcon status={view.status} className="size-3.5" />
      {label}
    </>
  )
  // The ruler measures the chip: the same box, nothing to find, focus or name.
  if (ruler) return <span className={chipClass(view.status)}>{content}</span>
  const time = nodeTime(view, snap, now)
  return (
    <Tooltip content={nodeTip(view, label, time)}>
      <button
        type="button"
        data-testid={`timeline-node-${view.key}`}
        data-status={view.status}
        aria-current={CURRENT.has(view.status) ? 'step' : undefined}
        onClick={() => goToCard(view.key)}
        className={cn(chipClass(view.status), 'hover:bg-accent')}
      >
        {content}
        <span className="sr-only">
          : {PASS_STATUS_LABEL[view.status]}
          {time !== null ? `, ${time}` : ''}
        </span>
      </button>
    </Tooltip>
  )
}

function StripItem({
  col,
  snap,
  now,
  ruler = false,
}: {
  col: TimelineColumn
  snap: RunSnapshot
  now: number
  ruler?: boolean
}): React.JSX.Element {
  if (col.kind === 'gate') {
    if (ruler) return <span className="flex h-6 w-3 shrink-0" />
    return <GateMark col={col} snap={snap} compact />
  }
  const [first, ...rest] = col.steps
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {first !== undefined && <StripChip view={first} snap={snap} now={now} ruler={ruler} />}
      {/* Review ‖ Critic: one column, side by side. */}
      {rest.map((v) => (
        <Fragment key={v.key}>
          <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
          <StripChip view={v} snap={snap} now={now} ruler={ruler} />
        </Fragment>
      ))}
    </span>
  )
}

function isSettled(col: TimelineColumn, snap: RunSnapshot): boolean {
  if (col.kind === 'gate') return col.auto === true || !gateOpen(snap, col.gate)
  return col.steps.every((v) => SETTLED.has(v.status))
}

/** The steps a "+N" chip stands for. */
function MoreChip({
  cols,
  where,
}: {
  cols: readonly TimelineColumn[]
  where: 'before' | 'after'
}): React.JSX.Element {
  const steps = cols.flatMap((c) => (c.kind === 'step' ? c.steps : []))
  const names = steps.map((v) => `${stepLabel(v.key)}: ${PASS_STATUS_LABEL[v.status]}`).join(', ')
  const first = steps[0]
  return (
    <Tooltip content={names}>
      <button
        type="button"
        data-testid={`timeline-more-${where}`}
        data-count={steps.length}
        aria-label={`${where === 'before' ? 'Earlier' : 'Later'} steps: ${names}`}
        onClick={() => {
          if (first !== undefined) goToCard(first.key)
        }}
        className={cn(CHIP, 'border-border text-muted-foreground tabular-nums hover:bg-accent')}
      >
        <StableLabel labels={MORE_RESERVE}>+{steps.length}</StableLabel>
      </button>
    </Tooltip>
  )
}

export function PhaseStrip({
  snap,
  keep,
}: {
  snap: RunSnapshot
  /** Steps the Run view has shown before: they keep their chip (steps.ts shownSteps). */
  keep?: ReadonlySet<StepKey>
}): React.JSX.Element {
  const live = Object.values(snap.steps).some(isCounting)
  const now = useNow(live)
  const cols = timelineColumns(snap, { autoGates: true, ...(keep !== undefined ? { keep } : {}) })
  const [fit, setFit] = useState<StripFit>({ before: 0, after: 0 })
  const line = useRef<HTMLOListElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  // What the fit depends on besides the widths: the items and which of them are settled.
  const shape = cols.map((c) => `${columnKey(c)}:${isSettled(c, snap) ? 1 : 0}`).join(',')
  useLayoutEffect(() => {
    const l = line.current
    const r = ruler.current
    if (l === null || r === null) return
    const settled = shape === '' ? [] : shape.split(',').map((s) => s.endsWith(':1'))
    const measure = (sync: boolean): void => {
      const available = l.clientWidth
      if (available <= 0) return
      const widths = [...r.querySelectorAll<HTMLElement>('[data-strip-item]')].map(
        (el) => el.getBoundingClientRect().width,
      )
      const more = r.querySelector('[data-strip-more]')?.getBoundingClientRect().width ?? 0
      const next = fitStrip(
        settled.map((s, i) => ({ width: widths[i] ?? 0, settled: s })),
        { available, gap: STRIP_GAP_PX, more },
      )
      const apply = (): void =>
        setFit((prev) => (prev.before === next.before && prev.after === next.after ? prev : next))
      if (sync) flushSync(apply)
      else apply()
    }
    measure(false)
    if (typeof ResizeObserver === 'undefined') return
    // A window resize or zoom step: fitted again in the observer's callback, before the paint.
    const ro = new ResizeObserver(() => measure(true))
    ro.observe(l)
    ro.observe(r)
    return () => ro.disconnect()
  }, [shape])
  const before = Math.min(fit.before, cols.length)
  const after = Math.min(fit.after, cols.length - before)
  const shown = cols.slice(before, cols.length - after)
  return (
    <nav
      aria-label="Run steps"
      data-testid="phase-timeline"
      data-form="compact"
      // The ruler inside is as wide as every item: clipped, so it never widens the page.
      className="relative overflow-clip [overflow-clip-margin:0.25rem]"
    >
      <ol
        ref={line}
        className="flex h-6 min-w-0 items-center gap-1.5 overflow-clip [overflow-clip-margin:0.25rem]"
      >
        {before > 0 && (
          <li className="flex shrink-0">
            <MoreChip cols={cols.slice(0, before)} where="before" />
          </li>
        )}
        {shown.map((col) => (
          <li key={columnKey(col)} className="flex shrink-0">
            <StripItem col={col} snap={snap} now={now} />
          </li>
        ))}
        {after > 0 && (
          <li className="flex shrink-0">
            <MoreChip cols={cols.slice(cols.length - after)} where="after" />
          </li>
        )}
      </ol>
      {/* Every item at its width, unseen: what the fit measures. */}
      <div
        ref={ruler}
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max items-center gap-1.5 overflow-visible"
      >
        {cols.map((col) => (
          <span key={columnKey(col)} data-strip-item="" className="flex shrink-0">
            <StripItem col={col} snap={snap} now={now} ruler />
          </span>
        ))}
        <span data-strip-more="" className={cn(CHIP, 'tabular-nums')}>
          <StableLabel labels={MORE_RESERVE}>+0</StableLabel>
        </span>
      </div>
    </nav>
  )
}
