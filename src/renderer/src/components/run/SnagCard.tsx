// The Snag card: a failed step's category title and
// core's one-line message; then the recovery buttons in core's order from the step's latest `snag` event (core builds
// them; the snapshot carries only the Failure), under them the AI diagnosis once there is one ("Diagnosis (AI,
// medium confidence): …", core's StepView.heal), the AI's suggested fixes after it, [Close run] while the run is
// failed, and the raw error in a disclosure. "Ask AI to diagnose" is the primary button only where core lists it first (for
// `unknown`, and flag_drift's "Find the renamed flag"), and only until a diagnosis is shown; other failed passes
// offer it as a secondary button, except categories core never asks the AI about (and runner steps, which core does
// not diagnose). Once the AI suggested fixes, the first of them is the card's primary. Nothing moves on its own: a
// diagnosis on its way keeps the diagnose button's label (the spinner takes its icon slot), and its answer changes
// variants only; every button keeps its place and the AI's fixes are added after core's row.
// A user Stop (user_cancelled) has no snag card.
import { CircleX } from 'lucide-react'
import type { FailureCategory, RecoveryAction } from '@shared/failure.ts'
import type { StepView } from '@shared/run.ts'
import { coreNow, useCoreNow } from '../../lib/coreClock.ts'
import { cn } from '../../lib/cn.ts'
import { categoryTitle, stepLabel } from '../../lib/format.ts'
import { useStore } from '../../state/store.ts'
import { HEAL_LABEL, HEAL_WAIT_MS, healPending, requestHeal, useHealRequest } from '../recovery/heal.ts'
import { HealDiagnosis } from '../recovery/HealDiagnosis.tsx'
import { runCommand } from './commands.ts'
import { REGION } from './follow.tsx'
import { RecoveryActions } from './RecoveryActions.tsx'
import { useLastEnvelope } from './runLog.ts'
import { isAgent } from './text.ts'

export function hasSnag(view: StepView): boolean {
  return view.failure !== undefined && view.failure.category !== 'user_cancelled'
}

/** Categories core never asks the AI about (heal/categories.ts `heal: 'never'`, e.g. content_policy). */
export const NO_HEAL_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'content_policy',
  'user_cancelled',
  'verify_failed',
  'timeout_stall',
  'ask_timeout',
  'permission_denied',
])

export const SUGGESTED_BY_AI = 'Suggested by AI'
const CLOSE_RUN: RecoveryAction = { id: 'run:close', label: 'Close run', kind: 'close_run' }

