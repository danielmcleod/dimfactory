// The config resolver: builtin (layer 0) → user → project → recipe → run, with a
// provenance map (JSON pointer into ResolvedConfig → {source, file?, line?, via?}).
//   1. Deep merge of every section except `profiles`/`passes` (objects merge, arrays replace, null is a value).
//   2. Per pass, per layer: `profiles[sel][p]`, then `passes[p]`.
//   3. `fix.inherit: 'implement'` copies vendor/model/effort/mode/extensions unless Fix set them explicitly (in any
//      layer); the model only while Fix runs on Implement's vendor, and the effort only with the model.
//   4. A null model takes `vendors[v].defaultModel` (provenance `vendor`); still null → provenance `cli`. A null
//      effort takes `vendors[v].defaultEffort` the same way.
//   5. `auto` ⇒ Implement and Fix `full`, both gates off (provenance `auto`). It never changes a pass's Extensions
//      level (Auto widens what runs without asking, never which extensions a pass loads).
//   6. Templates resolve to {name, path, layer, sha256} (project → user → builtin).
// A disabled pass needs no vendor or template of its own (placeholder vendor; builtin template + a warning).
// With no user/project layer this reproduces `resolveBuiltinConfig` (the original producer) exactly.
import type {
  DimFactoryConfig,
  FixConfig,
  ImplementConfig,
  PassConfig,
  PlanConfig,
  ProfileConfig,
  Provenance,
  ProvenanceMap,
  ProvenanceSource,
  ResolvedConfig,
  ResolvedPass,
  ReviewConfig,
  RunOverrides,
  RunToolsInput,
  SecurityConfig,
  Timeouts,
} from '../../shared/config-schema.ts'
import {
  DimFactoryConfigZ,
  ResolvedConfigZ,
  PROJECT_ONLY_KEYS,
  RunOverridesZ,
  USER_ONLY_KEYS,
  toJsonPointer,
} from '../../shared/config-schema.ts'
import type { ConfigIssue, ConfigLayerInfo } from '../../shared/ipc.ts'
import { defaultExtensionLevel, resolvedRunTools } from '../../shared/extensions.ts'
import { PASS_NAMES, ROUTED_STEPS } from '../../shared/run.ts'
import type { Mode, PassName, RoutedStep } from '../../shared/run.ts'
import type { HomePaths } from '../home.ts'
import {
  PromptResolveError,
  builtinTemplatePath,
  readTemplateFile,
  resolvePromptTemplate,
  toResolvedTemplate,
} from '../prompts/resolve.ts'
import { suggestName } from '../prompts/template.ts'
import {
  BUILTIN_DEFAULTS,
  BuiltinConfigError,
  CLARIFY_DEFAULT_QUESTIONS,
  GIT_DEFAULTS,
  INHERITED_KEYS,
  PASS_BASE,
  QUALITY_DEFAULTS,
} from './defaults.ts'
import type { BuiltinConfigErrorCode, BuiltinConfigIssue, BuiltinLayer } from './defaults.ts'
import { layerOrigin, loadConfigFile, toConfigLayer } from './load.ts'
import type { ConfigLayer, LoadResult } from './load.ts'
import { mergeGuardrails } from '../../shared/guardrails.ts'
import { deepMerge, isPlainObject, omitKeys } from './merge.ts'
import { locateProjectConfig, userConfigPath } from './paths.ts'
import { ProvenanceRecorder, parseProvenanceMap, provenanceAt, provenanceFrom } from './provenance.ts'
import type { LayerOrigin } from './provenance.ts'

// ---- errors ---------------------------------------------------------------------------------------------------------

/** A resolve problem, located (when a file layer set the value) at `file:line`. */
export interface ResolveIssue extends BuiltinConfigIssue {
  source?: ProvenanceSource
  file?: string
  line?: number
}

/**
 * Thrown by {@link resolve} (category `config_invalid`). Extends BuiltinConfigError so existing catch sites of the
 * original producer keep working; `issues` carry file/line where a file layer is responsible.
 */
export class ConfigResolveError extends BuiltinConfigError {
  override readonly issues: ResolveIssue[] = []
  constructor(code: BuiltinConfigErrorCode, message: string, issues: ResolveIssue[] = []) {
    super(code, message, issues)
    this.name = 'ConfigResolveError'
    this.issues = issues
  }
}

