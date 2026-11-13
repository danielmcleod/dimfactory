// The state machine, one case per row in scope here (pass rows P1–P26, run rows R1–R5, R2b, R13).
// Rows covered by other suites are listed as todo so the table stays complete.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT, PLAN_IMPLEMENT_BUILD_STEPS } from '@core/supervisor/machine.ts'
import { timerId } from '@core/supervisor/timers.ts'
import type { ReducerContext } from '@core/supervisor/types.ts'
import { Harness, PLAN_TEXT, blockedReport, effectTypes, makeConfig } from './helpers.ts'

const STALL = makeConfig().timeouts.stallMs
const HARD = makeConfig().timeouts.hardKillMs

describe('pass rows', () => {
  it('P1 queued → running: spawn only after reconcile, S0 and the pass-boundary preflight', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    expect(h.step('implement').status).toBe('running')
    expect(h.fx('reconcile')).toEqual([
      expect.objectContaining({ boundary: 'pre-implement', step: 'implement' }),
    ])
    expect(h.fx('spawn')).toHaveLength(0)
    h.reconcile()
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0', step: 'implement' })])
    expect(h.fx('spawn')).toHaveLength(0)
    h.snapshot('S0', 'tree-base')
    expect(h.fx('preflight')).toEqual([expect.objectContaining({ mode: 'passBoundary', step: 'implement' })])
    expect(h.fx('spawn')).toHaveLength(0)
    h.tick(10).passPreflight('implement')
    const [spawn] = h.fx('spawn')
    expect(spawn).toMatchObject({
      step: 'implement',
      attempt: 1,
      spawnNo: 1,
      launch: { fresh: {} },
      mode: 'autoedit',
    })
    expect(h.fx('liveCount')).toEqual([{ t: 'liveCount', on: true }])
    expect(h.state.timers[timerId.stall('implement')]).toBe(h.now + STALL)
    expect(h.state.timers[timerId.hard('implement')]).toBe(h.now + HARD)
    expect(h.step('implement').startSnap?.label).toBe('S0')
    expect(h.state.phase).toBe('implementing')
  })

  it('P2 queued → skipped: a disabled pass is skipped with its reason', () => {
    const h = new Harness(
      makeConfig({
        passes: { ...makeConfig().passes, plan: { ...makeConfig().passes.plan, enabled: false } },
      }),
    )
    h.create()
    h.lock()
    h.preflight()
    expect(h.step('plan')).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(h.state.plan).toMatchObject({ decided: true, text: null })
    // Implement goes straight to its pre-implement boundary.
    expect(h.fx('reconcile')).toHaveLength(1)
  })

  it('P3 queued → Stop → cancelled (a queued run leaves the scheduler queue)', () => {
    const h = new Harness()
    h.create()
    h.user({ kind: 'stop' })
    expect(h.step('plan').status).toBe('cancelled')
    expect(h.step('implement').status).toBe('cancelled')
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.fx('snapshot')).toHaveLength(0)
    expect(h.state.status).toBe('cancelled')
    expect(h.state.phase).toBe('done')
  })

  it('P4 running, session{id} → persist the session id', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.reconcile()
    h.snapshot('S0')
    h.passPreflight('implement')
    const r = h.ev('implement', { type: 'session', id: 'sess-1' })
    expect(h.step('implement').sessionId).toBe('sess-1')
    expect(h.state.sessions['sess-1']).toMatchObject({ vendor: 'claude', step: 'implement' })
    expect(r.transition).toBe(true)
    expect(h.fx('persist')).toEqual([{ t: 'persist', force: true }])
  })

  it('P5 running/stalled, any event → lastEventAt moves; an in-flight tool uses toolStallMs', () => {
    const h = new Harness().toImplementRunning()
    const t = makeConfig().timeouts
    h.tick(1000).ev('implement', {
      type: 'tool',
      id: 't1',
      name: 'Bash',
      summary: 'npm test',
      phase: 'start',
    })
    expect(h.step('implement').inFlightTools).toEqual(['t1'])
    expect(h.step('implement').lastEventAt).toBe(h.now)
    h.tick(1000).ev('implement', { type: 'tool', id: 't1', name: 'Bash', summary: 'npm test', phase: 'end' })
    expect(h.step('implement').inFlightTools).toEqual([])
    // Firing the (lazily kept) stall timer re-arms it at the new deadline instead of stalling.
    h.tick(1000).signal('implement', { type: 'liveness' })
    const last = h.now
    h.fire('stall|implement')
    expect(h.step('implement').status).toBe('running')
    expect(h.state.timers[timerId.stall('implement')]).toBe(last + t.stallMs)
  })

  it('P6 running, auto-answered signal → logged, still running', () => {
    const h = new Harness().toImplementRunning()
    h.signal('implement', {
      type: 'auto-answered',
      requestId: 'a1',
      decision: 'allow',
      tool: 'Bash',
      why: 'allow-cache',
    })
    expect(h.bodies('auto-answered')).toEqual([
      expect.objectContaining({ step: 'implement', requestId: 'a1', why: 'allow-cache', decision: 'allow' }),
    ])
    expect(h.step('implement').status).toBe('running')
    expect(h.fx('answer')).toHaveLength(0)
  })

  it('P7 running/stalled, ask → waiting: FIFO queue, ask timer, stall/hard suspended, notify', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1', { expiresIn: 600_000 })
    expect(h.step('implement').status).toBe('waiting')
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBe(h.now + 600_000)
    expect(h.state.timers[timerId.stall('implement')]).toBeUndefined()
    expect(h.state.timers[timerId.hard('implement')]).toBeUndefined()
    expect(h.fx('notify')).toEqual([{ t: 'notify', kind: 'ask', step: 'implement', requestId: 'q1' }])
    h.ask('implement', 'q2')
    expect(h.step('implement').asks.map((a) => a.requestId)).toEqual(['q1', 'q2'])
    expect(h.state.status).toBe('waiting')
    expect(h.state.phase).toBe('implementing')
  })

  it('P8 waiting, Allow once / Allow for this run → answer; allow-rule persisted; timers re-armed when empty', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.ask('implement', 'q2', { allowSession: false })
    h.tick(5000).user({ kind: 'answer', requestId: 'q1', decision: 'allow-session', via: 'app' })
    expect(h.fx('answer')).toEqual([
      expect.objectContaining({ requestId: 'q1', decision: 'allow-session', step: 'implement' }),
    ])
    expect(h.step('implement').status).toBe('waiting')
    h.signal('implement', {
      type: 'allow-rule',
      rule: {
        vendor: 'claude',
        kind: 'shell',
        tool: 'Bash',
        match: { argv: ['npm', 'test'] },
        source: 'exact',
      },
    })
    expect(h.state.allowRules).toHaveLength(1)
    // allowSession:false downgrades to a one-time allow.
    h.tick(1000).user({ kind: 'answer', requestId: 'q2', decision: 'allow-session', via: 'cli' })
    expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q2', decision: 'allow' })])
    expect(h.bodies('ask-resolved')).toEqual([
      expect.objectContaining({ requestId: 'q2', by: 'user', via: 'cli', decision: 'allow' }),
    ])
    expect(h.step('implement').status).toBe('running')
    expect(h.state.timers[timerId.stall('implement')]).toBe(h.now + STALL)
    expect(h.state.timers[timerId.hard('implement')]).toBe(h.now + HARD)
  })

  it('P9 waiting, Deny (app) → 3 s grace before the vendor hears anything', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    expect(h.fx('answer')).toHaveLength(0)
    expect(h.step('implement').asks[0]?.pendingDeny).toEqual({ until: h.now + 3000, via: 'app' })
    expect(h.state.timers[timerId.deny('implement', 'q1')]).toBe(h.now + 3000)
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBeUndefined()
    expect(h.step('implement').status).toBe('waiting')
  })

  it('P9u waiting(pendingDeny), asks.undo → grace cleared, ask timer back', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1', { expiresIn: 600_000 })
    const expires = h.step('implement').asks[0]?.expiresAt
    h.tick(1000).user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.tick(1000).user({ kind: 'undo-deny', requestId: 'q1' })
    expect(h.fx('clearTimer')).toEqual([{ t: 'clearTimer', id: timerId.deny('implement', 'q1') }])
    expect(h.step('implement').asks[0]?.pendingDeny).toBeUndefined()
    expect(h.state.timers[timerId.ask('implement', 'q1')]).toBe(expires)
    expect(h.fx('answer')).toHaveLength(0)
    expect(h.step('implement').status).toBe('waiting')
  })

  it('P9a grace timer [¬denyPauses] → answer deny; the vendor continues', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.fire('deny|implement')
    expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q1', decision: 'deny' })])
    expect(h.fx('answer')[0]?.why).toBeUndefined()
    expect(h.bodies('ask-resolved')).toEqual([
      expect.objectContaining({ requestId: 'q1', by: 'user', via: 'app', decision: 'deny' }),
    ])
    expect(h.step('implement').status).toBe('running')
  })

  it('P9b grace timer [denyPauses] → cancel(denied), kill after 3 s, snapshot after exit → paused(denied)', () => {
    const h = new Harness(makeConfig({ denyPauses: true })).toImplementRunning()
    h.ask('implement', 'q1')
    h.user({ kind: 'answer', requestId: 'q1', decision: 'deny', via: 'app' })
    h.fire('deny|implement')
    expect(h.fx('answer')).toEqual([
      expect.objectContaining({ requestId: 'q1', decision: 'cancel', why: 'denied' }),
    ])
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'denied' })
    expect(h.step('implement').resumeContinuation).toBe('The user denied npm test #q1; do not retry it.')
    expect(h.state.timers[timerId.kill('implement', 1)]).toBe(h.now + 3000)
    h.fire('kill|implement')
    expect(h.fx('kill')).toEqual([{ t: 'kill', step: 'implement', spawnNo: 1 }])
    h.exit('implement', { code: 1 })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'paused', step: 'implement' })])
    expect(h.state.status).toBe('paused')
    expect(h.state.phase).toBe('needs-attention')
  })

  it('P10 waiting, ask timer → cancel(ask-timeout), kill after 3 s, snapshot → paused(ask-timeout)', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1', { expiresIn: 600_000 })
    h.ask('implement', 'q2', { expiresIn: 650_000 })
    h.fire(timerId.ask('implement', 'q1'))
    expect(h.fx('answer')).toEqual([
      expect.objectContaining({ requestId: 'q1', decision: 'cancel', why: 'ask-timeout' }),
      expect.objectContaining({ requestId: 'q2', decision: 'cancel', why: 'ask-timeout' }),
    ])
    expect(h.bodies('ask-resolved')[0]).toMatchObject({ requestId: 'q1', by: 'timeout', decision: 'cancel' })
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'ask-timeout', asks: [] })
    expect(h.state.timers[timerId.kill('implement', 1)]).toBe(h.now + 3000)
    expect(h.fx('liveCount')).toEqual([{ t: 'liveCount', on: false }])
    h.exit('implement', { code: 1 })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'paused' })])
    expect(h.fx('kill')).toHaveLength(0)
  })

  it('P11 waiting, ask-withdrawn → dropped; running again once the queue is empty', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.tick(100).signal('implement', { type: 'ask-withdrawn', requestId: 'q1' })
    expect(h.bodies('ask-resolved')).toEqual([
      expect.objectContaining({ requestId: 'q1', by: 'vendor-cancel' }),
    ])
    expect(h.fx('answer')).toHaveLength(0)
    expect(h.step('implement').status).toBe('running')
    expect(h.state.timers[timerId.stall('implement')]).toBe(h.now + STALL)
  })

  it('P12 running, stall timer [no ask] → stall card → stalled', () => {
    const h = new Harness().toImplementRunning()
    h.fire('stall|implement')
    expect(h.step('implement').status).toBe('stalled')
    expect(h.state.cards).toHaveLength(1)
    expect(h.state.cards[0]?.view).toMatchObject({
      kind: 'stall',
      title: 'No output for 5m',
      blocking: false,
    })
    expect(h.state.timers[timerId.hard('implement')]).toBeDefined()
    expect(h.state.status).toBe('waiting')
    expect(h.state.phase).toBe('needs-attention')
  })

  it('P13 stalled, Keep waiting (or any event) → card cleared, keepWaitingAt = now, stall + hard re-armed', () => {
    const h = new Harness().toImplementRunning()
    h.fire('stall|implement')
    const card = h.state.cards[0]?.view.id ?? ''
    h.tick(60_000).user({ kind: 'card', cardId: card, choiceId: 'keep-waiting' })
    expect(h.state.cards).toHaveLength(0)
    expect(h.bodies('card')).toEqual([
      expect.objectContaining({ state: 'resolved', choiceId: 'keep-waiting' }),
    ])
    expect(h.step('implement')).toMatchObject({ status: 'running', keepWaitingAt: h.now })
    expect(h.state.timers[timerId.stall('implement')]).toBe(h.now + STALL)
    expect(h.state.timers[timerId.hard('implement')]).toBe(h.now + HARD)
    // An event while stalled also clears the card.
    h.fire('stall|implement')
    expect(h.step('implement').status).toBe('stalled')
    h.tick(10).ev('implement', { type: 'text', delta: 'still here' })
    expect(h.step('implement').status).toBe('running')
    expect(h.state.cards).toHaveLength(0)
  })

  it('P14 running/stalled, hard timer [no ask] → interrupt → kill → snapshot → failed(timeout_hard)', () => {
    const h = new Harness().toImplementRunning()
    h.fire('stall|implement')
    h.fire('hard|implement')
    expect(effectTypes(h.effects)).toContain('interrupt')
    expect(h.step('implement')).toMatchObject({ status: 'failed', reason: 'timeout_hard' })
    expect(h.bodies('snag').map((b) => [b.step, b.failure.category])).toEqual([['implement', 'timeout_hard']])
    expect(h.state.cards).toHaveLength(0)
    h.fire('kill|implement')
    expect(h.fx('kill')).toHaveLength(1)
    h.exit('implement', { code: 1 })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'stopped', step: 'implement' })])
    expect(h.state.status).toBe('failed')
    expect(h.state.failure).toEqual({ step: 'implement', category: 'timeout_hard' })
  })

  it('P15 running, done → artifact, usage, end snapshot + reconcile(end-of-pass) → done', () => {
    const h = new Harness().toPlanRunning()
    h.ev('plan', {
      type: 'done',
      result: `\`\`\`md\n${PLAN_TEXT}\n\`\`\``,
      usage: { input: 10, output: 5, costUsd: 0.01 },
    })
    expect(h.fx('writeOutput')).toEqual([{ t: 'writeOutput', file: 'plan', text: PLAN_TEXT, version: 1 }])
    expect(h.bodies('output')).toEqual([{ t: 'output', file: 'plan', version: 1 }])
    expect(h.bodies('usage')).toEqual([expect.objectContaining({ step: 'plan', costBasis: 'vendor' })])
    expect(h.step('plan').status).toBe('done')

    const m = new Harness().toImplementRunning()
    m.tick(1000).ev('implement', { type: 'done', result: 'Changed 1 file.', usage: { input: 1, output: 1 } })
    expect(m.step('implement').status).toBe('done')
    expect(m.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S1', step: 'implement' })])
    expect(m.fx('reconcile')).toEqual([
      expect.objectContaining({ boundary: 'end-of-pass', step: 'implement' }),
    ])
    expect(m.fx('liveCount')).toEqual([{ t: 'liveCount', on: false }])
    expect(m.bodies('usage')).toEqual([expect.objectContaining({ costBasis: 'none' })])
    expect(m.state.phase).toBe('implementing')
  })

  it('P16 running, failure [auto ∧ budget unused] → pre-retry snapshot, retry auto → running (attempt 2)', () => {
    const h = new Harness().toImplementRunning()
    h.tick(1000).ev('implement', {
      type: 'error',
      message: 'ECONNRESET',
      raw: '',
      fatal: true,
      category: 'network',
    })
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: true })
    expect(h.fx('spawn')).toHaveLength(0)
    h.exit('implement', { code: 1 })
    // Mutating: the pre-retry snapshot decides the strategy (no change since S0 → fresh).
    h.snapshot('pre-retry', 'tree-base')
    expect(h.state.timers[timerId.launch('implement')]).toBe(h.now + 5000)
    h.fire('launch|implement')
    h.passPreflight('implement')
    const [spawn] = h.fx('spawn')
    expect(spawn).toMatchObject({ attempt: 2, spawnNo: 2, launch: { fresh: {} } })
    // The budget is spent: the next failure is P17.
    h.ev('implement', { type: 'error', message: 'ECONNRESET', raw: '', fatal: true, category: 'network' })
    expect(h.step('implement').status).toBe('failed')
  })

  it('P16 resume_failed at startup → fresh without spending the budget or the attempt', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', {
      type: 'error',
      message: 'No conversation found',
      raw: '',
      fatal: true,
      category: 'resume_failed',
    })
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 1, autoRetryUsed: false })
    h.exit('implement', { code: 1 })
    h.snapshot('pre-retry', 'tree-base')
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toEqual({ fresh: { reason: 'resume-failed' } })
  })

  it('P17 running, failure [otherwise] → kill; snapshot; heal when unknown → failed(category) + snag', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', {
      type: 'error',
      message: 'Not logged in',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    expect(h.fx('kill')).toEqual([{ t: 'kill', step: 'implement', spawnNo: 1 }])
    expect(h.fx('heal')).toHaveLength(0)
    expect(h.step('implement')).toMatchObject({ status: 'failed', snagOpen: true })
    const [snag] = h.bodies('snag')
    expect(snag?.actions.map((a) => a.kind)).toEqual(['retry', 'close_run'])
    h.exit('implement', { code: 1 })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'stopped' })])

    const u = new Harness().toImplementRunning()
    u.ev('implement', { type: 'error', message: '???', raw: 'x', fatal: true })
    expect(u.fx('heal').map((x) => [x.step, x.failure.category])).toEqual([['implement', 'unknown']])
  })

  it('P18 running/waiting/stalled, Stop → asks cancelled, interrupt, kill after 3 s, stopped snapshot → cancelled', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.user({ kind: 'stop' })
    expect(h.fx('answer')).toEqual([expect.objectContaining({ requestId: 'q1', decision: 'cancel' })])
    expect(h.fx('answer')[0]?.why).toBeUndefined()
    expect(h.bodies('ask-resolved')).toEqual([expect.objectContaining({ by: 'stop' })])
    expect(h.fx('interrupt')).toHaveLength(1)
    expect(h.step('implement').status).toBe('cancelled')
    expect(h.state).toMatchObject({ status: 'cancelled', phase: 'stopping' })
    expect(h.fx('unlock')).toHaveLength(0)
    h.fire('kill|implement')
    expect(h.fx('kill')).toHaveLength(1)
    h.exit('implement', { code: 1 })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'stopped' })])
    expect(h.fx('unlock')).toHaveLength(0)
    expect(h.state.phase).toBe('done')
  })

  it('P19 paused, Resume [session ∧ canResume] → resume snapshot; --resume + continuation', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.fire(timerId.ask('implement', 'q1'))
    h.exit('implement', { code: 1 })
    h.snapshot('paused')
    h.tick(1000).user({ kind: 'resume', allowTimedOutAsk: true })
    expect(h.step('implement').status).toBe('running')
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'resume', step: 'implement' })])
    h.snapshot('resume')
    h.passPreflight('implement')
    const [spawn] = h.fx('spawn')
    expect(spawn?.launch).toEqual({
      resume: { sessionId: 'impl-session' },
      continuation: 'continue',
      lateAllow: { kind: 'shell', detail: 'npm test #q1' },
    })
    expect(spawn?.attempt).toBe(1)
    expect(spawn?.spawnNo).toBe(2)
  })

  it('P20 paused, Resume [no session / read-only] → fresh', () => {
    const h = new Harness().toImplementRunning({ session: false })
    h.ask('implement', 'q1')
    h.fire(timerId.ask('implement', 'q1'))
    h.exit('implement', { code: 1 })
    h.user({ kind: 'resume' })
    expect(h.fx('snapshot').filter((s) => s.label === 'resume')).toHaveLength(0)
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toEqual({ fresh: { reason: 'no-session' } })
  })

  it('P21 failed, Retry pass (auto / resume / fresh / keep-changes / revert-then-fresh)', () => {
    const fail = (): Harness => {
      const h = new Harness().toImplementRunning()
      h.ev('implement', {
        type: 'error',
        message: 'Not logged in',
        raw: '',
        fatal: true,
        category: 'auth_required',
      })
      h.exit('implement', { code: 1 })
      h.snapshot('stopped', 'tree-changed')
      return h
    }
    // auto, changes made, session exists → resume with the failure reason.
    const a = fail()
    a.user({ kind: 'retry', step: 'implement' })
    expect(a.step('implement')).toMatchObject({ status: 'running', attempt: 2, snagOpen: false })
    a.snapshot('pre-retry', 'tree-changed')
    a.passPreflight('implement')
    expect(a.fx('spawn')[0]?.launch).toEqual({
      resume: { sessionId: 'impl-session' },
      continuation: 'Previous attempt failed: Not logged in; continue.',
    })
    // explicit fresh
    const f = fail()
    f.user({ kind: 'retry', step: 'implement', strategy: 'fresh' })
    f.snapshot('pre-retry', 'tree-changed')
    f.passPreflight('implement')
    expect(f.fx('spawn')[0]?.launch).toEqual({ fresh: {} })
    // revert-then-fresh: back to the pass's start snapshot (S0) first, then fresh
    const r = fail()
    r.user({ kind: 'retry', step: 'implement', strategy: 'revert-then-fresh' })
    expect(r.fx('result')).toEqual([])
    r.snapshot('pre-retry', 'tree-changed')
    expect(r.fx('revert')).toEqual([expect.objectContaining({ to: 'c-S0', why: 'retry' })])
    r.send({
      t: 'revert-result',
      req: r.req((x) => x.kind === 'revert'),
      outcome: { preRevert: 'c-pre-revert', restored: ['src/a.ts'], deleted: [], skipped: [] },
    })
    r.passPreflight('implement')
    expect(r.fx('spawn')[0]?.launch).toEqual({ fresh: {} })
  })

  it('P21 auto with changes and no session → retryPartial card; keep changes → fresh; Auto takes the default', () => {
    const fail = (auto: boolean): Harness => {
      const h = new Harness(makeConfig({ auto, gates: { afterPlan: !auto, beforeFix: false } }))
      if (auto) {
        h.toPlanRunning()
        h.ev('plan', { type: 'done', result: PLAN_TEXT })
        h.exit('plan')
        h.reconcile()
        h.snapshot('S0', 'tree-base')
        h.passPreflight('implement')
      } else h.toImplementRunning({ session: false })
      h.ev('implement', { type: 'error', message: 'boom', raw: '', fatal: true, category: 'auth_expired' })
      h.exit('implement', { code: 1 })
      h.snapshot('stopped', 'tree-changed')
      h.user({ kind: 'retry', step: 'implement' })
      h.snapshot('pre-retry', 'tree-changed')
      return h
    }
    const h = fail(false)
    const card = h.state.cards.find((c) => c.view.kind === 'retryPartial')
    expect(card?.view.defaultChoice).toBe('keep-changes')
    expect(h.state.status).toBe('waiting')
    h.user({ kind: 'card', cardId: card?.view.id ?? '', choiceId: 'keep-changes' })
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toEqual({ fresh: {} })

    const a = fail(true)
    expect(a.state.cards).toHaveLength(0)
    expect(a.state.notes.some((n) => n.startsWith('Auto:'))).toBe(true)
    a.passPreflight('implement')
    expect(a.fx('spawn')).toHaveLength(1)
  })

  it('P22 failed, config_patch applied → resolved.json patch → P21', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'error', message: 'x', raw: '', fatal: true, category: 'flag_drift' })
    const patched = makeConfig()
    patched.passes.implement = { ...patched.passes.implement, model: 'sonnet' }
    h.user({ kind: 'config-patch', step: 'implement', config: patched, label: 'Use sonnet', patchId: 'p1' })
    expect(h.fx('result')).toEqual([])
    expect(h.fx('apply-patch')).toEqual([{ t: 'apply-patch', patchId: 'p1' }])
    expect(h.state.config.passes.implement.model).toBe('sonnet')
    expect(h.step('implement')).toMatchObject({ status: 'running', attempt: 2, snagOpen: false })
    // A pass that is not failed takes no patch.
    const r = new Harness().toImplementRunning()
    r.user({ kind: 'config-patch', step: 'implement', config: patched, label: 'x', patchId: 'p2' })
    expect(r.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
    expect(r.fx('apply-patch')).toEqual([])
  })

  it('P23 failed/paused, Continue without [plan] → skipped(user); Implement gets the task only', () => {
    const h = new Harness().toPlanRunning()
    h.ev('plan', { type: 'error', message: 'Not logged in', raw: '', fatal: true, category: 'auth_required' })
    h.exit('plan', { code: 1 })
    expect(h.step('plan').status).toBe('failed')
    h.user({ kind: 'skip', step: 'plan' })
    expect(h.step('plan')).toMatchObject({ status: 'skipped', reason: 'user', snagOpen: false })
    expect(h.state.plan).toMatchObject({ decided: true, text: null })
    expect(h.fx('reconcile')).toHaveLength(1)
    expect(h.state.failure).toBeUndefined()
    h.user({ kind: 'skip', step: 'implement' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'FORBIDDEN' })])
  })

  it('P24 live, relaunch → orphan sweep; interrupted snapshot → paused(interrupted); never auto-resume', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.send({ t: 'relaunch' })
    expect(h.fx('sweep')).toHaveLength(1)
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'interrupted' })])
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'interrupted', asks: [] })
    expect(h.step('implement').proc?.live).toBe(false)
    expect(h.fx('spawn')).toHaveLength(0)
    expect(h.state.timers).toEqual({})
    expect(h.state.status).toBe('paused')
    // the gate card of another run would stay; here: resume works from the paused state.
    h.snapshot('interrupted')
    h.user({ kind: 'resume' })
    h.snapshot('resume')
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toMatchObject({
      resume: { sessionId: 'impl-session' },
      continuation: 'Continue. The previous turn was interrupted.',
    })
  })

  it('P25 paused/failed, Stop / Close run → cancelled; failed ⇒ outcome failed, failure kept', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', {
      type: 'error',
      message: 'Not logged in',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    h.exit('implement', { code: 1 })
    h.snapshot('stopped')
    h.user({ kind: 'close' })
    expect(h.step('implement').status).toBe('cancelled')
    expect(h.state).toMatchObject({
      status: 'cancelled',
      outcome: 'failed',
      failure: { step: 'implement', category: 'auth_required' },
    })
    const p = new Harness().toImplementRunning()
    p.ask('implement', 'q1')
    p.fire(timerId.ask('implement', 'q1'))
    p.user({ kind: 'stop' })
    expect(p.step('implement').status).toBe('cancelled')
    expect(p.state.outcome).toBeUndefined()
  })

  it('P26 running/waiting/stalled, app quit → asks dropped unanswered, interrupt, kill after 3 s → paused(interrupted-by-quit)', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.send({ t: 'quit' })
    expect(h.fx('answer')).toHaveLength(0)
    expect(h.bodies('ask-resolved')).toEqual([expect.objectContaining({ requestId: 'q1', by: 'stop' })])
    expect(h.fx('interrupt')).toHaveLength(1)
    expect(h.state.timers[timerId.kill('implement', 1)]).toBe(h.now + 3000)
    expect(h.step('implement')).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
    h.exit('implement', { code: 1 })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'interrupted' })])
  })
})

