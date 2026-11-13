// The end panel's Context and Context health sections: per pass how full its context got (peak), how often the
// vendor summarised it, what was there before the task (baseline) and its largest contributors; then the health items
// core's detectors found, each with what to try. Core decides everything (RunSnapshot.contextHealth); this only words
// it (text.ts). "Lower Extensions for this pass" is a link to Settings › Extensions, never a change made for the user.
// UI standards: a table that wraps its cells instead of scrolling (no new scroll region), no buttons, and
// it is there as soon as the panel is (the snapshot carries it), so nothing arrives later and moves the page.
import type { ContextHealthReport } from '@shared/context.ts'
import { stepLabel } from '../../lib/format.ts'
import { cn } from '../../lib/cn.ts'
import { href } from '../../lib/router.ts'
import {
  CONTEXT_HEALTH_NONE,
  CONTEXT_HEALTH_TITLE,
  CONTEXT_SECTION_TITLE,
  CONTEXT_SUGGESTION_TEXT,
  aboutTokens,
  contributorText,
  healthItemText,
} from './text.ts'

export function ContextHealthSection({ report }: { report: ContextHealthReport }): React.JSX.Element {
  return (
    <>
      <section
        aria-label={CONTEXT_SECTION_TITLE}
        data-testid="run-end-context"
        className="flex flex-col gap-1.5"
      >
        <h4 className="text-sm font-semibold">{CONTEXT_SECTION_TITLE}</h4>
        <table className="w-full table-fixed text-left text-sm" data-testid="run-end-context-table">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-[22%] pr-2 font-medium">
                Pass
              </th>
              <th scope="col" className="w-[12%] pr-2 font-medium">
                Peak
              </th>
              <th scope="col" className="w-[14%] pr-2 font-medium">
                Summaries
              </th>
              <th scope="col" className="w-[16%] pr-2 font-medium">
                Before task
              </th>
              <th scope="col" className="font-medium">
                Largest contributors
              </th>
            </tr>
          </thead>
          <tbody>
            {report.passes.map((p) => (
              <tr key={p.step} data-testid={`run-end-context-${p.step}`} className="align-top">
                <td className="pr-2 break-words">{stepLabel(p.step)}</td>
                <td className="pr-2 tabular-nums">
                  {p.peakPercent !== undefined ? `${p.peakPercent}%` : 'n/a'}
                </td>
                <td
                  className={cn('pr-2 tabular-nums', p.compactions >= 2 && 'text-warning')}
                  data-warn={p.compactions >= 2 || undefined}
                >
                  {p.compactions}
                </td>
                <td className="pr-2 tabular-nums">
                  {p.baseline !== undefined ? aboutTokens(p.baseline) : 'n/a'}
                </td>
                <td className="break-words text-muted-foreground">
                  {p.contributors.length > 0
                    ? p.contributors.map(contributorText).join(', ')
                    : 'None reported'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section
        aria-label={CONTEXT_HEALTH_TITLE}
        data-testid="run-end-context-health"
        className="flex flex-col gap-1.5"
      >
        <h4 className="text-sm font-semibold">{CONTEXT_HEALTH_TITLE}</h4>
        {report.items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="run-end-context-health-none">
            {CONTEXT_HEALTH_NONE}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="run-end-context-health-items">
            {report.items.map((item, i) => {
              const suggestion = CONTEXT_SUGGESTION_TEXT[item.suggestion]
              return (
                <li
                  key={`${item.id}-${item.step}-${i}`}
                  data-detector={item.id}
                  data-strong={item.strong || undefined}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="shrink-0 text-xs text-muted-foreground">{stepLabel(item.step)}</span>
                  <span className={cn('min-w-0 break-words', item.strong && 'text-warning')}>
                    {healthItemText(item)}
                  </span>
                  {suggestion !== '' &&
                    (item.suggestion === 'lower-extensions' ? (
                      // A link only: Dim Factory never lowers a pass's Extensions itself.
                      <a
                        href={href({ name: 'settings', section: 'extensions' })}
                        className="min-w-0 break-words text-primary underline-offset-4 hover:underline"
                        data-testid="context-lower-extensions"
                      >
                        {suggestion}
                      </a>
                    ) : (
                      <span className="min-w-0 break-words text-muted-foreground">{suggestion}</span>
                    ))}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}
