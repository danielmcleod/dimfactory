// Deps install for an isolated run (Prepare step 3, deps detection;
// deps_missing). The same safe execution as a verify command: the `deps` grant is checked
// again right before anything spawns (nothing runs untrusted; Auto never implies trust), argv[0] resolves like a
// verify command (PATH first for package managers; corepack for a pnpm/yarn `packageManager`), no shell (a win32
// .cmd/.bat through win-cmd.ts batchInvocation), the sanitized env + CI=1 NO_COLOR=1 TERM=dumb, stdin ignored, a 15 min
// budget for the whole install then a tree kill, Stop (`signal`) kills the running command's tree. Output goes to
// runs/<id>/prepare/deps.log (first 1 MB + last 4 MB per command) and live.log (the PrepareCard's live view: the last
// 256 KB, current within 200 ms).
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { HomePaths } from '../home.ts'
import type { EnvInput } from '../proc/env.ts'
import { stopChild } from '../proc/kill.ts'
import { resolvePathEnv, splitPathList } from '../proc/path-env.ts'
import { procRecordFor } from '../proc/proc-table.ts'
import type { ProcTable } from '../proc/proc-table.ts'
import { SpawnError, spawnChild } from '../proc/spawn.ts'
import type { ChildHandle, StdStream } from '../proc/spawn.ts'
import { batchInvocation } from '../proc/win-cmd.ts'
import { displayArgv } from '../verify/argv.ts'
import { classifyEnvFailure } from '../verify/classify.ts'
import { cwdRelOf } from '../verify/discover.ts'
import { ExcerptCollector, cleanLine } from '../verify/excerpt.ts'
import { CappedLog, LiveTail } from '../verify/log.ts'
import { formatTimeout, formatVerifyDuration } from '../verify/render.ts'
import { resolveCommand } from '../verify/resolve-cmd.ts'
import type { ResolvedCommand } from '../verify/resolve-cmd.ts'
import { verifyChildEnv } from '../verify/run.ts'
import { planCommands } from './detectDeps.ts'
import type { DepsPlan } from './detectDeps.ts'
import { checkDepsTrust } from './trust.ts'

/** The install's budget, then a tree kill. */
export const DEPS_INSTALL_TIMEOUT_MS = 15 * 60_000

/** A line of output longer than this is logged as its first 256 bytes and its size. */
const MAX_LINE_BYTES = 1024 * 1024

/**
 * `pass`; `fail` (it ran and failed, or timed out); `env` (a program it needs was not found: deps_missing);
 * `skipped` (Stop, an argument cmd.exe cannot take literally, or trust cannot cover what it runs);
 * `skipped-untrusted` (no `deps` grant for this command and these files: nothing ran).
 */
export type InstallStatus = 'pass' | 'fail' | 'env' | 'skipped' | 'skipped-untrusted'

export interface InstallStepResult {
  argv: string[]
  status: InstallStatus
  exitCode: number | null
  durationMs: number
  reason?: string
  timedOut?: boolean
}

export interface InstallResult {
  status: InstallStatus
  /** The command that decided the status (the one that failed, else the install command). */
  argv: string[]
  exitCode: number | null
  /** All commands together. */
  durationMs: number
  /** The deciding command's last lines plus error lines (at most 4 KB); '' for a pass or nothing run. */
  excerpt: string
  /** The commands that started or were refused, in order. */
  steps: InstallStepResult[]
  /** runs/<id>/prepare/deps.log */
  logPath: string
  /** runs/<id>/prepare/live.log */
  liveLog: string
  /** UI copy: why it failed, could not run or was not run. */
  reason?: string
  timedOut?: boolean
  /** `skipped-untrusted`: no grant at all, or one for other files (`changed`); `invalid`: trust cannot cover it. */
  trust?: 'untrusted' | 'changed' | 'invalid'
  /** The grant hash and body read right before it ran (the consent card grants exactly these). */
  hash?: string
  body?: string
  /** `changed`: the body the existing grant covers. */
  grantedBody?: string | null
  /** pnpm or yarn ran through corepack (not on PATH, named by package.json#packageManager). */
  viaCorepack?: boolean
}

export type InstallOutputEvent =
  | { type: 'start'; index: number; argv: string[] }
  /** One output line (ANSI and control characters removed). */
  | { type: 'line'; index: number; stream: StdStream; line: string }
  | { type: 'end'; index: number; step: InstallStepResult }

