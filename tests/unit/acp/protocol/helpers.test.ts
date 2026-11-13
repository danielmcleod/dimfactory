// protocol.ts helpers (the ACP base): what the agent advertised (resume route, modes,
// models), the decision table (allow → allow_once; allow-session → the first session-scoped allow_always of
// optionPrefs, never a forbidden or persistent one; deny → reject_once; cancel → cancelled), the ask kinds, the plan
// exit, the usage conversions (G05) and the words of an ACP error.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ASK_KIND_OF_TOOL,
  CACHED_READ_IN_INPUT_DEFAULT,
  CANCELLED_OUTCOME,
  PERSISTENT_OPTION_NAME,
  acpErrorText,
  agentFactsOf,
  allowSessionOption,
  askKindOf,
  cachedReadInInputOf,
  canAllowSession,
  hasMode,
  isAuthRequired,
  isFinalToolStatus,
  isPlanExit,
  methodAvailable,
  permissionReply,
  promptUsageOf,
  protocolCompatible,
  rejectReply,
  resumeKindOf,
  resumeRouteOf,
  sessionSetupOf,
  toolCallText,
  usageFromAcp,
  usageFromContext,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import type {
  PermissionOption,
  PermissionOptionPrefs,
  ToolKind,
} from '../../../../src/core/adapters/acp-base/protocol.ts'
import { isPlanExit as adapterIsPlanExit } from '../../../../src/core/adapters/acp-base/permissions.ts'
import { GEMINI_PLAN_EXIT_TITLE } from '../../../../src/core/adapters/gemini/wire.ts'
import { GEMINI_PREFS } from '../../../fixtures/gemini/recipes/synthesize.mjs'
import { loadFixture, responseTo } from './fixtures.ts'

