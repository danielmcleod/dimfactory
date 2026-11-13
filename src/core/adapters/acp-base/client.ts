// One ACP agent process and its JSON-RPC 2.0 peer (JsonRpcPeer with `header:'2.0'`; ACP setup:
// initialize{protocolVersion:1, clientCapabilities:{fs:false, terminal:false}, clientInfo}; Dim Factory never calls
// `authenticate`). Shared by a pass (run.ts) and the probe handshake (probe.ts). Spawned through src/core/proc only.
import { setTimeout as delay } from 'node:timers/promises'
import type { ModelInfo } from '../../../shared/vendors.ts'
import { stopChild } from '../../proc/kill.ts'
import { JsonRpcError, JsonRpcPeer, JsonRpcPeerError } from '../../proc/jsonrpc.ts'
import { spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle, SpawnLabel, TapFn } from '../../proc/spawn.ts'
import type { AcpLaunch } from './config.ts'
import { ACP_ERROR, agentFactsOf, initializeParams } from './protocol.ts'
import { M, arr, rec, str } from './wire.ts'

// `initialize` params are protocol.ts initializeParams(): the capabilities are written as `{fs:false, terminal:false}`;
// the schema's `fs` is an object (FileSystemCapabilities), so "no file system" is both of its members false. The agent
// then does its own file I/O, and Dim Factory answers every fs/* and terminal/* request -32601.

/** What Dim Factory reads from InitializeResponse (never `authMethods`: Dim Factory does not authenticate). */
export interface AgentInfo {
  protocolVersion: number | undefined
  /** `agentCapabilities.loadSession`. */
  loadSession: boolean
  /** `agentCapabilities.sessionCapabilities.resume` is present (`{}`), not omitted or null. */
  resume: boolean
}

export function readInitialize(result: unknown): AgentInfo {
  const f = agentFactsOf(result)
  return {
    protocolVersion: f.protocolVersion ?? undefined,
    loadSession: f.loadSession,
    resume: f.resumeSession,
  }
}

/** What Dim Factory caches from a session/new, session/load or session/resume answer. */
export interface SessionInfo {
  sessionId: string | undefined
  /** `modes.availableModes[].id` (undefined: the agent sent no mode state). */
  modes: string[] | undefined
  currentMode: string | undefined
  models: ModelInfo[]
}

/**
 * The models a session answer names: `models.availableModels` (the shape Gemini sends, `{modelId, name}`) or a
 * `configOptions` select of category `model` (the stable schema's form). The current one is the default.
 */
export function sessionModels(r: Record<string, unknown> | undefined): ModelInfo[] {
  const out: ModelInfo[] = []
  const add = (id: string | undefined, label: string | undefined, current: string | undefined): void => {
    if (id === undefined || id === '' || out.some((m) => m.id === id)) return
    const m: ModelInfo = { id, source: 'cli' }
    if (label !== undefined && label !== '' && label !== id) m.label = label
    if (current !== undefined && current === id) m.isDefault = true
    out.push(m)
  }
  const models = rec(r?.['models'])
  const current = str(models?.['currentModelId'])
  for (const m of arr(models?.['availableModels'])) {
    const x = rec(m)
    add(str(x?.['modelId']) ?? str(x?.['id']), str(x?.['name']), current)
  }
  for (const o of arr(r?.['configOptions'])) {
    const x = rec(o)
    if (str(x?.['category']) !== 'model' || str(x?.['type']) !== 'select') continue
    const cur = str(x?.['currentValue'])
    for (const opt of arr(x?.['options'])) {
      const v = rec(opt)
      // A flat option list, or groups of options (SessionConfigSelectOptions).
      const group = arr(v?.['options'])
      if (group.length > 0) {
        for (const g of group) add(str(rec(g)?.['value']), str(rec(g)?.['name']), cur)
      } else add(str(v?.['value']), str(v?.['name']), cur)
    }
  }
  return out
}

export function readSession(result: unknown): SessionInfo {
  const r = rec(result)
  const modes = rec(r?.['modes'])
  const ids = modes === undefined ? undefined : arr(modes['availableModes']).map((m) => str(rec(m)?.['id']))
  return {
    sessionId: str(r?.['sessionId']),
    modes: ids?.filter((x): x is string => x !== undefined && x !== ''),
    currentMode: str(modes?.['currentModeId']),
    models: sessionModels(r),
  }
}

/** ACP `authRequired` (RequestError.authRequired(): code -32000). */
export const isAuthRequired = (err: unknown): boolean =>
  err instanceof JsonRpcError && err.code === ACP_ERROR.authRequired

export const isPeerTimeout = (err: unknown): boolean =>
  err instanceof JsonRpcPeerError && err.kind === 'timeout'
export const isPeerClosed = (err: unknown): boolean =>
  err instanceof JsonRpcPeerError && err.kind === 'closed'

export interface AcpSpawn {
  launch: AcpLaunch
  cwd: string
  label: SpawnLabel
  tap?: TapFn | undefined
}

export class AcpClient {
  readonly child: ChildHandle
  readonly peer: JsonRpcPeer

  private constructor(child: ChildHandle) {
    this.child = child
    this.peer = JsonRpcPeer.fromChild(child, { header: '2.0' })
  }

  /** Spawns the agent (no shell; SpawnError on failure). The peer starts reading stdout at once. */
  static async spawn(o: AcpSpawn): Promise<AcpClient> {
    const child = await spawnChild({
      command: o.launch.exe,
      args: o.launch.args,
      cwd: o.cwd,
      env: o.launch.env,
      label: o.label,
      ...(o.tap !== undefined ? { tap: o.tap } : {}),
    })
    return new AcpClient(child)
  }

  /** `initialize`, bounded (a silent CLI has drifted). Never followed by `authenticate`. */
  async initialize(timeoutMs: number): Promise<AgentInfo> {
    const result = await this.peer.request(M.initialize, initializeParams(), { timeoutMs })
    return readInitialize(result)
  }

  /** Close stdin, wait up to `waitMs` for the exit, then kill the tree. */
  async shutdown(waitMs = 3_000): Promise<void> {
    if (this.child.exitInfo() !== null) return
    this.child.closeStdin()
    const exited = await Promise.race([
      this.child.exited.then(() => true),
      delay(waitMs, false, { ref: false }),
    ])
    if (!exited) await stopChild(this.child, { stdinWaitMs: 0 }).catch(() => undefined)
    await this.child.exited
  }
}
