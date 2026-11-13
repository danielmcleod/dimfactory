// One ACP pass (session setup, updates, permissions, the decision table; kill: `session/cancel` with every pending
// permission answered `cancelled`, then stdin, then the tree; the session id from session/new is persisted before
// session/prompt).
//
// initialize (never authenticate) → session/new{cwd, mcpServers:[]} (or session/resume, else session/load with its
// replay dropped until 400 ms of quiet, 10 s cap) → onSession(id) → session/set_mode (after every new, load or
// resume) → session/prompt{prompt:[text]}. The prompt only ever travels inside session/prompt.
import { setTimeout as delay } from 'node:timers/promises'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import { newRequestId } from '../../../shared/ids.ts'
import type { Mode } from '../../../shared/run.ts'
import type { AppKill } from '../../heal/classify.ts'
import { classify, redactRaw } from '../../heal/classify.ts'
import type { EnvInput } from '../../proc/env.ts'
import { JsonRpcError } from '../../proc/jsonrpc.ts'
import type { JsonRpcPeer, RpcStreamError } from '../../proc/jsonrpc.ts'
import { stopChild } from '../../proc/kill.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { SpawnError } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { AdapterError, BufferedEmitter, classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import type {
  AskCancelReason,
  ExitInfo,
  RunHandle,
  SessionRecorded,
  StartOptions,
  StopReason,
  Unsubscribe,
} from '../types.ts'
import { META_COMPACTION_REMINDER } from '../types.ts'
import { readonlyAllowRulesCopy } from './allow-rules.ts'
import { AcpClient, isPeerClosed, isPeerTimeout, readSession } from './client.ts'
import type { AgentInfo, SessionInfo } from './client.ts'
import type { AcpFacts, AcpTiming, AcpVendorConfig } from './config.ts'
import { acpEnv, acpExtraArgsProblem, acpFlagMapProblem } from './launch.ts'
import { AcpNormalizer, isReadOnlyPass } from './normalize.ts'
import type { AcpStep } from './normalize.ts'
import { namesRedactor } from '../../extensions/redact.ts'
import { folderTrust } from './trust.ts'
import {
  ACP_PROTOCOL_VERSION,
  acpErrorText,
  cancelParams,
  loadSessionParams,
  newSessionParams,
  promptParams,
  resumeSessionParams,
  setModeParams,
} from './protocol.ts'
import { M } from './wire.ts'

export const DEFAULT_ACP_TIMING: AcpTiming = {
  // Gemini starts as `node <bundle>`: slower than a native CLI on a busy Windows machine.
  initializeMs: 30_000,
  requestMs: 60_000,
  loadQuietMs: 400,
  loadQuietCapMs: 10_000,
  stopTurnMs: 5_000,
  stopStdinMs: 2_000,
  exitAfterTerminalMs: 5_000,
  sessionPersistMs: 10_000,
  planCancelMs: 10_000,
}

export const KILL_FOR_REASON: Record<StopReason, AppKill> = {
  user: 'stop',
  timeout: 'hard',
  shutdown: 'quit',
  loop: 'loop',
}

export type SpawnHook = (
  o: StartOptions,
  child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
) => void | Promise<void>

export interface AcpRunDeps {
  config: AcpVendorConfig
  /** The CLI to spawn; rejects with an AdapterError (cli_missing, …) when there is none. */
  resolve(): Promise<ResolvedCli>
  baseEnv: EnvInput
  pathEnv(): Promise<string | undefined>
  /** `vendors.<id>.env` (user config); StartOptions.env is layered on top. */
  vendorEnv?: Record<string, string> | undefined
  now: () => number
  /** What the launch probe found (modes, load/resume), frozen at start. */
  facts: AcpFacts
  /** DIM_FACTORY_HOME: its working folders are Dim Factory-owned (no trust grant needed). */
  dimFactoryHome: string
  /** The user's home folder (the read-only allow-rules scan reads the user-level settings under it). */
  home?: string | undefined
  /** An extra trust.json lookup (StartOptions.trustFolder is the engine's answer for the run's folder). */
  folderGranted?: ((cwd: string, vendor: string) => Promise<boolean>) | undefined
  /** Folders a plan exit's plan file may be read from. */
  planRoots: readonly string[]
  timing: AcpTiming
  onSpawn?: SpawnHook | undefined
  /**
   * A session/new, session/load or session/resume answer (the modes and models are cached): the adapter keeps
   * the modes and models it names for support() and listModels().
   */
  onSessionSetup?: ((info: SessionInfo) => void) | undefined
}

