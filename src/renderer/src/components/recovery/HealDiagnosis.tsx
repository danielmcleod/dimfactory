// What the AI diagnosis says (self-heal: parsing, hidden unsafe suggestions; if the healer fails, the raw error plus
// open_docs; the snag card's one-line diagnosis). One block for every state of a HealView:
// on its way (the button beside it carries the spinner; this line says what is happening and what the AI sees),
// the diagnosis with its confidence, "Dim Factory hid N unsafe suggestions", the raw error of a failed heal, and "turned
// off" with a link to Settings → Self-heal. The suggested fixes are the caller's RecoveryActions.
import { Sparkles } from 'lucide-react'
import type { HealView } from '@shared/failure.ts'
import { cn } from '../../lib/cn.ts'
import { navigate } from '../../lib/router.ts'
import { Button } from '../ui/Button.tsx'
import {
  autoAppliedText,
  diagnosisText,
  HEAL_DISABLED_TEXT,
  HEAL_FAILED_TEXT,
  HEAL_NOTHING_TEXT,
  HEAL_RUNNING_TEXT,
  hiddenText,
  SELF_HEAL_ROUTE,
} from './heal.ts'

export const OPEN_SELF_HEAL_LABEL = 'Open Self-heal settings'

export interface HealDiagnosisProps {
  heal: HealView | undefined
  /** A diagnosis is on its way (core runs it, or the user just asked). */
  pending: boolean
  testId: string
  className?: string
}

export function HealDiagnosis({
  heal,
  pending,
  testId,
  className,
}: HealDiagnosisProps): React.JSX.Element | null {
  if (!pending && heal === undefined) return null
  const status = pending ? 'running' : (heal?.status ?? 'running')
  const hidden = heal !== undefined && !pending ? hiddenText(heal) : null
  const applied = heal !== undefined && !pending ? autoAppliedText(heal) : null
  return (
    <div
      data-testid={testId}
      data-status={status}
      className={cn('flex min-h-5 flex-col gap-1 text-xs', className)}
    >
      <p className="flex items-start gap-1.5">
        <Sparkles aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 break-words" data-testid={`${testId}-text`}>
          {status === 'running'
            ? HEAL_RUNNING_TEXT
            : status === 'disabled'
              ? HEAL_DISABLED_TEXT
              : status === 'failed'
                ? HEAL_FAILED_TEXT
                : heal !== undefined
                  ? diagnosisText(heal)
                  : ''}
        </span>
      </p>
      {status === 'failed' && heal?.error !== undefined && heal.error !== '' && (
        // The healer's raw error: short (core truncates it), so it reads in the page flow.
        <pre
          data-testid={`${testId}-error`}
          className="stream-text ml-5 rounded bg-muted p-2 break-words whitespace-pre-wrap"
        >
          {heal.error}
        </pre>
      )}
      {(status === 'ok' || status === 'cached') &&
        heal !== undefined &&
        heal.actions.length === 0 &&
        heal.hidden === 0 && <p className="ml-5 text-muted-foreground">{HEAL_NOTHING_TEXT}</p>}
      {applied !== null && (
        <p data-testid={`${testId}-applied`} className="ml-5 text-muted-foreground">
          {applied}
        </p>
      )}
      {hidden !== null && (
        <p data-testid={`${testId}-hidden`} className="ml-5 text-muted-foreground">
          {hidden}
        </p>
      )}
      {status === 'disabled' && (
        <div className="ml-5">
          <Button
            size="sm"
            variant="outline"
            data-testid={`${testId}-settings`}
            onClick={() => navigate(SELF_HEAL_ROUTE)}
          >
            {OPEN_SELF_HEAL_LABEL}
          </Button>
        </div>
      )}
    </div>
  )
}