const zodIssues = (issues: readonly { path: readonly PropertyKey[]; message: string }[]): ResolveIssue[] =>
  issues.map((i) => ({
    pointer: toJsonPointer(i.path.map((s) => (typeof s === 'symbol' ? String(s) : s))),
    message: i.message,
  }))

function located(issue: ResolveIssue, p: Provenance | undefined): ResolveIssue {
  if (p === undefined) return issue
  return {
    ...issue,
    source: p.source,
    ...(p.file !== undefined ? { file: p.file } : {}),
    ...(p.line !== undefined ? { line: p.line } : {}),
  }
}

// ---- input ----------------------------------------------------------------------------------------------------------

export interface ResolveInput {
  /** Layer 0 (default BUILTIN_DEFAULTS). */
  builtin?: BuiltinLayer
  /** The user file (validated; see load.ts `toConfigLayer`). */
  user?: ConfigLayer
  /** The project file (validated). User-only keys in it are ignored here (load reports them as errors). */
  project?: ConfigLayer
  /**
   * The recipe layer: the chosen recipe's switches as config keys (shared/recipes.ts recipeOverrides), validated with
   * RunOverridesZ. Above the project file, below the run layer; provenance `recipe` with `via: recipe:<id>`.
   */
  recipe?: RecipeLayerInput
  /** The run layer (composer overrides, CLI `--set`); validated with RunOverridesZ. */
  run?: unknown
  /** CLI `--profile`: wins over every layer's `profile` (provenance `run`). */
  profile?: string
  /** The folder whose `.dimfactory/prompts/` is the project template layer (omit: no project templates). */
  folder?: string
  /** DIM_FACTORY_HOME for the user template layer (default: resolveHome()). */
  home?: string
  /** Test seam for the builtin prompt directory. */
  builtinDir?: string
}

export interface ResolveResult {
  config: ResolvedConfig
  provenance: ProvenanceMap
  /** Every profile name some layer defines (builtin first), for the profile picker and `run.profile`. */
  profiles: string[]
  /** Problems that do not stop a run (a disabled pass's missing template: the builtin one stands in). */
  warnings: ResolveIssue[]
}

interface Layer {
  origin: LayerOrigin
  cfg: DimFactoryConfig
  /** Every value this layer sets is tagged with it (the recipe layer: `recipe:<id>`). */
  via?: string
}

/** A recipe as a config layer: its id, the file it was read from, and its keys. */
export interface RecipeLayerInput {
  id: string
  file?: string
  value: RunOverrides
}

function recipeLayer(r: RecipeLayerInput | undefined): Layer | undefined {
  if (r === undefined) return undefined
  const parsed = RunOverridesZ.safeParse(r.value)
  if (!parsed.success) {
    const issues = zodIssues(parsed.error.issues).map((i) => ({
      ...i,
      source: 'recipe' as const,
      ...(r.file !== undefined ? { file: r.file } : {}),
    }))
    throw new ConfigResolveError(
      'invalid',
      `The recipe "${r.id}" is invalid: ${issues.map((i) => `${i.pointer || '/'} ${i.message}`).join('; ')}`,
      issues,
    )
  }
  return {
    origin: { source: 'recipe', ...(r.file !== undefined ? { file: r.file } : {}) },
    cfg: parsed.data,
    via: `recipe:${r.id}`,
  }
}

/** Keys that never reach ResolvedConfig sections (`profile` is resolved separately). */
const NON_SECTION_KEYS = ['$schema', 'version', 'profile', 'profiles', 'passes'] as const

function fileLayer(scope: 'user' | 'project', layer: ConfigLayer | undefined): Layer | undefined {
  if (layer === undefined) return undefined
  const parsed = DimFactoryConfigZ.safeParse(layer.value)
  if (!parsed.success) {
    const issues = zodIssues(parsed.error.issues).map((i) => ({
      ...i,
      source: scope,
      ...(layer.file !== undefined ? { file: layer.file } : {}),
      ...(layer.lines?.[i.pointer] !== undefined ? { line: layer.lines[i.pointer] } : {}),
    }))
    throw new ConfigResolveError(
      'invalid',
      `The ${scope} config is invalid: ${issues.map((i) => `${i.pointer || '/'} ${i.message}`).join('; ')}`,
      issues,
    )
  }
  // A key the other scope owns is reported by the file's semantic check and never applied here.
  const cfg =
    scope === 'project' ? omitKeys(parsed.data, USER_ONLY_KEYS) : omitKeys(parsed.data, PROJECT_ONLY_KEYS)
  return { origin: layerOrigin(scope, layer), cfg }
}

