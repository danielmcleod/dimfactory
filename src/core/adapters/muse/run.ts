// One Muse pass: `muse exec --json --prompt-file <file> [--trust-workspace] --disable-approval|--yolo`.
// Dim Factory writes the prompt file before the spawn (never argv), closes stdin at once, reads one record per
// stdout line, and never answers anything: exec has no relay, so the engine's stall timer is the safety net. Spawned
// through src/core/proc only, with no shell.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AdapterSignal, AskDecision, NormalizedEvent, Usage } from '../../../shared/events.ts'
import type { Failure } from '../../../shared/failure.ts'
import { newRequestId } from '../../../shared/ids.ts'
import type { AppKill } from '../../heal/classify.ts'
import { classify } from '../../heal/classify.ts'
import type { EnvInput } from '../../proc/env.ts'
import { stopChild } from '../../proc/kill.ts'
import type { ResolvedCli } from '../../proc/resolve-cli.ts'
import { SpawnError, spawnChild } from '../../proc/spawn.ts'
import type { ChildHandle } from '../../proc/spawn.ts'
import { isDimFactoryOwnedCwd } from '../acp-base/trust.ts'
import { AdapterError, BufferedEmitter, classifyFailure, makeFailure } from '../errors.ts'
import type { AskCancelReason, ExitInfo, RunHandle, StartOptions, StopReason, Unsubscribe } from '../types.ts'
import type { MuseTiming } from './capabilities.ts'
import { museEffectiveMode, museSupport } from './capabilities.ts'
import { MUSE_DISPLAY_NAME, MUSE_VENDOR } from './cli-spec.ts'
import {
  MUSE_MODEL_ID,
  museArgv,
  museEnv,
  museExtraArgsProblem,
  museFlagMapProblem,
  musePromptFile,
  musePromptText,
} from './launch.ts'
import { MuseNormalizer } from './normalize.ts'
import type { MuseStep } from './normalize.ts'

export type MuseSpawnHook = (
  o: StartOptions,
  child: Pick<ChildHandle, 'pid' | 'pgid' | 'spawnAt' | 'command' | 'realCommand' | 'argv'>,
) => void | Promise<void>

export interface MuseRunDeps {
  /** The CLI to spawn; rejects with an AdapterError (cli_missing) when there is none. */
  resolve(): Promise<ResolvedCli>
  baseEnv: EnvInput
  pathEnv(): Promise<string | undefined>
  /** `vendors.muse.env` (user config); StartOptions.env is layered on top. */
  vendorEnv?: Record<string, string> | undefined
  /** DIM_FACTORY_HOME: the prompt file goes under its `runs/<id>/prompts/`. */
  dimFactoryHome: string
  now: () => number
  timing: MuseTiming
  /** After spawn, before anything else (the engine records procs.json here). */
  onSpawn?: MuseSpawnHook | undefined
  /** A number per process, for the prompt file's name. */
  seq: number
}

const KILL_FOR_REASON: Record<StopReason, AppKill> = {
  user: 'stop',
  timeout: 'hard',
  shutdown: 'quit',
  loop: 'loop',
}

export class MuseRun implements RunHandle {
  readonly id: string
  readonly vendor = MUSE_VENDOR
  readonly route = 'exec' as const
  readonly exited: Promise<ExitInfo>
  /** The argv after the binary's prefix args (set once the launch is built). */
  argv: string[] = []
  /** The prompt file Muse reads (set once written). */
  promptFile: string | undefined

  readonly #o: StartOptions
  readonly #deps: MuseRunDeps
  readonly #n: MuseNormalizer
  readonly #events = new BufferedEmitter<NormalizedEvent>()
  readonly #signals = new BufferedEmitter<AdapterSignal>()
  readonly #startedAt: number
  #child: ChildHandle | undefined
  #stoppedBy: StopReason | undefined
  #stopping: Promise<void> | undefined
  #finished = false
  #resolveExited: (e: ExitInfo) => void = () => undefined

  constructor(o: StartOptions, deps: MuseRunDeps) {
    this.id = newRequestId('muse')
    this.#o = o
    this.#deps = deps
    this.#startedAt = deps.now()
    this.#n = new MuseNormalizer({ step: o.step, mode: o.mode, cwd: o.cwd, model: o.model, now: deps.now })
    this.exited = new Promise((resolve) => {
      this.#resolveExited = resolve
    })
    this.#launch().catch((err: unknown) => this.#internalFailure(err))
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
    return this.#n.sessionId()
  }

