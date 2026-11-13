// The Run view's Flow tab: a PassCard per step in timeline order, Review and Critic side
// by side, each open card next to the step it belongs to (the gate before Fix ahead of Fix), and core's run notes.
// UI standard (nothing moves on its own): the flow only ever grows at its end. A step gets its card once
// it begins (steps.ts flowSteps), and whatever first appears (a step's block, a card for a step not on the page yet
// such as the gate before Fix, one of core's run notes) goes after everything already shown, in the order it came.
// A card for a step on the page joins that step's block only while the block is the flow's end; once something came
// after it (e.g. a note core adds while a verify round still runs, before the round's verifyEnv card), the card gets a
// place of its own at the end instead of pushing that down. Where a card goes is decided once, when it opens.
// Once the run has ended, "After the run" (Revert all, the run branch's end actions) arrives the same way. An
// isolated run's Prepare and Finalize steps have their own cards (PrepareCard, FinalizeCard). Re-run from Fix's
// findings picker, while the user has it open (Re-run ▾, "After the run"), arrives the same way, last. Fix until
// green: round 1 runs in the usual Fix, Final verify and Re-check cards (frozen as round 1 ended once round 2 starts),
// then round 1's verdict, a section per later round and the stop line arrive the same way (FixRounds.tsx).
import { Fragment, useState } from 'react'
import type { CardView as CardData, FixLoopView, RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { CardView } from '../../components/cards/CardView.tsx'
import { RunFixPicker } from '../../components/run/FixPicker.tsx'
import { PassCard } from '../../components/run/PassCard.tsx'
import { useFixPicker } from '../../components/run/rerun.ts'
import { isTerminalRun } from '../../components/run/RunHeader.tsx'
import { RunEndPanel } from '../../components/run/RunEndPanel.tsx'
import { FinalizeCard } from '../../components/run/FinalizeCard.tsx'
import {
  FirstRoundVerdict,
  FixRoundsStop,
  frozenView,
  ROUND_STEPS,
  RoundHeading,
  roundStepView,
  RoundVerdictBlock,
} from '../../components/run/FixRounds.tsx'
import type { RoundStep } from '../../components/run/FixRounds.tsx'
import { PrepareCard } from '../../components/run/PrepareCard.tsx'
import { cardGoesBefore, cardStep, flowSteps } from '../../components/run/steps.ts'
import { ScanCard } from '../../components/run/SecurityCard.tsx'
import { VerifyCard } from '../../components/run/VerifyCard.tsx'
import { isVerifyStep } from '../../components/run/VerifyModel.ts'

/** Cards that take focus (without scrolling) when they open and nothing else has it: they wait on the user. */
const FOCUS_KINDS: ReadonlySet<CardData['kind']> = new Set([
  'gate:afterPlan',
  'gate:beforeFix',
  'insufficientContext',
  'reconcile',
  'planMutated',
  // A verify round waits on these.
  'trust',
  'verifyEnv',
  // Test-first's red check found the tests passing before Implement.
  'testsNotRed',
  // Clarify's questions before Plan, and Research's review.
  'clarify',
  'research',
  // An isolated run's prepare and finalize wait on these.
  'depsConsent',
  'depsFailed',
  'finalize',
  'finalizeConflicts',
  'interruptedApply',
])

/** One thing in the flow: a step's block, a card of a step not on the page, or one of core's notes. */
interface FlowItem {
  key: string
  node?: React.ReactNode
  note?: string
}

/** Review, Critic and Security share one block (side by side), whichever of them begins first. */
const REVIEWERS_KEY = 'step:reviewers'

/** A step each round of Fix until green runs again (its rounds are attempts of it). */
function isRoundStep(k: StepKey): k is RoundStep {
  return (ROUND_STEPS as readonly StepKey[]).includes(k)
}

/**
 * Fix until green's flow items, in order: round 1's verdict once round 1 is over (after round 1's Re-check card), a
 * section per later round as it begins (its heading, its cards as its steps begin, its verdict once it is over), and
 * the stop line. Each only ever grows at its end, and an earlier round's never changes.
 */
function fixLoopItems(
  loop: FixLoopView,
  snap: RunSnapshot,
  card: (v: StepView, o?: { frozen?: boolean; instance?: string }) => React.ReactNode,
): FlowItem[] {
  const out: FlowItem[] = []
  const first = loop.rounds[0]
  if (first !== undefined && first.status !== 'running')
    out.push({ key: 'fix-round-1', node: <FirstRoundVerdict loop={loop} r={first} /> })
  for (const r of loop.rounds.slice(1)) {
    const instance = `round-${r.n}`
    const headingId = `fix-round-${r.n}-title`
    const shown = ROUND_STEPS.map((k) => roundStepView(loop, snap.steps, r.n, k)).filter(
      (x): x is { view: StepView; frozen: boolean } => x !== undefined,
    )
    out.push({
      key: `fix-round-section-${r.n}`,
      node: (
        <section
          aria-labelledby={headingId}
          data-testid={`fix-round-section-${r.n}`}
          className="flex flex-col gap-3"
        >
          <RoundHeading n={r.n} of={loop.max} id={headingId} />
          {shown.map((x) => card(x.view, { frozen: x.frozen, instance }))}
          {r.status !== 'running' && <RoundVerdictBlock r={r} />}
        </section>
      ),
    })
  }
  if (loop.stop !== undefined) out.push({ key: 'fix-rounds-stop', node: <FixRoundsStop stop={loop.stop} /> })
  return out
}

/**
 * The order things first appeared in: what is on the page keeps its place, and anything new goes after it (UI
 * standard: nothing moves on its own). On mount that is the natural order. Keys that leave keep their slot,
 * so a card that closes and opens again comes back where it was.
 */
function useArrivalOrder(keys: readonly string[]): ReadonlyMap<string, number> {
  const [order, setOrder] = useState<readonly string[]>(keys)
  const fresh = keys.filter((k) => !order.includes(k))
  const list = fresh.length > 0 ? [...order, ...fresh] : order
  if (list !== order) setOrder(list)
  return new Map(list.map((k, i) => [k, i]))
}

/**
 * Which open cards for a step on the page get a place of their own at the end of the flow: decided once per card, when
 * it first opens, from what the page showed then (`onPage`, the flow's items in order as last rendered). It joins its
 * step's block while that block is the flow's last item (or arrives now with it); otherwise something already follows
 * the block, and a card put there would push that down.
 */
function useCardPlaces(
  cards: readonly CardData[],
  shown: ReadonlySet<StepKey>,
  onPage: readonly string[],
): ReadonlySet<string> {
  const [decided, setDecided] = useState<ReadonlyMap<string, boolean>>(new Map())
  const fresh: [string, boolean][] = []
  for (const c of cards) {
    if (decided.has(c.id)) continue
    const step = cardStep(c)
    // Cards with no step on the page, and the gate before Fix (it opens before Fix's card), keep their own rules.
    if (step === null || !shown.has(step) || cardGoesBefore(c)) continue
    const block = blockKey(step)
    const own = onPage.includes(block) && onPage.at(-1) !== block
    fresh.push([c.id, own])
  }
  const next = fresh.length > 0 ? new Map([...decided, ...fresh]) : decided
  if (next !== decided) setDecided(next)
  return new Set([...next].filter(([, own]) => own).map(([id]) => id))
}

interface Placed {
  before: Map<StepKey, CardData[]>
  after: Map<StepKey, CardData[]>
  rest: CardData[]
}

/** The flow item a step's block is (Review and Critic share one). */
function blockKey(step: StepKey): string {
  return step === 'review' || step === 'critic' ? REVIEWERS_KEY : `step:${step}`
}

/**
 * `ownPlace`: cards that open after something already followed their step's block (they go at the end of the flow
 * as items of their own, see useCardPlaces).
 */
function placeCards(
  cards: readonly CardData[],
  shown: ReadonlySet<StepKey>,
  ownPlace: ReadonlySet<string> = new Set(),
): Placed {
  const before = new Map<StepKey, CardData[]>()
  const after = new Map<StepKey, CardData[]>()
  const rest: CardData[] = []
  for (const c of cards) {
    const step = cardStep(c)
    if (step === null || !shown.has(step) || ownPlace.has(c.id)) {
      rest.push(c)
      continue
    }
    const into = cardGoesBefore(c) ? before : after
    into.set(step, [...(into.get(step) ?? []), c])
  }
  return { before, after, rest }
}

export function FlowTab({
  snap,
  keep,
  finishedAtOpen,
}: {
  snap: RunSnapshot
  /** Steps the Run view has shown before: their cards stay (steps.ts shownSteps, flowSteps). */
  keep?: ReadonlySet<StepKey>
  /** Steps already over when the Run view opened: only their cards start collapsed (PassCard). */
  finishedAtOpen?: ReadonlySet<StepKey>
}): React.JSX.Element {
  const runId = snap.summary.runId
  const folder = snap.summary.folder
  const steps = flowSteps(snap, keep)
  const shown = new Set(steps.map((s) => s.key))
  // The flow's items as they were last rendered, in order (useCardPlaces reads where the page ends).
  const [onPage, setOnPage] = useState<readonly string[]>([])
  const ownPlace = useCardPlaces(snap.cards, shown, onPage)
  const placed = placeCards(snap.cards, shown, ownPlace)
  const fixPicker = useFixPicker(runId) !== null

  const cards = (list: readonly CardData[] | undefined): React.ReactNode =>
    list?.map((c) => (
      <CardView key={c.id} runId={runId} card={c} folder={folder} autoFocus={FOCUS_KINDS.has(c.kind)} />
    ))

  const loop = snap.fixLoop
  const card = (step: StepView, o: { frozen?: boolean; instance?: string } = {}): React.ReactNode => {
    // Fix until green: once a later round has started, round 1's cards (the usual ones) show round 1 as it ended.
    let v = step
    let frozen = o.frozen === true
    if (o.instance === undefined && loop !== undefined && loop.rounds.length > 1 && isRoundStep(step.key)) {
      const first = frozenView(loop.rounds[0], step.key)
      if (first !== undefined) {
        v = first
        frozen = true
      }
    }
    const key = o.instance !== undefined ? `${v.key}-${o.instance}` : v.key
    const props = {
      runId,
      snap,
      view: v,
      ...(finishedAtOpen !== undefined && o.instance === undefined
        ? { finishedAtOpen: finishedAtOpen.has(v.key) }
        : {}),
      ...(frozen ? { frozen } : {}),
      ...(o.instance !== undefined ? { instance: o.instance } : {}),
    }
    if (isRoundStep(v.key)) {
      if (isVerifyStep(v.key)) return <VerifyCard key={key} {...props} />
      return <PassCard key={key} {...props} />
    }
    // A verify round has its own card (per-command results and the round's output). An isolated run's
    // Prepare (its steps and the install's output) and Finalize (what was applied, kept or discarded) too.
    if (isVerifyStep(v.key)) return <VerifyCard key={v.key} {...props} />
    // The security advisor's scan (no vendor): its secrets, audits and advisories.
    if (v.key === 'scan') return <ScanCard key={v.key} {...props} />
    const isolated = snap.summary.isolation === 'worktree'
    if (isolated && v.key === 'prepare') return <PrepareCard key={v.key} {...props} />
    if (isolated && v.key === 'finalize') return <FinalizeCard key={v.key} {...props} />
    return <PassCard key={v.key} {...props} />
  }

  // Everything in the flow, in its natural order: a block per step (Review and Critic as one), the cards of steps not
  // on the page, then core's notes.
  const items: FlowItem[] = []
  for (let i = 0; i < steps.length; i++) {
    const v = steps[i] as StepView
    if (v.key === 'review' || v.key === 'critic' || v.key === 'security') {
      // One block for whichever reviewers have begun, always the same elements, each card keyed by its step: when the
      // second reviewer begins its card joins the grid and the first keeps its instance (and the user's open/closed
      // choice) instead of mounting again.
      const pair = steps.filter((s) => s.key === 'review' || s.key === 'critic' || s.key === 'security')
      if (v !== pair[0]) continue
      items.push({
        key: REVIEWERS_KEY,
        node: (
          <div className="flex flex-col gap-3">
            {cards(pair.flatMap((s) => placed.before.get(s.key) ?? []))}
            <div
              className={
                pair.length > 2
                  ? 'grid gap-3 lg:grid-cols-2 xl:grid-cols-3'
                  : pair.length > 1
                    ? 'grid gap-3 lg:grid-cols-2'
                    : 'grid gap-3'
              }
            >
              {pair.map((s) => card(s))}
            </div>
            {cards(pair.flatMap((s) => placed.after.get(s.key) ?? []))}
          </div>
        ),
      })
      continue
    }
    items.push({
      key: `step:${v.key}`,
      node: (
        <div className="flex flex-col gap-3">
          {cards(placed.before.get(v.key))}
          {card(v)}
          {cards(placed.after.get(v.key))}
        </div>
      ),
    })
  }
  // Fix until green: after round 1's Fix, Final verify and Re-check (before Finalize). On a live page each of these
  // arrives after everything already shown, so it lands at the flow's end.
  if (loop !== undefined) {
    const at = items.findIndex((it) => it.key === 'step:finalize')
    items.splice(at === -1 ? items.length : at, 0, ...fixLoopItems(loop, snap, card))
  }
  for (const c of placed.rest) items.push({ key: `card:${c.id}`, node: cards([c]) })
  snap.notes.forEach((n, i) => items.push({ key: `note:${i}`, note: n }))
  if (isTerminalRun(snap)) items.push({ key: 'run-end', node: <RunEndPanel snap={snap} /> })
  if (fixPicker) items.push({ key: 'rerun-fix', node: <RunFixPicker snap={snap} /> })

  const order = useArrivalOrder(items.map((i) => i.key))
  const sorted = [...items].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
  const sortedKeys = sorted.map((i) => i.key)
  if (sortedKeys.join('\u0000') !== onPage.join('\u0000')) setOnPage(sortedKeys)

  // Notes next to each other read as one Notes section.
  const out: React.ReactNode[] = []
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i] as FlowItem
    if (item.note === undefined) {
      out.push(<Fragment key={item.key}>{item.node}</Fragment>)
      continue
    }
    const group: FlowItem[] = [item]
    while (sorted[i + 1]?.note !== undefined) group.push(sorted[++i] as FlowItem)
    out.push(
      <section key={item.key} aria-label="Run notes" className="rounded-lg border p-3">
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Notes</h3>
        <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground" data-testid="run-notes">
          {group.map((g) => (
            <li key={g.key}>{g.note}</li>
          ))}
        </ul>
      </section>,
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="flow-tab">
      {/* Accessibility: the outline goes run (h1) → steps (h2) → each step and card (h3), with no level skipped. Unseen,
          and out of the flex flow (sr-only is absolutely positioned), so it takes no room. */}
      <h2 className="sr-only">Steps</h2>
      {out}
    </div>
  )
}
