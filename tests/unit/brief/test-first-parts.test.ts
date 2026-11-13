// Test-first's parts outside the state machine:
//   - the guard (testfirst/guard.ts): deleted test files, removed tests or assertions and added skips are [must];
//     untouched or strengthened tests, non-test files and commented-out code are not
//   - templates: {{brief}} is allowed in plan, implement, review, critic and fix (and tests); {{tests}} in implement,
//     review, critic and fix; the tests template takes {{checks}}; the default tests.md validates
//   - prompts: {{brief}} reaches every pass; the Tests step gets the plan and the checks; Implement, the readers and
//     Fix get the test files and the red check; the readers and Fix also get the guard's verdict
//   - preflight run.testFirst: Verify off or without commands blocks (Settings, never a config patch); with a command
//     it passes; it does not apply without Test-first
//   - estimates: the Tests step and its red check join the run total; verify:1 is planned with Test-first
//   - the CLI's --brief / --test-first
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig, VerifyCommandConfig } from '@shared/config-schema.ts'
import type { CheckResult, PreflightReport } from '@shared/preflight.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { trustGrantsFor } from '@core/config/trust.ts'
import { plannedSteps } from '@core/estimates/estimate.ts'
import { createPreflightEngine } from '@core/preflight/engine.ts'
import { readBuiltinTemplate } from '@core/prompts/resolve.ts'
import { TEMPLATE_SPECS, validateTemplate } from '@core/prompts/template.ts'
import { buildPrompt, checksText, testsSection } from '@core/supervisor/effects.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { isTestPath, testCounts, weakenedTests } from '@core/testfirst/guard.ts'
import { briefFromArgs } from '../../../src/cli/commands/run.ts'
import { healthyChecks, healthyDeps, probeResult } from '../preflight/helpers.ts'
import { result, trusted, VFlow } from '../verify/machine-helpers.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dim-factory-test-first-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// ---- the guard ----------------------------------------------------------------------------------------------------

const JS_TEST = [
  "import { expect, it } from 'vitest'",
  "it('prints the version', () => {",
  "  expect(run('--version')).toBe('1.0.0')",
  '  expect(code).toBe(0)',
  '})',
  "it('prints help', () => {",
  "  expect(run('--help')).toContain('Usage')",
  '})',
].join('\n')