function runLayer(run: unknown): Layer | undefined {
  if (run === undefined) return undefined
  const parsed = RunOverridesZ.safeParse(run)
  if (!parsed.success) {
    const issues = zodIssues(parsed.error.issues).map((i) => ({ ...i, source: 'run' as const }))
    throw new ConfigResolveError(
      'invalid-overrides',
      `Invalid run overrides: ${issues.map((i) => `${i.pointer || '/'} ${i.message}`).join('; ')}`,
      issues,
    )
  }
  const cfg: RunOverrides = parsed.data
  return { origin: { source: 'run' }, cfg }
}

/** Every profile name the layers define: builtin names first, then new names in layer order. */
export function knownProfiles(
  ...layers: readonly (Pick<DimFactoryConfig, 'profiles'> | BuiltinLayer | undefined)[]
): string[] {
  const out: string[] = []
  for (const l of layers)
    for (const name of Object.keys(l?.profiles ?? {})) if (!out.includes(name)) out.push(name)
  return out
}

// ---- resolve --------------------------------------------------------------------------------------------------------

type RawPass = PassConfig & FixConfig & SecurityConfig & PlanConfig & ImplementConfig & ReviewConfig

/** Resolve the layers into a ResolvedConfig + provenance. Throws {@link ConfigResolveError}. */
export function resolve(input: ResolveInput = {}): ResolveResult {
  const builtin = input.builtin ?? BUILTIN_DEFAULTS
  const run = runLayer(input.run)
  const user = fileLayer('user', input.user)
  const project = fileLayer('project', input.project)
  const recipe = recipeLayer(input.recipe)
  const builtinCfg: DimFactoryConfig = builtin
  const layers: Layer[] = [{ origin: { source: 'default' }, cfg: builtinCfg }]
  for (const l of [user, project, recipe, run]) if (l !== undefined) layers.push(l)
  const rec = new ProvenanceRecorder()

  // ---- profile ----
  let sel: string = builtin.profile
  let selProv: Provenance = { source: 'default' }
  for (const l of layers) {
    if (l.cfg.profile === undefined) continue
    sel = l.cfg.profile
    selProv = provenanceFrom(l.origin, '/profile', l.via)
  }
  if (input.profile !== undefined) {
    sel = input.profile
    selProv = { source: 'run', via: '--profile' }
  }
  const profiles = knownProfiles(...layers.map((l) => l.cfg))
  if (!profiles.includes(sel)) {
    const hint = suggestName(sel, profiles)
    throw new ConfigResolveError(
      'unknown-profile',
      `Unknown profile "${sel}"${hint !== undefined ? ` (did you mean "${hint}"?)` : ''}. ` +
        `Profiles: ${profiles.join(', ')}`,
      [located({ pointer: '/profile', message: `Unknown profile "${sel}"` }, selProv)],
    )
  }
  rec.set('/profile', selProv)

  // ---- step 1: sections ----
  const builtinSections: ResolvedSections = omitKeys(builtin, ['profile', 'profiles', 'passes'])
  const upperSections = layers.slice(1).map((l) => omitKeys(l.cfg, NON_SECTION_KEYS))
  const sections = deepMerge(builtinSections, ...upperSections)
  // Guardrails only tighten: a plain merge would let a project's list replace the user's. The run layer cannot name them.
  sections.guardrails = mergeGuardrails(user?.cfg.guardrails, project?.cfg.guardrails, recipe?.cfg.guardrails)
  const sectionsByLayer: object[] = [builtinSections, ...upperSections]
  layers.forEach((l, i) => {
    for (const [key, value] of Object.entries(sectionsByLayer[i] ?? {})) {
      rec.setLeaves(value, [key], (segs) => provenanceFrom(l.origin, toJsonPointer(segs), l.via))
    }
  })

  // ---- step 2: passes (per pass, per layer: profiles[sel][p] then passes[p]) ----
  const raw = {} as Record<PassName, RawPass>
  const explicitFix = new Set<string>()
  for (const p of PASS_NAMES) {
    raw[p] = structuredClone(PASS_BASE[p])
    for (const key of Object.keys(raw[p])) rec.set(`/passes/${p}/${key}`, { source: 'default' })
    for (const l of layers) {
      const blocks: [ProfileConfig | undefined, string[], string][] = [
        [l.cfg.profiles?.[sel], ['profiles', sel], `profile:${sel}`],
        [l.cfg.passes, ['passes'], 'passes'],
      ]
      for (const [block, prefix, via] of blocks) {
        const values = block?.[p]
        if (values === undefined) continue
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) continue
          ;(raw[p] as Record<string, unknown>)[key] = structuredClone(value)
          rec.set(
            `/passes/${p}/${key}`,
            provenanceFrom(l.origin, toJsonPointer([...prefix, p, key]), l.via ?? via),
          )
          if (p === 'fix' && (INHERITED_KEYS as readonly string[]).includes(key)) explicitFix.add(key)
        }
      }
    }
  }

  // ---- step 2b: model routing (per layer: profiles[sel].routing, then passes.routing; per step and key) ----
  const routing: Partial<Record<RoutedStep, { model?: string | null; effort?: string | null }>> = {}
  for (const l of layers) {
    const blocks: [ProfileConfig | undefined, string[], string][] = [
      [l.cfg.profiles?.[sel], ['profiles', sel], `profile:${sel}`],
      [l.cfg.passes, ['passes'], 'passes'],
    ]
    for (const [block, prefix, via] of blocks) {
      for (const step of ROUTED_STEPS) {
        const route = block?.routing?.[step]
        if (route === undefined) continue
        for (const key of ['model', 'effort'] as const) {
          const value = route[key]
          if (value === undefined) continue
          routing[step] = { ...routing[step], [key]: value }
          rec.set(
            `/routing/${step}/${key}`,
            provenanceFrom(l.origin, toJsonPointer([...prefix, 'routing', step, key]), l.via ?? via),
          )
        }
      }
    }
  }

  // ---- step 3: fix.inherit ----
  if (raw.fix.inherit === 'implement') {
    const inherited: Provenance = { source: 'inherit', via: 'inherit:implement' }
    if (!explicitFix.has('vendor')) {
      raw.fix.vendor = raw.implement.vendor
      rec.set('/passes/fix/vendor', inherited)
    }
    // Implement's model is a model of Implement's vendor: when Fix explicitly runs on another vendor, its model stays
    // its own (null → step 4: that vendor's defaultModel, else the CLI default) instead of a foreign model id.
    if (!explicitFix.has('model') && raw.fix.vendor === raw.implement.vendor) {
      raw.fix.model = raw.implement.model ?? null
      rec.set('/passes/fix/model', inherited)
      // The effort goes with the model: Fix runs Implement's model at Implement's effort, unless it sets its own.
      if (!explicitFix.has('effort')) {
        raw.fix.effort = raw.implement.effort ?? null
        rec.set('/passes/fix/effort', inherited)
      }
    }
    if (!explicitFix.has('mode')) {
      raw.fix.mode = raw.implement.mode ?? 'autoedit'
      rec.set('/passes/fix/mode', inherited)
    }
    // Fix carries on Implement's work with Implement's extensions, unless it sets its own level.
    if (!explicitFix.has('extensions')) {
      raw.fix.extensions = raw.implement.extensions ?? defaultExtensionLevel('implement')
      rec.set('/passes/fix/extensions', inherited)
    }
  }

  // ---- step 4: model and effort fill ----
  const fills = [
    ['model', 'defaultModel'],
    ['effort', 'defaultEffort'],
  ] as const
  for (const p of PASS_NAMES)
    for (const [key, vendorKey] of fills) {
      if ((raw[p][key] ?? null) !== null) continue
      const pointer = `/passes/${p}/${key}`
      const prev = rec.get(pointer)
      const v = raw[p].vendor
      const dm = v !== undefined ? sections.vendors[v]?.[vendorKey] : undefined
      if (v !== undefined && dm !== undefined && dm !== null) {
        raw[p][key] = dm
        const from = rec.get(toJsonPointer(['vendors', v, vendorKey]))
        rec.set(pointer, {
          source: 'vendor',
          ...(from?.file !== undefined ? { file: from.file } : {}),
          ...(from?.line !== undefined ? { line: from.line } : {}),
          via: toJsonPointer(['vendors', v, vendorKey]),
        })
      } else {
        raw[p][key] = null
        // Keep where the null came from (badge "CLI default"; the link still opens that line).
        rec.set(pointer, {
          source: 'cli',
          ...(prev?.file !== undefined ? { file: prev.file } : {}),
          ...(prev?.line !== undefined ? { line: prev.line } : {}),
          ...(prev?.via !== undefined ? { via: prev.via } : {}),
        })
      }
    }

  // ---- step 5: auto ----
  if (sections.auto) {
    const from = rec.get('/auto')
    const auto: Provenance = {
      source: 'auto',
      ...(from?.file !== undefined ? { file: from.file } : {}),
      ...(from?.line !== undefined ? { line: from.line } : {}),
    }
    raw.implement.mode = 'full'
    raw.fix.mode = 'full'
    sections.gates = { afterPlan: false, beforeFix: false }
    for (const ptr of [
      '/passes/implement/mode',
      '/passes/fix/mode',
      '/gates/afterPlan',
      '/gates/beforeFix',
    ]) {
      rec.set(ptr, auto)
    }
  }

  // A pass that is off never runs: it needs no vendor and no template of its own (a minimal custom profile can leave
  // them out). It still resolves to a full ResolvedPass, so its vendor is a placeholder: Implement's, else the
  // first one set, else Self-heal's.
  const enabled = (p: PassName): boolean => raw[p].enabled ?? true
  const noVendor = PASS_NAMES.filter((p) => raw[p].vendor === undefined && enabled(p))
  const placeholder =
    raw.implement.vendor ??
    PASS_NAMES.map((p) => raw[p].vendor).find((v) => v !== undefined) ??
    sections.selfHeal.vendor
  for (const p of PASS_NAMES) {
    if (raw[p].vendor !== undefined || enabled(p)) continue
    raw[p].vendor = placeholder
    rec.set(`/passes/${p}/vendor`, { source: 'default', via: 'disabled' })
  }
  if (noVendor.length > 0) {
    // Fix lost its vendor through `inherit: null`; any other pass, through the selected profile.
    const issues = noVendor.map((p) =>
      located(
        {
          pointer: `/passes/${p}/vendor`,
          message: `${p} has no vendor${p === 'fix' ? ' (set passes.fix.vendor, or inherit: "implement")' : ''}`,
        },
        p === 'fix' ? rec.get('/passes/fix/inherit') : selProv,
      ),
    )
    throw new ConfigResolveError('invalid', issues.map((i) => i.message).join('; '), issues)
  }

  // ---- vendors: every configured vendor gets the full shape ----
  for (const [id, v] of Object.entries(sections.vendors)) {
    sections.vendors[id] = {
      path: v.path ?? null,
      defaultModel: v.defaultModel ?? null,
      defaultEffort: v.defaultEffort ?? null,
      extraArgs: v.extraArgs ?? [],
      env: v.env ?? {},
      flagMap: v.flagMap ?? {},
    }
    for (const key of ['path', 'defaultModel', 'defaultEffort', 'extraArgs', 'env', 'flagMap']) {
      rec.setIfAbsent(toJsonPointer(['vendors', id, key]), { source: 'default' })
    }
  }

  // ---- extensions: every vendor allow list gets the full shape ----
  // (A hand-made layer 0 without the section, as some callers pass, has no allow lists.)
  sections.extensions ??= { allowed: {} }
  for (const [id, a] of Object.entries(sections.extensions.allowed)) {
    sections.extensions.allowed[id] = {
      mcp: a.mcp ?? [],
      skills: a.skills ?? [],
      mcpWithoutAsking: a.mcpWithoutAsking ?? [],
    }
    for (const key of ['mcp', 'skills', 'mcpWithoutAsking']) {
      rec.setIfAbsent(toJsonPointer(['extensions', 'allowed', id, key]), { source: 'default' })
    }
  }

  // ---- step 6: templates ----
  const passes = {} as Record<PassName, ResolvedPass>
  const warnings: ResolveIssue[] = []
  for (const p of PASS_NAMES) {
    const r = raw[p]
    const pointer = `/passes/${p}/promptTemplate`
    const where = (): Provenance | undefined => rec.get(pointer)
    let template: ResolvedPass['promptTemplate'] | undefined
    let problem: string | undefined
    try {
      const found = resolvePromptTemplate(r.promptTemplate ?? null, {
        pass: p,
        ...(input.folder !== undefined ? { folder: input.folder } : {}),
        ...(input.home !== undefined ? { home: input.home } : {}),
        ...(input.builtinDir !== undefined ? { builtinDir: input.builtinDir } : {}),
      })
      if (found.fellBack) {
        problem =
          `Prompt template "${found.requested}" was not found in .dimfactory/prompts, ` +
          `DIM_FACTORY_HOME/prompts or the builtin templates`
      }
      template = toResolvedTemplate(found)
    } catch (err) {
      if (!(err instanceof PromptResolveError)) throw err
      problem = err.message
    }
    if (problem !== undefined) {
      const issue = located({ pointer, message: problem }, where())
      // A pass that is off never renders its prompt: the problem is a warning, and the builtin template stands in.
      if (enabled(p)) throw new ConfigResolveError('template', problem, [issue])
      warnings.push(issue)
      template = builtinTemplate(p, input.builtinDir)
    }
    if (template === undefined) throw new ConfigResolveError('template', `No ${p} template`, [])
    passes[p] = {
      vendor: r.vendor ?? '',
      model: r.model ?? null,
      effort: r.effort ?? null,
      mode: r.mode ?? ('autoedit' satisfies Mode),
      enabled: r.enabled ?? true,
      promptTemplate: template,
      extensions: r.extensions ?? defaultExtensionLevel(p),
    }
  }

  // ---- project-only git: its defaults where no project file sets it ----
  for (const key of Object.keys(GIT_DEFAULTS)) rec.setIfAbsent(`/git/${key}`, { source: 'default' })
  for (const key of Object.keys(QUALITY_DEFAULTS)) rec.setIfAbsent(`/quality/${key}`, { source: 'default' })
  rec.setIfAbsent('/memory/autoApply', { source: 'default' })
  const candidate = {
    ...sections,
    git: { ...GIT_DEFAULTS, ...sections.git },
    quality: { ...QUALITY_DEFAULTS, ...sections.quality },
    // memory.autoApply is a project's opt-in (layer 0 leaves it out): off unless a project file sets it.
    memory: { autoApply: false, ...sections.memory },
    routing,
    // A run's own Tools come only from the run layer (and a recipe's): every vendor entry with both lists.
    tools: resolvedRunTools((sections as { tools?: RunToolsInput }).tools),
    profile: sel,
    passes: {
      ...passes,
      plan: {
        ...passes.plan,
        clarify: raw.plan.clarify ?? false,
        clarifyQuestions: raw.plan.clarifyQuestions ?? CLARIFY_DEFAULT_QUESTIONS,
        clarifyInAuto: raw.plan.clarifyInAuto ?? false,
        clarifyPlain: raw.plan.clarifyPlain ?? false,
        research: raw.plan.research ?? false,
        researchLenses: [...(raw.plan.researchLenses ?? [])],
        explain: raw.plan.explain ?? false,
        explainPlain: raw.plan.explainPlain ?? false,
      },
      review: { ...passes.review, acceptance: raw.review.acceptance ?? false },
      implement: {
        ...passes.implement,
        deploy: raw.implement.deploy ?? false,
        deployTarget: raw.implement.deployTarget ?? null,
        // Only when a layer sets it (absent: on, the default), so a config that never names it resolves as before.
        ...(raw.implement.continuePlan !== undefined ? { continuePlan: raw.implement.continuePlan } : {}),
      },
      security: {
        ...passes.security,
        recheck: raw.security.recheck ?? true,
        review: raw.security.review ?? 'always',
      },
      fix: {
        ...passes.fix,
        inherit: raw.fix.inherit ?? null,
        reuseSession: raw.fix.reuseSession ?? true,
        rounds: raw.fix.rounds ?? 1,
        recheck: raw.fix.recheck ?? true,
        maxCostUsd: raw.fix.maxCostUsd ?? null,
        maxMinutes: raw.fix.maxMinutes ?? null,
        // Only when a layer sets it (absent: `evidence`, the default).
        ...(raw.fix.trigger !== undefined ? { trigger: raw.fix.trigger } : {}),
      },
    },
  }
  const provenance = rec.toMap()
  const checked = ResolvedConfigZ.safeParse(candidate)
  if (!checked.success) {
    const issues = zodIssues(checked.error.issues).map((i) => located(i, provenanceAt(provenance, i.pointer)))
    throw new ConfigResolveError(
      'invalid',
      `The resolved config is invalid: ${issues
        .map((i) => `${i.pointer} ${i.message}${i.file !== undefined ? ` (${i.file}:${i.line ?? 1})` : ''}`)
        .join('; ')}`,
      issues,
    )
  }
  return { config: checked.data, provenance, profiles, warnings }
}

