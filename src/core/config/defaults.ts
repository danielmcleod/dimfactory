// Layer 0 (builtin defaults and built-in profiles): the five built-in profiles, every section's
// default, the per-pass base values and the config error type. No resolver logic lives here, so both builtins.ts
// (the original entry point, now delegating to resolve.ts) and resolve.ts can import it without an import cycle.
import type {
  FixConfig,
  ImplementConfig,
  ReviewConfig,
  PassConfig,
  PlanConfig,
  ProfileConfig,
  ResolvedConfig,
  SecurityConfig,
} from '../../shared/config-schema.ts'
import {
  CONTEXT_HEALTH_DEFAULTS,
  DEFAULT_TIMEOUTS,
  EASY_DEFAULTS,
  FACTORY_DEFAULTS,
  RUN_LIMITS_NONE,
} from '../../shared/config-schema.ts'
import { MEMORY_DEFAULT_MAX_BYTES } from '../../shared/factory.ts'
import type { FailureCategory } from '../../shared/failure.ts'
import { FIX_ROUNDS_MAX, PASS_NAMES } from '../../shared/run.ts'
import type { PassName } from '../../shared/run.ts'
import { BRAND } from '../../shared/brand.ts'
import { GUARDRAILS_DEFAULT } from '../../shared/guardrails.ts'

// ---- profiles ---------------------------------------------------------------------------------------------------

export const BUILTIN_PROFILE_NAMES = ['balanced', 'claude-only', 'codex-only', 'fast', 'thorough'] as const
export type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number]

export const DEFAULT_PROFILE: BuiltinProfileName = 'balanced'

const ro = (vendor: string, model: string | null = null, enabled = true): PassConfig => ({
  vendor,
  model,
  mode: 'readonly',
  enabled,
})
const edit = (vendor: string, model: string | null = null): PassConfig => ({
  vendor,
  model,
  mode: 'autoedit',
  enabled: true,
})
const inheritFix = (reuseSession: boolean): FixConfig => ({
  inherit: 'implement',
  reuseSession,
  enabled: true,
})

/**
 * The built-in profiles. Plan/Review/Critic/Security are read-only; Fix inherits Implement's vendor/model/mode. The
 * security advisor is opt-in: on in `thorough` only (the strongest reasoning model), off elsewhere until the composer's
 * "Security review" or a project setting turns it on. So are Clarify (questions before Plan; Auto still skips it unless
 * `clarifyInAuto`), Research (a cited study before Plan, its default lenses) and Fix until green (up to 3 Fix rounds):
 * on in `thorough` only.
 */
export const BUILTIN_PROFILES: Readonly<Record<BuiltinProfileName, ProfileConfig>> = deepFreeze({
  balanced: {
    plan: ro('claude', 'opus'),
    implement: edit('codex'),
    review: ro('claude', 'sonnet'),
    critic: ro('claude', 'opus'),
    security: ro('claude', 'opus', false),
    fix: inheritFix(true),
  },
  'claude-only': {
    plan: ro('claude', 'opus'),
    implement: edit('claude'),
    review: ro('claude', 'sonnet'),
    critic: ro('claude', 'opus'),
    security: ro('claude', 'opus', false),
    fix: inheritFix(true),
  },
  'codex-only': {
    plan: ro('codex'),
    implement: edit('codex'),
    review: ro('codex'),
    critic: ro('codex'),
    security: ro('codex', null, false),
    fix: inheritFix(true),
  },
  fast: {
    plan: ro('claude', 'sonnet', false),
    implement: edit('codex'),
    review: ro('claude', 'sonnet'),
    critic: ro('claude', null, false),
    security: ro('claude', 'opus', false),
    fix: inheritFix(true),
  },
  thorough: {
    plan: { ...ro('claude', 'opus'), clarify: true, research: true },
    implement: edit('codex'),
    review: { ...ro('claude', 'opus'), acceptance: true },
    critic: ro('claude', 'opus'),
    security: ro('claude', 'opus'),
    fix: { ...inheritFix(false), rounds: FIX_ROUNDS_MAX },
  },
})

