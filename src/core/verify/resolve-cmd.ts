// Verify argv[0] resolution: PATH + PATHEXT, <cwd>/node_modules/.bin,
// <cwd>/.venv/{Scripts|bin} and the repo-root wrappers (gradlew/gradlew.bat, mvnw/mvnw.cmd; ./-prefixed on POSIX).
// Project-local bins come first, as `npm run` and an activated venv would put them first, except for the package
// managers and the other tools resolved via PATH: those come from PATH, and from a local
// bin only when PATH has none. A trust grant covers argv and the script, not the program, so a launcher planted in
// the repository must not take the place of `npm` or `git`. A local bin whose real path leaves the scope root (a
// junctioned node_modules/.bin) is never used.
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { getEnv } from '../proc/env.ts'
import type { EnvInput } from '../proc/env.ts'
import { findOnPath } from '../proc/resolve-cli.ts'
import { isBatchFile } from '../proc/win-cmd.ts'

export type ResolvedVia = 'node_modules' | 'venv' | 'path' | 'wrapper' | 'relative'

export interface ResolvedCommand {
  /** Absolute path of the program to run. */
  path: string
  via: ResolvedVia
  /** win32 .cmd/.bat: it runs through cmd.exe with every argument escaped (proc/win-cmd.ts). */
  batch: boolean
}

export interface ResolveCommandOptions {
  /** The command's working directory. */
  cwd: string
  /** The scope root: repo-root wrappers are looked for in `cwd`, then here. */
  root?: string
  /** The resolved PATH entries (path-env). */
  pathEntries: readonly string[]
  /** For PATHEXT (win32). */
  env?: EnvInput
  platform?: NodeJS.Platform
  /** Test seam: is this a file that can be run (POSIX: executable). */
  isRunnable?: (p: string) => boolean
  /** Test seam: the real path (links and junctions followed); the path itself when it cannot be read. */
  realpath?: (p: string) => string
}

/**
 * Programs resolved via PATH first: the package managers and the fixed tools of the discovery
 * table. A project's own tools (vitest, eslint, pytest, python in a venv…) still come from its local bins first.
 */
export const PATH_FIRST: ReadonlySet<string> = new Set([
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'bun',
  'bunx',
  'corepack',
  'node',
  'git',
  'cargo',
  'go',
  'dotnet',
  'make',
  'gmake',
  'mingw32-make',
  'mvn',
  'gradle',
  'uv',
  'poetry',
])

function defaultRealpath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  gradlew: ['gradlew.bat', 'gradlew.cmd'],
  mvnw: ['mvnw.cmd', 'mvnw.bat'],
}

function defaultRunnable(platform: NodeJS.Platform): (p: string) => boolean {
  return (p) => {
    try {
      if (!statSync(p).isFile()) return false
      if (platform !== 'win32') accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}

const pathMod = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/** The project-local bin folders for `cwd` (node_modules/.bin, then the venv's), whether or not they exist. */
export function localBinDirs(cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = pathMod(platform)
  return [p.join(cwd, 'node_modules', '.bin'), p.join(cwd, '.venv', platform === 'win32' ? 'Scripts' : 'bin')]
}

/** `./gradlew`, `gradlew`, `.\mvnw` … → the wrapper's name; null for anything else. */
function wrapperName(argv0: string): string | null {
  const m = /^(?:\.[\\/])?(gradlew|mvnw)$/i.exec(argv0)
  return m?.[1]?.toLowerCase() ?? null
}

const hasSeparator = (s: string, platform: NodeJS.Platform): boolean =>
  s.includes('/') || (platform === 'win32' && s.includes('\\'))

/** win32 launcher extensions in PATHEXT order, natives first and .exe before .com (resolve-cli's findOnPath rule). */
function winExts(env: EnvInput): string[] {
  const raw = (getEnv(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => ['.exe', '.com', '.cmd', '.bat'].includes(e))
  const natives = raw
    .filter((e) => e === '.exe' || e === '.com')
    .sort((a, b) => (a === '.exe' ? -1 : b === '.exe' ? 1 : 0))
  const scripts = raw.filter((e) => e === '.cmd' || e === '.bat')
  const order = [...natives, ...scripts]
  return order.length > 0 ? order : ['.exe', '.cmd']
}

/**
 * Where `argv0` runs from, or null when it cannot be found (then the command cannot run: an environment failure,
 * never a finding). A path (`./scripts/x`, `bin\tool.exe`) is taken relative to `cwd`; on win32 PATHEXT applies.
 */
export function resolveCommand(argv0: string, opts: ResolveCommandOptions): ResolvedCommand | null {
  const platform = opts.platform ?? process.platform
  const win = platform === 'win32'
  const p = pathMod(platform)
  const env = opts.env ?? process.env
  const runnable = opts.isRunnable ?? defaultRunnable(platform)
  if (argv0 === '') return null
  const done = (path: string, via: ResolvedVia): ResolvedCommand => ({
    path,
    via,
    batch: win && isBatchFile(path),
  })
  const withExts = (base: string): string | null => {
    if (!win) return runnable(base) ? base : null
    if (/\.(?:exe|com|cmd|bat)$/i.test(base)) return runnable(base) ? base : null
    for (const ext of winExts(env)) if (runnable(base + ext)) return base + ext
    return null
  }

  const wrapper = wrapperName(argv0)
  if (wrapper !== null) {
    const dirs = [opts.cwd, ...(opts.root !== undefined ? [opts.root] : [])]
    for (const dir of dirs) {
      const names = win ? (WRAPPERS[wrapper] ?? []) : [wrapper]
      for (const n of names) {
        const full = p.join(dir, n)
        if (runnable(full)) return done(full, 'wrapper')
      }
    }
    // `./gradlew` with no wrapper is a path like any other; a bare `gradlew` may still be on PATH.
    if (argv0.startsWith('.')) return null
  }

  if (hasSeparator(argv0, platform) || p.isAbsolute(argv0)) {
    const hit = withExts(p.resolve(opts.cwd, argv0))
    return hit === null ? null : done(hit, 'relative')
  }

  const realpath = opts.realpath ?? defaultRealpath
  const scope = realpath(opts.root ?? opts.cwd)
  const inScope = (file: string): boolean => {
    const rel = p.relative(scope, realpath(file))
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel)
  }
  const local = (): ResolvedCommand | null => {
    const [nodeBin, venvBin] = localBinDirs(opts.cwd, platform)
    for (const [dir, via] of [
      [nodeBin, 'node_modules'],
      [venvBin, 'venv'],
    ] as const) {
      if (dir === undefined) continue
      const hit = withExts(p.join(dir, argv0))
      if (hit !== null && inScope(hit)) return done(hit, via)
    }
    return null
  }
  const fromPath = (): ResolvedCommand | null => {
    const onPath = findOnPath(argv0, opts.pathEntries, platform, env, runnable)
    return onPath[0] === undefined ? null : done(onPath[0], 'path')
  }
  const name = argv0.toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, '')
  return PATH_FIRST.has(name) ? (fromPath() ?? local()) : (local() ?? fromPath())
}
