// Composer suggestions from the vendors' readiness (the Critic swap; R10 decideSession; the Quick composer's Fix row
// "Reuse / Fresh / Fresh, different vendor"). Core computes them for `config.resolve`, so
// the rules live here once and the composer only formats them. Pure: readiness comes in from the probe store.
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { ComposerSuggestions, FixSessionChoice } from '../../shared/ipc.ts'
import type { Mode, PassName } from '../../shared/run.ts'
import type { SupportStatus } from '../../shared/vendors.ts'
import { previewFixSession, previewOptions } from '../supervisor/sessions.ts'
import type { SessionCapabilities } from '../supervisor/sessions.ts'
import { criticSwapSuggestion } from './firstLaunch.ts'

/** A built vendor whose (effective) launch probe passed, and what its adapter supports. */
export interface ReadyVendorInfo {
  id: string
  /** `adapter.support({pass, mode}).status`. */
  support(pass: PassName, mode: Mode): SupportStatus
  /** The launch probe's resume capabilities (decideSession's resume and model-switch rules); absent = unknown. */
  capabilities?: SessionCapabilities
  /**
   * An Experimental vendor (Muse). It is never suggested (the Critic swap, Fix's "Fresh, different vendor");
   * a pass the user put on it still counts as ready for Fix's session line.
   */
  experimental?: boolean
}

export function composerSuggestions(
  cfg: Pick<ResolvedConfig, 'passes'>,
  ready: readonly ReadyVendorInfo[],
  resolveId: (vendor: string) => string = (v) => v,
): ComposerSuggestions {
  const { implement, fix } = cfg.passes
  const suggestable = ready.filter((v) => v.experimental !== true)
  const criticSwap = criticSwapSuggestion(
    cfg,
    suggestable.map((v) => ({
      id: v.id,
      supportsReadonly: v.support('critic', 'readonly') !== 'unsupported',
    })),
    { resolveId },
  )
  const own = resolveId(implement.vendor)
  const otherFixVendor =
    suggestable.find((v) => resolveId(v.id) !== own && v.support('fix', fix.mode) !== 'unsupported')?.id ??
    null
  // The same static decision `pass.fix.resume` states (sessions.ts previewFixSession + previewOptions): Implement is
  // assumed to finish with a session; Fix's vendor counts (readiness, capabilities) only when it is in `ready`.
  const fixId = resolveId(fix.vendor)
  const fixVendor = ready.find((v) => resolveId(v.id) === fixId)
  const d = previewFixSession(
    cfg.passes,
    previewOptions(fixVendor && { ready: true, capabilities: fixVendor.capabilities }),
  )
  const choice: FixSessionChoice = d.reuse
    ? 'reuse'
    : fix.vendor !== implement.vendor
      ? 'fresh-other'
      : 'fresh'
  return { criticSwap, fixSession: d.reuse ? { choice } : { choice, reason: d.reason }, otherFixVendor }
}
