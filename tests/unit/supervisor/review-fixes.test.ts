// Regression tests for review findings on the reducer: adapter meta payloads (usageApprox /
// resumeIgnored), R2b Recheck while the lock is elsewhere, retryPartial across relaunch/quit, P19 "Allow & resume"
// end to end (rule → allowRules → StartOptions), and relaunch re-issuing owed work from the state.
import { describe, expect, it } from 'vitest'
import type { AllowRule } from '@shared/events.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { toRunSummary, toStepView } from '@core/supervisor/derive.ts'
import { startOptionsFor } from '@core/supervisor/effects.ts'
import { needsRelaunch } from '@core/supervisor/recovery.ts'
import { timerId } from '@core/supervisor/timers.ts'
import { Harness, blockedReport } from './helpers.ts'

describe('meta signals with the adapter’s real payloads', () => {
  it('usageApprox reaches the views (approximate tokens, cost basis none); the next spawn clears it', () => {
    const h = new Harness().toImplementRunning()
    h.signal('implement', {
      type: 'meta',
      key: 'usageApprox',
      value: { reason: 'counter-reset', fields: ['input'] },
    })
    h.ev('implement', { type: 'done', result: 'ok', usage: { input: 10, output: 5, costUsd: 0.5 } })
    expect(toStepView(h.step('implement'))).toMatchObject({
      usageApprox: true,
      usage: { input: 10, output: 5 },
      cost: { usd: null, basis: 'none' },
    })
    const sum = toRunSummary(h.state)
    expect(sum.steps.find((r) => r.key === 'implement')).toMatchObject({
      usageApprox: true,
      costBasis: 'none',
    })
    expect(sum.progress.costUsd).toBeNull()

    // `false` / `null` values do not flag; exact usage keeps its vendor cost.
    const e = new Harness().toImplementRunning()
    e.signal('implement', { type: 'meta', key: 'usageApprox', value: false })
    e.signal('implement', { type: 'meta', key: 'resumeIgnored', value: null })
    e.ev('implement', { type: 'done', result: 'ok', usage: { input: 10, output: 5, costUsd: 0.5 } })
    expect(e.step('implement').sessionNote).toBeUndefined()
    const v = toStepView(e.step('implement'))
    expect(v.usageApprox).toBeUndefined()
    expect(v.cost).toEqual({ usd: 0.5, basis: 'vendor', apiEquivalent: false })

    // A new spawn starts without the flag (its own `done` replaces the usage).
    const r = new Harness().toImplementRunning()
    r.signal('implement', { type: 'meta', key: 'usageApprox', value: { reason: 'resumed-without-base' } })
    r.ask('implement', 'q1')
    r.fire(timerId.ask('implement', 'q1'))
    r.exit('implement', { code: 1 })
    r.snapshot('paused')
    r.user({ kind: 'resume' })
    r.snapshot('resume')
    r.passPreflight('implement')
    expect(r.fx('spawn')).toHaveLength(1)
    expect(r.step('implement').usageApprox).toBeUndefined()
  })

  it('resumeIgnored (`{route, reason}`) sets the session note and logs it in a step-status body', () => {
    const h = new Harness().toImplementRunning()
    h.signal('implement', {
      type: 'meta',
      key: 'resumeIgnored',
      value: {
        route: 'plan',
        reason: 'Only edit passes can resume a Claude session; this one starts fresh.',
      },
    })
    expect(h.step('implement').sessionNote).toBe('the CLI ignored --resume and started a fresh session')
    expect(h.bodies('step-status')).toEqual([
      expect.objectContaining({
        step: 'implement',
        sessionNote: expect.stringMatching(/fresh session/) as unknown,
      }),
    ])
  })
})

describe('R2b Recheck while another run holds the folder', () => {
  it('the run reads queued (not "running preflight") until the lock is granted again', () => {
    const h = new Harness()
    h.create()
    h.lock()
    h.preflight(blockedReport({ category: 'auth_expired', title: 'Login needed' }))
    const card = h.state.cards[0]?.view
    h.user({ kind: 'card', cardId: card?.id ?? '', choiceId: 'recheck' })
    expect(h.fx('lock')).toHaveLength(1)
    expect(h.step('preflight')).toMatchObject({ status: 'queued', attempt: 1 })
    expect(h.state).toMatchObject({ status: 'queued', phase: 'queued', lock: 'requested' })
    expect(h.state.failure).toBeUndefined()
    expect(h.fx('preflight')).toEqual([])
    h.lock()
    expect(h.step('preflight')).toMatchObject({ status: 'running', attempt: 2 })
    expect(h.fx('preflight')).toEqual([expect.objectContaining({ mode: 'authoritative' })])
    expect(h.state).toMatchObject({ status: 'running', phase: 'preflight' })
  })
})

describe('retryPartial across relaunch and quit', () => {
  it('the card and its launch are left as they are; the user’s choice still continues the retry', () => {
    const h = new Harness().toImplementRunning({ session: false })
    h.ev('implement', { type: 'error', message: 'boom', raw: '', fatal: true, category: 'auth_expired' })
    h.exit('implement', { code: 1 })
    h.snapshot('stopped', 'tree-changed')
    h.user({ kind: 'retry', step: 'implement' })
    h.snapshot('pre-retry', 'tree-changed')
    const card = h.state.cards.find((c) => c.view.kind === 'retryPartial')
    expect(card).toBeDefined()
    const id = card?.view.id ?? ''
    // Boot recovery leaves it to the user (restoreHolder, no relaunch).
    expect(needsRelaunch(h.state)).toBe(false)
    for (const t of ['relaunch', 'quit'] as const) {
      h.send({ t })
      expect(h.state.cards.map((c) => c.view.id)).toEqual([id])
      expect(h.bodies('card')).toEqual([])
      expect(h.fx('sweep')).toEqual([])
      expect(h.step('implement')).toMatchObject({ status: 'running', launch: { card: id } })
      expect(h.state.status).toBe('waiting')
    }
    h.user({ kind: 'card', cardId: id, choiceId: 'keep-changes' })
    h.passPreflight('implement')
    expect(h.fx('spawn')[0]?.launch).toEqual({ fresh: {} })
  })
})

