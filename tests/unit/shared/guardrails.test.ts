import { describe, expect, it } from 'vitest'
import {
  GUARDRAIL_INFO,
  GuardrailRuleZ,
  GuardrailsZ,
  checkChanges,
  checkCommands,
  checkRunPlan,
  commandMatches,
  commandSegments,
  isTestFile,
  mergeGuardrails,
  onBreakOf,
  pathMatches,
  presetRules,
  rulesInForce,
  strengthAtLeast,
  suggestGuardrails,
  testRules,
} from '../../../src/shared/guardrails.ts'
import type { GuardrailRule, RunPlanFacts } from '../../../src/shared/guardrails.ts'

const facts = (o: Partial<RunPlanFacts> = {}): RunPlanFacts => ({
  vendors: ['claude'],
  fullAccess: false,
  isolated: false,
  extensionsInUse: [],
  ...o,
})

describe('path matching', () => {
  it.each([
    ['migrations/001.sql', 'migrations/**', true],
    ['db/migrations/001.sql', 'migrations/**', false],
    ['.env', '.env', true],
    ['app/.env', '.env', true],
    ['.env.local', '.env', false],
    ['.env.local', '.env*', true],
    ['src/a.ts', 'src/*.ts', true],
    ['src/deep/a.ts', 'src/*.ts', false],
    ['src/deep/a.ts', 'src/**/*.ts', true],
    ['src/a.ts', 'src/**/*.ts', true],
    ['secrets/key.pem', 'secrets', true],
    ['secretsfile', 'secrets', false],
    ['MIGRATIONS/1.sql', 'migrations/**', true],
    ['a+b.txt', 'a+b.txt', true],
    ['aab.txt', 'a+b.txt', false],
  ])('%s against %s: %s', (path, glob, want) => {
    expect(pathMatches(path, [glob]) !== undefined).toBe(want)
  })

  it('reads Windows separators and a leading ./', () => {
    expect(pathMatches('migrations\\001.sql', ['migrations/**'])).toBe('migrations/**')
    expect(pathMatches('./migrations/001.sql', ['./migrations/**'])).toBe('./migrations/**')
  })
})

describe('command matching', () => {
  it.each([
    ['git push', ['git', 'push'], true],
    ['git push origin main', ['git', 'push'], true],
    ['git -C ../x push', ['git', 'push'], true],
    ['npm test && git push', ['git', 'push'], true],
    ['echo hi; git push', ['git', 'push'], true],
    ['C:\\Program Files\\Git\\bin\\git.exe push', ['git', 'push'], false],
    ['"C:\\Program Files\\Git\\bin\\git.exe" push', ['git', 'push'], true],
    ['/usr/bin/git push', ['git', 'push'], true],
    ['git status', ['git', 'push'], false],
    ['echo git push', ['git', 'push'], false],
    ['git log --grep push', ['git', 'push'], true],
    ['rm -rf build', ['rm'], true],
  ] as const)('%s', (line, prefix, want) => {
    expect(commandMatches(line, prefix)).toBe(want)
  })

  it('does not see a command hidden in another shell, and the rule says so', () => {
    expect(commandMatches('sh -c "git push"', ['git', 'push'])).toBe(false)
    expect(GUARDRAIL_INFO.forbiddenCommand.limit).toMatch(/script/)
  })

  it('keeps a quoted separator inside its word', () => {
    expect(commandSegments('echo "a; b" | wc')).toEqual([['echo', 'a; b'], ['wc']])
  })
})

