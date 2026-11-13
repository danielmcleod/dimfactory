// ACP protocol table and helpers: session setup, updates,
// the permission order and decision table; JsonRpcPeer header '2.0'. Pinned to the Agent Client Protocol schema
// v1.25.0 (protocol/v1.25.0/). Pure: no Node built-ins. The wire builders are shared with tests/fixtures/gemini/recipes.
import type { AskDecision, AskKind, Usage } from '../../../shared/events.ts'
import type { ResumeKind } from '../../../shared/vendors.ts'
import type {
  CancelNotification,
  ErrorObject,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PermissionOption,
  PromptRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SetSessionModeRequest,
  SetSessionModelRequest,
  StopReason,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  Usage as AcpUsage,
} from './protocol/v1.25.0/types.ts'
import { BRAND } from '../../../shared/brand.ts'

export type * from './protocol/v1.25.0/types.ts'

/** The pinned schema release (protocol/v1.25.0/README.md). */
export const ACP_SCHEMA_VERSION = '1.25.0'
/** The committed folder under protocol/. */
export const ACP_PROTOCOL_FOLDER = 'v1.25.0'
/** The upstream tag the folder was fetched from. */
export const ACP_SCHEMA_TAG = 'schema-v1.25.0'
export const ACP_SCHEMA_SOURCE =
  'https://github.com/agentclientprotocol/agent-client-protocol/tree/schema-v1.25.0/schema/v1'
/** `initialize.protocolVersion`: the major protocol version Dim Factory speaks. */
export const ACP_PROTOCOL_VERSION = 1
/** ACP frames carry the JSON-RPC 2.0 header (JsonRpcPeer `header: '2.0'`). */
export const JSONRPC_HEADER = '2.0'

/**
 * The vendored files with their sha256: `upstream` is the release's bytes, `committed` this repository's (the two
 * em dashes of each schema written as the JSON escape —, README "The one edit"). A unit test checks both.
 */
export const ACP_SCHEMA_FILES: Readonly<Record<string, { upstream: string; committed: string }>> = {
  'schema.json': {
    upstream: '4bcd1d2051ff7ed379bd9b234fb9b09c5ab9245478698e9fab805bd9b52a33a6',
    committed: '04adc98acc3607bd153148e4fba7ce09faefa1a96c0ed9befd1937567c7abcd0',
  },
  'schema.unstable.json': {
    upstream: '5d89e96761e4312d9043ecd41d5be1ba9adc81d02c402bb774b79ef38bc32d91',
    committed: '09c298f30814afec037501e49fe0ed6e8231f5dfc7fdde15e73c73fa74301ef5',
  },
  'meta.json': {
    upstream: '061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88',
    committed: '061edb6efa8fb2aa2792459a86ec7268de5fe665bba48b2ffe7939df01481f88',
  },
  'meta.unstable.json': {
    upstream: '2c85c87aeedbd10bdac671b2f9274666e2833d38b8835decb741ca19a9d7fc5f',
    committed: '2c85c87aeedbd10bdac671b2f9274666e2833d38b8835decb741ca19a9d7fc5f',
  },
  LICENSE: {
    upstream: 'f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221',
    committed: 'f250d08cee4549b22b3b4aaaf3a743473336fd280316df5d0340717e5127a221',
  },
}

// ---- the method table -------------------------------------------------------------------------------------------

/** What an absent optional method turns off. */
export type AcpOptionalCapability = 'loadSession' | 'resumeSession' | 'setMode' | 'setModel' | 'configOptions'

export type AcpMethodRole =
  | 'required'
  | { optional: AcpOptionalCapability }
  /** Dim Factory never sends it (`authenticate`, `logout`: login stays with the user's own CLI). */
  | 'never'
  /** The agent may send it; Dim Factory answers -32601 (its client capabilities are false). */
  | 'refused'
  /** Read when it arrives (an agent cancelling its own request). */
  | 'used'

export interface AcpMethodEntry {
  method: string
  /** Who handles it, as the schema's `x-side` says: `agent` (Dim Factory sends it) or `client` (the agent sends it). */
  side: 'agent' | 'client' | 'protocol'
  kind: 'request' | 'notification'
  /** Schema definition of the params; null when the pinned schema does not have the method. */
  params: string | null
  /** Schema definition of the result (requests only); null when the pinned schema has none. */
  result?: string | null
  role: AcpMethodRole
  /** In schema.json (false: only in schema.unstable.json, or in neither). */
  stable: boolean
  note: string
}

