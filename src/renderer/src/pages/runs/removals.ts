// Remove and its Undo on the Runs page (interaction rule: undo toasts, not confirm dialogs). runs.remove hides the run at once (core deletes it for real after the undo
// window, or at the next start if the app quit) and answers an undo token; the Undo toast and the row the run leaves
// behind both send runs.undoRemove with it. Core decides what can be removed and until when it can come back: a
// refusal is a toast with core's words, and a refused Undo leaves the row saying why.
import { useSyncExternalStore } from 'react'
import type { RunSummary } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { removeRuns, upsertSummaries } from '../../state/actions.ts'
import { useStore } from '../../state/store.ts'
import { dismissToast, toast } from '../../state/toasts.ts'

export const UNDO_LABEL = 'Undo'

export interface Removal {
  /** The run as it was listed, shown in its row until it comes back. */
  summary: RunSummary
  undoToken: string
  /** `gone`: core refused the Undo (its window passed); `reason` says so. */
  state: 'removed' | 'undoing' | 'gone'
  reason?: string
}

const removals = new Map<string, Removal>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useRemoval(runId: string): Removal | undefined {
  return useSyncExternalStore(
    subscribe,
    () => removals.get(runId),
    () => undefined,
  )
}

export function removedToastId(runId: string): string {
  return `removed:${runId}`
}

export function removedText(displayNo: number): string {
  return `Run #${displayNo} removed`
}

/** runs.remove for one run, then its Undo toast; resolves to whether core removed it. */
export async function removeRun(summary: RunSummary): Promise<boolean> {
  const r = await invoke('runs.remove', { runIds: [summary.runId] })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  const { undoToken, removed } = r.value
  if (removed.length === 0) return false
  const byId = useStore.getState().summaries.byId
  for (const id of removed) {
    const s = id === summary.runId ? summary : byId[id]
    if (s !== undefined) removals.set(id, { summary: s, undoToken, state: 'removed' })
  }
  changed()
  removeRuns(removed)
  toast({
    id: removedToastId(summary.runId),
    level: 'info',
    message: removedText(summary.displayNo),
    action: { label: UNDO_LABEL, onClick: () => undoRemove(summary.runId) },
  })
  return true
}

/** runs.undoRemove with the run's token: the run (and any removed with it) comes back where it was listed. */
export async function undoRemove(runId: string): Promise<boolean> {
  const rem = removals.get(runId)
  if (rem === undefined || rem.state !== 'removed') return false
  const together = [...removals.entries()].filter(([, x]) => x.undoToken === rem.undoToken)
  for (const [id, x] of together) removals.set(id, { ...x, state: 'undoing' })
  changed()
  const r = await invoke('runs.undoRemove', { undoToken: rem.undoToken })
  if (!r.ok) {
    for (const [id, x] of together) removals.set(id, { ...x, state: 'gone', reason: r.error.message })
    changed()
    toast({ level: 'error', message: r.error.message })
    return false
  }
  for (const [id] of together) {
    removals.delete(id)
    dismissToast(removedToastId(id))
  }
  upsertSummaries(together.map(([, x]) => x.summary))
  changed()
  return true
}

/** Tests: forget every removal. */
export function resetRemovalsForTests(): void {
  removals.clear()
  changed()
}
