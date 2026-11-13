// The plan's acceptance criteria as a checklist: on the acceptance review's card and in the run's end panel. One row
// per criterion: a status icon and word (Met, Not met, Unknown, Not checked), the criterion, then the evidence, the
// finding it became and the tests mapped to it. Presentation only: every status and line is core's
// (RunSnapshot.acceptance). Rows never change size on their own: the icon and the word sit in a fixed-width column.
import { CircleCheck, CircleDashed, CircleHelp, CircleX } from 'lucide-react'
import type { AcceptanceItemView, AcceptanceStatus, AcceptanceView } from '@shared/acceptance.ts'
import { ACCEPTANCE_STATUS_LABEL, acceptanceSummaryText } from '@shared/acceptance.ts'
import { cn } from '../../lib/cn.ts'

const ICON: Readonly<Record<AcceptanceStatus, React.JSX.Element>> = {
  met: <CircleCheck aria-hidden className="size-4 shrink-0 text-st-done" />,
  'not-met': <CircleX aria-hidden className="size-4 shrink-0 text-st-failed" />,
  unknown: <CircleHelp aria-hidden className="size-4 shrink-0 text-st-waiting" />,
  'not-checked': <CircleDashed aria-hidden className="size-4 shrink-0 text-st-skipped" />,
}

/** The line above the rows: the counts, or why the review did not run. */
export function checklistLine(v: AcceptanceView): string {
  switch (v.review) {
    case 'off':
      return 'The acceptance review is off, so these criteria are not checked.'
    case 'pending':
      return 'The acceptance review checks these after Implement.'
    case 'checking':
      return 'The acceptance review is checking these criteria.'
    case 'skipped':
      return v.note ?? 'The acceptance review did not run.'
    case 'done': {
      const line = acceptanceSummaryText(v.counts)
      return v.findings && v.items.some((i) => i.finding !== undefined)
        ? `${line} Unmet criteria went to Fix as [must] findings.`
        : line
    }
  }
}

function Row({ item }: { item: AcceptanceItemView }): React.JSX.Element {
  return (
    <li
      className="flex min-w-0 items-start gap-2 py-1"
      data-testid={`acceptance-row-${item.id}`}
      data-status={item.status}
    >
      <span className="flex w-28 shrink-0 items-center gap-1.5 text-xs font-medium">
        {ICON[item.status]}
        <span data-testid={`acceptance-status-${item.id}`}>{ACCEPTANCE_STATUS_LABEL[item.status]}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm break-words">
          <span className="mr-1.5 font-mono text-xs text-muted-foreground">{item.id}</span>
          {item.text}
        </p>
        {item.evidence !== undefined && (
          <p
            className="text-xs break-words text-muted-foreground"
            data-testid={`acceptance-evidence-${item.id}`}
          >
            {item.evidence}
            {item.finding !== undefined ? ` (F${item.finding})` : ''}
          </p>
        )}
        {item.evidence === undefined && item.finding !== undefined && (
          <p className="text-xs text-muted-foreground">Finding F{item.finding}</p>
        )}
        {item.tests !== undefined && item.tests.length > 0 && (
          <p
            className="text-xs break-words text-muted-foreground"
            data-testid={`acceptance-tests-${item.id}`}
          >
            Tests: {item.tests.join('; ')}
          </p>
        )}
      </div>
    </li>
  )
}

export function AcceptanceChecklist({
  view,
  className,
  testId = 'acceptance-checklist',
}: {
  view: AcceptanceView
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid={testId} data-review={view.review}>
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-line`}>
        {checklistLine(view)}
      </p>
      <ul className="flex flex-col divide-y">
        {view.items.map((i) => (
          <Row key={i.id} item={i} />
        ))}
      </ul>
    </div>
  )
}
