// Verify round execution (runner steps, R7, R11).
//
// For each command, in order: re-read its body and check the grant (nothing runs untrusted; Auto never implies
// trust), resolve argv[0] (resolve-cmd.ts), spawn through src/core/proc without a shell (a win32 .cmd/.bat through
// cmd.exe with every argument escaped), env = the sanitized env + CI=1 NO_COLOR=1 TERM=dumb, stdin ignored, its
// timeout (600 s by default) then a tree kill. Output goes to runs/<id>/verify/<round>/<n>-<name>.log (first 1 MB +
// last 4 MB) and to the round's combined output.log; the excerpt and the environment-failure check come from it. The
// live view reads live.log (the last 256 KB of everything, current within 200 ms; output.log reaches the
// disk past a command's first 1 MB only when it ends).
// failFast stops the round at the first failure. Stop (`signal`) kills the running command's tree; the rest are not
// run. A rerun of the round (Resume) starts over in a cleared folder.
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { VerifyCommandResult, VerifyResultStatus } from '../../shared/verify.ts'
import { VERIFY_DEFAULT_TIMEOUT_MS } from '../../shared/verify.ts'
import { chaosPoint } from '../chaos.ts'
import { trustGrantsFor } from '../config/trust.ts'
import type { HomePaths } from '../home.ts'
import { sanitizeEnv } from '../proc/env.ts'
import type { EnvInput } from '../proc/env.ts'
import { stopChild } from '../proc/kill.ts'
import { resolvePathEnv, splitPathList } from '../proc/path-env.ts'
import { procRecordFor } from '../proc/proc-table.ts'
import type { ProcTable } from '../proc/proc-table.ts'
import { SpawnError, spawnChild } from '../proc/spawn.ts'
import type { ChildHandle, StdStream } from '../proc/spawn.ts'
import { batchInvocation } from '../proc/win-cmd.ts'
import { displayArgv } from './argv.ts'
import { classifyEnvFailure, envFailureHint } from './classify.ts'
import { cwdRelOf, readCommandBody } from './discover.ts'
import { ExcerptCollector, cleanLine } from './excerpt.ts'
import { CappedLog, LiveTail } from './log.ts'
import { formatTimeout, formatVerifyDuration } from './render.ts'
import { localBinDirs, resolveCommand } from './resolve-cmd.ts'
import { argvOfCommand, trustOf } from './trust.ts'
import { isPageloadArgv } from '../../shared/pageload.ts'
import { isPlaytestArgv } from '../../shared/playtest.ts'
import { runPageload } from './pageload.ts'
import type { PageChecker } from './pageload.ts'
import { runPlaytest } from './playtest.ts'
import type { Playtester } from './playtest.ts'

/**
 * The verify rounds (verify:0 is the isolated-run baseline), and the security scan's dependency audits, which run
 * through the same trusted-command runner.
 */
export type VerifyRoundKey = 'verify:0' | 'verify:red' | 'verify:1' | 'verify:2' | 'scan'

/** A line of output longer than this is logged as its first 256 bytes and its size. */
const MAX_LINE_BYTES = 1024 * 1024

/**
 * A command of a round. Takes a DetectedCommand (argv in `run`) or the engine's form (`argv`, with `run: false` for
 * a command it decided not to run: its `status` / `reason` are reported as its result).
 */
export interface VerifyRoundCommand {
  name: string
  run?: readonly string[] | boolean
  argv?: readonly string[]
  /** Relative to the round's root (`scopeRoot`, else `folder`). */
  cwdRel: string
  timeoutMs?: number
  /** `run: false`: the result to report. */
  status?: 'skipped-untrusted' | 'skipped'
  reason?: string
  /** DetectedCommand.error: it cannot run as configured (reported `skipped` with this reason). */
  error?: string
}

export type VerifyOutputEvent =
  | { type: 'start'; index: number; name: string; argv: string[] }
  /** One output line (ANSI and control characters removed). */
  | { type: 'line'; index: number; name: string; stream: StdStream; line: string }
  | { type: 'end'; index: number; result: VerifyCommandResult }

