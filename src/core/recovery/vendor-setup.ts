// `vendor_setup` executor (runs on click: calls Codex windowsSandbox/setupStart, waits for setupCompleted, then
// re-probes; the fix for sandbox_unavailable, from the Codex Windows sandbox procedure, X11b; the mode table's
// "fix: vendor_setup unelevated → elevated shell_copy").
//
// Safety: the only caller is `recovery.execute` (a user's click in the app, or the dev CLI on the user's command);
// nothing in a run, Auto mode or the healer executes it. Only the unelevated setup runs from here: the elevated one
// needs an administrator terminal and is only ever a copied command (shell_copy, `elevated: true`). One setup per
// vendor at a time. Whatever the setup answered, the vendor is probed again with force (token-free), so vendor health,
// preflight and `support()` read the sandbox as it is now.
import type { RecoveryActionOf } from '../../shared/failure.ts'
import type { RecoveryResult, VendorSetupOutcome } from '../../shared/ipc.ts'
import { vendorCheckId } from '../../shared/preflight.ts'
import type { ProbeResult } from '../../shared/vendors.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'

/** The vendor calls a `vendor_setup` action may name (the shared contract's union). */
export const VENDOR_SETUP_CALLS = ['windowsSandbox/setupStart'] as const
export type VendorSetupCall = (typeof VENDOR_SETUP_CALLS)[number]

/** The only setup mode the executor runs; `elevated` (a UAC prompt) stays a copied command. */
export const UNELEVATED = 'unelevated'

/** How long the setup may take before Dim Factory gives up on it (the adapter stops its private app-server). */
export const VENDOR_SETUP_TIMEOUT_MS = 5 * 60_000

/** What the vendor's own setup answered (Codex: `windowsSandbox/setupCompleted`). */
export interface VendorSetupResult {
  ok: boolean
  /** One plain sentence (the vendor's error text when it failed). */
  detail: string
}

/**
 * An adapter that can run its vendor's setup (Codex: `windowsSandbox/setupStart{mode}` over a private app-server,
 * waiting for `windowsSandbox/setupCompleted`). Optional on the Adapter contract: only Codex has one.
 */
