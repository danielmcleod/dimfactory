// Outside agents' access to Dim Factory (off by default). When on, a loopback-only MCP host (host.ts) listens on a fixed
// port (so a saved client configuration keeps working) with one route, `/mcp/dim-factory`, and a bearer token kept in
// state.json on this computer. Agents may read runs and ask for new ones; a request (requests.ts) waits in Dim Factory
// until the user approves it, and approving starts the run through runs.start with its authoritative preflight.
// Answering asks and gates, stopping runs and changing settings are never offered to agents.
//
// The commands: mcp.external.get / set / codexPlugin / claudePlugin, and mcp.requests.list / approve / decline (the Dashboard's
// pending-request card). Main owns mcp.addToEditor (it knows the bridge command and opens the editor's link).
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExternalMcpSetRequest,
  ExternalMcpView,
  McpBridgeCommand,
  McpRunRequest,
  Req,
  Res,
} from '../../shared/ipc.ts'
import { DimFactoryError, errorMessage } from '../errors.ts'
import type { HandlerMap } from '../handlers.ts'
import type { HomePaths } from '../home.ts'
import type { Logger } from '../log.ts'
import { isGuarded } from '../preflight/guard.ts'
import { claudePluginPlan, installClaudePlugin } from './claude-plugin.ts'
import type { ClaudeRunner } from './claude-plugin.ts'
import { codexPluginPlan, installCodexPlugin } from './codex-plugin.ts'
import type { CodexRunner } from './codex-plugin.ts'
import { McpHost, cleanAgentName } from './host.ts'
import { MCP_ROUTE } from './instructions.ts'
import { McpRequestStore } from './requests.ts'
import { createExternalMcpStateStore } from './state.ts'
import type { ExternalMcpStateStore } from './state.ts'
import { normalizeAgentFolder, registerDimFactoryTools } from './tools.ts'
import type { CoreInvoke } from './tools.ts'

export interface ExternalMcpDeps {
  paths: HomePaths
  log: Logger
  now: () => number
  env: Readonly<Record<string, string | undefined>>
  /** The core's own command table (reads, and config.resolve for a profile check). */
  invoke: CoreInvoke
  /** runs.start (authoritative preflight, the run's creation). */
  startRun: (req: Req<'runs.start'>) => Promise<Res<'runs.start'>>
  /** The run's task from run.json, null when unreadable. */
  readTask: (runId: string) => Promise<string | null>
  /** The pending request list changed (the `mcp-requests` event). */
  emit: (pending: McpRunRequest[]) => void
  /** `Dim Factory --mcp` (null: this host has none). */
  bridge: McpBridgeCommand | null
  /** Runs the Codex CLI (null when Codex was not found). */
  runCodex: CodexRunner
  /** Runs the Claude Code CLI (null when Claude Code was not found). */
  runClaude: ClaudeRunner
}

