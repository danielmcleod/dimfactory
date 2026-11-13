// testsNotRed card (Test-first): the red check before Implement found no failing command, so the tests the Tests step
// wrote may not test the change. Core's title and body say so; this lists the commands that passed (they should
// have failed) and core's choices: Rewrite the tests, Continue anyway, Stop run.
import { CircleCheck } from 'lucide-react'
import type { CardView } from '@shared/run.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { testsNotRedOf } from './payload.ts'
import type { CardResolver } from './resolve.ts'

export function TestsNotRedBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const v = testsNotRedOf(card)
  return (
    <div className="flex flex-col gap-3">
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      {v.passed.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Passed, though they should fail</p>
          <ul className="flex flex-col gap-0.5" data-testid="tests-not-red-passed">
            {v.passed.map((name, i) => (
              <li key={`${i}:${name}`} className="flex min-w-0 items-center gap-2 text-sm">
                <CircleCheck aria-hidden className="size-4 shrink-0 text-st-done" />
                <span className="min-w-0 truncate font-mono text-xs" title={name}>
                  {name}
                </span>
              </li>
            ))}
          </ul>
        </div>
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
