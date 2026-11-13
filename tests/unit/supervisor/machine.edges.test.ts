// Edge paths around the state machine rows: fallbacks, stale events, pipeline failures, relaunch/quit corners,
// isolated runs in this build, and command rejections.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT,
  VERIFY_BUILD_STEPS,
  insufficientContextOf,
  normalizePlanText,
} from '@core/supervisor/machine.ts'
import { timerId } from '@core/supervisor/timers.ts'
import { Harness, PLAN_TEXT, blockedReport, failure, makeConfig } from './helpers.ts'

describe('plan output', () => {
  it('normalizes BOM, CRLF and a single fence, and extracts <proposed_plan>', () => {
    expect(normalizePlanText('﻿```markdown\r\n## Goal\r\nx\r\n```\r\n')).toBe('## Goal\nx')
    expect(normalizePlanText('intro\n<proposed_plan>\n## Goal\ny\n</proposed_plan>\ntrailer')).toBe(
      '## Goal\ny',
    )
    expect(insufficientContextOf('INSUFFICIENT_CONTEXT: no repo')).toBe('no repo')
    expect(insufficientContextOf('## Goal\nINSUFFICIENT_CONTEXT: later line')).toBeNull()
  })

  it('an empty native plan falls back to the template once: same attempt, no budget, fallback reason', () => {
    const h = new Harness().toPlanRunning()
    h.ev('plan', { type: 'done', result: '   ' })
    expect(h.step('plan')).toMatchObject({ status: 'running', attempt: 1, autoRetryUsed: false })
    expect(h.fx('preflight')).toHaveLength(0)
    h.exit('plan', { code: 0 })
    h.passPreflight('plan')
    expect(h.fx('spawn')[0]).toMatchObject({
      attempt: 1,
      spawnNo: 2,
      launch: {
        fresh: {},
        planMode: 'emulated',
        planFallbackReason: 'Native plan mode returned an empty plan.',
      },
    })
    expect(h.bodies('step-status').at(-1)).toMatchObject({
      planMode: 'emulated',
      planFallbackReason: 'Native plan mode returned an empty plan.',
    })
    // A second empty plan is a stream_malformed failure (P16 spends the budget).
    h.ev('plan', { type: 'done', result: '' })
    expect(h.step('plan')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
  })

  it('a captured plan (ExitPlanMode) wins over the final message', () => {
    const h = new Harness().toPlanRunning()
    h.signal('plan', { type: 'plan-captured', markdown: PLAN_TEXT, source: 'exitPlanMode' })
    h.ev('plan', { type: 'done', result: 'Plan captured; stop.' })
    expect(h.fx('writeOutput')[0]?.text).toBe(PLAN_TEXT)
  })
})

describe('process events', () => {
  it('spawned records pid/route/argv and a pre-assigned session id (persisted at once)', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.reconcile()
    h.snapshot('S0')
    h.passPreflight('implement')
    const r = h.send({
      t: 'spawned',
      step: 'implement',
      spawnNo: 1,
      pid: 4242,
      route: 'claude-stdio',
      argv: ['-p', '--session-id=abc'],
      sessionId: 'abc',
    })
    expect(r.transition).toBe(true)
    expect(h.step('implement')).toMatchObject({
      sessionId: 'abc',
      route: 'claude-stdio',
      proc: { pid: 4242 },
    })
    expect(h.bodies('step-status')).toEqual([
      expect.objectContaining({ status: 'running', route: 'claude-stdio', argv: ['-p', '--session-id=abc'] }),
    ])
  })

  it('events of a superseded process are ignored', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'error', message: 'x', raw: '', fatal: true, category: 'network' })
    h.exit('implement', { code: 1 })
    h.snapshot('pre-retry', 'tree-base')
    h.fire('launch|implement')
    h.passPreflight('implement')
    expect(h.spawnNo('implement')).toBe(2)
    h.ev('implement', { type: 'done', result: 'old' }, 1)
    expect(h.effects.filter((e) => e.t !== 'persist')).toEqual([])
    expect(h.step('implement').status).toBe('running')
  })

  it('an exit without done is classified: code 0 → stream_malformed (auto retry), code 1 → process_crash', () => {
    const a = new Harness().toImplementRunning()
    a.exit('implement', { code: 0 })
    expect(a.step('implement')).toMatchObject({ status: 'running', attempt: 2 })
    expect(a.step('implement').failure?.category).toBe('stream_malformed')
    const b = new Harness().toImplementRunning()
    b.exit('implement', { code: 1, ranMs: 100 })
    expect(b.step('implement')).toMatchObject({ status: 'failed', reason: 'process_crash' })
    const c = new Harness().toImplementRunning()
    c.exit('implement', { code: 1, failure: failure('auth_expired') })
    expect(c.step('implement')).toMatchObject({ status: 'failed', reason: 'auth_expired' })
    expect(c.fx('snapshot')).toEqual([expect.objectContaining({ label: 'stopped' })])
  })

  it('a done with asks still pending resolves them as vendor-cancelled', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.ev('implement', { type: 'done', result: 'ok' })
    expect(h.bodies('ask-resolved')).toEqual([
      expect.objectContaining({ requestId: 'q1', by: 'vendor-cancel' }),
    ])
    expect(h.step('implement').status).toBe('done')
  })

  it('an ask from a process being stopped is closed right away', () => {
    const h = new Harness().toImplementRunning()
    h.user({ kind: 'stop' })
    h.ask('implement', 'late')
    expect(h.bodies('ask-resolved')).toEqual([expect.objectContaining({ requestId: 'late', by: 'stop' })])
    expect(h.step('implement').asks).toEqual([])
  })

  it('a lingering process is killed 5 s after done; the run completes once it exits', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'ok' })
    h.reconcile('end-of-pass')
    h.snapshot('S1', 'tree-new')
    expect(h.state.status).toBe('completed')
    expect(h.state.lock).toBe('held')
    h.fire('kill|implement')
    expect(h.fx('kill')).toHaveLength(1)
    h.exit('implement', { code: null })
    expect(h.fx('unlock')).toHaveLength(1)
  })

  it('meta signals: usageApprox and resumeIgnored are honoured; failureHints reach the snag builder', () => {
    let hints: string[] = []
    const h = new Harness(makeConfig(), {
      ...DEFAULT_CONTEXT,
      recoveryActions: (step, f, info) => {
        hints = info.hints
        return DEFAULT_CONTEXT.recoveryActions(step, f, info)
      },
    }).toImplementRunning()
    // The Claude adapter's real payloads (normalize.ts #passUsage, run.ts constructor): objects, not `true`.
    h.signal('implement', {
      type: 'meta',
      key: 'usageApprox',
      value: { reason: 'resumed-without-base', source: 'result.usage' },
    })
    h.signal('implement', {
      type: 'meta',
      key: 'resumeIgnored',
      value: {
        route: 'plan',
        reason: 'Only edit passes can resume a Claude session; this one starts fresh.',
      },
    })
    expect(h.bodies('step-status')).toEqual([
      expect.objectContaining({
        step: 'implement',
        sessionNote: expect.stringMatching(/fresh session/) as unknown,
      }),
    ])
    h.signal('implement', { type: 'meta', key: 'failureHints', value: ['claude-env-key'] })
    expect(h.step('implement').usageApprox).toBe(true)
    expect(h.step('implement').sessionNote).toMatch(/fresh session/)
    h.ev('implement', {
      type: 'error',
      message: 'Invalid API key',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    expect(hints).toEqual(['claude-env-key'])
  })

  it('exit cumulative usage becomes the session priorUsage of the next resume', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.fire(timerId.ask('implement', 'q1'))
    h.send({
      t: 'exit',
      step: 'implement',
      spawnNo: 1,
      code: 1,
      signal: null,
      ranMs: 9,
      cumulative: { input: 7, output: 3 },
    })
    h.snapshot('paused')
    h.user({ kind: 'resume' })
    h.snapshot('resume')
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch.resume).toEqual({
      sessionId: 'impl-session',
      priorUsage: { input: 7, output: 3 },
    })
  })
})

