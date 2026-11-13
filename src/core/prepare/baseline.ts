// verify:0 baseline for an isolated run (`verify.baseline`, Isolated only, after deps,
// parallel with Plan; writes runs/<id>/verify/baseline.json {name → pass|fail|env}). The round runs in the worktree
// with the SOURCE folder's grants (a worktree has another folder key), through the verify round runner, so
// trust is checked before each spawn and nothing untrusted runs. A command that fails here and again in verify:1 or
// verify:2 renders "already failing before this run", becomes a [should] (`preexisting`), does not block the Fix skip
// rule and does not make the outcome verify-failed (render.ts verifyFindings / verifyHasMustFailures take the map).
import { join } from 'node:path'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { TrustGrants } from '../../shared/ipc.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'
import type { HomePaths } from '../home.ts'
import { readJsonFile, writeJsonAtomic } from '../store/atomic.ts'
import { configCommands } from '../verify/discover.ts'
import type { VerifyBaseline } from '../verify/render.ts'
import { runVerifyRound } from '../verify/run.ts'
import type { VerifyDeps, VerifyOutputEvent, VerifyRoundCommand, VerifyRoundResult } from '../verify/run.ts'

export type { VerifyBaseline } from '../verify/render.ts'

/** runs/<id>/verify/baseline.json */
export function baselinePath(paths: HomePaths, runId: string): string {
  return join(paths.run(runId).verifyDir, 'baseline.json')
}

/**
 * The baseline map of a round's results: pass, fail and env by command name. A command that did not run (not
 * trusted, skipped, stopped) is left out: nothing is known about it before the run.
 */
export function baselineOf(results: readonly VerifyCommandResult[]): VerifyBaseline {
  const out: Record<string, 'pass' | 'fail' | 'env'> = {}
  for (const r of results) {
    if (r.status === 'pass' || r.status === 'fail' || r.status === 'env') out[r.name] = r.status
  }
  return out
}

/** The same names verify:1 / verify:2 give a round's commands (supervisor/machine.ts uniqueVerifyNames). */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.map((name) => {
    let n = name
    for (let i = 2; seen.has(n); i++) n = `${name} (${i})`
    seen.add(n)
    return n
  })
}

/**
 * The round's commands: every enabled `verify.commands[]` entry read in the worktree (`cwdRel` relative to its root),
 * named as verify:1 names them so the map's keys match. One that cannot run as configured keeps its place with its
 * error (reported `skipped`).
 */
export async function baselineCommands(
  config: Pick<ResolvedConfig, 'verify'>,
  worktreeFolder: string,
  worktreeRoot: string,
): Promise<VerifyRoundCommand[]> {
  const enabled = (
    await configCommands(config.verify.commands, { folder: worktreeFolder, scopeRoot: worktreeRoot })
  ).filter((c) => c.enabledByDefault)
  const names = uniqueNames(enabled.map((c) => c.name))
  return enabled.map((c, i): VerifyRoundCommand => ({
    name: names[i] ?? c.name,
    argv: [...c.run],
    cwdRel: c.cwdRel,
    ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
    ...(c.error !== undefined ? { error: c.error } : {}),
  }))
}

/** Whether this run takes a baseline: Verify on with a round to compare (`runAfter`), `verify.baseline`, Isolated. */
export function wantsBaseline(config: Pick<ResolvedConfig, 'verify' | 'isolation'>): boolean {
  const v = config.verify
  return (
    config.isolation.mode === 'worktree' &&
    v.enabled &&
    v.baseline &&
    v.runAfter.length > 0 &&
    v.commands.some((c) => c.enabled ?? true)
  )
}

export interface BaselineDeps extends Omit<VerifyDeps, 'grants'> {
  /** The SOURCE folder's grants (never the worktree's own folder key). */
  grants: () => Promise<TrustGrants>
  /** Test seam: the round runner. */
  runRound?: typeof runVerifyRound
}

export interface BaselineOptions {
  runId: string
  config: Pick<ResolvedConfig, 'verify'>
  /** The run's folder inside the worktree. */
  worktreeFolder: string
  /** The worktree's root (the scope root its `cwdRel` and bodies are relative to). */
  worktreeRoot: string
  onOutput?: (e: VerifyOutputEvent) => void
  onOutputWritten?: () => void
  signal?: AbortSignal
}

export interface BaselineResult {
  baseline: VerifyBaseline
  round: VerifyRoundResult
  /** runs/<id>/verify/baseline.json */
  path: string
}

/** Run verify:0 in the worktree and write baseline.json. Never throws for a command's failure. */
export async function runBaseline(deps: BaselineDeps, opts: BaselineOptions): Promise<BaselineResult> {
  const commands = await baselineCommands(opts.config, opts.worktreeFolder, opts.worktreeRoot)
  const { runRound, ...rest } = deps
  const round = await (runRound ?? runVerifyRound)(rest, {
    runId: opts.runId,
    round: 'verify:0',
    folder: opts.worktreeFolder,
    scopeRoot: opts.worktreeRoot,
    commands,
    // A baseline wants every command's state, so it never stops at the first failure.
    failFast: false,
    ...(opts.onOutput !== undefined ? { onOutput: opts.onOutput } : {}),
    ...(opts.onOutputWritten !== undefined ? { onOutputWritten: opts.onOutputWritten } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
  const baseline = baselineOf(round.results)
  const path = baselinePath(deps.paths, opts.runId)
  await writeBaseline(deps.paths, opts.runId, baseline)
  return { baseline, round, path }
}

/** Write runs/<id>/verify/baseline.json atomically. */
export async function writeBaseline(
  paths: HomePaths,
  runId: string,
  baseline: VerifyBaseline,
): Promise<void> {
  await writeJsonAtomic(baselinePath(paths, runId), baseline)
}

/**
 * baseline.json as written, or undefined when there is none (an in-place run, a baseline that never ran) or it cannot
 * be read. Entries that are not pass, fail or env are dropped.
 */
export async function readBaseline(paths: HomePaths, runId: string): Promise<VerifyBaseline | undefined> {
  const r = await readJsonFile(baselinePath(paths, runId)).catch(() => null)
  if (r === null || r.kind !== 'ok') return undefined
  const v = r.value
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, 'pass' | 'fail' | 'env'> = {}
  for (const [name, state] of Object.entries(v as Record<string, unknown>)) {
    if (state === 'pass' || state === 'fail' || state === 'env') out[name] = state
  }
  return out
}
