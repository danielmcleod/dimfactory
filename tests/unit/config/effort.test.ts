// Per-pass effort levels: the schema (`passes.<p>.effort`, `vendors.<id>.defaultEffort`), the resolver (layers,
// provenance, the vendor default, Fix inheriting Implement's effort with its model), resolved.json written before
// effort existed, the config_patch allowlist, and the shared helpers the adapters and pickers use.
import { describe, expect, it } from 'vitest'
import {
  DimFactoryConfigZ,
  EffortZ,
  PassConfigZ,
  ResolvedConfigZ,
  RunOverridesZ,
} from '@shared/config-schema.ts'
import type { DimFactoryConfig } from '@shared/config-schema.ts'
import {
  EFFORT_VENDORS,
  effortProblem,
  effortsFor,
  isEffortLevel,
  modelEfforts,
  supportsEffort,
} from '@shared/vendors.ts'
import type { ModelInfo } from '@shared/vendors.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { parseConfigText, toConfigLayer } from '@core/config/load.ts'
import type { ConfigLayer } from '@core/config/load.ts'
import { checkAllowlisted, validatePatchOps } from '@core/config/patch.ts'
import { resolve, resolvedFromFile } from '@core/config/resolve.ts'

const home = (): string => {
  const h = process.env['DIM_FACTORY_HOME']
  if (h === undefined) throw new Error('DIM_FACTORY_HOME is not set (tests/setup/home.ts)')
  return h
}

function layer(scope: 'user' | 'project', cfg: DimFactoryConfig): ConfigLayer {
  const r = parseConfigText(JSON.stringify(cfg, null, 2), { file: `${scope}.json`, scope })
  const l = toConfigLayer(r)
  if (l === undefined) throw new Error(`invalid ${scope} layer: ${JSON.stringify(r.issues)}`)
  return l
}

describe('schema', () => {
  it('an effort is lower-case letters (1 to 20) or null', () => {
    for (const ok of ['low', 'medium', 'high', 'xhigh', 'max', null])
      expect(EffortZ.safeParse(ok).success).toBe(true)
    for (const bad of ['', 'High', 'high --x', 'high;rm', '--effort', 'x'.repeat(21), 'h1gh', 3]) {
      expect(EffortZ.safeParse(bad).success).toBe(false)
    }
  })

  it('a pass may set effort in a profile, in passes and in the run layer; vendors may set defaultEffort', () => {
    expect(PassConfigZ.safeParse({ vendor: 'claude', model: 'opus', effort: 'high' }).success).toBe(true)
    expect(PassConfigZ.safeParse({ effort: 'high --dangerously-skip-permissions' }).success).toBe(false)
    expect(
      DimFactoryConfigZ.safeParse({
        profiles: { mine: { plan: { effort: 'max' }, fix: { effort: null } } },
        passes: { review: { effort: 'low' } },
        vendors: { codex: { defaultModel: 'gpt-6-luna', defaultEffort: 'xhigh' } },
      }).success,
    ).toBe(true)
    expect(DimFactoryConfigZ.safeParse({ vendors: { codex: { defaultEffort: 'XHIGH' } } }).success).toBe(
      false,
    )
    expect(RunOverridesZ.safeParse({ passes: { implement: { effort: 'high' } } }).success).toBe(true)
    expect(RunOverridesZ.safeParse({ passes: { implement: { effort: 'high -c x' } } }).success).toBe(false)
  })

  it('a resolved.json written before effort existed loads with the default effort everywhere', () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const old = structuredClone(cfg) as unknown as {
      passes: Record<string, Record<string, unknown>>
      vendors: Record<string, Record<string, unknown>>
    }
    for (const p of Object.values(old.passes)) delete p['effort']
    old.vendors = { claude: { path: null, defaultModel: null, extraArgs: [], env: {}, flagMap: {} } }
    const parsed = ResolvedConfigZ.parse(old)
    expect(parsed.passes.plan.effort).toBeNull()
    expect(parsed.passes.fix.effort).toBeNull()
    expect(parsed.vendors['claude']?.defaultEffort).toBeNull()
    expect(resolvedFromFile({ config: old }).config.passes.implement.effort).toBeNull()
  })
})

