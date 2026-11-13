// Plops (`#/plops`): AI usage over the last 30 or 7 days as a lineup of Plops, one per vendor; choosing a vendor shows
// its models on one shared floor after an "All <vendor>" Plop. Every figure is core's (`usage.get{range}`, from the
// runs' per-step usage); lineup.ts words them and applies the Plop rules.
//
// UI standards: the period buttons and the vendor buttons keep one size whatever is chosen (selection is a background
// and an inset ring, never a bolder label or a border); <main> is the only scroller; nothing moves on its own except
// the Plops' own loops, their rotation of snacks and emissions and their snacks at rest (plopAnimation.ts, capped
// page-wide by one SnackGate), drawn inside a box of fixed size; all of that stops under prefers-reduced-motion. While core answers a new period the old lineup
// stays (aria-busy), so the page never collapses and grows back.
import { Sparkles } from 'lucide-react'
import { useContext, useEffect, useState } from 'react'
import type { UsageData, UsageRange } from '@shared/usage.ts'
import { Button } from '../../components/ui/Button.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { formatUsd } from '../../lib/format.ts'
import { useReducedMotion } from '../../lib/motion.ts'
import { href } from '../../lib/router.ts'
import { useTheme } from '../../state/selectors.ts'
import { Plop } from './Plop.tsx'
import { Scoreboard } from './Scoreboard.tsx'
import {
  createPlopAnimator,
  createSnackGate,
  PlopMotionContext,
  PlopSnackGateContext,
} from './plopAnimation.ts'
import type { PlopFrame } from './plopAnimation.ts'
import { buildLineup, hasPlayed, markPlayed, plopLabel, tokensText } from './lineup.ts'
import type { PlopView, VendorView } from './lineup.ts'

export const PLOPS_TITLE = 'Plops'
export const PLOPS_INTRO =
  'AI usage from your runs, one Plop per vendor. A Plop grows with the tokens it used; choose a vendor to see its models.'
export const PLOPS_LOADING = 'Loading usage…'

/** The period buttons, in the design's order. */
export const PLOPS_PERIODS: readonly { id: UsageRange; label: string; words: string }[] = [
  { id: '30d', label: '30 days', words: 'last 30 days' },
  { id: '7d', label: '7 days', words: 'last 7 days' },
]
export const DEFAULT_PLOPS_RANGE: UsageRange = '30d'

/** Plop width (px) on the page; the floor runs at 90% of it (y = 180 of 200). */
const PLOP_SIZE = 148
/** A tile's padding above the Plop (px), so the floor line meets its feet. */
const TILE_PAD_TOP = 8
const FLOOR_TOP = TILE_PAD_TOP + Math.round(PLOP_SIZE * 0.9)
/** One tile's height (Plop, three lines, the model dots), kept while core answers so nothing shifts. */
const TILE_MIN_H = 'min-h-[252px]'
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(164px,1fr))] gap-2.5'

const periodWords = (r: UsageRange): string => PLOPS_PERIODS.find((p) => p.id === r)?.words ?? r

type State =
  | { status: 'loading'; data: UsageData | null }
  | { status: 'ready'; data: UsageData }
  | { status: 'error'; data: UsageData | null; error: string }

/**
 * What a Plop shows now (plopAnimation.ts): the snack then growing once (when it grew and motion is on), the rotation
 * while steps run, its resting pose, and now and then a snack at rest while it is in use. Timers stop on unmount and
 * while the page or window is hidden.
 */
function usePlopFrame(v: PlopView, animated: boolean): PlopFrame {
  const motion = useContext(PlopMotionContext)
  const gate = useContext(PlopSnackGateContext)
  const [anim] = useState(() =>
    createPlopAnimator(
      { resting: v.resting, emit: v.emit, grow: v.grew && !hasPlayed(v.key), animated },
      motion,
      gate,
    ),
  )
  const [frame, setFrame] = useState(anim.frame)
  useEffect(() => {
    if (anim.grows) markPlayed(v.key)
    const off = anim.subscribe(setFrame)
    const sync = (): void => (motion.hidden() ? anim.stop() : anim.start())
    sync()
    const unwatch = motion.onVisibilityChange(sync)
    return () => {
      unwatch()
      anim.stop()
      off()
    }
  }, [anim, motion, v.key])
  return frame
}

interface TileProps {
  v: PlopView
  dark: boolean
  animated: boolean
  testId: string
}

/** A new animator whenever what it animates changes (the Plop keeps its size, so nothing moves). */
function PlopTile(p: TileProps): React.JSX.Element {
  return <AnimatedPlop key={`${p.v.key}|${p.v.resting}|${p.v.emit}|${p.animated}`} {...p} />
}

function AnimatedPlop({ v, dark, animated, testId }: TileProps): React.JSX.Element {
  const { mood, snack, emit } = usePlopFrame(v, animated)
  return (
    <Plop
      color={v.color}
      growth={v.growth}
      mood={mood}
      snack={snack}
      emit={emit}
      lines={[v.name, v.tokensText, v.costText]}
      size={PLOP_SIZE}
      dark={dark}
      animated={animated}
      ariaLabel={plopLabel(v, mood)}
      testId={testId}
    />
  )
}

