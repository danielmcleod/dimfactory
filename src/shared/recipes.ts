// Recipes: saved pipelines plus briefs ("New web app", "Bug fix", ...). A recipe is data: built-in JSON files in
// src/core/recipes/, a user file `<home>/recipes/<id>.json` replaces the built-in of its id, and a project file
// `<folder>/.dimfactory/recipes/<id>.json` replaces both (shareable by committing it). Core validates them with
// RecipeZ and applies a chosen recipe as its own config layer (between the project file and the run's overrides), and
// its brief defaults to the Brief; the renderer and the CLI only show them and send the chosen id.
import { z } from 'zod'
import { APPROACH_GROUP, BriefInputZ, DEFAULT_CATEGORY, TEST_FIRST } from './brief.ts'
import type { BriefField, BriefInput } from './brief.ts'
import { VerifyCommandConfigZ } from './config-schema.ts'
import type { RunOverrides } from './config-schema.ts'
import { RESEARCH_LENSES_MAX, RESEARCH_LENS_ID } from './research.ts'
import { FIX_ROUNDS_MAX } from './run.ts'

// ---- ids and limits ---------------------------------------------------------------------------------------------

/** A recipe id: lower case letters, digits and dashes (it is also the file name, `<id>.json`). */
export const RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const RECIPE_LABEL_MAX = 40
export const RECIPE_DESCRIPTION_MAX = 300
export const RECIPE_TASK_HINT_MAX = 200
/** A recipe file larger than this is refused (recipes are small). */
export const RECIPE_FILE_MAX_BYTES = 64 * 1024

/** The built-in recipes, in the order the picker lists them. */
export const BUILTIN_RECIPE_IDS = [
  'new-web-app',
  'bug-fix',
  'add-feature',
  'refactor-safely',
  'write-docs',
  'data-report',
  'new-game',
  'game-jam',
  // Easy mode's recipes (one per kind of project, and a change to one): inspectable, usable in Full mode too.
  'easy-software',
  'easy-design',
  'easy-documents',
  'easy-data',
  'easy-research',
  'easy-operations',
  'easy-game',
  'easy-change',
  'easy-existing',
] as const
export type BuiltinRecipeId = (typeof BUILTIN_RECIPE_IDS)[number]

// ---- schema -----------------------------------------------------------------------------------------------------

/**
 * The switches a recipe turns on or off. Each maps onto one config key (recipeOverrides) except `testFirst`, which is
 * the brief's approach option `test-first` (recipeBrief). A switch left out is not the recipe's to decide.
 */
export const RecipeTogglesZ = z
  .strictObject({
    /** passes.plan.research */
    research: z.boolean(),
    /** passes.plan.clarify */
    clarify: z.boolean(),
    /** passes.security.enabled */
    security: z.boolean(),
    /** The brief's approach option `test-first` (the Tests step and its red check). */
    testFirst: z.boolean(),
    /** passes.fix.rounds: 1 = a single Fix; 2 or 3 = Fix until green. */
    fixRounds: z.number().int().min(1).max(FIX_ROUNDS_MAX),
    /** passes.implement.deploy */
    deploy: z.boolean(),
    /** passes.plan.explain (Explain it to me) */
    explain: z.boolean(),
    /** passes.review.acceptance (the acceptance review) */
    acceptance: z.boolean(),
  })
  .partial()
export type RecipeToggles = z.infer<typeof RecipeTogglesZ>
export type RecipeToggle = keyof RecipeToggles

/**
 * The passes a recipe may turn off or on by name. Plan and Implement always run; Security is the `security` switch.
 */
export const RECIPE_PASSES = ['review', 'critic', 'fix'] as const
export type RecipePass = (typeof RECIPE_PASSES)[number]

export const RecipeZ = z.strictObject({
  $schema: z.string().max(2048).optional(),
  id: z
    .string()
    .regex(RECIPE_ID_PATTERN, 'Not a recipe id (lower case letters, digits and dashes, up to 40)'),
  version: z.literal(1),
  label: z.string().trim().min(1).max(RECIPE_LABEL_MAX),
  description: z.string().trim().min(1).max(RECIPE_DESCRIPTION_MAX),
  toggles: RecipeTogglesZ,
  /** Per-pass on and off. */
  passes: z
    .strictObject({
      review: z.strictObject({ enabled: z.boolean() }).partial(),
      critic: z.strictObject({ enabled: z.boolean() }).partial(),
      fix: z.strictObject({ enabled: z.boolean() }).partial(),
    })
    .partial()
    .optional(),
  /**
   * Auto mode (Implement and Fix with full permissions, the gates skipped). A project recipe that turns it on needs
   * the user's grant for that version of the file, like a project dimfactory.json that does.
   */
  auto: z.boolean().optional(),
  /** The plan and Fix gates. */
  gates: z.strictObject({ afterPlan: z.boolean(), beforeFix: z.boolean() }).partial().optional(),
  /**
   * Verify on or off, and its commands. Commands are data: Verify asks the user to trust each one before it first runs,
   * as it does for a command from any other source.
   */
  verify: z
    .strictObject({ enabled: z.boolean(), commands: z.array(VerifyCommandConfigZ).max(20) })
    .partial()
    .optional(),
  /** Research's lenses (generic or the brief's pack's); empty or left out: the pack's defaults. */
  researchLenses: z
    .array(z.string().regex(RESEARCH_LENS_ID, 'Not a lens id'))
    .max(RESEARCH_LENSES_MAX)
    .optional(),
  /** The Brief's defaults: the category and the fields a user has not set themselves. */
  brief: BriefInputZ.optional(),
  /** The composer's task placeholder while the recipe is chosen. */
  taskHint: z.string().trim().min(1).max(RECIPE_TASK_HINT_MAX).optional(),
})
export type Recipe = z.infer<typeof RecipeZ>

