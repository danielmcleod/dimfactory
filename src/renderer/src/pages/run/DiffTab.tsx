// The Run view's Diff tab: the run's changes as core diffs
// them, one segment at a time (Implement S0..S1, Fix F0..S2, Combined S0..last; only the ones the run has), laid out
// by @pierre/diffs with Shiki in a worker (components/diff/).
// - Toolbar: segments · Split | Stacked · Ignore line endings · Mark all reviewed · Revert all (its button, disabled
//   with the reason while the folder is busy). Then the file list (Reviewed marks, status letters, +/- counts) and
//   every file's diff, laid out only near the view; files over 3000 changed lines start collapsed.
// - Reviewed marks go to core (`diff.markReviewed`, review-state.json): they last across a reload.
// - A file's Revert reverts it to the segment's start with an Undo toast; disabled while the folder is busy.
// - A history run whose snapshots were cleared shows its saved patch read only (core's `persisted`), with the reason
//   on every Revert. An isolated run gets the "Apply to folder…" panel (all files or the reviewed ones, with
//   core's preview of what Apply writes and which files conflict, and an Undo toast). Its Revert all and per-file
//   Revert are disabled with why: they would change the isolated copy, never the folder.
// - Keys (lib/keys.ts): J / K next and previous file, R the current file's Reviewed mark, S Split ⇄ Stacked. They act
//   while the tab is open, wherever focus is on the page (never in a field, a menu, a dialog or the toasts: lib/keys.ts
//   stops a scope there). The current file is the one the keyboard is in while it is in view, else the one at the top
//   of the reading area (readingPosition.ts), so R never marks a file out of sight. J/K move focus to the file and
//   bring it under the sticky header (jumpTo): the page scrolls only because the key was pressed.
// - While the run goes on, a list core sends because the run moved on is held (useDiffFiles) and offered with [Show
//   the latest changes]; the file list's open or closed default is fixed when a segment's list first shows.
// UI control standards: the page scroller is the only scroll region (the file list and the diffs are in its
// flow, nothing here scrolls or moves on its own); controls never change size; no em dash in what it shows.
import { FileDiff, FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiffSegment, FileChange } from '@shared/ipc.ts'
import type { RunSnapshot, RunSummary } from '@shared/run.ts'
import { MATCH_TEXT } from '@shared/match.ts'
import { ApplyPanel } from '../../components/diff/ApplyPanel.tsx'
import { DiffToolbar } from '../../components/diff/DiffToolbar.tsx'
import { FileList } from '../../components/diff/FileList.tsx'
import { FileSection } from '../../components/diff/FileSection.tsx'
import {
  chooseSegment,
  setDiffPrefs,
  toggleLayout,
  useDiffPrefs,
  useSegmentChoice,
} from '../../components/diff/prefs.ts'
import { revertFile } from '../../components/diff/revertFile.ts'
import {
  LIST_OPEN_MAX,
  READ_ONLY_REASON,
  isLarge,
  markedText,
  SEGMENT_LABEL,
} from '../../components/diff/text.ts'
import { currentFile, stepFile } from '../../components/diff/readingPosition.ts'
import type { Span } from '../../components/diff/readingPosition.ts'
import { useDiffFiles } from '../../components/diff/useDiffFiles.ts'
import { runCommand, useBusy } from '../../components/run/commands.ts'
import { jumpTo } from '../../components/run/follow.tsx'
import { UNDO_LABEL, useFolderBusyReason, useRevertSupported } from '../../components/run/revert.ts'
import { RevertAllButton } from '../../components/run/RevertAllButton.tsx'
import { NO_CHANGES_REASON, runMadeNoChanges } from '../../components/run/RunEndPanel.tsx'
import { useMainScroller } from '../../components/shell/mainScroll.ts'
import { Button } from '../../components/ui/Button.tsx'
import { LATER_VERSION } from '../../components/ui/DisabledHint.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { formatFiles } from '../../lib/format.ts'
import { KEYS, useShortcut } from '../../lib/keys.ts'
import { isActiveStatus, useSummary, useTheme } from '../../state/selectors.ts'
import { toast } from '../../state/toasts.ts'

/**
 * Why an isolated run's Revert all and per-file Revert are disabled (they would revert the isolated copy,
 * never the folder; core refuses diff.revert for it with the same words).
 */
export const ISOLATED_REVERT_REASON =
  "This run changed only its isolated copy, not your folder. Apply to folder puts its changes in your folder, and that apply's Undo takes them out again."

