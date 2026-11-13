// Plan-file hygiene: after a plan is captured, the copy Claude wrote to
// `${CLAUDE_CONFIG_DIR ?? ~/.claude}/plans/` is deleted only when it is under that dir, modified since the pass
// spawned and holds the same text; everything else stays and is reported. Real files in a temp CLAUDE_CONFIG_DIR.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigDir } from '@core/adapters/claude/launch.ts'
import { ClaudeNormalizer, normalizeRecording } from '@core/adapters/claude/normalize.ts'
import type { PlanCapture, PlanFileOps } from '@core/adapters/claude/plan-hygiene.ts'
import {
  META_PLAN_FILES,
  cleanPlanFiles,
  displayPath,
  isUnderDir,
  nodePlanFileOps,
  planFilesNote,
  samePlanText,
} from '@core/adapters/claude/plan-hygiene.ts'
import { synth } from '../../synth.ts'

const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
const recording = (id: string): string => readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8')

const PLAN = '# Plan: add --version\n\n1. Read package.json\n2. Print the version\n'
const SPAWN = Date.UTC(2026, 9, 6, 2, 0, 0)

let home: string
let configDir: string
let plansDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-plan-home-'))
  // A relocated config dir, as CLAUDE_CONFIG_DIR sets it (the same rule the adapter applies).
  configDir = claudeConfigDir({ CLAUDE_CONFIG_DIR: join(home, 'cfg') }, home)
  plansDir = join(configDir, 'plans')
  mkdirSync(plansDir, { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Writes `content` at `path` with the given mtime (ms). */
function put(path: string, content: string, mtimeMs: number): string {
  writeFileSync(path, content)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return path
}

const exitCapture = (planFilePath: string, markdown = PLAN.trim()): PlanCapture => ({
  markdown,
  source: 'exitPlanMode',
  planFilePath,
})
const finalCapture = (markdown = PLAN.trim()): PlanCapture => ({ markdown, source: 'final-message' })

describe('plan-file hygiene: ExitPlanMode planFilePath', () => {
  it('deletes the reported file when it is under <config>/plans, new and identical (CRLF tolerated)', () => {
    const file = put(join(plansDir, 'plan-happy-sunrise.md'), PLAN.replace(/\n/g, '\r\n'), SPAWN + 1500)
    const r = cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN })
    expect(r.kept).toEqual([])
    expect(r.deleted).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
  })

  it('a file modified exactly at the spawn time counts as this pass', () => {
    const file = put(join(plansDir, 'p.md'), PLAN, SPAWN)
    expect(
      cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN }).deleted,
    ).toHaveLength(1)
  })

  it('keeps a file older than the pass and says so', () => {
    const file = put(join(plansDir, 'p.md'), PLAN, SPAWN - 60_000)
    const r = cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN })
    expect(r.deleted).toEqual([])
    expect(r.kept).toEqual([{ path: expect.stringMatching(/p\.md$/) as unknown, reason: 'older-than-pass' }])
    expect(existsSync(file)).toBe(true)
  })

  it('keeps a file whose content differs from the captured plan', () => {
    const file = put(join(plansDir, 'p.md'), `${PLAN}\n3. Something the user added\n`, SPAWN + 10)
    const r = cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN })
    expect(r.kept).toMatchObject([{ reason: 'content-differs' }])
    expect(existsSync(file)).toBe(true)
  })

  it.each([
    [
      'the default ~/.claude while CLAUDE_CONFIG_DIR is relocated',
      (): string => join(home, '.claude', 'plans', 'p.md'),
    ],
    ['a sibling dir that shares the prefix', (): string => join(configDir, 'plans2', 'p.md')],
    ['a .. escape', (): string => join(plansDir, '..', 'p.md')],
    ['the config dir itself', (): string => join(configDir, 'p.md')],
  ])('keeps a file outside <config>/plans: %s', (_label, where) => {
    const path = where()
    mkdirSync(join(path, '..'), { recursive: true })
    put(path, PLAN, SPAWN + 10)
    const r = cleanPlanFiles({ capture: exitCapture(path), plansDir, home, spawnAtMs: SPAWN })
    expect(r.deleted).toEqual([])
    expect(r.kept).toMatchObject([{ reason: 'outside-plans-dir' }])
    expect(existsSync(path)).toBe(true)
  })

  it('resolves a ~-relative planFilePath against the home it is given (redacted fixtures, C06)', () => {
    const dflt = join(home, '.claude', 'plans')
    mkdirSync(dflt, { recursive: true })
    const file = put(join(dflt, 'plan-how-to-add-happy-sunrise.md'), PLAN, SPAWN + 10)
    const capture = exitCapture('~\\.claude\\plans\\plan-how-to-add-happy-sunrise.md')
    const r = cleanPlanFiles({ capture, plansDir: dflt, home, spawnAtMs: SPAWN })
    expect(r.deleted).toHaveLength(1)
    expect(existsSync(file)).toBe(false)
  })

  it('a missing planFilePath is nothing to report; other new files are left alone', () => {
    const other = put(join(plansDir, 'other.md'), PLAN, SPAWN + 10)
    const r = cleanPlanFiles({
      capture: exitCapture(join(plansDir, 'gone.md')),
      plansDir,
      home,
      spawnAtMs: SPAWN,
    })
    expect(r).toEqual({ deleted: [], kept: [] })
    expect(existsSync(other)).toBe(true)
  })

  it('never deletes a directory or a symlink with the plan name', () => {
    const dir = join(plansDir, 'dir.md')
    mkdirSync(dir)
    expect(cleanPlanFiles({ capture: exitCapture(dir), plansDir, home, spawnAtMs: 0 }).kept).toMatchObject([
      { reason: 'not-a-file' },
    ])
    const target = put(join(home, 'elsewhere.md'), PLAN, SPAWN + 10)
    const link = join(plansDir, 'link.md')
    try {
      symlinkSync(target, link, 'file')
    } catch {
      return // no symlink privilege (Windows without developer mode): the directory case above still ran
    }
    const r = cleanPlanFiles({ capture: exitCapture(link), plansDir, home, spawnAtMs: 0 })
    expect(r.deleted).toEqual([])
    expect(existsSync(target)).toBe(true)
  })

  it('a failed delete or an unreadable file is kept and reported, never thrown', () => {
    const file = put(join(plansDir, 'p.md'), PLAN, SPAWN + 10)
    const failing: PlanFileOps = {
      ...nodePlanFileOps,
      remove() {
        throw new Error('EPERM')
      },
    }
    expect(
      cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN, ops: failing }).kept,
    ).toMatchObject([{ reason: 'delete-failed' }])
    const unreadable: PlanFileOps = { ...nodePlanFileOps, read: () => undefined }
    expect(
      cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN, ops: unreadable }).kept,
    ).toMatchObject([{ reason: 'unreadable' }])
    const throwing: PlanFileOps = {
      ...nodePlanFileOps,
      stat() {
        throw new Error('boom')
      },
    }
    expect(
      cleanPlanFiles({ capture: exitCapture(file), plansDir, home, spawnAtMs: SPAWN, ops: throwing }),
    ).toEqual({ deleted: [], kept: [] })
    expect(existsSync(file)).toBe(true)
  })
})

