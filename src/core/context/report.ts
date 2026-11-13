// The project's Context report (`context.report{folder}`, Settings > Extensions): the contributors to its passes'
// context over its most recent ended runs (each run's context-health.json), how often runs with each one failed or
// needed grounding fixes against the project's own rates, and what to do about the heavy or unused ones. Pure over the
// runs' summaries and reports; reading them is the caller's (readContextReport).
// Names are the user's data: they are in the answer for the app to show, and nowhere else. Anything core keeps or logs
// about a contributor uses its key (a hash of its kind and name).
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  ContextContributor,
  ContextHealthReport,
  ContextRecommendation,
  ContextReport,
  ContextReportRow,
} from '../../shared/context.ts'
import {
  CONTEXT_REPORT_MAX_RUNS,
  CONTEXT_REPORT_MIN_RUNS,
  CONTEXT_REPORT_UNUSED_RUNS,
} from '../../shared/context.ts'
import type { RunOutcome, RunSummary, StepKey } from '../../shared/run.ts'

/** A skill this large (tokens) in most passes of a kind is worth naming. */
export const HEAVY_SKILL_TOKENS = 8_000
/** A memory file this large is worth naming. */
export const BIG_MEMORY_TOKENS = 8_000
/** A lift at least this, over at least LIFT_MIN_RUNS runs with the contributor, is worth naming. */
export const LIFT_NOTABLE = 1.5
export const LIFT_MIN_RUNS = 3

/** The contributor's key: sha256 of its kind and name, 12 hex. */
export function contributorKey(c: Pick<ContextContributor, 'kind' | 'name'>): string {
  return createHash('sha256').update(`${c.kind}\n${c.name}`, 'utf8').digest('hex').slice(0, 12)
}

const FAILED_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
  'failed',
  'verify-failed',
  'security-open',
  'fix-stopped',
  'gates-failed',
])

/** The run failed, or completed with failures. */
export function runFailed(s: Pick<RunSummary, 'status' | 'outcome'>): boolean {
  return s.status === 'failed' || (s.outcome !== undefined && FAILED_OUTCOMES.has(s.outcome))
}

/** The run's grounding checks (or a reviewer) found that the AI's claims did not match the run. */
export function runHadGrounding(r: Pick<ContextHealthReport, 'grounding'>): boolean {
  return (r.grounding?.findings ?? 0) > 0 || (r.grounding?.hallucinations ?? 0) > 0
}

/** One ended run with its report. */
export interface ReportRun {
  summary: RunSummary
  health: ContextHealthReport
}

const round2 = (n: number): number => Math.round(n * 100) / 100

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

interface Acc {
  key: string
  kind: ContextContributor['kind']
  name: string
  sizes: number[]
  tools?: number
  runIds: Set<string>
  steps: StepKey[]
  /** Passes per step it loaded into. */
  perStep: Map<StepKey, number>
  calls?: number
  /** Run ids (newest first order of `runs`) where it was loaded, with whether that run called it (undefined: not counted). */
  called: Map<string, boolean | undefined>
}

