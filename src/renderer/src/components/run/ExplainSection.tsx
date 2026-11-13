// "Explain it to me" in the run's end panel: explain.md (the plain-language summary the Explain step wrote: what was
// built, how to run it, what to try next, known limits), read through runs.output and shown with the light markdown
// component, inline in the page's scroll region (no scroll box of its own). It sits last in the panel, so the text
// arriving moves nothing below it; while it loads, one line holds its place.
import type { RunSnapshot } from '@shared/run.ts'
import { LightMarkdown } from './LightMarkdown.tsx'
import { useRunOutput } from './outputs.ts'

export const EXPLAIN_TITLE = 'Explain it to me'

/** The Explain step wrote explain.md: done, and not with an empty answer. */
export function explainWritten(snap: RunSnapshot): boolean {
  const v = snap.steps.explain
  return v.status === 'done' && v.reason !== 'empty answer'
}

export function ExplainSection({ snap }: { snap: RunSnapshot }): React.JSX.Element | null {
  const v = snap.steps.explain
  const written = explainWritten(snap)
  const out = useRunOutput(snap.summary.runId, 'explain', `${v.attempt}:${v.status}`, written)
  if (!written) return null
  return (
    <section aria-label={EXPLAIN_TITLE} data-testid="run-end-explain" className="flex flex-col gap-1.5">
      <h4 className="text-sm font-semibold">{EXPLAIN_TITLE}</h4>
      {out.status === 'loading' && <p className="text-sm text-muted-foreground">Loading the summary…</p>}
      {out.status === 'missing' && (
        <p className="text-sm text-muted-foreground">The summary file is not in the run folder.</p>
      )}
      {out.status === 'error' && <p className="text-sm text-st-failed">{out.message}</p>}
      {out.status === 'ready' && (
        <div data-testid="run-end-explain-text">
          <LightMarkdown text={out.output.text} className="text-sm" />
        </div>
      )}
    </section>
  )
}
