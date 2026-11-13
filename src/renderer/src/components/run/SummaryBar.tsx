// SummaryBar: `Plan ✓ approved (edited)` · `3 must · 5 should` · `7 files +120 −34`
// (live) · tokens · `$0.62 est.` · [Open diff ⌘⇧D]. Counts are core's (RunSummary); the line totals come from the
// latest diff-stats event; "approved" only when core's plan gate card closed with Approve (no gate ran under Auto or
// with gates.afterPlan off: "Plan done"). "→ ~$0.80" needs a cost estimate core does not report yet, so it is left
// out.
// The bar is one line at any size (UI control standard) and the compact header leaves the cost to it, so where
// it is narrow (a small window, a large zoom) things give way whole, in this order, before anything is cut: Open
// diff's key hint (the shortcut stays in its tooltip and aria-keyshortcuts), the token count, then the plan's words
// after "Plan ✓" (still read out, and whole in the title). Only then is text cut, the plan's words first. The bar is a
// size container, so this depends on its width alone: nothing gives way or comes back as the run's numbers change.
import { FileDiff } from 'lucide-react'
import type { RunSnapshot } from '@shared/run.ts'
import {
  formatFiles,
  formatFindingCounts,
  formatRunCost,
  formatTokens,
  liveCountOnly,
} from '../../lib/format.ts'
import { cn } from '../../lib/cn.ts'
import { ariaKeyShortcuts, formatCombo, KEYS } from '../../lib/keys.ts'
import { Button } from '../ui/Button.tsx'
import { Kbd } from '../ui/Kbd.tsx'
import { Tooltip } from '../ui/Tooltip.tsx'
import { usePlanGate, usePlanInfo } from './plan.ts'
import type { PlanGate } from './plan.ts'
import { useLastEnvelope } from './runLog.ts'
import { skipReasonText } from './text.ts'

/**
 * `Plan ✓ approved (edited)`, `Plan ready for review`, `Plan done`, `Plan · running`, … from the Plan step and its
 * gate: `gate` is how core's gate card closed (undefined while unknown). An edited plan (plan.original.md exists) was
 * approved at the gate by definition.
 */
export function planText(snap: RunSnapshot, edited: boolean, gate?: PlanGate): string {
  const p = snap.steps.plan
  switch (p.status) {
    case 'done':
      if (snap.cards.some((c) => c.kind === 'gate:afterPlan')) return 'Plan ready for review'
      if (p.reason !== undefined && p.reason !== '') return `Plan · ${p.reason}`
      if (gate === 'approved' || edited) return `Plan ✓ approved${edited ? ' (edited)' : ''}`
      if (gate === 'cancelled') return 'Plan not approved'
      return 'Plan done'
    case 'skipped': {
      const why = skipReasonText(p.reason)
      return why !== undefined ? `Plan skipped · ${why}` : 'Plan skipped'
    }
    case 'queued':
      return 'Plan · queued'
    case 'running':
      return 'Plan · running'
    case 'waiting':
      return snap.cards.some((c) => c.kind === 'insufficientContext')
        ? 'Plan needs more context'
        : 'Plan · waiting'
    case 'stalled':
      return 'Plan · no output for a while'
    case 'paused':
      return 'Plan · paused'
    case 'failed':
      return 'Plan failed'
    case 'cancelled':
      return 'Plan cancelled'
  }
}

/**
 * The start of the plan's text that stays where the bar is narrow: `Plan ✓` for an approved plan, `Plan skipped` for
 * a skipped one; null when the text has nothing to leave out.
 */
export function planShortText(text: string): string | null {
  for (const short of ['Plan ✓', 'Plan skipped'])
    if (text.startsWith(short) && text.length > short.length) return short
  return null
}

/** Findings are known once a reviewer finished; before that there is nothing to count. */
export function findingsText(snap: RunSnapshot): string | null {
  const reviewed = snap.steps.review.status === 'done' || snap.steps.critic.status === 'done'
  return reviewed ? formatFindingCounts(snap.summary.findings) : null
}

/**
 * Below these widths of the bar (its content box, a container query) the key hint, then the tokens give way. A
 * finished run's bar ("Plan ✓ approved (edited) · 2 must · 1 should · 3 files +40 −2 · 320.8k tokens · $0.62") needs
 * about 760 px with the hint, 680 px without it, 575 px without the tokens, 455 px with "Plan ✓".
 */
