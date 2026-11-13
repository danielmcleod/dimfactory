// Catalog writes (refresh Apply, manual edits): applying a refresh's ticked rows, a manual
// price, and Undo all write catalog/models.json and catalog/pricing.json TOGETHER: both or neither.
//
// One commit:
//   1. the previous pair is copied into catalog/history/<id>/ (models.json, pricing.json, meta.json with the hashes the
//      new pair will have) before anything changes; 20 entries are kept;
//   2. a journal (catalog/.commit.json) names that entry; both new files are written to temp files and fsynced;
//   3. both are renamed over the old ones, each rename retried on EPERM/EBUSY/EACCES like store/atomic.ts; when the
//      second one still fails, the first is put back from the backup and the error says nothing changed;
//   4. the journal is removed. A journal found later (a crash between the renames, a failed put-back) is settled by
//      recoverPendingCommit before the next read or write: the new pair stays when both files carry it, else the
//      backup comes back.
// Undo puts back the pair from before the newest change that is not undone yet (an undo is itself a history entry);
// it refuses with CONFLICT when the files are no longer exactly what that change wrote. All writes of one home are
// serialized here.
// An apply or a manual price rewrites both files from what was read, so it is refused (STORAGE) while
// either file is unreadable (the built-in prices or an empty list stand in for it) or has entries this Dim Factory
// cannot read: writing would drop them. Nothing is ever deleted.
import { createHash, randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { CatalogHistoryEntry, ModelsFile, PriceEdit, PricingFile } from '../../shared/catalog.ts'
import { DimFactoryError, errnoCode, errorMessage, storageError } from '../errors.ts'
import { assertSafeSegment, homePaths } from '../home.ts'
import type { HomePaths } from '../home.ts'
import {
  ATOMIC_RETRY_DELAYS_MS,
  RETRYABLE_ERRNO,
  nodeAtomicFs,
  writeFileAtomic,
  writeJsonAtomic,
} from '../store/atomic.ts'
import type { AtomicFs } from '../store/atomic.ts'
import { CURRENT_SCHEMA_VERSION, isPlainObject, withSchemaVersion } from '../store/versions.ts'
import { applyPriceEdit, applySelectedRows } from './diff.ts'
import { readCatalog } from './store.ts'
import type { CatalogData, CatalogReadResult } from './store.ts'
import { checkProposal, jobValidateContext } from './validate.ts'
import type { ValidateContext } from './validate.ts'

/** History entries kept in catalog/history/. */
export const CATALOG_HISTORY_KEEP = 20
export const COMMIT_JOURNAL_FILE = '.commit.json'

export type CatalogFilePaths = Pick<
  HomePaths,
  'catalogDir' | 'catalogModels' | 'catalogPricing' | 'catalogHistoryDir' | 'catalogJobsDir'
>

/** DIM_FACTORY_HOME, or its paths. */
export type CatalogHome = string | CatalogFilePaths

const pathsOf = (home: CatalogHome): CatalogFilePaths => (typeof home === 'string' ? homePaths(home) : home)

export interface CatalogIoOptions {
  now?: () => number
  /** Injectable fs for the renames and temp files (tests simulate Windows sharing violations). */
  fs?: AtomicFs
  retryDelaysMs?: readonly number[]
  /** History entries kept (default 20). */
  keep?: number
  /** Override the built-in seed (tests). */
  seedPath?: string
}

export interface CatalogChange {
  data: CatalogData
  /** The history entry this change wrote (its id is the undo token); null when nothing changed. */
  entry: CatalogHistoryEntry | null
  /** Newest first. */
  history: CatalogHistoryEntry[]
}

// ---- serialization ------------------------------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>()

/** Run `fn` after every earlier catalog write of the same home. */
function serialized<T>(p: CatalogFilePaths, fn: () => Promise<T>): Promise<T> {
  const key = p.catalogDir
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

// ---- small fs helpers ---------------------------------------------------------------------------------------------

type Bytes = Buffer | null

async function readBytes(file: string): Promise<Bytes> {
  try {
    return await fsp.readFile(file)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null
    throw storageError(`cannot read ${file}`, err)
  }
}

const sha = (b: Bytes | string): string =>
  b === null ? 'missing' : createHash('sha256').update(b).digest('hex')

const equalBytes = (a: Bytes, b: Bytes | string): boolean =>
  a === null || b === null ? a === b : a.equals(typeof b === 'string' ? Buffer.from(b, 'utf8') : b)

function jsonText(value: object): string {
  return `${JSON.stringify(withSchemaVersion(value, CURRENT_SCHEMA_VERSION), null, 2)}\n`
}

async function retrying<T>(
  what: string,
  file: string,
  delays: readonly number[],
  op: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (err) {
      const code = errnoCode(err)
      const wait = delays[attempt]
      if (code === undefined || !RETRYABLE_ERRNO.has(code) || wait === undefined) {
        throw storageError(`${what} ${file}`, err)
      }
      await delay(wait)
    }
  }
}

// ---- history ------------------------------------------------------------------------------------------------------

const HISTORY_ID = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/

interface HistoryMeta {
  schemaVersion: 1
  id: string
  /** Order of commits (ids alone could tie within one millisecond). */
  seq: number
  at: number
  source: CatalogHistoryEntry['source']
  entries: number
  jobId?: string
  /** For an undo: the entry it reverted. */
  revertOf?: string
  undone?: boolean
  /** The models this change added (CatalogHistoryEntry.added). */
  added?: { vendor: string; model: string }[]
  /** Which files existed before (the backup holds exactly those). */
  before: { models: boolean; pricing: boolean }
  /** sha256 of each file as this change left it ('missing' when it removed the file). */
  after: { models: string; pricing: string }
}

function historyId(at: number): string {
  const d = new Date(at)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}Z`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

function parseMeta(v: unknown): HistoryMeta | null {
  if (!isPlainObject(v)) return null
  const { id, seq, at, source, entries, before, after } = v
  if (typeof id !== 'string' || !HISTORY_ID.test(id)) return null
  if (typeof at !== 'number' || typeof entries !== 'number') return null
  if (source !== 'refresh' && source !== 'manual' && source !== 'undo' && source !== 'restore') return null
  if (!isPlainObject(before) || !isPlainObject(after)) return null
  if (typeof after['models'] !== 'string' || typeof after['pricing'] !== 'string') return null
  const meta: HistoryMeta = {
    schemaVersion: 1,
    id,
    seq: typeof seq === 'number' ? seq : 0,
    at,
    source,
    entries,
    before: { models: before['models'] === true, pricing: before['pricing'] === true },
    after: { models: after['models'], pricing: after['pricing'] },
  }
  if (typeof v['jobId'] === 'string') meta.jobId = v['jobId']
  if (typeof v['revertOf'] === 'string') meta.revertOf = v['revertOf']
  if (v['undone'] === true) meta.undone = true
  const added = v['added']
  if (Array.isArray(added)) {
    const list = added.filter(
      (a): a is { vendor: string; model: string } =>
        isPlainObject(a) && typeof a['vendor'] === 'string' && typeof a['model'] === 'string',
    )
    if (list.length > 0) meta.added = list.map((a) => ({ vendor: a.vendor, model: a.model }))
  }
  return meta
}

async function readMeta(p: CatalogFilePaths, id: string): Promise<HistoryMeta | null> {
  const raw = await readBytes(join(p.catalogHistoryDir, id, 'meta.json')).catch(() => null)
  if (raw === null) return null
  try {
    return parseMeta(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')))
  } catch {
    return null
  }
}

/** Every readable history entry, newest first. */
async function readHistoryMetas(p: CatalogFilePaths): Promise<HistoryMeta[]> {
  let names: string[]
  try {
    names = await fsp.readdir(p.catalogHistoryDir)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return []
    throw storageError(`cannot list ${p.catalogHistoryDir}`, err)
  }
  const metas = await Promise.all(names.filter((n) => HISTORY_ID.test(n)).map((n) => readMeta(p, n)))
  return metas
    .filter((m): m is HistoryMeta => m !== null)
    .sort((a, b) => b.seq - a.seq || b.at - a.at || b.id.localeCompare(a.id))
}

function toEntry(m: HistoryMeta): CatalogHistoryEntry {
  const e: CatalogHistoryEntry = { id: m.id, at: m.at, source: m.source, entries: m.entries }
  if (m.jobId !== undefined) e.jobId = m.jobId
  if (m.undone === true) e.undone = true
  if (m.added !== undefined) e.added = m.added.map((a) => ({ ...a }))
  return e
}

/** catalog/history/ as CatalogState.history: newest first. */
export async function listCatalogHistory(home: CatalogHome): Promise<CatalogHistoryEntry[]> {
  return (await readHistoryMetas(pathsOf(home))).map(toEntry)
}

/** The entry `undoLast` would revert: the newest change that is neither an undo nor undone already. */
export function undoCandidate<T extends Pick<CatalogHistoryEntry, 'source' | 'undone'>>(
  history: readonly T[],
): T | null {
  return history.find((h) => h.source !== 'undo' && h.undone !== true) ?? null
}

async function rotate(p: CatalogFilePaths, keep: number): Promise<void> {
  const metas = await readHistoryMetas(p)
  for (const m of metas.slice(Math.max(1, keep))) {
    await fsp.rm(join(p.catalogHistoryDir, m.id), { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---- the pair commit ----------------------------------------------------------------------------------------------

interface PairTexts {
  models: string | Buffer | null
  pricing: string | Buffer | null
}

interface CommitMeta {
  source: CatalogHistoryEntry['source']
  entries: number
  jobId?: string
  revertOf?: string
  added?: { vendor: string; model: string }[]
}

interface Io {
  fs: AtomicFs
  delays: readonly number[]
  now: () => number
  keep: number
}

function ioOf(o: CatalogIoOptions): Io {
  return {
    fs: o.fs ?? nodeAtomicFs,
    delays: o.retryDelaysMs ?? ATOMIC_RETRY_DELAYS_MS,
    now: o.now ?? Date.now,
    keep: o.keep ?? CATALOG_HISTORY_KEEP,
  }
}

const journalPath = (p: CatalogFilePaths): string => join(p.catalogDir, COMMIT_JOURNAL_FILE)

/** Put `data` in place of `file` (null: remove it), atomically, with the sharing-violation retries. */
async function putBack(file: string, data: Bytes, io: Io): Promise<void> {
  if (data === null) {
    await retrying('cannot remove', file, io.delays, () => io.fs.rm(file, { force: true }))
    return
  }
  await writeFileAtomic(file, data, { fs: io.fs, retryDelaysMs: io.delays })
}

/** Stage `data` next to `file`: a fsynced temp file, its path returned. */
async function stage(file: string, data: string | Buffer, io: Io): Promise<string> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await retrying('cannot create a temp file for', file, io.delays, () =>
    io.fs.open(tmp, 'w', 0o600),
  )
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return tmp
}

/**
 * Write the pair (see the header). Files whose bytes do not change are not rewritten. Returns the history entry, or
 * null when neither file changes.
 */
async function commitPair(
  p: CatalogFilePaths,
  next: PairTexts,
  meta: CommitMeta,
  io: Io,
): Promise<HistoryMeta | null> {
  const files = { models: p.catalogModels, pricing: p.catalogPricing } as const
  const before = { models: await readBytes(files.models), pricing: await readBytes(files.pricing) }
  const nextBytes = {
    models: typeof next.models === 'string' ? Buffer.from(next.models, 'utf8') : next.models,
    pricing: typeof next.pricing === 'string' ? Buffer.from(next.pricing, 'utf8') : next.pricing,
  }
  const order = (['pricing', 'models'] as const).filter((k) => !equalBytes(before[k], nextBytes[k]))
  if (order.length === 0) return null

  const newest = (await readHistoryMetas(p))[0]
  const at = io.now()
  const id = historyId(Math.max(at, newest?.at ?? 0))
  const dir = join(p.catalogHistoryDir, id)
  const m: HistoryMeta = {
    schemaVersion: 1,
    id,
    seq: (newest?.seq ?? 0) + 1,
    at,
    source: meta.source,
    entries: meta.entries,
    before: { models: before.models !== null, pricing: before.pricing !== null },
    after: { models: sha(nextBytes.models), pricing: sha(nextBytes.pricing) },
  }
  if (meta.jobId !== undefined) m.jobId = meta.jobId
  if (meta.revertOf !== undefined) m.revertOf = meta.revertOf
  if (meta.added !== undefined && meta.added.length > 0) m.added = meta.added

  // 1. The backup, before anything changes.
  try {
    for (const k of ['models', 'pricing'] as const) {
      const b = before[k]
      if (b !== null)
        await writeFileAtomic(join(dir, `${k}.json`), b, { fs: io.fs, retryDelaysMs: io.delays })
    }
    await writeJsonAtomic(join(dir, 'meta.json'), m, { fs: io.fs, retryDelaysMs: io.delays })
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw nothingChanged('Dim Factory could not save a copy of the current prices first', err)
  }

  // 2. Journal, then the staged files.
  const staged: Partial<Record<'models' | 'pricing', string>> = {}
  const dropStaged = async (): Promise<void> => {
    for (const t of Object.values(staged)) await io.fs.rm(t, { force: true }).catch(() => undefined)
  }
  try {
    await writeJsonAtomic(journalPath(p), { schemaVersion: 1, id }, { fs: io.fs, retryDelaysMs: io.delays })
    for (const k of order) {
      const data = nextBytes[k]
      if (data !== null) staged[k] = await stage(files[k], data, io)
    }
  } catch (err) {
    await dropStaged()
    await fsp.rm(journalPath(p), { force: true }).catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw nothingChanged('Dim Factory could not write the new prices', err)
  }

  // 3. The renames; the first one is put back when the second fails.
  const done: ('models' | 'pricing')[] = []
  try {
    for (const k of order) {
      const tmp = staged[k]
      if (tmp !== undefined) {
        await retrying('cannot replace', files[k], io.delays, () => io.fs.rename(tmp, files[k]))
      } else {
        await retrying('cannot remove', files[k], io.delays, () => io.fs.rm(files[k], { force: true }))
      }
      delete staged[k]
      done.push(k)
    }
  } catch (err) {
    await dropStaged()
    try {
      for (const k of done) await putBack(files[k], before[k], io)
    } catch (restoreErr) {
      // The journal stays: recoverPendingCommit puts the backup back before the next read or write.
      throw storageError(
        'The prices could not be updated, and the previous prices could not be put back yet (Dim Factory puts them back the next time it reads them)',
        restoreErr,
      )
    }
    await fsp.rm(journalPath(p), { force: true }).catch(() => undefined)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw nothingChanged('The prices could not be updated', err)
  }

  // 4. Committed.
  await fsp.rm(journalPath(p), { force: true }).catch(() => undefined)
  await rotate(p, io.keep).catch(() => undefined)
  return m
}

function nothingChanged(what: string, err: unknown): DimFactoryError {
  const inner = err instanceof DimFactoryError ? err : storageError('storage error', err)
  return new DimFactoryError('STORAGE', `${what}; nothing was changed. ${inner.message}`, {
    cause: err,
    ...(inner.details !== undefined ? { details: inner.details } : {}),
  })
}

/**
 * Settle a commit a crash or a failed put-back left behind (catalog/.commit.json): keep the new pair when both files
 * carry it, else put the backup back. Safe to call any time; `none` when there was nothing to settle.
 */
export async function recoverPendingCommit(
  home: CatalogHome,
  o: CatalogIoOptions = {},
): Promise<'none' | 'committed' | 'rolled-back'> {
  const p = pathsOf(home)
  const io = ioOf(o)
  const raw = await readBytes(journalPath(p)).catch(() => null)
  if (raw === null) return 'none'
  let id: unknown
  try {
    id = (JSON.parse(raw.toString('utf8')) as Record<string, unknown>)['id']
  } catch {
    id = undefined
  }
  const meta = typeof id === 'string' && HISTORY_ID.test(id) ? await readMeta(p, id) : null
  if (meta === null) {
    await fsp.rm(journalPath(p), { force: true })
    return 'none'
  }
  const cur = { models: await readBytes(p.catalogModels), pricing: await readBytes(p.catalogPricing) }
  if (sha(cur.models) === meta.after.models && sha(cur.pricing) === meta.after.pricing) {
    await fsp.rm(journalPath(p), { force: true })
    return 'committed'
  }
  const dir = join(p.catalogHistoryDir, meta.id)
  for (const k of ['models', 'pricing'] as const) {
    const file = k === 'models' ? p.catalogModels : p.catalogPricing
    const backup = meta.before[k] ? await readBytes(join(dir, `${k}.json`)) : null
    if (meta.before[k] && backup === null) continue
    if (!equalBytes(cur[k], backup)) await putBack(file, backup, io)
  }
  await fsp.rm(journalPath(p), { force: true })
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  return 'rolled-back'
}

// ---- reading for a write ---------------------------------------------------------------------------------------------

/** A read problem that means entries of a file were left out (so writing the file back would drop them). */
const DROPPED_ENTRY = /^(pricing|models)\.json (entry #\d+|vendor .+) ignored /

/**
 * Read the pair for a change. `rewrite` (an apply, a manual price): refused while a file is unreadable or has entries
 * this Dim Factory cannot read, since the change rewrites the files from what was read.
 */
async function readForWrite(
  p: CatalogFilePaths,
  o: CatalogIoOptions,
  rewrite: boolean,
): Promise<CatalogReadResult> {
  await recoverPendingCommit(p, o)
  const read = await readCatalog(p, {
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.seedPath !== undefined ? { seedPath: o.seedPath } : {}),
  })
  if (read.readOnly.pricing || read.readOnly.models) {
    throw new DimFactoryError(
      'NEWER_SCHEMA',
      'The price list was saved by a newer Dim Factory; it is read-only here. Update Dim Factory to change it.',
    )
  }
  if (!rewrite) return read
  if (read.fallback.pricing || read.fallback.models) {
    const which = read.fallback.pricing ? p.catalogPricing : p.catalogModels
    throw new DimFactoryError(
      'STORAGE',
      `${which} cannot be read, so Dim Factory uses ${read.fallback.pricing ? 'its built-in prices' : 'an empty model list'} and will not write over the file. Fix or remove it, then try again.`,
      { details: { warnings: read.warnings } },
    )
  }
  const dropped = read.warnings.filter((w) => DROPPED_ENTRY.test(w))
  if (dropped.length > 0) {
    throw new DimFactoryError(
      'STORAGE',
      `Saving now would drop what Dim Factory cannot read in the price files (${dropped[0]}${dropped.length > 1 ? `, and ${dropped.length - 1} more` : ''}). Fix or remove those entries in ${p.catalogDir}, then try again.`,
      { details: { warnings: dropped } },
    )
  }
  return read
}

async function result(
  p: CatalogFilePaths,
  o: CatalogIoOptions,
  entry: HistoryMeta | null,
): Promise<CatalogChange> {
  const read = await readCatalog(p, {
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.seedPath !== undefined ? { seedPath: o.seedPath } : {}),
  })
  return {
    data: { models: read.models, pricing: read.pricing },
    entry: entry !== null ? toEntry(entry) : null,
    history: await listCatalogHistory(p),
  }
}

// ---- jobs -----------------------------------------------------------------------------------------------------------

/** catalog/jobs/<id>/ (the id checked as one safe path segment). */
export function catalogJobDir(p: Pick<CatalogFilePaths, 'catalogJobsDir'>, jobId: string): string {
  return join(p.catalogJobsDir, assertSafeSegment(jobId, 'job id'))
}

/** catalog/jobs/<id>/proposal.json as parsed JSON; NOT_FOUND when the job or its proposal is gone. */
export async function readJobProposal(p: CatalogFilePaths, jobId: string): Promise<unknown> {
  let dir: string
  try {
    dir = catalogJobDir(p, jobId)
  } catch {
    throw new DimFactoryError('NOT_FOUND', 'That price update does not exist.')
  }
  const raw = await readBytes(join(dir, 'proposal.json'))
  if (raw === null) throw new DimFactoryError('NOT_FOUND', 'The results of that price update are gone.')
  try {
    return JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) as unknown
  } catch (err) {
    throw new DimFactoryError(
      'NOT_FOUND',
      `The results of that price update cannot be read (${errorMessage(err)}).`,
    )
  }
}

/** status.json of a job as a raw object (missing or unreadable: null). */
export async function readJobStatusRaw(
  p: CatalogFilePaths,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBytes(join(catalogJobDir(p, jobId), 'status.json'))
    if (raw === null) return null
    const v: unknown = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
    return isPlainObject(v) ? v : null
  } catch {
    return null
  }
}

const jobState = (raw: Record<string, unknown> | null): string | null => {
  const s = raw?.['state'] ?? raw?.['status']
  return typeof s === 'string' ? s : null
}

/** Mark a job applied in its status.json (fields the refresh wrote are kept). Best effort. */
async function markJobApplied(p: CatalogFilePaths, jobId: string, at: number, rows: number): Promise<void> {
  const raw = (await readJobStatusRaw(p, jobId)) ?? { id: jobId }
  const next = { ...raw, state: 'applied', appliedAt: at, appliedRows: rows }
  if ('status' in next && typeof next['status'] === 'string') next['status'] = 'applied'
  await writeJsonAtomic(join(catalogJobDir(p, jobId), 'status.json'), next).catch(() => undefined)
}

// ---- the operations ---------------------------------------------------------------------------------------------------

export interface ApplyRowsOptions extends CatalogIoOptions {
  /** CLI model lists, official sources, user edits (validate.ts). */
  ctx?: ValidateContext
}

export interface ApplyRowsResult extends CatalogChange {
  jobId: string
  /** Distinct entries changed by ticked rows (ticked confirmations included). */
  entries: number
  /** Entries re-stamped by ticked confirm rows. */
  confirmed: number
}

/**
 * Apply the ticked rows of a finished refresh: the proposal in catalog/jobs/<id>/proposal.json is validated again
 * against the catalog as it is now, then the pair is committed with its backup. The job is marked applied.
 */
export function applyRows(
  home: CatalogHome,
  jobId: string,
  rowIds: readonly string[],
  o: ApplyRowsOptions = {},
): Promise<ApplyRowsResult> {
  const p = pathsOf(home)
  return serialized(p, async () => {
    const io = ioOf(o)
    const status = await readJobStatusRaw(p, jobId).catch(() => null)
    const state = jobState(status)
    if (state === 'applied') throw new DimFactoryError('CONFLICT', 'This price update was applied already.')
    if (state === 'running') throw new DimFactoryError('CONFLICT', 'This price update is still running.')
    if (state === 'failed' || state === 'cancelled') {
      throw new DimFactoryError('CONFLICT', 'This price update did not finish, so there is nothing to apply.')
    }
    const proposal = await readJobProposal(p, jobId)
    const read = await readForWrite(p, o, true)
    const current: CatalogData = { models: read.models, pricing: read.pricing }
    // The same review the user saw: the job's reads, the models it named and the vendors it covered (status.json).
    const checked = checkProposal(current, proposal, { ...o.ctx, ...jobValidateContext(status) })
    const now = io.now()
    const applied = applySelectedRows(current, checked, rowIds, now)
    let entry: HistoryMeta | null = null
    if (applied.changed) {
      entry = await commitPair(
        p,
        { models: jsonText(applied.next.models), pricing: jsonText(applied.next.pricing) },
        { source: 'refresh', entries: applied.entries, jobId, added: applied.added },
        io,
      )
    }
    await markJobApplied(p, jobId, now, rowIds.length)
    return { ...(await result(p, o, entry)), jobId, entries: applied.entries, confirmed: applied.confirmed }
  })
}

/**
 * A manual price (Settings → Catalog): bounds as a refresh, `confidence:'user'`, committed like an apply (so Undo puts
 * the previous prices back the same way).
 */
export function savePrice(
  home: CatalogHome,
  edit: PriceEdit,
  o: CatalogIoOptions = {},
): Promise<CatalogChange> {
  const p = pathsOf(home)
  return serialized(p, async () => {
    const io = ioOf(o)
    const read = await readForWrite(p, o, true)
    const r = applyPriceEdit(read.pricing, edit, io.now())
    const entry = r.changed
      ? await commitPair(
          p,
          { models: jsonText(read.models), pricing: jsonText(r.pricing) },
          { source: 'manual', entries: 1 },
          io,
        )
      : null
    return result(p, o, entry)
  })
}

/**
 * Undo the newest change not undone yet (an apply, a manual price, an earlier undo's target before it): its backup
 * pair comes back, committed like any change. NOT_FOUND when there is nothing to undo; CONFLICT when the files are no
 * longer what that change wrote.
 */
export function undoLast(home: CatalogHome, o: CatalogIoOptions = {}): Promise<CatalogChange> {
  const p = pathsOf(home)
  return serialized(p, async () => {
    const io = ioOf(o)
    // Undo writes back the backup's bytes, never a re-serialized read, so nothing it could not read is lost.
    await readForWrite(p, o, false)
    const metas = await readHistoryMetas(p)
    const target = undoCandidate(metas)
    if (target === null) throw new DimFactoryError('NOT_FOUND', 'There is no price change to undo.')
    const cur = { models: await readBytes(p.catalogModels), pricing: await readBytes(p.catalogPricing) }
    if (sha(cur.models) !== target.after.models || sha(cur.pricing) !== target.after.pricing) {
      throw new DimFactoryError(
        'CONFLICT',
        'The prices changed after that update, so Undo would lose those changes. Edit the prices in Settings → Catalog instead.',
        { details: { historyId: target.id } },
      )
    }
    const dir = join(p.catalogHistoryDir, target.id)
    const back = {
      models: target.before.models ? await readBytes(join(dir, 'models.json')) : null,
      pricing: target.before.pricing ? await readBytes(join(dir, 'pricing.json')) : null,
    }
    if ((target.before.models && back.models === null) || (target.before.pricing && back.pricing === null)) {
      throw new DimFactoryError(
        'NOT_FOUND',
        'The copy of the earlier prices is missing, so this change cannot be undone.',
      )
    }
    const entry = await commitPair(
      p,
      back,
      {
        source: 'undo',
        entries: target.entries,
        revertOf: target.id,
        ...(target.jobId !== undefined ? { jobId: target.jobId } : {}),
      },
      io,
    )
    const undone: HistoryMeta = { ...target, undone: true }
    await writeJsonAtomic(join(dir, 'meta.json'), undone).catch(() => undefined)
    return result(p, o, entry)
  })
}

/** For tests and diagnostics: the parsed files as JSON text, the way a commit writes them. */
export function catalogFileText(value: ModelsFile | PricingFile): string {
  return jsonText(value)
}
