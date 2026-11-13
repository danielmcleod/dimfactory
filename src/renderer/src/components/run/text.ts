// Run view wording that core states as plain strings. Copied from core and the dev CLI,
// since the renderer may not import src/core: skip reasons (supervisor/machine.ts SKIP_REASON), fresh-session reasons
// (supervisor/sessions.ts) and the CLI's mode words (cli/render.ts). tests/renderer/run/text.test.ts keeps them equal.
import type { AgentStep, FreshReason, Mode, PassName, PlanMode, StepKey, StepView } from '@shared/run.ts'
import { isAgentStep, isPassName } from '@shared/run.ts'
import { localPresetIdOf } from '@shared/vendors.ts'
import type {
  ContextContributor,
  ContextHealthItem,
  ContextSuggestion,
  ContextView,
} from '@shared/context.ts'
import { stepLabel, vendorName } from '../../lib/format.ts'

/** core SKIP_REASON values that mean "this run does not use the step": the timeline leaves such steps out. */
export const NOT_USED_REASONS: ReadonlySet<string> = new Set([
  'disabled',
  'not in this build',
  'in place',
  'verify off',
  'not used',
])

/** core SKIP_REASON → what a skipped step says. Unknown reasons show as core wrote them. */
export const SKIP_REASON_TEXT: Readonly<Record<string, string>> = {
  disabled: 'turned off',
  'not in this build': 'not in this version',
  'in place': 'not used for in-place runs',
  'verify off': 'verify is off',
  'no changes': 'no changes were made',
  user: 'you skipped it',
  'no findings': 'no findings to fix',
  'no findings selected': 'no findings were selected',
  // Quieter reviews: nothing listed came with evidence of a real problem.
  'nothing with evidence': 'nothing came with evidence of a real problem',
  'not needed': 'not needed',
  'not used': 'not used in this run',
  // Clarify in an Auto run (unless set to ask in Auto).
  'skipped in Auto': 'Auto skips Clarify',
  // The acceptance review when the plan lists no acceptance criteria.
  'no criteria': 'the plan lists no acceptance criteria',
  // The security reviewer of a run that reviews only sensitive changes, when its scan found none.
  'not needed: no keys or personal data changed':
    'not needed: the secret scan found no keys or personal data in the changes',
}

export function skipReasonText(reason: string | undefined): string | undefined {
  if (reason === undefined || reason === '') return undefined
  return SKIP_REASON_TEXT[reason] ?? reason
}

/** The human half of Fix's session line (core sessions.ts FRESH_REASON_TEXT). */
export const FRESH_REASON_TEXT: Readonly<Record<FreshReason, string>> = {
  'vendor-differs': 'Fix vendor differs',
  'no-session': 'no session to continue',
  'cannot-resume': 'the session cannot be resumed',
  'cwd-changed': 'the folder changed',
  'model-differs': 'the model differs',
  'override-fresh': 'set to start fresh',
  'override-other-vendor': 'set to a different vendor',
  'resume-failed': 'resuming failed',
  'implement-skipped': 'Implement was skipped',
  'context-heavy': 'the Implement session was nearly full',
  'plan-skipped': 'Plan was skipped',
  'plan-vendor-differs': 'Plan ran on another vendor',
  'mode-switch-unsupported': 'the vendor cannot change the mode of a resumed session',
}

/**
 * Mode words when core sent no `modeCopy` (the dev CLI's MODE_TEXT). `StepView.modeCopy.copy` always wins: it is the
 * adapter's honest copy for this vendor.
 */
export const MODE_TEXT: Readonly<Record<Mode, string>> = {
  readonly: 'read-only',
  autoedit: 'edits files',
  full: 'full access',
}

const NATIVE_PLAN_TEXT: Readonly<Record<string, string>> = {
  claude: 'Native plan · Claude plan mode',
  codex: 'Native plan · Codex <proposed_plan>',
  gemini: 'Native plan · Gemini ACP',
  grok: 'Native plan · Grok ACP',
}

/** The plan-mode chip: `Native plan · Claude plan mode` / `Read-only + plan template` / `Fell back to template: …`. */
export function planModeText(
  planMode: PlanMode | undefined,
  vendor: string | undefined,
  fallbackReason?: string,
): string | undefined {
  if (fallbackReason !== undefined && fallbackReason !== '') return `Fell back to template: ${fallbackReason}`
  if (planMode === 'native')
    return (vendor !== undefined ? NATIVE_PLAN_TEXT[vendor] : undefined) ?? 'Native plan'
  if (planMode === 'emulated') return 'Read-only + plan template'
  return undefined
}

