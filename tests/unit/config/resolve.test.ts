import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResolvedConfigZ } from '@shared/config-schema.ts'
import type { DimFactoryConfig, Provenance, ResolvedConfig } from '@shared/config-schema.ts'
import { PASS_NAMES } from '@shared/run.ts'
import {
  BUILTIN_PROFILE_NAMES,
  BuiltinConfigError,
  planImplementOverrides,
  resolveBuiltinConfig,
} from '@core/config/builtins.ts'
import { parseConfigText, toConfigLayer } from '@core/config/load.ts'
import type { ConfigLayer } from '@core/config/load.ts'
import {
  ConfigResolveError,
  knownProfiles,
  loadAndResolve,
  resolve,
  resolvedFromFile,
} from '@core/config/resolve.ts'
import type { ResolveInput } from '@core/config/resolve.ts'
import { sha256Text } from '@core/prompts/resolve.ts'
import { homePaths } from '@core/home.ts'

const home = (): string => {
  const h = process.env['DIM_FACTORY_HOME']
  if (h === undefined) throw new Error('DIM_FACTORY_HOME is not set (tests/setup/home.ts)')
  return h
}
const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'cfg-resolve-'))

/** A validated file layer from JSONC lines (line numbers in tests are 1-based indexes into `lines`). */
function fileLayer(
  scope: 'user' | 'project',
  lines: string[] | DimFactoryConfig,
  file = `${scope}.json`,
): ConfigLayer {
  const text = Array.isArray(lines) ? lines.join('\n') : JSON.stringify(lines, null, 2)
  const r = parseConfigText(text, { file, scope })
  const layer = toConfigLayer(r)
  if (layer === undefined) throw new Error(`invalid ${scope} layer: ${JSON.stringify(r.issues)}`)
  return layer
}
const user = (l: string[] | DimFactoryConfig): ConfigLayer => fileLayer('user', l)
const project = (l: string[] | DimFactoryConfig): ConfigLayer => fileLayer('project', l)

const errorOf = (fn: () => unknown): ConfigResolveError => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigResolveError)
    return err as ConfigResolveError
  }
  throw new Error('expected a ConfigResolveError')
}

// ---- builtin compatibility -----------------------------------------------------------------------------------------

describe('no files: reproduces resolveBuiltinConfig exactly (builtin compatibility)', () => {
  const cases: [string, { profile?: string; overrides?: unknown }][] = [
    ...BUILTIN_PROFILE_NAMES.map((p): [string, { profile: string }] => [`profile ${p}`, { profile: p }]),
    ['no options', {}],
    [
      'objects merge, arrays replace',
      {
        profile: 'claude-only',
        overrides: {
          gates: { beforeFix: true },
          verify: { runAfter: ['fix'] },
          passes: { review: { model: 'opus' }, plan: { enabled: false } },
        },
      },
    ],
    ['fix inherits', { profile: 'claude-only', overrides: { passes: { implement: { model: 'sonnet' } } } }],
    [
      'fix explicit model',
      {
        profile: 'claude-only',
        overrides: { passes: { implement: { model: 'sonnet' }, fix: { model: 'opus' } } },
      },
    ],
    [
      'fix inherit null',
      {
        profile: 'claude-only',
        overrides: { passes: { implement: { model: 'sonnet' }, fix: { inherit: null, vendor: 'claude' } } },
      },
    ],
    ['auto', { profile: 'claude-only', overrides: { auto: true } }],
    ['planImplementOverrides', { profile: 'claude-only', overrides: planImplementOverrides() }],
    ['overrides.profile', { overrides: { profile: 'thorough' } }],
    ['--profile wins', { profile: 'fast', overrides: { profile: 'thorough' } }],
    [
      'isolation + timeouts',
      {
        overrides: {
          isolation: { mode: 'worktree', worktree: { copy: ['.env'], install: 'never' } },
          planning: { native: 'off' },
          verify: { enabled: true, commands: [{ name: 'test', run: ['pnpm', 'test'] }] },
        },
      },
    ],
  ]

  it.each(cases)('%s', (_name, o) => {
    const expected = resolveBuiltinConfig(o)
    const got = resolve({
      ...(o.profile !== undefined ? { profile: o.profile } : {}),
      ...(o.overrides !== undefined ? { run: o.overrides } : {}),
    })
    expect(got.config).toEqual(expected)
    expect(JSON.stringify(got.config)).toBe(JSON.stringify(expected))
  })

  const failures: [string, { profile?: string; overrides?: unknown }][] = [
    ['full without auto', { overrides: { passes: { implement: { mode: 'full' } } } }],
    ['writable read-only pass', { overrides: { passes: { review: { mode: 'autoedit' } } } }],
    ['unknown run key', { overrides: { passes: { plan: { promptTemplte: 'x' } } } }],
    ['user-only run key', { overrides: { vendors: {} } }],
    ['not an object', { overrides: 'nope' }],
    ['unknown profile', { profile: 'balanced2' }],
    ['missing template', { overrides: { passes: { plan: { promptTemplate: 'nope' } } } }],
    ['fix without a vendor', { profile: 'claude-only', overrides: { passes: { fix: { inherit: null } } } }],
  ]

  it.each(failures)('fails the same way: %s', (_name, o) => {
    let expected: BuiltinConfigError | undefined
    try {
      resolveBuiltinConfig(o)
    } catch (err) {
      expected = err as BuiltinConfigError
    }
    expect(expected).toBeInstanceOf(BuiltinConfigError)
    const e = errorOf(() =>
      resolve({
        ...(o.profile !== undefined ? { profile: o.profile } : {}),
        ...(o.overrides !== undefined ? { run: o.overrides } : {}),
      }),
    )
    expect(e).toBeInstanceOf(BuiltinConfigError)
    expect(e.code).toBe(expected?.code)
    expect(e.category).toBe('config_invalid')
    expect(e.issues.map((i) => i.pointer)).toEqual(expected?.issues.map((i) => i.pointer))
  })
})