describe('layers only tighten', () => {
  const push: GuardrailRule = { kind: 'forbiddenCommand', argvPrefix: ['git', 'push'] }
  const migrations: GuardrailRule = { kind: 'protectedFiles', paths: ['migrations/**'] }

  it('a project cannot lower the preset', () => {
    expect(mergeGuardrails({ preset: 'strict' }, { preset: 'off' }).preset).toBe('strict')
    expect(mergeGuardrails({ preset: 'recommended' }, { preset: 'off' }).preset).toBe('recommended')
  })

  it('a project can raise the preset', () => {
    expect(mergeGuardrails({ preset: 'off' }, { preset: 'strict' }).preset).toBe('strict')
  })

  it('a project cannot remove a rule, and can add one', () => {
    const merged = mergeGuardrails({ rules: [push] }, { rules: [] })
    expect(merged.rules).toEqual([push])
    expect(mergeGuardrails({ rules: [push] }, { rules: [migrations] }).rules).toEqual([push, migrations])
  })

  it('counts the same rule once, however its keys are ordered', () => {
    const reordered = { argvPrefix: ['git', 'push'], kind: 'forbiddenCommand' } as GuardrailRule
    expect(mergeGuardrails({ rules: [push] }, { rules: [reordered] }).rules).toHaveLength(1)
  })

  it('lets only the user grant the settings exception', () => {
    expect(mergeGuardrails({ allowAgentSettings: true }).allowAgentSettings).toBe(true)
    expect(mergeGuardrails(undefined, { allowAgentSettings: true }).allowAgentSettings).toBeUndefined()
    expect(mergeGuardrails({}, { allowAgentSettings: true }).allowAgentSettings).toBeUndefined()
    expect(
      mergeGuardrails({ allowAgentSettings: true }, { allowAgentSettings: false }).allowAgentSettings,
    ).toBeUndefined()
  })

  it('is recommended when nothing sets it', () => {
    expect(mergeGuardrails().preset).toBe('recommended')
    expect(mergeGuardrails(undefined, {}).preset).toBe('recommended')
  })

  it('puts the preset and own rules together', () => {
    expect(rulesInForce({ preset: 'off', rules: [] })).toEqual([])
    const own = rulesInForce({ preset: 'recommended', rules: [push, migrations] })
    expect(own.filter((r) => r.kind === 'forbiddenCommand' && r.argvPrefix[1] === 'push')).toHaveLength(1)
    expect(own).toContainEqual(migrations)
  })
})

