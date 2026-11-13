// fast-check invariants over the full review sequence (Plan → Implement → Review ∥ Critic → gate → Fix): the Plan → Implement
// invariants (no mutating spawn without its start snapshot, no Plan spawn before run-start, one live process per
// step, no unlock while a process lives, terminal pass states stay terminal, no stall/hard timer with a pending
// ask, run.json round-trips) plus
//   Fix spawns only after the join (both reviewers done/skipped, R8 decided) · the Review ∥ Critic barrier never
//   strands a launch · outcomes agree with the steps (fixed ⇒ Fix done, clean ⇒ skip rule, no-changes ⇒ nothing
//   reviewed) · a done reviewer has a parsed source · the gate and the findings-review phase go together ·
//   the Fix selection is a subset of the findings.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { STEP_KEYS, TERMINAL_PASS_STATUSES, configPassOf } from '@shared/run.ts'
import type { PassStatus } from '@shared/run.ts'
import { anyLiveProc } from '@core/supervisor/derive.ts'
import { fixSkipRuleHolds, isMutatingStep, reduce } from '@core/supervisor/machine.ts'
import type { EngineEvent, Reduction, RunConfig, RunState } from '@core/supervisor/types.ts'
import { act, findingsResult, interpret, newState } from './driver.ts'
import type { Act } from './driver.ts'
import { reviewConfig } from './helpers.review.ts'

const TERMINAL: readonly PassStatus[] = TERMINAL_PASS_STATUSES

type Act13 = Act | { k: 'select'; mask: number } | { k: 'empty' }

// Mostly well-behaved progress, so streams reach the end of the sequence; the Plan → Implement noise (asks, failures, stops,
// relaunches, …) stays in at a lower rate.
const act13: fc.Arbitrary<Act13> = fc.oneof(
  { weight: 30, arbitrary: fc.record({ k: fc.constant('go' as const), alt: fc.boolean() }) },
  { weight: 6, arbitrary: act },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('select' as const), mask: fc.nat({ max: 15 }) }) },
  { weight: 5, arbitrary: fc.constant<Act13>({ k: 'empty' }) },
)

const config13: fc.Arbitrary<RunConfig> = fc
  .record({
    auto: fc.boolean(),
    beforeFix: fc.boolean(),
    review: fc.constantFrom(true, true, true, false),
    critic: fc.constantFrom(true, true, true, false),
    fix: fc.constantFrom(true, true, true, false),
    reuseSession: fc.constantFrom(true, true, false),
    otherVendor: fc.constantFrom(false, false, false, true),
    denyPauses: fc.boolean(),
  })
  .map((o) => {
    const c = reviewConfig({
      auto: o.auto,
      beforeFix: o.beforeFix,
      review: o.review,
      critic: o.critic,
      fix: o.fix,
      reuseSession: o.reuseSession,
      ...(o.otherVendor ? { fixVendor: 'codex' } : {}),
    })
    c.denyPauses = o.denyPauses
    return c
  })

/** The base acts, plus "Continue with a subset" at an open gate:beforeFix. */
function interpret13(s: RunState, now: number, a: Act13): ReturnType<typeof interpret> {
  if (a.k === 'empty') {
    // An empty reviewer output (the parse says `empty`): retry with the budget, then the card / Auto.
    const req = Object.keys(s.requests).find((id) => s.requests[id]?.kind === 'findings')
    return req === undefined ? null : { body: findingsResult(req, 'empty'), at: now }
  }
  if (a.k !== 'select') return interpret(s, now, a)
  const gate = s.cards.find((c) => c.view.kind === 'gate:beforeFix')
  if (gate === undefined) return null
  const ids = (s.findings?.list ?? []).map((f) => f.id).filter((_, i) => (a.mask >> i) % 2 === 1)
  return {
    body: { t: 'user', cmd: { kind: 'card', cardId: gate.view.id, choiceId: 'continue', input: ids } },
    at: now,
  }
}

function drive13(
  config: RunConfig,
  acts: readonly Act13[],
  onStep: (prev: RunState, e: EngineEvent, r: Reduction) => void,
): RunState {
  let s = newState(config)
  let now = 1_000_000
  const step = (e: EngineEvent): void => {
    const r = reduce(s, e)
    onStep(s, e, r)
    s = r.state
  }
  step({ t: 'created', at: now })
  for (const a of acts) {
    const x = interpret13(s, now, a)
    if (x === null) continue
    if (x === 'tick') {
      now += a.k === 'tick' ? a.ms : 0
      continue
    }
    now = x.at
    step({ ...x.body, at: x.at })
  }
  return s
}

