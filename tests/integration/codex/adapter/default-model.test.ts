// Codex's "CLI default", decided per pass, through the real adapter, resolver and spawn path and the fake CLI
// (a model the account's list lacks is decided per pass), on the committed recordings:
// the probe replays live X01a (model/list for the picker, nothing more), and each pass with no model of its own starts
// its thread without one and is answered as the live CLI answered (X09h's thread/start names the profile's gpt-5.6-sol,
// X02's the account's gpt-6-luna). Then:
//   - an unlisted model: the pass reads the whole list (model/list{includeHidden:true}) and turn/start carries the
//     account's default (Plan's native collaboration mode too; Fix's thread/resume the same), recorded as the model used;
//   - a listed model (visible, or hidden and listed): nothing is sent, and the model the thread named is the one used;
//   - no list (no probe), or a list that cannot be read: nothing is sent;
//   - a login other than ChatGPT's (an API key), or the openai provider behind OPENAI_BASE_URL: the probe keeps no list
//     to decide by, so a model the list lacks runs as the CLI chose it (nothing is sent);
//   - a thread answer without a model: the pass says so (`{model: null}`), so the card stops expecting one;
//   - a pass that names its model, or runs a local preset, decides nothing; the exec route leaves it to the CLI.
import { describe, expect, it } from 'vitest'
import { accountModelsOf } from '../../../../src/core/adapters/codex/default-model.ts'
import { toModelInfo } from '../../../../src/core/adapters/codex/probe.ts'
import { META_MODEL_USED } from '../../../../src/core/adapters/types.ts'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import type { ModelInfo } from '../../../../src/shared/vendors.ts'
import type { Entry, Fixture, Op, ScenarioEntry } from './helpers.ts'
import {
  COMMITTED_SCHEMA,
  drive,
  eventsOf,
  fakeCodex,
  fakeSetup,
  loadFixture,
  scenario,
  tempDir,
} from './helpers.ts'
import { join } from 'node:path'

