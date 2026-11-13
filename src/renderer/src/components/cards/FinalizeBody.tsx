// finalize card ([Apply to folder] [Keep for later] [Discard] (deletion deferred 10 s;
// undoable); state row R12: Apply or Discard finish the step, Keep for later skips it (kept); either way the run
// completes with the outcome it already has). Core builds the card: its words (what the run changed in its copy, the
// files that changed in your folder too, what each choice does) and its choices, Apply first; Auto takes Keep for later
// unless autoApply applied without the card. This shows them and sends core's choice. The Undo of an apply or a discard
// is a toast with core's token (FinalizeCard watches core's finalize view), never a confirm dialog.
import type { CardView } from '@shared/run.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { paragraphs } from './payload.ts'
import type { CardResolver } from './resolve.ts'

export function FinalizeBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="finalize-body">
      {paragraphs(card.body).map((p, i) => (
        <LightMarkdown key={i} text={p} className="text-sm" />
      ))}
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
