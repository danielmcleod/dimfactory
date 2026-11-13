// The Run view's Log tab (it shows AUTO approved N): the run's
// persisted envelopes (events.jsonl through runs.events), the last 2,000 rows, filterable by step, monospace. The AUTO
// counts are core's (RunSnapshot.autoAnswered) once the snapshot carries them, else counted over the whole log as core
// counts them (the native plan's capture is not an auto-answer); an Auto run shows the amber AUTO badge. Live batches arrive every 16–33 ms: envelopes are immutable, so a row renders
// once (memoized by envelope) and only new rows cost anything; the tail itself updates at most once per frame.
// UI control standards: the rows are the tab's one inner scroll region (data-scroll-region="log", a fixed
// maximum height, at most the reading area less a strip of page: follow.tsx), under the step filter and the counts,
// which stay in place; they follow new rows only while the user is at their bottom.
import { memo, useId, useMemo, useState } from 'react'
import type { NormalizedEvent } from '@shared/events.ts'
import type { RunEnvelope, RunEventBody, StepKey } from '@shared/run.ts'
import { STEP_KEYS } from '@shared/run.ts'
import { JumpToLatest, REGION, useFollowBottom } from '../../components/run/follow.tsx'
import { LOG_TAIL_ROWS, useLogTail } from '../../components/run/runLog.ts'
import { summariesText } from '../../components/run/text.ts'
import { AutoBadge } from '../../components/ui/Badge.tsx'
import { cn } from '../../lib/cn.ts'
import { categoryTitle, formatUsage, liveCountOnly, stepLabel } from '../../lib/format.ts'
import { useStore } from '../../state/store.ts'

const MAX_TEXT = 240

