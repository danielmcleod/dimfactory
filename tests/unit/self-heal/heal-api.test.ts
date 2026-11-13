// Self-heal seam (input: a tail of stderr plus status/control frames only, content
// frames dropped, strings over 300 characters truncated; parsing: unsafe suggestions dropped with "Dim Factory hid N
// unsafe suggestions"; a failed healer points to the vendor's docs). The executors' own tail filter is a property test:
// whatever a pass streamed, the task, plan, diff and file bodies never reach the healer.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { RecoveryAction } from '@shared/failure.ts'
import { hiddenSuggestionsText } from '@shared/failure.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import {
  HEAL_STRING_MAX,
  HEAL_TAIL_LINES,
  failedHeal,
  healTail,
  healViewOf,
  parseRawLog,
  statusFrame,
} from '@core/recovery/heal-api.ts'
import type { HealOutcome, RawLine } from '@core/recovery/heal-api.ts'

const SECRET_WORD = /[A-Za-z]{12,24}/

/** Frames a pass streams that carry content (Claude's shapes), each holding `secret`. */
const contentFrames = (secret: string): string[] => [
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: secret }] } }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: secret } },
    parent_tool_use_id: null,
  }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: secret }] } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.ts', content: secret } }],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: secret }] },
  }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: secret, num_turns: 2 }),
  JSON.stringify({
    type: 'control_request',
    request_id: 'r1',
    request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { new_string: secret } },
  }),
  JSON.stringify({ type: 'tool_progress', content: secret }),
  JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: secret } }),
]

