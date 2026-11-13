// can_use_tool → ask mapping, automatic answers, user answers and "Allow for this run" rules.
import { describe, expect, it } from 'vitest'
import { AllowCache } from '@core/adapters/allow-cache.ts'
import {
  allowQuery,
  allowRuleFor,
  askDetail,
  askEvent,
  askKind,
  autoAnswerFor,
  capturePlan,
  nativeRulesFrom,
  stripAnsi,
  summarizeTool,
} from '@core/adapters/claude/asks.ts'
import {
  DENY_MESSAGE,
  PLAN_CAPTURED_MESSAGE,
  READONLY_DENY_MESSAGE,
  UNSUPPORTED_ASK_MESSAGE,
} from '@core/adapters/claude/capabilities.ts'
import { ClaudeNormalizer } from '@core/adapters/claude/normalize.ts'
import type { CanUseToolRequest, PermissionUpdate } from '@core/adapters/claude/protocol.ts'
import {
  initializeRequest,
  interruptRequest,
  sessionPermissions,
  userMessage,
} from '@core/adapters/claude/protocol.ts'

const req = (over: Partial<CanUseToolRequest> = {}): CanUseToolRequest => ({
  subtype: 'can_use_tool',
  tool_name: 'Bash',
  input: { command: 'npm --version', description: 'Print npm version' },
  description: 'Print npm version',
  tool_use_id: 'toolu_1',
  ...over,
})

const npmSuggestion: PermissionUpdate[] = [
  {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'npm --version' }],
    behavior: 'allow',
    destination: 'localSettings',
  },
]