/** The project's report from its ended runs (newest first or not: they are ordered here) and their reports. */
export function buildContextReport(folder: string, input: readonly ReportRun[]): ContextReport {
  const runs = [...input]
    .sort((a, b) => (b.summary.endedAt ?? b.summary.createdAt) - (a.summary.endedAt ?? a.summary.createdAt))
    .slice(0, CONTEXT_REPORT_MAX_RUNS)
  const enough = runs.length >= CONTEXT_REPORT_MIN_RUNS
  const failedIds = new Set(runs.filter((r) => runFailed(r.summary)).map((r) => r.summary.runId))
  const groundIds = new Set(runs.filter((r) => runHadGrounding(r.health)).map((r) => r.summary.runId))
  const failureRate = runs.length > 0 ? failedIds.size / runs.length : 0
  const groundingRate = runs.length > 0 ? groundIds.size / runs.length : 0
  // Passes per step over all runs (the "every Implement pass" of a recommendation).
  const stepPasses = new Map<StepKey, number>()

  const byKey = new Map<string, Acc>()
  for (const r of runs) {
    const id = r.summary.runId
    for (const p of r.health.passes) {
      stepPasses.set(p.step, (stepPasses.get(p.step) ?? 0) + 1)
      for (const c of p.contributors) {
        const key = contributorKey(c)
        let a = byKey.get(key)
        if (a === undefined) {
          a = {
            key,
            kind: c.kind,
            name: c.name,
            sizes: [],
            runIds: new Set(),
            steps: [],
            perStep: new Map(),
            called: new Map(),
          }
          byKey.set(key, a)
        }
        if (c.tokens > 0) a.sizes.push(c.tokens)
        if (c.tools !== undefined) a.tools = Math.max(a.tools ?? 0, c.tools)
        a.runIds.add(id)
        if (!a.steps.includes(p.step)) a.steps.push(p.step)
        a.perStep.set(p.step, (a.perStep.get(p.step) ?? 0) + 1)
        if (c.calls !== undefined) {
          a.calls = (a.calls ?? 0) + c.calls
          a.called.set(id, (a.called.get(id) ?? false) || c.calls > 0)
        } else if (!a.called.has(id)) a.called.set(id, undefined)
      }
    }
  }

  const rows: ContextReportRow[] = []
  for (const a of byKey.values()) {
    const row: ContextReportRow = {
      key: a.key,
      kind: a.kind,
      name: a.name,
      tokens: median(a.sizes),
      runs: a.runIds.size,
      steps: a.steps,
    }
    if (a.tools !== undefined) row.tools = a.tools
    if (a.calls !== undefined) row.calls = a.calls
    if (enough) {
      const ids = [...a.runIds]
      const fr = ids.filter((x) => failedIds.has(x)).length / ids.length
      const gr = ids.filter((x) => groundIds.has(x)).length / ids.length
      row.failureRate = round2(fr)
      row.groundingRate = round2(gr)
      if (failureRate > 0) row.failureLift = round2(fr / failureRate)
      if (groundingRate > 0) row.groundingLift = round2(gr / groundingRate)
    }
    rows.push(row)
  }
  rows.sort((x, y) => y.tokens - x.tokens || y.runs - x.runs || (x.name < y.name ? -1 : 1))

  const recs: ContextRecommendation[] = []
  for (const a of byKey.values()) {
    const tokens = median(a.sizes)
    if (a.kind === 'skill' && tokens >= HEAVY_SKILL_TOKENS) {
      // The pass kind it loads into most, when it is in most passes of that kind.
      let best: { step: StepKey; n: number } | undefined
      for (const [step, n] of a.perStep) if (best === undefined || n > best.n) best = { step, n }
      if (best !== undefined && best.n * 2 >= (stepPasses.get(best.step) ?? 0))
        recs.push({ kind: 'heavy-skill', key: a.key, name: a.name, tokens, step: best.step })
    }
    if (a.kind === 'memory' && tokens >= BIG_MEMORY_TOKENS)
      recs.push({ kind: 'big-memory', key: a.key, name: a.name, tokens })
    if (a.kind === 'mcp') {
      // Loaded in each of the last N runs, counted, and called in none of them.
      const lastN = runs.slice(0, CONTEXT_REPORT_UNUSED_RUNS).map((r) => r.summary.runId)
      const seen = lastN.length >= Math.min(CONTEXT_REPORT_UNUSED_RUNS, CONTEXT_REPORT_MIN_RUNS)
      const all = lastN.every((id) => a.called.get(id) === false)
      if (seen && all) {
        const rec: ContextRecommendation = {
          kind: 'unused-mcp',
          key: a.key,
          name: a.name,
          runs: lastN.length,
        }
        if (a.tools !== undefined) rec.tools = a.tools
        recs.push(rec)
      }
    }
  }
  if (enough) {
    for (const row of rows) {
      if (row.runs < LIFT_MIN_RUNS || row.runs === runs.length) continue
      if ((row.failureLift ?? 0) >= LIFT_NOTABLE)
        recs.push({ kind: 'lift', key: row.key, name: row.name, what: 'failures', lift: row.failureLift! })
      if ((row.groundingLift ?? 0) >= LIFT_NOTABLE)
        recs.push({ kind: 'lift', key: row.key, name: row.name, what: 'grounding', lift: row.groundingLift! })
    }
  }

  const report: ContextReport = {
    folder,
    runs: runs.length,
    minRuns: CONTEXT_REPORT_MIN_RUNS,
    rows,
    recommendations: recs,
  }
  if (enough) {
    report.failureRate = round2(failureRate)
    report.groundingRate = round2(groundingRate)
  }
  return report
}

/** The same folder, as two paths name it (Windows: case does not matter). */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * Read the project's ended runs (the history's summaries for `folder`) with their context-health.json, newest first,
 * and build the report. A run without a readable report is left out. `runDir` gives runs/<id>.
 */
export async function readContextReport(
  folder: string,
  summaries: readonly RunSummary[],
  runDir: (runId: string) => string,
): Promise<ContextReport> {
  const ended = summaries
    .filter((s) => sameFolder(s.folder, folder))
    .filter((s) => s.status === 'completed' || s.status === 'failed')
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
  const out: ReportRun[] = []
  for (const s of ended) {
    if (out.length >= CONTEXT_REPORT_MAX_RUNS) break
    const health = await readHealth(join(runDir(s.runId), 'context-health.json'))
    if (health !== undefined) out.push({ summary: s, health })
  }
  return buildContextReport(folder, out)
}

async function readHealth(path: string): Promise<ContextHealthReport | undefined> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof v !== 'object' || v === null) return undefined
    const r = v as Partial<ContextHealthReport>
    if (r.version !== 1 || !Array.isArray(r.passes)) return undefined
    const passes = r.passes.filter(
      (p) =>
        typeof p === 'object' && p !== null && Array.isArray((p as { contributors?: unknown }).contributors),
    )
    return { ...(r as ContextHealthReport), passes, items: Array.isArray(r.items) ? r.items : [] }
  } catch {
    return undefined
  }
}
