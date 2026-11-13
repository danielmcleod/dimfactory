// The ACP base through the real resolver and spawn path with the Gemini config (session setup, updates, the
// permission order and the decision table, cancel and stop; Gemini launch with --skip-trust only with the
// vendorFolder grant or a Dim Factory-owned cwd; the session id is taken from session/new before session/prompt).
// Each pass replays a small recording in the fixture format; the fake checks every host frame.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { META_LATE_ALLOW_RULE, META_USAGE_APPROX } from '../../../../src/core/adapters/types.ts'
import type { AllowRule, NormalizedEvent } from '../../../../src/shared/events.ts'
import {
  EDIT_OPTIONS,
  INITIALIZE_PARAMS,
  INITIALIZE_RESULT,
  SESSION,
  acpScenario,
  checkInvariants,
  chunk,
  drive,
  eof,
  errLine,
  eventsOf,
  exitFrame,
  expectNoMismatch,
  fakeGemini,
  fakeSetup,
  hermeticEnv,
  inNote,
  inReq,
  inRes,
  opening,
  outErr,
  outReq,
  outRes,
  recording,
  signalsOf,
  startOptions,
  tempDir,
  update,
} from './helpers.ts'

const OUT_CWD = { FAKE_CLI_OUT_CWD: '1' }

const setMode = (id: number, modeId: string) => [
  inReq(id, 'session/set_mode', { sessionId: SESSION, modeId }),
  outRes(id, {}),
]
const prompt = (id: number, text: string) =>
  inReq(id, 'session/prompt', { sessionId: SESSION, prompt: [{ type: 'text', text }] })

const toolCall = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) => ({
  toolCallId: id,
  status: 'pending',
  title,
  kind,
  ...extra,
})
const permission = (rpcId: number, tc: Record<string, unknown>, options = EDIT_OPTIONS) =>
  outReq(rpcId, 'session/request_permission', { sessionId: SESSION, toolCall: tc, options })
const selected = (rpcId: number, optionId: string) =>
  inRes(rpcId, { outcome: { outcome: 'selected', optionId } })

/**
 * The ACP spec's cancel order, as the host wrote it: `session/cancel` first, then the pending permissions answered
 * `cancelled` (the fake's replay matches by message, so the order is checked on what it read).
 */
function expectCancelBeforeReplies(lines: unknown[]): void {
  const kinds = lines.map((m) => {
    const x = m as { method?: string; result?: unknown }
    return x.method ?? (x.result !== undefined ? 'reply' : 'other')
  })
  expect(kinds.indexOf('session/cancel')).toBeGreaterThan(-1)
  expect(kinds.lastIndexOf('reply')).toBeGreaterThan(kinds.indexOf('session/cancel'))
}

const USAGE = {
  inputTokens: 1200,
  outputTokens: 40,
  cachedReadTokens: 200,
  thoughtTokens: 10,
  totalTokens: 1250,
}

