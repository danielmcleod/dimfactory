// The Codex Windows sandbox setup as the renderer runs it (the `vendor_setup` executor, Codex's probe
// `windowsSandbox/readiness` and "Codex, Windows sandbox not ready", the sandbox procedure X11b/X11c, codex-sandbox.spec.ts).
// One setup per vendor at a time, shared by every place that offers it and kept while the user changes screens.
//
// A click runs `recovery.execute` for core's `vendor_setup` action: core runs `windowsSandbox/setupStart` (unelevated)
// over a private app-server, waits for `setupCompleted` and probes the vendor again, and answers what it found
// (`RecoveryResult.setup`: ready, or why not). The renderer then reads the vendor's new probe (vendors.list; a forced
// vendors.probe only when core's probe is not newer than the one before the click) and says what core found: the
// sandbox is ready, or the setup did not finish (with core's words), in which case the elevated command core offers
// (`codex sandbox setup --elevated --current-user`, a UAC prompt) is the next step. Nothing here decides readiness: it
// is core's answer and its `vendor.<v>.winSandbox` check.
import { create } from 'zustand'
import type { RecoveryActionOf } from '@shared/failure.ts'
import type { CheckResult } from '@shared/preflight.ts'
import { vendorCheckId } from '@shared/preflight.ts'
import type { VendorSetupOutcome } from '@shared/ipc.ts'
import type { ProbeView } from '@shared/vendors.ts'
import { invoke } from '../../ipc/client.ts'
import { vendorName } from '../../lib/format.ts'
import { upsertProbes } from '../../state/actions.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { useStore } from '../../state/store.ts'
import { toast } from '../../state/toasts.ts'
import { noteKindSupport, recoveryRequest } from './execute.ts'
import type { RecoveryContext } from './execute.ts'

export type VendorSetupAction = RecoveryActionOf<'vendor_setup'>
type ShellCopy = RecoveryActionOf<'shell_copy'>

/** A setup the user started in this session, per vendor. */
export type SetupRun =
  | { state: 'running'; actionId: string; startedAt: number }
  | { state: 'ready'; actionId: string; at: number; message: string }
  | { state: 'failed'; actionId: string; at: number; message: string }

/** What a sandbox control shows. */
export type SandboxPhase = 'unknown' | 'ready' | 'needed' | 'running' | 'failed' | 'unavailable'

const useRuns = create<Readonly<Record<string, SetupRun>>>()(() => ({}))

/** The setup the user last started for `vendor` in this session, if any. */
export function useSetupRun(vendor: string): SetupRun | undefined {
  return useRuns((s) => s[vendor])
}

export function setupRunOf(vendor: string): SetupRun | undefined {
  return useRuns.getState()[vendor]
}

/** Tests: forget every setup. */
export function resetSandboxSetupForTests(): void {
  useRuns.setState({}, true)
}

function setRun(vendor: string, run: SetupRun): void {
  useRuns.setState((s) => ({ ...s, [vendor]: run }))
}

// ---- reading core's probe ------------------------------------------------------------------------------------------

/** The vendor's `vendor.<v>.winSandbox` check from its probe, if core reported one. */
export function winSandboxCheck(view: ProbeView | undefined): CheckResult | undefined {
  if (view === undefined) return undefined
  const id = vendorCheckId(view.vendor, 'winSandbox')
  return view.probe?.checks.find((c) => c.id === id)
}

/** Core says the sandbox is ready: its winSandbox check passed. */
export function sandboxReady(view: ProbeView | undefined): boolean {
  return winSandboxCheck(view)?.status === 'pass'
}

/** Core's `vendor_setup` fix among a check's actions. */
export function setupActionOf(
  check: Pick<CheckResult, 'recovery'> | undefined,
): VendorSetupAction | undefined {
  return check?.recovery.find((a): a is VendorSetupAction => a.kind === 'vendor_setup')
}

