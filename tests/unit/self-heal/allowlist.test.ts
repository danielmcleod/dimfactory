// config_patch safety (executors config_patch, "autoApplyConfigPatches"): every allowlisted
// pointer is accepted, every forbidden one refused (executable paths, verify and install commands, Auto, a mode
// escalation, managed flags in extraArgs, flagMap values that are not flags or that rename to a managed or escalating
// flag), and a patched resolved config must leave every protected field exactly as it was.
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '@shared/config-schema.ts'
import type { JsonPatchOp } from '@shared/failure.ts'
import { MANAGED_FLAGS } from '@core/adapters/claude/capabilities.ts'
import { extraArgsProblem, flagMapProblem } from '@core/adapters/claude/launch.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { DimFactoryError } from '@core/errors.ts'
import {
  AUTO_APPLY_POINTERS,
  checkRecoveryOps,
  escalatingArg,
  guardResolved,
  isAutoApplicable,
  isSafetyFlag,
  patchPreview,
  patchResolved,
} from '@core/recovery/config-patch.ts'
import type { VendorArgsCheck } from '@core/recovery/config-patch.ts'
import { applyJsonPatch } from '@core/recovery/json-patch.ts'

const managedFlags = { claude: MANAGED_FLAGS as readonly string[] }
const vendorArgs: VendorArgsCheck = (vendor, v) =>
  vendor === 'claude' ? (extraArgsProblem(v.extraArgs) ?? flagMapProblem(v.flagMap)) : undefined
const guard = { managedFlags, vendorArgs }

function resolved(): ResolvedConfig {
  const c = resolveBuiltinConfig({ profile: 'claude-only' })
  return {
    ...c,
    vendors: {
      ...c.vendors,
      claude: {
        path: null,
        defaultModel: null,
        defaultEffort: null,
        extraArgs: ['--max-turns', '40'],
        env: {},
        flagMap: {},
      },
    },
  }
}

const replace = (path: string, value: unknown): JsonPatchOp => ({ op: 'replace', path, value })
const add = (path: string, value: unknown): JsonPatchOp => ({ op: 'add', path, value })

function refusal(fn: () => unknown): DimFactoryError {
  try {
    fn()
  } catch (e) {
    if (e instanceof DimFactoryError) return e
    throw e
  }
  throw new Error('expected a refusal')
}

describe('allowlisted pointers are accepted', () => {
  const allowed: [string, JsonPatchOp][] = [
    ['/profile', replace('/profile', 'fast')],
    ['/passes/*/vendor', replace('/passes/review/vendor', 'codex')],
    ['/passes/*/model', replace('/passes/plan/model', null)],
    ['/passes/*/model (fix)', replace('/passes/fix/model', 'sonnet')],
    ['/passes/*/enabled (plan)', replace('/passes/plan/enabled', false)],
    ['/passes/*/enabled (review)', replace('/passes/review/enabled', false)],
    ['/passes/*/enabled (critic)', replace('/passes/critic/enabled', false)],
    ['/passes/fix/reuseSession', replace('/passes/fix/reuseSession', false)],
    ['/timeouts/stallMs', replace('/timeouts/stallMs', 600_000)],
    ['/timeouts/hardKillMs', replace('/timeouts/hardKillMs', 2_400_000)],
    ['/timeouts/toolStallMs', replace('/timeouts/toolStallMs', 600_000)],
    ['/timeouts/askMs', replace('/timeouts/askMs', 120_000)],
    ['/isolation/branch', replace('/isolation/branch', 'runBranch')],
    ['/isolation/worktree/install', replace('/isolation/worktree/install', 'never')],
    ['/vendors/*/extraArgs', replace('/vendors/claude/extraArgs', ['--max-turns', '80'])],
    ['/vendors/*/extraArgs/-', add('/vendors/claude/extraArgs/-', '--debug')],
    ['/vendors/*/flagMap/*', add('/vendors/claude/flagMap/--permission-mode', '--mode')],
  ]
  it.each(allowed)('%s', (_name, op) => {
    expect(checkRecoveryOps([op], { target: 'resolved', managedFlags })).toEqual([op])
    expect(checkRecoveryOps([op], { target: 'runOverrides', managedFlags })).toEqual([op])
    const before = resolved()
    const { config, ops } = patchResolved(before, [op], guard)
    expect(ops).toEqual([op])
    expect(config).not.toEqual(before)
  })

  it('a flagMap entry for a vendor the run has no settings for creates that vendor entry', () => {
    const c = resolveBuiltinConfig({ profile: 'claude-only' })
    const { config } = patchResolved(c, [add('/vendors/claude/flagMap/--model', '--model-name')], guard)
    expect(config.vendors['claude']).toEqual({
      path: null,
      defaultModel: null,
      defaultEffort: null,
      extraArgs: [],
      env: {},
      flagMap: { '--model': '--model-name' },
    })
  })
})