describe('ACP passes (Gemini config, fake agent)', () => {
  it('a read-only Review rejects every request (zero asks), sets the default mode and reports the usage', async () => {
    const setup = await fakeSetup()
    const edit = toolCall('write_file-1', 'edit', 'WriteFile src/cli.ts', {
      locations: [{ path: '<CWD>/src/cli.ts' }],
    })
    const shell = toolCall('run_shell_command-2', 'execute', 'git status', {
      rawInput: { command: 'git status' },
    })
    const file = recording({ scenario: 'review-readonly' }, [
      ...opening(),
      ...setMode(3, 'default'),
      prompt(4, 'Review the diff.'),
      update({ sessionUpdate: 'tool_call', ...edit }),
      permission(0, edit),
      selected(0, 'cancel'),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'write_file-1', status: 'failed' }),
      update({ sessionUpdate: 'tool_call', ...shell }),
      permission(1, shell),
      selected(1, 'cancel'),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'run_shell_command-2', status: 'failed' }),
      chunk('Looks '),
      chunk('fine.'),
      outRes(4, { stopReason: 'end_turn', usage: USAGE }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file), { vendorEnv: OUT_CWD })
    const cwd = tempDir('gemini-cwd-')
    const d = await drive(
      fake.adapter,
      startOptions(cwd, { step: 'review', mode: 'readonly', prompt: 'Review the diff.' }),
    )
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: true })
    const events = eventsOf(d.entries)
    expect(events[0]).toEqual({ type: 'session', id: SESSION })
    expect(events.filter((e) => e.type === 'tool')).toMatchObject([
      { id: 'write_file-1', name: 'edit', phase: 'start' },
      { id: 'write_file-1', name: 'edit', phase: 'end', status: 'declined' },
      { id: 'run_shell_command-2', name: 'shell', phase: 'start' },
      { id: 'run_shell_command-2', name: 'shell', phase: 'end', status: 'declined' },
    ])
    const auto = d.entries.filter((e) => e.type === 'auto-answered')
    expect(auto).toMatchObject([
      { decision: 'deny', why: 'readonly', tool: 'edit' },
      { decision: 'deny', why: 'readonly', tool: 'shell' },
    ])
    // G05: inputTokens includes the cached tokens; Dim Factory's input is the uncached part.
    expect(events.at(-1)).toEqual({
      type: 'done',
      result: 'Looks fine.',
      usage: { input: 1000, output: 40, cacheRead: 200, reasoning: 10 },
    })
    // Gemini launch: `--acp`, and no --skip-trust in a folder nobody trusted.
    const argv = fake.starts().find((a) => a.includes('--acp'))!
    expect(argv).toContain('--acp')
    expect(argv).not.toContain('--skip-trust')
  })

  it('autoedit: an ask answered allow-session picks the session-scoped option and adds an exact rule', async () => {
    const setup = await fakeSetup()
    const shell = toolCall('run_shell_command-1', 'execute', 'npm test', {
      rawInput: { command: 'npm test' },
    })
    const file = recording({ scenario: 'autoedit-allow-session' }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Add a --version flag.'),
      update({ sessionUpdate: 'tool_call', ...shell }),
      permission(0, shell, [
        { optionId: 'proceed_always_and_save', name: 'Allow for all future sessions', kind: 'allow_always' },
        ...EDIT_OPTIONS,
      ]),
      selected(0, 'proceed_always'),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'run_shell_command-1', status: 'completed' }),
      chunk('Done.'),
      outRes(4, { stopReason: 'end_turn', usage: USAGE }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')), [{ decision: 'allow-session' }])
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    const ask = eventsOf(d.entries).find((e) => e.type === 'ask')
    expect(ask).toMatchObject({ kind: 'shell', allowSession: true, detail: 'npm test' })
    const rule = d.entries.find((e) => e.type === 'allow-rule')
    expect(rule).toMatchObject({
      rule: {
        vendor: 'gemini',
        kind: 'shell',
        tool: 'shell',
        match: { argv: ['npm', 'test'] },
        source: 'exact',
      },
    })
  })

  it('the allow cache answers a later identical request allow_once in a new process (no ask)', async () => {
    const setup = await fakeSetup()
    const shell = toolCall('run_shell_command-1', 'execute', 'npm test', {
      rawInput: { command: 'npm test' },
    })
    const rule: AllowRule = {
      vendor: 'gemini',
      kind: 'shell',
      tool: 'shell',
      match: { argv: ['npm', 'test'] },
      source: 'exact',
    }
    const file = recording({ scenario: 'allow-cache' }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Fix the findings.'),
      update({ sessionUpdate: 'tool_call', ...shell }),
      permission(0, shell),
      selected(0, 'proceed_once'),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'run_shell_command-1', status: 'completed' }),
      chunk('Fixed.'),
      outRes(4, { stopReason: 'end_turn', usage: USAGE }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), { step: 'fix', prompt: 'Fix the findings.', allowRules: [rule] }),
    )
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).some((e) => e.type === 'ask')).toBe(false)
    expect(d.entries.find((e) => e.type === 'auto-answered')).toMatchObject({
      decision: 'allow',
      why: 'allow-cache',
    })
  })

  it('deny answers reject_once (Gemini "cancel") and the turn goes on; the tool ends declined', async () => {
    const setup = await fakeSetup()
    const edit = toolCall('replace-1', 'edit', 'Edit src/cli.ts', {
      locations: [{ path: '<CWD>/src/cli.ts' }],
    })
    const file = recording({ scenario: 'autoedit-deny' }, [
      ...opening(),
      ...setMode(3, 'yolo'),
      prompt(4, 'Add a --version flag.'),
      update({ sessionUpdate: 'tool_call', ...edit }),
      permission(0, edit, [
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ]),
      selected(0, 'cancel'),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'replace-1', status: 'failed' }),
      chunk('I did not change the file.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file), { vendorEnv: OUT_CWD })
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-'), { mode: 'full' }), [
      { decision: 'deny' },
    ])
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    const events = eventsOf(d.entries)
    // No allow_always offered (no "Allow for this run").
    expect(events.find((e) => e.type === 'ask')).toMatchObject({
      kind: 'edit',
      allowSession: false,
      detail: 'Edit src/cli.ts',
    })
    expect(events.filter((e) => e.type === 'tool').at(-1)).toMatchObject({ phase: 'end', status: 'declined' })
    // No usage on the answer and no usage_update: done without usage, flagged.
    expect(events.at(-1)).toEqual({ type: 'done', result: 'I did not change the file.' })
    expect(d.entries.find((e) => e.type === 'meta' && e.key === META_USAGE_APPROX)).toBeDefined()
  })

  it('an ask that times out: session/cancel, then every pending permission answered cancelled; ask_timeout', async () => {
    const setup = await fakeSetup()
    const shell = toolCall('run_shell_command-1', 'execute', 'npm test', {
      rawInput: { command: 'npm test' },
    })
    const file = recording({ scenario: 'ask-timeout' }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Add a --version flag.'),
      update({ sessionUpdate: 'tool_call', ...shell }),
      permission(0, shell),
      inNote('session/cancel', { sessionId: SESSION }),
      inRes(0, { outcome: { outcome: 'cancelled' } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'run_shell_command-1', status: 'failed' }),
      outRes(4, { stopReason: 'cancelled' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')), [
      { decision: 'cancel', why: 'ask-timeout' },
    ])
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', fatal: true, category: 'ask_timeout' })
    expect(d.entries.find((e) => e.type === 'meta' && e.key === META_LATE_ALLOW_RULE)).toMatchObject({
      value: { rule: { match: { argv: ['npm', 'test'] } } },
    })
    expectCancelBeforeReplies(fake.stdinLines())
  })

  it('native Plan: set_mode plan; exit_plan_mode is captured, rejected and the turn cancelled; done is the plan', async () => {
    const setup = await fakeSetup()
    const plan = '# Plan\n\n1. Read src/cli.ts.\n2. Add --version.\n'
    const exit = toolCall('exit_plan_mode-1', 'switch_mode', 'Exit plan mode', {
      content: [{ type: 'content', content: { type: 'text', text: plan } }],
    })
    const file = recording({ scenario: 'plan-native' }, [
      ...opening(),
      ...setMode(3, 'plan'),
      prompt(4, 'Plan a --version flag.'),
      chunk('Here is my plan.'),
      update({ sessionUpdate: 'tool_call', ...exit }),
      permission(0, exit, [
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ]),
      selected(0, 'cancel'),
      inNote('session/cancel', { sessionId: SESSION }),
      outRes(4, { stopReason: 'cancelled', usage: USAGE }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), {
        step: 'plan',
        mode: 'readonly',
        planNative: true,
        prompt: 'Plan a --version flag.',
      }),
    )
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: true })
    expect(signalsOf(d.entries)).toEqual(
      expect.arrayContaining([
        { type: 'plan-captured', markdown: plan, source: 'acp-exit-plan' },
        expect.objectContaining({ type: 'auto-answered', decision: 'deny', why: 'plan-capture' }),
      ]),
    )
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: plan })
  })

  it('a stop with a pending ask: session/cancel, then it is answered cancelled and withdrawn; user_cancelled', async () => {
    const setup = await fakeSetup()
    const shell = toolCall('run_shell_command-1', 'execute', 'npm test', {
      rawInput: { command: 'npm test' },
    })
    const file = recording({ scenario: 'stop-pending-ask' }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Add a --version flag.'),
      update({ sessionUpdate: 'tool_call', ...shell }),
      permission(0, shell),
      inNote('session/cancel', { sessionId: SESSION }),
      inRes(0, { outcome: { outcome: 'cancelled' } }),
      outRes(4, { stopReason: 'cancelled' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')), [], {
      stopAfter: (e: NormalizedEvent) => e.type === 'ask',
    })
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    const ask = eventsOf(d.entries).find((e) => e.type === 'ask')!
    expect(d.entries).toContainEqual({
      type: 'ask-withdrawn',
      requestId: (ask as { requestId: string }).requestId,
    })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'user_cancelled' })
    expect(d.exit.stoppedBy).toBe('user')
    expectCancelBeforeReplies(fake.stdinLines())
  })

  it('session/new answered authRequired: auth_required, nothing prompted (never authenticate)', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'auth-required' }, [
      ...opening({ sessionNew: false }),
      inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] }),
      outErr(2, { code: -32000, message: 'Authentication required' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'auth_required' })
    expect(fake.stdinLines().map((m) => (m as { method?: string }).method)).not.toContain('authenticate')
  })

  it('set_mode refused (an unavailable mode): flag_drift before any prompt', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'set-mode-refused' }, [
      ...opening(),
      inReq(3, 'session/set_mode', { sessionId: SESSION, modeId: 'autoEdit' }),
      outErr(3, {
        code: -32603,
        message: 'Internal error',
        data: { details: 'Invalid or unavailable mode: autoEdit' },
      }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')))
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'flag_drift' })
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'session/prompt')).toBe(false)
  })

  it('an agent without session/set_mode (-32601, an optional method) is capability_missing, nothing prompted', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'set-mode-missing' }, [
      ...opening(),
      inReq(3, 'session/set_mode', { sessionId: SESSION, modeId: 'autoEdit' }),
      outErr(3, { code: -32601, message: 'Method not found' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')))
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'capability_missing' })
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'session/prompt')).toBe(false)
  })

  it('the agent widening its own mode during a read-only pass ends it (config_invalid), never silently', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'mode-widened' }, [
      ...opening(),
      ...setMode(3, 'default'),
      prompt(4, 'Review the diff.'),
      update({ sessionUpdate: 'current_mode_update', currentModeId: 'yolo' }),
      inNote('session/cancel', { sessionId: SESSION }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), { step: 'review', mode: 'readonly', prompt: 'Review the diff.' }),
    )
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'config_invalid' })
    checkInvariants(d, { readOnly: true })
  })

  it("Gemini's own mode echo ([MODE_UPDATE] text) is never printed; a widening ends the pass", async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'mode-echo-widened' }, [
      ...opening(),
      inReq(3, 'session/set_mode', { sessionId: SESSION, modeId: 'autoEdit' }),
      // The echo of Dim Factory's own set_mode, sent while it runs: no text, no stop.
      chunk('[MODE_UPDATE] autoEdit'),
      outRes(3, {}),
      prompt(4, 'Add a --version flag.'),
      chunk('Working on it.'),
      // Gemini switching itself to YOLO mid-turn: the pass ends before anything runs unasked.
      chunk('[MODE_UPDATE] yolo'),
      inNote('session/cancel', { sessionId: SESSION }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), { prompt: 'Add a --version flag.' }),
    )
    const texts = eventsOf(d.entries).flatMap((e) => (e.type === 'text' ? [e.delta] : []))
    expect(texts).toEqual(['Working on it.'])
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'config_invalid' })
    checkInvariants(d, { readOnly: false })
  })

  it('a refusal stop reason is content_policy; max_turn_requests is turn_limit', async () => {
    const setup = await fakeSetup()
    for (const [stop, category] of [
      ['refusal', 'content_policy'],
      ['max_turn_requests', 'turn_limit'],
    ] as const) {
      const file = recording({ scenario: `stop-${stop}` }, [
        ...opening(),
        ...setMode(3, 'autoEdit'),
        prompt(4, 'Add a --version flag.'),
        outRes(4, { stopReason: stop, usage: USAGE }),
        eof(),
        exitFrame(0),
      ])
      const fake = fakeGemini(setup, acpScenario(file))
      const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')))
      expectNoMismatch(fake.logEntries())
      checkInvariants(d, { readOnly: false })
      expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category })
      // A failed attempt still bills its usage (META_USAGE), never with a done.
      expect(d.entries.find((e) => e.type === 'meta' && e.key === 'usage')).toMatchObject({
        value: { input: 1000, output: 40 },
      })
    }
  })

  it('an agent request Dim Factory does not serve (fs, terminal) gets -32601 and the turn goes on', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'unknown-request' }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Add a --version flag.'),
      outReq(0, 'fs/read_text_file', { sessionId: SESSION, path: '/etc/hosts' }),
      {
        t: 0,
        dir: 'in',
        line: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32601, message: 'Method not found: fs/read_text_file' },
        }),
      },
      chunk('Done.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: 'Done.' })
  })
})