/** Core's elevated commands among a check's actions (the sandbox's fallback, X11c). */
export function elevatedActionsOf(check: Pick<CheckResult, 'recovery'> | undefined): ShellCopy[] {
  return (check?.recovery ?? []).filter((a): a is ShellCopy => a.kind === 'shell_copy' && a.elevated === true)
}

/** `Codex` for a vendor id, from its probe when there is one. */
export function setupVendorName(vendor: string, view?: ProbeView): string {
  return view !== undefined && view.displayName !== '' ? view.displayName : vendorName(vendor)
}

// ---- words ---------------------------------------------------------------------------------------------------------

export const SANDBOX_SET_UP_LABEL = 'Set up the Codex sandbox'

export function sandboxReadyText(name: string): string {
  return `${name} sandbox ready`
}

/** `Setting up the Codex sandbox… 0:12` (the time it has taken so far). */
export function sandboxRunningText(name: string, elapsed: string): string {
  return `Setting up the ${name} sandbox… ${elapsed}`
}

export function sandboxFailedText(message: string): string {
  const m = message.trim().replace(/\.$/, '')
  return m === '' ? 'Setup did not finish.' : `Setup did not finish: ${m}.`
}

/** The next step after a failed setup (X11c), beside the elevated command. */
export const ELEVATED_NEXT =
  'If the setup cannot finish, run this command in an administrator terminal, then re-check.'

/** The disclosure that shows the elevated command (the user opens it; it never opens on its own). */
export const ELEVATED_TOGGLE_LABEL = 'Set up as administrator instead'

// ---- running it ------------------------------------------------------------------------------------------------------

function viewOf(views: readonly ProbeView[], vendor: string): ProbeView | undefined {
  return views.find((v) => v.vendor === vendor)
}

/**
 * The vendor's probe after the setup: core probes again when the setup ends, so vendors.list has it; a forced
 * probe only when the probe is not newer than the one held before the click (an older core, or one still probing).
 */
async function probeAfter(vendor: string, before: number | null): Promise<ProbeView | undefined> {
  const listed = await invoke('vendors.list')
  if (listed.ok) {
    upsertProbes(listed.value)
    const view = viewOf(listed.value, vendor)
    const at = view?.probe?.at ?? null
    if (view !== undefined && at !== null && (before === null || at > before)) return view
  }
  const forced = await invoke('vendors.probe', { vendor, force: true })
  if (!forced.ok) return listed.ok ? viewOf(listed.value, vendor) : undefined
  upsertProbes(forced.value)
  return viewOf(forced.value, vendor)
}

/** Why the sandbox is still not ready after a setup core reported done: its check's words, else a plain line. */
function stillNeededMessage(view: ProbeView | undefined, said: string | undefined): string {
  const check = winSandboxCheck(view)
  const detail = check?.detail.trim() ?? ''
  if (detail !== '') return detail
  const title = check?.title.trim() ?? ''
  if (title !== '') return title
  return said !== undefined && said.trim() !== '' ? said : 'The sandbox is still not set up'
}

/** Core's answer for a finished setup (`RecoveryResult.setup`), read defensively; undefined when it sent none. */
export function setupOutcomeOf(value: unknown): VendorSetupOutcome | undefined {
  const s = (value as { setup?: unknown } | null | undefined)?.setup
  if (typeof s !== 'object' || s === null) return undefined
  const o = s as Partial<Record<keyof VendorSetupOutcome, unknown>>
  if (typeof o.ok !== 'boolean' || typeof o.ready !== 'boolean') return undefined
  return {
    vendor: typeof o.vendor === 'string' ? o.vendor : '',
    ok: o.ok,
    ready: o.ready,
    detail: typeof o.detail === 'string' ? o.detail : '',
    probed: o.probed === true,
    ...(typeof o.stillNotReady === 'string' ? { stillNotReady: o.stillNotReady } : {}),
  }
}

