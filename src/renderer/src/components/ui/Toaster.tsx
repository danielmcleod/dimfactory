// The toast stack (state/toasts.ts): an overlay in the bottom right corner, clear of the page's primary actions (Run
// is at the top; a page with a bar at the window's bottom keeps the stack above it with useToastClearance). Hovering
// or focusing it pauses every auto-dismiss timer. An action runs a core command or a callback once, then the toast
// closes; a failed command becomes an error toast with core's message. A disabled action shows its reason as a
// tooltip.
//
// Nothing moves on its own (UI standard): a toast on screen stays exactly where it is
// until it goes, however many come and go around it. The stack is anchored at the bottom, oldest first. A toast that
// goes while a newer one is above it leaves its room behind as a gap (invisible and inert; neighbouring gaps join into
// one), so nothing above it drops; gaps with nothing shown above them close, which moves nothing. A new toast goes
// into the lowest gap it fits, at that gap's bottom (what is left of the gap stays a gap above it), and on top of the
// stack only when no gap fits it; it is measured and placed before it is painted. At most TOAST_MAX toasts are shown,
// so a burst reuses the room of the toasts it pushes out instead of climbing the window. The bars the stack keeps
// clear of (useToastClearance) can come and go while toasts are shown (a card's sticky action row): the stack then
// stays where it is, and moves to the new clearance once it is empty.
import { AlertTriangle, CircleAlert, Info, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ToastLevel } from '@shared/ipc.ts'
import { invokeCall } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useToasts } from '../../state/selectors.ts'
import { useStore } from '../../state/store.ts'
import { dismissToast, pauseToasts, resumeToasts, toast } from '../../state/toasts.ts'
import type { ToastActionSpec, ToastItem } from '../../state/toasts.ts'
import { Button } from './Button.tsx'
import { DisabledHint } from './DisabledHint.tsx'

const ICON: Record<ToastLevel, typeof Info> = { info: Info, warn: AlertTriangle, error: CircleAlert }
const ICON_TONE: Record<ToastLevel, string> = {
  info: 'text-info',
  warn: 'text-warning',
  error: 'text-destructive',
}

/** Room between two slots of the stack (px): its `gap-2`. */
export const TOAST_GAP_PX = 8

export interface ToastSlot {
  id: string
  /** The toast (for a gap, the last one that was there). */
  item: ToastItem
  /** False: a gap, the room toasts that went left behind. */
  live: boolean
  /** The room the slot keeps (px): a gap's, and a toast's that took a whole gap (it rests at the room's bottom). */
  hold?: number
  /** Just arrived on top and not measured yet: it may still go into a gap that fits it, before it is painted. */
  fresh?: boolean
}

/** Join neighbouring gaps into one (the same room: theirs and the space between them), and close gaps on top. */
function tidy(slots: ToastSlot[]): ToastSlot[] {
  const out: ToastSlot[] = []
  for (const s of slots) {
    const below = out.at(-1)
    if (!s.live && below !== undefined && !below.live)
      out[out.length - 1] = { ...below, hold: (below.hold ?? 0) + TOAST_GAP_PX + (s.hold ?? 0) }
    else out.push(s)
  }
  // A gap with nothing shown above it closes without moving anything.
  while (out.length > 0 && out.at(-1)?.live === false) out.pop()
  return out
}

/**
 * The stack's slots, oldest (bottom) first, after the store's toasts changed: a toast keeps its slot (also when it is
 * replaced by id), a toast that went leaves its room as a gap (`heightOf`: what each toast measured while shown), and
 * a new one goes on top, fresh, until placeFresh() has measured it.
 */
export function nextSlots(
  prev: readonly ToastSlot[],
  items: readonly ToastItem[],
  heightOf: (id: string) => number,
): ToastSlot[] {
  const byId = new Map(items.map((t) => [t.id, t]))
  const slots: ToastSlot[] = prev.map((s) => {
    const t = byId.get(s.id)
    if (t !== undefined) return { ...s, item: t }
    return s.live ? { id: s.id, item: s.item, live: false, hold: Math.max(s.hold ?? 0, heightOf(s.id)) } : s
  })
  const known = new Set(slots.map((s) => s.id))
  for (const t of items) if (!known.has(t.id)) slots.push({ id: t.id, item: t, live: true, fresh: true })
  return tidy(slots)
}

/**
 * Place the fresh toasts, now measured (`heightOf`): each goes into the lowest gap it fits, at that gap's bottom (the
 * rest of the gap stays a gap above it), or stays on top when none fits. Every other toast keeps its place: the room
 * below and above a filled gap is what it was. Returns `slots` itself when there is nothing to place.
 */
