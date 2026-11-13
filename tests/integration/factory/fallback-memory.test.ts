// Fallback on a rate limit, project memory and quality gates through a real core (no network):
//   - fallback (opt-in): Claude's Implement rejected by a rate limit (a 429) moves to Codex (an in-process scripted
//     Codex, as the second-vendor suites use) and the run finishes there; the switch is noted on the run and listed in
//     the day's report. Off: the snag waits for you. Past the run's budget: no switch.
//   - memory: a completed run proposes DIM_FACTORY.md as a diff; nothing is written until it is approved; the next run's
//     passes get it as {{memory}}; an Auto run in a project that opted in writes it itself
//   - quality gates: a required check that passes counts the run as done (the gates are listed on it)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { grantTrust } from '../../../src/core/config/trust.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { MemoryView } from '../../../src/shared/factory.ts'
import {
  IMPLEMENT_MATCH,
  ScriptedCodex,
  World as BalancedWorld,
  codexPlays,
  failedWithSnag,
  snagOf,
} from '../balanced/engine/helpers.ts'
import { rateLimitedScript } from '../self-heal/helpers.ts'
import { CHECK } from '../verify/helpers.ts'
import { stdinByScript } from '../run/scenario.ts'
import { World, tasksSpec, value, version } from './helpers.ts'

const balanced = new BalancedWorld()
const world = new World()
afterEach(async () => {
  await balanced.dispose()
  await world.dispose()
})

/** Only the first Implement entry launches in full mode (bypassPermissions), as an Auto run's does. */
function fullModeFirst(sc: { dir: string }): void {
  const file = join(sc.dir, 'scenario.json')
  const entries = JSON.parse(readFileSync(file, 'utf8')) as { match: { argvIncludes?: string[] } }[]
  const first = entries.find((e) => e.match.argvIncludes?.includes('acceptEdits') === true)
  if (first?.match.argvIncludes !== undefined)
    first.match.argvIncludes = first.match.argvIncludes.map((a) =>
      a === 'acceptEdits' ? 'bypassPermissions' : a,
    )
  writeFileSync(file, JSON.stringify(entries, null, 2))
}

const PLAN = { plan: { recording: 'C06-plan-native-host' } }
const CLAUDE_ONLY = { profile: 'claude-only', gates: { afterPlan: false, beforeFix: false } }
const limited = (): { name: string; match: typeof IMPLEMENT_MATCH; ops: object[] }[] => [
  {
    name: 'implement-rate-limited',
    match: IMPLEMENT_MATCH,
    ops: rateLimitedScript(Date.now() + 2 * 3_600_000),
  },
]

describe('fallback on a rate limit', () => {
  it('moves the rate-limited pass to the next ready vendor, notes it and lists it in the report', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', file: 'src/version.ts' }]))
    const t = await balanced.boot(PLAN, codex, {
      first: limited(),
      user: { fallback: { enabled: true, vendors: ['codex'] } },
    })
    const { runId, c } = await balanced.start(t, CLAUDE_ONLY)
    // The pass fails on the limit first (the run reads failed for a moment), then the fallback retries it.
    const done = await c.waitFor((s) => s.status === 'completed' || s.status === 'cancelled', 120_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'codex' })
    expect(codex.starts.map((s) => s.step)).toEqual(['implement'])
    // The limit was a snag first (its failure is the rate limit), then the switch.
    expect(snagOf(t.events, 'implement')?.failure.category).toBe('rate_limited')
    await t.core.factory?.settled()
    const report = value(await t.core.invoke('queue.report', {}))
    expect(report.fallbacks).toEqual([
      expect.objectContaining({
        runId,
        step: 'Implement',
        from: 'Claude',
        to: 'Codex',
        why: 'Claude hit a rate limit',
      }),
    ])
    expect(report.markdown).toContain('Implement: Claude to Codex (Claude hit a rate limit)')
    // resolved.json keeps the switch (Re-run takes it).
    const resolved = JSON.parse(readFileSync(join(t.home, 'runs', runId, 'resolved.json'), 'utf8')) as {
      patches: { label: string }[]
    }
    expect(resolved.patches.map((p) => p.label)).toEqual([
      'Fallback: Claude hit a rate limit, so Implement moved to Codex',
    ])
  }, 240_000)

  it('is off by default: the rate limit stays a snag for you', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', file: 'src/version.ts' }]))
    const t = await balanced.boot(PLAN, codex, { first: limited() })
    const { c } = await balanced.start(t, CLAUDE_ONLY)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    await new Promise((r) => setTimeout(r, 1500))
    await t.core.factory?.settled()
    expect(failed.steps.implement.failure).toMatchObject({ category: 'rate_limited' })
    expect(c.state.steps.implement).toMatchObject({ status: 'failed', vendor: 'claude' })
    expect(codex.starts).toEqual([])
  }, 240_000)

  it('never switches past the budget: a run over its limit keeps its snag', async () => {
    const codex = new ScriptedCodex(codexPlays([{ kind: 'ok', file: 'src/version.ts' }]))
    const t = await balanced.boot(PLAN, codex, {
      first: limited(),
      user: { fallback: { enabled: true, vendors: [] }, factory: { maxCostPerRunUsd: 0.000001 } },
    })
    const { c } = await balanced.start(t, CLAUDE_ONLY)
    await c.waitFor(failedWithSnag('implement'), 90_000)
    await new Promise((r) => setTimeout(r, 1500))
    await t.core.factory?.settled()
    expect(c.state.steps.implement).toMatchObject({ status: 'failed', vendor: 'claude' })
    expect(codex.starts).toEqual([])
    expect(value(await t.core.invoke('queue.report', {})).fallbacks).toEqual([])
  }, 240_000)
})

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}

