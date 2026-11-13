// P1 fixtures C11–C15 (recorded with claude.exe 2.1.289):
// what each recording settles, asserted on the normalizer's view of it. The snapshot, contract and replay suites
// pick these recordings up automatically; this file pins the decisions.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { allowRuleFor, askKind } from '@core/adapters/claude/asks.ts'
import type { RecordingEntry } from '@core/adapters/claude/normalize.ts'
import { normalizeRecording, parseRecording } from '@core/adapters/claude/normalize.ts'
import type { CanUseToolRequest, JsonObject } from '@core/adapters/claude/protocol.ts'
import { asCanUseTool, obj, parseFrame, str } from '@core/adapters/claude/protocol.ts'
import { synth, synthRe } from '../../synth.ts'

const STDIO = fileURLToPath(new URL('../../fixtures/claude/stdio/', import.meta.url))
const text = (id: string): string => readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8')
const entries = (id: string): RecordingEntry[] => normalizeRecording(text(id))

/** Every recorded stdout JSON frame. */
function outFrames(id: string): JsonObject[] {
  return parseRecording(text(id)).frames.flatMap((f) => {
    const v = f.dir === 'out' && f.line !== undefined ? parseFrame(f.line) : undefined
    return v !== undefined ? [v] : []
  })
}

const errFrames = (id: string): string[] =>
  parseRecording(text(id)).frames.flatMap((f) => (f.dir === 'err' && f.line !== undefined ? [f.line] : []))
const exitOf = (id: string) => parseRecording(text(id)).frames.find((f) => f.dir === 'exit')
const init = (id: string): JsonObject | undefined =>
  outFrames(id).find((f) => f['type'] === 'system' && f['subtype'] === 'init')
const resultOf = (id: string): JsonObject | undefined => outFrames(id).find((f) => f['type'] === 'result')
const asks = (id: string): CanUseToolRequest[] =>
  outFrames(id).flatMap((f) => {
    const r = f['type'] === 'control_request' ? asCanUseTool(obj(f['request']) ?? {}) : undefined
    return r !== undefined ? [r] : []
  })
const ofType = <T extends RecordingEntry['type']>(list: RecordingEntry[], type: T) =>
  list.filter((e): e is Extract<RecordingEntry, { type: T }> => e.type === type)
const shellTools = (id: string): string[] =>
  ((init(id)?.['tools'] as string[] | undefined) ?? []).filter((t) => t === 'Bash' || t === 'PowerShell')

describe('C11: argument and model errors', () => {
  it('C11a: an unknown flag is stderr only, exit 1, before any session → flag_drift', () => {
    expect(outFrames('C11a-unknown-flag')).toEqual([])
    expect(errFrames('C11a-unknown-flag')).toEqual(["error: unknown option '--not-a-real-flag'"])
    expect(exitOf('C11a-unknown-flag')).toMatchObject({ code: 1 })
    const list = entries('C11a-unknown-flag')
    expect(ofType(list, 'session')).toEqual([])
    expect(ofType(list, 'error')).toMatchObject([
      { fatal: true, category: 'flag_drift', message: "error: unknown option '--not-a-real-flag'" },
    ])
  })

  it('C11b: an unknown model starts a session, then fails with a synthetic model_not_found turn (0 tokens)', () => {
    expect(init('C11b-invalid-model')).toMatchObject({ model: 'claude-nonexistent-9' })
    expect(errFrames('C11b-invalid-model')).toEqual([
      '[claude-code:unrecognized_model] {"model":"claude-nonexistent-9","query_source":"sdk"}',
    ])
    const assistant = outFrames('C11b-invalid-model').find((f) => f['type'] === 'assistant')
    expect(assistant).toMatchObject({ error: 'model_not_found', message: { model: '<synthetic>' } })
    expect(resultOf('C11b-invalid-model')).toMatchObject({
      subtype: 'success',
      is_error: true,
      api_error_status: 404,
      terminal_reason: 'api_error',
      total_cost_usd: 0,
      modelUsage: {},
    })
    const list = entries('C11b-invalid-model')
    expect(ofType(list, 'session')).toHaveLength(1)
    expect(ofType(list, 'error')).toMatchObject([
      {
        fatal: true,
        category: 'model_unavailable',
        message: expect.stringMatching(/issue with the selected model/) as unknown,
      },
    ])
  })
})

