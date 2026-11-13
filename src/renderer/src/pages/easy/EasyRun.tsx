// Easy mode's view of a run. While it works: the project's short title, five milestone rows (always all five, each a
// fixed height, "Not needed" in place), one line of time and money with a fixed-width bar against the user's limit
// (when there is one), one line counting what the project permission approved (kept empty without one), Stop
// (confirmed in a dialog) and Show details (the Full Run view of the same run), a folded "What it is doing now" line,
// then what needs the user: the plain questions, plan, research and ask cards (and, for a run in a copy of the folder,
// "Your changes are ready": keep them or throw them away, with the line of what became of them). Once it has ended:
// the Done screen. A run that is one of two versions ("Make two and pick") points to the page that shows both, where
// one is kept: its own "keep or throw away" card is not shown here.
// UI standards: one scroll region (the page); nothing moves on its own (the rows, the time line and the bar keep their
// sizes; what needs the user arrives last on the page, so nothing above it moves); buttons keep their labels.
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CirclePause,
  Hand,
  Loader2,
  Square,
  ArrowDown,
  Columns2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import type { RunLimitsView } from '@shared/easy.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { STEP_KEYS } from '@shared/run.ts'
import { JUMP_MARGIN, jumpTo } from '../../components/run/follow.tsx'
import { useMainScroller } from '../../components/shell/mainScroll.ts'
import { stopRun } from '../../components/run/stop.ts'
import { Button } from '../../components/ui/Button.tsx'
import { StableLabel } from '../../components/ui/StableLabel.tsx'
import { useFocusRun } from '../../ipc/bridge.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useCoreNow } from '../../lib/coreClock.ts'
import { etaRemainingMs } from '../../lib/format.ts'
import { href } from '../../lib/router.ts'
import { useStream } from '../../lib/streamBuffer.ts'
import { useEasyPermission } from '../../state/easyPermission.ts'
import { useRun } from '../../state/selectors.ts'
import { PlainAskCard, PlainCard, PlainPlan, PlainQuestions, PlainResearch } from './EasyCards.tsx'
import { ChangesLine, PlainFinalize } from './EasyChanges.tsx'
import { EasyDone } from './EasyDone.tsx'
import { costFraction, milestoneViews, projectTitle } from './model.ts'
import { useEasyProject } from './useProject.ts'
import type { MilestoneView } from './model.ts'
import {
  COST_BAR_LABEL,
  MILESTONE_STATE,
  MILESTONE_TITLE,
  NOW_DOING,
  NEEDS_ANNOUNCE,
  NEEDS_JUMP,
  WAITING_FOR_YOU_TIME,
  NOW_NOTHING,
  PROGRESS_LABEL,
  RUN_LOADING,
  RUN_NOT_OPENED,
  RUN_TITLE_WORKING,
  SHOW_DETAILS,
  STOP_CONFIRM,
  STOP_LABEL,
  STOP_LABELS,
  STOP_NO,
  STOP_YES,
  TWO_POINTER_GO,
  TWO_POINTER_TEXT,
  TWO_POINTER_TITLE,
  permissionUsesText,
  spentText,
  timeSoFarText,
} from './text.ts'
import type { MilestoneState } from './text.ts'

const STATE_LABELS: readonly string[] = Object.values(MILESTONE_STATE)

const STATE_ICON: Readonly<Record<MilestoneState, LucideIcon>> = {
  waiting: Circle,
  working: Loader2,
  needsYou: Hand,
  done: CircleCheck,
  notNeeded: CircleMinus,
  stopped: CirclePause,
  failed: CircleAlert,
}

const STATE_TONE: Readonly<Record<MilestoneState, string>> = {
  waiting: 'text-muted-foreground',
  working: 'text-st-running',
  needsYou: 'text-st-waiting',
  done: 'text-st-done',
  notNeeded: 'text-muted-foreground',
  stopped: 'text-st-cancelled',
  failed: 'text-st-failed',
}

const ENDED = new Set(['completed', 'failed', 'cancelled'])

export function isEnded(snap: RunSnapshot): boolean {
  return ENDED.has(snap.summary.status) && snap.summary.phase !== 'stopping'
}

/** The run is one of two versions of an idea (a match's side built now, not a replay of an old run). */
export function isOfTwo(snap: RunSnapshot): boolean {
  const m = snap.summary.matchOf
  return m !== undefined && m.rematch !== true
}

