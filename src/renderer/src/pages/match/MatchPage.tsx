// The Match page (#/matches/<matchId>): two runs of one task, side by side.
//   - the task, where the match stands, and the switch that hides who built which until a result is picked
//   - one card per side: who built it, its run, the same facts in the same rows, and "Keep this result"
//   - the results: each side's page-load screenshot and its own Run it panel; both previews in one window
//   - where they differ, file by file
//   - what each side said at the end
//   - the pick: keep neither, or undo the pick
// Every part keeps its place: rows that have nothing yet say so in the same row, buttons keep one label, and the two
// cards keep the order they were first shown in. The page's only scroller is the app's.
import { FileQuestion } from 'lucide-react'
import { useState } from 'react'
import { MATCH_TEXT, blindNow, shownOrder } from '@shared/match.ts'
import type { MatchPickSide, MatchSide, MatchSideView, MatchView } from '@shared/match.ts'
import type { RunSummary } from '@shared/run.ts'
import { RunItPanel } from '../../components/run/RunItPanel.tsx'
import { Badge, StatusBadge } from '../../components/ui/Badge.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { DisabledHint } from '../../components/ui/DisabledHint.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Switch } from '../../components/ui/Switch.tsx'
import { invoke } from '../../ipc/client.ts'
import { folderBaseName } from '../dashboard/composer-model.ts'
import { href } from '../../lib/router.ts'
import { usePreviewsStore } from '../../state/previews.ts'
import { toast } from '../../state/toasts.ts'
import { MatchChanges } from './MatchChanges.tsx'
import {
  BLIND_SWITCH,
  HIDDEN,
  OPEN_TASK_LABEL,
  SAVE_PATCH_LABEL,
  NOTHING_SAID,
  NO_SHOT,
  OPEN_BOTH_LABEL,
  OPEN_BOTH_REASON,
  UNDO_LABEL,
  builderText,
  keepBlocked,
  matchStatus,
  matchWords,
  sideFacts,
  sideNames,
} from './text.ts'
import { sideKey, useMatch } from './useMatch.ts'

export const MATCH_LOADING = 'Loading the match…'