describe('forbidden pointers and values are refused', () => {
  const forbidden: [string, JsonPatchOp, RegExp][] = [
    ['an executable path', replace('/vendors/claude/path', 'C:\\evil\\claude.exe'), /Executable paths/],
    ['verify commands', replace('/verify/commands', [{ name: 'x', run: 'rm -rf /' }]), /Verify commands/],
    ['verify on', replace('/verify/enabled', true), /Verify commands/],
    ['an install command', replace('/isolation/worktree/installCommand', 'npm i evil'), /Install commands/],
    ['install auto', replace('/isolation/worktree/install', 'auto'), /escalation/],
    ['Auto on', replace('/auto', true), /Auto mode/],
    ['a pass mode', replace('/passes/implement/mode', 'full'), /mode escalation/],
    ['a read-only pass mode', replace('/passes/review/mode', 'autoedit'), /mode escalation/],
    ['a profile mode', replace('/profiles/mine/implement/mode', 'autoedit'), /mode escalation/],
    ['Implement off', replace('/passes/implement/enabled', false), /Only Plan, Review and Critic/],
    ['a prompt template', replace('/passes/review/promptTemplate', 'x'), /cannot be changed/],
    ['vendor env', replace('/vendors/claude/env', { PATH: 'x' }), /cannot be changed/],
    ['default model', replace('/vendors/claude/defaultModel', 'opus'), /cannot be changed/],
    ['isolation mode', replace('/isolation/mode', 'worktree'), /cannot be changed/],
    ['self-heal settings', replace('/selfHeal/autoApplyConfigPatches', true), /cannot be changed/],
    ['the theme', replace('/ui/theme', 'dark'), /cannot be changed/],
    [
      'a managed flag in extraArgs',
      replace('/vendors/claude/extraArgs', ['--model=opus']),
      /managed by Dim Factory/,
    ],
    [
      'a managed flag appended',
      add('/vendors/claude/extraArgs/-', '--permission-mode'),
      /managed by Dim Factory/,
    ],
    [
      'skip permissions',
      replace('/vendors/claude/extraArgs', ['--dangerously-skip-permissions']),
      /escalation/,
    ],
    ['full auto', add('/vendors/codex/extraArgs/-', '--full-auto'), /escalation/],
    [
      'a flagMap value that is not a flag',
      add('/vendors/claude/flagMap/--model', 'not a flag'),
      /look like a flag/,
    ],
    ['a flagMap value without dashes', add('/vendors/claude/flagMap/--model', 'model'), /look like a flag/],
    ['a flagMap rename to yolo', add('/vendors/gemini/flagMap/--approval-mode', '--yolo'), /escalation/],
    [
      'a flagMap key Dim Factory does not manage',
      add('/vendors/claude/flagMap/--verbose-ish', '--x'),
      /not a flag Dim Factory manages/,
    ],
  ]
  it.each(forbidden)('%s', (_name, op, reason) => {
    for (const target of ['resolved', 'runOverrides'] as const) {
      const e = refusal(() => checkRecoveryOps([op], { target, managedFlags }))
      expect(e.code).toBe('FORBIDDEN')
      expect(e.message).toMatch(reason)
    }
    expect(refusal(() => patchResolved(resolved(), [op], guard)).code).toBe('FORBIDDEN')
  })

  it('one forbidden op refuses the whole patch (nothing applied partially)', () => {
    const before = resolved()
    const e = refusal(() =>
      patchResolved(
        before,
        [replace('/passes/plan/model', null), replace('/vendors/claude/path', 'x')],
        guard,
      ),
    )
    expect(e.code).toBe('FORBIDDEN')
    expect(before.passes.plan.model).toBe('opus')
  })

  it('Auto can be turned off for a composer run, never on; and never through the resolved config', () => {
    const off = add('/auto', false)
    expect(checkRecoveryOps([off], { target: 'runOverrides' })).toEqual([off])
    expect(refusal(() => checkRecoveryOps([off], { target: 'resolved' })).code).toBe('FORBIDDEN')
    expect(refusal(() => checkRecoveryOps([add('/auto', true)], { target: 'runOverrides' })).code).toBe(
      'FORBIDDEN',
    )
  })

  it('managed flags are matched whatever their spelling, and escalating flags for any vendor', () => {
    for (const arg of ['--Permission_Mode', '--disallowed-tools', '--ALLOWEDTOOLS']) {
      expect(
        refusal(() => patchResolved(resolved(), [replace('/vendors/claude/extraArgs', [arg])], guard))
          .message,
      ).toMatch(/managed by Dim Factory/)
    }
    for (const arg of [
      '--add-dir',
      '--mcp-config',
      '--allow-dangerously-skip-permissions',
      '-c',
      '--sandbox',
    ]) {
      expect(escalatingArg(arg), arg).toBe(true)
      expect(
        refusal(() => patchResolved(resolved(), [replace('/vendors/claude/extraArgs', [arg])], guard)).code,
      ).toBe('FORBIDDEN')
    }
    expect(escalatingArg('--debug')).toBe(false)
  })

  it('a flagMap rename may not target another managed flag (the read-only tool cut would become an allow list)', () => {
    const e = refusal(() =>
      patchResolved(resolved(), [add('/vendors/claude/flagMap/--disallowedTools', '--allowed-tools')], guard),
    )
    expect(e).toMatchObject({ code: 'FORBIDDEN' })
    expect(e.message).toMatch(/manages itself/)
    // A spelling of the same flag is a rename, not a swap.
    expect(() =>
      patchResolved(
        resolved(),
        [add('/vendors/claude/flagMap/--disallowedTools', '--disallowed-tools')],
        guard,
      ),
    ).not.toThrow()
  })

  it("the vendor adapter's own launch rules hold too", () => {
    const strict: VendorArgsCheck = () => 'the adapter refuses it'
    const e = refusal(() =>
      patchResolved(resolved(), [add('/vendors/claude/extraArgs/-', '--debug')], {
        managedFlags,
        vendorArgs: strict,
      }),
    )
    expect(e.message).toMatch(/the adapter refuses it/)
  })

  it('malformed ops, an empty patch and a patch that no longer applies are VALIDATION', () => {
    expect(refusal(() => checkRecoveryOps([], { target: 'resolved' })).code).toBe('VALIDATION')
    expect(
      refusal(() => checkRecoveryOps([{ op: 'move', path: '/profile' }], { target: 'resolved' })).code,
    ).toBe('VALIDATION')
    expect(
      refusal(() => checkRecoveryOps([{ op: 'test', path: '/profile', value: 'x' }], { target: 'resolved' }))
        .code,
    ).toBe('VALIDATION')
    expect(
      refusal(() => patchResolved(resolved(), [{ op: 'remove', path: '/passes/plan/model' }], guard)).code,
    ).toBe('VALIDATION')
    expect(refusal(() => patchResolved(resolved(), [replace('/timeouts/stallMs', 5)], guard)).code).toBe(
      'VALIDATION',
    )
    // A failed test op: the config changed since the fix was offered.
    expect(
      refusal(() =>
        patchResolved(
          resolved(),
          [{ op: 'test', path: '/passes/plan/model', value: 'sonnet' }, replace('/passes/plan/model', null)],
          guard,
        ),
      ).message,
    ).toMatch(/no longer matches/)
  })

  it('guardResolved refuses any protected change however it was made', () => {
    const before = resolved()
    const protectedChanges: ((c: ResolvedConfig) => void)[] = [
      (c) => (c.auto = true),
      (c) => (c.passes.implement.mode = 'full'),
      (c) => (c.passes.fix.inherit = null),
      (c) => (c.verify.enabled = true),
      (c) => (c.isolation.worktree.installCommand = 'npm i'),
      (c) => {
        const v = c.vendors['claude']
        if (v !== undefined) v.path = 'C:\\x.exe'
      },
      (c) => {
        const v = c.vendors['claude']
        if (v !== undefined) v.env = { FOO: '1' }
      },
      (c) => (c.selfHeal.enabled = false),
      (c) => (c.gates.afterPlan = false),
    ]
    for (const change of protectedChanges) {
      const after = structuredClone(before)
      change(after)
      expect(refusal(() => guardResolved(before, after, guard)).code).toBe('FORBIDDEN')
    }
  })
})