/** The builtin template of a pass (stands in for a disabled pass's missing one). Throws ConfigResolveError. */
function builtinTemplate(p: PassName, builtinDir?: string): ResolvedPass['promptTemplate'] {
  const path = builtinTemplatePath(p, builtinDir)
  let file: { text: string; sha256: string } | undefined
  try {
    file = readTemplateFile(path)
  } catch (err) {
    if (!(err instanceof PromptResolveError)) throw err
  }
  if (file === undefined) {
    const message = `The builtin ${p} template is missing (${path})`
    throw new ConfigResolveError('template', message, [{ pointer: `/passes/${p}/promptTemplate`, message }])
  }
  return { name: p, path, layer: 'builtin', sha256: file.sha256 }
}

/** The merged sections before vendor normalization (vendors may still be partial). */
type ResolvedSections = Omit<
  ResolvedConfig,
  'passes' | 'profile' | 'vendors' | 'extensions' | 'git' | 'quality' | 'routing' | 'memory' | 'tools'
> & {
  /** `autoApply` only from a project file (resolve fills in false). */
  memory: Omit<ResolvedConfig['memory'], 'autoApply'> & { autoApply?: boolean }
  /** Project-only: absent from layer 0 (GIT_DEFAULTS and QUALITY_DEFAULTS fill them in). */
  git?: Partial<ResolvedConfig['git']>
  quality?: Partial<ResolvedConfig['quality']>
  vendors: Record<string, Partial<ResolvedConfig['vendors'][string]>>
  extensions: { allowed: Record<string, Partial<ResolvedConfig['extensions']['allowed'][string]>> }
}

