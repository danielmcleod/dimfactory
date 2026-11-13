// Core's `vendor_setup` fix as one control (it runs on click; UI control standards): [label] and, on the same line, what the setup is doing: the time it has taken while core sets
// the sandbox up, then core's answer once it probed the vendor again. Shared by every RecoveryActions list (snag
// cards, preflight cards and chips, Settings → Vendors, the setup card's rows).
//
// The button keeps its label and width (a spinner takes its icon slot); the status sits beside it on one line, cut
// with an ellipsis and whole in its tooltip, so nothing moves while it changes. Test ids: the button
// `recovery-<actionId>` (`data-kind="vendor_setup"`), the line `vendor-setup-status-<actionId>`.
import { ShieldPlus } from 'lucide-react'
import { useId } from 'react'
import { formatClock } from '../../lib/format.ts'
import { useNow } from '../../lib/ticker.ts'
import { cn } from '../../lib/cn.ts'
import { useProbe } from '../../state/selectors.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint } from '../ui/DisabledHint.tsx'
import type { RecoveryContext } from './execute.ts'
import {
  runVendorSetup,
  sandboxFailedText,
  sandboxPhase,
  sandboxReadyText,
  sandboxRunningText,
  setupVendorName,
  useSetupRun,
} from './sandboxSetup.ts'
import type { SandboxPhase, SetupRun, VendorSetupAction } from './sandboxSetup.ts'

/** The status line's words for a phase ('' when there is nothing to say yet). */
export function setupStatusText(
  phase: SandboxPhase,
  run: SetupRun | undefined,
  name: string,
  now: number,
  idle = '',
): string {
  switch (phase) {
    case 'running':
      return sandboxRunningText(name, formatClock(run?.state === 'running' ? now - run.startedAt : 0))
    case 'ready':
      return sandboxReadyText(name)
    case 'failed':
      return sandboxFailedText(run?.state === 'failed' ? run.message : '')
    case 'needed':
    case 'unavailable':
    case 'unknown':
      return idle
  }
}

/** The status line's colour: ready in green, a failed setup in red. */
export function setupStatusClass(phase: SandboxPhase): string {
  return phase === 'ready'
    ? 'text-success'
    : phase === 'failed'
      ? 'text-destructive'
      : 'text-muted-foreground'
}

export interface VendorSetupControlProps {
  action: VendorSetupAction
  ctx: RecoveryContext
  onRecheck?: (() => unknown) | undefined
  size: 'sm' | 'md'
  variant: 'default' | 'outline'
  /** Why it cannot run now (core's disabledReason, a core without the executor), or null. */
  reason: string | null
}

export function VendorSetupControl({
  action: a,
  ctx,
  onRecheck,
  size,
  variant,
  reason,
}: VendorSetupControlProps): React.JSX.Element {
  const statusId = useId()
  const view = useProbe(a.vendor)
  const run = useSetupRun(a.vendor)
  const phase = sandboxPhase(view, run)
  const running = phase === 'running'
  const now = useNow(running)
  const name = setupVendorName(a.vendor, view)
  const text = setupStatusText(phase, run, name, now)
  const why = reason ?? (phase === 'ready' ? `The ${name} sandbox is set up` : null)
  const button = (
    <Button
      size={size}
      variant={variant}
      data-testid={`recovery-${a.id}`}
      data-kind={a.kind}
      icon={<ShieldPlus aria-hidden />}
      loading={running}
      disabled={why !== null}
      aria-describedby={statusId}
      onClick={() => void runVendorSetup(a, ctx, onRecheck)}
    >
      {a.label}
    </Button>
  )
  return (
    <div className="flex min-w-0 items-center gap-2" data-setup-phase={phase}>
      {why !== null && !running ? <DisabledHint reason={why}>{button}</DisabledHint> : button}
      <p
        id={statusId}
        role="status"
        data-testid={`vendor-setup-status-${a.id}`}
        title={text !== '' ? text : undefined}
        className={cn('min-w-0 flex-1 truncate text-xs tabular-nums', setupStatusClass(phase))}
      >
        {text}
      </p>
    </div>
  )
}
