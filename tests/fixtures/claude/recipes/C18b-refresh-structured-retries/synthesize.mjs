// Synthesizes the catalog-refresh fixture C18b (structured-output retries exhausted) under tests/fixtures/claude/
// stdio/. It is NOT a recording: the frames are built
// from the Agent SDK types (sdk.d.ts of @anthropic-ai/claude-agent-sdk 0.3.289, the pinned
// devDependency: initialize's `jsonSchema`, the success result's `structured_output`, SDKResultError subtype
// `error_max_structured_output_retries`, TerminalReason `structured_output_retry_exhausted`) and the shapes of the
// recorded C01, C02, C05a and C16 frames. C17 and C18a were recorded live; retries exhausted
// could not be provoked cheaply (two live attempts, kept as C18c and C18d, ended with a success result without
// structured_output after one "[structured-output-enforce]" nudge), so C18b stays synthesized and its errors text is
// the SDK types' reading.
//
// The argv and the initialize `jsonSchema` come from the code (adapters/claude/launch.ts, catalog/refresh.ts), so
// when the refresh schema or flags change, run this again:
//   node tests/fixtures/claude/recipes/C18b-refresh-structured-retries/synthesize.mjs
// then `pnpm exec vitest run --project unit tests/unit/adapters/claude.normalize.test.ts -u -t "C18b"` for the
// expected.events.json snapshot. The prompt is `<REDACTED>` (the replay accepts any text): the rendered prompt
// carries the catalog of the moment.
//
// init.tools is what a logged-out 2.1.289 (and 2.1.293) reported for exactly this argv and initialize `jsonSchema` (a
// temp CLAUDE_CONFIG_DIR, no credentials; the logged-in live C17 reported the same), and every
// total_cost_usd / costUSD is the result's usage priced at the seed's Sonnet 5.5 rates (cache writes at the 1-hour
// tier, which Claude Code bills).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv } from '../../../../../src/core/adapters/claude/launch.ts'
import { catalogCostUsd } from '../../../../../src/core/catalog/cost.ts'
import { refreshJsonSchema } from '../../../../../src/core/catalog/refresh.ts'
import { officialHosts } from '../../../../../src/core/catalog/sources.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const STDIO = join(HERE, '..', '..', 'stdio')
const VENDORS = ['claude']
const MODEL = 'claude-sonnet-5-5'
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const MODELS_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview'

/** The seed's Sonnet 5.5 price: every cost below is the result's usage at this rate. */
const SEED = JSON.parse(
  readFileSync(join(HERE, '..', '..', '..', '..', '..', 'src', 'core', 'catalog', 'seed', 'pricing.seed.json'), 'utf8'),
)
const SONNET = SEED.entries.find((e) => e.vendor === 'claude' && e.model === MODEL)
if (SONNET === undefined) throw new Error(`the seed has no ${MODEL}`)
const costOf = (o) =>
  catalogCostUsd({ input: o.input, output: o.output, cacheRead: o.read, cacheWrite: o.write }, SONNET, true)

const argv = [
  'claude.exe',
  ...buildArgv({
    route: 'readonly',
    mode: 'readonly',
    step: 'catalog',
    model: 'sonnet',
    webDomains: officialHosts(VENDORS),
  }),
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
    '@anthropic-ai/claude-agent-sdk 0.3.289 sdk.d.ts (initialize jsonSchema, result structured_output, ' +
    'error_max_structured_output_retries) with the frame shapes of the recorded C01, C02, C05a and C16',
  note:
    'Synthesized while the Claude CLI was logged out; retries exhausted could not be provoked live (C18c, C18d). ' +
    'Generator: tests/fixtures/claude/recipes/C18b-refresh-structured-retries/synthesize.mjs',
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

const initialize = {
  type: 'control_request',
  request_id: 'init-1',
  request: { subtype: 'initialize', jsonSchema: refreshJsonSchema(VENDORS) },
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

const userPrompt = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '<REDACTED>' }] },
  parent_tool_use_id: null,
}

/**
 * `--tools WebSearch,WebFetch`: exactly what a logged-out 2.1.289 and 2.1.293 reported in init.tools for this argv and
 * schema; StructuredOutput comes with the initialize `jsonSchema`. Without `--tools` the same CLI
 * listed 20 tools (Workflow, Skill, EnterWorktree, CronCreate, SendMessage, Read, Glob, Grep, …).
 */
const TOOLS = ['WebFetch', 'WebSearch', 'StructuredOutput']

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
  apiKeySource: '<TOKEN>', // as the recorder redacts it
  claude_code_version: '2.1.289',
  output_style: 'default',
  agents: [],
  skills: [],
  plugins: [],
  uuid: '<REDACTED>',
})