/** Where a recipe came from: built in, or a user / project file (which replaces the lower layer's of its id). */
export const RECIPE_LAYERS = ['builtin', 'user', 'project'] as const
export type RecipeLayer = (typeof RECIPE_LAYERS)[number]

export interface RecipeView {
  recipe: Recipe
  layer: RecipeLayer
  /** The file it was read from. */
  path: string
  /** sha256 of the file's text (a project recipe's Auto grant is bound to it). */
  sha256: string
}

/** A recipe file that could not be used (the lower layer's recipe of its id, if any, stays). */
export interface RecipeIssue {
  file: string
  message: string
}

/** `recipes.list`. */
export interface RecipesList {
  recipes: RecipeView[]
  issues: RecipeIssue[]
  /** Where user recipe files live, and the folder's project recipe folder (null without a folder). */
  dirs: { user: string; project: string | null }
}

/** What a run records about the recipe it used (resolved.json `recipe`, RunSummary.recipe). */
export const RunRecipeZ = z.strictObject({
  id: z.string().regex(RECIPE_ID_PATTERN),
  label: z.string().min(1).max(RECIPE_LABEL_MAX),
  layer: z.enum(RECIPE_LAYERS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type RunRecipe = z.infer<typeof RunRecipeZ>

/**
 * resolved.json `recipe`: the run's recipe as it resolved (Re-run takes the frozen config and shows the same recipe).
 * `auto`: whether the recipe set Auto; `setsAuto`: it was a project recipe that turned Auto on (its grant is checked
 * again when the run is re-run).
 */
export const RecipeRecordZ = z.strictObject({
  ...RunRecipeZ.shape,
  path: z.string().min(1).max(4096),
  auto: z.boolean().optional(),
  setsAuto: z.boolean(),
})
export type RecipeRecord = z.infer<typeof RecipeRecordZ>

export function runRecipeOf(v: RecipeView): RunRecipe {
  return { id: v.recipe.id, label: v.recipe.label, layer: v.layer, sha256: v.sha256 }
}

// ---- mapping ----------------------------------------------------------------------------------------------------

/** The config key each switch sets (`testFirst` is the brief's, not a config key). */
export const TOGGLE_CONFIG_KEYS: Readonly<Record<Exclude<RecipeToggle, 'testFirst'>, string>> = {
  research: 'passes.plan.research',
  clarify: 'passes.plan.clarify',
  security: 'passes.security.enabled',
  fixRounds: 'passes.fix.rounds',
  deploy: 'passes.implement.deploy',
  explain: 'passes.plan.explain',
  acceptance: 'passes.review.acceptance',
}

/**
 * The recipe's config layer: its switches, passes, Auto, gates, Verify and lenses as config keys (a RunOverrides
 * shape, applied between the project file and the run's own overrides). Pure; keys the recipe leaves out are absent.
 */
export function recipeOverrides(r: Recipe): RunOverrides {
  const t = r.toggles
  const out: RunOverrides = {}
  const passes: NonNullable<RunOverrides['passes']> = {}
  const plan: NonNullable<NonNullable<RunOverrides['passes']>['plan']> = {}
  if (t.research !== undefined) plan.research = t.research
  if (t.clarify !== undefined) plan.clarify = t.clarify
  if (t.explain !== undefined) plan.explain = t.explain
  if (r.researchLenses !== undefined && r.researchLenses.length > 0)
    plan.researchLenses = [...r.researchLenses]
  if (Object.keys(plan).length > 0) passes.plan = plan
  if (t.deploy !== undefined) passes.implement = { deploy: t.deploy }
  const review: NonNullable<NonNullable<RunOverrides['passes']>['review']> = {}
  if (r.passes?.review?.enabled !== undefined) review.enabled = r.passes.review.enabled
  if (t.acceptance !== undefined) review.acceptance = t.acceptance
  if (Object.keys(review).length > 0) passes.review = review
  if (r.passes?.critic?.enabled !== undefined) passes.critic = { enabled: r.passes.critic.enabled }
  if (t.security !== undefined) passes.security = { enabled: t.security }
  const fix: NonNullable<NonNullable<RunOverrides['passes']>['fix']> = {}
  if (r.passes?.fix?.enabled !== undefined) fix.enabled = r.passes.fix.enabled
  if (t.fixRounds !== undefined) fix.rounds = t.fixRounds
  if (Object.keys(fix).length > 0) passes.fix = fix
  if (Object.keys(passes).length > 0) out.passes = passes
  if (r.auto !== undefined) out.auto = r.auto
  if (r.gates !== undefined && Object.keys(r.gates).length > 0) out.gates = { ...r.gates }
  if (r.verify !== undefined) {
    const verify: NonNullable<RunOverrides['verify']> = {}
    if (r.verify.enabled !== undefined) verify.enabled = r.verify.enabled
    if (r.verify.commands !== undefined) verify.commands = structuredClone(r.verify.commands)
    if (Object.keys(verify).length > 0) out.verify = verify
  }
  return out
}

/**
 * The recipe's brief defaults: its brief, with the approach group's `test-first` added (testFirst on) or taken out
 * (off). undefined when the recipe says nothing about the brief.
 */
export function recipeBrief(r: Recipe): BriefInput | undefined {
  const tf = r.toggles.testFirst
  if (r.brief === undefined && tf === undefined) return undefined
  const category = r.brief?.category ?? DEFAULT_CATEGORY
  const fields: Record<string, BriefField> = structuredClone(r.brief?.fields ?? {})
  if (tf !== undefined) {
    const cur = fields[APPROACH_GROUP]
    const choices = (cur?.choices ?? []).filter((c) => c !== TEST_FIRST)
    if (tf) choices.unshift(TEST_FIRST)
    if (choices.length > 0 || cur?.other !== undefined) fields[APPROACH_GROUP] = { ...cur, choices }
    else delete fields[APPROACH_GROUP]
  }
  return { category, fields }
}

/**
 * The brief a run takes with a recipe: the request's own brief when it has one (the composer applied the recipe's
 * defaults to it already), else the recipe's defaults (a CLI run with no brief flags).
 */
export function briefWithRecipe(
  brief: BriefInput | undefined,
  r: Recipe | undefined,
): BriefInput | undefined {
  if (brief !== undefined || r === undefined) return brief
  return recipeBrief(r)
}

// ---- words ------------------------------------------------------------------------------------------------------

export const RECIPE_LAYER_LABEL: Readonly<Record<RecipeLayer, string>> = {
  builtin: 'Built in',
  user: 'User',
  project: 'Project',
}

const TOGGLE_LABEL: Readonly<Record<RecipeToggle, string>> = {
  research: 'Research',
  clarify: 'Clarify',
  security: 'Security review',
  testFirst: 'Test-first',
  fixRounds: 'Fix until green',
  deploy: 'Deploy step',
  explain: 'Explain it to me',
  acceptance: 'Acceptance review',
}

const TOGGLE_ORDER: readonly RecipeToggle[] = [
  'clarify',
  'research',
  'testFirst',
  'security',
  'acceptance',
  'fixRounds',
  'deploy',
  'explain',
]

/** What the recipe turns on, as short UI phrases ("Research", "Fix until green (3 rounds)", "Auto mode"). */
export function recipeTurnsOn(r: Recipe): string[] {
  const out: string[] = []
  for (const k of TOGGLE_ORDER) {
    const v = r.toggles[k]
    if (k === 'fixRounds') {
      if (typeof v === 'number' && v >= 2) out.push(`${TOGGLE_LABEL[k]} (${v} rounds)`)
    } else if (v === true) out.push(TOGGLE_LABEL[k])
  }
  if (r.verify?.enabled === true) out.push('Verify')
  if (r.auto === true) out.push('Auto mode')
  return out
}

/** What the recipe turns off ("Security review", "Critic"). */
export function recipeTurnsOff(r: Recipe): string[] {
  const out: string[] = []
  for (const k of TOGGLE_ORDER) if (k !== 'fixRounds' && r.toggles[k] === false) out.push(TOGGLE_LABEL[k])
  const passLabel: Readonly<Record<RecipePass, string>> = { review: 'Review', critic: 'Critic', fix: 'Fix' }
  for (const p of RECIPE_PASSES) if (r.passes?.[p]?.enabled === false) out.push(passLabel[p])
  if (r.verify?.enabled === false) out.push('Verify')
  if (r.auto === false) out.push('Auto mode')
  return out
}

/** One line: "Turns on Research, Clarify. Turns off Security review." (or "Changes no switches."). */
export function recipeSummary(r: Recipe): string {
  const on = recipeTurnsOn(r)
  const off = recipeTurnsOff(r)
  const parts: string[] = []
  if (on.length > 0) parts.push(`Turns on ${on.join(', ')}.`)
  if (off.length > 0) parts.push(`Turns off ${off.join(', ')}.`)
  return parts.length > 0 ? parts.join(' ') : 'Changes no switches.'
}
