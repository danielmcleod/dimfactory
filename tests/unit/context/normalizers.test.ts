// Context signals per vendor: what each normalizer reports of the context window and its compactions, and the tool
// fingerprints and output sizes. Claude (message.usage deduped by message.id, system/status and compact_boundary,
// the result's modelUsage window, the get_context_usage answer), Codex (tokenUsage.last and modelContextWindow, the
// contextCompaction item, the deprecated thread/compacted, a sub-agent's tokens), ACP (usage_update {used, size},
// compaction_update) and Muse (per-call input). Synthesized frames in the recorded shapes; live X21 for the manual
// compaction turn the adapter never starts itself.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpNormalizer } from '@core/adapters/acp-base/normalize.ts'
import type { AcpStep } from '@core/adapters/acp-base/normalize.ts'
import { ClaudeNormalizer } from '@core/adapters/claude/normalize.ts'
import type { NormalizeStep as ClaudeStep } from '@core/adapters/claude/normalize.ts'
import { CodexNormalizer, codexToolInput, codexToolOutput } from '@core/adapters/codex/normalize.ts'
import type { NormalizeStep as CodexStep } from '@core/adapters/codex/normalize.ts'
import { canonicalJson, outputTokens, toolFingerprint } from '@core/adapters/fingerprint.ts'
import { geminiConfig } from '@core/adapters/gemini/config.ts'
import { MuseNormalizer } from '@core/adapters/muse/normalize.ts'
import type { AdapterSignal, NormalizedEvent } from '@shared/events.ts'

type Entry = NormalizedEvent | AdapterSignal
const ctxOf = (xs: readonly Entry[]): Entry[] =>
  xs.filter((e) => e.type === 'context' || e.type === 'compaction' || e.type === 'subagent-tokens')

// ---- Claude ----------------------------------------------------------------------------------------------------

const claude = (): ClaudeNormalizer =>
  new ClaudeNormalizer({ route: 'edit', askTimeoutMs: 600_000, now: () => 0 })
const cl = (n: ClaudeNormalizer, frame: Record<string, unknown>): Entry[] => {
  const s: ClaudeStep = n.line(JSON.stringify(frame))
  return [...s.signals, ...s.events]
}
const assistant = (
  id: string,
  content: unknown[],
  usage: Record<string, number>,
  parent: string | null = null,
) => ({
  type: 'assistant',
  message: { id, content, usage },
  parent_tool_use_id: parent,
})
const USAGE = { input_tokens: 10, cache_read_input_tokens: 17_943, cache_creation_input_tokens: 8_189 }

