// Settings > Extensions > Context, pure parts: the words for core's Context report (`context.report{folder}`) and for
// the context health options. Every figure is core's; this only words them (no em dashes).
import type { ContextHealthSettings, CompactionReminder } from '@shared/config-schema.ts'
import { CONTEXT_HEALTH_DEFAULTS } from '@shared/config-schema.ts'
import type { ContextRecommendation, ContextReport, ContextReportRow } from '@shared/context.ts'
import { stepLabel } from '../../../lib/format.ts'

export const CONTEXT_GROUP_TITLE = 'Context'
export const CONTEXT_GROUP_DESCRIPTION =
  'What loads into each pass of the chosen project, from its recent runs, and how Dim Factory checks what the AI says it did. These options are saved to your settings, for every project.'

export const GROUNDING_LABEL = 'Grounding checks'
export const GROUNDING_NOTE =
  'After Implement and Fix, compare what the AI says it did with the run: files it named, tests it said it ran, imports and packages it added. No model and no network.'
export const REGISTRY_LABEL = 'Check new packages online'
export const REGISTRY_NOTE =
  'Look up each package a run adds in its public registry (npm, PyPI, crates.io). This uses the network. Off: the check uses your lockfiles only.'
export const JUDGE_LABEL = 'AI judge'
export const JUDGE_NOTE =
  "After Implement, the cheapest model of the Review pass's vendor reads the AI's claims and the change's size, read-only. What it raises is labelled AI-judged and is never must-fix."
export const REMINDER_LABEL = 'Reminder after a summary'
export const REMINDER_NOTE =
  'When the AI summarises its notes to free memory, send it a short reminder of the plan, the criteria and the files changed so far.'

export const REMINDER_OPTIONS: readonly { value: CompactionReminder; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Auto runs only' },
  { value: 'always', label: 'Every run' },
]

/** The option keys this group writes (`/contextHealth/<key>` in the user's settings). */
export type ContextOptionKey = 'grounding' | 'registryCheck' | 'aiJudge' | 'compactionReminder'

/** The options as the resolved config gives them (defaults where it says nothing: an older core). */
export function contextOptionsOf(config: unknown): Pick<ContextHealthSettings, ContextOptionKey> | null {
  if (typeof config !== 'object' || config === null) return null
  const c = (config as { contextHealth?: Partial<ContextHealthSettings> }).contextHealth ?? {}
  const d = CONTEXT_HEALTH_DEFAULTS
  return {
    grounding: c.grounding ?? d.grounding,
    registryCheck: c.registryCheck ?? d.registryCheck,
    aiJudge: c.aiJudge ?? d.aiJudge,
    compactionReminder: c.compactionReminder ?? d.compactionReminder,
  }
}

/** The toast after an option is written. */
export function optionSavedText(key: ContextOptionKey, value: boolean | CompactionReminder): string {
  if (key === 'compactionReminder')
    return `${REMINDER_LABEL}: ${REMINDER_OPTIONS.find((o) => o.value === value)?.label ?? String(value)}`
  const label = key === 'grounding' ? GROUNDING_LABEL : key === 'registryCheck' ? REGISTRY_LABEL : JUDGE_LABEL
  return `${label}: ${value === true ? 'on' : 'off'}`
}

const KIND_LABEL: Readonly<Record<ContextReportRow['kind'], string>> = {
  mcp: 'MCP server',
  skill: 'Skill',
  memory: 'Memory file',
  agent: 'Subagent',
  file: 'File',
}

export function kindLabel(kind: ContextReportRow['kind']): string {
  return KIND_LABEL[kind]
}

/** `~12k tokens`, `~800 tokens`; "Size not known" for 0. */
export function tokensText(n: number): string {
  if (!(n > 0)) return 'Size not known'
  if (n < 1000) return `~${Math.round(n)} tokens`
  return `~${Math.round(n / 1000)}k tokens`
}

const times = (lift: number): string => `${lift.toFixed(1).replace(/\.0$/, '')} times`

/** A lift in words: how often runs with it went wrong against the project's average. */
export function liftText(lift: number | undefined, rate: number | undefined): string {
  if (rate === undefined) return 'Not enough runs'
  if (lift === undefined) return rate > 0 ? 'Only with it' : 'Never'
  if (lift >= 1.5) return `${times(lift)} as often`
  if (lift > 0.8) return 'About as often'
  return lift === 0 ? 'Never' : 'Less often'
}

/** The report's one line (kept on screen while it loads, so nothing below moves). */
export function reportSummaryText(r: ContextReport | null, loading: boolean, error: string | null): string {
  if (error !== null && r === null) return `The report could not be read: ${error}`
  if (r === null) return loading ? 'Reading the recent runs…' : ''
  if (r.runs === 0) return 'No finished runs of this project carry context data yet.'
  const runs = `${r.runs} recent run${r.runs === 1 ? '' : 's'}`
  if (r.runs < r.minRuns) {
    const more = r.minRuns - r.runs
    return `From ${runs}. The comparison with failures starts at ${r.minRuns} runs (${more} more).`
  }
  const n = r.recommendations.length
  return `From ${runs}: ${Math.round((r.failureRate ?? 0) * 100)}% failed or completed with failures, ${Math.round((r.groundingRate ?? 0) * 100)}% had AI claims that did not match the run. ${n === 0 ? 'No suggestions.' : `${n} suggestion${n === 1 ? '' : 's'}.`}`
}

/** One suggestion in plain words. */
export function recommendationText(rec: ContextRecommendation): string {
  switch (rec.kind) {
    case 'heavy-skill':
      return `Skill ${rec.name} adds ${tokensText(rec.tokens)} to every ${stepLabel(rec.step)} pass. Lower Extensions for that pass if it does not need it.`
    case 'big-memory':
      return `${rec.name} is ${tokensText(rec.tokens)} and loads into every pass. A shorter file leaves the AI more room.`
    case 'unused-mcp':
      return `MCP server ${rec.name}: ${rec.tools !== undefined ? `${rec.tools} tool${rec.tools === 1 ? '' : 's'}, ` : ''}unused in the last ${rec.runs} runs.`
    case 'lift':
      return rec.what === 'failures'
        ? `Runs with ${rec.name} failed ${times(rec.lift)} as often as this project's average.`
        : `Runs with ${rec.name} had AI claims that did not match the run ${times(rec.lift)} as often as this project's average.`
  }
}
