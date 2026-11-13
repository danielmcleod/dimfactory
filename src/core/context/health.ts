// The run's context health: per pass its peak, compactions, baseline and top contributors, and the health items the
// detectors find (runs/<id>/context-health.json and RunSnapshot.contextHealth). Pure: built from the run state and
// the estimate frozen at its start.
import type {
  ContextContributor,
  ContextGroundingCounts,
  ContextHealthReport,
  ContextPassRow,
} from '../../shared/context.ts'
import type { RunEstimate } from '../../shared/estimates.ts'
import { AGENT_STEPS } from '../../shared/run.ts'
import type { AgentStep } from '../../shared/run.ts'
import type { RunState } from '../supervisor/types.ts'
import type { ContextThresholds, PassContext } from './detectors.ts'
import { baselineOf, breakdownOf, detectAll } from './detectors.ts'
import { contextView, contextWindowOf } from './state.ts'
import type { ContextState } from './state.ts'

/** Passes that may change files (the detectors' "no progress" applies to them alone). */
const MUTATING: ReadonlySet<AgentStep> = new Set(['implement', 'fix', 'tests', 'deploy'])

const CONTRIBUTORS_MAX = 5

/**
 * A pass's largest contributors: the vendor's breakdown (Claude), then the project's memory files Dim Factory sized,
 * then the names the vendor's settings list for the pass (Codex, Gemini: no sizes).
 */
export function contributorsOf(cs: ContextState): ContextContributor[] {
  const b = breakdownOf(cs)
  const out: ContextContributor[] = [
    ...(b?.mcp ?? []),
    ...(b?.skills ?? []),
    ...(b?.memory ?? []),
    ...(b?.agents ?? []),
  ]
  for (const f of cs.facts?.projectFiles ?? []) {
    if (!out.some((x) => x.kind === 'memory' && x.name.toLowerCase() === f.name.toLowerCase())) out.push(f)
  }
  const sized = out
    .filter((c) => c.tokens > 0)
    .sort((a, c) => c.tokens - a.tokens)
    .map((c) => withCalls(cs, c))
  if (b === undefined) {
    for (const name of cs.facts?.mcpNames ?? [])
      sized.push(withCalls(cs, { kind: 'mcp', name, tokens: 0, from: 'name' }))
    for (const name of cs.facts?.skillNames ?? [])
      sized.push({ kind: 'skill', name, tokens: 0, from: 'name' })
  }
  return sized.slice(0, CONTRIBUTORS_MAX)
}

/**
 * An MCP contributor with the pass's calls to its server (0: loaded but never called). Counted only once the pass ran
 * a tool at all: a pass with no tool calls says nothing about its servers.
 */
function withCalls(cs: ContextState, c: ContextContributor): ContextContributor {
  if (c.kind !== 'mcp' || !(cs.tools.calls > 0)) return c
  return { ...c, calls: cs.tools.mcpCalls?.[c.name] ?? 0 }
}

/** The run's grounding counts from its findings (counts only: no titles, no names). */
export function groundingCounts(s: RunState): ContextGroundingCounts {
  const list = s.findings?.list ?? []
  const grounding = list.filter((f) => f.source === 'grounding' || f.flags.includes('grounding'))
  return {
    findings: grounding.length,
    musts: grounding.filter((f) => f.severity === 'must').length,
    hallucinations: list.filter((f) => f.flags.includes('possible-hallucination')).length,
  }
}

/** The passes of the run that reported their context, in run order. */
export function passContexts(s: RunState, estimate?: RunEstimate | null): PassContext[] {
  const out: PassContext[] = []
  for (const k of AGENT_STEPS) {
    const st = s.steps[k]
    const cs = st.context
    if (cs === undefined || st.attempt === 0) continue
    if (contextView(cs) === undefined && cs.facts === undefined) continue
    const est = estimate?.steps[k]
    const p80 = est !== undefined && est.samples > 0 ? est.tokens?.p80 : undefined
    const { window } = contextWindowOf(cs)
    out.push({
      step: k,
      ...(st.vendor !== undefined ? { vendor: st.vendor } : {}),
      mutating: MUTATING.has(k),
      cs,
      ...(window !== undefined ? { window } : {}),
      ...(st.usage !== undefined ? { usage: st.usage } : {}),
      ...(p80 !== undefined ? { p80Tokens: p80 } : {}),
    })
  }
  return out
}

/** The report; undefined when no pass reported anything about its context. */
export function buildContextHealth(
  s: RunState,
  estimate?: RunEstimate | null,
  thresholds: Partial<ContextThresholds> = {},
): ContextHealthReport | undefined {
  const passes = passContexts(s, estimate)
  if (passes.length === 0) return undefined
  const rows: ContextPassRow[] = passes.map((p) => {
    const v = contextView(p.cs)
    const baseline = baselineOf(p.cs)
    return {
      step: p.step,
      ...(p.vendor !== undefined ? { vendor: p.vendor } : {}),
      ...(v?.peakPercent !== undefined ? { peakPercent: v.peakPercent } : {}),
      compactions: p.cs.compactions,
      ...(baseline !== undefined ? { baseline } : {}),
      ...(p.window !== undefined ? { window: p.window } : {}),
      ...(p.cs.facts?.extensions !== undefined ? { extensions: p.cs.facts.extensions } : {}),
      contributors: contributorsOf(p.cs),
    }
  })
  return {
    version: 1,
    passes: rows,
    items: detectAll(passes, thresholds),
    grounding: groundingCounts(s),
  }
}