// ---- layer precedence ---------------------------------------------------------------------------------------------

interface PrecedenceRow {
  name: string
  user?: { profiles?: string; passes?: string }
  project?: { profiles?: string; passes?: string }
  run?: string
  /** [value, source, via] for /passes/review/model (balanced: builtin review model is "sonnet"). */
  expect: [string, Provenance['source'], string]
}

const ROWS: PrecedenceRow[] = [
  { name: 'builtin only', expect: ['sonnet', 'default', 'profile:balanced'] },
  { name: 'user profile', user: { profiles: 'u-prof' }, expect: ['u-prof', 'user', 'profile:balanced'] },
  { name: 'user passes', user: { passes: 'u-pass' }, expect: ['u-pass', 'user', 'passes'] },
  {
    name: 'within a layer, passes beat the profile',
    user: { profiles: 'u-prof', passes: 'u-pass' },
    expect: ['u-pass', 'user', 'passes'],
  },
  {
    name: "a project profile beats the user's passes (per-layer order)",
    user: { passes: 'u-pass' },
    project: { profiles: 'p-prof' },
    expect: ['p-prof', 'project', 'profile:balanced'],
  },
  {
    name: 'project passes beat user profiles',
    user: { profiles: 'u-prof' },
    project: { passes: 'p-pass' },
    expect: ['p-pass', 'project', 'passes'],
  },
  {
    name: 'project profile + passes',
    project: { profiles: 'p-prof', passes: 'p-pass' },
    expect: ['p-pass', 'project', 'passes'],
  },
  {
    name: 'run beats project',
    project: { passes: 'p-pass' },
    run: 'r-pass',
    expect: ['r-pass', 'run', 'passes'],
  },
  {
    name: 'run beats everything',
    user: { profiles: 'u-prof', passes: 'u-pass' },
    project: { profiles: 'p-prof', passes: 'p-pass' },
    run: 'r-pass',
    expect: ['r-pass', 'run', 'passes'],
  },
]

/** `{ "profiles": { "balanced": { "review": { "model": X } } }, "passes": { "review": { "model": Y } } }` */
function reviewLayer(set: { profiles?: string; passes?: string }): DimFactoryConfig {
  return {
    ...(set.profiles !== undefined ? { profiles: { balanced: { review: { model: set.profiles } } } } : {}),
    ...(set.passes !== undefined ? { passes: { review: { model: set.passes } } } : {}),
  }
}

