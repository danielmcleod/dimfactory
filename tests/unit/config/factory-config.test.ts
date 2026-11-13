// The factory's config: model routing in profiles and in `passes` (with provenance), the defaults of factory,
// fallback, quality and memory, and which scope may set them.
import { describe, expect, it } from 'vitest'
import { BUILTIN_DEFAULTS, QUALITY_DEFAULTS } from '@core/config/defaults.ts'
import { parseConfigText, toConfigLayer } from '@core/config/load.ts'
import type { ConfigLayer } from '@core/config/load.ts'
import { ConfigResolveError, resolve } from '@core/config/resolve.ts'
import { DimFactoryConfigZ, FACTORY_DEFAULTS, validateSemantics } from '@shared/config-schema.ts'
import type { DimFactoryConfig } from '@shared/config-schema.ts'
import { MEMORY_DEFAULT_MAX_BYTES } from '@shared/factory.ts'

function layer(scope: 'user' | 'project', cfg: DimFactoryConfig): ConfigLayer {
  const r = parseConfigText(JSON.stringify(cfg, null, 2), { file: `${scope}.json`, scope })
  const l = toConfigLayer(r)
  if (l === undefined) throw new Error(`invalid ${scope} layer: ${JSON.stringify(r.issues)}`)
  return l
}

describe('model routing', () => {
  it('no routing by default', () => {
    expect(resolve({}).config.routing).toEqual({})
  })

  it("the selected profile's routing applies; passes.routing and the run win over it, key by key", () => {
    const r = resolve({
      user: layer('user', {
        profiles: {
          balanced: { routing: { research: { model: 'haiku', effort: 'low' }, explain: { model: 'haiku' } } },
        },
      }),
      project: layer('project', { passes: { routing: { research: { model: 'sonnet' } } } }),
      run: { passes: { routing: { explain: { model: null } } } },
    })
    expect(r.config.routing).toEqual({
      research: { model: 'sonnet', effort: 'low' },
      explain: { model: null },
    })
    expect(r.provenance['/routing/research/model']).toMatchObject({ source: 'project', via: 'passes' })
    expect(r.provenance['/routing/research/effort']).toMatchObject({
      source: 'user',
      via: 'profile:balanced',
    })
    expect(r.provenance['/routing/explain/model']).toMatchObject({ source: 'run' })
  })

  it("another profile's routing does not apply", () => {
    const r = resolve({
      user: layer('user', { profiles: { thorough: { routing: { research: { model: 'haiku' } } } } }),
    })
    expect(r.config.routing).toEqual({})
  })

  it('only the routed steps take a route, and only model and effort', () => {
    expect(DimFactoryConfigZ.safeParse({ passes: { routing: { plan: { model: 'x' } } } }).success).toBe(false)
    expect(
      DimFactoryConfigZ.safeParse({ passes: { routing: { research: { vendor: 'codex' } } } }).success,
    ).toBe(false)
    expect(
      DimFactoryConfigZ.safeParse({ passes: { routing: { recheck: { effort: 'high' } } } }).success,
    ).toBe(true)
  })
})

describe('factory, fallback, quality and memory defaults', () => {
  it('resolve fills every key; memory.autoApply and quality are off unless a project sets them', () => {
    const r = resolve({})
    expect(r.config.factory).toEqual(FACTORY_DEFAULTS)
    expect(r.config.fallback).toEqual({ enabled: false, vendors: [] })
    expect(r.config.quality).toEqual(QUALITY_DEFAULTS)
    expect(r.config.memory).toEqual({
      enabled: true,
      propose: true,
      autoApply: false,
      maxBytes: MEMORY_DEFAULT_MAX_BYTES,
    })
    expect(r.provenance['/memory/autoApply']).toEqual({ source: 'default' })
    expect(r.provenance['/quality/enabled']).toEqual({ source: 'default' })
  })

  it('a project opts into memory.autoApply and quality gates; the user schedule is merged key by key', () => {
    const r = resolve({
      user: layer('user', { factory: { maxParallel: 4, schedule: { enabled: true } } }),
      project: layer('project', {
        memory: { autoApply: true },
        quality: { enabled: true, verify: ['test'], security: true },
      }),
    })
    expect(r.config.memory.autoApply).toBe(true)
    expect(r.config.quality).toEqual({ enabled: true, verify: ['test'], security: true, acceptance: false })
    expect(r.config.factory.maxParallel).toBe(4)
    expect(r.config.factory.schedule).toEqual({ ...FACTORY_DEFAULTS.schedule, enabled: true })
  })

  it('layer 0 is a valid user file', () => {
    expect(validateSemantics(BUILTIN_DEFAULTS as DimFactoryConfig, { scope: 'user' })).toEqual([])
    expect('autoApply' in BUILTIN_DEFAULTS.memory).toBe(false)
  })
})

describe('which file may set what', () => {
  it('a user file may not set quality or memory.autoApply', () => {
    const issues = validateSemantics(
      { quality: { enabled: true }, memory: { autoApply: true } },
      { scope: 'user' },
    )
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/memory/autoApply', 'project-only-key'],
      ['/quality', 'project-only-key'],
    ])
    expect(issues.every((i) => !i.message.includes('\u2014'))).toBe(true)
  })

  it('a project file may not set the factory (budgets and the schedule are yours)', () => {
    const issues = validateSemantics({ factory: { maxCostPerDayUsd: 1000 } }, { scope: 'project' })
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([['/factory', 'user-only-key']])
    // A project's factory section is never applied.
    const r = resolve({
      project: { ...layer('project', {}), value: { factory: { maxCostPerDayUsd: 1000 } } },
    })
    expect(r.config.factory.maxCostPerDayUsd).toBeNull()
  })

  it('fallback and memory (but autoApply) are fine in either file', () => {
    const cfg: DimFactoryConfig = {
      fallback: { enabled: true, vendors: ['codex'] },
      memory: { maxBytes: 4096 },
    }
    expect(validateSemantics(cfg, { scope: 'user' })).toEqual([])
    expect(validateSemantics(cfg, { scope: 'project' })).toEqual([])
  })

  it('the schema bounds: HH:MM schedule times, days 0-6, maxBytes, fix rounds', () => {
    const bad: unknown[] = [
      { factory: { schedule: { start: '25:00' } } },
      { factory: { schedule: { days: [7] } } },
      { factory: { schedule: { days: [] } } },
      { factory: { maxFixRounds: 4 } },
      { factory: { maxParallel: 0 } },
      { memory: { maxBytes: 100 } },
      { quality: { verify: [''] } },
    ]
    for (const b of bad) expect(DimFactoryConfigZ.safeParse(b).success, JSON.stringify(b)).toBe(false)
    expect(DimFactoryConfigZ.safeParse({ factory: { schedule: { end: null } } }).success).toBe(true)
  })

  it('an invalid routing in a profile is a resolve error with its place', () => {
    expect(() => resolve({ run: { passes: { routing: { research: { model: '' } } } } })).toThrow(
      ConfigResolveError,
    )
  })
})
