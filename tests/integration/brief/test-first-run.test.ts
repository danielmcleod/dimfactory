// Test-first through a real core (the fake Claude for the passes, real node scripts as the verify command in a temp
// git sandbox):
//   - red then green: the Tests step writes a failing test, the red check fails as expected (no finding), Implement
//     makes it pass, verify:1 is green, the run is clean; resolved.json records the brief, {{brief}} and the Tests
//     step's template; the prompts carry the brief, the tests and how they failed
//   - weakened tests: Implement loosens the test so verify passes; the tests check makes it a [must] (source tests)
//   - a brief that does not fit its category is refused (VALIDATION); Test-first without Verify is blocked by preflight
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BriefInput } from '../../../src/shared/brief.ts'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import { stdinByScript } from '../run/scenario.ts'
import type { Scenario } from '../run/scenario.ts'
import { VerifyWorld, settled, value } from '../verify/helpers.ts'

const world = new VerifyWorld()
afterEach(async () => world.dispose())

/** Runs every `*.test.mjs` in tdd-tests/ (importing it runs its assertions); exit 1 when one throws. */
const RUN_TESTS = [
  "import { existsSync, readdirSync } from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  "const dir = 'tdd-tests'",
  "const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')) : []",
  'let failed = 0',
  'for (const f of files) {',
  '  try {',
  "    await import(pathToFileURL(dir + '/' + f).href)",
  "    console.log('ok ' + f)",
  '  } catch (e) {',
  '    failed++',
  "    console.error('FAIL ' + f + ': ' + (e instanceof Error ? e.message : String(e)))",
  '  }',
  '}',
  "if (files.length === 0) console.log('no tests')",
  'process.exit(failed > 0 ? 1 : 0)',
].join('\n')

const TEST_FILE = {
  path: 'tdd-tests/version.test.mjs',
  content: [
    "import assert from 'node:assert'",
    "import { readFileSync } from 'node:fs'",
    "let v = ''",
    "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
    "assert.ok(v.includes('1.0.0'), 'expected version 1.0.0')",
    "assert.ok(v.includes('export'), 'expected an export')",
    '',
  ].join('\n'),
}
/** The same file with its assertions gone: it passes whatever src/version.ts says. */
const WEAKENED = {
  path: TEST_FILE.path,
  content: "import { readFileSync } from 'node:fs'\nconsole.log('checked')\n",
}
const VERSION = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }

const RUN_CMD = { name: 'tests', run: ['node', 'run-tests.mjs'] }
const TEST_FIRST: BriefInput = {
  category: 'software',
  fields: {
    approach: { choices: ['test-first'], source: 'user' },
    quality: { choices: ['accessible'], source: 'user' },
  },
}

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

const overrides = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  verify: { enabled: true, commands: [RUN_CMD], runAfter: [] },
}

