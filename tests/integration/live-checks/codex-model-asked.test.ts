// Live re-record, Model wording item 1 (the Codex part), through a real core: a Codex pass with no model whose
// folder model the account is not offered gets the
// account's default on turn/start, and the adapter says so in two steps (live X18a/b): `{asked, replaced}` before the
// turn, then `{model, replaced}` once Codex says it runs it. The step records the default as the model that ran only
// then (StepView.modelUsed, the price); before, it was asked for (StepView.modelAsked), the card still names the model
// core expects, and the step-status bodies carry it (a run read back from its log names it too). A refusal of the
// folder's model means Codex ran that instead (the card names it, the one-click fix pins the default); a refusal of the
// default leaves it asked for, never "ran".
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { META_MODEL_USED } from '../../../src/core/adapters/types.ts'
import { projectFromLog } from '../../../src/core/supervisor/recovery.ts'
import type { Usage } from '../../../src/shared/events.ts'
import { REVIEW_WITH_FINDINGS } from '../run/scenario.ts'
import type { CodexScript } from '../balanced/engine/helpers.ts'
import {
  ScriptedCodex,
  World,
  codexPlays,
  failedWithSnag,
  runJsonOnDisk,
  settled,
  snagOf,
  value,
} from '../balanced/engine/helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const SPEC = {
  plan: { recording: 'C06-plan-native-host' },
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
}
const NO_FIX = { profile: 'balanced', gates: { afterPlan: false }, passes: { fix: { enabled: false } } }
const ACCOUNT_MODELS = [
  { id: 'gpt-6-luna', isDefault: true, source: 'cli' as const },
  { id: 'gpt-5.6-terra', source: 'cli' as const },
  { id: 'gpt-5.6-luna', source: 'cli' as const },
]
/** One million fresh input tokens: $0.10 at gpt-6-luna's seed price, $4.00 at gpt-5.6-sol's. */
const MTOK: Usage = { input: 1_000_000, output: 0 }
const ASKED = { asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }
const CONFIRMED = { model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** As the adapter now runs Implement (no model): asked for before the turn, confirmed when `confirm` opens. */
function askedThenConfirmed(confirm: Promise<void>): CodexScript {
  let n = 0
  return (h, o) => {
    n++
    void (async () => {
      const thread = `thr_asked_${n}`
      h.thread = thread
      await o.onSession?.(thread)
      h.events.emit({ type: 'session', id: thread })
      if (o.step === 'implement') {
        h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: ASKED })
        await confirm
        h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: CONFIRMED })
        writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version = "0.1.0"\n')
      }
      h.events.emit({
        type: 'done',
        result: 'Done.',
        usage: o.step === 'implement' ? MTOK : { input: 1, output: 1 },
      })
      h.exit(0)
    })()
  }
}

/** Asked for, then refused with `refused` (no word from Codex that the default runs), then a pass that completes. */
function askedThenRefused(refused: string): CodexScript {
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
    if (n === 1) h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: ASKED })
    plays(h, o)
  }
}

const refusalOf = (model: string): string =>
  `The '${model}' model is not supported when using Codex with a ChatGPT account.`