describe('what a pass changed', () => {
  it('undoes a change to settings files on every preset, even with no rules', () => {
    for (const path of [
      '.dimfactory/dimfactory.json',
      '.claude/settings.json',
      '.claude/hooks/a.sh',
      '.codex/config.toml',
      '.mcp.json',
    ]) {
      const [hit] = checkChanges([], [{ path, status: 'modified' }])
      expect(hit).toMatchObject({ self: true, onBreak: 'undo', subject: path })
    }
  })

  it('leaves instruction files and skills editable', () => {
    for (const path of ['CLAUDE.md', 'AGENTS.md', '.claude/skills/x/SKILL.md', '.claude/commands/y.md']) {
      expect(checkChanges([], [{ path, status: 'modified' }])).toEqual([])
    }
  })

  it('allows settings files only with the explicit exception', () => {
    const changes = [{ path: '.codex/config.toml', status: 'modified' }] as const
    expect(checkChanges([], changes, { allowAgentSettings: true })).toEqual([])
  })

  it('finds a protected file, and takes the rule’s own reaction', () => {
    const rule: GuardrailRule = { kind: 'protectedFiles', paths: ['migrations/**'], onBreak: 'ask' }
    const [hit, ...rest] = checkChanges(
      [rule],
      [
        { path: 'migrations/1.sql', status: 'modified' },
        { path: 'src/a.ts', status: 'modified' },
      ],
    )
    expect(rest).toEqual([])
    expect(hit).toMatchObject({ kind: 'protectedFiles', onBreak: 'ask', subject: 'migrations/1.sql' })
  })

  it('finds weakened tests', () => {
    const rule: GuardrailRule = { kind: 'testsNotWeakened' }
    expect(checkChanges([rule], [{ path: 'tests/a.test.ts', status: 'deleted' }])).toHaveLength(1)
    expect(
      checkChanges(
        [rule],
        [{ path: 'src/a.test.ts', status: 'modified', addedLines: ["  it.skip('x', () => {})"] }],
      ),
    ).toHaveLength(1)
    expect(
      checkChanges(
        [rule],
        [{ path: 'test_a.py', status: 'modified', addedLines: ['@pytest.mark.skip(reason="x")'] }],
      ),
    ).toHaveLength(1)
  })

  it('leaves ordinary test changes and non-test deletions alone', () => {
    const rule: GuardrailRule = { kind: 'testsNotWeakened' }
    expect(
      checkChanges(
        [rule],
        [{ path: 'src/a.test.ts', status: 'modified', addedLines: ["it('x', () => {})"] }],
      ),
    ).toEqual([])
    expect(checkChanges([rule], [{ path: 'src/old.ts', status: 'deleted' }])).toEqual([])
    expect(
      checkChanges([rule], [{ path: 'src/skip.ts', status: 'modified', addedLines: ['it.skip(x)'] }]),
    ).toEqual([])
  })

  it('recognizes test files across languages', () => {
    for (const p of [
      'tests/a.py',
      'src/__tests__/a.js',
      'a.spec.ts',
      'pkg/a_test.go',
      'test_a.py',
      'e2e/flow.ts',
    ]) {
      expect(isTestFile(p)).toBe(true)
    }
    for (const p of ['src/contest.ts', 'src/latest.go', 'testing.md']) expect(isTestFile(p)).toBe(false)
  })

  it('stops at a size limit', () => {
    const rule: GuardrailRule = { kind: 'maxChanges', files: 1, lines: 10 }
    const hits = checkChanges(
      [rule],
      [
        { path: 'a', status: 'modified', linesChanged: 8 },
        { path: 'b', status: 'modified', linesChanged: 8 },
      ],
    )
    expect(hits.map((h) => h.subject)).toEqual(['2 files', '16 lines'])
    expect(checkChanges([rule], [{ path: 'a', status: 'modified', linesChanged: 10 }])).toEqual([])
  })

  it('names each new dependency', () => {
    const hits = checkChanges([{ kind: 'newDependencies' }], [], {
      manifests: [{ path: 'package.json', before: ['react'], after: ['react', 'left-pad'] }],
    })
    expect(hits.map((h) => h.subject)).toEqual(['left-pad'])
    expect(hits[0]?.onBreak).toBe('ask')
  })
})

describe('commands a pass ran', () => {
  it('reports what the Recommended preset forbids, and says it already ran', () => {
    const hits = checkCommands(presetRules('recommended'), [
      'npm test',
      'git push origin main',
      'pnpm publish',
    ])
    expect(hits.map((h) => h.subject)).toEqual(['git push origin main', 'pnpm publish'])
    expect(hits[0]?.detail).toMatch(/already run/)
    expect(hits[0]?.onBreak).toBe('stop')
  })
})

