// Context health's reactions in the reducer:
//   - Implement or Fix compacting `restartAfter` (3) times: a non-blocking restartFresh card in a normal run (once per
//     pass); [Restart fresh with a summary] stops the process and starts a fresh attempt whose launch carries the
//     `{{state}}` note's facts; [Keep going] goes on
//   - Auto: one fresh restart on its own, spending the pass's automatic retry; a note instead once that is spent
//   - Fix starts a fresh session (`context-heavy`) when Implement's session ended ≥70% full or compacted twice
//   - the same call 8 times: the loop card ([Stop] / [Keep going]); 12 times: the loop stop (runaway_loop, a snag
//     with a fresh retry); Auto stops at 8 and retries fresh once, and a second loop is the hard stop
import { describe, expect, it } from 'vitest'
import type { AdapterSignal } from '@shared/events.ts'
import type { SessionCheck } from '@core/supervisor/types.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { buildPrompt, restartStateNote } from '@core/supervisor/effects.ts'
import { Flow, must } from '../supervisor/helpers.review.ts'
import { Harness, PLAN_TEXT, makeConfig } from '../supervisor/helpers.ts'

const compactStart: AdapterSignal = { type: 'compaction', phase: 'start', trigger: 'auto' }
const compactEnd: AdapterSignal = { type: 'compaction', phase: 'end', trigger: 'auto' }

function compact(f: Harness, times: number, step: 'implement' | 'fix' = 'implement'): void {
  for (let i = 0; i < times; i++) {
    f.signal(step, compactStart)
    f.signal(step, compactEnd)
  }
}

function repeat(f: Harness, times: number, fp = 'fp-ls', from = 0): void {
  for (let i = 0; i < times; i++) {
    f.ev('implement', {
      type: 'tool',
      id: `t${from + i}`,
      name: 'Bash',
      summary: 'ls',
      phase: 'start',
      fp,
    })
  }
}

/** An Auto run: no gates; Implement spawned with its session. */
function autoImplementRunning(): Harness {
  const f = new Harness(makeConfig({ auto: true, gates: { afterPlan: false, beforeFix: false } }))
  f.toPlanRunning()
  f.ev('plan', { type: 'session', id: 'plan-session' })
  f.ev('plan', { type: 'done', result: PLAN_TEXT })
  f.exit('plan')
  f.reconcile()
  f.snapshot('S0', 'tree-base')
  f.passPreflight('implement')
  f.ev('implement', { type: 'session', id: 'impl-session' })
  return f
}

/** After the process exits: the pre-retry snapshot and the pass-boundary preflight, then the fresh spawn. */
function respawn(f: Harness, spawnNo: number): void {
  f.exit('implement', { spawnNo, code: null })
  f.snapshot('pre-retry', 'tree-mid')
  f.passPreflight('implement')
}

