// The session line and the fresh-session wording (PassCard's session line, the Quick composer's Fix row, the Runs
// history's Re-run from Fix tooltip that says fresh or why; the FreshReason list: the user understands why Fix
// started fresh from the card line). One wording for the card, the composer and the Re-run tooltip.
import { Copy } from 'lucide-react'
import { useId, useState } from 'react'
import type { FreshDetail, FreshReason, RunSnapshot, StepKey, StepView } from '@shared/run.ts'
import { FRESH_REASONS } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { stepLabel, vendorName } from '../../lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { copyText } from './commands.ts'
import { useLastEnvelope } from './runLog.ts'
import { FRESH_REASON_TEXT } from './text.ts'

/**
 * Core's session notes (supervisor/sessions.ts SESSION_NOTE, and machine.ts when the CLI ignored `--resume`), copied
 * because the renderer may not import src/core; tests/renderer/sessions keeps them equal.
 */
export const SESSION_NOTE_TEXT = {
  reusedImplement: 'reused the Implement session',
  /** Continuity: Implement continued Plan's session. */
  reusedPlan: 'continued the Plan session',
  resumed: 'resumed the previous session',
  /** `fresh session: <FRESH_REASON_TEXT[reason]>`. */
  freshPrefix: 'fresh session: ',
  resumeIgnored: 'the CLI ignored --resume and started a fresh session',
} as const

/** What core's session note says about a step's session, in the terms the line shows. */
export type SessionFacts =
  | { kind: 'reused' }
  | { kind: 'reused-plan' }
  | { kind: 'resumed' }
  | { kind: 'fresh'; reason: FreshReason }
  | { kind: 'resume-ignored' }
  | { kind: 'note'; text: string }

/**
 * Core's note read back as the words it was built from (a lookup of core's own strings, nothing decided here). A
 * note this build does not know is shown as core wrote it.
 */
export function sessionFactsOf(view: Pick<StepView, 'sessionNote'>): SessionFacts | null {
  const note = view.sessionNote
  if (note === undefined || note === '') return null
  if (note === SESSION_NOTE_TEXT.reusedImplement) return { kind: 'reused' }
  if (note === SESSION_NOTE_TEXT.reusedPlan) return { kind: 'reused-plan' }
  if (note === SESSION_NOTE_TEXT.resumed) return { kind: 'resumed' }
  if (note === SESSION_NOTE_TEXT.resumeIgnored) return { kind: 'resume-ignored' }
  if (note.startsWith(SESSION_NOTE_TEXT.freshPrefix)) {
    const said = note.slice(SESSION_NOTE_TEXT.freshPrefix.length)
    const reason = FRESH_REASONS.find((r) => FRESH_REASON_TEXT[r] === said)
    if (reason !== undefined) return { kind: 'fresh', reason }
  }
  return { kind: 'note', text: note }
}

/**
 * "Fresh session: Fix vendor differs": the line for a fresh start, which is core's note ("fresh session: <reason>",
 * the words the dev CLI prints) as a sentence. It carries no "Session: " label, which would say "session" twice. The
 * Fix card and the composer's Fix row show it; Re-run from Fix says the same reason ("Fix would start a fresh session:
 * Fix vendor differs").
 */
export function freshLineText(reason: FreshReason): string {
  const note = `${SESSION_NOTE_TEXT.freshPrefix}${FRESH_REASON_TEXT[reason]}`
  return `${note.charAt(0).toUpperCase()}${note.slice(1)}`
}

export interface FreshWhyContext {
  /** The pass that starts fresh: Fix, or a pass that was being resumed. Default Fix. */
  step?: StepKey
  /** Display name of that pass's vendor, when known. */
  vendor?: string | undefined
  /** Display name of Implement's vendor, when known. */
  implementVendor?: string | undefined
  /** Before the run (the composer): Implement has not run yet. */
  planned?: boolean
  /** Core's StepView.freshDetail: the fact behind the reason, when the reason alone does not say it. */
  detail?: FreshDetail | undefined
}

