// Disabled-not-hidden (UI for unbuilt backends renders but is blocked). A disabled
// control gets no pointer or focus events, so the tooltip hangs off a focusable wrapper. The wrapper is named by
// its own content plus the reason ("Cancel all Available in a later version"), so a keyboard or screen-reader user
// who tabs to it hears which control it is and why it is unavailable.
import { useId } from 'react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'
import { Tooltip } from './Tooltip.tsx'

export const LATER_VERSION = 'Available in a later version'

export interface DisabledHintProps {
  /** The disabled control (pass `disabled` to it yourself). */
  children: ReactNode
  /** Why it is disabled; defaults to "Available in a later version". */
  reason?: string
  className?: string
}

export function DisabledHint({
  children,
  reason = LATER_VERSION,
  className,
}: DisabledHintProps): React.JSX.Element {
  const id = useId()
  const controlId = `${id}-control`
  const reasonId = `${id}-reason`
  return (
    <Tooltip content={reason}>
      <span
        tabIndex={0}
        role="group"
        aria-labelledby={`${controlId} ${reasonId}`}
        data-disabled-hint=""
        className={cn('inline-flex cursor-not-allowed rounded-md focus-visible:outline-2', className)}
      >
        {/* display:contents keeps the control laid out as the wrapper's own child. */}
        <span id={controlId} className="contents">
          {children}
        </span>
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </span>
    </Tooltip>
  )
}
