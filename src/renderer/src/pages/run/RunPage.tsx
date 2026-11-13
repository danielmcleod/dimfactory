// Run view: RunHeader → tabs Flow · Diff(n) · Log · Config → sticky PhaseTimeline →
// the tab → sticky SummaryBar. While mounted the run's stream is focused (main forwards its stream events and the
// bridge replays its log), and its snapshot is loaded and kept current by the bridge. ⌘/Ctrl+. stops the run,
// ⌘/Ctrl+⇧D opens the Diff tab. Step transitions are announced in a polite live region, a card that needs the user
// in an assertive one.
// UI standards (one scroll region per screen, nothing moves on its own): the view scrolls in the
// shell's one page scroller, <main>. The header, tabs and timeline are one sticky block at its top and the SummaryBar
// is sticky at its bottom (sticky is not a scroll region); the page scroller's scroll-padding is set to them (and to a
// card's sticky action row while one is mounted), so a jump, a focused control or the text cursor is never hidden
// under them; the bars are marked data-sticky-bar, so focus moving through their own controls drops that padding and
// scrolls nothing. The inner scroll regions are capped at the reading area between them (--run-region-max), so the wheel
// always finds page to scroll beside a stream or the log. Nothing here scrolls the page on its own: a new ask or card
// takes focus without scrolling and a jump pill under the header scrolls to it on click (JumpPills). A step the view
// has shown stays shown (a step that turns out unused reads "Skipped" in place), so cards do not vanish mid-run.
// What arrives mid-run lands at the end of the content, so nothing above it moves: a step's card once it begins
// (FlowTab), and the AttentionPanel's asks and notes, which follow the tab's content.
// The sticky block has two forms (headerForm.ts): the full one (three header lines, the tabs, the step timeline), and
// a compact one (one header row, the tabs, a one-line step strip) where the full one would leave the reading area
// under 55% of the page's height: a small window, or the page zoomed in. An unseen copy of the full timeline at the
// page's width (TimelineRuler) tells it what the full block would take while the compact one shows.
import { FileQuestion } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PassStatus, RunSnapshot, StepKey } from '@shared/run.ts'
import { STEP_KEYS } from '@shared/run.ts'
import { AttentionPanel } from '../../components/run/AttentionPanel.tsx'
import { REGION_MIN_PX, REGION_SLACK_PX } from '../../components/run/follow.tsx'
import { JumpPills, cardTarget } from '../../components/run/JumpPills.tsx'
import type { StickyInsets } from '../../components/run/JumpPills.tsx'
import { useHeaderForm } from '../../components/run/headerForm.ts'
import { PhaseStrip, PhaseTimeline, TimelineRuler } from '../../components/run/PhaseTimeline.tsx'
import { useRevertUndoToast } from '../../components/run/revert.ts'
import { RunHeader, isTerminalRun } from '../../components/run/RunHeader.tsx'
import { isFinishedStatus, isShownStep } from '../../components/run/steps.ts'
import { stopRun } from '../../components/run/stop.ts'
import { SummaryBar } from '../../components/run/SummaryBar.tsx'
import { useMainScrollPadding, useMainScroller } from '../../components/shell/mainScroll.ts'
import { Button } from '../../components/ui/Button.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { StableLabel } from '../../components/ui/StableLabel.tsx'
import { useToastClearance } from '../../components/ui/Toaster.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs.tsx'
import { useFocusRun } from '../../ipc/bridge.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, runStepLabel } from '../../lib/format.ts'
import { KEYS, useShortcut } from '../../lib/keys.ts'
import { RUN_TABS, href, navigate } from '../../lib/router.ts'
import type { RunTab } from '../../lib/router.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { useRun } from '../../state/selectors.ts'
import { ConfigTab } from './ConfigTab.tsx'
import { DiffTab } from './DiffTab.tsx'
import { FlowTab } from './FlowTab.tsx'
import { LogTab } from './LogTab.tsx'

/**
 * The Diff tab's live file count, a pill inside the tab (its padding the other tabs' padding), reserves three digits:
 * new files never widen the tab and move Log and Config.
 */
const DIFF_COUNT_RESERVE = ['000'] as const

const TAB_LABEL: Readonly<Record<RunTab, string>> = {
  flow: 'Flow',
  diff: 'Diff',
  log: 'Log',
  config: 'Config',
}

/** "Implement: Running" for each step whose status changed since the last snapshot (first snapshot: nothing). */
function useStepAnnouncements(snap: RunSnapshot): string {
  const prev = useRef<Partial<Record<StepKey, PassStatus>> | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    const before = prev.current
    const now: Partial<Record<StepKey, PassStatus>> = {}
    for (const k of STEP_KEYS) now[k] = snap.steps[k].status
    prev.current = now
    if (before === null) return
    const changed = STEP_KEYS.filter((k) => before[k] !== now[k] && isShownStep(snap.steps[k]))
    if (changed.length > 0) {
      setText(
        changed
          .map((k) => `${runStepLabel(k, snap.steps)}: ${PASS_STATUS_LABEL[snap.steps[k].status]}`)
          .join('. '),
      )
    }
  }, [snap])
  return text
}