function clip(s: string): string {
  const one = s.replace(/\r?\n/g, '⏎')
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT)}…` : one
}

function stepOf(b: RunEventBody): StepKey | null {
  switch (b.t) {
    case 'ev':
    case 'step-status':
    case 'ask-resolved':
    case 'ask-extended':
    case 'auto-answered':
    case 'snag':
    case 'usage':
    case 'context':
      return b.step
    case 'run-status':
    case 'card':
    case 'diff-stats':
    case 'output':
      return null
    case 'guardrail':
      return b.step
  }
}

function describeEvent(ev: NormalizedEvent): { type: string; text: string } {
  switch (ev.type) {
    case 'session':
      return { type: 'session', text: ev.id }
    case 'text':
      return { type: 'text', text: clip(ev.delta) }
    case 'tool': {
      const phase =
        ev.phase !== undefined ? ` (${ev.phase}${ev.status !== undefined ? `, ${ev.status}` : ''})` : ''
      return { type: 'tool', text: `${ev.name}${ev.summary !== '' ? ` ${clip(ev.summary)}` : ''}${phase}` }
    }
    case 'ask':
      return { type: 'ask', text: `${ev.kind}: ${clip(ev.detail)}` }
    case 'done':
      return { type: 'done', text: ev.usage !== undefined ? formatUsage(ev.usage) : '' }
    case 'error':
      return { type: ev.fatal ? 'error (fatal)' : 'error', text: clip(ev.message) }
  }
}

/** What one envelope says, in a line. */
export function describeBody(b: RunEventBody): { type: string; text: string } {
  switch (b.t) {
    case 'ev':
      return describeEvent(b.ev)
    case 'step-status':
      return {
        type: 'step',
        text: `${b.status} · attempt ${b.attempt}${b.reason !== undefined ? ` · ${b.reason}` : ''}${b.pause !== undefined ? ` · ${b.pause}` : ''}${b.sessionNote !== undefined ? ` · ${b.sessionNote}` : ''}`,
      }
    case 'run-status':
      return {
        type: 'run',
        text: `${b.status} · ${b.phase}${b.outcome !== undefined ? ` · ${b.outcome}` : ''}`,
      }
    case 'card':
      return {
        type: 'card',
        text: `${b.card.kind} ${b.state}${b.choiceId !== undefined ? ` · ${b.choiceId}` : ''} · ${clip(b.card.title)}`,
      }
    case 'ask-resolved':
      return {
        type: 'ask answered',
        text: `${b.decision ?? ''} by ${b.by}${b.via !== undefined ? ` via ${b.via}` : ''}`.trim(),
      }
    case 'ask-extended':
      return { type: 'ask extended', text: new Date(b.expiresAt).toLocaleTimeString() }
    case 'auto-answered':
      return {
        type: 'AUTO',
        text: `${b.decision === 'allow' || b.decision === 'allow-session' ? 'approved' : 'denied'} ${b.tool} (${b.why})`,
      }
    case 'snag':
      return { type: 'snag', text: `${categoryTitle(b.failure.category)} · ${clip(b.failure.message)}` }
    case 'usage':
      return { type: 'usage', text: `${formatUsage(b.usage)} · ${b.costBasis}` }
    case 'context':
      return {
        type: 'context',
        text: `${b.percent !== undefined ? `${b.percent}%` : 'n/a'} · ${summariesText(b.compactions)}${b.compacting ? ' · summarising' : ''}`,
      }
    case 'diff-stats':
      return {
        type: 'diff',
        text: `${b.files} files${liveCountOnly(b) ? '' : ` +${b.added} −${b.deleted}`}${b.live ? ' (live)' : ''}`,
      }
    case 'output':
      return { type: 'output', text: `${b.file} v${b.version}` }
    case 'guardrail':
      return {
        type: 'guardrail',
        text: `${b.finding.rule}: ${b.finding.subject}${b.undone ? ' (put back)' : ''}`,
      }
  }
}

// One formatter for every row: building one per call costs ~70 µs, which 2,000 rows turn into a long task.
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** `14:03:07`: the envelope's local time of day. */
export function formatLogTime(ts: number): string {
  return TIME.format(ts)
}

const Row = memo(function Row({ e }: { e: RunEnvelope }): React.JSX.Element {
  const step = stepOf(e.body)
  const stepName = step !== null ? stepLabel(step) : 'run'
  const d = describeBody(e.body)
  return (
    <div
      className="flex gap-3 px-2 py-px [content-visibility:auto] [contain-intrinsic-size:auto_1.4em] hover:bg-muted/50"
      data-seq={e.seq}
    >
      <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">{e.seq}</span>
      <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{formatLogTime(e.ts)}</span>
      {/* Fixed columns, cut to fit: each says itself in full as a tooltip. */}
      <span className="w-24 shrink-0 truncate" title={stepName}>
        {stepName}
      </span>
      <span className="w-24 shrink-0 truncate text-muted-foreground" title={d.type}>
        {d.type}
      </span>
      <span className="min-w-0 flex-1 break-all">{d.text}</span>
    </div>
  )
})

export function LogTab({ runId }: { runId: string }): React.JSX.Element {
  const tail = useLogTail(runId)
  const snap = useStore((s) => s.runs.byId[runId]?.snapshot ?? null)
  // Both figures from one source: core's pair, else the log's.
  const { approved, denied } = snap?.autoAnswered ?? { approved: tail.autoApproved, denied: tail.autoDenied }
  const [step, setStep] = useState<'all' | StepKey>('all')
  const selectId = useId()
  const rows = useMemo(
    () => (step === 'all' ? tail.rows : tail.rows.filter((e) => stepOf(e.body) === step)),
    [tail.rows, step],
  )
  const present = useMemo(() => {
    const steps = new Set<StepKey>()
    for (const e of tail.rows) {
      const s = stepOf(e.body)
      if (s !== null) steps.add(s)
    }
    return steps
  }, [tail.rows])
  // The rows are the tab's inner scroll region: they follow new rows only while the user is at their bottom.
  const { ref, innerRef, onScroll, atBottom, jumpToLatest } = useFollowBottom<HTMLDivElement>(
    `${step}:${rows.length}:${rows.at(-1)?.seq ?? 0}`,
  )

  return (
    <section aria-label="Run log" className="flex flex-col gap-2" data-testid="log-tab">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor={selectId} className="text-muted-foreground">
          Step
        </label>
        <select
          id={selectId}
          data-testid="log-step-filter"
          value={step}
          onChange={(e) => setStep(e.currentTarget.value as 'all' | StepKey)}
          // A fixed width: options are added as steps appear in the log, and must not move what follows.
          className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="all">All steps</option>
          {STEP_KEYS.filter((k) => present.has(k)).map((k) => (
            <option key={k} value={k}>
              {stepLabel(k)}
            </option>
          ))}
        </select>
        {snap?.summary.auto === true && <AutoBadge data-testid="log-auto-badge" />}
        <span data-testid="log-auto-approved" data-count={approved} className="font-medium">
          AUTO approved {approved}
        </span>
        {denied > 0 && <span className="text-muted-foreground">AUTO denied {denied}</span>}
        <span className="ml-auto text-xs text-muted-foreground">
          {tail.status === 'loading'
            ? 'Reading the log…'
            : tail.total > LOG_TAIL_ROWS
              ? `Showing the last ${LOG_TAIL_ROWS.toLocaleString('en-US')} of ${tail.total.toLocaleString('en-US')} events`
              : `${tail.total.toLocaleString('en-US')} events`}
        </span>
      </div>
      {tail.status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          The log could not be read: {tail.error}
        </p>
      )}
      <div className="relative">
        <div
          ref={ref}
          onScroll={onScroll}
          className={cn(
            'stream-text max-h-[min(40rem,var(--run-region-max,60vh))] rounded-md border bg-muted/30 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring',
            REGION,
          )}
          data-testid="log-rows"
          data-scroll-region="log"
          role="log"
          aria-live="off"
          aria-label="Run log rows"
          tabIndex={0}
        >
          <div ref={innerRef}>
            {rows.length === 0 && tail.status !== 'loading' ? (
              <p className="px-2 py-1 text-muted-foreground">
                No events{step !== 'all' ? ' for this step' : ''} yet.
              </p>
            ) : (
              rows.map((e) => <Row key={e.seq} e={e} />)
            )}
          </div>
        </div>
        {!atBottom && <JumpToLatest testId="log-jump" onClick={jumpToLatest} />}
      </div>
    </section>
  )
}
