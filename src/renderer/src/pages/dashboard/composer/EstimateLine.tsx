// The composer's estimate line: core's RunEstimate formatted as
// `≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs`, `+ your review time` while a gate is on, and the per-step table
// (step, p50–p80 duration, cost, basis) on hover or keyboard focus. The renderer never computes an estimate.
// The line is a button whose box spans the row (UI control standard: a button never changes size when its text
// changes), so a new estimate (another model or profile, history arriving) changes only the text in it; a line too long
// for the row is cut with an ellipsis, and the table then repeats it in full.
// The table names the pricing the cost comes from as core describes it ("est. from
// pricing fetched <date> (unverified)"), and the line is amber while core says those prices are stale.
import { Clock } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { RunEstimate } from '@shared/estimates.ts'
import { cn } from '../../../lib/cn.ts'
import { pricingTitle, usePricingFacts } from '../../../lib/pricing.ts'
import { estimateLineParts, estimateRows, pFixText } from './model.ts'

/**
 * The estimate line's place while there is no estimate to show (core is estimating, no folder yet): one muted line
 * of the same height, so the estimate arriving moves nothing (UI standard: async content never shifts the page).
 */
export function EstimatePending({ text }: { text: string }): React.JSX.Element {
  return (
    <p
      data-testid="estimate-pending"
      className="flex h-5 min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground"
    >
      <Clock aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </p>
  )
}

export function EstimateLine({
  estimate,
  gateOn,
}: {
  estimate: RunEstimate
  gateOn: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [cut, setCut] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  const tableId = useId()
  const text = estimateLineParts(estimate.total, gateOn).join(' · ')
  const rows = estimateRows(estimate)
  const facts = usePricingFacts()
  const priced = estimate.total.costUsd !== null
  const stale = priced && facts?.stale === true
  const show = (): void => {
    const el = textRef.current
    setCut(el !== null && el.scrollWidth > el.clientWidth)
    setOpen(true)
  }
  const shown = open && (rows.length > 0 || cut)
  return (
    <div className="relative min-w-0" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        data-testid="estimate-line"
        data-stale-prices={stale || undefined}
        // It says more on hover and focus (its own table, with the whole line when it is cut).
        data-tooltip=""
        aria-describedby={shown ? tableId : undefined}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={show}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        className={cn(
          'flex h-5 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
          stale ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Clock aria-hidden className="size-3.5 shrink-0" />
        <span ref={textRef} className="min-w-0 truncate">
          {text}
        </span>
      </button>
      {shown && (
        <div
          id={tableId}
          role="tooltip"
          data-testid="estimate-table"
          className="absolute bottom-full left-0 z-30 mb-1 max-w-full min-w-80 rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        >
          {cut && (
            <p data-testid="estimate-full" className="mb-1.5 tabular-nums">
              {text}
            </p>
          )}
          {rows.length > 0 && (
            <table className="w-full border-collapse tabular-nums">
              <caption className="sr-only">Estimate per step</caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="pr-3 font-medium">
                    Step
                  </th>
                  <th scope="col" className="pr-3 font-medium">
                    Time
                  </th>
                  <th scope="col" className="pr-3 font-medium">
                    Cost
                  </th>
                  <th scope="col" className="font-medium">
                    Based on
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-step={r.key}>
                    <th scope="row" className="pr-3 text-left font-normal">
                      {r.label}
                    </th>
                    <td className="pr-3">{r.time}</td>
                    <td className="pr-3">{r.cost}</td>
                    <td className="text-muted-foreground">{r.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length > 0 && estimate.steps.fix !== undefined && (
            <p className="mt-1.5 text-muted-foreground">{pFixText(estimate.pFix)}</p>
          )}
          {priced && facts !== null && (
            <p
              data-testid="estimate-pricing"
              className={cn('mt-1', stale ? 'text-warning' : 'text-muted-foreground')}
            >
              Cost {pricingTitle(facts)}
            </p>
          )}
          <p className="mt-1 text-muted-foreground">Time while a run waits for you is not included.</p>
        </div>
      )}
    </div>
  )
}
