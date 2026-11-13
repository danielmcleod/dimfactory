// Vendor health as a dot and a one-line label (Shell footer, Dashboard right rail, Settings → Vendors). The health state and its copy come from core's ProbeView; this only picks a colour for it. Re-probe and
// Test share `reprobe` (a forced probe). A vendor of the "More" list that is not installed (Gemini before the user
// installs it) is an option, not a vendor to set up: it lights no Settings dot (its row still says "Not installed").
import type { ComponentProps } from 'react'
import type { ProbeView, VendorHealth } from '@shared/vendors.ts'
import { invoke } from '../../ipc/client.ts'
import { cn } from '../../lib/cn.ts'
import { PRIMARY_VENDORS } from '../../pages/dashboard/composer/model.ts'
import { upsertProbes } from '../../state/actions.ts'
import { toast } from '../../state/toasts.ts'

/** `vendors.probe {vendor, force: true}`, storing the answer; core's message as a toast on failure. */
export async function reprobe(vendor: string): Promise<boolean> {
  const r = await invoke('vendors.probe', { vendor, force: true })
  if (r.ok) upsertProbes(r.value)
  else toast({ level: 'error', message: r.error.message })
  return r.ok
}

const DOT: Readonly<Record<VendorHealth, string>> = {
  checking: 'bg-st-queued motion-safe:animate-pulse',
  ready: 'bg-st-done',
  warning: 'bg-st-paused',
  'login-needed': 'bg-st-failed',
  'update-needed': 'bg-st-failed',
  'sandbox-needed': 'bg-st-failed',
  'not-installed': 'bg-st-failed',
  'not-built': 'bg-st-skipped',
  error: 'bg-st-failed',
}

/**
 * Built vendors whose probe says they cannot run a pass yet (the Settings dot). Warnings still run. A "More" vendor
 * that is not installed (Gemini, which the user may never want) is left out; once installed, its login, update or
 * other failure counts like Claude's or Codex's.
 */
export function vendorNotReady(p: ProbeView): boolean {
  if (p.health === 'not-installed' && !PRIMARY_VENDORS.includes(p.vendor)) return false
  return p.built && p.health !== 'ready' && p.health !== 'warning' && p.health !== 'checking'
}

/** The probed CLI version, when a probe finished and found one. */
export function probeVersion(p: ProbeView): string | null {
  return p.probe?.version ?? p.probe?.binary?.version ?? null
}

/** `Claude 2.1.3 · Ready` (tooltips, accessible names). */
export function vendorHealthText(p: ProbeView): string {
  const version = probeVersion(p)
  return `${p.displayName}${version !== null ? ` ${version}` : ''} · ${p.healthDetail}`
}

/** Titles of the probe's failing checks (`Not logged in`, …). */
export function failingCheckTitles(p: ProbeView): string[] {
  return (p.probe?.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.title)
}

export function HealthDot({
  health,
  className,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & { health: VendorHealth }): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-health={health}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT[health], className)}
      {...props}
    />
  )
}