export function placeFresh(
  slots: readonly ToastSlot[],
  heightOf: (id: string) => number,
): readonly ToastSlot[] {
  if (!slots.some((s) => s.fresh === true)) return slots
  let out = [...slots]
  for (const fresh of slots.filter((s) => s.fresh === true)) {
    const at = out.indexOf(fresh)
    const h = heightOf(fresh.id)
    const placed: ToastSlot = { id: fresh.id, item: fresh.item, live: true }
    const gap = out.findIndex((s, i) => i < at && !s.live && (s.hold ?? 0) >= h)
    const target = out[gap]
    if (target === undefined) {
      out[at] = placed
      continue
    }
    const left = (target.hold ?? 0) - h - TOAST_GAP_PX
    out.splice(at, 1)
    out.splice(gap, 1, placed, ...(left > 0 ? [{ ...target, hold: left }] : []))
    // Not enough left for a gap of its own: the toast keeps the gap's whole room (its slot is that tall).
    if (left <= 0) out[gap] = { ...placed, hold: target.hold ?? h }
    out = tidy(out)
  }
  return out
}

/**
 * The slots for the store's toasts, kept across renders (derived state: recomputed when the toasts change). After
 * each change, before the browser paints, every toast is measured (its room is known when it goes) and the fresh ones
 * are placed.
 */
function useToastSlots(
  items: readonly ToastItem[],
  list: RefObject<HTMLOListElement | null>,
): readonly ToastSlot[] {
  const heights = useRef(new Map<string, number>())
  const heightOf = (id: string): number => heights.current.get(id) ?? 0
  const [state, setState] = useState<{ items: readonly ToastItem[]; slots: readonly ToastSlot[] }>(() => ({
    items,
    slots: nextSlots([], items, () => 0),
  }))
  let slots = state.slots
  if (state.items !== items) {
    slots = nextSlots(state.slots, items, heightOf)
    setState({ items, slots })
  }
  useLayoutEffect(() => {
    const measured = new Map<string, number>()
    for (const el of list.current?.querySelectorAll<HTMLElement>('[data-toast-card]') ?? [])
      measured.set(el.dataset['toastCard'] ?? '', el.getBoundingClientRect().height)
    // A toast keeps the height it was last seen with until it goes (its gap's room).
    for (const [id, h] of measured) heights.current.set(id, h)
    const present = new Set(state.slots.filter((s) => s.live).map((s) => s.id))
    for (const id of heights.current.keys()) if (!present.has(id)) heights.current.delete(id)
    const placed = placeFresh(state.slots, (id) => heights.current.get(id) ?? 0)
    if (placed !== state.slots) setState((st) => (st.slots === state.slots ? { ...st, slots: placed } : st))
  }, [state.slots, list])
  return slots
}

/** What each mounted bar asks the stack to clear (px from the window's bottom); the stack clears the most of them. */
const clearances = new Map<object, number>()
/** The clearance the bars want now (also the document's --toast-clearance), and who follows it. */
let wanted = 0
const followers = new Set<() => void>()

function applyClearance(): void {
  const root = document.documentElement
  wanted = clearances.size === 0 ? 0 : Math.round(Math.max(0, ...clearances.values()))
  if (clearances.size === 0) root.style.removeProperty('--toast-clearance')
  else root.style.setProperty('--toast-clearance', `${wanted}px`)
  for (const f of followers) f()
}

/**
 * The clearance the stack sits at: the bars' while no toast is shown, kept while toasts are (a bar that comes or goes
 * then never moves a toast on screen; the next toast after them clears it).
 */
function useHeldClearance(shown: boolean): number {
  const [held, setHeld] = useState(wanted)
  const showing = useRef(shown)
  showing.current = shown
  useEffect(() => {
    const follow = (): void => {
      if (!showing.current) setHeld(wanted)
    }
    followers.add(follow)
    follow()
    return () => {
      followers.delete(follow)
    }
  }, [])
  useEffect(() => {
    if (!shown) setHeld(wanted)
  }, [shown])
  return held
}

/** A bar's clearance: from its top edge to the window's bottom. */
function fromTop(el: HTMLElement): number {
  return window.innerHeight - el.getBoundingClientRect().top
}

/**
 * Keep the toast stack above a bar at the bottom of the window (e.g. the Run view's summary bar with Open diff) while
 * that bar is mounted: the stack's bottom edge follows the bar's top edge. `measure` says how much a bar needs when
 * that is not where it is now (a sticky row that can rest higher up but sticks just above the summary bar). With
 * several bars mounted, the stack clears the highest.
 */
export function useToastClearance(
  ref: RefObject<HTMLElement | null>,
  measure: (el: HTMLElement) => number = fromTop,
): void {
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const key = {}
    const set = (): void => {
      clearances.set(key, Math.max(0, measure(el)))
      applyClearance()
    }
    set()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null
    ro?.observe(el)
    window.addEventListener('resize', set)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', set)
      clearances.delete(key)
      applyClearance()
    }
  }, [ref, measure])
}