describe('ask mapping', () => {
  it('maps tool kinds', () => {
    expect(askKind('Bash')).toBe('shell')
    expect(askKind('PowerShell')).toBe('shell')
    expect(askKind('Edit')).toBe('edit')
    expect(askKind('Write')).toBe('edit')
    expect(askKind('NotebookEdit')).toBe('edit')
    expect(askKind('WebFetch')).toBe('network')
    expect(askKind('WebSearch')).toBe('network')
    expect(askKind('mcp__db__query')).toBe('other')
  })

  it('builds the detail from title, display name, summary, reason and blocked path', () => {
    expect(askDetail(req({ display_name: 'Bash', decision_reason: 'This command requires approval' }))).toBe(
      'Bash: npm --version\nPrint npm version\nThis command requires approval',
    )
    expect(askDetail(req({ title: 'Claude wants to run npm', blocked_path: '/etc/hosts' }))).toBe(
      'Claude wants to run npm\nPrint npm version\nPath: /etc/hosts',
    )
  })

  it('strips ANSI and control characters and caps the detail at 2000 chars', () => {
    const esc = String.fromCharCode(27)
    expect(stripAnsi(`${esc}[31mred${esc}[0m\u0007 ok\tfine`)).toBe('red ok\tfine')
    const long = askDetail(req({ decision_reason: 'x'.repeat(5000) }))
    expect(long.length).toBeLessThanOrEqual(2000)
  })

  it('allowSession follows suppress_always_allow_rule and requires_user_interaction; defaultToNo follows default_to_no', () => {
    expect(askEvent('r', req(), 10)).toMatchObject({ allowSession: true, expiresAt: 10 })
    expect(askEvent('r', req({ suppress_always_allow_rule: true }), 0).allowSession).toBe(false)
    expect(askEvent('r', req({ requires_user_interaction: true }), 0).allowSession).toBe(false)
    expect(askEvent('r', req({ default_to_no: true }), 0).defaultToNo).toBe(true)
    expect(askEvent('r', req(), 0)).not.toHaveProperty('defaultToNo')
  })

  it('summarizes tool inputs', () => {
    expect(summarizeTool('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeTool('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
    expect(summarizeTool('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev')
    expect(summarizeTool('mcp__github__create_issue', {})).toBe('github: create_issue')
    expect(summarizeTool('TodoWrite', { todos: [] })).toBe('updated tasks')
    expect(summarizeTool('Bash', { command: `line1\nline2 ${'y'.repeat(300)}` })).toBe('line1')
    expect(summarizeTool('Bash', { command: 'z'.repeat(300) })).toHaveLength(120)
  })
})

describe('automatic answers (in order)', () => {
  it('captures ExitPlanMode in a plan pass and denies everything else there', () => {
    const exit = req({ tool_name: 'ExitPlanMode', input: { plan: '# P' }, requires_user_interaction: true })
    expect(autoAnswerFor(exit, { planPass: true, readOnly: false })).toEqual({ kind: 'plan-capture' })
    expect(autoAnswerFor(req(), { planPass: true, readOnly: false })).toEqual({ kind: 'readonly' })
    expect(autoAnswerFor(req(), { planPass: false, readOnly: true })).toEqual({ kind: 'readonly' })
  })

  it('denies prompts that need the vendor UI, and allows cache hits', () => {
    expect(
      autoAnswerFor(req({ requires_user_interaction: true }), { planPass: false, readOnly: false }),
    ).toEqual({
      kind: 'unsupported',
    })
    const rule = allowRuleFor(req(), npmSuggestion)!
    const cache = new AllowCache([rule])
    expect(autoAnswerFor(req(), { planPass: false, readOnly: false, cache })).toMatchObject({
      kind: 'allow-cache',
    })
    expect(
      autoAnswerFor(req({ input: { command: 'npm publish' } }), { planPass: false, readOnly: false, cache }),
    ).toBe(undefined)
  })

  it('reads the plan from input.plan, else from a plan file under <config>/plans only', () => {
    const files: Record<string, string> = { '/h/.claude/plans/p.md': '# From file' }
    const read = (p: string): string | undefined => files[p.replace(/\\/g, '/')]
    expect(capturePlan({ plan: '  # Inline  ' }, '/h/.claude/plans', read)).toBe('# Inline')
    expect(capturePlan({ planFilePath: '/h/.claude/plans/p.md' }, '/h/.claude/plans', read)).toBe(
      '# From file',
    )
    expect(capturePlan({ planFilePath: '/etc/passwd' }, '/h/.claude/plans', read)).toBeUndefined()
    expect(
      capturePlan({ planFilePath: '/h/.claude/plans/../x.md' }, '/h/.claude/plans', read),
    ).toBeUndefined()
  })
})

describe('allow-session rules', () => {
  it('rewrites every destination to session and drops setMode (C04c)', () => {
    const s: PermissionUpdate[] = [
      ...npmSuggestion,
      { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'projectSettings' },
    ]
    expect(sessionPermissions(s)).toEqual([
      { ...npmSuggestion[0], destination: 'session' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'session' },
    ])
    expect(nativeRulesFrom(s)).toEqual(['Bash(npm --version)'])
  })

  it('keeps the vendor scope when it covers the ask; prefix rules become argvPrefix', () => {
    expect(allowRuleFor(req(), npmSuggestion)).toEqual({
      vendor: 'claude',
      kind: 'shell',
      tool: 'Bash',
      match: { argv: ['npm', '--version'] },
      source: 'vendor-suggestion',
      nativeRules: ['Bash(npm --version)'],
    })
    const prefix: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm run test:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]
    const r = allowRuleFor(req({ input: { command: 'npm run test -- --watch=false' } }), prefix)
    expect(r?.match).toEqual({ argvPrefix: ['npm', 'run', 'test'] })
    expect(r?.source).toBe('vendor-suggestion')
  })

  it('falls back to an exact rule when the suggestion does not cover this ask (C03 compound command)', () => {
    const compound = req({
      tool_name: 'PowerShell',
      input: { command: 'New-Item -ItemType Directory docs; Move-Item a b' },
    })
    const s: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [
          { toolName: 'PowerShell', ruleContent: 'New-Item:*' },
          { toolName: 'PowerShell', ruleContent: 'Move-Item:*' },
        ],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ]
    const r = allowRuleFor(compound, s)
    expect(r?.source).toBe('exact')
    expect(r?.match.argv?.[0]).toBe('New-Item')
    expect(r?.nativeRules).toEqual(['PowerShell(New-Item:*)', 'PowerShell(Move-Item:*)'])
  })

  it('makes exact rules for asks without suggestions', () => {
    expect(allowRuleFor(req(), [])).toMatchObject({
      source: 'exact',
      match: { argv: ['npm', '--version'] },
      nativeRules: ['Bash(npm --version)'],
    })
    expect(allowRuleFor(req({ tool_name: 'Edit', input: { file_path: 'src/a.ts' } }), [])).toMatchObject({
      source: 'exact',
      kind: 'edit',
      match: { pathGlob: 'src/a.ts' },
    })
    expect(allowQuery(req({ tool_name: 'mcp__x__y', input: { b: 1, a: 2 } })).argv).toEqual(['{"a":2,"b":1}'])
  })
})

describe('user answers through the normalizer', () => {
  const ask = {
    type: 'control_request',
    request_id: 'r1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'npm --version' },
      tool_use_id: 't1',
      permission_suggestions: npmSuggestion,
    },
  }
  const fresh = (): ClaudeNormalizer => {
    const n = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000, now: () => 0 })
    n.line(JSON.stringify(ask))
    return n
  }

  it('allow echoes the input', () => {
    expect(fresh().answer('r1', 'allow').stdin).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r1',
          response: { behavior: 'allow', updatedInput: { command: 'npm --version' } },
        },
      },
    ])
  })

  it('allow-session adds session-scoped permissions and an allow-rule signal', () => {
    const s = fresh().answer('r1', 'allow-session')
    expect(s.stdin[0]).toMatchObject({
      response: { response: { behavior: 'allow', updatedPermissions: [{ destination: 'session' }] } },
    })
    expect(s.signals).toMatchObject([{ type: 'allow-rule', rule: { nativeRules: ['Bash(npm --version)'] } }])
  })

  it('deny continues; cancel interrupts and is classified as an ask timeout', () => {
    expect(fresh().answer('r1', 'deny').stdin).toMatchObject([
      { response: { response: { behavior: 'deny', message: DENY_MESSAGE } } },
    ])
    const n = fresh()
    expect(n.answer('r1', 'cancel').stdin).toMatchObject([
      { response: { response: { behavior: 'deny', message: DENY_MESSAGE, interrupt: true } } },
    ])
    const r = n.line(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] }),
    )
    expect(r.events).toMatchObject([{ type: 'error', category: 'ask_timeout' }])
  })

  it('auto-answers carry the recorded messages', () => {
    const plan = new ClaudeNormalizer({ route: 'plan', askTimeoutMs: 1 })
    const exit = plan.line(
      JSON.stringify({
        type: 'control_request',
        request_id: 'p1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'ExitPlanMode',
          input: { plan: '# Plan' },
          tool_use_id: 't',
        },
      }),
    )
    expect(exit.stdin).toMatchObject([
      { response: { response: { behavior: 'deny', message: PLAN_CAPTURED_MESSAGE, interrupt: true } } },
    ])
    expect(exit.signals).toEqual([
      { type: 'plan-captured', markdown: '# Plan', source: 'exitPlanMode' },
      { type: 'auto-answered', requestId: 'p1', decision: 'deny', tool: 'ExitPlanMode', why: 'plan-capture' },
    ])
    expect(exit.planCaptured).toBe(true)
    // C06: the interrupted error result still completes the plan pass.
    const done = plan.line(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
    )
    expect(done.events).toEqual([{ type: 'done', result: '# Plan' }])

    const ro = new ClaudeNormalizer({ route: 'plan', askTimeoutMs: 1 })
    expect(ro.line(JSON.stringify(ask)).stdin).toMatchObject([
      { response: { response: { message: READONLY_DENY_MESSAGE } } },
    ])
    const ui = new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1 })
    const uiStep = ui.line(
      JSON.stringify({ ...ask, request: { ...ask.request, requires_user_interaction: true } }),
    )
    expect(uiStep.stdin).toMatchObject([{ response: { response: { message: UNSUPPORTED_ASK_MESSAGE } } }])
    expect(uiStep.events).toEqual([])
  })

  it('a plan without text is refused without interrupting', () => {
    const plan = new ClaudeNormalizer({ route: 'plan', askTimeoutMs: 1, readPlanFile: () => undefined })
    const s = plan.line(
      JSON.stringify({
        type: 'control_request',
        request_id: 'p1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'ExitPlanMode',
          input: { plan: ' ' },
          tool_use_id: 't',
        },
      }),
    )
    expect(s.stdin[0]).not.toMatchObject({ response: { response: { interrupt: true } } })
    expect(plan.planCaptured).toBe(false)
  })
})

describe('stdin frames', () => {
  it('match the recorded shapes exactly', () => {
    expect(initializeRequest('init-1')).toEqual({
      type: 'control_request',
      request_id: 'init-1',
      request: { subtype: 'initialize' },
    })
    expect(initializeRequest('i', { appendSystemPrompt: 'Be brief.' }).request).toEqual({
      subtype: 'initialize',
      appendSystemPrompt: 'Be brief.',
    })
    expect(interruptRequest('stop-1')).toEqual({
      type: 'control_request',
      request_id: 'stop-1',
      request: { subtype: 'interrupt' },
    })
    expect(userMessage('hi')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    })
  })
})