/** The rule behind a fresh start, in one plain sentence ("Why?"). */
export function freshReasonWhy(reason: FreshReason, ctx: FreshWhyContext = {}): string {
  const key = ctx.step ?? 'fix'
  const step = stepLabel(key)
  const fix = key === 'fix'
  const cli = ctx.vendor ?? 'The vendor CLI'
  const ran = ctx.planned === true ? 'runs' : 'ran'
  switch (reason) {
    case 'vendor-differs':
      return ctx.vendor !== undefined && ctx.implementVendor !== undefined
        ? `${step} runs on ${ctx.vendor}, Implement ${ran} on ${ctx.implementVendor}; a session cannot move between vendors.`
        : `${step} and Implement run on different vendors; a session cannot move between vendors.`
    case 'model-differs':
      return `${step} uses a different model and ${ctx.vendor ?? 'its vendor CLI'} cannot switch models when resuming.`
    case 'cwd-changed':
      return fix
        ? 'Fix runs in a different folder than Implement did, and a session stays with the folder it started in.'
        : `${step} now runs in a different folder, and a session stays with the folder it started in.`
    case 'cannot-resume':
      // Before a run core decides cannot-resume only from the vendor's capability (sessions.ts previewFixSession
      // never asks canResume), in the words of its `pass.fix.resume` detail; in a run, core's detail says so.
      if (ctx.planned === true || ctx.detail === 'vendor-cannot-resume')
        return `${cli} cannot continue a session, so ${step} ${ctx.planned === true ? 'starts' : 'started'} a new one.`
      return `${cli} no longer has ${fix ? "Implement's" : `the earlier ${step}`} conversation (it may have been cleaned up).`
    case 'resume-failed':
      return ctx.detail === 'new-attempt'
        ? `${cli} rejected the session; ${step} started fresh in a new attempt.`
        : `${cli} rejected the session; ${step} started fresh. This did not use the retry.`
    case 'override-fresh':
      return fix
        ? "You chose a fresh session for Fix instead of continuing Implement's."
        : `You chose to start ${step} in a fresh session.`
    case 'override-other-vendor':
      return `You chose to run ${step} on ${ctx.vendor ?? 'a different vendor'}; a session cannot move between vendors.`
    case 'implement-skipped':
      return `Implement was skipped, so there is no session for ${step} to continue.`
    case 'context-heavy':
      return "Implement's session ended nearly full or summarised its notes more than once, so Fix started clean."
    case 'no-session':
      if (key === 'implement') return 'Plan did not keep a session for Implement to continue.'
      if (!fix) return `There is no earlier ${step} session to continue.`
      return ctx.planned === true
        ? 'Implement has no session yet for Fix to continue.'
        : 'Implement did not finish with a session for Fix to continue.'
    case 'plan-skipped':
      return 'Plan did not run, so there is no Plan session for Implement to continue.'
    case 'plan-vendor-differs':
      return 'Plan and Implement run on different vendors; a session cannot move between vendors.'
    case 'mode-switch-unsupported':
      return `${cli} cannot switch a resumed session from Plan's read-only mode to editing, so Implement started a new one.`
  }
}

/**
 * "Why?" and its one sentence, shown in place (a disclosure, so it can be read and copied). `label` names the button
 * for assistive tech ("Why Fix started a fresh session"), since a page can show more than one "Why?".
 */
export function SessionWhy({
  text,
  label,
  testId,
}: {
  text: string
  label: string
  testId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen((v) => !v)}
        className="rounded px-0.5 text-xs text-primary underline-offset-2 hover:underline"
      >
        Why?
      </button>
      {open && (
        <p id={id} data-testid={testId} className="basis-full text-xs text-muted-foreground">
          {text}
        </p>
      )}
    </>
  )
}

export interface FreshReasonLineProps {
  reason: FreshReason
  context?: FreshWhyContext
  /** The line (`session-line-<step>` on a card). */
  testId: string
  /** The words alone (`fix-session-line` on Fix's card). */
  textTestId?: string
  /** The "Why?" sentence; its toggle is `<whyTestId>-toggle`. */
  whyTestId: string
  className?: string
}

/** `Fresh session: <reason> Why?`, the same on the card and in the composer. */
export function FreshReasonLine({
  reason,
  context,
  testId,
  textTestId,
  whyTestId,
  className,
}: FreshReasonLineProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      data-session="fresh"
      data-reason={reason}
      className={cn('flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground', className)}
    >
      <span data-testid={textTestId}>{freshLineText(reason)}</span>
      <SessionWhy
        text={freshReasonWhy(reason, context)}
        label={`Why ${stepLabel(context?.step ?? 'fix')} ${context?.planned === true ? 'starts' : 'started'} a fresh session`}
        testId={whyTestId}
      />
    </div>
  )
}

/** The first 8 characters of a long id (a UUID's first group); short ids as they are. */
export function shortSessionId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id
}

/**
 * What the vendor calls the session a pass continues (Fix resumes the Codex thread): Codex and the local
 * models it runs keep a thread; every other vendor a session.
 */
export function sessionNoun(vendor: string | undefined): 'thread' | 'session' {
  return vendor === 'codex' || vendor?.startsWith('local-') === true ? 'thread' : 'session'
}

