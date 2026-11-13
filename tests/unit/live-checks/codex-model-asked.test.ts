// Live re-record, the per-pass model decision live (which model a pass
// without one runs on). Live X18a (a Review) and X18b (a native Plan), each a pass with no model on the everyday
// profile: thread/start names the profile's gpt-5.6-sol, the pass asks model/list{includeHidden:true} (the account has
// no gpt-5.6-sol, hidden or not), and turn/start carries the account's default, gpt-6-luna (X18b in its collaboration
// mode too). codex-cli 0.160.1 ran it: no refusal (X09h's gpt-5.6-sol is refused at the first model call), the turns
// completed. Codex names the turn's model only in thread/settings/updated (X18b; a plain turn gets none, X18a), and
// neither turn/started nor the usage totals carry a model. So the default is asked for (`{asked, replaced}`) until Codex
// says it runs: thread/settings/updated naming it, or the turn's first usage total (a model call Codex ran).
import { describe, expect, it } from 'vitest'
import type { AdapterSignal, NormalizedEvent } from '@shared/events.ts'
import type { Failure } from '@shared/failure.ts'
import type { ModelInfo } from '@shared/vendors.ts'
import { META_MODEL_USED } from '@core/adapters/types.ts'
import {
  accountModelsOf,
  decideModel,
  fetchAccountModels,
  threadModelOf,
} from '@core/adapters/codex/default-model.ts'
import { CodexNormalizer } from '@core/adapters/codex/normalize.ts'
import type { NormalizeStep } from '@core/adapters/codex/normalize.ts'
import { toModelInfo } from '@core/adapters/codex/probe.ts'
import { awaitsModelWord, toStepView } from '@core/supervisor/derive.ts'
import type { StepState } from '@core/supervisor/types.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { snagActions } from '@core/recovery/snag-actions.ts'
import type { SnagActionInput } from '@core/recovery/snag-actions.ts'
import type { Fixture, Frame } from '../codex/protocol/fixtures.ts'
import { loadFixture, message, messages, requestParams, resultOf } from '../codex/protocol/fixtures.ts'

const X01A = loadFixture('app-server', 'X01a-handshake-model-list')
const X07 = loadFixture('app-server', 'X07-fix-resume-new-process')
const X18A = loadFixture('app-server', 'X18a-default-model-turn-override')
const X18B = loadFixture('app-server', 'X18b-default-model-plan-override')

type Entry = NormalizedEvent | AdapterSignal

const ASKED = { asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }
const CONFIRMED = { model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }

function normalizer(step: 'review' | 'plan' | 'fix', o: { resumed?: boolean } = {}): CodexNormalizer {
  return new CodexNormalizer({
    step,
    mode: step === 'fix' ? 'autoedit' : 'readonly',
    cwd: '/w',
    planNative: step === 'plan',
    resumed: o.resumed ?? false,
    askTimeoutMs: 600_000,
    allowRules: [],
    structured: false,
    loopback: false,
    now: () => 1000,
  })
}

/** The recording's server notifications fed to `n` in order, after `turnId` is known as the adapter learns it. */
function feed(n: CodexNormalizer, fx: Fixture): { entries: Entry[]; methods: string[] } {
  const entries: Entry[] = []
  const methods: string[] = []
  const turn = (resultOf(fx, 'turn/start') as { turn: { id: string } }).turn.id
  for (const m of messages(fx, 'out')) {
    if (typeof m['method'] !== 'string' || 'id' in m) {
      if ((m['result'] as { turn?: unknown } | undefined)?.turn !== undefined) n.turnStarted(turn)
      continue
    }
    const step: NormalizeStep = n.notification(m['method'], m['params'])
    for (const e of [...step.signals, ...step.events]) {
      entries.push(e)
      methods.push(m['method'])
    }
  }
  return { entries, methods }
}

const modelWords = (r: { entries: Entry[]; methods: string[] }) =>
  r.entries.flatMap((e, i) =>
    e.type === 'meta' && e.key === META_MODEL_USED ? [{ value: e.value, from: r.methods[i] }] : [],
  )

