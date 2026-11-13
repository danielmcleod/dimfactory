// Setup card (the first-run script, first-launch.spec.ts): shown until it is
// dismissed (state.json `setupDismissed`) or Claude and Codex are both ready (and git is not failing). Each vendor's
// row follows the probe events as they arrive ("Checking Claude…", then "Claude ready" or "Claude: login needed [Copy the
// login command]"), with the fixes of its failing check from core (for a vendor not in this build, only its install
// command); git's row is core's app.git result from dashboard.get, with its install fix; then the profile first
// launch selected, and the Codex sandbox chip: on Windows, [Set up the Codex sandbox] runs core's vendor_setup on
// the click, shows its progress and then what core's new probe says, with core's elevated command (UAC) after a setup
// that did not finish (components/recovery/SandboxChip.tsx). Codex's row leaves its sandbox fixes to the chip.
// Gemini is optional, so it has a row once its probe found it on this computer (ready, login needed, update needed);
// a computer without it gets no row (no red "not installed" block for a vendor nobody has to install,
// as the shell's Settings dot leaves it out, and no row growing seconds after the card showed, when the launch probe
// answers after the first-launch ones). Gemini works only in folders the user trusted for it, so once its probe found
// it the card also holds the folder trust chip for the folder the composer checks (components/recovery/
// FolderTrustChip.tsx): whether Gemini may work there, what trusting means in plain words, and [Trust this folder for
// Gemini], which writes the grant on the click (gemini-trust.spec.ts); the composer's checks then run again.
//
// Nothing moves on its own (UI standard): whether the card shows is decided once per
// visit to the Dashboard, as soon as state.json's setupDismissed is known (the rail waits for it, RightRail.tsx), and
// changes after that only through the user's Dismiss or Undo. A vendor becoming ready while the card is shown leaves
// it in place (its row then says so); the card is gone on the next visit. The profile line keeps its room while
// core resolves it. The optional vendors' rows and trust chips are decided with the card, from the probes
// in at that moment. An optional vendor's probe that answers later (Gemini's launch probe lands seconds after the
// first-launch ones) adds nothing to this visit's card, so the git row, the profile line, the sandbox chip and the rail
// below never move down on their own; the next visit lists it.
import { Rocket, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { CheckResult } from '@shared/preflight.ts'
import { vendorCheckId } from '@shared/preflight.ts'
import type { ProbeView, VendorHealth } from '@shared/vendors.ts'
import { needsFolderTrust } from '@shared/vendors.ts'
import { FolderTrustChip } from '../../../components/recovery/FolderTrustChip.tsx'
import { RecoveryActions } from '../../../components/recovery/RecoveryActions.tsx'
import { SandboxChip } from '../../../components/recovery/SandboxChip.tsx'
import { setupActionOf } from '../../../components/recovery/sandboxSetup.ts'
import { HealthDot, probeVersion } from '../../../components/shell/VendorHealth.tsx'
import { Button } from '../../../components/ui/Button.tsx'
import { getDimFactory, invoke } from '../../../ipc/client.ts'
import { cn } from '../../../lib/cn.ts'
import { useKeptHeight } from '../../../lib/keptHeight.ts'
import { useConfigEpoch, useProbes } from '../../../state/selectors.ts'
import { toast } from '../../../state/toasts.ts'
import { useComposerFolder } from '../../../state/trust.ts'

/** The vendors the built-in profiles use (first launch picks the profile from their readiness). */
export const PRIMARY_VENDORS = ['claude', 'codex'] as const

/** Health that can run a pass (a warning still runs). */
export function isReady(p: ProbeView): boolean {
  return p.health === 'ready' || p.health === 'warning'
}

/** The row's line: core's health in the first-run script's words. */
export function setupLine(p: ProbeView): string {
  const name = p.displayName
  switch (p.health) {
    case 'checking':
      return `Checking ${name}…`
    case 'ready':
      return `${name} ready`
    case 'warning':
      return `${name} ready · ${p.healthDetail}`
    case 'not-installed':
      return `${name} not installed`
    case 'login-needed':
      return `${name}: login needed`
    case 'update-needed':
      return `${name}: update needed`
    case 'sandbox-needed':
      return `${name}: sandbox setup needed`
    case 'not-built':
      return `${name}: arrives in a later version`
    case 'error':
      return `${name}: ${p.healthDetail}`
  }
}

/** The check whose fixes the row offers: the first blocking failure, else the first failure. */
function fixingCheck(p: ProbeView): CheckResult | undefined {
  const failed = (p.probe?.checks ?? []).filter((c) => c.status === 'fail')
  return failed.find((c) => c.blocking) ?? failed[0]
}

/**
 * A built vendor outside Claude and Codex (Gemini) is optional. The card lists it once its probe found
 * it on this computer (ready, or found and needing a sign-in or an update); without it (not installed, or its first
 * probe still running) the card has no row for it. Settings → Vendors and the composer's "More" list still say how
 * to install it. Keeps the card the Claude and Codex card the first-run script describes, and the probe
 * of an optional vendor, which answers after the first-launch probes, never grows the card seconds after it showed.
 */
export function listsOptionalVendor(p: ProbeView): boolean {
  if ((PRIMARY_VENDORS as readonly string[]).includes(p.vendor)) return false
  // An Experimental vendor (Muse) is never suggested; the user picks it under "More".
  if (p.experimental) return false
  return p.built && p.probe !== null && p.health !== 'not-installed' && p.health !== 'not-built'
}

/**
 * A vendor that works only in folders the user trusted for it (Gemini) and that its probe found on this computer:
 * the card then offers to trust the composer's folder for it (decided with the card). Not an
 * Experimental one (Muse), which the card neither lists nor suggests.
 */
export function offersFolderTrust(p: ProbeView): boolean {
  return (
    needsFolderTrust(p.vendor) &&
    // Never for an Experimental vendor (Muse): the composer's strip offers its grant once the user picks it.
    !p.experimental &&
    p.built &&
    p.probe !== null &&
    p.health !== 'not-installed' &&
    p.health !== 'not-built' &&
    p.health !== 'checking'
  )
}

/** Before the card is decided: no optional vendor listed. */
const NONE_OPTIONAL = { rows: [], trust: [] } as const

/** Text under a row whose sandbox fixes are the chip's (the chip names the button). */
export const SANDBOX_BELOW = 'Set it up with the sandbox button below.'

function VendorRow({ probe, sandboxChip }: { probe: ProbeView; sandboxChip: boolean }): React.JSX.Element {
  const [keptRef, kept] = useKeptHeight<HTMLLIElement>()
  const version = probeVersion(probe)
  const check = isReady(probe) || probe.checking ? undefined : fixingCheck(probe)
  // The sandbox setup and its elevated command are the chip's, below the rows (one button for one fix): any check that
  // offers the setup, and Codex's own sandbox check (whose only fix may be the elevated command).
  const sandbox =
    sandboxChip &&
    check !== undefined &&
    (setupActionOf(check) !== undefined || check.id === vendorCheckId(probe.vendor, 'winSandbox'))
  // A vendor not in this build: only its install command helps here (the profile already leaves it out).
  const actions =
    check === undefined || sandbox
      ? []
      : probe.built
        ? check.recovery
        : check.recovery.filter((a) => a.kind === 'shell_copy')
  const detail = check !== undefined && probe.built ? check.detail : ''
  return (
    <li
      // The row keeps the room it reached while the card shows (a sandbox set up seconds after the click, a login
      // that took): it says "ready" in fewer lines without pulling the rail up (UI standard: async content never
      // shifts the page).
      ref={keptRef}
      style={kept}
      data-testid={`setup-vendor-${probe.vendor}`}
      data-health={probe.health}
      // Greyed while the vendor cannot be used at all (first-launch.spec.ts: Codex greyed with an install tooltip): not in
      // this build, or not installed; the install command stays a live button.
      className={cn(
        'flex flex-col gap-1.5',
        (probe.health === 'not-built' || probe.health === 'not-installed') && 'text-muted-foreground',
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <HealthDot health={probe.checking ? 'checking' : probe.health} />
        <span className="min-w-0 flex-1">
          {probe.checking ? `Checking ${probe.displayName}…` : setupLine(probe)}
        </span>
        {version !== null && isReady(probe) && (
          <span className="text-xs text-muted-foreground tabular-nums">{version}</span>
        )}
      </div>
      {check !== undefined && (detail !== '' || actions.length > 0 || sandbox) && (
        <div className="flex flex-col gap-1 pl-4">
          {detail !== '' && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{detail}</p>}
          {sandbox && <p className="text-xs text-muted-foreground">{SANDBOX_BELOW}</p>}
          <RecoveryActions actions={actions} check={check} />
        </div>
      )}
    </li>
  )
}

/** Health dot for core's app.git result. */
const GIT_HEALTH: Readonly<Record<CheckResult['status'], VendorHealth>> = {
  pass: 'ready',
  warn: 'warning',
  fail: 'error',
  skip: 'checking',
}

/**
 * Git's row (the setup card probes vendors and git): core's app.git result from dashboard.get, "Git
 * ready" or core's failure with its install fix (copy → "I ran it → Re-check" asks core again).
 */
function GitRow({ check, onRecheck }: { check: CheckResult; onRecheck: () => unknown }): React.JSX.Element {
  const ok = check.status === 'pass'
  return (
    <li data-testid="setup-git" data-status={check.status} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <HealthDot health={GIT_HEALTH[check.status]} />
        <span className="min-w-0 flex-1">{ok ? 'Git ready' : check.title}</span>
        {ok && <span className="text-xs text-muted-foreground tabular-nums">{check.title}</span>}
      </div>
      {!ok && (check.detail !== '' || check.recovery.length > 0) && (
        <div className="flex flex-col gap-1 pl-4">
          {check.detail !== '' && (
            <p className="text-xs whitespace-pre-wrap text-muted-foreground">{check.detail}</p>
          )}
          <RecoveryActions actions={check.recovery} check={check} onRecheck={onRecheck} />
        </div>
      )}
    </li>
  )
}

function names(list: readonly ProbeView[]): string {
  const n = list.map((p) => p.displayName)
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1) ?? ''}`
}

/** `Using claude-only (Codex isn't ready)`. */
export function profileLine(profile: string, primary: readonly ProbeView[]): string {
  const notReady = primary.filter((p) => !isReady(p) && !p.checking && p.health !== 'checking')
  if (notReady.length === 0) return `Using ${profile}`
  return `Using ${profile} (${names(notReady)} ${notReady.length === 1 ? "isn't" : "aren't"} ready)`
}

function useProfile(enabled: boolean): string | null {
  const epoch = useConfigEpoch()
  const [profile, setProfile] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void invoke('config.resolve', {}).then((r) => {
      if (alive && r.ok) setProfile(r.value.config.profile)
    })
    return () => {
      alive = false
    }
  }, [enabled, epoch])
  return profile
}

export interface SetupState {
  /** state.json's setupDismissed; null until it answered, and when it could not be read (the card stays hidden). */
  dismissed: boolean | null
  /** state.get has answered (or failed) at least once this session. */
  known: boolean
}

const NOT_KNOWN: SetupState = { dismissed: null, known: false }
const useSetupStore = create<SetupState>()(() => NOT_KNOWN)
/** Bumped by resetSetupStateForTests: an answer to an older request is dropped. */
let generation = 0

/** Ask state.json again (each Dashboard visit); what was known stays meanwhile, so a later visit decides at once. */
function refreshSetupState(): void {
  const gen = generation
  void invoke('state.get').then((r) => {
    if (gen !== generation) return
    useSetupStore.setState(r.ok ? { dismissed: r.value.setupDismissed, known: true } : { known: true })
  })
}

/** Tests: forget what state.json said. */
export function resetSetupStateForTests(): void {
  generation++
  useSetupStore.setState(NOT_KNOWN, true)
}

/** state.json's setupDismissed, asked again on mount; the rail and the card share it. */
export function useSetupState(): SetupState {
  const dismissed = useSetupStore((s) => s.dismissed)
  const known = useSetupStore((s) => s.known)
  useEffect(() => refreshSetupState(), [])
  return { dismissed, known }
}

/** Whether state.json has answered this session (without asking it again: the card it holds does). */
export function useSetupKnown(): boolean {
  return useSetupStore((s) => s.known)
}

/** state.json's setupDismissed as last known (null: not known), without asking it again. */
export function useSetupDismissed(): boolean | null {
  return useSetupStore((s) => s.dismissed)
}

/**
 * A primary vendor (Claude, Codex) whose first probe has not answered yet: its setup row says "Checking…" and grows
 * when the answer lands (a Codex that is not installed: one line to its detail and install fixes). Also no vendor
 * view at all yet (core's vendors.list has not answered: the card would fill in when it does). A vendor without a view
 * among others (a stub list), or one probed before, is not waited for.
 */
export function primaryProbePending(probes: readonly ProbeView[]): boolean {
  if (probes.length === 0) return true
  return PRIMARY_VENDORS.some((v) => {
    const p = probes.find((x) => x.vendor === v)
    return p !== undefined && p.probe === null && (p.checking || p.health === 'checking')
  })
}

/** Dismiss or Undo: state.set, then what core wrote. False (with an error toast) when it failed. */
async function setDismissed(v: boolean): Promise<boolean> {
  const r = await invoke('state.set', { setupDismissed: v })
  if (!r.ok) {
    toast({ level: 'error', message: r.error.message })
    return false
  }
  useSetupStore.setState({ dismissed: r.value.setupDismissed, known: true })
  return true
}

export interface SetupCardProps {
  /** Core's app-scope checks (dashboard.get `appChecks`): git's row; none before core answered. */
  appChecks?: readonly CheckResult[] | undefined
  /** Ask core again (git's "I ran it → Re-check"). */
  onRecheckApp?: (() => unknown) | undefined
  /**
   * Whether what the card depends on is in (the rail's wait is over), so whether it shows can be decided; default
   * true. The decision then holds for this visit.
   */
  settled?: boolean
}

export function SetupCard({
  appChecks,
  onRecheckApp,
  settled = true,
}: SetupCardProps = {}): React.JSX.Element | null {
  const probes = useProbes()
  const { dismissed } = useSetupState()
  const primary = probes.filter((p) => (PRIMARY_VENDORS as readonly string[]).includes(p.vendor))
  const allReady = primary.length === PRIMARY_VENDORS.length && primary.every(isReady)
  const git = appChecks?.find((c) => c.id === 'app.git')
  const gitFailing = git !== undefined && git.status === 'fail'
  const needed = !allReady || gitFailing
  // Decided once, when state.json has answered and the rail has what it waits for; then only Dismiss/Undo change it.
  const [decided, setDecided] = useState<boolean | null>(null)
  // The optional vendors' rows and trust chips this visit, decided with the card (a probe that answers
  // later never adds one).
  const [optional, setOptional] = useState<{ rows: readonly string[]; trust: readonly string[] }>(
    NONE_OPTIONAL,
  )
  if (decided === null && dismissed !== null && settled) {
    setDecided(dismissed === false && needed)
    setOptional({
      rows: probes.filter(listsOptionalVendor).map((p) => p.vendor),
      trust: probes.filter(offersFolderTrust).map((p) => p.vendor),
    })
  }
  const show = decided === true && dismissed === false
  const profile = useProfile(show)
  const [busy, setBusy] = useState(false)
  // The folder the composer checks, for the folder trust chip (Gemini).
  const composerFolder = useComposerFolder()
  if (!show) return null
  const windows = getDimFactory()?.platform === 'win32'
  const trusting = probes.filter((p) => optional.trust.includes(p.vendor))

  const ordered = [
    ...PRIMARY_VENDORS.map((v) => primary.find((p) => p.vendor === v)).filter((p) => p !== undefined),
    ...probes.filter((p) => optional.rows.includes(p.vendor)),
  ]
  const dismiss = async (): Promise<void> => {
    setBusy(true)
    const ok = await setDismissed(true)
    setBusy(false)
    if (ok)
      toast({
        level: 'info',
        message: 'Setup card hidden',
        action: { label: 'Undo', onClick: () => void setDismissed(false) },
      })
  }
  return (
    <section
      aria-labelledby="setup-heading"
      data-testid="setup-card"
      className="flex flex-col gap-3 rounded-lg border bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <Rocket aria-hidden className="size-4 text-muted-foreground" />
        <h2 id="setup-heading" className="flex-1 text-sm font-semibold">
          Set up your vendors
        </h2>
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          data-testid="setup-dismiss"
          icon={<X aria-hidden />}
          onClick={() => void dismiss()}
        >
          Dismiss
        </Button>
      </div>
      {ordered.length === 0 && git === undefined ? (
        <p className="text-sm text-muted-foreground">Checking the vendor CLIs on this computer…</p>
      ) : (
        <ul aria-live="polite" className="flex flex-col gap-2.5">
          {ordered.map((p) => (
            <VendorRow key={p.vendor} probe={p} sandboxChip={windows && p.vendor === 'codex'} />
          ))}
          {git !== undefined && <GitRow check={git} onRecheck={() => onRecheckApp?.()} />}
        </ul>
      )}
      {/* The line keeps its room while core resolves the profile. */}
      <p className="min-h-4 text-xs text-muted-foreground" data-testid="setup-profile">
        {profile !== null ? profileLine(profile, primary) : ''}
      </p>
      {windows && <SandboxChip testId="setup-codex-sandbox" onRecheck={onRecheckApp} />}
      {trusting.map((p) => (
        <FolderTrustChip
          key={p.vendor}
          vendor={p.vendor}
          folder={composerFolder}
          showPath
          testId={`setup-${p.vendor}-trust`}
        />
      ))}
    </section>
  )
}
