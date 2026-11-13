// Context health: how full a pass's context window is, when the vendor CLI summarised it (compaction), and what
// makes a pass heavier than it needs to be (inefficiency detectors `D1` to `D10`). Dim Factory never compacts anything
// itself: the vendor CLIs own their sessions; this is what core observes of them, as plain data.
// Names of skills, MCP servers, subagents and memory files are the user's data: they may reach the renderer and the
// run's own history (context-health.json), never Dim Factory's logs, diagnostics or the self-heal input.
import type { ExtensionLevel } from './extensions.ts'
import type { StepKey } from './run.ts'

/**
 * What a `context` signal's `used` measures:
 * - `request`: the prompt of the latest main-thread model request (Claude's assistant `message.usage`, deduped by
 *   message id; Codex `tokenUsage.last`; Muse's per-call usage);
 * - `session`: the vendor's own report of the session's context (ACP `usage_update`, Claude's result `modelUsage`
 *   window);
 * - `breakdown`: Claude's `get_context_usage` answer (its estimate; the window is what Dim Factory keeps from it).
 */
export const CONTEXT_SOURCES = ['request', 'session', 'breakdown'] as const
export type ContextSource = (typeof CONTEXT_SOURCES)[number]

/** Bytes per token for Dim Factory's own estimates (the prompt patch budget uses the same figure). */
export const BYTES_PER_TOKEN = 3.5

/** Estimated tokens of a text of `bytes` UTF-8 bytes. */
export function tokensFromBytes(bytes: number): number {
  return Math.max(0, Math.round(bytes / BYTES_PER_TOKEN))
}

/** The meter turns amber from this share of the window. */
export const CONTEXT_WARN_PERCENT = 80
/** ... or from this many compactions in the pass. */
export const CONTEXT_WARN_COMPACTIONS = 2

/** `round(used / window * 100)`, kept between 0 and 999; undefined without both. */
export function contextPercent(used: number | undefined, window: number | undefined): number | undefined {
  if (used === undefined || window === undefined || !(window > 0) || !(used >= 0)) return undefined
  return Math.min(999, Math.round((used / window) * 100))
}

/** StepView.context: the pass's context meter (core-derived; the renderer only formats it). */
export interface ContextView {
  /** Tokens in the context at the latest model request; absent until the vendor reports one. */
  used?: number
  /** The context window; absent when neither the vendor nor the catalog knows it (the meter reads "n/a"). */
  window?: number
  /** Where the window came from: the vendor's own report first, else the model catalog or the probe. */
  windowFrom?: 'vendor' | 'catalog'
  /** used / window, rounded; absent while either is unknown. */
  percent?: number
  /** The highest percent this pass reached. */
  peakPercent?: number
  /** Compactions the vendor reported in this pass ("summaries"). */
  compactions: number
  /** The vendor is summarising the context now ("Summarising…"). */
  compacting?: true
  /** Tokens in the context before the task: the first request's prompt minus Dim Factory's own prompt. */
  baseline?: number
  /** Tokens the context grew per minute of the pass so far (absent until two reports). */
  fillPerMin?: number
  /** Amber: at or past {@link CONTEXT_WARN_PERCENT}, or {@link CONTEXT_WARN_COMPACTIONS} compactions. */
  warn?: true
}

/** RunSummaryStep.context: what the run history keeps of a pass's context (no names). */
export interface ContextSummary {
  peakPercent?: number
  compactions: number
  baseline?: number
}

/** One contributor to a pass's context, as the vendor (or Dim Factory's estimate) sizes it. */
export interface ContextContributor {
  kind: 'mcp' | 'skill' | 'memory' | 'agent' | 'file'
  /** The user's name for it (a server, a skill, a subagent, a memory file's name without its folder). */
  name: string
  tokens: number
  /** MCP: the server's tool count. */
  tools?: number
  /** MCP: the calls the pass made to the server (0: loaded but unused); absent when not counted. */
  calls?: number
  /**
   * Where the figure comes from: the vendor's breakdown, Dim Factory's size estimate (bytes / 3.5), or `name` when only
   * the name is known (the vendor's settings list it; `tokens` is then 0 and means unknown).
   */
  from: 'vendor' | 'estimate' | 'name'
}

/** Claude's `get_context_usage` answer, as core keeps it (summary detail; no paths, no tool names). */
export interface ContextBreakdown {
  /** The CLI's own estimate of the tokens in context. */
  total?: number
  /** The window it measures against. */
  window?: number
  percent?: number
  autoCompactAt?: number
  skills: ContextContributor[]
  mcp: ContextContributor[]
  memory: ContextContributor[]
  agents: ContextContributor[]
}

export const CONTEXT_DETECTORS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'] as const
export type ContextDetectorId = (typeof CONTEXT_DETECTORS)[number]

/** What a health item suggests (the renderer words it; core never acts on it). */
export type ContextSuggestion = 'lower-extensions' | 'trim-memory' | 'split-task' | 'narrow-output' | 'none'

