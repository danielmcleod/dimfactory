// Context health's reactions as a run holds them (RunConfig.contextHealth), and the facts they read off a pass's
// context state: whether a session ended heavy (Fix then starts clean), whether a pass compacted often enough for the
// fresh restart. Pure: no I/O, no clock.
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import { CONTEXT_HEALTH_DEFAULTS } from '../../shared/config-schema.ts'
import type { ContextHealthRunConfig, RunState } from '../supervisor/types.ts'
import type { ContextState } from './state.ts'
import { contextView } from './state.ts'

/** RunConfig.contextHealth from the resolved settings (read defensively: a hand-made config may leave them out). */
export function contextHealthRunConfig(cfg: ResolvedConfig): ContextHealthRunConfig {
  const c = { ...CONTEXT_HEALTH_DEFAULTS, ...(cfg as Partial<ResolvedConfig>).contextHealth }
  return {
    restartAfter: c.restartAfterCompactions,
    loopWarnAt: c.loopWarnAt,
    loopStopAt: Math.max(c.loopStopAt, c.loopWarnAt + 1),
    heavyPercent: c.heavyPercent,
    heavyCompactions: c.heavyCompactions,
    reminder: c.compactionReminder === 'always' || (c.compactionReminder === 'auto' && cfg.auto),
    grounding: c.grounding,
    registryCheck: c.registryCheck,
    aiJudge: c.aiJudge,
  }
}

/** The run's context health settings: its own, or the defaults for a run.json from before they existed. */
export function contextHealthOf(s: Pick<RunState, 'config'>): ContextHealthRunConfig {
  if (s.config.contextHealth !== undefined) return s.config.contextHealth
  const d = CONTEXT_HEALTH_DEFAULTS
  return {
    restartAfter: d.restartAfterCompactions,
    loopWarnAt: d.loopWarnAt,
    loopStopAt: d.loopStopAt,
    heavyPercent: d.heavyPercent,
    heavyCompactions: d.heavyCompactions,
    reminder: false,
    registryCheck: d.registryCheck,
    aiJudge: d.aiJudge,
  }
}

/**
 * A session ended heavy: its pass peaked at least `heavyPercent` of the window, or the vendor compacted it at least
 * `heavyCompactions` times. Unknown (nothing reported) is not heavy.
 */
export function sessionHeavy(
  cs: ContextState | undefined,
  policy: Pick<ContextHealthRunConfig, 'heavyPercent' | 'heavyCompactions'>,
): boolean {
  const v = contextView(cs)
  if (v === undefined) return false
  if (v.compactions >= policy.heavyCompactions) return true
  return (v.peakPercent ?? 0) >= policy.heavyPercent
}