describe('Gemini --skip-trust gating (Gemini launch)', () => {
  const plain = (name: string) =>
    recording({ scenario: name }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Add a --version flag.'),
      chunk('Done.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])

  it('without a grant Gemini starts without --skip-trust, and its exit 55 is trust_required', async () => {
    const setup = await fakeSetup()
    const dir = acpScenario(plain('untrusted'), [
      {
        match: { argvIncludes: ['--acp'], argvExcludes: ['--skip-trust'] },
        script: [
          { op: 'stderr', line: 'Gemini CLI is not running in a trusted directory. To proceed, trust it.' },
          { op: 'exit', code: 55 },
        ],
        repeat: true,
      },
    ])
    const fake = fakeGemini(setup, dir)
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-')))
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'trust_required' })
    expect(fake.starts().find((a) => a.includes('--acp'))).not.toContain('--skip-trust')
  })

  it('with the folder grant (StartOptions.trustFolder) the launch adds --skip-trust', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(plain('trusted')))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-'), { trustFolder: true }))
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: 'Done.' })
    expect(fake.starts().find((a) => a.includes('--acp'))).toContain('--skip-trust')
  })

  it('a Dim Factory-owned folder (a run-less heal under DIM_FACTORY_HOME/tmp) needs no grant', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(plain('owned')))
    const cwd = join(fake.dimFactoryHome, 'tmp', 'heal', 'h1')
    mkdirSync(cwd, { recursive: true })
    const d = await drive(fake.adapter, startOptions(cwd, { mode: 'autoedit' }))
    expect(fake.starts().find((a) => a.includes('--acp'))).toContain('--skip-trust')
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
  })

  it("Gemini's env twin of --skip-trust (GEMINI_CLI_TRUST_WORKSPACE) never reaches the agent", async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(plain('trust-env')), {
      adapter: { env: hermeticEnv({ GEMINI_CLI_TRUST_WORKSPACE: 'true' }) },
      vendorEnv: { FAKE_CLI_LOG_ENV: 'GEMINI_CLI_TRUST_WORKSPACE' },
    })
    await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), { env: { GEMINI_CLI_TRUST_WORKSPACE: '1' } }),
    )
    const start = fake
      .logEntries()
      .find((e) => e['kind'] === 'start' && (e['argv'] as string[]).includes('--acp'))
    expect(start?.['env']).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: null })
    expect(start?.['argv']).not.toContain('--skip-trust')
  })

  it('an isolated-run worktree under DIM_FACTORY_HOME is NOT Dim Factory-owned', async () => {
    const setup = await fakeSetup()
    const fake = fakeGemini(setup, acpScenario(plain('worktree')))
    const cwd = join(fake.dimFactoryHome, 'worktrees', 'run-1')
    mkdirSync(cwd, { recursive: true })
    await drive(fake.adapter, startOptions(cwd))
    expect(fake.starts().find((a) => a.includes('--acp'))).not.toContain('--skip-trust')
  })

  it('a stderr line before the exit is the classifier evidence (no stderr text is lost)', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'crash' }, [
      ...opening(),
      errLine('Please set an Auth method in your settings.json or specify an environment variable.'),
      exitFrame(41),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('gemini-cwd-'), { trustFolder: true }))
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'auth_required' })
  })
})