// ---- Re-run --------------------------------------------------------------------------------------------------------

export interface ResolvedFromFileOptions {
  /** Applies `resolved.json.patches[]` to the config before validation (patch.ts); omitted → patches ignored. */
  applyPatches?: (config: unknown, patches: readonly unknown[]) => unknown
}

/**
 * Re-run with the same config: `resolved.json.config` through ResolvedConfigZ — `mode: "full"` only with
 * `auto: true`, and none of the file-only rules (user-only keys, "full" in a file). No re-resolution; trust and
 * templates are re-checked by the authoritative preflight. Throws {@link ConfigResolveError} (`invalid`).
 */
export function resolvedFromFile(resolvedJson: unknown, o: ResolvedFromFileOptions = {}): ResolveResult {
  if (!isPlainObject(resolvedJson)) {
    throw new ConfigResolveError('invalid', 'resolved.json is not a JSON object', [
      { pointer: '', message: 'not an object' },
    ])
  }
  let cfg = resolvedJson['config']
  const patches = Array.isArray(resolvedJson['patches']) ? (resolvedJson['patches'] as unknown[]) : []
  if (o.applyPatches !== undefined && patches.length > 0) cfg = o.applyPatches(cfg, patches)
  const parsed = ResolvedConfigZ.safeParse(cfg)
  if (!parsed.success) {
    const issues = zodIssues(parsed.error.issues).map((i) => ({ ...i, pointer: `/config${i.pointer}` }))
    throw new ConfigResolveError(
      'invalid',
      `resolved.json has an invalid config: ${issues.map((i) => `${i.pointer} ${i.message}`).join('; ')}`,
      issues,
    )
  }
  return {
    config: parsed.data,
    provenance: parseProvenanceMap(resolvedJson['provenance']),
    profiles: [parsed.data.profile],
    warnings: [],
  }
}