describe('launch pipeline failures', () => {
  it('snapshot warnings (unreadable files) become run notes', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight()
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('run-start'),
      commit: 'c',
      tree: 't',
      warnings: ['1 file could not be read: locked.db'],
    })
    expect(h.state.notes).toEqual(['1 file could not be read: locked.db'])
  })

  it('a failing pass-boundary preflight fails the pass with that category and spawns nothing', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.reconcile()
    h.snapshot('S0')
    h.passPreflight('implement', {
      ...blockedReport({ category: 'sandbox_unavailable', title: 'No sandbox' }),
      mode: 'passBoundary',
    })
    expect(h.step('implement')).toMatchObject({
      status: 'failed',
      reason: 'sandbox_unavailable',
      autoRetryUsed: false,
    })
    expect(h.fx('spawn')).toHaveLength(0)
    expect(h.bodies('snag')).toHaveLength(1)
  })

  it('a failed start snapshot never lets the mutating pass spawn: one retry after 2 s, then failed', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.reconcile()
    h.snapshotFail('S0')
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2 })
    expect(h.state.timers[timerId.launch('implement')]).toBe(h.now + 2000)
    h.fire('launch|implement')
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
    h.snapshotFail('S0')
    expect(h.step('implement')).toMatchObject({ status: 'failed', reason: 'snapshot_failed' })
    expect(h.log.filter((e) => e.t === 'spawn' && e.step === 'implement')).toHaveLength(0)
  })
})

