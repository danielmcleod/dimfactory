// Apply to folder and the Undo of an apply or a discard (Apply leases the
// folder lock and takes the `pre-apply` snapshot P first, writes only files whose folder content still equals the
// base, and Undo is `restore(applied, P)`; Discard is deferred 10 s and undoable; Undo toasts, not confirm
// dialogs). worktree.preview says what Apply would do; worktree.apply answers with core's undo token, which the
// toast's Undo sends back (worktree.undoApply); the finalize card's Apply and Discard go through cards.resolve, and
// their Undo uses the token core's finalize view carries (FinalizeCard). Core's refusals (the folder busy, nothing to
// apply) become an error toast with core's own words. A core that answers UNSUPPORTED (older than this renderer) is
// remembered for the session, and the controls then say "Available in a later version".
import { useSyncExternalStore } from 'react'
import type { Result, WorktreeApplyResult, WorktreeConflictChoice, WorktreePreview } from '@shared/ipc.ts'
import { coreRemainingMs, coreTimeScale } from '../../lib/coreClock.ts'
import { invoke } from '../../ipc/client.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { UNDO_LABEL } from './revert.ts'

/** Discard's deferral (deletion is deferred 10 s), when core sends no time of its own. */
export const DISCARD_DEFER_MS = 10_000

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

/** "Applied 3 files to your folder", with what core left: "· 1 conflict to choose · 1 left alone". */
export function appliedCountText(applied: number, conflicts: number, skipped = 0): string {
  if (applied === 0 && conflicts === 0 && skipped === 0)
    return "Nothing to apply: your folder already has the run's changes."
  const parts = [applied > 0 ? `Applied ${files(applied)} to your folder` : 'Applied nothing yet']
  if (conflicts > 0) parts.push(`${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} to choose`)
  if (skipped > 0) parts.push(`${skipped} left alone`)
  return parts.join(' · ')
}

/** appliedCountText for worktree.apply's answer. */
export function appliedText(r: Pick<WorktreeApplyResult, 'applied' | 'conflicts' | 'skipped'>): string {
  return appliedCountText(r.applied.length, r.conflicts.length, r.skipped?.length ?? 0)
}

export const APPLY_UNDONE = 'Your folder is back as it was before the apply.'
export const DISCARDED = 'Discarded the isolated copy.'
export const DISCARD_UNDONE = 'The isolated copy is kept.'

// ---- what this build's core supports -------------------------------------------------------------------------------

let supported: 'unknown' | 'no' = 'unknown'
const listeners = new Set<() => void>()

function setUnsupported(): void {
  if (supported === 'no') return
  supported = 'no'
  for (const l of [...listeners]) l()
}

/** False once core answered UNSUPPORTED for a worktree command this session. */
export function useWorktreeSupported(): boolean {
  return (
    useSyncExternalStore(
      (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      () => supported,
    ) !== 'no'
  )
}

/** Tests: forget what core answered. */
export function resetWorktreeForTests(): void {
  supported = 'unknown'
  for (const l of [...listeners]) l()
}

// ---- the commands ---------------------------------------------------------------------------------------------------

function refused(code: string, message: string): void {
  if (code === 'UNSUPPORTED') setUnsupported()
  toast({ level: 'error', message })
}

/** What Apply would do now (core's preview); an UNSUPPORTED answer is remembered like the other commands'. */
export async function previewApply(runId: string): Promise<Result<WorktreePreview>> {
  const r = await invoke('worktree.preview', { runId })
  if (!r.ok && r.error.code === 'UNSUPPORTED') setUnsupported()
  return r
}

/** Undo an apply: the folder back to snapshot P (`pre-apply`). */
export async function undoApply(runId: string, undoToken: string): Promise<boolean> {
  const r = await invoke('worktree.undoApply', { runId, undoToken })
  if (!r.ok) {
    refused(r.error.code, r.error.message)
    return false
  }
  void fetchSnapshot(runId)
  toast({ id: `worktree-apply:${runId}`, level: 'info', message: APPLY_UNDONE })
  return true
}

/** What an apply takes: every file (nothing set), `paths`, or the reviewed files as core counts them. */
export interface ApplySelection {
  paths?: readonly string[]
  /** Core picks the files whose reviewed mark names the version Apply writes (WorktreePreview.reviewed). */
  reviewedOnly?: true
  resolutions?: Readonly<Record<string, WorktreeConflictChoice>>
}

/**
 * Apply the run's changes to its folder (all files, `paths`, or the reviewed ones). The toast says what core applied
 * and what it left as conflicts, and offers Undo. Resolves to core's answer, or null when nothing was done.
 */
export async function applyToFolder(
  runId: string,
  sel: ApplySelection = {},
): Promise<WorktreeApplyResult | null> {
  const r = await invoke('worktree.apply', {
    runId,
    ...(sel.paths !== undefined ? { paths: [...sel.paths] } : {}),
    ...(sel.reviewedOnly === true ? { reviewedOnly: true } : {}),
    ...(sel.resolutions !== undefined ? { resolutions: { ...sel.resolutions } } : {}),
  })
  if (!r.ok) {
    refused(r.error.code, r.error.message)
    return null
  }
  void fetchSnapshot(runId)
  const res = r.value
  const canUndo = res.applied.length > 0 && res.undoToken !== ''
  toast({
    id: `worktree-apply:${runId}`,
    level: res.conflicts.length > 0 ? 'warn' : 'info',
    message: appliedText(res),
    ...(canUndo
      ? {
          durationMs: 15_000,
          action: { label: UNDO_LABEL, onClick: () => undoApply(runId, res.undoToken) },
        }
      : {}),
  })
  return res
}

/**
 * Discard the isolated copy (worktree.discard): core deletes it 10 s later unless undone. The toast says so
 * with Undo (worktree.undoDiscard) until core deletes it.
 */
export async function discardCopy(runId: string): Promise<boolean> {
  const r = await invoke('worktree.discard', { runId })
  if (!r.ok) {
    refused(r.error.code, r.error.message)
    return false
  }
  void fetchSnapshot(runId)
  const { undoToken, deleteAt } = r.value
  toast({
    id: `worktree-discard:${runId}`,
    level: 'info',
    message: DISCARDED,
    durationMs: discardToastMs(deleteAt),
    action: { label: UNDO_LABEL, onClick: () => undoDiscard(runId, undoToken) },
  })
  return true
}

/** Undo a discard while its deletion is still pending. */
export async function undoDiscard(runId: string, undoToken: string): Promise<boolean> {
  const r = await invoke('worktree.undoDiscard', { runId, undoToken })
  if (!r.ok) {
    refused(r.error.code, r.error.message)
    return false
  }
  void fetchSnapshot(runId)
  toast({ id: `worktree-discard:${runId}`, level: 'info', message: DISCARD_UNDONE })
  return true
}

/**
 * How long the Discard toast stays (this window's ms): until core deletes the copy (`deleteAt`, a core time; under a
 * compressed E2E clock core's ms pass faster), at least a second; the 10 s deferral when core sent no time.
 */
export function discardToastMs(deleteAt: number): number {
  if (!Number.isFinite(deleteAt)) return DISCARD_DEFER_MS
  const local = coreRemainingMs(deleteAt) / coreTimeScale()
  return Math.round(Math.max(1000, Math.min(local, 60_000)))
}
