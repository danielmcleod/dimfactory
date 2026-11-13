// Helpers shared by the catalog E2E specs (the catalog refresh and its validation table,
// catalog.spec.ts): the fake Claude answering a catalog refresh with `structured_output` (the synthesized
// C17 recording with another answer, optionally held for a while so the job is seen running), the refresh process the
// fake ran (argv, cwd, the prompt), the catalog files and the dashboard's consent card.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { STDIO, loadConverter } from '../integration/run/scenario.ts'
import type { Scenario } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { fakeProcs } from './attention-helpers.ts'
import type { FakeProc } from './attention-helpers.ts'

export const DAY_MS = 24 * 60 * 60 * 1000
/** The refresh interval the built-in config uses (`catalog.refresh` intervalDays 14). */
export const INTERVAL_DAYS = 14

/** Anthropic's price page, as the synthesized C17 answer quotes it. */
export const PRICE_PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing'
/** The official hosts for Claude (src/core/catalog/sources.ts), the only ones the job may fetch pages from. */
export const CLAUDE_HOSTS = ['docs.anthropic.com', 'www.anthropic.com', 'claude.com', 'platform.claude.com']
/** The refresh's --disallowedTools (the refresh job's six, plus the read-only cut's AskUserQuestion and Monitor). */
export const REFRESH_DISALLOWED = [
  'Edit',
  'Write',
  'NotebookEdit',
  'AskUserQuestion',
  'Monitor',
  'Bash',
  'PowerShell',
  'Agent',
]

interface ProposedPrice {
  vendor: string
  model: string
  aliases?: string[]
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number | null
  cacheWritePerMTok: number | null
  sourceUrl: string
  sourceQuote: string
  deprecated?: boolean
}

export interface RefreshProposal {
  generatedAt: string
  entries: ProposedPrice[]
  newModels: { vendor: string; id: string; displayName?: string; contextWindow?: number; sourceUrl: string }[]
  unverifiable: { vendor: string; model: string; reason: string }[]
}

const price = (
  model: string,
  aliases: string[],
  p: [number, number, number, number],
  name: string,
): ProposedPrice => ({
  vendor: 'claude',
  model,
  aliases,
  inputPerMTok: p[0],
  outputPerMTok: p[1],
  cacheReadPerMTok: p[2],
  cacheWritePerMTok: p[3],
  sourceUrl: PRICE_PAGE,
  sourceQuote: `${name} | $${p[0]} / MTok | $${p[3]} / MTok | $${p[2]} / MTok | $${p[1]} / MTok`,
})

/**
 * catalog.spec.ts's answer against the seed prices (src/core/catalog/seed/pricing.seed.json):
 *   - Opus 5.5 output 20 → 25 (+25%): ticked; Plan, Implement and Critic use Opus, so the estimate moves;
 *   - Sonnet 5.5 input 2 → 3.5 (+75%): over 50%, amber and unticked;
 *   - Haiku 4.5 output 5 → 60 (12×): "suspicious", unticked;
 *   - a new model (not reported by the CLI) and Fable 5.1 unverifiable, as in C17.
 */
export const E21_PROPOSAL: RefreshProposal = {
  generatedAt: '2026-10-24T09:14:02Z',
  entries: [
    price('claude-opus-5-5', ['opus'], [4, 25, 0.2, 8], 'Claude Opus 5.5'),
    price('claude-sonnet-5-5', ['sonnet'], [3.5, 10, 0.2, 4], 'Claude Sonnet 5.5'),
    price('claude-haiku-4-5-20251001', ['haiku', 'claude-haiku-4-5'], [1, 60, 0.1, 2], 'Claude Haiku 4.5'),
  ],
  newModels: [
    {
      vendor: 'claude',
      id: 'claude-haiku-5',
      displayName: 'Claude Haiku 5',
      contextWindow: 200_000,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    },
  ],
  unverifiable: [
    {
      vendor: 'claude',
      model: 'claude-fable-5-1',
      reason: 'The pricing page says contact sales for Fable 5.1; no public per-token price.',
    },
  ],
}

/** The diff rows catalog.spec.ts looks at (ids are `kind|vendor|model|field`, core's fixed row ids). */
export const ROW = {
  opusOutput: 'price|claude|claude-opus-5-5|outputPerMTok',
  sonnetInput: 'price|claude|claude-sonnet-5-5|inputPerMTok',
  haikuOutput: 'price|claude|claude-haiku-4-5-20251001|outputPerMTok',
  newHaiku5: 'new-model|claude|claude-haiku-5',
} as const

