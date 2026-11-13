// dimfactory.json schema (zod 4, strictObject everywhere), the fully-resolved shape stored in resolved.json, and
// file-level semantic rules. Mapping issue pointers to file:line:col is core's job.
import { z } from 'zod'
import {
  CLARIFY_MAX_QUESTIONS,
  FIX_ROUNDS_MAX,
  ISOLATION_MODES,
  MODES,
  MUTATING_PASSES,
  PASS_NAMES,
  READONLY_PASSES,
} from './run.ts'
import type { PassName, ROUTED_STEPS } from './run.ts'
import { CLOCK_TIME, MEMORY_DEFAULT_MAX_BYTES, MEMORY_MAX_BYTES, MEMORY_MIN_BYTES } from './factory.ts'
import { RESEARCH_LENSES_MAX, RESEARCH_LENS_ID } from './research.ts'
import {
  EXTENSION_LEVELS,
  MCP_NAME_PATTERN,
  SKILL_NAME_PATTERN,
  defaultExtensionLevel,
} from './extensions.ts'
import type { ExtensionLevel } from './extensions.ts'
import { GuardrailsZ } from './guardrails.ts'
import { EFFORT_PATTERN, VENDOR_ID_PATTERN, codexEffortKeyMessage, codexEffortOverrides } from './vendors.ts'
import { PREVIEW_OPEN_TARGETS } from './preview.ts'
import { DEPLOY_TARGET_ID } from './deploy.ts'
import type { LocalPreset } from './vendors.ts'
import { DEPTH_SETTINGS } from './depth.ts'

export const CONFIG_SCOPES = ['user', 'project'] as const
export type ConfigScope = (typeof CONFIG_SCOPES)[number]

export const THEMES = ['light', 'dark', 'system'] as const
export type Theme = (typeof THEMES)[number]
export const ACCENTS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet'] as const
export type Accent = (typeof ACCENTS)[number]
export const STREAM_FONT_SIZES = [12, 13, 14] as const
export type StreamFontSize = (typeof STREAM_FONT_SIZES)[number]
/** How the app is used: Easy ("make something for me") or Full control. Unset (null): not chosen yet. */
export const EXPERIENCES = ['easy', 'full'] as const
export type Experience = (typeof EXPERIENCES)[number]

export const PLANNING_NATIVE = ['auto', 'off'] as const
export const BRANCH_MODES = ['none', 'runBranch'] as const
export const INSTALL_POLICIES = ['ask', 'auto', 'never'] as const
export const VERIFY_RUN_AFTER = ['implement', 'fix'] as const
export const NOTIFICATION_EVENTS = ['ask', 'gate', 'completed', 'failed', 'catalog'] as const
export const TEMPLATE_LAYERS = ['builtin', 'user', 'project'] as const

export const DEFAULT_TIMEOUTS = {
  stallMs: 300_000,
  hardKillMs: 1_200_000,
  toolStallMs: 900_000,
  askMs: 600_000,
} as const satisfies Timeouts

/** A renamed flag must still look like a flag. */
export const FLAG_VALUE_PATTERN = /^--?[a-z][a-z0-9-]*$/

/** Env vars a config may not set for a vendor child: Dim Factory owns them. */
const FORBIDDEN_ENV_PATTERN = /^(PATH|NODE_OPTIONS|ELECTRON_\w*)$/i

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/**
 * A host that is this computer: `localhost`, `127.x.x.x` or `[::1]`. A name under `.localhost` is not one:
 * Windows sends it to DNS (a hosts entry or a LAN responder can point it anywhere), and plain http to it would leave
 * the machine.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(host)
}

/** Local preset base URLs: https anywhere, plain http only on a loopback host. */
export function isAllowedPresetUrl(url: string): boolean {
  const m = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^/?#:@\s[\]]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(url)
  if (!m) return false
  return m[1]?.toLowerCase() === 'https' || isLoopbackHost(m[2] ?? '')
}

// ---- leaves ------------------------------------------------------------------

export const VendorIdZ = z.string().regex(VENDOR_ID_PATTERN)
/** null = omit the model flag and use the CLI default. */
export const ModelIdZ = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:@/[\]-]+$/)
  .nullable()
/** A reasoning effort level (`low`, `high`, `max`); null = the vendor's default effort (no effort sent). */
export const EffortZ = z.string().regex(EFFORT_PATTERN, 'Not an effort level').nullable()
/** Template name (looked up project → user → builtin); null = `<pass>.md`. */
export const TemplateNameZ = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .nullable()
/** A pass's Extensions level (shared/extensions.ts): none, allowed (the allow list) or passthrough. */
export const ExtensionLevelZ = z.enum(EXTENSION_LEVELS)
const McpNameZ = z.string().regex(MCP_NAME_PATTERN, 'Not an MCP server name Dim Factory can allow')
const SkillNameZ = z.string().regex(SKILL_NAME_PATTERN, 'Not a skill name')
export const ProfileNameZ = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
export const ModeZ = z.enum(MODES)
export const PassNameZ = z.enum(PASS_NAMES)
const EnvNameZ = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine((k) => !FORBIDDEN_ENV_PATTERN.test(k), { message: 'This variable is managed by Dim Factory' })
const FlagNameZ = z.string().regex(/^--?[A-Za-z][\w-]*$/)
/** argv, or one string tokenized quote-aware by core (no shell; metacharacters are rejected there). */
const CommandLineZ = z.union([
  z.array(z.string().min(1).max(1000)).min(1).max(64),
  z.string().min(1).max(1000),
])

// ---- passes and profiles ---------------------------------------------------------

const passFields = {
  vendor: VendorIdZ,
  model: ModelIdZ,
  effort: EffortZ,
  mode: ModeZ,
  enabled: z.boolean(),
  promptTemplate: TemplateNameZ,
  /** Which of the user's own extensions (MCP servers, skills, plugins, hooks) the pass may use. */
  extensions: ExtensionLevelZ,
}
/** Per-pass keys are EXACTLY vendor/model/effort/mode/enabled/promptTemplate/extensions. */
export const PassConfigZ = z.strictObject(passFields).partial()