export interface VerifyDeps {
  /** DIM_FACTORY_HOME: logs go to runs/<id>/verify/<round>/, grants are read from trust.json. */
  paths: HomePaths
  /** The resolved PATH (path-env) for argv[0] and every child. Default: resolvePathEnv(). */
  pathEnv?: string
  /** The env the child's is built from (sanitized). Default: process.env. */
  env?: EnvInput
  /**
   * The folder's grants, read at the start of the round. Default: trust.json under `paths.home` for the scope root.
   * An isolated run passes the source folder's: a worktree's own root has another folder key.
   */
  grants?: () => Promise<TrustGrants>
  /** procs.json: each child is recorded (step = the round, transport `verify`) for the relaunch sweep. */
  procTable?: ProcTable
  /**
   * Dim Factory's own play-test (PLAYTEST_ARGV): the app's play-tester (main plays the game in its sandboxed preview).
   * Absent (the command-line tool): the command reports "not checked here".
   */
  playtest?: Playtester
  /**
   * Dim Factory's own page-load check (`dimf:pageload <page>`): the app opens the page in its sandboxed preview.
   * Absent (the command-line tool): the command reports "not checked here".
   */
  pageload?: PageChecker
}

export interface VerifyRoundOptions {
  runId: string
  round: VerifyRoundKey
  /** The run's folder (a worktree's, for an isolated run). */
  folder: string
  /** The root `cwdRel` and grants are relative to (the scope root). Default: `folder`. */
  scopeRoot?: string
  commands: readonly VerifyRoundCommand[]
  failFast: boolean
  /** Default for commands without their own; default 600 s. */
  timeoutMs?: number
  onOutput?: (e: VerifyOutputEvent) => void
  /**
   * The round's live output file (live.log, what runs.output `verify:<n>` serves) was written; a reader
   * now sees the output written before it.
   */
  onOutputWritten?: () => void
  /** Stop: the running command's tree is killed and the remaining commands are not run. */
  signal?: AbortSignal
  /**
   * Whether the run's own added lines import a module (classify.ts): a missing package the run introduced is the
   * code's failure, never an environment problem. Absent: nothing is known of the run's lines.
   */
  introduced?: (name: string) => boolean
  /**
   * Where the round's logs go instead of runs/<id>/verify/<round>/ (a build run for sharing, outside any run's
   * folder). The folder is cleared first, as a round's always is.
   */
  logDir?: string
}

export interface VerifyRoundResult {
  /** One per command, in order. */
  results: VerifyCommandResult[]
  /** failFast stopped the round after a failure (the rest read `skipped`). */
  aborted?: boolean
  /** Stop ended the round (the command it killed and the rest read `skipped`). */
  stopped?: boolean
  /** runs/<id>/verify/<round>/ */
  logDir: string
  /** The round's combined output (each command's capped like its own log). */
  outputLog: string
  /** The live view's file: the last 256 KB of the round's output, kept current while it runs (LiveTail). */
  liveLog?: string
}

/** The round's combined output: the capped record (output.log) and the live view (live.log), written together. */
class RoundOutput {
  readonly #log: CappedLog
  readonly #live: LiveTail

  constructor(log: CappedLog, live: LiveTail) {
    this.#log = log
    this.#live = live
  }

  write(text: string): void {
    this.#log.write(text)
    this.#live.write(text)
  }