const PREFS: PermissionOptionPrefs = GEMINI_PREFS
const O = {
  once: { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  always: { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
  save: { optionId: 'proceed_always_and_save', name: 'Allow for all future sessions', kind: 'allow_always' },
  server: {
    optionId: 'proceed_always_server',
    name: 'Always allow all tools from server "x"',
    kind: 'allow_always',
  },
  tool: { optionId: 'proceed_always_tool', name: 'Always allow tool "y"', kind: 'allow_always' },
  reject: { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
  rejectAlways: { optionId: 'never', name: 'Never allow', kind: 'reject_always' },
} satisfies Record<string, PermissionOption>

const selected = (optionId: string): unknown => ({ outcome: { outcome: 'selected', optionId } })

describe('what the agent advertised', () => {
  it('G01: Gemini resumes by session/load and offers the plan mode', () => {
    const fx = loadFixture('G01-handshake-session')
    const facts = agentFactsOf(responseTo(fx, 'initialize')?.['result'])
    expect(facts).toMatchObject({
      protocolVersion: 1,
      loadSession: true,
      resumeSession: false,
      authMethods: ['oauth-personal', 'gemini-api-key', 'vertex-ai'],
      agentName: 'gemini-cli',
    })
    expect(protocolCompatible(facts)).toBe(true)
    expect(resumeRouteOf(facts)).toBe('load')
    expect(resumeKindOf(resumeRouteOf(facts))).toBe('load')
    const setup = sessionSetupOf(responseTo(fx, 'session/new')?.['result'])
    expect(setup.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(setup.modes?.available.map((m) => m.id)).toEqual(['default', 'autoEdit', 'yolo', 'plan'])
    expect(setup.modes?.current).toBe('default')
    expect(setup.models?.current).toBe('auto-gemini-3')
    expect(hasMode(setup, 'plan')).toBe(true)
    expect(methodAvailable('session/set_mode', facts, setup)).toBe(true)
    expect(methodAvailable('session/set_model', facts, setup)).toBe(true)
    expect(methodAvailable('session/resume', facts, setup)).toBe(false)
    expect(methodAvailable('session/load', facts, setup)).toBe(true)
    expect(methodAvailable('session/set_config_option', facts, setup)).toBe(false)
    expect(methodAvailable('authenticate', facts, setup)).toBe(false)
    expect(methodAvailable('session/prompt', facts, setup)).toBe(true)
  })

  it('G09b: session/resume when advertised, preferred over session/load', () => {
    const facts = agentFactsOf(responseTo(loadFixture('G09b-resume-advertised'), 'initialize')?.['result'])
    expect(facts.resumeSession).toBe(true)
    expect(facts.loadSession).toBe(true)
    expect(resumeRouteOf(facts)).toBe('resume')
    expect(resumeKindOf('resume')).toBe('id')
  })

  it('reads any shape without throwing, with the schema defaults', () => {
    for (const v of [undefined, null, 7, 'x', [], { agentCapabilities: 'no' }, { sessionCapabilities: {} }]) {
      const f = agentFactsOf(v)
      expect(f.loadSession).toBe(false)
      expect(f.resumeSession).toBe(false)
      expect(resumeRouteOf(f)).toBe('none')
      expect(sessionSetupOf(v)).toEqual({ sessionId: null, modes: null, models: null, configOptions: 0 })
    }
    expect(protocolCompatible({ protocolVersion: 2 })).toBe(false)
    expect(agentFactsOf({ agentCapabilities: { sessionCapabilities: { resume: null } } }).resumeSession).toBe(
      false,
    )
    expect(
      hasMode(sessionSetupOf({ modes: { currentModeId: 'a', availableModes: [{ id: 'a' }] } }), 'plan'),
    ).toBe(false)
  })
})

describe('the decision table', () => {
  it('allow → allow_once; deny → reject_once; cancel → cancelled', () => {
    const options = [O.always, O.once, O.reject]
    expect(permissionReply('allow', options, PREFS)).toEqual(selected('proceed_once'))
    expect(permissionReply('deny', options, PREFS)).toEqual(selected('cancel'))
    expect(permissionReply('cancel', options, PREFS)).toBe(CANCELLED_OUTCOME)
    expect(rejectReply(options, PREFS)).toEqual(selected('cancel'))
  })

  it('allow-session picks the first optionPrefs entry offered, never the forbidden save option', () => {
    expect(permissionReply('allow-session', [O.save, O.always, O.once, O.reject], PREFS)).toEqual(
      selected('proceed_always'),
    )
    // MCP: proceed_always_tool comes first in optionPrefs.
    expect(permissionReply('allow-session', [O.server, O.tool, O.once, O.reject], PREFS)).toEqual(
      selected('proceed_always_tool'),
    )
    expect(allowSessionOption([O.server, O.once], PREFS)?.optionId).toBe('proceed_always_server')
    expect(canAllowSession([O.always, O.once], PREFS)).toBe(true)
  })

  it('a forbidden-only or persistent-only option set: allowSession false, and allow-session falls back to once', () => {
    expect(canAllowSession([O.save, O.once, O.reject], PREFS)).toBe(false)
    expect(permissionReply('allow-session', [O.save, O.once, O.reject], PREFS)).toEqual(
      selected('proceed_once'),
    )
    // An allowed id whose name says it outlives the session is never chosen.
    for (const name of ['Allow in all future sessions', 'Always allow (all sessions)', 'Allow permanently']) {
      expect(PERSISTENT_OPTION_NAME.test(name)).toBe(true)
      const persistent = { ...O.always, name }
      expect(canAllowSession([persistent, O.once], PREFS)).toBe(false)
      expect(permissionReply('allow-session', [persistent, O.once], PREFS)).toEqual(selected('proceed_once'))
    }
    // An allow_once offered under an allowSession id is not an allow_always.
    expect(canAllowSession([{ ...O.always, kind: 'allow_once' }], PREFS)).toBe(false)
  })

  it('never reject_always, never an allow_always for a plain allow; nothing fitting → cancelled', () => {
    expect(permissionReply('deny', [O.once, O.rejectAlways], PREFS)).toBe(CANCELLED_OUTCOME)
    expect(permissionReply('allow', [O.always, O.reject], PREFS)).toBe(CANCELLED_OUTCOME)
    expect(permissionReply('allow-session', [O.save, O.reject], PREFS)).toBe(CANCELLED_OUTCOME)
    expect(permissionReply('allow', [], PREFS)).toBe(CANCELLED_OUTCOME)
  })

  it('an optionId offered twice is never chosen (the agent maps the answer back by id alone)', () => {
    const twin = [{ ...O.once, optionId: 'x' }, { ...O.save, optionId: 'x' }, O.reject]
    expect(permissionReply('allow', twin, PREFS)).toBe(CANCELLED_OUTCOME)
    const twinAlways = [O.always, { ...O.always, name: 'Allow for all future sessions' }, O.once]
    expect(canAllowSession(twinAlways, PREFS)).toBe(false)
    expect(permissionReply('allow-session', twinAlways, PREFS)).toEqual(selected('proceed_once'))
  })

  it('property: whatever is offered, the reply is never forbidden, persistent or reject_always', () => {
    const option = fc.record({
      optionId: fc.constantFrom(
        'proceed_once',
        'proceed_always',
        'proceed_always_and_save',
        'proceed_always_server',
        'proceed_always_tool',
        'cancel',
        'other',
      ),
      name: fc.constantFrom(
        'Allow',
        'Allow for this session',
        'Allow for all future sessions',
        'Allow permanently',
        'Reject',
      ),
      kind: fc.constantFrom('allow_once', 'allow_always', 'reject_once', 'reject_always'),
    })
    fc.assert(
      fc.property(
        fc.array(option, { maxLength: 6 }),
        fc.constantFrom('allow', 'allow-session', 'deny', 'cancel'),
        (options, decision) => {
          const reply = permissionReply(decision, options, PREFS)
          if (reply.outcome.outcome === 'cancelled') return true
          const id = reply.outcome.optionId
          // The agent reads the answer by id: the id names exactly one option, which is the one checked below.
          expect(options.filter((o) => o.optionId === id)).toHaveLength(1)
          const chosen = options.find((o) => o.optionId === id)
          expect(chosen).toBeDefined()
          expect(PREFS.forbidden).not.toContain(chosen?.optionId)
          expect(chosen?.kind).not.toBe('reject_always')
          if (chosen?.kind === 'allow_always') {
            expect(decision).toBe('allow-session')
            expect(PERSISTENT_OPTION_NAME.test(chosen.name)).toBe(false)
            expect(PREFS.allowSession).toContain(chosen.optionId)
          }
          if (decision === 'deny') expect(chosen?.kind).toBe('reject_once')
          if (decision === 'allow') expect(chosen?.kind).toBe('allow_once')
          return true
        },
      ),
    )
  })
})

describe('tools', () => {
  it('ask kinds: edit/delete/move → edit, execute → shell, fetch → network, else other', () => {
    expect(Object.entries(ASK_KIND_OF_TOOL)).toHaveLength(10)
    expect(['edit', 'delete', 'move'].map(askKindOf)).toEqual(['edit', 'edit', 'edit'])
    expect(askKindOf('execute')).toBe('shell')
    expect(askKindOf('fetch')).toBe('network')
    for (const k of ['read', 'search', 'think', 'switch_mode', 'other', 'future_kind', null, undefined])
      expect(askKindOf(k)).toBe('other')
    expect(askKindOf('constructor')).toBe('other')
  })

  it('the plan exit: kind switch_mode, or exit_plan_mode by name or title', () => {
    expect(isPlanExit({ kind: 'switch_mode', title: 'anything' })).toBe(true)
    expect(isPlanExit({ kind: 'other', name: 'exit_plan_mode', title: 'x' })).toBe(true)
    expect(isPlanExit({ kind: 'other', title: 'Exit plan mode' })).toBe(true)
    expect(isPlanExit({ kind: 'execute', title: 'npm run exit-plan' })).toBe(false)
    expect(isPlanExit({ kind: 'edit', title: 'plans/version-flag.md' })).toBe(false)
    // Entering plan mode is a mode switch, never the plan; a named exit of a tool kind that does things is not one.
    expect(isPlanExit({ kind: 'switch_mode', name: 'enter_plan_mode', title: 'Enter plan mode' })).toBe(false)
    expect(isPlanExit({ kind: 'switch_mode', title: 'Enter plan mode' })).toBe(false)
    expect(isPlanExit({ name: 'exit_plan_mode', title: 'x' })).toBe(true)
    expect(isPlanExit({ kind: 'think', title: 'Exit plan mode' })).toBe(true)
    expect(isPlanExit({ kind: 'execute', name: 'exit_plan_mode', title: 'Exit plan mode' })).toBe(false)
  })

  it('the plan exit is the adapter’s own rule (permissions.ts isPlanExit), on every combination', () => {
    const kinds = [undefined, null, 'switch_mode', 'other', 'think', 'execute', 'edit', 'read']
    const names = [undefined, 'exit_plan_mode', 'enter_plan_mode', 'ExitPlanMode', 'read_file']
    const titles = [
      undefined,
      'Exit plan mode',
      'Enter plan mode',
      'exit_plan_mode: done',
      'plans/a.md',
      // Gemini's own exit_plan_mode title, and one that only looks like it.
      'Requesting plan approval for: /h/.gemini/tmp/p/s/plans/a.md',
      'Requesting plan approval for: /h/.gemini/tmp/p/s/plans/a.txt',
    ]
    for (const exitTitle of [undefined, GEMINI_PLAN_EXIT_TITLE])
      for (const kind of kinds)
        for (const name of names)
          for (const title of titles) {
            const call = {
              ...(kind !== undefined ? { kind: kind as ToolKind | null } : {}),
              ...(name !== undefined ? { name } : {}),
              ...(title !== undefined ? { title } : {}),
            }
            expect(isPlanExit(call, exitTitle), JSON.stringify(call)).toBe(adapterIsPlanExit(call, exitTitle))
          }
  })

  it("Gemini's exit_plan_mode (kind other, its plan file in the title) is the plan exit only with its title rule", () => {
    const call = {
      kind: 'other' as ToolKind,
      title: String.raw`Requesting plan approval for: C:\h\.gemini\tmp\p\s\plans\v.md`,
    }
    expect(isPlanExit(call)).toBe(false)
    expect(isPlanExit(call, GEMINI_PLAN_EXIT_TITLE)).toBe(true)
    // A tool kind that does things is never read as the exit, whatever its title says.
    expect(isPlanExit({ ...call, kind: 'execute' }, GEMINI_PLAN_EXIT_TITLE)).toBe(false)
    expect(isPlanExit({ ...call, kind: 'edit' }, GEMINI_PLAN_EXIT_TITLE)).toBe(false)
  })

  it('a tool call’s text content (the plan G08 carries)', () => {
    expect(
      toolCallText({
        content: [
          { type: 'content', content: { type: 'text', text: '## Plan' } },
          { type: 'diff', path: 'a', newText: 'b' },
          { type: 'content', content: { type: 'text', text: '1. Do it.' } },
        ],
      }),
    ).toBe('## Plan\n\n1. Do it.')
    expect(toolCallText({ content: [] })).toBeNull()
    expect(toolCallText({})).toBeNull()
    expect(isFinalToolStatus('completed')).toBe(true)
    expect(isFinalToolStatus('failed')).toBe(true)
    expect(isFinalToolStatus('in_progress')).toBe(false)
    expect(isFinalToolStatus('pending')).toBe(false)
  })
})

describe('usage (G05, pending live confirmation)', () => {
  it('cached reads come off the input; thoughts are reasoning', () => {
    expect(CACHED_READ_IN_INPUT_DEFAULT).toBe(true)
    const u = {
      totalTokens: 19284,
      inputTokens: 18432,
      outputTokens: 612,
      thoughtTokens: 240,
      cachedReadTokens: 12288,
    }
    expect(usageFromAcp(u)).toEqual({ input: 6144, output: 612, cacheRead: 12288, reasoning: 240 })
    expect(usageFromAcp(u, { cachedReadInInput: false })).toEqual({
      input: 18432,
      output: 612,
      cacheRead: 12288,
      reasoning: 240,
    })
    expect(usageFromAcp({ totalTokens: 10, inputTokens: 7, outputTokens: 3 })).toEqual({
      input: 7,
      output: 3,
    })
    // Never negative, whatever a vendor reports.
    expect(usageFromAcp({ totalTokens: 5, inputTokens: 2, outputTokens: 3, cachedReadTokens: 9 }).input).toBe(
      0,
    )
  })

  it('a report says on its own whether cached reads are inside the input', () => {
    expect(
      cachedReadInInputOf({
        totalTokens: 19284,
        inputTokens: 18432,
        outputTokens: 612,
        thoughtTokens: 240,
        cachedReadTokens: 12288,
      }),
    ).toBe(true)
    expect(
      cachedReadInInputOf({
        totalTokens: 31572,
        inputTokens: 18432,
        outputTokens: 612,
        thoughtTokens: 240,
        cachedReadTokens: 12288,
      }),
    ).toBe(false)
    expect(
      cachedReadInInputOf({ totalTokens: 1, inputTokens: 18432, outputTokens: 612, cachedReadTokens: 12288 }),
    ).toBeUndefined()
    expect(cachedReadInInputOf({ totalTokens: 19044, inputTokens: 18432, outputTokens: 612 })).toBeUndefined()
  })

  it("G05a: Gemini's own total cannot tell (input + output), so the default decides; never false", () => {
    // gemini-cli 0.64 buildPromptResponse sends totalTokens = inputTokens + outputTokens, whatever the
    // cached and thought tokens are. With thoughts the report reads undefined, without them true: never false.
    const fx = loadFixture('G05a-usage-cached-tokens')
    const result = responseTo(fx, 'session/prompt')?.['result'] as Record<string, unknown> | undefined
    const u = promptUsageOf(result)
    expect(u).toBeDefined()
    if (u === undefined) return
    expect(u.totalTokens).toBe(u.inputTokens + u.outputTokens)
    expect(cachedReadInInputOf(u)).toBeUndefined()
    expect(CACHED_READ_IN_INPUT_DEFAULT).toBe(true)
    // What a live re-record checks instead: usage.inputTokens is _meta.quota's input_tokens (promptTokenCount, which
    // includes the cached content).
    const quota = (result?.['_meta'] as { quota: { token_count: { input_tokens: number } } }).quota
    expect(u.inputTokens).toBe(quota.token_count.input_tokens)
    for (const thoughts of [0, 1, 240])
      for (const cached of [1, 12288])
        expect(
          cachedReadInInputOf({
            totalTokens: 18432 + 612,
            inputTokens: 18432,
            outputTokens: 612,
            cachedReadTokens: cached,
            ...(thoughts > 0 ? { thoughtTokens: thoughts } : {}),
          }),
        ).not.toBe(false)
  })

  it('a prompt response usage is read defensively', () => {
    expect(promptUsageOf({ stopReason: 'end_turn' })).toBeUndefined()
    expect(promptUsageOf({ usage: { inputTokens: 'x', outputTokens: 1 } })).toBeUndefined()
    expect(promptUsageOf({ usage: { inputTokens: 4, outputTokens: 1 } })).toEqual({
      totalTokens: 5,
      inputTokens: 4,
      outputTokens: 1,
    })
  })

  it('the usage_update fallback: the context stands in for the input, USD cost kept', () => {
    expect(usageFromContext({ used: 7168 })).toEqual({ input: 7168, output: 0 })
    expect(usageFromContext({ used: 10, cost: { amount: 0.02, currency: 'usd' } })).toEqual({
      input: 10,
      output: 0,
      costUsd: 0.02,
    })
    expect(usageFromContext({ used: 10, cost: { amount: 3, currency: 'EUR' } })).toEqual({
      input: 10,
      output: 0,
    })
  })
})

describe('errors', () => {
  it('a thrown Error arrives as -32603 "Internal error" with the words in data.details (G09c, G10c)', () => {
    const fx = loadFixture('G09c-resume-unknown-session')
    const error = responseTo(fx, 'session/load')?.['error'] as {
      code: number
      message: string
      data?: unknown
    }
    expect(error.code).toBe(-32603)
    expect(error.message).toBe('Internal error')
    expect(acpErrorText(error)).toMatch(/^Internal error: Invalid session identifier "/)
    expect(acpErrorText({ message: 'Authentication required' })).toBe('Authentication required')
    expect(acpErrorText({ message: 'x', data: 'plain' })).toBe('x: plain')
    expect(acpErrorText({ message: 'same', data: { details: 'same' } })).toBe('same')
    expect(isAuthRequired({ code: -32000 })).toBe(true)
    expect(isAuthRequired({ code: -32603 })).toBe(false)
  })
})
