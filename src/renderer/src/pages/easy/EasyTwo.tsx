// Easy mode's view of two versions of one idea ("Make two and pick"): the two builds side by side, each with how it
// stands, the step it is at, what it has spent and, once it has a page, a small picture of it. What either build needs
// from the user (questions, asks) is one list below, each item under its version. When both are ready each can be
// opened and one is kept: its files go into the project folder and the page moves on to that version's Done screen.
// The versions are a match's sides with the builders' names hidden, so the page never says who built which.
// UI standards: one scroll region (the page); nothing moves on its own (both version boxes are there from the first
// frame with their picture, lines and buttons at fixed sizes; what needs the user arrives last on the page); buttons
// keep their labels and wait disabled until they apply.
import { Check, Eye, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EASY_DOCUMENT_KINDS } from '@shared/easy.ts'
import { shownOrder } from '@shared/match.ts'
import type { MatchPickSide, MatchSide, MatchSideView, MatchView } from '@shared/match.ts'
import type { RunSnapshot } from '@shared/run.ts'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { StableLabel } from '../../components/ui/StableLabel.tsx'
import { useFocusRun } from '../../ipc/bridge.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { href, navigate } from '../../lib/router.ts'
import { ensureRun } from '../../state/runs.ts'
import { useRunEntry } from '../../state/selectors.ts'
import { useMatch } from '../match/useMatch.ts'
import { NeedsYou, StopButton } from './EasyRun.tsx'
import { milestoneViews, projectTitle } from './model.ts'
import { openSession } from './session.ts'
import { canKeep, keptRunId, twoSideState, twoStatus } from './two-model.ts'
import { useEasyProject } from './useProject.ts'
import {
  MILESTONE_TITLE,
  NEEDS_ANNOUNCE,
  OPENED,
  OPEN_IT,
  SHOW_DETAILS,
  TWO_GO_PROJECT,
  TWO_KEEP,
  TWO_LOADING,
  TWO_NEEDS_LABEL,
  TWO_NEITHER,
  TWO_NOT_OPENED,
  TWO_NO_PICTURE,
  TWO_NO_PICTURE_DONE,
  TWO_SEE,
  TWO_STATE,
  TWO_STATUS,
  TWO_STOP,
  TWO_STOP_CONFIRM,
  TWO_TITLE_PICKED,
  TWO_TITLE_READY,
  TWO_TITLE_WORKING,
  TWO_VERSION_LABEL,
  spentText,
  twoConflictsText,
  twoPictureAlt,
} from './text.ts'
import type { TwoState } from './text.ts'

const STATE_LABELS: readonly string[] = Object.values(TWO_STATE)

const STATE_TONE: Readonly<Record<TwoState, string>> = {
  waiting: 'text-muted-foreground',
  working: 'text-st-running',
  needsYou: 'text-st-waiting',
  ready: 'text-st-done',
  stopped: 'text-st-cancelled',
  failed: 'text-st-failed',
  kept: 'text-st-done',
  notKept: 'text-muted-foreground',
}

/** A version can be opened once it has settled with something built: ready, or after the pick. */
const OPENABLE: ReadonlySet<TwoState> = new Set<TwoState>(['ready', 'kept', 'notKept'])

/** What waits for the user in a version's run, not counting its "keep or throw away" card (this page answers it). */
function needsOf(snap: RunSnapshot | null): number {
  if (snap === null) return 0
  return snap.cards.filter((c) => c.kind !== 'finalize').length + snap.asks.length
}

/** The step a version is at, in Easy's words; empty when it is not at one. */
function stepLine(snap: RunSnapshot | null, state: TwoState): string {
  if (snap === null || (state !== 'working' && state !== 'needsYou')) return ''
  const at = milestoneViews(snap).find((m) => m.state === 'working' || m.state === 'needsYou')
  return at !== undefined ? MILESTONE_TITLE[at.id] : ''
}

/** A version's run as the store has it, loaded when it has a run (the second may not have started yet). */
function useSnapshot(runId: string | undefined): RunSnapshot | null {
  useEffect(() => {
    if (runId !== undefined) ensureRun(runId)
  }, [runId])
  return useRunEntry(runId ?? '')?.snapshot ?? null
}