describe('the default asked for on turn/start, until Codex says it runs (engine)', () => {
  it('asked: not the model used yet, the card keeps the expected model; confirmed: the model used, priced at it', async () => {
    const confirm = gate()
    const codex = new ScriptedCodex(askedThenConfirmed(confirm.promise), { models: ACCOUNT_MODELS })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, NO_FIX)
    await c.waitFor((s) => s.steps.implement.modelAsked !== undefined, 90_000)
    await c.settle()
    const asked = value(await t.core.invoke('runs.get', { runId }))
    expect(asked.steps.implement).toMatchObject({
      status: 'running',
      model: null,
      modelAsked: 'gpt-6-luna',
      modelReplaced: 'gpt-5.6-sol',
      // Codex has not said which model runs: the card still names the model core expects.
      expectedModel: 'gpt-6-luna',
    })
    expect(asked.steps.implement.modelUsed).toBeUndefined()
    // The step-status body carries it, so a run read back from its log names it too.
    const bodies = t.events.filter(
      (e) => e.runId === runId && e.body.t === 'step-status' && e.body.step === 'implement',
    )
    const askedBody = bodies.find((e) => e.body.t === 'step-status' && e.body.modelAsked === 'gpt-6-luna')
    expect(askedBody).toBeDefined()
    expect(askedBody?.body).toMatchObject({ modelReplaced: 'gpt-5.6-sol' })
    expect(askedBody?.body).not.toHaveProperty('modelUsed')

    confirm.open()
    const done = await c.waitFor(settled, 120_000)
    await c.settle()
    expect(done.status, JSON.stringify(done.steps.implement.failure ?? done.failure ?? null)).toBe(
      'completed',
    )
    const after = value(await t.core.invoke('runs.get', { runId }))
    expect(after.steps.implement).toMatchObject({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(after.steps.implement.modelAsked).toBeUndefined()
    expect(after.steps.implement.expectedModel).toBeUndefined()
    expect(done.steps.implement.cost?.usd).toBeCloseTo(0.1, 6)

    // Read back: the confirmed run.json, then the asked-for body projected over a copy without it.
    const disk = runJsonOnDisk(t.home, runId)
    expect(disk.steps.implement).toMatchObject({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(disk.steps.implement.modelAsked).toBeUndefined()
    const base = structuredClone(disk)
    delete base.steps.implement.modelUsed
    delete base.steps.implement.modelReplaced
    const projected = projectFromLog(base, askedBody !== undefined ? [askedBody] : [])
    expect(projected.steps.implement).toMatchObject({
      modelAsked: 'gpt-6-luna',
      modelReplaced: 'gpt-5.6-sol',
    })
    expect(projected.steps.implement.modelUsed).toBeUndefined()
  }, 180_000)

  it('refused naming the folder’s model: Codex ran that; the card names it, and one click pins the default', async () => {
    const codex = new ScriptedCodex(askedThenRefused(refusalOf('gpt-5.6-sol')), { models: ACCOUNT_MODELS })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, NO_FIX)
    const failed = await c.waitFor(failedWithSnag('implement'), 90_000)
    expect(failed.steps.implement).toMatchObject({ modelAsked: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(failed.steps.implement.modelUsed).toBeUndefined()
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.implement).toMatchObject({
      model: null,
      modelUsed: 'gpt-5.6-sol',
      modelOverrideIgnored: 'gpt-6-luna',
    })
    expect(snap.steps.implement.modelAsked).toBeUndefined()
    expect(snap.steps.implement.modelReplaced).toBeUndefined()
    const actions = snagOf(t.events, 'implement')?.actions ?? []
    expect(actions[0]).toMatchObject({
      id: 'implement:account-model',
      ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-6-luna' }],
    })
    await c.settle()
    value(await t.core.invoke('recovery.execute', { actionId: 'implement:account-model', runId }))
    const done = await c.waitFor(settled, 120_000)
    expect(done.status).toBe('completed')
    expect(codex.starts.filter((s) => s.step === 'implement').map((s) => s.model ?? null)).toEqual([
      null,
      'gpt-6-luna',
    ])
  }, 180_000)

  it('a turn Codex rerouted ran its toModel: the model used and the price, also read back from the log', async () => {
    const REROUTED = { model: 'gpt-5.6-terra', rerouted: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }
    let n = 0
    const script: CodexScript = (h, o) => {
      n++
      void (async () => {
        const thread = `thr_rerouted_${n}`
        h.thread = thread
        await o.onSession?.(thread)
        h.events.emit({ type: 'session', id: thread })
        if (o.step === 'implement') {
          h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: ASKED })
          // As the adapter says it on `model/rerouted` (CodexNormalizer): the wait for the default ends here.
          h.signals.emit({ type: 'meta', key: META_MODEL_USED, value: REROUTED })
          writeFileSync(join(o.cwd, 'src', 'version.ts'), 'export const version = "0.1.0"\n')
        }
        h.events.emit({
          type: 'done',
          result: 'Done.',
          usage: o.step === 'implement' ? MTOK : { input: 1, output: 1 },
        })
        h.exit(0)
      })()
    }
    const codex = new ScriptedCodex(script, { models: ACCOUNT_MODELS })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, NO_FIX)
    const done = await c.waitFor(settled, 120_000)
    await c.settle()
    expect(done.status, JSON.stringify(done.steps.implement.failure ?? done.failure ?? null)).toBe(
      'completed',
    )
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.implement).toMatchObject({
      model: null,
      modelUsed: 'gpt-5.6-terra',
      modelRerouted: 'gpt-6-luna',
      modelReplaced: 'gpt-5.6-sol',
    })
    expect(snap.steps.implement.modelAsked).toBeUndefined()
    // Priced at the model that ran: $2.00 for a million fresh input tokens at gpt-5.6-terra's seed price.
    expect(done.steps.implement.cost?.usd).toBeCloseTo(2, 6)
    const body = t.events.find(
      (e) =>
        e.runId === runId &&
        e.body.t === 'step-status' &&
        e.body.step === 'implement' &&
        e.body.modelRerouted === 'gpt-6-luna',
    )
    expect(body?.body).toMatchObject({ modelUsed: 'gpt-5.6-terra', modelReplaced: 'gpt-5.6-sol' })
    const base = structuredClone(runJsonOnDisk(t.home, runId))
    delete base.steps.implement.modelUsed
    delete base.steps.implement.modelRerouted
    const projected = projectFromLog(base, body !== undefined ? [body] : [])
    expect(projected.steps.implement).toMatchObject({
      modelUsed: 'gpt-5.6-terra',
      modelRerouted: 'gpt-6-luna',
    })
  }, 180_000)

  it('refused naming the default asked for: no claim that it ran, and no one-click default', async () => {
    const codex = new ScriptedCodex(askedThenRefused(refusalOf('gpt-6-luna')), { models: ACCOUNT_MODELS })
    const t = await w.boot(SPEC, codex)
    const { runId, c } = await w.start(t, NO_FIX)
    await c.waitFor(failedWithSnag('implement'), 90_000)
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.implement).toMatchObject({ modelAsked: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(snap.steps.implement.modelUsed).toBeUndefined()
    expect(snap.steps.implement.modelOverrideIgnored).toBeUndefined()
    const ids = (snagOf(t.events, 'implement')?.actions ?? []).map((a) => a.id)
    expect(ids).not.toContain('implement:account-model')
  }, 180_000)
})