export function isBuiltinProfile(name: string): name is BuiltinProfileName {
  return (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name)
}

// ---- layer 0 ----------------------------------------------------------------------------------------------------

/**
 * Layer 0: every section populated (the defaults table) but the project-only `git` (GIT_DEFAULTS) and `quality`
 * (QUALITY_DEFAULTS), `passes: {}` and the built-in profiles. `routing` is resolved from the profiles, not a section.
 */
export type BuiltinLayer = Omit<
  ResolvedConfig,
  'passes' | 'profile' | 'git' | 'quality' | 'routing' | 'memory' | 'tools'
> & {
  /** `memory.autoApply` is a project's opt-in: layer 0 (a valid user file) leaves it out; resolve fills in false. */
  memory: Omit<ResolvedConfig['memory'], 'autoApply'>
  profile: BuiltinProfileName
  profiles: Readonly<Record<BuiltinProfileName, ProfileConfig>>
  passes: ProfileConfig
}

export const BUILTIN_DEFAULTS: BuiltinLayer = deepFreeze({
  profile: DEFAULT_PROFILE,
  profiles: BUILTIN_PROFILES,
  passes: {},
  gates: { afterPlan: true, beforeFix: false },
  auto: false,
  planning: { native: 'auto' },
  ask: { denyPauses: false },
  timeouts: { ...DEFAULT_TIMEOUTS },
  isolation: {
    mode: 'inPlace',
    branch: 'none',
    branchPrefix: BRAND.branchPrefix,
    worktree: { copy: [], install: 'ask', installCommand: null, autoApply: false },
  },
  verify: { enabled: false, commands: [], runAfter: ['implement', 'fix'], failFast: false, baseline: false },
  extensions: { allowed: {} },
  // ---- user-only ----
  selfHeal: { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false },
  ui: { theme: 'system', accent: 'slate', closeToTray: 'auto', streamFontSize: 13, experience: null },
  notifications: {
    desktop: true,
    sound: false,
    onlyWhenUnfocused: true,
    events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
  },
  vendors: {},
  catalog: { refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' } },
  storage: { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
  local: { presets: [] },
  preview: { openIn: 'ask' },
  factory: FACTORY_DEFAULTS,
  // Fallback on a rate limit: off until you turn it on.
  fallback: { enabled: false, vendors: [] },
  // Project memory: read and fed to every pass when the file exists; updates are proposed, never written without you.
  memory: { enabled: true, propose: true, maxBytes: MEMORY_DEFAULT_MAX_BYTES },
  // A run's own limits: none unless a layer or the run sets one.
  limits: RUN_LIMITS_NONE,
  // Guardrails: the Recommended preset unless a layer raises it. No layer can lower what another set.
  guardrails: GUARDRAILS_DEFAULT,
  // Easy mode: the Documents folder's projects folder, no limits, the plan check on.
  easy: EASY_DEFAULTS,
  // Context health: restart after 3 compactions, the loop card at 8 and stop at 12, nothing online, no AI judge, the
  // post-compaction reminder in Auto runs only.
  contextHealth: CONTEXT_HEALTH_DEFAULTS,
})

/**
 * The project-only `git` section's defaults (commit and pull request off). Not in layer 0, which must stay a valid
 * user file: resolve fills them in when no project file sets them.
 */
export const GIT_DEFAULTS: Readonly<ResolvedConfig['git']> = deepFreeze({
  commit: false,
  pullRequest: false,
  remote: 'origin',
})

/** The project-only `quality` section's defaults (no gates). Filled in by resolve like GIT_DEFAULTS. */
export const QUALITY_DEFAULTS: Readonly<ResolvedConfig['quality']> = deepFreeze({
  enabled: false,
  verify: [],
  security: false,
  acceptance: false,
})

/**
 * Layer 0 with another default profile (the one first launch would pick for the vendors that are ready, used
 * while no layer sets `profile`). Every other value is BUILTIN_DEFAULTS'.
 */
export function builtinLayerWith(profile: BuiltinProfileName): BuiltinLayer {
  return profile === BUILTIN_DEFAULTS.profile ? BUILTIN_DEFAULTS : { ...BUILTIN_DEFAULTS, profile }
}

/** How many questions Clarify may ask by default (the middle of three to five). */
export const CLARIFY_DEFAULT_QUESTIONS = 4

/** Per-pass base values under every profile (a profile that omits a key gets these). */
export const PASS_BASE: Readonly<
  Record<PassName, PassConfig & FixConfig & SecurityConfig & PlanConfig & ImplementConfig & ReviewConfig>
> = {
  /**
   * Clarify (on the Plan pass) is off; when on it asks at most four questions, and Auto skips it. Research (on the Plan
   * pass) is off; when on with no lenses named it researches the pack's (or the generic) default lenses.
   */
  plan: {
    model: null,
    effort: null,
    mode: 'readonly',
    enabled: true,
    promptTemplate: null,
    extensions: 'none',
    clarify: false,
    clarifyQuestions: CLARIFY_DEFAULT_QUESTIONS,
    clarifyInAuto: false,
    clarifyPlain: false,
    research: false,
    researchLenses: [],
    explain: false,
    explainPlain: false,
  },
  /** The Deploy step (on the Implement pass) is off; when on with no target named, the pack's pick for the deliverable. */
  implement: {
    model: null,
    effort: null,
    mode: 'autoedit',
    enabled: true,
    promptTemplate: null,
    extensions: 'passthrough',
    deploy: false,
    deployTarget: null,
  },
  /** The acceptance review (on the Review pass) is off. */
  review: {
    model: null,
    effort: null,
    mode: 'readonly',
    enabled: true,
    promptTemplate: null,
    extensions: 'none',
    acceptance: false,
  },
  critic: {
    model: null,
    effort: null,
    mode: 'readonly',
    enabled: true,
    promptTemplate: null,
    extensions: 'none',
  },
  /**
   * The security advisor: off unless a profile, a layer or the run turns it on. Its default reviewer is the strongest
   * reasoning model (Claude Opus), for a profile that names none; the re-check after Fix is on.
   */
  security: {
    vendor: 'claude',
    model: 'opus',
    effort: null,
    mode: 'readonly',
    enabled: false,
    promptTemplate: null,
    extensions: 'none',
    recheck: true,
    review: 'always',
  },
  fix: {
    model: null,
    effort: null,
    extensions: 'passthrough',
    mode: 'autoedit',
    enabled: true,
    promptTemplate: null,
    inherit: 'implement',
    reuseSession: true,
    // A single Fix; 2 or 3 rounds turn on Fix until green (each round re-checked, no budget unless set).
    rounds: 1,
    recheck: true,
    maxCostUsd: null,
    maxMinutes: null,
  },
}

/** The Fix keys `inherit: 'implement'` copies from Implement unless Fix sets them (Resolve step 3). */
export const INHERITED_KEYS = ['vendor', 'model', 'effort', 'mode', 'extensions'] as const

/** Enabled passes in execution order. */
export function enabledPasses(cfg: Pick<ResolvedConfig, 'passes'>): PassName[] {
  return PASS_NAMES.filter((p) => cfg.passes[p].enabled)
}

// ---- errors -----------------------------------------------------------------------------------------------------

export interface BuiltinConfigIssue {
  /** RFC 6901 pointer into the run overrides (or the resolved config for `invalid`). */
  pointer: string
  message: string
}

export type BuiltinConfigErrorCode = 'invalid-overrides' | 'unknown-profile' | 'template' | 'invalid'

export class BuiltinConfigError extends Error {
  readonly code: BuiltinConfigErrorCode
  readonly category: FailureCategory = 'config_invalid'
  readonly issues: BuiltinConfigIssue[]
  constructor(code: BuiltinConfigErrorCode, message: string, issues: BuiltinConfigIssue[] = []) {
    super(message)
    this.name = 'BuiltinConfigError'
    this.code = code
    this.issues = issues
  }
}

// ---- util -------------------------------------------------------------------------------------------------------

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const child of Object.values(v)) deepFreeze(child)
    Object.freeze(v)
  }
  return v
}
