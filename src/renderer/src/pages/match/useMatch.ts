// A match as core has it (`matches.get`), read again when core says its record changed (the `match` event) and when
// either side's run moves on (its summary's status, phase, copy or counts). Only the newest answer is kept.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MatchView } from '@shared/match.ts'
import type { RunSummary } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { useMatchEpoch } from '../../state/matches.ts'
import { useSummary } from '../../state/selectors.ts'

/** What of a side's run makes the match worth reading again (not its token count, which moves all the time). */
export function sideKey(s: RunSummary | undefined): string {
  if (s === undefined) return ''
  return [
    s.status,
    s.phase,
    s.outcome ?? '',
    s.worktree?.state ?? '',
    s.worktree?.notApplied === true ? 'n' : '',
    s.progress.filesChanged,
    s.findings.must,
    s.findings.should,
    s.endedAt ?? '',
  ].join('|')
}

export interface MatchLoad {
  view: MatchView | null
  /** Why the match could not be read (UI words), until it can. */
  error: string | null
  /** Take a command's answer as the newest view. */
  set: (v: MatchView) => void
  a: RunSummary | undefined
  b: RunSummary | undefined
}

export function useMatch(matchId: string): MatchLoad {
  const [view, setView] = useState<MatchView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const epoch = useMatchEpoch(matchId)
  const a = useSummary(view?.sides[0].runId ?? '')
  const b = useSummary(view?.sides[1].runId ?? '')
  // The sides' runs as they stood when the match was last read: a later change of either is a reason to read again.
  const key = view === null ? null : `${sideKey(a)}#${sideKey(b)}`
  const seq = useRef(0)
  const readAt = useRef<string | null>(null)
  const [stale, setStale] = useState(0)
  useEffect(() => {
    if (key === null) return
    if (readAt.current === null) readAt.current = key
    else if (readAt.current !== key) {
      readAt.current = key
      setStale((n) => n + 1)
    }
  }, [key])
  useEffect(() => {
    const mine = ++seq.current
    void invoke('matches.get', { matchId }).then((r) => {
      if (mine !== seq.current) return
      if (r.ok) {
        setView(r.value)
        setError(null)
      } else setError(r.error.message)
    })
  }, [matchId, epoch, stale])
  const set = useCallback((v: MatchView) => {
    // A read still in flight is older than this answer.
    seq.current++
    setView(v)
    setError(null)
  }, [])
  return { view, error, set, a, b }
}
