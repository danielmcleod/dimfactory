// Attention surfaces, events, notification rules: the facts core states for each
// `notify` effect — asks (vendor name, short detail, countdown, allowSession, defaultToNo, burst size), gates (card
// kind), completed (outcome, duration, cost), failed (category title) — and the attention items' timing.
import { describe, expect, it } from 'vitest'
import { aggregateAttention } from '@core/supervisor/attention.ts'
import { NOTIFY_DETAIL_MAX, notificationFacts, shortDetail } from '@core/supervisor/notify-facts.ts'
import type { RunState } from '@core/supervisor/types.ts'
import { Harness, failure, makeConfig } from './helpers.ts'

const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const vendorName = (v: string): string => names[v] ?? v

function factsOf(h: Harness, kind: 'ask' | 'gate' | 'card' | 'completed' | 'failed' | 'stopped') {
  const n = h.log.filter((e) => e.t === 'notify' && e.kind === kind).at(-1)
  expect(n, `notify ${kind}`).toBeDefined()
  if (n?.t !== 'notify') throw new Error('unreachable')
  return notificationFacts(n, h.state, { vendorName, at: h.now })
}

describe('notification facts', () => {
  it('ask: vendor display name, first-line detail, expiresAt, allowSession, defaultToNo, waiting count', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', {
      type: 'ask',
      requestId: 'q1',
      kind: 'shell',
      detail: 'Bash: npm --version\nPrint npm version (first run)\nThis command requires approval',
      reason: 'This command requires approval',
      expiresAt: h.now + 600_000,
      allowSession: false,
      defaultToNo: true,
    })
    const f = factsOf(h, 'ask')
    expect(f.run).toEqual({
      runId: h.state.runId,
      displayNo: 7,
      title: 'add a --version flag',
      folder: 'C:\\tmp\\ts-small',
      auto: false,
    })
    expect(f.ask).toEqual({
      requestId: 'q1',
      step: 'implement',
      vendor: 'claude',
      vendorName: 'Claude',
      kind: 'shell',
      detail: 'Bash: npm --version',
      reason: 'This command requires approval',
      expiresAt: h.now + 600_000,
      allowSession: false,
      defaultToNo: true,
      waiting: 1,
    })
    h.ask('implement', 'q2')
    expect(factsOf(h, 'ask').ask).toEqual(
      expect.objectContaining({ requestId: 'q2', waiting: 2, allowSession: true }),
    )
    expect(factsOf(h, 'ask').ask?.defaultToNo).toBeUndefined()
  })

  it('an ask that is gone by the time the facts are read has none', () => {
    const h = new Harness().toImplementRunning()
    h.ask('implement', 'q1')
    h.user({ kind: 'answer', requestId: 'q1', decision: 'allow', via: 'notification' })
    const f = notificationFacts({ kind: 'ask', step: 'implement', requestId: 'q1' }, h.state, {
      vendorName,
      at: h.now,
    })
    expect(f.ask).toBeUndefined()
    expect(f.run.runId).toBe(h.state.runId)
  })

  it('gate: the card kind and title', () => {
    const h = new Harness().toPlanGate()
    const f = factsOf(h, 'gate')
    expect(f.card).toEqual(
      expect.objectContaining({
        kind: 'gate:afterPlan',
        blocking: true,
        step: 'plan',
        id: h.state.cards[0]?.view.id,
      }),
    )
  })

  it('completed: outcome, wall duration and cost', () => {
    const h = new Harness(makeConfig({ gates: { afterPlan: false, beforeFix: false } })).toPlanRunning()
    h.ev('plan', { type: 'done', result: '## Goal\nx', usage: { input: 1, output: 1, costUsd: 0.25 } })
    h.exit('plan')
    h.reconcile()
    h.snapshot('S0', 'tree-base')
    h.passPreflight('implement')
    h.tick(60_000).ev('implement', {
      type: 'done',
      result: 'ok',
      usage: { input: 1, output: 1, costUsd: 0.5 },
    })
    h.exit('implement')
    h.snapshot('S1', 'tree-base')
    expect(h.state.outcome).toBe('no-changes')
    const f = factsOf(h, 'completed')
    expect(f.completed).toEqual({
      outcome: 'no-changes',
      durationMs: (h.state.endedAt as number) - h.state.createdAt,
      costUsd: 0.75,
    })
  })

  it('failed: the step, its category and the title with the vendor name', () => {
    const h = new Harness().toImplementRunning()
    h.ev('implement', {
      type: 'error',
      message: 'Not logged in',
      raw: '',
      fatal: true,
      category: 'auth_required',
    })
    h.exit('implement', { code: 1, failure: failure('auth_required') })
    const f = factsOf(h, 'failed')
    expect(f.failed).toEqual({
      step: 'implement',
      category: 'auth_required',
      title: 'Claude needs you to log in',
    })
  })

  it('stopped: run facts only', () => {
    const h = new Harness().toImplementRunning()
    h.user({ kind: 'stop' })
    const f = factsOf(h, 'stopped')
    expect(Object.keys(f)).toEqual(['run'])
  })

  it('shortDetail: first non-empty line, clipped with an ellipsis', () => {
    expect(shortDetail('\n  Bash: ls  \nmore')).toBe('Bash: ls')
    const long = 'x'.repeat(NOTIFY_DETAIL_MAX + 10)
    expect(shortDetail(long)).toHaveLength(NOTIFY_DETAIL_MAX)
    expect(shortDetail(long).endsWith('…')).toBe(true)
    expect(shortDetail('')).toBe('')
  })
})

describe('attention timing (Dashboard, tray and notifications agree)', () => {
  it('an ask item carries since = raisedAt and the ask expiresAt; a resume after sleep moves expiresAt', () => {
    const h = new Harness().toImplementRunning()
    h.tick(5000).ask('implement', 'q1')
    const raisedAt = h.now
    const item = (s: RunState) => aggregateAttention([s]).items.find((i) => i.kind === 'ask')
    const a = item(h.state)
    expect(a?.since).toBe(raisedAt)
    expect(a?.kind === 'ask' && a.ask.expiresAt).toBe(raisedAt + 600_000)
    h.tick(1000).send({ t: 'power', state: 'suspend' })
    h.tick(3_600_000).send({ t: 'power', state: 'resume' })
    const b = item(h.state)
    expect(b?.since).toBe(raisedAt)
    expect(b?.kind === 'ask' && b.ask.expiresAt).toBe(raisedAt + 600_000 + 3_600_000)
  })

  it('a stalled step is attention since its last output', () => {
    const h = new Harness().toImplementRunning()
    const last = h.step('implement').lastEventAt
    h.fire('stall|implement')
    const s = aggregateAttention([h.state]).items.find((i) => i.kind === 'stalled')
    expect(s?.since).toBe(last)
  })
})
