// Re-run renderer fixtures (Runs history, Re-run from Fix): findings, findings.json, ended
// runs with core's rerunFromFix, and a runs.list double that filters as core's filterSummaries does.
import type { Finding, FindingsFile } from '@shared/findings.ts'
import type { RunListQuery } from '@shared/ipc.ts'
import type { RerunFromFix, RunSnapshot, RunSummary } from '@shared/run.ts'
import { makeSnapshot, makeSummary } from '../helpers/fixtures.ts'

export function finding(n: number, severity: 'must' | 'should', title: string, id = `f${n}`): Finding {
  return { id, n, severity, source: 'review', title, body: '', flags: [], round: 1 }
}

/** F1, F2 must; F3, F4 should (core numbers must first). */
export const FINDINGS: readonly Finding[] = [
  finding(1, 'must', 'Null check missing in parse()'),
  finding(2, 'must', 'Race in the cache writer'),
  finding(3, 'should', 'Rename the helper'),
  finding(4, 'should', 'Add a test for the empty case'),
]

export function findingsFile(list: readonly Finding[] = FINDINGS): string {
  const doc: FindingsFile = {
    schemaVersion: 1,
    runId: 'src',
    round: 1,
    sources: { review: { status: 'ok', count: list.length, rawFile: 'review.md' } },
    findings: [...list],
    selected: Object.fromEntries(list.map((f) => [f.id, true])),
  }
  return JSON.stringify(doc)
}

/**
 * A finished run (completed, fixed, 4m 12s, $0.62 reported by the vendors, 3 files, 2 must · 2 should) with these
 * summary fields.
 */
export function endedSummary(over: Partial<RunSummary> & { runId: string }): RunSummary {
  const createdAt = over.createdAt ?? 1_700_000_000_000
  return makeSummary({
    displayNo: 7,
    status: 'completed',
    phase: 'done',
    outcome: 'fixed',
    createdAt,
    endedAt: createdAt + 252_000,
    progress: { tokens: 1200, costUsd: 0.62, filesChanged: 3 },
    findings: { must: 2, should: 2 },
    steps: [
      { key: 'implement', vendor: 'claude', status: 'done', activeMs: 1000, costBasis: 'vendor' },
      { key: 'fix', vendor: 'codex', status: 'done', activeMs: 1000, costBasis: 'vendor' },
    ],
    ...over,
  })
}

export const FRESH_FIX: RerunFromFix = { available: true, fresh: true, reason: 'vendor-differs' }
export const REUSE_FIX: RerunFromFix = { available: true, fresh: false }

/** The run's snapshot with core's rerunFromFix (and the Fix and Implement vendors the "Why?" names). */
export function endedSnap(
  over: Partial<RunSummary> & { runId: string },
  rerunFromFix: RerunFromFix = REUSE_FIX,
): RunSnapshot {
  const base = makeSnapshot(over)
  const summary = endedSummary(over)
  return {
    ...base,
    summary,
    steps: {
      ...base.steps,
      implement: { ...base.steps.implement, status: 'done', attempt: 1, vendor: 'claude' },
      fix: { ...base.steps.fix, status: 'done', attempt: 1, vendor: 'codex' },
    },
    rerunFromFix,
  }
}

/** runs.list over `all`, filtered and paged as core's filterSummaries does (titles for `text`). */
export function listOver(all: readonly RunSummary[]) {
  return (q: RunListQuery): { items: RunSummary[]; nextCursor: string | null } => {
    const text = q.text?.trim().toLowerCase()
    const rows = all
      .filter((s) => q.folder === undefined || s.folder.toLowerCase() === q.folder.toLowerCase())
      .filter((s) => q.status === undefined || q.status.includes(s.status))
      .filter((s) => q.vendor === undefined || s.steps.some((st) => st.vendor === q.vendor))
      .filter((s) => text === undefined || s.title.toLowerCase().includes(text))
      .filter((s) => q.from === undefined || s.createdAt >= q.from)
      .filter((s) => q.to === undefined || s.createdAt <= q.to)
      .sort((a, b) => b.createdAt - a.createdAt)
    const offset = q.cursor !== undefined ? Number(q.cursor) : 0
    const limit = q.limit ?? 100
    return {
      items: rows.slice(offset, offset + limit),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    }
  }
}
