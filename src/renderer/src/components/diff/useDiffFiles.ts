// The Diff tab's file list (IPC `diff.files`, `diff.markReviewed`): core's DiffFiles for
// one segment, fetched again whenever the run's diff can have moved (the caller's refresh key: status, phase, files
// changed), with the reviewed marks the viewer sets on top. A mark is for the segment shown (what the user read), is
// shown at once and sent to core (runs/<id>/review-state.json, so it lasts across a reload); until core's own list
// carries it, a list fetched before the mark was stored never takes it back. Out-of-order answers are dropped. The
// renderer decides nothing here: the files, their statuses and counts, the segments and the reviewed set are core's.
//
// Nothing moves on its own (UI standard): a list core sends because the run moved on (a new snapshot,
// the run's end) while the shown one came from a live run is held as `pending` when it would change what is laid out
// (files, their facts, the segments), and shown when the user asks (`showPending`). Its reviewed marks apply at once
// (they change no layout). A list the user asked for (opening the tab, a segment, a revert's refresh) shows at once,
// and so does one after a run that has ended (only the user's own reverts and edits change it then).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFiles, DiffSegment, FileChange, ResultCode } from '@shared/ipc.ts'
import { invoke } from '../../ipc/client.ts'
import { toast } from '../../state/toasts.ts'

export type FilesState =
  | { kind: 'loading' }
  | { kind: 'error'; code: ResultCode; message: string; seg: DiffSegment }
  | { kind: 'ready'; data: DiffFiles }

export interface DiffFilesApi {
  state: FilesState
  /** True while a fetch for the shown segment (or a newly chosen one) is out. */
  fetching: boolean
  /** Core's reviewed set with the viewer's marks on top. */
  reviewed: ReadonlySet<string>
  /**
   * Mark paths reviewed or not, for the segment whose list is shown (or `seg`); resolves to whether core stored it (an
   * error toast says why not).
   */
  setReviewed: (paths: readonly string[], value: boolean, seg?: DiffSegment) => Promise<boolean>
  /** Fetch the list again now and show it (after a revert or its undo: the user's own change). */
  refresh: () => void
  /** A newer list held back because showing it would move the page (null when there is none). */
  pending: DiffFiles | null
  /** Show the held list (the user asked). */
  showPending: () => void
}

interface Mark {
  seg: DiffSegment
  path: string
  value: boolean
  /** Dropped once an answer to a request numbered above this arrives (core's list then carries the mark). */
  until: number
}

const markKey = (seg: DiffSegment, path: string): string => `${seg}\u0000${path}`

/** The facts of a row that the viewer lays out (its height, its place, its chips). */
const ROW_FACTS = [
  'status',
  'path',
  'oldPath',
  'oldMode',
  'newMode',
  'oldSha',
  'newSha',
  'added',
  'deleted',
  'binary',
  'gitlink',
  'eolOnly',
  'similarity',
  'modeChanged',
  'large',
  'editedAfterRun',
  'changedByFix',
] as const satisfies readonly (keyof FileChange)[]

/** Would showing `next` instead of `shown` change what the tab lays out? (Reviewed marks never do.) */
export function changesLayout(shown: DiffFiles, next: DiffFiles): boolean {
  if (shown.seg !== next.seg || shown.persisted !== next.persisted) return true
  if (shown.revertUnavailable !== next.revertUnavailable) return true
  if (shown.available.join() !== next.available.join()) return true
  if (shown.files.length !== next.files.length) return true
  return shown.files.some((a, i) => {
    const b = next.files[i]
    return b === undefined || ROW_FACTS.some((k) => a[k] !== b[k])
  })
}

interface Held {
  data: DiffFiles
  /** Its request number. */
  n: number
  /** The run was live when it was asked for. */
  live: boolean
}

/**
 * `live`: the run is active now (queued, running, waiting, paused), so core's next list may come from the run, not the
 * user.
 */
