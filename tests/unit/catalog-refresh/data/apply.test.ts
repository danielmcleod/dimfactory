// Apply / undo / manual prices on disk (catalog refresh Apply: models + pricing together, a
// combined backup in catalog/history/ (20 kept); src/core/catalog/apply.ts). Atomicity: EPERM/EBUSY/EACCES on the
// second file's rename leave both files exactly as they were (or, retried, write both); a commit cut between the
// renames is settled by recoverPendingCommit. Undo restores the previous pair byte for byte and refuses when the
// files changed since.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATALOG_HISTORY_KEEP,
  COMMIT_JOURNAL_FILE,
  applyRows,
  catalogFileText,
  listCatalogHistory,
  recoverPendingCommit,
  savePrice,
  undoLast,
} from '../../../../src/core/catalog/apply.ts'
import { DimFactoryError } from '../../../../src/core/errors.ts'
import type { HomePaths } from '../../../../src/core/home.ts'
import { nodeAtomicFs } from '../../../../src/core/store/atomic.ts'
import type { AtomicFs } from '../../../../src/core/store/atomic.ts'
import { CLI_MODELS, JOB_ID, NOW, allClaude, current, homeOf, proposal, writeJob } from './fixtures.ts'

const ctx = { cliModels: { claude: CLI_MODELS } }
const FAST = { retryDelaysMs: [1, 1, 1] }

async function seed(): Promise<{ p: HomePaths; before: { models: Buffer; pricing: Buffer } }> {
  const p = homeOf()
  await mkdir(p.catalogDir, { recursive: true })
  const c = current()
  await writeFile(p.catalogPricing, catalogFileText(c.pricing))
  await writeFile(p.catalogModels, catalogFileText(c.models))
  return { p, before: await files(p) }
}

async function files(p: HomePaths): Promise<{ models: Buffer; pricing: Buffer }> {
  return { models: await readFile(p.catalogModels), pricing: await readFile(p.catalogPricing) }
}

/** A sonnet price change (+25%, ticked) and a new model listed under newModels (so both files change). */
async function job(p: HomePaths): Promise<string[]> {
  await writeJob(p, {
    proposal: proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } }), {
      newModels: [
        { vendor: 'claude', id: 'claude-opus-6', sourceUrl: 'https://www.anthropic.com/news/opus-6' },
      ],
    }),
  })
  return ['price|claude|claude-sonnet-5-5|inputPerMTok', 'new-model|claude|claude-opus-6']
}

type RenameRule = (from: string, to: string) => string | null

function fsWith(rule: RenameRule): AtomicFs & { renames: string[] } {
  const renames: string[] = []
  return {
    ...nodeAtomicFs,
    renames,
    rename: async (from, to) => {
      renames.push(to)
      const code = rule(from, to)
      if (code !== null)
        throw Object.assign(new Error(`${code}: operation not permitted, rename '${to}'`), { code })
      await nodeAtomicFs.rename(from, to)
    },
  }
}

async function rejection(p: Promise<unknown>): Promise<DimFactoryError> {
  try {
    await p
  } catch (err) {
    if (err instanceof DimFactoryError) return err
    throw err
  }
  throw new Error('expected a rejection')
}

async function leftovers(p: HomePaths): Promise<string[]> {
  return (await readdir(p.catalogDir)).filter((n) => n.endsWith('.tmp') || n === COMMIT_JOURNAL_FILE)
}