/** Clarify's keys on the Plan pass (Clarify runs on the Plan pass's vendor, model and effort). */
const clarifyFields = {
  /** Clarify before Plan: the model may ask a few multiple-choice questions first (default off). */
  clarify: z.boolean(),
  /** The most questions Clarify may ask (1 to CLARIFY_MAX_QUESTIONS). */
  clarifyQuestions: z.number().int().min(1).max(CLARIFY_MAX_QUESTIONS),
  /** In Auto, Clarify still asks (its card waits for you); off (the default): Auto skips Clarify. */
  clarifyInAuto: z.boolean(),
  /**
   * Plain questions: Clarify asks about the outcome (who uses it, what it needs), never the technology, in words for
   * someone who does not write code (Easy runs turn it on; default off).
   */
  clarifyPlain: z.boolean(),
}
/** Research's keys on the Plan pass (Research runs on the Plan pass's vendor, model and effort). */
const researchFields = {
  /** Research before Plan: a read-only, web-enabled study of the problem space (default off). */
  research: z.boolean(),
  /**
   * The lenses to research (generic or the run's pack's lens ids, at most RESEARCH_LENSES_MAX). Empty (the default):
   * the pack's default lenses, else the generic defaults.
   */
  researchLenses: z
    .array(z.string().regex(RESEARCH_LENS_ID, 'Not a lens id (letters, digits and dashes, up to 40)'))
    .max(RESEARCH_LENSES_MAX),
}
/** Explain's key on the Plan pass (Explain runs on the Plan pass's vendor, model and effort, read-only). */
const explainFields = {
  /**
   * Explain it to me: a final read-only pass that writes a plain-language summary of the run (what was built, how to
   * run it, what to try next, known limits) to explain.md (default off).
   */
  explain: z.boolean(),
  /**
   * Explain for a result that is not a program (a document, a report, a memo, a checklist): "How to open it" instead
   * of "How to run it", in words for someone who does not write code (Easy runs of those kinds turn it on; default
   * off).
   */
  explainPlain: z.boolean(),
}
/** The Plan pass: the pass keys plus Clarify's, Research's and Explain's. */
export const PlanConfigZ = z
  .strictObject({ ...passFields, ...clarifyFields, ...researchFields, ...explainFields })
  .partial()

/** The acceptance review's key on the Review pass (it runs on Review's vendor, model and effort, read-only). */
const acceptanceFields = {
  /**
   * The acceptance review: a read-only pass that marks each of the plan's acceptance criteria met, not met or unknown,
   * with evidence (default off).
   */
  acceptance: z.boolean(),
}
/** The Review pass: the pass keys plus the acceptance review's. */
export const ReviewConfigZ = z.strictObject({ ...passFields, ...acceptanceFields }).partial()

/** The Deploy step's keys on the Implement pass (the Deploy step runs on Implement's vendor, model and mode). */
const deployFields = {
  /** The Deploy step at the end of a run: write the deploy config the target needs (default off; never deploys). */
  deploy: z.boolean(),
  /** The deploy target (a pack target id, `netlify`, `fly`, …); null (the default): the pack's pick for the deliverable. */
  deployTarget: z.string().regex(DEPLOY_TARGET_ID, 'Not a deploy target id').nullable(),
}
/** Continuity's key on the Implement pass. */
const continuityFields = {
  /**
   * Implement continues Plan's session when both run on the same vendor and the session can carry on (the model rule
   * and the vendor's mode switch on resume); Plan stays read-only and Implement resumes it in its own mode. Absent:
   * on (the default).
   */
  continuePlan: z.boolean(),
}
/** The Implement pass: the pass keys plus the Deploy step's and continuity's. */
export const ImplementConfigZ = z
  .strictObject({ ...passFields, ...deployFields, ...continuityFields })
  .partial()

/** Fix until green's keys on the Fix pass. */
const fixLoopFields = {
  /** Fix rounds: 1 = a single Fix (the default); 2 or 3 = Fix until green, at most this many rounds. */
  rounds: z.number().int().min(1).max(FIX_ROUNDS_MAX),
  /** Fix until green: a read-only re-check of the round's [must] findings after each round (default on). */
  recheck: z.boolean(),
  /** Fix until green stops before a round that would take the run past this cost (USD; null: no limit). */
  maxCostUsd: z.number().positive().max(10_000).nullable(),
  /** Fix until green stops before a round that would take the run past this much working time (null: no limit). */
  maxMinutes: z.number().int().min(1).max(1_440).nullable(),
}
/**
 * What sends a finding to Fix: `evidence` (the default) only a [must] with evidence (a `file:line`, a failing check or a
 * grounding flag), and with Fix until green on a [should] with evidence too; `all` every finding (the earlier rule).
 * Either way every finding is listed, and the user can tick any of them for Fix.
 */
export const FIX_TRIGGERS = ['evidence', 'all'] as const
export type FixTrigger = (typeof FIX_TRIGGERS)[number]
export const FixConfigZ = z
  .strictObject({
    ...passFields,
    ...fixLoopFields,
    inherit: z.literal('implement').nullable(),
    reuseSession: z.boolean(),
    trigger: z.enum(FIX_TRIGGERS),
  })
  .partial()
/**
 * The Security pass (the security advisor, opt-in): the pass keys plus `recheck`, the short read-only re-check after
 * Fix that confirms each security [must] is resolved (default on).
 */
/**
 * When the security reviewer runs: `always` (the default), or `sensitive`: only when the run's changes touch code
 * that handles keys, sign-in, payments or people's data (the scan reads it from the diff; a secret it finds counts too).
 * The secret scan runs either way.
 */
export const SECURITY_REVIEWS = ['always', 'sensitive'] as const
export type SecurityReview = (typeof SECURITY_REVIEWS)[number]
export const SecurityConfigZ = z
  .strictObject({ ...passFields, recheck: z.boolean(), review: z.enum(SECURITY_REVIEWS) })
  .partial()
/**
 * Model routing: a step that runs on another pass's vendor (Research, Clarify and Explain on Plan's, the acceptance
 * review on Review's, the re-check on Security's) may run another model or effort of that vendor (a cheaper model for
 * Research, say). Absent keys follow the pass.
 */
export const StepRouteZ = z.strictObject({ model: ModelIdZ, effort: EffortZ }).partial()
export const RoutingZ = z.strictObject({
  research: StepRouteZ,
  clarify: StepRouteZ,
  explain: StepRouteZ,
  acceptance: StepRouteZ,
  recheck: StepRouteZ,
} satisfies Record<(typeof ROUTED_STEPS)[number], typeof StepRouteZ>)
export const ProfileZ = z
  .strictObject({
    plan: PlanConfigZ,
    implement: ImplementConfigZ,
    review: ReviewConfigZ,
    critic: PassConfigZ,
    security: SecurityConfigZ,
    fix: FixConfigZ,
    /** Per-step model routing (see StepRouteZ). */
    routing: RoutingZ.partial(),
  })
  .partial()

// ---- sections (full shapes are the resolved ones; files use .partial()) -----------------

export const TimeoutsZ = z.strictObject({
  stallMs: z.number().int().min(30_000).max(3_600_000),
  hardKillMs: z.number().int().min(60_000).max(14_400_000),
  toolStallMs: z.number().int().min(30_000).max(7_200_000),
  askMs: z.number().int().min(30_000).max(3_600_000),
})

