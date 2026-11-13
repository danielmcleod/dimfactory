// research card: before Plan, the review of what Research found (like the catalog's diff review). Every feature,
// standard and recommendation has a tick (the must-haves and recommendations ticked to start, as Auto would keep them);
// risks and sources are read-only; open questions take a one-line answer each. "Use selected" sends the ticked ids and
// `q<n>=<answer>` for each answered question; "Plan without research" sends nothing. Sources are untrusted web
// content, so they are shown as text, never as links. UI standard: the card never changes size while the user ticks
// or types (every row and answer box is always there, one line each), and the choices keep core's constant labels.
import { useState } from 'react'
import { RESEARCH_ANSWER_MAX, researchAnswerEntry } from '@shared/research.ts'
import type { ResearchPriority, ResearchResult } from '@shared/research.ts'
import type { CardView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Checkbox } from '../ui/Checkbox.tsx'
import { Input } from '../ui/Input.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { RESEARCH_CHOICE, researchOf } from './payload.ts'
import type { CardResolver } from './resolve.ts'

/** The line every research card shows: what it read is untrusted. */
export const UNTRUSTED_LINE = 'Sources are web pages: untrusted content. Check the ones you rely on.'
export const NO_WEB_LINE = 'No web search in this run: these findings come from this repository only.'

export const PRIORITY_LABEL: Readonly<Record<ResearchPriority, string>> = {
  must: 'Must',
  should: 'Should',
  could: 'Could',
}

/** The input "Use selected" sends: ticked ids in card order, then one `q<n>=<answer>` per answered question. */
export function researchInput(
  r: ResearchResult,
  ticked: ReadonlySet<string>,
  answers: Readonly<Record<string, string>>,
): string[] {
  const ids = [...r.features, ...r.standards, ...r.options].map((x) => x.id).filter((id) => ticked.has(id))
  const qs = r.questions
    .map((q) => [q.id, (answers[q.id] ?? '').trim().slice(0, RESEARCH_ANSWER_MAX)] as const)
    .filter(([, a]) => a !== '')
    .map(([id, a]) => researchAnswerEntry(id, a))
  return [...ids, ...qs]
}

/** "1 claim was left out" for the dropped count (empty when none). */
export function droppedLine(n: number): string {
  if (n <= 0) return ''
  return `${n === 1 ? 'One claim was' : `${n} claims were`} left out because ${n === 1 ? 'it' : 'they'} cited no source.`
}

function Sources({ list }: { list: readonly string[] }): React.JSX.Element | null {
  if (list.length === 0) return null
  return (
    <span className="block min-w-0 font-mono text-[11px] break-all text-muted-foreground select-text">
      {list.join(' · ')}
    </span>
  )
}

function Section({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  )
}

