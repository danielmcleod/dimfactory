// The project's Context report (src/core/context/report.ts, `context.report{folder}`): contributors keyed by a hash,
// the five-run gate before any rate, lift over the project's own rates, the recommendations (a heavy skill, a big
// memory file, an MCP server loaded and never called, a notable lift), and reading the runs' context-health.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildContextReport,
  contributorKey,
  readContextReport,
  runFailed,
  runHadGrounding,
} from '@core/context/report.ts'
import type { ReportRun } from '@core/context/report.ts'
import { createHandlers, dispatch } from '@core/handlers.ts'
import type { HandlerContext } from '@core/handlers.ts'
import type { DashboardDeps } from '@core/handlers-dashboard.ts'
import type { ContextContributor, ContextHealthReport } from '@shared/context.ts'
import type { RunSummary, StepKey } from '@shared/run.ts'
import { run } from '../estimates/helpers.ts'

const skill = (name: string, tokens: number): ContextContributor => ({
  kind: 'skill',
  name,
  tokens,
  from: 'vendor',
})
const mem = (name: string, tokens: number): ContextContributor => ({
  kind: 'memory',
  name,
  tokens,
  from: 'estimate',
})
const mcp = (name: string, tokens: number, tools: number, calls?: number): ContextContributor => ({
  kind: 'mcp',
  name,
  tokens,
  tools,
  from: 'vendor',
  ...(calls !== undefined ? { calls } : {}),
})

const health = (
  passes: { step: StepKey; contributors: ContextContributor[] }[],
  grounding = 0,
): ContextHealthReport => ({
  version: 1,
  passes: passes.map((p) => ({ ...p, compactions: 0 })),
  items: [],
  grounding: { findings: grounding, musts: grounding, hallucinations: 0 },
})

const ok = (h: ContextHealthReport, over: Partial<RunSummary> = {}): ReportRun => ({
  summary: run([], over),
  health: h,
})
const failed = (h: ContextHealthReport): ReportRun => ok(h, { status: 'failed', outcome: 'failed' })

describe('contributor keys', () => {
  it('hash the kind and the name (12 hex), so the same name of another kind is another key', () => {
    const k = contributorKey({ kind: 'skill', name: 'deploy' })
    expect(k).toMatch(/^[0-9a-f]{12}$/)
    expect(contributorKey({ kind: 'skill', name: 'deploy' })).toBe(k)
    expect(contributorKey({ kind: 'mcp', name: 'deploy' })).not.toBe(k)
    expect(k).not.toContain('deploy')
  })
})

describe('what counts as failed and as grounding', () => {
  it('a failed run or one that completed with failures; a run with grounding findings or hallucinations', () => {
    expect(runFailed({ status: 'failed' })).toBe(true)
    expect(runFailed({ status: 'completed', outcome: 'verify-failed' })).toBe(true)
    expect(runFailed({ status: 'completed', outcome: 'fix-stopped' })).toBe(true)
    expect(runFailed({ status: 'completed', outcome: 'fixed' })).toBe(false)
    expect(runFailed({ status: 'completed', outcome: 'findings-open' })).toBe(false)
    expect(runHadGrounding({ grounding: { findings: 1, musts: 0, hallucinations: 0 } })).toBe(true)
    expect(runHadGrounding({ grounding: { findings: 0, musts: 0, hallucinations: 2 } })).toBe(true)
    expect(runHadGrounding({})).toBe(false)
  })
})

