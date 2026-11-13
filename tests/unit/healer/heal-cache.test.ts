// Self-heal cache: 24 h, keyed by (category, vendor, version, normalized
// stderr signature), `heal/cache.json` with schemaVersion 1, atomic writes; a newer file is read-only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homePaths } from '@core/home.ts'
import { HEAL_CACHE_TTL_MS, HealCache, healCacheKey } from '@core/heal/heal-cache.ts'
import { healSignature } from '@core/heal/heal-input.ts'
import type { HealAnswer } from '@core/heal/parse-heal.ts'

const ANSWER: HealAnswer = {
  diagnosis: 'Claude Code is not logged in.',
  confidence: 'high',
  category: 'auth_required',
  actions: [{ kind: 'shell', command: 'claude auth login', reason: 'Sign in.' }],
}

function cacheFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heal-cache-'))
  return homePaths(dir).healCache
}

const keyFor = (
  stderr: string[],
  o: { category?: 'unknown' | 'flag_drift'; version?: string | null } = {},
): string =>
  healCacheKey({
    category: o.category ?? 'unknown',
    vendor: 'claude',
    version: o.version === undefined ? '2.1.289' : o.version,
    signature: healSignature(
      'claude exited with code 1',
      stderr.map((l) => `stderr: ${l}`),
    ),
  })

describe('healCacheKey', () => {
  it('normalizes the stderr signature: run-specific ids, numbers and paths do not matter', () => {
    expect(
      keyFor([
        'No conversation found with session ID: fa4ecb4e-ac4a-4078-8783-fa1e4b132e44',
        'at /home/a/x.js:10',
      ]),
    ).toBe(
      keyFor([
        'No conversation found with session ID: 0e5b7a21-1111-4222-8333-944455556666',
        'at /Users/b/y.js:99',
      ]),
    )
    expect(keyFor(['Error: retry 3 of 10'])).toBe(keyFor(['error:   RETRY 7 of 10']))
  })

  it('separates categories, versions and different errors', () => {
    const base = keyFor(['error: unknown option --x'])
    expect(keyFor(['error: unknown option --x'], { category: 'flag_drift' })).not.toBe(base)
    expect(keyFor(['error: unknown option --x'], { version: '2.1.290' })).not.toBe(base)
    expect(keyFor(['error: unknown option --x'], { version: null })).not.toBe(base)
    expect(keyFor(['error: not logged in'])).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('HealCache', () => {
  it('misses before a store, then hits with the stored answer', async () => {
    const file = cacheFile()
    const cache = new HealCache(file, { now: () => 1_000 })
    const key = keyFor(['boom'])
    expect(await cache.get(key)).toBeUndefined()
    await cache.set(key, { at: 1_000, healer: 'claude', answer: ANSWER })
    expect(await cache.get(key)).toEqual({ at: 1_000, healer: 'claude', answer: ANSWER })
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      schemaVersion: number
      entries: Record<string, unknown>
    }
    expect(doc.schemaVersion).toBe(1)
    expect(Object.keys(doc.entries)).toEqual([key])
  })

  it('expires after 24 hours', async () => {
    const file = cacheFile()
    let now = 5_000
    const cache = new HealCache(file, { now: () => now })
    const key = keyFor(['boom'])
    await cache.set(key, { at: now, healer: 'claude', answer: ANSWER })
    now += HEAL_CACHE_TTL_MS - 1
    expect(await cache.get(key)).toBeDefined()
    now += 1
    expect(await cache.get(key)).toBeUndefined()
  })

  it('drops expired entries and keeps the newest ones on write', async () => {
    const file = cacheFile()
    let now = 0
    const cache = new HealCache(file, { now: () => now, maxEntries: 2 })
    await cache.set(keyFor(['a']), { at: 0, healer: 'claude', answer: ANSWER })
    now = HEAL_CACHE_TTL_MS + 10
    await cache.set(keyFor(['b']), { at: now, healer: 'claude', answer: ANSWER })
    await cache.set(keyFor(['c']), { at: now + 1, healer: 'claude', answer: ANSWER })
    await cache.set(keyFor(['d']), { at: now + 2, healer: 'claude', answer: ANSWER })
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, unknown> }
    expect(Object.keys(doc.entries).sort()).toEqual([keyFor(['c']), keyFor(['d'])].sort())
  })

  it('serializes concurrent stores so none is lost', async () => {
    const file = cacheFile()
    const cache = new HealCache(file, { now: () => 1 })
    const keys = ['a', 'b', 'c', 'd', 'e'].map((s) => keyFor([s]))
    await Promise.all(keys.map((k) => cache.set(k, { at: 1, healer: 'claude', answer: ANSWER })))
    for (const k of keys) expect(await cache.get(k)).toBeDefined()
  })

  it('treats a corrupt file or a tampered entry as a miss and rewrites it', async () => {
    const file = cacheFile()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{ not json')
    const cache = new HealCache(file, { now: () => 1 })
    const key = keyFor(['x'])
    expect(await cache.get(key)).toBeUndefined()
    await cache.set(key, { at: 1, healer: 'claude', answer: ANSWER })
    expect(await cache.get(key)).toBeDefined()
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        entries: { [key]: { at: 1, healer: 'claude', answer: { diagnosis: 1 } } },
      }),
    )
    expect(await cache.get(key)).toBeUndefined()
  })

  it('reads but never writes a file from a newer Dim Factory', async () => {
    const file = cacheFile()
    mkdirSync(join(file, '..'), { recursive: true })
    const key = keyFor(['x'])
    const text = JSON.stringify({
      schemaVersion: 2,
      entries: { [key]: { at: 1, healer: 'claude', answer: ANSWER } },
    })
    writeFileSync(file, text)
    const cache = new HealCache(file, { now: () => 1 })
    expect(await cache.get(key)).toEqual({ at: 1, healer: 'claude', answer: ANSWER })
    await cache.set(keyFor(['y']), { at: 1, healer: 'claude', answer: ANSWER })
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('lives at heal/cache.json under DIM_FACTORY_HOME', () => {
    expect(homePaths('/h').healCache.replace(/\\/g, '/')).toMatch(/\/h\/heal\/cache\.json$/)
    expect(existsSync(cacheFile())).toBe(false)
  })
})