describe('plan-file hygiene: final-message plans (no ExitPlanMode, C07)', () => {
  it('deletes new *.md files in the plans dir whose content equals the plan; reports new ones that differ', () => {
    const same = put(join(plansDir, 'plan-declarative-fiddle.md'), `\n${PLAN}\n\n`, SPAWN + 20)
    const differs = put(join(plansDir, 'plan-user-session.md'), '# Someone else', SPAWN + 30)
    const old = put(join(plansDir, 'plan-from-yesterday.md'), PLAN, SPAWN - 86_400_000)
    const notMd = put(join(plansDir, 'notes.txt'), PLAN, SPAWN + 40)
    const r = cleanPlanFiles({ capture: finalCapture(), plansDir, home, spawnAtMs: SPAWN })
    expect(r.deleted).toEqual([same])
    expect(r.kept).toEqual([{ path: differs, reason: 'content-differs' }])
    expect(existsSync(same)).toBe(false)
    for (const f of [differs, old, notMd]) expect(existsSync(f)).toBe(true)
  })

  it('an ExitPlanMode capture without a planFilePath falls back to the same scan', () => {
    const same = put(join(plansDir, 'p.md'), PLAN, SPAWN + 20)
    const r = cleanPlanFiles({
      capture: { markdown: PLAN, source: 'exitPlanMode' },
      plansDir,
      home,
      spawnAtMs: SPAWN,
    })
    expect(r.deleted).toEqual([same])
  })

  it('a missing plans dir is a no-op', () => {
    rmSync(plansDir, { recursive: true })
    expect(cleanPlanFiles({ capture: finalCapture(), plansDir, home, spawnAtMs: SPAWN })).toEqual({
      deleted: [],
      kept: [],
    })
  })
})

