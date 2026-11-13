// Inline line diff of a plan edit (gate:afterPlan's "Edited · view changes", PassCard's
// "edited +n −m" chip). Rows carry a +/− sign and line numbers as well as the diff colours. It reads in the page flow
// (lines wrap), never in a scroller of its own (UI standard: one scroll region per screen).
import type { LineDiff } from '../../lib/linediff.ts'
import { cn } from '../../lib/cn.ts'

const MINUS = '−'

export function editCounts(d: Pick<LineDiff, 'added' | 'removed'>): string {
  return `+${d.added} ${MINUS}${d.removed}`
}

export function PlanDiff({
  diff,
  className,
  testId,
}: {
  diff: LineDiff
  className?: string
  testId?: string
}): React.JSX.Element {
  if (diff.identical) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>No changes from the original plan.</p>
    )
  }
  return (
    <div
      data-testid={testId}
      className={cn('stream-text rounded-md border bg-background text-xs', className)}
      role="table"
      aria-label={`Plan changes: ${diff.added} added, ${diff.removed} removed`}
    >
      {diff.hunks.map((h, hi) => (
        <div key={hi} role="rowgroup">
          <div role="row" className="bg-muted px-2 py-0.5 text-muted-foreground">
            <span role="cell">
              @@ {MINUS}
              {h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </span>
          </div>
          {h.lines.map((l, li) => (
            <div
              key={li}
              role="row"
              data-kind={l.kind}
              className={cn(
                'flex gap-2 px-2 whitespace-pre-wrap',
                l.kind === 'add' && 'bg-diff-add-bg text-diff-add',
                l.kind === 'del' && 'bg-diff-del-bg text-diff-del',
              )}
            >
              <span role="cell" className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
                {l.oldNo ?? ''}
              </span>
              <span role="cell" className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
                {l.newNo ?? ''}
              </span>
              <span role="cell" aria-hidden className="w-3 shrink-0">
                {l.kind === 'add' ? '+' : l.kind === 'del' ? MINUS : ' '}
              </span>
              <span role="cell" className="min-w-0 break-words">
                <span className="sr-only">
                  {l.kind === 'add' ? 'Added: ' : l.kind === 'del' ? 'Removed: ' : ''}
                </span>
                {l.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
