// A pass's live stream (performance: StreamPane keeps the last 400 blocks
// with content-visibility:auto; performance.spec.ts). It subscribes to one stream in lib/streamBuffer, so a delta re-renders this
// pane only, at most once per animation frame, and only the rows whose block changed (blocks are immutable).
// role=log with aria-live off: the stream is too chatty to announce; the Run view announces step transitions.
// UI control standards: the pane is an allowed inner scroll region (data-scroll-region="stream") with a fixed
// maximum height; it follows new output only while the user is at its bottom, offers "Jump to latest" when they are
// not, and never scrolls the page (follow.tsx).
import {
  Ban,
  Check,
  CircleAlert,
  CircleX,
  LoaderCircle,
  MessageCircleQuestion,
  ShieldCheck,
} from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import type { StepKey } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { formatDuration, formatUsage } from '../../lib/format.ts'
import { STREAM_BLOCK_CAP, useStream } from '../../lib/streamBuffer.ts'
import type { StreamBlock } from '../../lib/streamBuffer.ts'
import { JumpToLatest, REGION, useFollowBottom } from './follow.tsx'
import { LightMarkdown } from './LightMarkdown.tsx'

const ROW = 'stream-row [content-visibility:auto] [contain-intrinsic-size:auto_1.5em]'
/**
 * Text mounted per frame while a pane catches up (characters; a non-text row counts as ROW_COST). Mounting is
 * dominated by layout of the new text, so the budget is in characters rather than rows.
 */
export const FRAME_TEXT_BUDGET = 8_000
const ROW_COST = 80
/**
 * More new blocks than this in one update count as a burst: a fast stream (a 5 MB replay brings ~20 text blocks
 * per frame), a replay page, a pane opened over a long stream. A vendor typing adds a block or two per frame.
 */
export const BURST_ROWS = 4

/** How many more rows, counting back from `skip` rows before the newest, fit one frame's budget (at least 1). */
export function rowsWithinBudget(
  blocks: readonly StreamBlock[],
  skip: number,
  budget: number = FRAME_TEXT_BUDGET,
): number {
  let n = 0
  let cost = 0
  for (let i = blocks.length - 1 - skip; i >= 0; i--) {
    const b = blocks[i]
    cost += b?.kind === 'text' ? b.text.length : ROW_COST
    if (n > 0 && cost > budget) break
    n++
  }
  return Math.max(1, n)
}

const AUTO_WHY: Readonly<Record<string, string>> = {
  readonly: 'read-only pass',
  'allow-cache': 'allowed for this run',
  'plan-capture': 'plan captured',
  unsupported: 'not supported here',
}

const ASK_OUTCOME: Readonly<Record<string, string>> = {
  allow: 'allowed once',
  'allow-session': 'allowed for this run',
  deny: 'denied',
  cancel: 'cancelled',
}

function ToolRow({ b }: { b: Extract<StreamBlock, { kind: 'tool' }> }): React.JSX.Element {
  const dur = b.endedAt !== undefined ? formatDuration(b.endedAt - b.startedAt) : undefined
  const tone =
    b.status === 'failed'
      ? 'text-st-failed'
      : b.status === 'declined'
        ? 'text-st-paused'
        : b.status === 'running'
          ? 'text-st-running'
          : 'text-st-done'
  const Icon =
    b.status === 'failed'
      ? CircleX
      : b.status === 'declined'
        ? Ban
        : b.status === 'running'
          ? LoaderCircle
          : Check
  return (
    <div className={cn(ROW, 'flex items-baseline gap-2 py-0.5')} data-kind="tool" data-status={b.status}>
      <Icon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 translate-y-0.5',
          tone,
          b.status === 'running' && 'motion-safe:animate-spin',
        )}
      />
      <span className="min-w-0 flex-1 break-words">
        <span className="font-semibold">{b.name}</span>
        {b.summary !== '' && <span className="text-muted-foreground"> {b.summary}</span>}
      </span>
      <span className={cn('shrink-0 text-xs', tone)}>
        {b.status}
        {dur !== undefined && <span className="text-muted-foreground"> · {dur}</span>}
      </span>
    </div>
  )
}

const Row = memo(function Row({ b }: { b: StreamBlock }): React.JSX.Element {
  switch (b.kind) {
    case 'text':
      return <LightMarkdown text={b.text} className={ROW} />
    case 'tool':
      return <ToolRow b={b} />
    case 'ask': {
      const outcome = b.resolved
        ? `${b.resolved.decision !== undefined ? (ASK_OUTCOME[b.resolved.decision] ?? b.resolved.decision) : 'answered'}${b.resolved.by === 'timeout' ? ' (timed out)' : b.resolved.by === 'vendor-cancel' ? ' (withdrawn)' : b.resolved.by === 'auto' ? ' (Auto)' : ''}`
        : 'waiting for you'
      return (
        <div className={cn(ROW, 'flex items-baseline gap-2 py-0.5')} data-kind="ask">
          <MessageCircleQuestion aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-st-waiting" />
          <span className="min-w-0 flex-1 break-words">
            Asked ({b.askKind}): <span className="font-semibold">{b.detail}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{outcome}</span>
        </div>
      )
    }
    case 'auto': {
      const allowed = b.decision === 'allow' || b.decision === 'allow-session'
      return (
        <div className={cn(ROW, 'flex items-baseline gap-2 py-0.5')} data-kind="auto">
          <ShieldCheck aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-auto" />
          <span className="min-w-0 flex-1 break-words">
            <span className="font-semibold">{b.tool}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {allowed ? 'auto-approved' : 'auto-denied'} · {AUTO_WHY[b.why] ?? b.why}
          </span>
        </div>
      )
    }
    case 'error':
      return (
        <div className={cn(ROW, 'flex items-baseline gap-2 py-0.5 text-st-failed')} data-kind="error">
          <CircleAlert aria-hidden className="size-3.5 shrink-0 translate-y-0.5" />
          <span className="min-w-0 flex-1 break-words">{b.message}</span>
        </div>
      )
    case 'done':
      return (
        <div className={cn(ROW, 'py-0.5 text-xs text-muted-foreground')} data-kind="done">
          Finished{b.usage !== undefined ? ` · ${formatUsage(b.usage)}` : ''}
        </div>
      )
  }
})

