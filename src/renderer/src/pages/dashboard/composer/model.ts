// Quick composer view helpers (live preflight, estimates, provenance and the Critic-swap rule). Pure functions that FORMAT what core answered — config.resolve (config +
// provenance), preflight.run (PreflightReport), estimates.get (RunEstimate), vendors.list/models (ProbeView,
// ModelOption) — into the composer's labels. Nothing here decides a status, a cost or an estimate.
import type { ProvenanceMap, Provenance, ResolvedConfig, RunOverrides } from '@shared/config-schema.ts'
import type { Estimate, Percentiles, RunEstimate, StepEstimate } from '@shared/estimates.ts'
import type { ComposerSuggestions, FixSessionChoice, Platform } from '@shared/ipc.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import type { Mode, PassName, StepKey } from '@shared/run.ts'
import { FIX_ROUNDS_MAX } from '@shared/run.ts'
import type { Pack } from '@shared/brief.ts'
import { defaultLensIds, lensOptions } from '@shared/research.ts'
import type { GenericLenses } from '@shared/research.ts'
import type { LocalPreset, ModelOption, ProbeView, SupportStatus } from '@shared/vendors.ts'
import { effortsFor } from '@shared/vendors.ts'
import type { ExtensionLevel } from '@shared/extensions.ts'
import { defaultExtensionLevel } from '@shared/extensions.ts'
import {
  formatDurationRange,
  formatEta,
  formatTokens,
  formatUsd,
  NO_PRICE,
  stepLabel,
  vendorName,
} from '../../../lib/format.ts'
import { normalizeFolder } from '../composer-model.ts'

// ---- resolved config (read defensively: older cores and test doubles may omit sections) ----------------------------

export type ResolvedView = Partial<ResolvedConfig> & Pick<ResolvedConfig, 'profile' | 'auto' | 'passes'>

export interface ResolvedPassView {
  vendor: string
  model: string | null
  /** Absent from an older core's answer: the vendor's default effort. */
  effort?: string | null
  /** Absent from an older core's answer: the pass's default level (shared defaultExtensionLevel). */
  extensions?: ExtensionLevel
  mode: Mode
  enabled: boolean
  inherit?: 'implement' | null
  reuseSession?: boolean
  /** The Plan pass: Clarify before Plan (absent from an older core's answer: off). */
  clarify?: boolean
  /** The Plan pass: Research before Plan and its lenses (absent from an older core's answer: off, the defaults). */
  research?: boolean
  researchLenses?: string[]
  /** The Fix pass: Fix rounds, 1 = a single Fix (absent from an older core's answer: 1). */
  rounds?: number
  /** The Implement pass: the Deploy step at the end of the run (absent from an older core's answer: off). */
  deploy?: boolean
  deployTarget?: string | null
  /** The Review pass: the acceptance review (absent from an older core's answer: off). */
  acceptance?: boolean
  /** The Plan pass: Explain it to me (absent from an older core's answer: off). */
  explain?: boolean
}

/** The Security pass of an older core's answer (it has none): off, on the strongest reasoning model. */
const SECURITY_ABSENT: ResolvedPassView = {
  vendor: 'claude',
  model: 'opus',
  effort: null,
  extensions: 'none',
  mode: 'readonly',
  enabled: false,
}

export function passOf(config: ResolvedView, pass: PassName): ResolvedPassView {
  return (config.passes as Partial<ResolvedView['passes']>)[pass] ?? SECURITY_ABSENT
}

/** The security advisor is on (the run's pending choice first, then core's resolved Security pass). */
export function securityOnOf(config: ResolvedView | null, overrides: RunOverrides): boolean {
  const pending = overrides.passes?.security?.enabled
  if (pending !== undefined) return pending
  return config !== null ? passOf(config, 'security').enabled : false
}

/** Clarify before Plan is on (the run's pending choice first, then core's resolved Plan pass). */
export function clarifyOnOf(config: ResolvedView | null, overrides: RunOverrides): boolean {
  const pending = overrides.passes?.plan?.clarify
  if (pending !== undefined) return pending
  return config !== null ? passOf(config, 'plan').clarify === true : false
}

/** The Deploy step is on (the run's pending choice first, then core's resolved Implement pass). */
export function deployOnOf(config: ResolvedView | null, overrides: RunOverrides): boolean {
  const pending = overrides.passes?.implement?.deploy
  if (pending !== undefined) return pending
  return config !== null ? passOf(config, 'implement').deploy === true : false
}

/** The acceptance review is on (the run's pending choice first, then core's resolved Review pass). */
export function acceptanceOnOf(config: ResolvedView | null, overrides: RunOverrides): boolean {
  const pending = overrides.passes?.review?.acceptance
  if (pending !== undefined) return pending
  return config !== null ? passOf(config, 'review').acceptance === true : false
}

/** Explain it to me is on (the run's pending choice first, then core's resolved Plan pass). */
export function explainOnOf(config: ResolvedView | null, overrides: RunOverrides): boolean {
  const pending = overrides.passes?.plan?.explain
  if (pending !== undefined) return pending
  return config !== null ? passOf(config, 'plan').explain === true : false
}

