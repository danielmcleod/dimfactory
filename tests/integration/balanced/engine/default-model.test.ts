// Codex's "CLI default", decided per pass (a model the account's list lacks), at the engine level: a real core,
// the fake Claude and an in-process Codex.
//   - the model a pass with no model ran (META_MODEL_USED, with the model the account was not offered when Dim Factory ran
//     its default instead) is the step's model used: the snapshot names both, and the pass is priced at the one that ran
//   - before it starts, a pass with no model names the model core expects (StepView.expectedModel): the one its
//     estimate is priced at; once it runs, only until its vendor says (a model, or none) and only where its vendor says
//     before its turn (the app-server route), never after it ended nor on the exec route
//   - model_unavailable on a pass with no model whose own settings' model was refused: the snag offers the account's
//     default as a one-click config_patch, and the retry runs with it; not when the default itself was what ran, but
//     when the vendor did not run the default Dim Factory sent (its refusal names its own model), and the card then names
//     the model that ran
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { META_MODEL_USED } from '../../../../src/core/adapters/types.ts'
import type { Usage } from '../../../../src/shared/events.ts'
import { REVIEW_WITH_FINDINGS } from '../../run/scenario.ts'
import { ScriptedCodex, World, codexPlays, failedWithSnag, settled, snagOf, value } from './helpers.ts'
import type { CodexScript } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const SPEC = {
  plan: { recording: 'C06-plan-native-host' },
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
}
const BALANCED = { profile: 'balanced', gates: { afterPlan: false } }
/** The account's live list (X01a): gpt-6-luna is its default; the profile's own gpt-5.6-sol is not offered. */
const ACCOUNT_MODELS = [
  { id: 'gpt-6-luna', isDefault: true, source: 'cli' as const },
  { id: 'gpt-5.6-terra', source: 'cli' as const },
  { id: 'gpt-5.6-luna', source: 'cli' as const },
]
/** One million fresh input tokens: $0.10 at gpt-6-luna's seed price, $4.00 at gpt-5.6-sol's. */
const MTOK: Usage = { input: 1_000_000, output: 0 }
const REFUSED = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."

/** Codex as the real adapter runs a pass with no model: the model its thread named, or the default run in its place. */
function runsModel(used: { model: string; replaced?: string }): CodexScript {
  let n = 0
  return (h, o) => {
    n++
    void (async () => {
      const thread = o.resume?.sessionId ?? `thr_default_${n}`
      h.thread = thread
      await o.onSession?.(thread)
      h.events.emit({ type: 'session', id: thread })
      if (o.model === null || o.model === undefined)
        h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: used })
      if (o.step === 'implement')
        writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version = "0.1.0"\n')
      h.events.emit({
        type: 'done',
        result: o.step === 'implement' ? 'Added --version.' : 'Done.',
        usage: MTOK,
      })
      h.exit(0)
    })()
  }
}

/** The refusal X09h recorded, after the thread named the profile's model (`used`, when the adapter said it). */
function refusedOnce(used?: { model: string; replaced?: string }, refused = REFUSED): CodexScript {
  const plays = codexPlays([
    {
      kind: 'fail',
      failure: {
        category: 'model_unavailable',
        message: refused,
        raw: JSON.stringify({ detail: refused }),
        classifiedBy: 'regex',
      },
    },
    { kind: 'ok', file: 'src/version.ts' },
  ])
  let n = 0
  return (h, o) => {
    n++
    if (n === 1 && used !== undefined) h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: used })
    plays(h, o)
  }
}

