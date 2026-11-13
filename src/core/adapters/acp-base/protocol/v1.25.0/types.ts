// Agent Client Protocol v1.25.0 types (for the ACP base, Gemini and Grok), hand-written from
// schema.json and schema.unstable.json in this folder (README.md: source, tag, hashes). Only the subset the ACP base
// sends, answers or reads; every type keeps the schema's names and required fields. Type-only: no runtime code.

// ---- shared ---------------------------------------------------------------------------------------------------

/** `_meta`: reserved for extensions; implementations must not assume anything about its keys. */
export type Meta = Record<string, unknown> | null

/** `ProtocolVersion` (uint16). Dim Factory speaks 1. */
export type ProtocolVersion = number

/** JSON-RPC `RequestId`. */
export type RequestId = number | string | null

/** `SessionId`. */
export type SessionId = string

/** `Implementation`: who is on the other end (`clientInfo` / `agentInfo`). */
export interface Implementation {
  name: string
  title?: string | null
  version: string
  _meta?: Meta
}

/** `Error` (JSON-RPC error object). */
export interface ErrorObject {
  code: number
  message: string
  data?: unknown
}

/**
 * `ErrorCode`: the well-known codes (any other integer is allowed). A request handler that throws a plain `Error`
 * answers -32603 "Internal error" with `data: {details: <message>}` (the TypeScript SDK's connection layer).
 */
export type KnownErrorCode = -32700 | -32600 | -32601 | -32602 | -32603 | -32800 | -32000 | -32002

// ---- initialize -----------------------------------------------------------------------------------------------

export interface FileSystemCapabilities {
  readTextFile?: boolean
  writeTextFile?: boolean
  _meta?: Meta
}

/** `ClientCapabilities`. Dim Factory keeps `fs` and `terminal` false: the agent does its own I/O. */
export interface ClientCapabilities {
  fs?: FileSystemCapabilities
  terminal?: boolean
  auth?: { terminal?: boolean; _meta?: Meta }
  session?: Record<string, unknown> | null
  elicitation?: Record<string, unknown> | null
  _meta?: Meta
}

/** `InitializeRequest` (method `initialize`, client → agent). */
export interface InitializeRequest {
  protocolVersion: ProtocolVersion
  clientCapabilities?: ClientCapabilities
  clientInfo?: Implementation | null
  _meta?: Meta
}

export interface PromptCapabilities {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
  _meta?: Meta
}

export interface McpCapabilities {
  http?: boolean
  sse?: boolean
  _meta?: Meta
}

/** A session capability that is advertised by being present (an empty object), absent or null otherwise. */
export interface PresenceCapability {
  _meta?: Meta
}

/** `SessionCapabilities`. `resume` present = `session/resume` is supported (preferred over `session/load`). */
export interface SessionCapabilities {
  list?: PresenceCapability | null
  delete?: PresenceCapability | null
  additionalDirectories?: PresenceCapability | null
  resume?: PresenceCapability | null
  close?: PresenceCapability | null
  _meta?: Meta
}

/** `AgentCapabilities`. Every field defaults to false / empty. */
export interface AgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: PromptCapabilities
  mcpCapabilities?: McpCapabilities
  sessionCapabilities?: SessionCapabilities
  auth?: Record<string, unknown>
  _meta?: Meta
}

/** `AuthMethod`: an agent method (no `type`) or a terminal one (`type: "terminal"`). Dim Factory never authenticates. */
export interface AuthMethod {
  id: string
  name: string
  description?: string | null
  type?: 'terminal'
  args?: string[]
  env?: Record<string, string>
  _meta?: Meta
}

/** `InitializeResponse`. */
export interface InitializeResponse {
  protocolVersion: ProtocolVersion
  agentCapabilities?: AgentCapabilities
  authMethods?: AuthMethod[]
  agentInfo?: Implementation | null
  _meta?: Meta
}

// ---- sessions -------------------------------------------------------------------------------------------------

/** `McpServer` (Dim Factory always sends `[]`; the agent may still load the user's own servers from its settings). */
export type McpServer = Record<string, unknown>

/** `NewSessionRequest` (`session/new`). */
export interface NewSessionRequest {
  cwd: string
  mcpServers: McpServer[]
  additionalDirectories?: string[]
  _meta?: Meta
}

export interface SessionMode {
  id: string
  name: string
  description?: string | null
  _meta?: Meta
}

/** `SessionModeState`. Gemini: default / autoEdit / yolo / plan. */
export interface SessionModeState {
  currentModeId: string
  availableModes: SessionMode[]
  _meta?: Meta
}

