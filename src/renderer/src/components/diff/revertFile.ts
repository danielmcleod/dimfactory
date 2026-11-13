// A file's Revert in the Diff tab (it shows an undo toast and is disabled while the folder is busy). diff.revert{runId, seg, paths} puts the file back as it was at the segment's
// start (a rename's two sides go together, since core plans reverts without rename detection), then "Reverted
// src/a.ts · [Undo]"; Undo is diff.undoRevert with core's token, and waits, with the reason, while the folder is busy.
// Core checks the folder again and answers FOLDER_BUSY with its own message, shown as a toast.
import type { DiffSegment, FileChange } from '@shared/ipc.ts'
import { invoke } from '../../ipc/client.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { LATER_VERSION } from '../ui/DisabledHint.tsx'
import { UNDO_LABEL, folderBusyReason } from '../run/revert.ts'
import { REVERT_FILE_LABEL, revertedFileText } from './text.ts'

/** The paths a file's revert names: both sides of a rename. */
export function revertPaths(f: FileChange): string[] {
  return f.status === 'R' && f.oldPath !== undefined && f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path]
}

export function undoneFileText(path: string): string {
  return `Revert undone: ${path} is back`
}

async function undo(runId: string, undoToken: string, path: string, onDone: () => void): Promise<boolean> {
  const r = await invoke('diff.undoRevert', { runId, undoToken })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  toast({ id: `revert-file-undone:${runId}:${path}`, level: 'info', message: undoneFileText(path) })
  void fetchSnapshot(runId)
  onDone()
  return true
}

/** Revert one file of the segment; resolves to whether core reverted. `onDone` runs after a revert and its undo. */
export async function revertFile(
  runId: string,
  seg: DiffSegment,
  f: FileChange,
  onDone: () => void,
): Promise<boolean> {
  const r = await invoke('diff.revert', { runId, seg, paths: revertPaths(f) })
  if (!r.ok) {
    if (r.error.code === 'UNSUPPORTED')
      toast({ level: 'warn', message: `${REVERT_FILE_LABEL}: ${LATER_VERSION.toLowerCase()}.` })
    else toast({ level: 'error', message: r.error.message })
    return false
  }
  const res = r.value
  const changed = res.restored.length + res.deleted.length
  const token = res.undoToken
  toast({
    id: `revert-file:${runId}:${f.path}`,
    level: 'info',
    message: revertedFileText(f.path, changed, res.skipped.length),
    ...(changed > 0
      ? {
          durationMs: 15_000,
          action: {
            label: UNDO_LABEL,
            onClick: () => undo(runId, token, f.path, onDone),
            liveDisabledReason: (s) => folderBusyReason(s, runId),
          },
        }
      : {}),
  })
  void fetchSnapshot(runId)
  onDone()
  return true
}