  /** A command's section is over: its tail is written and the live view is current. */
  async endSection(): Promise<void> {
    await Promise.all([this.#log.endSection(), this.#live.flush()])
  }

  async close(): Promise<void> {
    await Promise.all([this.#log.close(), this.#live.close()])
  }
}

/** runs/<id>/verify/<round>/ */
export function verifyRoundDir(paths: HomePaths, runId: string, round: VerifyRoundKey): string {
  return paths.run(runId).verify(round)
}

/** A command's log name: `<n>-<name>.log`, the name reduced to safe characters. */
export function verifyLogName(n: number, name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${n}-${slug === '' ? 'command' : slug}.log`
}

/** The child's env: sanitized, project bins first on PATH, CI=1 NO_COLOR=1 TERM=dumb, no forced colour. */
export function verifyChildEnv(base: EnvInput, path: string, cwd: string): Record<string, string> {
  const env = sanitizeEnv(base, {
    purpose: 'verify',
    path,
    pathPrepend: localBinDirs(cwd).filter((d) => existsSync(d)),
    extra: { CI: '1', NO_COLOR: '1', TERM: 'dumb' },
  })
  // FORCE_COLOR beside NO_COLOR makes Node warn on every start and colours some tools anyway.
  for (const k of Object.keys(env)) {
    if (/^(?:FORCE_COLOR|CLICOLOR_FORCE)$/i.test(k)) delete env[k]
  }
  return env
}

function emit(onOutput: VerifyRoundOptions['onOutput'], e: VerifyOutputEvent): void {
  if (onOutput === undefined) return
  try {
    onOutput(e)
  } catch {
    // a listener's failure never stops the round
  }
}

interface RunOne {
  index: number
  name: string
  argv: string[]
  cwdRel: string
  cwd: string
  timeoutMs: number
}

/** Run every command of a round (see the header). Never throws for a command's failure. */
export async function runVerifyRound(deps: VerifyDeps, opts: VerifyRoundOptions): Promise<VerifyRoundResult> {
  const root = resolve(opts.scopeRoot ?? opts.folder)
  const logDir = opts.logDir ?? verifyRoundDir(deps.paths, opts.runId, opts.round)
  await rm(logDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
  await mkdir(logDir, { recursive: true })
  const outputLog = join(logDir, 'output.log')
  const liveLog = join(logDir, 'live.log')
  const written = opts.onOutputWritten
  const roundLog = new RoundOutput(
    await CappedLog.open(outputLog),
    new LiveTail(liveLog, written !== undefined ? { onFlushed: written } : {}),
  )

  const grants = await (
    deps.grants ??
    (() => trustGrantsFor(opts.folder, { home: deps.paths.home, folderScope: { scopeRoot: root } }))
  )().catch((): TrustGrants => ({}))
  const pathValue = deps.pathEnv ?? (await resolvePathEnv()).path
  const pathEntries = splitPathList(pathValue)
  const baseEnv = deps.env ?? process.env

  const results: VerifyCommandResult[] = []
  let aborted = false
  // A function, so the check is read again after each await (TypeScript would keep an earlier narrowing).
  const signalled = (): boolean => opts.signal?.aborted === true
  let stopped = signalled()
  let failedName: string | null = null

  const notRun = async (
    index: number,
    name: string,
    argv: readonly string[],
    status: VerifyResultStatus,
    extra: Partial<VerifyCommandResult> = {},
  ): Promise<VerifyCommandResult> => {
    const result: VerifyCommandResult = {
      name,
      argv: [...argv],
      status,
      exitCode: null,
      durationMs: 0,
      excerpt: '',
      logPath: '',
      ...extra,
    }
    roundLog.write(
      `$ ${argv.length > 0 ? displayArgv(argv) : name}\n[not run: ${result.reason ?? status}]\n\n`,
    )
    await roundLog.endSection()
    emit(opts.onOutput, { type: 'end', index, result })
    return result
  }

  for (const [index, c] of opts.commands.entries()) {
    const argv = argvOfCommand(c)
    if (stopped || signalled()) {
      stopped = true
      results.push(await notRun(index, c.name, argv, 'skipped', { reason: 'Stopped before it ran' }))
      continue
    }
    if (aborted) {
      const reason = `Not run: failFast stopped the round after ${failedName ?? 'a command'} failed`
      results.push(await notRun(index, c.name, argv, 'skipped', { reason }))
      continue
    }
    if (c.run === false) {
      const status = c.status ?? 'skipped'
      const extra: Partial<VerifyCommandResult> = c.reason !== undefined ? { reason: c.reason } : {}
      if (status === 'skipped-untrusted' && argv.length > 0) {
        const t = trustOf(c, (await readCommandBody(root, c)).body, grants)
        extra.trust = t.trust === 'changed' ? 'changed' : 'untrusted'
      }
      results.push(await notRun(index, c.name, argv, status, extra))
      continue
    }
    if (c.error !== undefined || argv.length === 0) {
      const reason = c.error ?? 'It has no command to run'
      results.push(await notRun(index, c.name, argv, 'skipped', { reason }))
      continue
    }
    const cwd = resolve(root, c.cwdRel)
    if (cwdRelOf(root, cwd) === null) {
      results.push(
        await notRun(index, c.name, argv, 'skipped', { reason: 'Its folder is outside the project' }),
      )
      continue
    }
    // Dim Factory's own checks: the play-test and the page-load check, never spawned, no grant.
    if (isPlaytestArgv(argv) || isPageloadArgv(argv)) {
      const result = await runBuiltinOne(
        { index, name: c.name, argv, cwdRel: c.cwdRel, cwd, timeoutMs: 0 },
        { deps, opts, root, logDir, roundLog, pathValue, pathEntries, baseEnv },
      )
      results.push(result)
      if (result.status === 'skipped' && signalled()) stopped = true
      if (result.status === 'fail' && opts.failFast) {
        aborted = true
        failedName = c.name
      }
      continue
    }
    // Trust, against the body as it is now (Implement or Fix may have changed the script). A body trust cannot cover
    // any more (another package's scripts, an include only make can name) is never run.
    const read = await readCommandBody(root, c)
    if (read.error !== undefined) {
      results.push(await notRun(index, c.name, argv, 'skipped', { reason: read.error }))
      continue
    }
    const check = trustOf(c, read.body, grants)
    if (check.trust !== 'trusted') {
      const changed = check.trust === 'changed'
      results.push(
        await notRun(index, c.name, argv, 'skipped-untrusted', {
          trust: changed ? 'changed' : 'untrusted',
          reason: changed ? 'Changed since it was trusted' : 'Not trusted',
        }),
      )
      continue
    }
    const result = await runOne(
      {
        index,
        name: c.name,
        argv,
        cwdRel: c.cwdRel,
        cwd,
        timeoutMs: c.timeoutMs ?? opts.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS,
      },
      { deps, opts, root, logDir, roundLog, pathValue, pathEntries, baseEnv },
    )
    results.push(result)
    if (result.status === 'skipped' && signalled()) stopped = true
    if (result.status === 'fail' && opts.failFast) {
      aborted = true
      failedName = c.name
    }
  }
  await roundLog.close()
  return {
    results,
    ...(aborted ? { aborted: true } : {}),
    ...(stopped ? { stopped: true } : {}),
    logDir,
    outputLog,
    liveLog,
  }
}

interface RoundContext {
  deps: VerifyDeps
  opts: VerifyRoundOptions
  root: string
  logDir: string
  roundLog: RoundOutput
  pathValue: string
  pathEntries: string[]
  baseEnv: EnvInput
}

async function runOne(cmd: RunOne, ctx: RoundContext): Promise<VerifyCommandResult> {
  const { opts, roundLog } = ctx
  const argv0 = cmd.argv[0] ?? ''
  const shown = displayArgv(cmd.argv)
  const logPath = join(ctx.logDir, verifyLogName(cmd.index + 1, cmd.name))
  const log = await CappedLog.open(logPath)
  const header = `$ ${shown}${cmd.cwdRel !== '.' ? `   (in ${cmd.cwdRel})` : ''}\n`
  log.write(header)
  roundLog.write(header)
  emit(opts.onOutput, { type: 'start', index: cmd.index, name: cmd.name, argv: [...cmd.argv] })

  const base = { name: cmd.name, argv: [...cmd.argv], logPath }
  const finish = async (result: VerifyCommandResult): Promise<VerifyCommandResult> => {
    const footer = `[${footerText(result)}]\n`
    log.write(footer)
    roundLog.write(`${footer}\n`)
    await Promise.all([log.close(), roundLog.endSection()])
    emit(opts.onOutput, { type: 'end', index: cmd.index, result })
    return result
  }

  const resolved = resolveCommand(argv0, { cwd: cmd.cwd, root: ctx.root, pathEntries: ctx.pathEntries })
  if (resolved === null) {
    const reason = existsSync(cmd.cwd)
      ? `Dim Factory could not find ${argv0}`
      : 'Its working folder does not exist'
    return finish({ ...base, status: 'env', exitCode: null, durationMs: 0, excerpt: '', reason })
  }

  const env = verifyChildEnv(ctx.baseEnv, ctx.pathValue, cmd.cwd)
  const excerpt = new ExcerptCollector()

  let child: ChildHandle
  let inv: { command: string; args: string[]; windowsVerbatimArguments: boolean } = {
    command: resolved.path,
    args: cmd.argv.slice(1),
    windowsVerbatimArguments: false,
  }
  const spawnStarted = Date.now()
  try {
    // A batch file runs through cmd.exe; batchInvocation refuses what no escape keeps literal there (EARGV).
    if (resolved.batch) inv = batchInvocation(resolved.path, cmd.argv.slice(1), { env })
    child = await spawnChild({
      command: inv.command,
      args: inv.args,
      cwd: cmd.cwd,
      env,
      label: { purpose: 'verify', runId: opts.runId, step: opts.round },
      stdin: 'ignore',
      maxLineBytes: MAX_LINE_BYTES,
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
  } catch (err) {
    const e = SpawnError.from(err, inv.command)
    const durationMs = Date.now() - spawnStarted
    if (e.code === 'EARGV') {
      return finish({
        ...base,
        status: 'skipped',
        exitCode: null,
        durationMs,
        excerpt: '',
        reason: e.message,
      })
    }
    const reason =
      classifyEnvFailure({ exitCode: null, spawnError: e.code, tail: [], cwd: cmd.cwd, argv0 }) ?? e.message
    return finish({ ...base, status: 'env', exitCode: null, durationMs, excerpt: '', reason })
  }

  chaosPoint('verify:spawned')
  const rec = await ctx.deps.procTable?.add(procRecordFor(child, opts.round, 'verify')).catch(() => undefined)
  chaosPoint('verify:recorded')

  let timedOut = false
  let stopping = false
  // An object, so the kill started by a timer or an abort is seen after the awaits below.
  const killing: { p: Promise<unknown> | null } = { p: null }
  const kill = (): void => {
    killing.p ??= stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, cmd.timeoutMs)
  const onAbort = (): void => {
    stopping = true
    kill()
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted === true) onAbort()

  const pump = async (stream: StdStream): Promise<void> => {
    for await (const r of child.records(stream)) {
      const raw = r.kind === 'line' ? r.line : `${r.head}… [a line of ${r.bytes} bytes]`
      log.write(`${raw}\n`)
      roundLog.write(`${raw}\n`)
      excerpt.push(raw)
      emit(opts.onOutput, { type: 'line', index: cmd.index, name: cmd.name, stream, line: cleanLine(raw) })
    }
  }
  const pumps = Promise.all([pump('stdout'), pump('stderr')])
  const exit = await child.exited
  await pumps
  clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)
  if (killing.p !== null) await killing.p
  if (rec !== undefined) {
    await ctx.deps.procTable
      ?.markExit(rec.id, {
        code: exit.code,
        signal: exit.signal,
        at: Date.now(),
        how: killing.p !== null ? 'killed' : 'exited',
      })
      .catch(() => undefined)
  }

  const durationMs = exit.ms
  const tail = excerpt.tail()
  if (timedOut) {
    return finish({
      ...base,
      status: 'fail',
      exitCode: null,
      durationMs,
      excerpt: excerpt.excerpt(),
      timedOut: true,
      reason: `Timed out after ${formatTimeout(cmd.timeoutMs)}`,
    })
  }
  if (stopping) {
    return finish({
      ...base,
      status: 'skipped',
      exitCode: null,
      durationMs,
      excerpt: '',
      reason: 'Stopped before it finished',
    })
  }
  if (exit.code === 0) return finish({ ...base, status: 'pass', exitCode: 0, durationMs, excerpt: '' })
  const classifyInput = {
    exitCode: exit.code,
    tail,
    cwd: cmd.cwd,
    argv0,
    ...(opts.introduced !== undefined ? { introduced: opts.introduced } : {}),
  }
  const envReason = classifyEnvFailure(classifyInput)
  if (envReason !== null) {
    return finish({
      ...base,
      status: 'env',
      exitCode: exit.code,
      durationMs,
      excerpt: excerpt.excerpt(),
      reason: envReason,
    })
  }
  // A failure whose output also names something missing stays a failure; the line is its hint.
  const hint = envFailureHint(classifyInput)
  const reason =
    exit.code === null && exit.signal !== null
      ? `Ended by ${exit.signal}`
      : hint !== null
        ? `It failed; its output also says: ${hint}`
        : undefined
  return finish({
    ...base,
    status: 'fail',
    exitCode: exit.code,
    durationMs,
    excerpt: excerpt.excerpt(),
    ...(reason !== undefined ? { reason } : {}),
  })
}

/** A built-in check as one command of the round: its own log and the round's, like a spawned command's. */
async function runBuiltinOne(cmd: RunOne, ctx: RoundContext): Promise<VerifyCommandResult> {
  const { opts, roundLog } = ctx
  const logPath = join(ctx.logDir, verifyLogName(cmd.index + 1, cmd.name))
  const log = await CappedLog.open(logPath)
  const header = `$ ${displayArgv(cmd.argv)}${cmd.cwdRel !== '.' ? `   (in ${cmd.cwdRel})` : ''}\n`
  log.write(header)
  roundLog.write(header)
  emit(opts.onOutput, { type: 'start', index: cmd.index, name: cmd.name, argv: [...cmd.argv] })
  const write = (text: string): void => {
    log.write(text)
    roundLog.write(text)
    for (const line of text.split('\n')) {
      if (line === '') continue
      emit(opts.onOutput, {
        type: 'line',
        index: cmd.index,
        name: cmd.name,
        stream: 'stdout',
        line: cleanLine(line),
      })
    }
  }
  const r = isPageloadArgv(cmd.argv)
    ? await runPageload({
        name: cmd.name,
        argv: cmd.argv,
        cwd: cmd.cwd,
        write,
        checker: ctx.deps.pageload,
        signal: opts.signal,
      })
    : await runPlaytest({
        name: cmd.name,
        argv: cmd.argv,
        cwd: cmd.cwd,
        runId: opts.runId,
        logDir: ctx.logDir,
        write,
        playtester: ctx.deps.playtest,
        signal: opts.signal,
      })
  const result: VerifyCommandResult = { ...r, logPath }
  const footer = `[${footerText(result)}]\n`
  log.write(footer)
  roundLog.write(`${footer}\n`)
  await Promise.all([log.close(), roundLog.endSection()])
  emit(opts.onOutput, { type: 'end', index: cmd.index, result })
  return result
}

function footerText(r: VerifyCommandResult): string {
  const took = formatVerifyDuration(r.durationMs)
  switch (r.status) {
    case 'pass':
      return `passed in ${took}`
    case 'fail':
      return r.timedOut === true
        ? `${r.reason ?? 'timed out'}`
        : `failed${r.exitCode !== null ? ` with exit ${r.exitCode}` : ''} after ${took}`
    case 'env':
      return `could not run: ${r.reason ?? 'environment'}`
    case 'skipped':
    case 'skipped-untrusted':
      return `not run: ${r.reason ?? r.status}`
  }
}
