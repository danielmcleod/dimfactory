// One Claude Code process for one step attempt: spawn, initialize, user message, normalize, answer, stop
// (stdin frames, kill), then plan-file hygiene.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import { newRequestId, newUuid } from '../../../shared/ids.ts'
import type { Route } from '../../../shared/vendors.ts'
import { effortProblem } from '../../../shared/vendors.ts'
import type { AppKill } from '../../heal/classify.ts'
import { classify, redactRaw } from '../../heal/classify.ts'
import type { EnvInput } from '../../proc/env.ts'
import { stopChild } from '../../proc/kill.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { SpawnError, spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { AdapterError, BufferedEmitter, classifyFailure, errorEvent, makeFailure } from '../errors.ts'
import { META_COMPACTION_REMINDER, META_RESUME_IGNORED } from '../types.ts'
import type { AskCancelReason, ExitInfo, RunHandle, StartOptions, StopReason, Unsubscribe } from '../types.ts'
import {
  CLAUDE_VENDOR,
  INITIALIZE_TIMEOUT_MS,
  PLAN_RESULT_TIMEOUT_MS,
  SEND_INITIALIZE,
  STOP_RESULT_WAIT_MS,
  STOP_STDIN_WAIT_MS,
} from './capabilities.ts'
import {
  buildArgv,
  claudeConfigDir,
  claudeEnv,
  extraArgsProblem,
  flagMapProblem,
  routeExtensions,
  routeFor,
} from './launch.ts'
import type { ClaudeRoute, ControlReply, NormalizeStep } from './normalize.ts'
import { GUARDRAIL_HOOK_ID, ClaudeNormalizer, guardrailHookMatcher } from './normalize.ts'
import type { PlanFileOps } from './plan-hygiene.ts'
import { cleanPlanFiles, planFilesNote } from './plan-hygiene.ts'
import type { ImageBlock, StdinFrame } from './protocol.ts'
import {
  hookResponse,
  initializeRequest,
  interruptRequest,
  sessionStartContext,
  userMessage,
} from './protocol.ts'
import { contextUsageRequest } from './context-usage.ts'
import { scanShellAllowRules } from './settings-scan.ts'
import type { ExtensionLevel } from '../../../shared/extensions.ts'
import { withFolderSpellings } from '../../real-path.ts'
import { claudeCustomAgents, claudeMcpDefinitions, discoverClaude } from '../../extensions/claude.ts'
import { namesRedactor } from '../../extensions/redact.ts'
import type { ClaudeConnector } from '../../extensions/claude-connectors.ts'
import type { GuardrailRule } from '../../../shared/guardrails.ts'
import { privateFilesIn } from '../../guardrails/private-files.ts'

/** The folder's private files, looked up the first time a search asks and kept for the pass. */
function privateFilesOnce(cwd: string, rules: readonly GuardrailRule[]): () => readonly string[] {
  let files: readonly string[] | undefined
  return () => (files ??= privateFilesIn(cwd, rules))
}

/**
 * The names the user's Claude settings define (MCP servers, skills, plugin skills, custom subagents), read in memory to
 * hide them in the raw log. A settings file that cannot be read hides nothing more; never throws.
 */
function settingsNames(env: EnvInput, home: string, cwd: string): string[] {
  try {
    const d = discoverClaude({ env, home, cwd })
    return [...d.mcp.map((m) => m.name), ...d.skills.map((s) => s.name), ...d.agents]
  } catch {
    return []
  }
}

export interface RunDeps {
  /** The CLI to spawn; rejects with an AdapterError (cli_missing, â€¦) when there is none. */
  resolve(): Promise<ResolvedCli>
  baseEnv: EnvInput
  /** The resolved PATH for children (path-env); undefined = the base env's PATH. */
  pathEnv(): Promise<string | undefined>
  /** `vendors.claude.env` (user config); StartOptions.env is layered on top. */
  vendorEnv?: Record<string, string> | undefined
  home: string
  now: () => number
  readPlanFile?: (path: string) => string | undefined
  /** Plan-file hygiene file operations (default node:fs). */
  planFiles?: PlanFileOps | undefined
  timing?: Partial<RunTiming>
  /** Called after spawn and before the first stdin write (the engine records procs.json here). */
  onSpawn?: SpawnHook | undefined
  /**
   * The account's claude.ai connectors (adapter `listConnectors`), asked only when an allowed MCP server is not in the
   * settings files. Absent: connectors are never allowed.
   */
  connectors?: (() => Promise<readonly ClaudeConnector[]>) | undefined
}