describe('healTail', () => {
  it('never carries what the pass was given or wrote (property)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(SECRET_WORD),
        fc.array(fc.constantFrom('err', 'status'), { maxLength: 6 }),
        (secret, extra) => {
          const lines: RawLine[] = [
            // The prompt (task, plan, diff) goes to the CLI over stdin.
            {
              dir: 'in',
              line: JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: secret }] } }),
            },
            ...contentFrames(secret).map((line): RawLine => ({ dir: 'out', line })),
            ...extra.map((k): RawLine =>
              k === 'err'
                ? { dir: 'err', line: 'error: unknown option --foo' }
                : { dir: 'out', line: JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1 }) },
            ),
          ]
          const tail = healTail(lines)
          for (const l of tail) expect(l).not.toContain(secret)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('keeps stderr and status frames (only their status fields), cut at 300 characters, the last 40', () => {
    const long = 'x'.repeat(500)
    const lines: RawLine[] = [
      { dir: 'err', line: `error: unknown option '--permission-mode' ${long}` },
      {
        dir: 'out',
        line: JSON.stringify({
          type: 'system',
          subtype: 'init',
          cwd: 'C:\\work\\secret-project',
          tools: ['Bash'],
          model: 'claude-opus',
          claude_code_version: '2.1.290',
        }),
      },
      {
        dir: 'out',
        line: JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 },
        }),
      },
      {
        dir: 'out',
        line: JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['boom'],
        }),
      },
      { dir: 'out', line: 'not json' },
    ]
    const tail = healTail(lines)
    expect(tail[0]?.length).toBe(HEAL_STRING_MAX + 1)
    expect(tail[0]).toMatch(/^error: unknown option '--permission-mode' x+…$/)
    expect(JSON.parse(tail[1] ?? '{}')).toEqual({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus',
      claude_code_version: '2.1.290',
    })
    expect(JSON.parse(tail[2] ?? '{}')).toEqual({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 },
    })
    expect(JSON.parse(tail[3] ?? '{}')).toEqual({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['boom'],
    })
    expect(tail).toHaveLength(4)
    const many = Array.from({ length: 100 }, (_, i): RawLine => ({ dir: 'err', line: `line ${i}` }))
    const last = healTail(many)
    expect(last).toHaveLength(HEAL_TAIL_LINES)
    expect(last.at(-1)).toBe('line 99')
    expect(
      statusFrame(
        JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool', input: {} } }),
      ),
    ).toBe('{"type":"control_request","request":{"subtype":"can_use_tool"}}')
  })

  it('reads a raw log (RawLog lines) and redacts for heal', () => {
    const text = [
      JSON.stringify({ t: 1, dir: 'in', line: 'PROMPT' }),
      JSON.stringify({
        t: 2,
        dir: 'err',
        line: 'auth failed for sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      '{"t":3,"dir":"out","li',
    ].join('\n')
    const lines = parseRawLog(text)
    expect(lines.map((l) => l.dir)).toEqual(['in', 'err'])
    const tail = healTail(lines)
    expect(tail).toHaveLength(1)
    expect(tail[0]).not.toContain('sk-ant-api03-AAAA')
  })
})

describe('healViewOf', () => {
  const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
  const outcome = (actions: RecoveryAction[], o: Partial<HealOutcome> = {}): HealOutcome => ({
    status: 'ok',
    actions,
    hidden: 1,
    at: 5,
    diagnosis: 'The CLI renamed a flag.',
    confidence: 'high',
    category: 'flag_drift',
    ...o,
  })

  it("checks every suggestion again: unsafe ones are hidden and counted; ids are the step's", () => {
    const view = healViewOf(
      outcome([
        {
          id: 'a',
          label: 'Rename the flag',
          kind: 'config_patch',
          target: 'resolved',
          ops: [{ op: 'add', path: '/vendors/claude/flagMap/--permission-mode', value: '--mode' }],
          preview: 'ignored',
        },
        {
          id: 'b',
          label: 'Escalate',
          kind: 'config_patch',
          target: 'resolved',
          ops: [{ op: 'replace', path: '/passes/implement/mode', value: 'full' }],
          preview: '',
        },
        {
          id: 'c',
          label: 'Two lines',
          kind: 'shell_copy',
          command: 'a\nb',
          shell: 'sh',
          reason: '',
          recheck: '',
        },
        {
          id: 'd',
          label: 'Login',
          kind: 'shell_copy',
          command: 'claude auth login',
          shell: 'sh',
          reason: '',
          recheck: '',
        },
        {
          id: 'e',
          label: 'Settings',
          kind: 'settings_link',
          route: 'settings/vendors',
          pointer: '/vendors/claude/path',
        },
        { id: 'f', label: 'Bad link', kind: 'settings_link', route: '../etc', pointer: '' },
        { id: 'g', label: 'Close', kind: 'close_run' },
      ]),
      'auto',
      { step: 'implement', config: cfg, managedFlags: { claude: ['--permission-mode'] } },
    )
    expect(view.actions.map((a) => [a.id, a.label])).toEqual([
      ['implement:heal-1', 'Rename the flag'],
      ['implement:heal-4', 'Login'],
      ['implement:heal-5', 'Settings'],
    ])
    expect(view.actions[0]).toMatchObject({ preview: '+ vendors.claude.flagMap.--permission-mode: "--mode"' })
    expect(view.hidden).toBe(1 + 4)
    expect(hiddenSuggestionsText(view.hidden)).toBe('Dim Factory hid 5 unsafe suggestions')
    expect(hiddenSuggestionsText(1)).toBe('Dim Factory hid 1 unsafe suggestion')
    expect(hiddenSuggestionsText(0)).toBe('')
    expect(view).toMatchObject({
      status: 'ok',
      trigger: 'auto',
      at: 5,
      diagnosis: 'The CLI renamed a flag.',
      confidence: 'high',
      category: 'flag_drift',
    })
  })

  it('in a run, a fix the healer would keep (persist) is offered to this run and, as a twin, saved too', () => {
    const ops = [{ op: 'add' as const, path: '/vendors/claude/flagMap/--permission-mode', value: '--mode' }]
    const flagFix: RecoveryAction = {
      id: 'x',
      label: 'Use --mode instead of --permission-mode',
      kind: 'config_patch',
      target: 'resolved',
      ops,
      preview: '',
      persist: { scope: 'user' },
    }
    const view = healViewOf(outcome([flagFix]), 'user', {
      step: 'plan',
      config: cfg,
      managedFlags: { claude: ['--permission-mode'] },
    })
    const preview = '+ vendors.claude.flagMap.--permission-mode: "--mode"'
    expect(view.actions).toEqual([
      { ...flagFix, id: 'plan:heal-1', preview, persist: undefined },
      { ...flagFix, id: 'plan:heal-1-save', preview },
    ])
    expect('persist' in (view.actions[0] ?? {})).toBe(false)
    // Outside a run (no config) the fix stays as the healer gave it: there is no run to apply it to alone.
    const outside = healViewOf(outcome([{ ...flagFix, target: 'runOverrides' }]), 'user', { step: 'probe' })
    expect(outside.actions).toEqual([
      expect.objectContaining({ id: 'probe:heal-1', persist: { scope: 'user' }, target: 'runOverrides' }),
    ])
  })

  it('a failed heal shows the raw error and the vendor docs', () => {
    const view = healViewOf(
      outcome([], { status: 'failed', error: 'timed out after 90 s', diagnosis: '' }),
      'user',
      {
        step: 'plan',
        vendor: 'claude',
      },
    )
    expect(view).toEqual({
      status: 'failed',
      trigger: 'user',
      at: 5,
      actions: [
        {
          id: 'plan:heal-docs',
          label: 'Open the setup guide',
          kind: 'open_docs',
          url: 'https://code.claude.com/docs/en/setup',
        },
      ],
      hidden: 1,
      confidence: 'high',
      category: 'flag_drift',
      error: 'timed out after 90 s',
    })
    expect(failedHeal('auto', 9, 'Self-heal is not available in this build.', 'claude', 'fix')).toMatchObject(
      {
        status: 'failed',
        error: 'Self-heal is not available in this build.',
        actions: [{ id: 'fix:heal-docs', kind: 'open_docs' }],
      },
    )
  })
})