describe('autoApplyConfigPatches subset', () => {
  it('only /passes/*/model, /timeouts/* and /vendors/*/{extraArgs,flagMap/*}', () => {
    expect(AUTO_APPLY_POINTERS).toEqual([
      '/passes/*/model',
      '/timeouts/*',
      '/vendors/*/extraArgs',
      '/vendors/*/flagMap/*',
    ])
    const yes = [
      [replace('/passes/plan/model', null)],
      [replace('/timeouts/askMs', 120_000)],
      [replace('/vendors/claude/extraArgs', [])],
      [add('/vendors/claude/extraArgs/-', '--debug')],
      [add('/vendors/claude/flagMap/--model', '--model-name')],
      [
        { op: 'test', path: '/passes/plan/model', value: 'opus' } as JsonPatchOp,
        replace('/passes/plan/model', null),
      ],
    ]
    for (const ops of yes) expect(isAutoApplicable(ops), JSON.stringify(ops)).toBe(true)
    const no = [
      [replace('/profile', 'fast')],
      [replace('/passes/plan/vendor', 'codex')],
      [replace('/passes/review/enabled', false)],
      [replace('/passes/fix/reuseSession', false)],
      [replace('/isolation/branch', 'runBranch')],
      [replace('/isolation/worktree/install', 'never')],
      [replace('/passes/plan/model', null), replace('/profile', 'fast')],
      [{ op: 'test', path: '/profile', value: 'x' } as JsonPatchOp],
      [],
    ]
    for (const ops of no) expect(isAutoApplicable(ops), JSON.stringify(ops)).toBe(false)
  })
})