const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }
const LOGIN_IN: ScenarioEntry = {
  match: { argvIncludes: ['login', 'status'] },
  script: [
    { op: 'stderr', line: 'Logged in using ChatGPT' },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}
/** `codex login status` for an API-key login (the key fragment the CLI prints is made up). */
const LOGIN_API_KEY: ScenarioEntry = {
  match: { argvIncludes: ['login', 'status'] },
  script: [
    { op: 'stderr', line: 'Logged in using an API key - sk-test-****' },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}
const SCHEMA: ScenarioEntry = {
  match: { argvIncludes: ['generate-json-schema'] },
  script: [
    {
      op: 'copyFiles',
      from: join(COMMITTED_SCHEMA, 'codex_app_server_protocol.schemas.json'),
      argvPath: '--out',
    },
    { op: 'exit', code: 0 },
  ],
  repeat: true,
}

const X01A = loadFixture('app-server', 'X01a-handshake-model-list')
const X09H = loadFixture('app-server', 'X09h-error-model-unsupported')
const X02 = loadFixture('app-server', 'X02-review-agent-deltas')
const X07 = loadFixture('app-server', 'X07-fix-resume-new-process')
const X12A = loadFixture('app-server', 'X12a-plan-native-item')
const X13 = loadFixture('app-server', 'X13-local-provider')
const X18A = loadFixture('app-server', 'X18a-default-model-turn-override')
const X18B = loadFixture('app-server', 'X18b-default-model-plan-override')

/** What the live CLI answered to the recording's first request for `method`. */
function answerTo(f: Fixture, method: string): Record<string, unknown> {
  const req = f.inMessages.find(
    (m): m is { id: number; method: string } =>
      typeof m === 'object' && m !== null && (m as { method?: unknown }).method === method && 'id' in m,
  )
  for (const fr of f.frames) {
    if (fr['dir'] !== 'out' || typeof fr['line'] !== 'string') continue
    const msg = JSON.parse(fr['line']) as { id?: unknown; result?: Record<string, unknown> }
    if (req !== undefined && msg.id === req.id && msg.result !== undefined) return msg.result
  }
  throw new Error(`${f.id}: no answer to ${method}`)
}

/** Live X01a's model/list entries (asked without hidden models). */
const LIVE_LIST = answerTo(X01A, 'model/list')['data'] as Record<string, unknown>[]
/** The same list asked with hidden models, as an account that still has the profile's gpt-5.6-sol hidden. */
const WITH_HIDDEN_SOL = [
  ...LIVE_LIST,
  { ...LIVE_LIST[1], id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', hidden: true, isDefault: false },
]
const PICKER = LIVE_LIST.map(toModelInfo).filter((m): m is ModelInfo => m !== undefined)
/** The facts a probe of live X01a leaves (the pass's first look). */
const FIRST_LOOK = accountModelsOf(PICKER)

/** X09h's live thread/start answer: the CLI resolved the profile's gpt-5.6-sol for the folder. */
const SOL_THREAD = answerTo(X09H, 'thread/start')

/** The params of a recording's first `method` notification. */
function notificationOf(f: Fixture, method: string): Record<string, unknown> {
  for (const fr of f.frames) {
    if (fr['dir'] !== 'out' || typeof fr['line'] !== 'string') continue
    const msg = JSON.parse(fr['line']) as { method?: unknown; params?: Record<string, unknown> }
    if (msg.method === method && msg.params !== undefined) return msg.params
  }
  throw new Error(`${f.id}: no ${method}`)
}

/** X09h's live refusal of the profile's model (error{willRetry:false}'s params, without its ids). */
const REFUSAL = (() => {
  const { threadId: _t, turnId: _u, willRetry: _w, ...rest } = notificationOf(X09H, 'error')
  return rest as { error: Record<string, unknown> }
})()

const handshake: Op[] = [
  { op: 'rpcExpect', method: 'initialize', as: 'init', params: { clientInfo: { name: 'dim-factory' } } },
  { op: 'rpcResult', id: '$init', result: answerTo(X09H, 'initialize') },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
]

/**
 * One pass's app-server: the thread request (no model in it) answered with `answer`, then (`list`) the pass's own
 * model/list with hidden models, then turn/start carrying `turnModel` (absent when undefined), a completed turn, EOF.
 */
function passServer(o: {
  method?: 'thread/start' | 'thread/resume'
  /** The thread request's params (partial); default: it names no model. */
  threadParams?: Record<string, unknown>
  answer: Record<string, unknown>
  list?: Record<string, unknown>[] | 'refused'
  turnModel?: string
  turnParams?: Record<string, unknown>
  /**
   * Live X18a/b: what Codex says after the turn's response. `usage`: a usage total of this turn (a model call ran,
   * X18a); `settings`: thread/settings/updated naming `turnModel` (a native Plan's, X18b); `settings-other`: one naming
   * another model; `refused`: X09h's refusal of the thread's own model, the turn failed (no usage). Default: nothing.
   * `rerouted`: model/rerouted of this turn (the vendored 0.160 schema; not seen live), from the turn's model
   * (`turnModel`, else the thread's) to gpt-5.6-terra.
   */
  after?: 'usage' | 'settings' | 'settings-other' | 'refused' | 'rerouted'
}): Op[] {
  const threadId = (o.answer['thread'] as { id: string }).id
  const ops: Op[] = [
    ...handshake,
    {
      op: 'rpcExpect',
      method: o.method ?? 'thread/start',
      as: 'th',
      params: o.threadParams ?? { model: { $absent: true } },
    },
    { op: 'rpcResult', id: '$th', result: o.answer },
  ]
  if (o.list === 'refused') {
    ops.push(
      { op: 'rpcExpect', method: 'model/list', as: 'ml', params: { includeHidden: true } },
      { op: 'rpcError', id: '$ml', error: { code: -32603, message: 'model catalog unavailable' } },
    )
  } else if (o.list !== undefined) {
    ops.push(
      { op: 'rpcExpect', method: 'model/list', as: 'ml', params: { includeHidden: true } },
      { op: 'rpcResult', id: '$ml', result: { data: o.list, nextCursor: null } },
    )
  }
  ops.push({
    op: 'rpcExpect',
    method: 'turn/start',
    as: 'tu',
    params: {
      threadId,
      model: o.turnModel !== undefined ? o.turnModel : { $absent: true },
      ...o.turnParams,
    },
  })
  const turnResult = { turn: { id: 'turn-1', status: 'inProgress' } }
  const from = o.turnModel ?? (typeof o.answer['model'] === 'string' ? o.answer['model'] : 'gpt-5.6-sol')
  const behind =
    o.after === 'usage'
      ? usageOf(threadId, 'turn-1')
      : o.after === 'rerouted'
        ? {
            method: 'model/rerouted',
            params: {
              threadId,
              turnId: 'turn-1',
              fromModel: from,
              toModel: 'gpt-5.6-terra',
              reason: 'highRiskCyberActivity',
            },
          }
        : undefined
  if (behind === undefined) ops.push({ op: 'rpcResult', id: '$tu', result: turnResult })
  else {
    // The response and the notification of its turn in one write, as one pipe read on Linux often holds them: the
    // notification is handled before the awaited response, and must still be matched to the turn.
    ops.push({
      op: 'stdout',
      raw: `{"id":$tu,"result":${JSON.stringify(turnResult)}}\n${JSON.stringify(behind)}\n`,
    })
  }
  if (o.after === 'settings' || o.after === 'settings-other') {
    const model = o.after === 'settings' ? (o.turnModel ?? 'gpt-6-luna') : 'gpt-5.6-terra'
    ops.push({ op: 'stdout', json: settingsOf(threadId, model) })
  }
  if (o.after === 'refused') {
    ops.push(
      {
        op: 'stdout',
        json: { method: 'error', params: { ...REFUSAL, willRetry: false, threadId, turnId: 'turn-1' } },
      },
      {
        op: 'stdout',
        json: {
          method: 'turn/completed',
          params: { threadId, turn: { id: 'turn-1', items: [], status: 'failed', error: REFUSAL.error } },
        },
      },
    )
  } else {
    ops.push({
      op: 'stdout',
      json: {
        method: 'turn/completed',
        params: { threadId, turn: { id: 'turn-1', items: [], status: 'completed', error: null } },
      },
    })
  }
  ops.push({ op: 'expectEof' }, { op: 'exit', code: 0 })
  return ops
}

/** Live X18a's first usage total, for `turnId` of `threadId`: a model call of that turn ran. */
function usageOf(threadId: string, turnId: string): Record<string, unknown> {
  const live = notificationOf(X18A, 'thread/tokenUsage/updated')
  return { method: 'thread/tokenUsage/updated', params: { ...live, threadId, turnId } }
}

/** Live X18b's thread/settings/updated (gpt-6-luna in plan mode), naming `model` instead. */
function settingsOf(threadId: string, model: string): Record<string, unknown> {
  const live = notificationOf(X18B, 'thread/settings/updated')
  const settings = live['threadSettings'] as Record<string, unknown>
  return {
    method: 'thread/settings/updated',
    params: { ...live, threadId, threadSettings: { ...settings, model } },
  }
}

const review = (cwd: string, o: Partial<StartOptions> = {}): StartOptions => ({
  runId: 'run-default-model',
  step: 'review',
  cwd,
  prompt: 'Review the change.',
  mode: 'readonly',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  model: null,
  ...o,
})

/** The params of the requests of one method the fake read (every process of the world), in order. */
function sent(lines: unknown[], method: string): Record<string, unknown>[] {
  return lines
    .filter((m): m is { method: string; params?: Record<string, unknown> } => {
      return typeof m === 'object' && m !== null && (m as { method?: unknown }).method === method
    })
    .map((m) => m.params ?? {})
}

const modelUsed = (entries: readonly Entry[]): unknown[] =>
  entries.flatMap((e) => (e.type === 'meta' && e.key === META_MODEL_USED ? [e.value] : []))

/** App-servers in order (each entry is claimed once: FAKE_CLI_STATE); the probe first when `probe` is given. */
async function world(
  passes: Op[][],
  o: { probe?: boolean; facts?: boolean; login?: ScenarioEntry; env?: Record<string, string> } = {},
) {
  return fakeCodex(
    await fakeSetup(),
    scenario([
      o.login ?? LOGIN_IN,
      SCHEMA,
      ...(o.probe === true ? [{ match: APP_SERVER, script: X01A.recording }] : []),
      ...passes.map((script) => ({ match: APP_SERVER, script })),
    ]),
    {
      adapter: { vendorEnv: { FAKE_CLI_STATE: tempDir('codex-state-'), ...o.env } },
      ...(o.facts === true && FIRST_LOOK !== undefined ? { facts: { accountModels: FIRST_LOOK } } : {}),
    },
  )
}

const noErrors = (fake: Awaited<ReturnType<typeof world>>): void =>
  expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])

describe('a pass with no model (Codex’s CLI default), on the recordings', () => {
  it('X01a’s list lacks X09h’s gpt-5.6-sol: the pass reads the whole list, and turn/start carries the default', async () => {
    const fake = await world(
      [passServer({ answer: SOL_THREAD, list: LIVE_LIST, turnModel: 'gpt-6-luna', after: 'usage' })],
      { probe: true },
    )
    // The probe asks the picker's list and nothing more (no config/read).
    await fake.adapter.probe()
    expect(fake.adapter.facts().accountModels).toEqual(FIRST_LOOK)
    const d = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    noErrors(fake)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    // Asked for before the turn, and recorded as the model that ran once Codex reported a model call of the turn.
    expect(modelUsed(d.entries)).toEqual([
      { asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' },
      { model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' },
    ])
    const lines = fake.stdinLines()
    expect(sent(lines, 'model/list')).toEqual([{ includeHidden: false }, { includeHidden: true }])
    expect(sent(lines, 'config/read')).toEqual([])
    expect(sent(lines, 'thread/start')[0]).not.toHaveProperty('model')
    expect(sent(lines, 'turn/start')[0]).toMatchObject({ model: 'gpt-6-luna' })
  }, 90_000)

  it('a listed model (X02’s gpt-6-luna; gpt-5.6-sol when the account has it hidden): nothing is sent', async () => {
    const fake = await world(
      [
        passServer({ answer: answerTo(X02, 'thread/start') }),
        passServer({ answer: SOL_THREAD, list: WITH_HIDDEN_SOL }),
      ],
      { facts: true },
    )
    const visible = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    const hidden = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    noErrors(fake)
    for (const d of [visible, hidden]) expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(modelUsed(visible.entries)).toEqual([{ model: 'gpt-6-luna' }])
    expect(modelUsed(hidden.entries)).toEqual([{ model: 'gpt-5.6-sol' }])
    const lines = fake.stdinLines()
    // The picker's list had gpt-6-luna: only the pass whose model it lacked read the list with hidden models.
    expect(sent(lines, 'model/list')).toEqual([{ includeHidden: true }])
    expect(sent(lines, 'turn/start').map((p) => p['model'])).toEqual([undefined, undefined])
  }, 90_000)

  it('no list (no probe yet), or a list that cannot be read: nothing is sent, the CLI’s model runs', async () => {
    const none = await world([passServer({ answer: SOL_THREAD })])
    const d = await drive(none.adapter, review(tempDir('codex-cwd-')))
    noErrors(none)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(modelUsed(d.entries)).toEqual([{ model: 'gpt-5.6-sol' }])
    expect(sent(none.stdinLines(), 'model/list')).toEqual([])

    const refused = await world([passServer({ answer: SOL_THREAD, list: 'refused' })], { facts: true })
    const r = await drive(refused.adapter, review(tempDir('codex-cwd-')))
    noErrors(refused)
    expect(eventsOf(r.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(modelUsed(r.entries)).toEqual([{ model: 'gpt-5.6-sol' }])
    expect(sent(refused.stdinLines(), 'turn/start')[0]).not.toHaveProperty('model')
  }, 90_000)

  it('an API-key login, or OPENAI_BASE_URL with ChatGPT’s: the list decides nothing, X09h’s gpt-5.6-sol runs as chosen', async () => {
    for (const o of [
      { login: LOGIN_API_KEY },
      { env: { OPENAI_BASE_URL: 'https://proxy.example.test/v1' } },
    ]) {
      const fake = await world([passServer({ answer: SOL_THREAD })], { probe: true, ...o })
      const probe = await fake.adapter.probe()
      // The probe still lists the picker's models; the pass has no list to judge by.
      expect(probe.models.map((m) => m.id)).toEqual(PICKER.map((m) => m.id))
      expect(fake.adapter.facts()).not.toHaveProperty('accountModels')
      const d = await drive(fake.adapter, review(tempDir('codex-cwd-')))
      noErrors(fake)
      expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
      expect(modelUsed(d.entries)).toEqual([{ model: 'gpt-5.6-sol' }])
      const lines = fake.stdinLines()
      expect(sent(lines, 'model/list')).toEqual([{ includeHidden: false }])
      expect(sent(lines, 'turn/start')[0]).not.toHaveProperty('model')
    }
  }, 90_000)

  it('a thread answer without a model: nothing is decided or sent, and the pass says it names none', async () => {
    const { model: _model, ...noModel } = SOL_THREAD
    const fake = await world([passServer({ answer: noModel })], { facts: true })
    const d = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    noErrors(fake)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(modelUsed(d.entries)).toEqual([{ model: null }])
    expect(sent(fake.stdinLines(), 'model/list')).toEqual([])
    expect(sent(fake.stdinLines(), 'turn/start')[0]).not.toHaveProperty('model')
  }, 90_000)

  it('native Plan runs the override in its collaboration mode; Fix’s thread/resume is decided the same way', async () => {
    const plan = { ...answerTo(X12A, 'thread/start'), model: 'gpt-5.6-sol' }
    const resumed: Record<string, unknown> = { ...answerTo(X07, 'thread/resume'), model: 'gpt-5.6-sol' }
    const resumedId = (resumed['thread'] as { id: string }).id
    const fake = await world(
      [
        passServer({
          answer: plan,
          list: LIVE_LIST,
          turnModel: 'gpt-6-luna',
          turnParams: { collaborationMode: { mode: 'plan', settings: { model: 'gpt-6-luna' } } },
          after: 'settings',
        }),
        passServer({
          method: 'thread/resume',
          answer: resumed,
          list: LIVE_LIST,
          turnModel: 'gpt-6-luna',
          after: 'usage',
        }),
      ],
      { facts: true },
    )
    const p = await drive(fake.adapter, review(tempDir('codex-cwd-'), { step: 'plan', planNative: true }))
    const f = await drive(
      fake.adapter,
      review(tempDir('codex-cwd-'), { step: 'fix', mode: 'autoedit', resume: { sessionId: resumedId } }),
    )
    noErrors(fake)
    // Plan's confirmed by thread/settings/updated naming it (X18b), Fix's by its turn's usage total (X18a).
    for (const d of [p, f])
      expect(modelUsed(d.entries)).toEqual([
        { asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' },
        { model: 'gpt-6-luna', replaced: 'gpt-5.6-sol' },
      ])
    const lines = fake.stdinLines()
    expect(sent(lines, 'thread/resume')[0]).toMatchObject({ threadId: resumedId })
    expect(sent(lines, 'thread/resume')[0]).not.toHaveProperty('model')
    expect(sent(lines, 'turn/start').map((x) => x['model'])).toEqual(['gpt-6-luna', 'gpt-6-luna'])
  }, 90_000)

  it('the default asked for is not the model that ran until Codex says so: a refusal, another model named, or silence confirms nothing', async () => {
    const fake = await world(
      [
        // X09h's refusal of gpt-5.6-sol: the turn failed before any model call.
        passServer({ answer: SOL_THREAD, list: LIVE_LIST, turnModel: 'gpt-6-luna', after: 'refused' }),
        // thread/settings/updated naming another model than the one asked for.
        passServer({ answer: SOL_THREAD, list: LIVE_LIST, turnModel: 'gpt-6-luna', after: 'settings-other' }),
        // nothing after the turn's response (no usage, no settings).
        passServer({ answer: SOL_THREAD, list: LIVE_LIST, turnModel: 'gpt-6-luna' }),
      ],
      { facts: true },
    )
    const refused = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    const other = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    const silent = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    noErrors(fake)
    expect(eventsOf(refused.entries).at(-1)).toMatchObject({ type: 'error', category: 'model_unavailable' })
    for (const d of [refused, other, silent])
      expect(modelUsed(d.entries)).toEqual([{ asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }])
    expect(sent(fake.stdinLines(), 'turn/start').map((x) => x['model'])).toEqual([
      'gpt-6-luna',
      'gpt-6-luna',
      'gpt-6-luna',
    ])
  }, 90_000)

  it('a turn Codex reroutes names the model that ran, with or without a default asked for; not on a named pass', async () => {
    const fake = await world(
      [
        // The default asked for in place of X09h's gpt-5.6-sol, then rerouted.
        passServer({ answer: SOL_THREAD, list: LIVE_LIST, turnModel: 'gpt-6-luna', after: 'rerouted' }),
        // A pass that names its model: priced at its own, nothing recorded.
        passServer({
          threadParams: { model: 'gpt-5.6-luna' },
          answer: { ...SOL_THREAD, model: 'gpt-5.6-luna' },
          after: 'rerouted',
        }),
      ],
      { facts: true },
    )
    // No list (no probe yet): the thread's gpt-5.6-sol runs, nothing asked, then rerouted.
    const noList = await world([passServer({ answer: SOL_THREAD, after: 'rerouted' })])
    const asked = await drive(fake.adapter, review(tempDir('codex-cwd-')))
    const named = await drive(fake.adapter, review(tempDir('codex-cwd-'), { model: 'gpt-5.6-luna' }))
    const own = await drive(noList.adapter, review(tempDir('codex-cwd-')))
    noErrors(fake)
    noErrors(noList)
    for (const d of [asked, own, named]) expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(modelUsed(asked.entries)).toEqual([
      { asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' },
      { model: 'gpt-5.6-terra', rerouted: 'gpt-6-luna', replaced: 'gpt-5.6-sol' },
    ])
    expect(modelUsed(own.entries)).toEqual([
      { model: 'gpt-5.6-sol' },
      { model: 'gpt-5.6-terra', rerouted: 'gpt-5.6-sol' },
    ])
    expect(modelUsed(named.entries)).toEqual([])
  }, 90_000)

  it('a resumed thread’s restored total (the prior turn’s) does not confirm the default asked for', async () => {
    const resumed: Record<string, unknown> = { ...answerTo(X07, 'thread/resume'), model: 'gpt-5.6-sol' }
    const resumedId = (resumed['thread'] as { id: string }).id
    const ops = passServer({
      method: 'thread/resume',
      answer: resumed,
      list: LIVE_LIST,
      turnModel: 'gpt-6-luna',
    })
    // As live X07: the restored total (the prior turn's id) comes after turn/start is sent, before its response.
    const at = ops.findIndex((op) => op['op'] === 'rpcResult' && op['id'] === '$tu')
    ops.splice(at, 0, { op: 'stdout', json: usageOf(resumedId, 'turn-prior') })
    const fake = await world([ops], { facts: true })
    const d = await drive(
      fake.adapter,
      review(tempDir('codex-cwd-'), { step: 'fix', mode: 'autoedit', resume: { sessionId: resumedId } }),
    )
    noErrors(fake)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(modelUsed(d.entries)).toEqual([{ asked: 'gpt-6-luna', replaced: 'gpt-5.6-sol' }])
  }, 90_000)

  it('a pass that names its model, or runs a local preset (X13’s thread), decides nothing', async () => {
    const local = X13.header.pass?.local
    if (local === undefined) throw new Error('X13 names no preset')
    const fake = await world(
      [
        passServer({
          threadParams: { model: 'gpt-5.6-terra' },
          answer: { ...SOL_THREAD, model: 'gpt-5.6-terra' },
        }),
        passServer({ threadParams: { model: local.model }, answer: answerTo(X13, 'thread/start') }),
      ],
      { facts: true },
    )
    const named = await drive(fake.adapter, review(tempDir('codex-cwd-'), { model: 'gpt-5.6-terra' }))
    const preset = await drive(
      fake.adapter,
      review(tempDir('codex-cwd-'), { step: 'implement', mode: 'autoedit', local }),
    )
    noErrors(fake)
    for (const d of [named, preset]) {
      expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
      expect(modelUsed(d.entries)).toEqual([])
    }
    expect(sent(fake.stdinLines(), 'model/list')).toEqual([])
  }, 90_000)

  it('the exec route cannot know the folder’s model before spawn: no -m, nothing recorded (live E03 argv)', async () => {
    const e03 = loadFixture('exec', 'E03-escalation-auto-denied')
    expect(e03.header.argv).not.toContain('-m')
    const fake = fakeCodex(
      await fakeSetup(),
      scenario([{ match: { argvIncludes: ['exec', '--json'] }, script: e03.recording, repeat: true }]),
      { facts: { route: 'exec', ...(FIRST_LOOK !== undefined ? { accountModels: FIRST_LOOK } : {}) } },
    )
    const d = await drive(fake.adapter, {
      ...review(tempDir('codex-cwd-'), { step: 'implement', mode: 'autoedit' }),
      prompt: e03.inMessages[0] as string,
    })
    noErrors(fake)
    const argv = fake
      .logEntries()
      .find((e) => e['kind'] === 'start' && (e['argv'] as string[]).includes('exec'))?.['argv'] as string[]
    expect(argv).not.toContain('-m')
    expect(modelUsed(d.entries)).toEqual([])
  }, 90_000)
})
