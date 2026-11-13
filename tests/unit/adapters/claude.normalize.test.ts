// Claude normalizer: every recording → expected.events.json snapshot, synthesized SDK frames, and classifier
// cases from the recorded failures (C08 bogus resume, C09 auth).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyDetailed } from '@core/heal/classify.ts'
import type {
  NormalizeRecordingOptions,
  NormalizeStep,
  RecordingEntry,
} from '@core/adapters/claude/normalize.ts'
import {
  ClaudeNormalizer,
  ENV_KEY_HINT,
  USAGE_APPROX_META,
  normalizeRecording,
  routeFromArgv,
} from '@core/adapters/claude/normalize.ts'
import type { AdapterSignal, NormalizedEvent, Usage } from '@shared/events.ts'
import { apiRetry, errorResult, initFrame, keepAlive, rateLimit } from '../heal/claude-frames.ts'
import { inputFromRecording } from '../heal/fixture-input.ts'
import { FIXTURES_ROOT } from '../../live-fixtures.ts'

// tests/fixtures (synthesized), or the live recordings under DIM_FACTORY_LIVE_FIXTURES=1 (tests/live-fixtures.ts).
const STDIO = join(FIXTURES_ROOT, 'claude', 'stdio')
const ids = readdirSync(STDIO, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
const recording = (id: string): string => readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8')

/** Snapshot form: consecutive liveness signals collapse into one entry with a count. */
function snapshotEntries(entries: readonly RecordingEntry[]): unknown[] {
  const out: unknown[] = []
  let live = 0
  const flush = (): void => {
    if (live > 0) out.push({ type: 'liveness', count: live })
    live = 0
  }
  for (const e of entries) {
    if (e.type === 'liveness') {
      live++
      continue
    }
    flush()
    out.push(e)
  }
  flush()
  return out
}

describe('claude normalize: recordings', () => {
  it('finds every P0 recording', () => {
    expect(ids.length).toBeGreaterThanOrEqual(28)
  })

  it.each(ids)('%s matches expected.events.json', async (id) => {
    const entries = normalizeRecording(recording(id), optionsFor(id))
    // The whole shell command is for the guardrails (shell-command-signal.test.ts), and a recording's command is already in its tool row.
    const shown = entries.filter((e) => e.type !== 'shell-command')
    const text = `${JSON.stringify(snapshotEntries(shown), null, 2)}\n`
    await expect(text).toMatchFileSnapshot(join(STDIO, id, 'expected.events.json'))
  })

  it('C08b reports its own pass against C08a totals: result.usage tokens and the Δ cost', () => {
    const prior = c08aTotals()
    expect(prior).toMatchObject({ input: 4, output: 191, cacheRead: 41386, cacheWrite: 10119 })
    const done = normalizeRecording(recording('C08b-resume-fix'), { priorUsage: prior }).find(
      (e) => e.type === 'done',
    )
    expect(done).toMatchObject({ usage: { input: 4, output: 231, cacheRead: 51887, cacheWrite: 415 } })
    const usage = (done as { usage: { costUsd: number } }).usage
    expect(usage.costUsd).toBeCloseTo(0.0143554, 6)
  })

  it('a resumed pass without a base reports result.usage, never the session total, and flags the cost', () => {
    const entries = normalizeRecording(recording('C08b-resume-fix'))
    expect(entries.find((e) => e.type === 'done')).toMatchObject({
      usage: { input: 4, output: 231, cacheRead: 51887, cacheWrite: 415 },
    })
    expect((entries.find((e) => e.type === 'done') as { usage: object }).usage).not.toHaveProperty('costUsd')
    expect(entries).toContainEqual({
      type: 'meta',
      key: USAGE_APPROX_META,
      value: { reason: 'resumed-without-base', source: 'result.usage' },
    })
  })
})

/** C08a's cumulative totals: a fresh session, so its `done.usage` (what the engine stores as lastTotals). */
function c08aTotals(): Usage {
  const done = normalizeRecording(recording('C08a-session-id-implement')).find((e) => e.type === 'done')
  return (done as { usage: Usage }).usage
}

/** C08b resumes C08a's session; replay it with C08a's totals as the base, like the engine would. */
function optionsFor(id: string): NormalizeRecordingOptions {
  if (id === 'C08b-resume-fix') return { priorUsage: c08aTotals() }
  // C24a registered the post-compaction reminder's SessionStart hook: its callback is the adapter's to answer.
  if (id === 'C24a-compaction-reminder') return { reminderHookId: 'compaction-reminder' }
  return {}
}

const step = (n: ClaudeNormalizer, frame: unknown): NormalizeStep => n.line(JSON.stringify(frame))
const events = (s: NormalizeStep): NormalizedEvent[] => s.events
const signals = (s: NormalizeStep): AdapterSignal[] => s.signals

function editNormalizer(): ClaudeNormalizer {
  return new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 1000, now: () => 5 })
}

