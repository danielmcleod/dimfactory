// Catalog fixtures for the catalog renderer tests (catalog, cost, estimates; src/shared/catalog.ts).
import type {
  CatalogDiff,
  CatalogDiffRow,
  CatalogHistoryEntry,
  CatalogJob,
  CatalogRefreshPlan,
  CatalogSchedule,
  CatalogState,
  CatalogStatus,
  PriceEntry,
} from '@shared/catalog.ts'
import type { ConfigWriteResult } from '@shared/ipc.ts'

export const AT = Date.UTC(2026, 9, 3)
export const SOURCE = 'https://docs.anthropic.com/en/docs/about-claude/pricing'

export function price(over: Partial<PriceEntry> & { model: string }): PriceEntry {
  return {
    vendor: 'claude',
    aliases: [],
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 8,
    sourceUrl: SOURCE,
    sourceQuote: 'Claude Opus 5.5 | $4 / MTok',
    fetchedAt: AT,
    confidence: 'unverified',
    ...over,
  }
}

export function schedule(over: Partial<CatalogSchedule> = {}): CatalogSchedule {
  return {
    enabled: true,
    intervalDays: 14,
    lastRefreshAt: null,
    snoozedUntil: null,
    nextDueAt: null,
    ...over,
  }
}

export function status(over: Partial<CatalogStatus> = {}): CatalogStatus {
  return {
    pricingUpdatedAt: AT,
    confidence: 'unverified',
    stale: false,
    refreshDue: false,
    jobRunning: false,
    schedule: schedule(),
    ...over,
  }
}

export function row(over: Partial<CatalogDiffRow> & { id: string }): CatalogDiffRow {
  return {
    vendor: 'claude',
    model: 'claude-opus-5-5',
    kind: 'price',
    field: 'inputPerMTok',
    current: 4,
    proposed: 5,
    deltaPct: 25,
    sourceUrl: SOURCE,
    sourceQuote: 'Input $5 / MTok',
    flags: [],
    ticked: true,
    ...over,
  }
}

export function diff(rows: CatalogDiffRow[], over: Partial<CatalogDiff> = {}): CatalogDiff {
  return {
    jobId: 'j1',
    generatedAt: AT,
    vendor: 'claude',
    model: 'sonnet',
    rows,
    rejected: [],
    unverifiable: [],
    ...over,
  }
}

export function job(over: Partial<CatalogJob> = {}): CatalogJob {
  return { id: 'j1', state: 'running', vendor: 'claude', model: 'sonnet', startedAt: Date.now(), ...over }
}

export function history(n: number, over: Partial<CatalogHistoryEntry> = {}): CatalogHistoryEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `h${i}`,
    at: AT - i * 86_400_000,
    source: i % 2 === 0 ? 'refresh' : 'manual',
    entries: i + 1,
    ...over,
  }))
}

export function catalogState(over: Partial<CatalogState> = {}): CatalogState {
  return {
    models: { schemaVersion: 1, updatedAt: AT, vendors: {} },
    pricing: {
      schemaVersion: 1,
      updatedAt: AT,
      entries: [
        price({ model: 'claude-opus-5-5', aliases: ['opus'] }),
        price({ model: 'claude-haiku-5', inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null }),
      ],
    },
    status: status(),
    job: null,
    history: [],
    ...over,
  }
}

export function plan(over: Partial<CatalogRefreshPlan> = {}): CatalogRefreshPlan {
  return {
    vendor: 'claude',
    model: 'sonnet',
    estDurationMs: 120_000,
    estCostUsd: 0.05,
    lastRefreshAt: null,
    due: true,
    ...over,
  }
}

export const write = (backupId: string | null = 'b-1'): ConfigWriteResult => ({
  path: 'C:\\home\\dimfactory.json',
  changed: true,
  diff: '',
  backupId,
})