describe('C12: turn and budget limits (read-only route with its tool cut + extraArgs)', () => {
  it('C12a: --max-turns 1 ends after the first tool round with error_max_turns → turn_limit', () => {
    expect(resultOf('C12a-max-turns')).toMatchObject({
      subtype: 'error_max_turns',
      is_error: true,
      terminal_reason: 'max_turns',
      errors: ['Reached maximum number of turns (1)'],
      num_turns: 2,
    })
    expect(resultOf('C12a-max-turns')).not.toHaveProperty('result')
    const list = entries('C12a-max-turns')
    // Live re-record 2026-10-25: the first model call reads both files in one message (2026-10-12: one file).
    expect(ofType(list, 'tool').filter((t) => t.phase === 'end')).toMatchObject([
      { name: 'Read', status: 'ok', summary: '<CWD>\\src\\index.ts' },
      { name: 'Read', status: 'ok', summary: '<CWD>\\package.json' },
    ])
    expect(ofType(list, 'error')).toMatchObject([
      { fatal: true, category: 'turn_limit', message: 'Reached maximum number of turns (1)' },
    ])
    // The spend is still reported (the engine records it although the pass failed).
    expect(ofType(list, 'meta').find((m) => m.key === 'usage')?.value).toMatchObject({
      costUsd: 0.021627800000000003,
    })
  })

  it('C12b: --max-budget-usd stops before the first tool runs → turn_limit; the open tool ends failed', () => {
    expect(resultOf('C12b-max-budget')).toMatchObject({
      subtype: 'error_max_budget_usd',
      terminal_reason: 'budget_exhausted',
      errors: ['Reached maximum budget ($0.0001)'],
      num_turns: 1,
    })
    expect(outFrames('C12b-max-budget').some((f) => f['type'] === 'user')).toBe(false)
    const list = entries('C12b-max-budget')
    expect(ofType(list, 'tool')).toMatchObject([
      { name: 'Read', phase: 'start' },
      { name: 'Read', phase: 'end', status: 'failed' },
    ])
    expect(ofType(list, 'error')).toMatchObject([
      { category: 'turn_limit', message: 'Reached maximum budget ($0.0001)' },
    ])
  })
})

describe('C13: subagent frames stay out of the main thread', () => {
  const id = 'C13-subagent'

  it('the recording has subagent frames (parent_tool_use_id) and no subagent stream deltas', () => {
    const frames = outFrames(id)
    const agent = frames
      .filter((f) => f['type'] === 'assistant' && f['parent_tool_use_id'] === null)
      .flatMap((f) => (obj(f['message'])?.['content'] as JsonObject[] | undefined) ?? [])
      .find((b) => b['type'] === 'tool_use')
    // init lists the tool as Task; the model calls it as Agent.
    expect((init(id)?.['tools'] as string[]).includes('Task')).toBe(true)
    expect(agent).toMatchObject({ name: 'Agent', input: { subagent_type: 'general-purpose' } })
    const parent = str(agent?.['id'])
    const sub = frames.filter((f) => f['parent_tool_use_id'] === parent)
    expect(sub.map((f) => f['type'])).toEqual(['user', 'assistant', 'user'])
    expect(frames.filter((f) => f['type'] === 'stream_event' && f['parent_tool_use_id'] !== null)).toEqual([])
    // task_* system frames carry the parent id as tool_use_id, never parent_tool_use_id.
    const tasks = frames.filter((f) => f['type'] === 'system' && /^task_/.test(str(f['subtype']) ?? ''))
    expect(tasks.map((f) => f['subtype'])).toEqual([
      'task_started',
      'task_progress',
      'task_updated',
      'task_notification',
    ])
  })

  it('normalizes to the Agent tool start/end, its progress, and the main-thread answer only', () => {
    const list = entries(id)
    const tools = ofType(list, 'tool')
    // task_started / task_progress / task_notification update the Agent row (same id, `start` again): the subagent's
    // type, its last tool and its tokens; never its prompt or its answer.
    expect(tools).toMatchObject([
      { name: 'Agent', summary: synth('Summarize src/index.ts'), phase: 'start' },
      { name: 'Agent', summary: `${synth('Summarize src/index.ts')} · general-purpose`, phase: 'start' },
      {
        name: 'Agent',
        summary: `${synth('Summarize src/index.ts')} · general-purpose · Read · 12.7k tokens`,
        phase: 'start',
      },
      {
        name: 'Agent',
        summary: `${synth('Summarize src/index.ts')} · general-purpose · 14.6k tokens`,
        phase: 'start',
      },
      { name: 'Agent', phase: 'end', status: 'ok' },
    ])
    expect(new Set(tools.map((t) => t.id)).size).toBe(1)
    const subToolIds = outFrames(id)
      .filter((f) => f['parent_tool_use_id'] !== null && f['parent_tool_use_id'] !== undefined)
      .flatMap((f) => (obj(f['message'])?.['content'] as JsonObject[] | undefined) ?? [])
      .flatMap((b) => (b['type'] === 'tool_use' ? [str(b['id'])] : []))
    expect(subToolIds).toHaveLength(1)
    expect(tools.some((t) => subToolIds.includes(t.id))).toBe(false)
    const printed = ofType(list, 'text')
      .map((t) => t.delta)
      .join('')
    const done = ofType(list, 'done')[0]
    expect(printed).toBe(done?.result)
    expect(done?.result).toBe(resultOf(id)?.['result'])
    // The subagent's prompt and its file read never reach the rendered stream.
    expect(printed).not.toMatch(synthRe('the file src/index.ts (in the working directory'))
    expect(JSON.stringify(list)).not.toContain(synth('Greeting logic for the ts-small CLI.'))
  })
})