describe('claude normalize: synthesized frames (sdk.d.ts shapes)', () => {
  it('keep_alive and unknown frames are liveness only', () => {
    const n = editNormalizer()
    expect(signals(step(n, keepAlive))).toEqual([{ type: 'liveness' }])
    expect(events(step(n, { type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash' }))).toEqual([])
  })

  it('conversation_reset switches the session', () => {
    const n = editNormalizer()
    expect(events(step(n, initFrame))).toEqual([{ type: 'session', id: initFrame.session_id }])
    const reset = {
      type: 'conversation_reset',
      new_conversation_id: 'new-id',
      uuid: 'u',
      session_id: initFrame.session_id,
    }
    expect(events(step(n, reset))).toEqual([{ type: 'session', id: 'new-id' }])
    expect(n.sessionId()).toBe('new-id')
  })

  it('a rejected rate_limit_event classifies the error result as a quota or a rate limit', () => {
    const quota = editNormalizer()
    step(quota, rateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 }))
    const q = events(step(quota, errorResult('error_during_execution', ['limit'])))
    expect(q).toMatchObject([{ type: 'error', fatal: true, category: 'quota_exceeded' }])

    const rate = editNormalizer()
    step(rate, rateLimit({ status: 'rejected' }))
    expect(events(step(rate, errorResult('error_during_execution')))).toMatchObject([
      { type: 'error', category: 'rate_limited' },
    ])
  })

  it('an allowed rate_limit_event is liveness only', () => {
    const n = editNormalizer()
    expect(step(n, rateLimit({ status: 'allowed', rateLimitType: 'five_hour' })).signals).toEqual([
      { type: 'liveness' },
    ])
  })

  it('stops at the second authentication api_retry, not the first', () => {
    const n = editNormalizer()
    const first = step(n, apiRetry('authentication_failed', 401, 1))
    expect(first.events).toEqual([])
    expect(first.abort).toBeUndefined()
    const second = step(n, apiRetry('authentication_failed', 401, 2))
    expect(second.events).toMatchObject([{ type: 'error', fatal: true, category: 'auth_required' }])
    expect(second.abort).toBe(true)
    // The CLI's own error result afterwards is not a second terminal.
    expect(events(step(n, errorResult('error_during_execution', ['Failed to authenticate.'])))).toEqual([])
  })

  it('other api_retry frames are liveness', () => {
    const n = editNormalizer()
    expect(step(n, apiRetry('overloaded', 529, 5)).signals).toEqual([{ type: 'liveness' }])
    expect(n.terminal).toBe(false)
  })

  it('control_cancel_request withdraws a pending ask', () => {
    const n = editNormalizer()
    const ask = step(n, {
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make' }, tool_use_id: 't1' },
    })
    expect(ask.events).toMatchObject([{ type: 'ask', requestId: 'r1', kind: 'shell', expiresAt: 1005 }])
    expect(n.pendingAsks()).toEqual(['r1'])
    expect(step(n, { type: 'control_cancel_request', request_id: 'r1' }).signals).toEqual([
      { type: 'ask-withdrawn', requestId: 'r1' },
    ])
    expect(n.pendingAsks()).toEqual([])
    // An answer after the withdrawal writes nothing.
    expect(n.answer('r1', 'allow').stdin).toEqual([])
  })

  it('unknown control_request subtypes get an error reply', () => {
    const n = editNormalizer()
    const s = step(n, { type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } })
    expect(s.stdin).toEqual([
      {
        type: 'control_response',
        response: { subtype: 'error', request_id: 'h1', error: 'Unsupported by Dim Factory: hook_callback' },
      },
    ])
  })

  it('subagent frames produce no events', () => {
    const n = editNormalizer()
    const delta = {
      type: 'stream_event',
      parent_tool_use_id: 'toolu_parent',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } },
    }
    expect(events(step(n, delta))).toEqual([])
    const tool = {
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
    }
    expect(events(step(n, tool))).toEqual([])
  })

  it('text comes only from main-thread text_delta; the final message resets at tool events', () => {
    const n = editNormalizer()
    const delta = (text: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    })
    step(n, delta('before tool '))
    step(n, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'before tool ' },
          { type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    })
    step(n, {
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 't' }] },
    })
    expect(events(step(n, delta('after')))).toEqual([{ type: 'text', delta: 'after' }])
    const done = events(
      step(n, { type: 'result', subtype: 'success', is_error: false, result: 'ignored', modelUsage: {} }),
    )
    expect(done).toEqual([{ type: 'done', result: 'after' }])
  })

  it('usage is the delta against priorUsage, and an empty modelUsage is unknown', () => {
    const n = new ClaudeNormalizer({
      route: 'edit',
      resumed: true,
      priorUsage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 0.5 },
      askTimeoutMs: 1,
    })
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0.75,
      modelUsage: {
        m: {
          inputTokens: 11,
          outputTokens: 25,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 50,
          costUSD: 0.75,
        },
      },
    }
    expect(events(step(n, result))).toEqual([
      {
        type: 'done',
        result: 'ok',
        usage: { input: 1, output: 5, cacheRead: 0, cacheWrite: 10, costUsd: 0.25 },
      },
    ])
    expect(n.cumulativeUsage()).toEqual({
      input: 11,
      output: 25,
      cacheRead: 30,
      cacheWrite: 50,
      costUsd: 0.75,
    })

    const interrupted = new ClaudeNormalizer({
      route: 'edit',
      askTimeoutMs: 1,
      priorUsage: { input: 3, output: 4 },
    })
    expect(events(step(interrupted, { ...result, modelUsage: {}, total_cost_usd: 0 }))).toEqual([
      { type: 'done', result: 'ok' },
    ])
    expect(interrupted.cumulativeUsage()).toEqual({ input: 3, output: 4 })
  })

  it('an exit without a result is classified; Dim Factory kills are not', () => {
    const crashed = editNormalizer()
    expect(crashed.end({ code: 1, signal: null, ranMs: 5000 }).events).toMatchObject([
      { type: 'error', fatal: true, category: 'process_crash' },
    ])
    const stopped = editNormalizer()
    stopped.markKilled('stop')
    expect(stopped.end({ code: 1, signal: null }).events).toMatchObject([
      { type: 'error', category: 'user_cancelled' },
    ])
    const quit = editNormalizer()
    quit.markKilled('quit')
    const q = quit.end({ code: null, signal: 'SIGTERM' }).events
    expect(q).toHaveLength(1)
    expect(q[0]).not.toHaveProperty('category')
  })
})

