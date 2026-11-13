// Codex's "CLI default", decided per pass (the live balanced run's item 10, "Decisions: the CLI
// default"), unit level, on the committed recordings: the model thread/start answered (live X09h names the profile's
// gpt-5.6-sol; live X02 the account's gpt-6-luna) against the account's list (live X01a's model/list, and the same list
// with hidden models), only for a ChatGPT login (listDecides), what turn/start then carries, that the exec route leaves
// the model to the CLI, model_unavailable's one-click fix (Codex only, and only when the account's default can differ
// from what ran, which includes a default the vendor did not run), and when a card still names the model core expects.
import { describe, expect, it } from 'vitest'
import type { Failure } from '@shared/failure.ts'
import type { ModelInfo } from '@shared/vendors.ts'
import {
  ACCOUNT_DEFAULT_VENDORS,
  MODEL_REPORT_ROUTES,
  accountDefaultMayDiffer,
  modelOverrideIgnored,
  namesModel,
} from '@shared/vendors.ts'
import {
  DECISION_LIST_PAGES,
  accountModelsOf,
  decideModel,
  fetchAccountModels,
  listDecides,
  threadModelOf,
} from '@core/adapters/codex/default-model.ts'
import { awaitsModelWord, toRunSnapshot, toStepView } from '@core/supervisor/derive.ts'
import type { StepState } from '@core/supervisor/types.ts'
import type { AccountModels } from '@core/adapters/codex/default-model.ts'
import { execArgv } from '@core/adapters/codex/launch.ts'
import { threadResumeParams, threadStartParams, turnStartParams } from '@core/adapters/codex/params.ts'
import { factsFrom, toModelInfo } from '@core/adapters/codex/probe.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { snagActions } from '@core/recovery/snag-actions.ts'
import type { SnagActionInput } from '@core/recovery/snag-actions.ts'
import { loadFixture, resultOf } from '../codex/protocol/fixtures.ts'
import { T0, makeRun } from '../supervisor/helpers.ts'

const X01A = loadFixture('app-server', 'X01a-handshake-model-list')
const X09H = loadFixture('app-server', 'X09h-error-model-unsupported')
const X02 = loadFixture('app-server', 'X02-review-agent-deltas')
const X13 = loadFixture('app-server', 'X13-local-provider')

/** X01a's live model/list entries (includeHidden:false: no hidden model among them). */
const LIVE_LIST = (resultOf(X01A, 'model/list') as { data: Record<string, unknown>[] }).data
/** The picker's list as the probe keeps it (toModelInfo), then the pass's first look (accountModelsOf). */
const PICKER: ModelInfo[] = LIVE_LIST.map(toModelInfo).filter((m): m is ModelInfo => m !== undefined)
const FIRST_LOOK = accountModelsOf(PICKER)
/** The profile's own model as an entry model/list gives only with includeHidden:true. */
const HIDDEN_SOL = {
  ...LIVE_LIST[1],
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  hidden: true,
  isDefault: false,
}

/** A model/list that answers `pages` in order (each a page's data and next cursor), recording the params. */
function lister(pages: { data: unknown[]; nextCursor: string | null }[] | Error) {
  const asked: Record<string, unknown>[] = []
  let n = 0
  const request = (params: Record<string, unknown>): Promise<unknown> => {
    asked.push(params)
    if (pages instanceof Error) return Promise.reject(pages)
    return Promise.resolve(pages[n++] ?? { data: [], nextCursor: null })
  }
  return { asked, request }
}

