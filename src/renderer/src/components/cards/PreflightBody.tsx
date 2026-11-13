// preflight card (every blocking CheckResult with its fixes · [Recheck] [Cancel run];
// state row R2b). The fixes are the shared recovery buttons (recovery.execute with the run); after a copied command
// "I ran it → Re-check" re-probes the vendor and then takes the card's own Recheck.
import type { CardView } from '@shared/run.ts'
import { RecoveryActions } from '../recovery/RecoveryActions.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { CHOICE, preflightChecks } from './payload.ts'
import type { CardResolver } from './resolve.ts'

export function PreflightBody({
  runId,
  card,
  resolver,
}: {
  runId: string
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const { blocking, warnings } = preflightChecks(card)
  const canRecheck = card.choices.some((c) => c.id === CHOICE.recheck)
  const recheck = canRecheck ? () => resolver.resolve(CHOICE.recheck) : undefined
  return (
    <div className="flex flex-col gap-3">
      {blocking.length === 0 ? (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">{card.body}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {blocking.map((c) => (
            <li
              key={c.id}
              data-testid={`check-${c.id}`}
              className="flex flex-col gap-1.5 rounded-md border p-2.5"
            >
              <p className="text-sm font-medium">{c.title}</p>
              {c.detail !== '' && <p className="text-sm break-words text-muted-foreground">{c.detail}</p>}
              <RecoveryActions actions={c.recovery} runId={runId} check={c} onRecheck={recheck} />
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none">
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
          </summary>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
            {warnings.map((w) => (
              <li key={w.id}>
                {w.title}
                {w.detail !== '' ? `: ${w.detail}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) => (
          <ChoiceButton
            key={c.id}
            card={card}
            choice={c}
            busy={resolver.busy}
            onChoose={() => resolver.resolve(c.id)}
          />
        ))}
      </ChoiceRow>
    </div>
  )
}