function Version({
  position,
  side,
  snap,
  state,
  document,
  keepable,
  keeping,
  locked,
  onKeep,
}: {
  /** Where the version is shown: 0 first, 1 second. */
  position: 0 | 1
  side: MatchSideView
  snap: RunSnapshot | null
  state: TwoState
  /** The project is a document: Open it shows the rendered document. */
  document: boolean
  keepable: boolean
  /** This version is being kept right now. */
  keeping: boolean
  /** A choice is being made: every button waits. */
  locked: boolean
  onKeep: () => void
}): React.JSX.Element {
  const [busy, run] = useBusy()
  const [note, setNote] = useState('')
  const name = TWO_VERSION_LABEL[position]
  const picture = side.detail?.thumbnail
  const runId = side.runId
  const open = (): void => {
    if (runId === undefined) return
    run('open', async () => {
      const s = await openSession(runId, document)
      if (typeof s === 'string') {
        setNote(s)
        return
      }
      const o = await invoke('preview.open', { sessionId: s.sessionId, target: s.openIn })
      setNote(o.ok ? OPENED : o.error.message)
    })
  }
  const line = stepLine(snap, state)
  return (
    <section
      aria-label={name}
      data-testid={`easy-two-version-${position}`}
      data-state={state}
      className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{name}</h2>
        <span className={cn('shrink-0 text-xs font-medium', STATE_TONE[state])} data-testid="easy-two-state">
          <StableLabel labels={STATE_LABELS} align="end">
            {TWO_STATE[state]}
          </StableLabel>
        </span>
      </div>
      {/* One height with or without a picture, so one arriving moves nothing. */}
      <div className="flex h-40 w-full items-center justify-center overflow-hidden rounded-md border bg-muted">
        {picture !== undefined ? (
          <img
            src={picture}
            alt={twoPictureAlt(name)}
            className="size-full object-contain"
            data-testid="easy-two-picture"
          />
        ) : (
          <span className="text-xs text-muted-foreground">
            {OPENABLE.has(state) ? TWO_NO_PICTURE_DONE : TWO_NO_PICTURE}
          </span>
        )}
      </div>
      <p className="h-5 truncate text-sm text-muted-foreground" title={line} data-testid="easy-two-step">
        {line}
      </p>
      <p className="h-5 truncate text-sm tabular-nums" data-testid="easy-two-spent">
        {runId !== undefined ? spentText(side.costUsd ?? null, null) : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          icon={<Play aria-hidden />}
          loading={busy === 'open'}
          disabled={!OPENABLE.has(state) || runId === undefined || locked}
          onClick={open}
          data-testid="easy-two-open"
        >
          {OPEN_IT}
        </Button>
        <Button
          icon={<Check aria-hidden />}
          loading={keeping}
          disabled={!keepable || (locked && !keeping)}
          onClick={onKeep}
          data-testid="easy-two-keep"
        >
          {TWO_KEEP}
        </Button>
        {/* The version's own page: its steps, and what happened when it did not finish. */}
        <Button
          variant="outline"
          icon={<Eye aria-hidden />}
          disabled={runId === undefined || locked}
          onClick={() => {
            if (runId !== undefined) navigate({ name: 'easyRun', runId })
          }}
          data-testid="easy-two-see"
        >
          {TWO_SEE}
        </Button>
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground" data-testid="easy-two-note">
        {note}
      </p>
    </section>
  )
}

function Loaded({ view, set }: { view: MatchView; set: (v: MatchView) => void }): React.JSX.Element {
  const order = shownOrder(view)
  const sideOf = (s: MatchSide): MatchSideView => (s === 'a' ? view.sides[0] : view.sides[1])
  const shown: readonly [MatchSideView, MatchSideView] = [sideOf(order[0]), sideOf(order[1])]
  const first = shown[0].runId
  const second = shown[1].runId
  useFocusRun(first)
  useFocusRun(second)
  const snaps: readonly [RunSnapshot | null, RunSnapshot | null] = [useSnapshot(first), useSnapshot(second)]
  const project = useEasyProject(view.folder)
  const [busy, setBusy] = useState<MatchPickSide | null>(null)
  const [note, setNote] = useState('')

  const states: readonly [TwoState, TwoState] = [
    twoSideState(view, shown[0], needsOf(snaps[0])),
    twoSideState(view, shown[1], needsOf(snaps[1])),
  ]
  const status = twoStatus(view, states)
  const picked = view.pick !== undefined || view.kept !== undefined
  const kept = keptRunId(view)
  const document =
    project !== 'loading' && project?.kind !== undefined && EASY_DOCUMENT_KINDS.includes(project.kind)
  const active = shown
    .filter((s) => s.runId !== undefined && s.status !== undefined && s.endedAt === undefined)
    .map((s) => s.runId as string)
  // The runs whose questions and asks are listed, in the order the versions are shown.
  const listed = snaps
    .map((snap, i) => ({ snap, label: TWO_NEEDS_LABEL[i as 0 | 1] }))
    .filter((x): x is { snap: RunSnapshot; label: string } => x.snap !== null)
  const needs = needsOf(snaps[0]) + needsOf(snaps[1])

  const pick = (side: MatchPickSide): void => {
    if (busy !== null) return
    setBusy(side)
    setNote('')
    void invoke('matches.pick', { matchId: view.matchId, side }).then((r) => {
      setBusy(null)
      if (!r.ok) {
        setNote(r.error.message)
        return
      }
      set(r.value.match)
      if (r.value.conflicts.length > 0) {
        setNote(twoConflictsText(r.value.conflicts.length))
        return
      }
      const to = keptRunId(r.value.match)
      if (to !== undefined) navigate({ name: 'easyRun', runId: to })
    })
  }

  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8"
      data-testid="easy-two"
      data-match-id={view.matchId}
      data-status={status}
    >
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="text-2xl font-semibold" data-testid="easy-two-title">
            {picked
              ? TWO_TITLE_PICKED
              : status === 'ready' || status === 'readyOne'
                ? TWO_TITLE_READY
                : TWO_TITLE_WORKING}
          </h1>
          <p
            className="truncate text-sm text-muted-foreground"
            title={view.folder}
            data-testid="easy-two-project"
          >
            {projectTitle(view.folder, project !== 'loading' ? project?.title : undefined)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" data-testid="easy-two-details">
            <a href={href({ name: 'match', matchId: view.matchId })}>{SHOW_DETAILS}</a>
          </Button>
          <StopButton
            runIds={active}
            label={TWO_STOP}
            confirm={TWO_STOP_CONFIRM}
            // Nothing to stop once both have built: from there the choice is to keep one or neither.
            disabled={active.length === 0 || picked || view.ready}
          />
        </div>
      </header>
      <p role="status" className="min-h-5 text-sm" data-testid="easy-two-status">
        {TWO_STATUS[status]}
      </p>
      <div className="grid grid-cols-2 gap-3">
        {([0, 1] as const).map((i) => (
          <Version
            key={shown[i].side}
            position={i}
            side={shown[i]}
            snap={snaps[i]}
            state={states[i]}
            document={document}
            keepable={canKeep(view, states[i])}
            keeping={busy === shown[i].side}
            locked={busy !== null}
            onKeep={() => pick(shown[i].side)}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          loading={busy === 'none'}
          disabled={!view.ready || picked || (busy !== null && busy !== 'none')}
          onClick={() => pick('none')}
          data-testid="easy-two-neither"
        >
          {TWO_NEITHER}
        </Button>
        {/* Always there and one size, so a pick moves nothing: it leads on once a version is in the project. */}
        <Button
          variant="outline"
          disabled={kept === undefined}
          onClick={() => {
            if (kept !== undefined) navigate({ name: 'easyRun', runId: kept })
          }}
          data-testid="easy-two-go-project"
        >
          {TWO_GO_PROJECT}
        </Button>
        <p
          role={note !== '' ? 'alert' : undefined}
          className="min-h-5 min-w-0 flex-1 text-sm text-destructive"
          data-testid="easy-two-note-page"
        >
          {note}
        </p>
      </div>
      <div className="sr-only" aria-live="polite" data-testid="easy-needs-announcer">
        {needs > 0 ? NEEDS_ANNOUNCE : ''}
      </div>
      <NeedsYou snaps={listed.map((x) => x.snap)} labels={listed.map((x) => x.label)} pair="page" />
    </div>
  )
}

export function EasyTwoPage({ matchId }: { matchId: string }): React.JSX.Element {
  const { view, error, set } = useMatch(matchId)
  if (view === null) {
    return (
      <p className="p-8 text-sm text-muted-foreground" role="status" data-testid="easy-two-loading">
        {error !== null ? `${TWO_NOT_OPENED} ${error}` : TWO_LOADING}
      </p>
    )
  }
  return <Loaded view={view} set={set} />
}
