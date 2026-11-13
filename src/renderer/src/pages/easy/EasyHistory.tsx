// Easy mode's project history (the Done screen): every run in the project's folder, newest first (the most recent
// HISTORY_MAX), each with when it ran, how it ended and what it was asked to do, and "Go back to before this": the
// folder is put back as it was before that run (diff.revert for the whole run, which also undoes every run after it),
// with the usual Undo in the message that follows. A run that worked in a copy of the folder, or one that changed
// nothing, has nothing to go back from here.
// UI standards: one row per run, each one fixed height; the buttons keep their labels; a button that cannot be used
// says why beside it; the list changes only when a run starts or ends.
import { Undo2 } from 'lucide-react'
import { useId } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { RunSummary } from '@shared/run.ts'
import { folderBusyReason, revertAll } from '../../components/run/revert.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { useStore } from '../../state/store.ts'
import type { StoreState } from '../../state/store.ts'
import {
  HISTORY_BACK,
  HISTORY_NOTHING,
  HISTORY_TEXT,
  HISTORY_TITLE,
  historyRowText,
  projectStatusText,
} from './text.ts'

/** The most runs the history lists. */
export const HISTORY_MAX = 12

/** The runs in a folder, newest first, from the store's summaries (by the folder's key). */
export function folderRuns(s: StoreState, folderKey: string): RunSummary[] {
  const out: RunSummary[] = []
  for (const id of s.summaries.order) {
    const r = s.summaries.byId[id]
    if (r !== undefined && r.folderKey === folderKey) out.push(r)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_MAX)
}

/** "27 Oct, 14:05" in the user's own format. */
function whenText(at: number): string {
  const d = new Date(at)
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function HistoryRow({ r }: { r: RunSummary }): React.JSX.Element {
  const [busy, run] = useBusy()
  const reason = useStore((s) => folderBusyReason(s, r.runId))
  const nothing = r.isolation === 'worktree' || r.progress.filesChanged === 0
  const button = (
    <Button
      size="sm"
      variant="outline"
      icon={<Undo2 aria-hidden />}
      loading={busy === 'back'}
      disabled={nothing || reason !== undefined || (busy !== null && busy !== 'back')}
      onClick={() => run('back', () => revertAll(r.runId))}
      data-testid="easy-history-back"
    >
      {HISTORY_BACK}
    </Button>
  )
  const why = nothing ? HISTORY_NOTHING : reason
  return (
    <li
      className="flex h-14 items-center gap-3 rounded-md border px-3"
      data-testid="easy-history-row"
      data-run-id={r.runId}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium" title={r.title}>
          {r.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {historyRowText(r.displayNo, whenText(r.createdAt), projectStatusText(r.status, r.outcome))}
        </span>
      </div>
      {why !== undefined ? <DisabledHint reason={why}>{button}</DisabledHint> : button}
    </li>
  )
}

export function EasyHistory({ folderKey }: { folderKey: string }): React.JSX.Element | null {
  const runs = useStore(useShallow((s) => folderRuns(s, folderKey)))
  const headingId = useId()
  if (runs.length === 0) return null
  return (
    <section
      aria-labelledby={headingId}
      data-testid="easy-done-history"
      className="flex flex-col gap-2 border-t pt-4"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {HISTORY_TITLE}
      </h2>
      <p className="text-sm">{HISTORY_TEXT}</p>
      <ul className="flex flex-col gap-2">
        {runs.map((r) => (
          <HistoryRow key={r.runId} r={r} />
        ))}
      </ul>
    </section>
  )
}