export interface StreamPaneProps {
  runId: string
  step: StepKey
  /** Shown while the stream has no output yet (the "spawned … waiting for first output" line). */
  waiting?: React.ReactNode
  className?: string
  /** Keep the newest output in view while the user is at the bottom of the pane. */
  follow?: boolean
  /**
   * The step is live: the pane takes its full height from the launch line on (it does not grow as output arrives),
   * and keeps it for as long as it is shown, so nothing below it moves.
   */
  live?: boolean
  /** The attempt whose stream the pane shows (an earlier round of Fix until green); absent: the latest. */
  attempt?: number
}

/**
 * The pane's one height: full while live (and after, while shown); at most this when opened over finished output.
 * Its max height is set either way: an inner scroll region always has a fixed maximum (UI standard),
 * here 28rem and at most the Run view's reading area less a strip of page (--run-region-max, follow.tsx), so the
 * pane never fills what the user reads through and the wheel still finds page to scroll beside it.
 */
const MAX_HEIGHT = 'max-h-[min(28rem,var(--run-region-max,50vh))]'
const LIVE_HEIGHT = `h-[min(28rem,var(--run-region-max,50vh))] ${MAX_HEIGHT}`

export const StreamPane = memo(function StreamPane({
  runId,
  step,
  waiting,
  className,
  follow = true,
  live = false,
  attempt,
}: StreamPaneProps): React.JSX.Element {
  const s = useStream(runId, step, attempt)
  // Mounting a burst of rows in one frame is a long task: a fast stream (a 5 MB replay brings ~40 KB of text per
  // frame), a replay page landing at once, a pane opened over a long stream. A pinned pane then mounts only the newest
  // rows that fit one frame's text budget — all a follower can see — and the older rows follow a budget per frame
  // once the burst is over, so the stream stays a series of short tasks (performance.spec.ts). Ordinary live output adds a row or two
  // per frame and is unaffected.
  const newest = s.blocks.at(-1)?.id ?? 0
  const [limit, setLimit] = useState(() =>
    s.blocks.length > BURST_ROWS ? rowsWithinBudget(s.blocks, 0) : STREAM_BLOCK_CAP,
  )
  const [seen, setSeen] = useState(newest)
  const growing = limit < Math.min(s.blocks.length, STREAM_BLOCK_CAP)
  const all = s.blocks
  useEffect(() => {
    if (!growing) return
    const id = requestAnimationFrame(() => setLimit((l) => l + rowsWithinBudget(all, l)))
    return () => cancelAnimationFrame(id)
  }, [growing, limit, all])
  const blocks = growing ? s.blocks.slice(-limit) : s.blocks

  // Follows new output inside the pane only while the user is at its bottom; the page never moves.
  const { ref, innerRef, onScroll, atBottom, jumpToLatest } = useFollowBottom<HTMLDivElement>(
    `${s.version}:${blocks.length}`,
    follow,
  )
  if (newest !== seen) {
    setSeen(newest)
    // Block ids increase by one per new block, so the gap is how many rows this frame would mount.
    if (newest - seen > BURST_ROWS && atBottom) setLimit(rowsWithinBudget(s.blocks, 0))
  }

  // Once the pane has had its live height it keeps it while shown: a step that finishes never shrinks it.
  const [fixed, setFixed] = useState(live)
  if (live && !fixed) setFixed(true)

  const empty = s.blocks.length === 0
  return (
    <div className="relative">
      <div
        ref={ref}
        role="log"
        aria-live="off"
        aria-label="Output of this step"
        tabIndex={0}
        data-testid={`stream-${step}`}
        data-scroll-region="stream"
        data-blocks={s.blocks.length}
        onScroll={onScroll}
        className={cn(
          'stream-text rounded-md bg-muted/40 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          REGION,
          fixed ? LIVE_HEIGHT : MAX_HEIGHT,
          className,
        )}
      >
        <div ref={innerRef}>
          {s.dropped > 0 && (
            <p className="pb-1 text-xs text-muted-foreground">
              {s.dropped} earlier {s.dropped === 1 ? 'block is' : 'blocks are'} hidden. Open the Log tab or
              the raw log for everything.
            </p>
          )}
          {empty ? (
            <div className="text-xs text-muted-foreground">{waiting ?? 'No output yet'}</div>
          ) : (
            blocks.map((b) => <Row key={b.id} b={b} />)
          )}
        </div>
      </div>
      {!atBottom && <JumpToLatest testId={`stream-jump-${step}`} onClick={jumpToLatest} />}
    </div>
  )
})