function PeriodButtons({
  range,
  onChange,
}: {
  range: UsageRange
  onChange: (r: UsageRange) => void
}): React.JSX.Element {
  return (
    <div role="group" aria-label="Period" className="flex shrink-0 gap-1.5">
      {PLOPS_PERIODS.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={range === p.id}
          data-testid={`plops-range-${p.id}`}
          onClick={() => onChange(p.id)}
          // Selection is the background only: the label keeps its weight, so the button keeps its width.
          className={cn(
            'h-9 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
            range === p.id ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

function VendorButton({
  v,
  selected,
  onPick,
  dark,
  animated,
}: {
  v: VendorView
  selected: boolean
  onPick: () => void
  dark: boolean
  animated: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-testid={`plops-vendor-${v.vendor}`}
      onClick={onPick}
      // Selection is a background and a 2 px inset ring (a shadow, not a border), so the button never changes size.
      className={cn(
        'flex min-w-0 flex-col items-center gap-2 rounded-2xl px-1.5 pb-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'bg-accent shadow-[inset_0_0_0_2px_var(--foreground)]'
          : 'shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent',
      )}
      style={{ paddingTop: TILE_PAD_TOP }}
    >
      <PlopTile v={v} dark={dark} animated={animated} testId={`plops-vendor-plop-${v.vendor}`} />
      <span className="flex h-4 items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <span aria-hidden className="flex gap-[3px]">
          {v.modelColors.slice(0, 6).map((c, i) => (
            <span
              key={i}
              className="size-2.5 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)]"
              style={{ background: c }}
            />
          ))}
        </span>
        <span>{v.modelCountText}</span>
      </span>
    </button>
  )
}

/** One tile on a shared floor: the floor line runs under every tile of the row. */
function FloorTile({
  children,
  divider,
  testId,
}: {
  children: React.ReactNode
  divider?: boolean
  testId: string
}): React.JSX.Element {
  return (
    <li
      data-testid={testId}
      className={cn(
        'relative flex min-w-0 justify-center pb-2',
        divider && 'border-r-2 border-dashed border-border',
      )}
      style={{ paddingTop: TILE_PAD_TOP }}
    >
      <span
        aria-hidden
        className="absolute -inset-x-[5px] h-0.5 rounded-full bg-border"
        style={{ top: FLOOR_TOP }}
      />
      <div className="relative">{children}</div>
    </li>
  )
}

export const LEGEND: readonly { term: string; desc: string }[] = [
  {
    term: 'Size',
    desc: 'Tokens in the period on a log scale across the Plops with usage: Drop, Sprout, Plop, Chonk, Mega.',
  },
  { term: 'Happy', desc: 'More tokens than the period before.' },
  { term: 'Sleepy', desc: 'Used in this period, but not in the last 24 hours.' },
  {
    term: 'Puddle',
    desc: 'Used before, but no tokens in this period: melted flat and asleep. Its width is its tokens of all time on the same scale.',
  },
  {
    term: 'Growing',
    desc: 'Reached a bigger stage than the period before: it eats a snack, then grows (plays once).',
  },
  {
    term: 'Snacks',
    desc: 'A Plop in use (tokens in the period, used in the last 24 hours) eats metal, a cord, a bolt or water now and then, at random, then rests again. Plops with failures (oil) or a limit or blocker (steam) do not snack, nor do sleepy Plops and puddles.',
  },
  {
    term: 'Gas or smoke',
    desc: 'Steps running right now. While they run, the Plop also snacks on metal, cords, bolts or water, changing every few seconds.',
  },
  {
    term: 'Oil',
    desc: 'Steps failed or runs were re-run in this period. Shown instead of the running animations.',
  },
  {
    term: 'Steam',
    desc: 'A rate, quota or billing limit stopped a step in the last 24 hours. Shown before anything else.',
  },
  {
    term: 'Still',
    desc: 'With reduced motion on, each Plop holds one pose that still shows its state, and nothing snacks.',
  },
  {
    term: 'No Plop',
    desc: 'A model that never reported tokens counts toward its vendor but gets no Plop of its own.',
  },
]

export function PlopsPage(): React.JSX.Element {
  const [range, setRange] = useState<UsageRange>(DEFAULT_PLOPS_RANGE)
  const [state, setState] = useState<State>({ status: 'loading', data: null })
  const [picked, setPicked] = useState<string | null>(null)
  // One gate for the page: at most about half of the Plops snacking at rest eat at the same moment.
  const [gate] = useState(createSnackGate)
  const reduced = useReducedMotion()
  const animated = !reduced
  const theme = useTheme()
  const dark =
    theme !== null ? theme.resolved === 'dark' : document.documentElement.classList.contains('dark')

  useEffect(() => {
    let live = true
    setState((s) => ({ status: 'loading', data: s.data }))
    void invoke('usage.get', { range }).then((r) => {
      if (!live) return
      setState((s) =>
        r.ok ? { status: 'ready', data: r.value } : { status: 'error', data: s.data, error: r.error.message },
      )
    })
    return () => {
      live = false
    }
  }, [range])

  const data = state.data
  const lineup = data !== null ? buildLineup(data) : []
  const selected = lineup.find((v) => v.vendor === picked) ?? lineup[0]
  const words = periodWords(data?.range ?? range)
  const summary =
    data === null
      ? state.status === 'error'
        ? 'Not available'
        : PLOPS_LOADING
      : `${tokensText(data.totals.tokens)} · ${
          data.totals.costUsd === null ? 'no price' : formatUsd(data.totals.costUsd)
        } · ${data.totals.runs} ${data.totals.runs === 1 ? 'run' : 'runs'}, ${words}`

  return (
    <PlopSnackGateContext.Provider value={gate}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-5" data-testid="plops-page">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{PLOPS_TITLE}</h1>
          <p className="text-sm text-muted-foreground">{PLOPS_INTRO}</p>
        </div>

        <section
          aria-labelledby="plops-vendors-title"
          aria-busy={state.status === 'loading' || undefined}
          data-testid="plops-vendors"
          data-status={state.status}
          className="flex flex-col gap-4 overflow-hidden rounded-xl border bg-card p-5 text-card-foreground"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 id="plops-vendors-title" className="text-base font-semibold">
                By vendor
              </h2>
              <p data-testid="plops-summary" className="truncate text-sm text-muted-foreground tabular-nums">
                {summary}
              </p>
            </div>
            <PeriodButtons range={range} onChange={setRange} />
          </div>
          {data === null ? (
            state.status === 'error' ? (
              <EmptyState className={TILE_MIN_H} title="Usage is not available" description={state.error} />
            ) : (
              <div
                className={cn('flex items-center justify-center text-sm text-muted-foreground', TILE_MIN_H)}
                data-testid="plops-loading"
              >
                {PLOPS_LOADING}
              </div>
            )
          ) : lineup.length === 0 ? (
            <div data-testid="plops-empty" className={cn('flex flex-col items-center', TILE_MIN_H)}>
              <Plop
                color="#A57BFF"
                growth={0}
                mood="sleepy"
                size={120}
                dark={dark}
                animated={animated}
                ariaLabel="A sleepy Drop Plop: no usage yet"
              />
              <EmptyState
                className="py-2"
                title={`No AI usage in the ${words}`}
                description="Plops grow from the tokens your runs' steps use. Start a run, or choose a longer period."
                action={
                  <Button asChild variant="outline">
                    <a href={href({ name: 'dashboard' })}>Go to the Dashboard</a>
                  </Button>
                }
              />
            </div>
          ) : (
            <div className={GRID}>
              {lineup.map((v) => (
                <VendorButton
                  key={v.key}
                  v={v}
                  selected={v.vendor === selected?.vendor}
                  onPick={() => setPicked(v.vendor)}
                  dark={dark}
                  animated={animated}
                />
              ))}
            </div>
          )}
        </section>

        {selected !== undefined && (
          <section
            aria-labelledby="plops-models-title"
            data-testid="plops-models"
            data-vendor={selected.vendor}
            className="flex flex-col gap-4 overflow-hidden rounded-xl border bg-card p-5 text-card-foreground"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="plops-models-title" className="text-base font-semibold">
                {selected.name} by model
              </h2>
              <p className="text-sm text-muted-foreground">Model sizes share one scale across every vendor</p>
            </div>
            <ul className={GRID} aria-label={`${selected.name} models`}>
              <FloorTile divider testId="plops-model-all">
                <PlopTile
                  key={selected.all.key}
                  v={selected.all}
                  dark={dark}
                  animated={animated}
                  testId={`plops-model-plop-all`}
                />
              </FloorTile>
              {selected.models.map((m, i) => (
                <FloorTile key={m.key} testId={`plops-model-${i}`}>
                  <PlopTile v={m} dark={dark} animated={animated} testId={`plops-model-plop-${i}`} />
                </FloorTile>
              ))}
            </ul>
          </section>
        )}

        <section
          aria-labelledby="plops-legend-title"
          className="flex flex-col gap-2 rounded-xl border bg-card p-5 text-card-foreground"
        >
          <h2 id="plops-legend-title" className="flex items-center gap-2 text-base font-semibold">
            <Sparkles aria-hidden className="size-4 text-muted-foreground" />
            Reading the Plops
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {LEGEND.map((l) => (
              <div key={l.term} className="contents">
                <dt className="font-medium">{l.term}</dt>
                <dd className="text-muted-foreground">{l.desc}</dd>
              </div>
            ))}
          </dl>
        </section>
        {/* Last, with its room kept while it loads: nothing above it moves when its answer comes. */}
        <Scoreboard />
      </div>
    </PlopSnackGateContext.Provider>
  )
}
