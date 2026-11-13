// Step status as icon + text + token colour (accessibility: colour is never the only status
// signal). Statuses are core's PassStatus values; this only picks the glyph and the words.
import {
  Ban,
  Circle,
  CircleCheck,
  CircleMinus,
  CirclePause,
  CircleX,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestion,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PassStatus } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL } from '../../lib/format.ts'
import { StableLabel } from '../ui/StableLabel.tsx'

export const STATUS_ICON: Readonly<Record<PassStatus, LucideIcon>> = {
  queued: Circle,
  running: LoaderCircle,
  waiting: MessageCircleQuestion,
  stalled: Hourglass,
  paused: CirclePause,
  done: CircleCheck,
  skipped: CircleMinus,
  failed: CircleX,
  cancelled: Ban,
}

export const STATUS_TEXT_TONE: Readonly<Record<PassStatus, string>> = {
  queued: 'text-st-queued',
  running: 'text-st-running',
  waiting: 'text-st-waiting',
  stalled: 'text-st-stalled',
  paused: 'text-st-paused',
  done: 'text-st-done',
  skipped: 'text-st-skipped',
  failed: 'text-st-failed',
  cancelled: 'text-st-cancelled',
}

export function StatusIcon({
  status,
  className,
}: {
  status: PassStatus
  className?: string
}): React.JSX.Element {
  const Icon = STATUS_ICON[status]
  return (
    <Icon
      aria-hidden
      className={cn(
        'size-4 shrink-0',
        STATUS_TEXT_TONE[status],
        status === 'running' && 'motion-safe:animate-spin',
        className,
      )}
    />
  )
}

/** Every status label, reserved by a StepStatus that must keep its width. */
const STATUS_LABELS = Object.values(PASS_STATUS_LABEL)

/**
 * Icon and label, e.g. "✓ Done", in the status colour. With `reserve`, it keeps the width of the widest status label,
 * so a status change never moves what follows it (a PassCard's chips; UI control standard).
 */
export function StepStatus({
  status,
  label,
  reserve = false,
  className,
}: {
  status: PassStatus
  label?: string
  reserve?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        STATUS_TEXT_TONE[status],
        className,
      )}
    >
      <StatusIcon status={status} className="size-3.5" />
      {reserve && label === undefined ? (
        <StableLabel labels={STATUS_LABELS} align="start">
          {PASS_STATUS_LABEL[status]}
        </StableLabel>
      ) : (
        (label ?? PASS_STATUS_LABEL[status])
      )}
    </span>
  )
}
