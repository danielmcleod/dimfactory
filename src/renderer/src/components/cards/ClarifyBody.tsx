// clarify card: before Plan, the Clarify step asks a few multiple-choice questions. Each question is a radio group of
// core's options, plus "Other" with a one-line text box and "Leave it to Plan" (the default, an unanswered question).
// "Use these answers" sends one answer per question in order ('' for a question left to Plan); "Skip questions" sends
// none. UI standard: the card never changes size while the user picks or types (every row and the Other box are
// always there, one line each), and the choices keep core's constant labels.
import { useId, useState } from 'react'
import { CLARIFY_ANSWER_MAX } from '@shared/run.ts'
import type { CardView, ClarifyQuestion } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { Input } from '../ui/Input.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { CLARIFY_CHOICE, clarifyOf } from './payload.ts'
import type { CardResolver } from './resolve.ts'

/** What one question's radio group holds: an option's index, "Other", or nothing (left to Plan). */
export type ClarifyPick = number | 'other' | 'none'

export interface ClarifyDraft {
  pick: ClarifyPick
  other: string
}

/** The label of the radio that leaves a question unanswered. */
export const LEAVE_TO_PLAN = 'Leave it to Plan'

/** The answers core takes: the option's text, the Other text (trimmed), or '' for a question left to Plan. */
export function clarifyAnswers(
  questions: readonly ClarifyQuestion[],
  drafts: readonly ClarifyDraft[],
): string[] {
  return questions.map((q, i) => {
    const d = drafts[i]
    if (d === undefined || d.pick === 'none') return ''
    if (d.pick === 'other') return d.other.trim().slice(0, CLARIFY_ANSWER_MAX)
    return q.options[d.pick] ?? ''
  })
}

const RADIO = 'size-3.5 shrink-0 accent-primary'

function Question({
  index,
  question,
  draft,
  disabled,
  onChange,
}: {
  index: number
  question: ClarifyQuestion
  draft: ClarifyDraft
  disabled: boolean
  onChange: (d: ClarifyDraft) => void
}): React.JSX.Element {
  const id = useId()
  const name = `${id}-q`
  const otherId = `${id}-other`
  return (
    <fieldset
      data-testid={`clarify-q-${index}`}
      className="flex min-w-0 flex-col gap-1.5 rounded-md border bg-background/60 p-2.5"
    >
      <legend className="sr-only">{question.question}</legend>
      {/* The question as the group's visible heading (the legend names it for assistive tech). */}
      <p aria-hidden className="text-sm font-medium">
        <span className="text-muted-foreground tabular-nums">{index + 1}. </span>
        {question.question}
      </p>
      {question.options.map((opt, o) => (
        <label key={`${o}:${opt}`} className="flex min-w-0 cursor-pointer items-start gap-2 text-sm">
          <input
            type="radio"
            name={name}
            className={cn(RADIO, 'mt-0.5')}
            data-testid={`clarify-q-${index}-opt-${o}`}
            checked={draft.pick === o}
            disabled={disabled}
            onChange={() => onChange({ ...draft, pick: o })}
          />
          <span className="min-w-0 break-words">{opt}</span>
        </label>
      ))}
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <input
          type="radio"
          id={`${otherId}-radio`}
          name={name}
          className={RADIO}
          data-testid={`clarify-q-${index}-other`}
          checked={draft.pick === 'other'}
          disabled={disabled}
          onChange={() => onChange({ ...draft, pick: 'other' })}
        />
        <label htmlFor={`${otherId}-radio`} className="shrink-0 cursor-pointer">
          Other
        </label>
        {/* Always there and one line high: picking Other or typing never changes the card's height. Typing picks it. */}
        <Input
          id={otherId}
          aria-label={`Your own answer to question ${index + 1}`}
          data-testid={`clarify-q-${index}-other-text`}
          className="h-8 flex-1"
          maxLength={CLARIFY_ANSWER_MAX}
          placeholder="Your own answer"
          value={draft.other}
          disabled={disabled}
          onChange={(e) => onChange({ other: e.currentTarget.value, pick: 'other' })}
        />
      </div>
      <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <input
          type="radio"
          name={name}
          className={RADIO}
          data-testid={`clarify-q-${index}-none`}
          checked={draft.pick === 'none'}
          disabled={disabled}
          onChange={() => onChange({ ...draft, pick: 'none' })}
        />
        {LEAVE_TO_PLAN}
      </label>
    </fieldset>
  )
}

export function ClarifyBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const questions = clarifyOf(card)
  const [drafts, setDrafts] = useState<ClarifyDraft[]>(() =>
    questions.map((): ClarifyDraft => ({ pick: 'none', other: '' })),
  )
  const busy = resolver.busy !== null
  const choose = (choiceId: string): void => {
    if (choiceId === CLARIFY_CHOICE.answer) resolver.resolve(choiceId, clarifyAnswers(questions, drafts))
    else resolver.resolve(choiceId)
  }
  return (
    <div className="flex flex-col gap-3">
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      <div className="flex flex-col gap-2" data-testid="clarify-questions">
        {questions.map((q, i) => (
          <Question
            key={i}
            index={i}
            question={q}
            draft={drafts[i] ?? { pick: 'none', other: '' }}
            disabled={busy}
            onChange={(d) => setDrafts((all) => all.map((x, j) => (j === i ? d : x)))}
          />
        ))}
      </div>
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) => (
          <ChoiceButton
            key={c.id}
            card={card}
            choice={c}
            busy={resolver.busy}
            onChoose={() => choose(c.id)}
          />
        ))}
      </ChoiceRow>
    </div>
  )
}