/**
 * Why a setup core answered did not leave the sandbox ready, in one short clause for the status line: the re-probe's
 * words while the sandbox still reads not ready, else the vendor's own error, else the probe's check.
 */
export function outcomeReason(o: VendorSetupOutcome, view: ProbeView | undefined): string {
  const still = o.stillNotReady?.trim() ?? ''
  if (still !== '') return still
  const detail = o.detail.trim()
  if (!o.ok && detail !== '') return detail
  if (!o.probed) return 'Dim Factory could not check the sandbox again'
  return stillNeededMessage(view, detail !== '' ? detail : undefined)
}

/**
 * Run core's sandbox setup for `a` (only from the user's click): progress while core works, then core's answer and
 * the vendor's new probe, a toast with core's words, the run's snapshot when the action came from a run, and
 * `onRecheck` so whoever showed it checks again (the composer's live preflight, a preflight card). A second click while
 * one runs does nothing.
 */
export async function runVendorSetup(
  a: VendorSetupAction,
  ctx: RecoveryContext,
  onRecheck?: () => unknown,
): Promise<void> {
  const vendor = a.vendor
  if (setupRunOf(vendor)?.state === 'running') return
  const before = useStore.getState().probes.byVendor[vendor]?.probe?.at ?? null
  setRun(vendor, { state: 'running', actionId: a.id, startedAt: Date.now() })
  let ok = false
  let message: string
  /** Core's own line for the toast (it names the next step and a retried pass), when it gave one. */
  let said = ''
  try {
    const r = await invoke('recovery.execute', recoveryRequest(a, ctx))
    if (!r.ok) {
      if (r.error.code === 'UNSUPPORTED') noteKindSupport('vendor_setup', 'no')
      message = r.error.message
    } else {
      noteKindSupport('vendor_setup', 'yes')
      said = r.value.message?.trim() ?? ''
      const view = await probeAfter(vendor, before)
      const outcome = setupOutcomeOf(r.value)
      // Core's answer decides (it probed again right after the setup); a core that sent none: the probe's check.
      ok = outcome !== undefined ? outcome.ready : sandboxReady(view)
      const name = setupVendorName(vendor, view)
      message = ok
        ? sandboxReadyText(name)
        : outcome !== undefined
          ? outcomeReason(outcome, view)
          : stillNeededMessage(view, said)
    }
  } catch (err: unknown) {
    message = err instanceof Error ? err.message : String(err)
  }
  const name = setupVendorName(vendor, useStore.getState().probes.byVendor[vendor])
  setRun(
    vendor,
    ok
      ? { state: 'ready', actionId: a.id, at: Date.now(), message }
      : { state: 'failed', actionId: a.id, at: Date.now(), message },
  )
  toast(
    said !== ''
      ? { level: ok ? 'info' : 'warn', message: said }
      : ok
        ? { level: 'info', message: sandboxReadyText(name) }
        : { level: 'warn', message: `${name} sandbox: ${sandboxFailedText(message)}` },
  )
  if (ctx.runId !== undefined) void fetchSnapshot(ctx.runId)
  await onRecheck?.()
}

/**
 * What a sandbox control shows, from core's probe and the setup the user started: running while it runs; ready once
 * core's check passes; failed after a setup that did not finish (until core says ready); else what the check offers.
 * `offered` is the check the control was shown for (a preflight report's): the vendor's probe, newer once a setup
 * re-probed it, says how the sandbox is; the offered check says what can be done.
 */
export function sandboxPhase(
  view: ProbeView | undefined,
  run: SetupRun | undefined,
  offered?: CheckResult,
): SandboxPhase {
  const status = winSandboxCheck(view) ?? offered
  if (run?.state === 'running') return 'running'
  if (status?.status === 'pass') return 'ready'
  if (run?.state === 'failed') return 'failed'
  if (run?.state === 'ready' && status === undefined) return 'ready'
  if (status === undefined) return 'unknown'
  return setupActionOf(offered ?? status) !== undefined ? 'needed' : 'unavailable'
}