/**
 * Research before Plan is on: the run's pending choice first, then core's resolved Plan pass, then the brief's pack
 * (`packOn`: a pack that researches by default, which core turns on unless the run says otherwise).
 */
export function researchOnOf(config: ResolvedView | null, overrides: RunOverrides, packOn = false): boolean {
  const pending = overrides.passes?.plan?.research
  if (pending !== undefined) return pending
  return (config !== null && passOf(config, 'plan').research === true) || packOn
}

/**
 * The lenses Research will tick: the run's pending list first, then core's resolved one; empty means the defaults
 * (the pack's, else the generic ones), so the picker shows those. Ids no lens has are left out.
 */
export function researchLensesOf(
  config: ResolvedView | null,
  overrides: RunOverrides,
  generic: GenericLenses | undefined,
  pack: Pack | undefined,
): string[] {
  if (generic === undefined) return []
  const known = new Set(lensOptions(generic, pack).map((l) => l.id))
  const pending = overrides.passes?.plan?.researchLenses
  const ids = pending ?? (config !== null ? (passOf(config, 'plan').researchLenses ?? []) : [])
  const kept = ids.filter((id) => known.has(id))
  return kept.length > 0 ? kept : defaultLensIds(generic, pack)
}

/** The lens list after ticking or unticking `id` (the last lens cannot be unticked), in the picker's order. */
export function toggleLens(
  current: readonly string[],
  id: string,
  on: boolean,
  order: readonly string[],
): string[] {
  const set = new Set(current)
  if (on) set.add(id)
  else if (set.size > 1) set.delete(id)
  return order.filter((x) => set.has(x))
}

/** Words that say the task builds something new (an app, a site, a feature): the composer then suggests Research. */
const NEW_WORK =
  /\b(new|build|create|make|design|start|launch|prototype|mvp|from scratch|add (?:a|an|the)? ?(?:new )?(?:feature|page|screen|section|endpoint|integration)|implement (?:a|an)|app|website|web app|product|tool|platform|service|game|dashboard|landing page|feature)\b/i
/** Words that say the task fixes or tidies what exists: no suggestion. */
const FIX_WORK =
  /\b(fix|bug|bugs|crash|crashes|error|errors|broken|fails?|failing|regression|typo|refactor|rename|clean ?up|lint|bump|upgrade|revert|flaky)\b/i

/** The task text looks like a new product or feature (and not a bug fix): the composer offers Research. */
export function looksLikeNewWork(task: string): boolean {
  const t = task.trim()
  if (t.length < 12) return false
  return NEW_WORK.test(t) && !FIX_WORK.test(t)
}

/** The research step's cost from the estimate (its p50 to p80), or null while it has none. */
export function researchCostText(estimate: RunEstimate | null): string | null {
  const c = estimate?.steps.research?.costUsd
  if (c === null || c === undefined) return null
  const lo = formatUsd(c.p50)
  const hi = formatUsd(c.p80)
  return lo === hi ? lo : `${lo} to ${hi}`
}

/**
 * The note beside "Research first": what it does, its cost when the estimate has one (web research is token-heavy),
 * a suggestion when the task looks like new work, and that the Plan vendor reads the repository only when it has no web
 * search. One line, cut with an ellipsis (it never changes the row's size).
 */
export function researchNote(o: {
  on: boolean
  cost: string | null
  suggest: boolean
  web: boolean | undefined
}): string {
  const parts: string[] = []
  if (!o.on && o.suggest) parts.push('Suggested: this looks like a new product or feature.')
  if (o.web === false) parts.push("Plan's vendor has no web search, so Research reads this repository only.")
  else parts.push('Studies the problem space with cited sources; you pick what Plan uses.')
  parts.push(
    o.cost !== null
      ? `Research: about ${o.cost}, web research is token-heavy.`
      : 'Web research is token-heavy.',
  )
  return parts.join(' ')
}

/** The rounds "Fix until green" turns on when the config does not name its own (the most a run may take). */
export const FIX_UNTIL_GREEN_ROUNDS = FIX_ROUNDS_MAX

/** The run's Fix rounds (the pending choice first, then core's resolved Fix pass; 1 = a single Fix). */
export function fixRoundsOf(config: ResolvedView | null, overrides: RunOverrides): number {
  const pending = overrides.passes?.fix?.rounds
  if (pending !== undefined) return pending
  return config !== null ? (passOf(config, 'fix').rounds ?? 1) : 1
}

/**
 * The rounds the "Fix until green" switch sets: on keeps a loop the config already has (2 or 3 rounds), else
 * FIX_UNTIL_GREEN_ROUNDS; off is a single Fix.
 */
export function fixRoundsFor(on: boolean, config: ResolvedView | null, overrides: RunOverrides): number {
  if (!on) return 1
  const now = fixRoundsOf(config, overrides)
  return now > 1 ? now : FIX_UNTIL_GREEN_ROUNDS
}