describe('resume: session/load with its replay dropped ("drop updates until 400 ms of quiet")', () => {
  it('replayed history is dropped, set_mode is re-sent after the load, usage is this pass only', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'load-resume' }, [
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, INITIALIZE_RESULT),
      inReq(2, 'session/load', { sessionId: SESSION, cwd: '<CWD>', mcpServers: [] }),
      outRes(
        2,
        {
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'autoEdit', name: 'Auto Edit' },
            ],
          },
        },
        0,
      ),
      // Gemini replays the history after the load answer (streamHistory is not awaited), 300 ms apart.
      update(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } },
        SESSION,
        100,
      ),
      update(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD ANSWER' } },
        SESSION,
        400,
      ),
      update(
        { sessionUpdate: 'tool_call', toolCallId: 'old-1', title: 'old', kind: 'edit', status: 'completed' },
        SESSION,
        700,
      ),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Fix the findings.'),
      chunk('Fixed.'),
      outRes(4, { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 20, totalTokens: 520 } }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file), { vendorEnv: { REPLAY_REALTIME: '1' } })
    const prior = { input: 3000, output: 100 }
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), {
        step: 'fix',
        prompt: 'Fix the findings.',
        resume: { sessionId: SESSION, priorUsage: prior },
      }),
    )
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    const events = eventsOf(d.entries)
    expect(events.some((e) => e.type === 'text' && e.delta.includes('OLD'))).toBe(false)
    expect(events.some((e) => e.type === 'tool')).toBe(false)
    expect(events[0]).toEqual({ type: 'session', id: SESSION })
    expect(events.at(-1)).toEqual({ type: 'done', result: 'Fixed.', usage: { input: 500, output: 20 } })
    // Σ per-pass usage = the running total the engine stores.
    expect(d.handle.cumulativeUsage()).toEqual({ input: 3500, output: 120 })
    // No session/new on a resume; the systemAppend is not resent either.
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'session/new')).toBe(false)
  }, 60_000)

  it('the quiet window is what drops the replay: a window shorter than the replay lets it through', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'load-short-window' }, [
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, INITIALIZE_RESULT),
      inReq(2, 'session/load', { sessionId: SESSION, cwd: '<CWD>', mcpServers: [] }),
      outRes(2, {}),
      update(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD ANSWER' } },
        SESSION,
        1_000,
      ),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Fix the findings.'),
      chunk('Fixed.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file), {
      vendorEnv: { REPLAY_REALTIME: '1' },
      adapter: { timing: { loadQuietMs: 50, loadQuietCapMs: 10_000, exitAfterTerminalMs: 3_000 } },
    })
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), {
        step: 'fix',
        prompt: 'Fix the findings.',
        resume: { sessionId: SESSION },
      }),
    )
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).some((e) => e.type === 'text' && e.delta === 'OLD ANSWER')).toBe(true)
  }, 60_000)

  it('an agent without session/load or session/resume cannot continue a session (capability_missing)', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'no-load' }, [
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, { ...INITIALIZE_RESULT, agentCapabilities: { loadSession: false } }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), { step: 'fix', resume: { sessionId: SESSION } }),
    )
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'capability_missing' })
  })

  it('session/load of a session Gemini does not have: resume_failed (fresh, no budget)', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'load-unknown' }, [
      inReq(1, 'initialize', INITIALIZE_PARAMS),
      outRes(1, INITIALIZE_RESULT),
      inReq(2, 'session/load', { sessionId: SESSION, cwd: '<CWD>', mcpServers: [] }),
      outErr(2, {
        code: -32603,
        message: 'Internal error',
        data: { details: `Invalid session identifier "${SESSION}"` },
      }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), { step: 'fix', resume: { sessionId: SESSION } }),
    )
    expectNoMismatch(fake.logEntries())
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'resume_failed' })
  })
})

