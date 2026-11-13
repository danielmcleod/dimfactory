// The stall card's body ("No output for 5m" [Keep waiting] [Stop]; state rows P12/P13, core's stall timers).
// Core titles the card with the silence ("No output for 5m") and builds the two choices; Keep
// waiting re-arms core's stall and hard timers, Stop stops the run. The silence and the choices' labels are core's.
// Like every card's choices, a pressed one keeps its label and the row says it is being sent (ChoiceRow).
import type { CardChoice, CardView } from '@shared/run.ts'
import { ChoiceRow } from '../cards/ChoiceButton.tsx'
import { CHOICE } from '../cards/payload.ts'
import type { CardResolver } from '../cards/resolve.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { Button } from '../ui/Button.tsx'

/** The idle time core stalled on (payload.idleMs), when it says. */
export function stallIdleMs(card: CardView): number | null {
  const p = card.payload
  const ms = typeof p === 'object' && p !== null ? (p as { idleMs?: unknown }).idleMs : undefined
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null
}

const FALLBACK: Readonly<Record<'keep' | 'stop', CardChoice>> = {
  keep: { id: CHOICE.keepWaiting, label: 'Keep waiting', primary: true },
  stop: { id: CHOICE.stop, label: 'Stop run', danger: true },
}

function StallButton({
  choice,
  testId,
  resolver,
  variant,
}: {
  choice: CardChoice
  testId: string
  resolver: CardResolver
  variant: 'default' | 'outline'
}): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant={variant}
      data-testid={testId}
      className={choice.danger === true ? 'text-destructive hover:text-destructive' : undefined}
      aria-busy={resolver.busy === choice.id || undefined}
      disabled={resolver.busy !== null}
      onClick={() => resolver.resolve(choice.id)}
    >
      {/* The card's generic choice id too, so every card choice is found the same way. */}
      <span data-testid={`card-choice-${choice.id}`}>{choice.label}</span>
    </Button>
  )
}

export function StallBody({ card, resolver }: { card: CardView; resolver: CardResolver }): React.JSX.Element {
  const keep = card.choices.find((c) => c.id === CHOICE.keepWaiting) ?? FALLBACK.keep
  const stop = card.choices.find((c) => c.id === CHOICE.stop) ?? FALLBACK.stop
  const idle = stallIdleMs(card)
  return (
    <div className="flex flex-col gap-3" data-testid="stall-body" data-idle-ms={idle ?? undefined}>
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      <ChoiceRow busy={resolver.busy}>
        <StallButton choice={keep} testId="stall-keep-waiting" resolver={resolver} variant="default" />
        <StallButton choice={stop} testId="stall-stop" resolver={resolver} variant="outline" />
      </ChoiceRow>
    </div>
  )
}
