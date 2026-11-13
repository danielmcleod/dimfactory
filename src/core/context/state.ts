// A pass's context state, as the run reducer keeps it (StepState.context, persisted in run.json): what the adapter
// reported of the vendor's context window (context, compaction, breakdown and subagent signals), what Dim Factory
// knows of the pass's own setup (ContextFacts, from the controller at spawn) and the tool counters the inefficiency
// detectors read (repeated calls, rereads, steps without a file change, the largest tool output).
// Pure functions over plain data: no I/O, no clock (the reducer passes `at`).
import type {
  ContextBreakdown,
  ContextContributor,
  ContextSummary,
  ContextView,
} from '../../shared/context.ts'
import { CONTEXT_WARN_COMPACTIONS, CONTEXT_WARN_PERCENT, contextPercent } from '../../shared/context.ts'
import type { AdapterSignal, NormalizedEventOf } from '../../shared/events.ts'
import type { ExtensionLevel } from '../../shared/extensions.ts'

/** What the controller knows of a spawn's setup (the `context-facts` engine event). */
export interface ContextFacts {
  /** Dim Factory's own prompt for the spawn (prompt + system append), estimated tokens (bytes / 3.5). */
  promptTokens: number
  /** The window the model catalog or the vendor probe gives for the pass's vendor and model. */
  window?: number
  /** The session continues an earlier one (a resume, Fix reusing Implement's session): no baseline then. */
  resumed: boolean
  /** The pass's Extensions level. */
  extensions?: ExtensionLevel
  /** The project's own memory files the vendor loads (CLAUDE.md, AGENTS.md, GEMINI.md), sized by Dim Factory. */
  projectFiles: ContextContributor[]
  /** The user's MCP servers and skills active for the pass, by name (the existing discovery; no sizes). */
  mcpNames: string[]
  skillNames: string[]
}

/** The tool counters behind `D4` to `D6`. */
export interface ToolTrack {
  /** Tool calls started. */
  calls: number
  /** Calls since the last file change; the longest such stretch. */
  sinceEdit: number
  maxSinceEdit: number
  /** The last fingerprints (a window of {@link LOOP_WINDOW}). */
  recent: string[]
  /** Calls per fingerprint (capped at {@link TRACK_KEYS_MAX} keys). */
  fpCounts: Record<string, number>
  /** Fingerprints seen {@link LOOP_REPEATS}+ times within one window, with the row they belong to. */
  looping: Record<string, { name: string; summary: string }>
  /** Reads per target since the last file change. */
  reads: Record<string, number>
  /** The most reads of one target with no change between them. */
  reread?: { target: string; count: number }
  /** The largest tool output. */
  biggest?: { name: string; summary: string; tokens: number }
  /** Calls per MCP server (the project report's "unused" servers); absent until one is called. */
  mcpCalls?: Record<string, number>
}

/**
 * The MCP server a tool call goes to, from the tool's name: Claude's `mcp__<server>__<tool>`, Codex's
 * `mcp:<server>/<tool>`. Undefined for any other tool.
 */
export function mcpServerOf(name: string): string | undefined {
  const claude = /^mcp__(.+?)__.+$/.exec(name)
  if (claude !== null) return claude[1]
  const codex = /^mcp:([^/]+)\/.+$/.exec(name)
  if (codex !== null) return codex[1]
  return undefined
}

export interface ContextState {
  facts?: ContextFacts
  /** Tokens in context at the latest report. */
  used?: number
  /** The window the vendor reported in this spawn. */
  vendorWindow?: number
  cacheRead?: number
  firstAt?: number
  firstUsed?: number
  lastAt?: number
  peakUsed?: number
  peakPercent?: number
  compactions: number
  failedCompactions?: number
  compacting?: boolean
  baseline?: number
  breakdown?: { start?: ContextBreakdown; end?: ContextBreakdown }
  /** Subagent tokens by the tool row that started each. */
  subagents?: Record<string, number>
  /** What the last `context` run event said (throttling). */
  sent?: { percent?: number; used?: number; window?: number; compactions: number; compacting: boolean }
  tools: ToolTrack
}

export const LOOP_WINDOW = 10
export const LOOP_REPEATS = 3
export const TRACK_KEYS_MAX = 400

export function newContextState(facts?: ContextFacts): ContextState {
  return {
    ...(facts !== undefined ? { facts } : {}),
    compactions: 0,
    tools: { calls: 0, sinceEdit: 0, maxSinceEdit: 0, recent: [], fpCounts: {}, looping: {}, reads: {} },
  }
}

/** The window the meter uses: the vendor's first, then the catalog's. */
export function contextWindowOf(cs: ContextState): { window?: number; from?: 'vendor' | 'catalog' } {
  if (cs.vendorWindow !== undefined) return { window: cs.vendorWindow, from: 'vendor' }
  if (cs.facts?.window !== undefined) return { window: cs.facts.window, from: 'catalog' }
  return {}
}