/**
 * Every method the ACP base sends, answers or reads (required: initialize, session/new, session/prompt,
 * session/cancel, session/update, session/request_permission; optional session/load, session/resume,
 * session/set_mode, session/set_model). Other agent notifications are liveness and land in the raw log.
 */
export const ACP_METHODS: readonly AcpMethodEntry[] = [
  {
    method: 'initialize',
    side: 'agent',
    kind: 'request',
    params: 'InitializeRequest',
    result: 'InitializeResponse',
    role: 'required',
    stable: true,
    note: 'protocolVersion 1; clientCapabilities fs and terminal false; authRequired maps to auth_required',
  },
  {
    method: 'session/new',
    side: 'agent',
    kind: 'request',
    params: 'NewSessionRequest',
    result: 'NewSessionResponse',
    role: 'required',
    stable: true,
    note: '{cwd, mcpServers: []}; sessionId persisted before session/prompt; modes and models cached',
  },
  {
    method: 'session/prompt',
    side: 'agent',
    kind: 'request',
    params: 'PromptRequest',
    result: 'PromptResponse',
    role: 'required',
    stable: true,
    note: 'the prompt as one text block (never argv); the response ends the pass (stopReason, unstable usage)',
  },
  {
    method: 'session/cancel',
    side: 'agent',
    kind: 'notification',
    params: 'CancelNotification',
    role: 'required',
    stable: true,
    note: 'graceful stop and plan capture; every pending permission is then answered cancelled',
  },
  {
    method: 'session/update',
    side: 'client',
    kind: 'notification',
    params: 'SessionNotification',
    role: 'required',
    stable: true,
    note: 'agent_message_chunk, tool_call (deduped by toolCallId), tool_call_update, usage_update; the rest is logged',
  },
  {
    method: 'session/request_permission',
    side: 'client',
    kind: 'request',
    params: 'RequestPermissionRequest',
    result: 'RequestPermissionResponse',
    role: 'required',
    stable: true,
    note: 'plan exit capture, read-only reject, allow-cache allow_once, else an ask',
  },
  {
    method: 'session/load',
    side: 'agent',
    kind: 'request',
    params: 'LoadSessionRequest',
    result: 'LoadSessionResponse',
    role: { optional: 'loadSession' },
    stable: true,
    note: 'resume when session/resume is not advertised; replayed updates are dropped until 400 ms of quiet',
  },
  {
    method: 'session/resume',
    side: 'agent',
    kind: 'request',
    params: 'ResumeSessionRequest',
    result: 'ResumeSessionResponse',
    role: { optional: 'resumeSession' },
    stable: true,
    note: 'preferred when sessionCapabilities.resume is advertised; no history replay',
  },
  {
    method: 'session/set_mode',
    side: 'agent',
    kind: 'request',
    params: 'SetSessionModeRequest',
    result: 'SetSessionModeResponse',
    role: { optional: 'setMode' },
    stable: true,
    note: 're-sent after every new, load or resume (the mode comes from the launch flags, not the session)',
  },
  {
    method: 'session/set_model',
    side: 'agent',
    kind: 'request',
    params: null,
    result: null,
    role: { optional: 'setModel' },
    stable: false,
    note: 'not in the pinned schema: Gemini CLI 0.62 still serves it (unstable_setSessionModel); Gemini takes -m',
  },
  {
    method: 'session/set_config_option',
    side: 'agent',
    kind: 'request',
    params: 'SetSessionConfigOptionRequest',
    result: 'SetSessionConfigOptionResponse',
    role: { optional: 'configOptions' },
    stable: true,
    note: 'v1.25.0 model and other options (Grok names its model here)',
  },
  {
    method: 'authenticate',
    side: 'agent',
    kind: 'request',
    params: 'AuthenticateRequest',
    result: 'AuthenticateResponse',
    role: 'never',
    stable: true,
    note: 'never called: sign-in is the user running the CLI; authRequired is a snag',
  },
  {
    method: 'logout',
    side: 'agent',
    kind: 'request',
    params: 'LogoutRequest',
    result: 'LogoutResponse',
    role: 'never',
    stable: true,
    note: 'never called',
  },
  ...(
    [
      ['fs/read_text_file', 'ReadTextFileRequest'],
      ['fs/write_text_file', 'WriteTextFileRequest'],
      ['terminal/create', 'CreateTerminalRequest'],
      ['terminal/output', 'TerminalOutputRequest'],
      ['terminal/release', 'ReleaseTerminalRequest'],
      ['terminal/wait_for_exit', 'WaitForTerminalExitRequest'],
      ['terminal/kill', 'KillTerminalRequest'],
      ['elicitation/create', 'CreateElicitationRequest'],
    ] as const
  ).map(([method, params]): AcpMethodEntry => ({
    method,
    side: 'client',
    kind: 'request',
    params,
    result: null,
    role: 'refused',
    stable: true,
    note: 'client capabilities stay false; an agent that asks anyway gets -32601',
  })),
  {
    method: '$/cancel_request',
    side: 'protocol',
    kind: 'notification',
    params: 'CancelRequestNotification',
    role: 'used',
    stable: true,
    note: 'the agent withdrew one of its own requests (a pending permission becomes ask-withdrawn)',
  },
]