/** The key scope the Diff tab's single-key shortcuts use (lib/keys.ts `data-key-scope`). */
export const DIFF_KEY_SCOPE = 'diff'

/** The segment shown until the viewer picks another: the run's whole change. */
export const DEFAULT_SEGMENT: DiffSegment = 'combined'

/** A J/K jump leaves this much room under the Run view's sticky header (px). */
const JUMP_GAP = 8

/**
 * What can move the run's diffs: the run's status and phase, Implement's and Fix's step (a new snapshot), the folder
 * lock (an ended run takes its last snapshot, `stopped` or the final one, before core releases the lock and
 * republishes the summary), the live files-changed count (edits after the run) and a card revert. `summary` is the
 * store's latest (run-summary events), else the snapshot's. Stream events are not in it: the list is fetched again only
 * when one of these changes.
 */
export function diffRefreshKey(snap: RunSnapshot, summary: RunSummary = snap.summary): string {
  const { implement, fix } = snap.steps
  return [
    summary.status,
    summary.phase,
    summary.progress.filesChanged,
    summary.lock ?? 'free',
    summary.endedAt ?? '',
    implement.status,
    implement.attempt,
    fix.status,
    fix.attempt,
    snap.revertUndo?.undoToken ?? '',
  ].join('|')
}

/**
 * Single keys need a scope (lib/keys.ts). While the tab is open the whole page is in the Diff tab's scope, so J/K/R/S
 * work from the tab bar, the header or a click on plain text (focus on <body>); fields never take them, and neither do
 * menus, listboxes, dialogs or the toasts (their typeahead and buttons stop the scope).
 */
function useBodyKeyScope(scope: string): void {
  useEffect(() => {
    const body = document.body
    const read = (): string[] =>
      (body.getAttribute('data-key-scope') ?? '').split(/\s+/).filter((t) => t !== '')
    if (read().includes(scope)) return
    body.setAttribute('data-key-scope', [...read(), scope].join(' '))
    return () => {
      const rest = read().filter((t) => t !== scope)
      if (rest.length === 0) body.removeAttribute('data-key-scope')
      else body.setAttribute('data-key-scope', rest.join(' '))
    }
  }, [scope])
}

/** "2 files changed · +12 −3": core's per-file counts added up (binary files have none). */
function summaryText(files: readonly FileChange[]): string {
  let added = 0
  let deleted = 0
  for (const f of files) {
    added += f.added ?? 0
    deleted += f.deleted ?? 0
  }
  return `${formatFiles(files.length)} changed · +${added} −${deleted}`
}

/** Before core has a diff to show (the run has not reached Implement, or core cannot read it): its words. */
function NoDiff({
  snap,
  filesChanged,
  message,
}: {
  snap: RunSnapshot
  /** Core's live count (RunSummary.progress.filesChanged). */
  filesChanged: number
  message: string
}): React.JSX.Element {
  const s = snap.summary
  const [busy, run] = useBusy()
  return (
    <EmptyState
      icon={FileDiff}
      title={`${formatFiles(filesChanged)} changed`}
      description={message}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            loading={busy === 'open'}
            icon={<FolderOpen aria-hidden />}
            onClick={() =>
              run('open', () => runCommand(null, 'shell.open', { target: 'folder', path: s.folder }))
            }
          >
            Open the folder
          </Button>
          <RevertAllButton
            runId={s.runId}
            testId="diff-revert-all"
            size="md"
            disabledReason={
              s.isolation === 'worktree'
                ? ISOLATED_REVERT_REASON
                : runMadeNoChanges(snap)
                  ? NO_CHANGES_REASON
                  : undefined
            }
          />
        </div>
      }
    />
  )
}