describe('layer precedence (builtin/user/project/run × profiles/passes)', () => {
  it.each(ROWS)('$name', (row) => {
    const input: ResolveInput = {
      ...(row.user !== undefined ? { user: user(reviewLayer(row.user)) } : {}),
      ...(row.project !== undefined ? { project: project(reviewLayer(row.project)) } : {}),
      ...(row.run !== undefined ? { run: { passes: { review: { model: row.run } } } } : {}),
    }
    const { config, provenance } = resolve(input)
    const [value, source, via] = row.expect
    expect(config.passes.review.model).toBe(value)
    expect(provenance['/passes/review/model']).toMatchObject({ source, via })
    if (source === 'user' || source === 'project') {
      expect(provenance['/passes/review/model']).toMatchObject({ file: `${source}.json` })
      expect(provenance['/passes/review/model']?.line).toBeGreaterThan(1)
    }
    // Other keys of the pass are untouched by the review model rows.
    expect(config.passes.review).toMatchObject({ vendor: 'claude', mode: 'readonly', enabled: true })
  })

  it.each([
    ['builtin', {}, false, 'default'],
    ['user', { user: user({ gates: { beforeFix: true } }) }, true, 'user'],
    [
      'project over user',
      { user: user({ gates: { beforeFix: true } }), project: project({ gates: { beforeFix: false } }) },
      false,
      'project',
    ],
    [
      'run over project',
      { project: project({ gates: { beforeFix: false } }), run: { gates: { beforeFix: true } } },
      true,
      'run',
    ],
  ] as [string, ResolveInput, boolean, string][])('sections: %s', (_n, input, value, source) => {
    const { config, provenance } = resolve(input)
    expect(config.gates.beforeFix).toBe(value)
    expect(config.gates.afterPlan).toBe(true)
    expect(provenance['/gates/beforeFix']?.source).toBe(source)
    expect(provenance['/gates/afterPlan']?.source).toBe('default')
  })

  it('profile selection: run > project > user > builtin, and --profile beats all', () => {
    expect(resolve({ user: user({ profile: 'fast' }) }).config.profile).toBe('fast')
    const both = resolve({ user: user({ profile: 'fast' }), project: project({ profile: 'thorough' }) })
    expect(both.config.profile).toBe('thorough')
    expect(both.provenance['/profile']).toMatchObject({ source: 'project', line: 2 })
    expect(
      resolve({ project: project({ profile: 'thorough' }), run: { profile: 'codex-only' } }).config.profile,
    ).toBe('codex-only')
    const cli = resolve({ run: { profile: 'codex-only' }, profile: 'claude-only' })
    expect(cli.config.profile).toBe('claude-only')
    expect(cli.provenance['/profile']).toEqual({ source: 'run', via: '--profile' })
  })

  it('a user profile with a builtin name merges over the builtin; a new profile is selectable', () => {
    const merged = resolve({
      user: user({ profiles: { fast: { critic: { enabled: true } } }, profile: 'fast' }),
    })
    expect(merged.config.passes.critic).toMatchObject({ vendor: 'claude', enabled: true })
    expect(merged.config.passes.plan).toMatchObject({ model: 'sonnet', enabled: false })

    const mine = resolve({
      project: project({
        profile: 'mine',
        profiles: {
          mine: {
            plan: { vendor: 'claude', mode: 'readonly' },
            implement: { vendor: 'claude', mode: 'autoedit' },
            review: { vendor: 'claude', mode: 'readonly' },
            critic: { vendor: 'codex', mode: 'readonly', model: 'gpt-5' },
          },
        },
      }),
    })
    expect(mine.config.profile).toBe('mine')
    expect(mine.config.passes.critic).toMatchObject({ vendor: 'codex', model: 'gpt-5' })
    expect(mine.config.passes.fix).toMatchObject({
      vendor: 'claude',
      inherit: 'implement',
      reuseSession: true,
    })
    expect(mine.profiles).toEqual([...BUILTIN_PROFILE_NAMES, 'mine'])
  })

  it('an unknown profile names the file and line that selected it, with a suggestion', () => {
    const e = errorOf(() => resolve({ user: user(['{', '  "auto": false,', '  "profile": "thorogh"', '}']) }))
    expect(e.code).toBe('unknown-profile')
    expect(e.message).toContain('did you mean "thorough"?')
    expect(e.issues).toEqual([
      {
        pointer: '/profile',
        message: 'Unknown profile "thorogh"',
        source: 'user',
        file: 'user.json',
        line: 3,
      },
    ])
  })

  it('a profile that leaves a pass without a vendor is an error at that pass', () => {
    const e = errorOf(() =>
      resolve({ user: user({ profile: 'half', profiles: { half: { implement: { vendor: 'claude' } } } }) }),
    )
    expect(e.code).toBe('invalid')
    expect(e.issues.map((i) => i.pointer)).toEqual([
      '/passes/plan/vendor',
      '/passes/review/vendor',
      '/passes/critic/vendor',
    ])
    expect(e.issues[0]).toMatchObject({ source: 'user', file: 'user.json' })
  })

  it('user-only keys in a project layer never take effect', () => {
    const layer: ConfigLayer = {
      value: { vendors: { claude: { path: 'C:\\evil.exe' } }, ui: { theme: 'dark' }, auto: false },
    }
    const { config } = resolve({ project: layer })
    expect(config.vendors).toEqual({})
    expect(config.ui.theme).toBe('system')
  })

  it('an invalid layer value is rejected with its file', () => {
    const e = errorOf(() =>
      resolve({ user: { value: { auto: 'yes' } as unknown as DimFactoryConfig, file: 'u' } }),
    )
    expect(e.code).toBe('invalid')
    expect(e.issues[0]).toMatchObject({ pointer: '/auto', source: 'user', file: 'u' })
  })
})