describe('run rows', () => {
  it('R1 runs.start [preflight ok] → run.json + index upsert → queued, lock requested', () => {
    const h = new Harness()
    const r = h.create()
    expect(effectTypes(r.effects)).toEqual(['emit:run-status', 'index', 'lock', 'persist'])
    expect(h.bodies('run-status')).toEqual([{ t: 'run-status', status: 'queued', phase: 'queued' }])
    expect(h.fx('persist')).toEqual([{ t: 'persist', force: true }])
    expect(h.state.lock).toBe('requested')
  })

  it('R2 queued, lock acquired → authoritative preflight → run-start snapshot, then Plan spawns → running', () => {
    const h = new Harness()
    h.create()
    h.lock()
    expect(h.fx('preflight')).toEqual([expect.objectContaining({ mode: 'authoritative' })])
    expect(h.state).toMatchObject({ status: 'running', phase: 'preflight', lock: 'held' })
    h.preflight()
    expect(h.step('prepare')).toMatchObject({ status: 'skipped', reason: 'in place' })
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'run-start' })])
    // Plan's launch starts with the snapshot request (its pass-boundary preflight runs meanwhile) …
    expect(h.fx('preflight')).toEqual([expect.objectContaining({ mode: 'passBoundary', step: 'plan' })])
    expect(h.fx('spawn')).toHaveLength(0)
    expect(h.state.phase).toBe('planning')
    // … but Plan never spawns before run-start has answered, so a write Plan makes is never folded into it.
    h.passPreflight('plan')
    expect(h.fx('spawn')).toHaveLength(0)
    expect(h.state.flow.runStart).toBe('requested')
    expect(h.state).toMatchObject({ status: 'running', phase: 'planning' })
    h.snapshot('run-start', 'tree-base')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
    expect(h.step('plan').proc).toMatchObject({ live: true })
  })

  it('R2 Plan spawns after a failed run-start snapshot too (with its note); the plan-end guard then keeps the changes', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight()
    h.passPreflight('plan')
    expect(h.fx('spawn')).toHaveLength(0)
    h.snapshotFail('run-start')
    expect(h.state.flow.runStart).toBe('failed')
    expect(h.state.notes).toContainEqual(expect.stringContaining('The run-start snapshot failed'))
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
  })

  it('R2 the run-start answer arriving first: Plan spawns as soon as its pass-boundary preflight answers', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight()
    h.snapshot('run-start', 'tree-base')
    expect(h.fx('spawn')).toHaveLength(0)
    h.passPreflight('plan')
    expect(h.fx('spawn')).toEqual([expect.objectContaining({ step: 'plan' })])
  })

  it('R2b queued, lock acquired, preflight blocking → failed + preflight card, lock released, no snapshot; Recheck', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight(
      blockedReport({ category: 'git_missing', title: 'Git not found' }, { title: 'Folder too large' }),
    )
    expect(h.step('preflight')).toMatchObject({ status: 'failed', reason: 'git_missing' })
    const card = h.state.cards[0]?.view
    expect(card).toMatchObject({ kind: 'preflight', blocking: true, title: '2 problems block this run' })
    expect(card?.choices.map((c) => c.id)).toEqual(['recheck', 'cancel'])
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.fx('snapshot')).toHaveLength(0)
    expect(h.state).toMatchObject({ status: 'waiting', phase: 'needs-attention', lock: 'none' })
    h.user({ kind: 'card', cardId: card?.id ?? '', choiceId: 'recheck' })
    expect(h.fx('lock')).toHaveLength(1)
    // Until the scheduler grants the lock again the run is queued (not "running preflight").
    expect(h.step('preflight')).toMatchObject({ status: 'queued', attempt: 1 })
    expect(h.state).toMatchObject({ status: 'queued', phase: 'queued', lock: 'requested' })
    h.lock()
    expect(h.step('preflight')).toMatchObject({ status: 'running', attempt: 2 })
    expect(h.state).toMatchObject({ status: 'running', phase: 'preflight' })
    h.preflight()
    expect(h.step('preflight').status).toBe('done')
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'run-start' })])
  })

  it('R3 Plan done, INSUFFICIENT_CONTEXT → card (even in Auto) → waiting; re-plan or proceed', () => {
    const h = new Harness(
      makeConfig({ auto: true, gates: { afterPlan: false, beforeFix: false } }),
    ).toPlanRunning()
    h.ev('plan', { type: 'done', result: 'INSUFFICIENT_CONTEXT: which CLI file?' })
    const card = h.state.cards[0]?.view
    expect(card).toMatchObject({ kind: 'insufficientContext', body: 'which CLI file?', blocking: true })
    expect(card?.defaultChoice).toBeUndefined()
    expect(h.step('plan').status).toBe('waiting')
    expect(h.state).toMatchObject({ status: 'waiting', phase: 'plan-review' })
    h.exit('plan')
    h.user({ kind: 'card', cardId: card?.id ?? '', choiceId: 'replan', input: 'add --version to src/cli.ts' })
    expect(h.state.task).toBe('add --version to src/cli.ts')
    expect(h.step('plan')).toMatchObject({ status: 'running', attempt: 2, autoRetryUsed: false })
    h.passPreflight('plan')
    expect(h.fx('spawn')).toHaveLength(1)
    h.ev('plan', { type: 'done', result: 'INSUFFICIENT_CONTEXT: still unclear' })
    const again = h.state.cards[0]?.view.id ?? ''
    h.exit('plan')
    h.user({ kind: 'card', cardId: again, choiceId: 'proceed' })
    expect(h.step('plan').status).toBe('done')
    expect(h.state.plan).toMatchObject({ decided: true, text: null })
    expect(h.fx('reconcile')).toHaveLength(1)
  })

  it('R4 Plan done → gate:afterPlan; Approve with edits writes plan.original.md + plan.md; Auto skips the gate', () => {
    const h = new Harness().toPlanGate()
    const card = h.state.cards[0]?.view
    expect(card).toMatchObject({ kind: 'gate:afterPlan', body: PLAN_TEXT, defaultChoice: 'approve' })
    expect(h.state).toMatchObject({ status: 'waiting', phase: 'plan-review' })
    h.approve(`${PLAN_TEXT}\n2. Add a test`)
    expect(h.fx('writeOutput')).toEqual([
      { t: 'writeOutput', file: 'plan.original', text: PLAN_TEXT, version: 1 },
      { t: 'writeOutput', file: 'plan', text: `${PLAN_TEXT}\n2. Add a test`, version: 2 },
    ])
    expect(h.state.plan).toMatchObject({ decided: true, edited: true, text: `${PLAN_TEXT}\n2. Add a test` })
    expect(h.state.phase).toBe('implementing')

    const a = new Harness(
      makeConfig({ auto: true, gates: { afterPlan: false, beforeFix: false } }),
    ).toPlanRunning()
    a.ev('plan', { type: 'done', result: PLAN_TEXT })
    expect(a.state.cards).toHaveLength(0)
    expect(a.state.plan.decided).toBe(true)
    expect(a.fx('reconcile')).toHaveLength(1)
  })

  it('R5 pre-Implement boundary: reconcile(pre-implement) → S0 → Implement P1; info verdicts become notes', () => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.reconcile('pre-implement', ['3 files changed during planning'])
    expect(h.state.notes).toContain('3 files changed during planning')
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'S0' })])
    h.snapshot('S0')
    h.passPreflight('implement')
    expect(h.fx('spawn')).toHaveLength(1)
  })

  it('R13 any non-terminal, Stop / Close run → changes kept, toast; lock released after the stopped snapshot', () => {
    const h = new Harness().toPlanGate()
    h.user({ kind: 'stop' })
    expect(h.fx('notify')).toEqual([{ t: 'notify', kind: 'stopped' }])
    expect(h.bodies('card')).toEqual([expect.objectContaining({ state: 'resolved' })])
    expect(h.fx('snapshot')).toEqual([expect.objectContaining({ label: 'stopped' })])
    expect(h.fx('unlock')).toHaveLength(0)
    h.snapshot('stopped')
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.state).toMatchObject({ status: 'cancelled', phase: 'done', lock: 'none' })
    expect(h.state.outcome).toBeUndefined()
    h.user({ kind: 'stop' })
    expect(h.fx('result')).toEqual([expect.objectContaining({ code: 'CONFLICT' })])
  })

  it.todo('R6 Implement done → S1 / verify:1 / Review ∥ Critic')
  it.todo('R7 verify:1 terminal')
  it.todo('R8 Review/Critic join')
  it.todo('R9 beforeFix card')
  it.todo('R10 pre-Fix boundary')
  it.todo('R11 Fix done')
  it.todo('R12 worktree finalize')
})