describe('the preview is the diff the snag card shows', () => {
  it('- old / + new per write, against the run config', () => {
    const c = resolved()
    expect(patchPreview([replace('/passes/plan/model', null)], c)).toBe(
      '- passes.plan.model: "opus"\n+ passes.plan.model: null',
    )
    expect(patchPreview([add('/vendors/claude/flagMap/--permission-mode', '--mode')], c)).toBe(
      '+ vendors.claude.flagMap.--permission-mode: "--mode"',
    )
    // A replaced extraArgs list shows the arguments it loses and gains, one per line.
    expect(
      patchPreview(
        [
          { op: 'test', path: '/profile', value: 'claude-only' },
          replace('/vendors/claude/extraArgs', ['--debug']),
          { op: 'remove', path: '/vendors/claude/extraArgs/0' },
        ],
        c,
      ),
    ).toBe(
      [
        '- vendors.claude.extraArgs: "--max-turns"',
        '- vendors.claude.extraArgs: "40"',
        '+ vendors.claude.extraArgs: "--debug"',
        '- vendors.claude.extraArgs.0: "--debug"',
      ].join('\n'),
    )
    // Without the config: only the new values.
    expect(patchPreview([replace('/timeouts/askMs', 120_000)])).toBe('+ timeouts.askMs: 120000')
    expect(patchPreview([replace('/passes/plan/model', null)], c)).not.toMatch(/\u2014/)
  })

  it('never cuts a vendor argument: an argument appended to a long list is shown', () => {
    const long = ['--max-turns', '40', '--max-budget-usd', '5', '--fallback-model', 'claude-sonnet-5-5']
    const c = resolved()
    const v = c.vendors['claude']
    if (v !== undefined) v.extraArgs = long
    expect(patchPreview([replace('/vendors/claude/extraArgs', [...long, '-pc'])], c)).toBe(
      '+ vendors.claude.extraArgs: "-pc"',
    )
    // Without the config, the whole new list, uncut.
    const whole = patchPreview([replace('/vendors/claude/extraArgs', [...long, '-pc'])])
    expect(whole).toBe(`+ vendors.claude.extraArgs: ${JSON.stringify([...long, '-pc'])}`)
    expect(whole).not.toContain('\u2026')
    // Only the order changed: both lists, whole.
    expect(patchPreview([replace('/vendors/claude/extraArgs', [...long].reverse())], c)).toBe(
      [
        `- vendors.claude.extraArgs: ${JSON.stringify(long)}`,
        `+ vendors.claude.extraArgs: ${JSON.stringify([...long].reverse())}`,
      ].join('\n'),
    )
    // Other long values are still cut at 80 characters.
    expect(patchPreview([replace('/profile', 'x'.repeat(200))])).toContain('\u2026')
  })
})