/** What the assertive region says about a card that needs the user, keyed by card (a new node per card). */
interface CardAnnouncement {
  cardId: string
  text: string
}

/** "Plan ready for review." once for each blocking card the view sees open, including one open when it mounts. */
function useCardAnnouncement(snap: RunSnapshot): CardAnnouncement | null {
  const seen = useRef(new Set<string>())
  const [said, setSaid] = useState<CardAnnouncement | null>(null)
  const cards = snap.cards
  useEffect(() => {
    const fresh = cards.filter((c) => c.blocking && !seen.current.has(c.id))
    for (const c of cards) seen.current.add(c.id)
    const last = fresh.at(-1)
    if (last !== undefined) {
      setSaid({ cardId: last.id, text: fresh.map((c) => `${cardTarget(c).label}.`).join(' ') })
    } else {
      // Accessibility: once the announced card is answered, the region empties (a later read of the page never meets
      // "Plan ready for review." after the plan was approved). Emptying is not announced.
      setSaid((cur) => (cur !== null && !cards.some((c) => c.id === cur.cardId) ? null : cur))
    }
  }, [cards])
  return said
}

/**
 * The steps already over when the view opened: only their cards start collapsed. A step that
 * begins and ends between two renders while the view is open (a fast reviewer) still opens expanded, as if the user
 * had watched it run.
 */
function useFinishedAtOpen(snap: RunSnapshot): ReadonlySet<StepKey> {
  const [over] = useState<ReadonlySet<StepKey>>(
    () => new Set(STEP_KEYS.filter((k) => isFinishedStatus(snap.steps[k].status))),
  )
  return over
}

/** Every step shown so far: a step stays in the flow and the timeline once shown (see steps.ts shownSteps). */
function useKeptSteps(snap: RunSnapshot): ReadonlySet<StepKey> {
  const now = STEP_KEYS.filter((k) => isShownStep(snap.steps[k]))
  const [kept, setKept] = useState<ReadonlySet<StepKey>>(() => new Set(now))
  if (now.some((k) => !kept.has(k))) setKept(new Set([...kept, ...now]))
  return kept
}

/**
 * The heights of the sticky header and SummaryBar, measured as they resize, and the reading area between them: the
 * jump pills' reading area. The view gets them as --run-sticky-top / --run-sticky-bottom (a card's sticky action row
 * rests on the SummaryBar) and --run-region-max, the most an inner scroll region (a stream, the log, a long command)
 * may take: the reading area less REGION_SLACK_PX, so a region never fills it and the wheel always finds page to
 * scroll beside it, and its bottom edge ("Jump to latest") is never under the SummaryBar. The page scroller keeps the
 * bars as its scroll padding while the view is mounted (mainScroll.ts useMainScrollPadding), so a timeline node's
 * scrollIntoView and keyboard focus land in the reading area between them. Measured before paint, so a region never
 * takes one height and then another.
 */
