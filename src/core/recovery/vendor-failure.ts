// Preflight cache invalidation, "a runtime failure scoped to a vendor": when a pass fails with a vendor-scoped category
// (login expired, CLI missing, rate limit, …), the vendor's cached results are dropped and its probe is
// marked stale, so the next authoritative preflight probes it again instead of trusting the launch probe.
import type { RunEnvelope, StepKey } from '../../shared/run.ts'
import type { BusSink } from '../bus/bus.ts'
import { CATEGORY_INFO } from '../heal/categories.ts'

export interface VendorFailureSinkDeps {
  /** The configured vendor of a run's step (live state), undefined when unknown. */
  vendorOf(runId: string, step: StepKey): string | undefined
  /** Registry id for a configured vendor (`local-x` → `codex`). */
  resolveId(vendor: string): string
  /** PreflightCache.invalidateVendor. */
  invalidateVendor(vendor: string): void
}

/** A bus sink that reacts to `snag` envelopes only (every other envelope returns at the first test). */
export function vendorFailureSink(d: VendorFailureSinkDeps): BusSink {
  return {
    name: 'preflight-vendor-failures',
    run(env: RunEnvelope): void {
      const b = env.body
      if (b.t !== 'snag' || !CATEGORY_INFO[b.failure.category].vendorScoped) return
      const vendor = d.vendorOf(env.runId, b.step)
      if (vendor !== undefined) d.invalidateVendor(d.resolveId(vendor))
    },
  }
}
