// Toasts (interaction rule: undo toasts, not confirm dialogs). A stack in the store with
// auto-dismiss timers kept here; hovering or focusing the stack pauses every timer. An action either runs a core
// command (`call`) or a callback (`onClick`), and may be shown disabled with a reason.
import type { ToastLevel } from '@shared/ipc.ts'
import { useStore } from './store.ts'
import type { ToastActionSpec, ToastItem } from './store.ts'

export type { ToastActionSpec, ToastItem } from './store.ts'

export interface ToastInput {
  level: ToastLevel
  message: string
  action?: ToastActionSpec
  /** A second action, shown after `action` (only with one). */
  secondary?: ToastActionSpec
  /** Default by level (info 5 s, warn 8 s, error 10 s; at least 8 s with an action). null: until dismissed. */
  durationMs?: number | null
  /** Reuse an id to replace a toast in place (e.g. "Denied · Undo" updated by its outcome). */
  id?: string
}

/**
 * Older toasts beyond this are dropped (UI standard, one scroll region per screen and nothing moves on its own: at
 * most three stacked, so the stack stays a corner overlay).
 */
export const TOAST_MAX = 3

const DEFAULT_MS: Record<ToastLevel, number> = { info: 5000, warn: 8000, error: 10_000 }
const ACTION_MIN_MS = 8000

interface Timer {
  handle: ReturnType<typeof setTimeout> | null
  remaining: number
  startedAt: number
}

const timers = new Map<string, Timer>()
let paused = false
let seq = 0

function arm(id: string, ms: number): void {
  const t: Timer = { handle: null, remaining: ms, startedAt: Date.now() }
  timers.set(id, t)
  if (!paused) t.handle = setTimeout(() => dismissToast(id), ms)
}

function disarm(id: string): void {
  const t = timers.get(id)
  if (t?.handle != null) clearTimeout(t.handle)
  timers.delete(id)
}

function durationOf(input: ToastInput): number | null {
  if (input.durationMs !== undefined) return input.durationMs
  const base = DEFAULT_MS[input.level]
  return input.action !== undefined ? Math.max(base, ACTION_MIN_MS) : base
}

/** Show a toast; returns its id. */
export function toast(input: ToastInput): string {
  const id = input.id ?? `t${++seq}`
  const durationMs = durationOf(input)
  const item: ToastItem = {
    id,
    level: input.level,
    message: input.message,
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(input.action !== undefined && input.secondary !== undefined ? { secondary: input.secondary } : {}),
    durationMs,
    createdAt: Date.now(),
  }
  disarm(id)
  const items = [...useStore.getState().toasts.items.filter((t) => t.id !== id), item]
  const keep = items.slice(-TOAST_MAX)
  for (const dropped of items.slice(0, items.length - keep.length)) disarm(dropped.id)
  useStore.setState({ toasts: { items: keep } })
  if (durationMs !== null) arm(id, durationMs)
  return id
}

export function dismissToast(id: string): void {
  disarm(id)
  useStore.setState((s) => ({ toasts: { items: s.toasts.items.filter((t) => t.id !== id) } }))
}

/** Freeze every auto-dismiss timer (pointer or focus inside the stack). */
export function pauseToasts(): void {
  if (paused) return
  paused = true
  const now = Date.now()
  for (const t of timers.values()) {
    if (t.handle !== null) {
      clearTimeout(t.handle)
      t.handle = null
      t.remaining = Math.max(0, t.remaining - (now - t.startedAt))
    }
  }
}

export function resumeToasts(): void {
  if (!paused) return
  paused = false
  const now = Date.now()
  for (const [id, t] of timers) {
    t.startedAt = now
    t.handle = setTimeout(() => dismissToast(id), t.remaining)
  }
}

export function toastsPaused(): boolean {
  return paused
}

/** Tests: drop all toasts and timers. */
export function clearToasts(): void {
  for (const id of [...timers.keys()]) disarm(id)
  paused = false
  useStore.setState({ toasts: { items: [] } })
}
