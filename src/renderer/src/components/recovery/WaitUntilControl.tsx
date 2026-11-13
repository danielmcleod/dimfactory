// A retry that waits for a limit to reset (the wait_until executor for failure categories rate_limited /
// quota_exceeded, a countdown in the snag card on core's clock). Core owns the wait
// (StepView.wait): while it is armed, core retries the pass at `until` on its own clock, and executing the action
// arms or disarms it. An armed wait loads disarmed after Dim Factory restarts, offering [Re-arm] and [Retry now]
// (runs.retryPass). The countdown reads core's clock (E2E runs compress it), sits in a reserved width, and the arm
// button keeps one width for Arm / Re-arm / Disarm (UI control standard).
import { RotateCcw, Timer, TimerOff } from 'lucide-react'
import { useId, useState } from 'react'
import { localClockText } from '@shared/clock-text.ts'
import type { RecoveryActionOf } from '@shared/failure.ts'
import type { WaitView } from '@shared/run.ts'
import { coreNow, coreRemainingMs, useCoreNow } from '../../lib/coreClock.ts'
import { formatClock } from '../../lib/format.ts'
import { runCommand } from '../run/commands.ts'
import { isAgent } from '../run/text.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { execute } from './execute.ts'
import type { RecoveryContext } from './execute.ts'

export type WaitUntilAction = RecoveryActionOf<'wait_until'>

export const ARM_LABEL = 'Arm'
export const REARM_LABEL = 'Re-arm'
export const DISARM_LABEL = 'Disarm'
export const RETRY_NOW_LABEL = 'Retry now'
const ARM_LABELS: readonly string[] = [ARM_LABEL, REARM_LABEL, DISARM_LABEL]

/** The wait as shown: core's view of it, else the action's own fields. */
export type WaitState = Pick<WaitView, 'until' | 'armed' | 'disarmed'>

/**
 * `15:05` (`Mon 15:05` a day or more ahead): the 24-hour form core writes in the action's label ("Retry at 15:05"),
 * so the card shows the time one way.
 */
export function timeOfDay(ms: number, now: number = coreNow()): string {
  return localClockText(ms, now)
}

/** Why the wait is not armed, in words. */
export function disarmedText(d: WaitView['disarmed']): string {
  switch (d) {
    case 'relaunch':
      return 'Dim Factory restarted, so the automatic retry is off.'
    case 'user':
      return 'Automatic retry is off.'
    case 'offered':
    case undefined:
      return 'Dim Factory does not retry this on its own.'
  }
}

/** The arm button's label: Disarm while armed, Re-arm after a disarm or a restart, else Arm. */
export function armLabel(s: WaitState): string {
  if (s.armed) return DISARM_LABEL
  return s.disarmed === 'user' || s.disarmed === 'relaunch' ? REARM_LABEL : ARM_LABEL
}

const sameWait = (a: WaitState | undefined, b: WaitState | undefined): boolean =>
  a?.until === b?.until && a?.armed === b?.armed && a?.disarmed === b?.disarmed

/**
 * The width a countdown starting at `ms` needs all its life: its first value with every digit a zero, and at least
 * `00:00` (`0:00:00` from an hour, `000:00:00` from 100 hours: a seven-day quota).
 */
export function countdownReserve(ms: number): string {
  const r = formatClock(ms).replace(/\d/g, '0')
  return r.length < 5 ? '00:00' : r
}

function Countdown({ ms, widest }: { ms: number; widest: number }): React.JSX.Element {
  // m:ss under an hour, h:mm:ss above; the digits are tabular, and the width of the longest value this wait has shown
  // stays reserved, so the sentence never shifts as the countdown shortens.
  return (
    <StableLabel
      labels={[countdownReserve(Math.max(ms, widest))]}
      align="start"
      className="font-medium tabular-nums"
    >
      {formatClock(ms)}
    </StableLabel>
  )
}

export interface WaitUntilControlProps {
  action: WaitUntilAction
  /** Core's view of the step's wait (StepView.wait), when it is this action's. */
  wait?: WaitView | undefined
  ctx: RecoveryContext
  primary: boolean
  size: 'sm' | 'md'
  busy: string | null
  run: (tag: string, fn: () => Promise<unknown>) => void
  /** Why the action cannot run now (laterReason, a core without the executor), or null. */
  reason: string | null
}

