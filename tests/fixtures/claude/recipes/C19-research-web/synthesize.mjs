// Synthesizes the Research fixture C19 (a web-enabled Research pass that answers with structured output) under
// tests/fixtures/claude/stdio/. It is NOT a recording: Research was built without live vendor calls, so the frames
// follow the recorded refresh C17 (the same confined read-only route: `dontAsk`, `--tools` as an allow list,
// CLAUDE_CODE_EVAL_CONFINED=1, the initialize `jsonSchema`, the StructuredOutput tool and `result.structured_output`)
// with Research's own tool set. The one assumption a live recording would settle: init.tools lists Read, Glob and Grep
// beside WebFetch and WebSearch for `--tools Read,Glob,Grep,WebSearch,WebFetch` (a logged-out probe of the refresh's
// argv listed exactly its `--tools` plus StructuredOutput).
//
// The argv and the initialize `jsonSchema` come from the code (adapters/claude/launch.ts, research/parse.ts), so when
// Research's schema or flags change, run this again:
//   node tests/fixtures/claude/recipes/C19-research-web/synthesize.mjs
// then `pnpm exec vitest run --project unit tests/unit/adapters/claude.normalize.test.ts -u -t "C19"` for the
// expected.events.json snapshot. The prompt is `<REDACTED>` (the replay accepts any text). Every total_cost_usd /
// costUSD is the result's usage priced at the seed's Sonnet 5.5 rates (cache writes at the 1-hour tier).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv } from '../../../../../src/core/adapters/claude/launch.ts'
import { catalogCostUsd } from '../../../../../src/core/catalog/cost.ts'
import { RESEARCH_SCHEMA } from '../../../../../src/core/research/parse.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STDIO = join(HERE, '..', '..', 'stdio')
const MODEL = 'claude-sonnet-5-5'
const SEED = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', '..', '..', 'src', 'core', 'catalog', 'seed', 'pricing.seed.json'), 'utf8'),
)
const SONNET = SEED.entries.find((e) => e.vendor === 'claude' && e.model === MODEL)
if (SONNET === undefined) throw new Error(`the seed has no ${MODEL}`)
const costOf = (o) =>
  catalogCostUsd({ input: o.input, output: o.output, cacheRead: o.read, cacheWrite: o.write }, SONNET, true)

const argv = [
  'claude.exe',
  ...buildArgv({ route: 'readonly', mode: 'readonly', step: 'research', model: 'sonnet', webOpen: true }),
]

const header = (scenario) => ({
  kind: 'header',
  schemaVersion: 1,
  vendor: 'claude',
  route: 'stdio',
  scenario,
  cliVersion: '2.1.289',
  os: 'win32',
  arch: 'x64',
  synthesized: true,
  synthesizedFrom:
    'the recorded refresh C17 (confined read-only route, initialize jsonSchema, StructuredOutput, ' +
    'result structured_output) and @anthropic-ai/claude-agent-sdk 0.3.289 sdk.d.ts',
  note:
    'Synthesized: Research was never recorded live. Generator: tests/fixtures/claude/recipes/C19-research-web/synthesize.mjs',
  argv,
  envKeys: ['CLAUDE_CODE_EVAL_CONFINED', 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS'],
  envDrop: ['^(CLAUDE|CLAUDECODE|NODE_OPTIONS)', '^ANTHROPIC_'],
  hostVersion: '0.1.0',
})

/** One recording: frames with their own clock. */
function recording(scenario, sessionId) {
  const lines = [JSON.stringify(header(scenario))]
  let t = 0
  const frame = (dt, dir, value) => {
    t += dt
    lines.push(JSON.stringify({ t, dir, line: typeof value === 'string' ? value : JSON.stringify(value) }))
  }
  const base = { session_id: sessionId, uuid: '<REDACTED>' }
  let msg = 0
  const msgId = () => `msg_01SynthM15Catalog${String(++msg).padStart(4, '0')}`
  const usage = (o) => ({
    input_tokens: 2,
    cache_creation_input_tokens: o.write,
    cache_read_input_tokens: o.read,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: o.write },
    output_tokens: o.out,
    service_tier: 'standard',
    inference_geo: 'not_available',
  })
  const assistant = (content, u) => ({
    type: 'assistant',
    message: {
      model: MODEL,
      id: msgId(),
      type: 'message',
      role: 'assistant',
      content,
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: usage(u),
      input_transformations: [],
      diagnostics: null,
      context_management: null,
    },
    parent_tool_use_id: null,
    ...base,
  })
  const stream = (event) => ({ type: 'stream_event', event, ...base, parent_tool_use_id: null })
  const toolResult = (id, content, isError = false) => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }],
    },
    parent_tool_use_id: null,
    ...base,
  })
  const text = (s, u) => {
    frame(900, 'out', stream({ type: 'message_start', message: { model: MODEL, id: `msg_stream_${msg + 1}`, type: 'message', role: 'assistant', content: [] } }))
    frame(5, 'out', stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    // Two deltas, as the CLI streams them (the normalizer takes text only from text_delta).
    const cut = Math.ceil(s.length / 2)
    frame(40, 'out', stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s.slice(0, cut) } }))
    frame(40, 'out', stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s.slice(cut) } }))
    frame(5, 'out', assistant([{ type: 'text', text: s }], u))
    frame(2, 'out', stream({ type: 'content_block_stop', index: 0 }))
  }
  const tool = (id, name, input, u) => {
    frame(600, 'out', assistant([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }], u))
    frame(2, 'out', stream({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }))
    frame(1, 'out', stream({ type: 'message_stop' }))
  }
  const exit = (dt, code) => {
    t += dt
    lines.push(JSON.stringify({ t, dir: 'exit', code, signal: null }))
  }
  return {
    frame,
    exit,
    base,
    text,
    tool,
    toolResult,
    get lines() {
      return lines
    },
  }
}

