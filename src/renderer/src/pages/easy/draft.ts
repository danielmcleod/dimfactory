// The idea being made into a project: typed on Easy's home, read by the confirm screen, kept when the user goes Back
// (and carried into the Full composer on a switch). Session memory only: an idea is never written anywhere until the
// user presses Start.
import { useSyncExternalStore } from 'react'
import type { EasyAttachment, EasyKind } from '@shared/easy.ts'

export interface EasyDraft {
  idea: string
  /** The kind the user picked on the confirm screen (absent: detected from the idea). */
  kind?: EasyKind
  /** Files added on the home screen, as core checked them (a refused one says why and is not sent). */
  attachments?: EasyAttachment[]
}

/** The draft with a new idea: a new idea is detected afresh (the kind goes), the added files stay. */
export function withIdea(d: EasyDraft, idea: string): EasyDraft {
  const files = d.attachments !== undefined ? { attachments: d.attachments } : {}
  return idea.trim() === d.idea.trim() ? { ...d, idea } : { idea, ...files }
}

let draft: EasyDraft = { idea: '' }
const listeners = new Set<() => void>()

export function setDraft(next: EasyDraft): void {
  draft = next
  for (const l of [...listeners]) l()
}

export function draftNow(): EasyDraft {
  return draft
}

export function useDraft(): EasyDraft {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => draft,
    () => draft,
  )
}

/** Tests: an empty draft. */
export function resetDraftForTests(): void {
  draft = { idea: '' }
}