describe('Plan → Implement build: steps after Implement', () => {
  const finish = (tree: string, ctx: ReducerContext = DEFAULT_CONTEXT): Harness => {
    const h = new Harness(makeConfig(), ctx).toImplementRunning()
    h.ev('implement', { type: 'done', result: 'done' })
    h.exit('implement')
    h.reconcile('end-of-pass')
    h.snapshot('S1', tree)
    return h
  }

  it('tree(S0) = tree(S1) → completed(no-changes); later steps skipped "no changes"; lock released', () => {
    const h = finish('tree-base')
    expect(h.state).toMatchObject({ status: 'completed', phase: 'done', outcome: 'no-changes', lock: 'none' })
    expect(h.step('review')).toMatchObject({ status: 'skipped', reason: 'no changes' })
    expect(h.fx('unlock')).toHaveLength(1)
    expect(h.fx('notify')).toEqual([{ t: 'notify', kind: 'completed' }])
    expect(h.bodies('run-status').at(-1)).toEqual({
      t: 'run-status',
      status: 'completed',
      phase: 'done',
      outcome: 'no-changes',
    })
  })

  it('changes → later steps skipped by reason → completed(clean)', () => {
    const h = finish('tree-changed')
    expect(h.state.outcome).toBe('clean')
    expect(h.step('verify:1')).toMatchObject({ status: 'skipped', reason: 'verify off' })
    expect(h.step('review')).toMatchObject({ status: 'skipped', reason: 'disabled' })
    expect(h.step('finalize')).toMatchObject({ status: 'skipped', reason: 'in place' })
  })

  it('an enabled Review outside the build is skipped "not in this build"', () => {
    const cfg = makeConfig()
    // The review sequence puts Review in DEFAULT_CONTEXT's build; this keeps checking the P2 reason with the Plan → Implement build.
    const h = new Harness(
      {
        ...cfg,
        passes: { ...cfg.passes, review: { ...cfg.passes.review, enabled: true } },
      },
      { ...DEFAULT_CONTEXT, buildSteps: PLAN_IMPLEMENT_BUILD_STEPS },
    )
    h.toImplementRunning()
    h.ev('implement', { type: 'done', result: 'done' })
    h.exit('implement')
    h.snapshot('S1', 'tree-changed')
    expect(h.step('review')).toMatchObject({ status: 'skipped', reason: 'not in this build' })
  })

  it('while S1 is pending the run is still implementing', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'done' })
    h.exit('implement')
    expect(h.state).toMatchObject({ status: 'running', phase: 'implementing' })
    expect(h.state.boundary).toEqual({ name: 'post-implement', step: 'implement' })
  })
})
