// Revert all (back to S0; the Stop toast "Run stopped · changes kept [Revert all]", undoable; in the Diff tab it
// shows an undo toast and is disabled while the folder is busy; R13).
// diff.revert{runId, paths:'all'} puts the folder back as it was before the run; core first snapshots the folder
// (`pre-revert`), so the toast's Undo (diff.undoRevert with core's token) brings the run's changes back.
// Revert is allowed only while no process holds the folder. The renderer reads that from core's facts (this run still
// working or stopping, or another run in the same folder working) and says so beside the disabled control; core
// checks again and answers FOLDER_BUSY with its own message. A core that answers UNSUPPORTED (older than this
// renderer) is remembered for the session: Revert all then shows "Available in a later version".
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { RevertResult } from '@shared/ipc.ts'
import type { RunSnapshot, RunSummary } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { useStore } from '../../state/store.ts'
import type { StoreState } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { LATER_VERSION } from '../ui/DisabledHint.tsx'

export const REVERT_ALL_LABEL = 'Revert all'
export const UNDO_LABEL = 'Undo'
export const STILL_STOPPING = 'Dim Factory is still stopping this run.'
export const STILL_WORKING = 'The run is still working in the folder.'
export const STILL_RECORDING = 'Dim Factory is still recording the folder.'

/** Another run in the same folder that holds it now. */
export function otherRunBusy(n: number): string {
  return `Run #${n} is using this folder.`
}

/** Step statuses that may have a vendor process in the folder (`waiting`: on an ask, or on a card). */
const STEP_WORKING: ReadonlySet<RunSummary['steps'][number]['status']> = new Set([
  'running',
  'waiting',
  'stalled',
])

/**
 * The run works in the folder: it is running (a step, or Dim Factory's own snapshot and checks between steps), or it
 * waits on an ask (a step waiting with its process alive). A run waiting on a card or a gate holds no process there,
 * so the user may revert then; a revert at the gate before Fix becomes a note for Fix. With the run's snapshot
 * (the open run) a waiting step counts only while it has an ask; from a summary alone, any waiting step counts.
 */
function working(r: RunSummary, snap?: RunSnapshot): boolean {
  if (r.status === 'running') return true
  if (r.status !== 'waiting') return false
  if (snap === undefined) return r.steps.some((st) => STEP_WORKING.has(st.status))
  return Object.values(snap.steps).some(
    (st) =>
      st.status === 'running' ||
      st.status === 'stalled' ||
      (st.status === 'waiting' && snap.asks.some((a) => a.step === st.key)),
  )
}

/**
 * Why Revert all cannot run now, or undefined. Read from core's summaries, never decided here: this run is still
 * stopping (core's phase `stopping` = a live process), still working, or has ended but still holds its folder lock
 * (its last snapshot); another run in the same folder is stopping, or holds its lock while it works or is about to
 * start (queued with the lock).
 */
export function folderBusyReason(s: StoreState, runId: string): string | undefined {
  const snap = s.runs.byId[runId]?.snapshot ?? undefined
  const me = s.summaries.byId[runId] ?? snap?.summary
  if (me === undefined) return undefined
  if (me.phase === 'stopping') return STILL_STOPPING
  if (working(me, snap)) return STILL_WORKING
  // An ended run still holding its folder lock: Dim Factory is taking its last snapshot (`stopped` after a Stop) and
  // releases the lock after it (R13); core republishes the summary then.
  if ((me.status === 'cancelled' || me.status === 'completed') && me.lock === 'held')
    return me.status === 'cancelled' ? STILL_STOPPING : STILL_RECORDING
  for (const id of s.summaries.order) {
    if (id === runId) continue
    const o = s.summaries.byId[id]
    if (o === undefined || o.folderKey !== me.folderKey) continue
    if (o.phase === 'stopping' || (o.lock === 'held' && (working(o) || o.status === 'queued')))
      return otherRunBusy(o.displayNo)
  }
  return undefined
}

export function useFolderBusyReason(runId: string): string | undefined {
  return useStore((s) => folderBusyReason(s, runId))
}

// ---- what this build's core supports -------------------------------------------------------------------------------

let supported: 'unknown' | 'no' = 'unknown'
const listeners = new Set<() => void>()