// ---- load + resolve ---------------------------------------------------------------------------------------------------

export interface LoadAndResolveOptions {
  paths: HomePaths
  /** The run folder; omitted → no project layer. */
  folder?: string
  scopeRoot?: string | null
  /** The scope's folderKey (project last-good storage); omitted → not stored. */
  folderKey?: string | null
  /** The chosen recipe as a config layer (between the project file and the run layer). */
  recipe?: RecipeLayerInput
  run?: unknown
  profile?: string
  managedFlags?: Readonly<Record<string, readonly string[]>>
  /** per-vendor forbidden flags, refused in extraArgs at load. */
  forbiddenFlags?: Readonly<Record<string, readonly string[]>>
  builtinDir?: string
  /** Layer 0 (default BUILTIN_DEFAULTS; app-core passes the first-launch default profile). */
  builtin?: BuiltinLayer
  /** Store a valid file's text as last-good (default true; read-only cores pass false). */
  storeLastGood?: boolean
}

export interface LoadedConfig {
  user: LoadResult
  project: LoadResult | null
  /** The folder whose `.dimfactory/` holds the project file (or would). */
  projectRoot: string | null
  /** Load issues of both files (an invalid file is left out of the resolve). */
  issues: ConfigIssue[]
  layers: { user: ConfigLayerInfo; project: ConfigLayerInfo | null }
  result?: ResolveResult
  error?: ConfigResolveError
}

