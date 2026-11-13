// Palette → quick composer (the palette's Actions "New run" and Folders "choose in composer"), and New project → quick
// composer. The asker asks; the composer, while mounted, chooses the folder (as a click on its chip would) and puts
// the focus in its task box, or, when the ask carries a task (New project), fills the task and the Brief and puts the
// focus on Run, so the user sees the checks and the estimate before pressing it. An ask made while the Dashboard is
// not mounted waits for the composer's next mount, for a short while only, so it never surprises a later visit to the
// Dashboard.
import { useEffect, useRef } from 'react'
import type { BriefInput } from '@shared/brief.ts'

export interface ComposerIntent {
  /** A folder to choose, as a click on its recent-folder chip would. */
  folder?: string
  /** The task to put in the task box (it replaces the folder's draft). */
  task?: string
  /** The Brief to show for the folder (as a saved brief is restored). */
  brief?: BriefInput
  /** The recipe the run should use (a recipe id); carried for the composer's recipe picker. */
  recipe?: string
}

type Listener = (intent: ComposerIntent) => void

/** An ask waiting for the composer is dropped after this long. */
export const INTENT_TTL_MS = 5000

const listeners = new Set<Listener>()
let pending: { intent: ComposerIntent; at: number } | null = null

/** Ask the composer to choose a folder (optional), fill a task and a Brief (optional) and take the focus. */
export function requestComposer(intent: ComposerIntent = {}): void {
  if (listeners.size === 0) {
    pending = { intent, at: Date.now() }
    return
  }
  pending = null
  for (const l of [...listeners]) l(intent)
}

/** The composer's side: called with each ask while mounted, and with one still waiting when it mounts. */
export function useComposerIntent(handler: Listener): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    const listener: Listener = (i) => ref.current(i)
    listeners.add(listener)
    const waiting = pending
    pending = null
    if (waiting !== null && Date.now() - waiting.at <= INTENT_TTL_MS) listener(waiting.intent)
    return () => {
      listeners.delete(listener)
    }
  }, [])
}

/** Tests: forget listeners and a waiting ask. */
export function resetComposerIntentForTests(): void {
  pending = null
  listeners.clear()
}