describe('Claude', () => {
  it('one request repeats its usage on each content block: counted once per message id (live C23a)', () => {
    const n = claude()
    const a = cl(n, assistant('msg_1', [{ type: 'thinking', thinking: '' }], USAGE))
    const b = cl(
      n,
      assistant('msg_1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }], USAGE),
    )
    const c = cl(
      n,
      assistant('msg_2', [{ type: 'text', text: 'ok' }], { ...USAGE, cache_read_input_tokens: 26_132 }),
    )
    expect(ctxOf([...a, ...b, ...c])).toEqual([
      { type: 'context', used: 26_142, cacheRead: 17_943, source: 'request' },
      { type: 'context', used: 34_331, cacheRead: 26_132, source: 'request' },
    ])
  })

  it("a subagent's requests and a synthetic message (no tokens) are not the main context", () => {
    const n = claude()
    expect(ctxOf(cl(n, assistant('msg_s', [], USAGE, 'toolu_agent')))).toEqual([])
    expect(ctxOf(cl(n, assistant('msg_0', [], { input_tokens: 0 })))).toEqual([])
  })

  it('status compacting starts a compaction; compact_boundary ends it with its trigger and tokens', () => {
    const n = claude()
    const out = [
      ...cl(n, { type: 'system', subtype: 'status', status: 'compacting' }),
      ...cl(n, { type: 'system', subtype: 'status', status: 'compacting' }),
      ...cl(n, { type: 'system', subtype: 'status', status: null, compact_result: 'success' }),
      ...cl(n, {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 167_210, post_tokens: 31_020, duration_ms: 9_000 },
      }),
    ]
    expect(ctxOf(out)).toEqual([
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end', trigger: 'auto', preTokens: 167_210, postTokens: 31_020 },
    ])
  })

  it('a failed compaction ("Not enough messages to compact.") ends failed, with no boundary', () => {
    const n = claude()
    cl(n, { type: 'system', subtype: 'status', status: 'compacting' })
    const out = cl(n, {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'Not enough messages to compact.',
    })
    expect(ctxOf(out)).toEqual([{ type: 'compaction', phase: 'end', failed: true }])
  })

  it("the result's modelUsage names the main model's window", () => {
    const n = claude()
    cl(n, { type: 'system', subtype: 'init', session_id: 's', model: 'claude-haiku-4-5' })
    cl(n, assistant('msg_1', [], USAGE))
    const out = cl(n, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
        'claude-sonnet-x': { inputTokens: 1, outputTokens: 1, contextWindow: 1_000_000 },
      },
    })
    expect(ctxOf(out)).toEqual([{ type: 'context', used: 26_142, window: 200_000, source: 'session' }])
  })

  it("its own get_context_usage answer: a breakdown signal and the window; another request's answer is not one", () => {
    const n = claude()
    n.expectContextUsage('ctx-1', 'start')
    const reply = (id: string) => ({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: { totalTokens: 38_436, rawMaxTokens: 200_000, mcpTools: [], memoryFiles: [], agents: [] },
      },
    })
    expect(cl(n, reply('other')).filter((e) => e.type === 'context-breakdown')).toEqual([])
    const out = cl(n, reply('ctx-1'))
    expect(out.filter((e) => e.type === 'context-breakdown')).toEqual([
      {
        type: 'context-breakdown',
        at: 'start',
        breakdown: {
          total: 38_436,
          window: 200_000,
          percent: 19,
          skills: [],
          mcp: [],
          memory: [],
          agents: [],
        },
      },
    ])
    expect(ctxOf(out)).toEqual([{ type: 'context', used: 38_436, window: 200_000, source: 'breakdown' }])
    // Answered once: the same id again is just a reply.
    expect(cl(n, reply('ctx-1')).filter((e) => e.type === 'context-breakdown')).toEqual([])
  })

  it("tool rows: a fingerprint of the call on its start, the output's size on its end; a subagent's tokens", () => {
    const n = claude()
    const start = cl(
      n,
      assistant('m', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], USAGE),
    )
    expect(start.find((e) => e.type === 'tool')).toMatchObject({
      fp: toolFingerprint('Bash', { command: 'ls' }),
    })
    const end = cl(n, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(350) }] },
      parent_tool_use_id: null,
    })
    expect(end.find((e) => e.type === 'tool')).toMatchObject({ phase: 'end', outTokens: 100 })
    cl(n, assistant('m2', [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { prompt: 'p' } }], USAGE))
    const progress = cl(n, {
      type: 'system',
      subtype: 'task_progress',
      tool_use_id: 'ag',
      usage: { total_tokens: 4_200 },
    })
    expect(ctxOf(progress)).toEqual([{ type: 'subagent-tokens', id: 'ag', tokens: 4_200 }])
  })
})

// ---- Codex -----------------------------------------------------------------------------------------------------

const codex = (): CodexNormalizer =>
  new CodexNormalizer({
    step: 'implement',
    mode: 'autoedit',
    cwd: '/w',
    planNative: false,
    resumed: false,
    askTimeoutMs: 600_000,
    allowRules: [],
    structured: false,
    loopback: false,
    now: () => 0,
  })
const cx = (n: CodexNormalizer, method: string, params: unknown): Entry[] => {
  const s: CodexStep = n.notification(method, params)
  return [...s.signals, ...s.events]
}
const tb = (total: number, input: number, cached: number) => ({
  totalTokens: total,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: total - input,
  reasoningOutputTokens: 0,
})