export interface VendorSetupCapable {
  vendorSetup(
    call: VendorSetupCall,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<VendorSetupResult>
}

export function hasVendorSetup(a: unknown): a is VendorSetupCapable {
  return (
    typeof a === 'object' && a !== null && typeof (a as { vendorSetup?: unknown }).vendorSetup === 'function'
  )
}

/** The vendor as the executor needs it (app-core / handlers implement it over the registry). */
export interface SetupVendor {
  /** Registry id (`local-<preset>` → `codex`). */
  id: string
  displayName: string
  built: boolean
  /** The adapter's setup, when it has one. */
  setup?: VendorSetupCapable['vendorSetup']
}

export interface VendorSetupHost {
  vendor(id: string): SetupVendor | undefined
  /**
   * The vendor's forced, token-free probe, stored for preflight and vendor health (its cached checks dropped first).
   */
  reprobe(vendor: string): Promise<ProbeResult>
  /** Default {@link VENDOR_SETUP_TIMEOUT_MS}. */
  timeoutMs?: number
  log?: { warn(msg: string, data?: Record<string, unknown>): void }
}

/** Setups in flight, by registry id (one per vendor). */
export type SetupsInFlight = Map<string, Promise<unknown>>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * The params the executor sends: exactly `{mode: 'unelevated'}`. An action naming another call, another mode or any
 * other field is refused (VALIDATION): the elevated setup is never run from Dim Factory.
 */
export function checkSetupRequest(a: Pick<RecoveryActionOf<'vendor_setup'>, 'call' | 'params'>): {
  call: VendorSetupCall
  params: { mode: typeof UNELEVATED }
} {
  if (!(VENDOR_SETUP_CALLS as readonly string[]).includes(a.call)) {
    throw new DimFactoryError('VALIDATION', `Dim Factory does not run "${String(a.call)}".`)
  }
  const p = isObj(a.params) ? a.params : {}
  const keys = Object.keys(p)
  const mode = p['mode'] ?? UNELEVATED
  if (mode !== UNELEVATED || keys.some((k) => k !== 'mode')) {
    throw new DimFactoryError(
      'VALIDATION',
      'Dim Factory only runs the setup that needs no administrator rights. Copy the elevated command instead.',
    )
  }
  return { call: a.call, params: { mode: UNELEVATED } }
}

/** How the vendor's sandbox reads in a probe: its `vendor.<v>.winSandbox` check (absent: not applicable). */
export function sandboxCheckOf(
  probe: ProbeResult | undefined,
  vendor: string,
): { ready: boolean; detail?: string } | undefined {
  const c = probe?.checks.find((x) => x.id === vendorCheckId(vendor, 'winSandbox'))
  if (c === undefined) return undefined
  return c.status === 'pass' ? { ready: true } : { ready: false, detail: c.detail || c.title }
}

const sentence = (s: string): string => {
  const t = s.trim().replace(/\s+/g, ' ')
  if (t === '') return ''
  const cut = t.length > 300 ? `${t.slice(0, 297)}...` : t
  return /[.!?]$/.test(cut) ? cut : `${cut}.`
}

/**
 * Run the vendor's setup, then probe it again. Answers what happened; never retries anything itself (the caller
 * decides: a failed pass retries only when the sandbox now reads ready).
 */
export async function runVendorSetup(
  a: RecoveryActionOf<'vendor_setup'>,
  host: VendorSetupHost,
  inflight: SetupsInFlight,
): Promise<VendorSetupOutcome> {
  if (a.disabledReason !== undefined && a.disabledReason.trim() !== '') {
    throw new DimFactoryError('UNSUPPORTED', a.disabledReason)
  }
  const req = checkSetupRequest(a)
  const v = host.vendor(a.vendor)
  if (v === undefined) throw new DimFactoryError('NOT_FOUND', `Unknown vendor "${a.vendor}".`)
  if (!v.built) throw new DimFactoryError('UNSUPPORTED', `${v.displayName} is not available in this build.`)
  if (v.setup === undefined) {
    throw new DimFactoryError('UNSUPPORTED', `${v.displayName} cannot set up its sandbox from Dim Factory.`)
  }
  if (inflight.has(v.id)) {
    throw new DimFactoryError('CONFLICT', `The ${v.displayName} sandbox setup is already running.`)
  }
  const setup = v.setup
  const work = (async (): Promise<VendorSetupOutcome> => {
    const ctl = new AbortController()
    const timeoutMs = host.timeoutMs ?? VENDOR_SETUP_TIMEOUT_MS
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    let r: VendorSetupResult
    try {
      r = await setup(req.call, { ...req.params }, ctl.signal)
      if (!isObj(r) || typeof r.ok !== 'boolean') r = { ok: false, detail: 'The setup gave no answer.' }
    } catch (err) {
      r = {
        ok: false,
        detail: ctl.signal.aborted
          ? `The setup took longer than ${Math.round(timeoutMs / 60_000)} minutes, so Dim Factory stopped it.`
          : errorMessage(err),
      }
    } finally {
      clearTimeout(timer)
    }
    // Probed again whatever the answer: a setup that failed half-way may still have changed the sandbox.
    let probe: ProbeResult | undefined
    try {
      probe = await host.reprobe(v.id)
    } catch (err) {
      host.log?.warn('re-probe after vendor setup failed', { vendor: v.id, err: errorMessage(err) })
    }
    const sb = sandboxCheckOf(probe, v.id)
    const ready = r.ok && probe !== undefined && (sb === undefined || sb.ready)
    const out: VendorSetupOutcome = {
      vendor: v.id,
      ok: r.ok,
      ready,
      detail: typeof r.detail === 'string' ? r.detail : '',
      probed: probe !== undefined,
    }
    if (!ready && sb !== undefined && !sb.ready && sb.detail !== undefined) out.stillNotReady = sb.detail
    return out
  })()
  inflight.set(v.id, work)
  try {
    return await work
  } finally {
    inflight.delete(v.id)
  }
}

/** The toast line for a finished setup (no em dash; the next step named when it did not work). */
export function setupMessage(o: VendorSetupOutcome, displayName: string, retrying?: string): string {
  if (o.ready) {
    return retrying !== undefined
      ? `The ${displayName} sandbox is set up. Retrying ${retrying}.`
      : `The ${displayName} sandbox is set up.`
  }
  if (o.ok) {
    const why = o.stillNotReady !== undefined ? ` ${sentence(o.stillNotReady)}` : ''
    return `The setup finished, but ${displayName} still reports the sandbox is not ready.${why} Try the elevated setup command.`
  }
  const why = sentence(o.detail)
  return `The ${displayName} sandbox setup failed.${why !== '' ? ` ${why}` : ''} Try the elevated setup command.`
}

/** RecoveryResult for a finished setup. */
export function setupResult(o: VendorSetupOutcome, message: string): RecoveryResult {
  return { kind: 'vendor_setup', message, setup: o }
}
