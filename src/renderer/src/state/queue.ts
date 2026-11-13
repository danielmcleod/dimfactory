// The factory's queues as core reports them (the `queue` event, and queue.get), and which folders' project memory
// changed (the `memory` event). Kept apart from the main store: the Queue page, the Dashboard's Queue card, the launch
// notice banner and the run's end panel read it.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { QueueView } from '@shared/factory.ts'
import { invoke } from '../ipc/client.ts'

interface QueueState {
  view: QueueView | null
  /** Bumped by every event, so a view fetched before it does not overwrite it. */
  version: number
  /** Per folder (as core names it), bumped when its memory changed. */
  memory: Record<string, number>
  /** queue.get failed (the message), until a view arrives. */
  error: string | null
}

export const useQueueStore = create<QueueState>(() => ({ view: null, version: 0, memory: {}, error: null }))

/** The `queue` event, or a command's answer: core's whole view. */
export function setQueueView(view: QueueView): void {
  useQueueStore.setState((s) => ({ view, version: s.version + 1, error: null }))
}

/** The `memory` event: a folder's project memory changed. */
export function bumpMemory(folder: string): void {
  const key = folderKey(folder)
  useQueueStore.setState((s) => ({ memory: { ...s.memory, [key]: (s.memory[key] ?? 0) + 1 } }))
}

export function folderKey(f: string): string {
  return f.replace(/[\\/]+$/, '').toLowerCase()
}

/** Read queue.get (with estimates) once; events keep it current. */
export function reloadQueue(): Promise<void> {
  const before = useQueueStore.getState().version
  return invoke('queue.get').then((r) => {
    if (!r.ok) {
      useQueueStore.setState({ error: r.error.message })
      return
    }
    if (useQueueStore.getState().version !== before && useQueueStore.getState().view !== null) {
      // An event arrived meanwhile: it is newer for the queues, but keep this answer's estimates.
      const cur = useQueueStore.getState().view
      if (cur === null) return
      setQueueView({
        ...cur,
        folders: cur.folders.map((f) => {
          const est = r.value.folders.find((x) => folderKey(x.folder) === folderKey(f.folder))?.estimateUsd
          return f.estimateUsd === undefined && est !== undefined ? { ...f, estimateUsd: est } : f
        }),
      })
      return
    }
    setQueueView(r.value)
  })
}

/** The view, read once on mount and kept current by the events. */
export function useQueueView(): QueueView | null {
  const view = useQueueStore((s) => s.view)
  useEffect(() => {
    void reloadQueue()
  }, [])
  return view
}

/** The memory version of a folder (re-read memory.get when it changes). */
export function useMemoryVersion(folder: string | null): number {
  return useQueueStore((s) => (folder === null ? 0 : (s.memory[folderKey(folder)] ?? 0)))
}

/** Tests: start empty. */
export function resetQueueForTests(): void {
  useQueueStore.setState({ view: null, version: 0, memory: {}, error: null })
}