/** The composer's note beside "Clarify first" (constant: it never changes the row's size). */
export const CLARIFY_NOTE =
  'Plan may ask you a few multiple-choice questions first. In Auto it is skipped unless set to ask.'

/** The composer's note beside "Fix until green" (constant: it never changes the row's size). */
export const FIX_UNTIL_GREEN_NOTE =
  'Fix runs again while verify fails or a must finding stays open, up to the round cap and any budget.'

/** The composer's note beside "Acceptance review" (constant: it never changes the row's size). */
export const ACCEPTANCE_NOTE =
  "After Implement, checks each of the plan's acceptance criteria: met, not met or unknown. With Fix until green, unmet ones go to Fix."

/** The composer's note beside "Explain it to me" (constant: it never changes the row's size). */
export const EXPLAIN_NOTE =
  'At the end, a plain-language summary: what was built, how to run it, what to try next, known limits.'

/** The composer's note beside "Deploy config" (constant: it never changes the row's size). */
export const DEPLOY_NOTE =
  'At the end, writes the deploy config the target needs (Dockerfile, netlify.toml, ...) for you to review. It never deploys.'

/** The composer's honest cost note beside "Security review" (constant: it never changes the row's size). */
export const SECURITY_COST_NOTE =
  "Adds a security pass on the strongest model (about one more review's cost), a scan with no tokens, and a short re-check after Fix."

export function gatesOf(config: ResolvedView): { afterPlan: boolean; beforeFix: boolean } | null {
  return config.gates ?? null
}

export function isolationModeOf(config: ResolvedView): 'inPlace' | 'worktree' {
  return config.isolation?.mode ?? 'inPlace'
}

/** The verify commands a run would run (core's resolved list, less those turned off). */
export function verifyCommandCount(config: ResolvedView): number {
  return config.verify?.commands.filter((c) => c.enabled !== false).length ?? 0
}

/** Whether verify is on (core's resolved `verify.enabled`). */
export function verifyEnabledOf(config: ResolvedView): boolean {
  return config.verify?.enabled ?? false
}

/** The passes verify runs after (core's resolved `verify.runAfter`). */
export function verifyRunAfterOf(config: ResolvedView): readonly ('implement' | 'fix')[] {
  return config.verify?.runAfter ?? ['implement', 'fix']
}

/** Local presets as vendor ids (`local-<id>`) with their labels. */
export function localPresetVendors(config: ResolvedView): { id: string; label: string }[] {
  return (config.local?.presets ?? []).map((p) => ({ id: `local-${p.id}`, label: p.label }))
}

/** The local preset a `local-<id>` vendor names, or undefined. */
export function localPresetOf(config: ResolvedView, vendor: string): LocalPreset | undefined {
  if (!vendor.startsWith('local-')) return undefined
  const id = vendor.slice('local-'.length)
  return config.local?.presets.find((p) => p.id === id)
}

/** The vendor picker names a local preset "Local · <label>" under More. */
export function localChoiceLabel(label: string): string {
  return `Local · ${label}`
}

// ---- labels ---------------------------------------------------------------------------------------------------------

export const PASS_ORDER: readonly PassName[] = ['plan', 'implement', 'review', 'critic', 'security', 'fix']

/** Plan, Review, Critic and Security always run read-only (a config semantic rule). */
export const READ_ONLY_PASSES: ReadonlySet<PassName> = new Set<PassName>([
  'plan',
  'review',
  'critic',
  'security',
])

/** Names of the mode choices (option names only; what a mode allows comes from core's `support().copy`). */
export const MODE_LABEL: Readonly<Record<Mode, string>> = {
  readonly: 'Read-only',
  autoedit: 'Approve edits',
  full: 'Approve everything',
}

/** Mode choices for a pass: read-only passes have one; "Approve everything" only while Auto is on. */
export function modeChoices(pass: PassName, auto: boolean): Mode[] {
  if (READ_ONLY_PASSES.has(pass)) return ['readonly']
  return auto ? ['readonly', 'autoedit', 'full'] : ['readonly', 'autoedit']
}

/**
 * What the vendor's probe says of a mode (`capabilities.modes`, core's support() per mode on its route: Codex's
 * "Approve edits" is unsupported while its Windows sandbox is not set up), read defensively; undefined when core
 * did not say.
 */
export function modeSupportOf(
  view: ProbeView | undefined,
  mode: Mode,
): { status: SupportStatus; copy: string } | undefined {
  const modes = (view?.probe?.capabilities as { modes?: unknown } | undefined)?.modes
  if (typeof modes !== 'object' || modes === null) return undefined
  const s = (modes as Record<string, unknown>)[mode]
  if (typeof s !== 'object' || s === null) return undefined
  const { status, copy } = s as { status?: unknown; copy?: unknown }
  if (status !== 'supported' && status !== 'degraded' && status !== 'unsupported') return undefined
  return { status, copy: typeof copy === 'string' ? copy : '' }
}