describe('applyRows', () => {
  it('writes models.json and pricing.json together after backing up the pair; the job reads applied', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    const r = await applyRows(p, JOB_ID, rows, { ctx, now: () => NOW })
    expect(r.entries).toBe(2)
    expect(r.data.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')?.inputPerMTok).toBe(2.5)
    expect(r.data.models.vendors['claude']?.models.map((m) => m.id)).toEqual(['claude-opus-6'])
    const after = await files(p)
    expect(after.pricing.equals(before.pricing)).toBe(false)
    expect(after.models.equals(before.models)).toBe(false)
    // The backup is the previous pair, byte for byte.
    // Two ticked rows' entries; Opus and Haiku, repeated unchanged, are confirm rows that were not ticked,
    // so they are left exactly as they were.
    expect(r.entry).toMatchObject({ source: 'refresh', jobId: JOB_ID, entries: 2 })
    // The history keeps which model the change added (a new-model card reads it), also when read back from disk.
    expect(r.entry?.added).toEqual([{ vendor: 'claude', model: 'claude-opus-6' }])
    expect(r.history[0]?.added).toEqual([{ vendor: 'claude', model: 'claude-opus-6' }])
    expect((await listCatalogHistory(p))[0]?.added).toEqual([{ vendor: 'claude', model: 'claude-opus-6' }])
    expect(r.confirmed).toBe(0)
    expect(r.data.pricing.entries.find((e) => e.model === 'claude-opus-5-5')).toEqual(
      current().pricing.entries.find((e) => e.model === 'claude-opus-5-5'),
    )
    const dir = join(p.catalogHistoryDir, r.entry?.id ?? '')
    expect((await readFile(join(dir, 'pricing.json'))).equals(before.pricing)).toBe(true)
    expect((await readFile(join(dir, 'models.json'))).equals(before.models)).toBe(true)
    expect(r.history).toEqual([r.entry])
    const status: unknown = JSON.parse(await readFile(join(p.catalogJobsDir, JOB_ID, 'status.json'), 'utf8'))
    expect(status).toMatchObject({
      id: JOB_ID,
      state: 'applied',
      appliedAt: NOW,
      appliedRows: 2,
      vendor: 'claude',
    })
    // Applied once only.
    expect((await rejection(applyRows(p, JOB_ID, rows, { ctx }))).code).toBe('CONFLICT')
    expect(await leftovers(p)).toEqual([])
  })

  it('a job that is running, failed or gone has nothing to apply', async () => {
    const { p } = await seed()
    await writeJob(p, { state: 'running' })
    expect((await rejection(applyRows(p, JOB_ID, [], { ctx }))).message).toBe(
      'This price update is still running.',
    )
    await writeJob(p, { state: 'failed' })
    expect((await rejection(applyRows(p, JOB_ID, [], { ctx }))).code).toBe('CONFLICT')
    expect((await rejection(applyRows(p, 'no-such-job', [], { ctx }))).code).toBe('NOT_FOUND')
    expect((await rejection(applyRows(p, '../escape', [], { ctx }))).code).toBe('NOT_FOUND')
  })

  it('EPERM on the second file every time: nothing changes (the first file is put back), no history, no leftovers', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    const fs = fsWith((_from, to) => (to === p.catalogModels ? 'EPERM' : null))
    const err = await rejection(applyRows(p, JOB_ID, rows, { ctx, fs, ...FAST }))
    expect(err.code).toBe('STORAGE')
    expect(err.message).toMatch(/^The prices could not be updated; nothing was changed\./)
    expect(err.details).toMatchObject({ errno: 'EPERM' })
    // 1 try + 3 retries on models.json; pricing.json was renamed, then put back.
    expect(fs.renames.filter((t) => t === p.catalogModels)).toHaveLength(4)
    const after = await files(p)
    expect(after.pricing.equals(before.pricing)).toBe(true)
    expect(after.models.equals(before.models)).toBe(true)
    expect(await listCatalogHistory(p)).toEqual([])
    expect(await leftovers(p)).toEqual([])
    // The job can still be applied once the file is free.
    const ok = await applyRows(p, JOB_ID, rows, { ctx })
    expect(ok.data.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')?.inputPerMTok).toBe(2.5)
  })

  it('EBUSY twice on the second file: retried like store/atomic.ts, then both files are written', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    let busy = 2
    const fs = fsWith((_from, to) => (to === p.catalogModels && busy-- > 0 ? 'EBUSY' : null))
    const r = await applyRows(p, JOB_ID, rows, { ctx, fs, ...FAST })
    expect(r.entry?.source).toBe('refresh')
    const after = await files(p)
    expect(after.pricing.equals(before.pricing)).toBe(false)
    expect(after.models.equals(before.models)).toBe(false)
    expect(await leftovers(p)).toEqual([])
  })

  it('EACCES on the first file: nothing changes', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    const fs = fsWith((_from, to) => (to === p.catalogPricing ? 'EACCES' : null))
    expect((await rejection(applyRows(p, JOB_ID, rows, { ctx, fs, ...FAST }))).code).toBe('STORAGE')
    const after = await files(p)
    expect(after.pricing.equals(before.pricing) && after.models.equals(before.models)).toBe(true)
    expect(await listCatalogHistory(p)).toEqual([])
  })

  it('when the first file cannot be put back either, the journal stays and the next read settles it', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    let pricingRenamed = false
    const fs = fsWith((_from, to) => {
      if (to === p.catalogModels) return 'EPERM'
      if (to === p.catalogPricing) {
        if (pricingRenamed) return 'EPERM'
        pricingRenamed = true
      }
      return null
    })
    const err = await rejection(applyRows(p, JOB_ID, rows, { ctx, fs, ...FAST }))
    expect(err.message).toContain('could not be put back yet')
    // Half applied on disk: the new pricing.json, the old models.json; the journal names the backup.
    expect((await files(p)).pricing.equals(before.pricing)).toBe(false)
    expect(await leftovers(p)).toEqual([COMMIT_JOURNAL_FILE])
    expect(await recoverPendingCommit(p)).toBe('rolled-back')
    const after = await files(p)
    expect(after.pricing.equals(before.pricing) && after.models.equals(before.models)).toBe(true)
    expect(await leftovers(p)).toEqual([])
    expect(await listCatalogHistory(p)).toEqual([])
    expect(await recoverPendingCommit(p)).toBe('none')
  })

  it('a journal left after both renames (a crash before it was removed) keeps the new pair', async () => {
    const { p } = await seed()
    const rows = await job(p)
    const r = await applyRows(p, JOB_ID, rows, { ctx })
    const applied = await files(p)
    await writeFile(
      join(p.catalogDir, COMMIT_JOURNAL_FILE),
      JSON.stringify({ schemaVersion: 1, id: r.entry?.id }),
    )
    expect(await recoverPendingCommit(p)).toBe('committed')
    const after = await files(p)
    expect(after.pricing.equals(applied.pricing) && after.models.equals(applied.models)).toBe(true)
    expect(await listCatalogHistory(p)).toHaveLength(1)
  })

  it('no ticked row writes nothing (no backup, no history); the job still reads applied', async () => {
    const { p, before } = await seed()
    await job(p)
    const r = await applyRows(p, JOB_ID, [], { ctx, now: () => NOW })
    expect(r).toMatchObject({ entry: null, entries: 0, confirmed: 0, history: [] })
    const after = await files(p)
    expect(after.pricing.equals(before.pricing)).toBe(true)
    expect(after.models.equals(before.models)).toBe(true)
    expect(await listCatalogHistory(p)).toEqual([])
    const status: unknown = JSON.parse(await readFile(join(p.catalogJobsDir, JOB_ID, 'status.json'), 'utf8'))
    expect(status).toMatchObject({ state: 'applied', appliedRows: 0 })
  })

  it("checks the ticks against the job's own reads (status.json fetchedHosts): not read, not verified", async () => {
    const { p } = await seed()
    await writeJob(p, {
      proposal: proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } })),
      extra: { fetchedHosts: ['www.anthropic.com'] },
    })
    const r = await applyRows(p, JOB_ID, ['price|claude|claude-sonnet-5-5|inputPerMTok'], { ctx })
    // The page it names (platform.claude.com) was never read in that job: applied as the user ticked, unverified.
    expect(r.data.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')).toMatchObject({
      inputPerMTok: 2.5,
      confidence: 'unverified',
    })
    // Its confirm rows do not exist either (nothing it read confirms them).
    await writeJob(p, {
      id: '20261009T121000Z-cd34',
      proposal: proposal(allClaude()),
      extra: { fetchedHosts: [] },
    })
    const err = await rejection(
      applyRows(p, '20261009T121000Z-cd34', ['confirm|claude|claude-opus-5-5'], { ctx }),
    )
    expect(err.code).toBe('CONFLICT')
  })

  it('refuses a price list written by a newer Dim Factory (NEWER_SCHEMA)', async () => {
    const { p } = await seed()
    const rows = await job(p)
    const newer = JSON.parse(await readFile(p.catalogPricing, 'utf8')) as Record<string, unknown>
    await writeFile(p.catalogPricing, JSON.stringify({ ...newer, schemaVersion: 2 }))
    expect((await rejection(applyRows(p, JOB_ID, rows, { ctx }))).code).toBe('NEWER_SCHEMA')
  })
})

