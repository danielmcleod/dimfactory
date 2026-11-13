// AttentionPanel (state rows P7–P11; asks.spec.ts, no-allow-session.spec.ts, keyboard.spec.ts).
// The run's pending asks (snapshot.asks, FIFO per step): the first is answered in an AskCard. A new ask is announced
// once in an assertive live region ("Claude asks to run: <detail>. 9 minutes left."), as a new node even when its
// text equals the last one's, and takes focus only when nothing else has it, without scrolling the page (UI
// standard: nothing scrolls on its own; while the ask is out of view the Run view's jump pill offers it).
// An ask that moves up from the queue takes answers only after ASK_ARM_MS. An ask that leaves without an answer from
// this window (withdrawn by the vendor, answered from a notification or the CLI, timed out) disappears in place with
// a polite note saying so; a stale answer shows core's own text ("already answered or has expired").
import { Info, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AskView, RunSnapshot } from '@shared/run.ts'
import { ASK_ARM_MS, AskCard } from '../attention/AskCard.tsx'
import { canSwitchToAuto } from './AutoSwitch.tsx'
import { announcement, noteFor } from '../attention/askText.ts'
import type { AskNote } from '../attention/askText.ts'
import { coreRemainingMs } from '../../lib/coreClock.ts'
import { streamBuffer } from '../../lib/streamBuffer.ts'
import type { AskResolution } from '../../lib/streamBuffer.ts'
import { Button } from '../ui/Button.tsx'

export { DENY_GRACE_MS } from '../attention/AskCard.tsx'

/** How the ask was resolved, as core's `ask-resolved` body (in the step's stream) says. */
function resolutionOf(ask: AskView): AskResolution | undefined {
  // Publish what the bridge applied: a window in the background gets no animation frames to do it.
  streamBuffer.flush()
  const s = streamBuffer.snapshot(ask.runId, ask.step, ask.attempt)
  for (let i = s.blocks.length - 1; i >= 0; i--) {
    const b = s.blocks[i]
    if (b?.kind === 'ask' && b.requestId === ask.requestId) return b.resolved
  }
  return undefined
}

interface Stale {
  requestId: string
  message: string
}

/** What the assertive region says, and for which ask (the key that makes each announcement a new node). */
interface Announcement {
  requestId: string
  text: string
}

/**
 * The front ask when it moved up from the queue (it was already waiting behind the one that left), else null. Kept
 * from the previous render, so the card mounts with it: a key or click can arrive before any effect runs.
 */
function usePromoted(asks: readonly AskView[]): string | null {
  const [seen, setSeen] = useState<{ asks: readonly AskView[]; promoted: string | null }>({
    asks,
    promoted: null,
  })
  if (seen.asks === asks) return seen.promoted
  const before = seen.asks[0]?.requestId
  const front = asks[0]?.requestId
  let promoted = seen.promoted
  if (front !== before) {
    promoted = front !== undefined && seen.asks.some((a) => a.requestId === front) ? front : null
  }
  setSeen({ asks, promoted })
  return promoted
}

/** Asks that left the queue since the last snapshot, with a note when someone else answered them. */
function useDepartures(asks: readonly AskView[]): {
  notes: AskNote[]
  dismiss: (requestId: string) => void
} {
  const previous = useRef<readonly AskView[]>(asks)
  const [notes, setNotes] = useState<AskNote[]>([])
  useEffect(() => {
    const before = previous.current
    previous.current = asks
    const still = new Set(asks.map((a) => a.requestId))
    const fresh: AskNote[] = []
    for (const a of before) {
      if (still.has(a.requestId)) continue
      const note = noteFor(a, resolutionOf(a))
      if (note !== null) fresh.push(note)
    }
    if (fresh.length > 0) setNotes((n) => [...n.filter((x) => !still.has(x.requestId)), ...fresh].slice(-3))
  }, [asks])
  return { notes, dismiss: (id) => setNotes((n) => n.filter((x) => x.requestId !== id)) }
}

export function AttentionPanel({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const asks = snap.asks
  const first = asks[0]
  const [announce, setAnnounce] = useState<Announcement | null>(null)
  const [stale, setStale] = useState<Stale | null>(null)
  const announced = useRef(new Set<string>())
  const shown = useRef<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const { notes, dismiss } = useDepartures(asks)

  useEffect(() => {
    const fresh = asks.filter((a) => !announced.current.has(a.requestId))
    for (const a of asks) announced.current.add(a.requestId)
    const a = fresh[0]
    if (a !== undefined)
      setAnnounce({
        requestId: a.requestId,
        text: announcement(a, coreRemainingMs(a.expiresAt), fresh.length - 1),
      })
    // Accessibility: once the announced ask has left (answered, withdrawn, timed out), the region empties, so a screen
    // reader reading the page later never meets a question that is no longer asked. Emptying is not announced.
    else setAnnounce((cur) => (cur !== null && !asks.some((x) => x.requestId === cur.requestId) ? null : cur))
  }, [asks])
  const promoted = usePromoted(asks)

  // A new ask in front (a new arrival, or the next in the queue) takes focus unless the user is somewhere else, and
  // clears the stale message of an earlier one. Focus never scrolls: the jump pill does that, on click.
  const front = first?.requestId ?? null
  useEffect(() => {
    if (front === null || front === shown.current) return
    shown.current = front
    setStale((s) => (s !== null && s.requestId !== front ? null : s))
    const active = document.activeElement
    if (active === null || active === document.body) {
      wrap.current?.querySelector<HTMLElement>('[data-key-scope="ask"]')?.focus({ preventScroll: true })
    }
  }, [front])

  const otherSteps = first === undefined ? 0 : asks.filter((a) => a.step !== first.step).length
  return (
    // Never a scroll anchor: what arrives here (an ask, a note) changes its height, so the browser keeps the user's
    // reading position on the content after it instead.
    <div ref={wrap} className="flex flex-col [overflow-anchor:none]" data-testid="attention">
      <div className="sr-only" aria-live="assertive" aria-atomic="true" data-testid="ask-announcer">
        {/* Keyed by ask: a second identical ask still replaces the node, so screen readers say it again. */}
        {announce !== null && (
          <p key={announce.requestId} data-request-id={announce.requestId}>
            {announce.text}
          </p>
        )}
      </div>
      {/* Always rendered (never display:none), so screen readers hear what is added to it. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-1.5 [&:not(:empty)]:mb-2">
        {stale !== null && (
          <p
            data-testid="ask-stale"
            className="rounded-md border border-st-paused/40 bg-st-paused/5 px-3 py-2 text-sm"
          >
            {stale.message}
          </p>
        )}
        {notes.map((n) => (
          <div
            key={n.requestId}
            className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm"
          >
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p data-testid="ask-withdrawn-note" className="font-medium">
                {n.title}
              </p>
              <p className="stream-text truncate text-muted-foreground" title={n.detail}>
                {n.detail}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Dismiss this note"
              onClick={() => dismiss(n.requestId)}
            >
              <X aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      {first !== undefined && (
        <AskCard
          key={first.requestId}
          ask={first}
          more={otherSteps}
          onStale={(requestId, message) => setStale({ requestId, message })}
          armDelayMs={promoted === first.requestId ? ASK_ARM_MS : 0}
          offerAuto={canSwitchToAuto(snap.summary) && (first.step === 'implement' || first.step === 'fix')}
        />
      )}
    </div>
  )
}
