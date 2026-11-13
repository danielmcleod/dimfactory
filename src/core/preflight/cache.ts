// Preflight result cache (with its invalidation rules).
// Two stores:
//  - check entries keyed by (def id, subjectKey, inputsHash), each with its own TTL;
//  - the vendor store: the launch probe per vendor plus the latest token-free auth re-check. Live preflight reads
//    vendor results only from here and never spawns a vendor.
import type { CheckResult } from '../../shared/preflight.ts'
import { vendorCheckId } from '../../shared/preflight.ts'
import type { ProbeResult } from '../../shared/vendors.ts'

/** `vendor.<v>.auth` is re-run by the authoritative preflight once it is this old. */
export const AUTH_TTL_MS = 10 * 60 * 1000

/**
 * "I ran it → Re-check" (cache invalidation): once a fix was handed out for a check, that check is re-run
 * by every preflight (never served from the cache) until it passes, for at most this long.
 */
export const RECHECK_WINDOW_MS = 30 * 60 * 1000

/** A def's run outcome: `failed` = at least one `fail` result (dependents are skipped). */
export type CheckState = 'ok' | 'failed'

export interface CachedCheck {
  results: CheckResult[]
  state: CheckState
  at: number
}

export interface VendorSnapshot {
  probe: ProbeResult
  /** probe.checks with the auth re-check results swapped in (same ids). */
  checks: CheckResult[]
  /** When `vendor.<v>.auth` was last evaluated (probe or re-check). */
  authAt: number
  /** Invalidated since the probe was stored; the next authoritative preflight re-probes with `force`. */
  stale: boolean
}

const SEP = '\u0000'

/** The same check: equal ids, or one is a dotted prefix of the other (`folder.git` / `folder.git.ownership`). */
const relatedIds = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)

export class PreflightCache {
  readonly #checks = new Map<string, CachedCheck & { id: string }>()
  readonly #probes = new Map<string, ProbeResult>()
  readonly #auth = new Map<string, { checks: CheckResult[]; at: number }>()
  readonly #stale = new Set<string>()
  readonly #probeListeners = new Set<(result: ProbeResult) => void>()
  /** Check ids awaiting a re-check → when the fix was handed out. */
  readonly #recheck = new Map<string, number>()

  static key(id: string, subjectKey: string, inputsHash: string): string {
    return [id, subjectKey, inputsHash].join(SEP)
  }

  /** A cached def outcome younger than `ttlMs` (0 → never cached). */
  get(
    id: string,
    subjectKey: string,
    inputsHash: string,
    now: number,
    ttlMs: number,
  ): CachedCheck | undefined {
    if (ttlMs <= 0) return undefined
    const key = PreflightCache.key(id, subjectKey, inputsHash)
    const hit = this.#checks.get(key)
    if (hit === undefined) return undefined
    if (now - hit.at >= ttlMs) {
      this.#checks.delete(key)
      return undefined
    }
    return { results: hit.results, state: hit.state, at: hit.at }
  }

  set(id: string, subjectKey: string, inputsHash: string, entry: CachedCheck): void {
    this.#checks.set(PreflightCache.key(id, subjectKey, inputsHash), { ...entry, id })
  }

  // ---- vendor store -------------------------------------------------------------------------------------------

  /** Store a launch probe (from app start, a forced Test, or an authoritative preflight). Clears `stale`. */
  setProbe(result: ProbeResult): void {
    this.#probes.set(result.vendor, result)
    this.#auth.delete(result.vendor)
    this.#stale.delete(result.vendor)
    this.#notify(result)
  }