describe('the restart after compactions', () => {
  it('a normal run opens the restartFresh card once, at the third compaction; the pass keeps running', () => {
    const f = new Flow()
    f.toImplementRunning()
    compact(f, 2)
    expect(f.state.cards.some((c) => c.view.kind === 'restartFresh')).toBe(false)
    compact(f, 1)
    const c = f.card('restartFresh')
    expect(c.view).toMatchObject({ blocking: false, title: 'Restart this pass fresh with a summary' })
    expect(c.view.body).toContain('summarised its notes 3 times in Implement')
    expect(c.view.body).not.toContain('\u2014')
    expect(c.view.choices.map((x) => x.label)).toEqual(['Restart fresh with a summary', 'Keep going'])
    expect(f.step('implement').status).toBe('running')
    // A fourth compaction opens no second card.
    compact(f, 1)
    expect(f.state.cards.filter((x) => x.view.kind === 'restartFresh')).toHaveLength(1)
  })

  it('[Restart fresh with a summary] stops the process and spawns a fresh attempt carrying {{state}}', () => {
    const f = new Flow()
    f.toImplementRunning()
    compact(f, 3)
    const spawnNo = f.spawnNo('implement')
    f.choose('restartFresh', 'restart-fresh')
    expect(f.fx('kill')).toEqual([{ t: 'kill', step: 'implement', spawnNo }])
    expect(f.state.cards.some((c) => c.view.kind === 'restartFresh')).toBe(false)
    expect(f.step('implement').attempt).toBe(2)
    expect(f.state.notes).toContain('Restarted Implement fresh with a summary after 3 compactions.')
    // A user click spends no automatic retry.
    expect(f.step('implement').autoRetryUsed).toBe(false)
    respawn(f, spawnNo)
    const [sp] = f.fx('spawn')
    expect(sp).toMatchObject({ step: 'implement', attempt: 2 })
    expect(sp?.launch).toEqual({ fresh: {}, restart: { compactions: 3 } })
    // The fresh session's meter starts anew; the restart is once per pass.
    expect(f.step('implement').context?.compactions).toBe(0)
    compact(f, 3)
    expect(f.state.cards.some((x) => x.view.kind === 'restartFresh')).toBe(false)
  })

  it('[Keep going] goes on in the same session', () => {
    const f = new Flow()
    f.toImplementRunning()
    compact(f, 3)
    f.choose('restartFresh', 'keep-going')
    expect(f.fx('kill')).toEqual([])
    expect(f.step('implement')).toMatchObject({ status: 'running', attempt: 1 })
    expect(f.step('implement').reactions?.restart).toBe('declined')
  })

  it('the card is resolved when the pass ends', () => {
    const f = new Flow()
    f.toImplementRunning()
    compact(f, 3)
    expect(f.state.cards.some((c) => c.view.kind === 'restartFresh')).toBe(true)
    f.ev('implement', { type: 'done', result: 'implemented' })
    expect(f.state.cards.some((c) => c.view.kind === 'restartFresh')).toBe(false)
  })

  it('Auto restarts once on its own, spending the automatic retry, with the {{state}} facts', () => {
    const f = autoImplementRunning()
    compact(f, 3)
    expect(f.state.cards.some((c) => c.view.kind === 'restartFresh')).toBe(false)
    expect(f.step('implement').autoRetryUsed).toBe(true)
    expect(f.state.notes).toContain('Auto: restarted Implement fresh with a summary after 3 compactions.')
    respawn(f, 1)
    expect(f.fx('spawn')[0]?.launch).toEqual({ fresh: {}, restart: { compactions: 3 } })
  })

  it('Auto with its retry already spent goes on with a note', () => {
    const f = autoImplementRunning()
    f.state.steps.implement.autoRetryUsed = true
    compact(f, 3)
    expect(f.fx('kill')).toEqual([])
    expect(f.step('implement').attempt).toBe(1)
    expect(f.state.notes.some((n) => n.includes('its automatic retry was already used'))).toBe(true)
  })

  it('Plan and the reviewers never restart', () => {
    const f = new Flow()
    f.toPlanRunning()
    for (let i = 0; i < 3; i++) {
      f.signal('plan', compactStart)
      f.signal('plan', compactEnd)
    }
    expect(f.state.cards.some((c) => c.view.kind === 'restartFresh')).toBe(false)
  })
})

describe('context-heavy Fix', () => {
  const REPO = 'C:\\work\\repo'
  const check = (): SessionCheck => ({ sessionId: 'impl-session', ok: true, cwd: REPO })

  /** Implement done in REPO; the gate before Fix continued; Fix waits on its pass-boundary preflight. */
  function atFixPreflight(heavy: (f: Flow) => void): Flow {
    const f = new Flow()
    f.toPlanGate()
    f.approve()
    f.reconcile()
    f.snapshot('S0', 'tree-base')
    f.passPreflight('implement')
    f.send({ t: 'spawned', step: 'implement', spawnNo: 1, pid: 1, cwd: REPO, sessionId: 'impl-session' })
    heavy(f)
    f.ev('implement', { type: 'done', result: 'implemented', usage: { input: 1, output: 1 } })
    f.exit('implement')
    f.reconcile('end-of-pass')
    f.snapshot('S1', 'tree-changed')
    f.reconcile('pre-review')
    for (const k of f.reviewers) f.passPreflight(k)
    f.report('review', 'ok', [must('r1')])
    f.report('critic', 'none')
    f.snapshot('post-review', 'tree-changed')
    f.choose('gate:beforeFix', 'continue')
    f.reconcile('pre-fix')
    f.snapshot('fix-start', 'tree-changed')
    f.send({ t: 'session-check', step: 'fix', check: check() })
    f.passPreflight('fix')
    return f
  }

  it('Implement compacted twice: Fix starts fresh (context-heavy)', () => {
    const f = atFixPreflight((x) => compact(x, 2))
    const [sp] = f.fx('spawn')
    expect(sp?.launch).toMatchObject({ fresh: { reason: 'context-heavy' } })
    expect(f.step('fix').sessionNote).toBe('fresh session: the Implement session was nearly full')
  })

  it('Implement peaked at 70% of its window: Fix starts fresh (context-heavy)', () => {
    const f = atFixPreflight((x) =>
      x.signal('implement', { type: 'context', used: 140_000, window: 200_000, source: 'request' }),
    )
    expect(f.fx('spawn')[0]?.launch).toMatchObject({ fresh: { reason: 'context-heavy' } })
  })

  it('a light session (60%, one compaction) is reused', () => {
    const f = atFixPreflight((x) => {
      x.signal('implement', { type: 'context', used: 120_000, window: 200_000, source: 'request' })
      compact(x, 1)
    })
    expect(f.fx('spawn')[0]?.launch).toMatchObject({ session: { reuse: true, sessionId: 'impl-session' } })
  })
})

