// Pure pieces of the run core: the compressed clock, prompt building, StartOptions, snag buttons (failureHints →
// "unset ANTHROPIC_API_KEY"), recovery (projectFromLog / needsRelaunch), runs.list filtering and CLI --set parsing.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUTS } from '../../../src/shared/config-schema.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import { filterSummaries } from '../../../src/core/handlers.ts'
import { toRunSummary } from '../../../src/core/supervisor/derive.ts'
import {
  buildPrompt,
  clockFromEnv,
  defaultRecoveryActions,
  scaledClock,
  startOptionsFor,
} from '../../../src/core/supervisor/effects.ts'
import { initRunState, runConfigFromResolved } from '../../../src/core/supervisor/machine.ts'
import { needsRelaunch, projectFromLog } from '../../../src/core/supervisor/recovery.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { UsageError, parseSets, runPolicy } from '../../../src/cli/args.ts'

const config = resolveBuiltinConfig({ profile: 'claude-only' })

function run(over: Partial<RunState> = {}): RunState {
  return {
    ...initRunState({
      runId: '20261005T120000Z-abcd',
      displayNo: 3,
      folder: 'C:\\tmp\\ts-small',
      folderKey: '0123456789abcdef',
      task: 'add a --version flag',
      profile: 'claude-only',
      createdAt: 1000,
      config: runConfigFromResolved(config, 'native'),
    }),
    ...over,
  }
}

describe('clock', () => {
  it('scaledClock runs `scale` times faster and fires timers at clock time', async () => {
    const c = scaledClock(100, Date.now())
    const t0 = c.now()
    const fired = await new Promise<number>((resolve) => c.setTimer(() => resolve(c.now()), t0 + 2000))
    expect(fired - t0).toBeGreaterThanOrEqual(1900)
    expect(c.scale).toBe(100)
  })

  it('DIM_FACTORY_E2E_TIME_SCALE needs DIM_FACTORY_E2E=1', () => {
    expect(clockFromEnv({ DIM_FACTORY_E2E_TIME_SCALE: '50' }).scale).toBe(1)
    expect(clockFromEnv({ DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_TIME_SCALE: '50' }).scale).toBe(50)
    expect(clockFromEnv({ DIM_FACTORY_E2E: '1', DIM_FACTORY_E2E_TIME_SCALE: 'x' }).scale).toBe(1)
  })
})

