// Today's summary tiles and 7-day spend by vendor.
// Every figure is core's (`DashboardData.totals`, `spendByVendor7d`); the renderer adds nothing up. Bar lengths are
// only each vendor's share of the largest bar. A core without dashboard.get keeps the disabled tiles.
import type { DashboardData, PeriodTotals, VendorSpend } from '@shared/estimates.ts'
import { DisabledHint } from '../../../components/ui/DisabledHint.tsx'
import { cn } from '../../../lib/cn.ts'
import {
  API_EQUIVALENT,
  API_EQUIVALENT_HINT,
  formatTokens,
  formatUsd,
  vendorName,
} from '../../../lib/format.ts'
import type { DashboardState } from './dashboardData.ts'

export const TILES = [
  { name: 'runs', label: 'Runs' },
  { name: 'completed', label: 'Completed' },
  { name: 'failed', label: 'Failed' },
  { name: 'cost', label: 'Cost' },
] as const

type TileName = (typeof TILES)[number]['name']

function tileValue(name: TileName, t: PeriodTotals): string {
  switch (name) {
    case 'runs':
      return String(t.runs)
    case 'completed':
      return String(t.completed)
    case 'failed':
      return String(t.failed)
    case 'cost':
      return formatUsd(t.costUsd)
  }
}

/** A tile without a figure gets a word, never a dash (UI copy standard). */
export const TILE_NOT_AVAILABLE = 'Not available'
export const TILE_LOADING = 'Loading…'
const TILE_WORD = 'text-sm leading-7 font-normal text-muted-foreground'

const TILE_TITLE: Readonly<Partial<Record<TileName, string>>> = {
  failed: 'Runs that failed, or finished with a failed outcome',
  cost: 'Reported by the vendors, or estimated from model prices',
}

/** The disabled tiles: core's period totals are not available from this core. */
function DisabledTiles(): React.JSX.Element {
  return (
    <DisabledHint className="flex">
      <dl className="grid flex-1 grid-cols-2 gap-2 opacity-60" data-testid="today-tiles">
        {TILES.map(({ name, label }) => (
          <div key={name} className="flex flex-col rounded-lg border bg-card px-3 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn('text-lg font-semibold tabular-nums', TILE_WORD)} data-testid={`today-${name}`}>
              {TILE_NOT_AVAILABLE}
            </dd>
          </div>
        ))}
      </dl>
    </DisabledHint>
  )
}

function Tiles({ totals, loading }: { totals: PeriodTotals | null; loading: boolean }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-2" data-testid="today-tiles">
      {TILES.map(({ name, label }) => (
        <div
          key={name}
          data-testid={`summary-tile-${name}`}
          title={TILE_TITLE[name]}
          className="flex flex-col rounded-lg border bg-card px-3 py-2"
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd
            className={cn(
              'text-lg font-semibold tabular-nums',
              totals === null && TILE_WORD,
              name === 'failed' && totals !== null && totals.failed > 0 && 'text-st-failed',
            )}
          >
            {totals !== null ? tileValue(name, totals) : loading ? TILE_LOADING : TILE_NOT_AVAILABLE}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SpendRow({ s, max }: { s: VendorSpend; max: number }): React.JSX.Element {
  const share = max > 0 ? Math.max(2, Math.round((s.costUsd / max) * 100)) : 0
  const cost = formatUsd(s.costUsd)
  return (
    <li className="flex flex-col gap-1" data-vendor={s.vendor}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium">{vendorName(s.vendor)}</span>
        <span className="ml-auto tabular-nums" title={s.apiEquivalent ? API_EQUIVALENT_HINT : undefined}>
          {cost}
          {s.apiEquivalent && <span className="text-muted-foreground"> · {API_EQUIVALENT}</span>}
        </span>
        <span className="w-16 text-right text-muted-foreground tabular-nums">
          {formatTokens(s.tokens)} tok
        </span>
      </div>
      <div aria-hidden className="h-1.5 w-full rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${share}%` }} />
      </div>
    </li>
  )
}

function SpendByVendor({ data }: { data: DashboardData }): React.JSX.Element {
  const rows = data.spendByVendor7d
  const max = rows.reduce((m, r) => Math.max(m, r.costUsd), 0)
  return (
    <section aria-labelledby="spend-heading" data-testid="spend-by-vendor" className="flex flex-col gap-2">
      <h3 id="spend-heading" className="flex items-baseline gap-2 text-xs font-semibold">
        Spend, last 7 days
        <span className="ml-auto font-normal text-muted-foreground tabular-nums">
          {formatUsd(data.totals.d7.costUsd)} · {data.totals.d7.runs}{' '}
          {data.totals.d7.runs === 1 ? 'run' : 'runs'}
        </span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No spend in the last 7 days.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <SpendRow key={r.vendor} s={r} max={max} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function SummaryTiles({ dashboard }: { dashboard: DashboardState }): React.JSX.Element {
  const { status, data } = dashboard
  return (
    <section aria-labelledby="today-heading" className="flex flex-col gap-3">
      <h2 id="today-heading" className="text-sm font-semibold">
        Today
      </h2>
      {status === 'unsupported' ? (
        <DisabledTiles />
      ) : (
        <Tiles totals={data?.totals.today ?? null} loading={status === 'loading'} />
      )}
      {status === 'error' && (
        <p className="text-xs text-destructive" role="status">
          Totals could not be loaded: {dashboard.error}
        </p>
      )}
      {data !== null && <SpendByVendor data={data} />}
    </section>
  )
}