/** The passes, in run order (the steps with a vendor CLI, a stream and a ⋯ menu). */
export const PASS_ORDER: readonly PassName[] = ['plan', 'implement', 'review', 'critic', 'security', 'fix']

/**
 * Steps that "Continue without" may skip (never Implement; Test-first's Tests step may be, and so may the security
 * advisor's reviewer, the re-check after Fix, Clarify's questions, Research before Plan, the Deploy step, the acceptance
 * review and Explain it to me).
 */
export const SKIPPABLE: ReadonlySet<StepKey> = new Set<StepKey>([
  'clarify',
  'research',
  'plan',
  'tests',
  'review',
  'critic',
  'security',
  'fix',
  'recheck',
  'deploy',
  'acceptance',
  'explain',
])

/** One of the configured passes (Tests is not: a run without Test-first never shows it). */
export function isPass(step: StepKey): step is PassName {
  return isPassName(step)
}

/**
 * A step a vendor CLI runs: a pass, or Test-first's Tests step. Its card has the vendor chips, the stream, asks and
 * the pass actions (Retry, Continue without, Keep waiting), which take it as `pass`.
 */
export function isAgent(step: StepKey): step is AgentStep {
  return isAgentStep(step)
}

/** `Claude` / `Codex` for a step, or a neutral word for runner steps. */
export function stepVendorName(view: Pick<StepView, 'vendor'>): string {
  return view.vendor !== undefined ? vendorName(view.vendor) : 'Dim Factory'
}

/** Last path segment of a command (`C:\…\claude.exe` → `claude.exe`). */
export function commandName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.at(-1) ?? path
}

/**
 * A copyable command line: arguments with spaces or quotes are double-quoted. Prompts go on stdin, so the argv is
 * flags and paths only.
 */