describe('prompts and StartOptions', () => {
  it('Plan gets the task; Implement gets the task and the approved plan; a resume gets the continuation', () => {
    const s = run()
    const plan = buildPrompt(s, config, { step: 'plan', launch: { fresh: {}, planMode: 'native' } })
    expect(plan.text).toContain('Task:\nadd a --version flag')
    expect(plan.text).toContain('INSUFFICIENT_CONTEXT')
    const withPlan = run({ plan: { decided: true, text: '## Goal\nPrint it.', edited: false } })
    const impl = buildPrompt(withPlan, config, { step: 'implement', launch: { fresh: {} } })
    expect(impl.text).toContain('Approved plan — follow it.')
    expect(impl.text).toContain('## Goal\nPrint it.')
    const noPlan = buildPrompt(run(), config, { step: 'implement', launch: { fresh: {} } })
    expect(noPlan.text).not.toContain('Approved plan')
    const resumed = buildPrompt(run(), config, {
      step: 'implement',
      launch: { resume: { sessionId: 's1' }, continuation: 'continue' },
    })
    expect(resumed.text).toBe('continue')
  })

  it('pre-assigns a session id for a fresh mutating pass and passes resume through', () => {
    const s = run()
    const fresh = startOptionsFor({
      runId: s.runId,
      cwd: s.folder,
      config,
      state: s,
      prompt: 'p',
      spawn: {
        t: 'spawn',
        step: 'implement',
        attempt: 1,
        spawnNo: 1,
        launch: { fresh: {} },
        vendor: 'claude',
        model: null,
        mode: 'autoedit',
      },
    })
    expect(fresh.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(fresh.askTimeoutMs).toBe(DEFAULT_TIMEOUTS.askMs)
    const resume = startOptionsFor({
      runId: s.runId,
      cwd: s.folder,
      config,
      state: s,
      prompt: 'continue',
      spawn: {
        t: 'spawn',
        step: 'implement',
        attempt: 1,
        spawnNo: 2,
        launch: { resume: { sessionId: 'abc' }, continuation: 'continue' },
        vendor: 'claude',
        model: null,
        mode: 'autoedit',
      },
    })
    expect(resume.resume).toEqual({ sessionId: 'abc' })
    expect(resume.sessionId).toBeUndefined()
    const plan = startOptionsFor({
      runId: s.runId,
      cwd: s.folder,
      config,
      state: s,
      prompt: 'p',
      spawn: {
        t: 'spawn',
        step: 'plan',
        attempt: 1,
        spawnNo: 1,
        launch: { fresh: {}, planMode: 'native' },
        vendor: 'claude',
        model: 'opus',
        mode: 'readonly',
      },
    })
    expect(plan.planNative).toBe(true)
    expect(plan.sessionId).toBeUndefined()
  })
})

describe('snag buttons', () => {
  const actions = defaultRecoveryActions(() => 'claude', 'win32')
  it('offers login and "unset ANTHROPIC_API_KEY" for an auth failure with the env-key hint', () => {
    const a = actions(
      'implement',
      { category: 'auth_required', message: 'bad key', raw: '', classifiedBy: 'structured' },
      { hasSession: false, hints: ['claude-env-key'] },
    )
    const ids = a.map((x) => x.id)
    expect(ids).toEqual(
      expect.arrayContaining(['implement:login', 'implement:unset-api-key', 'implement:retry', 'run:close']),
    )
    const unset = a.find((x) => x.id === 'implement:unset-api-key')
    expect(unset?.kind === 'shell_copy' && unset.command).toMatch(/ANTHROPIC_API_KEY/)
  })
  it('keeps the default buttons otherwise', () => {
    const a = actions(
      'plan',
      { category: 'process_crash', message: 'x', raw: '', classifiedBy: 'exit' },
      { hasSession: false, hints: [] },
    )
    expect(a.map((x) => x.id)).toEqual(['plan:retry', 'plan:skip', 'run:close'])
  })
})

describe('recovery', () => {
  it('projectFromLog applies statuses, sessions, cards and outputs written after run.json', () => {
    const s = run({ started: true, lock: 'held' })
    const env = (seq: number, body: RunEnvelope['body']): RunEnvelope => ({
      runId: s.runId,
      seq,
      ts: 5000 + seq,
      body,
    })
    const out = projectFromLog(s, [
      env(10, { t: 'step-status', step: 'plan', attempt: 1, status: 'running' }),
      env(11, { t: 'ev', step: 'plan', attempt: 1, ev: { type: 'session', id: 'sess-1' } }),
      env(12, { t: 'step-status', step: 'plan', attempt: 1, status: 'done' }),
      env(13, { t: 'output', file: 'plan', version: 1 }),
      env(14, {
        t: 'card',
        state: 'open',
        card: {
          id: 'gate:afterPlan-1',
          kind: 'gate:afterPlan',
          title: 'Review',
          body: '',
          payload: {},
          blocking: true,
          choices: [],
        },
      }),
      env(15, { t: 'run-status', status: 'waiting', phase: 'plan-review' }),
    ])
    expect(out.steps.plan.status).toBe('done')
    expect(out.steps.plan.sessionId).toBe('sess-1')
    expect(out.outputs.plan).toBe(1)
    expect(out.cards.map((c) => [c.view.kind, c.step])).toEqual([['gate:afterPlan', 'plan']])
    expect(out.phase).toBe('plan-review')
    expect(s.steps.plan.status).toBe('queued')
  })

  it('needsRelaunch: live work only (a gate or a paused step is left alone)', () => {
    const idle = run({ started: true, lock: 'held' })
    expect(needsRelaunch(idle)).toBe(false)
    const live = structuredClone(idle)
    live.steps.implement.status = 'running'
    expect(needsRelaunch(live)).toBe(true)
    const paused = structuredClone(idle)
    paused.steps.implement.status = 'paused'
    expect(needsRelaunch(paused)).toBe(false)
  })
})

describe('runs.list filter', () => {
  it('filters by folder, status and text and pages newest first', () => {
    const a = { ...toRunSummary(run()), runId: 'a', createdAt: 1, displayNo: 1, status: 'completed' as const }
    const b = { ...toRunSummary(run()), runId: 'b', createdAt: 2, displayNo: 2, title: 'other task' }
    const c = { ...toRunSummary(run()), runId: 'c', createdAt: 3, displayNo: 3, folder: 'D:\\elsewhere' }
    expect(filterSummaries([a, b, c], {}).items.map((s) => s.runId)).toEqual(['c', 'b', 'a'])
    expect(filterSummaries([a, b, c], { status: ['completed'] }).items.map((s) => s.runId)).toEqual(['a'])
    expect(filterSummaries([a, b, c], { text: 'other' }).items.map((s) => s.runId)).toEqual(['b'])
    expect(filterSummaries([a, b, c], { folder: 'D:\\elsewhere' }).items.map((s) => s.runId)).toEqual(['c'])
    const page = filterSummaries([a, b, c], { limit: 2 })
    expect(page.items).toHaveLength(2)
    // The cursor is the last row's place (a keyset cursor), and the next page starts right after it.
    expect(page.nextCursor).toBe('k:2:2')
    const next = filterSummaries([a, b, c], { limit: 2, cursor: page.nextCursor ?? '' })
    expect(next.items.map((s) => s.runId)).toEqual(['a'])
    expect(next.nextCursor).toBeNull()
  })
})

describe('CLI options', () => {
  it('--set maps pass vendor/model/enabled, gates and auto; anything else is a usage error', () => {
    expect(
      parseSets([
        'plan.model=sonnet',
        'passes.implement.enabled=true',
        'gates.afterPlan=false',
        'auto=true',
        'implement.model=default',
      ]),
    ).toEqual({
      passes: { plan: { model: 'sonnet' }, implement: { enabled: true, model: null } },
      gates: { afterPlan: false },
      auto: true,
    })
    expect(() => parseSets(['timeouts.askMs=1000'])).toThrow(UsageError)
    expect(() => parseSets(['plan.enabled=yes'])).toThrow(UsageError)
  })
  it('defaults: prompts on a TTY; without one gates and cards stop and asks are denied', () => {
    expect(runPolicy({}, true)).toMatchObject({ gates: 'ask', cards: 'ask', asks: 'ask' })
    expect(runPolicy({}, false)).toMatchObject({ gates: 'stop', cards: 'stop', asks: 'deny' })
    expect(() => runPolicy({ gates: 'maybe' }, false)).toThrow(UsageError)
  })
})