describe('the recordings the decision reads', () => {
  it('X09h’s thread/start names the profile’s model; X02’s the account’s; X01a’s list lacks the former', () => {
    expect(threadModelOf(resultOf(X09H, 'thread/start'))).toEqual({
      model: 'gpt-5.6-sol',
      provider: 'openai',
    })
    expect(threadModelOf(resultOf(X02, 'thread/start'))).toEqual({ model: 'gpt-6-luna', provider: 'openai' })
    expect(FIRST_LOOK?.defaultId).toBe('gpt-6-luna')
    expect(FIRST_LOOK?.ids).toEqual(expect.arrayContaining(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']))
    expect(FIRST_LOOK?.ids).not.toContain('gpt-5.6-sol')
    // The probe keeps it as the facts a pass reads, for a ChatGPT login (and nothing of the user's config: it asks for
    // none).
    expect(
      factsFrom({
        schema: {},
        handshake: { ok: true, ms: 1, models: PICKER, unexpected: [], stderr: [] },
        platform: 'linux',
        login: 'chatgpt',
      }).accountModels,
    ).toEqual(FIRST_LOOK)
    expect(
      factsFrom({
        schema: {},
        handshake: { ok: true, ms: 1, models: [], unexpected: [], stderr: [] },
        platform: 'linux',
        login: 'chatgpt',
      }),
    ).not.toHaveProperty('accountModels')
  })

  it('only a ChatGPT login’s list decides: an API key, a token, an unknown login or OPENAI_BASE_URL leave it to the CLI', () => {
    const facts = (login: string | undefined, openaiBaseUrl?: string) =>
      factsFrom({
        schema: {},
        handshake: { ok: true, ms: 1, models: PICKER, unexpected: [], stderr: [] },
        platform: 'win32',
        login,
        openaiBaseUrl,
      })
    expect(facts('chatgpt').accountModels).toEqual(FIRST_LOOK)
    expect(facts('chatgpt', '   ').accountModels).toEqual(FIRST_LOOK)
    for (const [login, url] of [
      ['api_key', undefined],
      ['access_token', undefined],
      ['unknown', undefined],
      [undefined, undefined],
      ['chatgpt', 'https://proxy.example.test/v1'],
    ] as const) {
      expect(facts(login, url), `${login} ${url ?? ''}`).not.toHaveProperty('accountModels')
      expect(listDecides({ login, openaiBaseUrl: url })).toBe(false)
    }
    expect(listDecides({ login: 'chatgpt', openaiBaseUrl: undefined })).toBe(true)
  })
})

describe('decideModel', () => {
  const sol = threadModelOf(resultOf(X09H, 'thread/start'))
  const luna = threadModelOf(resultOf(X02, 'thread/start'))

  it('a model the account does not list (X09h): turn/start carries model/list’s default', () => {
    expect(decideModel(sol, FIRST_LOOK)).toEqual({
      why: 'unlisted',
      runs: 'gpt-6-luna',
      override: 'gpt-6-luna',
      replaced: 'gpt-5.6-sol',
    })
  })

  it('a listed model (X02’s, or the profile’s when the list has it hidden): it runs, nothing is sent', async () => {
    expect(decideModel(luna, FIRST_LOOK)).toEqual({ why: 'listed', runs: 'gpt-6-luna' })
    const { asked, request } = lister([{ data: [...LIVE_LIST, HIDDEN_SOL], nextCursor: null }])
    const all = await fetchAccountModels(request)
    expect(asked).toEqual([{ includeHidden: true }])
    expect(decideModel(sol, all)).toEqual({ why: 'listed', runs: 'gpt-5.6-sol' })
    // Listed by its own id when the CLI resolved that spelling.
    expect(decideModel({ model: 'gpt-5.6-terra', provider: 'OpenAI' }, FIRST_LOOK).why).toBe('listed')
  })

  it('no list, a list without one default, another provider or no model named: left to the CLI', () => {
    expect(decideModel(sol, undefined)).toEqual({ why: 'no-list', runs: 'gpt-5.6-sol' })
    const noDefault: AccountModels = { ids: ['gpt-6-luna'] }
    expect(decideModel(sol, noDefault)).toEqual({ why: 'no-list', runs: 'gpt-5.6-sol' })
    expect(accountModelsOf(PICKER.map((m) => ({ ...m, isDefault: true })))).toBeUndefined()
    expect(accountModelsOf(PICKER.map((m) => ({ ...m, isDefault: false })))).toBeUndefined()
    // X13's thread runs Dim Factory's local provider: model/list does not describe its models.
    const local = threadModelOf(resultOf(X13, 'thread/start'))
    expect(local?.provider).toBe('dim_factory_local')
    expect(decideModel(local, FIRST_LOOK)).toEqual({ why: 'other-provider', runs: local?.model })
    expect(decideModel(threadModelOf({ thread: { id: 't' } }), FIRST_LOOK)).toEqual({ why: 'unknown-model' })
    expect(threadModelOf({ model: 'gpt-5.6-sol' })).toBeUndefined()
  })
})

describe('fetchAccountModels: the whole list or nothing', () => {
  it('reads every page with hidden models, following the cursor', async () => {
    const { asked, request } = lister([
      { data: LIVE_LIST.slice(0, 2), nextCursor: 'c1' },
      { data: [...LIVE_LIST.slice(2), HIDDEN_SOL], nextCursor: null },
    ])
    const all = await fetchAccountModels(request)
    expect(asked).toEqual([{ includeHidden: true }, { includeHidden: true, cursor: 'c1' }])
    expect(all?.defaultId).toBe('gpt-6-luna')
    expect(all?.ids).toEqual(expect.arrayContaining(['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.6-sol']))
  })

  it('a refused request, an unexpected shape or too many pages decide nothing (never override on uncertainty)', async () => {
    expect(await fetchAccountModels(lister(new Error('-32601 method not found')).request)).toBeUndefined()
    for (const bad of [
      { data: 'x', nextCursor: null },
      { data: [{ hidden: true }], nextCursor: null },
      { data: [7], nextCursor: null },
      { data: LIVE_LIST, nextCursor: 3 },
    ]) {
      expect(await fetchAccountModels(lister([bad as never]).request), JSON.stringify(bad)).toBeUndefined()
    }
    const endless = Array.from({ length: DECISION_LIST_PAGES + 1 }, (_, i) => ({
      data: LIVE_LIST,
      nextCursor: `c${i}`,
    }))
    expect(await fetchAccountModels(lister(endless).request)).toBeUndefined()
    // Two defaults: no default to send.
    const two = await fetchAccountModels(
      lister([{ data: LIVE_LIST.map((m) => ({ ...m, isDefault: true })), nextCursor: null }]).request,
    )
    expect(two).toBeDefined()
    expect(two).not.toHaveProperty('defaultId')
  })
})

describe('the model on the wire', () => {
  const base = { step: 'implement' as const, mode: 'autoedit' as const, cwd: '/w' }

  it('a pass with no model starts its thread without one (the CLI resolves it for the folder)', () => {
    expect(threadStartParams({ ...base, model: null })).not.toHaveProperty('model')
    expect(threadResumeParams('thr', { ...base, model: null })).not.toHaveProperty('model')
    expect(threadStartParams({ ...base, model: 'gpt-5.6-terra' }).model).toBe('gpt-5.6-terra')
  })

  it('turn/start carries the override, and only then', () => {
    expect(turnStartParams({ threadId: 't', prompt: 'p', model: 'gpt-6-luna' })).toMatchObject({
      threadId: 't',
      model: 'gpt-6-luna',
    })
    expect(turnStartParams({ threadId: 't', prompt: 'p' })).not.toHaveProperty('model')
  })

  it('exec cannot know the folder’s model before spawn: no -m for a pass that names none', () => {
    expect(execArgv({ ...base, model: null, outFile: '/t/o.txt' })).not.toContain('-m')
    const named = execArgv({ ...base, model: 'gpt-6-luna', outFile: '/t/o.txt' })
    expect(named.slice(named.indexOf('-m'), named.indexOf('-m') + 2)).toEqual(['-m', 'gpt-6-luna'])
  })
})

describe('model_unavailable on a pass with no model', () => {
  const refused = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
  const actions = (o: Partial<SnagActionInput> = {}) =>
    snagActions({
      step: 'implement',
      failure: { category: 'model_unavailable', message: refused, raw: refused, classifiedBy: 'regex' },
      hasSession: false,
      hints: [],
      at: 0,
      vendor: 'codex',
      vendorName: 'Codex',
      platform: 'win32',
      config: resolveBuiltinConfig({ profile: 'balanced' }),
      accountDefaultModel: 'gpt-6-luna',
      ...o,
    })
  const ids = (o: Partial<SnagActionInput>) => actions(o).map((a) => a.id)

  it('the model Codex’s settings chose was refused: one click puts the account’s default on the pass, first', () => {
    for (const ran of [{}, { modelUsed: 'gpt-5.6-sol' }]) {
      const list = actions(ran)
      expect(list[0]).toEqual({
        id: 'implement:account-model',
        label: "Use gpt-6-luna (Codex's default for this account)",
        kind: 'config_patch',
        target: 'resolved',
        ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-6-luna' }],
        preview: '- passes.implement.model: null\n+ passes.implement.model: "gpt-6-luna"',
      })
      // Then the category's other fixes, as before (Choose a default model in Settings, …).
      expect(list.map((a) => a.kind).slice(0, 2)).toEqual(['config_patch', 'settings_link'])
      expect(JSON.stringify(list)).not.toContain('—')
    }
  })

  it('not when the pass ran the account’s default, when the vendor names it refused, or when it is unknown', () => {
    expect(ids({ modelUsed: 'gpt-6-luna' })).not.toContain('implement:account-model')
    const own = "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."
    const ownFailure: Failure = {
      category: 'model_unavailable',
      message: own,
      raw: own,
      classifiedBy: 'regex',
    }
    expect(ids({ failure: ownFailure })).not.toContain('implement:account-model')
    // Dim Factory sent the default in place of gpt-5.6-sol, and the vendor's words name the default: it ran and was refused.
    expect(ids({ failure: ownFailure, modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })).not.toContain(
      'implement:account-model',
    )
    expect(ids({ accountDefaultModel: '' })).not.toContain('implement:account-model')
  })

  it('the vendor did not run the default Dim Factory sent (its words name its own model): the fix is offered', () => {
    // turn/start carried gpt-6-luna in place of gpt-5.6-sol, and the refusal names gpt-5.6-sol: the override was ignored.
    const list = actions({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(list[0]).toMatchObject({
      id: 'implement:account-model',
      ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-6-luna' }],
    })
  })

  it('a refusal is read for whole model ids: a longer id that starts with the default is not the default', () => {
    expect(namesModel("The 'gpt-6-luna' model is not supported.", 'gpt-6-luna')).toBe(true)
    expect(namesModel('Model gpt-6-luna.', 'gpt-6-luna')).toBe(true)
    expect(namesModel("The 'gpt-6-luna-pro' model is not supported.", 'gpt-6-luna')).toBe(false)
    expect(namesModel('gpt-6-luna.1 is not supported', 'gpt-6-luna')).toBe(false)
    expect(namesModel('xgpt-6-luna', 'gpt-6-luna')).toBe(false)
    expect(namesModel('anything', ' ')).toBe(false)
    const longer = "The 'gpt-6-luna-pro' model is not supported when using Codex with a ChatGPT account."
    // The default (gpt-6-luna) is not named by its longer cousin: the fix stays offered for a pass that ran another.
    expect(
      ids({
        failure: { category: 'model_unavailable', message: longer, raw: longer, classifiedBy: 'regex' },
      }),
    ).toContain('implement:account-model')
  })

  it('modelOverrideIgnored: a model_unavailable that names the replaced model and not the one sent', () => {
    const fail = (message: string, category = 'model_unavailable') => ({ category, message, raw: '' })
    const sent = { modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' }
    expect(modelOverrideIgnored({ ...sent, failure: fail(refused) })).toBe(true)
    expect(modelOverrideIgnored({ ...sent, failure: fail("'gpt-6-luna' is not supported") })).toBe(false)
    expect(modelOverrideIgnored({ ...sent, failure: fail(refused, 'network') })).toBe(false)
    expect(modelOverrideIgnored({ modelUsed: 'gpt-6-luna', failure: fail(refused) })).toBe(false)
    expect(modelOverrideIgnored({ ...sent })).toBe(false)
  })

  it('only for Codex: never Gemini (its default is the model such a pass ran), never a local preset', () => {
    expect(ACCOUNT_DEFAULT_VENDORS).toEqual(['codex'])
    expect(accountDefaultMayDiffer('codex')).toBe(true)
    for (const v of ['gemini', 'claude', 'local-ollama', undefined])
      expect(accountDefaultMayDiffer(v)).toBe(false)
    const gemini = resolveBuiltinConfig({
      profile: 'balanced',
      overrides: { passes: { implement: { vendor: 'gemini', model: null } } },
    })
    expect(
      ids({ vendor: 'gemini', vendorName: 'Gemini', config: gemini, accountDefaultModel: 'gemini-3-pro' }),
    ).not.toContain('implement:account-model')
  })

  it('a pass that names a model still gets "Use Codex’s default model" (model null), as before', () => {
    const named = resolveBuiltinConfig({
      profile: 'balanced',
      overrides: { passes: { implement: { model: 'gpt-5.6-sol' } } },
    })
    const list = actions({ config: named })
    expect(list.find((a) => a.kind === 'config_patch')).toMatchObject({
      id: 'implement:default-model',
      label: "Use Codex's default model",
      ops: [{ op: 'replace', path: '/passes/implement/model', value: null }],
    })
    expect(list.map((a) => a.id)).not.toContain('implement:account-model')
  })
})

describe('the model a card names for a pass with no model (core)', () => {
  const step = (o: Partial<StepState>): StepState => ({
    key: 'implement',
    status: 'queued',
    attempt: 0,
    spawnNo: 0,
    activeMs: 0,
    inFlightTools: [],
    asks: [],
    snagOpen: false,
    autoRetryUsed: false,
    meta: {},
    ...o,
  })

  it('expected while queued, and while it runs where its vendor says which model before its turn, until it has said', () => {
    // "Model wording" item 2: Claude's init names the session's model before any output of its turn.
    expect(MODEL_REPORT_ROUTES).toEqual(['app-server', 'stdio'])
    expect(awaitsModelWord(step({}), undefined)).toBe(true)
    expect(awaitsModelWord(step({}), 'exec')).toBe(true)
    const running = step({ status: 'running', attempt: 1, spawnNo: 1 })
    expect(awaitsModelWord(running, 'app-server')).toBe(true)
    expect(awaitsModelWord({ ...running, status: 'waiting' }, 'app-server')).toBe(true)
    expect(awaitsModelWord({ ...running, status: 'paused' }, 'app-server')).toBe(true)
    // Said: a model, or none.
    expect(awaitsModelWord({ ...running, modelUsed: 'gpt-6-luna' }, 'app-server')).toBe(false)
    expect(awaitsModelWord({ ...running, modelUnreported: true }, 'app-server')).toBe(false)
    expect(awaitsModelWord(running, 'stdio')).toBe(true)
    expect(awaitsModelWord({ ...running, modelUsed: 'claude-opus-5-5' }, 'stdio')).toBe(false)
    // Where the vendor never says (Codex exec, Gemini), or no route known: nothing once it runs.
    for (const route of ['exec', 'acp', undefined]) expect(awaitsModelWord(running, route)).toBe(false)
    // Ended: nothing, whatever the route (the card says the vendor did not report which model ran).
    for (const status of ['done', 'failed', 'cancelled', 'skipped'] as const)
      expect(awaitsModelWord({ ...running, status }, 'app-server')).toBe(false)
  })

  it('a default the vendor did not run: the view names the model the vendor ran, never the default', () => {
    const refused = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
    const failure: Failure = {
      category: 'model_unavailable',
      message: refused,
      raw: refused,
      classifiedBy: 'regex',
    }
    const failed = step({
      status: 'failed',
      attempt: 1,
      spawnNo: 1,
      vendor: 'codex',
      model: null,
      modelUsed: 'gpt-6-luna',
      modelReplaced: 'gpt-5.6-sol',
      failure,
    })
    const v = toStepView(failed)
    expect(v).toMatchObject({ modelUsed: 'gpt-5.6-sol', modelOverrideIgnored: 'gpt-6-luna' })
    expect(v.modelReplaced).toBeUndefined()
    // The default itself refused: it ran, as the step says.
    const own = "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."
    const ran = toStepView({ ...failed, failure: { ...failure, message: own, raw: own } })
    expect(ran).toMatchObject({ modelUsed: 'gpt-6-luna', modelReplaced: 'gpt-5.6-sol' })
    expect(ran.modelOverrideIgnored).toBeUndefined()
    // Still running (no refusal yet): the default Dim Factory sent.
    expect(toStepView({ ...failed, status: 'running' })).toMatchObject({
      modelUsed: 'gpt-6-luna',
      modelReplaced: 'gpt-5.6-sol',
    })
  })
})

describe('a pass whose launch is under way (begun, nothing spawned yet)', () => {
  it('shows what it is configured to run with, as while queued, so its row and chips do not blank until the spawn', () => {
    const s = makeRun()
    s.started = true
    s.config.passes.implement = {
      ...s.config.passes.implement,
      vendor: 'codex',
      model: null,
      mode: 'autoedit',
    }
    const inputs = { expectedModel: { implement: 'gpt-6-luna' } }
    const queued = toRunSnapshot(s, 0, T0, inputs).steps.implement
    expect(queued).toMatchObject({
      vendor: 'codex',
      model: null,
      mode: 'autoedit',
      expectedModel: 'gpt-6-luna',
    })
    // Its preflight and start snapshot: running, attempt 1, no spawn yet.
    s.steps.implement.status = 'running'
    s.steps.implement.attempt = 1
    const launching = toRunSnapshot(s, 0, T0, inputs).steps.implement
    expect(launching).toMatchObject({
      vendor: 'codex',
      model: null,
      mode: 'autoedit',
      expectedModel: 'gpt-6-luna',
    })
    // Spawned: what the spawn recorded (the same config).
    s.steps.implement.spawnNo = 1
    expect(toRunSnapshot(s, 0, T0, inputs).steps.implement.vendor).toBeUndefined()
  })
})
