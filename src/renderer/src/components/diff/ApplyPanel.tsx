// "Apply to folder…" for an isolated run (the Diff tab's panel: all files or reviewed only; core applies under the
// folder lock with the `pre-apply`
// snapshot first, a file whose folder content no longer equals the base is a conflict and is never overwritten; Undo
// restores the folder; no 3-way merge).
// Core says what Apply would do (worktree.preview: the run's changes and the conflicts now); the panel counts core's
// answer for the files chosen (all, or the ones core counts as reviewed: a mark that names the version Apply writes,
// in any segment) and Apply sends them (worktree.apply, `reviewedOnly` for "reviewed only", so core picks the same
// files). Its toast says what core applied and left, with Undo (worktree.undoApply). Conflicts stay as they are in the
// folder; the run's Finalize card asks about each. [Discard copy] deletes the isolated copy 10 s later
// (worktree.discard, Undo in its toast), for a run kept for later or stopped.
// UI control standards: the facts line is one line from the start (core's answer changes its words in place;
// the conflicts list opens on a click), Apply keeps its label and width (the spinner takes its icon slot), and a
// disabled Apply says why.
import { ChevronDown, ChevronRight, FolderInput, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { WORKTREE_APPLY_ACTIONS } from '@shared/ipc.ts'
import type { WorktreeApplyAction, WorktreePreview } from '@shared/ipc.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { useBusy } from '../run/commands.ts'
import { finalizeInfoOf } from '../run/isolation.ts'
import { STILL_STOPPING } from '../run/revert.ts'
import { applyToFolder, discardCopy, previewApply, useWorktreeSupported } from '../run/worktree.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint, LATER_VERSION } from '../ui/DisabledHint.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { APPLY_ALL, APPLY_HINT, APPLY_REVIEWED, APPLY_TITLE, filesText } from './text.ts'

export const APPLY_LABEL = 'Apply'
/** The panel's Discard (deferred 10 s, undoable). */
export const DISCARD_COPY_LABEL = 'Discard copy'
export const DISCARD_INTERRUPTED =
  'An apply to your folder stopped part way. Finish it first (the Finish apply card in the run).'
export const APPLY_RUN_WORKING =
  'The run is still working in its isolated copy. Apply once it reaches Finalize.'
export const APPLY_DISCARDED = 'The isolated copy was discarded.'
export const APPLY_BUSY = 'Dim Factory is applying or undoing an apply now.'
export const APPLY_NOTHING = 'No files to apply.'
export const APPLY_NONE_REVIEWED = 'No file is marked reviewed yet.'
/** Marks shown, but none names the version Apply writes (a later step changed those files again). */
export const APPLY_REVIEWED_EARLIER =
  'Your reviewed marks are for an earlier version of these files. Mark them again in the Combined view.'
export const PREVIEW_LOADING = "Comparing the run's changes with your folder…"

export type ApplyWhich = 'all' | 'reviewed'

/** The widest a file count gets in a radio's label (tabular digits). */
const COUNT_LABELS: readonly string[] = ['(…)', '(1 file)', '(000 files)']

/** What Apply would do to one path, as core's preview says (`actions`; derived from its lists for an older core). */
export type ApplyAction = WorktreeApplyAction

/** The action of each changed path: core's own when it sends them, else conflict / delete / write from its lists. */
export function applyActionsOf(p: WorktreePreview): Map<string, ApplyAction> {
  const out = new Map<string, ApplyAction>()
  if (p.actions !== undefined) {
    for (const a of p.actions)
      if ((WORKTREE_APPLY_ACTIONS as readonly string[]).includes(a.action)) out.set(a.path, a.action)
    return out
  }
  const conflicts = new Set(p.conflicts)
  for (const f of p.files)
    out.set(f.path, conflicts.has(f.path) ? 'conflict' : f.status === 'D' ? 'delete' : 'write')
  return out
}

export type ApplyCounts = Record<ApplyAction, number>

/** Core's preview counted for the chosen paths (all when `paths` is null). */
export function applyCounts(p: WorktreePreview, paths: ReadonlySet<string> | null): ApplyCounts {
  const out: ApplyCounts = { write: 0, delete: 0, noop: 0, conflict: 0, skip: 0 }
  for (const [path, action] of applyActionsOf(p)) {
    if (paths !== null && !paths.has(path)) continue
    out[action]++
  }
  return out
}

/** "2 files to write · 1 to delete · 1 already the same · 1 conflict · 1 left alone" (only what is there). */
export function applyCountsText(c: ApplyCounts): string {
  const parts: string[] = []
  if (c.write > 0) parts.push(`${filesText(c.write)} to write`)
  if (c.delete > 0)
    parts.push(parts.length === 0 ? `${filesText(c.delete)} to delete` : `${c.delete} to delete`)
  if (c.noop > 0) parts.push(`${c.noop} already the same`)
  if (c.conflict > 0) parts.push(`${c.conflict} ${c.conflict === 1 ? 'conflict' : 'conflicts'}`)
  if (c.skip > 0) parts.push(`${c.skip} left alone`)
  return parts.length === 0 ? APPLY_NOTHING : parts.join(' · ')
}

/** Why Apply cannot run now, from core's facts (the run's status and phase, its finalize view). */
export function applyBlockedReason(snap: RunSnapshot, supported: boolean): string | undefined {
  if (!supported) return LATER_VERSION
  const s = snap.summary
  if (s.phase === 'stopping') return STILL_STOPPING
  const fin = finalizeInfoOf(snap.steps.finalize).state
  if (fin === 'discarding' || fin === 'discarded') return APPLY_DISCARDED
  if (fin === 'applying' || fin === 'undoing') return APPLY_BUSY
  if (s.phase === 'ready-to-apply') return undefined
  if (s.status === 'queued' || s.status === 'running' || s.status === 'waiting' || s.status === 'paused')
    return APPLY_RUN_WORKING
  return undefined
}

type PreviewState =
  { kind: 'loading' } | { kind: 'ready'; preview: WorktreePreview } | { kind: 'error'; message: string }

/** Core's preview, read again whenever `refreshKey` changes (the run moved on, an apply or its undo). */
function usePreview(runId: string, refreshKey: string, enabled: boolean): PreviewState {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })
  useEffect(() => {
    if (!enabled) return
    let live = true
    void previewApply(runId).then((r) => {
      if (!live) return
      setState(r.ok ? { kind: 'ready', preview: r.value } : { kind: 'error', message: r.error.message })
    })
    return () => {
      live = false
    }
  }, [runId, refreshKey, enabled])
  return state
}