const DONT_ASK_DENIAL =
  "Permission to use WebFetch has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* " +
  'attempt to accomplish this action using other tools that might naturally be used to accomplish this goal.'

const PAGE_TEXT =
  'Model pricing (per million tokens): Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok\n' +
  'Claude Sonnet 5.5 | $2.50 / MTok | $3.13 / MTok | $5 / MTok | $0.25 / MTok | $12.50 / MTok\n' +
  'Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok\n' +
  'Claude Fable 5.1: contact sales.'

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

function write(id, lines, failure) {
  const dir = join(STDIO, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'recording.jsonl'), `${lines.join('\n')}\n`)
  writeFileSync(join(dir, 'expected.failure.json'), `${JSON.stringify(failure)}\n`)
  console.log(`wrote ${id}`)
}

/** The common start: initialize (with the schema), the prompt, init, a web search, a denied off-list fetch. */
function opening(r, sessionId) {
  r.frame(12, 'in', initialize)
  r.frame(1500, 'out', initializeReply)
  r.frame(14, 'in', userPrompt)
  r.frame(110, 'out', init(sessionId))
  r.frame(5, 'out', { type: 'system', subtype: 'status', status: 'requesting', ...r.base })
  r.text("I'll check Anthropic's official pricing page.", { write: 24000, read: 15202, out: 18 })
  r.tool('toolu_01SynthSearch0001', 'WebSearch', { query: 'Anthropic Claude API pricing per million tokens' }, { write: 0, read: 39202, out: 24 })
  r.frame(2100, 'out', r.toolResult('toolu_01SynthSearch0001', `Web search results for query: "Anthropic Claude API pricing per million tokens"\n\nLinks: [{"title":"Pricing - Claude Docs","url":"${PRICING_URL}"},{"title":"Claude API pricing compared","url":"https://pricing-aggregator.example/anthropic"}]`))
  // An off-list host: dontAsk denies it without a prompt (WebFetch is allowed only on the official hosts).
  r.tool('toolu_01SynthFetchDenied1', 'WebFetch', { url: 'https://pricing-aggregator.example/anthropic', prompt: 'List the per-token prices' }, { write: 1200, read: 39202, out: 40 })
  r.frame(20, 'out', { type: 'system', subtype: 'permission_denied', tool_name: 'WebFetch', tool_use_id: 'toolu_01SynthFetchDenied1', decision_reason_type: 'mode', message: DONT_ASK_DENIAL, ...r.base })
  r.frame(2, 'out', r.toolResult('toolu_01SynthFetchDenied1', DONT_ASK_DENIAL, true))
  r.tool('toolu_01SynthFetchPrice1', 'WebFetch', { url: PRICING_URL, prompt: 'List the per-model prices per million tokens' }, { write: 900, read: 40402, out: 38 })
  r.frame(3200, 'out', r.toolResult('toolu_01SynthFetchPrice1', PAGE_TEXT))
}

const DENIALS = [
  {
    tool_name: 'WebFetch',
    tool_use_id: 'toolu_01SynthFetchDenied1',
    tool_input: { url: 'https://pricing-aggregator.example/anthropic', prompt: 'List the per-token prices' },
  },
]

// ---- C18b: the answer never matched the schema: error_max_structured_output_retries ------------------------------

{
  const sid = 'c4a81f06-7e2d-4b93-a5c8-19f0e3d6b2a4'
  const r = recording('C18b-refresh-structured-retries', sid)
  opening(r, sid)
  const bad = { generatedAt: 'today', entries: [{ vendor: 'anthropic', model: 'Sonnet 5.5', inputPerMTok: '$2.50' }] }
  for (let i = 1; i <= 3; i++) {
    const id = `toolu_01SynthStructBad${i}`
    r.tool(id, 'StructuredOutput', bad, { write: 300, read: 41302 + i * 900, out: 90 })
    r.frame(12, 'out', r.toolResult(id, 'Output does not match the required schema: /entries/0/vendor must be equal to one of the allowed values', true))
  }
  r.frame(220, 'out', result(sid, {
    subtype: 'error_max_structured_output_retries', ms: 11200, turns: 7,
    errors: ['Failed to provide valid structured output after 3 attempts'],
    input: 14, output: 470, read: 180110, write: 28100, searches: 1, fetches: 2,
    denials: DENIALS, terminal: 'structured_output_retry_exhausted',
  }))
  r.exit(440, 1)
  write('C18b-refresh-structured-retries', r.lines, {
    category: 'stream_malformed',
    classifiedBy: 'structured',
    rule: 'claude.result.error_max_structured_output_retries',
  })
}
