// Resolving a card (cards.resolve{runId, cardId, choiceId, input?}).
// One busy flag per card: every choice keeps its label and waits, and the card's choice row says the pressed one is
// being sent (ChoiceRow). Errors become a toast with core's message (e.g. "This card is no longer open.").
// A choice core answers UNSUPPORTED for (a core older than this renderer) is remembered for the session and shown
// disabled with "Available in a later version" from then on, never hidden.
import { useSyncExternalStore } from 'react'
import type { CardChoiceValue, CardView } from '@shared/run.ts'
import { runCommand, useBusy } from '../run/commands.ts'
import { watchStop } from '../run/stop.ts'
import { CHOICE } from './payload.ts'

export interface CardResolver {
  busy: string | null
  resolve(choiceId: string, input?: CardChoiceValue): void
}

// ---- choices this build's core does not carry out ------------------------------------------------------------------

const unsupported = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (kind: CardView['kind'], choiceId: string): string => `${kind}\n${choiceId}`

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function markUnsupported(kind: CardView['kind'], choiceId: string): void {
  const key = keyOf(kind, choiceId)
  if (unsupported.has(key)) return
  unsupported.add(key)
  version++
  for (const l of [...listeners]) l()
}

/**
 * Choices core lists that this build cannot carry out yet. Empty since P21's `revert-then-fresh` (the
 * retryPartial card's "Revert partial then fresh") arrived; kept for choices a later core may add.
 */
export const LATER_CHOICES: Readonly<Partial<Record<CardView['kind'], readonly string[]>>> = {}

/** Whether a choice is known not to work in this build: listed above, or core answered UNSUPPORTED for it. */
export function isLaterChoice(kind: CardView['kind'], choiceId: string): boolean {
  return LATER_CHOICES[kind]?.includes(choiceId) === true || unsupported.has(keyOf(kind, choiceId))
}

/** isLaterChoice, re-rendering when core's answer teaches the session another one. */
export function useLaterChoice(kind: CardView['kind'], choiceId: string): boolean {
  useSyncExternalStore(subscribe, () => version)
  return isLaterChoice(kind, choiceId)
}

/** Tests: forget what core answered. */
export function resetLaterChoicesForTests(): void {
  unsupported.clear()
  version++
  for (const l of [...listeners]) l()
}

/** Cards whose `stop` choice stops the run (R13: changes kept, toast [Revert all]). */
const STOP_CARDS: ReadonlySet<CardView['kind']> = new Set<CardView['kind']>([
  'stall',
  'reconcile',
  'testsNotRed',
])

export function useResolve(runId: string, card: CardView): CardResolver {
  const [busy, run] = useBusy()
  return {
    busy,
    resolve: (choiceId, input) =>
      run(choiceId, async () => {
        const r = await runCommand(runId, 'cards.resolve', {
          runId,
          cardId: card.id,
          choiceId,
          ...(input !== undefined ? { input } : {}),
        })
        if (!r.ok && r.error.code === 'UNSUPPORTED') markUnsupported(card.kind, choiceId)
        // "Stop run" on a stall or a reconcile card (the branch-prep block card included) is a user Stop like the
        // header's (R13 toast).
        if (r.ok && STOP_CARDS.has(card.kind) && choiceId === CHOICE.stop) watchStop(runId)
      }),
  }
}
