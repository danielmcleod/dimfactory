// Folder trust as the renderer runs it (trust.json `vendorFolder`, the grant executor, the readiness check `trust`,
// gemini-trust.spec.ts; the user trusts a folder for Gemini): words, the grants started here, and
// the grant and revoke requests. Core decides trust and writes trust.json; the renderer only asks, on the user's click.
import { create } from 'zustand'
import type { RecoveryActionOf } from '@shared/failure.ts'
import type { Platform, TrustState } from '@shared/ipc.ts'
import type { CheckResult } from '@shared/preflight.ts'
import { getDimFactory, invoke } from '../../ipc/client.ts'
import { vendorName } from '../../lib/format.ts'
import { normalizeFolder } from '../../pages/dashboard/composer-model.ts'
import { fetchSnapshot } from '../../state/runs.ts'
import { toast } from '../../state/toasts.ts'
import { bumpTrustEpoch } from '../../state/trust.ts'
import { recoveryRequest } from './execute.ts'
import type { RecoveryContext } from './execute.ts'

export type GrantAction = RecoveryActionOf<'grant'>

/*
 * Which vendors need folder trust is core's list (src/shared/vendors.ts `needsFolderTrust`, the readiness check `trust`):
 * Gemini launches with --skip-trust only for a folder the user trusted for it, or a Dim Factory-owned one.
 *
 * How a grant runs: only from the user's click, through recovery.execute for core's `grant` action when a check
 * offered one (the composer's preflight strip, a snag), else through trust.set for the folder the composer checks (the
 * setup card). Either way core writes trust.json, the toast offers Undo (a revoke through trust.set), and the trust
 * epoch moves so whatever showed core's answer asks again. One grant per vendor and folder at a time, shared by every
 * place that offers it. Revoking (Settings → Vendors, or Undo) is trust.set with `trusted: false`.
 */

/** Core's vendorFolder grant among a check's actions (the readiness `trust` check's fix). */
export function trustActionOf(check: Pick<CheckResult, 'recovery'> | undefined): GrantAction | undefined {
  return check?.recovery.find((a): a is GrantAction => a.kind === 'grant' && a.grant === 'vendorFolder')
}

/** The vendor a grant is for ('' when core did not name it). */
export function trustVendorOf(a: GrantAction): string {
  return a.vendor ?? ''
}

/** `Gemini`, or a plain stand-in when core did not name the vendor. */
export function trustVendorName(vendor: string): string {
  return vendor === '' ? 'this vendor' : vendorName(vendor)
}

// ---- words -------------------------------------------------------------------------------------------------------

/** The button's label (core's action label when it gave one; it never changes while shown). */
export function trustLabel(name: string): string {
  return `Trust this folder for ${name}`
}

/** What trusting means, before the grant (said plainly where the button is). */
export function trustMeans(name: string): string {
  return `If you trust it, ${name} may read and act in this folder without its own trust prompt. You can revoke it later in Settings → Vendors.`
}

/** What the grant means once made. */
export function trustedMeans(name: string): string {
  return `${name} may read and act in this folder without its own trust prompt. Revoke it in Settings → Vendors.`
}

/** A later strip chip with the same grant points at the first (one trust button per strip). */
export function trustAbove(name: string): string {
  return `Trust this folder for ${name} from the first check that offers it, above.`
}

export const REVOKE_LABEL = 'Revoke'

/** What a trust chip shows. */
export type TrustPhase = 'no-folder' | 'checking' | 'needed' | 'running' | 'trusted' | 'failed'

/** The chip's status line: `where` is "this folder" beside the composer's folder, else the folder's path. */
export function trustStatusText(phase: TrustPhase, name: string, where: string, message = ''): string {
  switch (phase) {
    case 'no-folder':
      return `Choose a folder in the composer to trust it for ${name}`
    case 'checking':
      return `Checking ${name}'s trust for ${where}…`
    case 'needed':
      return `${name} is not trusted in ${where} yet`
    case 'running':
      return `Trusting ${where} for ${name}…`
    case 'trusted':
      return `${name} trusted in ${where}`
    case 'failed': {
      const m = message.trim().replace(/\.$/, '')
      return m === '' ? `Could not trust ${where}` : `Could not trust ${where}: ${m}`
    }
  }
}

/** The toast after a grant (core's own words win). */
export function trustedToast(name: string, folder: string): string {
  return `${name} trusted in ${folder}`
}

/** The toast after a revoke. */
export function revokedToast(name: string, folder: string): string {
  return `${name} no longer trusted in ${folder}`
}

// ---- grants the user started in this session ---------------------------------------------------------------------

export type TrustRun =
  | { state: 'running'; startedAt: number }
  | { state: 'trusted'; at: number }
  | { state: 'failed'; at: number; message: string }

const useRuns = create<Readonly<Record<string, TrustRun>>>()(() => ({}))

function platform(): Platform {
  return getDimFactory()?.platform ?? 'linux'
}

/** One key per vendor and folder (the folder as the file system compares it). */
export function trustRunKey(vendor: string, folder: string): string {
  return `${vendor}\n${normalizeFolder(folder, platform())}`
}

