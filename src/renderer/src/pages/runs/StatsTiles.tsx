// The Runs page's summary tiles (`stats.get{range}` returns them). Every figure is core's StatsData; the renderer only formats it. The range is the user's (24 hours,
// 7 days, 30 days). UI control standards: each tile keeps one size from the first paint, a word in the place of
// its figure while core answers ("Loading…") or when it cannot ("Not available"), and its second line always there.
import { useEffect, useState } from 'react'
import type { StatsData, StatsRange } from '@shared/estimates.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { formatDuration, formatTokens, formatUsd } from '../../lib/format.ts'

export const STATS_TILE_RANGES: readonly { id: StatsRange; label: string }[] = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]

export const DEFAULT_STATS_RANGE: StatsRange = '7d'
export const STATS_LOADING = 'Loading…'
export const STATS_NOT_AVAILABLE = 'Not available'
/** A figure core has no samples for: a word, never a dash (UI copy standard). */
export const STATS_NONE = 'None yet'
/**
 * The second line while core answers: a no-break space (a plain space collapses in the nowrap line). The line also has
 * a fixed height, so the tile keeps its size from Loading… to the figures whatever the text.
 */
export const STATS_SUB_PLACEHOLDER = '\u00a0'

type TileName = 'runs' | 'success' | 'median' | 'cost'

const TILES: readonly { name: TileName; label: string; title: string }[] = [
  { name: 'runs', label: 'Runs', title: 'Runs started in this period' },
  {
    name: 'success',
    label: 'Success rate',
    title: 'Completed runs out of completed and failed ones; cancelled runs are not counted',
  },
  // Core takes the median over completed runs only (src/core/dashboard/stats.ts), so the copy says completed.
  { name: 'median', label: 'Median time', title: 'The middle run time of completed runs' },
  { name: 'cost', label: 'Cost', title: 'Reported by the vendors, or estimated from model prices' },
]

interface Shown {
  value: string
  sub: string
  /** The value is a word (no figure): set smaller, in the figure's line height. */
  word: boolean
}

function tileOf(name: TileName, d: StatsData): Shown {
  switch (name) {
    case 'runs':
      return {
        value: String(d.runs),
        sub: `${d.completed} completed · ${d.failed} failed · ${d.cancelled} cancelled`,
        word: false,
      }
    case 'success':
      return d.successRate === null
        ? { value: STATS_NONE, sub: 'No finished runs', word: true }
        : {
            value: `${Math.round(d.successRate * 100)}%`,
            sub: `of ${d.successSamples} finished ${d.successSamples === 1 ? 'run' : 'runs'}`,
            word: false,
          }
    case 'median':
      return d.medianDurationMs === null
        ? { value: STATS_NONE, sub: 'No completed runs', word: true }
        : { value: formatDuration(d.medianDurationMs), sub: 'per completed run', word: false }
    case 'cost':
      return { value: formatUsd(d.costUsd), sub: `${formatTokens(d.tokens)} tokens`, word: false }
  }
}

type State =
  | { status: 'loading'; range: StatsRange }
  | { status: 'ready'; range: StatsRange; data: StatsData }
  | { status: 'error'; range: StatsRange; error: string }

/** The range switch and the four tiles, in the Runs page's header. */
export function StatsTiles(): React.JSX.Element {
  const [range, setRange] = useState<StatsRange>(DEFAULT_STATS_RANGE)
  const [state, setState] = useState<State>({ status: 'loading', range: DEFAULT_STATS_RANGE })

  useEffect(() => {
    let live = true
    setState({ status: 'loading', range })
    void invoke('stats.get', { range }).then((r) => {
      if (!live) return
      setState(
        r.ok ? { status: 'ready', range, data: r.value } : { status: 'error', range, error: r.error.message },
      )
    })
    return () => {
      live = false
    }
  }, [range])

  const shown = (name: TileName): Shown => {
    if (state.status === 'ready') return tileOf(name, state.data)
    if (state.status === 'loading') return { value: STATS_LOADING, sub: STATS_SUB_PLACEHOLDER, word: true }
    return { value: STATS_NOT_AVAILABLE, sub: 'Could not be loaded', word: true }
  }

  return (
    <section
      aria-label="Summary"
      data-testid="runs-stats"
      data-status={state.status}
      aria-busy={state.status === 'loading' || undefined}
      className="@container flex flex-col gap-2"
    >
      <div role="group" aria-label="Period" className="inline-flex self-start rounded-md border p-0.5">
        {STATS_TILE_RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={range === r.id}
            data-testid={`runs-stats-range-${r.id}`}
            onClick={() => setRange(r.id)}
            // Selection is the background only: a bolder label would widen the segment and move its neighbours.
            className={cn(
              'rounded px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
              range === r.id ? 'bg-secondary text-secondary-foreground' : 'hover:bg-accent',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-2 @min-[36rem]:grid-cols-4">
        {TILES.map(({ name, label, title }) => {
          const t = shown(name)
          const err = state.status === 'error' ? state.error : undefined
          return (
            <div
              key={name}
              data-testid={`runs-stat-${name}`}
              title={err !== undefined ? `${title}. ${err}` : title}
              className="flex min-w-0 flex-col rounded-lg border bg-card px-3 py-2"
            >
              <dt className="truncate text-xs text-muted-foreground">{label}</dt>
              <dd
                data-testid={`runs-stat-${name}-value`}
                title={t.value}
                className={cn(
                  'truncate text-lg leading-7 font-semibold tabular-nums',
                  // The figure's line height kept (text-sm would set its own): a word never changes the tile's height.
                  t.word && 'text-sm leading-7 font-normal text-muted-foreground',
                )}
              >
                {t.value}
              </dd>
              <dd
                data-testid={`runs-stat-${name}-sub`}
                // One fixed line (h-4 = the text-xs line height): the tile never changes height with its text.
                className="h-4 truncate text-xs leading-4 text-muted-foreground tabular-nums"
                title={t.sub.trim() !== '' ? t.sub : undefined}
              >
                {t.sub}
              </dd>
            </div>
          )
        })}
      </dl>
    </section>
  )
}