  cumulativeUsage(): Usage | undefined {
    return this.#n.cumulativeUsage()
  }

  /** exec relays nothing: there is never an ask. */
  pendingAsks(): string[] {
    return []
  }

  /** exec relays nothing: there is never an ask to answer. */
  answer(_requestId: string, _decision: AskDecision, _why?: AskCancelReason): void {}

  stop(reason: StopReason): Promise<void> {
    this.#stoppedBy ??= reason
    this.#n.markKilled(KILL_FOR_REASON[reason])
    if (this.#stopping !== undefined) return this.#stopping
    const child = this.#child
    if (child === undefined) {
      this.#stopping = this.exited.then(() => undefined)
      return this.#stopping
    }
    // No graceful step on this route: stdin is already closed, so the tree is killed after a short wait.
    this.#stopping = stopChild(child, { stdinWaitMs: this.#deps.timing.stopStdinMs }).then(() =>
      this.exited.then(() => undefined),
    )
    return this.#stopping
  }

  // ---- launch -----------------------------------------------------------------------------------------------------

  /** Why this pass may not start, before anything is spawned (undefined: go on). */
  preSpawnProblem(): Failure | undefined {
    const o = this.#o
    const support = museSupport({ pass: o.step, mode: o.mode })
    if (support.status === 'unsupported' || museEffectiveMode(o.step, o.mode) === 'readonly') {
      return makeFailure('capability_missing', support.copy, { classifiedBy: 'app' })
    }
    const flags = museExtraArgsProblem(o.extraArgs) ?? museFlagMapProblem(o.flagMap)
    if (flags !== undefined) return makeFailure('config_invalid', flags, { classifiedBy: 'app' })
    if (o.model !== undefined && o.model !== null && o.model !== '' && !MUSE_MODEL_ID.test(o.model)) {
      return makeFailure(
        'config_invalid',
        `"${o.model}" is not a model name ${MUSE_DISPLAY_NAME} can be given.`,
        {
          classifiedBy: 'app',
        },
      )
    }
    // Readiness `trust`: Muse works in a user folder only with the user's vendorFolder grant (the engine's
    // StartOptions.trustFolder). Never run it there without one: --yolo would trust the folder on its own.
    if (!o.trustFolder && !isDimFactoryOwnedCwd(o.cwd, this.#deps.dimFactoryHome)) {
      return makeFailure(
        'trust_required',
        `${MUSE_DISPLAY_NAME} needs your OK for this folder. Trust this folder for ${MUSE_DISPLAY_NAME}, then retry.`,
        { classifiedBy: 'app' },
      )
    }
    return undefined
  }

  async #launch(): Promise<void> {
    const o = this.#o
    const problem = this.preSpawnProblem()
    if (problem !== undefined) {
      this.#failBeforeSpawn(problem)
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
    // The prompt is a file Muse reads, written whole before the spawn; never argv.
    let promptFile: string
    try {
      promptFile = musePromptFile(this.#deps.dimFactoryHome, o.runId, o.step, this.#deps.seq)
      mkdirSync(dirname(promptFile), { recursive: true })
      writeFileSync(promptFile, musePromptText(o), { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      this.#failBeforeSpawn(
        makeFailure(
          code === 'ENOSPC' ? 'disk_full' : 'unknown',
          `Dim Factory could not write the prompt file for ${MUSE_DISPLAY_NAME}: ${err instanceof Error ? err.message : String(err)}`,
          { classifiedBy: 'app' },
        ),
      )
      return
    }
    this.promptFile = promptFile
    this.argv = museArgv({
      promptFile,
      step: o.step,
      mode: o.mode,
      model: o.model,
      trust: o.trustFolder,
      extraArgs: o.extraArgs,
      flagMap: o.flagMap,
    })
    let child: ChildHandle
    try {
      child = await spawnChild({
        cli,
        args: this.argv,
        cwd: o.cwd,
        env: museEnv(this.#deps.baseEnv, {
          path,
          pathPrepend: cli.pathPrepend,
          vendorEnv: { ...this.#deps.vendorEnv, ...o.env },
        }),
        label: { purpose: 'pass', runId: o.runId, step: o.step },
        ...(o.tap !== undefined ? { tap: o.tap } : {}),
      })
    } catch (err) {
      const e = SpawnError.from(err, cli.command)
      this.#failBeforeSpawn(
        classifyFailure({
          vendor: MUSE_VENDOR,
          errno: { code: e.code, message: e.message, ...(e.path !== undefined ? { path: e.path } : {}) },
          now: this.#deps.now(),
        }),
      )
      return
    }
    this.#child = child
    // Nothing goes to stdin: closed at once, so an exec that reads piped input gets EOF instead of waiting.
    child.closeStdin()
    const out = this.#readStdout(child).catch((err: unknown) => this.#internalFailure(err))
    const err = this.#drainStderr(child)
    await this.#afterSpawn(child)
    if (this.#stoppedBy !== undefined) {
      // A stop that came while spawning only waited for the exit: now there is a process to stop.
      this.#stopping = undefined
      void this.stop(this.#stoppedBy)
    }
    const exit = await child.exited
    await Promise.all([out, err])
    this.#finish(exit.code, exit.signal, exit.ms, () =>
      this.#n.end({ code: exit.code, signal: exit.signal, ranMs: exit.ms, stderrTail: child.stderrTail(20) }),
    )
  }

  async #afterSpawn(child: ChildHandle): Promise<void> {
    const hook = this.#deps.onSpawn
    if (hook === undefined) return
    const { pid, pgid, spawnAt, command, realCommand, argv } = child
    try {
      await hook(this.#o, { pid, pgid, spawnAt, command, realCommand, argv })
    } catch {
      // Bookkeeping must not fail the pass.
    }
  }

  async #readStdout(child: ChildHandle): Promise<void> {
    for await (const line of child.lines('stdout')) this.#apply(this.#n.line(line))
  }

  async #drainStderr(child: ChildHandle): Promise<void> {
    try {
      for await (const _ of child.lines('stderr')) {
        // the tail is kept by spawn.ts
      }
    } catch {
      // the stream ended with the process
    }
  }

