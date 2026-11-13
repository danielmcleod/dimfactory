// "AUTO approved N" (the Log tab shows AUTO approved N; Auto is amber with AUTO text everywhere; auto.spec.ts).
// The count is core's (RunSnapshot.autoAnswered, summed over the run's steps; core
// leaves it out while there are none), never one the renderer works out.
import type { RunSnapshot } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'

/** Core's count of asks it approved itself, or undefined when the snapshot does not carry one. */
export function coreAutoApproved(
  snap: Pick<RunSnapshot, 'autoAnswered'> | null | undefined,
): number | undefined {
  return snap?.autoAnswered?.approved
}

export function AutoApprovedCount({
  count,
  className,
  testId = 'auto-approved-count',
}: {
  count: number
  className?: string
  testId?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      data-count={count}
      title="Requests Dim Factory approved without asking you"
      className={cn('font-medium text-auto tabular-nums', className)}
    >
      AUTO approved {count}
    </span>
  )
}
