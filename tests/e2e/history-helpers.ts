// Helpers shared by the Runs history and re-run E2E specs (history.spec.ts; Runs history
// "Filters: folder, status, vendor, date, text. 100 per page" and its row actions; Sessions' Re-run from Fix;
// "Re-run loads resolved.json.config through ResolvedConfigZ" and `storage` {keepRuns, keepDays, rawLogDays};
// state-machine row R14). Everything lives under the test's temp root: DIM_FACTORY_HOME (its runs, their index and
// resolved.json, the folder's shadow repository) and the sandbox.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { RetentionReport } from '../../src/core/store/retention.ts'
import type { RunStatus, RunSummary } from '../../src/shared/run.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import type { PassScript, ScenarioSpec } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { gitOut } from './git-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'

export { REVIEW_WITH_FINDINGS }

/** REVIEW_WITH_FINDINGS' findings as Fix's prompt names them: F1 and F2 [must], F3 [should]. */
export const FINDING_TITLES = {
  F1: '--version prints nothing',
  F2: 'No test covers --version',
  F3: 'Unused import of',
} as const

/** A Fix that continues Implement's session (C08b, a `--resume=<id>` spawn) and writes a test file. */
export const RESUMED_FIX: PassScript = { recording: 'C08b-resume-fix', write: FIX_WRITE }

/**
 * Plan → Implement (C08a: its own session id; writes src/version.ts) → Review finds F1/F2 [must] and F3 [should] →
 * Critic clean → `resume` (each a `--resume=<id>` spawn, in order: the source's Fix, then the re-run's).
 */
export function findingsFlow(resume: PassScript[]): ScenarioSpec {
  return {
    plan: { recording: 'C06-plan-native-host' },
    implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
    review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
    resume,
  }
}

/** The source's Fix fails (the CLI answers "logged out", C09b): the run fails at Fix and keeps its folder. */
export const FAILED_FIX: PassScript = { recording: 'C09b-logged-out' }

export const NO_GATES = { gates: { afterPlan: false, beforeFix: false } }

// ---- the Runs page ---------------------------------------------------------------------------------------------------

/** The Runs page, from the sidebar; resolves once its first listing is on screen. */
export async function openRunsPage(page: Page): Promise<void> {
  await page.getByTestId('nav-runs').click()
  await expect(page.getByTestId('runs-filters')).toBeVisible()
  await expect(page.locator('[data-testid="runs-list"]:not([aria-busy="true"])')).toBeVisible()
}

export function runRow(page: Page, runId: string): Locator {
  return page.getByTestId(`runs-row-${runId}`)
}

/** Open a row's actions menu (Open · Re-run with same config · Re-run from Fix · Open diff · Reveal folder). */
export async function openRowMenu(page: Page, runId: string): Promise<Locator> {
  await page.getByTestId(`runs-menu-${runId}`).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  return menu
}

/** The run ids of the rows on screen, top to bottom (a removed run's undo row included). */
export async function rowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="runs-list"] > li[data-testid^="runs-row-"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('runs-row-'.length)))
}