function setUnsupported(): void {
  if (supported === 'no') return
  supported = 'no'
  for (const l of [...listeners]) l()
}

/** False once core answered UNSUPPORTED for diff.revert this session. */
export function useRevertSupported(): boolean {
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
export function resetRevertForTests(): void {
  supported = 'unknown'
  for (const l of [...listeners]) l()
}

// ---- reverting and undoing ----------------------------------------------------------------------------------------

const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`

/** "Reverted 7 files", with what core left alone: "Reverted 6 files · 1 skipped". */
export function revertedText(r: RevertResult): string {
  const n = r.restored.length + r.deleted.length
  const head = n === 0 ? 'No files needed reverting' : `Reverted ${files(n)}`
  return r.skipped.length > 0 ? `${head} · ${r.skipped.length} skipped` : head
}

export const UNDONE_MESSAGE = "Revert undone: the run's changes are back"

/** What an undo brings back: the run's changes, or what a card revert reverted ("Plan's changes"). */
export function undoneText(what?: string): string {
  return what === undefined ? UNDONE_MESSAGE : `Revert undone: ${what} are back`
}

/**
 * diff.undoRevert with core's token; what was reverted comes back (the run's changes, or `what` for a card revert:
 * RunSnapshot.revertUndo.label).
 */
export async function undoRevert(runId: string, undoToken: string, what?: string): Promise<boolean> {
  const r = await invoke('diff.undoRevert', { runId, undoToken })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  toast({ id: `revert-undone:${runId}`, level: 'info', message: undoneText(what) })
  void fetchSnapshot(runId)
  return true
}

/** "Reverted Plan's changes": core's words for what a card choice reverted (RunSnapshot.revertUndo.label). */
export function cardRevertText(label: string): string {
  return `Reverted ${label}`
}

/**
 * The undo toast for a revert core made on a card choice (Revert Plan's changes, Restore run's version, Revert partial
 * then fresh: RunSnapshot.revertUndo), once per undo token, for reverts that appear while the Run view is open (one
 * already there when the view opens was offered when it happened). Undo is diff.undoRevert with core's token.
 */
export function useRevertUndoToast(snap: RunSnapshot): void {
  const runId = snap.summary.runId
  const undo = snap.revertUndo
  const token = undo?.undoToken ?? null
  const seen = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const first = seen.current === undefined
    const prev = seen.current
    seen.current = token
    if (first || token === null || token === prev || undo === undefined) return
    toast({
      id: `revert-undo:${runId}`,
      level: 'info',
      message: cardRevertText(undo.label),
      durationMs: 15_000,
      // The run usually goes on at once (Fix after a restore, Implement after a retry): Undo waits, with the reason,
      // while the run works in the folder. "After the run" keeps offering it once the run has ended.
      action: {
        label: UNDO_LABEL,
        onClick: () => undoRevert(runId, token, undo.label),
        liveDisabledReason: (s) => folderBusyReason(s, runId),
      },
    })
    // The token names the revert: the toast is for a new one only (its label and count come with it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, token])
}

/**
 * diff.revert for the whole run, then "Reverted N files · [Undo]". Errors are toasts with core's message
 * (FOLDER_BUSY included); UNSUPPORTED is remembered so the controls show the reason instead.
 */
/** `onDone` runs after the revert and after its Undo (the Diff tab reads its list again: the user's own change). */
export async function revertAll(runId: string, onDone?: () => void): Promise<boolean> {
  const r = await invoke('diff.revert', { runId, paths: 'all' })
  if (!r.ok) {
    if (r.error.code === 'UNSUPPORTED') {
      setUnsupported()
      toast({ level: 'warn', message: `${REVERT_ALL_LABEL}: ${LATER_VERSION.toLowerCase()}.` })
    } else {
      toast({ level: 'error', message: r.error.message })
    }
    return false
  }
  const res = r.value
  const changed = res.restored.length + res.deleted.length
  toast({
    id: `reverted:${runId}`,
    level: 'info',
    message: revertedText(res),
    ...(changed > 0
      ? {
          action: {
            label: UNDO_LABEL,
            onClick: async () => {
              const undone = await undoRevert(runId, res.undoToken)
              if (undone) onDone?.()
              return undone
            },
          },
          durationMs: 15_000,
        }
      : {}),
  })
  void fetchSnapshot(runId)
  onDone?.()
  return true
}