/**
 * Not in the pinned schema: the earlier unstable `SessionModelState` that Gemini CLI 0.62 still sends on
 * `session/new` and `session/load` (v1.25.0 moved model choice to `configOptions` with category `model`).
 */
export interface ModelInfo {
  modelId: string
  name: string
  description?: string | null
  _meta?: Meta
}

/** Not in the pinned schema (see {@link ModelInfo}). */
export interface SessionModelState {
  availableModels: ModelInfo[]
  currentModelId: string
  _meta?: Meta
}

export interface SessionConfigSelectOption {
  value: string
  name: string
  description?: string | null
  _meta?: Meta
}

/** `SessionConfigOption` (select or boolean). Grok names its model here (category `model`). */
export interface SessionConfigOption {
  id: string
  name: string
  description?: string | null
  category?: string | null
  type: 'select' | 'boolean'
  currentValue: string | boolean
  options?: SessionConfigSelectOption[] | { group: string; name: string; options: SessionConfigSelectOption[] }[]
  _meta?: Meta
}

/** `NewSessionResponse`. Persist `sessionId` before `session/prompt` (a crash can then resume it). */
export interface NewSessionResponse {
  sessionId: SessionId
  modes?: SessionModeState | null
  configOptions?: SessionConfigOption[] | null
  /** Not in the pinned schema (Gemini CLI 0.62, see {@link SessionModelState}). */
  models?: SessionModelState | null
  _meta?: Meta
}

/** `LoadSessionRequest` (`session/load`; needs `agentCapabilities.loadSession`). Replays the history as updates. */
export interface LoadSessionRequest {
  sessionId: SessionId
  cwd: string
  mcpServers: McpServer[]
  additionalDirectories?: string[]
  _meta?: Meta
}

export interface LoadSessionResponse {
  modes?: SessionModeState | null
  configOptions?: SessionConfigOption[] | null
  /** Not in the pinned schema (Gemini CLI 0.62). */
  models?: SessionModelState | null
  _meta?: Meta
}

/** `ResumeSessionRequest` (`session/resume`; needs `sessionCapabilities.resume`). Restores without a replay. */
export interface ResumeSessionRequest {
  sessionId: SessionId
  cwd: string
  mcpServers?: McpServer[]
  additionalDirectories?: string[]
  _meta?: Meta
}

export interface ResumeSessionResponse {
  modes?: SessionModeState | null
  configOptions?: SessionConfigOption[] | null
  _meta?: Meta
}

/** `SetSessionModeRequest` (`session/set_mode`). Re-sent after every new, load or resume. */
export interface SetSessionModeRequest {
  sessionId: SessionId
  modeId: string
  _meta?: Meta
}

export interface SetSessionModeResponse {
  _meta?: Meta
}

/** Not in the pinned schema: Gemini CLI 0.62's `session/set_model` (`unstable_setSessionModel`). */
export interface SetSessionModelRequest {
  sessionId: SessionId
  modelId: string
  _meta?: Meta
}

/** `SetSessionConfigOptionRequest` (`session/set_config_option`). */
export interface SetSessionConfigOptionRequest {
  sessionId: SessionId
  configId: string
  value: string | boolean
  type?: 'boolean'
  _meta?: Meta
}

// ---- content ----------------------------------------------------------------------------------------------------

export interface Annotations {
  audience?: ('assistant' | 'user')[] | null
  lastModified?: string | null
  priority?: number | null
  _meta?: Meta
}

export interface TextContent {
  type: 'text'
  text: string
  annotations?: Annotations | null
  _meta?: Meta
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
  uri?: string | null
  annotations?: Annotations | null
  _meta?: Meta
}

export interface AudioContent {
  type: 'audio'
  data: string
  mimeType: string
  annotations?: Annotations | null
  _meta?: Meta
}

export interface ResourceLink {
  type: 'resource_link'
  name: string
  uri: string
  title?: string | null
  mimeType?: string | null
  size?: number | null
  annotations?: Annotations | null
  _meta?: Meta
}

export interface EmbeddedResource {
  type: 'resource'
  resource: { uri: string; text?: string; blob?: string; mimeType?: string | null; _meta?: Meta }
  annotations?: Annotations | null
  _meta?: Meta
}

/** `ContentBlock`. Dim Factory sends text only (prompts travel over JSON-RPC, never argv). */
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource

// ---- prompt turn ------------------------------------------------------------------------------------------------

/** `PromptRequest` (`session/prompt`). */
export interface PromptRequest {
  sessionId: SessionId
  prompt: ContentBlock[]
  _meta?: Meta
}