describe('Codex’s CLI default (engine)', () => {
  it('the model a pass with no model ran is its model used (and the one replaced); priced at it; expected before', async () => {
    const codex = new ScriptedCodex(runsModel({ model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }), {
      models: ACCOUNT_MODELS,
    })
    const t = await w.boot(SPEC, codex)
    // The estimate prices Implement (no model) at the account's default, the model the card names before the start.
    const est = value(await t.core.invoke('estimates.get', { folder: t.folder, overrides: BALANCED }))
    expect(est.steps.implement?.missingPricing).toEqual([])
    const { runId, c } = await w.start(t, BALANCED)
    const queued = value(await t.core.invoke('runs.get', { runId }))
    expect(queued.steps.implement).toMatchObject({
      status: 'queued',
      model: null,
      expectedModel: 'gpt-6-luna',
    })
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status, JSON.stringify(done.steps.implement.failure ?? done.failure ?? null)).toBe(
      'completed',
    )
    expect(codex.starts.find((s) => s.step === 'implement')?.model ?? null).toBeNull()
    const snap = value(await t.core.invoke('runs.get', { runId }))
    for (const k of ['implement', 'fix'] as const) {
      expect(snap.steps[k]).toMatchObject({
        model: null,
        modelUsed: 'gpt-6-luna',
        modelReplaced: 'gpt-5.6-sol',
      })
      // The pass ran: what it ran is modelUsed, nothing is still expected.
      expect(snap.steps[k].expectedModel).toBeUndefined()
    }
    // The step-status bodies carry both, so a run read back from its log names them too.
    const bodies = t.events.filter(
      (e) => e.runId === runId && e.body.t === 'step-status' && e.body.step === 'implement',
    )
    expect(bodies.map((e) => (e.body.t === 'step-status' ? e.body.modelReplaced : undefined))).toContain(
      'gpt-5.6-sol',
    )
    // Priced at gpt-6-luna ($0.10 per million input tokens), not at the profile's gpt-5.6-sol ($4.00).
    expect(done.steps.implement.cost).toMatchObject({ basis: 'catalog' })
    expect(done.steps.implement.cost?.usd).toBeCloseTo(0.1, 6)
    // Claude's passes name their own models: nothing used, replaced or expected is recorded for them.
    expect(snap.steps.review.modelUsed).toBeUndefined()
    expect(snap.steps.review.expectedModel).toBeUndefined()
  }, 180_000)

  it('a model the account lists runs as the CLI chose it: recorded, nothing replaced, priced at it', async () => {
    const codex = new ScriptedCodex(runsModel({ model: 'gpt-5.6-terra' }), { models: ACCOUNT_MODELS })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, BALANCED)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status).toBe('completed')
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.implement).toMatchObject({ model: null, modelUsed: 'gpt-5.6-terra' })
    expect(snap.steps.implement.modelReplaced).toBeUndefined()
    // gpt-5.6-terra costs 20× gpt-6-luna per input token: the pass is priced at what ran, not at what was expected.
    expect(done.steps.implement.cost?.usd ?? 0).toBeGreaterThan(0.5)
  }, 180_000)

  it('model_unavailable from the model Codex’s settings chose: one click puts the account’s default on the pass', async () => {
    const codex = new ScriptedCodex(refusedOnce({ model: 'gpt-5.6-sol' }), { models: ACCOUNT_MODELS })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, BALANCED)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement.failure).toMatchObject({ category: 'model_unavailable' })
    expect(failed.steps.implement.modelUsed).toBe('gpt-5.6-sol')
    const actions = snagOf(t.events, 'implement')?.actions ?? []
    const fix = actions.find((a) => a.id === 'implement:account-model')
    expect(fix).toMatchObject({
      kind: 'config_patch',
      label: "Use gpt-6-luna (Codex's default for this account)",
      ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-6-luna' }],
    })
    expect(actions[0]?.id).toBe('implement:account-model')
    expect(fix?.label).not.toContain('—')
    await c.settle()

    value(await t.core.invoke('recovery.execute', { actionId: 'implement:account-model', runId }))
    const done = await c.waitFor(settled, 120_000)
    expect(done.status, JSON.stringify(done.steps.implement.failure ?? done.failure ?? null)).toBe(
      'completed',
    )
    const implStarts = codex.starts.filter((s) => s.step === 'implement')
    expect(implStarts.map((s) => s.model ?? null)).toEqual([null, 'gpt-6-luna'])
    expect(done.steps.implement).toMatchObject({ status: 'done', model: 'gpt-6-luna' })
    expect(done.steps.implement.modelUsed).toBeUndefined()
  }, 180_000)

  it('not offered when the pass already ran the account’s default (it was the one refused)', async () => {
    const own = "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."
    const codex = new ScriptedCodex(refusedOnce({ model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }, own), {
      models: ACCOUNT_MODELS,
    })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, BALANCED)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement.modelUsed).toBe('gpt-6-luna')
    const ids = (snagOf(t.events, 'implement')?.actions ?? []).map((a) => a.id)
    expect(ids).not.toContain('implement:account-model')
    // The card says the default ran (and was refused).
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.implement).toMatchObject({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(snap.steps.implement.modelOverrideIgnored).toBeUndefined()
  }, 180_000)

  it('the vendor did not run the default Dim Factory sent (its refusal names its own model): honest card, one click', async () => {
    // turn/start carried gpt-6-luna in place of gpt-5.6-sol, and the account refused gpt-5.6-sol: the CLI ignored it.
    const codex = new ScriptedCodex(refusedOnce({ model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }), {
      models: ACCOUNT_MODELS,
    })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, BALANCED)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    // The step recorded what the adapter said it sent; the card names what ran, never that the default did.
    expect(failed.steps.implement).toMatchObject({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.implement).toMatchObject({
      model: null,
      modelUsed: 'gpt-5.6-sol',
      modelOverrideIgnored: 'gpt-6-luna',
    })
    expect(snap.steps.implement.modelReplaced).toBeUndefined()
    const actions = snagOf(t.events, 'implement')?.actions ?? []
    expect(actions[0]).toMatchObject({
      id: 'implement:account-model',
      kind: 'config_patch',
      label: "Use gpt-6-luna (Codex's default for this account)",
      ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-6-luna' }],
    })
    await c.settle()

    // The pass then names its model, which the adapter sends on thread/start (the live runs confirm it is honoured).
    value(await t.core.invoke('recovery.execute', { actionId: 'implement:account-model', runId }))
    const done = await c.waitFor(settled, 120_000)
    expect(done.status, JSON.stringify(done.steps.implement.failure ?? done.failure ?? null)).toBe(
      'completed',
    )
    const implStarts = codex.starts.filter((s) => s.step === 'implement')
    expect(implStarts.map((s) => s.model ?? null)).toEqual([null, 'gpt-6-luna'])
  }, 180_000)
})

