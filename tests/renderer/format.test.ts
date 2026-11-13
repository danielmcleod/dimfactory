// lib/format.ts: the outcome strings, cost basis labels, durations and labels, and parity with core's failure
// titles and step labels (read as text, since the renderer may not import src/core).
import { describe, expect, it } from 'vitest'
import { FAILURE_CATEGORIES } from '@shared/failure.ts'
import { RUN_PHASES, STEP_KEYS } from '@shared/run.ts'
import type { RunSummary } from '@shared/run.ts'
import coreCards from '../../src/core/supervisor/cards.ts?raw'
import coreCategories from '../../src/core/heal/categories.ts?raw'
import {
  COST_BASIS_LABEL,
  FAILURE_TITLE,
  NO_PRICE,
  RUN_PHASE_LABEL,
  STEP_LABEL,
  categoryTitle,
  costTitle,
  formatAgo,
  formatClock,
  formatCost,
  formatDuration,
  formatDurationRange,
  formatElapsedVsEta,
  formatEta,
  formatFiles,
  formatFindingCounts,
  formatRunCost,
  formatTokens,
  formatUsage,
  outcomeText,
  runCostBasis,
  runCostTitle,
  vendorName,
} from '@renderer/lib/format.ts'
import { makeSummary } from './helpers/fixtures.ts'

const done = (over: Partial<RunSummary>): RunSummary =>
  makeSummary({ runId: 'r', status: 'completed', ...over })

describe('outcome strings (Recent runs)', () => {
  it('words every finished outcome exactly', () => {
    expect(outcomeText(done({ outcome: 'fixed', findings: { must: 3, should: 5 } }))).toBe(
      'Fixed · 3 must · 5 should',
    )
    expect(outcomeText(done({ outcome: 'clean' }))).toBe('Clean: no findings')
    expect(outcomeText(done({ outcome: 'verify-failed' }))).toBe('Completed with failures')
    expect(outcomeText(done({ outcome: 'no-changes' }))).toBe('No changes made')
    expect(outcomeText(done({ outcome: 'findings-open', findings: { must: 2, should: 1 } }))).toBe(
      'Findings open · 2 must · 1 should',
    )
    expect(outcomeText(done({ outcome: 'findings-open' }))).toBe('Findings open')
    expect(outcomeText(done({ outcome: 'fixed' }))).toBe('Fixed')
  })

  it('names the step and the category title of a failure', () => {
    const failed = makeSummary({
      runId: 'r',
      status: 'failed',
      failure: { step: 'implement', category: 'auth_expired' },
      steps: [{ key: 'implement', vendor: 'codex', status: 'failed', activeMs: 1 }],
    })
    expect(outcomeText(failed)).toBe('Failed at Implement · Codex login expired')
    expect(outcomeText({ ...failed, failure: { step: 'plan', category: 'network' } })).toBe(
      'Failed at Plan · Network problem',
    )
  })

  it('says where a cancelled run stopped', () => {
    const cancelled = makeSummary({
      runId: 'r',
      status: 'cancelled',
      steps: [
        { key: 'plan', status: 'done', activeMs: 1 },
        { key: 'implement', status: 'done', activeMs: 1 },
        { key: 'review', status: 'cancelled', activeMs: 1 },
        { key: 'critic', status: 'cancelled', activeMs: 1 },
      ],
    })
    expect(outcomeText(cancelled)).toBe('Cancelled at Review')
    expect(outcomeText({ ...cancelled, steps: [] })).toBe('Cancelled')
  })

  it('has no outcome while a run is going', () => {
    for (const status of ['queued', 'running', 'waiting', 'paused'] as const) {
      expect(outcomeText(makeSummary({ runId: 'r', status }))).toBeNull()
    }
  })
})

describe('cost', () => {
  it('labels each basis', () => {
    expect(COST_BASIS_LABEL).toEqual({
      vendor: 'reported by vendor',
      catalog: 'est. from pricing',
      none: 'no price known',
    })
    expect(formatCost({ usd: 0.62, basis: 'catalog' })).toBe('$0.62 est.')
    expect(formatCost({ usd: 0.62, basis: 'vendor' })).toBe('$0.62')
    expect(formatCost({ usd: 0.62, basis: 'none' })).toBe('No price')
    expect(formatCost({ usd: null, basis: 'catalog' })).toBe('No price')
    expect(NO_PRICE).toBe('No price')
    expect(formatCost({ usd: 1.5, basis: 'catalog', apiEquivalent: true })).toBe('$1.50 est. · API-equiv.')
    expect(formatCost({ usd: 0.004, basis: 'vendor' })).toBe('<$0.01')
    expect(costTitle({ usd: 1, basis: 'catalog', apiEquivalent: true })).toMatch(/^est\. from pricing · /)
  })

  it('takes a run total basis from its steps without recomputing the total', () => {
    const s = makeSummary({
      runId: 'r',
      progress: { tokens: 1, costUsd: 0.8, filesChanged: 0 },
      steps: [
        { key: 'plan', status: 'done', activeMs: 1, costBasis: 'vendor' },
        { key: 'implement', status: 'done', activeMs: 1, costBasis: 'catalog' },
      ],
    })
    expect(runCostBasis(s)).toBe('catalog')
    expect(formatRunCost(s)).toBe('$0.80 est.')
    expect(formatRunCost({ ...s, progress: { ...s.progress, costUsd: null } })).toBe('No price')
  })

  it('tells "no figure yet" from "no price known" for a run total without one', () => {
    const none = { tokens: 0, costUsd: null, filesChanged: 0 }
    const going = makeSummary({ runId: 'r', status: 'running', progress: none })
    expect(formatRunCost(going)).toBe('No cost yet')
    expect(runCostTitle(going)).toBe('No step has reported its usage yet')
    for (const status of ['queued', 'waiting', 'paused'] as const)
      expect(formatRunCost({ ...going, status })).toBe('No cost yet')
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(formatRunCost({ ...going, status })).toBe('No cost reported')
      expect(runCostTitle({ ...going, status })).toBe('No step reported any usage')
    }
    // Usage reported (tokens, or a step's usage) but priced by neither the vendor nor the price list.
    const unpriced = { ...going, progress: { ...none, tokens: 1500 } }
    expect(formatRunCost(unpriced)).toBe(NO_PRICE)
    expect(runCostTitle(unpriced)).toBe('No cost reported, and no price known for the model')
    const stepUsage = {
      ...going,
      steps: [{ key: 'plan' as const, status: 'done' as const, activeMs: 1, usage: { input: 0, output: 0 } }],
    }
    expect(formatRunCost(stepUsage)).toBe(NO_PRICE)
    expect(formatRunCost({ ...unpriced, status: 'completed' })).toBe(NO_PRICE)
    // A figure wins whatever the status.
    const priced = {
      ...going,
      progress: { ...none, costUsd: 0.5 },
      steps: [{ key: 'plan' as const, status: 'done' as const, activeMs: 1, costBasis: 'vendor' as const }],
    }
    expect(formatRunCost(priced)).toBe('$0.50')
    expect(formatRunCost({ ...priced, status: 'cancelled' })).toBe('$0.50')
  })
})