export interface InstallDeps {
  /** DIM_FACTORY_HOME: logs go to runs/<id>/prepare/. */
  paths: HomePaths
  /** The resolved PATH (path-env). Default: resolvePathEnv(). */
  pathEnv?: string
  /** The env the child's is built from (sanitized). Default: process.env. */
  env?: EnvInput
  /** The SOURCE folder's grants (a worktree has another folder key), read right before the install. */
  grants: () => Promise<TrustGrants>
  /** procs.json: each child is recorded (step `prepare`) for the relaunch sweep. */
  procTable?: ProcTable
  platform?: NodeJS.Platform
}

export interface InstallOptions {
  runId: string
  /** The worktree's root: `cwdRel` and `sources` are relative to it. */
  root: string
  plan: DepsPlan
  /** Default 15 min for the whole install. */
  timeoutMs?: number
  onOutput?: (e: InstallOutputEvent) => void
  /** live.log was written; a reader now sees the output written before it. */
  onOutputWritten?: () => void
  /** Stop: the running command's tree is killed and nothing after it runs. */
  signal?: AbortSignal
}

/** runs/<id>/prepare/ */
export function prepareLogDir(paths: HomePaths, runId: string): string {
  return join(paths.run(runId).dir, 'prepare')
}

/** runs/<id>/prepare/deps.log and live.log */
export function depsLogPaths(paths: HomePaths, runId: string): { log: string; live: string } {
  const dir = prepareLogDir(paths, runId)
  return { log: join(dir, 'deps.log'), live: join(dir, 'live.log') }
}

function emit(onOutput: InstallOptions['onOutput'], e: InstallOutputEvent): void {
  if (onOutput === undefined) return
  try {
    onOutput(e)
  } catch {
    // a listener's failure never stops the install
  }
}