describe('buildContextReport', () => {
  it('below five runs: rows and sizes, no rates and no lifts', () => {
    const runs = [1, 2, 3, 4].map(() =>
      ok(health([{ step: 'implement', contributors: [skill('deploy', 9_000)] }])),
    )
    const r = buildContextReport('C:\\work\\app', runs)
    expect(r.runs).toBe(4)
    expect(r.minRuns).toBe(5)
    expect(r.failureRate).toBeUndefined()
    expect(r.rows).toEqual([
      {
        key: contributorKey({ kind: 'skill', name: 'deploy' }),
        kind: 'skill',
        name: 'deploy',
        tokens: 9_000,
        runs: 4,
        steps: ['implement'],
      },
    ])
    expect(r.recommendations.some((x) => x.kind === 'lift')).toBe(false)
  })

  it('from five runs: the project rates and each contributor lift over them', () => {
    const withX = (bad: boolean): ReportRun =>
      (bad ? failed : ok)(health([{ step: 'implement', contributors: [skill('x', 1_000), skill('y', 500)] }]))
    const withoutX = (): ReportRun => ok(health([{ step: 'implement', contributors: [skill('y', 500)] }]))
    // 3 of 4 runs with x failed; none of the other 6; 3 of 10 overall.
    const r = buildContextReport('C:\\work\\app', [
      withX(true),
      withX(true),
      withX(true),
      withX(false),
      ...Array.from({ length: 6 }, withoutX),
    ])
    expect(r.runs).toBe(10)
    expect(r.failureRate).toBe(0.3)
    expect(r.groundingRate).toBe(0)
    const x = r.rows.find((row) => row.name === 'x')!
    expect(x.failureRate).toBe(0.75)
    expect(x.failureLift).toBe(2.5)
    // No grounding in the project: no grounding lift.
    expect(x.groundingLift).toBeUndefined()
    const y = r.rows.find((row) => row.name === 'y')!
    expect(y.failureLift).toBe(1)
    expect(r.recommendations).toContainEqual({
      kind: 'lift',
      key: x.key,
      name: 'x',
      what: 'failures',
      lift: 2.5,
    })
    // y is in every run: comparing it with the project says nothing.
    expect(r.recommendations.some((rec) => rec.kind === 'lift' && rec.name === 'y')).toBe(false)
  })

  it('grounding lift: runs with a contributor needed grounding fixes more often', () => {
    const runs = [
      ok(health([{ step: 'implement', contributors: [skill('z', 100)] }], 2)),
      ok(health([{ step: 'implement', contributors: [skill('z', 100)] }], 1)),
      ok(health([{ step: 'implement', contributors: [skill('z', 100)] }], 0)),
      ok(health([{ step: 'implement', contributors: [] }], 0)),
      ok(health([{ step: 'implement', contributors: [] }], 0)),
      ok(health([{ step: 'implement', contributors: [] }], 0)),
    ]
    const r = buildContextReport('f', runs)
    const z = r.rows[0]!
    expect(r.groundingRate).toBe(0.33)
    expect(z.groundingRate).toBe(0.67)
    expect(z.groundingLift).toBe(2)
    expect(r.recommendations).toContainEqual({
      kind: 'lift',
      key: z.key,
      name: 'z',
      what: 'grounding',
      lift: 2,
    })
  })

  it('a heavy skill in most Implement passes, and a big memory file, are named with their size', () => {
    const runs = [1, 2, 3].map(() =>
      ok(
        health([
          { step: 'implement', contributors: [skill('big-skill', 12_000), mem('CLAUDE.md', 40_000)] },
          { step: 'review', contributors: [mem('CLAUDE.md', 40_000)] },
        ]),
      ),
    )
    const r = buildContextReport('f', runs)
    expect(r.recommendations).toContainEqual({
      kind: 'heavy-skill',
      key: contributorKey({ kind: 'skill', name: 'big-skill' }),
      name: 'big-skill',
      tokens: 12_000,
      step: 'implement',
    })
    expect(r.recommendations).toContainEqual({
      kind: 'big-memory',
      key: contributorKey({ kind: 'memory', name: 'CLAUDE.md' }),
      name: 'CLAUDE.md',
      tokens: 40_000,
    })
    // Biggest first; the median size; the passes it loads into.
    expect(r.rows[0]).toMatchObject({ name: 'CLAUDE.md', tokens: 40_000, steps: ['implement', 'review'] })
  })

  it('an MCP server loaded in each of the last ten runs and never called is unused; one call clears it', () => {
    const quiet = Array.from({ length: 12 }, () =>
      ok(
        health([
          { step: 'implement', contributors: [mcp('tracker', 9_000, 31, 0), mcp('busy', 2_000, 4, 3)] },
        ]),
      ),
    )
    const r = buildContextReport('f', quiet)
    expect(r.recommendations).toContainEqual({
      kind: 'unused-mcp',
      key: contributorKey({ kind: 'mcp', name: 'tracker' }),
      name: 'tracker',
      tools: 31,
      runs: 10,
    })
    expect(r.recommendations.some((x) => x.kind === 'unused-mcp' && x.name === 'busy')).toBe(false)
    expect(r.rows.find((x) => x.name === 'busy')!.calls).toBe(36)
    // Calls not counted in a run: nothing is said about the server.
    const uncounted = Array.from({ length: 12 }, () =>
      ok(health([{ step: 'implement', contributors: [mcp('tracker', 9_000, 31)] }])),
    )
    expect(buildContextReport('f', uncounted).recommendations).toEqual([])
  })

  it('keeps the 30 most recent runs', () => {
    const runs = Array.from({ length: 40 }, () =>
      ok(health([{ step: 'implement', contributors: [skill('s', 10)] }])),
    )
    expect(buildContextReport('f', runs).runs).toBe(30)
  })
})

describe('readContextReport and context.report', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const seed = (): { home: string; summaries: RunSummary[] } => {
    const home = mkdtempSync(join(tmpdir(), 'dimf-ctx-report-'))
    dirs.push(home)
    const summaries = [
      run([], { folder: 'C:\\work\\app' }),
      run([], { folder: 'C:\\work\\app', status: 'failed' }),
      run([], { folder: 'C:\\work\\other' }),
      run([], { folder: 'C:\\work\\app', status: 'running' }),
      run([], { folder: 'C:\\work\\app' }),
    ]
    for (const [i, s] of summaries.entries()) {
      const dir = join(home, s.runId)
      mkdirSync(dir, { recursive: true })
      // The last run's report cannot be read: it is left out.
      const text =
        i === 4
          ? '{ not json'
          : JSON.stringify(health([{ step: 'implement', contributors: [skill(`s${i}`, 100)] }]))
      writeFileSync(join(dir, 'context-health.json'), text)
    }
    return { home, summaries }
  }

  it('reads the folder ended runs with a readable report', async () => {
    const { home, summaries } = seed()
    const r = await readContextReport('C:\\work\\app', summaries, (id) => join(home, id))
    expect(r.runs).toBe(2)
    expect(r.rows.map((x) => x.name).sort()).toEqual(['s0', 's1'])
  })

  it('answers context.report through the handlers, and refuses a request without a folder', async () => {
    const { home, summaries } = seed()
    const ctx = {
      now: () => 0,
      summaries: () => summaries,
      paths: { run: (id: string) => ({ dir: join(home, id) }) },
      dashboard: {
        attention: () => ({ needsYou: 0, items: [] }),
        vendorHealth: () => [],
        catalogStatus: () => Promise.reject(new Error('unused')),
        pricing: { stepUsd: () => null, apiEquivalent: () => false },
        estimate: () => Promise.reject(new Error('unused')),
      } satisfies DashboardDeps,
    } as unknown as HandlerContext
    const h = createHandlers(ctx)
    const r = await dispatch(h, 'context.report', { folder: 'C:\\work\\app' })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.value.runs).toBe(2)
    const bad = await dispatch(h, 'context.report', { folder: '' })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
  })
})