describe('Test-first (core + fake Claude + real commands)', () => {
  it('red then green: the tests fail first, Implement makes them pass, the run is clean', async () => {
    const w = await world.setup(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [
          {
            recording: 'C08a-session-id-implement',
            write: TEST_FILE,
            text: 'Wrote tdd-tests/version.test.mjs',
          },
          { recording: 'C08a-session-id-implement', write: VERSION },
        ],
      },
      { 'run-tests.mjs': RUN_TESTS },
    )
    await world.trust(w.home, w.folder, ['node', 'run-tests.mjs'])
    const { core, events } = await world.boot(w.home)
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a version constant',
        overrides,
        brief: TEST_FIRST,
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.outcome).toBe('clean')

    const snap = value(await core.invoke('runs.get', { runId }))
    expect(snap.steps.tests).toMatchObject({ status: 'done', attempt: 1 })
    expect(snap.steps.tests.testFirst).toEqual({ files: ['tdd-tests/version.test.mjs'], guard: 'ok' })
    // Red: the new test failed before Implement, and that is no finding.
    expect(snap.steps['verify:red'].verify?.commands).toEqual([
      expect.objectContaining({ name: 'tests', status: 'fail', exitCode: 1 }),
    ])
    expect(snap.steps['verify:red'].verify?.commands[0]?.excerpt).toContain('expected version 1.0.0')
    // Green after Implement (verify:1 runs with Test-first even with runAfter empty).
    expect(snap.steps['verify:1'].verify?.commands).toEqual([
      expect.objectContaining({ name: 'tests', status: 'pass', exitCode: 0 }),
    ])
    expect(snap.summary.findings).toEqual({ must: 0, should: 0 })
    expect(done.notes.some((n) => n.includes('fail before Implement'))).toBe(true)
    // The steps ran in order: plan, tests, implement (and the timeline order).
    const order = events
      .filter((e) => e.runId === runId && e.body.t === 'step-status' && e.body.status === 'running')
      .map((e) => (e.body.t === 'step-status' ? e.body.step : ''))
    expect([...new Set(order)]).toEqual([
      'preflight',
      'plan',
      'tests',
      'verify:red',
      'implement',
      'verify:1',
      'review',
      'critic',
    ])

    // resolved.json records the brief, its rendering and the Tests step's template.
    const resolved = JSON.parse(readFileSync(join(w.home, 'runs', runId, 'resolved.json'), 'utf8')) as {
      brief?: { input: BriefInput; text: string; testFirst: boolean; pack: { id: string } }
      testsTemplate?: { name: string; layer: string }
    }
    expect(resolved.brief).toMatchObject({ testFirst: true, pack: { id: 'software' } })
    expect(resolved.brief?.input.fields['quality']).toEqual({ choices: ['accessible'], source: 'user' })
    expect(resolved.brief?.text).toContain('- Quality bar: Accessible (WCAG AA)')
    expect(resolved.testsTemplate).toMatchObject({ name: 'tests', layer: 'builtin' })

    // The prompts: the Tests step got the brief and the checks; Implement the tests and how they failed.
    const tests = sent(w.sc, 'implement-1.script.jsonl')
    expect(tests).toContain('You are the Tests step')
    expect(tests).toContain('Accessible (WCAG AA)')
    expect(tests).toContain('- tests: `node run-tests.mjs`')
    const impl = sent(w.sc, 'implement-2.script.jsonl')
    expect(impl).toContain('Tests written first')
    expect(impl).toContain('- tdd-tests/version.test.mjs')
    expect(impl).toContain('- FAIL `node run-tests.mjs`')
    expect(sent(w.sc, 'review-default.script.jsonl')).toContain('none was weakened')
  }, 180_000)

  it('weakened tests: Implement loosens the test, verify passes, and the tests check is a [must]', async () => {
    const w = await world.setup(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [
          { recording: 'C08a-session-id-implement', write: TEST_FILE },
          { recording: 'C08a-session-id-implement', write: WEAKENED },
        ],
        resume: [{ recording: 'C08b-resume-fix', write: TEST_FILE, text: 'F1 disputed: kept' }],
      },
      { 'run-tests.mjs': RUN_TESTS },
    )
    await world.trust(w.home, w.folder, ['node', 'run-tests.mjs'])
    const t = await world.boot(w.home)
    const { runId } = value(
      await t.core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a version',
        overrides,
        brief: TEST_FIRST,
      }),
    )
    const c = t.core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor(settled, 150_000)
    await c.settle(15_000)
    expect(done.status).toBe('completed')
    const ff = JSON.parse(readFileSync(join(w.home, 'runs', runId, 'findings.json'), 'utf8')) as FindingsFile
    expect(ff.findings).toEqual([expect.objectContaining({ n: 1, severity: 'must', source: 'tests' })])
    expect(ff.findings[0]?.title).toContain('`tdd-tests/version.test.mjs` was weakened')
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.tests.testFirst).toMatchObject({ guard: 'weakened', weakened: 1 })
  }, 240_000)

  it('refuses a brief that does not fit its category; Test-first without Verify is blocked', async () => {
    const w = await world.setup({ plan: { recording: 'C06-plan-native-host' } }, {})
    const { core } = await world.boot(w.home)
    const bad = await core.invoke('runs.start', {
      folder: w.folder,
      task: 't',
      brief: { category: 'software', fields: { styling: { choices: ['velvet'] } } },
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatchObject({ code: 'VALIDATION' })
    const blocked = await core.invoke('runs.start', {
      folder: w.folder,
      task: 't',
      overrides: { profile: 'claude-only', verify: { enabled: false } },
      brief: TEST_FIRST,
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.error.code).toBe('PREFLIGHT_BLOCKED')
      expect(blocked.error.message).toContain('Test-first needs Verify')
    }
    // The live check says so too, and the estimate plans the Tests step.
    const live = value(
      await core.invoke('preflight.run', {
        folder: w.folder,
        overrides: { profile: 'claude-only', verify: { enabled: false } },
        brief: TEST_FIRST,
      }),
    )
    expect(live.blocking.map((x) => x.id)).toContain('run.testFirst')
    const est = value(
      await core.invoke('estimates.get', {
        folder: w.folder,
        overrides: { profile: 'claude-only', verify: { enabled: true, commands: [RUN_CMD] } },
        brief: TEST_FIRST,
      }),
    )
    expect(Object.keys(est.steps)).toEqual(expect.arrayContaining(['tests', 'verify:red', 'verify:1']))
  }, 120_000)
})
