// A paused step's way forward (after a timeout: [Allow & resume] [Resume (keep denied)] [Stop run]; state rows
// P9b/P10/P19/P24, failure categories ask_timeout / permission_denied, kill-relaunch.spec.ts: nothing resumes on its own). runs.resume{allowTimedOutAsk: true} turns the timed-out question into an allow (core keeps it as an allow
// rule); plain runs.resume continues with it denied. After a deny that pauses (ask.denyPauses), Resume continues and
// the vendor is told not to retry what was denied. What was asked comes from the step's stream (core's ask bodies).
// A busy button's spinner takes its icon slot, so pressing one never moves the others.
import { CirclePause, Play, Square } from 'lucide-react'
import type { StepView } from '@shared/run.ts'
import { PAUSE_REASON_LABEL, stepLabel, vendorName } from '../../lib/format.ts'
import { useStream } from '../../lib/streamBuffer.ts'
import type { StreamSnapshot } from '../../lib/streamBuffer.ts'
import { Button } from '../ui/Button.tsx'
import { runCommand, useBusy } from './commands.ts'
import { stopRun } from './stop.ts'

/** The last ask of the stream that core resolved as `by` (with `decision`, when given). */
function lastAsk(s: StreamSnapshot, by: 'timeout' | 'user', decision?: 'cancel'): string | null {
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i]
    if (b?.kind !== 'ask' || b.resolved?.by !== by) continue
    if (decision !== undefined && b.resolved.decision !== decision) continue
    return b.detail
  }
  return null
}

/** Longest piece of an ask's detail quoted in the explanation (the stream shows all of it). */
const QUOTED_MAX = 80

function quote(detail: string): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  return one.length > QUOTED_MAX ? `${one.slice(0, QUOTED_MAX)}…` : one
}

function explanation(view: StepView, detail: string | null): string {
  const asked = detail !== null ? quote(detail) : null
  const label = stepLabel(view.key)
  const who = view.vendor !== undefined ? vendorName(view.vendor) : 'the vendor'
  const what = asked !== null ? ` (${asked})` : ''
  const pause = view.pause
  if (pause === undefined) return `${label} is paused.`
  switch (pause) {
    case 'ask-timeout':
      return `Nobody answered ${label}'s question in time${what}, so it paused. Allow it and continue, or continue with it denied.`
    case 'denied':
      return asked !== null
        ? `${label} paused because you denied ${asked}. Resume continues without it: ${who} is told you denied it and not to retry it.`
        : `${label} paused because a request was denied. Resume continues without it: ${who} is told not to retry it.`
    case 'interrupted':
      return `${label} was interrupted. Nothing resumes on its own: resume it when you are ready.`
    case 'interrupted-by-quit':
      return `${label} paused because Dim Factory closed. Nothing resumes on its own: resume it when you are ready.`
  }
}

export function PausedNotice({ runId, view }: { runId: string; view: StepView }): React.JSX.Element | null {
  return view.status === 'paused' ? <PausedBody runId={runId} view={view} /> : null
}

/** Mounted only while the step is paused, so a running step's stream does not re-render it. */
function PausedBody({ runId, view }: { runId: string; view: StepView }): React.JSX.Element {
  const [busy, run] = useBusy()
  const stream = useStream(runId, view.key)
  const timeout = view.pause === 'ask-timeout'
  const asked =
    view.pause === 'ask-timeout'
      ? lastAsk(stream, 'timeout')
      : view.pause === 'denied'
        ? lastAsk(stream, 'user', 'cancel')
        : null
  const idle = (tag: string): boolean => busy !== null && busy !== tag
  return (
    <section
      data-testid={`paused-${view.key}`}
      aria-label={`${stepLabel(view.key)} paused`}
      className="flex flex-col gap-2 rounded-md border border-st-paused/40 bg-st-paused/5 p-3"
    >
      <div className="flex items-start gap-2">
        <CirclePause aria-hidden className="mt-0.5 size-4 shrink-0 text-st-paused" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {view.pause !== undefined ? PAUSE_REASON_LABEL[view.pause] : 'Paused'}
          </p>
          <p className="text-sm text-muted-foreground" data-testid={`paused-why-${view.key}`}>
            {explanation(view, asked)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {timeout ? (
          <>
            <Button
              size="sm"
              data-testid="timeout-allow-resume"
              loading={busy === 'allow'}
              disabled={idle('allow')}
              icon={<Play aria-hidden />}
              onClick={() =>
                run('allow', () => runCommand(runId, 'runs.resume', { runId, allowTimedOutAsk: true }))
              }
            >
              Allow &amp; resume
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="timeout-resume-denied"
              loading={busy === 'resume'}
              disabled={idle('resume')}
              icon={<Play aria-hidden />}
              onClick={() => run('resume', () => runCommand(runId, 'runs.resume', { runId }))}
            >
              Resume (keep denied)
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            data-testid="resume"
            loading={busy === 'resume'}
            disabled={idle('resume')}
            icon={<Play aria-hidden />}
            onClick={() => run('resume', () => runCommand(runId, 'runs.resume', { runId }))}
          >
            Resume
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-testid={timeout ? 'timeout-stop' : 'paused-stop'}
          loading={busy === 'stop'}
          disabled={idle('stop')}
          icon={<Square aria-hidden />}
          onClick={() => run('stop', () => stopRun(runId))}
        >
          Stop run
        </Button>
      </div>
    </section>
  )
}
