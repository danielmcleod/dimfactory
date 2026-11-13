// Per-pass Extensions: the schema (`passes.<p>.extensions`, `extensions.allowed.<vendor>`), the file rule that keeps a
// read-only pass's Pass through out of project files, the resolver (defaults, layers, provenance, Fix inheriting
// Implement's level, Auto never widening), resolved.json written before Extensions existed, the config_patch allowlist
// (a recovery narrows, never widens) and the shared helpers.
import { describe, expect, it } from 'vitest'
import {
  DimFactoryConfigZ,
  ExtensionLevelZ,
  PassConfigZ,
  ResolvedConfigZ,
  RunOverridesZ,
  validateSemantics,
} from '@shared/config-schema.ts'
import type { DimFactoryConfig } from '@shared/config-schema.ts'
import {
  EXTENSION_LEVEL_LABEL,
  EXTENSIONS_SUPPORT,
  PASSTHROUGH_READONLY_WARNING,
  allowedFor,
  defaultExtensionLevel,
  extensionsCopy,
  extensionsSupport,
  extensionsVendor,
  isAllowableMcpName,
  isAllowableSkillName,
} from '@shared/extensions.ts'
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

const PASSES = ['plan', 'implement', 'review', 'critic', 'fix'] as const

describe('schema', () => {
  it('a level is none, allowed or passthrough', () => {
    for (const ok of ['none', 'allowed', 'passthrough'])
      expect(ExtensionLevelZ.safeParse(ok).success).toBe(true)
    for (const bad of ['', 'all', 'None', null, 1]) expect(ExtensionLevelZ.safeParse(bad).success).toBe(false)
  })

  it('a pass sets its level in a profile, in passes and in the run layer', () => {
    expect(PassConfigZ.safeParse({ extensions: 'allowed' }).success).toBe(true)
    expect(PassConfigZ.safeParse({ extensions: 'everything' }).success).toBe(false)
    expect(
      DimFactoryConfigZ.safeParse({
        profiles: { mine: { plan: { extensions: 'allowed' }, fix: { extensions: 'none' } } },
        passes: { review: { extensions: 'allowed' } },
      }).success,
    ).toBe(true)
    expect(RunOverridesZ.safeParse({ passes: { review: { extensions: 'passthrough' } } }).success).toBe(true)
  })

  it('the allow lists hold MCP server names and skill names per vendor, in a user or a project file', () => {
    const cfg = {
      extensions: { allowed: { claude: { mcp: ['github', 'my_db-2'], skills: ['pdf', 'tools:lint'] } } },
    }
    expect(DimFactoryConfigZ.safeParse(cfg).success).toBe(true)
    // Not user-only: a project file may tick its own servers.
    expect(validateSemantics(cfg, { scope: 'project' })).toEqual([])
    for (const bad of ['has space', 'a.b', 'x;rm', '', 'a'.repeat(129), '--mcp-config']) {
      expect(
        DimFactoryConfigZ.safeParse({ extensions: { allowed: { claude: { mcp: [bad] } } } }).success,
      ).toBe(false)
    }
    expect(
      DimFactoryConfigZ.safeParse({ extensions: { allowed: { claude: { skills: ['a:b:c'] } } } }).success,
    ).toBe(false)
    expect(DimFactoryConfigZ.safeParse({ extensions: { allowed: { claude: { tools: [] } } } }).success).toBe(
      false,
    )
    // The run layer cannot carry allow lists (only the files do).
    expect(RunOverridesZ.safeParse({ extensions: { allowed: {} } }).success).toBe(false)
  })

  it('a project file may not let a read-only pass pass through; the user file and the run layer may', () => {
    for (const pass of ['plan', 'review', 'critic'] as const) {
      const cfg: DimFactoryConfig = { passes: { [pass]: { extensions: 'passthrough' } } }
      const issues = validateSemantics(cfg, { scope: 'project' })
      expect(issues).toMatchObject([
        { pointer: `/passes/${pass}/extensions`, code: 'readonly-passthrough', severity: 'error' },
      ])
      expect(issues[0]?.message).not.toMatch(/—/)
      expect(validateSemantics(cfg, { scope: 'user' })).toEqual([])
      const inProfile = validateSemantics(
        { profiles: { team: { [pass]: { extensions: 'passthrough' } } } },
        { scope: 'project' },
      )
      expect(inProfile.map((i) => i.pointer)).toEqual([`/profiles/team/${pass}/extensions`])
    }
    // Implement and Fix pass through by default: a project may say so.
    expect(
      validateSemantics({ passes: { implement: { extensions: 'passthrough' } } }, { scope: 'project' }),
    ).toEqual([])
    expect(
      validateSemantics({ passes: { review: { extensions: 'allowed' } } }, { scope: 'project' }),
    ).toEqual([])
  })

  it('a resolved.json written before Extensions existed loads with the levels the passes had then', () => {
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const old = structuredClone(cfg) as unknown as Record<string, unknown> & {
      passes: Record<string, Record<string, unknown>>
    }
    for (const p of Object.values(old.passes)) delete p['extensions']
    delete old['extensions']
    const parsed = ResolvedConfigZ.parse(old)
    expect(parsed.passes.plan.extensions).toBe('none')
    expect(parsed.passes.review.extensions).toBe('none')
    expect(parsed.passes.critic.extensions).toBe('none')
    expect(parsed.passes.implement.extensions).toBe('passthrough')
    expect(parsed.passes.fix.extensions).toBe('passthrough')
    expect(parsed.extensions).toEqual({ allowed: {} })
    expect(resolvedFromFile({ config: old }).config.passes.implement.extensions).toBe('passthrough')
  })
})