const worktreeFields = {
  copy: z.array(z.string().min(1).max(260)).max(50),
  install: z.enum(INSTALL_POLICIES),
  installCommand: CommandLineZ.nullable(),
  autoApply: z.boolean(),
}
const isolationFields = {
  mode: z.enum(ISOLATION_MODES),
  branch: z.enum(BRANCH_MODES),
  branchPrefix: z.string().regex(/^[A-Za-z0-9._/-]{1,40}$/),
}

export const VerifyCommandConfigZ = z.strictObject({
  name: z.string().min(1).max(40),
  run: CommandLineZ,
  cwd: z.string().min(1).max(260).exactOptional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).exactOptional(),
  enabled: z.boolean().exactOptional(),
})
const verifyFields = {
  enabled: z.boolean(),
  commands: z.array(VerifyCommandConfigZ).max(20),
  runAfter: z.array(z.enum(VERIFY_RUN_AFTER)).max(2),
  failFast: z.boolean(),
  baseline: z.boolean(),
}

/** One vendor's allow list: the MCP servers and skills a pass at the "allowed" level may use. */
const AllowedExtensionsZ = z.strictObject({
  mcp: z.array(McpNameZ).max(200),
  skills: z.array(SkillNameZ).max(500),
  /** Claude: allowed MCP servers whose tools run without asking, read-only passes included (off by default). */
  mcpWithoutAsking: z.array(McpNameZ).max(200),
})
const ExtensionsSectionZ = z.strictObject({ allowed: z.record(VendorIdZ, AllowedExtensionsZ.partial()) })

/** One vendor's tools a run's picker names: MCP servers and skills. */
const ToolNamesZ = z.strictObject({ mcp: z.array(McpNameZ).max(50), skills: z.array(SkillNameZ).max(50) })
/**
 * The composer's Tools for one run (the run layer only, never a file): per vendor, the MCP servers and skills put on
 * (`on`) or taken off (`off`) the Allowed list for this run, and `skill`, the one skill the run is asked to use ("Use
 * skill"). What a pass then gets is shared/extensions.ts passExtensionsPlan: picks add only to the passes that change
 * files, never to a read-only pass, and never change a pass's level.
 */
export const RunToolsZ = z.strictObject({
  on: z.record(VendorIdZ, ToolNamesZ.partial()),
  off: z.record(VendorIdZ, ToolNamesZ.partial()),
  skill: z.strictObject({ vendor: VendorIdZ, name: SkillNameZ }).nullable(),
})
/** A resolved run's Tools: every vendor entry with both lists. */
export const ResolvedRunToolsZ = z.strictObject({
  on: z.record(VendorIdZ, ToolNamesZ),
  off: z.record(VendorIdZ, ToolNamesZ),
  skill: z.strictObject({ vendor: VendorIdZ, name: SkillNameZ }).nullable(),
})
export type RunToolsInput = z.infer<typeof RunToolsZ>

const SelfHealZ = z.strictObject({
  enabled: z.boolean(),
  vendor: VendorIdZ,
  model: ModelIdZ,
  autoApplyConfigPatches: z.boolean(),
})
const UiZ = z.strictObject({
  theme: z.enum(THEMES),
  accent: z.enum(ACCENTS),
  closeToTray: z.union([z.boolean(), z.literal('auto')]),
  streamFontSize: z.union([z.literal(12), z.literal(13), z.literal(14)]),
  /** Easy or Full control (null: not chosen yet; the app then shows Full, or asks a new user once). */
  experience: z.enum(EXPERIENCES).nullable(),
})
/**
 * A run's own limits (any layer, and the run's overrides): it stops once its cost passes `maxCostUsd` or it has worked
 * `maxMinutes` (time waiting for you does not count). Null: no limit (the default).
 */
export const RunLimitsZ = z.strictObject({
  maxCostUsd: z.number().positive().max(10_000).nullable(),
  maxMinutes: z.number().int().min(1).max(1_440).nullable(),
})
export type RunLimits = z.infer<typeof RunLimitsZ>
export const RUN_LIMITS_NONE: Readonly<RunLimits> = { maxCostUsd: null, maxMinutes: null }
/**
 * Easy mode's settings (user only): where new projects go (null: the Documents folder's "Dim Factory Projects"), the
 * limits a new project and a change start with (null: no limit, the default), and whether Easy runs skip the plan
 * check ("Don't ask me next time").
 */
const EasyZ = z.strictObject({
  projectsDir: z.string().min(1).max(1024).nullable(),
  maxCostUsd: z.number().positive().max(10_000).nullable(),
  changeMaxCostUsd: z.number().positive().max(10_000).nullable(),
  maxMinutes: z.number().int().min(1).max(1_440).nullable(),
  skipPlanCheck: z.boolean(),
})
export type EasySettings = z.infer<typeof EasyZ>
/** Easy's defaults: the Documents folder's projects folder, no limits, the plan check on. */
export const EASY_DEFAULTS: Readonly<EasySettings> = {
  projectsDir: null,
  maxCostUsd: null,
  changeMaxCostUsd: null,
  maxMinutes: null,
  skipPlanCheck: false,
}
/** When the short reminder after a compaction is sent: never, in Auto runs only, or in every run. */
export const COMPACTION_REMINDERS = ['off', 'auto', 'always'] as const
export type CompactionReminder = (typeof COMPACTION_REMINDERS)[number]
/**
 * Context health (user only): how Dim Factory reacts to what it sees of a pass's context. It never changes a vendor's
 * own settings; every reaction is a card in a normal run and happens once on its own in Auto.
 */
const ContextHealthZ = z.strictObject({
  /**
   * After this many compactions in Implement or Fix: restart the pass fresh with a summary (a card in a normal run,
   * once on its own in Auto). Null: never.
   */
  restartAfterCompactions: z.number().int().min(2).max(10).nullable(),
  /** The same call this many times in a pass: the loop card (Stop or Keep going). */
  loopWarnAt: z.number().int().min(3).max(50),
  /** The same call this many times: Dim Factory stops the pass (Auto then retries it fresh once). */
  loopStopAt: z.number().int().min(4).max(100),
  /** Fix starts a fresh session when Implement ended at least this full (percent of its window)... */
  heavyPercent: z.number().int().min(30).max(100),
  /** ...or after this many compactions. */
  heavyCompactions: z.number().int().min(1).max(10),
  /** The short reminder after a compaction (the plan, the criteria, the files changed so far). */
  compactionReminder: z.enum(COMPACTION_REMINDERS),
  /**
   * The grounding checks after Implement and Fix (no model): what the AI said it did against what the run shows (files,
   * tests it said it ran, imports and packages it added). Their findings go to Fix.
   */
  grounding: z.boolean(),
  /** Look up dependencies a run adds in their public registry (npm, PyPI, crates.io). Uses the network. */
  registryCheck: z.boolean(),
  /** A cheap model of the Review vendor checks the AI's claims after Implement (its findings read "AI-judged"). */
  aiJudge: z.boolean(),
})
export type ContextHealthSettings = z.infer<typeof ContextHealthZ>
/**
 * Context health's defaults: restart after 3 compactions, loop card at 8 and stop at 12, nothing online, and the
 * post-compaction reminder in Auto runs only (verified live with Claude's SessionStart hook and Codex's turn/steer).
 */