describe('durations, tokens, files', () => {
  it('formats durations like the CLI', () => {
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(252_000)).toBe('4m 12s')
    expect(formatDuration(3_780_000)).toBe('1h 3m')
    expect(formatDuration(-5)).toBe('0s')
  })

  it('formats elapsed against the ETA', () => {
    expect(formatClock(133_000)).toBe('2:13')
    expect(formatClock(3_733_000)).toBe('1:02:13')
    expect(formatEta(360_000)).toBe('~6 min')
    expect(formatEta(20_000)).toBe('~1 min')
    expect(formatEta(4_200_000)).toBe('~1 h 10 min')
    expect(formatElapsedVsEta(133_000, { p50: 360_000, p80: 600_000 })).toBe('2:13 / ~6 min')
    expect(formatElapsedVsEta(700_000, { p50: 360_000, p80: 600_000 })).toBe('11:40 · longer than usual')
    expect(formatElapsedVsEta(5_000)).toBe('0:05')
    expect(formatDurationRange({ p50: 360_000, p80: 600_000 })).toBe('6–10 min')
    expect(formatDurationRange({ p50: 360_000, p80: 370_000 })).toBe('~6 min')
  })

  it('formats tokens, usage, files, counts and ages', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(1_250_000)).toBe('1.25M')
    expect(formatUsage({ input: 12_300, output: 4100, cacheRead: 70_000, cacheWrite: 10_000 })).toBe(
      '12.3k in · 4.1k out · 80.0k cache',
    )
    expect(formatUsage({ input: 10, output: 5 })).toBe('10 in · 5 out')
    expect(formatFiles(7, 120, 34)).toBe('7 files +120 −34')
    expect(formatFiles(1, 3, 0)).toBe('1 file +3 −0')
    expect(formatFiles(7)).toBe('7 files')
    expect(formatFindingCounts({ must: 0, should: 0 })).toBe('no findings')
    expect(formatAgo(0, 30_000)).toBe('just now')
    expect(formatAgo(0, 5 * 60_000)).toBe('5 min ago')
    expect(formatAgo(0, 3 * 3_600_000)).toBe('3 h ago')
  })
})

describe('labels', () => {
  it('has a title for every failure category, matching core word for word', () => {
    for (const c of FAILURE_CATEGORIES) expect(FAILURE_TITLE[c], c).toBeTruthy()
    const core = new Map<string, string>()
    // ROWS entries in heal/categories.ts: `  <category>: {\n    title: '<title>',` (single or double quotes).
    for (const m of coreCategories.matchAll(/^ {2}(\w+): \{\r?\n {4}title: (?:'([^']*)'|"([^"]*)"),/gm)) {
      core.set(m[1]!, m[2] ?? m[3]!)
    }
    expect(core.size).toBe(FAILURE_CATEGORIES.length)
    for (const c of FAILURE_CATEGORIES) expect(FAILURE_TITLE[c], c).toBe(core.get(c))
  })

  it('fills the vendor into titles', () => {
    expect(categoryTitle('cli_missing', 'claude')).toBe('Claude CLI not found')
    expect(categoryTitle('trust_required', 'gemini')).toBe('Folder not trusted for Gemini')
    expect(categoryTitle('rate_limited')).toBe('The vendor rate limit hit')
    expect(vendorName('local-ollama')).toBe('Local model (ollama)')
    expect(vendorName('acme')).toBe('acme')
  })

  it('labels every step like core does, and every phase', () => {
    const m = /const STEP_LABEL: Record<StepKey, string> = \{([^}]*)\}/.exec(coreCards)
    expect(m).not.toBeNull()
    for (const k of STEP_KEYS) {
      const key = k.includes(':') ? `'${k}'` : k
      expect(m![1], k).toContain(`${key}: '${STEP_LABEL[k]}'`)
    }
    for (const p of RUN_PHASES) expect(RUN_PHASE_LABEL[p], p).toBeTruthy()
  })
})