describe('resolve', () => {
  it("every pass resolves a level: today's behaviour by default (read-only none, Implement and Fix passthrough)", () => {
    const r = resolve({ home: home() })
    for (const p of PASSES) expect(r.config.passes[p].extensions).toBe(defaultExtensionLevel(p))
    expect(r.config.passes.review.extensions).toBe('none')
    expect(r.config.passes.implement.extensions).toBe('passthrough')
    expect(r.provenance['/passes/review/extensions']).toMatchObject({ source: 'default' })
    expect(r.config.extensions).toEqual({ allowed: {} })
  })

  it('profile, passes and run layers set it, each with its provenance', () => {
    const r = resolve({
      home: home(),
      user: layer('user', {
        profiles: { balanced: { plan: { extensions: 'allowed' } } },
        passes: { review: { extensions: 'passthrough' } },
      }),
      project: layer('project', { passes: { critic: { extensions: 'allowed' } } }),
      run: { passes: { implement: { extensions: 'none' } } },
    })
    expect(r.config.passes.plan.extensions).toBe('allowed')
    expect(r.provenance['/passes/plan/extensions']).toMatchObject({ source: 'user', via: 'profile:balanced' })
    expect(r.config.passes.review.extensions).toBe('passthrough')
    expect(r.provenance['/passes/review/extensions']).toMatchObject({ source: 'user', via: 'passes' })
    expect(r.config.passes.critic.extensions).toBe('allowed')
    expect(r.provenance['/passes/critic/extensions']).toMatchObject({ source: 'project' })
    expect(r.config.passes.implement.extensions).toBe('none')
    expect(r.provenance['/passes/implement/extensions']).toMatchObject({ source: 'run' })
  })

  it("Fix inherits Implement's level unless it sets its own", () => {
    const r = resolve({
      home: home(),
      user: layer('user', { passes: { implement: { extensions: 'allowed' } } }),
    })
    expect(r.config.passes.fix.extensions).toBe('allowed')
    expect(r.provenance['/passes/fix/extensions']).toMatchObject({
      source: 'inherit',
      via: 'inherit:implement',
    })
    const own = resolve({
      home: home(),
      user: layer('user', { passes: { implement: { extensions: 'allowed' }, fix: { extensions: 'none' } } }),
    })
    expect(own.config.passes.fix.extensions).toBe('none')
    const off = resolve({
      home: home(),
      user: layer('user', {
        passes: { implement: { extensions: 'none' }, fix: { inherit: null, vendor: 'codex' } },
      }),
    })
    expect(off.config.passes.fix.extensions).toBe('passthrough')
  })

  it('Auto never widens a level', () => {
    const r = resolve({
      home: home(),
      user: layer('user', {
        auto: true,
        passes: { implement: { extensions: 'none' }, review: { extensions: 'allowed' } },
      }),
    })
    expect(r.config.passes.implement.mode).toBe('full')
    expect(r.config.passes.implement.extensions).toBe('none')
    expect(r.config.passes.fix.extensions).toBe('none')
    expect(r.config.passes.review.extensions).toBe('allowed')
    expect(r.config.passes.plan.extensions).toBe('none')
  })

  it('allow lists merge per vendor (a list replaces the one below it) and get their full shape', () => {
    const r = resolve({
      home: home(),
      user: layer('user', {
        extensions: { allowed: { claude: { mcp: ['a', 'b'], skills: ['pdf'] }, codex: { mcp: ['c'] } } },
      }),
      project: layer('project', { extensions: { allowed: { claude: { mcp: ['b'] } } } }),
    })
    expect(r.config.extensions.allowed).toEqual({
      claude: { mcp: ['b'], skills: ['pdf'], mcpWithoutAsking: [] },
      codex: { mcp: ['c'], skills: [], mcpWithoutAsking: [] },
    })
    expect(r.provenance['/extensions/allowed/claude/mcp']).toMatchObject({ source: 'project' })
    expect(r.provenance['/extensions/allowed/claude/skills']).toMatchObject({ source: 'user' })
    expect(r.provenance['/extensions/allowed/codex/skills']).toMatchObject({ source: 'default' })
    expect(r.provenance['/extensions/allowed/claude/mcpWithoutAsking']).toMatchObject({ source: 'default' })
  })

  it('Run without asking is per server, off by default, and its source is the layer that set it', () => {
    const r = resolve({
      home: home(),
      user: layer('user', {
        extensions: { allowed: { claude: { mcp: ['a', 'b'], mcpWithoutAsking: ['a'] } } },
      }),
    })
    expect(r.config.extensions.allowed['claude']).toEqual({
      mcp: ['a', 'b'],
      skills: [],
      mcpWithoutAsking: ['a'],
    })
    expect(r.provenance['/extensions/allowed/claude/mcpWithoutAsking']).toMatchObject({ source: 'user' })
    const none = resolve({
      home: home(),
      user: layer('user', { extensions: { allowed: { claude: { mcp: ['a'] } } } }),
    })
    expect(none.config.extensions.allowed['claude']?.mcpWithoutAsking).toEqual([])
  })

  it('a project file with a read-only Pass through is refused at load (the user is told where)', () => {
    const r = parseConfigText(JSON.stringify({ passes: { review: { extensions: 'passthrough' } } }), {
      file: 'project.json',
      scope: 'project',
    })
    expect(r.issues.some((i) => i.code === 'readonly-passthrough' && i.severity === 'error')).toBe(true)
  })
})