// ---- merge rules through resolve -----------------------------------------------------------------------------------

describe('resolve rules', () => {
  it('arrays replace across layers', () => {
    const { config, provenance } = resolve({
      user: user({
        verify: { runAfter: ['implement'] },
        isolation: { worktree: { copy: ['.env', '.npmrc'] } },
      }),
      project: project({ isolation: { worktree: { copy: ['.env.local'] } } }),
    })
    expect(config.verify.runAfter).toEqual(['implement'])
    expect(config.isolation.worktree.copy).toEqual(['.env.local'])
    expect(config.isolation.worktree.install).toBe('ask')
    expect(provenance['/isolation/worktree/copy']?.source).toBe('project')
    expect(provenance['/verify/runAfter']?.source).toBe('user')
  })

  it('a null model is kept (null is a value; provenance cli, still pointing at the line)', () => {
    const lines = ['{', '  "passes": {', '    "review": { "model": null }', '  }', '}']
    const { config, provenance } = resolve({ user: user(lines), run: { passes: { plan: { model: null } } } })
    expect(config.passes.review.model).toBeNull()
    expect(provenance['/passes/review/model']).toEqual({
      source: 'cli',
      file: 'user.json',
      line: 3,
      via: 'passes',
    })
    expect(config.passes.plan.model).toBeNull()
    expect(provenance['/passes/plan/model']).toEqual({ source: 'cli', via: 'passes' })
    expect(resolve().provenance['/passes/implement/model']).toEqual({
      source: 'cli',
      via: 'profile:balanced',
    })
  })

  it('fix.inherit copies vendor/model/mode from Implement', () => {
    const { config, provenance } = resolve({
      user: user({ passes: { implement: { vendor: 'claude', model: 'opus' } } }),
    })
    expect(config.passes.fix).toMatchObject({
      vendor: 'claude',
      model: 'opus',
      mode: 'autoedit',
      inherit: 'implement',
    })
    for (const k of ['vendor', 'model', 'mode']) {
      expect(provenance[`/passes/fix/${k}`]).toEqual({ source: 'inherit', via: 'inherit:implement' })
    }
  })

  it('fix.inherit with an explicit vendor: the vendor wins, mode still inherits, a foreign model does not', () => {
    const { config, provenance } = resolve({
      user: user({ passes: { implement: { vendor: 'claude', model: 'opus' } } }),
      project: project({ passes: { fix: { vendor: 'codex' } } }),
    })
    // "opus" is a Claude model: Fix on Codex keeps its own model (null → the Codex CLI default).
    expect(config.passes.fix).toMatchObject({ vendor: 'codex', model: null, mode: 'autoedit' })
    expect(provenance['/passes/fix/vendor']).toMatchObject({ source: 'project', via: 'passes' })
    expect(provenance['/passes/fix/model']?.source).toBe('cli')
    expect(provenance['/passes/fix/mode']).toEqual({ source: 'inherit', via: 'inherit:implement' })
  })

  it("fix.inherit with an explicit other vendor takes that vendor's defaultModel, never Implement's model", () => {
    const { config, provenance } = resolve({
      user: user({
        vendors: { claude: { defaultModel: 'sonnet' } },
        profile: 'claude-only',
        passes: { implement: { vendor: 'codex', model: 'gpt-5-codex' }, fix: { vendor: 'claude' } },
      }),
    })
    expect(config.passes.fix).toMatchObject({ vendor: 'claude', model: 'sonnet' })
    expect(provenance['/passes/fix/model']).toMatchObject({
      source: 'vendor',
      via: '/vendors/claude/defaultModel',
    })
    // An explicit vendor equal to Implement's still inherits the model.
    const same = resolve({
      user: user({ passes: { implement: { vendor: 'claude', model: 'opus' }, fix: { vendor: 'claude' } } }),
    })
    expect(same.config.passes.fix.model).toBe('opus')
    expect(same.provenance['/passes/fix/model']).toEqual({ source: 'inherit', via: 'inherit:implement' })
  })

  it('an explicit Fix key set in a lower layer stays explicit under a later inherit', () => {
    const { config } = resolve({
      user: user({ passes: { fix: { model: 'haiku' } } }),
      project: project({ passes: { fix: { inherit: 'implement' }, implement: { model: 'opus' } } }),
    })
    expect(config.passes.fix.model).toBe('haiku')
    expect(config.passes.fix.vendor).toBe('codex')
  })

  it('fix.inherit null: Fix keeps its own values', () => {
    const { config, provenance } = resolve({
      run: { passes: { implement: { model: 'opus' }, fix: { inherit: null, vendor: 'claude' } } },
    })
    expect(config.passes.fix).toMatchObject({
      vendor: 'claude',
      model: null,
      inherit: null,
      mode: 'autoedit',
    })
    expect(provenance['/passes/fix/mode']).toEqual({ source: 'default' })
  })

  it('a disabled pass needs no vendor: it resolves with a placeholder (Implement’s vendor)', () => {
    const solo = {
      profile: 'solo',
      profiles: {
        solo: {
          implement: { vendor: 'claude' },
          plan: { enabled: false },
          review: { enabled: false },
          critic: { enabled: false },
        },
      },
    }
    const { config, provenance } = resolve({ user: user(solo), home: home() })
    expect(config.passes.implement.vendor).toBe('claude')
    expect(config.passes.fix.vendor).toBe('claude')
    for (const p of ['plan', 'review', 'critic'] as const) {
      expect(config.passes[p]).toMatchObject({ vendor: 'claude', enabled: false })
      expect(provenance[`/passes/${p}/vendor`]).toEqual({ source: 'default', via: 'disabled' })
    }
    // An enabled pass without a vendor is still an error.
    const e = errorOf(() =>
      resolve({ user: user(solo), run: { passes: { review: { enabled: true } } }, home: home() }),
    )
    expect(e.code).toBe('invalid')
    expect(e.issues.map((i) => i.pointer)).toEqual(['/passes/review/vendor'])
  })

  it("a disabled pass's missing template is a warning (the builtin stands in), not a resolve failure", () => {
    const r = resolve({ user: user({ profile: 'fast', passes: { critic: { promptTemplate: 'gone' } } }) })
    expect(r.config.passes.critic.enabled).toBe(false)
    expect(r.config.passes.critic.promptTemplate).toMatchObject({ name: 'critic', layer: 'builtin' })
    expect(r.warnings).toEqual([
      expect.objectContaining({
        pointer: '/passes/critic/promptTemplate',
        source: 'user',
        file: 'user.json',
        message: expect.stringContaining('"gone" was not found') as string,
      }),
    ])
    // Enabled, the same template is an error.
    const e = errorOf(() =>
      resolve({
        user: user({ profile: 'fast', passes: { critic: { promptTemplate: 'gone', enabled: true } } }),
      }),
    )
    expect(e.code).toBe('template')
    expect(resolve().warnings).toEqual([])
  })

  it('auto forces Implement and Fix to full and turns both gates off (provenance auto)', () => {
    const lines = ['{', '  "gates": { "afterPlan": true, "beforeFix": true },', '  "auto": true', '}']
    const { config, provenance } = resolve({ project: project(lines), run: { gates: { afterPlan: true } } })
    expect(config.auto).toBe(true)
    expect(config.passes.implement.mode).toBe('full')
    expect(config.passes.fix.mode).toBe('full')
    expect(config.passes.plan.mode).toBe('readonly')
    expect(config.gates).toEqual({ afterPlan: false, beforeFix: false })
    const auto = { source: 'auto', file: 'project.json', line: 3 }
    for (const p of ['/passes/implement/mode', '/passes/fix/mode', '/gates/afterPlan', '/gates/beforeFix']) {
      expect(provenance[p]).toEqual(auto)
    }
    expect(provenance['/auto']).toEqual({ source: 'project', file: 'project.json', line: 3 })
    expect(ResolvedConfigZ.safeParse(config).success).toBe(true)
  })

  it('defaultModel fills a null model (provenance vendor) and never replaces a set one', () => {
    const lines = [
      '{',
      '  "vendors": {',
      '    "codex": { "defaultModel": "gpt-5-codex" },',
      '    "claude": { "defaultModel": "sonnet", "extraArgs": ["--verbose"] }',
      '  }',
      '}',
    ]
    const { config, provenance } = resolve({ user: user(lines) })
    expect(config.passes.implement.model).toBe('gpt-5-codex')
    expect(config.passes.fix.model).toBe('gpt-5-codex')
    expect(config.passes.plan.model).toBe('opus')
    const vendor = { source: 'vendor', file: 'user.json', line: 3, via: '/vendors/codex/defaultModel' }
    expect(provenance['/passes/implement/model']).toEqual(vendor)
    expect(provenance['/passes/fix/model']).toEqual(vendor)
    expect(provenance['/passes/plan/model']).toMatchObject({ source: 'default', via: 'profile:balanced' })
    // Vendors get the full resolved shape; unset fields are defaults.
    expect(config.vendors['claude']).toEqual({
      path: null,
      defaultModel: 'sonnet',
      defaultEffort: null,
      extraArgs: ['--verbose'],
      env: {},
      flagMap: {},
    })
    expect(provenance['/vendors/claude/extraArgs']).toMatchObject({ source: 'user', line: 4 })
    expect(provenance['/vendors/claude/path']).toEqual({ source: 'default' })
  })

  it('provenance pointers and lines across user, project and run', () => {
    const u = [
      '{', // 1
      '  // mine', // 2
      '  "profile": "claude-only",', // 3
      '  "profiles": {', // 4
      '    "claude-only": {', // 5
      '      "review": { "model": "opus" }', // 6
      '    }', // 7
      '  },', // 8
      '  "timeouts": { "stallMs": 600000 }', // 9
      '}', // 10
    ]
    const p = [
      '{', // 1
      '  "isolation": {', // 2
      '    "branch": "runBranch"', // 3
      '  },', // 4
      '  "passes": { "plan": { "enabled": false } }', // 5
      '}', // 6
    ]
    const { config, provenance } = resolve({
      user: user(u),
      project: project(p),
      run: { verify: { enabled: true } },
    })
    expect(config.passes.review.model).toBe('opus')
    expect(provenance['/profile']).toEqual({ source: 'user', file: 'user.json', line: 3 })
    expect(provenance['/passes/review/model']).toEqual({
      source: 'user',
      file: 'user.json',
      line: 6,
      via: 'profile:claude-only',
    })
    expect(provenance['/passes/review/vendor']).toEqual({ source: 'default', via: 'profile:claude-only' })
    expect(provenance['/timeouts/stallMs']).toEqual({ source: 'user', file: 'user.json', line: 9 })
    expect(provenance['/timeouts/hardKillMs']).toEqual({ source: 'default' })
    expect(provenance['/isolation/branch']).toEqual({ source: 'project', file: 'project.json', line: 3 })
    expect(provenance['/passes/plan/enabled']).toEqual({
      source: 'project',
      file: 'project.json',
      line: 5,
      via: 'passes',
    })
    expect(provenance['/verify/enabled']).toEqual({ source: 'run' })
    expect(provenance['/passes/plan/promptTemplate']).toEqual({ source: 'default' })
    // Every pass key has an entry; every pointer names a real location in the resolved config.
    for (const pass of PASS_NAMES) {
      for (const k of ['vendor', 'model', 'mode', 'enabled', 'promptTemplate']) {
        expect(provenance[`/passes/${pass}/${k}`]).toBeDefined()
      }
    }
    for (const ptr of Object.keys(provenance)) expect(valueAt(config, ptr)).not.toBeUndefined()
  })

  it('a cross-layer rule (timeout order) fails at the layer that set the value', () => {
    const e = errorOf(() =>
      resolve({
        user: user(['{', '  "timeouts": {', '    "stallMs": 1000000', '  }', '}']),
        // Valid on its own (defaults: stallMs 300000, toolStallMs 900000); not under the user's stallMs.
        project: project({ timeouts: { hardKillMs: 950000 } }),
      }),
    )
    expect(e.code).toBe('invalid')
    expect(e.issues).toHaveLength(1)
    expect(e.issues[0]).toMatchObject({
      pointer: '/timeouts/stallMs',
      source: 'user',
      file: 'user.json',
      line: 3,
    })
  })

  it('full without auto from a run layer is located at the run layer', () => {
    const e = errorOf(() => resolve({ run: { passes: { implement: { mode: 'full' } } } }))
    expect(e.issues).toEqual([
      {
        pointer: '/passes/implement/mode',
        message: 'mode "full" is only valid together with auto: true',
        source: 'run',
      },
      // Fix inherits Implement's mode, so it is invalid too, located as inherited.
      {
        pointer: '/passes/fix/mode',
        message: 'mode "full" is only valid together with auto: true',
        source: 'inherit',
      },
    ])
  })

  it('$schema and version stay in the file; the inputs are never mutated', () => {
    const u = user({ $schema: './schema/dimfactory.schema.json', version: 1, gates: { beforeFix: true } })
    const run = { passes: { review: { model: 'opus' } }, auto: true }
    const before = JSON.stringify([u, run])
    const { config, provenance } = resolve({ user: u, run })
    expect(config).not.toHaveProperty('$schema')
    expect(config).not.toHaveProperty('version')
    expect(provenance).not.toHaveProperty('/$schema')
    expect(JSON.stringify([u, run])).toBe(before)
  })

  it('knownProfiles lists builtin names first, then new names in layer order', () => {
    expect(knownProfiles({ profiles: { b: {} } }, undefined, { profiles: { a: {}, b: {} } })).toEqual([
      'b',
      'a',
    ])
  })
})

