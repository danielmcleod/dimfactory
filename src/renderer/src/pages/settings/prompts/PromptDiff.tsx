// A prompt's changes from the built-in default, as the plan
// gate shows a plan edit (lib/linediff.ts hunks, +/− signs and line numbers beside the diff colours). It reads in the
// page flow (lines wrap), never in a scroller of its own (UI standard: one scroll region per screen).
import type { LineDiff } from '../../../lib/linediff.ts'
import { cn } from '../../../lib/cn.ts'

const MINUS = '−'

export const SAME_AS_DEFAULT = 'Same as the built-in default.'

export function PromptDiff({ diff, testId }: { diff: LineDiff; testId: string }): React.JSX.Element {
  if (diff.identical) {
    return (
      <p data-testid={testId} className="text-xs text-muted-foreground">
        {SAME_AS_DEFAULT}
      </p>
    )
  }
  return (
    <div
      data-testid={testId}
      role="table"
      aria-label={`Changes from the built-in default: ${diff.added} added, ${diff.removed} removed`}
      className="stream-text rounded-md border bg-background text-xs"
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
              <span role="cell" className="min-w-0 [overflow-wrap:anywhere]">
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