describe('live X18a/b: what the adapter sent, and what codex-cli 0.160.1 answered', () => {
  it('thread/start without a model, model/list with hidden models, turn/start with the account’s default', () => {
    for (const fx of [X18A, X18B]) {
      // Made from the live recording (scripts/synthesize-fixtures.mjs): the frames' protocol as recorded.
      expect(String(fx.header['synthesizedFrom'])).toContain('scripts/synthesize-fixtures.mjs')
      expect(fx.header['cliVersion']).toBe('0.160.1')
      expect(requestParams(fx, 'thread/start')).not.toHaveProperty('model')
      expect(requestParams(fx, 'model/list')).toEqual({ includeHidden: true })
      expect(requestParams(fx, 'turn/start')).toMatchObject({ model: 'gpt-6-luna' })
      // The decision on the live answers: X18's own thread/start and its whole list (X01a's is the first look).
      const thread = threadModelOf(resultOf(fx, 'thread/start'))
      expect(thread).toEqual({ model: 'gpt-5.6-sol', provider: 'openai' })
      const picker = (resultOf(X01A, 'model/list') as { data: unknown[] }).data
        .map(toModelInfo)
        .filter((m): m is ModelInfo => m !== undefined)
      expect(decideModel(thread, accountModelsOf(picker)).why).toBe('unlisted')
    }
    expect(requestParams(X18B, 'turn/start')).toMatchObject({
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-luna' } },
    })
  })

  it('the whole list (hidden models too) lacks gpt-5.6-sol, so the default is sent', async () => {
    const all = await fetchAccountModels(() => Promise.resolve(resultOf(X18A, 'model/list')))
    expect(all?.defaultId).toBe('gpt-6-luna')
    // The live re-record of 2026-10-24 (the read-only feature switches): the account's list then.
    expect(all?.ids).toEqual(expect.arrayContaining(['gpt-6-luna', 'gpt-reserve', 'gpt-5.6-terra']))
    expect(all?.ids).not.toContain('gpt-5.6-sol')
    expect(decideModel(threadModelOf(resultOf(X18A, 'thread/start')), all)).toEqual({
      why: 'unlisted',
      runs: 'gpt-6-luna',
      override: 'gpt-6-luna',
      replaced: 'gpt-5.6-sol',
    })
  })

  it('0.160.1 honours the override: no refusal, a completed turn with usage; only a Plan’s settings name the model', () => {
    for (const fx of [X18A, X18B]) {
      const out = messages(fx, 'out')
      const text = JSON.stringify(out)
      // X09h's refusal and its missing-metadata warning name gpt-5.6-sol; nothing here does after thread/start.
      expect(out.filter((m) => m['method'] === 'error')).toEqual([])
      expect(out.filter((m) => m['method'] === 'warning')).toEqual([])
      expect(text).not.toContain('is not supported when using Codex')
      const done = out.find((m) => m['method'] === 'turn/completed')
      expect((done?.['params'] as { turn: { status: string } }).turn.status).toBe('completed')
      expect(out.filter((m) => m['method'] === 'thread/tokenUsage/updated').length).toBeGreaterThan(0)
      // Neither turn/started nor a usage total names a model.
      for (const m of out.filter(
        (x) => x['method'] === 'turn/started' || x['method'] === 'thread/tokenUsage/updated',
      ))
        expect(JSON.stringify(m)).not.toContain('gpt-')
    }
    const settings = (fx: Fixture) =>
      messages(fx, 'out').filter((m) => m['method'] === 'thread/settings/updated')
    expect(settings(X18A)).toEqual([])
    expect(settings(X18B)).toHaveLength(1)
    expect(settings(X18B)[0]?.['params']).toMatchObject({
      threadSettings: {
        model: 'gpt-6-luna',
        collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-luna' } },
      },
    })
  })
})

describe('their expected events (what the adapter makes of them)', () => {
  it('the default asked for before the turn, then the model used once Codex says so, before the pass ends', () => {
    for (const fx of [X18A, X18B]) {
      const words = fx.expected.filter((e) => e['type'] === 'meta' && e['key'] === META_MODEL_USED)
      expect(words.map((e) => e['value'])).toEqual([ASKED, CONFIRMED])
      const at = (v: unknown) => fx.expected.findIndex((e) => e['value'] === v)
      const done = fx.expected.findIndex((e) => e['type'] === 'done')
      expect(at(words[0]?.['value'])).toBeLessThan(at(words[1]?.['value']))
      expect(at(words[1]?.['value'])).toBeLessThan(done)
    }
  })
})

