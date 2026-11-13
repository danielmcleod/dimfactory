// Run & Preview sessions as core reports them (the `preview` event, and preview.detect's list). Kept apart from the
// main store: only the Run it panels read them.
import { create } from 'zustand'
import type { PreviewSessionView, PreviewSmokeView } from '@shared/preview.ts'

interface PreviewsState {
  byId: Record<string, PreviewSessionView>
  /** The newest smoke check run from this window, per folder (core keeps a run's with the run too). */
  smoke: Record<string, PreviewSmokeView>
}

export const usePreviewsStore = create<PreviewsState>(() => ({ byId: {}, smoke: {} }))

/** A session's newest view (the event, or a command's answer). An older view of the same session never wins. */
export function upsertPreviewSessions(views: readonly PreviewSessionView[]): void {
  if (views.length === 0) return
  usePreviewsStore.setState((s) => {
    const byId = { ...s.byId }
    for (const v of views) {
      const had = byId[v.id]
      // An ended session never goes back to running (an answer may arrive after the event that ended it).
      if (had !== undefined && had.endedAt !== undefined && v.endedAt === undefined) continue
      if (had !== undefined && had.lines > v.lines && had.status === v.status) continue
      byId[v.id] = v
    }
    return { byId }
  })
}

/** Normalized for comparing folders the way core does on Windows and elsewhere (case kept off Windows). */
const folderKey = (f: string): string => f.replace(/[\\/]+$/, '').toLowerCase()

/** The sessions for a folder, newest first. */
export function usePreviewSessions(folder: string | null): PreviewSessionView[] {
  const byId = usePreviewsStore((s) => s.byId)
  if (folder === null) return []
  const key = folderKey(folder)
  return Object.values(byId)
    .filter((v) => folderKey(v.folder) === key)
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** A smoke check's answer, for the folder's panels. */
export function setPreviewSmoke(folder: string, view: PreviewSmokeView): void {
  usePreviewsStore.setState((s) => ({ smoke: { ...s.smoke, [folderKey(folder)]: view } }))
}

/** The newest smoke check for a folder: this window's, or core's (a run's, read with preview.detect). */
export function usePreviewSmoke(
  folder: string | null,
  fromCore: PreviewSmokeView | null,
): PreviewSmokeView | null {
  const local = usePreviewsStore((s) => (folder === null ? undefined : s.smoke[folderKey(folder)]))
  if (local === undefined) return fromCore
  if (fromCore === null) return local
  return local.at >= fromCore.at ? local : fromCore
}

/** Tests: start empty. */
export function resetPreviewsForTests(): void {
  usePreviewsStore.setState({ byId: {}, smoke: {} })
}
