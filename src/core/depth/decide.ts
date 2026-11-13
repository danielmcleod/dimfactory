// Adaptive depth's decision for a run, and the Quick (direct) shape as a run-overrides layer. The decision: a depth the
// user forced (the run's choice, or `depth` in a settings file) wins; then an explicit profile choice keeps that
// profile's own pipeline; else the classifier decides (classify.ts). Quick is the existing supervisor with another
// pipeline shape, so the Run view shows it like any run: Plan off, Implement on the `direct` prompt in the vendor's own
// harness (its Extensions level as configured, pass through by default), Review on (on another vendor when one is
// ready, else the same vendor in a fresh session), Critic off, Fix only when something real fails (the reducer's
// evidence rule) and Fix until green as configured. Pure.
import type { ResolvedConfig, RunOverrides } from '../../shared/config-schema.ts'
import type { DepthDecision, DepthSetting } from '../../shared/depth.ts'
import { DEPTH_LABEL } from '../../shared/depth.ts'
import { deepMerge } from '../config/merge.ts'
import { classifyDepth } from './classify.ts'
import type { DepthInput } from './classify.ts'

/** The profiles first launch picks by readiness: they decide the vendors, not the pipeline, so `auto` still applies. */
export const READINESS_PROFILES: readonly string[] = ['balanced', 'claude-only', 'codex-only']

/** The Quick shape's Implement prompt (prompts/defaults/direct.md; a project or user `direct.md` replaces it). */
export const DIRECT_TEMPLATE = 'direct'

/** Reviewers in the order a Quick run picks one on another vendor. */
const REVIEWER_ORDER: readonly string[] = ['claude', 'codex', 'gemini']

export interface DepthContext {
  /** The resolved `depth` (absent: `auto`). */
  setting: DepthSetting | undefined
  /** Where a forced setting came from: this run's choice, or a settings file. */
  settingFrom?: 'run' | 'settings'
  /** The resolved profile. */
  profile: string
  /** The run itself picked the profile (the Full composer's profile picker, the CLI's --profile). */
  profileChosen: boolean
  input: DepthInput
}

export const DEPTH_CHOSEN_REASON = {
  run: (label: string): string => `You chose ${label} for this run.`,
  settings: (label: string): string => `Your settings use ${label}.`,
  profile: (profile: string): string => `The ${profile} profile was chosen, so its own passes run.`,
} as const

/** Quick or Thorough for a run, and why. */
export function decideDepth(c: DepthContext): DepthDecision {
  const setting = c.setting ?? 'auto'
  if (setting !== 'auto') {
    const label = DEPTH_LABEL[setting]
    return {
      depth: setting,
      source: 'chosen',
      reason:
        c.settingFrom === 'settings' ? DEPTH_CHOSEN_REASON.settings(label) : DEPTH_CHOSEN_REASON.run(label),
      signals: [],
    }
  }
  if (c.profileChosen || !READINESS_PROFILES.includes(c.profile)) {
    return {
      depth: 'full',
      source: 'profile',
      reason: DEPTH_CHOSEN_REASON.profile(c.profile),
      signals: [],
      profile: c.profile,
    }
  }
  const v = classifyDepth(c.input)
  return { depth: v.depth, source: 'auto', reason: v.reason, signals: v.signals }
}

/**
 * The reviewer a Quick run uses: Review as configured, moved to another ready vendor when it is on Implement's (with
 * Critic's model when Critic runs there, else that vendor's default). Undefined: Review stays as it is.
 */
export function directReviewer(
  cfg: Pick<ResolvedConfig, 'passes'>,
  ready: readonly string[],
): { vendor: string; model: string | null } | undefined {
  const impl = cfg.passes.implement.vendor
  if (cfg.passes.review.vendor !== impl) return undefined
  const other = REVIEWER_ORDER.find((v) => v !== impl && ready.includes(v))
  if (other === undefined) return undefined
  const critic = cfg.passes.critic
  return { vendor: other, model: critic.vendor === other ? critic.model : null }
}

/** The Quick shape as run overrides for a resolved config (the user's own run overrides go on top of it). */
export function directLayer(cfg: ResolvedConfig, ready: readonly string[]): RunOverrides {
  const reviewer = directReviewer(cfg, ready)
  const template = cfg.passes.implement.promptTemplate.name
  return {
    passes: {
      plan: { enabled: false, clarify: false, research: false },
      // Only the built-in Implement prompt gives way: a template the user chose for Implement stays.
      ...(template === 'implement' ? { implement: { promptTemplate: DIRECT_TEMPLATE } } : {}),
      review: { enabled: true, acceptance: false, ...(reviewer !== undefined ? reviewer : {}) },
      critic: { enabled: false },
    },
  }
}

/** The run's overrides with the Quick shape under them (what the user chose for the run still wins). */
export function withDirect(
  cfg: ResolvedConfig,
  ready: readonly string[],
  overrides: RunOverrides | undefined,
): RunOverrides {
  // `depth: direct` keeps a re-resolve (Re-run, the controller's patches) on the same shape and the reason honest.
  return deepMerge<RunOverrides>(directLayer(cfg, ready), overrides ?? {})
}