describe('before a run starts', () => {
  it('refuses a vendor that is not allowed', () => {
    const rule: GuardrailRule = { kind: 'allowedVendors', vendors: ['claude'] }
    expect(checkRunPlan([rule], facts())).toEqual([])
    expect(checkRunPlan([rule], facts({ vendors: ['claude', 'codex'] }))[0]?.detail).toMatch(/codex/)
  })

  it('refuses Approve everything, a run in place, and extensions when ruled out', () => {
    expect(checkRunPlan([{ kind: 'noFullAccess' }], facts({ fullAccess: true }))).toHaveLength(1)
    expect(checkRunPlan([{ kind: 'noFullAccess' }], facts())).toEqual([])
    expect(checkRunPlan([{ kind: 'requireIsolated' }], facts())).toHaveLength(1)
    expect(checkRunPlan([{ kind: 'requireIsolated' }], facts({ isolated: true }))).toEqual([])
    expect(checkRunPlan([{ kind: 'noExtensions' }], facts({ extensionsInUse: ['implement'] }))).toHaveLength(
      1,
    )
  })

  it('refuses a rule that cannot reach the strength it requires, naming the vendor', () => {
    const rule: GuardrailRule = { kind: 'protectedFiles', paths: ['a'], require: 'blocked' }
    const [block] = checkRunPlan([rule], facts({ vendors: ['codex'] }))
    expect(block?.detail).toBe('You required this to be blocked. With codex it can only be caught.')
    expect(checkRunPlan([{ ...rule, require: 'caught' }], facts())).toEqual([])
  })

  it('blocks nothing on the Recommended preset', () => {
    expect(
      checkRunPlan(presetRules('recommended'), facts({ fullAccess: true, vendors: ['claude', 'codex'] })),
    ).toEqual([])
  })

  it('ranks strength', () => {
    expect(strengthAtLeast('hard', 'blocked')).toBe(true)
    expect(strengthAtLeast('caught', 'blocked')).toBe(false)
  })
})

describe('Test this rule', () => {
  const rules: GuardrailRule[] = [
    { kind: 'protectedFiles', paths: ['migrations/**'] },
    { kind: 'forbiddenCommand', argvPrefix: ['git', 'push'] },
  ]

  it('gives the same answer as the real check for a path', () => {
    const [r] = testRules(rules, { path: 'migrations/1.sql' })
    expect(r).toMatchObject({ applies: true, strength: 'caught' })
    expect(testRules(rules, { path: 'src/a.ts' })[0]?.applies).toBe(false)
  })

  it('reports self-protection for a settings file', () => {
    expect(testRules([], { path: '.claude/settings.json' })[0]).toMatchObject({
      rule: 'Settings files',
      applies: true,
    })
  })

  it('gives the same answer as the real check for a command, and says it runs first', () => {
    const [r] = testRules(rules, { command: 'git push' })
    expect(r?.applies).toBe(true)
    expect(r?.outcome).toMatch(/after it runs/)
  })
})

describe('suggestions', () => {
  it('offers rules from what is in the project, each with a reason', () => {
    const got = suggestGuardrails([
      'migrations/1.sql',
      '.github/workflows/ci.yml',
      'pnpm-lock.yaml',
      'infra/main.tf',
    ])
    expect(got.map((s) => s.rule.kind)).toEqual([
      'protectedFiles',
      'protectedFiles',
      'protectedFiles',
      'forbiddenCommand',
      'newDependencies',
    ])
    expect(got.every((s) => s.reason.length > 0)).toBe(true)
  })

  it('offers nothing for an empty project', () => {
    expect(suggestGuardrails(['README.md'])).toEqual([])
  })
})

describe('the catalog', () => {
  it('states a limit for every rule, in plain text with no em dash', () => {
    for (const info of Object.values(GUARDRAIL_INFO)) {
      expect(info.limit.length).toBeGreaterThan(0)
      expect(`${info.title}${info.stops}${info.limit}`).not.toMatch(/\u2014/)
    }
  })

  it('validates a rule file strictly', () => {
    expect(GuardrailRuleZ.safeParse({ kind: 'protectedFiles', paths: [] }).success).toBe(false)
    expect(GuardrailRuleZ.safeParse({ kind: 'maxChanges' }).success).toBe(false)
    expect(GuardrailRuleZ.safeParse({ kind: 'nope' }).success).toBe(false)
    expect(GuardrailRuleZ.safeParse({ kind: 'noFullAccess', extra: 1 }).success).toBe(false)
    expect(GuardrailsZ.safeParse({ preset: 'loose', rules: [] }).success).toBe(false)
  })

  it('takes a default reaction from the catalog', () => {
    expect(onBreakOf({ kind: 'protectedFiles', paths: ['a'] })).toBe('undo')
    expect(onBreakOf({ kind: 'newDependencies' })).toBe('ask')
  })
})