describe('session id persistence (from session/new, before session/prompt)', () => {
  it('onSession is awaited before session/prompt; a failed save ends the pass with nothing prompted', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'persist-failed' }, [...opening(), eof(), exitFrame(0)])
    const fake = fakeGemini(setup, acpScenario(file))
    let seen: string | undefined
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), {
        onSession: (id) => {
          seen = id
          return Promise.resolve({ ok: false, reason: 'disk full', code: 'ENOSPC' })
        },
      }),
    )
    expectNoMismatch(fake.logEntries())
    expect(seen).toBe(SESSION)
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'error', category: 'disk_full' })
    expect(fake.stdinLines().some((m) => (m as { method?: string }).method === 'session/prompt')).toBe(false)
  })

  it('the ACP flags in a pass: extraArgs at the end, a model after -m', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'argv' }, [
      ...opening(),
      ...setMode(3, 'autoEdit'),
      prompt(4, 'Add a --version flag.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    await drive(
      fake.adapter,
      startOptions(tempDir('gemini-cwd-'), {
        model: 'gemini-3-pro-preview',
        extraArgs: ['--debug'],
        trustFolder: true,
      }),
    )
    // The fake's argv starts after its own script: exactly what the adapter passed after `node <entry>`.
    const argv = fake.starts().find((a) => a.includes('--acp'))!
    expect(argv.slice(argv.indexOf('--acp'))).toEqual([
      '--acp',
      '-m',
      'gemini-3-pro-preview',
      '--skip-trust',
      '--debug',
    ])
  })
})