/** `StopReason`. `refusal` and `max_turn_requests` are failures; `cancelled` follows `session/cancel`. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

/**
 * UNSTABLE `Usage` (schema.unstable.json): token usage reported with a prompt's response. `thoughtTokens` are not part
 * of `outputTokens`. Whether `inputTokens` includes `cachedReadTokens` is vendor-specific (fixture G05).
 */
export interface Usage {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens?: number | null
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
  _meta?: Meta
}

/** `PromptResponse`; `usage` is UNSTABLE (schema.unstable.json). Gemini also puts `_meta.quota`. */
export interface PromptResponse {
  stopReason: StopReason
  usage?: Usage | null
  _meta?: Meta
}

/** `CancelNotification` (`session/cancel`, a notification). */
export interface CancelNotification {
  sessionId: SessionId
  _meta?: Meta
}

// ---- session/update ---------------------------------------------------------------------------------------------

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface ToolCallLocation {
  path: string
  line?: number | null
  _meta?: Meta
}

export interface Diff {
  type: 'diff'
  path: string
  oldText?: string | null
  newText: string
  _meta?: Meta
}

/** `ToolCallContent`: a content block, a diff, or a terminal (never with `terminal: false`). */
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock; _meta?: Meta }
  | Diff
  | { type: 'terminal'; terminalId: string; _meta?: Meta }

/** `ToolCall` (`tool_call` update). */
export interface ToolCall {
  toolCallId: string
  title: string
  name?: string | null
  kind?: ToolKind
  status?: ToolCallStatus
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
  _meta?: Meta
}

/** `ToolCallUpdate` (`tool_call_update`, and the `toolCall` of a permission request). Only `toolCallId` is required. */
export interface ToolCallUpdate {
  toolCallId: string
  title?: string | null
  name?: string | null
  kind?: ToolKind | null
  status?: ToolCallStatus | null
  content?: ToolCallContent[] | null
  locations?: ToolCallLocation[] | null
  rawInput?: unknown
  rawOutput?: unknown
  _meta?: Meta
}

export interface ContentChunk {
  content: ContentBlock
  messageId?: string | null
  _meta?: Meta
}

export interface PlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
  _meta?: Meta
}

export interface AvailableCommand {
  name: string
  description: string
  input?: { hint: string; _meta?: Meta } | null
  _meta?: Meta
}

export interface Cost {
  amount: number
  currency: string
  _meta?: Meta
}

/** `UsageUpdate`: the context window (`used` tokens in context of `size`) and an optional cumulative cost. */
export interface UsageUpdate {
  used: number
  size: number
  cost?: Cost | null
  _meta?: Meta
}

/** `SessionUpdate`, tagged by `sessionUpdate`. The ACP base maps four of them; the rest are logged. */
export type SessionUpdate =
  | ({ sessionUpdate: 'user_message_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'agent_message_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'agent_thought_chunk' } & ContentChunk)
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallUpdate)
  | { sessionUpdate: 'plan'; entries: PlanEntry[]; _meta?: Meta }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[]; _meta?: Meta }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string; _meta?: Meta }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[]; _meta?: Meta }
  | { sessionUpdate: 'session_info_update'; title?: string | null; updatedAt?: string | null; _meta?: Meta }
  | ({ sessionUpdate: 'usage_update' } & UsageUpdate)
  | { sessionUpdate: 'notice'; severity: string; title: string; description?: string | null; _meta?: Meta }
  | { sessionUpdate: 'compaction_update'; compactionId: string; status: string; _meta?: Meta }
  | { sessionUpdate: 'compaction_summary_chunk'; compactionId: string; content: ContentBlock; _meta?: Meta }

export type SessionUpdateKind = SessionUpdate['sessionUpdate']

/** `SessionNotification` (`session/update`, agent → client). */
export interface SessionNotification {
  sessionId: SessionId
  update: SessionUpdate
  _meta?: Meta
}

// ---- permissions ------------------------------------------------------------------------------------------------

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

/** `PermissionOption`. Gemini optionIds: proceed_once, proceed_always, proceed_always_and_save, proceed_always_server, proceed_always_tool, cancel. */
export interface PermissionOption {
  optionId: string
  name: string
  kind: PermissionOptionKind
  _meta?: Meta
}

/** `RequestPermissionRequest` (`session/request_permission`, agent → client). */
export interface RequestPermissionRequest {
  sessionId: SessionId
  toolCall: ToolCallUpdate
  options: PermissionOption[]
  _meta?: Meta
}

/** `RequestPermissionOutcome`: `cancelled` (after `session/cancel`) or the selected option. */
export type RequestPermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string; _meta?: Meta }

/** `RequestPermissionResponse`. */
export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome
  _meta?: Meta
}
