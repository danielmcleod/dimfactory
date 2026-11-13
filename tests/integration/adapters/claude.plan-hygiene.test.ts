// Plan-file hygiene through the real adapter (Claude writes its own plan file): the fake CLI replays C06
// (ExitPlanMode capture) and C07 (final-message plan) while the test plays Claude's part of writing the plan file
// right after spawn. The adapter deletes this pass's own copy after the process exits and reports what it kept.
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClaudeAdapter } from '../../../src/core/adapters/claude/index.ts'
import type { ClaudeAdapter, ClaudeAdapterOptions } from '../../../src/core/adapters/claude/index.ts'
import { META_PLAN_FILES } from '../../../src/core/adapters/claude/plan-hygiene.ts'
import { parseFrame } from '../../../src/core/adapters/claude/protocol.ts'
import type { Entry, FakeSetup, Recording } from './helpers.ts'
import {
  drive,
  fakeSetup,
  hermeticEnv,
  loadRecording,
  startOptionsFor,
  tempDir,
  terminals,
} from './helpers.ts'

let setup: FakeSetup | undefined
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Every temp folder this file creates (homes, cwds, probe dirs), removed after the file. */
const made: string[] = []
function dir(prefix?: string): string {
  const d = tempDir(prefix)
  made.push(d)
  return d
}

beforeAll(async () => {
  setup = await fakeSetup()
})

