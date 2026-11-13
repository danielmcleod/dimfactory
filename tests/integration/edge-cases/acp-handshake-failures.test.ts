// Coverage: the ACP base when the agent misbehaves before or during a turn (a bounded
// initialize, never authenticate; a session needs its id before anything is prompted; a mode the agent does not offer
// is flag_drift, never a silent other mode; an unreadable stream is stream_malformed). Through the real
// resolver and spawn path with the fake Gemini replaying a small recording; nothing is prompted in any refusal.
import { describe, expect, it } from 'vitest'
import { META_PLAN_FALLBACK } from '../../../src/core/adapters/types.ts'
import { MALFORMED_THRESHOLD } from '../../../src/core/proc/jsonrpc.ts'
import type { Frame } from '../acp/adapter/helpers.ts'
import {
  INITIALIZE_PARAMS,
  INITIALIZE_RESULT,
  MODELS,
  MODES,
  SESSION,
  acpScenario,
  checkInvariants,
  chunk,
  drive,
  eof,
  eventsOf,
  exitFrame,
  expectNoMismatch,
  fakeGemini,
  fakeSetup,
  inReq,
  outErr,
  outRes,
  recording,
  signalsOf,
  startOptions,
  tempDir,
} from '../acp/adapter/helpers.ts'

const TIMING = { exitAfterTerminalMs: 3_000, stopTurnMs: 3_000, planCancelMs: 5_000 }

const init = (): Frame => inReq(1, 'initialize', INITIALIZE_PARAMS)
const sessionNew = (): Frame => inReq(2, 'session/new', { cwd: '<CWD>', mcpServers: [] })
const hold = (): Frame => ({ t: 0, dir: 'hold' })
const methodsSent = (lines: unknown[]): (string | undefined)[] =>
  lines.map((m) => (m as { method?: string }).method).filter((m) => m !== undefined)

describe('ACP: the startup handshake', () => {
  it('initialize refused with a JSON-RPC error: flag_drift naming the refusal; no session is opened', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'initialize-refused' }, [
      init(),
      outErr(1, { code: -32602, message: 'Unsupported protocol version' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    const last = eventsOf(d.entries).at(-1)
    expect(last).toMatchObject({ type: 'error', fatal: true, category: 'flag_drift' })
    expect((last as { message: string }).message).toMatch(
      /rejected the startup handshake: .*Unsupported protocol version/,
    )
    expect(methodsSent(fake.stdinLines())).toEqual(['initialize'])
  }, 60_000)

  it('an agent that speaks another ACP version: flag_drift naming both versions; no session is opened', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'protocol-mismatch' }, [
      init(),
      outRes(1, { ...INITIALIZE_RESULT, protocolVersion: 2 }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'flag_drift',
      message: expect.stringMatching(/speaks ACP version 2; Dim Factory speaks version 1/) as string,
    })
    expect(methodsSent(fake.stdinLines())).toEqual(['initialize'])
  }, 60_000)

  it('an agent that never answers initialize: flag_drift (the handshake timer), and the process is ended', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'initialize-silent' }, [init(), hold(), exitFrame(0)])
    const fake = fakeGemini(setup, acpScenario(file), {
      adapter: { timing: { ...TIMING, initializeMs: 1_500 } },
    })
    const started = Date.now()
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-')))
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'flag_drift',
      message: expect.stringMatching(/did not answer the startup handshake/) as string,
    })
    // Ended by Dim Factory (the fake would have held for its own 20 s timeout); nothing else was sent.
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(methodsSent(fake.stdinLines())).toEqual(['initialize'])
  }, 60_000)
})

