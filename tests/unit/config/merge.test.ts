import { describe, expect, it } from 'vitest'
import { deepMerge as builtinDeepMerge } from '@core/config/builtins.ts'
import { deepMerge, isPlainObject, leaves, omitKeys } from '@core/config/merge.ts'

describe('deepMerge (Resolve step 1)', () => {
  it('objects merge recursively; later layers win', () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }, { a: { d: 4 } })).toEqual({
      a: { b: 1, c: 3, d: 4 },
    })
  })

  it('arrays replace whole (never concatenate or merge by index)', () => {
    expect(deepMerge({ runAfter: ['implement', 'fix'] }, { runAfter: ['fix'] })).toEqual({
      runAfter: ['fix'],
    })
    expect(deepMerge({ copy: ['a', 'b'] }, { copy: [] })).toEqual({ copy: [] })
    expect(deepMerge({ list: [{ a: 1 }] }, { list: [{ b: 2 }] })).toEqual({ list: [{ b: 2 }] })
  })

  it('null is a value (sets null, does not delete); a missing/undefined key inherits', () => {
    expect(deepMerge({ model: 'opus', mode: 'readonly' }, { model: null })).toEqual({
      model: null,
      mode: 'readonly',
    })
    expect(deepMerge({ model: 'opus' }, { model: undefined })).toEqual({ model: 'opus' })
    expect(deepMerge({ model: 'opus' }, undefined)).toEqual({ model: 'opus' })
  })

  it('records merge per key', () => {
    const user = { vendors: { claude: { defaultModel: 'sonnet', env: { A: '1' } } } }
    const more = { vendors: { claude: { env: { B: '2' } }, codex: { path: null } } }
    expect(deepMerge(user, more)).toEqual({
      vendors: { claude: { defaultModel: 'sonnet', env: { A: '1', B: '2' } }, codex: { path: null } },
    })
  })

  it('a scalar over an object (and vice versa) replaces it', () => {
    expect(deepMerge({ closeToTray: { x: 1 } }, { closeToTray: 'auto' })).toEqual({ closeToTray: 'auto' })
    expect(deepMerge({ run: 'pnpm test' }, { run: ['pnpm', 'test'] })).toEqual({ run: ['pnpm', 'test'] })
  })

  it('never mutates inputs and shares no structure with them', () => {
    const base = { a: { b: [1, 2] } }
    const layer = { a: { c: { d: 1 } } }
    const out = deepMerge(base, layer)
    out.a.b.push(3)
    ;(out.a as unknown as { c: { d: number } }).c.d = 9
    expect(base).toEqual({ a: { b: [1, 2] } })
    expect(layer).toEqual({ a: { c: { d: 1 } } })
  })

  it('agrees with the builtins deepMerge', () => {
    const cases: [unknown, unknown[]][] = [
      [
        { a: { b: 1, c: [1, 2] }, d: 'x', e: { f: 1 } },
        [{ a: { c: [3] }, d: null, e: undefined }, { a: { g: true } }],
      ],
      [{ v: {} }, [{ v: { x: { y: 1 } } }, { v: { x: { z: 2 } } }]],
    ]
    for (const [base, layers] of cases)
      expect(deepMerge(base, ...layers)).toEqual(builtinDeepMerge(base, ...layers))
  })
})

describe('helpers', () => {
  it('isPlainObject', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })

  it('omitKeys drops top-level keys only', () => {
    expect(omitKeys({ a: 1, b: { a: 2 }, c: 3 }, ['a', 'c'])).toEqual({ b: { a: 2 } })
  })

  it('leaves: scalars, nulls, arrays and empty objects; undefined skipped', () => {
    expect(leaves({ a: { b: 1, c: null, d: [1], e: {}, f: undefined } }, ['root'])).toEqual([
      [['root', 'a', 'b'], 1],
      [['root', 'a', 'c'], null],
      [['root', 'a', 'd'], [1]],
      [['root', 'a', 'e'], {}],
    ])
    expect(leaves(5, ['x'])).toEqual([[['x'], 5]])
    expect(leaves(undefined, ['x'])).toEqual([])
  })
})