describe('config_patch allowlist: a recovery narrows a pass, never widens it', () => {
  it('only "none" may be written to a pass level, and never removed', () => {
    expect(checkAllowlisted(['passes', 'review', 'extensions'])).toEqual({ ok: true })
    const ok = validatePatchOps([{ op: 'add', path: '/passes/review/extensions', value: 'none' }], {
      scope: 'user',
      allowlist: true,
    })
    expect(ok.ok).toBe(true)
    for (const value of ['allowed', 'passthrough']) {
      const v = validatePatchOps([{ op: 'replace', path: '/passes/implement/extensions', value }], {
        scope: 'user',
        allowlist: true,
      })
      expect(v.ok).toBe(false)
      expect(v.rejected[0]).toMatchObject({ kind: 'forbidden' })
    }
    const removed = validatePatchOps([{ op: 'remove', path: '/passes/review/extensions' }], {
      scope: 'user',
      allowlist: true,
    })
    expect(removed.ok).toBe(false)
    expect(checkAllowlisted(['profiles', 'mine', 'review', 'extensions']).ok).toBe(false)
  })

  it('a recovery never edits an allow list; Settings (no allowlist) may', () => {
    expect(checkAllowlisted(['extensions', 'allowed', 'claude', 'mcp']).ok).toBe(false)
    const settings = validatePatchOps([{ op: 'add', path: '/extensions/allowed/claude/mcp', value: ['a'] }], {
      scope: 'project',
      allowlist: false,
    })
    expect(settings.ok).toBe(true)
    expect(settings.routed.project).toHaveLength(1)
  })
})

