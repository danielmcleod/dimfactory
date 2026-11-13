// "Where they differ" on the Match page: every path either side changed, sorted into what both changed differently,
// what only one side changed, and what both changed the same way. A file opens on a click: the two results against
// each other when both changed it (or either side's own change against the start), else that side's change.
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { DiffFilePatch, FileChange } from '@shared/ipc.ts'
import { splitCompare } from '@shared/match.ts'
import type { MatchCompare, MatchCompareFile, MatchSide, MatchView } from '@shared/match.ts'
import { Segmented } from '../../components/diff/Segmented.tsx'
import { MessageRow } from '../../components/diff/SpecialRows.tsx'
import { LOADING_DIFF } from '../../components/diff/text.ts'
import { useDiffPrefs } from '../../components/diff/prefs.ts'
import { invoke } from '../../ipc/client.ts'
import { useTheme } from '../../state/selectors.ts'

const PatchView = lazy(() =>
  import('../../components/diff/PatchView.tsx').then((m) => ({ default: m.PatchView })),
)

export const CHANGES_LOADING = 'Reading what each side changed…'
export const NO_CHANGES = 'Neither side has changed a file yet.'
export const BETWEEN_GONE =
  'One of the two copies is gone, so the results cannot be put against each other. Each side’s own changes are still shown.'

type Against = 'between' | MatchSide

function countsText(f: FileChange | undefined): string {
  if (f === undefined) return ''
  if (f.binary || f.added === null || f.deleted === null) return 'binary'
  return `+${f.added} -${f.deleted}`
}

function FilePatch({
  matchId,
  file,
  against,
  runIds,
}: {
  matchId: string
  file: MatchCompareFile
  against: Against
  runIds: Record<MatchSide, string | undefined>
}): React.JSX.Element {
  const prefs = useDiffPrefs()
  const theme = useTheme()?.resolved ?? 'light'
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; value: DiffFilePatch } | { kind: 'error'; message: string }
  >({ kind: 'loading' })
  const key = ['match', matchId, against, file.path, file.a?.newSha ?? '', file.b?.newSha ?? ''].join(
    '\u0000',
  )
  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    const runId = against === 'between' ? undefined : runIds[against]
    const ask =
      against === 'between'
        ? invoke('matches.compareFile', { matchId, path: file.path })
        : invoke('diff.file', { runId: runId ?? '', seg: 'combined', path: file.path })
    void ask.then((r) => {
      if (!live) return
      setState(r.ok ? { kind: 'ready', value: r.value } : { kind: 'error', message: r.error.message })
    })
    return () => {
      live = false
    }
    // The key names everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (state.kind === 'loading') return <MessageRow testId="match-patch-loading">{LOADING_DIFF}</MessageRow>
  if (state.kind === 'error') {
    return (
      <MessageRow testId="match-patch-error" tone="error">
        {state.message}
      </MessageRow>
    )
  }
  if (state.value.patch.trim() === '') {
    return <MessageRow testId="match-patch-empty">No difference in this file.</MessageRow>
  }
  return (
    <Suspense fallback={<MessageRow testId="match-patch-loading">{LOADING_DIFF}</MessageRow>}>
      <PatchView patch={state.value.patch} cacheKey={key} layout={prefs.layout} theme={theme} />
      {state.value.truncated && (
        <MessageRow testId="match-patch-truncated">This file’s diff is too long to show whole.</MessageRow>
      )}
    </Suspense>
  )
}

