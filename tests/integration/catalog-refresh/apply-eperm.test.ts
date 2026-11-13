// Atomic catalog apply under EPERM ("Apply writes models + pricing together, with a combined backup": write both
// or neither, EPERM/EBUSY/EACCES retried like store/atomic.ts). Through a real core:
// catalog.apply of rows that change both files, with every rename onto models.json (the second of the pair) failing
// with EPERM as a Windows sharing violation does, answers STORAGE "nothing was changed" and leaves both files byte for
// byte as they were, with no history entry, journal or temp file left, the job still ready to apply and estimates.get
// still at the old price. A sharing violation that clears within the retries does not fail the apply. Undo under
// EACCES on pricing.json (the first of the pair) changes nothing either, and works once the file is free.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { catalogCostUsd } from '../../../src/core/catalog/cost.ts'
import { loadSeedPricing } from '../../../src/core/catalog/store.ts'
import { catalogRowId } from '../../../src/core/catalog/validate.ts'
import { PRIOR_USAGE } from '../../../src/core/estimates/defaults.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { PriceEntry } from '../../../src/shared/catalog.ts'
import { cleanup, hermeticEnv, makeSandbox } from '../run/scenario.ts'

/** The injected failure: a rename onto a file this names fails with that code (counted). */
const inject = vi.hoisted(() => ({
  fail: null as ((to: string) => string | null) | null,
  failed: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const code = inject.fail?.(String(to)) ?? null
      if (code !== null) {
        inject.failed.push(basename(String(to)))
        throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), {
          code,
          errno: code === 'EPERM' ? -4048 : -4092,
          syscall: 'rename',
          path: String(from),
          dest: String(to),
        })
      }
      return actual.rename(from, to)
    },
  }
})

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  inject.fail = null
  inject.failed.length = 0
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const JOB = '20261009T120000Z-cd34'
const OPUS_OUTPUT = catalogRowId('price', 'claude', 'claude-opus-5-5', 'outputPerMTok')
const NEW_MODEL = catalogRowId('new-model', 'claude', 'claude-haiku-5')

/** A finished refresh: Opus output 20 → 25 and a new model (so the apply changes both files). */
async function writeJob(home: string): Promise<void> {
  const seed = await loadSeedPricing()
  const entries = seed.entries
    .filter((e) => e.vendor === 'claude')
    .map((e) => ({
      vendor: e.vendor,
      model: e.model,
      aliases: e.aliases,
      inputPerMTok: e.inputPerMTok,
      outputPerMTok: e.model === 'claude-opus-5-5' ? 25 : e.outputPerMTok,
      cacheReadPerMTok: e.cacheReadPerMTok,
      cacheWritePerMTok: e.cacheWritePerMTok,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      sourceQuote: `${e.model} pricing`,
    }))
  const dir = join(homePaths(home).catalogJobsDir, JOB)
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: JOB,
      state: 'diff-ready',
      vendor: 'claude',
      model: 'sonnet',
      startedAt: now - 120_000,
      endedAt: now - 1000,
    }),
  )
  writeFileSync(
    join(dir, 'proposal.json'),
    JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      entries,
      newModels: [
        {
          vendor: 'claude',
          id: 'claude-haiku-5',
          displayName: 'Claude Haiku 5',
          contextWindow: 200_000,
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
        },
      ],
      unverifiable: [],
    }),
  )
}

async function ok<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

const planP80 = (
  rates: Pick<PriceEntry, 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok'>,
) => catalogCostUsd(PRIOR_USAGE.plan ?? { input: 0, output: 0 }, rates, true)

interface Files {
  models: string
  pricing: string
}

function readPair(home: string): Files {
  const p = homePaths(home)
  return { models: readFileSync(p.catalogModels, 'utf8'), pricing: readFileSync(p.catalogPricing, 'utf8') }
}

/** What a failed commit must not leave: a history entry, the journal, a staged temp file. */
function leftovers(home: string): string[] {
  const p = homePaths(home)
  const out: string[] = []
  if (existsSync(p.catalogHistoryDir))
    out.push(...readdirSync(p.catalogHistoryDir).map((d) => `history/${d}`))
  out.push(...readdirSync(p.catalogDir).filter((f) => f === '.commit.json' || f.endsWith('.tmp')))
  return out
}