const isOptional = (role: AcpMethodRole): role is { optional: AcpOptionalCapability } =>
  typeof role === 'object'

export const REQUIRED_ACP_METHODS: readonly string[] = ACP_METHODS.filter((m) => m.role === 'required').map(
  (m) => m.method,
)
export const OPTIONAL_ACP_METHODS: readonly string[] = ACP_METHODS.filter((m) => isOptional(m.role)).map(
  (m) => m.method,
)
/** Methods the ACP base never sends. */
export const NEVER_SENT_METHODS: readonly string[] = ACP_METHODS.filter((m) => m.role === 'never').map(
  (m) => m.method,
)

export function acpMethod(method: string): AcpMethodEntry | undefined {
  return ACP_METHODS.find((m) => m.method === method)
}

// ---- what the agent advertised ------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The facts of an `initialize` answer the ACP base acts on (schema defaults where the agent left a field out). */
export interface AcpAgentFacts {
  protocolVersion: number | null
  loadSession: boolean
  /** `sessionCapabilities.resume` is present (an object): `session/resume` exists. */
  resumeSession: boolean
  closeSession: boolean
  listSessions: boolean
  promptImage: boolean
  authMethods: string[]
  agentName: string | null
  agentVersion: string | null
}

/** Reads an `initialize` result defensively (any shape; never throws). */
export function agentFactsOf(result: unknown): AcpAgentFacts {
  const r = isObj(result) ? result : {}
  const caps = isObj(r['agentCapabilities']) ? r['agentCapabilities'] : {}
  const session = isObj(caps['sessionCapabilities']) ? caps['sessionCapabilities'] : {}
  const prompt = isObj(caps['promptCapabilities']) ? caps['promptCapabilities'] : {}
  const info = isObj(r['agentInfo']) ? r['agentInfo'] : undefined
  const methods = Array.isArray(r['authMethods']) ? r['authMethods'] : []
  return {
    protocolVersion: typeof r['protocolVersion'] === 'number' ? r['protocolVersion'] : null,
    loadSession: caps['loadSession'] === true,
    resumeSession: isObj(session['resume']),
    closeSession: isObj(session['close']),
    listSessions: isObj(session['list']),
    promptImage: prompt['image'] === true,
    authMethods: methods.flatMap((m) => (isObj(m) && typeof m['id'] === 'string' ? [m['id']] : [])),
    agentName: str(info?.['name']) ?? null,
    agentVersion: str(info?.['version']) ?? null,
  }
}

/** The agent answered with the protocol version Dim Factory speaks (an agent answers with its latest it supports). */
export function protocolCompatible(facts: Pick<AcpAgentFacts, 'protocolVersion'>): boolean {
  return facts.protocolVersion === ACP_PROTOCOL_VERSION
}

export type AcpResumeRoute = 'resume' | 'load' | 'none'

/** `session/resume` if advertised, else `session/load`, else none. */
export function resumeRouteOf(facts: Pick<AcpAgentFacts, 'loadSession' | 'resumeSession'>): AcpResumeRoute {
  if (facts.resumeSession) return 'resume'
  return facts.loadSession ? 'load' : 'none'
}

/** The contract's `Capabilities.resume` for a resume route (`session/resume` takes the id as is). */
export function resumeKindOf(route: AcpResumeRoute): ResumeKind {
  return route === 'resume' ? 'id' : route
}