/** Why Discard cannot run now: Apply's reasons, and an apply that stopped part way (finish it first). */
export function discardBlockedReason(snap: RunSnapshot, supported: boolean): string | undefined {
  const blocked = applyBlockedReason(snap, supported)
  if (blocked !== undefined) return blocked
  return finalizeInfoOf(snap.steps.finalize).state === 'interrupted' ? DISCARD_INTERRUPTED : undefined
}

export interface ApplyPanelProps {
  snap: RunSnapshot
  /**
   * The reviewed marks the tab shows: they move the preview (core counts the reviewed files itself), and stand in for
   * core's count when its preview has none.
   */
  reviewed: ReadonlySet<string>
  /** What can move the preview (the Diff tab's refresh key). */
  refreshKey: string
}

export function ApplyPanel({ snap, reviewed, refreshKey }: ApplyPanelProps): React.JSX.Element {
  const id = useId()
  const headingId = `${id}-heading`
  const runId = snap.summary.runId
  const supported = useWorktreeSupported()
  const fin = finalizeInfoOf(snap.steps.finalize)
  const marks = [...reviewed].sort().join('|')
  const key = `${refreshKey}|${fin.state ?? ''}|${fin.undoToken ?? ''}|${marks}`
  const preview = usePreview(runId, key, supported)
  const [which, setWhich] = useState<ApplyWhich>('all')
  const [showConflicts, setShowConflicts] = useState(false)
  const [busy, run] = useBusy()

  const ready = preview.kind === 'ready' ? preview.preview : null
  // Core's own count (the same rule worktree.apply {reviewedOnly} applies); the tab's marks for an older core.
  const coreReviewed = ready?.reviewed !== undefined ? new Set(ready.reviewed) : reviewed
  const reviewedPaths =
    ready !== null ? ready.files.map((f) => f.path).filter((p) => coreReviewed.has(p)) : []
  const allCount = ready?.files.length ?? null
  const chosen = which === 'reviewed' ? new Set(reviewedPaths) : null
  const counts = ready !== null ? applyCounts(ready, chosen) : null
  const conflictPaths =
    ready !== null ? ready.conflicts.filter((p) => chosen === null || chosen.has(p)) : ([] as string[])
  /** core's reason for a conflict, when its preview gives one. */
  const reasons = new Map(
    (ready?.actions ?? []).flatMap((a) => (a.reason !== undefined ? [[a.path, a.reason] as const] : [])),
  )
  const facts = !supported
    ? LATER_VERSION
    : preview.kind === 'loading'
      ? PREVIEW_LOADING
      : preview.kind === 'error'
        ? `Dim Factory could not compare with your folder: ${preview.message}`
        : applyCountsText(counts ?? { write: 0, delete: 0, noop: 0, conflict: 0, skip: 0 })

  const blocked = applyBlockedReason(snap, supported)
  const emptyReason =
    ready === null
      ? undefined
      : which === 'reviewed' && reviewedPaths.length === 0
        ? ready.reviewed !== undefined && reviewed.size > 0
          ? APPLY_REVIEWED_EARLIER
          : APPLY_NONE_REVIEWED
        : ready.files.length === 0
          ? APPLY_NOTHING
          : undefined
  const reason = blocked ?? emptyReason
  const discardReason = discardBlockedReason(snap, supported)
  const apply = (): void =>
    run('apply', async () => {
      await applyToFolder(runId, which === 'reviewed' ? { reviewedOnly: true } : {})
    })
  const discard = (): void =>
    run('discard', async () => {
      await discardCopy(runId)
    })

  // A count keeps one width from "…" to core's answer (up to three digits), so nothing beside it moves.
  const count = (n: number | null): React.JSX.Element => (
    <StableLabel labels={COUNT_LABELS} align="start">
      {n === null ? '(…)' : `(${filesText(n)})`}
    </StableLabel>
  )
  const button = (
    <Button
      size="sm"
      variant="outline"
      icon={<FolderInput aria-hidden />}
      data-testid="diff-apply"
      disabled={reason !== undefined || (busy !== null && busy !== 'apply')}
      loading={busy === 'apply'}
      onClick={apply}
    >
      {APPLY_LABEL}
    </Button>
  )
  const discardButton = (
    <Button
      size="sm"
      variant="outline"
      icon={<Trash2 aria-hidden />}
      data-testid="diff-discard"
      disabled={discardReason !== undefined || (busy !== null && busy !== 'discard')}
      loading={busy === 'discard'}
      onClick={discard}
    >
      {DISCARD_COPY_LABEL}
    </Button>
  )
  return (
    <section
      aria-labelledby={headingId}
      data-testid="diff-apply-panel"
      className="flex flex-col gap-2 rounded-md border border-dashed px-3 py-2"
    >
      <h2 id={headingId} className="text-sm font-medium">
        {APPLY_TITLE}
      </h2>
      <p className="text-xs text-muted-foreground">{APPLY_HINT}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset
          disabled={!supported}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 disabled:opacity-60"
        >
          <legend className="sr-only">Files to apply</legend>
          <label className="inline-flex items-center gap-1.5 text-xs tabular-nums">
            <input
              type="radio"
              name={`${id}-which`}
              data-testid="diff-apply-all"
              disabled={!supported}
              checked={which === 'all'}
              onChange={() => setWhich('all')}
            />
            {APPLY_ALL} {count(allCount)}
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs tabular-nums">
            <input
              type="radio"
              name={`${id}-which`}
              data-testid="diff-apply-reviewed"
              disabled={!supported}
              checked={which === 'reviewed'}
              onChange={() => setWhich('reviewed')}
            />
            {APPLY_REVIEWED} {count(ready !== null ? reviewedPaths.length : null)}
          </label>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          {reason !== undefined ? <DisabledHint reason={reason}>{button}</DisabledHint> : button}
          {discardReason !== undefined ? (
            <DisabledHint reason={discardReason}>{discardButton}</DisabledHint>
          ) : (
            discardButton
          )}
        </div>
      </div>
      {/* One line from the start: core's counts for the files chosen, and the conflicts on a click. */}
      <div className="flex h-5 min-w-0 items-center gap-2 text-xs">
        <p
          data-testid="diff-apply-facts"
          role="status"
          className="min-w-0 truncate text-muted-foreground tabular-nums"
          title={facts}
        >
          {facts}
        </p>
        {conflictPaths.length > 0 && (
          <button
            type="button"
            aria-expanded={showConflicts}
            data-testid="diff-apply-conflicts-toggle"
            onClick={() => setShowConflicts((v) => !v)}
            className="inline-flex shrink-0 items-center gap-1 rounded text-primary hover:underline"
          >
            {showConflicts ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
            <StableLabel labels={['Show the conflicts', 'Hide the conflicts']} align="start">
              {showConflicts ? 'Hide the conflicts' : 'Show the conflicts'}
            </StableLabel>
          </button>
        )}
      </div>
      {showConflicts && conflictPaths.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="diff-apply-conflicts">
          <p className="text-xs text-muted-foreground">
            These files changed in your folder too. Apply leaves them as they are; the run&apos;s Finalize
            card asks you for each (Keep mine or Take run&apos;s).
          </p>
          <ul className="flex flex-col gap-0.5">
            {conflictPaths.map((p) => (
              <li key={p}>
                <code className="font-mono text-xs break-all">{p}</code>
                {reasons.get(p) !== undefined && (
                  <span className="ml-2 text-xs text-muted-foreground">{reasons.get(p)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