describe('P19 Allow & resume', () => {
  const rule: AllowRule = {
    vendor: 'claude',
    kind: 'shell',
    tool: 'Bash',
    match: { argv: ['npm', 'test'] },
    nativeRules: ['Bash(npm test)'],
    source: 'exact',
  }

  const timedOut = (o: { rule?: boolean } = {}): Harness => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.fire(timerId.ask('implement', 'q1'))
    expect(h.fx('answer')).toEqual([expect.objectContaining({ decision: 'cancel', why: 'ask-timeout' })])
    if (o.rule !== false) {
      // A rule for another request, or a malformed one, is ignored.
      h.signal('implement', { type: 'meta', key: 'lateAllowRule', value: { requestId: 'other', rule } })
      h.signal('implement', {
        type: 'meta',
        key: 'lateAllowRule',
        value: { requestId: 'q1', rule: { vendor: 'claude', kind: 'shell', tool: 'Bash', match: {} } },
      })
      expect(h.step('implement').timedOutAsk?.rule).toBeUndefined()
      h.signal('implement', { type: 'meta', key: 'lateAllowRule', value: { requestId: 'q1', rule } })
    }
    h.exit('implement', { code: 1 })
    h.snapshot('paused')
    return h
  }

  it('the exact rule the adapter reported becomes an allow-rule of the run and reaches StartOptions', () => {
    const h = timedOut()
    expect(h.state.allowRules).toEqual([])
    h.user({ kind: 'resume', allowTimedOutAsk: true })
    expect(h.state.allowRules).toEqual([rule])
    expect(h.last?.transition).toBe(true)
    h.snapshot('resume')
    h.passPreflight('implement')
    const spawn = h.fx('spawn')[0]
    expect(spawn?.launch).toMatchObject({
      resume: { sessionId: 'impl-session' },
      lateAllow: { kind: 'shell', detail: 'npm test #q1', rule },
    })
    if (spawn === undefined) return
    const o = startOptionsFor({
      runId: h.state.runId,
      cwd: h.state.folder,
      config: resolveBuiltinConfig({ profile: 'claude-only' }),
      state: h.state,
      spawn,
      prompt: 'continue',
    })
    expect(o.allowRules).toEqual([rule])
  })

  it('"Resume (keep denied)" adds nothing; without an adapter rule a note says the pass may ask again', () => {
    const k = timedOut()
    k.user({ kind: 'resume' })
    expect(k.state.allowRules).toEqual([])
    const n = timedOut({ rule: false })
    n.user({ kind: 'resume', allowTimedOutAsk: true })
    expect(n.state.allowRules).toEqual([])
    expect(n.state.notes.some((x) => x.includes('could not be turned into a rule'))).toBe(true)
  })
})

describe('nested repositories (not in the shadow tree)', () => {
  const note = 'Changes inside app/ (a separate git repository) are not in Dim Factory’s snapshots.'
  const run = (s0: string, s1: string): Harness => {
    const h = new Harness().toPlanGate()
    h.approve()
    h.reconcile()
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('S0'),
      commit: 'c0',
      tree: 'same',
      nested: s0,
      warnings: [note],
    })
    h.passPreflight('implement')
    h.ev('implement', { type: 'done', result: 'ok' })
    h.reconcile('end-of-pass')
    h.send({
      t: 'snapshot-done',
      req: h.snapReq('S1'),
      commit: 'c0',
      tree: 'same',
      nested: s1,
      warnings: [note],
    })
    return h
  }

  it('an edit only inside a nested repository is a change, not no-changes; the note is shown once', () => {
    const h = run('fp-before', 'fp-after')
    expect(h.state).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(h.state.notes.filter((n) => n === note)).toHaveLength(1)
    const same = run('fp', 'fp')
    expect(same.state).toMatchObject({ status: 'completed', outcome: 'no-changes' })
  })
})

describe('relaunch re-issues owed run-level work from the state', () => {
  it('the end snapshot of a finished mutating pass and an in-flight run-start, without request ids', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', { type: 'done', result: 'ok' })
    expect(h.step('implement').endSnapStatus).toBe('requested')
    // run.json projected from the log carries no request ids.
    h.state = { ...h.state, requests: {} }
    h.send({ t: 'relaunch' })
    expect(h.fx('sweep')).toHaveLength(1)
    expect(h.fx('snapshot').map((s) => s.label)).toEqual(['S1', 'interrupted'])
    h.snapshot('S1', 'tree-new')
    expect(h.state).toMatchObject({ status: 'completed', outcome: 'clean' })

    const r = new Harness()
    r.create()
    r.lock()
    r.preflight()
    r.state = { ...r.state, requests: {} }
    r.send({ t: 'relaunch' })
    expect(r.fx('snapshot').map((s) => s.label)).toEqual(['run-start', 'interrupted'])
  })
})
