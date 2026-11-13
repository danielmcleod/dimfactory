// The composer's Run control (its run states; UI control standards), drawn
// in the composer's Run row and again in the compact bar that keeps Run reachable once the composer is scrolled past.
// Run never changes size: its label is Run, or Queue while core's folder.lock says another run holds the folder (both
// widths reserved), and its icon slot shows the spinner while starting. What Run would do now is the status text
// BESIDE it, left of the button, in a group that takes the row's remaining room and never wraps: a long status is cut
// with an ellipsis (whole in its title and in Run's aria-describedby), so Run keeps its place at the row's end.
import { Play } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../../../components/ui/Button.tsx'
import { Kbd } from '../../../components/ui/Kbd.tsx'
import { Tooltip } from '../../../components/ui/Tooltip.tsx'
import { cn } from '../../../lib/cn.ts'
import { ariaKeyShortcuts, KEYS } from '../../../lib/keys.ts'

export const RUN_LABEL = 'Run'
/** core's folder.lock: another run holds the folder, so this one waits for it, then starts. */
export const QUEUE_LABEL = 'Queue'
/** Every label the Run button can show: its width is the widest, whatever the state. */
export const RUN_LABELS: readonly string[] = [RUN_LABEL, QUEUE_LABEL]

export interface RunState {
  /** Queue (core's folder.lock) or Run. */
  label: string
  /** The state beside Run (Starting… / Fix N issues to run / Checking… / Folder busy / an error), or ''. */
  status: ReactNode
  /** The status as plain text: its title, and what Run's aria-describedby reads. */
  statusText: string
  /** The status is a problem (red). */
  statusBlocked: boolean
  /** Why Run is disabled (its tooltip, and the name of the wrapper that takes focus for it), or null. */
  disabledReason: string | null
  starting: boolean
  /** Run would queue: the tooltip says it waits for the run that holds the folder. */
  busyTooltip: string | null
  canRun: boolean
  onRun: () => void
}

export function RunControl({
  run,
  buttonTestId,
  statusId,
  statusTestId,
  className,
}: {
  run: RunState
  buttonTestId: string
  statusId: string
  statusTestId: string
  className?: string
}): React.JSX.Element {
  const button = (
    <Button
      data-testid={buttonTestId}
      icon={<Play aria-hidden />}
      labels={RUN_LABELS}
      loading={run.starting}
      disabled={!run.canRun}
      aria-keyshortcuts={ariaKeyShortcuts(KEYS.runOrApprove)}
      aria-describedby={run.statusText !== '' ? statusId : undefined}
      onClick={run.onRun}
      className="min-w-24"
    >
      {run.label}
    </Button>
  )
  return (
    <div className={cn('flex min-w-0 flex-1 items-center justify-end gap-2', className)}>
      <span
        id={statusId}
        data-testid={statusTestId}
        title={run.statusText !== '' ? run.statusText : undefined}
        className={cn(
          'min-w-0 truncate text-xs tabular-nums',
          run.statusBlocked ? 'font-medium text-destructive' : 'text-muted-foreground',
        )}
      >
        {run.status}
      </span>
      <Kbd combo={KEYS.runOrApprove} aria-hidden className="shrink-0" />
      {run.disabledReason !== null && !run.starting ? (
        <Tooltip content={run.disabledReason}>
          <span tabIndex={0} aria-label={run.disabledReason} className="inline-flex shrink-0 rounded-md">
            {button}
          </span>
        </Tooltip>
      ) : run.busyTooltip !== null && !run.starting ? (
        <Tooltip content={run.busyTooltip}>{button}</Tooltip>
      ) : (
        button
      )}
    </div>
  )
}