/** Whether a method can be used with this agent (optional methods by their capability, the rest always). */
export function methodAvailable(
  method: string,
  facts: Pick<AcpAgentFacts, 'loadSession' | 'resumeSession'>,
  setup?: Pick<AcpSessionSetup, 'modes' | 'models' | 'configOptions'>,
): boolean {
  const entry = acpMethod(method)
  if (entry === undefined || !isOptional(entry.role)) return entry !== undefined && entry.role !== 'never'
  switch (entry.role.optional) {
    case 'loadSession':
      return facts.loadSession
    case 'resumeSession':
      return facts.resumeSession
    case 'setMode':
      return (setup?.modes?.available.length ?? 0) > 0
    case 'setModel':
      return (setup?.models?.available.length ?? 0) > 0
    case 'configOptions':
      return (setup?.configOptions ?? 0) > 0
  }
}

export interface AcpChoice {
  id: string
  name: string
}

/** What a `session/new`, `session/load` or `session/resume` answer set up (modes, models, config options). */
export interface AcpSessionSetup {
  sessionId: string | null
  modes: { current: string | null; available: AcpChoice[] } | null
  /** Gemini CLI 0.62's `models` (not in the pinned schema). */
  models: { current: string | null; available: AcpChoice[] } | null
  /** How many config options the agent offered (v1.25.0 `configOptions`). */
  configOptions: number
}

/** Reads a session setup answer defensively. */
export function sessionSetupOf(result: unknown): AcpSessionSetup {
  const r = isObj(result) ? result : {}
  const choices = (list: unknown, idKey: string): AcpChoice[] =>
    Array.isArray(list)
      ? list.flatMap((x) =>
          isObj(x) && typeof x[idKey] === 'string'
            ? [{ id: x[idKey], name: str(x['name']) ?? x[idKey] }]
            : [],
        )
      : []
  const modes = isObj(r['modes'])
    ? {
        current: str(r['modes']['currentModeId']) ?? null,
        available: choices(r['modes']['availableModes'], 'id'),
      }
    : null
  const models = isObj(r['models'])
    ? {
        current: str(r['models']['currentModelId']) ?? null,
        available: choices(r['models']['availableModels'], 'modelId'),
      }
    : null
  return {
    sessionId: str(r['sessionId']) ?? null,
    modes,
    models,
    configOptions: Array.isArray(r['configOptions']) ? r['configOptions'].length : 0,
  }
}

/** The probe's plan check (Gemini: `plan` ∈ availableModes). */
export function hasMode(setup: Pick<AcpSessionSetup, 'modes'>, modeId: string): boolean {
  return setup.modes?.available.some((m) => m.id === modeId) ?? false
}

// ---- the wire: what the ACP base sends ------------------------------------------------------------------------------

/** Dim Factory's `clientInfo` on `initialize`. */
export const ACP_CLIENT_INFO = { name: BRAND.clientName, title: BRAND.displayName, version: '0.1.0' } as const

/** `initialize{protocolVersion:1, clientCapabilities:{fs:false, terminal:false}, clientInfo}`. */
export function initializeParams(): InitializeRequest {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { ...ACP_CLIENT_INFO },
  }
}

/** `session/new{cwd, mcpServers:[]}`. */
export function newSessionParams(cwd: string): NewSessionRequest {
  return { cwd, mcpServers: [] }
}

/** `session/load{sessionId, cwd, mcpServers:[]}` (same cwd as the session's: sessions are project-scoped). */
export function loadSessionParams(sessionId: string, cwd: string): LoadSessionRequest {
  return { sessionId, cwd, mcpServers: [] }
}

/** `session/resume{sessionId, cwd, mcpServers:[]}`. */
export function resumeSessionParams(sessionId: string, cwd: string): ResumeSessionRequest {
  return { sessionId, cwd, mcpServers: [] }
}

export function setModeParams(sessionId: string, modeId: string): SetSessionModeRequest {
  return { sessionId, modeId }
}

/** Gemini CLI 0.62's `session/set_model` (not in the pinned schema). */
export function setModelParams(sessionId: string, modelId: string): SetSessionModelRequest {
  return { sessionId, modelId }
}

/** `session/prompt{sessionId, prompt:[{type:'text', text}]}`: the prompt travels over JSON-RPC only. */
export function promptParams(sessionId: string, text: string): PromptRequest {
  return { sessionId, prompt: [{ type: 'text', text }] }
}

