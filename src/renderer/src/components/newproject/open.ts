// Whether the New project dialog is open: the Dashboard's button and the palette's action open it; the dialog
// (mounted once, beside the palette) reads it.
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (open === next) return
  open = next
  for (const l of [...listeners]) l()
}

export function openNewProject(): void {
  set(true)
}

export function closeNewProject(): void {
  set(false)
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useNewProjectOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  )
}

/** Tests: closed, no listeners kept. */
export function resetNewProjectForTests(): void {
  open = false
}