describe('Codex', () => {
  it('tokenUsage.last.totalTokens with modelContextWindow; after a compaction only totalTokens is set (live X22)', () => {
    const n = codex()
    cx(n, 'thread/started', { thread: { id: 't' } })
    const a = cx(n, 'thread/tokenUsage/updated', {
      threadId: 't',
      turnId: 'u',
      tokenUsage: { total: tb(13_181, 13_000, 0), last: tb(13_181, 13_000, 0), modelContextWindow: 258_400 },
    })
    const b = cx(n, 'thread/tokenUsage/updated', {
      threadId: 't',
      turnId: 'u',
      tokenUsage: {
        total: tb(13_181, 13_000, 0),
        last: { ...tb(0, 0, 0), totalTokens: 7_398 },
        modelContextWindow: 258_400,
      },
    })
    expect(ctxOf([...a, ...b])).toEqual([
      { type: 'context', used: 13_181, window: 258_400, cacheRead: 0, source: 'request' },
      { type: 'context', used: 7_398, window: 258_400, cacheRead: 0, source: 'request' },
    ])
  })

  it('contextCompaction item: started, completed (each once); the deprecated thread/compacted only without one', () => {
    const n = codex()
    const item = { type: 'contextCompaction', id: 'c1' }
    const out = [
      ...cx(n, 'item/started', { threadId: 't', turnId: 'u', item }),
      ...cx(n, 'item/started', { threadId: 't', turnId: 'u', item }),
      ...cx(n, 'item/completed', { threadId: 't', turnId: 'u', item }),
      ...cx(n, 'thread/compacted', { threadId: 't', turnId: 'u' }),
      ...cx(n, 'thread/compacted', { threadId: 't', turnId: 'u2' }),
    ]
    expect(ctxOf(out)).toEqual([
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end' },
      { type: 'compaction', phase: 'end' },
    ])
  })

  it("a sub-agent's own thread: its tokens, never the main context", () => {
    const n = codex()
    n.session('main')
    const out = cx(n, 'thread/tokenUsage/updated', {
      threadId: 'sub',
      turnId: 'v',
      tokenUsage: {
        total: tb(9_000, 8_000, 2_000),
        last: tb(9_000, 8_000, 2_000),
        modelContextWindow: 258_400,
      },
    })
    expect(ctxOf(out)).toEqual([{ type: 'subagent-tokens', id: 'subagent-sub', tokens: 9_000 }])
  })

  it('tool input for the fingerprint keeps what was asked, never ids, status or output; output sized', () => {
    const item = {
      type: 'commandExecution',
      id: 'x',
      command: 'ls',
      cwd: '/w',
      status: 'completed',
      aggregatedOutput: 'y'.repeat(700),
    }
    expect(codexToolInput(item)).toEqual({ type: 'commandExecution', command: 'ls', cwd: '/w' })
    expect(codexToolOutput(item)).toBe(200)
    expect(codexToolOutput({ type: 'commandExecution', aggregatedOutput: '' })).toBeUndefined()
  })

  it('live X21: the compaction turn Dim Factory never starts itself reads as a compaction to a resumed pass', () => {
    const file = join(process.cwd(), 'tests/fixtures/codex/app-server/X21-compact-manual/recording.jsonl')
    const frames = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { dir?: string; line?: string })
    const cut = frames.findIndex((f) => f.dir === 'in' && f.line?.includes('thread/compact/start') === true)
    expect(cut).toBeGreaterThan(0)
    const n = codex()
    const out: Entry[] = []
    for (const f of frames.slice(cut + 1)) {
      if (f.dir !== 'out' || f.line === undefined) continue
      const m = JSON.parse(f.line) as { method?: string; params?: unknown }
      if (typeof m.method === 'string') out.push(...cx(n, m.method, m.params))
    }
    expect(ctxOf(out)).toEqual([
      { type: 'compaction', phase: 'start' },
      { type: 'context', used: 4_702, window: 258_400, cacheRead: 0, source: 'request' },
      { type: 'compaction', phase: 'end' },
    ])
  })
})

// ---- ACP -------------------------------------------------------------------------------------------------------

