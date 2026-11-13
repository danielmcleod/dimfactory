// Dim Factory's own play-test as a Verify command: discovery adds "Play-test (Dim Factory)" only when the folder has a
// playtest.json; it needs no trust grant and resolves as built in; a round runs it through the play-tester it is given
// (never spawned) and only must scenarios decide it; without a play-tester (the command-line tool) it is "not checked
// here", never a finding; a missing playtest.json is skipped, a broken one fails; the verify section and the
// findings name each scenario as passed or failed.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homePaths } from '../../../src/core/home.ts'
import { detectVerifyCommands } from '../../../src/core/verify/detect.ts'
import { discoverCommands, playtestCommand } from '../../../src/core/verify/discover.ts'
import { PLAYTEST_NOT_HERE, PLAYTEST_NO_FILE } from '../../../src/core/verify/playtest.ts'
import type { Playtester } from '../../../src/core/verify/playtest.ts'
import {
  renderVerifySection,
  verifyFindings,
  verifyHasMustFailures,
} from '../../../src/core/verify/render.ts'
import { runVerifyRound } from '../../../src/core/verify/run.ts'
import { trustOf } from '../../../src/core/verify/trust.ts'
import type { PlaytestReport, PlaytestScenarioResult } from '../../../src/shared/playtest.ts'
import { BUILTIN_COMMAND_PATH, PLAYTEST_ARGV, PLAYTEST_COMMAND_NAME } from '../../../src/shared/playtest.ts'
import { pkg, removeDir, tempDir, writeFiles } from './helpers.ts'

let folder = ''
let home = ''
beforeEach(() => {
  folder = tempDir('dim-factory-playtest-')
  home = tempDir('dim-factory-playtest-home-')
})
afterEach(() => {
  removeDir(folder)
  removeDir(home)
})

const SPEC = JSON.stringify({
  version: 1,
  scenarios: [
    { name: 'Space starts the game', steps: [{ key: 'Space' }, { expect: 'scene', eq: 'playing' }] },
    { name: 'Arrow keys steer', steps: [{ hold: 'ArrowDown', ms: 200 }] },
    { name: 'Looks nice', must: false, steps: [] },
  ],
})

const scenario = (
  name: string,
  status: PlaytestScenarioResult['status'],
  must = true,
): PlaytestScenarioResult => ({
  name,
  must,
  status,
  durationMs: 10,
  screenshots: [],
  ...(status !== 'pass'
    ? {
        failure: {
          step: 2,
          what: 'scene eq "playing"',
          message: 'expected scene to be "playing", got "title"',
        },
      }
    : {}),
})

const report = (
  scenarios: PlaytestScenarioResult[],
  extra: Partial<PlaytestReport> = {},
): PlaytestReport => ({
  url: 'http://127.0.0.1:5000/',
  loaded: true,
  hook: true,
  scenarios,
  checks: [{ id: 'canvas', status: 'pass', title: 'The canvas shows something' }],
  measures: {},
  consoleErrors: [],
  failedLoads: [],
  blocked: [],
  durationMs: 1000,
  ...extra,
})

const round = (playtest?: Playtester) =>
  runVerifyRound(
    {
      paths: homePaths(home),
      pathEnv: '',
      grants: () => Promise.resolve({}),
      ...(playtest !== undefined ? { playtest } : {}),
    },
    {
      runId: '20261026T120000Z-play',
      round: 'verify:1',
      folder,
      commands: [{ name: PLAYTEST_COMMAND_NAME, run: [...PLAYTEST_ARGV], cwdRel: '.' }],
      failFast: false,
    },
  )

describe('discovery', () => {
  it('adds the play-test only when the folder has a playtest.json', async () => {
    writeFiles(folder, { 'package.json': pkg({ test: 'node --test' }), 'index.html': '<canvas></canvas>' })
    expect((await discoverCommands(folder)).map((c) => c.name)).toEqual(['test'])
    expect(await playtestCommand(folder, '.')).toBeNull()
    writeFiles(folder, { 'playtest.json': SPEC })
    const found = await discoverCommands(folder)
    expect(found.map((c) => c.name)).toEqual(['test', PLAYTEST_COMMAND_NAME])
    const p = found.find((c) => c.name === PLAYTEST_COMMAND_NAME)
    expect(p).toMatchObject({
      run: [...PLAYTEST_ARGV],
      source: 'dimfactory',
      kind: 'test',
      body: null,
      enabledByDefault: true,
    })
  })

  it('needs no trust grant and resolves as built in (Settings shows it trusted)', async () => {
    writeFiles(folder, { 'playtest.json': SPEC })
    const c = { run: [...PLAYTEST_ARGV], cwdRel: '.' }
    expect(trustOf(c, null, {}).trust).toBe('trusted')
    const listed = await detectVerifyCommands({ folder, configured: [], grants: {}, pathEntries: [] })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      name: PLAYTEST_COMMAND_NAME,
      trust: 'trusted',
      trusted: true,
      resolved: BUILTIN_COMMAND_PATH,
    })
  })
})