describe('ACP: the session', () => {
  it('session/new answered without a session id: stream_malformed; nothing is prompted', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'session-without-id' }, [
      init(),
      outRes(1, INITIALIZE_RESULT),
      sessionNew(),
      outRes(2, { modes: { currentModeId: 'default', availableModes: [] }, models: MODELS }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-')))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'stream_malformed',
      message: expect.stringMatching(/session\/new without a session id/) as string,
    })
    expect(eventsOf(d.entries).some((e) => e.type === 'session')).toBe(false)
    expect(methodsSent(fake.stdinLines())).toEqual(['initialize', 'session/new'])
  }, 60_000)

  it('session/new not answered in time: unknown, naming the request; nothing is prompted', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'session-silent' }, [
      init(),
      outRes(1, INITIALIZE_RESULT),
      sessionNew(),
      hold(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file), {
      adapter: { timing: { ...TIMING, requestMs: 1_500 } },
    })
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-')))
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'unknown',
      message: expect.stringMatching(/did not answer session\/new within 2 s/) as string,
    })
    expect(methodsSent(fake.stdinLines())).not.toContain('session/prompt')
  }, 60_000)

  it('the mode the pass needs is not offered: flag_drift naming what is; set_mode is never sent', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'mode-not-offered' }, [
      init(),
      outRes(1, INITIALIZE_RESULT),
      sessionNew(),
      outRes(2, {
        sessionId: SESSION,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default', description: 'Prompts for approval' },
            { id: 'plan', name: 'Plan', description: 'Read-only mode' },
          ],
        },
        models: MODELS,
      }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-'), { mode: 'autoedit' }))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({
      type: 'error',
      category: 'flag_drift',
      message: expect.stringMatching(/has no "autoEdit" mode \(it offers default, plan\)/) as string,
    })
    expect(methodsSent(fake.stdinLines())).toEqual(['initialize', 'session/new'])
  }, 60_000)

  it('a native Plan where the agent offers no plan mode falls back to a read-only Plan, said so, never another mode', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'plan-fallback' }, [
      init(),
      outRes(1, INITIALIZE_RESULT),
      sessionNew(),
      outRes(2, {
        sessionId: SESSION,
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default', name: 'Default', description: 'Prompts for approval' }],
        },
        models: MODELS,
      }),
      inReq(3, 'session/set_mode', { sessionId: SESSION, modeId: 'default' }),
      outRes(3, {}),
      inReq(4, 'session/prompt', {
        sessionId: SESSION,
        prompt: [{ type: 'text', text: 'Plan a --version flag.' }],
      }),
      chunk('1. Read src/cli.ts.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('acp-cwd-'), {
        step: 'plan',
        mode: 'readonly',
        planNative: true,
        prompt: 'Plan a --version flag.',
      }),
    )
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: true })
    expect(signalsOf(d.entries)).toContainEqual({
      type: 'meta',
      key: META_PLAN_FALLBACK,
      value: { reason: expect.stringMatching(/offers no plan mode here/) as string },
    })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: '1. Read src/cli.ts.' })
  }, 60_000)
})

describe('ACP: the stream', () => {
  /** A turn that has started (session, autoEdit set, prompt sent) and streamed some text. */
  const turn = (): Frame[] => [
    init(),
    outRes(1, INITIALIZE_RESULT),
    sessionNew(),
    outRes(2, { sessionId: SESSION, modes: MODES, models: MODELS }),
    inReq(3, 'session/set_mode', { sessionId: SESSION, modeId: 'autoEdit' }),
    outRes(3, {}),
    inReq(4, 'session/prompt', {
      sessionId: SESSION,
      prompt: [{ type: 'text', text: 'Add a --version flag.' }],
    }),
    chunk('Working'),
  ]
  const garbled = (i: number): Frame => ({
    t: 0,
    dir: 'out',
    line: `[agent log ${i}] {"jsonrpc":"2.0","method":`,
  })

  it('one stray line that is not JSON-RPC is tolerated (a log line on stdout): the turn completes', async () => {
    const setup = await fakeSetup()
    const file = recording({ scenario: 'stray-line' }, [
      ...turn(),
      garbled(1),
      chunk(' done.'),
      outRes(4, { stopReason: 'end_turn' }),
      eof(),
      exitFrame(0),
    ])
    const fake = fakeGemini(setup, acpScenario(file))
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-'), { mode: 'autoedit' }))
    expectNoMismatch(fake.logEntries())
    checkInvariants(d, { readOnly: false })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: 'Working done.' })
  }, 60_000)

  it(`${MALFORMED_THRESHOLD} in a row: stream_malformed with the lines as evidence, and the process is ended`, async () => {
    const setup = await fakeSetup()
    const lines = Array.from({ length: MALFORMED_THRESHOLD }, (_, i) => garbled(i + 1))
    const file = recording({ scenario: 'garbled-stream' }, [...turn(), ...lines, hold(), exitFrame(0)])
    const fake = fakeGemini(setup, acpScenario(file))
    const started = Date.now()
    const d = await drive(fake.adapter, startOptions(tempDir('acp-cwd-'), { mode: 'autoedit' }))
    checkInvariants(d, { readOnly: false })
    const last = eventsOf(d.entries).at(-1)
    expect(last).toMatchObject({
      type: 'error',
      fatal: true,
      category: 'stream_malformed',
      message: expect.stringMatching(/sent unreadable output/) as string,
    })
    for (let i = 1; i <= MALFORMED_THRESHOLD; i++) {
      expect((last as { raw: string }).raw).toContain(`[agent log ${i}]`)
    }
    // Ended by Dim Factory (the fake would have held for its own 20 s timeout).
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 60_000)
})
