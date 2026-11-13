// interruptedApply card (a journal in run.json.finalize makes [Finish apply] idempotent after a
// crash relaunch). Dim Factory closed while it was applying an isolated run's changes to the folder;
// core's journal knows which files it wrote. Core's lead, one line of what the journal says (written so far, still to
// write), and core's choices ([Finish apply] first). Finishing writes only what is still to write, under the same rules
// as Apply (a file changed meanwhile becomes a conflict).
import type { CardView } from '@shared/run.ts'
import { interruptedOf } from '../run/isolation.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { paragraphs } from './payload.ts'
import type { CardResolver } from './resolve.ts'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "2 files were applied before Dim Factory closed · 3 still to apply" (core's journal); '' when it says nothing. */
export function interruptedText(d: { done: number | null; remaining: number | null }): string {
  const parts: string[] = []
  if (d.done !== null)
    parts.push(`${plural(d.done, 'file was', 'files were')} applied before Dim Factory closed`)
  if (d.remaining !== null) parts.push(`${d.remaining} still to apply`)
  return parts.join(' · ')
}

export function InterruptedApplyBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const facts = interruptedText(interruptedOf(card))
  const paras = paragraphs(card.body)
  return (
    <div className="flex flex-col gap-3">
      {paras.map((p, i) => (
        <LightMarkdown key={i} text={p} className="text-sm" />
      ))}
      {facts !== '' && (
        <p data-testid="interrupted-facts" className="text-sm text-muted-foreground">
          {facts}
        </p>
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