/** A mode choice's note in the picker: `not available here` or `limited` from the vendor's probe; '' otherwise. */
export function modeChoiceNote(view: ProbeView | undefined, mode: Mode): string {
  const s = modeSupportOf(view, mode)
  if (s === undefined) return ''
  return s.status === 'unsupported' ? 'not available here' : s.status === 'degraded' ? 'limited' : ''
}

export function modelText(model: string | null): string {
  return model ?? 'CLI default'
}

/** A pass's Extensions level as core resolved it (an older core's answer: the pass's default). */
export function extensionsOf(p: Pick<ResolvedPassView, 'extensions'>, pass: PassName): ExtensionLevel {
  return p.extensions ?? defaultExtensionLevel(pass)
}

/** Why a read-only pass's Pass through is not saved to the project file (a project cannot set it). */
export const PASSTHROUGH_NOT_SAVED =
  'A project file cannot let a read-only pass use every extension. Choose it in Settings, Extensions, for your own settings.'

/** An effort level as a pass row says it: `high effort`, or the vendor's default. */
export function effortText(effort: string | null | undefined): string {
  return effort !== undefined && effort !== null ? `${effort} effort` : 'Default effort'
}

/**
 * The effort a pass keeps when its model changes (Harpoon's rule): a level the new model lists stays; one it does not
 * goes back to the default (null). While the list is not known (not loaded, or it names no levels) the level stays.
 */
export function effortAfterModel(
  options: readonly ModelOption[] | null,
  model: string | null,
  effort: string | null,
): string | null {
  if (effort === null || options === null) return effort
  const levels = effortsFor(options, model)
  return levels.length === 0 || levels.includes(effort) ? effort : null
}

/** A vendor's display name: a local preset's label, a probed vendor's name, else the known names. */
export function vendorText(vendor: string, config: ResolvedView, probes: readonly ProbeView[]): string {
  const preset = localPresetVendors(config).find((p) => p.id === vendor)
  if (preset !== undefined) return preset.label
  return probes.find((p) => p.vendor === vendor)?.displayName ?? vendorName(vendor)
}

// ---- provenance -----------------------------------------------------------------------------------------------------

export function provenanceAt(
  map: ProvenanceMap | undefined,
  pass: PassName,
  field: string,
): Provenance | undefined {
  return map?.[`/passes/${pass}/${field}`]
}

export const PROVENANCE_LABEL: Readonly<Record<Provenance['source'], string>> = {
  default: 'default',
  user: 'user',
  project: 'project',
  recipe: 'recipe',
  run: 'run',
  auto: 'auto',
  inherit: 'inherited',
  vendor: 'vendor default',
  cli: 'CLI default',
}

/** Run-layer and Auto values are this run's own (amber); everything else comes from files or defaults. */
/** The badge text: a built-in value from the selected profile reads `profile`. */
export function provenanceLabel(p: Provenance): string {
  return p.source === 'default' && p.via?.startsWith('profile:') === true
    ? 'profile'
    : PROVENANCE_LABEL[p.source]
}

export function isRunProvenance(p: Provenance | undefined): boolean {
  return p?.source === 'run' || p?.source === 'auto'
}

function where(p: Provenance): string | null {
  if (p.file === undefined) return null
  return p.line !== undefined ? `${p.file}:${p.line}` : p.file
}

/** Tooltip for a provenance badge. */
export function provenanceTitle(p: Provenance): string {
  const at = where(p)
  const profile = p.via?.startsWith('profile:') === true ? p.via.slice('profile:'.length) : null
  switch (p.source) {
    case 'default':
      return profile !== null ? `From the ${profile} profile` : 'Built-in default'
    case 'user':
      return `Your settings${at !== null ? `: ${at}` : ''}`
    case 'project':
      return `Project settings${at !== null ? `: ${at}` : ''}`
    case 'recipe': {
      const id = p.via?.startsWith('recipe:') === true ? p.via.slice('recipe:'.length) : null
      return `From the recipe${id !== null ? ` ${id}` : ''}${at !== null ? `: ${at}` : ''}`
    }
    case 'run':
      return 'This run only'
    case 'auto':
      return 'Set by Auto mode'
    case 'inherit':
      return 'Same as Implement'
    case 'vendor':
      return `The vendor's default model in your settings${at !== null ? `: ${at}` : ''}`
    case 'cli':
      return 'Left to the CLI: it uses its own default model'
  }
}

// ---- preflight report ----------------------------------------------------------------------------------------------

export function allChecks(r: PreflightReport | null): CheckResult[] {
  return r === null ? [] : [...r.blocking, ...r.warnings, ...r.info]
}

export function checkById(r: PreflightReport | null, id: string): CheckResult | undefined {
  return allChecks(r).find((c) => c.id === id)
}

/** Passed checks (`✓ N checks ok`); skipped ones are listed but not counted. */
export function okChecks(r: PreflightReport): CheckResult[] {
  return r.info.filter((c) => c.status === 'pass')
}