function noteUsed(cs: ContextState, used: number, at: number): void {
  cs.used = used
  cs.firstAt ??= at
  cs.firstUsed ??= used
  cs.lastAt = at
  cs.peakUsed = Math.max(cs.peakUsed ?? 0, used)
  const p = contextPercent(used, contextWindowOf(cs).window)
  if (p !== undefined) cs.peakPercent = Math.max(cs.peakPercent ?? 0, p)
}

/** A peak recorded before the window was known gets its percent once it is. */
function refreshPeak(cs: ContextState): void {
  const p = contextPercent(cs.peakUsed, contextWindowOf(cs).window)
  if (p !== undefined) cs.peakPercent = Math.max(cs.peakPercent ?? 0, p)
}

/** Apply one context-family adapter signal; returns whether anything changed. */
export function applyContextSignal(cs: ContextState, sig: AdapterSignal, at: number): boolean {
  switch (sig.type) {
    case 'context': {
      if (!(sig.used >= 0)) return false
      if (sig.window !== undefined && sig.window > 0) cs.vendorWindow = sig.window
      // The breakdown's total is the CLI's estimate (live C23b: 38k at the start, 25k at the first request): it shows
      // on the meter only until a request reports, and never sets the peak or the fill rate.
      if (sig.source === 'breakdown') {
        if (cs.used === undefined) cs.used = sig.used
        refreshPeak(cs)
        return true
      }
      if (sig.cacheRead !== undefined) cs.cacheRead = sig.cacheRead
      // The baseline: the first request of a fresh session, less Dim Factory's own prompt.
      if (
        cs.baseline === undefined &&
        cs.firstUsed === undefined &&
        cs.facts !== undefined &&
        !cs.facts.resumed
      )
        cs.baseline = Math.max(0, sig.used - cs.facts.promptTokens)
      noteUsed(cs, sig.used, at)
      refreshPeak(cs)
      return true
    }
    case 'compaction':
      if (sig.phase === 'start') {
        if (cs.compacting === true) return false
        cs.compacting = true
        return true
      }
      cs.compacting = false
      if (sig.failed === true) cs.failedCompactions = (cs.failedCompactions ?? 0) + 1
      else {
        cs.compactions += 1
        if (sig.postTokens !== undefined) {
          cs.used = sig.postTokens
          cs.lastAt = at
        }
      }
      return true
    case 'context-breakdown':
      cs.breakdown = { ...cs.breakdown, [sig.at]: sig.breakdown }
      if (sig.breakdown.window !== undefined && cs.vendorWindow === undefined) {
        cs.vendorWindow = sig.breakdown.window
        refreshPeak(cs)
      }
      return true
    case 'subagent-tokens': {
      const subs = (cs.subagents ??= {})
      if (subs[sig.id] === sig.tokens) return false
      if (subs[sig.id] === undefined && Object.keys(subs).length >= TRACK_KEYS_MAX) return false
      subs[sig.id] = sig.tokens
      return true
    }
    case 'shell-command':
    case 'guardrail-blocked':
    case 'liveness':
    case 'ask-withdrawn':
    case 'allow-rule':
    case 'plan-captured':
    case 'auto-answered':
    case 'meta':
    case 'waiting':
      return false
  }
}

/** Tool names that change files (Claude, Codex `edit`, ACP kinds). */
const FILE_EDIT = /^(?:edit|write|multiedit|notebookedit|apply_patch|filechange|delete|move)$/i

export const isFileEditTool = (name: string): boolean => FILE_EDIT.test(name)

/** What a read tool read (Claude `Read`, ACP kind `read`: the path; Codex: a shell row "Read <path>"). */
export function readTarget(name: string, summary: string): string | undefined {
  if (/^read$/i.test(name)) return summary.trim() !== '' ? summary.trim() : undefined
  if (/^shell$/i.test(name) && summary.startsWith('Read ')) return summary.slice(5).trim() || undefined
  return undefined
}

function bump(map: Record<string, number>, key: string): number {
  if (map[key] === undefined && Object.keys(map).length >= TRACK_KEYS_MAX) return 0
  map[key] = (map[key] ?? 0) + 1
  return map[key]
}