export interface RefreshAnswer {
  proposal: RefreshProposal
  /** Hold the job this long after the prompt arrives (the card and Settings show it running). */
  holdMs?: number
}

/** A refresh that fails (C18b: the answer never matches the schema), after `holdMs`. */
export interface FailingRefresh {
  fails: true
  holdMs?: number
}

/** The C18b recording as a script, held `holdMs` after the prompt arrives. */
function failingScript(text: string, holdMs: number | undefined): string {
  const out: Op[] = []
  for (const l of text.split('\n')) {
    const t = l.trim()
    if (t === '' || t.startsWith('//') || t.startsWith('#')) continue
    const op = JSON.parse(t) as Op
    out.push(op)
    const match = op['match'] as { type?: unknown } | undefined
    if (op.op === 'expectStdin' && match?.type === 'user' && holdMs !== undefined)
      out.push({ op: 'sleep', ms: holdMs })
  }
  return `${out.map((o) => JSON.stringify(o)).join('\n')}\n`
}

type Op = Record<string, unknown> & { op: string }

const frame = (line: unknown): Record<string, unknown> | undefined => {
  if (typeof line !== 'string') return undefined
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The C17 recording as a script answering `a.proposal` (structured_output and the StructuredOutput call). */
function refreshScript(text: string, a: RefreshAnswer): string {
  const ops = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('#'))
    .map((l) => JSON.parse(l) as Op)
  const out: Op[] = []
  let answered = 0
  for (const op of ops) {
    const match = op['match'] as { type?: unknown } | undefined
    out.push(op)
    if (op.op === 'expectStdin' && match?.type === 'user' && a.holdMs !== undefined) {
      out.push({ op: 'sleep', ms: a.holdMs })
      continue
    }
    if (op.op !== 'stdout') continue
    const f = frame(op['line'])
    if (f?.['type'] === 'result') {
      f['structured_output'] = a.proposal
      op['line'] = JSON.stringify(f)
      answered++
      continue
    }
    const msg = f?.['type'] === 'assistant' ? (f['message'] as { content?: unknown } | undefined) : undefined
    const content = Array.isArray(msg?.content) ? (msg.content as Record<string, unknown>[]) : []
    const call = content.find((c) => c['type'] === 'tool_use' && c['name'] === 'StructuredOutput')
    if (call !== undefined) {
      call['input'] = a.proposal
      op['line'] = JSON.stringify(f)
    }
  }
  if (answered !== 1) throw new Error(`C17: expected one result frame, found ${answered}`)
  return `${out.map((o) => JSON.stringify(o)).join('\n')}\n`
}

/**
 * StartOptions.editScenario: the refresh spawns (the only ones whose --allowedTools starts with WebSearch) replay C17
 * answering `answers` in order. Their entries go first: the refresh's argv also has the reviewers' `dontAsk --model
 * sonnet`. Call `await loadRefreshConverter()` first.
 */
export function withRefreshes(answers: readonly (RefreshAnswer | FailingRefresh)[]): (sc: Scenario) => void {
  const text = c17Script
  const failing = c18bScript
  if (text === undefined || failing === undefined)
    throw new Error('call loadRefreshConverter() before withRefreshes()')
  return (sc) => {
    const file = join(sc.dir, 'scenario.json')
    const entries = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    const refreshes = answers.map((a, i) => {
      const script = join(sc.dir, `catalog-${i + 1}.script.jsonl`)
      writeFileSync(script, 'fails' in a ? failingScript(failing, a.holdMs) : refreshScript(text, a))
      return { match: { argvIncludes: ['-p', 'WebSearch*'] }, script }
    })
    writeFileSync(file, JSON.stringify([...refreshes, ...entries], null, 2))
  }
}

let c17Script: string | undefined
let c18bScript: string | undefined

/** Convert the synthesized C17 (and C18b) recordings once (scripts/fixture-to-script.mjs). */
export async function loadRefreshConverter(): Promise<void> {
  const convert = await loadConverter()
  c17Script ??= convert(readFileSync(join(STDIO, 'C17-refresh-structured-output', 'recording.jsonl'), 'utf8'))
  c18bScript ??= convert(
    readFileSync(join(STDIO, 'C18b-refresh-structured-retries', 'recording.jsonl'), 'utf8'),
  )
}

// ---- what the fake saw ---------------------------------------------------------------------------------------------

/** The refresh processes the fake started (their script is catalog-N.script.jsonl). */
export function refreshProcs(e2e: E2EHarness): FakeProc[] {
  return fakeProcs(e2e).filter((p) => /^catalog-\d+\.script\.jsonl$/.test(p.script))
}