export const CONTEXT_HEALTH_DEFAULTS: Readonly<ContextHealthSettings> = {
  restartAfterCompactions: 3,
  loopWarnAt: 8,
  loopStopAt: 12,
  heavyPercent: 70,
  heavyCompactions: 2,
  compactionReminder: 'auto',
  grounding: true,
  registryCheck: false,
  aiJudge: false,
}
/** Settings → Preview: where Open preview shows a preview's page. */
const PreviewZ = z.strictObject({ openIn: z.enum(PREVIEW_OPEN_TARGETS) })
/** A git remote name (`origin`). */
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/**
 * Commit and pull request at the end of a run (project only, default off): `commit` offers "Commit to run branch" for a
 * run on a run branch or an isolated copy; `pullRequest` offers "Create PR" (a copyable `gh pr create`, or run after a
 * confirmation that names the repository and branch); `remote` is where a pull request's branch is pushed.
 */
const GitSectionZ = z.strictObject({
  commit: z.boolean(),
  pullRequest: z.boolean(),
  remote: z.string().regex(REMOTE_NAME_PATTERN, 'Not a git remote name'),
})
const NotificationEventsZ = z.strictObject({
  ask: z.boolean(),
  gate: z.boolean(),
  completed: z.boolean(),
  failed: z.boolean(),
  catalog: z.boolean(),
})
const notificationFields = { desktop: z.boolean(), sound: z.boolean(), onlyWhenUnfocused: z.boolean() }
const vendorFields = {
  path: z.string().min(1).max(1024).nullable(),
  defaultModel: ModelIdZ,
  /** The effort level of passes on this vendor that set none (null: the vendor's default). */
  defaultEffort: EffortZ,
  extraArgs: z.array(z.string().min(1).max(200)).max(32),
  env: z.record(EnvNameZ, z.string().max(8192)),
  /** managed flag → replacement flag (a CLI renamed it). Keys are checked against managedFlags in core. */
  flagMap: z.record(FlagNameZ, z.string().min(1).max(64)),
}
const CatalogRefreshZ = z.strictObject({
  enabled: z.boolean(),
  intervalDays: z.number().int().min(1).max(365),
  vendor: VendorIdZ,
  model: ModelIdZ,
})
const StorageZ = z.strictObject({
  keepRuns: z.number().int().min(1).max(100_000),
  keepDays: z.number().int().min(1).max(3650),
  rawLogDays: z.number().int().min(0).max(3650),
})
export const LocalPresetZ = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
  label: z.string().min(1).max(60),
  baseUrl: z
    .string()
    .max(2048)
    .refine(isAllowedPresetUrl, { message: 'Use https, or http only for localhost / 127.0.0.1 / [::1]' }),
  model: z.string().min(1).max(128),
  apiKeyEnv: EnvNameZ.exactOptional(),
  contextWindow: z.number().int().positive().max(100_000_000).exactOptional(),
}) satisfies z.ZodType<LocalPreset>

/** The factory's schedule (user only): the window the queue runs in, local time. */
export const ScheduleZ = z.strictObject({
  enabled: z.boolean(),
  start: z.string().regex(CLOCK_TIME, 'Use HH:MM on a 24-hour clock'),
  end: z.string().regex(CLOCK_TIME, 'Use HH:MM on a 24-hour clock').nullable(),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  resumeAutomatically: z.boolean(),
  onBattery: z.boolean(),
})
/**
 * The factory (user only): how queued tasks run (Auto, isolated copies, how many at once), the budgets and stop rules,
 * and the schedule. A null limit is no limit.
 */
const factoryFields = {
  /** Queued tasks run in Auto (trust grants, blocking cards and budgets still apply). Default off. */
  auto: z.boolean(),
  maxCostPerRunUsd: z.number().positive().max(10_000).nullable(),
  maxCostPerDayUsd: z.number().positive().max(100_000).nullable(),
  maxMinutesPerRun: z.number().int().min(1).max(1_440).nullable(),
  /** The most Fix rounds a queued run takes (never more than its own config allows). */
  maxFixRounds: z.number().int().min(1).max(FIX_ROUNDS_MAX).nullable(),
  /** Pause the queue after this many failed tasks in a row. */
  stopAfterFailures: z.number().int().min(1).max(100).nullable(),
  /** A task whose run needs you is left waiting and the queue goes on with the next (default off: the queue waits). */
  skipBlocked: z.boolean(),
  /** Each task runs in an isolated copy, so a folder's tasks can run side by side. */
  isolate: z.boolean(),
  /** The most queued runs working at once, over every folder. */
  maxParallel: z.number().int().min(1).max(8),
}
const FactoryZ = z.strictObject({ ...factoryFields, schedule: ScheduleZ })
/** Fallback on a rate limit or an exhausted quota: switch the pass to another ready vendor (default off). */
const FallbackZ = z.strictObject({
  enabled: z.boolean(),
  /** The vendors to try, in order (empty: the usual order, Claude then Codex then the others). */
  vendors: z.array(VendorIdZ).max(8),
})
/**
 * Quality gates (project only): the checks a run must pass to count as done. `verify` names verify commands (tests,
 * lint, a coverage command); `security` needs the security review with nothing open; `acceptance` needs every
 * acceptance criterion met. A run that misses one completes as "Completed with failures".
 */
const QualityZ = z.strictObject({
  enabled: z.boolean(),
  verify: z.array(z.string().min(1).max(40)).max(20),
  security: z.boolean(),
  acceptance: z.boolean(),
})
/**
 * Project memory (DIM_FACTORY.md at the project root): fed to every pass as `{{memory}}` (at most `maxBytes`), and
 * after each run an update is proposed for you to approve. `autoApply` (project only) lets Auto runs write it without
 * asking.
 */
const MemoryZ = z.strictObject({
  enabled: z.boolean(),
  propose: z.boolean(),
  autoApply: z.boolean(),
  maxBytes: z.number().int().min(MEMORY_MIN_BYTES).max(MEMORY_MAX_BYTES),
})