/**
 * One health item: an inefficiency a detector found in a pass. These are facts about the user's setup and the
 * pass's behaviour, never Fix findings (Fix cannot fix a user's skill). Every figure the copy names is here.
 */
export interface ContextHealthItem {
  id: ContextDetectorId
  step: StepKey
  /** Past the strong threshold (or the reaction level). */
  strong: boolean
  suggestion: ContextSuggestion
  /** Tokens the item is about (baseline, a server's tools, a file, a tool output, the pass's burn). */
  tokens?: number
  /** A share in percent (of the window, of hits, of the pass). */
  percent?: number
  /** A count (tools, repeats, steps, compactions). */
  count?: number
  /** A ratio (burn vs the usual high). */
  ratio?: number
  /** The user's name it is about (an MCP server, a memory file) or the tool's name. */
  name?: string
  /** `D1`: the read-only pass at Extensions None it compares with. */
  compare?: { step: StepKey; tokens: number }
  /** `D4`: a repeated call (`loop`, `name` is the tool) or a file read again and again (`reread`, `name` is the file). */
  variant?: 'loop' | 'reread'
  /** `D3`: what the big file is (a skill, or a memory file such as CLAUDE.md). */
  fileKind?: 'skill' | 'memory'
}

/** One pass's row of the Context health table. */
export interface ContextPassRow {
  step: StepKey
  vendor?: string
  peakPercent?: number
  compactions: number
  baseline?: number
  window?: number
  extensions?: ExtensionLevel
  /** The largest contributors, biggest first (at most five). */
  contributors: ContextContributor[]
}

/** ContextHealthReport.grounding: the run's grounding findings (no titles, no names). */
export interface ContextGroundingCounts {
  /** Findings from the grounding checks, or a reviewer's marked `(grounding)`. */
  findings: number
  /** Of those, `[must]`. */
  musts: number
  /** Findings (any source) flagged as a possible hallucination. */
  hallucinations: number
}

/** runs/<id>/context-health.json and RunSnapshot.contextHealth. */
export interface ContextHealthReport {
  version: 1
  passes: ContextPassRow[]
  items: ContextHealthItem[]
  /** The run's grounding counts; absent in a report written before they existed. */
  grounding?: ContextGroundingCounts
}

// ---- the project's Context report (`context.report{folder}`, Settings > Extensions) --------------------------------

/** Runs a project needs (each with its context-health.json) before the report compares contributors with failures. */
export const CONTEXT_REPORT_MIN_RUNS = 5
/** The most recent runs the report reads. */
export const CONTEXT_REPORT_MAX_RUNS = 30
/** "Unused in the last N runs": an MCP server loaded in each of the last N runs and called in none of them. */
export const CONTEXT_REPORT_UNUSED_RUNS = 10

/** One contributor across the project's recent runs. */
export interface ContextReportRow {
  /** A hash of its kind and name (sha256, 12 hex): the key core uses for it anywhere but the renderer. */
  key: string
  kind: ContextContributor['kind']
  /** The user's name for it (shown in the app only). */
  name: string
  /** Its typical size (the median of the passes that sized it); 0 when no pass did. */
  tokens: number
  /** MCP: its tool count, when known. */
  tools?: number
  /** Runs it loaded into. */
  runs: number
  /** The passes it loaded into, in run order. */
  steps: StepKey[]
  /** MCP: calls over those runs (absent when no run counted them). */
  calls?: number
  /** Share of its runs that failed or completed with failures, and that rate over the project's (lift). */
  failureRate?: number
  failureLift?: number
  /** Share of its runs with grounding findings, and that rate over the project's. */
  groundingRate?: number
  groundingLift?: number
}

/** What the report suggests about one contributor (the renderer words it). */
export type ContextRecommendation =
  /** A skill that adds its tokens to most passes of a kind. */
  | { kind: 'heavy-skill'; key: string; name: string; tokens: number; step: StepKey }
  /** A memory file (CLAUDE.md, AGENTS.md...) that is large. */
  | { kind: 'big-memory'; key: string; name: string; tokens: number }
  /** An MCP server loaded in each of the last `runs` runs and called in none. */
  | { kind: 'unused-mcp'; key: string; name: string; tools?: number; runs: number }
  /** Runs with this contributor fail (or need grounding fixes) `lift` times as often as the project's. */
  | { kind: 'lift'; key: string; name: string; what: 'failures' | 'grounding'; lift: number }

/** `context.report{folder}`: the project's contributors over its recent runs. */
export interface ContextReport {
  folder: string
  /** Ended runs of the project read (each with its context-health.json), at most CONTEXT_REPORT_MAX_RUNS. */
  runs: number
  /** Correlation needs this many runs; below it no rates or lifts are given. */
  minRuns: number
  /** The project's own rates over those runs (absent below minRuns). */
  failureRate?: number
  groundingRate?: number
  /** Biggest first. */
  rows: ContextReportRow[]
  recommendations: ContextRecommendation[]
}
