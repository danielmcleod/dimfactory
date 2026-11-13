// `isolation.verifyReady` (Prepare step 5; deps_missing):
// after deps, every enabled verify command's argv[0] must resolve in the worktree (PATH, node_modules/.bin, .venv,
// repo wrappers), or Verify would only find out after Implement. A failure opens verifyEnv before
// Implement. Evaluated in prepare, never in the live preflight (the worktree does not exist yet there).
import { resolve } from 'node:path'
import type { ResolvedConfig } from '../../shared/config-schema.ts'
import type { RecoveryAction } from '../../shared/failure.ts'
import type { CheckResult } from '../../shared/preflight.ts'
import { resolvePathEnv, splitPathList } from '../proc/path-env.ts'
import { displayArgv } from '../verify/argv.ts'
import { configCommands, programName } from '../verify/discover.ts'
import { resolveCommand } from '../verify/resolve-cmd.ts'
import { uniqueNames } from './baseline.ts'

export const VERIFY_READY_CHECK_ID = 'run.isolation.verifyReady'

export interface VerifyReadyCommand {
  name: string
  argv: string[]
  /** Relative to the worktree's root. */
  cwdRel: string
  /** Where argv[0] runs from in the worktree; null: not found (or it cannot run as configured: `error`). */
  resolved: string | null
  error?: string
}

export interface VerifyReadyReport {
  ok: boolean
  commands: VerifyReadyCommand[]
  /** The commands whose program was not found. */
  missing: VerifyReadyCommand[]
  /** UI copy for the verifyEnv card ("Verify cannot run in the run's copy: test needs vitest, …"); '' when ok. */
  reason: string
}

export interface VerifyReadyOptions {
  /** The run's folder inside the worktree. */
  worktreeFolder: string
  /** The worktree's root. */
  worktreeRoot: string
  /** The resolved PATH. Default: resolvePathEnv(). */
  pathEnv?: string
  platform?: NodeJS.Platform
}

/** Whether readiness applies: an isolated run with Verify on and a round to run. */
export function wantsVerifyReady(config: Pick<ResolvedConfig, 'verify' | 'isolation'>): boolean {
  return config.isolation.mode === 'worktree' && config.verify.enabled && config.verify.runAfter.length > 0
}

/**
 * Each enabled verify command's argv[0], resolved in the worktree. A command that cannot run as configured is left to
 * run.verify (it is not a readiness problem); one whose program is not found makes the report not ok.
 */
export async function checkVerifyReady(
  config: Pick<ResolvedConfig, 'verify'>,
  opts: VerifyReadyOptions,
): Promise<VerifyReadyReport> {
  const platform = opts.platform ?? process.platform
  const root = resolve(opts.worktreeRoot)
  const enabled = (
    await configCommands(config.verify.commands, { folder: opts.worktreeFolder, scopeRoot: root })
  ).filter((c) => c.enabledByDefault)
  const names = uniqueNames(enabled.map((c) => c.name))
  let entries: string[] | undefined
  const commands: VerifyReadyCommand[] = []
  for (const [i, c] of enabled.entries()) {
    const base = { name: names[i] ?? c.name, argv: [...c.run], cwdRel: c.cwdRel }
    if (c.error !== undefined || c.run.length === 0) {
      commands.push({ ...base, resolved: null, error: c.error ?? 'It has no command to run' })
      continue
    }
    entries ??= splitPathList(opts.pathEnv ?? (await resolvePathEnv({ platform })).path, platform)
    const hit = resolveCommand(c.run[0] ?? '', {
      cwd: resolve(root, c.cwdRel),
      root,
      pathEntries: entries,
      platform,
    })
    commands.push({ ...base, resolved: hit?.path ?? null })
  }
  const missing = commands.filter((c) => c.error === undefined && c.resolved === null)
  const reason =
    missing.length === 0
      ? ''
      : `Verify cannot run in the run's copy: ${missing
          .map((m) => `${m.name} needs ${programName(m.argv[0] ?? m.name)}`)
          .join(', ')}. Install the project's dependencies (or set the install command), then Retry.`
  return { ok: missing.length === 0, commands, missing, reason }
}

const installCommandLink: RecoveryAction = {
  id: `${VERIFY_READY_CHECK_ID}.installCommand`,
  label: 'Set the install command',
  kind: 'settings_link',
  route: 'settings/isolation',
  pointer: '/isolation/worktree/installCommand',
}

/** The report as a run-scope CheckResult (`run.isolation.verifyReady`, category deps_missing when it fails). */
export function verifyReadyResult(report: VerifyReadyReport, at: number): CheckResult {
  const base = {
    id: VERIFY_READY_CHECK_ID,
    scope: 'run' as const,
    title: 'Verify can run in the run’s copy',
    at,
    ttlMs: 0,
  }
  if (report.ok) {
    const n = report.commands.filter((c) => c.error === undefined).length
    return {
      ...base,
      status: 'pass',
      blocking: false,
      detail: `${n} ${n === 1 ? 'command' : 'commands'} found after installing dependencies.`,
      recovery: [],
    }
  }
  const lines = report.missing.map(
    (m) =>
      `\`${displayArgv(m.argv)}\`${m.cwdRel !== '.' ? ` (in ${m.cwdRel})` : ''} needs ${m.argv[0] ?? m.name}`,
  )
  return {
    ...base,
    title:
      report.missing.length === 1
        ? `The ${report.missing[0]?.name ?? ''} check cannot find ${report.missing[0]?.argv[0] ?? 'its program'} in the run’s copy`
        : `${report.missing.length} checks cannot find their programs in the run’s copy`,
    status: 'fail',
    blocking: true,
    category: 'deps_missing',
    detail: `${lines.join('\n')}\nDim Factory looked on PATH, in node_modules/.bin, in .venv and for project wrappers.`,
    recovery: [installCommandLink],
  }
}