describe('shared helpers', () => {
  it('names a level as the UI shows it', () => {
    expect(EXTENSION_LEVEL_LABEL).toEqual({
      none: 'None',
      allowed: 'Allowed list',
      passthrough: 'Pass through',
    })
  })

  it('MCP and skill names Dim Factory can allow', () => {
    expect(isAllowableMcpName('github-2_x')).toBe(true)
    for (const bad of ['a b', 'a.b', 'a,b', '', '--x', '-y']) expect(isAllowableMcpName(bad)).toBe(false)
    expect(isAllowableSkillName('pdf')).toBe(true)
    expect(isAllowableSkillName('plugin:skill.v2')).toBe(true)
    expect(isAllowableSkillName('a b')).toBe(false)
  })

  it('a local preset uses Codex extensions; Grok and Muse cannot be limited', () => {
    expect(extensionsVendor('local-ollama')).toBe('codex')
    expect(extensionsSupport('claude')).toEqual({ mcp: true, skills: true })
    expect(extensionsSupport('codex')).toEqual({ mcp: true, skills: false })
    expect(extensionsSupport('gemini')).toEqual({ mcp: true, skills: false })
    expect(extensionsSupport('grok')).toEqual({ mcp: false, skills: false })
    expect(extensionsSupport('muse')).toEqual({ mcp: false, skills: false })
    expect(extensionsSupport('someone-else')).toEqual({ mcp: false, skills: false })
    expect(Object.keys(EXTENSIONS_SUPPORT)).toEqual(['claude', 'codex', 'gemini', 'grok', 'muse'])
  })

  it('the copy is honest per vendor and level, and has no em dash', () => {
    const vendors = ['claude', 'codex', 'gemini', 'grok', 'muse', 'local-x', 'other']
    for (const v of vendors)
      for (const l of ['none', 'allowed', 'passthrough'] as const) {
        const copy = extensionsCopy(v, l)
        expect(copy.length).toBeGreaterThan(20)
        expect(copy).not.toMatch(/—/)
      }
    expect(PASSTHROUGH_READONLY_WARNING).not.toMatch(/—/)
    // Codex and Gemini say Allowed list covers MCP servers only; Claude limits skills too.
    expect(extensionsCopy('codex', 'allowed')).toMatch(/cannot limit skills/)
    expect(extensionsCopy('gemini', 'allowed')).toMatch(/cannot limit skills/)
    expect(extensionsCopy('claude', 'allowed')).toMatch(/MCP servers and skills you allowed/)
    // Grok and Muse: the same words at every level (Dim Factory cannot limit them).
    expect(
      new Set((['none', 'allowed', 'passthrough'] as const).map((l) => extensionsCopy('grok', l))).size,
    ).toBe(1)
    expect(extensionsCopy('muse', 'none')).toMatch(/cannot limit/)
  })

  it("allowedFor reads one vendor list (a local preset reads Codex's), empty when none is set", () => {
    const ext = { allowed: { codex: { mcp: ['a'], skills: [] }, claude: { mcp: ['b'] } } }
    const empty = { mcpWithoutAsking: [] }
    expect(allowedFor(ext, 'local-ollama')).toEqual({ mcp: ['a'], skills: [], ...empty })
    expect(allowedFor(ext, 'claude')).toEqual({ mcp: ['b'], skills: [], ...empty })
    expect(allowedFor(ext, 'gemini')).toEqual({ mcp: [], skills: [], ...empty })
    expect(allowedFor(undefined, 'claude')).toEqual({ mcp: [], skills: [], ...empty })
  })
})