describe('weakenedTests', () => {
  it('counts tests, assertions and skips across frameworks, ignoring comments', () => {
    expect(testCounts(JS_TEST)).toEqual({ assertions: 3, tests: 2, skips: 0 })
    expect(testCounts("it.skip('x', () => {})\nxit('y', () => {})\ntest.todo('z')")).toMatchObject({
      skips: 3,
    })
    expect(
      testCounts('def test_a():\n    assert f() == 1\n\n@pytest.mark.skip\ndef test_b():\n    pass'),
    ).toEqual({
      assertions: 1,
      tests: 2,
      skips: 1,
    })
    expect(
      testCounts('func TestA(t *testing.T) {\n\tif f() != 1 { t.Errorf("bad") }\n\tt.Skip("later")\n}'),
    ).toEqual({
      assertions: 1,
      tests: 1,
      skips: 1,
    })
    expect(testCounts('#[test]\nfn a() { assert_eq!(f(), 1); }\n#[ignore]\n#[test]\nfn b() {}')).toEqual({
      assertions: 1,
      tests: 2,
      skips: 1,
    })
    expect(testCounts('// expect(x).toBe(1)\n/* expect(y).toBe(2) */')).toMatchObject({ assertions: 0 })
  })

  it('a deleted, weakened or skipped test file is a [must]; untouched, stronger and non-test files are not', () => {
    const weaker = JS_TEST.replace('  expect(code).toBe(0)\n', '')
    const skipped = JS_TEST.replace("it('prints help'", "it.skip('prints help'")
    const fewer = JS_TEST.split("it('prints help'")[0] ?? ''
    const stronger = `${JS_TEST}\nit('more', () => { expect(1).toBe(1) })`
    const out = weakenedTests([
      { path: 'test/a.test.ts', before: JS_TEST, after: null },
      { path: 'test/b.test.ts', before: JS_TEST, after: weaker },
      { path: 'test/c.test.ts', before: JS_TEST, after: skipped },
      { path: 'test/d.test.ts', before: JS_TEST, after: fewer },
      { path: 'test/e.test.ts', before: JS_TEST, after: JS_TEST },
      { path: 'test/f.test.ts', before: JS_TEST, after: stronger },
      { path: 'src/version.ts', before: 'export const v = 0', after: null },
      { path: 'test/new.test.ts', before: null, after: JS_TEST },
    ])
    expect(out.map((f) => f.title)).toEqual([
      '`test/a.test.ts` was deleted after the Tests step wrote it',
      '`test/b.test.ts` was weakened after the Tests step wrote it: 1 assertion removed',
      '`test/c.test.ts` was weakened after the Tests step wrote it: 1 skip added',
      '`test/d.test.ts` was weakened after the Tests step wrote it: 1 test removed, 1 assertion removed',
    ])
    expect(out.every((f) => f.severity === 'must')).toBe(true)
    expect(new Set(out.map((f) => f.id)).size).toBe(out.length)
  })

  it('knows test files by name or folder', () => {
    for (const p of [
      'test/a.ts',
      'src/__tests__/a.tsx',
      'a.test.mjs',
      'pkg/a_test.go',
      'tests/test_a.py',
      'AppTests.cs',
    ])
      expect(isTestPath(p), p).toBe(true)
    for (const p of ['src/version.ts', 'docs/testing.md', 'contest.ts']) expect(isTestPath(p), p).toBe(false)
  })
})

// ---- templates and prompts ----------------------------------------------------------------------------------------

describe('templates', () => {
  it('{{brief}} and {{tests}} are allowed where the passes use them; the tests template takes {{checks}}', () => {
    for (const k of ['plan', 'implement', 'review', 'critic', 'fix', 'tests'] as const)
      expect(TEMPLATE_SPECS[k].allowed, k).toContain('brief')
    for (const k of ['implement', 'review', 'critic', 'fix'] as const)
      expect(TEMPLATE_SPECS[k].allowed, k).toContain('tests')
    expect(TEMPLATE_SPECS.plan.allowed).not.toContain('tests')
    expect(TEMPLATE_SPECS.tests).toMatchObject({
      required: ['task'],
      requiredWhenPlan: ['plan'],
      internal: false,
    })
    expect(validateTemplate('{{task}} {{checks}} {{diff}}', 'tests').issues[0]).toMatchObject({
      code: 'unknown-placeholder',
      name: 'diff',
    })
    expect(validateTemplate('{{task}}\n{{#brief}}\n{{brief}}\n{{/brief}}', 'plan').ok).toBe(true)
    expect(validateTemplate('{{task}} {{tests}}', 'plan').ok).toBe(false)
    expect(TEMPLATE_SPECS.suggest.internal).toBe(true)
  })

  it('the default tests.md validates and uses every placeholder its step takes', () => {
    const v = validateTemplate(readBuiltinTemplate('tests'), 'tests', { planEnabled: true })
    expect(v.issues).toEqual([])
    expect([...v.placeholders].sort()).toEqual(['acceptance', 'brief', 'checks', 'memory', 'plan', 'task'])
    for (const k of ['plan', 'implement', 'review', 'critic', 'fix'] as const)
      expect(readBuiltinTemplate(k), k).toContain('{{#brief}}')
  })
})

const cfg = (verify: VerifyCommandConfig[] = [{ name: 'test', run: ['npm', 'test'] }]): ResolvedConfig =>
  resolveBuiltinConfig({ profile: 'claude-only', overrides: { verify: { enabled: true, commands: verify } } })

