// App-scope checks: app.config.user, app.home.writable, app.disk.home, app.git.
import { statfs } from 'node:fs/promises'
import { basename } from 'node:path'
import type { RecoveryAction } from '../../../shared/failure.ts'
import type { ConfigIssue } from '../../../shared/ipc.ts'
import type { CheckResult } from '../../../shared/preflight.ts'
import { gitInstallCommand } from '../../heal/commands.ts'
import type { OsFamily } from '../../heal/commands.ts'
import { homePaths, probeHomeWritable } from '../../home.ts'
import { sanitizeEnv } from '../../proc/env.ts'
import { compareVersions } from '../../proc/resolve-cli.ts'
import { execCapture } from '../../proc/spawn.ts'
import { LAST_GOOD_POINTER } from '../../recovery/routes.ts'
import type { CheckContext, ConfigFileState, PreflightCheckDef } from '../engine.ts'

const MB = 1024 * 1024
const GB = 1024 * MB

/** Below this git is refused (< 2.17 → B). */
export const GIT_MIN_VERSION = '2.17.0'
/** Below this git lacks security fixes (CVE-2022-24765 safe.directory): W. */
export const GIT_RECOMMENDED_VERSION = '2.35.2'
export const HOME_DISK_BLOCK_BYTES = 500 * MB
export const HOME_DISK_WARN_BYTES = 2 * GB

export type GitVersionResult =
  { ok: true; version: string; raw: string } | { ok: false; reason: 'missing' | 'error'; detail: string }

export type HomeWritableResult = { ok: true } | { ok: false; detail: string }

/** `git version 2.17.1.windows.2` → `2.17.1`. */
export function parseGitVersion(stdout: string): string | undefined {
  return /git version (\d+\.\d+(?:\.\d+)?)/.exec(stdout)?.[1]
}

/** `git --version` through proc (shell-less, git-sanitized env). */
export async function defaultGitVersion(o: { timeoutMs?: number } = {}): Promise<GitVersionResult> {
  const r = await execCapture('git', ['--version'], {
    env: sanitizeEnv(process.env, { purpose: 'git' }),
    timeoutMs: o.timeoutMs ?? 10_000,
  })
  if (r.error !== undefined) {
    const code = r.error.code
    return code === 'ENOENT'
      ? { ok: false, reason: 'missing', detail: 'git was not found on PATH' }
      : { ok: false, reason: 'error', detail: r.error.message }
  }
  if (r.timedOut) return { ok: false, reason: 'error', detail: 'git --version did not answer' }
  const version = parseGitVersion(r.stdout)
  if (r.code !== 0 || version === undefined) {
    return {
      ok: false,
      reason: 'error',
      detail: `git --version: exit ${r.code ?? '?'} ${r.stderr.trim()}`.trim(),
    }
  }
  return { ok: true, version, raw: r.stdout.trim() }
}

