// The Diff tab's view choices (its toolbar: Split | Stacked, Ignore line endings, the segment).
// They are the viewer's, not the run's: kept for the window's session (a tab switch or another run keeps them), never
// written to config or core. The segment is remembered per run.
import { useSyncExternalStore } from 'react'
import type { DiffSegment } from '@shared/ipc.ts'
import type { DiffLayout } from './text.ts'

export interface DiffPrefs {
  layout: DiffLayout
  ignoreEol: boolean
}

const DEFAULTS: DiffPrefs = { layout: 'split', ignoreEol: false }

let prefs: DiffPrefs = DEFAULTS
const segments = new Map<string, DiffSegment>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of [...listeners]) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useDiffPrefs(): DiffPrefs {
  return useSyncExternalStore(subscribe, () => prefs)
}

export function setDiffPrefs(patch: Partial<DiffPrefs>): void {
  prefs = { ...prefs, ...patch }
  emit()
}

export function toggleLayout(): void {
  setDiffPrefs({ layout: prefs.layout === 'split' ? 'stacked' : 'split' })
}

/** The segment the viewer last chose for this run (undefined: the default). */
export function useSegmentChoice(runId: string): DiffSegment | undefined {
  return useSyncExternalStore(subscribe, () => segments.get(runId))
}

export function chooseSegment(runId: string, seg: DiffSegment): void {
  segments.set(runId, seg)
  emit()
}

/** Tests: back to the defaults. */
export function resetDiffPrefs(): void {
  prefs = DEFAULTS
  segments.clear()
  emit()
}
