// Badge, StatusBadge and AutoBadge (statuses come from core; AUTO is amber with the text AUTO).
// Status colours map PassStatus/RunStatus to the --st-* tokens; the label is the core status formatted, never
// a status the renderer worked out.
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import type { PassStatus, RunStatus } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, RUN_STATUS_LABEL } from '../../lib/format.ts'
import { StableLabel } from './StableLabel.tsx'

export type StatusTone =
  'queued' | 'running' | 'waiting' | 'stalled' | 'paused' | 'done' | 'skipped' | 'failed' | 'cancelled'

/** Pass and run statuses share one palette; a completed run looks like a done pass. */
export const STATUS_TONE: Readonly<Record<PassStatus | RunStatus, StatusTone>> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  stalled: 'stalled',
  paused: 'paused',
  done: 'done',
  completed: 'done',
  skipped: 'skipped',
  failed: 'failed',
  cancelled: 'cancelled',
}

export const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-xs font-medium [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        auto: 'border-auto/40 bg-auto/15 font-semibold tracking-wide text-auto',
        queued: 'border-transparent bg-st-queued/15 text-st-queued',
        running: 'border-transparent bg-st-running/15 text-st-running',
        waiting: 'border-transparent bg-st-waiting/15 text-st-waiting',
        stalled: 'border-transparent bg-st-stalled/15 text-st-stalled',
        paused: 'border-transparent bg-st-paused/15 text-st-paused',
        done: 'border-transparent bg-st-done/15 text-st-done',
        skipped: 'border-transparent bg-st-skipped/15 text-st-skipped',
        failed: 'border-transparent bg-st-failed/15 text-st-failed',
        cancelled: 'border-transparent bg-st-cancelled/15 text-st-cancelled',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
)

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export type StatusBadgeProps = Omit<BadgeProps, 'variant' | 'children'> &
  ({ kind: 'pass'; status: PassStatus } | { kind: 'run'; status: RunStatus }) & {
    /** Replaces the default label ("Running", "Waiting for you", …). */
    label?: string
    /**
     * Keep the width of the widest default label of its kind, so a status change never moves what follows the badge
     * (UI standard: nothing moves on its own).
     */
    reserve?: boolean
  }

function statusText(p: { kind: 'pass'; status: PassStatus } | { kind: 'run'; status: RunStatus }): string {
  return p.kind === 'pass' ? PASS_STATUS_LABEL[p.status] : RUN_STATUS_LABEL[p.status]
}

export function StatusBadge(props: StatusBadgeProps): React.JSX.Element {
  const text = props.label ?? statusText(props)
  const { kind, status, label: _label, reserve = false, ...rest } = props
  return (
    <Badge variant={STATUS_TONE[status]} data-status={status} {...rest}>
      {reserve ? (
        <StableLabel labels={Object.values(kind === 'pass' ? PASS_STATUS_LABEL : RUN_STATUS_LABEL)}>
          {text}
        </StableLabel>
      ) : (
        text
      )}
    </Badge>
  )
}

/** The amber AUTO marker (runs and switches in Auto mode). */
export function AutoBadge({
  className,
  ...props
}: Omit<BadgeProps, 'variant' | 'children'>): React.JSX.Element {
  return (
    <Badge
      variant="auto"
      className={className}
      title="Auto mode: gates are skipped and asks follow your rules"
      {...props}
    >
      AUTO
    </Badge>
  )
}