/** The C16-shaped initialize reply, trimmed to what Dim Factory reads (models; the account minus email/org). */
const initializeReply = {
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'init-1',
    response: {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5' },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
        { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
      ],
      account: {
        email: 'user@example.invalid',
        organization: '<REDACTED>',
        subscriptionType: 'Example Plan',
        apiProvider: 'firstParty',
      },
      pid: 4242,
      current_permission_mode: 'dontAsk',
    },
  },
}

const initialize = {
  type: 'control_request',
  request_id: 'init-1',
  request: { subtype: 'initialize', jsonSchema: RESEARCH_SCHEMA },
}

const userPrompt = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '<REDACTED>' }] },
  parent_tool_use_id: null,
}

/** `--tools Read,Glob,Grep,WebSearch,WebFetch`, plus StructuredOutput with the initialize `jsonSchema` (assumed). */
const TOOLS = ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'StructuredOutput']

const init = (sessionId) => ({
  type: 'system',
  subtype: 'init',
  cwd: '<CWD>',
  session_id: sessionId,
  tools: TOOLS,
  mcp_servers: [],
  model: MODEL,
  permissionMode: 'dontAsk',
  slash_commands: [],
  apiKeySource: '<TOKEN>',
  claude_code_version: '2.1.289',
  output_style: 'default',
  agents: [],
  skills: [],
  plugins: [],
  uuid: '<REDACTED>',
})

const CLIG = 'https://clig.dev/'
const PAGE_TEXT =
  'Command Line Interface Guidelines. Help: display help text when passed -h or --help. Version: print the ' +
  'version with --version; -V is common, avoid -v (it is often verbose). Output the version on stdout and exit 0.'