describe('a verify round', () => {
  it('passes when every must scenario passes (a non-must failure is only reported)', async () => {
    writeFiles(folder, { 'playtest.json': SPEC })
    let asked: unknown = null
    const r = await round((req) => {
      asked = req.spec.scenarios.map((s) => s.name)
      return Promise.resolve({
        kind: 'report',
        report: report([
          scenario('Space starts the game', 'pass'),
          scenario('Arrow keys steer', 'pass'),
          scenario('Looks nice', 'fail', false),
        ]),
      })
    })
    expect(asked).toEqual(['Space starts the game', 'Arrow keys steer', 'Looks nice'])
    const res = r.results[0]!
    expect(res.status).toBe('pass')
    expect(res.scenarios?.map((s) => `${s.status} ${s.name}`)).toEqual([
      'pass Space starts the game',
      'pass Arrow keys steer',
      'fail Looks nice',
    ])
    expect(verifyHasMustFailures(r.results)).toBe(false)
    const log = readFileSync(res.logPath, 'utf8')
    expect(log).toContain('PASS  Space starts the game')
    expect(log).toContain('FAIL  Looks nice (not required)')
    expect(log).toContain('check canvas: ok')
    const section = renderVerifySection(r.results)
    expect(section).toContain(`- PASS \`${PLAYTEST_COMMAND_NAME}\``)
    expect(section).toContain('  - passed: Space starts the game')
    expect(section).toContain('  - failed: Looks nice (not required)')
  })

  it('fails when a must scenario fails: a [must] finding naming it, for Fix', async () => {
    writeFiles(folder, { 'playtest.json': SPEC })
    const r = await round(() =>
      Promise.resolve({
        kind: 'report',
        report: report([
          scenario('Space starts the game', 'fail'),
          scenario('Arrow keys steer', 'pass'),
          scenario('Looks nice', 'pass', false),
        ]),
      }),
    )
    const res = r.results[0]!
    expect(res.status).toBe('fail')
    expect(res.reason).toBe('1 of 2 must scenarios did not pass: Space starts the game')
    expect(res.excerpt).toContain(
      'FAIL  Space starts the game: step 2 (scene eq "playing"): expected scene to be "playing", got "title"',
    )
    expect(res.excerpt).not.toContain('PASS ')
    const findings = verifyFindings(r.results)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'must', source: 'verify' })
    expect(findings[0]!.title).toBe(`\`${PLAYTEST_COMMAND_NAME}\` failed (1 of 2 must scenarios failed, 0s)`)
    expect(findings[0]!.body).toContain('Space starts the game')
    expect(verifyHasMustFailures(r.results)).toBe(true)
    expect(renderVerifySection(r.results)).toContain('  - failed: Space starts the game: step 2')
  })

  it('a game that did not load fails; an error scenario counts as not passed', async () => {
    writeFiles(folder, { 'playtest.json': SPEC })
    const r = await round(() =>
      Promise.resolve({
        kind: 'report',
        report: report([], { loaded: false, error: 'The page did not load' }),
      }),
    )
    expect(r.results[0]).toMatchObject({ status: 'fail', reason: 'The page did not load' })
    const r2 = await round(() =>
      Promise.resolve({
        kind: 'report',
        report: report([scenario('Space starts the game', 'error'), scenario('Arrow keys steer', 'pass')]),
      }),
    )
    expect(r2.results[0]!.status).toBe('fail')
  })

  it('without a play-tester (the command-line tool): not checked here, never a finding', async () => {
    writeFiles(folder, { 'playtest.json': SPEC })
    const r = await round()
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: PLAYTEST_NOT_HERE })
    expect(PLAYTEST_NOT_HERE).toMatch(/^Not checked here/)
    expect(verifyFindings(r.results)).toEqual([])
    expect(renderVerifySection(r.results)).toContain(
      `- NOT RUN \`${PLAYTEST_COMMAND_NAME}\` (${PLAYTEST_NOT_HERE})`,
    )
  })

  it('no playtest.json yet: skipped; a broken one fails (Fix repairs it); a skip from the play-tester is kept', async () => {
    const never: Playtester = () => {
      throw new Error('should not play')
    }
    expect((await round(never)).results[0]).toMatchObject({ status: 'skipped', reason: PLAYTEST_NO_FILE })
    writeFiles(folder, { 'playtest.json': '{"version":1,"scenarios":[{"name":"x","steps":[{"eval":"1"}]}]}' })
    const bad = (await round(never)).results[0]!
    expect(bad.status).toBe('fail')
    expect(bad.excerpt).toMatch(/playtest.json does not fit its format/)
    writeFiles(folder, { 'playtest.json': SPEC })
    const skip = (
      await round(() => Promise.resolve({ kind: 'skipped', reason: 'There is no index.html to play' }))
    ).results[0]!
    expect(skip).toMatchObject({ status: 'skipped', reason: 'There is no index.html to play' })
  })

  it('a play-tester that throws is a failed check with its message', async () => {
    writeFiles(folder, { 'playtest.json': SPEC })
    const r = await round(() => {
      throw new Error('the window crashed')
    })
    expect(r.results[0]).toMatchObject({ status: 'fail', reason: 'the window crashed' })
  })
})