describe('CodexNormalizer.expectModel: the default asked for is confirmed only by Codex’s word', () => {
  it('X18a (a plain turn): confirmed by the turn’s first usage total, once', () => {
    const n = normalizer('review')
    n.expectModel('gpt-6-luna', 'gpt-5.6-sol')
    const r = feed(n, X18A)
    expect(modelWords(r)).toEqual([{ value: CONFIRMED, from: 'thread/tokenUsage/updated' }])
  })

  it('X18b (a native Plan): confirmed by thread/settings/updated naming it, before any output', () => {
    const n = normalizer('plan')
    n.expectModel('gpt-6-luna', 'gpt-5.6-sol')
    const r = feed(n, X18B)
    expect(modelWords(r)).toEqual([{ value: CONFIRMED, from: 'thread/settings/updated' }])
    const first = r.entries.findIndex((e) => e.type === 'meta' && e.key === META_MODEL_USED)
    expect(r.entries.slice(0, first).filter((e) => e.type === 'text')).toEqual([])
  })

  it('nothing asked, nothing said; settings naming another model end the wait: no later usage confirms it', () => {
    expect(modelWords(feed(normalizer('review'), X18A))).toEqual([])
    const n = normalizer('plan')
    n.expectModel('gpt-5.6-terra', 'gpt-5.6-sol')
    // X18b's settings name gpt-6-luna, not the model asked for here; its usage totals then confirm nothing.
    expect(modelWords(feed(n, X18B))).toEqual([])
  })

  it('X07 (a resumed thread): the restored total, the prior turn’s, confirms nothing; the turn’s own does', () => {
    const n = normalizer('fix', { resumed: true })
    n.expectModel('gpt-6-luna', 'gpt-5.6-sol')
    const r = feed(n, X07)
    const words = modelWords(r)
    expect(words).toEqual([{ value: CONFIRMED, from: 'thread/tokenUsage/updated' }])
    // The first usage frame X07 holds is the restored total: it came before the turn's id was known.
    const usages = r.methods.filter((m) => m === 'thread/tokenUsage/updated').length
    expect(usages).toBeGreaterThan(1)
  })
})

const step = (o: Partial<StepState>): StepState => ({
  key: 'implement',
  status: 'running',
  attempt: 1,
  spawnNo: 1,
  activeMs: 0,
  inFlightTools: [],
  asks: [],
  snagOpen: false,
  autoRetryUsed: false,
  meta: {},
  vendor: 'codex',
  model: null,
  ...o,
})

const refusal = (model: string): Failure => {
  const text = `The '${model}' model is not supported when using Codex with a ChatGPT account.`
  return { category: 'model_unavailable', message: text, raw: text, classifiedBy: 'regex' }
}