/** The structured answer: cited items (URLs and a repository file), one open question. */
const ANSWER = {
  summary: ['A --version flag is expected of every CLI.', 'Print to stdout and exit 0.'],
  features: [
    { feature: 'Print the version with --version', priority: 'must', sources: [CLIG] },
    { feature: 'Short -V alias', priority: 'could', sources: [CLIG] },
  ],
  standards: [{ standard: 'GNU --version output', why: 'Users and scripts parse it', sources: [CLIG] }],
  options: [
    {
      topic: 'Where the version comes from',
      options: ['package.json', 'a constant'],
      recommendation: 'package.json',
      rationale: 'One source of truth already in the repository',
      sources: ['repo:package.json'],
    },
  ],
  risks: [{ risk: 'A bundled build can print a stale version', sources: [CLIG] }],
  questions: ['Should --version also print the commit hash?'],
  sources: [{ url: CLIG, title: 'Command Line Interface Guidelines' }],
}
const result = (sessionId, o) => {
  const mu = {
    [MODEL]: {
      inputTokens: o.input,
      outputTokens: o.output,
      cacheReadInputTokens: o.read,
      cacheCreationInputTokens: o.write,
      webSearchRequests: o.searches,
      costUSD: costOf(o),
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      thinkingTokens: 0,
      canonicalModel: MODEL,
      provider: 'firstParty',
      costBasis: 'list',
    },
  }
  return {
    type: 'result',
    subtype: o.subtype,
    is_error: o.subtype !== 'success',
    duration_ms: o.ms,
    duration_api_ms: o.ms - 400,
    num_turns: o.turns,
    ...(o.subtype === 'success' ? { result: o.result } : { errors: o.errors }),
    stop_reason: o.subtype === 'success' ? 'end_turn' : 'tool_use',
    session_id: sessionId,
    total_cost_usd: costOf(o),
    usage: {
      input_tokens: o.input,
      cache_creation_input_tokens: o.write,
      cache_read_input_tokens: o.read,
      output_tokens: o.output,
      server_tool_use: { web_search_requests: o.searches, web_fetch_requests: o.fetches },
      service_tier: 'standard',
    },
    modelUsage: mu,
    permission_denials: o.denials,
    ...(o.structured !== undefined ? { structured_output: o.structured } : {}),
    terminal_reason: o.terminal,
    uuid: '<REDACTED>',
    result_index: 0,
  }
}

// ---- C19: Research searches, reads a page and a repository file, answers with structured output ---------------------

{
  const id = 'C19-research-web'
  const sid = 'd7b2e4a1-3c6f-4e8d-9a15-2f0c8b7e6d31'
  const r = recording(id, sid)
  r.frame(12, 'in', initialize)
  r.frame(1500, 'out', initializeReply)
  r.frame(14, 'in', userPrompt)
  r.frame(110, 'out', init(sid))
  r.frame(5, 'out', { type: 'system', subtype: 'status', status: 'requesting', ...r.base })
  r.text("I'll check what this repository has and what CLI conventions say.", { write: 22000, read: 15202, out: 20 })
  r.tool('toolu_01SynthResRead0001', 'Read', { file_path: '<CWD>/package.json' }, { write: 0, read: 37202, out: 22 })
  r.frame(30, 'out', r.toolResult('toolu_01SynthResRead0001', '{\n  "name": "ts-small",\n  "version": "1.0.0"\n}'))
  r.tool('toolu_01SynthResSearch01', 'WebSearch', { query: 'command line interface guidelines --version flag' }, { write: 400, read: 37602, out: 24 })
  r.frame(2100, 'out', r.toolResult('toolu_01SynthResSearch01', `Web search results for query: "command line interface guidelines --version flag"\n\nLinks: [{"title":"Command Line Interface Guidelines","url":"${CLIG}"}]`))
  r.tool('toolu_01SynthResFetch001', 'WebFetch', { url: CLIG, prompt: 'What does it say about --version?' }, { write: 600, read: 38202, out: 30 })
  r.frame(2800, 'out', r.toolResult('toolu_01SynthResFetch001', PAGE_TEXT))
  r.tool('toolu_01SynthResStruct01', 'StructuredOutput', ANSWER, { write: 300, read: 39102, out: 420 })
  r.frame(12, 'out', r.toolResult('toolu_01SynthResStruct01', 'Structured output provided successfully'))
  const answerText = JSON.stringify(ANSWER)
  r.frame(220, 'out', result(sid, {
    subtype: 'success', ms: 9800, turns: 5, result: answerText,
    input: 12, output: 516, read: 167308, write: 23300, searches: 1, fetches: 1,
    denials: [], terminal: 'completed', structured: ANSWER,
  }))
  r.exit(300, 0)
  const dir = join(STDIO, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'recording.jsonl'), `${r.lines.join('\n')}\n`)
  writeFileSync(join(dir, 'expected.failure.json'), `${JSON.stringify({ category: null })}\n`)
  console.log(`wrote ${id}`)
}