// ---- dimfactory.json ---------------------------------------------------------------

/** One config file (user or project). Every key optional; unknown keys anywhere are errors. */
export const DimFactoryConfigZ = z
  .strictObject({
    $schema: z.string().max(2048),
    /** Absent ⇒ 1. */
    version: z.literal(1),
    profile: ProfileNameZ,
    profiles: z.record(ProfileNameZ, ProfileZ),
    /** Layer-level pass overrides applied after the selected profile (the "Save to project" target). */
    passes: ProfileZ,
    /**
     * How deep a run goes (shared/depth.ts): `auto` (the default) decides per run, `direct` is always Quick (one strong
     * session plus checks), `full` always the profile's full pipeline. An explicit profile choice wins over `auto`.
     */
    depth: z.enum(DEPTH_SETTINGS),
    planning: z.strictObject({ native: z.enum(PLANNING_NATIVE) }).partial(),
    gates: z.strictObject({ afterPlan: z.boolean(), beforeFix: z.boolean() }).partial(),
    auto: z.boolean(),
    ask: z.strictObject({ denyPauses: z.boolean() }).partial(),
    timeouts: TimeoutsZ.partial(),
    isolation: z
      .strictObject({ ...isolationFields, worktree: z.strictObject(worktreeFields).partial() })
      .partial(),
    verify: z.strictObject(verifyFields).partial(),
    /** The allow lists of the "allowed" Extensions level, per vendor (user or project). */
    extensions: ExtensionsSectionZ.partial(),
    /** Fallback on a rate limit (user or project). */
    fallback: FallbackZ.partial(),
    /** Project memory (user or project; `autoApply` only in a project file). */
    memory: MemoryZ.partial(),
    /** A run's own cost and time limits (any layer, and the run's overrides; null: none). */
    limits: RunLimitsZ.partial(),
    /** Rules a run must keep (shared/guardrails.ts). Layers only tighten, so this section does not merge like the others. */
    guardrails: GuardrailsZ.partial(),
    // ---- project-only (an error in a user file) ----
    git: GitSectionZ.partial(),
    quality: QualityZ.partial(),
    // ---- user-only (an error in a project file) ----
    selfHeal: SelfHealZ.partial(),
    ui: UiZ.partial(),
    notifications: z.strictObject({ ...notificationFields, events: NotificationEventsZ.partial() }).partial(),
    vendors: z.record(VendorIdZ, z.strictObject(vendorFields).partial()),
    catalog: z.strictObject({ refresh: CatalogRefreshZ.partial() }).partial(),
    storage: StorageZ.partial(),
    local: z.strictObject({ presets: z.array(LocalPresetZ).max(20) }).partial(),
    preview: PreviewZ.partial(),
    factory: z.strictObject({ ...factoryFields, schedule: ScheduleZ.partial() }).partial(),
    /** Easy mode (user only). */
    easy: EasyZ.partial(),
    /** Context health's reactions and checks (user only). */
    contextHealth: ContextHealthZ.partial(),
  })
  .partial()

export type DimFactoryConfig = z.infer<typeof DimFactoryConfigZ>
export type PassConfig = z.infer<typeof PassConfigZ>
export type ImplementConfig = z.infer<typeof ImplementConfigZ>
export type PlanConfig = z.infer<typeof PlanConfigZ>
export type ReviewConfig = z.infer<typeof ReviewConfigZ>
export type FixConfig = z.infer<typeof FixConfigZ>
export type SecurityConfig = z.infer<typeof SecurityConfigZ>
export type ProfileConfig = z.infer<typeof ProfileZ>
export type Timeouts = z.infer<typeof TimeoutsZ>
export type VerifyCommandConfig = z.infer<typeof VerifyCommandConfigZ>

/** Keys a committed project file may not set (a project must never point `vendors.*.path` at an executable). */
export const USER_ONLY_KEYS = [
  'selfHeal',
  'ui',
  'notifications',
  'vendors',
  'catalog',
  'storage',
  'local',
  'preview',
  'factory',
  'easy',
  'contextHealth',
] as const satisfies readonly (keyof DimFactoryConfig)[]
export type UserOnlyKey = (typeof USER_ONLY_KEYS)[number]

/** Keys only a project file may set (commit and pull request are opted into per project). */
export const PROJECT_ONLY_KEYS = ['git', 'quality'] as const satisfies readonly (keyof DimFactoryConfig)[]

export const RUN_OVERRIDE_KEYS = [
  'profile',
  'auto',
  'passes',
  'depth',
  'gates',
  'planning',
  'isolation',
  'verify',
  'limits',
] as const satisfies readonly (keyof DimFactoryConfig)[]

/**
 * The in-memory run layer (composer overrides, CLI `--set`). Strict: user-only keys are unrecognized. `tools` (the
 * composer's Tools and Use skill) exists only here: it is for one run, never saved to a file.
 */
export const RunOverridesZ = DimFactoryConfigZ.pick({
  profile: true,
  auto: true,
  passes: true,
  depth: true,
  gates: true,
  planning: true,
  isolation: true,
  verify: true,
  limits: true,
}).extend({ tools: RunToolsZ.partial().optional() })
export type RunOverrides = z.infer<typeof RunOverridesZ>

// ---- resolved config (resolved.json `config`; Re-run loads it through ResolvedConfigZ) ----------

