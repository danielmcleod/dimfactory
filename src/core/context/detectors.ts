// Inefficiency detectors `D1` to `D10`: pure functions over one pass's context state (and the run's other passes where a
// comparison helps). Each returns health items, never Fix findings: what they find is the user's setup or the pass's
// behaviour, which Fix cannot change. The thresholds are defaults a caller may override.
import type { ContextBreakdown, ContextHealthItem } from '../../shared/context.ts'
import { contextPercent } from '../../shared/context.ts'
import type { Usage } from '../../shared/events.ts'
import type { StepKey } from '../../shared/run.ts'
import { sampleTokens } from '../estimates/estimate.ts'
import type { ContextState } from './state.ts'
import { worstLoop } from './state.ts'

export interface ContextThresholds {
  /** `D1`: tokens in context before the task (or this share of the window). */
  overheadTokens: number
  overheadPercent: number
  /** `D2`: MCP tools (or their tokens) loaded into every request. */
  mcpTools: number
  mcpTokens: number
  /** `D3`: one skill or memory file; strong from the second figure. */
  fileTokens: number
  fileTokensStrong: number
  /** `D4`: the same call this often in one window of 10 (state.ts LOOP_REPEATS marks it); strong from this many in all. */
  loopStrong: number
  /** `D4`: the same file read this often with no change between. */
  rereads: number
  /** `D5`: one tool output. */
  outputTokens: number
  /** `D6`: tool calls in a row without changing a file (mutating passes); strong from the second figure. */
  stepsWithoutChange: number
  stepsWithoutChangeStrong: number
  /** `D7`: compactions in one pass (warn, react). */
  compactionsWarn: number
  compactionsReact: number
  /** `D8`: tokens over the usual high (p80) by this ratio; strong from the second. */
  burnRatio: number
  burnRatioStrong: number
  /** `D9`: prompt cache hits under this share, once the pass sent this many prompt tokens. */
  cacheHitPercent: number
  cacheMinTokens: number
  /** `D10`: subagents' share of the pass's tokens. */
  subagentPercent: number
}

export const DEFAULT_CONTEXT_THRESHOLDS: Readonly<ContextThresholds> = {
  overheadTokens: 30_000,
  overheadPercent: 15,
  mcpTools: 40,
  mcpTokens: 10_000,
  fileTokens: 8_000,
  fileTokensStrong: 20_000,
  loopStrong: 8,
  rereads: 4,
  outputTokens: 25_000,
  stepsWithoutChange: 40,
  stepsWithoutChangeStrong: 80,
  compactionsWarn: 2,
  compactionsReact: 3,
  burnRatio: 1,
  burnRatioStrong: 2,
  cacheHitPercent: 50,
  cacheMinTokens: 20_000,
  subagentPercent: 50,
}

/** One pass as the detectors see it. */
export interface PassContext {
  step: StepKey
  vendor?: string
  /** The pass may change files (Implement, Fix, Tests, Deploy). */
  mutating: boolean
  cs: ContextState
  window?: number
  /** The final attempt's usage. */
  usage?: Usage
  /** The usual high (p80) of this pass's tokens, from past runs (never the priors). */
  p80Tokens?: number
}

type Detector = (p: PassContext, all: readonly PassContext[], t: ContextThresholds) => ContextHealthItem[]

/** The breakdown the pass ended with, else the one it started with. */
export function breakdownOf(cs: ContextState): ContextBreakdown | undefined {
  return cs.breakdown?.end ?? cs.breakdown?.start
}

/** The pass's baseline: measured at its first request, else Claude's start breakdown less Dim Factory's prompt. */
export function baselineOf(cs: ContextState): number | undefined {
  if (cs.baseline !== undefined) return cs.baseline
  const total = cs.breakdown?.start?.total
  if (total === undefined || cs.facts === undefined || cs.facts.resumed) return undefined
  return Math.max(0, total - cs.facts.promptTokens)
}