function FileRow({
  matchId,
  file,
  names,
  runIds,
  between,
  order,
}: {
  matchId: string
  file: MatchCompareFile
  names: Record<MatchSide, string>
  runIds: Record<MatchSide, string | undefined>
  /** The two results can be put against each other. */
  between: boolean
  /** The sides in the order the page shows them. */
  order: readonly [MatchSide, MatchSide]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const both = file.a !== undefined && file.b !== undefined
  const only: MatchSide = file.a !== undefined ? 'a' : 'b'
  const [against, setAgainst] = useState<Against>(both && between ? 'between' : only)
  const shown: Against = both ? (against === 'between' && !between ? 'a' : against) : only
  const counts = both
    ? order.map((s) => `${names[s]} ${countsText(file[s])}`).join(', ')
    : countsText(file.a ?? file.b)
  return (
    <li data-testid={`match-file-${file.path}`} data-open={open} className="rounded-md border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{counts}</span>
      </button>
      {open && (
        <div className="border-t">
          {both && (
            <div className="flex h-9 items-center px-2">
              <Segmented<Against>
                label={`What to show for ${file.path}`}
                testId={`match-against-${file.path}`}
                options={[
                  ...(between
                    ? [
                        {
                          value: 'between' as const,
                          label: 'Against each other',
                          hint: `${names.a} on the old side, ${names.b} on the new side`,
                        },
                      ]
                    : []),
                  ...order.map((s) => ({
                    value: s,
                    label: names[s],
                    hint: `What ${names[s]} changed against the start`,
                  })),
                ]}
                value={shown}
                onChange={setAgainst}
              />
            </div>
          )}
          <FilePatch matchId={matchId} file={file} against={shown} runIds={runIds} />
        </div>
      )}
    </li>
  )
}

function Group({
  title,
  testId,
  files,
  ...rest
}: {
  title: string
  testId: string
  files: MatchCompareFile[]
  matchId: string
  names: Record<MatchSide, string>
  runIds: Record<MatchSide, string | undefined>
  between: boolean
  order: readonly [MatchSide, MatchSide]
}): React.JSX.Element | null {
  if (files.length === 0) return null
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">
        {title} ({files.length})
      </h3>
      <ul className="flex flex-col gap-1">
        {files.map((f) => (
          <FileRow key={f.path} file={f} {...rest} />
        ))}
      </ul>
    </div>
  )
}

export function MatchChanges({
  view,
  names,
  order,
  refreshKey,
}: {
  view: MatchView
  names: Record<MatchSide, string>
  /** The sides in the order the page shows them. */
  order: readonly [MatchSide, MatchSide]
  /** Changes when either side's changes may have (its run moved on). */
  refreshKey: string
}): React.JSX.Element {
  const [cmp, setCmp] = useState<MatchCompare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const matchId = view.matchId
  useEffect(() => {
    const mine = ++seq.current
    void invoke('matches.compare', { matchId }).then((r) => {
      if (mine !== seq.current) return
      if (r.ok) {
        setCmp(r.value)
        setError(null)
      } else setError(r.error.message)
    })
  }, [matchId, refreshKey])
  const runIds = { a: view.sides[0].runId, b: view.sides[1].runId }
  if (error !== null && cmp === null) {
    return (
      <MessageRow testId="match-changes-error" tone="error">
        {error}
      </MessageRow>
    )
  }
  if (cmp === null) return <MessageRow testId="match-changes-loading">{CHANGES_LOADING}</MessageRow>
  if (cmp.files.length === 0) return <MessageRow testId="match-changes-none">{NO_CHANGES}</MessageRow>
  const split = splitCompare(cmp.files)
  const shared = { matchId, names, runIds, between: cmp.available.between, order }
  const only = { a: split.onlyA, b: split.onlyB }
  return (
    <div data-testid="match-changes" className="flex flex-col gap-3">
      {!cmp.available.between && view.ready && (
        <p data-testid="match-between-gone" className="text-xs text-muted-foreground">
          {BETWEEN_GONE}
        </p>
      )}
      <Group title="Both changed, differently" testId="match-group-both" files={split.both} {...shared} />
      {order.map((s) => (
        <Group
          key={s}
          title={`Only ${names[s]} changed`}
          testId={`match-group-only-${s}`}
          files={only[s]}
          {...shared}
        />
      ))}
      <Group title="Both changed, the same way" testId="match-group-same" files={split.same} {...shared} />
    </div>
  )
}