export function useDiffFiles(
  runId: string,
  seg: DiffSegment,
  refreshKey: string,
  live: boolean,
): DiffFilesApi {
  const [state, setState] = useState<FilesState>({ kind: 'loading' })
  const [fetching, setFetching] = useState(true)
  const [marks, setMarks] = useState<ReadonlyMap<string, Mark>>(new Map())
  const [nonce, setNonce] = useState(0)
  const [pending, setPending] = useState<Held | null>(null)
  /** The last request issued and the last answer applied (request numbers). */
  const issued = useRef(0)
  const applied = useRef(0)
  const mounted = useRef(true)
  /** The segment of the list on screen: marks are for what the user reads, even while another segment loads. */
  const shownSeg = useRef(seg)
  /** The list on screen came from a live run: the run's own next lists are held. */
  const shownLive = useRef(false)
  const liveNow = useRef(live)
  /** What the last request was made for: a change of the segment or a refresh is the user's. */
  const asked = useRef<{ seg: DiffSegment; nonce: number; runId: string } | null>(null)
  const stateRef = useRef(state)

  useEffect(() => {
    liveNow.current = live
    stateRef.current = state
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Core's reviewed set for a segment now carries the marks set before request `n`. */
  const dropCarriedMarks = useCallback((forSeg: DiffSegment, n: number) => {
    setMarks((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Map(prev)
      for (const [key, m] of prev) {
        if (m.seg === forSeg && n > m.until) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const show = useCallback(
    (data: DiffFiles, n: number, wasLive: boolean) => {
      shownSeg.current = data.seg
      shownLive.current = wasLive
      setState({ kind: 'ready', data })
      setPending((p) => (p !== null && p.n <= n ? null : p))
      dropCarriedMarks(data.seg, n)
    },
    [dropCarriedMarks],
  )

  useEffect(() => {
    const n = ++issued.current
    const prev = asked.current
    const byUser = prev === null || prev.seg !== seg || prev.nonce !== nonce || prev.runId !== runId
    asked.current = { seg, nonce, runId }
    const wasLive = liveNow.current
    setFetching(true)
    void invoke('diff.files', { runId, seg }).then((r) => {
      if (!mounted.current || n < applied.current) return
      applied.current = n
      if (n === issued.current) setFetching(false)
      const shown = stateRef.current
      const ready = shown.kind === 'ready' && shown.data.seg === seg ? shown.data : null
      if (!r.ok) {
        // A list on screen stays when a refresh the run caused fails; the user's own request says why.
        if (ready !== null && !byUser) return
        setState({ kind: 'error', code: r.error.code, message: r.error.message, seg })
        return
      }
      const hold =
        !byUser && ready !== null && (shownLive.current || liveNow.current) && changesLayout(ready, r.value)
      if (!hold) {
        show(r.value, n, wasLive)
        return
      }
      // Held: only its reviewed marks show now (checkboxes, no layout).
      setState({ kind: 'ready', data: { ...ready, reviewed: r.value.reviewed } })
      dropCarriedMarks(r.value.seg, n)
      setPending({ data: r.value, n, live: wasLive })
    })
  }, [runId, seg, refreshKey, nonce, show, dropCarriedMarks])

  const shownData = state.kind === 'ready' ? state.data : null
  const reviewed = useMemo(() => {
    const set = new Set(shownData?.reviewed ?? [])
    for (const m of marks.values()) {
      if (m.seg !== shownData?.seg) continue
      if (m.value) set.add(m.path)
      else set.delete(m.path)
    }
    return set
  }, [shownData, marks])

  const setReviewed = useCallback(
    async (paths: readonly string[], value: boolean, forSeg?: DiffSegment): Promise<boolean> => {
      if (paths.length === 0) return true
      const markSeg = forSeg ?? shownSeg.current
      setMarks((prev) => {
        const next = new Map(prev)
        for (const path of paths)
          next.set(markKey(markSeg, path), { seg: markSeg, path, value, until: Number.POSITIVE_INFINITY })
        return next
      })
      const r = await invoke('diff.markReviewed', { runId, seg: markSeg, paths: [...paths], reviewed: value })
      if (!mounted.current) return r.ok
      // Stored (or not): an answer to any request issued from now on carries core's own reading.
      const until = issued.current
      setMarks((prev) => {
        const next = new Map(prev)
        for (const path of paths) {
          const key = markKey(markSeg, path)
          const m = next.get(key)
          if (m === undefined || m.value !== value) continue
          if (r.ok) next.set(key, { ...m, until })
          else next.delete(key)
        }
        return next
      })
      if (!r.ok) toast({ level: 'error', message: r.error.message })
      return r.ok
    },
    [runId],
  )

  const refresh = useCallback(() => setNonce((x) => x + 1), [])
  const showPending = useCallback(() => {
    if (pending === null) return
    show(pending.data, pending.n, pending.live)
  }, [pending, show])

  // A held list is for the segment shown; another segment's list replaces it.
  const pendingData =
    pending !== null && shownData !== null && pending.data.seg === shownData.seg ? pending.data : null
  return { state, fetching, reviewed, setReviewed, refresh, pending: pendingData, showPending }
}
