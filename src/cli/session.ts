// CLI ↔ core sessions: the writable core (home lock and recovery; run, resume) and the read-only core (show, runs,
// preflight, doctor), plus the exit codes every command shares.
import { isAbsolute, relative, resolve } from 'node:path'
import type { Core } from '../core/app-core.ts'
import { createCore } from '../core/app-core.ts'
import { stepLabel } from '../core/supervisor/cards.ts'
import { shellArg } from './hints.ts'
import type { CliIo } from './io.ts'
import { BRAND } from '../shared/brand.ts'

export const EXIT = {
  completed: 0,
  failed: 1,
  usage: 2,
  preflightBlocked: 3,
  cancelled: 4,
  paused: 5,
  homeLocked: 6,
  hardInterrupt: 130,
} as const

/**
 * How the user runs this CLI, for copy-paste hints: `pnpm cli` (the package script; not packaged), `node <entry>`
 * when started directly, else `dim-factory`.
 */
export function cliName(io: Pick<CliIo, 'env' | 'cwd'>, entry: string | undefined = process.argv[1]): string {
  if (io.env['npm_lifecycle_event'] === 'cli') return 'pnpm cli'
  if (entry !== undefined && /dimf\.ts$/i.test(entry)) {
    const rel = relative(io.cwd, entry)
    const shown = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : entry
    return `node ${/\s/.test(shown) ? `"${shown}"` : shown}`
  }
  return BRAND.cliName
}

export interface SessionOptions {
  /**
   * Print the "your dimfactory.json has errors" banner (the app's red banner) before the command runs. Default true;
   * commands that report config problems themselves (run, preflight, config) pass false.
   */
  configBanner?: boolean
}

/**
 * The CLI's version of the app's config banner (an invalid user file blocks runs): the errors with
 * file:line:col, and how to restore the last good version when there is one.
 */
export async function printConfigBanner(io: CliIo, core: Core, home: string | undefined): Promise<void> {
  const errors = core.config.user?.issues.filter((i) => i.severity === 'error') ?? []
  if (errors.length === 0) return
  io.err(
    `Your dimfactory.json has ${errors.length === 1 ? 'an error' : `${errors.length} errors`}, so new runs are blocked:`,
  )
  for (const i of errors.slice(0, 5)) io.err(`  ${i.file}:${i.line}:${i.col} ${i.message}`)
  if (errors.length > 5) io.err(`  … and ${errors.length - 5} more`)
  const read = await core.invoke('config.read', { scope: 'user' })
  if (read.ok && read.value.backups.length > 0) {
    io.err(
      `Fix it, or restore the last version that worked: ${cliName(io)} config restore` +
        (home !== undefined ? ` --home ${shellArg(home)}` : ''),
    )
  }
}

/** CLI kind core with the home lock; HOME_LOCKED → exit 6. Always shuts the core down. */
export async function withWritableCore(
  io: CliIo,
  home: string | undefined,
  fn: (core: Core) => Promise<number>,
  o: SessionOptions = {},
): Promise<number> {
  let core: Core
  try {
    core = await createCore({
      host: { kind: 'cli' },
      env: io.env,
      ...(home !== undefined ? { home: resolve(io.cwd, home) } : {}),
    })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'HOME_LOCKED') {
      const d = (err as { details?: { pid?: number; kind?: string } }).details
      io.err(
        `Another Dim Factory process is using this home folder (pid ${d?.pid ?? '?'}, ${d?.kind ?? 'unknown'}). ` +
          'Close it, or pass --home <dir>.',
      )
      return EXIT.homeLocked
    }
    io.err(`dim-factory: ${err instanceof Error ? err.message : String(err)}`)
    return EXIT.failed
  }
  try {
    if (o.configBanner !== false) await printConfigBanner(io, core, home)
    for (const p of core.recovery.paused) {
      io.err(
        `Run #${p.displayNo} was paused because Dim Factory closed (${p.steps.map((s) => stepLabel(s)).join(', ')}). ` +
          `Resume it with: ${cliName(io)} resume ${p.runId}`,
      )
    }
    return await fn(core)
  } finally {
    await core.shutdown()
  }
}

export async function withReadOnlyCore<T>(
  io: CliIo,
  home: string | undefined,
  fn: (core: Core) => Promise<T>,
  o: SessionOptions = {},
): Promise<T> {
  const core = await createCore({
    host: { kind: 'cli' },
    readOnly: true,
    env: io.env,
    ...(home !== undefined ? { home: resolve(io.cwd, home) } : {}),
  })
  try {
    if (o.configBanner !== false) await printConfigBanner(io, core, home)
    return await fn(core)
  } finally {
    await core.shutdown()
  }
}

export function usage(io: CliIo, cmd: string, use: string, err: unknown): number {
  io.err(`dimf ${cmd}: ${err instanceof Error ? err.message : String(err)}`)
  io.err(`usage: ${use}`)
  return EXIT.usage
}

export const when = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')

// ---- show ---------------------------------------------------------------------------------------------------------