/**
 * One action of a toast: it runs once (a core command, or a callback), then the toast closes; a failed command becomes
 * an error toast with core's message. Disabled with its reason, which may follow the store while the toast shows
 * (ToastActionSpec.liveDisabledReason).
 */
function ToastActionButton({
  item,
  action,
  which,
  busy,
  setBusy,
}: {
  item: ToastItem
  action: ToastActionSpec
  which: 'primary' | 'secondary'
  busy: 'primary' | 'secondary' | null
  setBusy: (b: 'primary' | 'secondary' | null) => void
}): React.JSX.Element {
  const live = useStore((s) => action.liveDisabledReason?.(s))
  const disabledReason = action.disabledReason ?? live

  const run = async (): Promise<void> => {
    setBusy(which)
    try {
      if ('call' in action) {
        const r = await invokeCall(action.call)
        if (!r.ok) toast({ level: 'error', message: r.error.message })
      } else {
        await action.onClick()
      }
    } catch (err) {
      toast({ level: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
      dismissToast(item.id)
    }
  }

  if (disabledReason !== undefined) {
    return (
      <DisabledHint reason={disabledReason}>
        <Button size="sm" variant="outline" disabled data-toast-action={which}>
          {action.label}
        </Button>
      </DisabledHint>
    )
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-toast-action={which}
      loading={busy === which}
      disabled={busy !== null && busy !== which}
      onClick={() => void run()}
    >
      {action.label}
    </Button>
  )
}

/** A toast in its slot: the slot is as tall as the toast, or as the gap's room it took (resting at its bottom). */
function ToastRow({ item, hold }: { item: ToastItem; hold: number | undefined }): React.JSX.Element {
  const [busy, setBusy] = useState<'primary' | 'secondary' | null>(null)
  const Icon = ICON[item.level]
  const action = item.action
  const secondary = action !== undefined ? item.secondary : undefined
  const primaryButton = action !== undefined && (
    <ToastActionButton item={item} action={action} which="primary" busy={busy} setBusy={setBusy} />
  )

  return (
    <li
      role={item.level === 'error' ? 'alert' : 'status'}
      data-toast-id={item.id}
      data-level={item.level}
      style={hold !== undefined ? { minHeight: hold } : undefined}
      className="flex flex-col justify-end"
    >
      <div
        data-toast-card={item.id}
        className="pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
      >
        <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', ICON_TONE[item.level])} />
        {secondary === undefined ? (
          <>
            <p className="min-w-0 flex-1 break-words">{item.message}</p>
            {primaryButton}
          </>
        ) : (
          // Two actions do not fit beside the message in the stack's width: they go under it, in one row.
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="break-words">{item.message}</p>
            <div className="flex flex-wrap items-center gap-2">
              {primaryButton}
              <ToastActionButton
                item={item}
                action={secondary}
                which="secondary"
                busy={busy}
                setBusy={setBusy}
              />
            </div>
          </div>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="-mt-1 -mr-1 size-6"
          aria-label="Dismiss"
          onClick={() => dismissToast(item.id)}
        >
          <X />
        </Button>
      </div>
    </li>
  )
}

export function Toaster(): React.JSX.Element {
  const items = useToasts()
  const list = useRef<HTMLOListElement>(null)
  const slots = useToastSlots(items, list)
  const clearance = useHeldClearance(slots.some((s) => s.live))
  return (
    <section
      aria-label="Notifications"
      data-testid="toaster"
      // A page's single-key scope (the Diff tab's J/K/R/S) never reaches a toast's buttons (lib/keys.ts).
      data-key-scope-stop=""
      // The clearance it holds (useHeldClearance) overrides the document's for the stack.
      style={{ '--toast-clearance': `${clearance}px` } as React.CSSProperties}
      // The whole height of the window's right edge, whatever it holds: the box itself never grows or shrinks with
      // the toasts (a box whose top edge moved would be a layout shift too). Only the toasts take pointer events.
      className="pointer-events-none fixed top-4 right-4 bottom-[calc(var(--toast-clearance,0px)+1rem)] z-[60] w-80 max-w-[calc(100vw-2rem)]"
    >
      {/* Bottom-anchored, oldest at the bottom: a toast goes into a gap it fits or on top, where nothing has to move. */}
      <ol
        ref={list}
        className="flex h-full flex-col-reverse gap-2"
        onPointerEnter={pauseToasts}
        onPointerLeave={resumeToasts}
        onFocus={pauseToasts}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) resumeToasts()
        }}
      >
        {slots.map((s) =>
          s.live ? (
            <ToastRow key={s.id} item={s.item} hold={s.hold} />
          ) : (
            // The room toasts that went left behind: nothing in it can be seen, found or focused.
            <li key={s.id} aria-hidden inert data-toast-gap="" style={{ height: s.hold ?? 0 }} />
          ),
        )}
      </ol>
    </section>
  )
}