describe('the loop card and the loop stop', () => {
  it('the same call 8 times opens the loop card; 7 does not', () => {
    const f = new Flow()
    f.toImplementRunning()
    repeat(f, 7)
    expect(f.state.cards.some((c) => c.view.kind === 'loop')).toBe(false)
    repeat(f, 1, 'fp-ls', 7)
    const c = f.card('loop')
    expect(c.view).toMatchObject({ blocking: false, title: 'The AI keeps repeating the same step' })
    expect(c.view.body).toBe(
      'Implement ran the same Bash call 8 times. It may be stuck. Stop it, or keep going (Dim Factory stops it at 12).',
    )
    expect(c.view.choices.map((x) => x.label)).toEqual(['Stop', 'Keep going'])
    expect(f.step('implement').status).toBe('running')
  })

  it('[Keep going] stays quiet until the hard stop at 12: runaway_loop with a fresh retry', () => {
    const f = new Flow()
    f.toImplementRunning()
    repeat(f, 8)
    f.choose('loop', 'keep-going')
    repeat(f, 3, 'fp-ls', 8)
    // Keep going closed the card; no second one opens for the same call.
    expect(f.state.cards.some((c) => c.view.kind === 'loop')).toBe(false)
    expect(f.step('implement').status).toBe('running')
    const spawnNo = f.spawnNo('implement')
    repeat(f, 1, 'fp-ls', 11)
    const st = f.step('implement')
    expect(st.status).toBe('failed')
    expect(st.failure).toMatchObject({
      category: 'runaway_loop',
      classifiedBy: 'app',
      message: 'The AI kept repeating the same step, so Dim Factory stopped it.',
    })
    expect(st.reactions?.loop?.stoppedSpawn).toBe(spawnNo)
    expect(f.log).toContainEqual({ t: 'kill', step: 'implement', spawnNo })
    const snag = f.log
      .filter((e) => e.t === 'emit')
      .map((e) => (e.t === 'emit' ? e.body : undefined))
      .find((b) => b?.t === 'snag')
    expect(snag).toMatchObject({ step: 'implement', failure: { category: 'runaway_loop' } })
    expect(JSON.stringify(snag)).toContain('Retry in a fresh session')
  })

  it('[Stop] stops the pass now', () => {
    const f = new Flow()
    f.toImplementRunning()
    repeat(f, 8)
    f.choose('loop', 'stop')
    expect(f.step('implement')).toMatchObject({ status: 'failed', failure: { category: 'runaway_loop' } })
  })

  it('different calls never open the card', () => {
    const f = new Flow()
    f.toImplementRunning()
    for (let i = 0; i < 20; i++) repeat(f, 1, `fp-${i}`, i)
    expect(f.state.cards.some((c) => c.view.kind === 'loop')).toBe(false)
  })

  it('Auto stops at 8 and retries fresh once; a second loop is the hard stop', () => {
    const f = autoImplementRunning()
    repeat(f, 8)
    expect(f.state.cards.some((c) => c.view.kind === 'loop')).toBe(false)
    expect(f.fx('kill')).toEqual([{ t: 'kill', step: 'implement', spawnNo: 1 }])
    expect(f.step('implement')).toMatchObject({ status: 'running', attempt: 2 })
    expect(f.state.notes).toContain(
      'Auto: Implement kept repeating the same step, so Dim Factory stopped it and retried it fresh.',
    )
    respawn(f, 1)
    expect(f.fx('spawn')[0]?.launch).toEqual({ fresh: {} })
    // The fresh session's counters start anew.
    repeat(f, 7, 'fp-ls', 100)
    expect(f.step('implement').status).toBe('running')
    repeat(f, 1, 'fp-ls', 107)
    expect(f.step('implement')).toMatchObject({ status: 'failed', failure: { category: 'runaway_loop' } })
  })
})

describe('{{state}} in the restarted prompt', () => {
  it('Implement restarted after compactions gets the plan, the criteria and the files so far', () => {
    const f = new Flow()
    f.toImplementRunning()
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    const text = buildPrompt(
      f.state,
      config,
      { step: 'implement', launch: { fresh: {}, restart: { compactions: 3 } } },
      { changedFiles: ['src/cli.ts'] },
    ).text
    expect(text).toContain('You are continuing Implement in a fresh session.')
    expect(text).toContain('summarised its notes 3 times')
    expect(text).toContain('Files changed so far:\n- src/cli.ts')
    expect(text).toContain('The plan:\n## Goal')
    // An ordinary launch has no such note.
    const plain = buildPrompt(f.state, config, { step: 'implement', launch: { fresh: {} } }).text
    expect(plain).not.toContain('fresh session')
  })

  it('a template without {{state}} still gets the note at its end', () => {
    const f = new Flow()
    f.toImplementRunning()
    const note = restartStateNote(f.state, 'implement', { compactions: 3 }, {})
    expect(note).toContain('Files changed so far:\n- none yet')
  })
})
