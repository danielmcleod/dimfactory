// Jump pills (UI standard: nothing scrolls automatically except as the direct
// result of a user action). A new ask or blocking card never scrolls the page to itself: it is announced, takes focus
// without scrolling when nothing else has it, and while it is out of view a pill under the Run view's sticky header
// says so ("Claude needs approval", "Plan ready for review"). Only a click on the pill scrolls, to the target, and
// focuses it. A card in the Flow tab, seen from another tab, opens Flow first. The pills overlay the content under
// the header, so showing one moves nothing.
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CardView, RunSnapshot } from '@shared/run.ts'
import { RUN_PHASE_LABEL, vendorName } from '../../lib/format.ts'
import { useMainScroller } from '../shell/mainScroll.ts'
import { Button } from '../ui/Button.tsx'
import { jumpTo } from './follow.tsx'

export type JumpKind = 'ask' | 'plan' | 'findings' | 'context' | 'card'

export interface JumpTarget {
  /** Stable per target: `ask:<requestId>`, `card:<cardId>`. */
  id: string
  kind: JumpKind
  label: string
  /** The element to jump to, inside the Run view. */
  selector: string
  /** Rendered only in the Flow tab (cards); from another tab a click opens Flow first. */
  flow: boolean
}

/** Heights (px) of the Run view's sticky header (top) and SummaryBar (bottom): what they cover of the page scroller. */
export interface StickyInsets {
  top: number
  bottom: number
}

/** A jump leaves this much room between the sticky header and the target. */
const JUMP_GAP = 8

/** A jump waiting for Flow to show its card gives up after this long (the card closed meanwhile). */
const PENDING_MS = 2000

/** How much of a target must be in the reading area to count as seen. */
const SEEN_PX = 40