export function cancelParams(sessionId: string): CancelNotification {
  return { sessionId }
}

export function selectedOutcome(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } }
}

/** The answer to every pending permission after `session/cancel` (the ACP spec's rule). */
export const CANCELLED_OUTCOME: RequestPermissionResponse = Object.freeze({
  outcome: Object.freeze({ outcome: 'cancelled' as const }),
})

// ---- permissions ----------------------------------------------------------------------------------------------------

/** A vendor's option preferences (AcpVendorConfig.optionPrefs). */
export interface PermissionOptionPrefs {
  /** allow_always optionIds that are session-scoped, in order of preference. */
  allowSession: readonly string[]
  /** optionIds never chosen (they persist the grant in the vendor's config). */
  forbidden: readonly string[]
  /**
   * An option whose name matches is never chosen, whatever its kind or id (Grok: "Enable always-approve mode",
   * which would widen the whole session, may come as any kind under an id Dim Factory has not seen).
   */
  forbiddenName?: RegExp | undefined
}

/** The option may never be chosen for this vendor (its id is forbidden, or its name is). */
const isForbidden = (o: PermissionOption, prefs: PermissionOptionPrefs): boolean =>
  prefs.forbidden.includes(o.optionId) || (prefs.forbiddenName?.test(o.name) ?? false)

/** An option whose name says it outlives the session is never chosen (the decision table). */
export const PERSISTENT_OPTION_NAME = /future|all sessions|permanent/i

/**
 * The option "Allow for this run" picks: the first optionId of `prefs.allowSession` that the request offers as an
 * allow_always, is not forbidden and whose name does not say it persists. Undefined when none qualifies (the ask is
 * then raised with `allowSession: false`).
 */
export function allowSessionOption(
  options: readonly PermissionOption[],
  prefs: PermissionOptionPrefs,
): PermissionOption | undefined {
  for (const id of prefs.allowSession) {
    if (prefs.forbidden.includes(id) || ambiguous(options, id)) continue
    const o = options.find((x) => x.optionId === id)
    if (
      o !== undefined &&
      o.kind === 'allow_always' &&
      !PERSISTENT_OPTION_NAME.test(o.name) &&
      !isForbidden(o, prefs)
    )
      return o
  }
  return undefined
}

/** The ask's `allowSession` flag. */
export function canAllowSession(options: readonly PermissionOption[], prefs: PermissionOptionPrefs): boolean {
  return allowSessionOption(options, prefs) !== undefined
}

/**
 * An optionId offered more than once: the agent maps the answer back by id alone, so it could read it as the other
 * entry (another kind). Such an id is never chosen.
 */
function ambiguous(options: readonly PermissionOption[], optionId: string): boolean {
  return options.filter((o) => o.optionId === optionId).length > 1
}

/** The first option of `kind` that is not forbidden and whose id is the option's alone. */
function optionOfKind(
  options: readonly PermissionOption[],
  kind: PermissionOption['kind'],
  prefs: PermissionOptionPrefs,
): PermissionOption | undefined {
  return options.find((o) => o.kind === kind && !isForbidden(o, prefs) && !ambiguous(options, o.optionId))
}

/**
 * The reply to a permission request for a decision (the decision table): allow → allow_once; allow-session →
 * {@link allowSessionOption} (an ask raised with allowSession:false falls back to allow_once, never to another
 * allow_always); deny → reject_once (never reject_always, which may persist); cancel → `cancelled`. When the request
 * offers no option of the needed kind the answer is `cancelled`, which never allows anything.
 */
export function permissionReply(
  decision: AskDecision,
  options: readonly PermissionOption[],
  prefs: PermissionOptionPrefs,
): RequestPermissionResponse {
  const pick =
    decision === 'allow'
      ? optionOfKind(options, 'allow_once', prefs)
      : decision === 'allow-session'
        ? (allowSessionOption(options, prefs) ?? optionOfKind(options, 'allow_once', prefs))
        : decision === 'deny'
          ? optionOfKind(options, 'reject_once', prefs)
          : undefined
  return pick === undefined ? CANCELLED_OUTCOME : selectedOutcome(pick.optionId)
}

/** The reply to an automatic reject (read-only pass, plan exit): reject_once, else `cancelled`. */
export function rejectReply(
  options: readonly PermissionOption[],
  prefs: PermissionOptionPrefs,
): RequestPermissionResponse {
  return permissionReply('deny', options, prefs)
}

