// How deep a run goes (adaptive depth): Quick (one strong build session in the vendor's own harness, then Dim Factory's
// checks and one independent review; Fix only when something real fails) or Thorough (the profile's full pipeline:
// plan, build, two reviewers and fixes). The `depth` config key is `auto` by default: core decides from the task, the
// folder, Easy or Full, the Brief and what the idea needs, with no model call (core/depth/classify.ts), and the user can
// always force either. An explicit profile choice keeps that profile's own pipeline. Core decides; the renderer and the
// CLI only show the decision and send the user's choice.

/** The `depth` config key: decide per run (the default), or always Quick, or always Thorough. */
export const DEPTH_SETTINGS = ['auto', 'direct', 'full'] as const
export type DepthSetting = (typeof DEPTH_SETTINGS)[number]
export const DEFAULT_DEPTH: DepthSetting = 'auto'

/** What a run does: Quick (direct) or Thorough (the full pipeline). */
export const DEPTHS = ['direct', 'full'] as const
export type Depth = (typeof DEPTHS)[number]

/**
 * Who decided: `auto` (the classifier), `chosen` (the user forced it: the composer, the Easy confirm screen or a config
 * file), `profile` (an explicit profile choice: that profile's own pipeline runs as it is).
 */
export const DEPTH_SOURCES = ['auto', 'chosen', 'profile'] as const
export type DepthSource = (typeof DEPTH_SOURCES)[number]

/** What the classifier saw (the reason names the first that decided). */
export const DEPTH_SIGNALS = [
  'risky',
  'new-project',
  'beginner-new',
  'needs',
  'test-first',
  'large-refactor',
  'large-task',
  'large-repo',
  'small-change',
] as const
export type DepthSignal = (typeof DEPTH_SIGNALS)[number]

export interface DepthDecision {
  depth: Depth
  source: DepthSource
  /** One plain sentence, no em dashes ("A small change to an existing project."). */
  reason: string
  /** The classifier's signals (empty for a choice or a profile). */
  signals: DepthSignal[]
  /** The profile that decided, for `source: 'profile'`. */
  profile?: string
}

/** The short names the controls show. */
export const DEPTH_LABEL: Readonly<Record<Depth, string>> = {
  direct: 'Quick',
  full: 'Thorough',
}

/** One line per depth, as the composer and the Easy confirm screen describe it. */
export const DEPTH_SUMMARY: Readonly<Record<Depth, string>> = {
  direct: 'Quick: one strong session plus checks',
  full: 'Thorough: plan, build, two reviewers and fixes',
}

/** The choice control's options, in order. */
export const DEPTH_CHOICES: readonly { value: DepthSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'direct', label: DEPTH_LABEL.direct },
  { value: 'full', label: DEPTH_LABEL.full },
]

/** The decision as one line: "Quick: one strong session plus checks. A small change to an existing project." */
export function depthLine(d: Pick<DepthDecision, 'depth' | 'reason' | 'source' | 'profile'>): string {
  if (d.source === 'profile')
    return `Profile ${d.profile ?? ''}: its own passes. ${d.reason}`.replace(/\s+/g, ' ')
  return `${DEPTH_SUMMARY[d.depth]}. ${d.reason}`
}

export function isDepthSetting(v: unknown): v is DepthSetting {
  return typeof v === 'string' && (DEPTH_SETTINGS as readonly string[]).includes(v)
}

/** What a run records about its depth (RunConfig.depth, RunSnapshot.depth): the decision and an escalation. */
export interface RunDepthView {
  depth: Depth
  source: DepthSource
  reason: string
  /** A Quick run whose check failed switched to thorough checks: why (absent: it did not). */
  escalated?: string
}

/** The note a Quick run adds when a failed check makes it switch to thorough checks (no em dashes). */
export const DEPTH_ESCALATED_NOTE = (what: string): string =>
  `A check failed (${what}), so this Quick run switched to thorough checks: a second reviewer joins and Fix repeats until the checks pass.`
