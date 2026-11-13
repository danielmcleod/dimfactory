// Catalog data test fixtures (catalog refresh): a small current catalog, the CLI's model list,
// proposal builders shaped like the refresh job's answer (the refresh output schema), a job folder writer, and a fake
// clock for the scheduler.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CatalogData } from '../../../../src/core/catalog/store.ts'
import { homePaths } from '../../../../src/core/home.ts'
import type { HomePaths } from '../../../../src/core/home.ts'
import type { Clock, TimerHandle } from '../../../../src/core/supervisor/effects.ts'
import type { ModelsFile, PriceEntry, ProposedPrice } from '../../../../src/shared/catalog.ts'
import type { ModelInfo } from '../../../../src/shared/vendors.ts'

export const NOW = Date.UTC(2026, 9, 9, 12)
export const DAY = 86_400_000
export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'

export function entry(over: Partial<PriceEntry> & Pick<PriceEntry, 'model'>): PriceEntry {
  return {
    vendor: 'claude',
    aliases: [],
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 2,
    sourceUrl: PRICING_URL,
    sourceQuote: 'seed quote',
    fetchedAt: NOW - 30 * DAY,
    confidence: 'unverified',
    ...over,
  }
}

export const OPUS = entry({
  model: 'claude-opus-5-5',
  aliases: ['opus'],
  inputPerMTok: 4,
  outputPerMTok: 20,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: 8,
})
export const SONNET = entry({
  model: 'claude-sonnet-5-5',
  aliases: ['sonnet'],
  inputPerMTok: 2,
  outputPerMTok: 10,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: 4,
})
export const HAIKU = entry({
  model: 'claude-haiku-4-5-20251001',
  aliases: ['haiku', 'claude-haiku-4-5'],
})
/** The user priced this one by hand. */
export const FABLE = entry({
  model: 'claude-fable-5-1',
  aliases: ['fable'],
  inputPerMTok: 10,
  outputPerMTok: 50,
  cacheReadPerMTok: 0.25,
  cacheWritePerMTok: 20,
  confidence: 'user',
})
export const GPT = entry({
  vendor: 'codex',
  model: 'gpt-5.5',
  sourceUrl: 'https://openai.com/api/pricing',
  inputPerMTok: 1.25,
  outputPerMTok: 10,
})

export function emptyModels(): ModelsFile {
  return { schemaVersion: 1, updatedAt: NOW - 30 * DAY, vendors: {} }
}

export function current(entries: PriceEntry[] = [OPUS, SONNET, HAIKU, FABLE, GPT]): CatalogData {
  return {
    pricing: { schemaVersion: 1, updatedAt: NOW - 30 * DAY, entries: structuredClone(entries) },
    models: emptyModels(),
  }
}

/** What Claude's initialize handshake reports (C16 shape: alias ids, the concrete model as an alias). */
export const CLI_MODELS: ModelInfo[] = [
  { id: 'default', aliases: ['claude-opus-5-5'], isDefault: true, source: 'cli' },
  { id: 'opus', aliases: ['claude-opus-5-5'], source: 'cli' },
  { id: 'sonnet', aliases: ['claude-sonnet-5-5'], source: 'cli' },
  { id: 'haiku', aliases: ['claude-haiku-4-5-20251001'], source: 'cli' },
  { id: 'fable', aliases: ['claude-fable-5-1'], source: 'cli' },
]

/** A proposal entry repeating a stored price from the official page with a quote (change what you test). */
export function proposed(e: PriceEntry, over: Partial<ProposedPrice> = {}): ProposedPrice {
  return {
    vendor: e.vendor,
    model: e.model,
    aliases: [...e.aliases],
    inputPerMTok: e.inputPerMTok,
    outputPerMTok: e.outputPerMTok,
    cacheReadPerMTok: e.cacheReadPerMTok,
    cacheWritePerMTok: e.cacheWritePerMTok,
    sourceUrl: PRICING_URL,
    sourceQuote: `${e.model} | $${e.inputPerMTok} / MTok`,
    ...over,
  }
}

export function proposal(
  entries: unknown[],
  extra: { newModels?: unknown[]; unverifiable?: unknown[] } = {},
): Record<string, unknown> {
  return {
    generatedAt: '2026-10-09T12:00:00Z',
    entries,
    newModels: extra.newModels ?? [],
    unverifiable: extra.unverifiable ?? [],
  }
}

/** Every stored Claude model named, unchanged: no deprecation rows (tests then change one thing). */
export function allClaude(over: Record<string, Partial<ProposedPrice>> = {}): ProposedPrice[] {
  return [OPUS, SONNET, HAIKU, FABLE].map((e) => proposed(e, over[e.model] ?? {}))
}

export const homeOf = (): HomePaths => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')

export const JOB_ID = '20261009T120000Z-ab12'

/** catalog/jobs/<id>/{status.json, proposal.json} as the refresh job leaves them (refresh.ts RefreshJobStatus). */
export async function writeJob(
  p: HomePaths,
  o: {
    id?: string
    state?: string
    proposal?: unknown
    startedAt?: number
    endedAt?: number
    rejected?: unknown[]
    /** More status.json fields (fetchedHosts, mentioned, vendors). */
    extra?: Record<string, unknown>
  } = {},
): Promise<string> {
  const id = o.id ?? JOB_ID
  const dir = join(p.catalogJobsDir, id)
  await mkdir(dir, { recursive: true })
  const status: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    state: o.state ?? 'diff-ready',
    vendor: 'claude',
    model: 'sonnet',
    startedAt: o.startedAt ?? NOW - 5 * 60_000,
  }
  if (o.endedAt !== undefined || (o.state ?? 'diff-ready') !== 'running')
    status['endedAt'] = o.endedAt ?? NOW - 60_000
  if (o.rejected !== undefined) status['rejected'] = o.rejected
  Object.assign(status, o.extra)
  await writeFile(join(dir, 'status.json'), JSON.stringify(status, null, 2))
  if (o.proposal !== undefined)
    await writeFile(join(dir, 'proposal.json'), JSON.stringify(o.proposal, null, 2))
  return id
}

/** A clock whose timers fire only on `advance` (in due order). */
export class FakeClock implements Clock {
  t: number
  readonly scale = 1
  #seq = 0
  readonly timers = new Map<number, { fn: () => void; at: number }>()

  constructor(start = NOW) {
    this.t = start
  }

  now = (): number => this.t

  setTimer = (fn: () => void, at: number): TimerHandle => {
    const id = ++this.#seq
    this.timers.set(id, { fn, at })
    return id as unknown as TimerHandle
  }

  clearTimer = (h: TimerHandle): void => {
    this.timers.delete(h as unknown as number)
  }

  /** Move time forward; every timer due on the way fires at its own time. Returns the new now. */
  advance(ms: number): number {
    const end = this.t + ms
    for (;;) {
      let next: [number, { fn: () => void; at: number }] | undefined
      for (const t of this.timers)
        if (t[1].at <= end && (next === undefined || t[1].at < next[1].at)) next = t
      if (next === undefined) break
      this.timers.delete(next[0])
      this.t = Math.max(this.t, next[1].at)
      next[1].fn()
    }
    this.t = end
    return end
  }
}

/** Let promise callbacks and timers already queued run. */
export const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
