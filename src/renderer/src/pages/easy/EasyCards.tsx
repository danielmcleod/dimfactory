// Easy mode's plain cards: the questions before the plan (about the outcome; "You decide" leaves one to Dim Factory),
// the plan as "When it's done, you'll be able to:" with Build it / Change something (a change goes back as Plan's
// edited version, which Implement reads), the research review as one choice, any other card under a plain title with
// core's choices (the trust, install and other cards whose core text is about scripts and logs say it plainly, core's
// text one click away behind Show what will run), and an ask in plain words with Allow / Don't allow (the safe answer
// is the primary one; nothing is answered for the user here, and no answer in time is a no; what the project
// permission covers never reaches this card). Core's choice ids and inputs are the Full cards' own.
// UI standards: every button keeps one label (or reserves all of them), each question's rows are always there.
import { AlertTriangle, MessageCircleQuestion, ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import type { AskView, CardView } from '@shared/run.ts'
import { CLARIFY_ANSWER_MAX } from '@shared/run.ts'
import { ChoiceButton } from '../../components/cards/ChoiceButton.tsx'
import {
  CHOICE,
  CLARIFY_CHOICE,
  RESEARCH_CHOICE,
  clarifyOf,
  planChangedPaths,
  planOf,
  researchOf,
} from '../../components/cards/payload.ts'
import { researchInput } from '../../components/cards/ResearchBody.tsx'
import { useResolve } from '../../components/cards/resolve.ts'
import { ASK_ARM_MS, DENY_GRACE_MS, useArmed } from '../../components/attention/AskCard.tsx'
import { timeLeftText } from '../../components/attention/askText.ts'
import { LightMarkdown } from '../../components/run/LightMarkdown.tsx'
import { useBusy } from '../../components/run/commands.ts'
import { Button } from '../../components/ui/Button.tsx'
import { Checkbox } from '../../components/ui/Checkbox.tsx'
import { Input } from '../../components/ui/Input.tsx'
import { Textarea } from '../../components/ui/Textarea.tsx'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { coreNow, coreRemainingMs, useCoreNow } from '../../lib/coreClock.ts'
import { href } from '../../lib/router.ts'
import { loadExperience, useEasyState } from '../../state/experience.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { planCriteria, planWithChange, plainAsk, plainCardBody, plainCardTitle } from './model.ts'
import {
  ALLOW,
  ANSWER_IN_DETAILS,
  ASK_LABELS,
  ASK_OUTSIDE_NOTE,
  ASK_TIMEOUT_NOTE,
  BUILD_IT,
  CANCEL_CHANGE,
  CHANGE_SOMETHING,
  CONTINUE_LABEL,
  DONT_ALLOW,
  DONT_ASK_PLAN,
  DONT_ASK_PLAN_NOTE,
  HIDE_PLAN,
  HIDE_WHAT_RUNS,
  OTHER_LABEL,
  OTHER_PLACEHOLDER,
  PLAN_CAN_DO,
  PLAN_CHANGE_HEADING,
  PLAN_CHANGE_LABEL,
  PLAN_CHANGE_PLACEHOLDER,
  PLAN_NO_CRITERIA,
  PLAN_TITLE,
  PLAN_TOGGLE_LABELS,
  QUESTIONS_INTRO,
  QUESTIONS_TITLE,
  RESEARCH_INTRO,
  RESEARCH_SKIP,
  RESEARCH_TITLE,
  RESEARCH_USE,
  SEND_CHANGE,
  SHOW_DETAILS,
  SHOW_PLAN,
  SHOW_WHAT_RUNS,
  SKIP_LABEL,
  WHAT_RUNS_LABELS,
  EASY_CHOICE_LABEL,
  FILES_CHANGED_LABELS,
  PROBLEM_LABELS,
  YOU_DECIDE,
  researchFoundText,
} from './text.ts'

const RADIO = 'size-4 shrink-0 accent-primary'

function CardFrame({
  testId,
  title,
  icon,
  tone = 'default',
  children,
}: {
  testId: string
  title: string
  icon?: React.ReactNode
  tone?: 'default' | 'outside'
  children: React.ReactNode
}): React.JSX.Element {
  const headingId = useId()
  return (
    <section
      data-testid={testId}
      aria-labelledby={headingId}
      tabIndex={-1}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        tone === 'outside' ? 'border-warning' : 'border-st-waiting/50',
      )}
    >
      <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

// ---- questions ----------------------------------------------------------------------------------------------------

type QuestionPick = number | 'other' | 'decide'

export function PlainQuestions({ runId, card }: { runId: string; card: CardView }): React.JSX.Element {
  const questions = clarifyOf(card)
  const resolver = useResolve(runId, card)
  const [picks, setPicks] = useState<QuestionPick[]>(() => questions.map((): QuestionPick => 'decide'))
  const [others, setOthers] = useState<string[]>(() => questions.map(() => ''))
  const id = useId()
  const busy = resolver.busy !== null
  const answers = (): string[] =>
    questions.map((q, i) => {
      const p = picks[i] ?? 'decide'
      if (p === 'decide') return ''
      if (p === 'other') return (others[i] ?? '').trim().slice(0, CLARIFY_ANSWER_MAX)
      return q.options[p] ?? ''
    })
  return (
    <CardFrame testId="easy-card-questions" title={QUESTIONS_TITLE}>
      <p className="text-sm text-muted-foreground">{QUESTIONS_INTRO}</p>
      <div className="flex flex-col gap-3">
        {questions.map((q, i) => {
          const name = `${id}-q${i}`
          const pick = picks[i] ?? 'decide'
          const setPick = (p: QuestionPick): void => setPicks((all) => all.map((x, j) => (j === i ? p : x)))
          return (
            <fieldset
              key={i}
              data-testid={`easy-q-${i}`}
              className="flex min-w-0 flex-col gap-2 rounded-md border bg-background p-3"
            >
              <legend className="sr-only">{q.question}</legend>
              <p aria-hidden className="text-sm font-medium">
                {q.question}
              </p>
              {q.options.map((opt, o) => (
                <label key={`${o}:${opt}`} className="flex min-w-0 cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name={name}
                    className={cn(RADIO, 'mt-0.5')}
                    data-testid={`easy-q-${i}-opt-${o}`}
                    checked={pick === o}
                    disabled={busy}
                    onChange={() => setPick(o)}
                  />
                  <span className="min-w-0 break-words">{opt}</span>
                </label>
              ))}
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <input
                  type="radio"
                  id={`${name}-other`}
                  name={name}
                  className={RADIO}
                  data-testid={`easy-q-${i}-other`}
                  checked={pick === 'other'}
                  disabled={busy}
                  onChange={() => setPick('other')}
                />
                <label htmlFor={`${name}-other`} className="shrink-0 cursor-pointer">
                  {OTHER_LABEL}
                </label>
                <Input
                  aria-label={`${OTHER_LABEL}: ${q.question}`}
                  data-testid={`easy-q-${i}-other-text`}
                  className="h-8 flex-1"
                  maxLength={CLARIFY_ANSWER_MAX}
                  placeholder={OTHER_PLACEHOLDER}
                  value={others[i] ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.currentTarget.value
                    setOthers((all) => all.map((x, j) => (j === i ? v : x)))
                    setPick('other')
                  }}
                />
              </div>
              <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={name}
                  className={RADIO}
                  data-testid={`easy-q-${i}-decide`}
                  checked={pick === 'decide'}
                  disabled={busy}
                  onChange={() => setPick('decide')}
                />
                {YOU_DECIDE}
              </label>
            </fieldset>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="easy-continue"
          loading={resolver.busy === CLARIFY_CHOICE.answer}
          disabled={busy}
          onClick={() => resolver.resolve(CLARIFY_CHOICE.answer, answers())}
        >
          {CONTINUE_LABEL}
        </Button>
        <Button
          variant="outline"
          data-testid="easy-skip"
          loading={resolver.busy === CLARIFY_CHOICE.skip}
          disabled={busy}
          onClick={() => resolver.resolve(CLARIFY_CHOICE.skip)}
        >
          {SKIP_LABEL}
        </Button>
      </div>
    </CardFrame>
  )
}

// ---- the plan -----------------------------------------------------------------------------------------------------

/** "Don't ask me next time": Easy settings' `skipPlanCheck` (later runs only; this plan still waits for an answer). */
async function setSkipPlanCheck(on: boolean): Promise<boolean> {
  const r = await invoke('config.patch', {
    scope: 'user',
    ops: [{ op: 'add', path: '/easy/skipPlanCheck', value: on }],
  })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  await loadExperience()
  return true
}

export function PlainPlan({ runId, card }: { runId: string; card: CardView }): React.JSX.Element {
  const plan = planOf(card)
  const criteria = planCriteria(plan)
  const resolver = useResolve(runId, card)
  const [full, setFull] = useState(false)
  const [changing, setChanging] = useState(false)
  const [change, setChange] = useState('')
  const settings = useEasyState()?.settings
  const [skipBusy, setSkipBusy] = useState(false)
  const checkId = useId()
  const changeId = useId()
  const approve = card.choices.find((c) => c.id === CHOICE.approve)
  const busy = resolver.busy !== null
  return (
    <CardFrame testId="easy-card-plan" title={PLAN_TITLE}>
      <p className="text-sm font-medium">{PLAN_CAN_DO}</p>
      {criteria.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="easy-plan-will-do">
          {criteria.map((c, i) => (
            <li key={i} className="break-words">
              {c}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{PLAN_NO_CRITERIA}</p>
      )}
      <div>
        <Button
          size="sm"
          variant="ghost"
          labels={PLAN_TOGGLE_LABELS}
          aria-expanded={full}
          data-testid="easy-plan-toggle"
          onClick={() => setFull((v) => !v)}
        >
          {full ? HIDE_PLAN : SHOW_PLAN}
        </Button>
      </div>
      {full && (
        <div data-testid="easy-plan-full" className="rounded-md border bg-background p-3">
          <LightMarkdown text={plan} className="text-sm" />
        </div>
      )}
      {changing ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={changeId} className="text-sm font-medium">
            {PLAN_CHANGE_LABEL}
          </label>
          <Textarea
            id={changeId}
            data-testid="easy-plan-change"
            rows={2}
            className="h-16 resize-none"
            placeholder={PLAN_CHANGE_PLACEHOLDER}
            value={change}
            onChange={(e) => setChange(e.currentTarget.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="easy-plan-send"
              loading={resolver.busy === CHOICE.approve}
              disabled={busy || change.trim() === '' || approve === undefined}
              onClick={() =>
                resolver.resolve(CHOICE.approve, planWithChange(plan, change, PLAN_CHANGE_HEADING))
              }
            >
              {SEND_CHANGE}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setChanging(false)}>
              {CANCEL_CHANGE}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="easy-build-it"
            loading={resolver.busy === CHOICE.approve}
            disabled={busy || approve === undefined}
            onClick={() => resolver.resolve(CHOICE.approve)}
          >
            {BUILD_IT}
          </Button>
          <Button
            variant="outline"
            data-testid="easy-change-something"
            disabled={busy}
            onClick={() => setChanging(true)}
          >
            {CHANGE_SOMETHING}
          </Button>
        </div>
      )}
      <div className="flex items-start gap-2">
        <Checkbox
          id={checkId}
          data-testid="easy-dont-ask-plan"
          className="mt-0.5"
          checked={settings?.skipPlanCheck === true}
          disabled={skipBusy || settings === undefined}
          onCheckedChange={(v) => {
            setSkipBusy(true)
            void setSkipPlanCheck(v === true).finally(() => setSkipBusy(false))
          }}
        />
        <label htmlFor={checkId} className="text-sm">
          {DONT_ASK_PLAN}
          <span className="block text-xs text-muted-foreground">{DONT_ASK_PLAN_NOTE}</span>
        </label>
      </div>
    </CardFrame>
  )
}

// ---- research -----------------------------------------------------------------------------------------------------

export function PlainResearch({ runId, card }: { runId: string; card: CardView }): React.JSX.Element {
  const payload = researchOf(card)
  const resolver = useResolve(runId, card)
  const busy = resolver.busy !== null
  const r = payload?.result
  const found = r !== undefined ? r.features.length + r.standards.length + r.options.length : 0
  return (
    <CardFrame testId="easy-card-research" title={RESEARCH_TITLE}>
      <p className="text-sm text-muted-foreground">{RESEARCH_INTRO}</p>
      {r !== undefined && (
        <>
          <p className="text-sm">{researchFoundText(found)}</p>
          {r.summary.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {r.summary.slice(0, 3).map((s, i) => (
                <li key={i} className="break-words">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="easy-research-use"
          loading={resolver.busy === RESEARCH_CHOICE.use}
          disabled={busy || r === undefined}
          onClick={() => {
            if (r === undefined || payload === null) return
            resolver.resolve(RESEARCH_CHOICE.use, researchInput(r, new Set(payload.suggested), {}))
          }}
        >
          {RESEARCH_USE}
        </Button>
        <Button
          variant="outline"
          data-testid="easy-research-skip"
          loading={resolver.busy === RESEARCH_CHOICE.skip}
          disabled={busy}
          onClick={() => resolver.resolve(RESEARCH_CHOICE.skip)}
        >
          {RESEARCH_SKIP}
        </Button>
      </div>
    </CardFrame>
  )
}

/** Easy's own label for a core choice, as ChoiceButton props (none: core's label). */
function easyLabel(card: CardView, choiceId: string): { label?: string } {
  const label = EASY_CHOICE_LABEL[card.kind]?.[choiceId]
  return label !== undefined ? { label } : {}
}

// ---- any other card -----------------------------------------------------------------------------------------------

export function PlainCard({ runId, card }: { runId: string; card: CardView }): React.JSX.Element {
  const resolver = useResolve(runId, card)
  const needsText = card.choices.some((c) => c.input !== undefined)
  const plain = plainCardBody(card)
  /** A check that stops the run before it starts: its details are core's own words about the problem. */
  const problem = card.kind === 'preflight'
  /** The plan changed files: its details are the files, not core's Full-mode wording. */
  const files = card.kind === 'planMutated' ? planChangedPaths(card) : null
  const detail = files !== null ? files.map((f) => `- \`${f}\``).join('\n') : card.body
  const labels = files !== null ? FILES_CHANGED_LABELS : problem ? PROBLEM_LABELS : WHAT_RUNS_LABELS
  const [open, setOpen] = useState(false)
  const detailId = useId()
  return (
    <CardFrame
      testId={`easy-card-${card.kind}`}
      title={plainCardTitle(card)}
      icon={<MessageCircleQuestion aria-hidden className="size-4 text-st-waiting" />}
    >
      {plain !== null ? (
        <>
          <p className="text-sm" data-testid="easy-card-body">
            {plain}
          </p>
          {detail !== '' && (
            <div>
              <Button
                size="sm"
                variant="ghost"
                labels={labels}
                aria-expanded={open}
                aria-controls={detailId}
                data-testid="easy-card-what"
                onClick={() => setOpen((v) => !v)}
              >
                {open ? labels[1] : labels[0]}
              </Button>
            </div>
          )}
          {open && (
            <div id={detailId} className="rounded-md border bg-background p-3" data-testid="easy-card-detail">
              <LightMarkdown text={detail} className="text-sm text-muted-foreground" />
            </div>
          )}
        </>
      ) : (
        card.body !== '' && <LightMarkdown text={card.body} className="text-sm text-muted-foreground" />
      )}
      {needsText ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm">{ANSWER_IN_DETAILS}</p>
          <Button asChild size="sm" variant="outline" data-testid="easy-card-details">
            <a href={href({ name: 'run', runId })}>{SHOW_DETAILS}</a>
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {card.choices.map((c) => (
            <ChoiceButton
              key={c.id}
              card={card}
              choice={c}
              {...easyLabel(card, c.id)}
              busy={resolver.busy}
              onChoose={() => resolver.resolve(c.id)}
            />
          ))}
        </div>
      )}
    </CardFrame>
  )
}

// ---- asks ---------------------------------------------------------------------------------------------------------

export function PlainAskCard({ ask, folder }: { ask: AskView; folder: string }): React.JSX.Element {
  const plain = plainAsk(ask, folder)
  const [busy, run] = useBusy()
  const [open, setOpen] = useState(false)
  // A press meant for the ask before this one never answers it (as the Full ask card does).
  const armed = useArmed(ASK_ARM_MS)
  useCoreNow()
  const left = coreRemainingMs(ask.expiresAt)
  const pendingDeny = ask.pendingDenyUntil !== undefined && ask.pendingDenyUntil > coreNow()
  const detailId = useId()
  const { runId, requestId } = ask
  const answer = (decision: 'allow' | 'deny'): void =>
    run(decision, async () => {
      const r = await invoke('asks.answer', {
        runId,
        requestId,
        decision,
        ...(decision === 'deny' ? { graceMs: DENY_GRACE_MS } : {}),
      })
      void fetchSnapshot(runId)
      if (!r.ok) {
        toast({ level: 'error', message: r.error.message })
        return
      }
      if (decision === 'deny') {
        toast({
          id: `deny:${requestId}`,
          level: 'info',
          message: `${DONT_ALLOW} · Undo`,
          durationMs: DENY_GRACE_MS,
          action: { label: 'Undo', call: { cmd: 'asks.undo', req: { runId, requestId } } },
        })
      }
    })
  const allowFirst = plain.recommended === 'allow'
  return (
    <CardFrame
      testId="easy-ask"
      title={plain.text}
      tone={plain.tier === 'outside' ? 'outside' : 'default'}
      icon={
        plain.tier === 'outside' ? (
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
        ) : (
          <ShieldCheck aria-hidden className="size-4 shrink-0 text-st-waiting" />
        )
      }
    >
      {plain.tier === 'outside' && <p className="text-sm">{ASK_OUTSIDE_NOTE}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={allowFirst ? 'default' : 'outline'}
          labels={ASK_LABELS}
          data-testid="easy-ask-allow"
          loading={busy === 'allow'}
          disabled={busy !== null || pendingDeny || !armed}
          onClick={() => answer('allow')}
        >
          {ALLOW}
        </Button>
        <Button
          variant={allowFirst ? 'outline' : 'default'}
          labels={ASK_LABELS}
          data-testid="easy-ask-deny"
          loading={busy === 'deny'}
          disabled={busy !== null || pendingDeny || !armed}
          onClick={() => answer('deny')}
        >
          {DONT_ALLOW}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          labels={WHAT_RUNS_LABELS}
          aria-expanded={open}
          aria-controls={detailId}
          data-testid="easy-ask-what"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? HIDE_WHAT_RUNS : SHOW_WHAT_RUNS}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="easy-ask-left">
          {timeLeftText(left)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{ASK_TIMEOUT_NOTE}</p>
      {open && (
        <pre
          id={detailId}
          data-testid="easy-ask-detail"
          className="stream-text rounded-md bg-muted px-2.5 py-1.5 break-words whitespace-pre-wrap"
        >
          {ask.detail}
        </pre>
      )}
    </CardFrame>
  )
}