  #apply(step: MuseStep): void {
    for (const s of step.signals) this.#signals.emit(s)
    for (const e of step.events) {
      this.#events.emit(e)
      if (e.type === 'session' && this.#o.onSession !== undefined) {
        // exec has already started its turn: the id is recorded as soon as it is known.
        void this.#o.onSession(e.id).catch(() => undefined)
      }
    }
    if (step.terminalRecord === true) this.#armExitTimer()
  }

  /** After its terminal record Muse should exit; one that lingers (cleanup stalled, 1.4.2) is stopped. */
  #armExitTimer(): void {
    const child = this.#child
    if (child === undefined) return
    void delay(this.#deps.timing.exitAfterTerminalMs, undefined, { ref: false }).then(() => {
      if (child.exitInfo() !== null) return
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    })
  }

  #stopFailure(): Failure {
    const kind = KILL_FOR_REASON[this.#stoppedBy ?? 'user']
    return (
      classify({ vendor: MUSE_VENDOR, appInitiated: { kind }, now: this.#deps.now() }) ??
      makeFailure('user_cancelled', 'Dim Factory is shutting down.', { classifiedBy: 'app' })
    )
  }

  #failBeforeSpawn(failure: Failure): void {
    if (this.#finished) return
    this.#finished = true
    this.#apply(this.#n.fail(failure))
    this.#resolveExited({
      code: null,
      signal: null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#deps.now() - this.#startedAt,
    })
  }

  /** A bug in the adapter itself: one terminal error and the process stopped, never a hang. */
  #internalFailure(err: unknown): void {
    if (this.#finished) return
    this.#apply(
      this.#n.fail(
        makeFailure('unknown', `Muse adapter error: ${err instanceof Error ? err.message : String(err)}`, {
          classifiedBy: 'heuristic',
        }),
      ),
    )
    this.#finished = true
    const child = this.#child
    if (child !== undefined && child.exitInfo() === null)
      void stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
    this.#resolveExited({
      code: child?.exitInfo()?.code ?? null,
      signal: child?.exitInfo()?.signal ?? null,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal: true,
      ranMs: this.#deps.now() - this.#startedAt,
    })
  }

  /** The process is gone: the terminal event when none was emitted, then `exited`. */
  #finish(code: number | null, signal: string | null, ms: number, end: () => MuseStep): void {
    if (this.#finished) return
    this.#finished = true
    const sawTerminal = this.#n.terminal
    this.#apply(end())
    this.#resolveExited({
      code,
      signal,
      ...(this.#stoppedBy !== undefined ? { stoppedBy: this.#stoppedBy } : {}),
      sawTerminal,
      ranMs: ms,
    })
  }
}
