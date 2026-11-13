// The run-overrides layer every Easy run sends (above its Easy recipe, which sets the switches): the profile picked by
// readiness, Auto off, the plan check (unless the user said "Don't ask me next time"), plain questions (and, for a
// result that is not a program, a summary that says how to open it rather than run it), no extensions on the passes
// that only read (the user's MCP servers, skills and hooks never run there silently) while the passes that build
// (Implement and Fix, and the Deploy step and Test-first's Tests step on Implement's pass) run at the user's own level
// (pass through unless the user chose otherwise), Verify when the folder has checks of
// its own, the run's own limits, and for a change the secret scan (the full security review when the change needs it)
// with lighter models and no Critic for a small one. Easy never
// writes a config file: this layer lives with the run.
import type {
  RunLimits,
  RunOverrides,
  SecurityReview,
  VerifyCommandConfig,
} from '../../shared/config-schema.ts'
import type { BuiltinProfileName } from '../config/defaults.ts'
import type { DepthSetting } from '../../shared/depth.ts'

export interface EasyOverridesInput {
  profile: BuiltinProfileName
  /** "Don't ask me next time" on the plan card (Easy settings). */
  skipPlanCheck: boolean
  limits: RunLimits
  /** The result is not a program (a document, report, memo or checklist): Explain says how to open it. */
  nonCode?: boolean
  /** The checks the folder has of its own (verify detection found them): the run checks with them. */
  checks?: readonly VerifyCommandConfig[]
  /**
   * Nobody is there to answer (the overnight list): no questions before the plan, no look at similar things to review
   * and no plan check. Asks still ask (and a timeout is a no); nothing is answered for the user.
   */
  unattended?: boolean
  /**
   * A change to a project (Make a change, a folder the user already has, carrying on): the security advisor is on, with
   * its secret scan on every change and its reviewer `always` (the change names keys or people's data) or only when the
   * scan finds the diff touches such code (`sensitive`). A `small` change runs Plan on a lighter model (Claude's
   * Sonnet, when Plan runs on Claude) and no Critic.
   */
  change?: { small: boolean; review: SecurityReview }
  /** Quick or Thorough as the user forced it (absent or auto: adaptive depth decides when the run starts). */
  depth?: DepthSetting
}

/** The lighter model a small change plans with, when Plan runs on Claude. */
export const SMALL_CHANGE_PLAN_MODEL = 'sonnet'

/** The built-in profiles whose Plan runs on Claude (a small change plans on its lighter model). */
const CLAUDE_PLAN: readonly BuiltinProfileName[] = ['balanced', 'claude-only']

export function easyOverrides(o: EasyOverridesInput): RunOverrides {
  const away = o.unattended === true
  const small = o.change?.small === true
  return {
    profile: o.profile,
    auto: false,
    gates: { afterPlan: !away && !o.skipPlanCheck, beforeFix: false },
    passes: {
      plan: {
        extensions: 'none',
        clarifyPlain: true,
        ...(o.nonCode === true ? { explainPlain: true } : {}),
        ...(away ? { clarify: false, research: false } : {}),
        ...(small && CLAUDE_PLAN.includes(o.profile) ? { model: SMALL_CHANGE_PLAN_MODEL } : {}),
      },
      // Implement and Fix build: they run at the user's own Extensions level (their skills and MCP servers), as a run
      // in Full mode does. The project permission still asks for what it does not cover.
      review: { extensions: 'none' },
      critic: { extensions: 'none', ...(small ? { enabled: false } : {}) },
      security: {
        extensions: 'none',
        ...(o.change !== undefined ? { enabled: true, review: o.change.review } : {}),
      },
    },
    ...(o.depth !== undefined && o.depth !== 'auto' ? { depth: o.depth } : {}),
    // The project's own checks, when the folder has some (a change run's: a new folder has none yet): each is trusted
    // by the project permission, or asks on the plain trust card.
    ...(o.checks !== undefined && o.checks.length > 0
      ? { verify: { enabled: true, commands: o.checks.map((c) => ({ ...c })) } }
      : {}),
    limits: { maxCostUsd: o.limits.maxCostUsd, maxMinutes: o.limits.maxMinutes },
  }
}
