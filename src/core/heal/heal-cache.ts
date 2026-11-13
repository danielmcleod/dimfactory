// Self-heal result cache (`heal/cache.json`): 24 h, keyed by
// (category, vendor, version, normalized stderr signature). It stores the healer's validated answer, not the actions,
// so a hit goes through the same safety pass as a fresh answer. schemaVersion 1; atomic writes; a newer file is only
// read, never written.
import { createHash } from 'node:crypto'
import type { FailureCategory } from '../../shared/failure.ts'
import { writeJsonAtomic } from '../store/atomic.ts'
import { CURRENT_SCHEMA_VERSION, readVersionedJson, withSchemaVersion } from '../store/versions.ts'
import type { HealAnswer } from './parse-heal.ts'
import { HealAnswerZ, normalizeAnswer } from './parse-heal.ts'

export const HEAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** Newest entries kept on write. */
export const HEAL_CACHE_MAX_ENTRIES = 200

export interface HealCacheKeyParts {
  category: FailureCategory
  /** The failing vendor. */
  vendor: string
  /** Its CLI version (null: unknown). */
  version: string | null
  /** heal-input.ts healSignature. */
  signature: string
}

/** The cache key: sha256 of the four parts (stable across processes). */
export function healCacheKey(k: HealCacheKeyParts): string {
  return createHash('sha256')
    .update(JSON.stringify([k.category, k.vendor, k.version ?? '', k.signature]), 'utf8')
    .digest('hex')
}

export interface HealCacheEntry {
  at: number
  /** The vendor that answered. */
  healer: string
  answer: HealAnswer
}

interface CacheDoc {
  entries: Record<string, HealCacheEntry>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function validEntry(v: unknown): HealCacheEntry | null {
  if (
    !isObj(v) ||
    typeof v['at'] !== 'number' ||
    !Number.isFinite(v['at']) ||
    typeof v['healer'] !== 'string'
  ) {
    return null
  }
  const r = HealAnswerZ.safeParse(v['answer'])
  if (!r.success) return null
  const answer = normalizeAnswer(r.data)
  return answer === null ? null : { at: v['at'], healer: v['healer'], answer }
}

function validDoc(doc: Record<string, unknown>): CacheDoc {
  const entries: Record<string, HealCacheEntry> = {}
  const raw = doc['entries']
  if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!/^[0-9a-f]{64}$/.test(k)) continue
      const e = validEntry(v)
      if (e !== null) entries[k] = e
    }
  }
  return { entries }
}

/** Serializes the read-modify-write of one cache file within this process. */
const chains = new Map<string, Promise<unknown>>()

function serialized<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prev = chains.get(file) ?? Promise.resolve()
  const next = prev.then(op, op)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  chains.set(file, tail)
  void tail.then(() => {
    if (chains.get(file) === tail) chains.delete(file)
  })
  return next
}

export interface HealCacheOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

/** `heal/cache.json` under DIM_FACTORY_HOME. Read failures are a miss; write failures are reported to the caller. */
export class HealCache {
  readonly file: string
  readonly #ttl: number
  readonly #max: number
  readonly #now: () => number

  constructor(file: string, o: HealCacheOptions = {}) {
    this.file = file
    this.#ttl = o.ttlMs ?? HEAL_CACHE_TTL_MS
    this.#max = o.maxEntries ?? HEAL_CACHE_MAX_ENTRIES
    this.#now = o.now ?? Date.now
  }

  async #read(): Promise<{ doc: CacheDoc; writable: boolean }> {
    try {
      const r = await readVersionedJson(this.file, { validate: validDoc })
      if (r.kind === 'ok') return { doc: r.value, writable: !r.readOnly }
    } catch {
      // unreadable: a miss, rewritten on the next store
    }
    return { doc: { entries: {} }, writable: true }
  }

  #fresh(e: HealCacheEntry, now: number): boolean {
    return e.at <= now + 60_000 && now - e.at < this.#ttl
  }

  /** The entry for `key` while it is younger than 24 h. */
  async get(key: string): Promise<HealCacheEntry | undefined> {
    const { doc } = await this.#read()
    const e = doc.entries[key]
    return e !== undefined && this.#fresh(e, this.#now()) ? e : undefined
  }

  /** Store an answer, dropping expired entries and keeping the newest {@link HEAL_CACHE_MAX_ENTRIES}. */
  set(key: string, entry: HealCacheEntry): Promise<void> {
    return serialized(this.file, async () => {
      const { doc, writable } = await this.#read()
      if (!writable) return
      const now = this.#now()
      const kept = Object.entries({ ...doc.entries, [key]: entry })
        .filter(([, e]) => this.#fresh(e, now))
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, this.#max)
      const out: CacheDoc = { entries: Object.fromEntries(kept) }
      await writeJsonAtomic(this.file, withSchemaVersion(out, CURRENT_SCHEMA_VERSION))
    })
  }
}
