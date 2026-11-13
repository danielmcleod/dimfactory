// The Finalize step of an isolated run (it starts once the outcome is fixed and never
// changes it; Apply or Discard finish it, Keep for later skips it (kept); Undo = restore(applied, P); Discard is
// deferred 10 s and undoable; R12). Its header has core's status; one line under it says what core's
// finalize view (StepView.finalize) reports (applied, kept for later, discarding, conflicts to choose, an apply to
// finish), with [Undo] beside it while core holds an undo token for the last apply or the pending discard. The choices
// themselves are the finalize, finalizeConflicts and interruptedApply cards that follow it.
// An apply or a discard that happens while the view is open (the finalize card's choice, Auto's autoApply, the Diff
// tab's Apply) also gets its toast with Undo here, once per core token: the card that was pressed has closed by then.
// UI control standards: the line is one line, as tall as the Undo button, from the moment the view watched the
// step, so the button arriving or leaving moves nothing.
import { Undo2 } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { RunSnapshot, StepView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, formatDuration, stepLabel } from '../../lib/format.ts'
import { toast } from '../../state/toasts.ts'
import { Button } from '../ui/Button.tsx'
import { useBusy } from './commands.ts'
import { JUMP_MARGIN } from './follow.tsx'
import { finalizeInfoOf, finalizeStateText } from './isolation.ts'
import type { FinalizeInfo } from './isolation.ts'
import { PausedNotice } from './PausedNotice.tsx'
import { UNDO_LABEL } from './revert.ts'
import { SnagCard } from './SnagCard.tsx'
import { StepStatus } from './StepStatus.tsx'
import { skipReasonText } from './text.ts'
import { appliedCountText, DISCARDED, discardToastMs, undoApply, undoDiscard } from './worktree.ts'

export interface FinalizeCardProps {
  runId: string
  snap: RunSnapshot
  view: StepView
  finishedAtOpen?: boolean
}

/** Keep for later is core's skip reason `kept`. */
export function finalizeReasonText(view: StepView): string {
  if (view.status === 'skipped' && view.reason === 'kept') return 'Kept for later'
  if (view.status === 'skipped') return skipReasonText(view.reason) ?? ''
  if (view.status === 'failed' || view.status === 'paused') return ''
  return view.reason ?? ''
}

/** The undo core offers now: the last apply's, or the pending discard's. */
function undoOf(info: FinalizeInfo): { kind: 'apply' | 'discard'; token: string } | null {
  if (info.state === 'discarding' && info.discardToken !== null)
    return { kind: 'discard', token: info.discardToken }
  if (info.state === 'applied' && info.undoToken !== null) return { kind: 'apply', token: info.undoToken }
  return null
}

/**
 * The toast with Undo for an apply or a discard core reports while the view is open: once per core token, never for a
 * token that was already there when the card mounted (reopening a run does not repeat it).
 */
function useUndoToasts(runId: string, info: FinalizeInfo): void {
  const undo = undoOf(info)
  const seen = useRef<Set<string>>(new Set(undo !== null ? [undo.token] : []))
  const key = undo === null ? '' : `${undo.kind}\u0000${undo.token}`
  const applied = info.applied ?? info.files ?? 0
  const conflicts = info.conflicts.length
  const deleteAt = info.deleteAt
  useEffect(() => {
    const done = seen.current
    if (key === '') return
    const [kind = '', token = ''] = key.split('\u0000')
    if (done.has(token)) return
    done.add(token)
    if (kind === 'discard') {
      toast({
        id: `worktree-discard:${runId}`,
        level: 'info',
        message: DISCARDED,
        durationMs: discardToastMs(deleteAt ?? Number.NaN),
        action: { label: UNDO_LABEL, onClick: () => undoDiscard(runId, token) },
      })
    } else {
      toast({
        id: `worktree-apply:${runId}`,
        level: conflicts > 0 ? 'warn' : 'info',
        message: appliedCountText(applied, conflicts),
        durationMs: 15_000,
        action: { label: UNDO_LABEL, onClick: () => undoApply(runId, token) },
      })
    }
  }, [key, runId, applied, conflicts, deleteAt])
}

export const FinalizeCard = memo(function FinalizeCard({ runId, view }: FinalizeCardProps) {
  const live = view.status === 'running' || view.status === 'waiting'
  const [watched, setWatched] = useState(live)
  if (live && !watched) setWatched(true)
  const info = finalizeInfoOf(view)
  useUndoToasts(runId, info)
  const undo = undoOf(info)
  const [busy, run] = useBusy()
  const state = finalizeStateText(info) ?? finalizeReasonText(view)
  const time = view.attempt === 0 && view.activeMs === 0 ? null : formatDuration(view.activeMs)
  const label = stepLabel(view.key)
  const showLine = watched || state !== '' || undo !== null
  return (
    <article
      id="pass-card-finalize"
      data-testid="pass-card-finalize"
      data-kind="finalize"
      data-status={view.status}
      aria-label={`${label}: ${PASS_STATUS_LABEL[view.status]}`}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground',
        JUMP_MARGIN,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold">{label}</h3>
        <StepStatus status={view.status} reserve />
        {time !== null && (
          <span className="text-xs text-muted-foreground tabular-nums" data-testid="pass-time-finalize">
            {time}
          </span>
        )}
      </header>
      {showLine && (
        <div className="flex h-7 min-w-0 items-center gap-3">
          <p
            data-testid="finalize-state"
            data-state={info.state ?? undefined}
            className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
            title={state !== '' ? state : undefined}
          >
            {state}
          </p>
          {undo !== null && (
            <Button
              size="sm"
              variant="outline"
              icon={<Undo2 aria-hidden />}
              data-testid={`finalize-undo-${undo.kind}`}
              loading={busy !== null}
              aria-label={undo.kind === 'apply' ? 'Undo the apply' : 'Undo the discard'}
              onClick={() =>
                run('undo', () =>
                  undo.kind === 'apply' ? undoApply(runId, undo.token) : undoDiscard(runId, undo.token),
                )
              }
            >
              {UNDO_LABEL}
            </Button>
          )}
        </div>
      )}
      {info.error !== null && (
        <p role="alert" data-testid="finalize-error" className="text-sm text-destructive">
          {info.error}
        </p>
      )}
      <PausedNotice runId={runId} view={view} />
      <SnagCard runId={runId} view={view} />
    </article>
  )
})