afterAll(() => {
  // fakeSetup is memoized per test file (module isolation), so its scenario folder is this file's own.
  if (setup !== undefined) made.push(setup.scenarioDir)
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * helpers.ts `fakeAdapter`, with its home and probe folders made here (and tracked): the helper's defaults would
 * create untracked claude-home-* / claude-probe-* folders on every call.
 */
function fakeAdapter(s: FakeSetup, o: Pick<ClaudeAdapterOptions, 'home' | 'onSpawn'>): ClaudeAdapter {
  return createClaudeAdapter({
    configuredPath: s.launcher,
    pathEnv: s.pathEnv,
    probeCwd: dir('claude-probe-'),
    now: () => 0,
    env: hermeticEnv(),
    ...o,
    vendorEnv: { FAKE_CLI_SCRIPT: s.scenarioDir },
  })
}

function fake(): FakeSetup {
  if (setup === undefined) throw new Error('fakeSetup did not run')
  return setup
}

/** ExitPlanMode's input in a recording (C06: `plan` and a `~`-relative `planFilePath`). */
function exitPlanInput(rec: Recording): { plan: string; planFilePath: string } {
  for (const f of rec.frames) {
    if (f.dir !== 'out' || f.line === undefined) continue
    const v = parseFrame(f.line)
    const req = v?.['request'] as
      { tool_name?: string; input?: { plan: string; planFilePath: string } } | undefined
    if (v?.['type'] === 'control_request' && req?.tool_name === 'ExitPlanMode' && req.input) return req.input
  }
  throw new Error(`${rec.id}: no ExitPlanMode ask`)
}

function finalResult(rec: Recording): string {
  for (const f of rec.frames) {
    const v = f.dir === 'out' && f.line !== undefined ? parseFrame(f.line) : undefined
    if (v?.['type'] === 'result' && typeof v['result'] === 'string') return v['result']
  }
  throw new Error(`${rec.id}: no result text`)
}

const notes = (entries: readonly Entry[]): unknown[] =>
  entries.flatMap((e) => (e.type === 'meta' && e.key === META_PLAN_FILES ? [e.value] : []))

/** Replays `rec` as a native plan pass; `onSpawn` writes files the way Claude would during the pass. */
async function planPass(
  rec: Recording,
  home: string,
  write: (plansDir: string) => void,
  env: Record<string, string> = {},
): Promise<Entry[]> {
  const adapter = fakeAdapter(fake(), {
    home,
    // After spawn, like Claude (seconds into a real pass); the pause keeps mtimes clear of the spawn time even
    // where file timestamps are coarser than Date.now().
    onSpawn: async () => {
      await sleep(50)
      write(join(home, '.claude', 'plans'))
    },
  })
  const o = startOptionsFor(rec, { cwd: dir(), env: { FAKE_CLI_SCRIPT: rec.path, ...env } })
  expect(o).toMatchObject({ step: 'plan', planNative: true })
  const { entries } = await drive(adapter, o, rec.decisions)
  expect(terminals(entries)).toMatchObject([{ type: 'done' }])
  return entries
}

describe('claude adapter: plan-file hygiene', () => {
  it('C06: deletes the ExitPlanMode plan file it captured, after exit', async () => {
    const rec = loadRecording('C06-plan-native-host')
    const { plan, planFilePath } = exitPlanInput(rec)
    const home = dir('claude-home-')
    const name = planFilePath.split(/[\\/]/).pop()!
    let file = ''
    const entries = await planPass(rec, home, (dir) => {
      mkdirSync(dir, { recursive: true })
      file = join(dir, name)
      writeFileSync(file, plan.replace(/\n/g, '\r\n'))
    })
    expect(existsSync(file)).toBe(false)
    expect(notes(entries)).toEqual([{ deleted: [`~/.claude/plans/${name}`], kept: [] }])
    // The note follows the done event: the pass outcome never waits on hygiene.
    const done = entries.findIndex((e) => e.type === 'done')
    const note = entries.findIndex((e) => e.type === 'meta' && e.key === META_PLAN_FILES)
    expect(note).toBeGreaterThan(done)
  })

  it('C06: keeps a plan file the user changed, or one older than the pass, and says so', async () => {
    const rec = loadRecording('C06-plan-native-host')
    const { plan, planFilePath } = exitPlanInput(rec)
    const name = planFilePath.split(/[\\/]/).pop()!

    const edited = dir('claude-home-')
    let file = ''
    const a = await planPass(rec, edited, (dir) => {
      mkdirSync(dir, { recursive: true })
      file = join(dir, name)
      writeFileSync(file, `${plan}\n\nMy own notes.\n`)
    })
    expect(readFileSync(file, 'utf8')).toContain('My own notes.')
    expect(notes(a)).toEqual([
      { deleted: [], kept: [{ path: `~/.claude/plans/${name}`, reason: 'content-differs' }] },
    ])

    const older = dir('claude-home-')
    const b = await planPass(rec, older, (dir) => {
      mkdirSync(dir, { recursive: true })
      file = join(dir, name)
      writeFileSync(file, plan)
      utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1))
    })
    expect(existsSync(file)).toBe(true)
    expect(notes(b)).toEqual([
      { deleted: [], kept: [{ path: `~/.claude/plans/${name}`, reason: 'older-than-pass' }] },
    ])
  })

  it('C06: a planFilePath outside ${CLAUDE_CONFIG_DIR}/plans is never deleted', async () => {
    const rec = loadRecording('C06-plan-native-host')
    const { plan, planFilePath } = exitPlanInput(rec)
    const home = dir('claude-home-')
    const name = planFilePath.split(/[\\/]/).pop()!
    let file = ''
    // The recording names ~/.claude/plans, but this pass's config dir is relocated.
    const entries = await planPass(
      rec,
      home,
      (dir) => {
        mkdirSync(dir, { recursive: true })
        file = join(dir, name)
        writeFileSync(file, plan)
      },
      { CLAUDE_CONFIG_DIR: join(home, 'relocated') },
    )
    expect(existsSync(file)).toBe(true)
    expect(notes(entries)).toMatchObject([{ deleted: [], kept: [{ reason: 'outside-plans-dir' }] }])
  })

  it('C07: a final-message plan deletes only new plan files with the same text', async () => {
    const rec = loadRecording('C07-plan-no-host')
    const text = finalResult(rec)
    const home = dir('claude-home-')
    const plans = join(home, '.claude', 'plans')
    mkdirSync(plans, { recursive: true })
    const yesterday = join(plans, 'plan-from-yesterday.md')
    writeFileSync(yesterday, text)
    utimesSync(yesterday, new Date(2020, 0, 1), new Date(2020, 0, 1))
    const entries = await planPass(rec, home, (dir) => {
      writeFileSync(join(dir, 'plan-declarative-fiddle.md'), `${text.trim()}\n`)
      writeFileSync(join(dir, 'plan-other-session.md'), '# Not this pass')
    })
    expect(existsSync(join(plans, 'plan-declarative-fiddle.md'))).toBe(false)
    expect(existsSync(join(plans, 'plan-other-session.md'))).toBe(true)
    expect(existsSync(yesterday)).toBe(true)
    expect(notes(entries)).toEqual([
      {
        deleted: ['~/.claude/plans/plan-declarative-fiddle.md'],
        kept: [{ path: '~/.claude/plans/plan-other-session.md', reason: 'content-differs' }],
      },
    ])
  })

  it('no plan files: no note (the recording replays exactly as normalized)', async () => {
    const rec = loadRecording('C07-plan-no-host')
    const entries = await planPass(rec, dir('claude-home-'), () => undefined)
    expect(notes(entries)).toEqual([])
  })

  it('edit passes never touch the plans dir', async () => {
    const rec = loadRecording('C15b-askuser-disallowed')
    const home = dir('claude-home-')
    const plans = join(home, '.claude', 'plans')
    mkdirSync(plans, { recursive: true })
    const adapter = fakeAdapter(fake(), {
      home,
      onSpawn: async () => {
        await sleep(50)
        writeFileSync(join(plans, 'p.md'), finalResult(rec))
      },
    })
    const o = startOptionsFor(rec, { cwd: dir(), env: { FAKE_CLI_SCRIPT: rec.path } })
    expect(o.step).toBe('implement')
    const { entries } = await drive(adapter, o, rec.decisions)
    expect(existsSync(join(plans, 'p.md'))).toBe(true)
    expect(notes(entries)).toEqual([])
  })
})
