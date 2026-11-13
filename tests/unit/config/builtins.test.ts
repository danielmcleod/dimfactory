import { describe, expect, it } from 'vitest'
import { DimFactoryConfigZ, ProfileZ, ResolvedConfigZ, validateSemantics } from '@shared/config-schema.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import { PASS_NAMES } from '@shared/run.ts'
import {
  BUILTIN_DEFAULTS,
  BUILTIN_PROFILES,
  BUILTIN_PROFILE_NAMES,
  BuiltinConfigError,
  deepMerge,
  enabledPasses,
  planImplementOverrides,
  mergeOverrides,
  resolveBuiltinConfig,
} from '@core/config/builtins.ts'

const errorOf = (fn: () => unknown): BuiltinConfigError => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(BuiltinConfigError)
    return err as BuiltinConfigError
  }
  throw new Error('expected a BuiltinConfigError')
}

describe('layer 0 (the defaults table)', () => {
  it('is a valid dimfactory.json with no semantic issues', () => {
    expect(DimFactoryConfigZ.safeParse(BUILTIN_DEFAULTS).success).toBe(true)
    expect(validateSemantics(DimFactoryConfigZ.parse(BUILTIN_DEFAULTS), { scope: 'user' })).toEqual([])
  })

  it('has the documented defaults', () => {
    expect(BUILTIN_DEFAULTS).toMatchObject({
      profile: 'balanced',
      gates: { afterPlan: true, beforeFix: false },
      auto: false,
      planning: { native: 'auto' },
      ask: { denyPauses: false },
      timeouts: { stallMs: 300000, hardKillMs: 1200000, toolStallMs: 900000, askMs: 600000 },
      isolation: {
        mode: 'inPlace',
        branch: 'none',
        branchPrefix: 'dim/',
        worktree: { copy: [], install: 'ask', installCommand: null, autoApply: false },
      },
      verify: {
        enabled: false,
        commands: [],
        runAfter: ['implement', 'fix'],
        failFast: false,
        baseline: false,
      },
      passes: {},
      selfHeal: { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false },
      ui: { theme: 'system', accent: 'slate', closeToTray: 'auto', streamFontSize: 13 },
      notifications: {
        desktop: true,
        sound: false,
        onlyWhenUnfocused: true,
        events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
      },
      vendors: {},
      catalog: { refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' } },
      storage: { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
      local: { presets: [] },
      preview: { openIn: 'ask' },
    })
  })

  it('is frozen', () => {
    expect(Object.isFrozen(BUILTIN_DEFAULTS)).toBe(true)
    expect(Object.isFrozen(BUILTIN_DEFAULTS.isolation.worktree)).toBe(true)
    expect(Object.isFrozen(BUILTIN_PROFILES.balanced.plan)).toBe(true)
  })
})

describe('built-in profiles', () => {
  it.each(BUILTIN_PROFILE_NAMES)('%s validates and resolves', (name) => {
    expect(ProfileZ.safeParse(BUILTIN_PROFILES[name]).success).toBe(true)
    const cfg = resolveBuiltinConfig({ profile: name })
    expect(ResolvedConfigZ.safeParse(cfg).success).toBe(true)
    expect(cfg.profile).toBe(name)
    for (const p of ['plan', 'review', 'critic'] as const) expect(cfg.passes[p].mode).toBe('readonly')
  })

  const row = (name: (typeof BUILTIN_PROFILE_NAMES)[number]) => {
    const c = resolveBuiltinConfig({ profile: name })
    return PASS_NAMES.map((p) => [
      p,
      c.passes[p].vendor,
      c.passes[p].model,
      c.passes[p].mode,
      c.passes[p].enabled,
    ])
  }

  it('balanced', () => {
    expect(row('balanced')).toEqual([
      ['plan', 'claude', 'opus', 'readonly', true],
      ['implement', 'codex', null, 'autoedit', true],
      ['review', 'claude', 'sonnet', 'readonly', true],
      ['critic', 'claude', 'opus', 'readonly', true],
      ['security', 'claude', 'opus', 'readonly', false],
      ['fix', 'codex', null, 'autoedit', true],
    ])
    expect(resolveBuiltinConfig().passes.fix).toMatchObject({ inherit: 'implement', reuseSession: true })
  })

  it('claude-only', () => {
    expect(row('claude-only')).toEqual([
      ['plan', 'claude', 'opus', 'readonly', true],
      ['implement', 'claude', null, 'autoedit', true],
      ['review', 'claude', 'sonnet', 'readonly', true],
      ['critic', 'claude', 'opus', 'readonly', true],
      ['security', 'claude', 'opus', 'readonly', false],
      ['fix', 'claude', null, 'autoedit', true],
    ])
  })

  it('codex-only', () => {
    expect(row('codex-only').map((r) => r[1])).toEqual(['codex', 'codex', 'codex', 'codex', 'codex', 'codex'])
    // The security advisor is opt-in: off here.
    expect(resolveBuiltinConfig({ profile: 'codex-only' }).passes.security.enabled).toBe(false)
  })

  it('fast: Plan (sonnet) and Critic are off', () => {
    expect(row('fast')).toEqual([
      ['plan', 'claude', 'sonnet', 'readonly', false],
      ['implement', 'codex', null, 'autoedit', true],
      ['review', 'claude', 'sonnet', 'readonly', true],
      ['critic', 'claude', null, 'readonly', false],
      ['security', 'claude', 'opus', 'readonly', false],
      ['fix', 'codex', null, 'autoedit', true],
    ])
  })

  it('thorough: Review on opus, Fix starts fresh', () => {
    const c = resolveBuiltinConfig({ profile: 'thorough' })
    expect(c.passes.review.model).toBe('opus')
    expect(c.passes.fix).toMatchObject({ vendor: 'codex', inherit: 'implement', reuseSession: false })
    // The security advisor is on in thorough only, on the strongest reasoning model, with its re-check.
    expect(c.passes.security).toMatchObject({
      vendor: 'claude',
      model: 'opus',
      mode: 'readonly',
      enabled: true,
      extensions: 'none',
      recheck: true,
    })
  })
})

describe('resolveBuiltinConfig', () => {
  it('defaults to balanced with builtin templates', () => {
    const c = resolveBuiltinConfig()
    expect(c.profile).toBe('balanced')
    for (const p of PASS_NAMES) {
      expect(c.passes[p].promptTemplate).toMatchObject({ name: p, layer: 'builtin' })
      expect(c.passes[p].promptTemplate.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('--profile wins over overrides.profile', () => {
    expect(resolveBuiltinConfig({ profile: 'fast', overrides: { profile: 'thorough' } }).profile).toBe('fast')
    expect(resolveBuiltinConfig({ overrides: { profile: 'thorough' } }).profile).toBe('thorough')
  })

  it('applies run overrides: objects merge, arrays replace', () => {
    const c = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: {
        gates: { beforeFix: true },
        verify: { runAfter: ['fix'] },
        passes: { review: { model: 'opus' }, plan: { enabled: false } },
      },
    })
    expect(c.gates).toEqual({ afterPlan: true, beforeFix: true })
    expect(c.verify.runAfter).toEqual(['fix'])
    expect(c.passes.review.model).toBe('opus')
    expect(c.passes.plan.enabled).toBe(false)
    expect(c.passes.plan.vendor).toBe('claude')
  })

  it('fix.inherit copies vendor/model/mode from Implement unless Fix sets them', () => {
    const inherited = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { implement: { model: 'sonnet' } } },
    })
    expect(inherited.passes.fix).toMatchObject({ vendor: 'claude', model: 'sonnet', mode: 'autoedit' })
    const explicit = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { implement: { model: 'sonnet' }, fix: { model: 'opus' } } },
    })
    expect(explicit.passes.fix).toMatchObject({ vendor: 'claude', model: 'opus' })
    const noInherit = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { implement: { model: 'sonnet' }, fix: { inherit: null, vendor: 'claude' } } },
    })
    expect(noInherit.passes.fix).toMatchObject({ vendor: 'claude', model: null, inherit: null })
    const e = errorOf(() =>
      resolveBuiltinConfig({ profile: 'claude-only', overrides: { passes: { fix: { inherit: null } } } }),
    )
    expect(e.issues).toEqual([expect.objectContaining({ pointer: '/passes/fix/vendor' })])
  })

  it('auto sets Implement and Fix to full and turns the gates off', () => {
    const c = resolveBuiltinConfig({ profile: 'claude-only', overrides: { auto: true } })
    expect(c.auto).toBe(true)
    expect(c.passes.implement.mode).toBe('full')
    expect(c.passes.fix.mode).toBe('full')
    expect(c.gates).toEqual({ afterPlan: false, beforeFix: false })
  })

  it('rejects full without auto, and a writable read-only pass', () => {
    expect(
      errorOf(() => resolveBuiltinConfig({ overrides: { passes: { implement: { mode: 'full' } } } })).code,
    ).toBe('invalid')
    const e = errorOf(() => resolveBuiltinConfig({ overrides: { passes: { review: { mode: 'autoedit' } } } }))
    expect(e.code).toBe('invalid')
    expect(e.issues[0]?.pointer).toBe('/passes/review/mode')
    expect(e.category).toBe('config_invalid')
  })

  it('rejects unknown and user-only keys in run overrides', () => {
    const e = errorOf(() => resolveBuiltinConfig({ overrides: { passes: { plan: { promptTemplte: 'x' } } } }))
    expect(e.code).toBe('invalid-overrides')
    expect(errorOf(() => resolveBuiltinConfig({ overrides: { vendors: {} } })).code).toBe('invalid-overrides')
    expect(errorOf(() => resolveBuiltinConfig({ overrides: 'nope' })).code).toBe('invalid-overrides')
  })

  it('unknown profiles get a suggestion', () => {
    const e = errorOf(() => resolveBuiltinConfig({ profile: 'balanced2' }))
    expect(e.code).toBe('unknown-profile')
    expect(e.message).toContain('did you mean "balanced"?')
  })

  it('a missing custom template is an error', () => {
    const e = errorOf(() =>
      resolveBuiltinConfig({ overrides: { passes: { plan: { promptTemplate: 'nope' } } } }),
    )
    expect(e.code).toBe('template')
    expect(e.issues[0]?.pointer).toBe('/passes/plan/promptTemplate')
  })

  it('never mutates the builtin layer', () => {
    const before = JSON.stringify(BUILTIN_DEFAULTS)
    resolveBuiltinConfig({ overrides: { auto: true, gates: { afterPlan: false }, verify: { runAfter: [] } } })
    expect(JSON.stringify(BUILTIN_DEFAULTS)).toBe(before)
  })
})

