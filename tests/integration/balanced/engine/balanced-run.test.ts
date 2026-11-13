// The balanced run at the engine level ("balanced end to end … Claude native Plan · Codex Implement ·
// Review‖Critic · Fix resumes the Codex thread, with statuses/ETA/cost on every card"; the Codex session id comes
// "from the thread/start response, before turn/start", decideSession; the cost's `catalog` basis, "Subscription
// auth shows API-equiv."): a real core, the fake Claude for Plan/Review/Critic and an in-process Codex for Implement and Fix.
//   - Implement on Codex gets no made-up session id; the thread id it reports through onSession is in run.json on disk
//     before its first turn (the adapter's turn/start waits for that)
//   - Fix reuses Implement's thread: StartOptions.resume names it with Implement's cumulative totals, the thread
//     echoes the same id, and the card's session line reads "reused the Implement session"
//   - Fix's prompt carries the selected findings; Codex passes are priced from the catalog (API-equiv. on ChatGPT)
//   - Fix on Claude while Implement ran on Codex starts fresh, "fresh session: Fix vendor differs"
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import type { Usage } from '../../../../src/shared/events.ts'
import { REVIEW_WITH_FINDINGS } from '../../run/scenario.ts'
import { ScriptedCodex, World, runJsonOnDisk, settled, value } from './helpers.ts'
import type { CodexScript } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const SPEC = {
  plan: { recording: 'C06-plan-native-host' },
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
}
const OVERRIDES = { profile: 'balanced', gates: { afterPlan: false } }

const IMPL_TOTAL: Usage = { input: 12_000, output: 1_500, cacheRead: 30_000, reasoning: 400 }
const FIX_TOTAL: Usage = { input: 19_000, output: 2_100, cacheRead: 52_000, reasoning: 700 }
const minus = (a: Usage, b: Usage): Usage => ({
  input: a.input - b.input,
  output: a.output - b.output,
  cacheRead: (a.cacheRead ?? 0) - (b.cacheRead ?? 0),
  reasoning: (a.reasoning ?? 0) - (b.reasoning ?? 0),
})

interface Seen {
  /** steps.implement.sessionId in run.json on disk when the first turn would be sent. */
  persistedBeforeTurn: (string | undefined)[]
  starts: StartOptions[]
}

/**
 * Codex as the app-server route behaves for Dim Factory: thread/start (or thread/resume, echoing the id) → onSession
 * awaited → turn/start → a file change → turn/completed with the per-pass delta.
 */
function codexScript(home: () => string, seen: Seen): CodexScript {
  return (h, o) => {
    seen.starts.push(o)
    void (async () => {
      const resumed = o.resume?.sessionId
      const thread = resumed ?? 'thr_m8_implement'
      h.thread = thread
      await o.onSession?.(thread)
      if (o.step === 'implement') {
        seen.persistedBeforeTurn.push(runJsonOnDisk(home(), o.runId).steps.implement.sessionId)
      }
      h.events.emit({ type: 'session', id: thread })
      const file = o.step === 'implement' ? 'src/version.ts' : 'src/version.test.ts'
      h.events.emit({ type: 'tool', id: `fc-${o.step}`, name: 'fileChange', summary: file, phase: 'start' })
      writeFileSync(
        join(o.cwd, file),
        o.step === 'implement' ? 'export const version = "0.1.0"\n' : 'import "./version"\n',
      )
      h.events.emit({
        type: 'tool',
        id: `fc-${o.step}`,
        name: 'fileChange',
        summary: file,
        phase: 'end',
        status: 'ok',
      })
      const total = o.step === 'implement' ? IMPL_TOTAL : FIX_TOTAL
      const prior = o.resume?.priorUsage
      h.total = total
      h.events.emit({
        type: 'text',
        delta: o.step === 'implement' ? 'Added --version.' : 'Fixed the findings.',
      })
      h.events.emit({
        type: 'done',
        result: o.step === 'implement' ? 'Added --version.' : 'Fixed the findings.',
        usage: prior !== undefined ? minus(total, prior) : total,
      })
      h.exit(0)
    })()
  }
}

