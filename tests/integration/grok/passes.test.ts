// Grok passes through the real adapter and spawn path against hand-written recordings (`grok agent stdio` with
// GROK_DISABLE_AUTOUPDATER=1; the "Grok ACP" mode row; the decision table; the failure categories). What
// the GR fixtures do not cover: the child env, the user's flags, an ask the user answers (never an option that widens
// the session), a continued session carrying the posture, and Grok's own failure texts.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../acp/adapter/helpers.ts'
import {
  checkInvariants,
  drive,
  eof,
  eventsOf,
  exitFrame,
  expectNoMismatch,
  fakeSetup,
  inReq,
  inRes,
  outErr,
  outReq,
  outRes,
  recording,
  signalsOf,
  tempDir,
  update,
} from '../acp/adapter/helpers.ts'
import { fakeGrok, grokStartOptions, stdioScenario } from './helpers.ts'

const SESSION = '0199d2a4-7c1e-7a3b-9f20-3c4d5e6f7101'
const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'dim-factory', title: 'Dim Factory', version: '0.1.0' },
}
const initResult = (resume = true): Record<string, unknown> => ({
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: resume ? { close: {}, list: {}, resume: {} } : { close: {} },
  },
  authMethods: [],
})
const ASK = { yoloMode: false, autoMode: false }
const YOLO = { yoloMode: true }
const chunk = (text: string): Frame =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, SESSION)
const answer = (input: number, output: number, cached = 0): Record<string, unknown> => ({
  stopReason: 'end_turn',
  _meta: {
    sessionId: SESSION,
    usage: {
      totalTokens: input + cached + output,
      modelUsage: { 'grok-4.6': { inputTokens: input, outputTokens: output, cacheReadInputTokens: cached } },
    },
  },
})
const rec = (frames: Frame[]): string => recording({ scenario: 'grok-pass', vendor: 'grok' }, frames)
const newSession = (meta: Record<string, unknown>, id = 2): Frame[] => [
  inReq(id, 'session/new', { cwd: '<CWD>', mcpServers: [], _meta: meta }),
  outRes(id, { sessionId: SESSION }),
]
const promptReq = (id: number, text: string): Frame =>
  inReq(id, 'session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text }] })

describe('Grok pass launch', () => {
  it('the child env: GROK_DISABLE_AUTOUPDATER=1 above the user, folder-trust and sandbox auto-allow switches dropped', async () => {
    const setup = await fakeSetup()
    const file = rec([
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, initResult()),
      ...newSession(ASK),
      promptReq(3, 'Review the change.'),
      chunk('No findings.'),
      outRes(3, answer(100, 10)),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGrok(setup, stdioScenario(file), {
      env: { GROK_FOLDER_TRUST: '0', Grok_Sandbox_Auto_Allow_Bash: '1' },
      vendorEnv: { GROK_DISABLE_AUTOUPDATER: '0', GROK_FOLDER_TRUST: '0', XAI_API_KEY: 'k' },
      logEnv: [
        'GROK_DISABLE_AUTOUPDATER',
        'GROK_FOLDER_TRUST',
        'GROK_SANDBOX_AUTO_ALLOW_BASH',
        'XAI_API_KEY',
      ],
    })
    const d = await drive(fake.adapter, grokStartOptions(tempDir('grok-env-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: true })
    const starts = fake.starts()
    const env = fake.startEnv()[starts.findIndex((a) => a.includes('stdio'))]!
    expect(env['GROK_DISABLE_AUTOUPDATER']).toBe('1')
    expect(env['GROK_FOLDER_TRUST']).toBeNull()
    expect(env['GROK_SANDBOX_AUTO_ALLOW_BASH']).toBeNull()
    // The user's own key still reaches Grok (it signs in with it).
    expect(env['XAI_API_KEY']).toBe('k')
    // Every Grok process Dim Factory starts (the resolver's --version and the agent) never updates itself.
    for (const e of fake.startEnv()) expect(e['GROK_DISABLE_AUTOUPDATER']).toBe('1')
  })

  it('extraArgs go before `stdio` (agent options); a flagMap renames a managed flag; a refused flag never spawns', async () => {
    const setup = await fakeSetup()
    const file = rec([
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, initResult()),
      ...newSession(ASK),
      promptReq(3, 'Review the change.'),
      chunk('Fine.'),
      outRes(3, answer(10, 1)),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGrok(setup, stdioScenario(file))
    const o = grokStartOptions(tempDir('grok-args-'), {
      model: 'grok-4.5',
      extraArgs: ['--agent-profile', 'reviewer.json'],
      flagMap: { '--no-leader': '--local' },
    })
    const d = await drive(fake.adapter, o)
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(fake.starts().find((a) => a.includes('stdio'))).toEqual([
      'agent',
      '--model',
      'grok-4.5',
      '--local',
      '--agent-profile',
      'reviewer.json',
      'stdio',
    ])

    const refused = fakeGrok(setup, stdioScenario(file))
    const r = await drive(
      refused.adapter,
      grokStartOptions(tempDir('grok-args-'), { mode: 'full', step: 'implement', extraArgs: ['--yolo'] }),
    )
    expect(eventsOf(r.entries)).toEqual([
      expect.objectContaining({ type: 'error', category: 'config_invalid' }),
    ])
    expect(refused.starts()).toEqual([])
  })
})

describe("a read-only pass the user's allow rules would widen never starts", () => {
  it("a Review with an Edit allow rule in the user's Claude settings is refused before spawning", async () => {
    const setup = await fakeSetup()
    const file = rec([
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, initResult()),
      ...newSession(ASK),
      promptReq(3, 'Review the change.'),
      chunk('No findings.'),
      outRes(3, answer(100, 10)),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGrok(setup, stdioScenario(file), { vendorEnv: { XAI_API_KEY: 'k' } })
    const cwd = tempDir('grok-guard-')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Edit'] } }),
    )
    const refused = await drive(fake.adapter, grokStartOptions(cwd))
    expect(eventsOf(refused.entries)).toEqual([
      expect.objectContaining({ type: 'error', category: 'capability_missing' }),
    ])
    expect(JSON.stringify(refused.entries)).toContain('Edit in .claude/settings.local.json')
    expect(fake.starts().filter((a) => a.includes('stdio'))).toEqual([])

    // A full-mode Implement (Auto) is not read-only: the rule is Grok's to apply, and the pass runs.
    const implement = rec([
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, initResult()),
      ...newSession(YOLO),
      promptReq(3, 'Add a flag.'),
      chunk('Done.'),
      outRes(3, answer(100, 10)),
      eof(),
      exitFrame(0),
    ])
    const full = fakeGrok(setup, stdioScenario(implement), { vendorEnv: { XAI_API_KEY: 'k' } })
    const ran = await drive(
      full.adapter,
      grokStartOptions(cwd, { step: 'implement', mode: 'full', prompt: 'Add a flag.' }),
    )
    expectNoMismatch(full.logEntries())
    expect(eventsOf(ran.entries).at(-1)).toMatchObject({ type: 'done' })
  })
})

describe('Grok asks and the decision table', () => {
  // A confirmation whose first allow_once-kind option is the session-wide always-approve (Grok's option ids are not
  // documented: whatever kind and id it comes as, its name keeps it from being chosen).
  const OPTIONS = [
    { optionId: 'always_approve', name: 'Enable always-approve mode', kind: 'allow_once' },
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always_allow', name: 'Always allow `npm run build` in this project', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  ]
  const shellCall = {
    toolCallId: 'call_1',
    status: 'pending',
    title: 'npm run build',
    name: 'Bash',
    kind: 'execute',
    content: [],
    locations: [],
    rawInput: { command: 'npm run build' },
  }
  const askFrames = (chosen: string, status: 'completed' | 'failed'): Frame[] => [
    inReq(1, 'initialize', INITIALIZE_PARAMS),
    outRes(1, initResult()),
    ...newSession(YOLO),
    promptReq(3, 'Review the change.'),
    update({ sessionUpdate: 'tool_call', ...shellCall }, SESSION),
    outReq(0, 'session/request_permission', { sessionId: SESSION, options: OPTIONS, toolCall: shellCall }),
    inRes(0, { outcome: { outcome: 'selected', optionId: chosen } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status }, SESSION),
    chunk('Done.'),
    outRes(3, answer(200, 20, 100)),
    eof(),
    exitFrame(0),
  ]

  it.each([
    ['allow', 'allow_once', 'completed', 'ok'],
    ['deny', 'reject_once', 'failed', 'declined'],
    // Allow for this run is never offered; an engine that sends it anyway gets Allow once, never "Always allow".
    ['allow-session', 'allow_once', 'completed', 'ok'],
  ] as const)(
    'an ask Grok still raises in full mode (its ask rules): %s → %s',
    async (decision, chosen, status, end) => {
      const setup = await fakeSetup()
      const fake = fakeGrok(setup, stdioScenario(rec(askFrames(chosen, status))))
      const o = grokStartOptions(tempDir('grok-ask-'), { step: 'implement', mode: 'full' })
      const d = await drive(fake.adapter, o, [{ decision }])
      expectNoMismatch(fake.logEntries())
      checkInvariants(d, { readOnly: false })
      const ask = eventsOf(d.entries).find((e) => e.type === 'ask')
      expect(ask).toMatchObject({ kind: 'shell', allowSession: false })
      expect(eventsOf(d.entries)).toContainEqual(
        expect.objectContaining({ type: 'tool', phase: 'end', status: end }),
      )
      // Only Dim Factory's own exact rule for this run, never Grok's per-project Always allow (the fake checked the reply).
      expect(signalsOf(d.entries).some((s) => s.type === 'allow-rule')).toBe(decision === 'allow-session')
      // Exact usage from Grok's _meta.usage (cached reads apart).
      expect(eventsOf(d.entries).at(-1)).toMatchObject({
        type: 'done',
        usage: { input: 200, output: 20, cacheRead: 100 },
      })
    },
  )
})

describe('a continued Grok session carries the posture', () => {
  const resumeFrames = (
    meta: Record<string, unknown>,
    method: 'session/resume' | 'session/load',
  ): Frame[] => [
    inReq(1, 'initialize', INITIALIZE_PARAMS),
    outRes(1, initResult(method === 'session/resume')),
    inReq(2, method, { sessionId: SESSION, cwd: '<CWD>', mcpServers: [], _meta: meta }),
    outRes(2, {}),
    promptReq(3, 'Review the change.'),
    chunk('Fixed.'),
    outRes(3, answer(300, 30)),
    eof(),
    exitFrame(0),
  ]

  it.each([
    ['full', YOLO, 'session/resume'],
    ['readonly', ASK, 'session/resume'],
    ['full', YOLO, 'session/load'],
  ] as const)('a %s Fix sends its _meta on %s', async (mode, meta, method) => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(rec(resumeFrames(meta, method))))
    const prior = { input: 1000, output: 100 }
    const o = grokStartOptions(tempDir('grok-resume-'), {
      step: 'fix',
      mode,
      resume: { sessionId: SESSION, priorUsage: prior },
    })
    const d = await drive(fake.adapter, o)
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: mode === 'readonly' })
    expect(eventsOf(d.entries)[0]).toEqual({ type: 'session', id: SESSION })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', usage: { input: 300, output: 30 } })
    expect(d.handle.cumulativeUsage()).toMatchObject({ input: 1300, output: 130 })
  })
})

describe("Grok's own failure texts (failure categories)", () => {
  const failing = (details: string): Frame[] => [
    inReq(1, 'initialize', INITIALIZE_PARAMS),
    outRes(1, initResult()),
    ...newSession(ASK),
    promptReq(3, 'Review the change.'),
    outErr(3, { code: -32603, message: 'Internal error', data: { details } }),
    eof(),
    exitFrame(0),
  ]

  it.each([
    ['Session expired. Run `grok login` to re-authenticate.', 'auth_expired'],
    [
      'Authentication failed. Run `grok login`, set XAI_API_KEY, or add api_key to ~/.grok/config.toml.',
      'auth_required',
    ],
    ['429 Too Many Requests: rate limit exceeded', 'rate_limited'],
    ['The model grok-9 does not exist or your team does not have access to it', 'model_unavailable'],
  ])('%s → %s', async (details, category) => {
    const setup = await fakeSetup()
    const fake = fakeGrok(setup, stdioScenario(rec(failing(details))))
    const d = await drive(fake.adapter, grokStartOptions(tempDir('grok-fail-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: true })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', fatal: true, category })
  })

  it('session/new answering authRequired is auth_required; Dim Factory never calls authenticate', async () => {
    const setup = await fakeSetup()
    const frames = [
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, initResult()),
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [], _meta: ASK }),
      outErr(2, { code: -32000, message: 'Authentication required' }),
      eof(),
      exitFrame(0),
    ]
    const fake = fakeGrok(setup, stdioScenario(rec(frames)))
    const d = await drive(fake.adapter, grokStartOptions(tempDir('grok-auth-')))
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'auth_required' })
    expect(fake.stdinLines().map((m) => (m as { method?: string }).method)).not.toContain('authenticate')
  })
})