const BRIEF = 'Category: Software\n\nChosen for this run:\n- Styling: Tailwind'

/** A Test-first run that reached S1 with its files, red check and guard (as the machine leaves them). */
function testFirstState(guard: 'ok' | 'weakened'): RunState {
  const f = new VFlow({ review: true, critic: true, fix: true })
  f.toVerified(result('test', 'pass'))
  const s = structuredClone(f.state)
  s.config.testFirst = true
  s.brief = BRIEF
  s.steps.tests.status = 'done'
  s.steps.tests.attempt = 1
  s.steps['verify:red'].status = 'done'
  s.steps['verify:red'].verify = {
    phase: 'done',
    commands: [
      {
        ...trusted('test'),
        decision: 'run',
        status: 'fail',
        exitCode: 1,
        durationMs: 2000,
        excerpt: 'FAIL test/version.test.ts\n  expected 1.0.0',
      },
    ],
  }
  s.testFirst = {
    files: ['test/version.test.ts'],
    guard,
    ...(guard === 'weakened'
      ? {
          findings: [
            {
              id: 'w1',
              n: 0,
              severity: 'must',
              source: 'tests',
              title: '`test/version.test.ts` was weakened after the Tests step wrote it: 1 skip added',
              body: '',
              flags: [],
              round: 1,
            },
          ],
        }
      : {}),
  }
  return s
}

describe('prompts', () => {
  it('{{brief}} reaches every pass; without a brief the section drops out', () => {
    const s = testFirstState('ok')
    for (const step of ['plan', 'implement', 'review', 'critic', 'fix', 'tests'] as const) {
      const text = buildPrompt(s, cfg(), { step, launch: { fresh: {} } }, { diff: 'D' }).text
      expect(text, step).toContain('- Styling: Tailwind')
    }
    const plan = buildPrompt(s, cfg(), { step: 'plan', launch: { fresh: {} } }).text
    expect(plan).toContain('## Decisions')
    const none: RunState = structuredClone(s)
    delete none.brief
    expect(buildPrompt(none, cfg(), { step: 'plan', launch: { fresh: {} } }).text).not.toContain(
      'brief for this run',
    )
  })

  it('the Tests step gets the plan and the checks; Implement the tests and how they failed', () => {
    const s = testFirstState('ok')
    const tests = buildPrompt(s, cfg(), { step: 'tests', launch: { fresh: {} } }).text
    expect(tests).toContain('You are the Tests step')
    expect(tests).toContain('- test: `npm test`')
    expect(checksText(cfg([{ name: 'unit', run: 'node --test', cwd: 'pkg' }]))).toBe(
      '- unit: `node --test` (in pkg)',
    )
    const impl = buildPrompt(s, cfg(), { step: 'implement', launch: { fresh: {} } }).text
    expect(impl).toContain('Tests written first')
    expect(impl).toContain('- test/version.test.ts')
    expect(impl).toContain('- FAIL `npm run test`')
    expect(impl).not.toContain('Dim Factory compared')
  })

  it('the readers and Fix also get the guard verdict', () => {
    expect(testsSection(testFirstState('ok'), 'review')).toContain('none was weakened')
    const weak = testsSection(testFirstState('weakened'), 'critic')
    expect(weak).toContain('Dim Factory found test files weakened after Implement')
    expect(weak).toContain('1 skip added')
    const fix = buildPrompt(
      testFirstState('weakened'),
      cfg(),
      { step: 'fix', launch: { fresh: {} } },
      { diff: 'D' },
    )
    expect(fix.text).toContain('Keep them; do not weaken, skip or delete them')
    const off = testFirstState('ok')
    off.config = { ...off.config }
    delete off.config.testFirst
    expect(testsSection(off, 'implement')).toBe('')
  })
})

// ---- preflight run.testFirst ---------------------------------------------------------------------------------------