const NO_KBD = '@max-[48rem]:hidden'
const NO_TOKENS = '@max-[42rem]:hidden'
/** Below this width the plan reads "Plan ✓" (the rest of its words read out, and in the title). */
const PLAN_LONG = '@max-[36rem]:hidden'
const PLAN_SHORT = 'hidden @max-[36rem]:inline'

/** How each part gives way once nothing more can go whole: the plan's words first; the cost never. */
const SHRINK: Readonly<Record<string, string>> = {
  plan: 'min-w-0 shrink',
  findings: 'min-w-0 shrink-[0.25]',
  files: 'min-w-0 shrink-[0.25]',
  tokens: `min-w-0 shrink-[0.5] ${NO_TOKENS}`,
}

/** The plan's text: whole, or (a narrow bar) its start, with the rest for screen readers only. */
function PlanPart({ text }: { text: string }): React.JSX.Element {
  const short = planShortText(text)
  if (short === null)
    return (
      <span data-testid="summary-plan" title={text} className="min-w-0 truncate tabular-nums">
        {text}
      </span>
    )
  return (
    <>
      <span
        data-testid="summary-plan"
        title={text}
        className={cn('min-w-0 truncate tabular-nums', PLAN_LONG)}
      >
        {text}
      </span>
      <span data-testid="summary-plan-short" title={text} className={cn('min-w-0 truncate', PLAN_SHORT)}>
        {short}
        <span className="sr-only">{text.slice(short.length)}</span>
      </span>
    </>
  )
}

export function SummaryBar({
  snap,
  onOpenDiff,
}: {
  snap: RunSnapshot
  onOpenDiff: () => void
}): React.JSX.Element {
  const s = snap.summary
  const runId = s.runId
  const plan = usePlanInfo(runId, snap)
  const gate = usePlanGate(runId, snap)
  // diff-stats bodies are always pushed (they are not stream events), so one search plus live updates stay current.
  const stats = useLastEnvelope(runId, 'diff-stats', () => true, { enabled: s.progress.filesChanged > 0 })
  // Core's live count (the poller while a pass edits) counts files, not lines: its 0/0 is no line total, so the bar
  // shows the count alone ("3 files") rather than "3 files +0 −0" (live balanced run).
  const files =
    stats !== undefined &&
    stats !== null &&
    stats.body.files === s.progress.filesChanged &&
    !liveCountOnly(stats.body)
      ? formatFiles(stats.body.files, stats.body.added, stats.body.deleted)
      : formatFiles(s.progress.filesChanged)
  const findings = findingsText(snap)
  const parts: { id: string; text: string }[] = [
    { id: 'plan', text: planText(snap, plan.edit !== null, gate) },
    ...(findings !== null ? [{ id: 'findings', text: findings }] : []),
    { id: 'files', text: files },
    { id: 'tokens', text: `${formatTokens(s.progress.tokens)} tokens` },
    { id: 'cost', text: formatRunCost(s) },
  ]
  return (
    <footer
      data-testid="summary-bar"
      aria-label="Run summary"
      // One line of a fixed height that never wraps (UI control standard): the bar is sticky at the bottom of
      // the page scroller, so a second line would cover the reading area as counts grow. What does not fit is cut
      // (the plan's words first), with the full text as the title. A size container: what gives way whole where it is
      // narrow depends on its width alone.
      className="@container flex h-11 items-center gap-3 border-t bg-background px-4 text-sm"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-clip whitespace-nowrap [overflow-clip-margin:0.25rem]">
        {parts.map((p, i) => (
          <span key={p.id} className={cn('flex items-center gap-2', SHRINK[p.id] ?? 'shrink-0')}>
            {i > 0 && (
              <span aria-hidden className="shrink-0 text-muted-foreground">
                ·
              </span>
            )}
            {p.id === 'plan' ? (
              <PlanPart text={p.text} />
            ) : (
              <span data-testid={`summary-${p.id}`} title={p.text} className="min-w-0 truncate tabular-nums">
                {p.text}
              </span>
            )}
          </span>
        ))}
      </div>
      <Tooltip content={`Open the diff (${formatCombo(KEYS.openDiff)})`}>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          data-testid="open-diff"
          aria-keyshortcuts={ariaKeyShortcuts(KEYS.openDiff)}
          onClick={onOpenDiff}
        >
          <FileDiff aria-hidden />
          Open diff
          <Kbd aria-hidden combo={KEYS.openDiff} className={NO_KBD} />
        </Button>
      </Tooltip>
    </footer>
  )
}
