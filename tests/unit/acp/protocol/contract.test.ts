// The adapter contract invariants and the Gemini safety rules, checked on every Gemini ACP fixture (recording + expected
// events): one terminal event, no double text, every ask answered or withdrawn, zero asks in read-only passes, usage
// ≥ 0 and the pass's own report, session before done; the host frames keep the mode table, reject every permission
// of a read-only pass, never choose a forbidden or persistent option, capture and reject the plan exit, never call
// authenticate, never put a prompt in argv, and --skip-trust only with a grant; the set is what the generator writes.
// Review fixes: the plan exit is Gemini's own (kind other, its plan file in the title, the file in a `file` frame), a
// `[MODE_UPDATE]` echo is never text, and a 0.62 answer's usage is its `_meta.quota` totals (approximate).
import { describe, expect, it } from 'vitest'
import {
  CANCELLED_OUTCOME,
  PERSISTENT_OPTION_NAME,
  initializeParams,
  isPlanExit,
  promptUsageOf,
  toolCallText,
  usageFromAcp,
  usageFromContext,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import type { PermissionOption, ToolCallUpdate } from '../../../../src/core/adapters/acp-base/protocol.ts'
import {
  GEMINI_MODE_UPDATE,
  GEMINI_PLAN_EXIT_TITLE,
  geminiMetaUsage,
} from '../../../../src/core/adapters/gemini/wire.ts'
import { GEMINI_PREFS, LIVE, SCENARIOS, outOfDate } from '../../../fixtures/gemini/recipes/synthesize.mjs'
import type { Fixture, Json, Usage } from './fixtures.ts'
import {
  EVENT_TYPES,
  READ_ONLY_STEPS,
  allFixtures,
  loadFixture,
  message,
  messages,
  requestParams,
} from './fixtures.ts'

const fixtures = allFixtures()
const passes = fixtures.filter((f) => f.header.pass?.kind === 'pass')
const MODE_IDS: Record<string, string> = { readonly: 'default', autoedit: 'autoEdit', full: 'yolo' }
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const

const eventsOf = (fx: Fixture): Json[] => fx.expected.filter((e) => EVENT_TYPES.has(String(e['type'])))
const signalsOf = (fx: Fixture): Json[] => fx.expected.filter((e) => !EVENT_TYPES.has(String(e['type'])))
const isTerminal = (e: Json): boolean =>
  e['type'] === 'done' || (e['type'] === 'error' && e['fatal'] === true)
const readOnly = (fx: Fixture): boolean =>
  READ_ONLY_STEPS.has(String(fx.header.pass?.step)) || fx.header.pass?.mode === 'readonly'

/** Frame index of the first message of `dir` that `pick` accepts (-1 when none). */
function indexOf(fx: Fixture, dir: 'in' | 'out', pick: (m: Json) => boolean): number {
  return fx.frames.findIndex((f) => {
    if (f.dir !== dir) return false
    const m = message(f)
    return m !== undefined && pick(m)
  })
}

/**
 * The live turn's agent messages: chunks after the prompt, split by tool updates (a replay before it never counts, nor
 * does Gemini's `[MODE_UPDATE]` echo).
 */
function agentMessages(fx: Fixture): string[] {
  const start = indexOf(fx, 'in', (m) => m['method'] === 'session/prompt')
  if (start === -1) return []
  const out: string[] = []
  let current = ''
  for (const f of fx.frames.slice(start)) {
    const m = f.dir === 'out' ? message(f) : undefined
    if (m?.['method'] !== 'session/update') continue
    const u = (m['params'] as Json)['update'] as Json
    if (u['sessionUpdate'] === 'agent_message_chunk') {
      const c = u['content'] as Json
      if (c['type'] === 'text' && !GEMINI_MODE_UPDATE.test(String(c['text']).trim()))
        current += String(c['text'])
    } else if (u['sessionUpdate'] === 'tool_call' || u['sessionUpdate'] === 'tool_call_update') {
      if (current !== '') out.push(current)
      current = ''
    }
  }
  if (current !== '') out.push(current)
  return out
}

/** The agent's permission requests with the host's reply to each. */
function permissions(fx: Fixture): { request: Json; replies: Json[] }[] {
  const replies = messages(fx, 'in').filter((m) => typeof m['method'] !== 'string')
  return messages(fx, 'out')
    .filter((m) => m['method'] === 'session/request_permission' && 'id' in m)
    .map((request) => ({ request, replies: replies.filter((r) => r['id'] === request['id']) }))
}

const optionsOf = (request: Json): PermissionOption[] =>
  (request['params'] as Json)['options'] as PermissionOption[]
const toolCallOf = (request: Json): ToolCallUpdate =>
  (request['params'] as Json)['toolCall'] as ToolCallUpdate
const isExit = (request: Json): boolean => isPlanExit(toolCallOf(request), GEMINI_PLAN_EXIT_TITLE)

/**
 * The plan a plan exit carries: its text content, else the plan file its title names, as the recording's `file` frame
 * wrote it (Gemini's exit_plan_mode carries no content).
 */
function planOf(fx: Fixture, request: Json): string | null {
  const text = toolCallText(toolCallOf(request))
  if (text !== null) return text
  const file = GEMINI_PLAN_EXIT_TITLE.exec(String(toolCallOf(request).title ?? '').trim())?.[1]
  return fx.frames.find((f) => f.dir === 'file' && f.path === file)?.content ?? null
}

const chosenOf = (reply: Json): string | null => {
  const outcome = (reply['result'] as Json)['outcome'] as Json
  return outcome['outcome'] === 'selected' ? String(outcome['optionId']) : null
}

describe('the fixture set', () => {
  it('is exactly what the generator writes (re-run tests/fixtures/gemini/recipes/synthesize.mjs)', () => {
    expect(outOfDate()).toEqual([])
    expect(fixtures.map((f) => f.name)).toEqual(SCENARIOS.map((s) => `${s.id}-${s.slug}`).sort())
  })

  it('covers G01–G10 and every Gemini exit code the adapter knows', () => {
    const ids = new Set(fixtures.map((f) => f.name.replace(/[a-z]?-.*/, '')))
    for (let n = 1; n <= 10; n++) expect(ids).toContain(`G${String(n).padStart(2, '0')}`)
    for (const code of [41, 42, 44, 52, 53, 54, 55]) expect(ids).toContain(`GX${code}`)
  })

  it.each(fixtures.map((f) => [f.name, f] as const))('%s: header', (_n, fx) => {
    expect(fx.header).toMatchObject({
      kind: 'header',
      vendor: 'gemini',
      route: 'acp',
      scenario: fx.name,
      protocol: 'jsonrpc',
      jsonrpc: '2.0',
      envDrop: ['^GEMINI_', '^GOOGLE_'],
      launch: 'node <entry>',
    })
    expect(fx.header['envKeys']).toContain('GEMINI_CLI_HOME')
    if (LIVE.has(fx.name)) {
      // A live recording has no synthesized field (tests/fixtures/gemini/README.md "Re-recording live").
      expect(fx.header.synthesized).toBeUndefined()
    } else {
      // Every fixture not recorded live says it is synthesized and from what.
      expect(fx.header.synthesized).toBe(true)
      expect(fx.header['envKeys']).toEqual(['GEMINI_CLI_HOME'])
      expect(String(fx.header['synthesizedFrom'])).toContain('protocol/v1.25.0')
      expect(String(fx.header['synthesizedFrom'])).toContain('github.com/google-gemini/gemini-cli')
    }
    expect(fx.header.pass?.kind).toMatch(/^(pass|probe)$/)
    expect(fx.frames.at(-1)?.dir).toBe('exit')
  })
})

describe('contract invariants, every pass fixture', () => {
  it.each(passes.map((f) => [f.name, f] as const))('%s', (_n, fx) => {
    const events = eventsOf(fx)
    const signals = signalsOf(fx)

    // exactly one terminal event, and it is the last event
    expect(events.filter(isTerminal)).toHaveLength(1)
    expect(isTerminal(events.at(-1)!)).toBe(true)

    // session before done, once, and it is the session the agent set up or the pass resumed
    const sessionId =
      fx.header.pass?.resume?.sessionId ??
      (
        messages(fx, 'out').find(
          (m) => typeof (m['result'] as Json | undefined)?.['sessionId'] === 'string',
        )?.['result'] as Json | undefined
      )?.['sessionId']
    const sessions = events.filter((e) => e['type'] === 'session')
    if (sessions.length > 0) {
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!['id']).toBe(sessionId)
      expect(events.indexOf(sessions[0]!)).toBe(0)
    }
    const done = events.findIndex((e) => e['type'] === 'done')
    if (done !== -1) expect(sessions).toHaveLength(1)

    // no double-printed text: the live turn's messages once each, '\n\n' between two (a replay never prints)
    const printed = events.flatMap((e) => (e['type'] === 'text' ? [String(e['delta'])] : [])).join('')
    expect(printed).toBe(agentMessages(fx).join('\n\n'))

    // every ask answered or withdrawn: each permission request has exactly one reply, and is an ask or auto-answered
    const asks = events.filter((e) => e['type'] === 'ask').length
    const auto = signals.filter((s) => s['type'] === 'auto-answered').length
    const perms = permissions(fx)
    for (const p of perms) expect(p.replies).toHaveLength(1)
    expect(asks + auto).toBe(perms.length)

    // zero asks in read-only passes, and every permission of one is rejected
    if (readOnly(fx)) {
      expect(asks).toBe(0)
      for (const p of perms) {
        const chosen = chosenOf(p.replies[0]!)
        const option = optionsOf(p.request).find((o) => o.optionId === chosen)
        expect(option?.kind ?? 'cancelled').toMatch(/^(reject_once|cancelled)$/)
      }
    }

    // tools: one start per toolCallId of the live turn, ended at most once; a replayed tool never shows
    const promptAt = indexOf(fx, 'in', (m) => m['method'] === 'session/prompt')
    const liveTools = new Set(
      fx.frames.slice(promptAt === -1 ? fx.frames.length : promptAt).flatMap((f) => {
        const m = f.dir === 'out' ? message(f) : undefined
        const u = m?.['method'] === 'session/update' ? ((m['params'] as Json)['update'] as Json) : undefined
        return u?.['sessionUpdate'] === 'tool_call' ? [String(u['toolCallId'])] : []
      }),
    )
    const starts = events
      .filter((e) => e['type'] === 'tool' && e['phase'] === 'start')
      .map((e) => String(e['id']))
    expect([...new Set(starts)]).toEqual(starts)
    expect(new Set(starts)).toEqual(liveTools)
    const ends = events
      .filter((e) => e['type'] === 'tool' && e['phase'] === 'end')
      .map((e) => String(e['id']))
    expect([...new Set(ends)]).toEqual(ends)
    for (const id of ends) expect(starts).toContain(id)

    // usage ≥ 0, and it is the pass's own report (one prompt per process; never minus priorUsage)
    const doneEvent = events[done]
    if (doneEvent !== undefined) {
      const usage = doneEvent['usage'] as Usage | undefined
      for (const f of FIELDS) expect(usage?.[f] ?? 0).toBeGreaterThanOrEqual(0)
      const prompt = messages(fx, 'out').find(
        (m) =>
          m['id'] === messages(fx, 'in').find((x) => x['method'] === 'session/prompt')?.['id'] &&
          !('method' in m),
      )
      const reported = promptUsageOf(prompt?.['result'])
      const meta = geminiMetaUsage(prompt?.['result'])
      const contexts = messages(fx, 'out')
        .filter((m) => m['method'] === 'session/update')
        .map((m) => (m['params'] as Json)['update'] as Json)
        .filter((u) => u['sessionUpdate'] === 'usage_update')
      const approx = signals.filter((s) => s['type'] === 'meta' && s['key'] === 'usageApprox')
      if (reported !== undefined) {
        // Gemini 0.64: the answer's usage (G05: cached reads off the input), never approximate.
        expect(usage).toEqual(usageFromAcp(reported))
        expect(approx).toEqual([])
      } else if (meta !== undefined) {
        // Gemini 0.62 and 0.63: the _meta.quota totals, input with the cached tokens in it (approximate).
        expect(usage).toEqual(meta)
        expect(approx).toEqual([{ type: 'meta', key: 'usageApprox', value: { reason: 'no-cached-split' } }])
      } else if (contexts.length > 0) {
        // The generic fallback: the last usage_update, flagged approximate (G05b).
        expect(usage).toEqual(usageFromContext(contexts.at(-1) as { used: number }))
        expect(approx).toHaveLength(1)
      } else {
        // A cancelled prompt (a captured plan) carries no usage in any Gemini version: done has none.
        expect(usage).toBeUndefined()
        expect(prompt?.['result']).toEqual({ stopReason: 'cancelled' })
      }
      // done.result: the final message, or the captured plan of a native Plan pass
      const result = String(doneEvent['result'])
      if (fx.header.pass?.planNative === true) {
        const exit = perms.find((p) => isExit(p.request))
        expect(result).toBe(planOf(fx, exit!.request))
      } else expect(result).toBe(agentMessages(fx).at(-1) ?? '')
    }
  })

  it('a resumed pass reports only its own turn (G04 + G09a = the session total)', () => {
    const g04 = loadFixture('G04-permission-allow-once')
    const g09a = loadFixture('G09a-resume-load-quiet')
    expect(g09a.header.pass?.resume?.sessionId).toBe(
      (
        messages(g04, 'out').find((m) => (m['result'] as Json | undefined)?.['sessionId'])?.['result'] as Json
      )['sessionId'],
    )
    const doneUsage = (fx: Fixture): Usage =>
      eventsOf(fx).find((e) => e['type'] === 'done')!['usage'] as Usage
    expect(g09a.header.pass?.resume?.priorUsage).toEqual(doneUsage(g04))
    expect(doneUsage(g09a)).not.toEqual(doneUsage(g04))
    // The replayed history (user, thought, old tools, old answer) comes after session/load's answer, before set_mode.
    const loadAnswer = indexOf(
      g09a,
      'out',
      (m) => m['id'] === requestId(g09a, 'session/load') && !('method' in m),
    )
    const setMode = indexOf(g09a, 'in', (m) => m['method'] === 'session/set_mode')
    const replayed = g09a.frames.slice(loadAnswer + 1, setMode).filter((f) => f.dir === 'out')
    expect(replayed.map((f) => ((message(f)!['params'] as Json)['update'] as Json)['sessionUpdate'])).toEqual(
      ['user_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call', 'agent_message_chunk'],
    )
  })
})