/** Codex holding a pass open: the session, then `word` (the model it says, or none) once `say` resolves, then done. */
function heldPass(say: Promise<void>, finish: Promise<void>, word?: unknown): CodexScript {
  let n = 0
  return (h, o) => {
    n++
    void (async () => {
      const thread = o.resume?.sessionId ?? `thr_held_${n}`
      h.thread = thread
      await o.onSession?.(thread)
      h.events.emit({ type: 'session', id: thread })
      if (o.step === 'implement') {
        await say
        if (word !== undefined) h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: word })
        await finish
        writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version = "0.1.0"\n')
      }
      h.events.emit({ type: 'done', result: 'Done.', usage: { input: 1_000, output: 100 } })
      h.exit(0)
    })()
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('the model a card expects, while it is still expected (engine)', () => {
  const NO_FIX = { ...BALANCED, passes: { fix: { enabled: false } } }

  it('app-server: expected until the vendor says; it said the thread named none: nothing expected from then on', async () => {
    const say = gate()
    const finish = gate()
    const codex = new ScriptedCodex(heldPass(say.promise, finish.promise, { model: null }), {
      models: ACCOUNT_MODELS,
    })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, NO_FIX)
    await c.waitFor((s) => s.steps.implement.sessionId !== undefined, 90_000)
    await c.settle()
    // Started, and Codex has not said which model it runs yet: the card still names the expected model.
    const before = value(await t.core.invoke('runs.get', { runId }))
    // (ScriptedCodex spawns no child, so the step records no route: core reads the probe's, the app-server.)
    expect(before.steps.implement.status).toBe('running')
    expect(before.steps.implement.expectedModel).toBe('gpt-6-luna')
    say.open()
    await c.waitFor((s) => s.steps.implement.modelUnreported === true, 30_000)
    const said = value(await t.core.invoke('runs.get', { runId }))
    expect(said.steps.implement.status).toBe('running')
    expect(said.steps.implement.expectedModel).toBeUndefined()
    expect(said.steps.implement.modelUsed).toBeUndefined()
    finish.open()
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    const after = value(await t.core.invoke('runs.get', { runId }))
    expect(after.steps.implement.expectedModel).toBeUndefined()
    expect(after.steps.implement.modelUsed).toBeUndefined()
  }, 180_000)

  it('exec: expected while queued only; started and finished, nothing is expected (Codex does not say)', async () => {
    const say = gate()
    const finish = gate()
    const codex = new ScriptedCodex(heldPass(say.promise, finish.promise), {
      models: ACCOUNT_MODELS,
      route: 'exec',
    })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, NO_FIX)
    const queued = value(await t.core.invoke('runs.get', { runId }))
    expect(queued.steps.implement).toMatchObject({ status: 'queued', expectedModel: 'gpt-6-luna' })
    await c.waitFor((s) => s.steps.implement.sessionId !== undefined, 90_000)
    await c.settle()
    const running = value(await t.core.invoke('runs.get', { runId }))
    // (No child, so no route recorded: core reads the probe's, exec.)
    expect(running.steps.implement).toMatchObject({ status: 'running', model: null })
    expect(running.steps.implement.expectedModel).toBeUndefined()
    say.open()
    finish.open()
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    const after = value(await t.core.invoke('runs.get', { runId }))
    expect(after.steps.implement).toMatchObject({ status: 'done', model: null })
    expect(after.steps.implement.expectedModel).toBeUndefined()
    expect(after.steps.implement.modelUsed).toBeUndefined()
  }, 180_000)

  it('frozen for the run: a re-probe mid-run that finds another default does not change a queued pass’s expectation', async () => {
    const say = gate()
    const finish = gate()
    const codex = new ScriptedCodex(heldPass(say.promise, finish.promise, { model: 'gpt-6-luna' }), {
      models: ACCOUNT_MODELS,
    })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, BALANCED)
    await c.waitFor((s) => s.steps.implement.sessionId !== undefined, 90_000)
    // The account's default changes, and Codex is probed again while Implement runs and Fix waits.
    codex.models = [
      { id: 'gpt-6-luna', source: 'cli' },
      { id: 'gpt-5.6-terra', isDefault: true, source: 'cli' },
    ]
    value(await t.core.invoke('vendors.probe', { vendor: 'codex', force: true }))
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.fix).toMatchObject({ status: 'queued', model: null, expectedModel: 'gpt-6-luna' })
    say.open()
    finish.open()
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
  }, 180_000)
})
