import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DimFactoryError } from '../../../src/core/errors.ts'
import {
  CURRENT_SCHEMA_VERSION,
  readVersionedJson,
  schemaVersionOf,
  upgradeDoc,
  versionInfo,
  withSchemaVersion,
  writeVersionedJson,
} from '../../../src/core/store/versions.ts'

const home = (): string => process.env['DIM_FACTORY_HOME'] ?? ''

describe('schema versions', () => {
  it('reads schemaVersion (absent ⇒ 1, junk ⇒ corrupt)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1)
    expect(schemaVersionOf({})).toBe(1)
    expect(schemaVersionOf({ schemaVersion: 3 })).toBe(3)
    expect(schemaVersionOf({ schemaVersion: '1' })).toBeNull()
    expect(schemaVersionOf({ schemaVersion: 0 })).toBeNull()
    expect(schemaVersionOf([])).toBeNull()
    expect(versionInfo({ schemaVersion: 2 })).toEqual({ version: 2, readOnly: true })
    expect(versionInfo({ schemaVersion: 1 })).toEqual({ version: 1, readOnly: false })
  })

  it('upgrades older documents in memory and keeps unknown fields', () => {
    const out = upgradeDoc({ schemaVersion: 1, a: 1, keep: true }, { 1: (d) => ({ ...d, b: 2 }) }, 2)
    expect(out).toEqual({ schemaVersion: 2, a: 1, b: 2, keep: true })
    expect(() => upgradeDoc({ schemaVersion: 1 }, {}, 2)).toThrow(DimFactoryError)
  })

  it('withSchemaVersion puts schemaVersion first and forces it', () => {
    expect(Object.keys(withSchemaVersion({ z: 1, schemaVersion: 9 }))).toEqual(['schemaVersion', 'z'])
    expect(withSchemaVersion({ schemaVersion: 9 })).toEqual({ schemaVersion: 1 })
  })
})

describe('readVersionedJson / writeVersionedJson', () => {
  it('a newer file opens read-only and refuses writes with NEWER_SCHEMA', async () => {
    const file = join(home(), 'f.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 2, future: { x: 1 } }))
    const r = await readVersionedJson(file)
    expect(r).toEqual({
      kind: 'ok',
      value: { schemaVersion: 2, future: { x: 1 } },
      version: 2,
      readOnly: true,
    })
    const err = await writeVersionedJson(file, { x: 1 }).catch((e: unknown) => e)
    expect((err as DimFactoryError).code).toBe('NEWER_SCHEMA')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 2, future: { x: 1 } })
  })

  it('writes schemaVersion:1 and round-trips; validate can mark a file corrupt', async () => {
    const file = join(home(), 'g.json')
    await writeVersionedJson(file, { a: 1 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, a: 1 })
    const ok = await readVersionedJson(file, { validate: (d) => (typeof d['a'] === 'number' ? d : null) })
    expect(ok.kind).toBe('ok')
    const bad = await readVersionedJson(file, { validate: () => null })
    expect(bad.kind).toBe('corrupt')
    expect(await readVersionedJson(join(home(), 'none.json'))).toEqual({ kind: 'missing' })
    await writeFile(file, '[1,2]')
    expect((await readVersionedJson(file)).kind).toBe('corrupt')
  })
})
