import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  CONTEXT_HEALTH_DEFAULTS,
  DimFactoryConfigZ,
  DEFAULT_TIMEOUTS,
  FACTORY_DEFAULTS,
  ResolvedConfigZ,
  RunOverridesZ,
  USER_ONLY_KEYS,
  isAllowedPresetUrl,
  toJsonPointer,
  validateSemantics,
} from '@shared/config-schema.ts'
import type { DimFactoryConfig, ResolvedConfig, RunOverrides, SemanticIssue } from '@shared/config-schema.ts'
import type { LocalPreset } from '@shared/vendors.ts'

/** A user file that sets every key (all values valid). */
const FULL_USER = {
  $schema: './schema/dimfactory.schema.json',
  version: 1,
  profile: 'mine',
  profiles: {
    mine: {
      plan: {
        vendor: 'claude',
        model: 'opus',
        effort: 'high',
        mode: 'readonly',
        enabled: true,
        promptTemplate: null,
      },
      implement: {
        vendor: 'codex',
        model: null,
        effort: null,
        mode: 'autoedit',
        enabled: true,
        promptTemplate: 'implement-strict',
      },
      review: { vendor: 'claude', model: 'sonnet', mode: 'readonly' },
      critic: { vendor: 'claude', model: 'opus[1m]', enabled: false },
      fix: { inherit: 'implement', reuseSession: true },
    },
  },
  passes: { review: { model: 'claude-sonnet-4-5@20250929' }, fix: { reuseSession: false, inherit: null } },
  planning: { native: 'auto' },
  gates: { afterPlan: true, beforeFix: false },
  auto: false,
  ask: { denyPauses: false },
  timeouts: { stallMs: 300_000, hardKillMs: 1_200_000, toolStallMs: 900_000, askMs: 600_000 },
  isolation: {
    mode: 'inPlace',
    branch: 'none',
    branchPrefix: 'dim/',
    worktree: { copy: ['.env.local'], install: 'ask', installCommand: null, autoApply: false },
  },
  verify: {
    enabled: true,
    commands: [
      { name: 'typecheck', run: ['pnpm', 'typecheck'] },
      { name: 'test', run: 'pnpm test -- --run', cwd: 'packages/app', timeoutMs: 600_000, enabled: true },
    ],
    runAfter: ['implement', 'fix'],
    failFast: false,
    baseline: false,
  },
  selfHeal: { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false },
  ui: { theme: 'system', accent: 'slate', closeToTray: 'auto', streamFontSize: 13, experience: null },
  notifications: {
    desktop: true,
    sound: false,
    onlyWhenUnfocused: true,
    events: { ask: true, gate: true, completed: true, failed: true, catalog: false },
  },
  vendors: {
    claude: {
      path: null,
      defaultModel: 'sonnet',
      defaultEffort: 'high',
      extraArgs: ['--verbose'],
      env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\x\\.claude-fixtures' },
      flagMap: { '--permission-mode': '--mode' },
    },
    'local-ollama': { defaultModel: 'qwen3-coder' },
  },
  catalog: { refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' } },
  storage: { keepRuns: 300, keepDays: 60, rawLogDays: 14 },
  local: {
    presets: [
      {
        id: 'ollama',
        label: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen3-coder',
        contextWindow: 65536,
      },
      {
        id: 'lab',
        label: 'Lab box',
        baseUrl: 'https://llm.lab.example.com/v1',
        model: 'm',
        apiKeyEnv: 'LAB_KEY',
      },
    ],
  },
}

const sha = 'a'.repeat(64)
const tpl = (name: string): ResolvedConfig['passes']['plan']['promptTemplate'] => ({
  name,
  path: `builtin:${name}.md`,
  layer: 'builtin',
  sha256: sha,
})

function resolved(): ResolvedConfig {
  return {
    profile: 'balanced',
    auto: false,
    passes: {
      plan: {
        vendor: 'claude',
        model: 'opus',
        effort: null,
        mode: 'readonly',
        enabled: true,
        promptTemplate: tpl('plan'),
        extensions: 'none',
        clarify: false,
        clarifyQuestions: 4,
        clarifyInAuto: false,
        clarifyPlain: false,
        research: false,
        researchLenses: [],
        explain: false,
        explainPlain: false,
      },
      implement: {
        vendor: 'codex',
        model: null,
        effort: null,
        mode: 'autoedit',
        enabled: true,
        promptTemplate: tpl('implement'),
        extensions: 'passthrough',
        deploy: false,
        deployTarget: null,
      },
      review: {
        vendor: 'claude',
        model: 'sonnet',
        effort: null,
        mode: 'readonly',
        enabled: true,
        promptTemplate: tpl('review'),
        extensions: 'none',
        acceptance: false,
      },
      critic: {
        vendor: 'claude',
        model: 'opus',
        effort: null,
        mode: 'readonly',
        enabled: true,
        promptTemplate: tpl('critic'),
        extensions: 'none',
      },
      security: {
        vendor: 'claude',
        model: 'opus',
        effort: null,
        mode: 'readonly',
        enabled: false,
        promptTemplate: tpl('security'),
        extensions: 'none',
        recheck: true,
      },
      fix: {
        vendor: 'codex',
        model: null,
        effort: null,
        mode: 'autoedit',
        enabled: true,
        promptTemplate: tpl('fix'),
        extensions: 'passthrough',
        inherit: 'implement',
        reuseSession: true,
        rounds: 1,
        recheck: true,
        maxCostUsd: null,
        maxMinutes: null,
      },
    },
    planning: { native: 'auto' },
    gates: { afterPlan: true, beforeFix: false },
    ask: { denyPauses: false },
    timeouts: { ...DEFAULT_TIMEOUTS },
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
    extensions: { allowed: {} },
    tools: { on: {}, off: {}, skill: null },
    selfHeal: { enabled: true, vendor: 'claude', model: 'sonnet', autoApplyConfigPatches: false },
    ui: { theme: 'system', accent: 'slate', closeToTray: 'auto', streamFontSize: 13, experience: null },
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
    git: { commit: false, pullRequest: false, remote: 'origin' },
    factory: structuredClone(FACTORY_DEFAULTS),
    fallback: { enabled: false, vendors: [] },
    quality: { enabled: false, verify: [], security: false, acceptance: false },
    memory: { enabled: true, propose: true, autoApply: false, maxBytes: 16_000 },
    routing: {},
    limits: { maxCostUsd: null, maxMinutes: null },
    guardrails: { preset: 'recommended', rules: [] },
    easy: {
      projectsDir: null,
      maxCostUsd: null,
      changeMaxCostUsd: null,
      maxMinutes: null,
      skipPlanCheck: false,
    },
    contextHealth: { ...CONTEXT_HEALTH_DEFAULTS },
  }
}

function issuesOf(r: z.ZodSafeParseResult<unknown>): z.core.$ZodIssue[] {
  return r.success ? [] : r.error.issues
}

function parseFile(value: unknown): DimFactoryConfig {
  return DimFactoryConfigZ.parse(value)
}

const pointers = (issues: SemanticIssue[]): string[] => issues.map((i) => i.pointer)

describe('DimFactoryConfigZ', () => {
  it('parses a file that sets every key', () => {
    const r = DimFactoryConfigZ.safeParse(FULL_USER)
    expect(issuesOf(r)).toEqual([])
    expect(validateSemantics(parseFile(FULL_USER), { scope: 'user' })).toEqual([])
  })

  it('accepts an empty file and a missing version', () => {
    expect(DimFactoryConfigZ.safeParse({}).success).toBe(true)
    expect(DimFactoryConfigZ.safeParse({ version: 2 }).success).toBe(false)
  })

  it('rejects an unknown top-level key with unrecognized_keys', () => {
    const issues = issuesOf(DimFactoryConfigZ.safeParse({ profile: 'balanced', trust: {} }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['trust'], path: [] })
  })

  it('rejects an unknown nested pass key with unrecognized_keys at the pass path', () => {
    const issues = issuesOf(DimFactoryConfigZ.safeParse({ passes: { review: { promptTemplte: 'x' } } }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['promptTemplte'],
      path: ['passes', 'review'],
    })

    const inProfile = issuesOf(DimFactoryConfigZ.safeParse({ profiles: { mine: { fix: { reuse: true } } } }))
    expect(inProfile[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['reuse'],
      path: ['profiles', 'mine', 'fix'],
    })
  })

  it('allows inherit/reuseSession only on fix', () => {
    const issues = issuesOf(DimFactoryConfigZ.safeParse({ passes: { review: { reuseSession: true } } }))
    expect(issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['reuseSession'] })
  })

  it('stays strict after .partial() at every level', () => {
    const again = DimFactoryConfigZ.partial()
    expect(issuesOf(again.safeParse({ bogus: 1 }))[0]?.code).toBe('unrecognized_keys')
    expect(issuesOf(DimFactoryConfigZ.safeParse({ timeouts: { stalMs: 300_000 } }))[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: ['timeouts'],
    })
    expect(
      issuesOf(DimFactoryConfigZ.safeParse({ isolation: { worktree: { autoapply: true } } }))[0],
    ).toMatchObject({ code: 'unrecognized_keys', path: ['isolation', 'worktree'] })
    expect(issuesOf(DimFactoryConfigZ.safeParse({ vendors: { claude: { args: [] } } }))[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: ['vendors', 'claude'],
    })
  })

  it('enforces value bounds', () => {
    const bad: [string, unknown][] = [
      ['stallMs below 30 s', { timeouts: { stallMs: 29_999 } }],
      ['hardKillMs below 60 s', { timeouts: { hardKillMs: 59_999 } }],
      ['toolStallMs below 30 s', { timeouts: { toolStallMs: 1_000 } }],
      ['askMs below 30 s', { timeouts: { askMs: 10_000 } }],
      ['non-integer timeout', { timeouts: { askMs: 60_000.5 } }],
      ['font size', { ui: { streamFontSize: 15 } }],
      ['accent', { ui: { accent: 'pink' } }],
      ['closeToTray', { ui: { closeToTray: 'always' } }],
      ['mode', { passes: { implement: { mode: 'yolo' } } }],
      ['isolation mode spelling', { isolation: { mode: 'inplace' } }],
      ['install policy', { isolation: { worktree: { install: 'always' } } }],
      ['runAfter', { verify: { runAfter: ['review'] } }],
      ['verify command without run', { verify: { commands: [{ name: 'x' }] } }],
      ['vendor id', { vendors: { Claude: {} } }],
      ['forbidden env', { vendors: { claude: { env: { PATH: 'x' } } } }],
      ['forbidden env (case)', { vendors: { claude: { env: { node_options: 'x' } } } }],
      ['forbidden env (electron)', { vendors: { claude: { env: { ELECTRON_RUN_AS_NODE: '1' } } } }],
      ['flagMap key', { vendors: { claude: { flagMap: { 'permission-mode': '--mode' } } } }],
      [
        'http to a remote preset',
        { local: { presets: [{ id: 'x', label: 'x', baseUrl: 'http://10.0.0.5/v1', model: 'm' }] } },
      ],
      ['profile name', { profile: 'My Profile' }],
      ['intervalDays', { catalog: { refresh: { intervalDays: 0 } } }],
    ]
    for (const [name, value] of bad) expect(DimFactoryConfigZ.safeParse(value).success, name).toBe(false)
  })

  it('accepts loopback http and any https for local presets', () => {
    for (const u of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:11434',
      'http://[::1]:8080/v1',
      'https://x.example.com',
    ]) {
      expect(isAllowedPresetUrl(u), u).toBe(true)
    }
    for (const u of [
      'http://192.168.1.2/v1',
      'ftp://localhost/',
      'localhost:1234',
      'http://user@localhost/',
    ]) {
      expect(isAllowedPresetUrl(u), u).toBe(false)
    }
  })

  it('can generate the editor JSON schema', () => {
    const schema = z.toJSONSchema(DimFactoryConfigZ, { unrepresentable: 'any' })
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('infers exact local preset types', () => {
    type FilePreset = NonNullable<NonNullable<DimFactoryConfig['local']>['presets']>[number]
    expectTypeOf<FilePreset>().toEqualTypeOf<LocalPreset>()
  })
})

describe('RunOverridesZ', () => {
  it('accepts the run-layer keys', () => {
    const value = {
      profile: 'fast',
      auto: true,
      passes: { fix: { reuseSession: false, vendor: 'claude' } },
      gates: { afterPlan: false },
      planning: { native: 'off' },
      isolation: { mode: 'worktree', branch: 'runBranch' },
      verify: { enabled: true },
    }
    expect(issuesOf(RunOverridesZ.safeParse(value))).toEqual([])
    expectTypeOf<RunOverrides>().toHaveProperty('passes')
  })

  it('rejects every user-only key', () => {
    for (const key of USER_ONLY_KEYS) {
      const issues = issuesOf(RunOverridesZ.safeParse({ [key]: {} }))
      expect(issues[0], key).toMatchObject({ code: 'unrecognized_keys', keys: [key] })
    }
    expect(issuesOf(RunOverridesZ.safeParse({ timeouts: {} }))[0]?.code).toBe('unrecognized_keys')
  })
})

describe('ResolvedConfigZ', () => {
  it('accepts a fully populated config', () => {
    expect(issuesOf(ResolvedConfigZ.safeParse(resolved()))).toEqual([])
  })

  it('accepts mode "full" for implement/fix only together with auto', () => {
    const noAuto = resolved()
    noAuto.passes.implement.mode = 'full'
    noAuto.passes.fix.mode = 'full'
    const issues = issuesOf(ResolvedConfigZ.safeParse(noAuto))
    expect(issues.map((i) => i.path)).toEqual([
      ['passes', 'implement', 'mode'],
      ['passes', 'fix', 'mode'],
    ])

    const withAuto = { ...noAuto, auto: true, gates: { afterPlan: false, beforeFix: false } }
    expect(issuesOf(ResolvedConfigZ.safeParse(withAuto))).toEqual([])
  })

  it('never accepts a non-read-only plan, review or critic', () => {
    const cfg = { ...resolved(), auto: true }
    cfg.passes.plan.mode = 'full'
    cfg.passes.critic.mode = 'autoedit'
    expect(issuesOf(ResolvedConfigZ.safeParse(cfg)).map((i) => i.path)).toEqual([
      ['passes', 'plan', 'mode'],
      ['passes', 'critic', 'mode'],
    ])
  })

  it('checks timeout ordering', () => {
    const cfg = resolved()
    cfg.timeouts = { ...cfg.timeouts, stallMs: 1_200_000, toolStallMs: 1_300_000 }
    expect(issuesOf(ResolvedConfigZ.safeParse(cfg)).map((i) => i.path)).toEqual([
      ['timeouts', 'stallMs'],
      ['timeouts', 'toolStallMs'],
    ])
  })

  it('is strict and requires every key', () => {
    expect(issuesOf(ResolvedConfigZ.safeParse({ ...resolved(), extra: 1 }))[0]?.code).toBe(
      'unrecognized_keys',
    )
    const { storage: _storage, ...missing } = resolved()
    expect(ResolvedConfigZ.safeParse(missing).success).toBe(false)
    const badPass = resolved() as unknown as { passes: { review: Record<string, unknown> } }
    badPass.passes.review['reuseSession'] = true
    expect(issuesOf(ResolvedConfigZ.safeParse(badPass))[0]?.code).toBe('unrecognized_keys')
  })
})

describe('validateSemantics', () => {
  it('requires plan/review/critic to be read-only, in profiles and passes', () => {
    const cfg = parseFile({
      profiles: { mine: { plan: { mode: 'full' }, critic: { mode: 'autoedit' } } },
      passes: { review: { mode: 'autoedit' } },
    })
    const issues = validateSemantics(cfg, { scope: 'user' })
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/profiles/mine/plan/mode', 'readonly-pass'],
      ['/profiles/mine/critic/mode', 'readonly-pass'],
      ['/passes/review/mode', 'readonly-pass'],
    ])
    expect(issues.every((i) => i.severity === 'error')).toBe(true)
  })

  it('never allows mode "full" in a file', () => {
    const cfg = parseFile({
      auto: true,
      profiles: { p: { fix: { mode: 'full' } } },
      passes: { implement: { mode: 'full' } },
    })
    const issues = validateSemantics(cfg, { scope: 'project' })
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/profiles/p/fix/mode', 'full-in-file'],
      ['/passes/implement/mode', 'full-in-file'],
    ])
    expect(issues[0]?.message).toContain('"auto": true')
  })

  it('checks stallMs < hardKillMs and toolStallMs < hardKillMs against effective values', () => {
    const at = (timeouts: object, inheritedTimeouts?: object): string[] =>
      pointers(
        validateSemantics(parseFile({ timeouts }), {
          scope: 'user',
          ...(inheritedTimeouts ? { inheritedTimeouts } : {}),
        }),
      )
    expect(at({ stallMs: 1_200_000 })).toEqual(['/timeouts/stallMs'])
    expect(at({ toolStallMs: 2_000_000, hardKillMs: 1_500_000 })).toEqual(['/timeouts/toolStallMs'])
    expect(at({ hardKillMs: 600_000 })).toEqual(['/timeouts/hardKillMs'])
    expect(at({ stallMs: 1_500_000 }, { hardKillMs: 3_000_000 })).toEqual([])
    expect(at({ askMs: 60_000 })).toEqual([])
    expect(at({ ...DEFAULT_TIMEOUTS })).toEqual([])
  })

  it('validates flagMap values and, when given, managed flags', () => {
    const cfg = parseFile({
      vendors: {
        claude: {
          flagMap: { '--permission-mode': '--mode', '--model': 'Model', '--resume': '-r' },
          extraArgs: ['--model=opus', '--verbose', '--add-dir'],
        },
      },
    })
    expect(validateSemantics(cfg, { scope: 'user' }).map((i) => [i.pointer, i.code])).toEqual([
      ['/vendors/claude/flagMap/--model', 'flag-map-value'],
    ])
    const managed = { claude: ['--permission-mode', '--model', '--add-dir'] }
    expect(
      validateSemantics(cfg, { scope: 'user', managedFlags: managed }).map((i) => [i.pointer, i.code]),
    ).toEqual([
      ['/vendors/claude/flagMap/--model', 'flag-map-value'],
      ['/vendors/claude/flagMap/--resume', 'flag-map-key'],
      ['/vendors/claude/extraArgs/0', 'managed-flag'],
      ['/vendors/claude/extraArgs/2', 'managed-flag'],
    ])
  })

  it('reports user-only keys in a project file only', () => {
    const cfg = parseFile({
      ui: { theme: 'dark' },
      vendors: { claude: { path: 'C:\\evil.exe' } },
      profile: 'fast',
    })
    expect(validateSemantics(cfg, { scope: 'user' })).toEqual([])
    const issues = validateSemantics(cfg, { scope: 'project' })
    expect(issues.map((i) => [i.pointer, i.code])).toEqual([
      ['/ui', 'user-only-key'],
      ['/vendors', 'user-only-key'],
    ])
    const projectOk = Object.fromEntries(
      Object.entries(FULL_USER).filter(([k]) => !(USER_ONLY_KEYS as readonly string[]).includes(k)),
    )
    expect(validateSemantics(parseFile(projectOk), { scope: 'project' })).toEqual([])
  })

  it('reports duplicate local preset ids', () => {
    const preset = { id: 'ollama', label: 'O', baseUrl: 'http://localhost:11434/v1', model: 'm' }
    const cfg = parseFile({ local: { presets: [preset, { ...preset, label: 'O2' }] } })
    expect(pointers(validateSemantics(cfg, { scope: 'user' }))).toEqual(['/local/presets/1/id'])
  })
})

describe('toJsonPointer', () => {
  it('escapes per RFC 6901', () => {
    expect(toJsonPointer([])).toBe('')
    expect(toJsonPointer(['a/b', 'c~d', 0])).toBe('/a~1b/c~0d/0')
    expect(toJsonPointer(['vendors', 'claude', 'flagMap', '--permission-mode'])).toBe(
      '/vendors/claude/flagMap/--permission-mode',
    )
  })
})