export function formatCommandLine(argv: readonly string[]): string {
  return argv.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

// ---- the model a pass with no model runs (seen in a live balanced run) -----------------------------------------------

/** The model chip of a pass that names no model and has no model reported or expected. */
export const DEFAULT_MODEL_TEXT = 'default model'

/** The model chip's text: the pass's own model, else the one it ran, else the one core expects, else the default. */
export function modelChipText(view: Pick<StepView, 'model' | 'modelUsed' | 'expectedModel'>): string {
  return view.model ?? view.modelUsed ?? view.expectedModel ?? DEFAULT_MODEL_TEXT
}

const ACTIVE_PASS_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting', 'stalled', 'paused'])

/**
 * The model chip's tooltip for a pass that names no model (the Config tab's Model cell says the same). It names the
 * model in full (the chip may cut it to the width it keeps) and says who chose it, or that the vendor did not report
 * which model ran. None for a pass that names its model, nor for a local preset's (it runs its preset's model). No em dash.
 */
export function modelChipTitle(
  view: Pick<
    StepView,
    | 'status'
    | 'attempt'
    | 'model'
    | 'modelUsed'
    | 'modelReplaced'
    | 'modelAsked'
    | 'modelRerouted'
    | 'modelOverrideIgnored'
    | 'expectedModel'
    | 'vendor'
  >,
): string | undefined {
  if (view.model !== null) return undefined
  if (view.vendor !== undefined && localPresetIdOf(view.vendor) !== null) return undefined
  const who = vendorName(view.vendor)
  const { modelUsed: used, modelReplaced: replaced, modelOverrideIgnored: asked } = view
  if (used !== undefined && asked !== undefined)
    return `This pass names no model. ${who}'s settings chose ${used}, which this account is not offered. Dim Factory asked for the account's default, ${asked}, but ${who} ran ${used}, and the account refused it.`
  // The vendor moved the turn to another model (Codex's reroute of a request it flags).
  if (used !== undefined && view.modelRerouted !== undefined) {
    const moved = `${who} moved this turn from ${view.modelRerouted} to ${used}, which ran.`
    return replaced !== undefined
      ? `This pass names no model. ${who}'s settings chose ${replaced}, which this account is not offered, so Dim Factory asked ${who} for the account's default. ${moved}`
      : `This pass names no model. ${moved}`
  }
  // The default ran once the vendor said so; until then it was only asked for.
  if (used !== undefined && replaced !== undefined)
    return `This pass names no model. ${who}'s settings chose ${replaced}, which this account is not offered, so ${who} ran the account's default, ${used}, at Dim Factory's request.`
  if (view.modelAsked !== undefined && replaced !== undefined) {
    const head = `This pass names no model. ${who}'s settings chose ${replaced}, which this account is not offered, so Dim Factory asked ${who} to run the account's default, ${view.modelAsked}, instead.`
    return ACTIVE_PASS_STATUSES.has(view.status)
      ? `${head} ${who} has not confirmed yet which model it runs.`
      : `${head} ${who} did not confirm which model ran.`
  }
  if (used !== undefined) return `This pass names no model. ${who}'s settings chose ${used} for this folder.`
  if (view.expectedModel !== undefined)
    return `This pass names no model, so ${who} chooses. Dim Factory expects ${view.expectedModel}, its default for this account, and prices the estimate at it.`
  if (view.attempt === 0)
    return view.status === 'queued' ? `This pass names no model, so ${who} chooses.` : undefined
  return ACTIVE_PASS_STATUSES.has(view.status)
    ? `This pass names no model, so ${who} chooses. ${who} has not reported which model it runs.`
    : `This pass names no model, so ${who} chose. ${who} did not report which model ran.`
}

/**
 * The texts whose widths the model chip keeps from its first render (UI standard: nothing moves on its own): the text
 * it shows first and, when that is a model core only expects, "default model" too, which the chip reads once the pass
 * has started where its vendor does not say which model ran.
 */
export function modelChipReserve(
  view: Pick<StepView, 'model' | 'modelUsed' | 'expectedModel'>,
): readonly string[] {
  const text = modelChipText(view)
  const expected = view.model === null && view.modelUsed === undefined && view.expectedModel !== undefined
  return expected && text !== DEFAULT_MODEL_TEXT ? [text, DEFAULT_MODEL_TEXT] : [text]
}

/**
 * The Config tab's Model cell: the pass's own model, else the model it ran or (before its vendor said) the one core
 * expects, marked "(default)"; "default" when neither is known. A confirmed expectation changes nothing.
 */
export function configModelText(view: Pick<StepView, 'model' | 'modelUsed' | 'expectedModel'>): string {
  if (view.model !== null && view.model !== undefined) return view.model
  const m = view.modelUsed ?? view.expectedModel
  return m !== undefined ? `${m} (default)` : 'default'
}

// ---- Context health ---------------------------------------------------------------------------------------------

/** The context meter's heading word, and its words while the vendor summarises the context. */
export const CONTEXT_WORD = 'Context'
export const SUMMARISING_TEXT = 'Summarising…'
/** The end panel's sections. */
export const CONTEXT_SECTION_TITLE = 'Context'
export const CONTEXT_HEALTH_TITLE = 'Context health'
export const CONTEXT_HEALTH_NONE = 'Nothing made these passes heavier than they needed to be.'
/** Easy mode's heading for the same notes. */
export const EASY_CONTEXT_TITLE = 'Good to know'

/** `1 summary`, `2 summaries`. */
export function summariesText(n: number): string {
  return `${n} ${n === 1 ? 'summary' : 'summaries'}`
}

/** `42k`, `950`: a rough token count for prose ("about 42k tokens"). */
export function aboutTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n)))
}

/**
 * The meter's text: "Context 42%", then " · 2 summaries" once the vendor summarised; "Context n/a" while the window or
 * the use is unknown; "Summarising…" while the vendor summarises.
 */
export function contextMeterText(c: ContextView | undefined): string {
  if (c?.compacting === true) return SUMMARISING_TEXT
  const pct = c?.percent !== undefined ? `${c.percent}%` : 'n/a'
  const tail = c !== undefined && c.compactions > 0 ? ` · ${summariesText(c.compactions)}` : ''
  return `${CONTEXT_WORD} ${pct}${tail}`
}

/** The meter's tooltip: tokens of the window, where the window came from, the peak and the baseline. */
export function contextMeterTitle(c: ContextView | undefined): string {
  if (c === undefined) return 'The vendor has not reported how full its context is yet.'
  const parts: string[] = []
  if (c.used !== undefined && c.window !== undefined)
    parts.push(
      `${c.used.toLocaleString('en-US')} of ${c.window.toLocaleString('en-US')} tokens in the context window`,
    )
  else if (c.used !== undefined)
    parts.push(`${c.used.toLocaleString('en-US')} tokens in context (window size unknown)`)
  if (c.window !== undefined)
    parts.push(c.windowFrom === 'vendor' ? 'window reported by the vendor' : 'window from the model catalog')
  if (c.peakPercent !== undefined) parts.push(`peak ${c.peakPercent}%`)
  if (c.baseline !== undefined) parts.push(`${aboutTokens(c.baseline)} tokens before the task (baseline)`)
  if (c.compactions > 0) parts.push(`summarised ${c.compactions === 1 ? 'once' : `${c.compactions} times`}`)
  return parts.length > 0
    ? `${parts.join(' · ')}.`
    : 'The vendor has not reported how full its context is yet.'
}