/** Ask kinds: edit/delete/move → edit, execute → shell, fetch → network, anything else → other. */
export const ASK_KIND_OF_TOOL: Readonly<Record<ToolKind, AskKind>> = {
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  execute: 'shell',
  fetch: 'network',
  read: 'other',
  search: 'other',
  think: 'other',
  switch_mode: 'other',
  other: 'other',
}

/** The ask kind of a tool kind (an unknown or missing kind is `other`; the wire may carry a newer kind). */
export function askKindOf(kind: string | null | undefined): AskKind {
  return typeof kind === 'string' && Object.hasOwn(ASK_KIND_OF_TOOL, kind)
    ? ASK_KIND_OF_TOOL[kind as ToolKind]
    : 'other'
}

const PLAN_EXIT_NAME = /^exit_?plan_?mode$/i
const PLAN_ENTER_NAME = /^enter_?plan_?mode$/i
const PLAN_EXIT_TITLE = /^\s*exit[ _]plan[ _]mode\b/i
const PLAN_ENTER_TITLE = /^\s*enter[ _]plan[ _]mode\b/i
/** Kinds a plan exit may carry besides `switch_mode` (a vendor that does not use ACP's own kind for it). */
const NEUTRAL_KINDS: ReadonlySet<string> = new Set(['', 'other', 'think'])

/**
 * The plan exit: a `switch_mode` tool (ACP's kind for changing modes) that does not name entering plan mode, or a
 * tool of a neutral kind (none, other, think) whose name or title names the exit, or whose title is the vendor's own
 * plan exit (`exitTitle`; Gemini's exit_plan_mode is kind `other`, titled `Requesting plan approval for: <plan file>`,
 * Only a Plan pass treats it as the plan (the permission order, rule 1). The same rule as the
 * adapter's (`permissions.ts isPlanExit`); the fixtures and the live responder use this one.
 */
export function isPlanExit(
  toolCall: Pick<ToolCallUpdate, 'kind' | 'name' | 'title'>,
  exitTitle?: RegExp,
): boolean {
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : ''
  if (kind !== 'switch_mode' && !NEUTRAL_KINDS.has(kind)) return false
  const named = (name: RegExp, title: RegExp): boolean =>
    (typeof toolCall.name === 'string' && name.test(toolCall.name.trim())) ||
    (typeof toolCall.title === 'string' && title.test(toolCall.title))
  if (named(PLAN_EXIT_NAME, PLAN_EXIT_TITLE)) return true
  if (exitTitle !== undefined && typeof toolCall.title === 'string' && exitTitle.test(toolCall.title.trim()))
    return true
  return kind === 'switch_mode' && !named(PLAN_ENTER_NAME, PLAN_ENTER_TITLE)
}

