// insufficientContext (message + task textarea · [Edit task & re-plan] [Proceed anyway]
// [Cancel]; state row R3, opens even in Auto). Re-plan sends the task as the choice's `input`.
import { useId, useState } from 'react'
import type { CardView } from '@shared/run.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { taskOf } from './payload.ts'
import type { CardResolver } from './resolve.ts'
import { CARD_INPUT } from './surface.ts'

export function InsufficientContextBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const [task, setTask] = useState(() => taskOf(card))
  const id = useId()
  return (
    <div className="flex flex-col gap-3">
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          Task
        </label>
        <Textarea
          id={id}
          data-testid="card-task-input"
          value={task}
          onChange={(e) => setTask(e.currentTarget.value)}
          rows={3}
          data-scroll-region="card-input"
          className={CARD_INPUT}
        />
      </div>
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) => (
          <ChoiceButton
            key={c.id}
            card={card}
            choice={c}
            busy={resolver.busy}
            disabled={c.input === 'task' && task.trim() === ''}
            onChoose={() => resolver.resolve(c.id, c.input === 'task' ? task : undefined)}
          />
        ))}
      </ChoiceRow>
    </div>
  )
}