const acp = (): AcpNormalizer =>
  new AcpNormalizer({
    vendor: 'gemini',
    displayName: 'Gemini',
    step: 'implement',
    mode: 'autoedit',
    cwd: '/w',
    planNative: false,
    resumed: false,
    askTimeoutMs: 600_000,
    allowRules: [],
    optionPrefs: geminiConfig.optionPrefs,
    usage: geminiConfig.usage,
    modeRank: geminiConfig.modeRank,
    planRoots: [],
    requestPrefix: 'h:',
    now: () => 0,
  })
const up = (n: AcpNormalizer, u: Record<string, unknown>): Entry[] => {
  const s: AcpStep = n.update({ sessionId: 'S', update: u })
  return [...s.signals, ...s.events]
}

describe('ACP', () => {
  it('usage_update {used, size}: the meter (the window is no longer dropped)', () => {
    const n = acp()
    n.session('S')
    expect(ctxOf(up(n, { sessionUpdate: 'usage_update', used: 840_000, size: 1_048_576 }))).toEqual([
      { type: 'context', used: 840_000, window: 1_048_576, source: 'session' },
    ])
  })

  it('compaction_update: in_progress starts, completed ends, failed and cancelled end failed, each once', () => {
    const n = acp()
    n.session('S')
    const out = [
      ...up(n, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }),
      ...up(n, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }),
      ...up(n, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }),
      ...up(n, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }),
      ...up(n, { sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'in_progress' }),
      ...up(n, { sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'cancelled' }),
    ]
    expect(ctxOf(out)).toEqual([
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end' },
      { type: 'compaction', phase: 'start' },
      { type: 'compaction', phase: 'end', failed: true },
    ])
  })

  it("a tool's output is sized from its content", () => {
    const n = acp()
    n.session('S')
    up(n, {
      sessionUpdate: 'tool_call',
      toolCallId: 'x',
      status: 'in_progress',
      kind: 'read',
      title: 'Read a',
    })
    const end = up(n, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'x',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'z'.repeat(70) } }],
    })
    expect(end.find((e) => e.type === 'tool')).toMatchObject({ phase: 'end', outTokens: 20 })
  })
})

// ---- Muse ------------------------------------------------------------------------------------------------------

describe('Muse', () => {
  it("each model call's input (cached reads included) is the context; Muse names no window", () => {
    const n = new MuseNormalizer({ step: 'implement', mode: 'autoedit', cwd: '/w', now: () => 0 })
    const status = (input: number, cached: number) => ({
      schema_version: 1,
      id: 'r',
      stream: { kind: 'session', id: 's' },
      sequence: 1,
      recorded_at: 1,
      record_type: 'event',
      durability: 'durable',
      causation_id: 'c',
      payload_type: 'task.lifecycle.status',
      payload_schema_version: 1,
      payload: {
        kind: 'task_lifecycle',
        task_id: 'm1',
        event: {
          kind: 'status',
          task_id: 'm1',
          details: {
            facets: [
              { usage: { input_tokens: 1, output_tokens: 1 } },
              {
                usage: {
                  input_tokens: input,
                  output_tokens: 5,
                  input_tokens_details: { cached_tokens: cached },
                },
              },
            ],
          },
        },
      },
    })
    const s = n.line(JSON.stringify(status(9_000, 4_000)))
    expect(ctxOf(s.signals)).toEqual([{ type: 'context', used: 9_000, cacheRead: 4_000, source: 'request' }])
  })
})

describe('fingerprints', () => {
  it('canonical JSON sorts keys at every level; equal calls share a fingerprint, others do not', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    )
    expect(toolFingerprint('Read', { a: 1, b: 2 })).toBe(toolFingerprint('Read', { b: 2, a: 1 }))
    expect(toolFingerprint('Read', { a: 1 })).not.toBe(toolFingerprint('Edit', { a: 1 }))
    expect(toolFingerprint('Read', { a: 1 })).toMatch(/^[0-9a-f]{12}$/)
  })
  it('output sizes: strings, text blocks, nested content; nothing for empty output', () => {
    expect(outputTokens('x'.repeat(35))).toBe(10)
    expect(outputTokens([{ type: 'text', text: 'x'.repeat(35) }])).toBe(10)
    expect(outputTokens('')).toBeUndefined()
    expect(outputTokens(undefined)).toBeUndefined()
  })
})
