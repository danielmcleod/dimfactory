// planMutated card ([Revert Plan's changes] [Keep]; core's plan-end guard): the
// Plan step was meant to read only, but the folder changed while it ran and Plan reported an edit, a write or a shell
// command. Core's text says so; the card lists the files that changed (the first few, then "and N more" and the full
// list in a disclosure) and offers core's choices, the default as the primary button.
import type { CardView } from '@shared/run.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { PathList } from './PathList.tsx'
import { choicesWithDefault, planChangedPaths } from './payload.ts'
import type { CardResolver } from './resolve.ts'

export const PLAN_CHANGED_LABEL = 'Changed while Plan ran'

export function PlanMutatedBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      <PathList label={PLAN_CHANGED_LABEL} paths={planChangedPaths(card)} testId="plan-mutated-paths" />
      <ChoiceRow busy={resolver.busy}>
        {choicesWithDefault(card).map((c) => (
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
