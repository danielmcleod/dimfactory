// Fix until green in the Run view's flow: round 1's verdict after round 1's Re-check card, then a section per later
// round ("Round 2 of 3", its Fix, Final verify and Re-check cards, its verdict), and the stop line last; and the
// "Round 2 of 3" chip on those cards. Presentation only: the rounds, what each changed, what still fails, which
// findings each resolved, what it spent and why the loop stopped are core's (RunSnapshot.fixLoop, StepView.round).
// UI standard (nothing moves on its own): each round is an attempt of the same steps, so an earlier round's cards show
// its frozen views (FixRoundView.views) and never change when the next round starts; everything new is appended.
import { CircleCheck, CircleX } from 'lucide-react'
import type { FixLoopView, FixRoundView, StepView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { formatDuration, formatUsd } from '../../lib/format.ts'
import { Badge } from '../ui/Badge.tsx'

/** `Round 2 of 3`. */
export function roundText(r: { n: number; of: number }): string {
  return `Round ${r.n} of ${r.of}`
}

/**
 * The round chip: the same width whichever round it names (every `Round n of N` is reserved in one grid cell), so the
 * header around it never shifts when the next round begins.
 */
export function RoundChip({
  round,
  testId,
}: {
  round: { n: number; of: number }
  testId?: string
}): React.JSX.Element {
  const all = Array.from({ length: Math.max(round.of, round.n) }, (_, i) =>
    roundText({ n: i + 1, of: round.of }),
  )
  return (
    <Badge variant="outline" data-testid={testId} className="font-normal tabular-nums">
      <span className="grid">
        {all.map((t) => (
          <span key={t} aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap">
            {t}
          </span>
        ))}
        <span className="col-start-1 row-start-1 whitespace-nowrap">{roundText(round)}</span>
      </span>
    </Badge>
  )
}

/** What Fix did in a round. */
export function roundFixText(r: FixRoundView): string {
  if (r.changed === undefined) return r.status === 'running' ? 'Fixing' : 'Not recorded'
  return r.changed ? 'Changed files' : 'Made no changes'
}

/** What the final verify said after a round. */
export function roundVerifyText(r: FixRoundView): string {
  if (r.failing === undefined) return r.status === 'running' ? 'Not yet' : 'Not run'
  if (r.failing.length === 0) return 'Passed'
  return `Still failing: ${r.failing.join(', ')}`
}

const fList = (ns: readonly number[]): string => ns.map((n) => `F${n}`).join(', ')

/** `F1, F3 resolved`. */
export function resolvedText(ns: readonly number[]): string {
  return `${fList(ns)} resolved`
}

/** `F2 still open`. */
export function openText(ns: readonly number[]): string {
  return `${fList(ns)} still open`
}

/** `Up to 3 rounds · budget $2.00 · 30 min of work`. */
export function loopHeadText(loop: FixLoopView): string {
  const parts = [`Up to ${loop.max} ${loop.max === 1 ? 'round' : 'rounds'}`]
  if (loop.budget?.usd !== undefined) parts.push(`budget ${formatUsd(loop.budget.usd)}`)
  if (loop.budget?.minutes !== undefined) parts.push(`${loop.budget.minutes} min of work`)
  return parts.join(' · ')
}

function Cell({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {children}
    </span>
  )
}

/** One round's verdict: what Fix did, what verify said, which findings it resolved and left open, cost and time. */
export function RoundVerdict({ r }: { r: FixRoundView }): React.JSX.Element {
  const verifyBad = r.failing !== undefined && r.failing.length > 0
  return (
    <div
      data-testid={`fix-round-${r.n}`}
      data-status={r.status}
      className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-sm"
    >
      <span className="w-16 shrink-0 font-medium tabular-nums">Round {r.n}</span>
      <Cell label="Fix:">
        <span data-testid={`fix-round-${r.n}-fix`}>{roundFixText(r)}</span>
      </Cell>
      <Cell label="Verify:">
        <span
          data-testid={`fix-round-${r.n}-verify`}
          className={cn(
            'min-w-0 break-words',
            verifyBad ? 'text-st-failed' : r.failing !== undefined && 'text-st-done',
          )}
        >
          {roundVerifyText(r)}
        </span>
      </Cell>
      <Cell label="Re-check:">
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {r.resolved.length > 0 && (
            <Badge
              variant="outline"
              data-testid={`fix-round-${r.n}-resolved`}
              className="border-st-done/40 font-normal text-st-done"
            >
              <CircleCheck aria-hidden />
              {resolvedText(r.resolved)}
            </Badge>
          )}
          {r.open.length > 0 && (
            <Badge
              variant="outline"
              data-testid={`fix-round-${r.n}-open`}
              className="border-warning/50 font-normal text-warning"
            >
              <CircleX aria-hidden />
              {openText(r.open)}
            </Badge>
          )}
          {r.resolved.length === 0 && r.open.length === 0 && (
            <span className="text-muted-foreground">
              {r.status === 'running' ? 'Not yet' : 'Nothing to check'}
            </span>
          )}
        </span>
      </Cell>
      <span className="ml-auto flex shrink-0 gap-3 text-xs text-muted-foreground tabular-nums">
        <span data-testid={`fix-round-${r.n}-cost`}>{r.usd !== null ? formatUsd(r.usd) : 'No price'}</span>
        <span data-testid={`fix-round-${r.n}-time`}>{formatDuration(r.activeMs)}</span>
      </span>
    </div>
  )
}

const BLOCK = 'flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-3 text-card-foreground'

/**
 * Round 1's verdict, right after round 1's Re-check card once the round is over, under the loop's head line ("Fix
 * until green · Up to 3 rounds · budget $2.00").
 */
export function FirstRoundVerdict({ loop, r }: { loop: FixLoopView; r: FixRoundView }): React.JSX.Element {
  return (
    <section data-testid="fix-rounds" aria-labelledby="fix-rounds-title" className={BLOCK}>
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h3 id="fix-rounds-title" className="text-sm font-semibold">
          Fix until green
        </h3>
        <p data-testid="fix-rounds-head" className="text-xs text-muted-foreground tabular-nums">
          {loopHeadText(loop)}
        </p>
      </header>
      <RoundVerdict r={r} />
    </section>
  )
}

/** A later round's verdict, at the end of its section once the round is over. */
export function RoundVerdictBlock({ r }: { r: FixRoundView }): React.JSX.Element {
  return (
    <div className={BLOCK} data-testid={`fix-round-${r.n}-verdict`}>
      <RoundVerdict r={r} />
    </div>
  )
}

/** The heading of a later round's section ("Round 2 of 3"). */
export function RoundHeading({ n, of, id }: { n: number; of: number; id: string }): React.JSX.Element {
  return (
    <h3 id={id} data-testid={`fix-round-${n}-heading`} className="pt-1 text-sm font-semibold tabular-nums">
      {roundText({ n, of })}
    </h3>
  )
}

/** Why the loop stopped: green in a positive tone, the round cap, budget or no progress as a warning. */
export function FixRoundsStop({ stop }: { stop: NonNullable<FixLoopView['stop']> }): React.JSX.Element {
  return (
    <p
      data-testid="fix-rounds-stop"
      data-reason={stop.reason}
      className={cn(
        'rounded-lg border bg-card p-3 text-sm',
        stop.reason === 'green' ? 'border-st-done/40 text-st-done' : 'border-warning/50 text-warning',
      )}
    >
      {stop.text}
    </p>
  )
}

/** The loop's steps, each round an attempt of them: Fix, its final verify and its re-check. */
export const ROUND_STEPS = ['fix', 'verify:2', 'recheck'] as const
export type RoundStep = (typeof ROUND_STEPS)[number]

const VIEW_OF: Readonly<Record<RoundStep, 'fix' | 'verify' | 'recheck'>> = {
  fix: 'fix',
  'verify:2': 'verify',
  recheck: 'recheck',
}

/** A round's frozen view of a step (absent while the round runs, or from a core that sends none). */
export function frozenView(r: FixRoundView | undefined, k: RoundStep): StepView | undefined {
  return r?.views?.[VIEW_OF[k]]
}

/**
 * The view the flow shows for round `n` of a step: an earlier round's frozen view (FixRoundView.views); for the latest
 * round, the step's own view once it has begun in that round (its attempt is past the previous round's). Absent when
 * there is nothing to show for it yet. Round 1's cards are the flow's usual ones: only their frozen view comes from here.
 */
export function roundStepView(
  loop: FixLoopView,
  steps: Readonly<Record<RoundStep, StepView>>,
  n: number,
  k: RoundStep,
): { view: StepView; frozen: boolean } | undefined {
  if (n < loop.rounds.length) {
    const frozen = frozenView(loop.rounds[n - 1], k)
    return frozen !== undefined ? { view: frozen, frozen: true } : undefined
  }
  const live = steps[k]
  if (live.attempt === 0 && live.status === 'queued') return undefined
  const before = frozenView(loop.rounds[n - 2], k)
  if (before !== undefined) return live.attempt > before.attempt ? { view: live, frozen: false } : undefined
  return live.round?.n === n ? { view: live, frozen: false } : undefined
}