function SideCard({
  view,
  side,
  name,
  live,
  busy,
  onKeep,
  onPatch,
}: {
  view: MatchView
  side: MatchSideView
  name: string
  live: RunSummary | undefined
  busy: string | null
  onKeep: (side: MatchSide) => void
  onPatch: (side: MatchSide) => void
}): React.JSX.Element {
  const words = matchWords(view.kind)
  const hide = blindNow(view)
  const facts = sideFacts(side, { hide, tokens: live?.progress.tokens, costUsd: live?.progress.costUsd })
  const blocked = keepBlocked(view, side)
  // A Head to head's kept side is in the folder; a rematch's picked side is only marked.
  const kept = view.kind === 'rematch' ? view.pick?.side === side.side : view.kept === side.side
  const noChanges = side.runId === undefined || (side.filesChanged ?? 0) === 0
  const patch = (
    <Button
      data-testid={`match-patch-${side.side}`}
      size="sm"
      variant="outline"
      disabled={noChanges || busy !== null}
      loading={busy === `patch-${side.side}`}
      onClick={() => onPatch(side.side)}
    >
      {SAVE_PATCH_LABEL}
    </Button>
  )
  const keep = (
    <Button
      data-testid={`match-keep-${side.side}`}
      size="sm"
      disabled={blocked !== null || busy !== null}
      loading={busy === `keep-${side.side}`}
      onClick={() => onKeep(side.side)}
    >
      {words.keep}
    </Button>
  )
  return (
    <section
      data-testid={`match-side-${side.side}`}
      data-kept={kept || undefined}
      aria-label={name}
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <div className="flex h-6 min-w-0 items-center gap-2">
        <h2 className="shrink-0 text-sm font-semibold">{name}</h2>
        <p
          data-testid={`match-builder-${side.side}`}
          className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
          title={hide ? HIDDEN : builderText(side.contestant)}
        >
          {hide ? HIDDEN : builderText(side.contestant)}
        </p>
        {live !== undefined && <StatusBadge kind="run" status={live.status} reserve className="shrink-0" />}
      </div>
      <p className="h-5 truncate text-xs text-muted-foreground">
        {side.runId === undefined ? (
          <span title={side.notStarted ?? 'Not started yet'}>{side.notStarted ?? 'Not started yet'}</span>
        ) : hide ? (
          'Its run is hidden until you pick'
        ) : (
          <a
            data-testid={`match-run-${side.side}`}
            href={href({ name: 'run', runId: side.runId })}
            className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open run #{side.displayNo}
            {side.recorded === true ? ' (the original, as it was recorded)' : ''}
          </a>
        )}
      </p>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {facts.map((f) => (
          <div key={f.key} className="contents">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd
              data-testid={`match-fact-${side.side}-${f.key}`}
              className="truncate tabular-nums"
              title={f.value}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex h-7 items-center gap-2">
        {blocked !== null ? <DisabledHint reason={blocked}>{keep}</DisabledHint> : keep}
        {noChanges ? <DisabledHint reason="This side has no changes to save.">{patch}</DisabledHint> : patch}
        {kept && (
          <span data-testid={`match-kept-${side.side}`} className="text-xs font-medium text-success">
            {words.marked}
          </span>
        )}
      </div>
    </section>
  )
}

function Shot({ side, name }: { side: MatchSideView; name: string }): React.JSX.Element {
  const src = side.detail?.thumbnail
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* One height with or without a screenshot, so one arriving moves nothing. */}
      <div className="flex h-48 w-full items-center justify-center overflow-hidden rounded-md border bg-muted">
        {src !== undefined ? (
          <img
            data-testid={`match-shot-${side.side}`}
            src={src}
            alt={`${name}: the page as it loaded`}
            className="size-full object-contain"
          />
        ) : (
          <span className="text-xs text-muted-foreground">{NO_SHOT}</span>
        )}
      </div>
      {side.runId !== undefined && <RunItPanel target={{ runId: side.runId }} collapsible />}
    </div>
  )
}

export function MatchPage({ matchId }: { matchId: string }): React.JSX.Element {
  const { view, error, set, a, b } = useMatch(matchId)
  const [busy, setBusy] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<{ side: MatchSide; paths: string[] } | null>(null)
  const [saved, setSaved] = useState<{ side: MatchSide; path: string } | null>(null)
  const sessions = usePreviewsStore((s) => s.byId)

  if (view === null) {
    return (
      <div data-testid="match-page" className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-5">
        <h1 className="text-lg font-semibold">Head to head</h1>
        {error !== null ? (
          <EmptyState
            icon={FileQuestion}
            title="This match cannot be shown"
            description={error}
            action={
              <Button asChild variant="outline">
                <a href={href({ name: 'dashboard' })}>Go to the Dashboard</a>
              </Button>
            }
          />
        ) : (
          <p data-testid="match-loading" className="text-sm text-muted-foreground">
            {MATCH_LOADING}
          </p>
        )}
      </div>
    )
  }

  const names = sideNames(view)
  const order = shownOrder(view)
  const sideOf = (s: MatchSide): MatchSideView => (s === 'a' ? view.sides[0] : view.sides[1])
  const liveOf = (s: MatchSide): RunSummary | undefined => (s === 'a' ? a : b)
  const hide = blindNow(view)
  const picked = view.pick !== undefined

  const act = async (tag: string, fn: () => Promise<MatchView | null>): Promise<void> => {
    if (busy !== null) return
    setBusy(tag)
    try {
      const next = await fn()
      if (next !== null) set(next)
    } finally {
      setBusy(null)
    }
  }
  const fail = (message: string): null => {
    toast({ level: 'error', message })
    return null
  }
  const pick = (side: MatchPickSide): void => {
    void act(`keep-${side}`, async () => {
      const r = await invoke('matches.pick', { matchId, side })
      if (!r.ok) return fail(r.error.message)
      setConflicts(
        side !== 'none' && r.value.conflicts.length > 0 ? { side, paths: r.value.conflicts } : null,
      )
      return r.value.match
    })
  }
  const undo = (): void => {
    void act('undo', async () => {
      const r = await invoke('matches.undoPick', { matchId })
      if (!r.ok) return fail(r.error.message)
      setConflicts(null)
      return r.value
    })
  }
  const setBlind = (on: boolean): void => {
    void act('blind', async () => {
      const r = await invoke('matches.blind', { matchId, on })
      return r.ok ? r.value : fail(r.error.message)
    })
  }

  // Both previews in one window: each side's running preview, when both have a page.
  const previewOf = (s: MatchSide): string | undefined => {
    const runId = sideOf(s).runId
    if (runId === undefined) return undefined
    return Object.values(sessions).find((v) => v.runId === runId && v.url !== null && v.endedAt === undefined)
      ?.id
  }
  const pair = [previewOf(order[0]), previewOf(order[1])] as const
  const openBoth = (
    <Button
      data-testid="match-open-both"
      size="sm"
      variant="outline"
      disabled={pair[0] === undefined || pair[1] === undefined}
      onClick={() => {
        const [x, y] = pair
        if (x === undefined || y === undefined) return
        void invoke('preview.openPair', {
          sessionIds: [x, y],
          labels: [names[order[0]], names[order[1]]],
        }).then((r) => {
          if (!r.ok) toast({ level: 'error', message: r.error.message })
        })
      }}
    >
      {OPEN_BOTH_LABEL}
    </Button>
  )
  const savePatch = (side: MatchSide): void => {
    void act(`patch-${side}`, async () => {
      const r = await invoke('matches.savePatch', { matchId, side })
      if (!r.ok) return fail(r.error.message)
      setSaved({ side, path: r.value.path })
      return null
    })
  }
  const words = matchWords(view.kind)
  const status = matchStatus(view)
  const blindOff = picked || view.kept !== undefined

  return (
    <div
      data-testid="match-page"
      data-blind={hide || undefined}
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-5"
    >
      <header className="flex flex-col gap-1">
        <div className="flex h-7 min-w-0 items-center gap-3">
          <h1 className="shrink-0 text-lg font-semibold">{words.title}</h1>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={view.folder}>
            {folderBaseName(view.folder)}
          </span>
          {view.openTask === true && (
            <Badge
              variant="outline"
              data-testid="match-open-task"
              title={MATCH_TEXT.openTaskMark}
              className="shrink-0 font-normal text-warning"
            >
              {OPEN_TASK_LABEL}
            </Badge>
          )}
          <label className="flex shrink-0 cursor-pointer items-center gap-2">
            <Switch
              data-testid="match-blind"
              checked={hide}
              disabled={blindOff || busy !== null}
              onCheckedChange={setBlind}
              title={blindOff ? 'Names cannot be hidden once a result is picked' : undefined}
            />
            <span className="text-xs font-medium text-muted-foreground">{BLIND_SWITCH}</span>
          </label>
        </div>
        <p data-testid="match-task" className="line-clamp-2 text-sm" title={view.task}>
          {view.task}
        </p>
        <p
          data-testid="match-status"
          role="status"
          className="h-5 truncate text-xs text-muted-foreground"
          title={status}
        >
          {status}
        </p>
        {view.sides[0].recorded === true && (
          <p data-testid="match-then-now" className="h-5 truncate text-xs text-muted-foreground">
            {MATCH_TEXT.thenAndNow}
          </p>
        )}
      </header>

      <div className="grid grid-cols-2 gap-3">
        {order.map((s) => (
          <SideCard
            key={s}
            view={view}
            side={sideOf(s)}
            name={names[s]}
            live={liveOf(s)}
            busy={busy}
            onKeep={pick}
            onPatch={savePatch}
          />
        ))}
      </div>

      <section aria-label="Your pick" className="flex flex-col gap-1">
        <div className="flex h-9 items-center gap-2">
          <Button
            data-testid="match-keep-none"
            size="sm"
            variant="outline"
            disabled={picked || view.kept !== undefined || !view.ready || busy !== null}
            loading={busy === 'keep-none'}
            onClick={() => pick('none')}
          >
            {words.neither}
          </Button>
          <Button
            data-testid="match-undo"
            size="sm"
            variant="outline"
            disabled={!picked || busy !== null}
            loading={busy === 'undo'}
            onClick={undo}
          >
            {UNDO_LABEL}
          </Button>
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{words.help}</p>
        </div>
        <p data-testid="match-conflicts" role="alert" className="min-h-5 text-xs text-warning">
          {conflicts !== null && (
            <>
              {conflicts.paths.length === 1 ? '1 file' : `${conflicts.paths.length} files`} changed in the
              folder since the match began and {conflicts.paths.length === 1 ? 'was' : 'were'} left as{' '}
              {conflicts.paths.length === 1 ? 'it is' : 'they are'}.{' '}
              <a
                className="underline underline-offset-2"
                href={href({ name: 'run', runId: sideOf(conflicts.side).runId ?? '' })}
              >
                Open the run to choose
              </a>
              .
            </>
          )}
        </p>
      </section>

      <p
        data-testid="match-patch-saved"
        role="status"
        className="h-5 truncate text-xs text-muted-foreground"
        title={saved !== null ? saved.path : undefined}
      >
        {saved !== null ? `Saved ${names[saved.side]}'s changes as a patch: ${saved.path}` : ''}
      </p>

      <section aria-label="Results" className="flex flex-col gap-2">
        <div className="flex h-7 items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">Results</h2>
          {pair[0] === undefined || pair[1] === undefined ? (
            <DisabledHint reason={OPEN_BOTH_REASON}>{openBoth}</DisabledHint>
          ) : (
            openBoth
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {order.map((s) => (
            <Shot key={s} side={sideOf(s)} name={names[s]} />
          ))}
        </div>
      </section>

      <section aria-label="Where they differ" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Where they differ</h2>
        <MatchChanges view={view} names={names} order={order} refreshKey={`${sideKey(a)}#${sideKey(b)}`} />
      </section>

      <section aria-label="What they said" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">What they said</h2>
        <div className="grid grid-cols-2 gap-3">
          {order.map((s) => {
            const said = sideOf(s).detail?.closing
            return (
              <div
                key={s}
                data-testid={`match-said-${s}`}
                className="min-w-0 rounded-lg border bg-card p-3 text-sm text-card-foreground"
              >
                <h3 className="mb-1 text-xs font-medium text-muted-foreground">{names[s]}</h3>
                {said !== undefined ? (
                  <p className="break-words whitespace-pre-wrap">{said}</p>
                ) : (
                  <p className="text-muted-foreground">{NOTHING_SAID}</p>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