const layerInfo = (r: LoadResult): ConfigLayerInfo => ({
  scope: r.scope,
  path: r.file,
  exists: r.exists,
  sha256: r.sha256,
  valid: !r.issues.some((i) => i.severity === 'error'),
})

/**
 * Load the user and project files and resolve. Never throws for config problems: an invalid file is reported in
 * `issues` and resolved without (builtins + the other layer still apply); a resolve failure is `error`.
 */
export async function loadAndResolve(o: LoadAndResolveOptions): Promise<LoadedConfig> {
  const userFile = userConfigPath(o.paths.home)
  const store = o.storeLastGood !== false
  const user = await loadConfigFile(userFile, {
    scope: 'user',
    ...(store ? { paths: o.paths } : {}),
    ...(o.managedFlags !== undefined ? { managedFlags: o.managedFlags } : {}),
    ...(o.forbiddenFlags !== undefined ? { forbiddenFlags: o.forbiddenFlags } : {}),
  })
  let project: LoadResult | null = null
  let projectRoot: string | null = null
  if (o.folder !== undefined) {
    const loc = await locateProjectConfig(o.folder, o.scopeRoot)
    projectRoot = loc.root
    const inherited = deepMerge<Timeouts>(BUILTIN_DEFAULTS.timeouts, user.value?.timeouts)
    project = await loadConfigFile(loc.path, {
      scope: 'project',
      ...(store ? { paths: o.paths } : {}),
      inheritedTimeouts: inherited,
      ...(o.folderKey !== undefined && o.folderKey !== null
        ? { folderKey: o.folderKey, scopeRoot: o.scopeRoot ?? null }
        : {}),
    })
  }
  const userLayer = toConfigLayer(user)
  const projectLayer = project !== null ? toConfigLayer(project) : undefined
  const out: LoadedConfig = {
    user,
    project,
    projectRoot,
    issues: [...user.issues, ...(project?.issues ?? [])],
    layers: { user: layerInfo(user), project: project !== null ? layerInfo(project) : null },
  }
  try {
    out.result = resolve({
      ...(o.builtin !== undefined ? { builtin: o.builtin } : {}),
      ...(userLayer !== undefined ? { user: userLayer } : {}),
      ...(projectLayer !== undefined ? { project: projectLayer } : {}),
      ...(o.recipe !== undefined ? { recipe: o.recipe } : {}),
      ...(o.run !== undefined ? { run: o.run } : {}),
      ...(o.profile !== undefined ? { profile: o.profile } : {}),
      ...(projectRoot !== null ? { folder: projectRoot } : {}),
      home: o.paths.home,
      ...(o.builtinDir !== undefined ? { builtinDir: o.builtinDir } : {}),
    })
  } catch (err) {
    if (!(err instanceof ConfigResolveError)) throw err
    out.error = err
  }
  return out
}