/** Free bytes available to this user on the volume holding `path` (null when unknown). */
export async function defaultDiskFree(path: string): Promise<number | null> {
  try {
    const s = await statfs(path)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export async function defaultHomeWritable(home: string): Promise<HomeWritableResult> {
  const r = await probeHomeWritable(homePaths(home))
  if (r.ok) return { ok: true }
  const details = r.error.details as { error?: unknown } | undefined
  return { ok: false, detail: typeof details?.error === 'string' ? details.error : r.error.message }
}

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  if (n >= MB) return `${Math.round(n / MB)} MB`
  return `${Math.round(n / 1024)} KB`
}

export function gitInstallAction(os: OsFamily, reason: string): RecoveryAction {
  const cmd = gitInstallCommand(os)
  return {
    id: 'app.git.install',
    label: 'Copy the git install command',
    kind: 'shell_copy',
    command: cmd.command,
    shell: cmd.shell,
    reason,
    recheck: 'app.git',
  }
}

const clearSnapshots: RecoveryAction = {
  id: 'app.disk.clear-snapshots',
  label: 'Free space: clear old snapshots',
  kind: 'settings_link',
  route: 'settings/storage',
  pointer: '/storage',
}

const always = (): boolean => true

// ---- config files (errors and recovery; shared with folder.project.config) ----------------------------------------

/** Issues listed in one result; the rest are counted. */
const MAX_LISTED_CONFIG_ISSUES = 5

/** `C:\…\dimfactory.json:14:7 Unknown key "modle" (did you mean "model"?)` */
export function formatConfigIssue(i: Pick<ConfigIssue, 'file' | 'line' | 'col' | 'message'>): string {
  return `${i.file}:${i.line}:${i.col} ${i.message}`
}

export function configIssueLines(
  issues: readonly ConfigIssue[],
  max: number = MAX_LISTED_CONFIG_ISSUES,
): string[] {
  const lines = issues.slice(0, max).map(formatConfigIssue)
  if (issues.length > max) lines.push(`… and ${issues.length - max} more`)
  return lines
}

/**
 * Recovery for a config file: open it at its first error (Settings → Config file), and "Restore last good" when an
 * earlier version exists (`config.restoreBackup {backupId: 'last-good'}`: the last-good copy, else the newest backup).
 */
export function configFileRecovery(
  checkId: string,
  file: ConfigFileState,
  folder?: string,
): RecoveryAction[] {
  const first = file.issues.find((i) => i.severity === 'error') ?? file.issues[0]
  const where = { scope: file.scope, path: file.path, ...(folder !== undefined ? { folder } : {}) }
  const out: RecoveryAction[] = [
    {
      id: `${checkId}.open`,
      label:
        first !== undefined
          ? `Open ${basename(file.path)} at line ${first.line}`
          : `Open ${basename(file.path)}`,
      kind: 'settings_link',
      route: 'settings/config',
      pointer: first?.pointer ?? '',
      suggested: { ...where, ...(first !== undefined ? { line: first.line, col: first.col } : {}) },
    },
  ]
  if (file.restorable) {
    out.push({
      id: `${checkId}.restore`,
      label: 'Restore last good',
      kind: 'settings_link',
      route: 'settings/config',
      // Settings → Config file focuses its Restore button for this pointer (the config_invalid snag's link too).
      pointer: LAST_GOOD_POINTER,
      suggested: { ...where, backupId: 'last-good' },
    })
  }
  return out
}

/** One config file's result: errors block (config_invalid), warnings only warn, otherwise pass. */
export function configFileResult(
  ctx: CheckContext,
  checkId: string,
  file: ConfigFileState,
  o: { name: string; blocked: string; folder?: string },
): CheckResult {
  const errors = file.issues.filter((i) => i.severity === 'error')
  const warnings = file.issues.filter((i) => i.severity !== 'error')
  const recovery = configFileRecovery(checkId, file, o.folder)
  if (errors.length > 0) {
    const fix = file.restorable
      ? 'Fix the file, or restore the last version that worked (Restore last good).'
      : 'Fix the file, then re-check.'
    return ctx.result({
      status: 'fail',
      title: `${o.name} has ${errors.length === 1 ? 'an error' : `${errors.length} errors`}`,
      detail: [...configIssueLines(errors), `${o.blocked} ${fix}`].join('\n'),
      category: 'config_invalid',
      recovery,
    })
  }
  if (warnings.length > 0) {
    return ctx.result({
      status: 'warn',
      title: `${o.name} has ${warnings.length === 1 ? 'a warning' : `${warnings.length} warnings`}`,
      detail: configIssueLines(warnings).join('\n'),
      recovery: recovery.filter((a) => a.id.endsWith('.open')),
    })
  }
  return ctx.result({
    status: 'pass',
    detail: file.exists ? file.path : `${file.path} does not exist yet; the built-in settings apply.`,
  })
}

export function appCheckDefs(): PreflightCheckDef[] {
  return [
    {
      id: 'app.config.user',
      scope: 'app',
      title: 'Your settings (dimfactory.json)',
      dependsOn: [],
      cost: 'cheap',
      ttlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: (ctx) => ctx.input.configFiles !== undefined,
      subjectKey: (ctx) => ctx.input.configFiles?.user.path ?? '',
      run(ctx: CheckContext) {
        const file = ctx.input.configFiles?.user
        if (file === undefined) return Promise.resolve([])
        return Promise.resolve(
          configFileResult(ctx, 'app.config.user', file, {
            name: 'Your dimfactory.json',
            blocked: 'Every run is blocked until it is fixed.',
          }),
        )
      },
    },
    {
      id: 'app.home.writable',
      scope: 'app',
      title: 'Dim Factory home folder',
      dependsOn: [],
      cost: 'io',
      ttlMs: 10 * 60_000,
      authoritativeTtlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: always,
      subjectKey: (ctx) => ctx.home,
      async run(ctx: CheckContext) {
        const r = await (ctx.deps.homeWritable ?? defaultHomeWritable)(ctx.home)
        return r.ok
          ? ctx.result({ status: 'pass', detail: ctx.home })
          : ctx.result({
              status: 'fail',
              title: 'Dim Factory cannot write to its home folder',
              detail: `${ctx.home}: ${r.detail}. Check the folder's permissions, or set DIM_FACTORY_HOME to a writable folder.`,
              category: 'disk_full',
            })
      },
    },
    {
      id: 'app.disk.home',
      scope: 'app',
      title: 'Free space for Dim Factory',
      dependsOn: ['app.home.writable'],
      cost: 'io',
      ttlMs: 60_000,
      authoritativeTtlMs: 0,
      modes: ['live', 'authoritative'],
      appliesTo: always,
      subjectKey: (ctx) => ctx.home,
      async run(ctx: CheckContext) {
        const free = await (ctx.deps.diskFree ?? defaultDiskFree)(ctx.home)
        if (free === null) return ctx.result({ status: 'skip', detail: 'Free space could not be read.' })
        const detail = `${formatBytes(free)} free on the drive holding ${ctx.home}.`
        if (free < HOME_DISK_BLOCK_BYTES) {
          return ctx.result({
            status: 'fail',
            title: 'Not enough disk space',
            detail: `${detail} Dim Factory needs at least 500 MB for snapshots and logs.`,
            category: 'disk_full',
            recovery: [clearSnapshots],
          })
        }
        if (free < HOME_DISK_WARN_BYTES) {
          return ctx.result({
            status: 'warn',
            title: 'Disk space is low',
            detail: `${detail} Below 2 GB, snapshots of large folders may fail.`,
            category: 'disk_full',
            recovery: [clearSnapshots],
          })
        }
        return ctx.result({ status: 'pass', detail })
      },
    },
    {
      id: 'app.git',
      scope: 'app',
      title: 'Git',
      dependsOn: [],
      cost: 'spawn',
      ttlMs: 60 * 60_000,
      timeoutMs: { live: 2000 },
      modes: ['live', 'authoritative'],
      appliesTo: always,
      subjectKey: () => 'git',
      async run(ctx: CheckContext) {
        const timeoutMs = ctx.mode === 'live' ? 2000 : 10_000
        const r = await (ctx.deps.gitVersion ?? defaultGitVersion)({
          timeoutMs,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
        if (!r.ok) {
          return r.reason === 'missing'
            ? ctx.result({
                status: 'fail',
                title: 'Git is not installed',
                detail: 'Dim Factory uses git to snapshot and diff every run. Install git, then re-check.',
                category: 'git_missing',
                recovery: [gitInstallAction(ctx.os, 'Git is not installed')],
              })
            : ctx.result({
                status: 'fail',
                title: 'Git could not be started',
                detail: r.detail,
                category: 'git_missing',
                recovery: [gitInstallAction(ctx.os, 'Git could not be started')],
              })
        }
        if (compareVersions(r.version, GIT_MIN_VERSION) < 0) {
          return ctx.result({
            status: 'fail',
            title: `Git ${r.version} is too old`,
            detail: `Dim Factory needs git ${GIT_MIN_VERSION} or newer.`,
            category: 'git_missing',
            recovery: [gitInstallAction(ctx.os, `Git ${r.version} is older than ${GIT_MIN_VERSION}`)],
          })
        }
        if (compareVersions(r.version, GIT_RECOMMENDED_VERSION) < 0) {
          return ctx.result({
            status: 'warn',
            title: `Git ${r.version} is missing security fixes`,
            detail: `Git ${GIT_RECOMMENDED_VERSION} or newer is recommended. Dim Factory works with ${r.version}.`,
            recovery: [gitInstallAction(ctx.os, `Update git to ${GIT_RECOMMENDED_VERSION} or newer`)],
          })
        }
        return ctx.result({ status: 'pass', title: `Git ${r.version}`, detail: r.raw })
      },
    },
  ]
}