/** `D1`: a big overhead before the task, compared with a read-only pass at Extensions None of the same run. */
export const d1Overhead: Detector = (p, all, t) => {
  const base = baselineOf(p.cs)
  if (base === undefined) return []
  const percent = contextPercent(base, p.window)
  const over = base > t.overheadTokens || (percent !== undefined && percent > t.overheadPercent)
  if (!over) return []
  const level = p.cs.facts?.extensions
  const other = all.find(
    (o) =>
      o.step !== p.step &&
      o.cs.facts?.extensions === 'none' &&
      baselineOf(o.cs) !== undefined &&
      baselineOf(o.cs)! < base,
  )
  return [
    {
      id: 'D1',
      step: p.step,
      strong: base > 2 * t.overheadTokens,
      suggestion: level !== undefined && level !== 'none' ? 'lower-extensions' : 'trim-memory',
      tokens: base,
      ...(percent !== undefined ? { percent } : {}),
      ...(level !== 'none' && other !== undefined
        ? { compare: { step: other.step, tokens: baselineOf(other.cs)! } }
        : {}),
    },
  ]
}

/** `D2`: too many MCP tools loaded into every request (the vendor's breakdown names the servers). */
export const d2Mcp: Detector = (p, _all, t) => {
  const mcp = breakdownOf(p.cs)?.mcp ?? []
  if (mcp.length === 0) return []
  const tools = mcp.reduce((n, s) => n + (s.tools ?? 0), 0)
  const tokens = mcp.reduce((n, s) => n + s.tokens, 0)
  if (tools <= t.mcpTools && tokens <= t.mcpTokens) return []
  const top = mcp[0]!
  return [
    {
      id: 'D2',
      step: p.step,
      strong: tools > 2 * t.mcpTools || tokens > 2 * t.mcpTokens,
      suggestion: 'lower-extensions',
      name: top.name,
      tokens: top.tokens,
      count: top.tools ?? 0,
    },
  ]
}

/** `D3`: a huge skill or memory file (the vendor's sizes; the project's own files sized by Dim Factory). */
export const d3BigFiles: Detector = (p, _all, t) => {
  const b = breakdownOf(p.cs)
  const files = [...(b?.memory ?? []), ...(b?.skills ?? [])]
  for (const f of p.cs.facts?.projectFiles ?? []) {
    if (!files.some((x) => x.name.toLowerCase() === f.name.toLowerCase())) files.push(f)
  }
  return files
    .filter((f) => f.tokens > t.fileTokens)
    .sort((a, b2) => b2.tokens - a.tokens)
    .slice(0, 3)
    .map((f) => ({
      id: 'D3' as const,
      step: p.step,
      strong: f.tokens > t.fileTokensStrong,
      suggestion: f.kind === 'skill' ? ('lower-extensions' as const) : ('trim-memory' as const),
      name: f.name,
      tokens: f.tokens,
      fileKind: f.kind === 'skill' ? ('skill' as const) : ('memory' as const),
    }))
}

/** `D4`: loops and rereads (the same call repeated within ten calls; the same file read again and again). */
export const d4Loops: Detector = (p, _all, t) => {
  const out: ContextHealthItem[] = []
  const loop = worstLoop(p.cs.tools)
  if (loop !== undefined) {
    out.push({
      id: 'D4',
      step: p.step,
      strong: loop.count >= t.loopStrong,
      suggestion: 'split-task',
      name: loop.name,
      count: loop.count,
      variant: 'loop',
    })
  }
  const reread = p.cs.tools.reread
  if (reread !== undefined && reread.count >= t.rereads) {
    out.push({
      id: 'D4',
      step: p.step,
      strong: reread.count >= 2 * t.rereads,
      suggestion: 'split-task',
      name: reread.target,
      count: reread.count,
      variant: 'reread',
    })
  }
  return out
}