/** The text content of a tool call (each text block, joined by a blank line); null when it has none. */
export function toolCallText(toolCall: Pick<ToolCallUpdate, 'content'>): string | null {
  const parts: string[] = []
  for (const c of toolCall.content ?? []) {
    if (c.type === 'content' && c.content.type === 'text' && c.content.text.trim() !== '')
      parts.push(c.content.text)
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** A tool status that ends the tool's card (`tool_call_update` → `tool` end). */
export function isFinalToolStatus(
  status: ToolCallStatus | null | undefined,
): status is 'completed' | 'failed' {
  return status === 'completed' || status === 'failed'
}

// ---- usage ---------------------------------------------------------------------------------------------------------

/**
 * Fixture G05 (synthesized, pending live confirmation): Gemini's `inputTokens` counts the cached tokens too (the
 * Gemini API's promptTokenCount "includes the number of tokens in the cached content"; Gemini CLI 0.64's
 * buildPromptResponse sends it as inputTokens and the cached part as cachedReadTokens), so Dim Factory's uncached
 * `input` is inputTokens − cachedReadTokens. A vendor whose inputTokens excludes them sets its own value.
 */
export const CACHED_READ_IN_INPUT_DEFAULT = true

/**
 * What a report says about G05 on its own, for an agent whose `totalTokens` is the sum of every part: with cached
 * reads and a total, `totalTokens = inputTokens + outputTokens + thoughtTokens` means the cached reads are inside
 * inputTokens (true), `… + cachedReadTokens` means they are not (false). Undefined when the report cannot tell (no
 * cached reads, no total, or neither sum). Gemini's own total cannot tell: Gemini CLI 0.64 sends `totalTokens =
 * inputTokens + outputTokens` whatever the cached and thought tokens are, so for Gemini this never reads
 * false and the G05 default decides (`USAGE_INPUT_INCLUDES_CACHED`, from the API's promptTokenCount definition).
 */
export function cachedReadInInputOf(u: AcpUsage): boolean | undefined {
  const cached = u.cachedReadTokens ?? 0
  if (cached <= 0) return undefined
  const base = u.inputTokens + u.outputTokens + (u.thoughtTokens ?? 0)
  if (u.totalTokens === base) return true
  if (u.totalTokens === base + cached) return false
  return undefined
}

/**
 * Dim Factory `Usage` of an ACP PromptResponse.usage (unstable). `thoughtTokens` are reasoning, not part of
 * `outputTokens` (Gemini: candidates and thoughts are counted apart; its totalTokens is inputTokens + outputTokens).
 * Gemini reports one prompt per process, so a pass's usage is the report as is (no prior-usage subtraction; fixture
 * G09a, pending live confirmation).
 */
export function usageFromAcp(
  u: AcpUsage,
  o: { cachedReadInInput: boolean } = { cachedReadInInput: CACHED_READ_IN_INPUT_DEFAULT },
): Usage {
  const cached = u.cachedReadTokens ?? 0
  const out: Usage = {
    input: Math.max(0, o.cachedReadInInput ? u.inputTokens - cached : u.inputTokens),
    output: u.outputTokens,
  }
  if (u.cachedReadTokens !== undefined && u.cachedReadTokens !== null) out.cacheRead = u.cachedReadTokens
  if (u.cachedWriteTokens !== undefined && u.cachedWriteTokens !== null) out.cacheWrite = u.cachedWriteTokens
  if (u.thoughtTokens !== undefined && u.thoughtTokens !== null) out.reasoning = u.thoughtTokens
  return out
}

/** A PromptResponse's `usage`, when it carries one in the unstable shape. */
export function promptUsageOf(result: unknown): AcpUsage | undefined {
  const u = isObj(result) && isObj(result['usage']) ? result['usage'] : undefined
  if (u === undefined) return undefined
  const n = (k: string): number | undefined => (typeof u[k] === 'number' ? u[k] : undefined)
  const input = n('inputTokens')
  const output = n('outputTokens')
  if (input === undefined || output === undefined) return undefined
  const v: AcpUsage = {
    totalTokens: n('totalTokens') ?? input + output,
    inputTokens: input,
    outputTokens: output,
  }
  for (const k of ['thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'] as const) {
    const x = n(k)
    if (x !== undefined) v[k] = x
  }
  return v
}

/**
 * The fallback when a PromptResponse carries no usage (`usage_update` is a fallback usage source; fixture G05b):
 * the last `usage_update`'s `used` (tokens in context at the end of the turn) stands in for the input, with output
 * 0, flagged approximate (`usageApprox`). A USD `cost` becomes `costUsd`.
 */
export function usageFromContext(update: {
  used: number
  cost?: { amount: number; currency: string } | null
}): Usage {
  const out: Usage = { input: Math.max(0, update.used), output: 0 }
  if (update.cost !== undefined && update.cost !== null && update.cost.currency.toUpperCase() === 'USD')
    out.costUsd = update.cost.amount
  return out
}

// ---- stop reasons and errors -------------------------------------------------------------------------------------

export const STOP_REASONS: readonly StopReason[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]

/** Well-known ACP error codes (schema `ErrorCode`). */
export const ACP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const

/**
 * The words of an ACP error. A handler that throws a plain Error is answered -32603 "Internal error" with the text
 * in `data.details` (the TypeScript SDK; Gemini's "Invalid session identifier", quota and API errors arrive so): the
 * message and the details joined, so the classifier sees the vendor's own words.
 */
export function acpErrorText(error: Pick<ErrorObject, 'message' | 'data'>): string {
  const data = isObj(error.data) ? error.data : undefined
  const details = str(data?.['details']) ?? (typeof error.data === 'string' ? error.data : undefined)
  if (details === undefined || details.trim() === '' || details === error.message) return error.message
  return `${error.message}: ${details}`
}

export function isAuthRequired(error: Pick<ErrorObject, 'code'>): boolean {
  return error.code === ACP_ERROR.authRequired
}
