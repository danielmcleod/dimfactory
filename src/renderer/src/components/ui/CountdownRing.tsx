// Countdown ring to an `expiresAt` (asks, wait_until), driven by the shared 1 s ticker (lib/ticker.ts). The ring
// empties as time runs out; the seconds left are the accessible name and an optional centre label. Deadlines are
// core times, so the ring counts on core's clock (lib/coreClock.ts), which E2E runs compress.
import { cn } from '../../lib/cn.ts'
import { coreNow } from '../../lib/coreClock.ts'
import { formatDuration } from '../../lib/format.ts'
import { useNow } from '../../lib/ticker.ts'
import { StableLabel } from './StableLabel.tsx'

export interface CountdownRingProps {
  /** Core epoch ms when the countdown ends. */
  expiresAt: number
  /** Full length of the countdown in ms (the ring's 100 %). */
  totalMs: number
  /** Diameter in px (default 20). */
  size?: number
  /** Show the remaining time next to the ring. */
  showLabel?: boolean
  className?: string
  /** Override core's clock (tests, previews). */
  now?: number
}

export function CountdownRing({
  expiresAt,
  totalMs,
  size = 20,
  showLabel = false,
  className,
  now: fixedNow,
}: CountdownRingProps): React.JSX.Element {
  // Re-rendered by the shared ticker, but drawn at core's time of this render, not of the last tick: a deadline that
  // changed between ticks (an ask extended after a sleep) never shows more time than core gives.
  useNow(fixedNow === undefined)
  const now = fixedNow ?? coreNow()
  const remaining = Math.max(0, expiresAt - now)
  const fraction = totalMs > 0 ? Math.min(1, remaining / totalMs) : 0
  const stroke = Math.max(2, Math.round(size / 8))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const label = remaining === 0 ? 'Time is up' : `${formatDuration(remaining)} left`
  const urgent = remaining > 0 && remaining <= Math.min(30_000, totalMs * 0.2)
  return (
    <span
      role="timer"
      aria-label={label}
      className={cn('inline-flex items-center gap-1.5 tabular-nums', className)}
      data-remaining-ms={remaining}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          className={cn(
            'transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none',
            urgent ? 'stroke-destructive' : 'stroke-primary',
          )}
        />
      </svg>
      {/* Reserved width (tabular digits): the ticking label never moves what sits beside the ring. */}
      {showLabel && (
        <StableLabel
          labels={countdownReserve(Math.max(totalMs, remaining))}
          align="start"
          className="text-xs text-muted-foreground tabular-nums"
        >
          {formatDuration(remaining)}
        </StableLabel>
      )}
    </span>
  )
}

const zeros = (n: number): string => '0'.repeat(String(n).length)

/**
 * Every shape formatDuration gives a time from `maxMs` down to 0, digits written as zeros: `00s`, `<m>m 00s` and
 * `<h>h 00m` with as many minute or hour digits as the longest the countdown reaches. With tabular digits the widest
 * of them is as wide as any label it will show, so the label keeps one width all the way down (a 15 min ask included).
 */
export function countdownReserve(maxMs: number): string[] {
  const s = Math.max(0, Math.round(maxMs / 1000))
  const out = ['00s']
  if (s >= 60) out.push(`${zeros(Math.min(59, Math.floor(s / 60)))}m 00s`)
  if (s >= 3600) out.push(`${zeros(Math.floor(s / 3600))}h 00m`)
  return out
}