/** The folder's memory view once `pred` holds (proposals are made as a run's end is published). */
async function memoryWhen(
  core: Awaited<ReturnType<World['boot']>>['core'],
  folder: string,
  pred: (m: MemoryView) => boolean,
): Promise<MemoryView> {
  const end = Date.now() + 30_000
  for (;;) {
    await core.factory?.settled()
    const m = value(await core.invoke('memory.get', { folder }))
    if (pred(m) || Date.now() > end) return m
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function runOnce(
  core: Awaited<ReturnType<World['boot']>>['core'],
  folder: string,
  task: string,
  overrides: Record<string, unknown> = {},
): Promise<{ runId: string; state: RunState }> {
  const { runId } = value(await core.invoke('runs.start', { folder, task, overrides }))
  const c = core.controller(runId)
  if (c === undefined) throw new Error('no controller')
  const state = await c.waitFor(
    (s) => s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed',
    120_000,
  )
  await c.settle(15_000)
  await core.factory?.settled()
  return { runId, state }
}

describe('project memory', () => {
  it('proposes the update as a diff, writes nothing until approved, and feeds the file to the next run', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0'), version('1.0.1')]))
    const { core, sc } = await world.boot(w)
    const file = join(w.folder, 'DIM_FACTORY.md')
    const first = await runOnce(core, w.folder, 'add a --version flag')
    expect(first.state.outcome).toBe('clean')
    expect(existsSync(file)).toBe(false)
    const m = await memoryWhen(core, w.folder, (x) => x.pending.length > 0)
    expect(m).toMatchObject({ file, exists: false, enabled: true, propose: true, autoApply: false })
    expect(m.pending).toHaveLength(1)
    const p = m.pending[0]
    expect(p).toMatchObject({ runId: first.runId, baseSha256: null, removed: 0 })
    expect(p?.diff).toContain('--- /dev/null\n+++ b/DIM_FACTORY.md\n')
    expect(p?.diff).toContain('+# Project memory')
    expect(p?.diff).toMatch(
      /\+- \d{4}-\d\d-\d\d · Run #\d+ · add a --version flag · Done, the reviewers found nothing to fix/,
    )

    const applied = value(await core.invoke('memory.apply', { folder: w.folder, id: p?.id ?? '' }))
    expect(applied.pending).toEqual([])
    expect(applied.exists).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('## Run notes')
    expect(text).toContain('add a --version flag')

    // The next run's passes get the file as {{memory}}.
    const second = await runOnce(core, w.folder, 'bump the version')
    expect(second.state.memory).toContain('add a --version flag')
    const plan = (stdinByScript(sc.entries()).get('plan-2.script.jsonl') ?? [])
      .map(userText)
      .find((x) => x !== '')
    expect(plan).toContain(
      "The project's memory: its conventions, decisions and notes kept from earlier runs.",
    )
    expect(plan).toContain('add a --version flag')
    // Its own proposal is against the file as it is now: one note added.
    const again = await memoryWhen(core, w.folder, (x) => x.pending.length > 0)
    expect(again.pending.map((x) => [x.runId, x.added, x.removed])).toEqual([[second.runId, 1, 0]])
    // A file changed since the proposal is never overwritten.
    writeFileSync(file, `${text}\n- a note of yours\n`)
    const conflict = await core.invoke('memory.apply', { folder: w.folder, id: second.runId })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.error.code).toBe('CONFLICT')
    expect(readFileSync(file, 'utf8')).toContain('- a note of yours')
    value(await core.invoke('memory.dismiss', { folder: w.folder, id: second.runId }))
    expect(value(await core.invoke('memory.get', { folder: w.folder })).pending).toEqual([])
  }, 300_000)

  it('an Auto run writes it itself only where the project opted in', async () => {
    const w = await world.setup(
      tasksSpec([version('1.0.0'), version('1.0.1')]),
      {},
      {
        project: { memory: { autoApply: true } },
      },
    )
    // The first run is Auto (Implement in full mode); the second is not.
    fullModeFirst(w.sc)
    // The project's opt-in is part of its file; a project file that turns nothing else on needs no Auto grant.
    const { core } = await world.boot(w)
    const file = join(w.folder, 'DIM_FACTORY.md')
    const r = await runOnce(core, w.folder, 'add a --version flag', { auto: true })
    expect(r.state.status).toBe('completed')
    const written = await memoryWhen(core, w.folder, (x) => x.exists)
    expect(written.pending).toEqual([])
    expect(readFileSync(file, 'utf8')).toContain('add a --version flag')
    // Not Auto: the update waits for you even here.
    const r2 = await runOnce(core, w.folder, 'bump it again')
    const waiting = await memoryWhen(core, w.folder, (x) => x.pending.length > 0)
    expect(waiting.pending.map((p) => p.runId)).toEqual([r2.runId])
    expect(readFileSync(file, 'utf8')).not.toContain('bump it again')
  }, 300_000)

  it('memory.autoApply in the user file is refused (a project opt-in only)', async () => {
    const w = await world.setup(tasksSpec([version('1.0.0')]), { memory: { autoApply: true } })
    const { core } = await world.boot(w)
    const r = await core.invoke('runs.start', { folder: w.folder, task: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
  }, 120_000)
})

describe('quality gates', () => {
  it('a required check that passes counts the run as done, and the gates are listed', async () => {
    const w = await world.setup(
      tasksSpec([version('1.0.0')]),
      { verify: { enabled: true, commands: [CHECK] } },
      { project: { quality: { enabled: true, verify: ['check'] } } },
    )
    await grantTrust(
      w.folder,
      { kind: 'command', command: { kind: 'verify', argv: ['node', 'check.mjs'], cwdRel: '.' } },
      { home: w.home },
    )
    const { core } = await world.boot(w)
    const live = value(await core.invoke('preflight.run', { folder: w.folder }))
    const q = [...live.warnings, ...live.info].find((c) => c.id === 'run.quality')
    expect(q).toMatchObject({ status: 'pass', detail: 'To count as done the run must pass: check.' })
    const r = await runOnce(core, w.folder, 'set the version')
    expect(r.state.outcome).toBe('clean')
    expect(r.state.notes).toContain('Quality gates passed: check.')
    expect(core.summary(r.runId)?.gates).toEqual({ passed: ['check'], failed: [] })
  }, 240_000)

  it('the live checks warn when a required check cannot run', async () => {
    const w = await world.setup(
      tasksSpec([version('1.0.0')]),
      {},
      {
        project: { quality: { enabled: true, verify: ['lint'], security: true, acceptance: true } },
      },
    )
    const { core } = await world.boot(w)
    const live = value(await core.invoke('preflight.run', { folder: w.folder }))
    const q = live.warnings.find((c) => c.id === 'run.quality')
    expect(q).toMatchObject({
      status: 'warn',
      blocking: false,
      title: 'The run cannot pass its quality gates as set up',
    })
    expect(q?.detail).toBe(
      '"lint" is required, but Verify is off. The security review is required, but it is off for this run. The acceptance review is required, but it is off for this run. The run completes with failures unless every required check passes.',
    )
  }, 120_000)
})