describe('Plan → Implement overrides', () => {
  it('planImplementOverrides disables Review, Critic and Fix (Plan → gate → Implement)', () => {
    const c = resolveBuiltinConfig({ profile: 'claude-only', overrides: planImplementOverrides() })
    expect(enabledPasses(c)).toEqual(['plan', 'implement'])
    expect(c.passes.review.vendor).toBe('claude')
  })

  it('mergeOverrides layers --set values under the Plan → Implement override', () => {
    const cli: RunOverrides = { auto: true, passes: { review: { enabled: true, model: 'opus' } } }
    const merged = mergeOverrides(cli, planImplementOverrides())
    expect(merged).toEqual({
      auto: true,
      passes: {
        review: { enabled: false, model: 'opus' },
        critic: { enabled: false },
        fix: { enabled: false },
      },
    })
    expect(cli.passes?.review?.enabled).toBe(true)
  })
})

describe('deepMerge', () => {
  it('objects merge, arrays replace, null is a value, undefined is skipped', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 'x', e: { f: 1 } }
    const out = deepMerge(base, { a: { c: [3] }, d: null, e: undefined }, { a: { g: true } })
    expect(out).toEqual({ a: { b: 1, c: [3], g: true }, d: null, e: { f: 1 } })
    expect(base).toEqual({ a: { b: 1, c: [1, 2] }, d: 'x', e: { f: 1 } })
  })
})