export function WaitUntilControl(p: WaitUntilControlProps): React.JSX.Element {
  const { action: a, ctx, busy, run, size } = p
  const id = useId()
  const fromCore: WaitState | undefined = p.wait?.actionId === a.id ? p.wait : undefined
  // core's answer to the last click, kept until the snapshot shows something other than what it showed then
  const [answer, setAnswer] = useState<{ wait: WaitState; base: WaitState | undefined } | null>(null)
  const state: WaitState =
    answer !== null && sameWait(answer.base, fromCore)
      ? answer.wait
      : (fromCore ?? { until: a.until, armed: a.armed })
  useCoreNow()
  const remaining = coreRemainingMs(state.until)
  // The longest countdown this wait has shown (per `until`): its width stays reserved while it counts down.
  const [widest, setWidest] = useState<{ until: number; ms: number }>({ until: state.until, ms: remaining })
  if (widest.until !== state.until || remaining > widest.ms) setWidest({ until: state.until, ms: remaining })
  const now = coreNow()

  const pass = ctx.step !== undefined && isAgent(ctx.step) ? ctx.step : null
  const runId = ctx.runId
  const toggleTag = a.id
  const retryTag = `retry-now:${a.id}`

  const toggle = (): void =>
    run(toggleTag, async () => {
      const base = fromCore
      const r = await execute(a, ctx)
      const now = r.result?.wait
      if (r.outcome === 'done') {
        setAnswer({
          wait: now !== undefined ? now : { until: state.until, armed: !state.armed, disarmed: 'user' },
          base,
        })
      }
    })
  const retryNow = (): void => {
    if (runId === undefined || pass === null) return
    run(retryTag, () => runCommand(runId, 'runs.retryPass', { runId, pass }))
  }

  const toggleButton = (
    <Button
      size={size}
      variant={p.primary && !state.armed ? 'default' : 'outline'}
      data-testid={`recovery-${a.id}`}
      data-kind="wait_until"
      aria-describedby={`${id}-status`}
      icon={state.armed ? <TimerOff aria-hidden /> : <Timer aria-hidden />}
      labels={ARM_LABELS}
      loading={busy === toggleTag}
      disabled={p.reason !== null || (busy !== null && busy !== toggleTag)}
      onClick={p.reason === null ? toggle : undefined}
    >
      {armLabel(state)}
    </Button>
  )

  return (
    <div
      data-testid={`wait-${a.id}`}
      data-kind="wait_until"
      data-armed={state.armed}
      data-disarmed={state.disarmed}
      className="flex flex-col gap-1.5 rounded-md border bg-background/60 p-2"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Timer aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words">{a.label}</span>
      </p>
      <p id={`${id}-status`} data-testid={`wait-status-${a.id}`} className="text-xs text-muted-foreground">
        {state.armed ? (
          remaining > 0 ? (
            <>
              Retrying automatically in <Countdown ms={remaining} widest={widest.ms} /> (at{' '}
              {timeOfDay(state.until, now)}).
            </>
          ) : (
            'Retrying now.'
          )
        ) : (
          <>
            {disarmedText(state.disarmed)}{' '}
            {remaining > 0 ? (
              <>
                The limit resets in <Countdown ms={remaining} widest={widest.ms} /> (at{' '}
                {timeOfDay(state.until, now)}).
              </>
            ) : (
              'The limit should have reset by now.'
            )}
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {p.reason === null ? toggleButton : <DisabledHint reason={p.reason}>{toggleButton}</DisabledHint>}
        {runId !== undefined && pass !== null && (
          <Button
            size={size}
            variant="outline"
            data-testid={`wait-retry-${a.id}`}
            icon={<RotateCcw aria-hidden />}
            loading={busy === retryTag}
            disabled={busy !== null && busy !== retryTag}
            onClick={retryNow}
          >
            {RETRY_NOW_LABEL}
          </Button>
        )}
      </div>
    </div>
  )
}