function TickRow({
  id,
  label,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string
  label: string
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li
      className="flex min-w-0 items-start gap-2 rounded-md border bg-background/60 p-2"
      data-testid={`research-item-${id}`}
      data-ticked={checked || undefined}
    >
      <Checkbox
        className="mt-0.5"
        aria-label={`Keep ${label}`}
        data-testid={`research-tick-${id}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">{children}</div>
    </li>
  )
}

export function ResearchBody({
  card,
  resolver,
}: {
  card: CardView
  resolver: CardResolver
}): React.JSX.Element {
  const payload = researchOf(card)
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(payload?.suggested ?? []))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const busy = resolver.busy !== null
  if (payload === null) {
    return <p className="text-sm text-muted-foreground">{card.body}</p>
  }
  const r = payload.result
  const tick = (id: string, v: boolean): void =>
    setTicked((s) => {
      const n = new Set(s)
      if (v) n.add(id)
      else n.delete(id)
      return n
    })
  const choose = (choiceId: string): void => {
    if (choiceId === RESEARCH_CHOICE.use) resolver.resolve(choiceId, researchInput(r, ticked, answers))
    else resolver.resolve(choiceId)
  }
  const dropped = droppedLine(r.dropped)
  return (
    <div className="flex flex-col gap-3" data-testid="research-review">
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      <p className="text-xs text-muted-foreground" data-testid="research-trust">
        {payload.web ? UNTRUSTED_LINE : NO_WEB_LINE}
        {dropped !== '' && <span data-testid="research-dropped"> {dropped}</span>}
      </p>
      {r.summary.length > 0 && (
        <Section title="Summary" testId="research-summary">
          <ul className="flex flex-col gap-0.5 pl-4 text-sm">
            {r.summary.map((l, i) => (
              <li key={i} className="list-disc break-words">
                {l}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.features.length > 0 && (
        <Section title="Features" testId="research-features">
          <ul className="flex flex-col gap-1">
            {r.features.map((f) => (
              <TickRow
                key={f.id}
                id={f.id}
                label={f.feature}
                checked={ticked.has(f.id)}
                disabled={busy}
                onChange={(v) => tick(f.id, v)}
              >
                <span className="flex min-w-0 items-start gap-1.5">
                  <Badge
                    variant={f.priority === 'must' ? 'default' : 'outline'}
                    data-testid={`research-priority-${f.id}`}
                    className="shrink-0"
                  >
                    {PRIORITY_LABEL[f.priority]}
                  </Badge>
                  <span className="min-w-0 break-words">{f.feature}</span>
                </span>
                <Sources list={f.sources} />
              </TickRow>
            ))}
          </ul>
        </Section>
      )}
      {r.standards.length > 0 && (
        <Section title="Standards and practices" testId="research-standards">
          <ul className="flex flex-col gap-1">
            {r.standards.map((s) => (
              <TickRow
                key={s.id}
                id={s.id}
                label={s.standard}
                checked={ticked.has(s.id)}
                disabled={busy}
                onChange={(v) => tick(s.id, v)}
              >
                <span className="break-words">
                  <span className="font-medium">{s.standard}</span>
                  {s.why !== undefined && <span className="text-muted-foreground">: {s.why}</span>}
                </span>
                <Sources list={s.sources} />
              </TickRow>
            ))}
          </ul>
        </Section>
      )}
      {r.options.length > 0 && (
        <Section title="Recommendations" testId="research-options">
          <ul className="flex flex-col gap-1">
            {r.options.map((o) => (
              <TickRow
                key={o.id}
                id={o.id}
                label={`${o.topic}: ${o.recommendation}`}
                checked={ticked.has(o.id)}
                disabled={busy}
                onChange={(v) => tick(o.id, v)}
              >
                <span className="break-words">
                  <span className="text-muted-foreground">{o.topic}: </span>
                  <span className="font-medium">{o.recommendation}</span>
                </span>
                {o.rationale !== '' && (
                  <span className="break-words text-muted-foreground">{o.rationale}</span>
                )}
                {o.options.length > 0 && (
                  <span className="text-xs break-words text-muted-foreground">
                    Weighed: {o.options.join(', ')}
                  </span>
                )}
                <Sources list={o.sources} />
              </TickRow>
            ))}
          </ul>
        </Section>
      )}
      {r.risks.length > 0 && (
        <Section title="Risks and pitfalls" testId="research-risks">
          <ul className="flex flex-col gap-1 pl-4 text-sm">
            {r.risks.map((x, i) => (
              <li key={x.id !== '' ? x.id : i} className="list-disc break-words">
                {x.risk}
                <Sources list={x.sources} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.questions.length > 0 && (
        <Section title="Open questions" testId="research-questions">
          <ul className="flex flex-col gap-1.5">
            {r.questions.map((q) => (
              <li
                key={q.id}
                className="flex min-w-0 flex-col gap-1 text-sm"
                data-testid={`research-q-${q.id}`}
              >
                <span className="break-words">{q.question}</span>
                <Input
                  aria-label={`Your answer: ${q.question}`}
                  data-testid={`research-answer-${q.id}`}
                  className="h-8"
                  maxLength={RESEARCH_ANSWER_MAX}
                  placeholder="Leave blank and Plan decides"
                  value={answers[q.id] ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.currentTarget.value
                    setAnswers((a) => ({ ...a, [q.id]: v }))
                  }}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.sources.length > 0 && (
        <Section title="Sources" testId="research-sources">
          <ul className={cn('flex flex-col gap-0.5 text-xs text-muted-foreground')}>
            {r.sources.map((s) => (
              <li key={s.url} className="min-w-0 break-all select-text">
                {s.title !== undefined && <span className="text-foreground">{s.title}: </span>}
                <span className="font-mono">{s.url}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
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