describe('catalog apply under a sharing violation (EPERM)', () => {
  it('writes both files or neither; the job, the estimates and the history are as before', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eperm-'))
    dirs.push(root)
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    const folder = makeSandbox({}, root)
    const core = await createCore({
      home,
      host: { kind: 'app' },
      env: hermeticEnv(),
      retention: false,
      catalogScheduler: false,
    })
    cores.push(core)
    await writeJob(home)
    const seedOpus = (await loadSeedPricing()).entries.find((e) => e.model === 'claude-opus-5-5')
    if (seedOpus === undefined) throw new Error('the seed has no claude-opus-5-5')
    const planCost = async (): Promise<number | undefined> =>
      (await ok(core.invoke('estimates.get', { folder }))).steps.plan?.costUsd?.p80
    expect(await planCost()).toBeCloseTo(planP80(seedOpus), 9)
    const review = await ok(core.invoke('catalog.get'))
    expect(review.job?.state).toBe('diff-ready')
    const rowIds = review.job?.diff?.rows.map((r) => r.id) ?? []
    expect(rowIds).toContain(OPUS_OUTPUT)
    expect(rowIds).toContain(NEW_MODEL)
    const before = readPair(home)

    // ---- every rename onto models.json fails (EPERM): the pricing rename that went first is put back ----
    inject.fail = (to) => (basename(to) === 'models.json' ? 'EPERM' : null)
    const failed = await core.invoke('catalog.apply', { jobId: JOB, rowIds: [OPUS_OUTPUT, NEW_MODEL] })
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('the apply succeeded')
    expect(failed.error.code).toBe('STORAGE')
    expect(failed.error.message).toContain('nothing was changed')
    expect(failed.error.message).not.toContain(String.fromCharCode(0x2014))
    // Tried once and retried five times (ATOMIC_RETRY_DELAYS_MS), as store/atomic.ts does.
    expect(inject.failed.filter((f) => f === 'models.json')).toHaveLength(6)
    expect(readPair(home)).toEqual(before)
    expect(leftovers(home)).toEqual([])
    const after = await ok(core.invoke('catalog.get'))
    expect(after.history).toEqual([])
    expect(after.undoId).toBeNull()
    expect(after.job).toMatchObject({ id: JOB, state: 'diff-ready' })
    expect(after.pricing).toEqual(review.pricing)
    expect(after.models).toEqual(review.models)
    expect(await planCost()).toBeCloseTo(planP80(seedOpus), 9)

    // ---- a sharing violation that clears within the retries: applied, both files ----
    let left = 2
    inject.failed.length = 0
    inject.fail = (to) => (basename(to) === 'models.json' && left-- > 0 ? 'EBUSY' : null)
    const applied = await ok(core.invoke('catalog.apply', { jobId: JOB, rowIds: [OPUS_OUTPUT, NEW_MODEL] }))
    expect(inject.failed).toEqual(['models.json', 'models.json'])
    expect(applied.job?.state).toBe('applied')
    expect(applied.history).toHaveLength(1)
    expect(applied.models.vendors['claude']?.models.map((m) => m.id)).toContain('claude-haiku-5')
    expect(applied.pricing.entries.find((e) => e.model === 'claude-opus-5-5')?.outputPerMTok).toBe(25)
    const now = readPair(home)
    expect(now.models).not.toBe(before.models)
    expect(now.pricing).not.toBe(before.pricing)
    expect(leftovers(home)).toEqual([`history/${applied.history[0]?.id}`])
    expect(await planCost()).toBeCloseTo(planP80({ ...seedOpus, outputPerMTok: 25 }), 9)

    // ---- Undo while pricing.json (the first rename) is held (EACCES): nothing changes ----
    inject.failed.length = 0
    inject.fail = (to) => (basename(to) === 'pricing.json' ? 'EACCES' : null)
    const undoFailed = await core.invoke('catalog.undo')
    expect(undoFailed.ok ? null : undoFailed.error.code).toBe('STORAGE')
    expect(inject.failed.filter((f) => f === 'pricing.json')).toHaveLength(6)
    expect(readPair(home)).toEqual(now)
    expect((await ok(core.invoke('catalog.get'))).history).toHaveLength(1)
    expect(await planCost()).toBeCloseTo(planP80({ ...seedOpus, outputPerMTok: 25 }), 9)

    // ---- the file is free again: Undo puts the earlier pair back byte for byte ----
    inject.fail = null
    await ok(core.invoke('catalog.undo'))
    expect(readPair(home)).toEqual(before)
    expect(await planCost()).toBeCloseTo(planP80(seedOpus), 9)
  })
})
