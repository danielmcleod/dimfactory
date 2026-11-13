// A small status-coloured dot (timeline nodes, sidebar, vendor health). Running pulses unless reduced motion is on.
import type { ComponentProps } from 'react'
import type { PassStatus, RunStatus } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, RUN_STATUS_LABEL } from '../../lib/format.ts'
import { STATUS_TONE } from './Badge.tsx'
import type { StatusTone } from './Badge.tsx'

const DOT: Readonly<Record<StatusTone, string>> = {
  queued: 'bg-st-queued',
  running: 'bg-st-running',
  waiting: 'bg-st-waiting',
  stalled: 'bg-st-stalled',
  paused: 'bg-st-paused',
  done: 'bg-st-done',
  skipped: 'bg-st-skipped',
  failed: 'bg-st-failed',
  cancelled: 'bg-st-cancelled',
}

export type StatusDotProps = Omit<ComponentProps<'span'>, 'children'> & {
  status: PassStatus | RunStatus
  /** Accessible name; defaults to the status label. Pass "" when text next to the dot already says it. */
  label?: string
}

export function StatusDot({ status, label, className, ...props }: StatusDotProps): React.JSX.Element {
  const tone = STATUS_TONE[status]
  const name =
    label ??
    (status in PASS_STATUS_LABEL
      ? PASS_STATUS_LABEL[status as PassStatus]
      : RUN_STATUS_LABEL[status as RunStatus])
  return (
    <span
      data-status={status}
      role={name === '' ? undefined : 'img'}
      aria-label={name === '' ? undefined : name}
      aria-hidden={name === '' ? true : undefined}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        DOT[tone],
        tone === 'running' && 'motion-safe:animate-pulse',
        className,
      )}
      {...props}
    />
  )
}