describe('resolve', () => {
  it('every pass resolves an effort: null by default (provenance cli)', () => {
    const r = resolve({ home: home() })
    for (const p of ['plan', 'implement', 'review', 'critic', 'fix'] as const) {
      expect(r.config.passes[p].effort).toBeNull()
    }
    expect(r.provenance['/passes/plan/effort']?.source).toBe('cli')
  })

  it('profile, passes and run layers set it, each with its provenance', () => {
    const r = resolve({
      home: home(),
      user: layer('user', {
        profiles: { balanced: { plan: { effort: 'high' } } },
        passes: { review: { effort: 'low' } },
      }),
      run: { passes: { critic: { effort: 'max' } } },
    })
    expect(r.config.passes.plan.effort).toBe('high')
    expect(r.provenance['/passes/plan/effort']).toMatchObject({ source: 'user', via: 'profile:balanced' })
    expect(r.config.passes.review.effort).toBe('low')
    expect(r.provenance['/passes/review/effort']).toMatchObject({ source: 'user', via: 'passes' })
    expect(r.config.passes.critic.effort).toBe('max')
    expect(r.provenance['/passes/critic/effort']).toMatchObject({ source: 'run' })
  })

  it("a null effort takes the vendor's defaultEffort (provenance vendor), never replacing a set one", () => {
    const r = resolve({
      home: home(),
      user: layer('user', {
        vendors: { claude: { defaultEffort: 'medium' } },
        passes: { critic: { effort: 'max' } },
      }),
    })
    // balanced: Plan, Review and Critic on Claude, Implement and Fix on Codex.
    expect(r.config.passes.plan.effort).toBe('medium')
    expect(r.provenance['/passes/plan/effort']).toMatchObject({
      source: 'vendor',
      via: '/vendors/claude/defaultEffort',
    })
    expect(r.config.passes.critic.effort).toBe('max')
    expect(r.config.passes.implement.effort).toBeNull()
    expect(r.config.vendors['claude']?.defaultEffort).toBe('medium')
  })

  it("fix.inherit copies Implement's effort with its model", () => {
    const r = resolve({
      home: home(),
      user: layer('user', { passes: { implement: { model: 'gpt-6-luna', effort: 'xhigh' } } }),
    })
    expect(r.config.passes.fix).toMatchObject({ vendor: 'codex', model: 'gpt-6-luna', effort: 'xhigh' })
    expect(r.provenance['/passes/fix/effort']).toMatchObject({ source: 'inherit', via: 'inherit:implement' })
  })

  it("Fix's own effort wins; its own model or another vendor stops the copy", () => {
    const own = resolve({
      home: home(),
      user: layer('user', { passes: { implement: { effort: 'xhigh' }, fix: { effort: 'low' } } }),
    })
    expect(own.config.passes.fix.effort).toBe('low')
    const ownModel = resolve({
      home: home(),
      user: layer('user', { passes: { implement: { effort: 'xhigh' }, fix: { model: 'gpt-6-sol' } } }),
    })
    expect(ownModel.config.passes.fix).toMatchObject({ model: 'gpt-6-sol', effort: null })
    const other = resolve({
      home: home(),
      user: layer('user', { passes: { implement: { effort: 'xhigh' }, fix: { vendor: 'claude' } } }),
    })
    expect(other.config.passes.fix).toMatchObject({ vendor: 'claude', effort: null })
    // Off: nothing is copied.
    const off = resolve({
      home: home(),
      user: layer('user', {
        passes: { implement: { effort: 'xhigh' }, fix: { inherit: null, vendor: 'codex' } },
      }),
    })
    expect(off.config.passes.fix.effort).toBeNull()
  })
})

describe('config_patch allowlist', () => {
  it('a recovery may set or clear a pass effort, nothing else under it', () => {
    expect(checkAllowlisted(['passes', 'implement', 'effort'])).toEqual({ ok: true })
    expect(checkAllowlisted(['profiles', 'mine', 'implement', 'effort']).ok).toBe(false)
    expect(checkAllowlisted(['vendors', 'claude', 'defaultEffort']).ok).toBe(false)
    const v = validatePatchOps([{ op: 'add', path: '/passes/plan/effort', value: null }], {
      scope: 'user',
      allowlist: true,
    })
    expect(v.ok).toBe(true)
  })
})

describe('shared helpers', () => {
  const models: ModelInfo[] = [
    { id: 'default', isDefault: true, efforts: ['low', 'medium', 'high'], source: 'cli' },
    { id: 'opus', aliases: ['claude-opus-5-5'], efforts: ['low', 'high', 'max'], source: 'cli' },
    { id: 'haiku', source: 'cli' },
  ]

  it('isEffortLevel and effortProblem take plain levels only', () => {
    expect(isEffortLevel('high')).toBe(true)
    expect(isEffortLevel('high --x')).toBe(false)
    expect(isEffortLevel(undefined)).toBe(false)
    expect(effortProblem(null)).toBeUndefined()
    expect(effortProblem(undefined)).toBeUndefined()
    expect(effortProblem('max')).toBeUndefined()
    expect(effortProblem('high --x')).toMatch(/is not an effort level/)
  })

  it("modelEfforts: the model's own levels (by id or alias; null = the default), else undefined", () => {
    expect(modelEfforts(models, 'opus')).toEqual(['low', 'high', 'max'])
    expect(modelEfforts(models, 'claude-opus-5-5')).toEqual(['low', 'high', 'max'])
    expect(modelEfforts(models, null)).toEqual(['low', 'medium', 'high'])
    expect(modelEfforts(models, 'haiku')).toBeUndefined()
    expect(modelEfforts(models, 'gpt-x')).toBeUndefined()
  })

  it("effortsFor falls back to every level the vendor's models list", () => {
    expect(effortsFor(models, 'opus')).toEqual(['low', 'high', 'max'])
    expect(effortsFor(models, 'haiku')).toEqual(['low', 'medium', 'high', 'max'])
    expect(effortsFor([], null)).toEqual([])
  })

  it('only Claude and Codex take an effort; a local preset does not', () => {
    expect([...EFFORT_VENDORS]).toEqual(['claude', 'codex'])
    expect(supportsEffort('claude')).toBe(true)
    expect(supportsEffort('codex')).toBe(true)
    for (const v of ['gemini', 'grok', 'muse', 'local-ollama', undefined])
      expect(supportsEffort(v)).toBe(false)
  })
})