/** `D5`: one tool output far too large for the context. */
export const d5BigOutput: Detector = (p, _all, t) => {
  const big = p.cs.tools.biggest
  if (big === undefined || big.tokens <= t.outputTokens) return []
  return [
    {
      id: 'D5',
      step: p.step,
      strong: big.tokens > 2 * t.outputTokens,
      suggestion: 'narrow-output',
      name: big.name,
      tokens: big.tokens,
    },
  ]
}

/** `D6`: a pass that may change files went many steps without changing one. */
export const d6NoProgress: Detector = (p, _all, t) => {
  const n = p.cs.tools.maxSinceEdit
  if (!p.mutating || n < t.stepsWithoutChange) return []
  return [
    {
      id: 'D6',
      step: p.step,
      strong: n >= t.stepsWithoutChangeStrong,
      suggestion: 'split-task',
      count: n,
    },
  ]
}

/** `D7`: the vendor summarised the context again and again. */
export const d7Compactions: Detector = (p, _all, t) => {
  const n = p.cs.compactions
  if (n < t.compactionsWarn) return []
  return [{ id: 'D7', step: p.step, strong: n >= t.compactionsReact, suggestion: 'split-task', count: n }]
}

/** `D8`: the pass burned more tokens than it usually does (its p80 over past runs). */
export const d8Burn: Detector = (p, _all, t) => {
  if (p.usage === undefined || p.p80Tokens === undefined || !(p.p80Tokens > 0)) return []
  const used = sampleTokens(p.usage)
  const ratio = Math.round((used / p.p80Tokens) * 10) / 10
  if (!(used > p.p80Tokens * t.burnRatio)) return []
  return [
    {
      id: 'D8',
      step: p.step,
      strong: ratio >= t.burnRatioStrong,
      suggestion: 'none',
      tokens: used,
      ratio,
    },
  ]
}

/** `D9`: the prompt cache kept missing. */
export const d9Cache: Detector = (p, _all, t) => {
  const u = p.usage
  if (u === undefined || u.cacheRead === undefined) return []
  const prompt = u.input + u.cacheRead + (u.cacheWrite ?? 0)
  if (prompt < t.cacheMinTokens) return []
  const percent = Math.round((u.cacheRead / prompt) * 100)
  if (percent >= t.cacheHitPercent) return []
  return [
    {
      id: 'D9',
      step: p.step,
      strong: percent < t.cacheHitPercent / 2,
      suggestion: 'none',
      percent,
      tokens: prompt - u.cacheRead,
    },
  ]
}

/** `D10`: subagents used most of the pass. */
export const d10Subagents: Detector = (p, _all, t) => {
  const subs = Object.values(p.cs.subagents ?? {})
  if (subs.length === 0 || p.usage === undefined) return []
  const total = sampleTokens(p.usage)
  if (!(total > 0)) return []
  const sub = subs.reduce((n, x) => n + x, 0)
  const percent = Math.min(100, Math.round((sub / total) * 100))
  if (percent <= t.subagentPercent) return []
  return [
    {
      id: 'D10',
      step: p.step,
      strong: percent >= 80,
      suggestion: 'none',
      percent,
      count: subs.length,
    },
  ]
}

export const DETECTORS: readonly Detector[] = [
  d1Overhead,
  d2Mcp,
  d3BigFiles,
  d4Loops,
  d5BigOutput,
  d6NoProgress,
  d7Compactions,
  d8Burn,
  d9Cache,
  d10Subagents,
]

/** Every detector over every pass, strong items first, then in the passes' order. */
export function detectAll(
  passes: readonly PassContext[],
  thresholds: Partial<ContextThresholds> = {},
): ContextHealthItem[] {
  const t = { ...DEFAULT_CONTEXT_THRESHOLDS, ...thresholds }
  const items = passes.flatMap((p) => DETECTORS.flatMap((d) => d(p, passes, t)))
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => Number(b.item.strong) - Number(a.item.strong) || a.i - b.i)
    .map((x) => x.item)
}