export type SpawnHook = (
  o: StartOptions,
  child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
) => void | Promise<void>

export interface RunTiming {
  initializeMs: number
  planResultMs: number
  stopResultMs: number
  stopStdinMs: number
  /** How long an answer waits on its background work (shells, subagents) before the pass ends anyway. */
  backgroundMs: number
  /** After the background work ends, how long to wait for the CLI's follow-up turn. */
  drainedMs: number
  /**
   * How long the session stays open after the answer for the end-of-pass context breakdown (live C23b: answered
   * before exit, the whole pass took 5.5 s). Well under the engine's exit grace after `done`.
   */
  contextUsageMs: number
}

const DEFAULT_TIMING: RunTiming = {
  initializeMs: INITIALIZE_TIMEOUT_MS,
  planResultMs: PLAN_RESULT_TIMEOUT_MS,
  stopResultMs: STOP_RESULT_WAIT_MS,
  stopStdinMs: STOP_STDIN_WAIT_MS,
  backgroundMs: 30 * 60_000,
  drainedMs: 20_000,
  contextUsageMs: 2_500,
}

/** The callback id of Dim Factory's own SessionStart hook (the post-compaction reminder). */
export const REMINDER_HOOK_ID = 'compaction-reminder'

const KILL_FOR_REASON: Record<StopReason, AppKill> = {
  user: 'stop',
  timeout: 'hard',
  shutdown: 'quit',
  loop: 'loop',
}

/** The largest picture sent with a prompt (the Messages API's limit for one image). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** StartOptions.images as image blocks (PNG or JPEG by name); one that cannot be read, or is too large, is left out. */
export function imageBlocks(paths: readonly string[]): ImageBlock[] {
  const out: ImageBlock[] = []
  for (const p of paths) {
    try {
      const bytes = readFileSync(p)
      if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) continue
      const media_type = /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png'
      out.push({ type: 'image', source: { type: 'base64', media_type, data: bytes.toString('base64') } })
    } catch {
      // not readable: the prompt goes without it
    }
  }
  return out
}

type Waiter = () => void

export class ClaudeRun implements RunHandle {
  readonly id: string
  readonly vendor = CLAUDE_VENDOR
  readonly route: Route = 'stdio'
  readonly exited: Promise<ExitInfo>
  /** The argv after the binary's prefix args (set once the launch plan is built). */
  argv: string[] = []
  readonly claudeRoute: ClaudeRoute

  readonly #o: StartOptions
  readonly #deps: RunDeps
  readonly #timing: RunTiming
  readonly #n: ClaudeNormalizer
  /** `${CLAUDE_CONFIG_DIR ?? ~/.claude}` as the child sees it. */
  readonly #configDir: string
  /** The post-compaction reminder's hook callback id (an edit pass given StartOptions.compactionReminder). */
  #reminderHookId: string | undefined
  /** `--resume` target: only the edit route can continue a session (the others run without persistence). */
  readonly #resumeId: string | undefined
  readonly #events = new BufferedEmitter<NormalizedEvent>()
  readonly #signals = new BufferedEmitter<AdapterSignal>()
  readonly #replyWaiters = new Map<string, (r: ControlReply | undefined) => void>()
  #resultWaiters: Waiter[] = []
  #child: ChildHandle | undefined
  #presetSession: string | undefined
  #stoppedBy: StopReason | undefined
  #stopping: Promise<void> | undefined
  #writeChain: Promise<unknown> = Promise.resolve()
  #stdinClosed = false
  #planTimer: NodeJS.Timeout | undefined
  /** The capped wait on background work after an answer, and the wait for the follow-up turn once it is done. */
  #waitTimer: NodeJS.Timeout | undefined
  #drainTimer: NodeJS.Timeout | undefined
  #startedAt: number
  #resolveExited: (e: ExitInfo) => void = () => undefined
  #preSpawnTerminal = false
  #userSent = false
  #finished = false
  /** The pass's Extensions level (StartOptions.extensions, else the route's own). */
  readonly #level: ExtensionLevel
  /** Allowed list: the allowed servers' config file of this launch (deleted once the process is gone). */
  #mcpConfigFile: string | undefined
  /** Hides the allowed servers' and skills' names in the raw log. */
  readonly #redact: (text: string) => string
  /** The end-of-pass context breakdown: not asked yet, asked (the session stays open for it), or over. */
  #contextEnd: 'none' | 'asked' | 'over' = 'none'
  #contextEndId: string | undefined
  #contextTimer: NodeJS.Timeout | undefined

