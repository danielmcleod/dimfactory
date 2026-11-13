// The Codex sandbox chip (the setup card offers the Codex sandbox fix, and the preflight strip shows it as a chip;
// codex-sandbox.spec.ts: the Codex Windows sandbox chip clears the block; the sandbox procedure X11b/X11c; the user sets up
// the Codex sandbox from the chip). One control for the setup card, the composer's preflight strip and Settings →
// Vendors: a status line says how the sandbox is (core's words, the setup's progress, then what core's new probe says),
// and under it [Set up the Codex sandbox] runs core's `vendor_setup` on the click only; after a setup that did not
// finish (or where core offers no unelevated setup), core's elevated command is shown to copy, with the administrator
// terminal and UAC notes and I ran it → Re-check. Once core reads the sandbox ready, the chip is that status line
// alone ("Codex sandbox ready"): nothing is left to set up, so there is no disabled button to explain.
//
// Nothing moves on its own: the status line comes first, on a line of its own and one fixed height, so it stays put
// (and keeps the chip's whole width for core's words) in every phase, its icon swapping in one slot; the button keeps
// its label and width (a spinner takes the icon slot). Beside the button in the setup card (about
// 250 CSS px at the default window) the ready line was cut to "Codex s…". The elevated command sits behind
// [Set up as administrator instead], a disclosure the user opens (setup first, the elevated command below it, the
// fallback's order); it never appears on its own when a setup fails seconds after the click. Once core has answered for the
// vendor, the disclosure's row is there (invisible while core offers no elevated command), and the chip keeps the
// tallest height it reached until the user opens or closes the disclosure, so core's later answers (a setup that
// finished, a probe again, the sandbox reading ready and the rows under the status going) never shift the page.
// Before core's first answer (its first probe of the vendor is running) the chip is the status line alone
// ("Checking Codex…"): a sandbox that reads ready at launch then shows "Codex sandbox ready" with no room held under
// it (rows held while checking left 64 px empty for the whole visit), and one that needs setting up
// gets its rows with core's answer, as the vendor's row above it does (the setup card streams the probes). Test ids (`testId` = the button): `<testId>-line` (the status line) holding `<testId>-status` (its words),
// `<testId>-more` (the disclosure), `<testId>-elevated`, and the chip `<testId>-chip` with `data-phase`.
import { ChevronDown, Shield, ShieldAlert, ShieldCheck, ShieldPlus, ShieldX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { CheckResult } from '@shared/preflight.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { useNow } from '../../lib/ticker.ts'
import { cn } from '../../lib/cn.ts'
import { useProbe } from '../../state/selectors.ts'
import { Button } from '../ui/Button.tsx'
import { DisabledHint, LATER_VERSION } from '../ui/DisabledHint.tsx'
import { laterReason, useKindSupport } from './execute.ts'
import type { RecoveryContext } from './execute.ts'
import { RecoveryActions } from './RecoveryActions.tsx'
import {
  elevatedActionsOf,
  ELEVATED_NEXT,
  ELEVATED_TOGGLE_LABEL,
  runVendorSetup,
  SANDBOX_SET_UP_LABEL,
  sandboxPhase,
  setupActionOf,
  setupVendorName,
  useSetupRun,
  winSandboxCheck,
} from './sandboxSetup.ts'
import type { SandboxPhase } from './sandboxSetup.ts'
import { setupStatusClass, setupStatusText } from './VendorSetupControl.tsx'

/** Why the chip cannot set the sandbox up when core reported nothing to do it with. */
export function noSetupReason(view: ProbeView | undefined, name: string): string {
  if (view === undefined || view.checking || view.health === 'checking') return `Checking ${name}…`
  if (!view.built || view.health === 'not-built') return LATER_VERSION
  if (view.health === 'not-installed') return `Install ${name} first`
  return `${name} did not report its sandbox`
}

/**
 * The chip's line before any setup ran: how the sandbox is in core's words (the vendor's own sandbox check, so the
 * strip's chip under "Codex cannot run Implement…" does not repeat its title; else the check it was offered for), or
 * why there is nothing to set up.
 */
function idleText(
  phase: SandboxPhase,
  check: CheckResult | undefined,
  view: ProbeView | undefined,
  name: string,
) {
  if (phase === 'needed' || phase === 'unavailable') {
    const own = winSandboxCheck(view)?.title ?? ''
    return own !== '' ? own : (check?.title ?? '')
  }
  if (phase === 'unknown') return noSetupReason(view, name)
  return ''
}

/** The status line's icon in each phase: one slot, so the words after it never move when it changes. */
export const SANDBOX_PHASE_ICON: Readonly<Record<SandboxPhase, LucideIcon>> = {
  unknown: Shield,
  needed: ShieldAlert,
  unavailable: ShieldAlert,
  running: Shield,
  failed: ShieldX,
  ready: ShieldCheck,
}

export interface SandboxChipProps {
  /** The vendor whose sandbox it sets up (Codex). */
  vendor?: string
  /** The check the chip is shown for (a preflight report's); default: the vendor's probe `winSandbox` check. */
  check?: CheckResult | undefined
  /** Where the actions were offered (a composer folder, a run), for recovery.execute. */
  ctx?: RecoveryContext
  /** After the setup or a Re-check: re-run whatever showed the chip (the composer's live preflight). */
  onRecheck?: (() => unknown) | undefined
  /** The button's test id. */
  testId: string
  size?: 'sm' | 'md'
  className?: string
}

export function SandboxChip({
  vendor = 'codex',
  check,
  ctx = {},
  onRecheck,
  testId,
  size = 'sm',
  className,
}: SandboxChipProps): React.JSX.Element {
  const statusId = useId()
  const elevatedId = useId()
  const [elevatedOpen, setElevatedOpen] = useState(false)
  // The tallest the chip has been since the user last opened or closed the disclosure (px).
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return
    const grow = (): void => {
      const h = el.getBoundingClientRect().height
      setRoom((r) => (h > r ? h : r))
    }
    grow()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(grow)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const view = useProbe(vendor)
  const run = useSetupRun(vendor)
  const support = useKindSupport('vendor_setup')
  const offered = check ?? winSandboxCheck(view)
  const phase = sandboxPhase(view, run, check)
  const ready = phase === 'ready'
  const running = phase === 'running'
  const now = useNow(running)
  const name = setupVendorName(vendor, view)
  const setup = setupActionOf(offered)
  const elevated = elevatedActionsOf(offered)
  const text = setupStatusText(phase, run, name, now, idleText(phase, offered, view, name))
  const StatusIcon = SANDBOX_PHASE_ICON[phase]

  const reason: string | null = running
    ? null
    : setup === undefined
      ? phase === 'unavailable'
        ? offered?.detail !== undefined && offered.detail !== ''
          ? offered.detail
          : (offered?.title ?? noSetupReason(view, name))
        : noSetupReason(view, name)
      : (laterReason(setup, view) ?? (support === 'no' ? LATER_VERSION : null))

  const button = (
    <Button
      size={size}
      variant={phase === 'needed' || phase === 'failed' ? 'default' : 'outline'}
      data-testid={testId}
      data-kind="vendor_setup"
      icon={<ShieldPlus aria-hidden />}
      loading={running}
      disabled={reason !== null}
      aria-describedby={statusId}
      onClick={() => {
        if (setup !== undefined) void runVendorSetup(setup, ctx, onRecheck)
      }}
    >
      {SANDBOX_SET_UP_LABEL}
    </Button>
  )
  // Core's first probe of the vendor is still running: the status line alone, nothing held under it.
  const waiting = phase === 'unknown' && (view === undefined || view.health === 'checking')
  // The elevated command (the sandbox's elevated fallback, X11c), offered whenever core offers it and the sandbox is not ready; the row of its
  // disclosure is kept (invisible) while core offers no setup it can name (`unknown` after its answer: not installed,
  // not in this build), so a later answer offering it moves nothing.
  const offerElevated = elevated.length > 0 && !ready && phase !== 'unknown'
  const reserveRow = offerElevated || (phase === 'unknown' && !waiting)
  const showElevated = elevatedOpen && offerElevated
  return (
    <div
      ref={rootRef}
      data-testid={`${testId}-chip`}
      data-phase={phase}
      style={room > 0 ? { minHeight: room } : undefined}
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
    >
      {/* First and on its own line of one height: the same place in every phase, the chip's whole width for its words
          (cut with an ellipsis only past that, whole in its title). */}
      <div
        data-testid={`${testId}-line`}
        className={cn('flex h-4 min-w-0 items-center gap-1.5 text-xs', setupStatusClass(phase))}
      >
        <StatusIcon aria-hidden data-phase-icon={phase} className="size-3.5 shrink-0" />
        <p
          id={statusId}
          role="status"
          data-testid={`${testId}-status`}
          title={text !== '' ? text : undefined}
          className="min-w-0 flex-1 truncate tabular-nums"
        >
          {text}
        </p>
      </div>
      {!ready && !waiting && (
        <div className="flex min-w-0 items-center">
          {reason !== null ? (
            <DisabledHint reason={reason} className="shrink-0">
              {button}
            </DisabledHint>
          ) : (
            button
          )}
        </div>
      )}
      {reserveRow && (
        <div
          className={cn('flex min-w-0 items-center', !offerElevated && 'invisible')}
          aria-hidden={offerElevated ? undefined : true}
        >
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testId}-more`}
            aria-expanded={showElevated}
            aria-controls={elevatedId}
            disabled={!offerElevated}
            icon={
              <ChevronDown aria-hidden className={cn('transition-transform', showElevated && 'rotate-180')} />
            }
            onClick={() => {
              // A user's toggle: the chip may take its new height now.
              setRoom(0)
              setElevatedOpen((v) => !v)
            }}
            className="h-6 px-1.5 text-xs text-muted-foreground"
          >
            {ELEVATED_TOGGLE_LABEL}
          </Button>
        </div>
      )}
      {showElevated && (
        <div id={elevatedId} data-testid={`${testId}-elevated`} className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{ELEVATED_NEXT}</p>
          <RecoveryActions
            actions={elevated}
            layout="commands"
            onRecheck={onRecheck}
            {...(ctx.runId !== undefined ? { runId: ctx.runId } : {})}
            {...(ctx.folder !== undefined ? { folder: ctx.folder } : {})}
            {...(offered !== undefined ? { check: offered } : {})}
          />
        </div>
      )}
    </div>
  )
}