describe('preflight run.testFirst', () => {
  async function run(config: ResolvedConfig, testFirst: boolean): Promise<PreflightReport> {
    const folder = join(root, 'project')
    const home = join(root, 'home')
    mkdirSync(folder, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    const engine = createPreflightEngine(
      healthyDeps({
        home,
        platform: process.platform,
        trustGrants: (f) => trustGrantsFor(f, { home, folderScope: { scopeRoot: folder } }),
      }),
    )
    engine.recordProbe(probeResult('claude', 1_000_000, healthyChecks('claude', 1_000_000)))
    return engine.run('authoritative', { folder, config, ...(testFirst ? { testFirst: true } : {}) })
  }
  const tf = (r: PreflightReport): CheckResult | undefined =>
    [...r.blocking, ...r.warnings, ...r.info].find((c) => c.id === 'run.testFirst')

  it('blocks with Verify off or without commands, linking to Settings with what the project suggests', async () => {
    const off = await run(
      resolveBuiltinConfig({ profile: 'claude-only', overrides: { verify: { enabled: false } } }),
      true,
    )
    expect(off.ok).toBe(false)
    expect(tf(off)).toMatchObject({
      status: 'fail',
      title: 'Test-first needs Verify',
      category: 'config_invalid',
    })
    expect(tf(off)?.detail).toContain('test (')
    expect(tf(off)?.recovery).toEqual([
      expect.objectContaining({
        kind: 'settings_link',
        route: 'settings/isolation',
        pointer: '/verify/commands',
      }),
    ])
    const none = await run(cfg([]), true)
    expect(tf(none)).toMatchObject({ status: 'fail', title: 'Test-first needs a verify command' })
  })

  it('passes with a command, and does not apply without Test-first', async () => {
    const ok = await run(cfg([{ name: 'test', run: ['npm', 'test'] }]), true)
    expect(tf(ok)).toMatchObject({ status: 'pass' })
    const without = await run(
      resolveBuiltinConfig({ profile: 'claude-only', overrides: { verify: { enabled: false } } }),
      false,
    )
    expect(tf(without)).toBeUndefined()
  })
})

// ---- estimates and the CLI -----------------------------------------------------------------------------------------

describe('estimates', () => {
  it('plans the Tests step (on Implement’s config) and its red check, and verify:1, with Test-first', () => {
    const c = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { verify: { enabled: true, runAfter: [], commands: [{ name: 't', run: ['npm', 'test'] }] } },
    })
    expect(plannedSteps(c).map((q) => q.key)).not.toContain('tests')
    const keys = plannedSteps({ ...c, testFirst: true }).map((q) => q.key)
    expect(keys.slice(0, 5)).toEqual(['plan', 'tests', 'verify:red', 'implement', 'verify:1'])
    const tests = plannedSteps({ ...c, testFirst: true }).find((q) => q.key === 'tests')
    expect(tests).toMatchObject({ vendor: c.passes.implement.vendor, mode: c.passes.implement.mode })
  })
})

describe('dimf run --brief / --test-first', () => {
  it('reads a brief file, adds Test-first, and refuses a file that is not a brief', async () => {
    expect(await briefFromArgs(undefined, false, root)).toBeUndefined()
    expect(await briefFromArgs(undefined, true, root)).toEqual({
      category: 'software',
      fields: { approach: { choices: ['test-first'], source: 'user' } },
    })
    writeFileSync(
      join(root, 'b.json'),
      JSON.stringify({ category: 'software', fields: { approach: { choices: ['milestones'] } } }),
    )
    expect(await briefFromArgs('b.json', true, root)).toEqual({
      category: 'software',
      fields: { approach: { choices: ['milestones', 'test-first'], source: 'user' } },
    })
    writeFileSync(join(root, 'bad.json'), JSON.stringify({ category: 'Software!' }))
    await expect(briefFromArgs('bad.json', false, root)).rejects.toThrow(/is not a brief/)
  })
})