/** What a health item suggests, in a short sentence (empty when it suggests nothing). */
export const CONTEXT_SUGGESTION_TEXT: Readonly<Record<ContextSuggestion, string>> = {
  'lower-extensions': 'Lower Extensions for this pass.',
  'trim-memory': 'Shorten it, or move rarely needed parts out of it.',
  'split-task': 'Split the task into smaller runs.',
  'narrow-output': 'Ask for narrower searches or shorter outputs.',
  none: '',
}

/** A health item's words in the end panel (Full mode). */
export function healthItemText(item: ContextHealthItem): string {
  const tokens = aboutTokens(item.tokens ?? 0)
  const count = item.count ?? 0
  switch (item.id) {
    case 'D1': {
      const cmp =
        item.compare !== undefined
          ? ` (${stepLabel(item.compare.step)} started with ${aboutTokens(item.compare.tokens)})`
          : ''
      return `This pass started with about ${tokens} tokens before your task${cmp}.`
    }
    case 'D2':
      return `MCP server ${item.name ?? ''} adds about ${tokens} tokens (${count} ${count === 1 ? 'tool' : 'tools'}) to every request.`
    case 'D3':
      return `${item.fileKind === 'skill' ? 'The skill ' : ''}${item.name ?? 'A file'} is about ${tokens} tokens and loads into every request.`
    case 'D4':
      return item.variant === 'reread'
        ? `The AI read ${item.name ?? 'one file'} ${count} times without changing it.`
        : `The AI ran the same ${item.name ?? 'tool'} call ${count} times.`
    case 'D5':
      return `One ${item.name ?? 'tool'} result was about ${tokens} tokens.`
    case 'D6':
      return `${count} steps without changing a file.`
    case 'D7':
      return `The AI summarised its context ${count === 2 ? 'twice' : `${count} times`} in this pass.`
    case 'D8':
      return `Used ${item.ratio ?? 0} times the usual tokens for ${stepLabel(item.step)}.`
    case 'D9':
      return `The prompt cache kept missing (${item.percent ?? 0}% hits).`
    case 'D10':
      return `Subagents used ${item.percent ?? 0}% of this pass.`
  }
}

/** The same in Easy mode's plain words (several items may read alike: show each sentence once). */
export function easyHealthText(item: ContextHealthItem): string {
  switch (item.id) {
    case 'D1':
    case 'D2':
      return 'Some of your add-ons make each step heavier.'
    case 'D3':
      return item.fileKind === 'skill'
        ? 'Some of your add-ons make each step heavier.'
        : 'A notes file in your project is long, so every step reads a lot.'
    case 'D4':
      return 'The AI kept repeating the same step.'
    case 'D5':
      return 'One step brought back a very long result.'
    case 'D6':
      return 'The AI took many steps without changing anything.'
    case 'D7':
      return `The AI ran low on memory and summarised its notes ${(item.count ?? 0) === 2 ? 'twice' : `${item.count ?? 0} times`}; results may be less reliable.`
    case 'D8':
      return 'This step used more than usual.'
    case 'D9':
      return 'The AI could not reuse its earlier work, so this cost more.'
    case 'D10':
      return 'Helpers did most of the work in one step.'
  }
}

/** Easy mode's notes: each plain sentence once, strong ones first, at most three. */
export function easyHealthNotes(items: readonly ContextHealthItem[]): string[] {
  const out: string[] = []
  for (const i of items) {
    const t = easyHealthText(i)
    if (!out.includes(t)) out.push(t)
    if (out.length === 3) break
  }
  return out
}

/** A contributor in the table: "github MCP 9k", "CLAUDE.md 4k", "linear MCP" when only its name is known. */
export function contributorText(c: ContextContributor): string {
  const kind = c.kind === 'mcp' ? ' MCP' : c.kind === 'skill' ? ' skill' : c.kind === 'agent' ? ' agent' : ''
  return c.from === 'name' ? `${c.name}${kind}` : `${c.name}${kind} ${aboutTokens(c.tokens)}`
}
