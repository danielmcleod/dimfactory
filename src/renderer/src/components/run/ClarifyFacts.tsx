// The Clarify step's facts on its card: while it asks, a line pointing at the questions card below; once answered,
// each question with the answer given ("Left to Plan" for one left blank); skipped or with nothing to ask, core's
// note. Presentation only: the questions, answers and note are core's (StepView.clarify).
import type { ClarifyView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'

/** What an unanswered question reads as once the user answered the others. */
export const LEFT_TO_PLAN = 'Left to Plan'

/** The line under the Clarify step's header. */
export function clarifyLine(v: ClarifyView): string {
  const n = v.questions.length
  switch (v.status) {
    case 'asking':
      return `${n} ${n === 1 ? 'question' : 'questions'} waiting for your answers below`
    case 'answered': {
      const given = (v.answers ?? []).filter((a) => a !== '').length
      return `You answered ${given} of ${n} ${n === 1 ? 'question' : 'questions'}`
    }
    case 'skipped':
      return 'You skipped the questions: Plan decides'
    case 'none':
      return v.note !== undefined && v.note !== '' ? v.note : 'Clarify had no questions'
  }
}

export function ClarifyFacts({ view }: { view: ClarifyView }): React.JSX.Element {
  const showAnswers = view.status === 'answered' && view.questions.length > 0
  return (
    <div className="flex flex-col gap-1" data-testid="clarify-facts" data-status={view.status}>
      <p
        data-testid="clarify-line"
        className={cn('text-xs', view.status === 'asking' ? 'text-st-waiting' : 'text-muted-foreground')}
      >
        {clarifyLine(view)}
      </p>
      {showAnswers && (
        <dl className="flex flex-col gap-1 text-sm" data-testid="clarify-answers">
          {view.questions.map((q, i) => {
            const a = view.answers?.[i] ?? ''
            return (
              <div key={i} className="flex min-w-0 flex-col" data-testid={`clarify-answer-${i}`}>
                <dt className="break-words text-muted-foreground">{q.question}</dt>
                <dd className={cn('break-words', a === '' && 'text-muted-foreground italic')}>
                  {a === '' ? LEFT_TO_PLAN : a}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
      {view.status === 'skipped' && view.questions.length > 0 && (
        <ul
          className="flex flex-col gap-0.5 pl-4 text-sm text-muted-foreground"
          data-testid="clarify-skipped"
        >
          {view.questions.map((q, i) => (
            <li key={i} className="list-disc break-words">
              {q.question}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
