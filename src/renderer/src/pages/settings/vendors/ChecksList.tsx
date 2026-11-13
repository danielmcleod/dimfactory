// A vendor probe's checks with their fixes: status icon, core's title and detail, and the recovery actions of a check
// that warns or fails. A
// check whose fixes the card shows elsewhere (Codex's sandbox, in the card's Sandbox row) says where they are instead.
import { CircleAlert, CircleCheck, CircleMinus, CircleX } from 'lucide-react'
import type { CheckResult, CheckStatus } from '@shared/preflight.ts'
import { RecoveryActions } from '../../../components/recovery/RecoveryActions.tsx'
import { cn } from '../../../lib/cn.ts'

export const CHECK_ICON: Readonly<
  Record<CheckStatus, { icon: typeof CircleCheck; className: string; label: string }>
> = {
  pass: { icon: CircleCheck, className: 'text-success', label: 'Passed' },
  warn: { icon: CircleAlert, className: 'text-warning', label: 'Warning' },
  fail: { icon: CircleX, className: 'text-destructive', label: 'Failed' },
  skip: { icon: CircleMinus, className: 'text-muted-foreground', label: 'Skipped' },
}

export function ChecksList({
  label,
  checks,
  fixesElsewhere,
}: {
  label: string
  checks: readonly CheckResult[]
  /** Check ids whose fixes the card shows in another row, with the words that say where. */
  fixesElsewhere?: Readonly<Record<string, string>> | undefined
}): React.JSX.Element {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {checks.map((c) => {
        const s = CHECK_ICON[c.status]
        const Icon = s.icon
        const failing = c.status === 'warn' || c.status === 'fail'
        const elsewhere = failing ? fixesElsewhere?.[c.id] : undefined
        const fixes = failing && elsewhere === undefined ? c.recovery : []
        return (
          <li
            key={c.id}
            data-testid={`vendor-check-${c.id}`}
            data-check-id={c.id}
            data-status={c.status}
            className="flex gap-2 text-sm"
          >
            <Icon aria-label={s.label} role="img" className={cn('mt-0.5 size-4 shrink-0', s.className)} />
            {/* A path in a check ("/home/…/claude (configured path; …)") breaks anywhere: one with no hyphen or space
                is a single word, wider than a narrow card. */}
            <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
              <p>{c.title}</p>
              {c.detail !== '' && (
                <p className="text-xs whitespace-pre-wrap text-muted-foreground">{c.detail}</p>
              )}
              {elsewhere !== undefined && <p className="text-xs text-muted-foreground">{elsewhere}</p>}
              {fixes.length > 0 && <RecoveryActions actions={fixes} check={c} />}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