describe('C14: shell tool names', () => {
  it('both Bash and PowerShell exist by default on Windows; each ask is a shell ask under its own name', () => {
    for (const id of ['C14a-shell-bash', 'C14b-shell-powershell', 'C14c-shell-bash-missing'])
      expect(shellTools(id)).toEqual(['Bash', 'PowerShell'])
    const bash = asks('C14a-shell-bash')
    const ps = asks('C14b-shell-powershell')
    expect(bash.map((a) => a.tool_name)).toEqual(['Bash'])
    expect(ps.map((a) => a.tool_name)).toEqual(['PowerShell'])
    expect(askKind('PowerShell')).toBe('shell')
    expect(ofType(entries('C14b-shell-powershell'), 'ask')).toMatchObject([
      {
        kind: 'shell',
        detail: expect.stringMatching(
          new RegExp(`^PowerShell: ${synthRe('npm --version').source}`),
        ) as unknown,
        allowSession: true,
      },
    ])
  })

  it('PowerShell asks differ: no decision_reason text, decision_reason_type subcommandResults', () => {
    expect(asks('C14a-shell-bash')[0]).toMatchObject({
      decision_reason: 'This command requires approval',
      decision_reason_type: 'other',
    })
    const ps = asks('C14b-shell-powershell')[0]!
    expect(ps).toMatchObject({ decision_reason_type: 'subcommandResults' })
    expect(ps).not.toHaveProperty('decision_reason')
    expect(ofType(entries('C14b-shell-powershell'), 'ask')[0]).not.toHaveProperty('reason')
  })

  it("allow-session uses the vendor's own PowerShell rule", () => {
    const ps = asks('C14b-shell-powershell')[0]!
    expect(allowRuleFor(ps, ps.permission_suggestions ?? [])).toEqual({
      vendor: 'claude',
      kind: 'shell',
      tool: 'PowerShell',
      match: { argv: [synth('npm'), '--version'] },
      nativeRules: [`PowerShell(${synth('npm --version')})`],
      source: 'vendor-suggestion',
    })
  })

  it('C14c: CLAUDE_CODE_GIT_BASH_PATH at a missing file is ignored; Bash still runs', () => {
    const header = parseRecording(text('C14c-shell-bash-missing')).header
    expect(header?.['envKeys']).toEqual(['CLAUDE_CODE_GIT_BASH_PATH'])
    expect(ofType(entries('C14c-shell-bash-missing'), 'tool').filter((t) => t.phase === 'end')).toMatchObject(
      [{ name: 'Bash', status: 'ok' }],
    )
    expect(exitOf('C14c-shell-bash-missing')).toMatchObject({ code: 0 })
  })
})

describe('C15: AskUserQuestion', () => {
  it('C15a: with a host and no --disallowedTools it arrives as a can_use_tool that requires interaction', () => {
    expect(init('C15a-askuser-allowed')?.['tools']).toContain('AskUserQuestion')
    const [ask] = asks('C15a-askuser-allowed')
    expect(ask).toMatchObject({ tool_name: 'AskUserQuestion', requires_user_interaction: true })
    expect(ask).not.toHaveProperty('permission_suggestions')
    const list = entries('C15a-askuser-allowed')
    // The adapter answers it itself ("unsupported", no interrupt); the user never sees an ask.
    expect(ofType(list, 'ask')).toEqual([])
    expect(ofType(list, 'auto-answered')).toMatchObject([
      { tool: 'AskUserQuestion', decision: 'deny', why: 'unsupported' },
    ])
    expect(ofType(list, 'tool')).toMatchObject([
      {
        name: 'AskUserQuestion',
        summary: synth('Should the new greeting that src/index.ts prints be in English or French?'),
      },
      { name: 'AskUserQuestion', phase: 'end', status: 'declined' },
    ])
    expect(ofType(list, 'done')[0]?.result).toMatch(synthRe('English or French?'))
  })

  it('C15b: --disallowedTools AskUserQuestion removes the tool; the model asks in its answer instead', () => {
    expect(init('C15b-askuser-disallowed')?.['tools']).not.toContain('AskUserQuestion')
    expect(asks('C15b-askuser-disallowed')).toEqual([])
    const list = entries('C15b-askuser-disallowed')
    expect(ofType(list, 'tool')).toEqual([])
    expect(ofType(list, 'auto-answered')).toEqual([])
    expect(ofType(list, 'done')[0]?.result).toMatch(synthRe('English or French?'))
  })
})