describe('plan-file hygiene: helpers', () => {
  it('samePlanText ignores only line endings and surrounding whitespace', () => {
    expect(samePlanText('a\r\nb\n', ' a\nb')).toBe(true)
    expect(samePlanText('a\nb', 'a\n\nb')).toBe(false)
    expect(samePlanText('a  b', 'a b')).toBe(false)
  })

  it('isUnderDir folds .., ~ and trailing slashes; case-insensitive on win32 only', () => {
    expect(isUnderDir('/h/.claude/plans/p.md', '/h/.claude/plans/', '/h')).toBe(true)
    expect(isUnderDir('~/.claude/plans/p.md', '/h/.claude/plans', '/h')).toBe(true)
    expect(isUnderDir('/h/.claude/plans', '/h/.claude/plans', '/h')).toBe(false)
    expect(isUnderDir('/h/.claude/plans/../x.md', '/h/.claude/plans', '/h')).toBe(false)
    expect(
      isUnderDir('C:\\Users\\U\\.claude\\Plans\\p.md', 'c:/users/u/.claude/plans', 'C:\\Users\\U', 'win32'),
    ).toBe(true)
    expect(isUnderDir('/H/.claude/plans/p.md', '/h/.claude/plans', '/h', 'linux')).toBe(false)
  })

  it('the note uses ~-relative paths and is absent when there is nothing to say', () => {
    expect(planFilesNote({ deleted: [], kept: [] }, home)).toBeUndefined()
    const note = planFilesNote(
      {
        deleted: [join(home, '.claude', 'plans', 'a.md')],
        kept: [{ path: '/elsewhere/b.md', reason: 'older-than-pass' }],
      },
      home,
    )
    expect(note).toEqual({
      type: 'meta',
      key: META_PLAN_FILES,
      value: {
        deleted: ['~/.claude/plans/a.md'],
        kept: [{ path: '/elsewhere/b.md', reason: 'older-than-pass' }],
      },
    })
    expect(displayPath('C:\\Users\\U\\x.md', 'c:\\users\\u', 'win32')).toBe('~/x.md')
  })
})

describe('the normalizer exposes what the hygiene needs', () => {
  it('C06: ExitPlanMode capture carries the plan and its planFilePath', () => {
    const n = new ClaudeNormalizer({ route: 'plan', askTimeoutMs: 1, now: () => 0 })
    expect(n.planCapture()).toBeUndefined()
    for (const raw of recording('C06-plan-native-host').split('\n')) {
      const fr = raw.trim() === '' ? undefined : (JSON.parse(raw) as { dir?: string; line?: string })
      if (fr?.dir === 'out' && typeof fr.line === 'string') n.line(fr.line)
    }
    const c = n.planCapture()
    expect(c).toMatchObject({
      source: 'exitPlanMode',
      planFilePath: '~\\.claude\\plans\\plan-how-to-add-lexical-walrus.md',
    })
    const plan = normalizeRecording(recording('C06-plan-native-host')).find((e) => e.type === 'plan-captured')
    expect(plan).toMatchObject({ markdown: c?.markdown })
  })

  it('C07: a plan route without ExitPlanMode captures the final message', () => {
    const n = new ClaudeNormalizer({ route: 'plan', askTimeoutMs: 1, now: () => 0 })
    for (const raw of recording('C07-plan-no-host').split('\n')) {
      const fr = raw.trim() === '' ? undefined : (JSON.parse(raw) as { dir?: string; line?: string })
      if (fr?.dir === 'out' && typeof fr.line === 'string') n.line(fr.line)
    }
    expect(n.planCapture()).toMatchObject({ source: 'final-message' })
    expect(n.planCapture()).not.toHaveProperty('planFilePath')
    expect(n.planCapture()?.markdown.startsWith(synth('The plan is below and saved at'))).toBe(true)
  })

  it('reads a ~-relative planFilePath against the normalizer home when input.plan is empty', () => {
    const dflt = join(home, '.claude', 'plans')
    mkdirSync(dflt, { recursive: true })
    writeFileSync(join(dflt, 'p.md'), PLAN)
    const n = new ClaudeNormalizer({
      route: 'plan',
      askTimeoutMs: 1,
      home,
      readPlanFile: (p) => readFileSync(p.replace(/^~/, home), 'utf8'),
    })
    n.line(
      JSON.stringify({
        type: 'control_request',
        request_id: 'p1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'ExitPlanMode',
          input: { plan: '', planFilePath: '~/.claude/plans/p.md' },
          tool_use_id: 't',
        },
      }),
    )
    expect(n.planCapture()).toEqual({
      markdown: PLAN.trim(),
      source: 'exitPlanMode',
      planFilePath: '~/.claude/plans/p.md',
    })
  })

  it('edit and read-only routes never capture a plan', () => {
    for (const route of ['edit', 'readonly'] as const) {
      const n = new ClaudeNormalizer({ route, askTimeoutMs: 1 })
      n.line(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '# A plan?' }))
      expect(n.planCapture()).toBeUndefined()
    }
  })
})