/**
 * Core's `folder.lock` answer (info "queues behind #N"): the check when another run holds the folder, else null.
 * Core reports both outcomes as a passed check; only a queued answer names the run it queues behind.
 */
export function queueCheck(r: PreflightReport | null): CheckResult | null {
  const c = checkById(r, 'folder.lock')
  return c !== undefined && /queues behind/i.test(c.title) ? c : null
}

/** The folder is not a git repository (core's `folder.git` result says so). */
export function notGitRepo(r: PreflightReport | null): boolean {
  const c = checkById(r, 'folder.git')
  return c !== undefined && /not a git repositor|needs? a git repositor/i.test(`${c.title} ${c.detail}`)
}

/** `Native plan` / `Plan template` from core's `pass.plan.native` result; null before a report. */
export function planModeText(r: PreflightReport | null): string | null {
  const c = checkById(r, 'pass.plan.native')
  if (c === undefined) return null
  return /^native plan/i.test(c.title) ? 'Native plan' : 'Plan template'
}

/** What core says a pass's mode allows (`pass.<p>.mode` detail is `support().copy`, the only mode copy). */
export function modeCopy(r: PreflightReport | null, pass: PassName): string | null {
  const c = checkById(r, `pass.${pass}.mode`)
  return c !== undefined && c.detail !== '' ? c.detail : null
}

/**
 * How core's `pass.<p>.mode` check reads the mode: passed = supported, warned = degraded (e.g. Codex exec's
 * "escalations auto-denied"), failed = unsupported (e.g. Codex "Approve edits" without its Windows sandbox). The
 * copy line under Mode takes its colour from it.
 */
export function modeCopyStatus(r: PreflightReport | null, pass: PassName): SupportStatus | null {
  const c = checkById(r, `pass.${pass}.mode`)
  if (c === undefined) return null
  return c.status === 'fail' ? 'unsupported' : c.status === 'warn' ? 'degraded' : 'supported'
}

/** Core's word on Fix reusing Implement's session (`pass.fix.resume`), when it gave one. */
export function fixResumeCheck(r: PreflightReport | null): CheckResult | null {
  return checkById(r, 'pass.fix.resume') ?? null
}

/**
 * Chips for checks that share their fixes: core reports one vendor problem once per pass that uses the vendor (each
 * `pass.<p>.vendor` carries the vendor check's own actions). A check whose non-empty action ids equal an earlier
 * one's is listed under that chip instead of repeating the same buttons. Order and every check are kept.
 */
export function groupBySameFix(
  checks: readonly CheckResult[],
): { check: CheckResult; also: CheckResult[] }[] {
  const out: { check: CheckResult; also: CheckResult[] }[] = []
  const byFix = new Map<string, { check: CheckResult; also: CheckResult[] }>()
  for (const c of checks) {
    const key = c.recovery.map((a) => a.id).join('\n')
    const group = key !== '' ? byFix.get(key) : undefined
    if (group !== undefined) {
      group.also.push(c)
      continue
    }
    const g = { check: c, also: [] as CheckResult[] }
    out.push(g)
    if (key !== '') byFix.set(key, g)
  }
  return out
}

export const MAX_RUN_REASONS = 3

/** `Fix 2 issues to run`. */
export function fixIssuesLabel(n: number): string {
  return `Fix ${n} ${n === 1 ? 'issue' : 'issues'} to run`
}

/**
 * The problems core's blocking checks amount to: checks reported with the same fixes are one problem (a logged-out
 * vendor fails its own check and every pass that uses it), as the strip shows them as one chip.
 */
export function blockingIssueCount(blocking: readonly CheckResult[]): number {
  return groupBySameFix(blocking).length
}

/** The Run button's label while core's checks block it: one count for the label, the strip and the reasons. */
export function blockedLabel(blocking: readonly CheckResult[]): string {
  return fixIssuesLabel(blockingIssueCount(blocking))
}

/** The disabled Run button's reason: the label and at most three blocking titles (one per problem). */
export function blockedReason(blocking: readonly CheckResult[]): string {
  const groups = groupBySameFix(blocking)
  const titles = groups.slice(0, MAX_RUN_REASONS).map((g) => g.check.title)
  const more = groups.length - titles.length
  return `${fixIssuesLabel(groups.length)}: ${titles.join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

/**
 * What the composer's polite live region says about core's live checks (accessibility): announced when
 * it changes, so a screen-reader user hears that Run became blocked, queued or free. '' before an answer.
 */
export function checksAnnouncement(
  report: PreflightReport | null,
  error: string | null,
  queued: boolean,
): string {
  if (error !== null) return `Could not check this folder: ${error}`
  if (report === null) return ''
  const groups = groupBySameFix(report.blocking)
  if (groups.length > 0) {
    const first = groups[0]?.check.title ?? ''
    return `Checks: ${groups.length === 1 ? '1 issue blocks' : `${groups.length} issues block`} the run. ${first}.`
  }
  const warnings = groupBySameFix(report.warnings).length
  const head =
    warnings === 0
      ? 'All checks passed'
      : `Nothing blocks the run; ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
  return queued ? `${head}. The run will queue behind another run in this folder.` : `${head}.`
}