describe('undoLast', () => {
  it('puts the previous pair back byte for byte; the change reads undone; nothing is left to undo', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    const applied = await applyRows(p, JOB_ID, rows, { ctx, now: () => NOW })
    const r = await undoLast(p, { now: () => NOW + 1 })
    const after = await files(p)
    expect(after.pricing.equals(before.pricing)).toBe(true)
    expect(after.models.equals(before.models)).toBe(true)
    expect(r.data.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')?.inputPerMTok).toBe(2)
    expect(r.history.map((h) => [h.source, h.undone === true])).toEqual([
      ['undo', false],
      ['refresh', true],
    ])
    expect(r.history[1]?.id).toBe(applied.entry?.id)
    expect((await rejection(undoLast(p))).code).toBe('NOT_FOUND')
  })

  it('undoes the newest change first, then the one before (an apply after a manual price)', async () => {
    const { p, before } = await seed()
    const rows = await job(p)
    await savePrice(p, {
      vendor: 'claude',
      model: 'claude-opus-5-5',
      inputPerMTok: 4.5,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 8,
    })
    const afterEdit = await files(p)
    await applyRows(p, JOB_ID, rows, { ctx })
    await undoLast(p)
    expect((await files(p)).pricing.equals(afterEdit.pricing)).toBe(true)
    const r = await undoLast(p)
    expect((await files(p)).pricing.equals(before.pricing)).toBe(true)
    expect(r.data.pricing.entries.find((e) => e.model === 'claude-opus-5-5')).toMatchObject({
      inputPerMTok: 4,
      confidence: 'unverified',
    })
  })

  it('refuses (CONFLICT) when the files changed after that change; nothing is written', async () => {
    const { p } = await seed()
    const rows = await job(p)
    await applyRows(p, JOB_ID, rows, { ctx })
    const edited = (await readFile(p.catalogPricing, 'utf8')).replace(
      '"inputPerMTok": 2.5',
      '"inputPerMTok": 2.7',
    )
    await writeFile(p.catalogPricing, edited)
    const err = await rejection(undoLast(p))
    expect(err.code).toBe('CONFLICT')
    expect(err.message).toBe(
      'The prices changed after that update, so Undo would lose those changes. Edit the prices in Settings → Catalog instead.',
    )
    expect(await readFile(p.catalogPricing, 'utf8')).toBe(edited)
  })
})