// Composed at runtime so no secret-shaped literal lives in the repo.
const SECRET = ['sk', 'ant', 'api03', 'Qw7e'.repeat(8)].join('-')
const EMAIL = ['alice', 'corp-mail.net'].join('@')

const writeAsk = (requestId: string, toolUseId: string, content: string): unknown => ({
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    input: { file_path: 'a.env', content },
    tool_use_id: toolUseId,
  },
})
const toolUse = (id: string, name = 'Write', input: object = { file_path: 'a.env' }): unknown => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name, input }] },
})

describe('claude normalize: Dim Factory-ended turns', () => {
  it('raw never carries the result frame: no tool inputs, secrets, emails or ids, and at most 4000 chars', () => {
    const n = editNormalizer()
    const body = `KEY=${SECRET}\nowner=${EMAIL}\n${'x'.repeat(10_000)}`
    step(n, toolUse('toolu_w'))
    step(n, writeAsk('r1', 'toolu_w', body))
    n.answer('r1', 'cancel')
    const result = {
      ...errorResult('error_during_execution', ['[ede_diagnostic] interrupted']),
      uuid: 'f00dfeed-0000-4000-8000-00000000beef',
      terminal_reason: 'aborted_streaming',
      result: `final text mentioning ${EMAIL}`,
      permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_w', tool_input: { content: body } }],
    }
    const ev = events(step(n, result)).find((e) => e.type === 'error')
    expect(ev).toMatchObject({ type: 'error', category: 'ask_timeout', fatal: true })
    const raw = (ev as { raw: string }).raw
    expect(raw.length).toBeLessThanOrEqual(4000)
    for (const needle of [SECRET, EMAIL, 'f00dfeed', 'xxxxxxxxxx', 'final text', 'a.env'])
      expect(raw).not.toContain(needle)
    expect(JSON.parse(raw)).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      terminal_reason: 'aborted_streaming',
      permission_denials: ['Write'],
    })
  })

  it('a cancel says why: the ask timer is ask_timeout, a deny under denyPauses is permission_denied', () => {
    const timer = editNormalizer()
    step(timer, writeAsk('r1', 't1', 'a'))
    timer.answer('r1', 'cancel', 'ask-timeout')
    expect(timer.end({ code: 1, signal: null }).events).toMatchObject([
      { type: 'error', category: 'ask_timeout' },
    ])

    const denied = editNormalizer()
    step(denied, writeAsk('r1', 't1', 'a'))
    denied.answer('r1', 'cancel', 'denied')
    expect(denied.end({ code: 1, signal: null }).events).toMatchObject([
      { type: 'error', category: 'permission_denied', message: expect.stringMatching(/denied/) as unknown },
    ])

    // A Stop after the cancel wins; an ask cancel never replaces it.
    const stopped = editNormalizer()
    step(stopped, writeAsk('r1', 't1', 'a'))
    stopped.markKilled('stop')
    stopped.answer('r1', 'cancel', 'denied')
    expect(stopped.end({ code: 1, signal: null }).events).toMatchObject([
      { type: 'error', category: 'user_cancelled' },
    ])
  })

  it('an ask-timeout cancel reports the exact rule "Allow & resume" would add (meta lateAllowRule, P19)', () => {
    const shellAsk = (requestId: string, toolUseId: string): unknown => ({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test' },
        tool_use_id: toolUseId,
        permission_suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    })
    const timer = editNormalizer()
    step(timer, shellAsk('r1', 't1'))
    const out = timer.answer('r1', 'cancel', 'ask-timeout')
    expect(out.signals).toEqual([
      {
        type: 'meta',
        key: 'lateAllowRule',
        value: {
          requestId: 'r1',
          // Exact: the vendor's wider `npm:*` suggestion is not taken.
          rule: {
            vendor: 'claude',
            kind: 'shell',
            tool: 'Bash',
            match: { argv: ['npm', 'test'] },
            nativeRules: ['Bash(npm test)'],
            source: 'exact',
          },
        },
      },
    ])
    // A deny under denyPauses is no timeout: nothing to allow late.
    const denied = editNormalizer()
    step(denied, shellAsk('r1', 't1'))
    expect(denied.answer('r1', 'cancel', 'denied').signals).toEqual([])
  })

  it('the terminal event closes tool calls still open (C10b tree kill, auth fail-fast)', () => {
    const n = editNormalizer()
    step(n, toolUse('toolu_bash', 'Bash', { command: 'node -e "setTimeout(()=>{},60000)"' }))
    step(n, toolUse('toolu_edit', 'Edit', { file_path: 'b.ts' }))
    step(n, {
      type: 'control_request',
      request_id: 'r2',
      request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {}, tool_use_id: 'toolu_edit' },
    })
    n.answer('r2', 'deny')
    n.markKilled('stop')
    const evs = n.end({ code: 1, signal: null }).events
    expect(evs).toMatchObject([
      { type: 'tool', id: 'toolu_bash', phase: 'end', status: 'failed' },
      { type: 'tool', id: 'toolu_edit', phase: 'end', status: 'declined' },
      { type: 'error', category: 'user_cancelled' },
    ])
  })

  it('fail() ends the pass once, with open tools closed first', () => {
    const n = editNormalizer()
    step(n, toolUse('toolu_r', 'Read'))
    const s = n.fail({ category: 'flag_drift', message: 'rejected', raw: '', classifiedBy: 'structured' })
    expect(s.events).toMatchObject([
      { type: 'tool', id: 'toolu_r', status: 'failed' },
      { type: 'error', category: 'flag_drift', fatal: true },
    ])
    expect(n.terminal).toBe(true)
    expect(n.fail({ category: 'unknown', message: 'x', raw: '', classifiedBy: 'heuristic' }).events).toEqual(
      [],
    )
  })
})