// ---- estimates ------------------------------------------------------------------------------------------------------

/** `$0.40–0.85` or `$0.30` when both ends round to the same cent. */
export function formatUsdRange(p: Percentiles): string {
  const a = formatUsd(p.p50)
  const b = formatUsd(Math.max(p.p50, p.p80))
  if (a === b) return a
  return `${a}–${b.startsWith('$') ? b.slice(1) : b}`
}

/** `≈ 9–14 min` (never `≈ ~…`). */
export function formatApproxDuration(p: Percentiles): string {
  const range = formatDurationRange(p)
  return `≈ ${range.startsWith('~') ? range.slice(1) : range}`
}

/** core names a model it could not price `vendor/model`; `vendor/default` = the CLI default model is unknown. */
export function isCliDefaultEntry(entry: string): boolean {
  return entry.endsWith('/default')
}

/**
 * The cost part of an estimate: `~$0.40–0.85 est.`; when core has no cost, why: `no price (CLI default model
 * unknown)`, `no price for codex/gpt-x`, or `cost unknown` (no token history yet).
 */
export function estimateCostText(e: Estimate): string {
  if (e.costUsd !== null) return `~${formatUsdRange(e.costUsd)} est.`
  if (e.missingPricing.some(isCliDefaultEntry)) return 'no price (CLI default model unknown)'
  if (e.missingPricing.length > 0) return `no price for ${e.missingPricing.join(', ')}`
  return 'cost unknown'
}

/** `~120k–180k tokens`, when core gave tokens but no cost. */
export function estimateTokensText(e: Estimate): string | null {
  if (e.costUsd !== null || e.tokens === undefined) return null
  const a = formatTokens(e.tokens.p50)
  const b = formatTokens(Math.max(e.tokens.p50, e.tokens.p80))
  return a === b ? `~${a} tokens` : `~${a}–${b} tokens`
}

/** The basis as core worded it (`from 12 runs`, `typical (no history yet)`). */
export function estimateBasisText(e: Estimate): string {
  if (e.basis.trim() !== '') return e.basis
  return e.samples > 0 ? `from ${e.samples} runs` : 'typical (no history yet)'
}

export const REVIEW_TIME = '+ your review time'

/** The composer line: `≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs` (+ `· + your review time` with a gate on). */
export function estimateLineParts(e: Estimate, gateOn: boolean): string[] {
  const parts = [formatApproxDuration(e.durationMs)]
  const tokens = estimateTokensText(e)
  if (tokens !== null) parts.push(tokens)
  parts.push(estimateCostText(e), estimateBasisText(e))
  if (gateOn) parts.push(REVIEW_TIME)
  return parts
}

/** A pass row's estimate: `~2 min · ~$0.08`. */
export function passEstimateText(e: StepEstimate | undefined): string | null {
  if (e === undefined) return null
  const time = formatEta(e.durationMs.p50)
  return e.costUsd !== null ? `${time} · ~${formatUsd(e.costUsd.p50)}` : time
}

/** Per-step rows for the hover table, in run order. */
export function estimateRows(
  est: RunEstimate,
): { key: StepKey; label: string; time: string; cost: string; basis: string }[] {
  const order: StepKey[] = [
    'prepare',
    'verify:0',
    'plan',
    'tests',
    'verify:red',
    'implement',
    'verify:1',
    'review',
    'critic',
    'fix',
    'verify:2',
  ]
  return order.flatMap((key) => {
    const e = est.steps[key]
    if (e === undefined) return []
    return [
      {
        key,
        label: stepLabel(key),
        time: formatDurationRange(e.durationMs),
        cost: e.costUsd !== null ? formatUsdRange(e.costUsd) : NO_PRICE,
        basis: estimateBasisText(e),
      },
    ]
  })
}

const PFIX_BASIS: Readonly<Record<RunEstimate['pFix']['basis'], string>> = {
  folder: "from this folder's runs",
  global: 'from all your runs',
  prior: 'typical',
}

/** `Fix counted at 60% · typical`. */
export function pFixText(p: RunEstimate['pFix']): string {
  return `Fix counted at ${Math.round(p.value * 100)}% · ${PFIX_BASIS[p.basis]}`
}

// ---- vendors --------------------------------------------------------------------------------------------------------

export const PRIMARY_VENDORS: readonly string[] = ['claude', 'codex']

/**
 * Core's install command for a vendor that is not installed (its `vendor.<v>.bin` copy action), or for a vendor not
 * in this build (its registry stub offers `<v>.install`).
 */
export function installCommandOf(view: ProbeView | undefined): string | null {
  if (view === undefined) return null
  const checks = view.probe?.checks ?? []
  const bin = checks.find((c) => c.id === `vendor.${view.vendor}.bin`)
  for (const a of bin?.recovery ?? []) if (a.kind === 'shell_copy') return a.command
  for (const c of checks)
    for (const a of c.recovery)
      if (a.kind === 'shell_copy' && a.id === `${view.vendor}.install`) return a.command
  return null
}