/** runs.list's answer for a query: what core lists, for checking what the page shows against it. */
export async function listed(e2e: E2EHarness, query: Record<string, unknown> = {}): Promise<RunSummary[]> {
  const out: RunSummary[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await e2e.call('runs.list', {
      ...query,
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    out.push(...page.items)
    if (page.nextCursor === null) return out
    cursor = page.nextCursor
  }
}

// ---- history seeded before the app starts ------------------------------------------------------------------------------

export interface SeedRow {
  title: string
  folder: string
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>
  /** Every pass's vendor (default claude). */
  vendor?: string
  /** ms before now. */
  ageMs: number
}

const DAY_MS = 86_400_000
const STEP_KEYS = ['plan', 'implement', 'review', 'critic', 'fix'] as const

/** A run id as core makes them (RUN_ID_PATTERN), unique by `n`. */
function seedRunId(createdAt: number, n: number): string {
  const d = new Date(createdAt)
  const p = (x: number): string => String(x).padStart(2, '0')
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return `${stamp}-${n.toString(16).padStart(4, '0')}`
}

/** A finished run's summary as core's index keeps it (a run of an earlier session: no run folder of its own). */
export function seededSummary(row: SeedRow, displayNo: number, now: number): RunSummary {
  const createdAt = now - row.ageMs
  const vendor = row.vendor ?? 'claude'
  const failed = row.status === 'failed'
  const summary: RunSummary = {
    runId: seedRunId(createdAt, displayNo),
    displayNo,
    folder: row.folder,
    // A key of the shape core makes (16 hex digits); no shadow repository has it.
    folderKey: createHash('sha256').update(row.folder.toLowerCase()).digest('hex').slice(0, 16),
    title: row.title,
    status: row.status,
    phase: 'done',
    ...(row.status === 'completed' ? { outcome: 'clean' as const } : {}),
    ...(failed ? { failure: { step: 'implement' as const, category: 'auth_required' as const } } : {}),
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt,
    endedAt: createdAt + 90_000,
    progress: { tokens: 1200, costUsd: 0.04, filesChanged: 1 },
    findings: { must: 0, should: 0 },
    steps: STEP_KEYS.map((key) => ({
      key,
      vendor,
      model: null,
      status: failed && key !== 'plan' ? (key === 'implement' ? 'failed' : 'queued') : 'done',
      activeMs: 15_000,
    })),
  }
  return summary
}

/**
 * Write runs/index.jsonl into the home before the app starts (call before E2EHarness.start): the summaries of earlier
 * runs, newest first in display order. Returns them.
 */
export function seedHistory(e2e: E2EHarness, rows: readonly SeedRow[], now = Date.now()): RunSummary[] {
  const runs = join(e2e.home, 'runs')
  mkdirSync(runs, { recursive: true })
  const out = rows.map((r, i) => seededSummary(r, i + 1, now))
  writeFileSync(
    join(runs, 'index.jsonl'),
    out.map((s) => JSON.stringify({ v: 1, op: 'put', s })).join('\n') + '\n',
  )
  return out
}

/** `n` finished runs in `folder`, a few minutes apart (the newest first in the list). */
export function manyRows(n: number, folder: string, title = 'seeded run'): SeedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `${title} ${i + 1}`,
    folder,
    status: i % 7 === 3 ? 'failed' : i % 5 === 2 ? 'cancelled' : 'completed',
    ageMs: (n - i) * 5 * 60_000 + DAY_MS / 24,
  }))
}

export { DAY_MS }

// ---- a run's files ---------------------------------------------------------------------------------------------------

export function resolvedJson(e2e: E2EHarness, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(e2e.home, 'runs', runId, 'resolved.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

export function runFolderExists(e2e: E2EHarness, runId: string): boolean {
  return existsSync(join(e2e.home, 'runs', runId))
}

/** The run refs the folder's shadow repository holds (refs/dimfactory/runs/<runId>, packed refs included). */
export function shadowRunRefs(e2e: E2EHarness, folderKey: string): string[] {
  const gitDir = join(e2e.home, 'shadow', folderKey, 'repo.git')
  if (!existsSync(gitDir)) return []
  const out = gitOut(
    e2e.sandbox,
    '--git-dir',
    gitDir,
    'for-each-ref',
    '--format=%(refname)',
    'refs/dimfactory/runs/',
  )
  return out
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .map((r) => r.slice('refs/dimfactory/runs/'.length))
}

/** The run.json state of a run (fields the views do not carry: rerunOf, the source's lock). */
export function storedState(e2e: E2EHarness, runId: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(e2e.home, 'runs', runId, 'run.json'), 'utf8')) as {
    state?: Record<string, unknown>
  }
  return doc.state ?? {}
}

// ---- retention (E2E hook) ----------------------------------------------------------------------------------------------

/**
 * One retention pass now, on core's clock (e2e.clock moves it), as the app's daily pass runs it; the deletes it starts
 * have finished when it resolves. The schedule itself is off under DIM_FACTORY_E2E=1 (src/main/e2e.ts history hook).
 */
export async function runRetention(e2e: E2EHarness): Promise<RetentionReport> {
  const app = e2e.app
  if (app === null) throw new Error('the app is not running')
  return app.evaluate(async () => {
    const g = (globalThis as Record<string, unknown>)['__dimFactoryE2E'] as
      { history?: { retention(): Promise<RetentionReport> } } | undefined
    if (g?.history === undefined) throw new Error('the E2E history hook is missing')
    return g.history.retention()
  })
}