  constructor(o: StartOptions, deps: RunDeps) {
    this.id = newRequestId('claude')
    this.#o = o
    this.#deps = deps
    this.#timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.claudeRoute = routeFor(o)
    this.#level = o.extensions?.level ?? routeExtensions(this.claudeRoute)
    // Every level: the names the user's settings define (the allowed ones too), hidden in the raw log.
    this.#redact = namesRedactor([
      ...(o.extensions?.mcp ?? []),
      ...(o.extensions?.skills ?? []),
      ...settingsNames({ ...deps.baseEnv, ...deps.vendorEnv, ...o.env }, deps.home, o.cwd),
    ])
    this.#startedAt = deps.now()
    this.#resumeId = this.claudeRoute === 'edit' ? o.resume?.sessionId : undefined
    if (o.resume !== undefined && this.#resumeId === undefined) {
      this.#signals.emit({
        type: 'meta',
        key: META_RESUME_IGNORED,
        value: {
          route: this.claudeRoute,
          reason: 'Only edit passes can resume a Claude session; this one starts fresh.',
        },
      })
    }
    const configDir = claudeConfigDir({ ...deps.baseEnv, ...deps.vendorEnv, ...o.env }, deps.home)
    this.#configDir = configDir
    // The post-compaction reminder: an edit pass registers its own SessionStart hook (answered in #onHook).
    if (o.compactionReminder !== undefined && this.claudeRoute === 'edit')
      this.#reminderHookId = REMINDER_HOOK_ID
    this.#n = new ClaudeNormalizer({
      route: this.claudeRoute,
      resumed: this.#resumeId !== undefined,
      priorUsage: this.#resumeId !== undefined ? o.resume?.priorUsage : undefined,
      askTimeoutMs: o.askTimeoutMs,
      now: deps.now,
      allowRules: o.allowRules,
      ...(o.permit !== undefined ? { permit: o.permit } : {}),
      cwd: o.cwd,
      home: deps.home,
      configDir,
      ...(deps.readPlanFile !== undefined ? { readPlanFile: deps.readPlanFile } : {}),
      ...(this.#level === 'allowed' ? { allowedMcp: o.extensions?.mcp ?? [] } : {}),
      ...(this.#reminderHookId !== undefined ? { reminderHookId: this.#reminderHookId } : {}),
      ...(o.guardrails !== undefined ? { guardrails: withFolderSpellings(o.guardrails, o.cwd) } : {}),
      ...(o.guardrails?.rules.some((r) => r.kind === 'privateFiles') === true
        ? { privateFiles: privateFilesOnce(o.cwd, o.guardrails.rules) }
        : {}),
    })
    this.exited = new Promise((resolve) => {
      this.#resolveExited = resolve
    })
    this.#launch(configDir).catch((err: unknown) => this.#internalFailure(err))
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  onEvent(cb: (e: NormalizedEvent) => void): Unsubscribe {
    return this.#events.subscribe(cb)
  }

  onSignal(cb: (s: AdapterSignal) => void): Unsubscribe {
    return this.#signals.subscribe(cb)
  }

  sessionId(): string | undefined {
    return this.#n.sessionId() ?? this.#presetSession
  }

  cumulativeUsage(): Usage | undefined {
    return this.#n.cumulativeUsage()
  }

  pendingAsks(): string[] {
    return this.#n.pendingAsks()
  }

  answer(requestId: string, decision: AskDecision, why?: AskCancelReason): void {
    this.#apply(this.#n.answer(requestId, decision, why))
    this.#maybeCloseStdin()
  }

  stop(reason: StopReason): Promise<void> {
    this.#stoppedBy ??= reason
    this.#n.markKilled(KILL_FOR_REASON[reason])
    return this.#stop()
  }

  // ---- launch ---------------------------------------------------------------------------------------------

  async #launch(configDir: string): Promise<void> {
    const o = this.#o
    const problem = extraArgsProblem(o.extraArgs) ?? flagMapProblem(o.flagMap) ?? effortProblem(o.effort)
    if (problem !== undefined) {
      this.#failBeforeSpawn(makeFailure('config_invalid', problem, { classifiedBy: 'app' }))
      return
    }
    let cli: ResolvedCli
    let path: string | undefined
    try {
      ;[cli, path] = await Promise.all([this.#deps.resolve(), this.#deps.pathEnv()])
    } catch (err) {
      this.#failBeforeSpawn(
        err instanceof AdapterError
          ? err.failure
          : makeFailure('cli_missing', err instanceof Error ? err.message : String(err), {
              classifiedBy: 'app',
            }),
      )
      return
    }
    if (this.#stoppedBy !== undefined) {
      this.#failBeforeSpawn(this.#stopFailure())
      return
    }

    const route = this.claudeRoute
    const resumeId = this.#resumeId
    if (route === 'edit' && resumeId === undefined) this.#presetSession = o.sessionId ?? newUuid()
    // Continuity: a Plan that keeps its session starts it under a known id, so Implement can resume it.
    const keep = o.keepSession === true && o.step === 'plan' && route !== 'edit'
    if (keep) this.#presetSession = o.sessionId ?? newUuid()
    if (resumeId !== undefined) this.#presetSession = resumeId
    const disallowShell = route !== 'edit' && scanShellAllowRules(o.cwd, configDir).length > 0
    const vendorEnv = { ...this.#deps.vendorEnv, ...o.env }
    // Read-only and plan routes below Pass through run without the subagent tool when custom subagents exist.
    const customAgents =
      route !== 'edit' &&
      this.#level !== 'passthrough' &&
      claudeCustomAgents({ env: { ...this.#deps.baseEnv, ...vendorEnv }, home: this.#deps.home, cwd: o.cwd })
        .length > 0
    let mcpWithoutAsking: string[] = []
    if (this.#level === 'allowed') {
      try {
        const written = await this.#writeMcpConfig({ ...this.#deps.baseEnv, ...vendorEnv })
        this.#mcpConfigFile = written?.file
        // Only servers the file really defines run without asking (a name no longer defined gets no rule).
        const noAsk = new Set(o.extensions?.mcpWithoutAsking ?? [])
        mcpWithoutAsking = (written?.names ?? []).filter((n) => noAsk.has(n))
      } catch {
        this.#failBeforeSpawn(
          makeFailure('unknown', 'Dim Factory could not prepare the allowed MCP servers for this pass.', {
            classifiedBy: 'app',
          }),
        )
        return
      }
      // Listing the connectors can take a few seconds: a stop meanwhile ends the pass before it spawns.
      if (this.#stoppedBy !== undefined) {
        this.#failBeforeSpawn(this.#stopFailure())
        return
      }
    }
    this.argv = buildArgv({
      route,
      mode: o.mode,
      step: o.step,
      model: o.model,
      effort: o.effort,
      sessionId: this.#presetSession,
      resumeId,
      nativeRules: o.allowRules.filter((r) => r.vendor === CLAUDE_VENDOR).flatMap((r) => r.nativeRules ?? []),
      disallowShell,
      ephemeral: o.ephemeral,
      ...(keep ? { keepSession: true } : {}),
      extraArgs: o.extraArgs,
      flagMap: o.flagMap,
      // Only the catalog step reads it (launch.ts); `true` is web search without page fetches.
      webDomains: typeof o.web === 'object' ? o.web.allowedDomains : undefined,
      // Research reads it: web search and page fetches on any host, or none.
      webOpen: o.step === 'research' && o.web === true,
      // Only a pass that names its level gets one: without it argv is exactly what the route always had.
      ...(o.extensions !== undefined ? { extensions: this.#level } : {}),
      ...(this.#mcpConfigFile !== undefined ? { mcpConfigPath: this.#mcpConfigFile } : {}),
      ...(customAgents ? { customAgents } : {}),
      ...(mcpWithoutAsking.length > 0 ? { mcpWithoutAsking } : {}),
    })
    const env = claudeEnv(this.#deps.baseEnv, {
      route,
      path,
      pathPrepend: cli.pathPrepend,
      vendorEnv,
      ...(o.extensions !== undefined ? { extensions: this.#level } : {}),
      // The catalog refresh's allow list is exactly its argv (no settings rules, no preapproved hosts).
      // Research takes the same confinement (its web access is its argv's, nothing from settings).
      confined: o.step === 'catalog' || o.step === 'research',
    })
    // An auth failure names ANTHROPIC_API_KEY only when the CLI really runs with it.
    this.#n.noteSpawnEnv(env)

    let child: ChildHandle
    try {
      child = await spawnChild({
        cli,
        args: this.argv,
        cwd: o.cwd,
        env,
        label: {
          purpose: o.step === 'heal' ? 'heal' : o.step === 'catalog' ? 'catalog' : 'pass',
          runId: o.runId,
          step: o.step,
        },
        ...(o.tap !== undefined ? { tap: this.#tap(o.tap) } : {}),
      })
    } catch (err) {
      const e = SpawnError.from(err, cli.command)
      this.#failBeforeSpawn(
        classifyFailure({
          vendor: CLAUDE_VENDOR,
          errno: { code: e.code, message: e.message, ...(e.path !== undefined ? { path: e.path } : {}) },
          now: this.#deps.now(),
        }),
      )
      return
    }
    this.#child = child
    const fail = (e: unknown): void => this.#internalFailure(e)
    const out = this.#readStdout(child).catch(fail)
    const err = this.#readStderr(child).catch(fail)
    if (this.#deps.onSpawn !== undefined) {
      const { pid, pgid, spawnAt, command, realCommand, argv } = child
      try {
        await this.#deps.onSpawn(o, { pid, pgid, spawnAt, command, realCommand, argv })
      } catch {
        // Bookkeeping must not fail the pass.
      }
    }
    if (this.#stoppedBy !== undefined) {
      this.#stopping = undefined
      void this.#stop()
    } else void this.#converse(child)
    const exit = await child.exited
    await Promise.all([out, err])
    this.#finish(exit.code, exit.signal, exit.ms)
  }

  async #converse(child: ChildHandle): Promise<void> {
    if (SEND_INITIALIZE) {
      const requestId = newRequestId('init')
      const append = this.#resumeId === undefined ? this.#o.systemAppend : undefined
      const schema = this.#o.outputSchema
      const reply = this.#awaitReply(requestId, this.#timing.initializeMs)
      this.#write(
        initializeRequest(requestId, {
          ...(append !== undefined ? { appendSystemPrompt: append } : {}),
          // C17: the answer comes back in result.structured_output (the normalizer's structuredOutput meta).
          ...(schema !== undefined ? { jsonSchema: schema } : {}),
          // Allowed list: only the skills the user allowed (none when they allowed none).
          ...(this.#level === 'allowed' ? { skills: this.#o.extensions?.skills ?? [] } : {}),
          // The post-compaction reminder's hook (no matcher: #onHook answers only a `compact` start).
          ...(this.#reminderHookId !== undefined || this.#o.guardrails !== undefined
            ? {
                hooks: {
                  ...(this.#reminderHookId !== undefined
                    ? { SessionStart: [{ hookCallbackIds: [this.#reminderHookId] }] }
                    : {}),
                  ...(this.#o.guardrails !== undefined
                    ? {
                        PreToolUse: [
                          {
                            matcher: guardrailHookMatcher(this.#o.guardrails),
                            hookCallbackIds: [GUARDRAIL_HOOK_ID],
                          },
                        ],
                      }
                    : {}),
                },
              }
            : {}),
        }),
      )
      const r = await reply
      if (child.exitInfo() !== null || this.#n.terminal || this.#stoppedBy !== undefined) return
      if (r === undefined) {
        // C08c: a CLI that fails at startup never answers; one that is alive and silent has drifted.
        if (child.exitInfo() !== null || this.#n.terminal) return
        this.#n.markKilled('handshake')
        void this.#hardStop()
        return
      }
      if (!r.ok) {
        // systemAppend travels only in initialize: never run the pass without it.
        const error = redactRaw(r.error ?? 'error').slice(0, 300)
        this.#apply(
          this.#n.fail(
            makeFailure('flag_drift', `Claude Code rejected the startup handshake: ${error}`, {
              raw: redactRaw(JSON.stringify({ subtype: 'error', error: r.error ?? 'error' })),
              classifiedBy: 'structured',
            }),
          ),
        )
        void this.#hardStop()
        return
      }
    }
    this.#userSent = true
    this.#write(userMessage(this.#o.prompt, imageBlocks(this.#o.images ?? [])))
    // The context breakdown at the start (live C23b: answered before the first model call); never awaited.
    if (this.#o.contextBreakdown === true) this.#askContext('start')
  }

  /**
   * Dim Factory's SessionStart hook fired: after a compaction (`source` compact) it answers with the reminder as
   * additionalContext; any other start, an empty reminder or a failure to read it answers with nothing added. The
   * CLI waits for this answer, so it always goes back.
   */
  async #onHook(hook: { requestId: string; source: string | undefined }): Promise<void> {
    let text: string | undefined
    if (hook.source === 'compact') {
      try {
        text = await this.#o.compactionReminder?.()
      } catch {
        text = undefined
      }
    }
    const out = text !== undefined && text.trim() !== '' ? sessionStartContext(text) : {}
    this.#write(hookResponse(hook.requestId, out))
    if (hook.source === 'compact')
      this.#signals.emit({
        type: 'meta',
        key: META_COMPACTION_REMINDER,
        value: { sent: Object.keys(out).length > 0 },
      })
  }

  /** Send a get_context_usage request (summary detail); its answer becomes the normalizer's breakdown signals. */
  #askContext(at: 'start' | 'end'): string {
    const id = newRequestId('ctx')
    this.#n.expectContextUsage(id, at)
    this.#write(contextUsageRequest(id))
    return id
  }

  #awaitReply(requestId: string, timeoutMs: number): Promise<ControlReply | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#replyWaiters.delete(requestId)
        resolve(undefined)
      }, timeoutMs)
      this.#replyWaiters.set(requestId, (r) => {
        clearTimeout(timer)
        this.#replyWaiters.delete(requestId)
        resolve(r)
      })
    })
  }

  async #readStdout(child: ChildHandle): Promise<void> {
    for await (const line of child.lines('stdout')) this.#apply(this.#n.line(line))
  }

  async #readStderr(child: ChildHandle): Promise<void> {
    for await (const line of child.lines('stderr')) this.#n.stderr(line)
  }

  #apply(step: NormalizeStep): void {
    for (const s of step.signals) this.#signals.emit(s)
    for (const e of step.events) {
      // A failure that quotes an allowed server or skill (the CLI's own error text) keeps the name hidden. A warning
      // (Dim Factory's own words, such as an allowed server that did not connect) names it, as a tool row does.
      this.#events.emit(
        e.type === 'error' && e.fatal && this.#level === 'allowed'
          ? { ...e, message: this.#redact(e.message), raw: this.#redact(e.raw) }
          : e,
      )
    }
    for (const f of step.stdin) this.#write(f)
    if (step.hook !== undefined) void this.#onHook(step.hook)
    if (step.reply !== undefined) this.#replyWaiters.get(step.reply.requestId)?.(step.reply)
    if (step.reply !== undefined && step.reply.requestId === this.#contextEndId) this.#contextOver()
    if (step.planCaptured === true && this.#planTimer === undefined) {
      this.#planTimer = setTimeout(() => {
        if (!this.#n.sawResult) void this.#hardStop()
      }, this.#timing.planResultMs)
      this.#planTimer.unref()
    }
    if (step.result === true || this.#n.terminal) this.#wakeResultWaiters()
    if (step.abort === true) void this.#hardStop()
    this.#watchBackground(step)
    this.#maybeCloseStdin()
  }

  /**
   * An answer waiting on background work: the pass ends with the CLI's follow-up turn when the work finishes, or with
   * the answer it has if no turn follows (or the wait runs out). stdin stays open meanwhile: closing it ends a one-shot
   * session and kills its background tasks.
   */
  #watchBackground(step: NormalizeStep): void {
    if (!this.#n.waiting) {
      this.#clearWaitTimers()
      return
    }
    const finish = (): void => this.#apply(this.#n.finishHeld())
    if (this.#waitTimer === undefined) {
      this.#waitTimer = setTimeout(finish, this.#timing.backgroundMs)
      this.#waitTimer.unref()
    }
    if (step.drained === true) {
      if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer)
      this.#drainTimer = setTimeout(finish, this.#timing.drainedMs)
      this.#drainTimer.unref()
    } else if (step.events.length > 0 && this.#drainTimer !== undefined) {
      // The follow-up turn started: it ends the pass with its own result.
      clearTimeout(this.#drainTimer)
      this.#drainTimer = undefined
    }
  }

  #clearWaitTimers(): void {
    if (this.#waitTimer !== undefined) clearTimeout(this.#waitTimer)
    if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer)
    this.#waitTimer = this.#drainTimer = undefined
  }

  #write(frame: StdinFrame): void {
    const child = this.#child
    if (child === undefined || this.#stdinClosed) return
    this.#writeChain = this.#writeChain.then(() => child.writeLine(frame)).catch(() => false)
  }

  #closeStdin(): void {
    const child = this.#child
    if (child === undefined || this.#stdinClosed) return
    this.#stdinClosed = true
    this.#writeChain = this.#writeChain.then(() => child.closeStdin()).catch(() => undefined)
  }

  /**
   * Close stdin after the first result, once no asks are pending and no background work is awaited. A pass that ended
   * with its answer first asks for the end-of-pass context breakdown (StartOptions.contextBreakdown) and keeps the
   * session open until it is answered or {@link RunTiming.contextUsageMs} runs out.
   */
  #maybeCloseStdin(): void {
    if (this.#n.waiting) return
    if (!((this.#n.sawResult || this.#n.terminal) && this.#n.pendingAsks().length === 0)) return
    if (this.#contextEnd === 'none' && this.#o.contextBreakdown === true && this.#n.succeeded) {
      const child = this.#child
      if (
        child !== undefined &&
        child.exitInfo() === null &&
        !this.#stdinClosed &&
        this.#stopping === undefined
      ) {
        this.#contextEnd = 'asked'
        this.#contextEndId = this.#askContext('end')
        this.#contextTimer = setTimeout(() => this.#contextOver(), this.#timing.contextUsageMs)
        this.#contextTimer.unref()
        return
      }
    }
    if (this.#contextEnd === 'asked') return
    this.#closeStdin()
  }

  /** The end-of-pass breakdown was answered (or not in time): the session may close. */
  #contextOver(): void {
    if (this.#contextTimer !== undefined) clearTimeout(this.#contextTimer)
    this.#contextTimer = undefined
    if (this.#contextEnd !== 'asked') return
    this.#contextEnd = 'over'
    this.#maybeCloseStdin()
  }

  #wakeResultWaiters(): void {
    const ws = this.#resultWaiters
    this.#resultWaiters = []
    for (const w of ws) w()
  }

  #waitForResult(ms: number): Promise<void> {
    if (this.#n.sawResult || this.#n.terminal) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.#resultWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // ---- stop / finish --------------------------------------------------------------------------------------

  #stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#child
    if (child === undefined) {
      // Still resolving: #launch sees #stoppedBy and finishes without spawning.
      this.#stopping = this.exited.then(() => undefined)
      return this.#stopping
    }
    if (child.exitInfo() !== null) return this.exited.then(() => undefined)
    this.#stopping = (async () => {
      await stopChild(child, {
        graceful: async () => {
          if (this.#userSent && !this.#n.sawResult && !this.#n.terminal) {
            this.#write(interruptRequest(newRequestId('stop')))
            await this.#waitForResult(this.#timing.stopResultMs)
          }
          this.#closeStdin()
          await this.#writeChain
        },
        gracefulWaitMs: this.#timing.stopResultMs,
        stdinWaitMs: this.#timing.stopStdinMs,
      })
      await this.exited
    })()
    return this.#stopping
  }

  /** Internal kill (handshake drift, plan-result timeout, fail-fast): close stdin, then kill the tree. */
  #hardStop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#child
    if (child === undefined || child.exitInfo() !== null) return Promise.resolve()
    this.#closeStdin()
    this.#stopping = stopChild(child, { stdinWaitMs: 500 }).then(() => undefined)
    return this.#stopping
  }

  #stopFailure(): Failure {
    const kind = KILL_FOR_REASON[this.#stoppedBy ?? 'user']
    return (
      classify({ vendor: CLAUDE_VENDOR, appInitiated: { kind }, now: this.#deps.now() }) ??
      makeFailure('user_cancelled', 'Dim Factory is shutting down.', { classifiedBy: 'app' })
    )
  }

  /**
   * Allowed list: the allowed servers' definitions, copied from the user's Claude settings into a file only this user
   * may read (0600, in the run's private folder), for `--mcp-config`. Its env values may be secrets: they are written
   * here and nowhere else, and the file is deleted once the process is gone. Undefined when no allowed server is
   * defined any more (preflight says so): the pass then runs with no MCP server.
   */
  async #writeMcpConfig(
    env: Record<string, string | undefined>,
  ): Promise<{ file: string; names: string[] } | undefined> {
    const o = this.#o
    const names = o.extensions?.mcp ?? []
    if (names.length === 0) return undefined
    const servers: Record<string, Record<string, unknown>> = claudeMcpDefinitions({
      env,
      home: this.#deps.home,
      cwd: o.cwd,
      names,
    })
    // An allowed name the settings do not define may be a claude.ai connector: an explicit `claudeai-proxy` entry,
    // which the CLI connects under strict MCP (C22c).
    const missing = names.filter((n) => servers[n] === undefined)
    if (missing.length > 0 && this.#deps.connectors !== undefined) {
      const connectors = await this.#deps.connectors().catch(() => [])
      for (const c of connectors) if (missing.includes(c.name)) servers[c.name] = { ...c.def }
    }
    if (Object.keys(servers).length === 0) return undefined
    const dir = o.extensions?.scratchDir ?? join(tmpdir(), 'dim-factory-mcp')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `mcp-${newUuid()}.json`)
    writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600, flag: 'wx' })
    return { file, names: Object.keys(servers) }
  }

  #removeMcpConfig(): void {
    const file = this.#mcpConfigFile
    if (file === undefined) return
    this.#mcpConfigFile = undefined
    try {
      rmSync(file, { force: true })
    } catch {
      // Swept with the run folder's scratch files later.
    }
  }

  /**
   * The raw-log tap with the names of the user's MCP servers, skills and subagents hidden, at every level (the run
   * view's tool rows keep them).
   */
  #tap(tap: NonNullable<StartOptions['tap']>): NonNullable<StartOptions['tap']> {
    const redact = this.#redact
    return (dir, line) => tap(dir, redact(line))
  }

  #failBeforeSpawn(failure: Failure): void {
    this.#removeMcpConfig()
    this.#preSpawnTerminal = true
    this.#finished = true
    this.#events.emit(errorEvent(failure, true))
    this.#resolveExited({
      code: null,
      signal: null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#deps.now() - this.#startedAt,
    })
  }

  /** A bug in the adapter itself: end the attempt with one terminal error instead of hanging. */
  #internalFailure(err: unknown): void {
    if (this.#finished) return
    this.#removeMcpConfig()
    const message = err instanceof Error ? err.message : String(err)
    if (!this.#n.terminal && !this.#preSpawnTerminal) {
      this.#preSpawnTerminal = true
      this.#events.emit(
        errorEvent(
          makeFailure('unknown', `Claude adapter error: ${message}`, { classifiedBy: 'heuristic' }),
          true,
        ),
      )
    }
    const child = this.#child
    if (child !== undefined && child.exitInfo() === null)
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    this.#finished = true
    this.#resolveExited({
      code: child?.exitInfo()?.code ?? null,
      signal: child?.exitInfo()?.signal ?? null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#deps.now() - this.#startedAt,
    })
  }

  /**
   * Plan-file hygiene: once the process is gone, delete the plan file Claude wrote for the plan this
   * pass captured (only this pass's own copy of the same text); report anything left in a `planFiles` note.
   */
  #cleanPlanFiles(): void {
    const capture = this.#n.planCapture()
    const child = this.#child
    if (this.claudeRoute !== 'plan' || capture === undefined || child === undefined) return
    try {
      const result = cleanPlanFiles({
        capture,
        plansDir: join(this.#configDir, 'plans'),
        home: this.#deps.home,
        spawnAtMs: child.spawnAt,
        ...(this.#deps.planFiles !== undefined ? { ops: this.#deps.planFiles } : {}),
      })
      const note = planFilesNote(result, this.#deps.home)
      if (note !== undefined) this.#signals.emit(note)
    } catch {
      // Hygiene never fails a pass.
    }
  }

  #finish(code: number | null, signal: string | null, ms: number): void {
    if (this.#finished) return
    this.#finished = true
    this.#removeMcpConfig()
    if (this.#planTimer !== undefined) clearTimeout(this.#planTimer)
    if (this.#contextTimer !== undefined) clearTimeout(this.#contextTimer)
    this.#clearWaitTimers()
    for (const w of [...this.#replyWaiters.values()]) w(undefined)
    this.#wakeResultWaiters()
    const sawTerminal = this.#n.terminal || this.#preSpawnTerminal
    this.#apply(this.#n.end({ code, signal, ranMs: ms }))
    this.#cleanPlanFiles()
    this.#resolveExited({
      code,
      signal,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal,
      ranMs: ms,
    })
  }
}