export function SnagCard({ runId, view }: { runId: string; view: StepView }): React.JSX.Element | null {
  const failure = view.failure
  const show = failure !== undefined && failure.category !== 'user_cancelled'
  const snag = useLastEnvelope(runId, 'snag', (b) => b.step === view.key, {
    enabled: show,
    key: `${view.attempt}:${view.status}:${failure?.category ?? ''}`,
  })
  const heal = view.heal
  const req = useHealRequest(runId, view.key)
  // Re-render with the shared ticker only while a request may still be waiting for core's word; read core's clock now.
  useCoreNow(req !== undefined && (req.inFlight || coreNow() - req.at < HEAL_WAIT_MS))
  const pending = healPending(heal, req, coreNow())
  const runStatus = useStore(
    (s) => (s.runs.byId[runId]?.snapshot?.summary ?? s.summaries.byId[runId])?.status,
  )
  if (failure === undefined || failure.category === 'user_cancelled') return null
  const title = categoryTitle(failure.category, view.vendor)

  const own = snag?.body.actions ?? []
  const ownIds = new Set(own.map((a) => a.id))
  const done = !pending && heal !== undefined
  // The AI's fixes, less any core already shows (that button stays where it is).
  const suggestions =
    done && heal.status !== 'running' && heal.status !== 'disabled'
      ? heal.actions.filter((a) => !ownIds.has(a.id))
      : []
  const coreHeal = own.find((a) => a.kind === 'heal')
  // Core diagnoses a failed pass only (heal.diagnose refuses a runner step such as preflight or prepare), so a runner
  // step's card keeps core's own list.
  const offer =
    coreHeal !== undefined ||
    (isAgent(view.key) && view.status === 'failed' && !NO_HEAL_CATEGORIES.has(failure.category))
  const healAction: RecoveryAction = coreHeal ?? { id: `${view.key}:heal`, label: HEAL_LABEL, kind: 'heal' }
  const diagnosed = done && (heal.status === 'ok' || heal.status === 'cached')
  // Core orders the heal per failure category: first where asking the AI is the category's primary fix (`unknown`, and
  // flag_drift's "Find the renamed flag"), after the category's own fixes otherwise.
  const healLeads =
    offer && (coreHeal !== undefined ? own[0]?.id === coreHeal.id : failure.category === 'unknown')
  const rest = own.filter((a) => a.kind !== 'heal' && a.kind !== 'close_run')
  const close = own.find((a) => a.kind === 'close_run') ?? (runStatus === 'failed' ? CLOSE_RUN : undefined)
  const localClose = close === CLOSE_RUN
  const aiPrimary = diagnosed && suggestions.length > 0

  // Every button keeps its place once shown (UI standard: nothing moves on its own): the diagnose button stays in its
  // slot when the answer arrives (only its variant changes), Close run stays last in this row, and the AI's fixes are
  // added after the row.
  const main: RecoveryAction[] = [
    ...(healLeads ? [healAction] : []),
    ...rest,
    ...(offer && !healLeads ? [healAction] : []),
    ...(close !== undefined ? [close] : []),
  ]
  // The primary: the AI's first fix once there is one; the diagnose button while it leads and nothing is diagnosed;
  // otherwise core's first fix.
  const primaryId = aiPrimary
    ? null
    : healLeads && !diagnosed
      ? healAction.id
      : (main.find((a) => a.kind !== 'heal')?.id ?? null)
  const handlers: Record<string, () => Promise<unknown>> = {
    [healAction.id]: () => requestHeal(runId, view.key, heal, coreHeal),
    ...(localClose ? { [CLOSE_RUN.id]: () => runCommand(runId, 'runs.close', { runId }) } : {}),
  }
  const pendingIds = pending ? new Set([healAction.id]) : undefined
  const common = { runId, step: view.key, wait: view.wait, handlers, pendingIds }

  return (
    <section
      data-testid={`snag-${view.key}`}
      data-category={failure.category}
      aria-label={`${stepLabel(view.key)} failed: ${title}`}
      className="flex flex-col gap-2 rounded-md border border-st-failed/40 bg-st-failed/5 p-3"
    >
      <div className="flex items-start gap-2">
        <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-st-failed" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-semibold">{title}</p>
          {failure.message !== '' && (
            <p className="text-sm break-words text-muted-foreground">{failure.message}</p>
          )}
        </div>
      </div>
      {snag === undefined ? (
        <p className="text-xs text-muted-foreground">Loading the recovery options…</p>
      ) : main.length === 0 && suggestions.length === 0 ? (
        <p className="text-xs text-muted-foreground">Core recorded no recovery options for this failure.</p>
      ) : (
        <RecoveryActions actions={main} primaryId={primaryId} {...common} />
      )}
      {/* Under core's row, so an answer longer than the "on its way" line grows
          below the buttons and never moves them (UI standard: nothing moves on its own). */}
      <HealDiagnosis heal={heal} pending={pending} testId={`snag-heal-${view.key}`} />

      {suggestions.length > 0 && (
        <div
          role="group"
          aria-label={SUGGESTED_BY_AI}
          data-testid={`snag-suggestions-${view.key}`}
          className="flex flex-col gap-1.5"
        >
          <p className="text-xs font-medium text-muted-foreground">{SUGGESTED_BY_AI}</p>
          <RecoveryActions actions={suggestions} primaryFirst={aiPrimary} {...common} />
        </div>
      )}
      {failure.raw !== '' && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none">Raw error</summary>
          {/* Error output: an inner region with a fixed maximum height that never scrolls the page. */}
          <pre
            data-scroll-region="snag-output"
            className={cn(
              'stream-text mt-1 max-h-[min(15rem,var(--run-region-max,50vh))] rounded bg-muted p-2 break-words whitespace-pre-wrap',
              REGION,
            )}
          >
            {failure.raw}
          </pre>
        </details>
      )}
    </section>
  )
}
