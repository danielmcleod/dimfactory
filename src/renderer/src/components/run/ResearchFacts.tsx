// The Research step's facts on its card: the lenses it researches and whether it searches the web (from the run's
// start, so nothing appears mid-run), then a status line (waiting for the review below, what was kept, Auto's choice,
// skipped, or core's note), and once chosen the kept items. Presentation only: everything is core's (StepView.research).
import type { ResearchView } from '@shared/research.ts'
import { cn } from '../../lib/cn.ts'

/** The kept items of a chosen view, as short lines (features, standards, recommendations, answered questions). */
export function keptLines(v: ResearchView): string[] {
  const r = v.result
  if (r === undefined || v.status !== 'chosen') return []
  const keep = new Set(v.chosen ?? [])
  const out: string[] = []
  for (const f of r.features) if (keep.has(f.id)) out.push(`${f.feature} (${f.priority})`)
  for (const s of r.standards) if (keep.has(s.id)) out.push(s.standard)
  for (const o of r.options) if (keep.has(o.id)) out.push(`${o.topic}: ${o.recommendation}`)
  for (const q of r.questions) {
    const a = v.answers?.[q.id]
    if (a !== undefined && a !== '') out.push(`${q.question} ${a}`)
  }
  return out
}

/** The line under the Research step's header. */
export function researchLine(v: ResearchView): string {
  const n = v.lenses.length
  switch (v.status) {
    case 'pending':
      return `${n} ${n === 1 ? 'lens' : 'lenses'}, ${v.web ? 'with web search' : 'this repository only (no web)'}`
    case 'reviewing':
      return 'Findings waiting for your review below'
    case 'chosen': {
      const k = keptLines(v).length
      const what = `${k} ${k === 1 ? 'item' : 'items'}`
      return v.auto === true
        ? `Auto kept ${what}: the must-haves and recommendations`
        : `You kept ${what} for Plan`
    }
    case 'skipped':
      return 'Plan goes on without the research'
    case 'none':
      return v.note !== undefined && v.note !== '' ? v.note : 'Research found nothing usable'
  }
}

export function ResearchFacts({ view }: { view: ResearchView }): React.JSX.Element {
  const kept = keptLines(view)
  return (
    <div className="flex flex-col gap-1" data-testid="research-facts" data-status={view.status}>
      <p className="flex flex-wrap gap-1 text-xs text-muted-foreground" data-testid="research-lenses">
        {view.lenses.map((l) => (
          <span key={l.id} className="rounded border px-1.5 py-px" data-web={l.web || undefined}>
            {l.label}
          </span>
        ))}
      </p>
      <p
        data-testid="research-line"
        className={cn('text-xs', view.status === 'reviewing' ? 'text-st-waiting' : 'text-muted-foreground')}
      >
        {researchLine(view)}
      </p>
      {kept.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-4 text-sm" data-testid="research-kept">
          {kept.map((l, i) => (
            <li key={i} className="list-disc break-words">
              {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