/** A tool event: the `D4` to `D6` counters. */
export function applyToolEvent(cs: ContextState, ev: NormalizedEventOf<'tool'>): void {
  const t = cs.tools
  if (ev.phase === 'end') {
    const tokens = ev.outTokens
    if (tokens !== undefined && tokens > (t.biggest?.tokens ?? 0))
      t.biggest = { name: ev.name, summary: ev.summary, tokens }
    return
  }
  // A start; a subagent's progress repeats its start row: only a call with a fingerprint counts.
  if (ev.phase !== 'start' || ev.fp === undefined) return
  t.calls += 1
  if (isFileEditTool(ev.name)) {
    t.sinceEdit = 0
    t.reads = {}
  } else {
    t.sinceEdit += 1
    t.maxSinceEdit = Math.max(t.maxSinceEdit, t.sinceEdit)
  }
  bump(t.fpCounts, ev.fp)
  const server = mcpServerOf(ev.name)
  if (server !== undefined) bump((t.mcpCalls ??= {}), server)
  t.recent = [...t.recent, ev.fp].slice(-LOOP_WINDOW)
  if (t.looping[ev.fp] === undefined && t.recent.filter((f) => f === ev.fp).length >= LOOP_REPEATS)
    t.looping[ev.fp] = { name: ev.name, summary: ev.summary }
  const target = readTarget(ev.name, ev.summary)
  if (target !== undefined) {
    const n = bump(t.reads, target)
    if (n > (t.reread?.count ?? 0)) t.reread = { target, count: n }
  }
}

/** The repeated call with the most calls (`D4`), when one repeated within a window. */
export function worstLoop(t: ToolTrack): { name: string; summary: string; count: number } | undefined {
  let best: { name: string; summary: string; count: number } | undefined
  for (const [fp, row] of Object.entries(t.looping)) {
    const count = t.fpCounts[fp] ?? 0
    if (best === undefined || count > best.count) best = { ...row, count }
  }
  return best
}

/** StepView.context; undefined while nothing was reported. */
export function contextView(cs: ContextState | undefined): ContextView | undefined {
  if (cs === undefined) return undefined
  const reported = cs.used !== undefined || cs.compactions > 0 || cs.compacting === true
  if (!reported) return undefined
  const { window, from } = contextWindowOf(cs)
  const percent = contextPercent(cs.used, window)
  const v: ContextView = { compactions: cs.compactions }
  if (cs.used !== undefined) v.used = cs.used
  if (window !== undefined) v.window = window
  if (from !== undefined && window !== undefined) v.windowFrom = from
  if (percent !== undefined) v.percent = percent
  if (cs.peakPercent !== undefined) v.peakPercent = cs.peakPercent
  if (cs.compacting === true) v.compacting = true
  if (cs.baseline !== undefined) v.baseline = cs.baseline
  const fill = fillPerMin(cs)
  if (fill !== undefined) v.fillPerMin = fill
  if ((percent ?? 0) >= CONTEXT_WARN_PERCENT || cs.compactions >= CONTEXT_WARN_COMPACTIONS) v.warn = true
  return v
}

/** Tokens per minute the context grew, from the first report to the peak; undefined under 30 s of reports. */
export function fillPerMin(cs: ContextState): number | undefined {
  if (cs.firstAt === undefined || cs.lastAt === undefined || cs.firstUsed === undefined) return undefined
  const minutes = (cs.lastAt - cs.firstAt) / 60_000
  if (minutes < 0.5) return undefined
  return Math.max(0, Math.round(((cs.peakUsed ?? cs.firstUsed) - cs.firstUsed) / minutes))
}

/** RunSummaryStep.context; undefined while nothing was reported. */
export function contextSummary(cs: ContextState | undefined): ContextSummary | undefined {
  const v = contextView(cs)
  if (v === undefined) return undefined
  return {
    compactions: v.compactions,
    ...(v.peakPercent !== undefined ? { peakPercent: v.peakPercent } : {}),
    ...(v.baseline !== undefined ? { baseline: v.baseline } : {}),
  }
}

/**
 * The `context` run event to send now, or undefined (throttled): a percent that moved by a whole point, a compaction
 * that started or ended, the window first known, or the first report. Records what it sends.
 */
export function contextEventDue(
  cs: ContextState,
):
  { used?: number; window?: number; percent?: number; compactions: number; compacting: boolean } | undefined {
  const v = contextView(cs)
  if (v === undefined) return undefined
  const next = {
    ...(v.used !== undefined ? { used: v.used } : {}),
    ...(v.window !== undefined ? { window: v.window } : {}),
    ...(v.percent !== undefined ? { percent: v.percent } : {}),
    compactions: v.compactions,
    compacting: v.compacting === true,
  }
  const s = cs.sent
  const due =
    s === undefined ||
    s.compactions !== next.compactions ||
    s.compacting !== next.compacting ||
    s.window !== next.window ||
    (next.percent !== undefined && (s.percent === undefined || Math.abs(next.percent - s.percent) >= 1)) ||
    (next.percent === undefined && s.used === undefined && next.used !== undefined)
  if (!due) return undefined
  cs.sent = next
  return next
}