export interface VendorChoice {
  id: string
  label: string
  group: 'primary' | 'more'
  disabled: boolean
  /** Muted text after the name (`Not installed`, `Login needed`, `Not available in this build`). */
  note?: string
  /** Hover text: the install command for a vendor that is not installed (or not in this build). */
  title?: string
}

/** The note of a vendor whose probe is running (selecting one triggers vendors.probe). */
export const CHECKING_NOTE = 'Checking…'

/** The badge of an Experimental vendor (core's ProbeView.experimental: Muse), wherever vendors are listed. */
export const EXPERIMENTAL_NOTE = 'Experimental'

/**
 * A choice as the vendor pickers list it (`Muse · Experimental · Muse's event shapes are not pinned
 * yet`). The picker's trigger is narrower than that, so it carries this text as its title too (UI standard: text cut
 * with an ellipsis says itself in full).
 */
export function vendorChoiceText(c: Pick<VendorChoice, 'label' | 'note'>): string {
  return c.note !== undefined ? `${c.label} · ${c.note}` : c.label
}

function choiceOf(view: ProbeView, group: VendorChoice['group']): VendorChoice {
  const c = stateChoiceOf(view, group)
  if (!view.experimental) return c
  return { ...c, note: c.note !== undefined ? `${EXPERIMENTAL_NOTE} · ${c.note}` : EXPERIMENTAL_NOTE }
}

function stateChoiceOf(view: ProbeView, group: VendorChoice['group']): VendorChoice {
  const base = { id: view.vendor, label: view.displayName, group }
  const install = installCommandOf(view)
  const title = install !== null ? { title: install } : {}
  if (!view.built) return { ...base, disabled: true, note: 'Not available in this build', ...title }
  if (view.health === 'not-installed') return { ...base, disabled: true, note: 'Not installed', ...title }
  if (view.checking) return { ...base, disabled: false, note: CHECKING_NOTE }
  if (view.health === 'ready' || view.health === 'checking') return { ...base, disabled: false }
  return { ...base, disabled: false, note: view.healthDetail }
}

/**
 * A built vendor whose `--version` succeeded (the "More" list is every vendor whose resolve
 * + `--version` succeeded). A version check that fails (Gemini below what Dim Factory needs, or without `--acp`)
 * still lists it, with core's health ("Update needed"), so choosing it shows the fix in the checks.
 */
export function versionFound(view: ProbeView): boolean {
  return view.probe !== null && (view.probe.version ?? view.probe.binary?.version) !== undefined
}

/**
 * The vendor picker: Claude and Codex first; "More" lists other vendors whose `--version` succeeded and
 * the local presets; vendors that are not installed are greyed with the install command, unbuilt ones are disabled.
 * The current vendor is always present so the picker can show it.
 */
export function vendorChoices(
  probes: readonly ProbeView[],
  presets: readonly { id: string; label: string }[],
  current: string,
): VendorChoice[] {
  const byId = new Map(probes.map((p) => [p.vendor, p]))
  const out: VendorChoice[] = PRIMARY_VENDORS.map((id) => {
    const view = byId.get(id)
    return view !== undefined
      ? choiceOf(view, 'primary')
      : { id, label: vendorName(id), group: 'primary', disabled: false }
  })
  for (const view of probes) {
    if (PRIMARY_VENDORS.includes(view.vendor)) continue
    if (!view.built || view.health === 'not-installed' || versionFound(view)) out.push(choiceOf(view, 'more'))
  }
  for (const p of presets)
    out.push({ id: p.id, label: localChoiceLabel(p.label), group: 'more', disabled: false })
  if (!out.some((c) => c.id === current)) {
    out.push({
      id: current,
      label: byId.get(current)?.displayName ?? vendorName(current),
      group: 'more',
      disabled: false,
    })
  }
  return out
}

// ---- models ---------------------------------------------------------------------------------------------------------

/** Model picker options: core's `vendors.models` list, else the probe's model list (without pricing). */
export function modelOptionsFromProbe(view: ProbeView | undefined): ModelOption[] {
  return (view?.probe?.models ?? []).map((m) => ({ ...m, hasPricing: true }))
}

/** A model core could not price: `vendors.models` says so, or the estimate names it in `missingPricing`. */
export function modelHasNoPricing(
  vendor: string,
  model: string | null,
  options: readonly ModelOption[] | null,
  estimate: RunEstimate | null,
): boolean {
  if (model === null) return false
  const opt = options?.find((o) => o.id === model || o.aliases?.includes(model) === true)
  if (opt !== undefined && !opt.hasPricing) return true
  return estimate?.total.missingPricing.includes(`${vendor}/${model}`) === true
}

const MODEL_ID = /^[\w.:@/[\]-]+$/