describe('balanced run (core + fake Claude + in-process Codex)', () => {
  it('Claude Plan, Codex Implement, Review‖Critic on Claude, Fix resumes the Codex thread', async () => {
    const seen: Seen = { persistedBeforeTurn: [], starts: [] }
    let home = ''
    const codex = new ScriptedCodex(codexScript(() => home, seen))
    const t = await w.boot(SPEC, codex)
    home = t.home
    const { runId, c } = await w.start(t, OVERRIDES)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)

    expect(done.status).toBe('completed')
    expect(done.config.passes.implement.vendor).toBe('codex')
    expect(done.config.passes.fix.vendor).toBe('codex')
    expect(done.steps.plan).toMatchObject({ status: 'done', vendor: 'claude' })
    expect(done.steps.review).toMatchObject({ status: 'done', vendor: 'claude' })
    expect(done.steps.critic).toMatchObject({ status: 'done', vendor: 'claude' })

    // Implement: no made-up id; the thread id was durable before the first turn.
    const [impl, fix] = seen.starts
    expect(seen.starts.map((s) => s.step)).toEqual(['implement', 'fix'])
    expect(impl?.sessionId).toBeUndefined()
    expect(impl?.resume).toBeUndefined()
    expect(impl).toMatchObject({ mode: 'autoedit', cwd: t.folder })
    expect(seen.persistedBeforeTurn).toEqual(['thr_m8_implement'])
    expect(done.steps.implement).toMatchObject({
      status: 'done',
      vendor: 'codex',
      sessionId: 'thr_m8_implement',
    })
    expect(done.sessions['thr_m8_implement']).toMatchObject({ vendor: 'codex', cwd: t.folder })

    // Fix: resumes the same thread with Implement's totals; the session line says so.
    expect(fix?.resume).toEqual({ sessionId: 'thr_m8_implement', priorUsage: IMPL_TOTAL })
    expect(fix?.sessionId).toBeUndefined()
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      vendor: 'codex',
      attempt: 1,
      sessionId: 'thr_m8_implement',
      sessionNote: 'reused the Implement session',
    })
    expect(done.sessions['thr_m8_implement']?.lastTotals).toMatchObject(FIX_TOTAL)
    // Per-pass usage: Fix's own delta (the engine never subtracts; the adapter did).
    expect(done.steps.implement.usage).toMatchObject(IMPL_TOTAL)
    expect(done.steps.fix.usage).toMatchObject(minus(FIX_TOTAL, IMPL_TOTAL))

    // Fix's prompt carries the selected [must] findings (prompts over JSON-RPC, never argv).
    expect(fix?.prompt).toContain('--version prints nothing')
    expect(fix?.prompt).toContain('No test covers --version')

    // Cost on the Codex cards: catalog prices (the seed's gpt-5.6-sol, the probe's default), API-equiv. on ChatGPT.
    for (const step of ['implement', 'fix'] as const) {
      const cost = done.steps[step].cost
      expect(cost?.basis).toBe('catalog')
      expect(cost?.usd ?? 0).toBeGreaterThan(0)
      expect(cost?.apiEquivalent).toBe(true)
    }
    // Every card the Run view shows: a status, the frozen estimate's ETA, and a cost (Claude's from the vendor).
    const snap = value(await t.core.invoke('runs.get', { runId }))
    for (const step of ['plan', 'implement', 'review', 'critic', 'fix'] as const) {
      const v = snap.steps[step]
      expect(v.status, step).toBe('done')
      expect(v.eta, step).toBeDefined()
      expect(v.cost, step).toBeDefined()
    }
    expect(snap.steps.plan.cost?.basis).toBe('vendor')
  }, 180_000)

  it('Fix on Claude after a Codex Implement starts fresh: "Fix vendor differs" (never resumes another vendor’s thread)', async () => {
    const seen: Seen = { persistedBeforeTurn: [], starts: [] }
    let home = ''
    const codex = new ScriptedCodex(codexScript(() => home, seen))
    const t = await w.boot({ ...SPEC, fix: [{ recording: 'C08a-session-id-implement' }] }, codex)
    home = t.home
    const { c } = await w.start(t, {
      ...OVERRIDES,
      passes: { fix: { vendor: 'claude', model: null, mode: 'autoedit' } },
    })
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(seen.starts.map((s) => s.step)).toEqual(['implement'])
    expect(done.steps.fix).toMatchObject({
      vendor: 'claude',
      sessionNote: 'fresh session: Fix vendor differs',
    })
    expect(done.steps.fix.sessionId).not.toBe('thr_m8_implement')
  }, 180_000)
})