describe('savePrice and the history', () => {
  const edit = (input: number) => ({
    vendor: 'claude',
    model: 'claude-sonnet-5-5',
    inputPerMTok: input,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 4,
  })

  it("stores confidence 'user' (manual history entry, models.json untouched) and undoes like an apply", async () => {
    const { p, before } = await seed()
    const r = await savePrice(p, edit(2.25), { now: () => NOW })
    expect(r.entry).toMatchObject({ source: 'manual', entries: 1 })
    expect(r.data.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')).toMatchObject({
      inputPerMTok: 2.25,
      confidence: 'user',
      fetchedAt: NOW,
    })
    const after = await files(p)
    expect(after.models.equals(before.models)).toBe(true)
    // The same price again: no write, no history entry.
    expect((await savePrice(p, edit(2.25))).entry).toBeNull()
    await undoLast(p)
    expect((await files(p)).pricing.equals(before.pricing)).toBe(true)
  })

  it('refuses (STORAGE) while pricing.json has entries it cannot read, or cannot be read at all', async () => {
    const { p } = await seed()
    const raw = JSON.parse(await readFile(p.catalogPricing, 'utf8')) as { entries: unknown[] }
    // A malformed entry, and a duplicate: both are left out when read, so a rewrite would drop them.
    raw.entries.unshift({ vendor: 'claude', model: 'my-local-model', inputPerMTok: 'x' })
    raw.entries.push(raw.entries[1])
    const text = JSON.stringify(raw, null, 2)
    await writeFile(p.catalogPricing, text)
    const err = await rejection(savePrice(p, edit(2.25)))
    expect(err.code).toBe('STORAGE')
    expect(err.message).toMatch(
      /^Saving now would drop what Dim Factory cannot read in the price files \(pricing\.json entry #1 ignored .*, and 1 more\)\. Fix or remove those entries in /,
    )
    const rows = await job(p)
    expect((await rejection(applyRows(p, JOB_ID, rows, { ctx }))).code).toBe('STORAGE')
    expect(await readFile(p.catalogPricing, 'utf8')).toBe(text)
    expect(await listCatalogHistory(p)).toEqual([])
    // Unreadable: the built-in prices stand in for it, and it is never written over.
    await writeFile(p.catalogPricing, '{ not json')
    const gone = await rejection(savePrice(p, edit(2.25)))
    expect(gone.code).toBe('STORAGE')
    expect(gone.message).toContain(
      'cannot be read, so Dim Factory uses its built-in prices and will not write over the file.',
    )
    expect(await readFile(p.catalogPricing, 'utf8')).toBe('{ not json')
  })

  it('refuses out-of-bounds prices without writing anything', async () => {
    const { p, before } = await seed()
    for (const bad of [0, -1, 1000.01, Number.NaN]) {
      expect((await rejection(savePrice(p, edit(bad)))).code).toBe('VALIDATION')
    }
    expect((await files(p)).pricing.equals(before.pricing)).toBe(true)
    expect(await listCatalogHistory(p)).toEqual([])
  })

  it(`keeps the newest ${CATALOG_HISTORY_KEEP} entries; concurrent edits are serialized`, async () => {
    const { p } = await seed()
    for (let i = 1; i <= 23; i++) await savePrice(p, edit(2 + i / 100))
    await Promise.all([savePrice(p, edit(3.5)), savePrice(p, { ...edit(3.5), model: 'claude-opus-5-5' })])
    const history = await listCatalogHistory(p)
    expect(history).toHaveLength(CATALOG_HISTORY_KEEP)
    expect((await readdir(p.catalogHistoryDir)).length).toBe(CATALOG_HISTORY_KEEP)
    expect(history.every((h, i) => i === 0 || h.at <= (history[i - 1]?.at ?? 0))).toBe(true)
    const r = await undoLast(p)
    // The last of the two concurrent edits was undone; the other stays.
    const prices = r.data.pricing.entries
      .filter((e) => e.vendor === 'claude')
      .map((e) => [e.model, e.inputPerMTok])
    expect(prices.filter(([, v]) => v === 3.5)).toHaveLength(1)
  })
})