function requestId(fx: Fixture, method: string): unknown {
  return messages(fx, 'in').find((m) => m['method'] === method && 'id' in m)?.['id']
}

describe('safety rules in the host frames', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_n, fx) => {
    const ins = messages(fx, 'in')
    // JSON-RPC 2.0 on every host frame; never authenticate or logout; no method the base does not send
    for (const m of ins) expect(m['jsonrpc']).toBe('2.0')
    const sent = ins.filter((m) => typeof m['method'] === 'string').map((m) => String(m['method']))
    for (const m of sent)
      expect([
        'initialize',
        'session/new',
        'session/load',
        'session/resume',
        'session/set_mode',
        'session/prompt',
        'session/cancel',
      ]).toContain(m)
    // the handshake: protocol 1, fs and terminal false (never a client capability that would serve files or shells)
    expect(requestParams(fx, 'initialize')).toEqual(initializeParams())
    // never an MCP server of Dim Factory's own
    for (const method of ['session/new', 'session/load', 'session/resume']) {
      const p = requestParams(fx, method)
      if (p !== undefined) expect(p).toMatchObject({ cwd: '<CWD>', mcpServers: [] })
    }
    // argv: `gemini --acp [-m <model>] [--skip-trust]`; the prompt never in argv
    const argv = fx.header.argv
    expect(argv.slice(0, 2)).toEqual(['gemini', '--acp'])
    const prompt = fx.header.pass?.prompt
    if (prompt !== undefined) for (const a of argv) expect(a).not.toContain(prompt.slice(0, 20))
    if (fx.header.pass?.model !== undefined) expect(argv.slice(2, 4)).toEqual(['-m', fx.header.pass.model])
    else expect(argv).not.toContain('-m')
    // --skip-trust only with a vendorFolder grant (a pass's trustFolder) or in Dim Factory's own folder (the probe)
    const trusted = fx.header.pass?.kind === 'probe' || fx.header.pass?.trustFolder === true
    expect(argv.includes('--skip-trust')).toBe(trusted)
    if (fx.header.pass?.kind === 'pass') expect(typeof fx.header.pass.trustFolder).toBe('boolean')
  })

  it.each(passes.map((f) => [f.name, f] as const))('%s: the mode table, after every setup', (_n, fx) => {
    const setups = ['session/new', 'session/load', 'session/resume']
      .map((m) => indexOf(fx, 'out', (x) => x['id'] === requestId(fx, m) && 'result' in x))
      .filter((i) => i !== -1)
    const setMode = indexOf(fx, 'in', (m) => m['method'] === 'session/set_mode')
    const prompt = indexOf(fx, 'in', (m) => m['method'] === 'session/prompt')
    if (setups.length === 0) {
      // the setup was refused (G09c, G10b) or the CLI exited first (GX): nothing more is sent
      expect(setMode).toBe(-1)
      expect(prompt).toBe(-1)
      return
    }
    const pass = fx.header.pass!
    const want = pass.planNative === true ? 'plan' : MODE_IDS[String(pass.mode)]
    expect(requestParams(fx, 'session/set_mode')?.['modeId']).toBe(want)
    // set_mode after the setup answered, the prompt after set_mode answered: the session id is known (and persisted)
    expect(setMode).toBeGreaterThan(Math.max(...setups))
    const setModeAnswer = indexOf(
      fx,
      'out',
      (m) => m['id'] === requestId(fx, 'session/set_mode') && !('method' in m),
    )
    expect(prompt).toBeGreaterThan(setModeAnswer)
    // a resume continues the pass's session, by the route the agent advertised
    if (pass.resume !== undefined) {
      const route = requestParams(fx, 'session/resume') !== undefined ? 'session/resume' : 'session/load'
      expect(requestParams(fx, route)?.['sessionId']).toBe(pass.resume.sessionId)
      const caps = (
        messages(fx, 'out').find((m) => m['id'] === requestId(fx, 'initialize'))?.['result'] as Json
      )['agentCapabilities'] as Json
      const resume = ((caps['sessionCapabilities'] ?? {}) as Json)['resume']
      expect(route).toBe(resume !== undefined && resume !== null ? 'session/resume' : 'session/load')
      expect(requestParams(fx, 'session/new')).toBeUndefined()
    }
    // full mode only from Auto: no fixture pass runs yolo
    expect(requestParams(fx, 'session/set_mode')?.['modeId']).not.toBe('yolo')
  })

  it('never chooses a forbidden, persistent or reject_always option; allow-session only from optionPrefs', () => {
    for (const fx of fixtures) {
      for (const p of permissions(fx)) {
        const chosen = chosenOf(p.replies[0]!)
        if (chosen === null) continue
        const option = optionsOf(p.request).find((o) => o.optionId === chosen)
        expect(option, `${fx.name}: chose an option it was not offered`).toBeDefined()
        expect(GEMINI_PREFS.forbidden).not.toContain(chosen)
        expect(option?.kind).not.toBe('reject_always')
        if (option?.kind === 'allow_always') {
          expect(GEMINI_PREFS.allowSession).toContain(chosen)
          expect(PERSISTENT_OPTION_NAME.test(option.name)).toBe(false)
        }
      }
    }
  })

  it('a Plan pass captures the plan exit, rejects it and sends session/cancel; it is never approved', () => {
    for (const fx of fixtures) {
      for (const p of permissions(fx).filter((x) => isExit(x.request))) {
        const option = optionsOf(p.request).find((o) => o.optionId === chosenOf(p.replies[0]!))
        expect(option?.kind, fx.name).toBe('reject_once')
        expect(fx.header.pass?.planNative).toBe(true)
        const replyAt = indexOf(fx, 'in', (m) => m['id'] === p.request['id'] && !('method' in m))
        const cancelAt = indexOf(fx, 'in', (m) => m['method'] === 'session/cancel')
        expect(cancelAt).toBeGreaterThan(replyAt)
        expect(eventsOf(fx).find((e) => e['type'] === 'done')).toBeDefined()
        expect(signalsOf(fx)).toEqual(
          expect.arrayContaining([
            { type: 'plan-captured', markdown: planOf(fx, p.request), source: 'acp-exit-plan' },
            { type: 'auto-answered', decision: 'deny', why: 'plan-capture' },
          ]),
        )
      }
    }
    expect(fixtures.some((fx) => permissions(fx).some((p) => isExit(p.request)))).toBe(true)
  })

  it("Gemini's own shapes: the exit names its plan file, a shell request's title is its command", () => {
    // G08: kind other, no content; the plan file is written (a file frame) before the request that names it.
    const g08 = loadFixture('G08-plan-exit-captured')
    const exit = permissions(g08).find((p) => isExit(p.request))!
    const call = toolCallOf(exit.request)
    expect(call.kind).toBe('other')
    expect(call.content ?? []).toEqual([])
    const fileAt = g08.frames.findIndex((f) => f.dir === 'file')
    const requestAt = indexOf(g08, 'out', (m) => m['method'] === 'session/request_permission')
    expect(fileAt).toBeGreaterThan(-1)
    expect(fileAt).toBeLessThan(requestAt)
    // Every shell request: the command is the title, the one text block the explanation (never the command).
    for (const fx of fixtures)
      for (const p of permissions(fx)) {
        const tc = toolCallOf(p.request)
        if (tc.kind !== 'execute') continue
        expect(toolCallText(tc), fx.name).toMatch(/^\[(in |current working directory )/)
        expect(tc.title, fx.name).not.toMatch(/^\[/)
      }
  })

  it('every set_mode that changes the mode is echoed as [MODE_UPDATE] text before it answers', () => {
    for (const fx of passes) {
      const mode = requestParams(fx, 'session/set_mode')?.['modeId']
      if (typeof mode !== 'string') continue
      const echoes = messages(fx, 'out')
        .filter((m) => m['method'] === 'session/update')
        .map((m) => (m['params'] as Json)['update'] as Json)
        .filter((u) => u['sessionUpdate'] === 'agent_message_chunk')
        .map((u) => String((u['content'] as Json)['text']))
        .filter((t) => GEMINI_MODE_UPDATE.test(t))
      expect(echoes, fx.name).toEqual(mode === 'default' ? [] : [`[MODE_UPDATE] ${mode}`])
    }
  })

  it('a Stop sends session/cancel and answers every pending permission cancelled (G10a)', () => {
    const fx = loadFixture('G10a-cancel-pending-permission')
    const cancelAt = indexOf(fx, 'in', (m) => m['method'] === 'session/cancel')
    expect(cancelAt).toBeGreaterThan(-1)
    for (const p of permissions(fx)) {
      expect(p.replies[0]!['result']).toEqual(CANCELLED_OUTCOME)
      expect(indexOf(fx, 'in', (m) => m['id'] === p.request['id'] && !('method' in m))).toBeGreaterThan(
        cancelAt,
      )
    }
    expect(eventsOf(fx).at(-1)).toMatchObject({ type: 'error', category: 'user_cancelled' })
  })

  it('the host closes stdin after the turn (eof), except where the CLI exited first', () => {
    for (const fx of fixtures) {
      const exitEarly = fx.name.startsWith('GX')
      expect(
        fx.frames.some((f) => f.dir === 'eof'),
        fx.name,
      ).toBe(!exitEarly)
      if (!exitEarly) expect(fx.frames.at(-2)?.dir).toBe('eof')
    }
  })
})