function MilestoneRow({ m }: { m: MilestoneView }): React.JSX.Element {
  const Icon = STATE_ICON[m.state]
  return (
    <li
      data-testid={`easy-milestone-${m.id}`}
      data-state={m.state}
      className="flex h-16 items-center gap-3 rounded-md border px-3"
    >
      <Icon
        aria-hidden
        className={cn(
          'size-5 shrink-0',
          STATE_TONE[m.state],
          m.state === 'working' && 'animate-spin motion-reduce:animate-none',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{MILESTONE_TITLE[m.id]}</span>
        <span
          className="truncate text-xs text-muted-foreground"
          title={m.line}
          data-testid="easy-milestone-line"
        >
          {m.line}
        </span>
      </div>
      <span className={cn('shrink-0 text-xs font-medium', STATE_TONE[m.state])}>
        <StableLabel labels={STATE_LABELS} align="end">
          {MILESTONE_STATE[m.state]}
        </StableLabel>
      </span>
    </li>
  )
}

/** The run's own limits, asked once (they do not change while it runs). */
export function useRunLimits(runId: string, enabled = true): RunLimitsView | null | 'loading' {
  const [v, setV] = useState<RunLimitsView | null | 'loading'>('loading')
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void invoke('runs.limits', { runId }).then((r) => {
      if (alive) setV(r.ok ? r.value : null)
    })
    return () => {
      alive = false
    }
  }, [runId, enabled])
  return v
}

