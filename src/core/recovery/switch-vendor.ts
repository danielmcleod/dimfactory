// `switch_vendor` (built, but rendered disabled
// until a second vendor is ready"). The target is the first vendor other than the failing one that is built and ready
// for the pass's mode, preferring Claude and Codex (the "Fresh, different vendor" rule). With none ready the action
// is still offered, disabled with the reason, so the user knows the option exists.
import type { Mode, PassName } from '../../shared/run.ts'

export interface VendorChoice {
  id: string
  displayName: string
  /** In this build (registry stubs are not). */
  built: boolean
  /** Experimental (Muse): never a switch target; the user picks it under "More". */
  experimental?: boolean
}

export type Readiness = { ok: true } | { ok: false; reason: string }

/** What switch_vendor needs to know about the vendors (app-core implements it over the registry and the probes). */
export interface VendorReadiness {
  vendors(): readonly VendorChoice[]
  /** Built, its launch probe ready, and `mode` supported for `pass`. */
  readyFor(vendor: string, pass: PassName, mode: Mode): Readiness
}

export interface SwitchTarget {
  to: string
  displayName: string
  /** The target vendor's default model. */
  model: null
  /** Set when no other vendor is ready: why (the action renders disabled with it). */
  disabledReason?: string
}

const PREFERRED: readonly string[] = ['claude', 'codex']

function ordered(vendors: readonly VendorChoice[]): VendorChoice[] {
  const rank = (v: VendorChoice): number => {
    const i = PREFERRED.indexOf(v.id)
    return i >= 0 ? i : PREFERRED.length + (v.built ? 0 : 1)
  }
  return [...vendors].sort((a, b) => rank(a) - rank(b))
}

/** "<Name> is not available in this build." / its readiness reason. */
export function notReadyReason(v: VendorChoice, r: Readiness): string {
  if (!v.built) return `${v.displayName} is not available in this build.`
  return r.ok ? '' : r.reason
}

/**
 * The vendor a failed pass can switch to, or null when there is no other vendor at all. Without a ready one, the
 * first candidate comes back with `disabledReason`.
 */
export function switchTargetFor(
  current: string | undefined,
  pass: PassName,
  mode: Mode,
  r: VendorReadiness,
): SwitchTarget | null {
  const others = ordered(r.vendors().filter((v) => v.id !== current && v.experimental !== true))
  let first: { v: VendorChoice; reason: string } | undefined
  for (const v of others) {
    const ready: Readiness = v.built ? r.readyFor(v.id, pass, mode) : { ok: false, reason: '' }
    if (ready.ok) return { to: v.id, displayName: v.displayName, model: null }
    first ??= { v, reason: notReadyReason(v, ready) }
  }
  if (first === undefined) return null
  return {
    to: first.v.id,
    displayName: first.v.displayName,
    model: null,
    disabledReason: first.reason !== '' ? first.reason : `${first.v.displayName} is not ready.`,
  }
}