describe('combined short flags, renames onto CLI flags, autoApply of safety flags', () => {
  it('extraArgs may not combine a managed short flag with others (-pc, -r<id>), at every layer', () => {
    for (const arg of ['-pc', '-cp', '-rfa4ecb4e-ac4a-4078-8783-fa1e4b132e44', '-dp', '-p=x']) {
      const ops = [add('/vendors/claude/extraArgs/-', arg)]
      expect(refusal(() => checkRecoveryOps(ops, { target: 'resolved', managedFlags })).code, arg).toBe(
        'FORBIDDEN',
      )
      expect(refusal(() => patchResolved(resolved(), ops, guard)).code, arg).toBe('FORBIDDEN')
      // The guard alone (the config already patched some other way).
      const after = applyJsonPatch(resolved(), ops)
      expect(refusal(() => guardResolved(resolved(), after, { managedFlags })).code, arg).toBe('FORBIDDEN')
      expect(extraArgsProblem([arg]), arg).toMatch(/combine/)
    }
    // A cluster of letters Dim Factory does not manage, and plain values, stay allowed.
    expect(() => patchResolved(resolved(), [add('/vendors/claude/extraArgs/-', '-dv')], guard)).not.toThrow()
    expect(extraArgsProblem(['--max-turns', '-10'])).toBeUndefined()
  })

  it('a flagMap rename onto a flag the CLI already defines is refused (the read-only tool cut would become an option value)', () => {
    for (const [from, to] of [
      ['--disallowedTools', '--fallback-model'],
      ['--disallowedTools', '--betas'],
      ['--strict-mcp-config', '--debug'],
      ['--settings', '--verbose-x'],
    ] as const) {
      const ops = [add(`/vendors/claude/flagMap/${from}`, to)]
      if (to === '--verbose-x') {
        // Not a Claude Code flag: a plain rename.
        expect(() => patchResolved(resolved(), ops, guard)).not.toThrow()
        continue
      }
      const e = refusal(() => patchResolved(resolved(), ops, guard))
      expect(e.code).toBe('FORBIDDEN')
      expect(e.message).toMatch(/already uses/)
      // Also without a run's config (a run-less fix saved to the user file).
      expect(
        refusal(() => checkRecoveryOps(ops, { target: 'runOverrides', managedFlags, vendorArgs })).code,
      ).toBe('FORBIDDEN')
      expect(flagMapProblem({ [from]: to })).toMatch(/already uses/)
    }
  })

  it('a rename of a read-only safety flag never applies on its own; other renames and arguments still may', () => {
    for (const flag of [
      '--disallowedTools',
      '--disallowed-tools',
      '--allowedTools',
      '--strict-mcp-config',
      '--settings',
      '--permission-mode',
      '--permission-prompts',
      '--permission-prompt-tool',
    ]) {
      expect(isAutoApplicable([add(`/vendors/claude/flagMap/${flag}`, '--renamed')]), flag).toBe(false)
      expect(isSafetyFlag(flag), flag).toBe(true)
    }
    expect(isAutoApplicable([add('/vendors/claude/flagMap/--model', '--model-name')])).toBe(true)
    expect(isAutoApplicable([add('/vendors/claude/flagMap/--output-format', '--format')])).toBe(true)
    expect(isSafetyFlag('--model')).toBe(false)
  })
})

describe('applyJsonPatch', () => {
  it('applies add / replace / remove / test without touching its input', () => {
    const doc = { a: { b: [1, 2] }, c: 'x' }
    const out = applyJsonPatch(doc, [
      { op: 'add', path: '/a/b/-', value: 3 },
      { op: 'add', path: '/a/b/0', value: 0 },
      { op: 'replace', path: '/c', value: 'y' },
      { op: 'remove', path: '/a/b/1' },
      { op: 'test', path: '/c', value: 'y' },
      { op: 'add', path: '/d', value: { e: 1 } },
    ])
    expect(out).toEqual({ a: { b: [0, 2, 3] }, c: 'y', d: { e: 1 } })
    expect(doc).toEqual({ a: { b: [1, 2] }, c: 'x' })
    for (const ops of [
      [{ op: 'replace', path: '/missing', value: 1 }],
      [{ op: 'add', path: '/x/y', value: 1 }],
      [{ op: 'remove', path: '/a/b/9' }],
      [{ op: 'test', path: '/c', value: 'z' }],
      [{ op: 'add', path: '/__proto__/x', value: 1 }],
    ] as JsonPatchOp[][]) {
      expect(() => applyJsonPatch(doc, ops), JSON.stringify(ops)).toThrow(DimFactoryError)
    }
  })
})
