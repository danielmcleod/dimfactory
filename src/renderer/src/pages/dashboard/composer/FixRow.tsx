// The Fix row's session choice (Reuse / Fresh / Fresh, different vendor).
// Reuse = reuseSession on Implement's vendor; Fresh = reuseSession off; "Fresh, different vendor" = reuseSession off
// plus core's other ready vendor (config.resolve suggestions). The current choice is core's decideSession answer for
// the resolved config; when it starts Fix fresh, core's reason is worded as the Fix card's session line words it
// (components/run/SessionLine.tsx: `Fresh session: <reason>` + "Why?"). Why Reuse cannot happen is core's
// `pass.fix.resume` result, shown as core words it (its title left out when the session line says the same reason).
import { Info } from 'lucide-react'
import type { ComposerSuggestions } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import type { FreshReason } from '@shared/run.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { FreshReasonLine } from '../../../components/run/SessionLine.tsx'
import { FRESH_REASON_TEXT } from '../../../components/run/text.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/Select.tsx'
import { FIX_SESSION_LABEL, passOf, vendorText } from './model.ts'
import type { FixSession, ResolvedView } from './model.ts'

export interface FixSessionSelectProps {
  value: FixSession
  /** Vendor "Fresh, different vendor" would use (display name), or null when no other vendor is ready. */
  otherVendor: string | null
  resumeCheck: CheckResult | null
  /** Core's FreshReason when Fix will start fresh (config.resolve `suggestions.fixSession.reason`). */
  reason?: FreshReason | undefined
  /** Display names of Fix's and Implement's vendors, for the reason's "Why?" sentence. */
  fixVendor?: string | undefined
  implementVendor?: string | undefined
  disabled?: boolean
  onChange: (session: FixSession) => void
}

/**
 * Core's `pass.fix.resume` as the row's note: `title · detail`. While the session line above already states core's
 * fresh reason and the check's title ends in the same words ("Fix will start fresh: set to start fresh"), only the
 * detail is shown, so the reason is not said twice. null when there is nothing to show.
 */
export function fixResumeNote(check: CheckResult | null, reason: FreshReason | undefined): string | null {
  if (check === null) return null
  const detail = check.detail !== '' && check.detail !== check.title ? check.detail : ''
  if (reason !== undefined && check.title.endsWith(FRESH_REASON_TEXT[reason]))
    return detail !== '' ? detail : null
  return detail !== '' ? `${check.title} · ${detail}` : check.title
}

/** The reason props for FixSessionSelect: core's fixSession reason and the two vendors' display names. */
export function fixSessionReason(
  config: ResolvedView,
  suggestions: ComposerSuggestions | undefined,
  probes: readonly ProbeView[],
): Pick<FixSessionSelectProps, 'reason' | 'fixVendor' | 'implementVendor'> {
  const reason = suggestions?.fixSession.reason
  if (reason === undefined) return {}
  return {
    reason,
    fixVendor: vendorText(passOf(config, 'fix').vendor, config, probes),
    implementVendor: vendorText(passOf(config, 'implement').vendor, config, probes),
  }
}

const SESSIONS: readonly FixSession[] = ['reuse', 'fresh', 'fresh-other']

export function FixSessionSelect({
  value,
  otherVendor,
  resumeCheck,
  reason,
  fixVendor,
  implementVendor,
  disabled,
  onChange,
}: FixSessionSelectProps): React.JSX.Element {
  const note = fixResumeNote(resumeCheck, reason)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span id="fix-session-label" className="w-16 text-xs text-muted-foreground">
          Session
        </span>
        <Select value={value} onValueChange={(v) => onChange(v as FixSession)} disabled={disabled === true}>
          <SelectTrigger
            size="sm"
            data-testid="fix-session"
            aria-labelledby="fix-session-label"
            className="w-60"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SESSIONS.map((s) => {
              const unavailable = s === 'fresh-other' && otherVendor === null
              return (
                <SelectItem key={s} value={s} disabled={unavailable}>
                  {s === 'fresh-other' && otherVendor !== null
                    ? `${FIX_SESSION_LABEL[s]} (${otherVendor})`
                    : FIX_SESSION_LABEL[s]}
                  {unavailable ? ' · no other vendor is ready' : ''}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>
      {reason !== undefined && (
        <FreshReasonLine
          reason={reason}
          context={{ step: 'fix', vendor: fixVendor, implementVendor, planned: true }}
          testId="fix-session-reason"
          textTestId="fix-session-reason-text"
          whyTestId="fix-session-reason-why"
          className="pl-18"
        />
      )}
      {note !== null && (
        <p
          data-testid="fix-session-note"
          className="flex items-start gap-1 pl-18 text-xs text-muted-foreground"
        >
          <Info aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>{note}</span>
        </p>
      )}
    </div>
  )
}
