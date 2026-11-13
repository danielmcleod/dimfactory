// "Isolated: not applied" (unfinalized worktrees are never auto-deleted, so the Dashboard marks them) on the
// Dashboard's active and recent run cards. Core says when it applies
// (RunSummary.worktree.notApplied: the copy exists and its changes are not in the folder); the chip only shows it.
// "Isolated: apply interrupted" while an apply Dim Factory's close interrupted waits to be finished.
import type { RunSummary } from '@shared/run.ts'
import { Badge } from '../../components/ui/Badge.tsx'
import { isolatedChipOf } from '../../components/run/isolation.ts'

export function IsolatedChip({ summary }: { summary: RunSummary }): React.JSX.Element | null {
  const chip = isolatedChipOf(summary)
  if (chip === null) return null
  return (
    <Badge
      variant="outline"
      data-testid={`isolated-chip-${summary.runId}`}
      title={chip.hint}
      className="shrink-0 border-warning/50 font-normal text-warning"
    >
      {chip.text}
    </Badge>
  )
}