describe('relaunch and quit corners', () => {
  it('relaunch during the pre-implement boundary pauses Implement; Resume redoes the whole boundary', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.send({ t: 'relaunch' })
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'interrupted', spawnNo: 0 })
    // The reconcile of the dead instance is dropped; only the interrupted snapshot is outstanding.
    expect(Object.values(h.state.requests)).toEqual([
      { kind: 'snapshot', label: 'interrupted', purpose: 'recovery' },
    ])
    h.user({ kind: 'resume' })
    expect(h.fx('reconcile')).toEqual([expect.objectContaining({ boundary: 'pre-implement' })])
  })

  it('a lock grant that crosses a Stop is handed back', () => {
    const h = new Harness()
    h.create()
    h.user({ kind: 'stop' })
    expect(h.fx('unlock')).toHaveLength(1)
    h.lock()
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.fx('preflight')).toHaveLength(0)
    expect(h.state.lock).toBe('none')
  })

  it('relaunch re-enqueues a queued run and re-requests run-level snapshots', () => {
    const q = new Harness()
    q.create()
    q.send({ t: 'relaunch' })
    expect(q.fx('lock')).toHaveLength(1)
    const r = new Harness()
    r.create()
    r.lock()
    r.preflight()
    r.send({ t: 'relaunch' })
    expect(r.fx('snapshot').map((s) => s.label)).toEqual(['run-start', 'interrupted'])
    expect(r.step('plan')).toMatchObject({ status: 'paused', pause: 'interrupted' })
  })

  it('quit during the authoritative preflight pauses it; Resume reruns it', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.send({ t: 'quit' })
    expect(h.step('preflight')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
    h.send({ t: 'relaunch' })
    expect(h.step('preflight').pause).toBe('interrupted-by-quit')
    h.user({ kind: 'resume' })
    expect(h.step('preflight')).toMatchObject({ status: 'running', attempt: 2 })
    expect(h.fx('preflight')).toEqual([expect.objectContaining({ mode: 'authoritative' })])
  })

  it('a gate stays open across relaunch', () => {
    const h = new Harness().toPlanGate()
    h.send({ t: 'relaunch' })
    expect(h.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
    expect(h.state.status).toBe('waiting')
  })
})

describe('isolated runs in this build', () => {
  it('without prepare in the build the run fails at prepare with capability_missing', () => {
    // The verify build has no prepare step, so it is named explicitly.
    const h = new Harness(makeConfig({ isolation: 'worktree' }), {
      ...DEFAULT_CONTEXT,
      buildSteps: VERIFY_BUILD_STEPS,
    })
    h.create()
    h.lock()
    h.preflight()
    expect(h.step('prepare')).toMatchObject({ status: 'failed', reason: 'capability_missing' })
    expect(h.state.status).toBe('failed')
    expect(h.fx('spawn')).toHaveLength(0)
  })

  it('with prepare in the build: setup → Plan ∥ run-start ∥ rest; Implement waits for the rest', () => {
    const h = new Harness(makeConfig({ isolation: 'worktree' }), {
      ...DEFAULT_CONTEXT,
      buildSteps: [...DEFAULT_CONTEXT.buildSteps, 'prepare'],
    })
    h.create()
    h.lock()
    h.preflight()
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'setup' })])
    expect(h.state.phase).toBe('queued')
    h.send({ t: 'prepare-result', req: h.req((r) => r.kind === 'prepare'), ok: true })
    expect(h.fx('prepare')).toEqual([expect.objectContaining({ stage: 'rest' })])
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'run-start' })])
    h.snapshot('run-start')
    h.passPreflight('plan')
    h.ev('plan', { type: 'done', result: PLAN_TEXT })
    h.exit('plan')
    h.approve()
    expect(h.step('implement').status).toBe('queued')
    expect(h.state.phase).toBe('preparing')
    h.send({ t: 'prepare-result', req: h.req((r) => r.kind === 'prepare'), ok: true })
    expect(h.step('prepare').status).toBe('done')
    expect(h.fx('reconcile')).toHaveLength(1)
  })
})

describe('command rejections', () => {
  it('answers to unknown asks, undo without a pending deny, unknown cards and choices', () => {
    const h = new Harness().toPlanGate()
    h.user({ kind: 'answer', requestId: 'nope', decision: 'allow', via: 'app' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
    h.user({ kind: 'undo-deny', requestId: 'nope' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
    h.user({ kind: 'card', cardId: 'nope', choiceId: 'approve' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })])
    const id = h.state.cards[0]?.view.id ?? ''
    h.user({ kind: 'card', cardId: id, choiceId: 'bogus' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    expect(h.state.cards).toHaveLength(1)
  })

  it('resume / retry / skip / keep-waiting in the wrong state are conflicts', () => {
    const h = new Harness().toImplementRunning()
    for (const cmd of [
      { kind: 'resume' as const },
      { kind: 'retry' as const, step: 'implement' as const },
      { kind: 'skip' as const, step: 'plan' as const },
      { kind: 'keep-waiting' as const, step: 'plan' as const },
    ]) {
      h.user(cmd)
      expect(h.fx('result'), cmd.kind).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    }
    h.user({ kind: 'keep-waiting', step: 'implement' })
    expect(h.fx('result')).toEqual([])
    expect(h.step('implement').keepWaitingAt).toBe(h.now)
  })
})