/** The mode a pass runs in: read-only steps (and `readonly` mode) read-only, else the pass's own mode. */
export function effectiveMode(step: StartOptions['step'], mode: Mode): Mode {
  return isReadOnlyPass(step, mode) ? 'readonly' : mode
}

/**
 * The `session/set_mode` id a pass needs: the native plan mode for a native Plan pass, else its mode's id.
 * `undefined` when the vendor has none for it (its default stands).
 */
export function targetModeOf(
  config: AcpVendorConfig,
  o: Pick<StartOptions, 'step' | 'mode'>,
  planNative: boolean,
): string | undefined {
  if (planNative && config.plan !== undefined) return config.plan.acpMode
  return config.modes[effectiveMode(o.step, o.mode)].acpMode ?? undefined
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A JSON-RPC error's words, the vendor's `data.details` included (protocol.ts acpErrorText). */
const rpcText = (err: JsonRpcError): string => acpErrorText({ message: err.message, data: err.data })

/** A model name Dim Factory passes in argv: no leading dash (it would read as a flag), no spaces or control chars. */
export const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/

export class AcpRun implements RunHandle {
  readonly id: string
  readonly vendor: string
  readonly route = 'acp' as const
  readonly exited: Promise<ExitInfo>
  /** The argv after the executable (set once the launch is built). */
  argv: string[] = []
  /** The Plan pass runs the vendor's native plan mode (planNative asked, the vendor has it). */
  readonly planNative: boolean

  readonly #o: StartOptions
  /** Hides the allowed MCP servers' names in the argv Dim Factory records. */
  #redactArgv: (text: string) => string = (t) => t
  readonly #d: AcpRunDeps
  readonly #cfg: AcpVendorConfig
  readonly #n: AcpNormalizer
  readonly #events = new BufferedEmitter<NormalizedEvent>()
  readonly #signals = new BufferedEmitter<AdapterSignal>()
  readonly #startedAt: number
  /** The session a load or resume continues (undefined: a new session). */
  readonly #resumeId: string | undefined
  #client: AcpClient | undefined
  #sessionId: string | undefined
  #stoppedBy: StopReason | undefined
  #stopping: Promise<void> | undefined
  #finished = false
  #preSpawnTerminal = false
  #cancelSent = false
  #promptSent = false
  #stdinClosed = false
  #lastUpdate = 0
  #terminalWaiters: (() => void)[] = []
  #exitTimer: NodeJS.Timeout | undefined
  #planTimer: NodeJS.Timeout | undefined
  #resolveExited: (e: ExitInfo) => void = () => undefined

  constructor(o: StartOptions, deps: AcpRunDeps) {
    this.#o = o
    this.#d = deps
    this.#cfg = deps.config
    this.vendor = deps.config.id
    this.id = newRequestId(deps.config.id)
    this.#startedAt = deps.now()
    this.#resumeId = o.resume?.sessionId
    this.planNative =
      o.step === 'plan' && o.planNative && deps.config.planMode === 'native' && deps.config.plan !== undefined
    this.#n = new AcpNormalizer({
      vendor: deps.config.id,
      displayName: deps.config.displayName,
      step: o.step,
      mode: effectiveMode(o.step, o.mode),
      cwd: o.cwd,
      planNative: this.planNative,
      resumed: this.#resumeId !== undefined,
      ...(this.#resumeId !== undefined && o.resume?.priorUsage !== undefined
        ? { priorUsage: o.resume.priorUsage }
        : {}),
      askTimeoutMs: o.askTimeoutMs,
      allowRules: o.allowRules,
      ...(o.permit !== undefined ? { permit: o.permit } : {}),
      optionPrefs: deps.config.optionPrefs,
      usage: deps.config.usage,
      modeRank: deps.config.modeRank,
      planRoots: deps.planRoots,
      shell: deps.config.shellRequest,
      planExitTitle: deps.config.planExitTitle,
      modeUpdateText: deps.config.modeUpdateText,
      requestPrefix: `${this.id}:`,
      now: deps.now,
    })
    this.exited = new Promise((resolve) => {
      this.#resolveExited = resolve
    })
    this.#launch().catch((err: unknown) => this.#internalFailure(err))
  }

  get pid(): number | undefined {
    return this.#client?.child.pid
  }

  onEvent(cb: (e: NormalizedEvent) => void): Unsubscribe {
    return this.#events.subscribe(cb)
  }

  onSignal(cb: (s: AdapterSignal) => void): Unsubscribe {
    return this.#signals.subscribe(cb)
  }

  sessionId(): string | undefined {
    return this.#n.sessionId() ?? this.#resumeId
  }

  cumulativeUsage(): Usage | undefined {
    return this.#n.cumulativeUsage()
  }

  pendingAsks(): string[] {
    return this.#n.pendingAsks()
  }

  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): void {
    // A cancel ends the turn (the decision table): `session/cancel` goes out first, then every pending permission
    // is answered `cancelled` (the ACP spec's order; the replies are written after this call returns).
    if (decision === 'cancel' && this.#n.pendingAsks().includes(requestId)) void this.#cancelTurn()
    const step = this.#n.answer(requestId, decision, why)
    this.#apply(step)
  }

  stop(reason: StopReason): Promise<void> {
    this.#stoppedBy ??= reason
    this.#n.markKilled(KILL_FOR_REASON[reason])
    return this.#stop()
  }

  // ---- emitting -----------------------------------------------------------------------------------------------

  /** Signals first (consumers read them before the events they explain), then events, then the step's actions. */
  #apply(step: AcpStep): void {
    for (const s of step.signals) {
      this.#signals.emit(s)
      // ACP has no way to add the post-compaction reminder to a session: it is reported as not supported.
      if (s.type === 'compaction' && s.phase === 'end' && this.#o.compactionReminder !== undefined)
        this.#signals.emit({ type: 'meta', key: META_COMPACTION_REMINDER, value: { unsupported: true } })
    }
    for (const e of step.events) this.#events.emit(e)
    if (step.cancelTurn === true) setImmediate(() => void this.#cancelTurn())
    if (step.hardStop === true) void this.#hardStop()
    if (this.#n.terminal) this.#afterTerminal()
  }

  #over(): boolean {
    return this.#n.terminal || this.#finished || this.#stoppedBy !== undefined
  }

  // ---- launch -------------------------------------------------------------------------------------------------

  /** Before anything is spawned: the user's flags and a mode this vendor cannot run. */
  #preSpawnProblem(): Failure | undefined {
    const o = this.#o
    const problem = acpExtraArgsProblem(this.#cfg, o.extraArgs) ?? acpFlagMapProblem(this.#cfg, o.flagMap)
    if (problem !== undefined) return makeFailure('config_invalid', problem, { classifiedBy: 'app' })
    if (typeof o.model === 'string' && !MODEL_ID.test(o.model)) {
      // The model goes in argv after `-m`: a value that reads as a flag (or carries spaces) is never passed.
      return makeFailure(
        'config_invalid',
        `"${o.model.slice(0, 60)}" is not a ${this.#cfg.displayName} model name Dim Factory can pass.`,
        { classifiedBy: 'app' },
      )
    }
    const mode = effectiveMode(o.step, o.mode)
    const spec = this.#cfg.modes[mode]
    if (spec.status === 'unsupported') {
      return makeFailure('capability_missing', `${this.#cfg.displayName}: ${spec.copy}`, {
        classifiedBy: 'app',
      })
    }
    // Grok: never a read-only pass the user's own allow rules would let change files unasked, whatever
    // preflight said (fail closed: readiness `<id>` says the same before the run).
    const guard = this.#cfg.readonlyAllowRules
    if (guard !== undefined && mode === 'readonly' && this.#d.home !== undefined) {
      const env: EnvInput = { ...this.#d.baseEnv, ...this.#d.vendorEnv, ...o.env }
      const rules = guard.scan({ cwd: o.cwd, env, home: this.#d.home })
      if (rules.length > 0) {
        const copy = readonlyAllowRulesCopy(this.#cfg.displayName, o.step, rules, {
          cwd: o.cwd,
          home: this.#d.home,
        })
        return makeFailure('capability_missing', `${copy.title}. ${copy.detail}`, {
          classifiedBy: 'app',
        })
      }
    }
    return undefined
  }

  async #launch(): Promise<void> {
    const o = this.#o
    const problem = this.#preSpawnProblem()
    if (problem !== undefined) {
      this.#failBeforeSpawn(problem)
      return
    }
    let cli: ResolvedCli
    let path: string | undefined
    try {
      ;[cli, path] = await Promise.all([this.#d.resolve(), this.#d.pathEnv()])
    } catch (err) {
      this.#failBeforeSpawn(
        err instanceof AdapterError
          ? err.failure
          : makeFailure('cli_missing', errorText(err), { classifiedBy: 'app' }),
      )
      return
    }
    if (this.#stoppedBy !== undefined) {
      this.#failBeforeSpawn(this.#stopFailure())
      return
    }
    // Gemini: the trust flag only with the folder's vendorFolder grant, or in a Dim Factory-owned folder.
    const trust =
      this.#cfg.trustFlag === undefined
        ? { trusted: false as const }
        : await folderTrust({
            cwd: o.cwd,
            vendor: this.#cfg.id,
            dimFactoryHome: this.#d.dimFactoryHome,
            engineTrusted: o.trustFolder,
            granted: this.#d.folderGranted ?? (() => Promise.resolve(false)),
          })
    const env = acpEnv(this.#d.baseEnv, {
      vendor: this.#cfg.id,
      path,
      pathPrepend: cli.pathPrepend,
      vendorEnv: { ...this.#d.vendorEnv, ...o.env },
    })
    // Extensions: below Pass through only the allowed servers (none at the None level) may load.
    const ext = o.extensions
    const mcpAllow =
      ext === undefined || ext.level === 'passthrough' ? undefined : ext.level === 'allowed' ? ext.mcp : []
    const launch = this.#cfg.resolveLaunch({
      cli,
      model: o.model,
      trust: trust.trusted,
      extraArgs: o.extraArgs,
      flagMap: o.flagMap,
      env,
      purpose: 'pass',
      ...(mcpAllow !== undefined ? { mcpAllow } : {}),
    })
    // The allowed servers' names stay out of what Dim Factory writes down (the run's argv, procs.json).
    this.#redactArgv = namesRedactor(mcpAllow ?? [])
    this.argv = launch.args.map(this.#redactArgv)
    let client: AcpClient
    try {
      client = await AcpClient.spawn({
        launch,
        cwd: o.cwd,
        label: {
          purpose: o.step === 'heal' ? 'heal' : o.step === 'catalog' ? 'catalog' : 'pass',
          runId: o.runId,
          step: o.step,
        },
        ...(o.tap !== undefined ? { tap: o.tap } : {}),
      })
    } catch (err) {
      const e = SpawnError.from(err, launch.exe)
      this.#failBeforeSpawn(
        classifyFailure({
          vendor: this.#cfg.id,
          errno: { code: e.code, message: e.message, ...(e.path !== undefined ? { path: e.path } : {}) },
          now: this.#d.now(),
        }),
      )
      return
    }
    this.#client = client
    this.#wire(client.peer)
    const stderr = this.#drainStderr(client.child)
    await this.#afterSpawn(client.child)
    if (this.#stoppedBy !== undefined) {
      this.#stopping = undefined
      void this.#stop()
    } else void this.#converse(client).catch((err: unknown) => this.#internalFailure(err))
    const exit = await client.child.exited
    await Promise.all([client.peer.done.catch(() => undefined), stderr])
    this.#clearTimers()
    this.#wakeTerminalWaiters()
    this.#finish(exit.code, exit.signal, exit.ms, () =>
      this.#n.end({
        code: exit.code,
        signal: exit.signal,
        ranMs: exit.ms,
        stderrTail: client.child.stderrTail(20).map(this.#redactArgv),
      }),
    )
  }

  async #drainStderr(child: ChildHandle): Promise<void> {
    try {
      for await (const _ of child.lines('stderr')) {
        // the tail is kept by spawn.ts (the classifier's evidence)
      }
    } catch {
      // the stream ended with the process
    }
  }

  async #afterSpawn(child: ChildHandle): Promise<void> {
    const hook = this.#d.onSpawn
    if (hook === undefined) return
    const { pid, pgid, spawnAt, command, realCommand } = child
    const argv = child.argv.map(this.#redactArgv)
    try {
      await hook(this.#o, { pid, pgid, spawnAt, command, realCommand, argv })
    } catch {
      // Bookkeeping must not fail the pass.
    }
  }

  #wire(peer: JsonRpcPeer): void {
    peer.onRequest(M.requestPermission, (params, ctx) => {
      const out = this.#n.request(params, ctx.id)
      this.#apply(out.step)
      return out.reply
    })
    // Every other agent → client request (fs/*, terminal/*, vendor extensions) gets -32601 from the peer.
    peer.onNotification(M.sessionUpdate, (params) => {
      this.#lastUpdate = Date.now()
      this.#apply(this.#n.update(params))
    })
    peer.onNotification(M.cancelRequest, (params) => this.#apply(this.#n.withdraw(params)))
    peer.onError((e) => this.#streamError(e))
  }

  #streamError(e: RpcStreamError): void {
    if (this.#n.terminal) return
    if (e.reason === 'oversize') return // one dropped line (the raw log has its head); not a protocol break
    this.#apply(
      this.#n.fail(
        makeFailure('stream_malformed', `${this.#cfg.displayName} sent unreadable output (${e.message}).`, {
          raw: redactRaw(e.lines.join('\n')),
          classifiedBy: 'structured',
        }),
      ),
    )
    void this.#hardStop()
  }

  // ---- the conversation ---------------------------------------------------------------------------------------

  async #converse(client: AcpClient): Promise<void> {
    const o = this.#o
    const t = this.#d.timing
    const peer = client.peer
    // 1. initialize (bounded: a silent CLI has drifted). Never authenticate.
    let info: AgentInfo
    try {
      info = await client.initialize(t.initializeMs)
    } catch (err) {
      if (this.#over()) return
      if (isPeerTimeout(err)) {
        this.#n.markKilled('handshake')
        void this.#hardStop()
        return
      }
      if (err instanceof JsonRpcError) {
        this.#failHard(
          makeFailure(
            'flag_drift',
            `${this.#cfg.displayName} rejected the startup handshake: ${rpcText(err).slice(0, 300)}`,
            {
              raw: redactRaw(JSON.stringify({ method: M.initialize, code: err.code, message: rpcText(err) })),
              classifiedBy: 'structured',
            },
          ),
        )
      }
      return
    }
    if (this.#over()) return
    if (info.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.#failHard(
        makeFailure(
          'flag_drift',
          `${this.#cfg.displayName} speaks ACP version ${String(info.protocolVersion ?? 'unknown')}; Dim Factory speaks version ${ACP_PROTOCOL_VERSION}.`,
          {
            raw: JSON.stringify({ protocolVersion: info.protocolVersion ?? null }),
            classifiedBy: 'structured',
          },
        ),
      )
      return
    }

    // 2. The session: new, or continued (resume if advertised, else load with its replay dropped). The mode's `_meta`
    //    (Grok's approval posture) goes on every setup: a continued session never keeps an earlier pass's posture.
    let session: SessionInfo
    const resumeId = this.#resumeId
    const meta = this.#cfg.modes[effectiveMode(o.step, o.mode)].meta
    const withMeta = <T extends object>(params: T): T & { _meta?: Readonly<Record<string, unknown>> } =>
      meta !== undefined ? { ...params, _meta: meta } : params
    if (resumeId !== undefined) {
      const method = info.resume ? M.sessionResume : info.loadSession ? M.sessionLoad : undefined
      if (method === undefined) {
        this.#failHard(
          makeFailure(
            'capability_missing',
            `${this.#cfg.displayName} cannot continue an earlier session here, so this pass cannot reuse it.`,
            {
              raw: JSON.stringify({ loadSession: info.loadSession, resume: info.resume }),
              classifiedBy: 'structured',
            },
          ),
        )
        return
      }
      if (method === M.sessionLoad) this.#n.setDropping(true)
      try {
        session = readSession(
          await peer.request(
            method,
            method === M.sessionResume
              ? withMeta(resumeSessionParams(resumeId, o.cwd))
              : withMeta(loadSessionParams(resumeId, o.cwd)),
            { timeoutMs: t.requestMs },
          ),
        )
      } catch (err) {
        this.#rpcFailed(method, err, false)
        return
      }
      if (this.#over()) return
      this.#cacheSetup(session)
      this.#sessionId = resumeId
      this.#apply(this.#n.session(resumeId))
      if (method === M.sessionLoad) {
        await this.#quietWindow()
        this.#n.setDropping(false)
        if (this.#over()) return
      }
    } else {
      try {
        session = readSession(
          await peer.request(M.sessionNew, withMeta(newSessionParams(o.cwd)), { timeoutMs: t.requestMs }),
        )
      } catch (err) {
        this.#rpcFailed(M.sessionNew, err, true)
        return
      }
      if (this.#over()) return
      this.#cacheSetup(session)
      const id = session.sessionId
      if (id === undefined || id === '') {
        this.#failHard(
          makeFailure(
            'stream_malformed',
            `${this.#cfg.displayName} answered session/new without a session id.`,
            {
              classifiedBy: 'structured',
            },
          ),
        )
        return
      }
      this.#sessionId = id
      this.#apply(this.#n.session(id))
      // The session id is durable (run.json) before session/prompt.
      const persisted = await this.#persistSession(id)
      if (this.#over()) return
      if (persisted !== undefined) {
        this.#failHard(persisted)
        return
      }
    }
    const sessionId = this.#sessionId

    // 3. The mode, after every new, load or resume (the mode is not restored; the user's own default may differ).
    let target = targetModeOf(this.#cfg, o, this.planNative)
    const modes = session.modes ?? this.#d.facts.modes
    if (this.planNative && target !== undefined && modes !== undefined && !modes.includes(target)) {
      this.#apply(
        this.#n.planFellBack(
          `${this.#cfg.displayName} offers no plan mode here, so Plan runs read-only with the plan template`,
        ),
      )
      target = this.#cfg.modes.readonly.acpMode ?? undefined
    }
    if (target !== undefined) {
      if (modes !== undefined && !modes.includes(target)) {
        this.#failHard(
          makeFailure(
            'flag_drift',
            `${this.#cfg.displayName} has no "${target}" mode (it offers ${modes.join(', ') || 'none'}), so Dim Factory cannot run this pass as asked.`,
            { raw: JSON.stringify({ modeId: target, availableModes: modes }), classifiedBy: 'structured' },
          ),
        )
        return
      }
      try {
        await peer.request(M.sessionSetMode, setModeParams(sessionId, target), { timeoutMs: t.requestMs })
      } catch (err) {
        // Never prompt in a mode Dim Factory did not set: the vendor's own default could ask less. session/set_mode is
        // an optional ACP method: a -32601 is capability_missing; "Invalid or unavailable mode" stays
        // flag_drift (the ACP signal table's own rule).
        this.#rpcFailed(M.sessionSetMode, err, false)
        return
      }
      if (this.#over()) return
      this.#n.modeSet(target)
    }

    // 4. The prompt: it travels only here.
    const text =
      resumeId === undefined && o.systemAppend !== undefined && o.systemAppend.trim() !== ''
        ? `${o.systemAppend}\n\n${o.prompt}`
        : o.prompt
    this.#promptSent = true
    let result: unknown
    try {
      result = await peer.request(M.sessionPrompt, promptParams(sessionId, text), { retry: false })
    } catch (err) {
      this.#rpcFailed(M.sessionPrompt, err, true)
      return
    }
    this.#apply(this.#n.promptResult(result))
  }

  /** The adapter caches what a session answer names (a bad callback never fails the pass). */
  #cacheSetup(session: SessionInfo): void {
    try {
      this.#d.onSessionSetup?.(session)
    } catch {
      // bookkeeping only
    }
  }

  /** After a session/load: until updates have been quiet for loadQuietMs, at most loadQuietCapMs. */
  async #quietWindow(): Promise<void> {
    const t = this.#d.timing
    const start = Date.now()
    this.#lastUpdate = Math.max(this.#lastUpdate, start)
    for (;;) {
      if (this.#over()) return
      const now = Date.now()
      const quietLeft = this.#lastUpdate + t.loadQuietMs - now
      const capLeft = start + t.loadQuietCapMs - now
      if (quietLeft <= 0 || capLeft <= 0) return
      await delay(Math.min(quietLeft, capLeft), undefined, { ref: false })
    }
  }

  /**
   * onSession (the engine's run.json write), bounded: the failure that ends the pass when the id is not durable,
   * else undefined. No hook (outside a run): nothing to persist. Never races into session/prompt.
   */
  async #persistSession(sessionId: string): Promise<Failure | undefined> {
    const hook = this.#o.onSession
    if (hook === undefined) return undefined
    const timedOut = Symbol('timeout')
    const ms = this.#d.timing.sessionPersistMs
    const r = await Promise.race([
      hook(sessionId).catch((err: unknown): SessionRecorded => ({ ok: false, reason: errorText(err) })),
      delay(ms, timedOut, { ref: false }),
    ])
    if (r !== timedOut && r.ok) return undefined
    const why =
      r === timedOut
        ? `Dim Factory did not confirm within ${Math.round(ms / 1000)} s that it saved the ${this.#cfg.displayName} session id`
        : `Dim Factory could not save the ${this.#cfg.displayName} session id (${r.reason})`
    return makeFailure(
      r !== timedOut && r.code === 'ENOSPC' ? 'disk_full' : 'unknown',
      `${why}, so it did not send the prompt. Nothing was sent to the model.`,
      {
        raw: JSON.stringify({ sessionId, ...(r !== timedOut ? { reason: r.reason, code: r.code } : {}) }),
        classifiedBy: 'app',
      },
    )
  }

  #rpcFailed(method: string, err: unknown, required: boolean): void {
    if (this.#n.terminal || this.#finished) return
    if (isPeerClosed(err)) return // the process ended: end() classifies it with its exit code and stderr
    if (this.#stoppedBy !== undefined || this.#n.killedBy !== undefined) {
      if (err instanceof JsonRpcError)
        this.#apply(this.#n.failRpc({ rpcError: { method, code: err.code, message: rpcText(err) } }))
      return
    }
    if (isPeerTimeout(err)) {
      this.#failHard(
        makeFailure(
          'unknown',
          `${this.#cfg.displayName} did not answer ${method} within ${Math.round(this.#d.timing.requestMs / 1000)} s.`,
          { classifiedBy: 'heuristic' },
        ),
      )
      return
    }
    if (err instanceof JsonRpcError) {
      this.#apply(
        this.#n.failRpc({
          rpcError: { method, code: err.code, message: rpcText(err), required },
          stderrTail: (this.#client?.child.stderrTail(20) ?? []).map(this.#redactArgv),
        }),
      )
      void this.#hardStop()
      return
    }
    this.#internalFailure(err)
  }

  #failHard(f: Failure): void {
    this.#apply(this.#n.fail(f))
    void this.#hardStop()
  }

  // ---- cancel, end of the turn, stop ----------------------------------------------------------------------------

  /** `session/cancel` (a notification), once. A captured plan's pass ends even if the agent never answers. */
  async #cancelTurn(): Promise<void> {
    const peer = this.#client?.peer
    const sessionId = this.#sessionId
    if (this.#cancelSent || peer === undefined || peer.isClosed || sessionId === undefined) return
    this.#cancelSent = true
    if (this.#n.planCaptured && this.#planTimer === undefined) {
      this.#planTimer = setTimeout(() => {
        this.#planTimer = undefined
        if (!this.#n.terminal) void this.#hardStop()
      }, this.#d.timing.planCancelMs)
      this.#planTimer.unref()
    }
    await peer.notify(M.sessionCancel, cancelParams(sessionId)).catch(() => undefined)
  }

  /** The terminal event is out: close stdin (the agent exits) and kill it if it lingers. */
  #afterTerminal(): void {
    this.#wakeTerminalWaiters()
    if (this.#planTimer !== undefined) {
      clearTimeout(this.#planTimer)
      this.#planTimer = undefined
    }
    const child = this.#client?.child
    if (child === undefined || this.#exitTimer !== undefined || this.#stopping !== undefined) return
    // Let the replies to auto-cancelled requests go out first.
    setImmediate(() => this.#closeStdin())
    this.#exitTimer = setTimeout(() => {
      if (child.exitInfo() === null) void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    }, this.#d.timing.exitAfterTerminalMs)
    this.#exitTimer.unref()
  }

  #closeStdin(): void {
    if (this.#stdinClosed) return
    this.#stdinClosed = true
    this.#client?.child.closeStdin()
  }

  #wakeTerminalWaiters(): void {
    const ws = this.#terminalWaiters
    this.#terminalWaiters = []
    for (const w of ws) w()
  }

  #waitTerminal(ms: number): Promise<void> {
    if (this.#n.terminal || this.#finished) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref()
      this.#terminalWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Kill: every pending permission `cancelled`, `session/cancel`, then stdin, then the tree. */
  #stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#client?.child
    if (child === undefined) {
      // Still resolving or spawning: #launch sees the stop and ends without a conversation.
      this.#stopping = this.exited.then(() => undefined)
      return this.#stopping
    }
    if (child.exitInfo() !== null) return this.exited.then(() => undefined)
    const t = this.#d.timing
    this.#stopping = (async () => {
      await stopChild(child, {
        graceful: async () => {
          this.#apply(this.#n.cancelAll())
          if (this.#promptSent && !this.#n.terminal) {
            await this.#cancelTurn()
            await this.#waitTerminal(t.stopTurnMs)
          }
          this.#closeStdin()
        },
        gracefulWaitMs: t.stopTurnMs + t.stopStdinMs,
        stdinWaitMs: t.stopStdinMs,
      })
      await this.exited
    })()
    return this.#stopping
  }

  /** Internal kill (handshake drift, a refused session, a widened mode, unreadable output): stdin, then the tree. */
  #hardStop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#client?.child
    if (child === undefined || child.exitInfo() !== null) return Promise.resolve()
    this.#closeStdin()
    this.#stopping = stopChild(child, { stdinWaitMs: 1_000 }).then(() => undefined)
    return this.#stopping
  }

  #clearTimers(): void {
    for (const t of [this.#exitTimer, this.#planTimer]) if (t !== undefined) clearTimeout(t)
    this.#exitTimer = undefined
    this.#planTimer = undefined
  }

  // ---- ends --------------------------------------------------------------------------------------------------

  #stopFailure(): Failure {
    const kind = KILL_FOR_REASON[this.#stoppedBy ?? 'user']
    return (
      classify({ vendor: this.#cfg.id, appInitiated: { kind }, now: this.#d.now() }) ??
      makeFailure('user_cancelled', 'Dim Factory is shutting down.', { classifiedBy: 'app' })
    )
  }

  /** One fatal error and an exit with no process (flags, the binary, the spawn). */
  #failBeforeSpawn(failure: Failure): void {
    if (this.#finished) return
    this.#preSpawnTerminal = true
    this.#finished = true
    const step = this.#n.fail(failure)
    for (const s of step.signals) this.#signals.emit(s)
    for (const e of step.events) this.#events.emit(e)
    if (step.events.length === 0) this.#events.emit(errorEvent(failure, true))
    this.#resolveExited({
      code: null,
      signal: null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#d.now() - this.#startedAt,
    })
  }

  /** A bug in the adapter itself: one terminal error instead of hanging, and the process is ended. */
  #internalFailure(err: unknown): void {
    if (this.#finished) return
    if (!this.#n.terminal && !this.#preSpawnTerminal) {
      this.#preSpawnTerminal = true
      const step = this.#n.fail(
        makeFailure('unknown', `${this.#cfg.displayName} adapter error: ${errorText(err)}`, {
          classifiedBy: 'heuristic',
        }),
      )
      for (const s of step.signals) this.#signals.emit(s)
      for (const e of step.events) this.#events.emit(e)
    }
    this.#clearTimers()
    this.#finished = true
    const child = this.#client?.child
    if (child !== undefined && child.exitInfo() === null)
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    this.#resolveExited({
      code: child?.exitInfo()?.code ?? null,
      signal: child?.exitInfo()?.signal ?? null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#d.now() - this.#startedAt,
    })
  }

  /** The process is gone: the terminal event when none was emitted (`end`), then `exited`. */
  #finish(code: number | null, signal: string | null, ms: number, end: () => AcpStep): void {
    if (this.#finished) return
    this.#finished = true
    const sawTerminal = this.#n.terminal || this.#preSpawnTerminal
    const step = end()
    for (const s of step.signals) this.#signals.emit(s)
    for (const e of step.events) this.#events.emit(e)
    this.#resolveExited({
      code,
      signal,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal,
      ranMs: ms,
    })
  }
}