/** A model id the config accepts (ModelIdZ): null for an empty box (CLI default). */
export function parseModelInput(
  text: string,
): { ok: true; model: string | null } | { ok: false; message: string } {
  const t = text.trim()
  if (t === '') return { ok: true, model: null }
  if (t.length > 128) return { ok: false, message: 'Model ids are at most 128 characters.' }
  if (!MODEL_ID.test(t)) return { ok: false, message: 'Use letters, digits and . : @ / [ ] - _ only.' }
  return { ok: true, model: t }
}

// ---- core's readiness-based suggestions (Critic swap, Fix session) -------------------------------------------------
// Core decides them (config.resolve `suggestions`, src/core/config/suggestions.ts); the composer formats them.

export type FixSession = FixSessionChoice

export const FIX_SESSION_LABEL: Readonly<Record<FixSession, string>> = {
  reuse: "Reuse Implement's session",
  fresh: 'Fresh session',
  'fresh-other': 'Fresh, different vendor',
}

/** [Swap Critic to X]: core's target, or null. */
export function criticSwapTarget(suggestions: ComposerSuggestions | undefined): string | null {
  return suggestions?.criticSwap?.to ?? null
}

/**
 * The Critic-swap chip's tooltip: why core offers it, and what the other vendor's read-only mode can do here when
 * its probe says it is limited (Codex without its Windows sandbox reviews from the diff), in core's words.
 */
export function criticSwapTooltip(
  implementName: string,
  targetName: string,
  target: ProbeView | undefined,
): string {
  const base = `Critic runs on ${implementName}, like Implement. Another vendor reviews with fresh eyes. This run only.`
  const ro = modeSupportOf(target, 'readonly')
  if (ro === undefined || ro.status !== 'degraded' || ro.copy === '') return base
  return `${base} ${targetName} here: ${ro.copy}`
}

/**
 * The Fix row's session as core will start it (its decideSession answer); an older core without suggestions: the
 * resolved config's `reuseSession` as stated.
 */
export function fixSessionOf(config: ResolvedView, suggestions: ComposerSuggestions | undefined): FixSession {
  if (suggestions !== undefined) return suggestions.fixSession.choice
  return passOf(config, 'fix').reuseSession !== false ? 'reuse' : 'fresh'
}

/** "Fresh, different vendor": core's first ready vendor other than Implement's, or null. */
export function otherFixVendor(suggestions: ComposerSuggestions | undefined): string | null {
  return suggestions?.otherFixVendor ?? null
}

// ---- folder notes -------------------------------------------------------------------------------------------------

/** "Snapshots cover repo root <path>" when core's scope root is not the chosen folder. */
export function scopeRootNote(folder: string, scopeRoot: string | null, platform: Platform): string | null {
  if (scopeRoot === null || folder.trim() === '') return null
  if (normalizeFolder(scopeRoot, platform) === normalizeFolder(folder, platform)) return null
  return `Snapshots cover repo root ${scopeRoot}`
}

/** A chip's place in the open preflight details while they stay open (PreflightStrip). */
export interface HeldSlot {
  key: string
  /** The title it last showed (what a cleared slot names). */
  title: string
}

export type SlotRow<T> =
  | { kind: 'chip'; slot: number; key: string; item: T }
  | { kind: 'cleared'; slot: number; key: string; title: string }

/**
 * Keep each chip where it was while the preflight details stay open (core answers on its own schedule, and its
 * answers never move the page): a chip still reported stays in its slot; a slot whose chip core no longer reports
 * takes the next newly reported chip, else says it cleared. The first layout (no slots yet) places every chip; after
 * that a new chip with no free slot waits (`waiting`) until the details are laid out afresh, since adding a place
 * would push the page below down (the summary row above counts it already). Updates `held` (the slots, in order);
 * calling it again with the same input gives the same rows.
 */
export function placeInSlots<T>(
  held: HeldSlot[],
  current: readonly { key: string; title: string; item: T }[],
): { rows: SlotRow<T>[]; waiting: number } {
  const first = held.length === 0
  const byKey = new Map(current.map((c) => [c.key, c]))
  const heldKeys = new Set(held.map((s) => s.key))
  const fresh = current.filter((c) => !heldKeys.has(c.key))
  const rows: SlotRow<T>[] = []
  held.forEach((s, slot) => {
    const c = byKey.get(s.key)
    if (c !== undefined) {
      s.title = c.title
      rows.push({ kind: 'chip', slot, key: c.key, item: c.item })
      return
    }
    const f = fresh.shift()
    if (f !== undefined) {
      held[slot] = { key: f.key, title: f.title }
      rows.push({ kind: 'chip', slot, key: f.key, item: f.item })
      return
    }
    rows.push({ kind: 'cleared', slot, key: s.key, title: s.title })
  })
  if (!first) return { rows, waiting: fresh.length }
  for (const f of fresh) {
    held.push({ key: f.key, title: f.title })
    rows.push({ kind: 'chip', slot: held.length - 1, key: f.key, item: f.item })
  }
  return { rows, waiting: 0 }
}
