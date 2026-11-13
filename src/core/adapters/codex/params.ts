// JSON-RPC params the Codex adapter sends (handshake, threads and turns,
// approvals), typed by the generated protocol. Exported so the fixture recipes (tests/fixtures/codex/recipes/) can
// build the same frames the adapter sends.
import type { AskDecision } from '../../../shared/events.ts'
import type { Mode } from '../../../shared/run.ts'
import type { LocalPreset } from '../../../shared/vendors.ts'
import { isEffortLevel } from '../../../shared/vendors.ts'
import type { ExtensionLevel } from '../../../shared/extensions.ts'
import type { StartStep } from '../types.ts'
import { CLIENT_NAME, CLIENT_VERSION, LOCAL_PROVIDER_ID } from './capabilities.ts'
import {
  ephemeralFor,
  featuresFor,
  localProviderConfig,
  mcpOffKeys,
  noNetworkConfig,
  sandboxFor,
  webSearchFor,
} from './launch.ts'
import { APPROVAL_DECISIONS, permissionsReply as protocolPermissionsReply } from './protocol.ts'
import type {
  CollaborationMode,
  InitializeParams,
  JsonValue,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from './wire.ts'
import { rec } from './wire.ts'

export { ELICITATION_CANCEL } from './protocol.ts'

/** `initialize{clientInfo:{name:'dim-factory'}, capabilities:{experimentalApi: planNative}}`. */
export function initializeParams(experimentalApi: boolean): InitializeParams {
  return {
    clientInfo: { name: CLIENT_NAME, title: null, version: CLIENT_VERSION },
    capabilities: { experimentalApi, requestAttestation: false },
  }
}

export interface ThreadInput {
  step: StartStep
  /** Research: it may search the web (launch.ts webSearchFor). */
  web?: boolean | undefined
  mode: Mode
  cwd: string
  /** `null` / absent: the CLI's default model. A local preset always names its model. */
  model?: string | null | undefined
  local?: LocalPreset | undefined
  /** New threads only (thread/start `developerInstructions`). */
  systemAppend?: string | undefined
  /**
   * The user's MCP servers to switch off (mcp-isolation.ts; launch.ts mcpOffKeys). A name that is not a safe bare key is
   * never sent.
   */
  mcpOff?: readonly string[] | undefined
  /** The pass's Extensions level (absent: read-only steps switch `mcpOff` off, Implement and Fix keep them). */
  extensions?: ExtensionLevel | undefined
  /** Feature switches to turn off (`features.<name>`: apps, plugins, hooks); absent: the level's (launch.ts featuresFor). */
  featuresOff?: readonly string[] | undefined
  /** Plan only (continuity): a thread that is not ephemeral, so Implement can resume it (launch.ts ephemeralFor). */
  keepSession?: boolean | undefined
  /** The No network guardrail: the sandbox's network and web search off (launch.ts noNetworkConfig). */
  noNetwork?: boolean | undefined
}

function threadConfig(i: ThreadInput): Record<string, JsonValue> | undefined {
  const config: Record<string, JsonValue> = {}
  if (i.local !== undefined) Object.assign(config, localProviderConfig(i.local))
  // X17: the catalog refresh searches the web (read-only, ephemeral, config:{web_search:'live'}); so does Research
  // when it may (else its web search is off).
  const web = webSearchFor(i.step, i.web)
  if (web !== undefined) config['web_search'] = web
  if (i.noNetwork === true) Object.assign(config, noNetworkConfig())
  // Dotted keys, as `-c` spells them: `mcp_servers.<name>.enabled = false` for each of the user's servers.
  for (const key of mcpOffKeys(i.step, i.mcpOff, i.extensions)) config[key] = false
  for (const key of featuresFor(i)) config[key] = false
  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * The model a pass runs: the pass's own model when it names one, else a local preset's model, else the CLI default.
 * A model picked for a local-preset pass (the composer lists the server's models) is the one that runs.
 */
export function modelOf(i: Pick<ThreadInput, 'model' | 'local'>): string | undefined {
  if (i.model !== undefined && i.model !== null && i.model.trim() !== '') return i.model
  return i.local?.model
}

/**
 * thread/start: `{cwd, model?, sandbox, approvalPolicy, approvalsReviewer:'user', developerInstructions?, ephemeral,
 * config?}`. Read-only steps run `{sandbox:'read-only', approvalPolicy:'never', ephemeral:true}`.
 */
export function threadStartParams(i: ThreadInput): ThreadStartParams {
  const { sandbox, approvalPolicy } = sandboxFor(i.step, i.mode)
  const model = modelOf(i)
  const config = threadConfig(i)
  return {
    cwd: i.cwd,
    ...(model !== undefined ? { model } : {}),
    ...(i.local !== undefined ? { modelProvider: LOCAL_PROVIDER_ID } : {}),
    sandbox,
    approvalPolicy,
    approvalsReviewer: 'user',
    ...(i.systemAppend !== undefined && i.systemAppend !== ''
      ? { developerInstructions: i.systemAppend }
      : {}),
    ephemeral: ephemeralFor(i.step, i.keepSession),
    ...(config !== undefined ? { config } : {}),
  }
}

/**
 * thread/resume: `{threadId, excludeTurns:true, …}` with the same safety set as a start (a cold resume would
 * otherwise fall back to the thread's or the user's settings). No developerInstructions: the thread keeps its own.
 */
export function threadResumeParams(threadId: string, i: ThreadInput): ThreadResumeParams {
  const { ephemeral: _e, developerInstructions: _d, ...rest } = threadStartParams(i)
  return { threadId, excludeTurns: true, ...rest }
}

/**
 * The plan collaboration mode; the model is the one thread/start answered with (the settings require one). Its
 * settings take precedence over the turn's effort, so they carry the pass's effort too (null: the model's default).
 */
export function planCollaboration(model: string, effort?: string): CollaborationMode {
  const reasoning_effort = isEffortLevel(effort) ? effort : null
  return { mode: 'plan', settings: { model, reasoning_effort, developer_instructions: null } }
}

export function turnStartParams(o: {
  threadId: string
  prompt: string
  /**
   * Live balanced run: the model this turn runs instead of the one the thread answered with ("Override the model for
   * this turn and subsequent turns"): model/list's default, for a pass with no model whose resolved model the account
   * does not list (default-model.ts). Absent: the thread's own model.
   */
  model?: string | undefined
  /** The pass's effort level for this turn and the ones after it; absent (or not a plain level): the thread's. */
  effort?: string | undefined
  collaborationMode?: CollaborationMode | undefined
  outputSchema?: object | undefined
  /** Pictures sent with the prompt (StartOptions.images): `localImage` inputs before the text. */
  images?: readonly string[] | undefined
}): TurnStartParams {
  return {
    threadId: o.threadId,
    input: [
      ...(o.images ?? []).map((path) => ({ type: 'localImage' as const, path })),
      { type: 'text', text: o.prompt, text_elements: [] },
    ],
    ...(o.model !== undefined ? { model: o.model } : {}),
    ...(isEffortLevel(o.effort) ? { effort: o.effort } : {}),
    ...(o.collaborationMode !== undefined ? { collaborationMode: o.collaborationMode } : {}),
    ...(o.outputSchema !== undefined ? { outputSchema: strictOutputSchema(o.outputSchema) } : {}),
  }
}

/** Keywords OpenAI's strict structured outputs may refuse; Dim Factory's own parsers enforce these limits. */
const NOT_STRICT = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])

/** `prop` that may also be null (a type union, the enum widened; anything without a type through anyOf). */
function nullable(prop: unknown): unknown {
  const p = rec(prop)
  if (p === undefined) return prop
  const type = p['type']
  if (typeof type === 'string' || Array.isArray(type)) {
    const types = (Array.isArray(type) ? type : [type]) as unknown[]
    if (types.includes('null')) return p
    const out: Record<string, unknown> = { ...p, type: [...types, 'null'] }
    if (Array.isArray(p['enum']) && !(p['enum'] as unknown[]).includes(null))
      out['enum'] = [...(p['enum'] as unknown[]), null]
    return out
  }
  return { anyOf: [p, { type: 'null' }] }
}

/**
 * An outputSchema as OpenAI's strict structured outputs take it, which Codex applies to every outputSchema (live X17:
 * an optional property was refused with 400 `invalid_json_schema`, "'required' is required to include every key in
 * properties. Missing 'aliases'"). Every object lists all its properties as required and closes them; a property that
 * was optional may be null instead; the length and count limits strict mode refuses are dropped. Pure and idempotent.
 */
export function strictOutputSchema(schema: object): { [key: string]: JsonValue } {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    const n = rec(node)
    if (n === undefined) return node
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(n)) {
      if (NOT_STRICT.has(k)) continue
      if (k === 'properties' || k === '$defs' || k === 'definitions') {
        const props = rec(v)
        out[k] =
          props === undefined
            ? v
            : Object.fromEntries(Object.entries(props).map(([name, p]) => [name, walk(p)]))
      } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf' || k === 'not') {
        out[k] = walk(v)
      } else out[k] = v
    }
    const props = rec(out['properties'])
    if (props !== undefined) {
      const required = new Set(
        Array.isArray(n['required']) ? (n['required'] as unknown[]).filter((r) => typeof r === 'string') : [],
      )
      out['properties'] = Object.fromEntries(
        Object.entries(props).map(([name, p]) => [name, required.has(name) ? p : nullable(p)]),
      )
      out['required'] = Object.keys(props)
      out['additionalProperties'] = false
    }
    return out
  }
  return walk(schema) as { [key: string]: JsonValue }
}

/**
 * Approvals: allow → accept, allow-session → acceptForSession, deny → decline (the turn continues),
 * timeout/cancel → cancel (the turn is interrupted). Never `acceptWithExecpolicyAmendment`: it persists rules.
 */
export function approvalReply(d: AskDecision): {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
} {
  return { decision: APPROVAL_DECISIONS[d] }
}

/**
 * item/permissions/requestApproval: allow grants what was asked for this turn, allow-session for the session; deny
 * (and a timeout) is `{permissions:{}}`: anything left out of the grant is denied.
 */
export function permissionsReply(d: AskDecision, requested: unknown): unknown {
  const r = rec(requested) ?? {}
  return protocolPermissionsReply(d, { network: r['network'], fileSystem: r['fileSystem'] })
}