function check(prev: RunState, e: EngineEvent, r: Reduction): void {
  const next = r.state
  const spawned = new Set<string>()
  for (const fx of r.effects) {
    if (fx.t === 'spawn') {
      if (isMutatingStep(fx.step)) expect(next.steps[fx.step].startSnap, 'start snapshot').toBeDefined()
      if (fx.step === 'plan')
        expect(['done', 'failed'], 'plan before run-start').toContain(next.flow.runStart)
      expect(prev.steps[fx.step].proc?.live === true, `${fx.step} already live`).toBe(false)
      expect(spawned.has(fx.step), `${fx.step} spawned twice`).toBe(false)
      spawned.add(fx.step)
      expect(next.stop).toBeUndefined()
      expect(next.config.passes[configPassOf(fx.step)].enabled).toBe(true)
      if (fx.step === 'fix') {
        // Fix only after the join and R8's decision (gate continued, or no gate).
        for (const k of ['review', 'critic'] as const)
          expect(['done', 'skipped']).toContain(next.steps[k].status)
        expect(next.flow).toMatchObject({ review: 'joined', fix: 'started' })
        expect(next.findings?.selected.length ?? 0).toBeGreaterThan(0)
        expect(fx.launch.notes).toBeDefined()
        if (fx.attempt === 1 && fx.spawnNo === 1) expect(fx.launch.session).toBeDefined()
      }
      if (fx.step === 'review' || fx.step === 'critic') {
        expect(['running', 'post-review', 'joined']).toContain(next.flow.review)
        expect(next.steps.implement.status).toBe('done')
      }
    }
    if (fx.t === 'unlock') {
      expect(anyLiveProc(next), 'unlock with a live process').toBe(false)
      expect(next.lock).toBe('none')
    }
  }
  for (const k of STEP_KEYS) {
    if (TERMINAL.includes(prev.steps[k].status))
      expect(next.steps[k].status, `${k} left terminal`).toBe(prev.steps[k].status)
    const st = next.steps[k]
    if (st.asks.length > 0 || next.suspendedAt !== undefined) {
      expect(next.timers[`stall|${k}`]).toBeUndefined()
      expect(next.timers[`hard|${k}`]).toBeUndefined()
    }
  }
  // The barrier never strands a launch: a ready reviewer launch always waits on a sibling still in its pipeline.
  for (const [k, o] of [
    ['review', 'critic'],
    ['critic', 'review'],
  ] as const) {
    const L = next.steps[k].launch
    if (L?.ready === true && next.stop === undefined) {
      const other = next.steps[o].launch
      expect(other !== undefined && other.cause === 'initial' && other.ready !== true, `${k} stranded`).toBe(
        true,
      )
    }
  }
  // A done reviewer has a parsed source (never `parsing`).
  for (const k of ['review', 'critic'] as const) {
    if (next.steps[k].status === 'done') {
      const src = next.findings?.sources[k]
      expect(src, `${k} source`).toBeDefined()
      expect(src?.status).not.toBe('parsing')
      expect(src?.status).not.toBe('empty')
    }
  }
  const gateOpen = next.cards.some((c) => c.view.kind === 'gate:beforeFix')
  if (gateOpen) {
    expect(next.flow.fix).toBe('gate')
    expect(next.steps.fix.status).toBe('queued')
    if (next.status !== 'cancelled') expect(next.phase).toBe('findings-review')
  }
  const fs = next.findings
  if (fs !== undefined) {
    const ids = new Set(fs.list.map((f) => f.id))
    expect(ids.size).toBe(fs.list.length)
    for (const id of fs.selected) expect(ids.has(id), `selected ${id}`).toBe(true)
    fs.list.forEach((f, i) => expect(f.n).toBe(i + 1))
  }
  if (next.outcome !== undefined && prev.outcome === undefined && next.stop === undefined) {
    switch (next.outcome) {
      case 'fixed':
        expect(next.steps.fix.status).toBe('done')
        break
      case 'clean':
        expect(next.steps.fix.status).toBe('skipped')
        expect(fixSkipRuleHolds(next)).toBe(true)
        break
      case 'findings-open':
        expect(next.steps.fix.status).toBe('skipped')
        break
      case 'no-changes':
        for (const k of ['review', 'critic', 'fix'] as const) {
          expect(next.steps[k]).toMatchObject({ status: 'skipped', reason: 'no changes' })
        }
        break
      case 'verify-failed':
      case 'security-open':
      case 'fix-stopped':
      case 'gates-failed':
      case 'failed':
        throw new Error(`unexpected outcome ${next.outcome} without a stop`)
    }
    expect(next.status).toBe('completed')
  }
  expect(JSON.parse(JSON.stringify(next))).toStrictEqual(next)
}

describe('review sequence reducer invariants (fast-check)', () => {
  it('hold on random event streams through the full sequence', () => {
    fc.assert(
      fc.property(config13, fc.array(act13, { minLength: 40, maxLength: 220 }), (config, acts) => {
        drive13(config, acts, check)
      }),
      { numRuns: 300 },
    )
  }, 60_000)

  it('reach the review sequence states (sanity check on the generator)', () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(config13, fc.array(act13, { minLength: 60, maxLength: 220 }), (config, acts) => {
        drive13(config, acts, (_prev, _e, r) => {
          for (const k of STEP_KEYS) seen.add(`${k}:${r.state.steps[k].status}`)
          for (const e of r.effects) {
            if (e.t === 'spawn') seen.add(`spawn:${e.step}:${e.launch.resume ? 'resume' : 'fresh'}`)
            if (e.t === 'parseFindings') seen.add('parseFindings')
          }
          for (const c of r.state.cards) seen.add(`card:${c.view.kind}`)
          if (r.state.outcome !== undefined) seen.add(`outcome:${r.state.outcome}`)
          seen.add(`phase:${r.state.phase}`)
        })
      }),
      { numRuns: 400, seed: 20261005 },
    )
    for (const s of [
      'spawn:review:fresh',
      'spawn:critic:fresh',
      'spawn:fix:resume',
      'spawn:fix:fresh',
      'parseFindings',
      'review:done',
      'critic:done',
      'fix:done',
      'fix:failed',
      'card:gate:beforeFix',
      'card:emptyFindings',
      'outcome:fixed',
      'outcome:clean',
      'outcome:findings-open',
      'outcome:no-changes',
      'phase:reviewing',
      'phase:findings-review',
      'phase:fixing',
    ]) {
      expect(seen, s).toContain(s)
    }
  }, 60_000)
})