export function DiffTab({ snap }: { snap: RunSnapshot }): React.JSX.Element {
  const s = snap.summary
  const runId = s.runId
  const prefs = useDiffPrefs()
  const seg = useSegmentChoice(runId) ?? DEFAULT_SEGMENT
  const live = useSummary(runId) ?? s
  const { state, fetching, reviewed, setReviewed, refresh, pending, showPending } = useDiffFiles(
    runId,
    seg,
    diffRefreshKey(snap, live),
    isActiveStatus(live.status),
  )
  const theme = useTheme()?.resolved ?? 'light'
  const folderBusy = useFolderBusyReason(runId)
  const revertSupported = useRevertSupported()
  const main = useMainScroller()
  const rootRef = useRef<HTMLElement>(null)
  /** The file J/K last went to, or focus last came into: R acts on it. */
  const cursor = useRef<string | null>(null)
  const [collapsedBy, setCollapsedBy] = useState<ReadonlyMap<string, boolean>>(new Map())
  /** The file list's open state per segment: its default is fixed when the segment's list first shows. */
  const [listOpen, setListOpen] = useState<Readonly<Partial<Record<DiffSegment, boolean>>>>({})
  const [marking, runMark] = useBusy()
  useBodyKeyScope(DIFF_KEY_SCOPE)

  const data = state.kind === 'ready' ? state.data : null
  const files = useMemo(() => data?.files ?? [], [data])
  if (data !== null && listOpen[data.seg] === undefined) {
    // Set while rendering (React's derived state): the first list's count decides, never a later one.
    setListOpen((prev) => ({ ...prev, [data.seg]: data.files.length <= LIST_OPEN_MAX }))
  }
  // A saved patch (history run): core's reason, or ours where an older core gives none.
  const readOnly =
    data === null ? undefined : (data.revertUnavailable ?? (data.persisted ? READ_ONLY_REASON : undefined))
  // An isolated run's Revert would change its copy, never the folder (core refuses it too).
  const isolated = s.isolation === 'worktree' ? ISOLATED_REVERT_REASON : undefined
  const fileRevertReason = !revertSupported ? LATER_VERSION : (isolated ?? readOnly ?? folderBusy)
  const revertAllReason = isolated ?? readOnly ?? (runMadeNoChanges(snap) ? NO_CHANGES_REASON : undefined)
  const unreviewed = files.filter((f) => !reviewed.has(f.path))

  const isCollapsed = useCallback((f: FileChange) => collapsedBy.get(f.path) ?? isLarge(f), [collapsedBy])
  const setCollapsed = (f: FileChange, v: boolean): void =>
    setCollapsedBy((prev) => new Map(prev).set(f.path, v))

  /** The file sections in order. */
  const sections = (): HTMLElement[] => [
    ...(rootRef.current?.querySelectorAll<HTMLElement>('article[data-testid="diff-file"]') ?? []),
  ]

  /** Bring file `i` under the sticky header and focus it (a key or a click asked for it). */
  const goTo = (i: number): void => {
    const el = sections()[i]
    const f = files[i]
    if (el === undefined || f === undefined) return
    cursor.current = f.path
    const root = rootRef.current
    const top =
      root !== null ? parseFloat(getComputedStyle(root).getPropertyValue('--run-sticky-top')) || 0 : 0
    jumpTo(main, el, top + JUMP_GAP)
  }

  /** The sections' places, the reading area, and the files the keyboard is in (focus, the last J / K). */
  const where = (): { rects: Span[]; area: Span; focused: number; cursorAt: number } => {
    const els = sections()
    const active = document.activeElement
    const rects = els.map((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })
    const root = rootRef.current
    const cs = root !== null ? getComputedStyle(root) : null
    const view = main?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
    const area = {
      top: view.top + (parseFloat(cs?.getPropertyValue('--run-sticky-top') ?? '') || 0),
      bottom: view.bottom - (parseFloat(cs?.getPropertyValue('--run-sticky-bottom') ?? '') || 0),
    }
    return {
      rects,
      area,
      focused: els.findIndex((el) => active !== null && el.contains(active)),
      cursorAt: cursor.current === null ? -1 : files.findIndex((f) => f.path === cursor.current),
    }
  }

  const step = (by: 1 | -1): void => {
    const w = where()
    const to = stepFile(w.rects, w.area, by, w.focused, w.cursorAt, JUMP_GAP)
    if (to !== -1) goTo(to)
  }

  const toggleReviewed = (): void => {
    const w = where()
    const f = files[currentFile(w.rects, w.area, w.focused, w.cursorAt, JUMP_GAP)]
    if (f === undefined) return
    cursor.current = f.path
    void setReviewed([f.path], !reviewed.has(f.path))
  }

  const keyOpts = { scope: DIFF_KEY_SCOPE, enabled: files.length > 0 }
  useShortcut(KEYS.diffNext, () => step(1), { ...keyOpts, description: 'Next file', repeat: true })
  useShortcut(KEYS.diffPrev, () => step(-1), { ...keyOpts, description: 'Previous file', repeat: true })
  useShortcut(KEYS.diffReviewed, toggleReviewed, { ...keyOpts, description: 'Mark the file reviewed' })
  useShortcut(KEYS.diffLayout, toggleLayout, { scope: DIFF_KEY_SCOPE, description: 'Split or stacked' })

  const markAll = (): void => {
    const paths = unreviewed.map((f) => f.path)
    if (paths.length === 0 || data === null) return
    // The Undo is for the same segment, whichever one shows by then.
    const markSeg = data.seg
    runMark('mark', async () => {
      if (!(await setReviewed(paths, true, markSeg))) return
      toast({
        id: `diff-marked:${runId}`,
        level: 'info',
        message: markedText(paths.length),
        durationMs: 15_000,
        action: { label: UNDO_LABEL, onClick: () => setReviewed(paths, false, markSeg) },
      })
    })
  }

  let body: React.ReactNode
  if (state.kind === 'loading') {
    body = (
      <p
        className="px-1 py-6 text-sm text-muted-foreground"
        data-testid="diff-loading-files"
        aria-live="polite"
      >
        Loading the changes…
      </p>
    )
  } else if (state.kind === 'error') {
    body = <NoDiff snap={snap} filesChanged={live.progress.filesChanged} message={state.message} />
  } else {
    const open = listOpen[state.data.seg] ?? files.length <= LIST_OPEN_MAX
    const listSeg = state.data.seg
    body = (
      <>
        <DiffToolbar
          runId={runId}
          segments={state.data.available}
          seg={seg}
          onSeg={(v) => chooseSegment(runId, v)}
          layout={prefs.layout}
          onLayout={(layout) => setDiffPrefs({ layout })}
          ignoreEol={prefs.ignoreEol}
          onIgnoreEol={(ignoreEol) => setDiffPrefs({ ignoreEol })}
          unreviewed={unreviewed.length}
          onMarkAll={markAll}
          markingAll={marking !== null}
          revertAllReason={revertAllReason}
          summary={summaryText(files)}
          newer={pending !== null}
          onShowNewer={showPending}
          onReverted={refresh}
        />
        {readOnly !== undefined && (
          <p className="text-sm text-muted-foreground" data-testid="diff-read-only">
            {readOnly}
          </p>
        )}
        {s.isolation === 'worktree' && s.matchOf?.rematch === true && (
          <p className="text-sm text-muted-foreground" data-testid="diff-rematch-not-applied">
            {MATCH_TEXT.notApplied}
          </p>
        )}
        {s.isolation === 'worktree' && s.matchOf?.rematch !== true && (
          <ApplyPanel snap={snap} reviewed={reviewed} refreshKey={diffRefreshKey(snap, live)} />
        )}
        {files.length === 0 ? (
          <EmptyState
            icon={FileDiff}
            title="No files changed"
            description={`${SEGMENT_LABEL[state.data.seg]}: nothing differs between its start and its end.`}
          />
        ) : (
          <>
            <FileList
              files={files}
              reviewed={reviewed}
              onReviewed={(f, v) => void setReviewed([f.path], v)}
              onOpen={goTo}
              open={open}
              onOpenChange={(v) => setListOpen((prev) => ({ ...prev, [listSeg]: v }))}
            />
            <div className="flex flex-col gap-3" data-testid="diff-files">
              {files.map((f, i) => (
                <FileSection
                  key={f.path}
                  runId={runId}
                  seg={state.data.seg}
                  file={f}
                  index={i}
                  reviewed={reviewed.has(f.path)}
                  onReviewed={(v) => void setReviewed([f.path], v)}
                  collapsed={isCollapsed(f)}
                  onCollapsed={(v) => setCollapsed(f, v)}
                  layout={prefs.layout}
                  theme={theme}
                  ignoreEol={prefs.ignoreEol}
                  revertReason={fileRevertReason}
                  onRevert={() => revertFile(runId, state.data.seg, f, refresh)}
                  onFocusFile={() => {
                    cursor.current = f.path
                  }}
                />
              ))}
            </div>
          </>
        )}
      </>
    )
  }

  return (
    <section
      ref={rootRef}
      aria-label="Changes"
      aria-busy={fetching}
      data-testid="diff-tab"
      data-key-scope={DIFF_KEY_SCOPE}
      data-segment={seg}
      className="flex flex-col gap-3"
    >
      {body}
    </section>
  )
}