function useStickyInsets(
  root: React.RefObject<HTMLElement | null>,
  top: React.RefObject<HTMLElement | null>,
  bottom: React.RefObject<HTMLElement | null>,
): StickyInsets {
  const main = useMainScroller()
  const [insets, setInsets] = useState<StickyInsets>({ top: 0, bottom: 0 })
  useLayoutEffect(() => {
    const r = root.current
    const t = top.current
    const b = bottom.current
    if (r === null || t === null || b === null) return
    const measure = (): void => {
      const next = {
        top: Math.round(t.getBoundingClientRect().height),
        bottom: Math.round(b.getBoundingClientRect().height),
      }
      const view = main?.clientHeight ?? window.innerHeight
      const region = Math.max(REGION_MIN_PX, view - next.top - next.bottom - REGION_SLACK_PX)
      r.style.setProperty('--run-sticky-top', `${next.top}px`)
      r.style.setProperty('--run-sticky-bottom', `${next.bottom}px`)
      r.style.setProperty('--run-region-max', `${region}px`)
      setInsets((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next))
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(t)
    ro?.observe(b)
    if (main !== null) ro?.observe(main)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [root, top, bottom, main])
  useMainScrollPadding(insets)
  return insets
}

function RunView({ snap, tab }: { snap: RunSnapshot; tab: RunTab }): React.JSX.Element {
  const runId = snap.summary.runId
  const terminal = isTerminalRun(snap)
  const [stopping, setStopping] = useState(false)
  const announcement = useStepAnnouncements(snap)
  const cardSaid = useCardAnnouncement(snap)
  const kept = useKeptSteps(snap)
  const finishedAtOpen = useFinishedAtOpen(snap)
  const rootRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLDivElement>(null)
  const insets = useStickyInsets(rootRef, topRef, bottomRef)
  const form = useHeaderForm(topRef, bottomRef, rulerRef)
  const compact = form === 'compact'
  // A revert core made on a card choice offers its Undo (RunSnapshot.revertUndo).
  useRevertUndoToast(snap)
  // Toasts stack above the SummaryBar (and its Open diff) while the view is mounted.
  useToastClearance(bottomRef)

  const onStop = (): void => {
    if (stopping || terminal) return
    setStopping(true)
    void stopRun(runId).finally(() => setStopping(false))
  }
  const openDiff = (): void => navigate({ name: 'run', runId, tab: 'diff' })
  useShortcut(KEYS.stop, onStop, { description: 'Stop the run', enabled: !terminal })
  useShortcut(KEYS.openDiff, openDiff, { description: 'Open the diff' })

  return (
    <Tabs
      ref={rootRef}
      value={tab}
      onValueChange={(v) => {
        if ((RUN_TABS as readonly string[]).includes(v)) navigate({ name: 'run', runId, tab: v as RunTab })
      }}
      // In the page scroller's flow: at least the window's height, so the SummaryBar sits at the bottom of a short
      // run. Positioned, so nothing absolutely positioned inside (sr-only text, overlays) escapes the scroller.
      className="relative flex min-h-full flex-col gap-0"
      data-testid="run-view"
      data-run-id={runId}
    >
      <div
        ref={topRef}
        data-testid="run-sticky-top"
        data-form={form}
        data-sticky-bar="top"
        className="sticky top-0 z-20 bg-background [overflow-anchor:none]"
      >
        <RunHeader snap={snap} onStop={onStop} stopping={stopping} compact={compact} />
        <TabsList aria-label="Run views" className="w-full justify-start px-4">
          {RUN_TABS.map((t) => (
            <TabsTrigger key={t} value={t} data-testid={`run-tab-${t}`}>
              {TAB_LABEL[t]}
              {t === 'diff' && (
                <span
                  data-testid="diff-count"
                  className="inline-flex h-5 items-center rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
                >
                  <span className="sr-only">(</span>
                  <StableLabel labels={DIFF_COUNT_RESERVE}>{snap.summary.progress.filesChanged}</StableLabel>
                  <span className="sr-only">)</span>
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className={cn('relative border-b px-4', compact ? 'py-1' : 'py-2')}>
          {compact ? <PhaseStrip snap={snap} keep={kept} /> : <PhaseTimeline snap={snap} keep={kept} />}
          {/* The full timeline at the timeline's width, unseen and taking no room (a clipped box of no height). */}
          <div className="pointer-events-none absolute inset-x-4 top-0 h-0 overflow-clip">
            <TimelineRuler ref={rulerRef} snap={snap} keep={kept} />
          </div>
        </div>
        <JumpPills
          snap={snap}
          tab={tab}
          onOpenFlow={() => navigate({ name: 'run', runId, tab: 'flow' })}
          insets={insets}
          root={rootRef}
        />
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 py-3" data-testid="run-content">
        <TabsContent value="flow">
          <FlowTab snap={snap} keep={kept} finishedAtOpen={finishedAtOpen} />
        </TabsContent>
        <TabsContent value="diff">
          <DiffTab snap={snap} />
        </TabsContent>
        <TabsContent value="log">
          <LogTab runId={runId} />
        </TabsContent>
        <TabsContent value="config">
          <ConfigTab snap={snap} />
        </TabsContent>
        {/* After the tab's content: an ask arriving here never pushes what the user is reading (its jump pill offers
            it while it is out of view). */}
        <AttentionPanel snap={snap} />
      </div>
      <div ref={bottomRef} data-sticky-bar="bottom" className="sticky bottom-0 z-20 [overflow-anchor:none]">
        <SummaryBar snap={snap} onOpenDiff={openDiff} />
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="step-announcer">
        {announcement}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true" data-testid="card-announcer">
        {/* Keyed by card: a second card with the same words still replaces the node, so it is said again. */}
        {cardSaid !== null && (
          <p key={cardSaid.cardId} data-announced={cardSaid.cardId}>
            {cardSaid.text}
          </p>
        )}
      </div>
    </Tabs>
  )
}

export function RunPage({ runId, tab }: { runId: string; tab: RunTab }): React.JSX.Element {
  useFocusRun(runId)
  const entry = useRun(runId)
  const snap = entry?.snapshot ?? null

  if (snap === null) {
    if (entry?.status === 'error') {
      return (
        <div data-testid="run-not-found">
          <EmptyState
            icon={FileQuestion}
            title="This run could not be opened"
            description={entry.error ?? `Run ${runId} was not found.`}
            action={
              <div className="flex gap-2">
                <Button asChild variant="outline">
                  <a href={href({ name: 'runs' })}>Go to Runs</a>
                </Button>
                <Button variant="ghost" onClick={() => void fetchSnapshot(runId)}>
                  Try again
                </Button>
              </div>
            }
          />
        </div>
      )
    }
    return (
      <p className="p-6 text-sm text-muted-foreground" data-testid="run-loading" aria-live="polite">
        Loading the run…
      </p>
    )
  }
  // Keyed by run: what the view has shown and announced belongs to one run.
  return <RunView key={snap.summary.runId} snap={snap} tab={tab} />
}