  #notify(result: ProbeResult): void {
    for (const fn of this.#probeListeners) {
      try {
        fn(result)
      } catch {
        // a listener (the app's `probe` push) must never break probing
      }
    }
  }

  /**
   * Called after every stored probe, whichever path ran it (first launch, vendors.probe, preflight), and when an
   * auth re-check changed what the vendor's checks say; always with the effective probe (`effectiveProbe`).
   */
  onProbe(fn: (result: ProbeResult) => void): () => void {
    this.#probeListeners.add(fn)
    return () => this.#probeListeners.delete(fn)
  }

  /** The launch probe as stored (its own checks; see `effectiveProbe` for what the vendor's state is now). */
  probe(vendor: string): ProbeResult | undefined {
    return this.#probes.get(vendor)
  }

  /**
   * The vendor's probe as it stands: the launch probe with a newer auth re-check swapped into its checks, `ok`
   * recomputed (no blocking failure) and `at` the re-check's time. Vendor health, the setup card, Settings → Vendors
   * and readiness read this, so a login fixed after launch shows as fixed (the run's preflight already passes).
   */
  effectiveProbe(vendor: string): ProbeResult | undefined {
    const probe = this.#probes.get(vendor)
    const auth = this.#auth.get(vendor)
    if (probe === undefined || auth === undefined) return probe
    const checks = this.vendor(vendor)?.checks ?? probe.checks
    return {
      ...probe,
      at: Math.max(probe.at, auth.at),
      ok: !checks.some((c) => c.status === 'fail' && c.blocking),
      checks,
    }
  }

  /**
   * Store a token-free auth re-check (`vendor.<v>.auth`, optionally `vendor.<v>.env`). When it changes a check's
   * status, the probe listeners hear the effective probe (the app pushes the vendor's new health).
   */
  setAuth(vendor: string, checks: CheckResult[], at: number): void {
    const before = this.vendor(vendor)?.checks
    this.#auth.set(vendor, { checks, at })
    const now = this.effectiveProbe(vendor)
    if (now === undefined) return
    const was = new Map((before ?? []).map((c) => [c.id, c.status]))
    if (now.checks.some((c) => was.get(c.id) !== c.status) || now.checks.length !== was.size)
      this.#notify(now)
  }

  /** The vendor's effective results: the probe with any newer auth re-check swapped in. */
  vendor(vendor: string): VendorSnapshot | undefined {
    const probe = this.#probes.get(vendor)
    if (probe === undefined) return undefined
    const auth = this.#auth.get(vendor)
    const authId = vendorCheckId(vendor, 'auth')
    const probeAuthAt = probe.checks.find((c) => c.id === authId)?.at ?? probe.at
    let checks = probe.checks
    if (auth !== undefined) {
      const replaced = new Set(auth.checks.map((c) => c.id))
      checks = [...probe.checks.filter((c) => !replaced.has(c.id)), ...auth.checks]
      const order = new Map(probe.checks.map((c, i) => [c.id, i]))
      checks.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
    }
    return { probe, checks, authAt: auth?.at ?? probeAuthAt, stale: this.#stale.has(vendor) }
  }

  isStale(vendor: string): boolean {
    return this.#stale.has(vendor)
  }

  // ---- invalidation ---------------------------------------------------------------------------------------------

  /**
   * Test, a vendor path change, or a runtime failure scoped to the vendor: drop its auth re-check and cached
   * check entries, and mark the probe stale. The last probe stays readable (live shows it until a new one lands).
   */
  invalidateVendor(vendor: string): void {
    this.#auth.delete(vendor)
    if (this.#probes.has(vendor)) this.#stale.add(vendor)
    for (const [key, entry] of this.#checks) {
      if (entry.id === `vendor.${vendor}` || entry.id.startsWith(`vendor.${vendor}.`))
        this.#checks.delete(key)
    }
  }

  /**
   * "I ran it → Re-check" for one check id (a result id or a def id). Drops every entry whose def id is that id,
   * a prefix of it (`folder.git` for `folder.git.lock`) or an extension of it; `vendor.<v>.*` invalidates the vendor.
   */
  invalidateCheck(checkId: string): void {
    const m = /^vendor\.([^.]+)(?:\.|$)/.exec(checkId)
    if (m?.[1] !== undefined) this.invalidateVendor(m[1])
    for (const [key, entry] of this.#checks) {
      if (entry.id === checkId || checkId.startsWith(`${entry.id}.`) || entry.id.startsWith(`${checkId}.`)) {
        this.#checks.delete(key)
      }
    }
  }

  /** `config-changed`: run, pass and folder entries (app and vendor entries and the vendor store stay). */
  invalidateConfig(): void {
    for (const [key, entry] of this.#checks) {
      if (!entry.id.startsWith('app.') && !entry.id.startsWith('vendor.')) this.#checks.delete(key)
    }
  }

  // ---- "I ran it → Re-check" ----------------------------------------------------------------------------------

  /**
   * A fix for `checkId` (a result id such as `folder.git.ownership`, or a def id) was handed out (recovery.execute
   * of a shell_copy, whose `recheck` names the check): drop its entries now (`invalidateCheck`), and re-run it in
   * every later preflight instead of serving a cached result, until it passes. Live preflight never spawns a vendor:
   * a `vendor.<v>.*` id marks the probe stale (the authoritative preflight re-probes it), and the composer's
   * Re-check sends `vendors.probe{vendor, force:true}` before `preflight.run`.
   */
  awaitRecheck(checkId: string, at: number): void {
    this.#recheck.set(checkId, at)
    this.invalidateCheck(checkId)
  }

  /** The def (or one of its results) awaits a re-check: do not serve it from the cache. */
  needsRecheck(defId: string, now: number): boolean {
    let hit = false
    for (const [id, at] of this.#recheck) {
      if (now - at >= RECHECK_WINDOW_MS) {
        this.#recheck.delete(id)
        continue
      }
      if (relatedIds(id, defId)) hit = true
    }
    return hit
  }

  /**
   * The def ran again: a re-check is done once none of its results for that check id fails or warns (a warning
   * such as dubious ownership is still the problem the fix was for).
   */
  settleRecheck(defId: string, results: readonly CheckResult[]): void {
    for (const id of [...this.#recheck.keys()]) {
      if (!relatedIds(id, defId)) continue
      const open = results.some((r) => relatedIds(r.id, id) && (r.status === 'fail' || r.status === 'warn'))
      if (!open) this.#recheck.delete(id)
    }
  }

  /** Check ids awaiting a re-check (tests, diagnostics). */
  get pendingRechecks(): string[] {
    return [...this.#recheck.keys()]
  }

  clear(): void {
    this.#checks.clear()
    this.#probes.clear()
    this.#auth.clear()
    this.#stale.clear()
    this.#recheck.clear()
  }

  /** Number of cached check entries (tests, diagnostics). */
  get size(): number {
    return this.#checks.size
  }
}