describe('the step while the default is only asked for (core)', () => {
  const asked = step({ modelAsked: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })

  it('the view says it was asked for, never that it ran; the card still awaits Codex’s word', () => {
    const v = toStepView(asked)
    expect(v).toMatchObject({ modelAsked: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(v.modelUsed).toBeUndefined()
    expect(awaitsModelWord(asked, 'app-server')).toBe(true)
    // Confirmed: the model that ran, nothing asked any more.
    const ran = toStepView(step({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' }))
    expect(ran).toMatchObject({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(ran.modelAsked).toBeUndefined()
  })

  it('refused naming the folder’s model: Codex ran that, not the default asked for', () => {
    const v = toStepView({ ...asked, status: 'failed', failure: refusal('gpt-5.6-sol') })
    expect(v).toMatchObject({ modelUsed: 'gpt-5.6-sol', modelOverrideIgnored: 'gpt-6-luna' })
    expect(v.modelAsked).toBeUndefined()
    expect(v.modelReplaced).toBeUndefined()
  })

  it('refused naming the default: still only asked for (the card does not claim it ran)', () => {
    const v = toStepView({ ...asked, status: 'failed', failure: refusal('gpt-6-luna') })
    expect(v).toMatchObject({ modelAsked: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(v.modelUsed).toBeUndefined()
    expect(v.modelOverrideIgnored).toBeUndefined()
  })

  it('the snag’s one click: offered when Codex ran its own choice, not when the default asked for was refused', () => {
    const actions = (o: Partial<SnagActionInput>) =>
      snagActions({
        step: 'implement',
        failure: refusal('gpt-5.6-sol'),
        hasSession: false,
        hints: [],
        at: 0,
        vendor: 'codex',
        vendorName: 'Codex',
        platform: 'win32',
        config: resolveBuiltinConfig({ profile: 'balanced' }),
        accountDefaultModel: 'gpt-6-luna',
        ...o,
      }).map((a) => a.id)
    const sent = { modelAsked: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' }
    expect(actions(sent)[0]).toBe('implement:account-model')
    expect(actions({ ...sent, failure: refusal('gpt-6-luna') })).not.toContain('implement:account-model')
    const neither: Failure = {
      category: 'model_unavailable',
      message: 'model unavailable',
      raw: 'model unavailable',
      classifiedBy: 'regex',
    }
    expect(actions({ ...sent, failure: neither })).not.toContain('implement:account-model')
  })
})

describe('model/rerouted (synthesized frames of the vendored 0.160 schema): the model that runs', () => {
  const TERRA = 'gpt-5.6-terra'
  const turnOf = (fx: Fixture): string => (resultOf(fx, 'turn/start') as { turn: { id: string } }).turn.id
  /** X18a with a `model/rerouted` notification spliced in after the first server frame of method `after`. */
  function withReroute(
    fx: Fixture,
    o: { after: string; turnId?: string; from?: string; to?: string },
  ): Fixture {
    const reroute: Frame = {
      dir: 'out',
      line: JSON.stringify({
        jsonrpc: '2.0',
        method: 'model/rerouted',
        params: {
          threadId: 'thr',
          turnId: o.turnId ?? turnOf(fx),
          fromModel: o.from ?? 'gpt-6-luna',
          toModel: o.to ?? TERRA,
          reason: 'highRiskCyberActivity',
        },
      }),
    }
    const at = fx.frames.findIndex((f) => f.dir === 'out' && message(f)?.['method'] === o.after)
    expect(at, o.after).toBeGreaterThan(-1)
    return { ...fx, frames: [...fx.frames.slice(0, at + 1), reroute, ...fx.frames.slice(at + 1)] }
  }
  const REROUTED = { model: TERRA, rerouted: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }

  it('asked for the default, then rerouted: Codex’s toModel is the model used; no usage total confirms the default', () => {
    const n = normalizer('review')
    n.expectModel('gpt-6-luna', 'gpt-5.6-sol')
    const r = feed(n, withReroute(X18A, { after: 'turn/started' }))
    expect(modelWords(r)).toEqual([{ value: REROUTED, from: 'model/rerouted' }])
  })

  it('rerouted after the confirmation: the reroute is the last word', () => {
    const n = normalizer('review')
    n.expectModel('gpt-6-luna', 'gpt-5.6-sol')
    const r = feed(n, withReroute(X18A, { after: 'thread/tokenUsage/updated' }))
    expect(modelWords(r)).toEqual([
      { value: CONFIRMED, from: 'thread/tokenUsage/updated' },
      { value: REROUTED, from: 'model/rerouted' },
    ])
  })

  it('a pass whose thread named the model that runs (nothing asked): the reroute names the model used', () => {
    const n = normalizer('review')
    n.tracksModel()
    const r = feed(n, withReroute(X18A, { after: 'turn/started', from: 'gpt-5.6-luna' }))
    expect(modelWords(r)).toEqual([
      { value: { model: TERRA, rerouted: 'gpt-5.6-luna' }, from: 'model/rerouted' },
    ])
  })

  it('another turn’s reroute, or one on a pass that names its model, records nothing', () => {
    const other = normalizer('review')
    other.expectModel('gpt-6-luna', 'gpt-5.6-sol')
    const r = feed(other, withReroute(X18A, { after: 'turn/started', turnId: 'turn-other' }))
    // The default asked for is still confirmed by this turn's own usage total.
    expect(modelWords(r)).toEqual([{ value: CONFIRMED, from: 'thread/tokenUsage/updated' }])
    expect(modelWords(feed(normalizer('review'), withReroute(X18A, { after: 'turn/started' })))).toEqual([])
  })

  it('the step: the rerouted model is the model used, never an ignored default', () => {
    const ran = step({ modelUsed: TERRA, modelRerouted: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(toStepView(ran)).toMatchObject({
      modelUsed: TERRA,
      modelRerouted: 'gpt-6-luna',
      modelReplaced: 'gpt-5.6-sol',
    })
    expect(awaitsModelWord(ran, 'app-server')).toBe(false)
    // A refusal naming the folder's model after a reroute: Codex ran the rerouted model, not the folder's.
    const failed = toStepView({ ...ran, status: 'failed', failure: refusal('gpt-5.6-sol') })
    expect(failed).toMatchObject({ modelUsed: TERRA, modelRerouted: 'gpt-6-luna' })
    expect(failed.modelOverrideIgnored).toBeUndefined()
    // Only beside a model used.
    expect(toStepView(step({ modelRerouted: 'gpt-6-luna' })).modelRerouted).toBeUndefined()
  })
})