function attr(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/** What a pill (and the card announcement) calls a card that needs the user. */
export function cardTarget(c: CardView): JumpTarget {
  const base = { id: `card:${c.id}`, selector: `section[data-card-id="${attr(c.id)}"]`, flow: true }
  if (c.kind === 'gate:afterPlan') return { ...base, kind: 'plan', label: RUN_PHASE_LABEL['plan-review'] }
  if (c.kind === 'gate:beforeFix')
    return { ...base, kind: 'findings', label: RUN_PHASE_LABEL['findings-review'] }
  if (c.kind === 'insufficientContext') return { ...base, kind: 'context', label: 'Plan needs more context' }
  return { ...base, kind: 'card', label: c.title }
}

/** What needs the user now: the front ask, then each blocking card, in core's order. */
export function jumpTargets(snap: RunSnapshot): JumpTarget[] {
  const out: JumpTarget[] = []
  const ask = snap.asks[0]
  if (ask !== undefined) {
    out.push({
      id: `ask:${ask.requestId}`,
      kind: 'ask',
      label: `${vendorName(ask.vendor)} needs approval`,
      selector: `[data-testid="ask-panel"][data-request-id="${attr(ask.requestId)}"]`,
      flow: false,
    })
  }
  for (const c of snap.cards) if (c.blocking) out.push(cardTarget(c))
  return out
}

/** Where a target is: in the reading area, above or below it, or not on this tab. */
type Where = 'in' | 'above' | 'below' | 'away'

export interface JumpPillsProps {
  snap: RunSnapshot
  /** The Run view's tab: cards are only in Flow. */
  tab: string
  /** Opens the Flow tab (a pill for a card clicked on another tab). */
  onOpenFlow: () => void
  insets: StickyInsets
  /** The Run view, where targets are looked up. */
  root: React.RefObject<HTMLElement | null>
}

/**
 * Which targets are on the page now, as one string ('1' present, '0' not, in list order), followed as the Run view's
 * DOM changes: a tab's content mounts a render after the tab changes (Radix Presence), without this component
 * rendering again, so the targets' observer and a pending jump wait for this instead.
 */
function usePresence(root: React.RefObject<HTMLElement | null>, list: readonly JumpTarget[]): string {
  const [present, setPresent] = useState('')
  useEffect(() => {
    const scope = root.current
    if (scope === null || list.length === 0) return
    const check = (): void =>
      setPresent(list.map((t) => (scope.querySelector(t.selector) !== null ? '1' : '0')).join(''))
    check()
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(check)
    mo.observe(scope, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [root, list])
  return present
}

export function JumpPills({ snap, tab, onOpenFlow, insets, root }: JumpPillsProps): React.JSX.Element {
  const main = useMainScroller()
  // The target list changes identity only when what it says changes, so the observer is not rebuilt per snapshot.
  const fresh = jumpTargets(snap)
  const key = fresh.map((t) => `${t.id}=${t.label}`).join('|')
  const [targets, setTargets] = useState({ key, list: fresh })
  if (targets.key !== key) setTargets({ key, list: fresh })
  const list = targets.list
  const present = usePresence(root, list)

  const [where, setWhere] = useState<Readonly<Record<string, Where>>>({})
  useEffect(() => {
    const scope = root.current
    if (scope === null) return
    const found = new Map<Element, string>()
    const away: Record<string, Where> = {}
    for (const t of list) {
      const el = scope.querySelector(t.selector)
      if (el !== null) found.set(el, t.id)
      else away[t.id] = 'away'
    }
    // Before the observer reports, a target on the page is not called out (no flash for one in view).
    setWhere(away)
    if (found.size === 0 || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        setWhere((prev) => {
          const next = { ...prev }
          for (const e of entries) {
            const id = found.get(e.target)
            if (id === undefined) continue
            const top = e.rootBounds?.top ?? insets.top
            next[id] = e.isIntersecting ? 'in' : e.boundingClientRect.bottom <= top ? 'above' : 'below'
          }
          return next
        })
      },
      // The reading area: the page scroller's view less the sticky header and SummaryBar, and a target must show
      // SEEN_PX of itself above the bottom edge to count as seen. (One observer for every target, with both insets:
      // mainScroll.ts's useViewPosition follows one element under a top bar only.)
      { root: main, rootMargin: `-${insets.top}px 0px -${insets.bottom + SEEN_PX}px 0px`, threshold: 0 },
    )
    for (const el of found.keys()) io.observe(el)
    return () => io.disconnect()
  }, [list, tab, insets.top, insets.bottom, root, main, present])

  // A pill for a card clicked on another tab: Flow opens, then the jump happens once the card is on the page. The tab
  // content mounts a render after the tab changes (Radix Presence), so this checks after every commit (the targets'
  // presence changing is one) until it lands.
  const pending = useRef<{ selector: string; since: number } | null>(null)
  useEffect(() => {
    const p = pending.current
    if (p === null || tab !== 'flow') return
    const el = root.current?.querySelector<HTMLElement>(p.selector)
    if (el !== null && el !== undefined) {
      pending.current = null
      jumpTo(main, el, insets.top + JUMP_GAP)
    } else if (performance.now() - p.since > PENDING_MS) {
      pending.current = null
    }
  })

  const go = (t: JumpTarget): void => {
    const el = root.current?.querySelector<HTMLElement>(t.selector)
    if (el !== null && el !== undefined) {
      jumpTo(main, el, insets.top + JUMP_GAP)
      return
    }
    if (t.flow && tab !== 'flow') {
      pending.current = { selector: t.selector, since: performance.now() }
      onOpenFlow()
    }
  }

  const shown = list.filter((t) => {
    const w = where[t.id]
    return w === 'above' || w === 'below' || w === 'away'
  })
  return (
    <div
      data-testid="jump-pills"
      // No box while no pill shows: an empty overlay box hanging below the sticky block can keep a stale tile on screen.
      className="pointer-events-none absolute inset-x-0 top-full z-30 flex flex-wrap justify-center gap-2 px-4 pt-2 [overflow-anchor:none] empty:hidden"
    >
      {shown.map((t) => {
        const Icon = where[t.id] === 'above' ? ArrowUp : ArrowDown
        return (
          <Button
            key={t.id}
            size="sm"
            variant="default"
            data-testid={`jump-${t.kind}`}
            data-target={t.id}
            data-where={where[t.id]}
            icon={<Icon aria-hidden />}
            onClick={() => go(t)}
            className="pointer-events-auto h-7 max-w-80 rounded-full px-3 shadow-md"
          >
            <span className="min-w-0 truncate">{t.label}</span>
          </Button>
        )
      })}
    </div>
  )
}