/** The id's tooltip: `Codex thread 0199a213-81c0-…` / `Claude session fa4e849c-…`. */
export function sessionIdTitle(vendor: string | undefined, id: string): string {
  return `${vendor !== undefined ? `${vendorName(vendor)} ` : ''}${sessionNoun(vendor)} ${id}`
}

/**
 * The session the step runs in, as its CLI reported it (`session` events in the run log): the step's own, or for a
 * reused Fix, Implement's until Fix reports it. null while unknown.
 */
function useSessionId(
  runId: string,
  step: StepKey,
  withImplement: boolean,
  enabled: boolean,
  withPlan = false,
): string | null {
  const env = useLastEnvelope(
    runId,
    'ev',
    (b) =>
      b.ev.type === 'session' &&
      (b.step === step || (withImplement && b.step === 'implement') || (withPlan && b.step === 'plan')),
    { enabled, key: `${step}:${String(withImplement)}:${String(withPlan)}` },
  )
  return env?.body.ev.type === 'session' && env.body.ev.id !== '' ? env.body.ev.id : null
}

export interface SessionLineProps {
  runId: string
  snap: RunSnapshot
  view: StepView
}

/**
 * PassCard's session line (Fix, and any pass core resumed, e.g. a paused Implement), in core's words as the dev CLI
 * prints them: `Session: reused the Implement session fa4e849c [copy]`, `Session: the CLI ignored --resume and started
 * a fresh session`, or `Fresh session: <reason>`; a fresh start has a "Why?" that says the rule in one sentence. A
 * continued Codex pass (Fix resuming Implement's Codex thread) names the thread before its id.
 * Test ids: session-line-<step>, <step>-session-line (the words), session-why-<step>, session-id-<step>,
 * session-copy-<step>, session-kind-<step> (Codex).
 */
export function SessionLine({ runId, snap, view }: SessionLineProps): React.JSX.Element | null {
  const facts = sessionFactsOf(view)
  const continued =
    facts !== null && (facts.kind === 'reused' || facts.kind === 'reused-plan' || facts.kind === 'resumed')
  const id = useSessionId(runId, view.key, facts?.kind === 'reused', continued, facts?.kind === 'reused-plan')
  if (facts === null) return null
  const step = view.key
  const vendor = view.vendor !== undefined ? vendorName(view.vendor) : undefined
  // A continued Codex pass names its thread ("Session: reused the Implement session · Codex thread 0199a213").
  const noun = sessionNoun(view.vendor)
  const impl = snap.steps.implement.vendor
  const context: FreshWhyContext = {
    step,
    vendor,
    implementVendor: impl !== undefined ? vendorName(impl) : undefined,
    detail: view.freshDetail,
  }
  if (facts.kind === 'fresh') {
    return (
      <FreshReasonLine
        reason={facts.reason}
        context={context}
        testId={`session-line-${step}`}
        textTestId={`${step}-session-line`}
        whyTestId={`session-why-${step}`}
      />
    )
  }
  const words =
    facts.kind === 'reused'
      ? SESSION_NOTE_TEXT.reusedImplement
      : facts.kind === 'reused-plan'
        ? SESSION_NOTE_TEXT.reusedPlan
        : facts.kind === 'resumed'
          ? SESSION_NOTE_TEXT.resumed
          : facts.kind === 'resume-ignored'
            ? SESSION_NOTE_TEXT.resumeIgnored
            : facts.text
  return (
    <div
      data-testid={`session-line-${step}`}
      data-session={facts.kind}
      className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
    >
      <span data-testid={`${step}-session-line`}>Session: {words}</span>
      {continued && id !== null && (
        <>
          {noun === 'thread' && (
            <span data-testid={`session-kind-${step}`}>{`${vendor ?? 'Codex'} thread`}</span>
          )}
          <code
            data-testid={`session-id-${step}`}
            title={noun === 'thread' ? sessionIdTitle(view.vendor, id) : id}
            className="rounded bg-muted px-1 font-mono text-[11px] text-foreground"
          >
            {shortSessionId(id)}
          </code>
          <Button
            size="icon"
            variant="ghost"
            className="size-5 [&_svg]:size-3"
            aria-label={`Copy the ${noun} id`}
            title={`Copy the ${noun} id`}
            data-testid={`session-copy-${step}`}
            onClick={() => void copyText(id, noun === 'thread' ? 'Thread id' : 'Session id')}
          >
            <Copy aria-hidden />
          </Button>
        </>
      )}
      {facts.kind === 'resume-ignored' && (
        <SessionWhy
          text={`${vendor ?? 'The vendor CLI'} did not continue the earlier session and started a new one, so ${stepLabel(step)} does not have that conversation.`}
          label={`Why ${stepLabel(step)} started a new session`}
          testId={`session-why-${step}`}
        />
      )}
    </div>
  )
}