function valueAt(cfg: ResolvedConfig, pointer: string): unknown {
  let cur: unknown = cfg
  for (const seg of pointer.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return cur
}

// ---- templates ------------------------------------------------------------------------------------------------------

describe('template lookup order: project → user → builtin', () => {
  it('a named template', async () => {
    const folder = await tmp()
    const projectFile = join(folder, '.dimfactory', 'prompts', 'review-strict.md')
    const userFile = join(home(), 'prompts', 'review-strict.md')
    await mkdir(join(folder, '.dimfactory', 'prompts'), { recursive: true })
    await mkdir(join(home(), 'prompts'), { recursive: true })
    await writeFile(projectFile, 'project text {{diff}}\n')
    await writeFile(userFile, 'user text {{diff}}\n')
    const lines = ['{', '  "passes": { "review": { "promptTemplate": "review-strict" } }', '}']
    const input: ResolveInput = { user: user(lines), folder, home: home() }

    expect(resolve(input).config.passes.review.promptTemplate).toEqual({
      name: 'review-strict',
      path: projectFile,
      layer: 'project',
      sha256: sha256Text('project text {{diff}}\n'),
    })
    await rm(projectFile)
    expect(resolve(input).config.passes.review.promptTemplate).toMatchObject({
      path: userFile,
      layer: 'user',
    })
    await rm(userFile)
    const e = errorOf(() => resolve(input))
    expect(e.code).toBe('template')
    expect(e.issues[0]).toMatchObject({
      pointer: '/passes/review/promptTemplate',
      source: 'user',
      file: 'user.json',
      line: 2,
    })
  })

  it('the default name (null) is the pass name; a user override beats the builtin', async () => {
    const before = resolve({ home: home() }).config.passes.critic.promptTemplate
    expect(before).toMatchObject({ name: 'critic', layer: 'builtin' })
    await mkdir(join(home(), 'prompts'), { recursive: true })
    await writeFile(join(home(), 'prompts', 'critic.md'), 'my critic {{diff}}\n')
    expect(resolve({ home: home() }).config.passes.critic.promptTemplate).toMatchObject({
      name: 'critic',
      layer: 'user',
    })
    // No folder → no project layer at all.
    expect(resolve({ home: home() }).config.passes.plan.promptTemplate.layer).toBe('builtin')
  })
})

// ---- Re-run ------------------------------------------------------------------------------------------------------------

describe('resolvedFromFile (Re-run via ResolvedConfigZ)', () => {
  it('round-trips a resolved config and its provenance', () => {
    const r = resolve({ user: user({ vendors: { claude: { defaultModel: 'opus' } } }), run: { auto: true } })
    const doc: unknown = JSON.parse(
      JSON.stringify({ config: r.config, provenance: r.provenance, patches: [] }),
    )
    const again = resolvedFromFile(doc)
    expect(again.config).toEqual(r.config)
    expect(again.provenance).toEqual(r.provenance)
  })

  it('accepts mode "full" only together with auto: true; skips the file-only rules', () => {
    const base = resolveBuiltinConfig({ profile: 'claude-only', overrides: { auto: true } })
    expect(base.passes.implement.mode).toBe('full')
    // vendors (user-only in a file) are fine here.
    const withVendors: ResolvedConfig = {
      ...base,
      vendors: {
        claude: {
          path: 'C:\\x\\claude.exe',
          defaultModel: null,
          defaultEffort: null,
          extraArgs: [],
          env: {},
          flagMap: {},
        },
      },
    }
    expect(resolvedFromFile({ config: withVendors }).config.vendors['claude']?.path).toBe('C:\\x\\claude.exe')

    const e = errorOf(() => resolvedFromFile({ config: { ...base, auto: false } }))
    expect(e.code).toBe('invalid')
    expect(e.issues.map((i) => i.pointer)).toEqual([
      '/config/passes/implement/mode',
      '/config/passes/fix/mode',
    ])
    expect(() =>
      resolvedFromFile({
        config: { ...base, passes: { ...base.passes, plan: { ...base.passes.plan, mode: 'full' } } },
      }),
    ).toThrow(/plan must be read-only/)
    expect(() => resolvedFromFile('nope')).toThrow(ConfigResolveError)
    expect(() => resolvedFromFile({})).toThrow(ConfigResolveError)
  })

  it('applies patches through the injected hook', () => {
    const base = resolveBuiltinConfig({ profile: 'claude-only' })
    const seen: unknown[] = []
    const out = resolvedFromFile(
      { config: base, patches: [{ ops: [{ op: 'replace', path: '/passes/review/model', value: 'opus' }] }] },
      {
        applyPatches: (cfg, patches) => {
          seen.push(...patches)
          const c = structuredClone(cfg) as ResolvedConfig
          c.passes.review.model = 'opus'
          return c
        },
      },
    )
    expect(seen).toHaveLength(1)
    expect(out.config.passes.review.model).toBe('opus')
    expect(resolvedFromFile({ config: base, patches: [{ ops: [] }] }).config).toEqual(base)
  })
})

// ---- load + resolve ---------------------------------------------------------------------------------------------------

describe('loadAndResolve', () => {
  const setup = async (userText?: string, projectText?: string) => {
    const paths = homePaths(home())
    const folder = await tmp()
    if (userText !== undefined) await writeFile(paths.userConfig, userText)
    if (projectText !== undefined) {
      await mkdir(join(folder, '.dimfactory'), { recursive: true })
      await writeFile(join(folder, '.dimfactory', 'dimfactory.json'), projectText)
    }
    return { paths, folder }
  }

  it('no files → the builtin config; layers report what exists', async () => {
    const { paths, folder } = await setup()
    const r = await loadAndResolve({ paths, folder, scopeRoot: folder })
    expect(r.issues).toEqual([])
    expect(r.result?.config).toEqual(resolveBuiltinConfig({ home: home(), folder }))
    expect(r.layers.user).toEqual({
      scope: 'user',
      path: paths.userConfig,
      exists: false,
      sha256: null,
      valid: true,
    })
    expect(r.layers.project).toMatchObject({ scope: 'project', exists: false, valid: true })
    expect(r.projectRoot).toBe(folder)
    expect((await loadAndResolve({ paths })).project).toBeNull()
  })

  it('merges both files, stores last-good, and resolves templates from the project root', async () => {
    const { paths, folder } = await setup(
      '{\n  "profile": "claude-only",\n  "vendors": { "claude": { "defaultModel": "sonnet" } }\n}\n',
      '{ "gates": { "beforeFix": true } }',
    )
    await mkdir(join(folder, '.dimfactory', 'prompts'), { recursive: true })
    await writeFile(join(folder, '.dimfactory', 'prompts', 'fix.md'), 'project fix {{findings}}\n')
    const r = await loadAndResolve({ paths, folder, scopeRoot: folder, folderKey: '0123456789abcdef' })
    expect(r.issues).toEqual([])
    expect(r.result?.config).toMatchObject({ profile: 'claude-only', gates: { beforeFix: true } })
    expect(r.result?.config.passes.implement.model).toBe('sonnet')
    expect(r.result?.config.passes.fix.promptTemplate.layer).toBe('project')
    expect(r.result?.provenance['/gates/beforeFix']).toMatchObject({
      source: 'project',
      file: join(folder, '.dimfactory', 'dimfactory.json'),
      line: 1,
    })
    expect(await readFile(paths.lastGoodUserConfig, 'utf8')).toContain('"claude-only"')
    expect(await readFile(paths.lastGoodProjectConfig('0123456789abcdef'), 'utf8')).toContain('beforeFix')
  })

  it('an invalid user file: issues reported, builtins + project still resolve', async () => {
    const { paths, folder } = await setup(
      '{\n  "profile": "fast",\n  "aut": true\n}',
      '{ "gates": { "beforeFix": true } }',
    )
    const r = await loadAndResolve({ paths, folder, scopeRoot: folder })
    expect(r.issues.map((i) => `${i.file}:${i.line}:${i.col} ${i.code}`)).toEqual([
      `${paths.userConfig}:3:3 unrecognized_keys`,
    ])
    expect(r.issues[0]?.suggestion).toBe('auto')
    expect(r.layers.user.valid).toBe(false)
    expect(r.result?.config.profile).toBe('balanced')
    expect(r.result?.config.gates.beforeFix).toBe(true)
  })

  it('an invalid project file (incl. timeouts that clash with the user layer) is left out', async () => {
    const { paths, folder } = await setup(
      '{ "timeouts": { "stallMs": 1000000 } }',
      '{\n  "timeouts": { "hardKillMs": 950000 },\n  "auto": true\n}',
    )
    const r = await loadAndResolve({ paths, folder, scopeRoot: folder })
    expect(r.issues.map((i) => `${i.line}:${i.col} ${i.code} ${i.pointer}`)).toEqual([
      '2:31 timeout-order /timeouts/hardKillMs',
    ])
    expect(r.layers.project?.valid).toBe(false)
    expect(r.result?.config.auto).toBe(false)
    expect(r.result?.config.timeouts.stallMs).toBe(1_000_000)
  })

  it('a resolve failure is returned, not thrown', async () => {
    const { paths, folder } = await setup('{ "profile": "nope" }')
    const r = await loadAndResolve({ paths, folder })
    expect(r.result).toBeUndefined()
    expect(r.error?.code).toBe('unknown-profile')
    expect(r.error?.issues[0]).toMatchObject({ file: paths.userConfig, line: 1 })
  })
})
