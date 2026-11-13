// One renderer for every card kind. Core builds the
// title, body and choices; this shows them and sends cards.resolve{runId, cardId, choiceId, input?}. The plan gate,
// the gate before Fix, insufficientContext, preflight, stall, reconcile and planMutated, trust and
// verifyEnv, depsConsent / depsFailed, finalize, finalizeConflicts, interruptedApply, testsNotRed, clarify and research get
// their own bodies; every other kind is generic: body text plus core's choices, with a text box for a choice that takes text.
import { useEffect, useId, useRef, useState } from 'react'
import type { CardChoice, CardView as CardData } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { StallBody } from '../attention/StallBody.tsx'
import { JUMP_MARGIN } from '../run/follow.tsx'
import { LightMarkdown } from '../run/LightMarkdown.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Textarea } from '../ui/Textarea.tsx'
import { BeforeFixBody } from './BeforeFixBody.tsx'
import { ChoiceButton, ChoiceRow } from './ChoiceButton.tsx'
import { ClarifyBody } from './ClarifyBody.tsx'
import { ResearchBody } from './ResearchBody.tsx'
import { ConflictsBody } from './ConflictsBody.tsx'
import { DepsBody } from './DepsBody.tsx'
import { FinalizeBody } from './FinalizeBody.tsx'
import { InsufficientContextBody } from './InsufficientContextBody.tsx'
import { InterruptedApplyBody } from './InterruptedApplyBody.tsx'
import { inputSeed } from './payload.ts'
import { PlanGateBody } from './PlanGateBody.tsx'
import { PlanMutatedBody } from './PlanMutatedBody.tsx'
import { PreflightBody } from './PreflightBody.tsx'
import { ReconcileBody } from './ReconcileBody.tsx'
import { TestsNotRedBody } from './TestsNotRedBody.tsx'
import { CARD_INPUT, CARD_SURFACE } from './surface.ts'
import { TrustBody } from './TrustBody.tsx'
import { VerifyEnvBody } from './VerifyEnvBody.tsx'
import { useResolve } from './resolve.ts'
import type { CardResolver } from './resolve.ts'

/** A choice whose input is text (a plan, a task, a command); `findings` and `paths` take lists. */
function takesText(c: CardChoice): boolean {
  return c.input === 'plan' || c.input === 'task' || c.input === 'command'
}

function GenericBody({ card, resolver }: { card: CardData; resolver: CardResolver }): React.JSX.Element {
  const takes = card.choices.find(takesText)
  const kind =
    takes?.input === 'plan' || takes?.input === 'task' || takes?.input === 'command' ? takes.input : null
  const [text, setText] = useState(() => (kind !== null ? inputSeed(card, kind) : ''))
  const id = useId()
  const choose = (c: CardChoice): void => resolver.resolve(c.id, takesText(c) ? text : undefined)
  return (
    <div className="flex flex-col gap-3">
      {card.body !== '' && <LightMarkdown text={card.body} className="text-sm" />}
      {kind !== null && (
        <div className="flex flex-col gap-1">
          <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
            {kind === 'command' ? 'Command' : kind === 'task' ? 'Task' : 'Plan'}
          </label>
          <Textarea
            id={id}
            mono={kind !== 'task'}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            rows={3}
            data-scroll-region="card-input"
            className={CARD_INPUT}
          />
        </div>
      )}
      <ChoiceRow busy={resolver.busy}>
        {card.choices.map((c) => (
          <ChoiceButton key={c.id} card={card} choice={c} busy={resolver.busy} onChoose={() => choose(c)} />
        ))}
      </ChoiceRow>
    </div>
  )
}

export interface CardViewProps {
  runId: string
  card: CardData
  /** The run's folder (the plan gate's "Don't stop after plan for this project" writes its project config). */
  folder: string
  /** Move focus here when the card opens and nothing else has focus (the plan gate takes focus). */
  autoFocus?: boolean
}

export function CardView({ runId, card, folder, autoFocus = false }: CardViewProps): React.JSX.Element {
  const resolver = useResolve(runId, card)
  const ref = useRef<HTMLElement>(null)
  const headingId = useId()

  // UI standard (nothing scrolls on its own): the card takes focus without scrolling the page. The Run
  // view announces it and, while it is out of view, offers a jump pill that scrolls to it on click.
  useEffect(() => {
    const el = ref.current
    if (!autoFocus || el === null) return
    const active = document.activeElement
    if (active === null || active === document.body) el.focus({ preventScroll: true })
  }, [autoFocus, card.id])

  const body = (() => {
    switch (card.kind) {
      case 'gate:afterPlan':
        return <PlanGateBody card={card} folder={folder} resolver={resolver} />
      case 'gate:beforeFix':
        return <BeforeFixBody card={card} resolver={resolver} />
      case 'insufficientContext':
        return <InsufficientContextBody card={card} resolver={resolver} />
      case 'preflight':
        return <PreflightBody runId={runId} card={card} resolver={resolver} />
      case 'reconcile':
        return <ReconcileBody runId={runId} card={card} resolver={resolver} />
      case 'planMutated':
        return <PlanMutatedBody card={card} resolver={resolver} />
      case 'trust':
        return <TrustBody card={card} resolver={resolver} />
      case 'verifyEnv':
        return <VerifyEnvBody runId={runId} card={card} resolver={resolver} />
      case 'depsConsent':
      case 'depsFailed':
        return <DepsBody card={card} resolver={resolver} />
      case 'finalize':
        return <FinalizeBody card={card} resolver={resolver} />
      case 'finalizeConflicts':
        return <ConflictsBody runId={runId} card={card} resolver={resolver} />
      case 'interruptedApply':
        return <InterruptedApplyBody card={card} resolver={resolver} />
      case 'emptyFindings':
      case 'retryPartial':
      case 'restartFresh':
      case 'loop':
        return <GenericBody card={card} resolver={resolver} />
      case 'stall':
        return <StallBody card={card} resolver={resolver} />
      case 'testsNotRed':
        return <TestsNotRedBody card={card} resolver={resolver} />
      case 'clarify':
        return <ClarifyBody card={card} resolver={resolver} />
      case 'research':
        return <ResearchBody card={card} resolver={resolver} />
    }
  })()

  return (
    <section
      ref={ref}
      tabIndex={-1}
      data-testid={`card-${card.kind}`}
      data-card-id={card.id}
      aria-labelledby={headingId}
      // The card's tint as one opaque colour (--card-surface), which a sticky action row repeats over the page.
      style={
        {
          '--card-surface': card.blocking ? CARD_SURFACE.blocking : CARD_SURFACE.other,
        } as React.CSSProperties
      }
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-[var(--card-surface)] p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        JUMP_MARGIN,
        card.blocking ? 'border-st-waiting/50' : 'border-st-stalled/40',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {card.title}
        </h3>
        {card.blocking && <Badge variant="waiting">Waiting for you</Badge>}
      </header>
      {body}
    </section>
  )
}