function NowDoing({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const step = STEP_KEYS.find((k) => snap.steps[k].status === 'running') ?? 'plan'
  const stream = useStream(snap.summary.runId, step)
  const running = snap.steps[step].status === 'running'
  const last = running ? [...stream.blocks].reverse().find((b) => b.kind === 'tool') : undefined
  const text = last !== undefined && last.kind === 'tool' ? last.summary || last.name : NOW_NOTHING
  return (
    <details className="group rounded-md border px-3 py-2" data-testid="easy-now">
      <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {NOW_DOING}
      </summary>
      <p className="mt-1 truncate text-sm text-muted-foreground" title={text}>
        {text}
      </p>
    </details>
  )
}

function TimeAndMoney({
  snap,
  limit,
  waiting,
}: {
  snap: RunSnapshot
  limit: number | null
  /** Something waits for the user: the time line says so instead of counting down. */
  waiting: boolean
}): React.JSX.Element {
  const now = useCoreNow()
  const s = snap.summary
  const frac = costFraction(s.progress.costUsd, limit)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="easy-time-money">
      <span className="tabular-nums" data-testid="easy-time">
        {waiting ? WAITING_FOR_YOU_TIME : timeSoFarText(now - s.createdAt, etaRemainingMs(s.progress, now))}
      </span>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <span className="tabular-nums" data-testid="easy-spent">
        {spentText(s.progress.costUsd, limit)}
      </span>
      {/* Always there and one size; it fills only against a limit. */}
      <span
        role={limit !== null ? 'meter' : undefined}
        aria-label={limit !== null ? COST_BAR_LABEL : undefined}
        aria-hidden={limit === null || undefined}
        aria-valuemin={limit !== null ? 0 : undefined}
        aria-valuemax={limit !== null ? 100 : undefined}
        aria-valuenow={limit !== null ? Math.round(frac * 100) : undefined}
        data-testid="easy-cost-bar"
        className={cn(
          'relative h-2 w-40 shrink-0 overflow-hidden rounded-full bg-muted',
          limit === null && 'invisible',
        )}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${frac * 100}%` }}
        />
      </span>
    </div>
  )
}

/** Stop, confirmed in a dialog: one run, or every run named (both versions of a pair). */
export function StopButton({
  runIds,
  label = STOP_LABEL,
  confirm = STOP_CONFIRM,
  disabled = false,
}: {
  runIds: readonly string[]
  label?: string
  confirm?: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="outline" icon={<Square aria-hidden />} disabled={disabled} data-testid="easy-stop">
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="easy-stop-dialog"
          className="fixed top-[30vh] left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-4 rounded-lg border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
        >
          <Dialog.Title className="text-base font-semibold">{confirm}</Dialog.Title>
          <Dialog.Description className="sr-only">{confirm}</Dialog.Description>
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline" labels={STOP_LABELS} data-testid="easy-stop-no">
                {STOP_NO}
              </Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              labels={STOP_LABELS}
              loading={busy}
              data-testid="easy-stop-yes"
              onClick={() => {
                setBusy(true)
                void Promise.all(runIds.map((id) => stopRun(id))).finally(() => {
                  setBusy(false)
                  setOpen(false)
                })
              }}
            >
              {STOP_YES}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** A version's run page: both versions are on one page, and that is where one is kept. */
export function TwoPointer({ matchId }: { matchId: string }): React.JSX.Element {
  return (
    <section
      aria-label={TWO_POINTER_TITLE}
      className="flex flex-col gap-2 rounded-md border px-4 py-3"
      data-testid="easy-two-pointer"
    >
      <h2 className="text-base font-semibold">{TWO_POINTER_TITLE}</h2>
      <p className="text-sm">{TWO_POINTER_TEXT}</p>
      <div>
        <Button asChild icon={<Columns2 aria-hidden />} data-testid="easy-two-pointer-go">
          <a href={href({ name: 'easyTwo', matchId })}>{TWO_POINTER_GO}</a>
        </Button>
      </div>
    </section>
  )
}

/** The page scroller's reading area holds at least this much of an element (px) for it to count as seen. */
const SEEN_PX = 40

function inView(main: HTMLElement | null, el: HTMLElement): boolean {
  const view = main?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
  const r = el.getBoundingClientRect()
  return r.bottom > view.top + SEEN_PX && r.top < view.bottom - SEEN_PX
}

/**
 * What needs the user: the plain cards and asks. A newly waiting one is brought into view once, when it arrives (the
 * page scrolls to it and it takes focus; nothing else moves, and nothing scrolls again for it), unless it is already
 * in view or the user is typing. While one is out of view after that, a pill over the page (it moves no layout) says
 * so, and a click on it brings the card back.
 *
 * Several runs (the two versions of a pair) share one list, each run's items under its label. A version's "keep or
 * throw away" card is never shown: one of the two is kept on the page that shows both (`pair: 'page'` leaves the card
 * out, `pair: 'pointer'` says where to go instead).
 */
export function NeedsYou({
  snaps,
  labels,
  pair,
}: {
  snaps: readonly RunSnapshot[]
  /** A label per run, shown over its items (the page that shows two versions). */
  labels?: readonly string[]
  pair?: 'page' | 'pointer'
}): React.JSX.Element {
  const items: { id: string; node: React.JSX.Element }[] = snaps.flatMap((snap, i) => {
    const runId = snap.summary.runId
    const folder = snap.summary.folder
    const label = labels?.[i]
    const two = snap.summary.matchOf
    const wrap = (node: React.JSX.Element): React.JSX.Element =>
      label === undefined ? (
        node
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground" data-testid="easy-needs-version">
            {label}
          </p>
          {node}
        </div>
      )
    const cards = [...snap.cards]
      .filter((c) => !(c.kind === 'finalize' && two !== undefined && pair === 'page'))
      .sort((a, b) => Number(b.blocking) - Number(a.blocking))
    return [
      ...cards.map((c) => {
        const node =
          c.kind === 'clarify' ? (
            <PlainQuestions runId={runId} card={c} />
          ) : c.kind === 'gate:afterPlan' ? (
            <PlainPlan runId={runId} card={c} />
          ) : c.kind === 'research' ? (
            <PlainResearch runId={runId} card={c} />
          ) : c.kind === 'finalize' && two !== undefined && pair === 'pointer' ? (
            <TwoPointer matchId={two.matchId} />
          ) : c.kind === 'finalize' ? (
            <PlainFinalize runId={runId} card={c} snap={snap} />
          ) : (
            <PlainCard runId={runId} card={c} />
          )
        return { id: `card:${runId}:${c.id}`, node: wrap(node) }
      }),
      ...snap.asks.map((a) => ({
        id: `ask:${runId}:${a.step}:${a.requestId}`,
        node: wrap(<PlainAskCard ask={a} folder={folder} />),
      })),
    ]
  })
  const main = useMainScroller()
  const root = useRef<HTMLDivElement>(null)
  const seen = useRef(new Set<string>())
  const first = items[0]?.id
  const [away, setAway] = useState(false)

  // A new waiting item is brought into view once (and focused), unless it is in view or the user is typing.
  useEffect(() => {
    const scope = root.current
    if (scope === null) return
    for (const it of items) {
      if (seen.current.has(it.id)) continue
      seen.current.add(it.id)
      const el = scope.querySelector<HTMLElement>(`[data-needs-id="${CSS.escape(it.id)}"]`)
      const target = el?.querySelector<HTMLElement>('section') ?? el
      if (target === null || target === undefined || inView(main, target)) continue
      const active = document.activeElement
      const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      if (!typing) jumpTo(main, target, 8)
      break
    }
  })

  // The pill: while the first waiting item is out of the reading area.
  useEffect(() => {
    const el =
      first !== undefined ? root.current?.querySelector(`[data-needs-id="${CSS.escape(first)}"]`) : null
    if (el === null || el === undefined || typeof IntersectionObserver === 'undefined') {
      setAway(false)
      return
    }
    const io = new IntersectionObserver((entries) => setAway(entries.some((e) => !e.isIntersecting)), {
      root: main,
      rootMargin: `0px 0px -${SEEN_PX}px 0px`,
      threshold: 0,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [first, main])

  const goFirst = (): void => {
    const el =
      first !== undefined
        ? root.current?.querySelector<HTMLElement>(`[data-needs-id="${CSS.escape(first)}"]`)
        : null
    const target = el?.querySelector<HTMLElement>('section') ?? el
    if (target !== null && target !== undefined) jumpTo(main, target, 8)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="easy-needs-you" ref={root}>
      {items.map((it) => (
        <div key={it.id} data-needs-id={it.id} className={JUMP_MARGIN}>
          {it.node}
        </div>
      ))}
      {first !== undefined && away && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center">
          <Button
            size="sm"
            className="pointer-events-auto shadow-md"
            icon={<ArrowDown aria-hidden />}
            onClick={goFirst}
            data-testid="easy-jump-needs"
          >
            {NEEDS_JUMP}
          </Button>
        </div>
      )}
    </div>
  )
}

/** What the project permission approved during this run: one line, always there (empty without a permission). */
function PermissionLine({ folder, runId }: { folder: string; runId: string }): React.JSX.Element {
  const p = useEasyPermission(folder, runId)
  const show = p !== null && (p.granted || p.runUses > 0)
  return (
    <p className="min-h-5 text-sm text-muted-foreground tabular-nums" data-testid="easy-permission-uses">
      {show ? permissionUsesText(p.runUses) : ''}
    </p>
  )
}

function EasyProgress({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const runId = snap.summary.runId
  const limits = useRunLimits(runId)
  const project = useEasyProject(snap.summary.folder)
  const views = milestoneViews(snap)
  const needs = snap.cards.length + snap.asks.length
  const limit = limits !== 'loading' && limits !== null ? limits.limits.maxCostUsd : null
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8"
      data-testid="easy-run"
      data-run-id={runId}
    >
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="text-2xl font-semibold">{RUN_TITLE_WORKING}</h1>
          <p
            className="truncate text-sm text-muted-foreground"
            title={snap.summary.folder}
            data-testid="easy-run-project"
          >
            {projectTitle(snap.summary.folder, project !== 'loading' ? project?.title : undefined)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" data-testid="easy-show-details">
            <a href={href({ name: 'run', runId })}>{SHOW_DETAILS}</a>
          </Button>
          <StopButton runIds={[runId]} />
        </div>
      </header>
      <ol aria-label={PROGRESS_LABEL} className="flex flex-col gap-2" data-testid="easy-milestones">
        {views.map((m) => (
          <MilestoneRow key={m.id} m={m} />
        ))}
      </ol>
      <TimeAndMoney snap={snap} limit={limit} waiting={needs > 0} />
      <PermissionLine folder={snap.summary.folder} runId={runId} />
      <NowDoing snap={snap} />
      {/* A run in a copy of the folder: what became of its changes (kept, thrown away), with Undo. */}
      {snap.summary.isolation === 'worktree' && <ChangesLine snap={snap} ended={false} />}
      <div className="sr-only" aria-live="polite" data-testid="easy-needs-announcer">
        {needs > 0 ? NEEDS_ANNOUNCE : ''}
      </div>
      <NeedsYou snaps={[snap]} {...(isOfTwo(snap) ? { pair: 'pointer' as const } : {})} />
    </div>
  )
}

export function EasyRunPage({ runId }: { runId: string }): React.JSX.Element {
  useFocusRun(runId)
  const entry = useRun(runId)
  const snap = entry?.snapshot ?? null
  if (snap === null) {
    return (
      <p className="p-8 text-sm text-muted-foreground" role="status" data-testid="easy-run-loading">
        {entry?.status === 'error' ? (entry.error ?? RUN_NOT_OPENED) : RUN_LOADING}
      </p>
    )
  }
  if (!isEnded(snap)) return <EasyProgress key={runId} snap={snap} />
  // One of two versions that is not the one in the project: the page of both is where one is kept.
  const two = snap.summary.matchOf
  if (two !== undefined && isOfTwo(snap) && snap.summary.worktree?.state !== 'applied') {
    return (
      <>
        <div className="mx-auto w-full max-w-3xl px-6 pt-8">
          <TwoPointer matchId={two.matchId} />
        </div>
        <EasyDone key={runId} snap={snap} />
      </>
    )
  }
  return <EasyDone key={runId} snap={snap} />
}