export function newMcpToken(): string {
  return randomBytes(32).toString('base64url')
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

export class ExternalMcp {
  readonly #d: ExternalMcpDeps
  readonly #state: ExternalMcpStateStore
  readonly requests: McpRequestStore
  #host: McpHost | null = null
  #error: string | null = null
  #lastCall: number | null = null
  /** The name the last MCP handshake gave (a request without its own `requestedBy`). */
  #lastClient: string | null = null
  #approving = new Set<string>()
  #ops: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(d: ExternalMcpDeps) {
    this.#d = d
    this.#state = createExternalMcpStateStore(d.paths.state)
    this.requests = new McpRequestStore({
      file: join(d.paths.home, 'mcp-requests.json'),
      now: d.now,
      log: d.log,
      onChange: (pending) => d.emit(pending),
    })
  }

  /** One start/stop/set at a time. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#ops.then(fn, fn)
    this.#ops = p.catch(() => undefined)
    return p
  }

  /** Boot: load the requests, and listen if the user turned access on (a taken port shows in the view). */
  async start(): Promise<void> {
    await this.requests.init().catch((err: unknown) => this.#d.log.warn('mcp requests unreadable', { err }))
    await this.#serial(() => this.#listen())
  }

  async #listen(): Promise<void> {
    if (this.#closed || this.#host !== null) return
    let cfg = await this.#state.get()
    if (!cfg.enabled) return
    if (cfg.token === null) cfg = await this.#state.set({ token: newMcpToken() })
    const token = cfg.token
    if (token === null) return
    const host = new McpHost(this.#d.log, { port: cfg.port })
    try {
      await host.listen()
      host.open(MCP_ROUTE, {
        token,
        onCall: (call) => {
          this.#lastCall = this.#d.now()
          if (call.clientName !== null) this.#lastClient = call.clientName
        },
        register: (server, call) =>
          registerDimFactoryTools(
            server,
            {
              invoke: this.#d.invoke,
              readTask: this.#d.readTask,
              checkFolder: (f) => this.checkFolder(f),
              requests: this.requests,
            },
            (given) => {
              const clean = given !== undefined ? cleanAgentName(given) : ''
              return clean !== '' ? clean : (call.clientName ?? this.#lastClient ?? 'An outside agent')
            },
          ),
      })
      this.#host = host
      this.#error = null
      this.#d.log.info('outside agents can connect', { port: cfg.port })
    } catch (err) {
      await host.close().catch(() => undefined)
      const code = (err as { code?: string }).code
      this.#error =
        code === 'EADDRINUSE'
          ? `Port ${cfg.port} is in use by another program. Pick another port.`
          : code === 'EACCES'
            ? `Dim Factory may not listen on port ${cfg.port}. Pick another port.`
            : errorMessage(err)
      this.#d.log.warn('outside agent endpoint failed', { err: this.#error })
    }
  }

  async #unlisten(): Promise<void> {
    const h = this.#host
    this.#host = null
    if (h !== null) await h.close()
  }

  /** Quit: stop listening and the expiry timer. */
  async stop(): Promise<void> {
    this.#closed = true
    this.requests.dispose()
    await this.#serial(() => this.#unlisten())
  }

  async set(req: ExternalMcpSetRequest): Promise<ExternalMcpView> {
    return this.#serial(async () => {
      await this.#unlisten()
      this.#error = null
      await this.#state.set({
        ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
        ...(req.port !== undefined ? { port: req.port } : {}),
        ...(req.regenerate === true ? { token: newMcpToken() } : {}),
      })
      await this.#listen()
      return this.view()
    })
  }

  async view(): Promise<ExternalMcpView> {
    const cfg = await this.#state.get()
    const running = this.#host !== null
    return {
      enabled: cfg.enabled,
      port: cfg.port,
      running,
      url: running ? `http://127.0.0.1:${cfg.port}/mcp/${MCP_ROUTE}` : null,
      token: cfg.token,
      error: cfg.enabled ? this.#error : null,
      lastCall: this.#lastCall,
      bridge: this.#d.bridge,
    }
  }

  /**
   * A folder an agent named: absolute, an existing folder, and one the folder guard allows (never the user's home,
   * a drive root, a system folder or Dim Factory's own home). VALIDATION with the reason otherwise.
   */
  async checkFolder(folder: string): Promise<string> {
    const abs = normalizeAgentFolder(folder)
    if (!(await isDirectory(abs)))
      throw new DimFactoryError('VALIDATION', `${abs} is not an existing folder.`)
    const g = await isGuarded(abs, { owner: 'run', dimFactoryHome: this.#d.paths.home, env: this.#d.env })
    if (g.guarded) throw new DimFactoryError('VALIDATION', `Dim Factory does not run in ${abs}: ${g.detail}`)
    return abs
  }

  async approve(id: string): Promise<Res<'mcp.requests.approve'>> {
    if (this.#approving.has(id)) throw new DimFactoryError('CONFLICT', 'That request is being approved.')
    this.#approving.add(id)
    try {
      const r = await this.requests.pendingOne(id)
      // runs.start: the authoritative preflight decides; a blocked start leaves the request pending.
      const started = await this.#d.startRun({
        folder: r.folder,
        task: r.task,
        ...(r.profile !== undefined ? { overrides: { profile: r.profile } } : {}),
      })
      await this.requests.settle(id, {
        status: 'approved',
        runId: started.runId,
        displayNo: started.displayNo,
      })
      this.#d.log.info('outside agent request approved', { requestId: id, runId: started.runId })
      return started
    } finally {
      this.#approving.delete(id)
    }
  }

  async decline(id: string): Promise<void> {
    if (this.#approving.has(id)) throw new DimFactoryError('CONFLICT', 'That request is being approved.')
    await this.requests.settle(id, { status: 'declined' })
    this.#d.log.info('outside agent request declined', { requestId: id })
  }

  async codexPlugin(install: boolean): Promise<Res<'mcp.external.codexPlugin'>> {
    const bridge = this.#d.bridge
    if (bridge === null) {
      throw new DimFactoryError('UNSUPPORTED', 'The Codex plugin needs the installed Dim Factory app.')
    }
    if (!install) return codexPluginPlan(this.#d.paths.home, bridge)
    const r = await installCodexPlugin(this.#d.paths.home, bridge, this.#d.runCodex)
    this.#d.log.info('codex plugin install', { installed: r.installed, steps: r.steps.length })
    return r
  }

  async claudePlugin(install: boolean): Promise<Res<'mcp.external.claudePlugin'>> {
    const bridge = this.#d.bridge
    if (bridge === null) {
      throw new DimFactoryError('UNSUPPORTED', 'The Claude Code plugin needs the installed Dim Factory app.')
    }
    if (!install) return claudePluginPlan(this.#d.paths.home, bridge)
    const r = await installClaudePlugin(this.#d.paths.home, bridge, this.#d.runClaude)
    this.#d.log.info('claude plugin install', { installed: r.installed, steps: r.steps.length })
    return r
  }

  /** The core commands this module answers. */
  handlers(): HandlerMap {
    return {
      'mcp.external.get': () => this.view(),
      'mcp.external.set': (req) => this.set(req),
      'mcp.external.codexPlugin': (req) => this.codexPlugin(req.install),
      'mcp.external.claudePlugin': (req) => this.claudePlugin(req.install),
      'mcp.requests.list': () => this.requests.pending(),
      'mcp.requests.approve': (req) => this.approve(req.id),
      'mcp.requests.decline': (req) => this.decline(req.id),
    }
  }
}