/** The grant the user last started for `vendor` in `folder` this session, if any. */
export function useTrustRun(vendor: string, folder: string | null): TrustRun | undefined {
  const key = folder === null ? null : trustRunKey(vendor, folder)
  return useRuns((s) => (key === null ? undefined : s[key]))
}

function runOf(vendor: string, folder: string): TrustRun | undefined {
  return useRuns.getState()[trustRunKey(vendor, folder)]
}

function setRun(vendor: string, folder: string, run: TrustRun | null): void {
  const key = trustRunKey(vendor, folder)
  useRuns.setState((s) => {
    const next = { ...s }
    if (run === null) delete next[key]
    else next[key] = run
    return next
  }, true)
}

/** Tests: forget every grant started here. */
export function resetFolderTrustForTests(): void {
  useRuns.setState({}, true)
}

// ---- trust.set -----------------------------------------------------------------------------------------------------

/** Whether core's trust answer holds the vendor's grant. */
export function hasVendorGrant(
  state: Pick<TrustState, 'grants'> | null | undefined,
  vendor: string,
): boolean {
  return state?.grants.vendorFolder?.[vendor] !== undefined
}

async function setTrust(
  vendor: string,
  folder: string,
  trusted: boolean,
): Promise<{ ok: true; state: TrustState } | { ok: false; message: string }> {
  try {
    const r = await invoke('trust.set', { folder, grant: { kind: 'vendorFolder', vendor }, trusted })
    return r.ok ? { ok: true, state: r.value } : { ok: false, message: r.error.message }
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Take the vendor's trust in a folder back (Settings → Vendors' Revoke, a grant's Undo): trust.set with
 * `trusted: false`, then the epoch moves. `undo`: the revoke's own toast offers trusting it again. Returns core's
 * answer, or null when it refused (its message is a toast).
 */
export async function revokeFolderTrust(
  vendor: string,
  folder: string,
  opts: { undo?: boolean; onDone?: (() => unknown) | undefined } = {},
): Promise<TrustState | null> {
  const name = trustVendorName(vendor)
  const r = await setTrust(vendor, folder, false)
  if (!r.ok) {
    toast({ level: 'error', message: r.message })
    return null
  }
  setRun(vendor, folder, null)
  bumpTrustEpoch()
  await opts.onDone?.()
  toast({
    id: `trust:${trustRunKey(vendor, folder)}`,
    level: 'info',
    message: revokedToast(name, folder),
    ...(opts.undo === true
      ? {
          action: {
            label: 'Undo',
            onClick: async () => {
              const back = await setTrust(vendor, folder, true)
              if (!back.ok) toast({ level: 'error', message: back.message })
              else {
                bumpTrustEpoch()
                await opts.onDone?.()
              }
            },
          },
        }
      : {}),
  })
  return r.state
}

export interface GrantInput {
  vendor: string
  /** The folder the grant is for (the composer's, absolute). */
  folder: string
  /** Core's grant action from a check: run through recovery.execute. Absent: trust.set for `folder`. */
  action?: GrantAction | undefined
  /** Where the action was offered (a composer folder, a run), for recovery.execute. */
  ctx?: RecoveryContext | undefined
  /** After the grant: let whoever showed it check again (the composer's live preflight). */
  onRecheck?: (() => unknown) | undefined
}

/**
 * Trust `folder` for `vendor` (only from the user's click): core's grant action when a check offered one, else
 * trust.set; then the toast with Undo, the epoch, the run's snapshot when it came from a run, and `onRecheck`. A second
 * click while one runs does nothing. Returns whether core wrote the grant.
 */
export async function grantFolderTrust(input: GrantInput): Promise<boolean> {
  const { vendor, folder, action, ctx = {}, onRecheck } = input
  if (runOf(vendor, folder)?.state === 'running') return false
  const name = trustVendorName(vendor)
  setRun(vendor, folder, { state: 'running', startedAt: Date.now() })
  let ok = false
  let message = ''
  let said = ''
  try {
    if (action !== undefined) {
      const r = await invoke('recovery.execute', recoveryRequest(action, { folder, ...ctx }))
      if (r.ok) {
        ok = true
        said = r.value.message?.trim() ?? ''
      } else message = r.error.message
    } else {
      const r = await setTrust(vendor, folder, true)
      if (r.ok && hasVendorGrant(r.state, vendor)) ok = true
      else message = r.ok ? 'Core did not record the grant' : r.message
    }
  } catch (err: unknown) {
    message = err instanceof Error ? err.message : String(err)
  }
  setRun(
    vendor,
    folder,
    ok ? { state: 'trusted', at: Date.now() } : { state: 'failed', at: Date.now(), message },
  )
  if (ok) {
    bumpTrustEpoch()
    toast({
      id: `trust:${trustRunKey(vendor, folder)}`,
      level: 'info',
      message: said !== '' ? said : trustedToast(name, folder),
      action: {
        label: 'Undo',
        onClick: () => revokeFolderTrust(vendor, folder, { onDone: onRecheck }),
      },
    })
  } else {
    toast({ level: 'error', message: trustStatusText('failed', name, folder, message) })
  }
  if (ctx.runId !== undefined) void fetchSnapshot(ctx.runId)
  await onRecheck?.()
  return ok
}