/** Both logs, written together; a command's section ends with its footer. */
class InstallLog {
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
  async endSection(): Promise<void> {
    await Promise.all([this.#log.endSection(), this.#live.flush()])
  }
  async close(): Promise<void> {
    await Promise.all([this.#log.close(), this.#live.close()])
  }
}

interface Program {
  resolved: ResolvedCommand
  args: string[]
  viaCorepack: boolean
}

/** Where a step's program runs from; pnpm/yarn named by packageManager fall back to `corepack <pm>`. */
function programFor(
  argv: readonly string[],
  plan: DepsPlan,
  o: { cwd: string; root: string; pathEntries: string[]; platform: NodeJS.Platform },
): Program | null {
  const argv0 = argv[0] ?? ''
  const opts = { cwd: o.cwd, root: o.root, pathEntries: o.pathEntries, platform: o.platform }
  const hit = resolveCommand(argv0, opts)
  if (hit !== null) return { resolved: hit, args: argv.slice(1), viaCorepack: false }
  if (plan.corepack === true && argv0 === plan.manager) {
    const corepack = resolveCommand('corepack', opts)
    if (corepack !== null) return { resolved: corepack, args: [...argv], viaCorepack: true }
  }
  return null
}

/** Run the plan's commands (see the header). Never throws for a command's failure. */
export async function runInstall(deps: InstallDeps, opts: InstallOptions): Promise<InstallResult> {
  const root = resolve(opts.root)
  const plan = opts.plan
  const platform = deps.platform ?? process.platform
  const paths = depsLogPaths(deps.paths, opts.runId)
  await mkdir(prepareLogDir(deps.paths, opts.runId), { recursive: true })
  await Promise.all(
    [paths.log, paths.live].map((p) =>
      rm(p, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined),
    ),
  )
  const written = opts.onOutputWritten
  const log = new InstallLog(
    await CappedLog.open(paths.log),
    new LiveTail(paths.live, written !== undefined ? { onFlushed: written } : {}),
  )
  const steps: InstallStepResult[] = []
  const base = { logPath: paths.log, liveLog: paths.live, steps }
  const commands = planCommands(plan)
  const signalled = (): boolean => opts.signal?.aborted === true

  const notRun = async (
    status: InstallStatus,
    reason: string,
    extra: Partial<InstallResult> = {},
  ): Promise<InstallResult> => {
    log.write(`$ ${displayArgv(plan.argv)}\n[not run: ${reason}]\n`)
    await log.endSection()
    await log.close()
    return {
      ...base,
      status,
      argv: [...plan.argv],
      exitCode: null,
      durationMs: 0,
      excerpt: '',
      reason,
      ...extra,
    }
  }

  const cwd = resolve(root, plan.cwdRel)
  if (cwdRelOf(root, cwd) === null) return notRun('skipped', 'Its folder is outside the project')
  if (signalled()) return notRun('skipped', 'Stopped before it ran')

  // Trust, against the files as they are in the run's copy now (Auto never implies trust).
  const grants = await deps.grants().catch((): TrustGrants => ({}))
  const t = await checkDepsTrust(root, plan, grants)
  if (t.trust === 'invalid') return notRun('skipped', t.error, { trust: 'invalid' })
  const trustFacts = { hash: t.hash, body: t.body }
  if (t.trust !== 'trusted') {
    const changed = t.trust === 'changed'
    return notRun(
      'skipped-untrusted',
      changed ? 'Its files changed since you allowed it' : 'Not allowed yet',
      {
        ...trustFacts,
        trust: changed ? 'changed' : 'untrusted',
        ...(changed ? { grantedBody: t.grantedBody ?? null } : {}),
      },
    )
  }

  const pathValue = deps.pathEnv ?? (await resolvePathEnv()).path
  const pathEntries = splitPathList(pathValue, platform)
  const deadline = Date.now() + (opts.timeoutMs ?? DEPS_INSTALL_TIMEOUT_MS)
  const timeoutText = formatTimeout(opts.timeoutMs ?? DEPS_INSTALL_TIMEOUT_MS)
  let total = 0
  let viaCorepack = false

  for (const [index, argv] of commands.entries()) {
    if (signalled()) {
      log.write(`$ ${displayArgv(argv)}\n[not run: Stopped before it ran]\n`)
      await log.close()
      return {
        ...base,
        ...trustFacts,
        status: 'skipped',
        argv: [...argv],
        exitCode: null,
        durationMs: total,
        excerpt: '',
        reason: 'Stopped before it ran',
      }
    }
    const one = await runStep(index, argv, {
      plan,
      root,
      cwd,
      platform,
      pathValue,
      pathEntries,
      deps,
      opts,
      log,
      remainingMs: Math.max(0, deadline - Date.now()),
      timeoutText,
    })
    steps.push(one.step)
    total += one.step.durationMs
    viaCorepack ||= one.viaCorepack
    if (one.step.status !== 'pass') {
      await log.close()
      return {
        ...base,
        ...trustFacts,
        status: one.step.status,
        argv: [...argv],
        exitCode: one.step.exitCode,
        durationMs: total,
        excerpt: one.excerpt,
        ...(one.step.reason !== undefined ? { reason: one.step.reason } : {}),
        ...(one.step.timedOut === true ? { timedOut: true } : {}),
        ...(viaCorepack ? { viaCorepack: true } : {}),
      }
    }
  }
  await log.close()
  return {
    ...base,
    ...trustFacts,
    status: 'pass',
    argv: [...plan.argv],
    exitCode: 0,
    durationMs: total,
    excerpt: '',
    ...(viaCorepack ? { viaCorepack: true } : {}),
  }
}

interface StepContext {
  plan: DepsPlan
  root: string
  cwd: string
  platform: NodeJS.Platform
  pathValue: string
  pathEntries: string[]
  deps: InstallDeps
  opts: InstallOptions
  log: InstallLog
  remainingMs: number
  timeoutText: string
}

interface StepOutcome {
  step: InstallStepResult
  excerpt: string
  viaCorepack: boolean
}

async function runStep(index: number, argv: readonly string[], ctx: StepContext): Promise<StepOutcome> {
  const { opts, log } = ctx
  const argv0 = argv[0] ?? ''
  const header = `$ ${displayArgv(argv)}${ctx.plan.cwdRel !== '.' ? `   (in ${ctx.plan.cwdRel})` : ''}\n`
  log.write(header)
  emit(opts.onOutput, { type: 'start', index, argv: [...argv] })
  const finish = async (step: InstallStepResult, excerpt = '', viaCorepack = false): Promise<StepOutcome> => {
    log.write(`[${footerText(step)}]\n\n`)
    await log.endSection()
    emit(opts.onOutput, { type: 'end', index, step })
    return { step, excerpt, viaCorepack }
  }
  const base = { argv: [...argv] }

  if (ctx.remainingMs <= 0) {
    return finish({
      ...base,
      status: 'fail',
      exitCode: null,
      durationMs: 0,
      timedOut: true,
      reason: `Timed out after ${ctx.timeoutText}`,
    })
  }
  const program = programFor(argv, ctx.plan, ctx)
  if (program === null) {
    const reason = existsSync(ctx.cwd)
      ? `Dim Factory could not find ${argv0}`
      : 'Its working folder does not exist'
    return finish({ ...base, status: 'env', exitCode: null, durationMs: 0, reason })
  }
  if (program.viaCorepack) log.write(`(${argv0} is not on PATH: running it through corepack)\n`)

  const env = verifyChildEnv(ctx.deps.env ?? process.env, ctx.pathValue, ctx.cwd)
  const excerpt = new ExcerptCollector()
  let inv: { command: string; args: string[]; windowsVerbatimArguments: boolean } = {
    command: program.resolved.path,
    args: program.args,
    windowsVerbatimArguments: false,
  }
  let child: ChildHandle
  const spawnStarted = Date.now()
  try {
    // A batch file runs through cmd.exe; batchInvocation refuses what no escape keeps literal there (EARGV).
    if (program.resolved.batch) inv = batchInvocation(program.resolved.path, program.args, { env })
    child = await spawnChild({
      command: inv.command,
      args: inv.args,
      cwd: ctx.cwd,
      env,
      label: { purpose: 'verify', runId: opts.runId, step: 'prepare' },
      stdin: 'ignore',
      maxLineBytes: MAX_LINE_BYTES,
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
  } catch (err) {
    const e = SpawnError.from(err, inv.command)
    const durationMs = Date.now() - spawnStarted
    if (e.code === 'EARGV') {
      return finish({ ...base, status: 'skipped', exitCode: null, durationMs, reason: e.message })
    }
    const reason =
      classifyEnvFailure({ exitCode: null, spawnError: e.code, tail: [], cwd: ctx.cwd, argv0 }) ?? e.message
    return finish({ ...base, status: 'env', exitCode: null, durationMs, reason })
  }

  const rec = await ctx.deps.procTable?.add(procRecordFor(child, 'prepare', 'verify')).catch(() => undefined)
  let timedOut = false
  let stopping = false
  const killing: { p: Promise<unknown> | null } = { p: null }
  const kill = (): void => {
    killing.p ??= stopChild(child, { stdinWaitMs: 0 }).catch(() => undefined)
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, ctx.remainingMs)
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
      excerpt.push(raw)
      emit(opts.onOutput, { type: 'line', index, stream, line: cleanLine(raw) })
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
  const v = program.viaCorepack
  if (timedOut) {
    return finish(
      {
        ...base,
        status: 'fail',
        exitCode: null,
        durationMs,
        timedOut: true,
        reason: `Timed out after ${ctx.timeoutText}`,
      },
      excerpt.excerpt(),
      v,
    )
  }
  if (stopping) {
    return finish(
      { ...base, status: 'skipped', exitCode: null, durationMs, reason: 'Stopped before it finished' },
      '',
      v,
    )
  }
  if (exit.code === 0) return finish({ ...base, status: 'pass', exitCode: 0, durationMs }, '', v)
  const envReason = classifyEnvFailure({ exitCode: exit.code, tail: excerpt.tail(), cwd: ctx.cwd, argv0 })
  if (envReason !== null) {
    return finish(
      { ...base, status: 'env', exitCode: exit.code, durationMs, reason: envReason },
      excerpt.excerpt(),
      v,
    )
  }
  const reason =
    exit.code === null && exit.signal !== null
      ? `Ended by ${exit.signal}`
      : `${displayArgv(argv)} failed with exit ${exit.code ?? '?'}`
  return finish({ ...base, status: 'fail', exitCode: exit.code, durationMs, reason }, excerpt.excerpt(), v)
}

function footerText(s: InstallStepResult): string {
  const took = formatVerifyDuration(s.durationMs)
  switch (s.status) {
    case 'pass':
      return `done in ${took}`
    case 'fail':
      return s.timedOut === true
        ? (s.reason ?? 'timed out')
        : `failed${s.exitCode !== null ? ` with exit ${s.exitCode}` : ''} after ${took}`
    case 'env':
      return `could not run: ${s.reason ?? 'a program it needs is missing'}`
    case 'skipped':
    case 'skipped-untrusted':
      return `not run: ${s.reason ?? s.status}`
  }
}