describe('claude normalize: auth failures carry the env-key hint', () => {
  it('fail-fast 401 with ANTHROPIC_API_KEY on stderr (C09c) names the key and hints the unset command', () => {
    const n = editNormalizer()
    n.stderr('⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set')
    step(n, apiRetry('authentication_failed', 401, 1))
    const s = step(n, apiRetry('authentication_failed', 401, 2))
    expect(s.events).toMatchObject([
      {
        type: 'error',
        category: 'auth_required',
        message: expect.stringMatching(/^API key is invalid \(401\)/) as unknown,
      },
    ])
    expect(s.signals).toContainEqual({ type: 'meta', key: 'failureHints', value: [ENV_KEY_HINT] })
  })

  it('init apiKeySource ANTHROPIC_API_KEY is enough; an OAuth 401 gets neither the hint nor the key wording', () => {
    const key = editNormalizer()
    step(key, { ...initFrame, apiKeySource: 'ANTHROPIC_API_KEY' })
    step(key, apiRetry('authentication_failed', 401, 2))
    expect(key.terminal).toBe(true)

    const oauth = editNormalizer()
    step(oauth, { ...initFrame, apiKeySource: 'none' })
    const s = step(oauth, apiRetry('authentication_failed', 401, 2))
    expect(s.events).toMatchObject([
      { type: 'error', category: 'auth_required', message: 'Claude Code could not authenticate (401).' },
    ])
    expect(s.signals.some((x) => x.type === 'meta' && x.key === 'failureHints')).toBe(false)
  })

  it('classifier hints (claude.regex.invalid-api-key) reach the adapter as a meta signal', () => {
    const n = editNormalizer()
    const s = n.end({ code: 1, signal: null, stderrTail: ['Invalid API key · Fix external API key'] })
    expect(s.events).toMatchObject([{ type: 'error', category: 'auth_required' }])
    expect(s.signals).toEqual([{ type: 'meta', key: 'failureHints', value: [ENV_KEY_HINT] }])
  })
})

