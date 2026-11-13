// A verify round's combined output in the Run view (the round's log; UI standards: one scroll region per screen,
// nothing moves on its own). Core writes the round's
// output to the run file `verify:<n>` and announces each new version with an `output` body; this reads the newest
// version (at most every READ_EVERY_MS while the round runs) and shows its last VERIFY_OUTPUT_TAIL characters.
// The pane is an allowed inner region (data-scroll-region="verify-output") with a fixed maximum height: it follows
// new output only while the user is at its bottom, offers "Jump to latest" otherwise, and never scrolls the page.
// While the round runs it has its full height from the start, and keeps it, so nothing below it moves.
// A core that streams the round as step events instead is shown through the stream buffer (StreamPane).
import { memo, useEffect, useRef, useState } from 'react'
import type { RunOutputFile, StepKey } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { useStream } from '../../lib/streamBuffer.ts'
import { JumpToLatest, REGION, useFollowBottom } from './follow.tsx'
import { useLastEnvelope } from './runLog.ts'
import { StreamPane } from './StreamPane.tsx'
import { verifyOutputFile } from './VerifyModel.ts'

/** The most of a round's output the pane holds (characters, the newest): the whole log stays in the run folder. */
export const VERIFY_OUTPUT_TAIL = 64 * 1024
/** While the round runs, its output is read again at most this often (ms), whatever core's announcement rate. */
export const READ_EVERY_MS = 500

/** The pane's height: fixed while live (and after, while shown), else at most this (Run view: --run-region-max). */
export const VERIFY_REGION_MAX = 'max-h-[min(20rem,var(--run-region-max,50vh))]'
const LIVE_HEIGHT = `h-[min(20rem,var(--run-region-max,50vh))] ${VERIFY_REGION_MAX}`

/** The text's newest part that fits the pane's cap, starting at a line. */
export function tailText(text: string, cap: number = VERIFY_OUTPUT_TAIL): { text: string; cut: boolean } {
  if (text.length <= cap) return { text, cut: false }
  const start = text.length - cap
  const nl = text.indexOf('\n', start)
  return { text: nl === -1 || nl - start > 400 ? text.slice(start) : text.slice(nl + 1), cut: true }
}

export interface OutputText {
  text: string | null
  error: string | null
}

/**
 * The newest text of a run output file: read when `version` changes (`'final'` reads once without a version), at most
 * every READ_EVERY_MS, with an answer applied only when it is newer than the one shown.
 */
export function useOutputText(runId: string, file: RunOutputFile | null, version: string | null): OutputText {
  const [state, setState] = useState<OutputText & { key: string }>({ key: '', text: null, error: null })
  const lastRead = useRef(Number.NEGATIVE_INFINITY)
  const sent = useRef(0)
  const applied = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const key = `${runId}\u0000${file ?? ''}`
  useEffect(() => {
    if (file === null || version === null) return
    const wait = Math.max(0, lastRead.current + READ_EVERY_MS - Date.now())
    const t = setTimeout(() => {
      lastRead.current = Date.now()
      const n = ++sent.current
      void invoke('runs.output', { runId, file }).then((r) => {
        if (!mounted.current || n < applied.current) return
        applied.current = n
        if (r.ok) setState({ key, text: r.value.text, error: null })
        else if (r.error.code !== 'NOT_FOUND')
          setState((s) => ({ key, text: s.key === key ? s.text : null, error: r.error.message }))
      })
    }, wait)
    return () => clearTimeout(t)
  }, [runId, file, version, key])
  return state.key === key ? { text: state.text, error: state.error } : { text: null, error: null }
}

export interface VerifyOutputProps {
  runId: string
  step: StepKey
  attempt: number
  /** The round is live (running or waiting on a card): the pane takes its full height and keeps it. */
  live: boolean
  /** Shown while there is no output yet. */
  waiting: React.ReactNode
}

export const VerifyOutput = memo(function VerifyOutput({
  runId,
  step,
  attempt,
  live,
  waiting,
}: VerifyOutputProps): React.JSX.Element {
  const file = verifyOutputFile(step)
  const announced = useLastEnvelope(runId, 'output', (b) => b.file === file, {
    enabled: file !== null,
    key: attempt,
  })
  // A finished round core announced nothing for is read once (an older log, or output written in one go).
  const version =
    announced !== undefined && announced !== null
      ? String(announced.body.version)
      : announced === null && !live
        ? 'final'
        : null
  const out = useOutputText(runId, file, version)
  const stream = useStream(runId, step)
  const shown = out.text !== null ? tailText(out.text) : null

  const { ref, innerRef, onScroll, atBottom, jumpToLatest } = useFollowBottom<HTMLDivElement>(
    shown?.text.length ?? 0,
    true,
  )
  // Once the pane has had its live height it keeps it while shown: a round that finishes never shrinks it.
  const [fixed, setFixed] = useState(live)
  if (live && !fixed) setFixed(true)

  if (shown === null && stream.blocks.length > 0) {
    return <StreamPane runId={runId} step={step} waiting={waiting} live={live} />
  }
  return (
    <div className="relative">
      <div
        ref={ref}
        role="log"
        aria-live="off"
        aria-label="Output of the verify commands"
        tabIndex={0}
        data-testid={`verify-output-${step}`}
        data-scroll-region="verify-output"
        onScroll={onScroll}
        className={cn(
          'stream-text rounded-md bg-muted/40 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
          REGION,
          fixed ? LIVE_HEIGHT : VERIFY_REGION_MAX,
        )}
      >
        <div ref={innerRef}>
          {shown?.cut === true && (
            <p className="pb-1 text-xs text-muted-foreground" data-testid={`verify-output-cut-${step}`}>
              Showing the newest output only. The whole log is kept with the run.
            </p>
          )}
          {shown !== null && shown.text !== '' ? (
            <pre className="break-words whitespace-pre-wrap">{shown.text}</pre>
          ) : (
            <div className="text-xs text-muted-foreground">
              {out.error !== null ? `The output could not be read: ${out.error}` : waiting}
            </div>
          )}
        </div>
      </div>
      {!atBottom && <JumpToLatest testId={`verify-output-jump-${step}`} onClick={jumpToLatest} />}
    </div>
  )
})
