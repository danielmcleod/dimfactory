// How the app is used (Easy or Full control) and Easy's settings, from core's `easy.state`: loaded before the first
// render (main.tsx, so the Dashboard never shows the composer and then swaps in the welcome card), again after every
// config change, and after a switch. Unset (null): Full, unless core says a new user is to be asked once.
import { useSyncExternalStore } from 'react'
import type { Experience } from '@shared/config-schema.ts'
import type { EasyState } from '@shared/easy.ts'
import { invoke } from '../ipc/client.ts'
import { toast } from './toasts.ts'

let state: EasyState | null = null
const listeners = new Set<() => void>()

function set(next: EasyState | null): void {
  state = next
  for (const l of [...listeners]) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Ask core again (after a config change, a switch, or at start). False when core did not answer. */
export async function loadExperience(): Promise<boolean> {
  const r = await invoke('easy.state')
  if (!r.ok) return false
  set(r.value)
  return true
}

/** Easy or Full control; switching never stops or restarts a run. Resolves to whether core took it. */
export async function chooseExperience(experience: Experience): Promise<boolean> {
  const r = await invoke('easy.setExperience', { experience })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  set(r.value)
  return true
}

export function easyStateNow(): EasyState | null {
  return state
}

/** Core's Easy state (null until it answered). */
export function useEasyState(): EasyState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  )
}

/** The mode in use: Easy only when chosen; Full otherwise (unset included). */
export function useExperience(): Experience {
  return useEasyState()?.experience === 'easy' ? 'easy' : 'full'
}

/** Tests: a state as if core had answered it (null: not answered). */
export function setEasyStateForTests(next: EasyState | null): void {
  set(next)
}