describe('claude normalize: recorded routes', () => {
  it('derives the route from the recorded argv', () => {
    expect(routeFromArgv(['-p', '--permission-mode', 'plan'])).toEqual({ route: 'plan', resumed: false })
    expect(routeFromArgv(['--permission-mode', 'dontAsk'])).toEqual({ route: 'readonly', resumed: false })
    expect(routeFromArgv(['--permission-mode', 'acceptEdits', '--resume=abc'])).toEqual({
      route: 'edit',
      resumed: true,
    })
  })
})

describe('claude classifier: recorded failures', () => {
  const classifyRec = (id: string) =>
    classifyDetailed(inputFromRecording(join(STDIO, id, 'recording.jsonl'), 'claude'))

  it.each([
    ['C08c-resume-bogus', 'resume_failed'],
    ['C08d-resume-bogus-startup-results', 'resume_failed'],
    ['C09a-logged-out-startup-results', 'auth_required'],
    ['C09b-logged-out', 'auth_required'],
    ['C09c-invalid-api-key', 'auth_required'],
  ])('%s → %s', (id, category) => {
    expect(classifyRec(id)?.failure.category).toBe(category)
  })

  it('auth failures (subtype success + is_error) classify from the assistant error field', () => {
    for (const id of ['C09a-logged-out-startup-results', 'C09b-logged-out', 'C09c-invalid-api-key']) {
      const r = classifyRec(id)
      expect(r?.failure.classifiedBy).toBe('structured')
      expect(r?.rule).toBe('claude.assistant.error.authentication_failed')
    }
  })

  it('a bogus resume classifies from the error text (C08c/C08d)', () => {
    expect(classifyRec('C08c-resume-bogus')?.rule).toBe('claude.regex.no-conversation')
  })

  it('the rejected --session-id + --resume combination has no specific rule (C08e)', () => {
    expect(classifyRec('C08e-session-id-with-resume')?.failure.category).toBe('unknown')
  })

  it('clean runs are not failures', () => {
    for (const id of ['C01-plain-text', 'C04b-ask-deny', 'C08a-session-id-implement'])
      expect(classifyRec(id)).toBeNull()
  })
})