/** The fake's `start` cwd of a process (the job's folder). */
export function procCwd(e2e: E2EHarness, pid: number): string | undefined {
  const start = e2e.fakeLog().find((e) => e.kind === 'start' && e.pid === pid)
  return typeof start?.['cwd'] === 'string' ? start['cwd'] : undefined
}

/** The value after `flag` in an argv. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

/** The stdin frames of a process, parsed (lines that are not JSON left out). */
export function stdinFrames(p: FakeProc): Record<string, unknown>[] {
  return p.stdin.flatMap((l) => {
    const f = frame(l)
    return f !== undefined ? [f] : []
  })
}

/** The prompt text a process was sent (its user message). */
export function promptOf(p: FakeProc): string {
  const user = stdinFrames(p).find((f) => f['type'] === 'user')
  const content = (user?.['message'] as { content?: { type?: string; text?: string }[] } | undefined)?.content
  return (content ?? []).map((c) => c.text ?? '').join('')
}

// ---- the catalog files ---------------------------------------------------------------------------------------------

export function catalogFile(e2e: E2EHarness, name: 'pricing' | 'models'): string {
  return join(e2e.home, 'catalog', `${name}.json`)
}

/** sha256 of a catalog file ('missing' when absent). */
export function catalogHash(e2e: E2EHarness, name: 'pricing' | 'models'): string {
  const f = catalogFile(e2e, name)
  return existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'missing'
}

interface StoredPrice {
  vendor: string
  model: string
  inputPerMTok: number
  outputPerMTok: number
  confidence: string
}

/** The stored price entry of a model (pricing.json). */
export function storedPrice(e2e: E2EHarness, model: string): StoredPrice | undefined {
  const pricing = JSON.parse(readFileSync(catalogFile(e2e, 'pricing'), 'utf8')) as { entries: StoredPrice[] }
  return pricing.entries.find((x) => x.model === model)
}

/**
 * Windows: another program holds `file` open without sharing delete (as an editor, an indexer or an antivirus scan
 * may), so replacing it fails with a sharing violation until the returned `release` is called.
 */
export async function holdOpen(file: string): Promise<() => Promise<void>> {
  const escaped = file.replace(/'/g, "''")
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$f = [System.IO.File]::Open('${escaped}', 'Open', 'Read', 'Read'); ` +
        `[Console]::Out.WriteLine('held'); [Console]::Out.Flush(); ` +
        `[void][Console]::In.ReadLine(); $f.Close()`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
  )
  await new Promise<void>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`could not hold ${file} open`)), 60_000)
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString()
      if (out.includes('held')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the holder of ${file} exited (${code}) before it held the file`))
    })
  })
  return async () => {
    if (child.exitCode !== null) return
    const gone = new Promise<void>((r) => child.once('exit', () => r()))
    child.stdin.end('\n')
    await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))])
    if (child.exitCode === null) child.kill()
  }
}

/** state.json's catalog fields. */
export function catalogScheduleState(e2e: E2EHarness): { lastRefreshAt?: number; snoozedUntil?: number } {
  const f = join(e2e.home, 'state.json')
  if (!existsSync(f)) return {}
  const raw = JSON.parse(readFileSync(f, 'utf8')) as { catalog?: Record<string, number> }
  return raw.catalog ?? {}
}

// ---- the estimate ---------------------------------------------------------------------------------------------------

/**
 * Plan's prior cost at p80 (PRIOR_USAGE plan: 10 input, 1,200 output, 40,000 cache read and 8,000 cache write tokens)
 * at Opus prices: what estimates.get reports for a fresh home.
 */
export function planPriorCost(p: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}): number {
  return (10 * p.input + 1_200 * p.output + 40_000 * p.cacheRead + 8_000 * p.cacheWrite) / 1e6
}

export const OPUS_SEED = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 }
export const OPUS_E21 = { ...OPUS_SEED, output: 25 }

// ---- the Dashboard and Settings -------------------------------------------------------------------------------------

export function consentCard(page: Page): Locator {
  return page.getByTestId('catalog-card')
}

/** Settings → Catalog, from the sidebar (the section's data is read a moment after it opens). */
export async function openCatalogSettings(page: Page): Promise<void> {
  if (
    !(await page
      .getByTestId('settings-nav')
      .isVisible()
      .catch(() => false))
  )
    await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-catalog').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'catalog')
  await expect(page.getByTestId('catalog-prices')).toBeVisible()
}