export const ResolvedTemplateZ = z.strictObject({
  name: z.string().min(1).max(64),
  path: z.string().min(1),
  layer: z.enum(TEMPLATE_LAYERS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export const ResolvedPassZ = z.strictObject({
  vendor: VendorIdZ,
  model: ModelIdZ,
  /** Absent in a resolved.json written before effort existed: the vendor's default. */
  effort: EffortZ.default(null),
  mode: ModeZ,
  enabled: z.boolean(),
  promptTemplate: ResolvedTemplateZ,
  /** Absent in a resolved.json written before Extensions existed: none (the passes below give their own default). */
  extensions: ExtensionLevelZ.default('none'),
})
/** A pass of a resolved.json written before Extensions existed runs at the level it ran at then. */
const resolvedPassAt = (level: ExtensionLevel) =>
  z.strictObject({ ...ResolvedPassZ.shape, extensions: ExtensionLevelZ.default(level) })
export const ResolvedFixPassZ = z.strictObject({
  ...ResolvedPassZ.shape,
  // Absent in a resolved.json written before Extensions existed: what Fix did then (everything passes through).
  extensions: ExtensionLevelZ.default(defaultExtensionLevel('fix')),
  inherit: z.literal('implement').nullable(),
  reuseSession: z.boolean(),
  // Absent in a resolved.json written before Fix until green existed: a single Fix.
  rounds: fixLoopFields.rounds.default(1),
  recheck: fixLoopFields.recheck.default(true),
  maxCostUsd: fixLoopFields.maxCostUsd.default(null),
  maxMinutes: fixLoopFields.maxMinutes.default(null),
  // Absent (no layer set it, or a resolved.json written before it existed): `evidence`, the default.
  trigger: z.enum(FIX_TRIGGERS).optional(),
})

/** The Implement pass resolved: the Deploy step's keys (absent in a resolved.json written before Deploy existed: off). */
export const ResolvedImplementPassZ = z.strictObject({
  ...ResolvedPassZ.shape,
  extensions: ExtensionLevelZ.default(defaultExtensionLevel('implement')),
  deploy: deployFields.deploy.default(false),
  deployTarget: deployFields.deployTarget.default(null),
  // Absent (no layer set it, or a resolved.json written before it existed): on, the default.
  continuePlan: z.boolean().optional(),
})

/** The Plan pass resolved: Clarify's keys (absent in a resolved.json written before Clarify existed: off). */
export const ResolvedPlanPassZ = z.strictObject({
  ...ResolvedPassZ.shape,
  extensions: ExtensionLevelZ.default(defaultExtensionLevel('plan')),
  clarify: clarifyFields.clarify.default(false),
  clarifyQuestions: clarifyFields.clarifyQuestions.default(4),
  clarifyInAuto: clarifyFields.clarifyInAuto.default(false),
  // Absent in a resolved.json written before plain questions existed: off.
  clarifyPlain: clarifyFields.clarifyPlain.default(false),
  // Absent in a resolved.json written before Research existed: off.
  research: researchFields.research.default(false),
  researchLenses: researchFields.researchLenses.default([]),
  // Absent in a resolved.json written before Explain existed: off.
  explain: explainFields.explain.default(false),
  // Absent in a resolved.json written before the plain summary existed: off.
  explainPlain: explainFields.explainPlain.default(false),
})

/** The Review pass resolved: the acceptance review's key (absent in a resolved.json written before it existed: off). */
export const ResolvedReviewPassZ = z.strictObject({
  ...ResolvedPassZ.shape,
  extensions: ExtensionLevelZ.default(defaultExtensionLevel('review')),
  acceptance: acceptanceFields.acceptance.default(false),
})

export const ResolvedSecurityPassZ = z.strictObject({
  ...ResolvedPassZ.shape,
  extensions: ExtensionLevelZ.default(defaultExtensionLevel('security')),
  recheck: z.boolean().default(true),
  // Absent in a resolved.json written before the review could depend on the change: always.
  review: z.enum(SECURITY_REVIEWS).optional(),
})

/**
 * The Security pass of a resolved.json written before the security advisor existed: off (that run never had one).
 * Its template stands in for a pass that never renders a prompt.
 */
export const SECURITY_PASS_ABSENT = {
  vendor: 'claude',
  model: null,
  effort: null,
  mode: 'readonly',
  enabled: false,
  promptTemplate: { name: 'security', path: 'security.md', layer: 'builtin', sha256: '0'.repeat(64) },
  extensions: 'none',
  recheck: true,
  review: 'always',
} as const satisfies z.input<typeof ResolvedSecurityPassZ>

/** The factory's settings, every key populated. */
export type FactorySettings = z.infer<typeof FactoryZ>

/** The factory's defaults: no budgets, three failures in a row pause a queue, at most two queued runs at once. */
export const FACTORY_DEFAULTS: Readonly<FactorySettings> = {
  auto: false,
  maxCostPerRunUsd: null,
  maxCostPerDayUsd: null,
  maxMinutesPerRun: null,
  maxFixRounds: null,
  stopAfterFailures: 3,
  skipBlocked: false,
  isolate: false,
  maxParallel: 2,
  schedule: {
    enabled: false,
    start: '22:00',
    end: '06:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    resumeAutomatically: false,
    onBattery: false,
  },
}

export type ResolvedTemplate = z.infer<typeof ResolvedTemplateZ>
export type ResolvedPass = z.infer<typeof ResolvedPassZ>
export type ResolvedFixPass = z.infer<typeof ResolvedFixPassZ>
export type ResolvedPlanPass = z.infer<typeof ResolvedPlanPassZ>
export type ResolvedReviewPass = z.infer<typeof ResolvedReviewPassZ>
export type ResolvedImplementPass = z.infer<typeof ResolvedImplementPassZ>
export type ResolvedSecurityPass = z.infer<typeof ResolvedSecurityPassZ>

const ResolvedShapeZ = z.strictObject({
  profile: ProfileNameZ,
  auto: z.boolean(),
  // Absent (no layer set it, or a resolved.json written before it existed): `auto`, the default.
  depth: z.enum(DEPTH_SETTINGS).optional(),
  passes: z.strictObject({
    plan: ResolvedPlanPassZ,
    implement: ResolvedImplementPassZ,
    review: ResolvedReviewPassZ,
    critic: resolvedPassAt(defaultExtensionLevel('critic')),
    security: ResolvedSecurityPassZ.default(() => structuredClone(SECURITY_PASS_ABSENT) as never),
    fix: ResolvedFixPassZ,
  }),
  planning: z.strictObject({ native: z.enum(PLANNING_NATIVE) }),
  gates: z.strictObject({ afterPlan: z.boolean(), beforeFix: z.boolean() }),
  ask: z.strictObject({ denyPauses: z.boolean() }),
  timeouts: TimeoutsZ,
  isolation: z.strictObject({ ...isolationFields, worktree: z.strictObject(worktreeFields) }),
  verify: z.strictObject(verifyFields),
  // Absent in a resolved.json written before Extensions existed: no allow lists.
  extensions: z.strictObject({ allowed: z.record(VendorIdZ, AllowedExtensionsZ) }).default({ allowed: {} }),
  // The run's own Tools (the composer's picker and Use skill). Absent in a resolved.json written before it existed: none.
  tools: ResolvedRunToolsZ.default(() => ({ on: {}, off: {}, skill: null })),
  selfHeal: SelfHealZ,
  // `experience` is absent in a resolved.json written before Easy mode existed: not chosen.
  ui: z.strictObject({ ...UiZ.shape, experience: UiZ.shape.experience.default(null) }),
  notifications: z.strictObject({ ...notificationFields, events: NotificationEventsZ }),
  // `defaultEffort` is absent in a resolved.json written before effort existed: the vendor's default.
  vendors: z.record(VendorIdZ, z.strictObject({ ...vendorFields, defaultEffort: EffortZ.default(null) })),
  catalog: z.strictObject({ refresh: CatalogRefreshZ }),
  storage: StorageZ,
  local: z.strictObject({ presets: z.array(LocalPresetZ).max(20) }),
  // Absent in a resolved.json written before Run & Preview existed.
  preview: PreviewZ.default({ openIn: 'ask' }),
  // Absent in a resolved.json written before the Deploy helper existed: commit and pull request off.
  git: GitSectionZ.default({ commit: false, pullRequest: false, remote: 'origin' }),
  // Absent in a resolved.json written before the factory existed: its defaults, fallback off, no quality gates, memory
  // as it is by default, no routing.
  factory: FactoryZ.default(() => structuredClone(FACTORY_DEFAULTS) as FactorySettings),
  fallback: FallbackZ.default({ enabled: false, vendors: [] }),
  quality: QualityZ.default({ enabled: false, verify: [], security: false, acceptance: false }),
  memory: MemoryZ.default({
    enabled: true,
    propose: true,
    autoApply: false,
    maxBytes: MEMORY_DEFAULT_MAX_BYTES,
  }),
  routing: RoutingZ.partial().default({}),
  // Absent in a resolved.json written before run limits and Easy mode existed: no limits, Easy's defaults.
  limits: RunLimitsZ.default({ ...RUN_LIMITS_NONE }),
  // Absent in a resolved.json written before guardrails existed: that run keeps no rules, as when it ran.
  guardrails: GuardrailsZ.default({ preset: 'off', rules: [] }),
  easy: EasyZ.default(() => ({ ...EASY_DEFAULTS })),
  // Absent in a resolved.json written before context health's reactions existed: their defaults.
  contextHealth: ContextHealthZ.default(() => ({ ...CONTEXT_HEALTH_DEFAULTS })),
})

/**
 * Every key populated. Accepts mode "full" for implement/fix only together with `auto: true`, and skips the
 * file-only rules (user-only keys, "full" in a file).
 */
export const ResolvedConfigZ = ResolvedShapeZ.superRefine((cfg, ctx) => {
  for (const pass of READONLY_PASSES) {
    if (cfg.passes[pass].mode !== 'readonly') {
      ctx.addIssue({ code: 'custom', path: ['passes', pass, 'mode'], message: `${pass} must be read-only` })
    }
  }
  for (const pass of MUTATING_PASSES) {
    if (cfg.passes[pass].mode === 'full' && !cfg.auto) {
      ctx.addIssue({
        code: 'custom',
        path: ['passes', pass, 'mode'],
        message: 'mode "full" is only valid together with auto: true',
      })
    }
  }
  for (const issue of timeoutOrderIssues(cfg.timeouts)) {
    ctx.addIssue({ code: 'custom', path: ['timeouts', issue.key], message: issue.message })
  }
})
export type ResolvedConfig = z.infer<typeof ResolvedConfigZ>

// ---- provenance --------------------------------------------------------------------

export const PROVENANCE_SOURCES = [
  'default',
  'user',
  'project',
  /** A recipe the run chose (`via: recipe:<id>`): above the project file, below the run's own overrides. */
  'recipe',
  'run',
  'auto',
  'inherit',
  'vendor',
  'cli',
] as const
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

export interface Provenance {
  source: ProvenanceSource
  file?: string
  line?: number
  /** e.g. `profile:balanced`, `passes`, `inherit:implement`, `recipe:bug-fix`. */
  via?: string
}

/** JSON pointer into ResolvedConfig → where the value came from (drives composer badges). */
export type ProvenanceMap = Record<string, Provenance>

// ---- semantic rules (after zod) -------------------------------------------------------------

export const SEMANTIC_ISSUE_CODES = [
  'readonly-pass',
  'full-in-file',
  'timeout-order',
  'flag-map-value',
  'flag-map-key',
  'managed-flag',
  'forbidden-flag',
  'user-only-key',
  'duplicate-preset',
  'readonly-passthrough',
  'project-only-key',
] as const
export type SemanticIssueCode = (typeof SEMANTIC_ISSUE_CODES)[number]

export interface SemanticIssue {
  /** RFC 6901 pointer into the file's JSON value. */
  pointer: string
  code: SemanticIssueCode
  message: string
  severity: 'error' | 'warning'
}

export interface SemanticOptions {
  scope: ConfigScope
  /** Timeouts from lower layers; builtin defaults fill the rest. */
  inheritedTimeouts?: Partial<Timeouts>
  /** Per-vendor `adapter.managedFlags`; when given, extraArgs and flagMap keys are checked against them. */
  managedFlags?: Readonly<Record<string, readonly string[]>>
  /**
   * per-vendor `adapter.forbiddenFlags`, the flags that widen what a pass may do (Gemini `--yolo`,
   * `-y`; Claude `--add-dir`; Codex `--profile`). When given, extraArgs may not carry one, nor `--dangerously-*`, nor a
   * forbidden letter inside a combined short flag (`-dy`), so the load check (`file:line:col`) refuses what the spawn
   * check, support() and the recovery guard already refuse.
   */
  forbiddenFlags?: Readonly<Record<string, readonly string[]>>
}

/** Spelling-insensitive identity of a long flag (`--skip-trust` ≡ `--skip_trust` ≡ `--skipTrust`), as the adapters read it. */
const longFlagKey = (arg: string): string =>
  (arg.split('=', 1)[0] ?? arg).replace(/^-+/, '').toLowerCase().replace(/[-_]/g, '')

/**
 * The reason an extraArgs entry is a forbidden flag for its vendor, or undefined. A long flag is
 * matched in any spelling, as the adapters' spawn checks match it, and `--dangerously-*` always; a single letter is
 * matched exactly, alone or as one letter of a combined short flag (`-dy` is `-d -y` to the CLI's parser).
 */
function forbiddenFlagProblem(arg: string, forbidden: readonly string[]): string | undefined {
  if (!arg.startsWith('-') || arg === '-') return undefined
  const name = arg.split('=', 1)[0] ?? arg
  if (arg.startsWith('--')) {
    const key = longFlagKey(arg)
    const long = forbidden.filter((f) => f.startsWith('--')).map(longFlagKey)
    if (long.includes(key) || /^dangerously/.test(key))
      return `${name} widens what a pass may do; extraArgs may not set it`
    return undefined
  }
  const short = forbidden.filter((f) => /^-[^-]$/.test(f))
  if (arg.length === 2) {
    return short.includes(arg) ? `${arg} widens what a pass may do; extraArgs may not set it` : undefined
  }
  const letter = [...arg.slice(1)].map((ch) => `-${ch}`).find((l) => short.includes(l))
  return letter !== undefined
    ? `${arg} combines ${letter} with other short flags; ${letter} widens what a pass may do`
    : undefined
}

/** RFC 6901: `~` → `~0`, `/` → `~1`. */
export function toJsonPointer(segments: readonly (string | number)[]): string {
  return segments.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

const isReadonlyPass = (p: PassName): boolean => (READONLY_PASSES as readonly PassName[]).includes(p)

function timeoutOrderIssues(t: Timeouts): { key: 'stallMs' | 'toolStallMs'; message: string }[] {
  const out: { key: 'stallMs' | 'toolStallMs'; message: string }[] = []
  for (const key of ['stallMs', 'toolStallMs'] as const) {
    if (t[key] >= t.hardKillMs) {
      out.push({ key, message: `${key} (${t[key]}) must be less than hardKillMs (${t.hardKillMs})` })
    }
  }
  return out
}

/** File-level rules zod cannot express. Returns pointer-addressed issues; line/col mapping happens in core. */
export function validateSemantics(cfg: DimFactoryConfig, opts: SemanticOptions): SemanticIssue[] {
  const issues: SemanticIssue[] = []
  const add = (path: (string | number)[], code: SemanticIssueCode, message: string): void => {
    issues.push({ pointer: toJsonPointer(path), code, message, severity: 'error' })
  }

  if (opts.scope === 'user') {
    if (cfg.memory?.autoApply !== undefined) {
      add(
        ['memory', 'autoApply'],
        'project-only-key',
        '"memory.autoApply" can only be set in a project\'s dimfactory.json (it is opted into per project), not in your user file',
      )
    }
    for (const key of PROJECT_ONLY_KEYS) {
      if (cfg[key] !== undefined) {
        add(
          [key],
          'project-only-key',
          `"${key}" can only be set in a project's dimfactory.json (it is opted into per project), not in your user file`,
        )
      }
    }
  }

  if (opts.scope === 'project') {
    for (const key of USER_ONLY_KEYS) {
      if (cfg[key] !== undefined) {
        add(
          [key],
          'user-only-key',
          `"${key}" can only be set in your user dimfactory.json, not in a project file`,
        )
      }
    }
  }

  const passBlocks: [(string | number)[], ProfileConfig][] = Object.entries(cfg.profiles ?? {}).map(
    ([name, profile]) => [['profiles', name], profile],
  )
  if (cfg.passes) passBlocks.push([['passes'], cfg.passes])
  for (const [prefix, block] of passBlocks) {
    for (const pass of PASS_NAMES) {
      const mode = block[pass]?.mode
      if (opts.scope === 'project' && isReadonlyPass(pass) && block[pass]?.extensions === 'passthrough') {
        add(
          [...prefix, pass, 'extensions'],
          'readonly-passthrough',
          `A project file cannot let the ${pass} pass use every extension (it may act outside read-only); choose it in your own settings or for one run`,
        )
      }
      if (mode === undefined) continue
      if (isReadonlyPass(pass) && mode !== 'readonly') {
        add([...prefix, pass, 'mode'], 'readonly-pass', `The ${pass} pass must be "readonly"`)
      } else if (mode === 'full') {
        add(
          [...prefix, pass, 'mode'],
          'full-in-file',
          '"full" is only set by Auto mode; use "auto": true instead',
        )
      }
    }
  }

  const t = cfg.timeouts
  if (t) {
    const inherited = opts.inheritedTimeouts ?? {}
    const effective: Timeouts = {
      stallMs: t.stallMs ?? inherited.stallMs ?? DEFAULT_TIMEOUTS.stallMs,
      hardKillMs: t.hardKillMs ?? inherited.hardKillMs ?? DEFAULT_TIMEOUTS.hardKillMs,
      toolStallMs: t.toolStallMs ?? inherited.toolStallMs ?? DEFAULT_TIMEOUTS.toolStallMs,
      askMs: t.askMs ?? inherited.askMs ?? DEFAULT_TIMEOUTS.askMs,
    }
    for (const issue of timeoutOrderIssues(effective)) {
      // Only report pairs this file touches, at the key it set.
      if (t[issue.key] !== undefined) add(['timeouts', issue.key], 'timeout-order', issue.message)
      else if (t.hardKillMs !== undefined) add(['timeouts', 'hardKillMs'], 'timeout-order', issue.message)
    }
  }

  for (const [vendor, vc] of Object.entries(cfg.vendors ?? {})) {
    const managed = opts.managedFlags?.[vendor]
    for (const [flag, value] of Object.entries(vc.flagMap ?? {})) {
      if (!FLAG_VALUE_PATTERN.test(value)) {
        add(
          ['vendors', vendor, 'flagMap', flag],
          'flag-map-value',
          `"${value}" is not a flag (expected e.g. --new-name)`,
        )
      }
      if (managed && !managed.includes(flag)) {
        add(
          ['vendors', vendor, 'flagMap', flag],
          'flag-map-key',
          `${flag} is not a flag Dim Factory manages for ${vendor}`,
        )
      }
    }
    const forbidden = opts.forbiddenFlags?.[vendor]
    if (managed || forbidden) {
      ;(vc.extraArgs ?? []).forEach((arg, i) => {
        const name = arg.split('=', 1)[0] ?? arg
        // `-pc` is `-p -c` to the CLI's parser, so a combined short flag names every letter in it.
        const letter =
          managed && /^-[^-]/.test(arg) && arg.length > 2
            ? [...arg.slice(1)].map((ch) => `-${ch}`).find((l) => managed.includes(l))
            : undefined
        const widens = forbidden !== undefined ? forbiddenFlagProblem(arg, forbidden) : undefined
        if (managed?.includes(name) === true) {
          add(
            ['vendors', vendor, 'extraArgs', i],
            'managed-flag',
            `${name} is managed by Dim Factory; use flagMap to rename it`,
          )
        } else if (letter !== undefined) {
          add(
            ['vendors', vendor, 'extraArgs', i],
            'managed-flag',
            `${arg} combines ${letter} with other short flags; Dim Factory manages ${letter}`,
          )
        } else if (widens !== undefined) {
          add(['vendors', vendor, 'extraArgs', i], 'forbidden-flag', widens)
        }
      })
    }
    // Effort is a managed setting: Codex `-c model_reasoning_effort=…` (any of the -c / --config forms) would override
    // the pass's Effort behind its back. Checked whether or not the adapter's flag lists are known.
    if (vendor === 'codex') {
      for (const { index, key } of codexEffortOverrides(vc.extraArgs ?? [])) {
        add(['vendors', vendor, 'extraArgs', index], 'managed-flag', codexEffortKeyMessage(key))
      }
    }
  }

  const seen = new Set<string>()
  ;(cfg.local?.presets ?? []).forEach((preset, i) => {
    if (seen.has(preset.id))
      add(['local', 'presets', i, 'id'], 'duplicate-preset', `Duplicate preset id "${preset.id}"`)
    seen.add(preset.id)
  })

  return issues
}
