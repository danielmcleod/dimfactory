// Dependency detection for isolated runs. This is the
// ONLY deps detector: prepare, preflight `run.deps` and the depsConsent card all read their install command here.
//
// The folder is searched first, then each parent up to the scope root; the first folder with a signal wins, and within
// a folder the signals are tried in this order (pnpm-lock, package-lock, yarn.lock, bun.lock, uv.lock,
// poetry.lock, Pipfile.lock, requirements.txt, Cargo.lock, go.sum, dotnet, maven, gradle). package.json#packageManager
// (the nearest one) wins over the lockfile's kind; a manager named there without its own lockfile installs without the
// frozen flag. `isolation.worktree.installCommand` replaces detection (planFromCommand), and needs its own grant.
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { commandArgv } from '../verify/argv.ts'
import { cwdRelOf, packageManagerOfField, parsePackageJson } from '../verify/discover.ts'
import type { PackageManager } from '../verify/discover.ts'

export const DEPS_MANAGERS = [
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'uv',
  'poetry',
  'pipenv',
  'pip',
  'cargo',
  'go',
  'dotnet',
  'maven',
  'gradle',
  /** `isolation.worktree.installCommand`, or a command the user edited on the depsConsent card. */
  'custom',
] as const
export type DepsManager = (typeof DEPS_MANAGERS)[number]

/** What install a folder needs (never a shell line: every command is argv). */
export interface DepsPlan {
  manager: DepsManager
  /** The install command. */
  argv: string[]
  /** Commands that run first, in order (requirements.txt: the virtual environment). */
  setup?: string[][]
  /** Where the commands run, relative to the scope root (`/` separators, `.` for the root). */
  cwdRel: string
  /** The lockfile it installs from, relative to the scope root; null when there is none. */
  lockfile: string | null
  /**
   * The files the trust body covers (the lockfile and the manifests and wrappers the install reads), relative to the
   * scope root. A change to any of them asks for consent again.
   */
  sources: string[]
  /** How the command was chosen. */
  via: 'lockfile' | 'packageManager' | 'manifest' | 'config'
  /** pnpm or yarn named by package.json#packageManager: corepack may run it when the binary is not on PATH. */
  corepack?: boolean
  /** Programs that must exist before anything runs (a later step's program may be made by an earlier one). */
  tools: string[]
  /** UI copy: a fact about the choice ("package.json names pnpm, but this folder has no pnpm-lock.yaml"). */
  note?: string
}

export interface DetectDepsOptions {
  /** The root `cwdRel` and `sources` are relative to (the repository's top level). Default: the folder itself. */
  scopeRoot?: string
  platform?: NodeJS.Platform
}

const MAX_READ_BYTES = 4 * 1024 * 1024

async function readText(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    if (!s.isFile() || s.size > MAX_READ_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** `folder`, then each parent up to and including `root` (only `folder` when it is not inside `root`). */
function upToRoot(folder: string, root: string): string[] {
  const out = [resolve(folder)]
  if (cwdRelOf(root, folder) === null) return out
  const top = resolve(root)
  let dir = out[0] ?? top
  while (dir !== top) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    out.push(dir)
  }
  return out
}

/** `rel` joined under `cwdRel` (`.` stays out of the path). */
const under = (cwdRel: string, rel: string): string => (cwdRel === '.' ? rel : `${cwdRel}/${rel}`)

// ---- JavaScript ----------------------------------------------------------------------------------------------------

/** Lockfiles per manager, in detection order (pnpm, npm, yarn, bun). */
const JS_LOCKFILES: readonly (readonly [PackageManager, readonly string[]])[] = [
  ['pnpm', ['pnpm-lock.yaml']],
  ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
  ['yarn', ['yarn.lock']],
  ['bun', ['bun.lock', 'bun.lockb']],
]

/** The nearest package.json#packageManager: the manager, its major version (yarn) and the folder it is set in. */
interface PackageManagerField {
  manager: PackageManager
  major: number | null
  dir: string
}

async function packageManagerField(dirs: readonly string[]): Promise<PackageManagerField | null> {
  for (const dir of dirs) {
    const text = await readText(join(dir, 'package.json'))
    const field = text === null ? undefined : parsePackageJson(text)?.packageManager
    const manager = packageManagerOfField(field)
    if (manager === null) continue
    const m = /@(\d+)/.exec(field ?? '')
    return { manager, major: m?.[1] !== undefined ? Number(m[1]) : null, dir }
  }
  return null
}

async function lockfileIn(dir: string, manager: PackageManager): Promise<string | null> {
  const names = JS_LOCKFILES.find(([pm]) => pm === manager)?.[1] ?? []
  for (const n of names) if (await isFile(join(dir, n))) return n
  return null
}

/** Yarn 2+ ("berry") takes `--immutable`; yarn 1 takes `--frozen-lockfile`. */
async function isYarnBerry(dir: string, field: PackageManagerField | null): Promise<boolean> {
  if (field?.manager === 'yarn' && field.major !== null) return field.major >= 2
  const lock = await readText(join(dir, 'yarn.lock'))
  if (lock !== null) {
    if (/^__metadata:/m.test(lock)) return true
    if (/^# yarn lockfile v1/m.test(lock)) return false
  }
  return isFile(join(dir, '.yarnrc.yml'))
}

async function jsArgv(
  manager: PackageManager,
  frozen: boolean,
  dir: string,
  field: PackageManagerField | null,
): Promise<string[]> {
  switch (manager) {
    case 'pnpm':
      return frozen ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', 'install']
    case 'npm':
      return frozen ? ['npm', 'ci'] : ['npm', 'install']
    case 'yarn':
      if (!frozen) return ['yarn', 'install']
      return (await isYarnBerry(dir, field))
        ? ['yarn', 'install', '--immutable']
        : ['yarn', 'install', '--frozen-lockfile']
    case 'bun':
      return frozen ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install']
  }
}

async function jsPlan(
  manager: PackageManager,
  lock: string | null,
  dir: string,
  root: string,
  field: PackageManagerField | null,
  via: DepsPlan['via'],
  note?: string,
): Promise<DepsPlan> {
  const cwdRel = cwdRelOf(root, dir) ?? '.'
  const argv = await jsArgv(manager, lock !== null, dir, field)
  const sources = [...(lock !== null ? [under(cwdRel, lock)] : []), under(cwdRel, 'package.json')]
  const plan: DepsPlan = {
    manager,
    argv,
    cwdRel,
    lockfile: lock !== null ? under(cwdRel, lock) : null,
    sources,
    via,
    tools: [argv[0] ?? manager],
  }
  if ((manager === 'pnpm' || manager === 'yarn') && field?.manager === manager) plan.corepack = true
  if (note !== undefined) plan.note = note
  return plan
}

/**
 * A JavaScript install for `dir`, or null. With a packageManager field: that manager's own lockfile here (frozen);
 * another manager's lockfile here (the field wins: no frozen flag); the field's own folder with no lockfile of its
 * manager here or above (no frozen flag). Without one: the first lockfile in table order.
 */
async function jsSignal(
  dir: string,
  dirs: readonly string[],
  root: string,
  field: PackageManagerField | null,
): Promise<DepsPlan | null> {
  if (field !== null) {
    const own = await lockfileIn(dir, field.manager)
    if (own !== null) return jsPlan(field.manager, own, dir, root, field, 'packageManager')
    for (const [pm, names] of JS_LOCKFILES) {
      for (const n of names) {
        if (!(await isFile(join(dir, n)))) continue
        return jsPlan(
          field.manager,
          null,
          dir,
          root,
          field,
          'packageManager',
          `package.json names ${field.manager}, so it installs without the ${pm} lockfile ${n}`,
        )
      }
    }
    if (dir !== field.dir) return null
    // The field is set here without a lockfile: a lockfile of that manager further up is the workspace's own.
    const above = dirs.slice(dirs.indexOf(dir) + 1)
    for (const d of above) if ((await lockfileIn(d, field.manager)) !== null) return null
    return jsPlan(
      field.manager,
      null,
      dir,
      root,
      field,
      'packageManager',
      `package.json names ${field.manager} and there is no lockfile, so it installs without one`,
    )
  }
  for (const [pm, names] of JS_LOCKFILES) {
    for (const n of names) {
      if (await isFile(join(dir, n))) return jsPlan(pm, n, dir, root, null, 'lockfile')
    }
  }
  return null
}

// ---- the other ecosystems ------------------------------------------------------------------------------------------

/** The sources that exist, of `names` in `dir` (relative to the scope root), in order. */
async function existing(dir: string, cwdRel: string, names: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const n of names) if (await isFile(join(dir, n))) out.push(under(cwdRel, n))
  return out
}

/** The repository wrapper (`./mvnw`, `./gradlew`) when it is in `dir` or the scope root, with its files. */
async function wrapperOf(
  dir: string,
  root: string,
  name: 'mvnw' | 'gradlew',
): Promise<{ argv0: string; files: string[] } | null> {
  const props =
    name === 'mvnw' ? ['.mvn/wrapper/maven-wrapper.properties'] : ['gradle/wrapper/gradle-wrapper.properties']
  for (const d of dir === root ? [dir] : [dir, root]) {
    const rel = cwdRelOf(root, d) ?? '.'
    const files = await existing(d, rel, [name, `${name}.bat`, `${name}.cmd`])
    if (files.length > 0) return { argv0: `./${name}`, files: [...files, ...(await existing(d, rel, props))] }
  }
  return null
}

const DOTNET_PROJECT = /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i

async function otherSignal(dir: string, root: string, platform: NodeJS.Platform): Promise<DepsPlan | null> {
  const cwdRel = cwdRelOf(root, dir) ?? '.'
  const has = (n: string): Promise<boolean> => isFile(join(dir, n))
  const plan = async (
    manager: DepsManager,
    argv: string[],
    lock: string | null,
    sourceNames: readonly string[],
    extra: Partial<DepsPlan> = {},
  ): Promise<DepsPlan> => ({
    manager,
    argv,
    cwdRel,
    lockfile: lock !== null ? under(cwdRel, lock) : null,
    sources: await existing(dir, cwdRel, sourceNames),
    via: lock !== null ? 'lockfile' : 'manifest',
    tools: [argv[0] ?? manager],
    ...extra,
  })

  if (await has('uv.lock'))
    return plan('uv', ['uv', 'sync', '--frozen'], 'uv.lock', ['uv.lock', 'pyproject.toml'])
  if (await has('poetry.lock')) {
    return plan('poetry', ['poetry', 'install', '--no-interaction'], 'poetry.lock', [
      'poetry.lock',
      'pyproject.toml',
    ])
  }
  if (await has('Pipfile.lock')) {
    return plan('pipenv', ['pipenv', 'sync'], 'Pipfile.lock', ['Pipfile.lock', 'Pipfile'])
  }
  if (await has('requirements.txt')) {
    const win = platform === 'win32'
    const venv = win ? ['py', '-3', '-m', 'venv', '.venv'] : ['python3', '-m', 'venv', '.venv']
    const python = win ? '.venv/Scripts/python' : '.venv/bin/python'
    return plan(
      'pip',
      [python, '-m', 'pip', 'install', '-r', 'requirements.txt'],
      'requirements.txt',
      ['requirements.txt'],
      { setup: [venv], tools: [venv[0] ?? 'python3'] },
    )
  }
  if (await has('Cargo.lock')) {
    return plan('cargo', ['cargo', 'fetch', '--locked'], 'Cargo.lock', ['Cargo.lock', 'Cargo.toml'])
  }
  if (await has('go.sum')) return plan('go', ['go', 'mod', 'download'], 'go.sum', ['go.sum', 'go.mod'])

  const entries = (await readdir(dir).catch((): string[] => [])).sort()
  const projects = []
  for (const e of entries) if (DOTNET_PROJECT.test(e) && (await has(e))) projects.push(e)
  if (projects.length > 0) {
    const lock = (await has('packages.lock.json')) ? 'packages.lock.json' : null
    return plan('dotnet', ['dotnet', 'restore'], lock, [
      ...projects,
      'packages.lock.json',
      'Directory.Packages.props',
      'Directory.Build.props',
      'NuGet.config',
      'nuget.config',
      'global.json',
    ])
  }
  if (await has('pom.xml')) {
    const w = await wrapperOf(dir, root, 'mvnw')
    const p = await plan('maven', [w?.argv0 ?? 'mvn', '-B', '-q', 'dependency:resolve'], null, ['pom.xml'])
    return { ...p, sources: [...p.sources, ...(w?.files ?? [])] }
  }
  const gradleFiles = ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle']
  if ((await existing(dir, cwdRel, gradleFiles)).length > 0) {
    const w = await wrapperOf(dir, root, 'gradlew')
    const lock = (await has('gradle.lockfile')) ? 'gradle.lockfile' : null
    const p = await plan('gradle', [w?.argv0 ?? 'gradle', '--no-daemon', 'dependencies'], lock, [
      ...gradleFiles,
      'gradle.lockfile',
    ])
    return { ...p, sources: [...p.sources, ...(w?.files ?? [])] }
  }
  return null
}

/**
 * The install `folder` needs, or null when nothing is detected. `cwdRel`, `lockfile` and
 * `sources` are relative to `opts.scopeRoot` (default: the folder). Detection only reads files; nothing runs.
 */
export async function detectDeps(folder: string, opts: DetectDepsOptions = {}): Promise<DepsPlan | null> {
  const root = resolve(opts.scopeRoot ?? folder)
  const platform = opts.platform ?? process.platform
  const dirs = upToRoot(folder, root)
  const field = await packageManagerField(dirs)
  for (const dir of dirs) {
    const js = await jsSignal(dir, dirs, root, field)
    if (js !== null) return js
    const other = await otherSignal(dir, root, platform)
    if (other !== null) return other
  }
  return null
}

/**
 * A configured or edited install command as a plan (manager `custom`). It runs where detection would install (else in
 * `folder`), and its trust body covers the files detection found there too, so a lockfile change still asks again.
 * `error`: the line cannot be read as argv (shell syntax), UI copy.
 */
export async function planFromCommand(
  run: string | readonly string[],
  folder: string,
  opts: DetectDepsOptions = {},
): Promise<{ plan: DepsPlan; error?: undefined } | { plan: null; error: string }> {
  const parsed = commandArgv(run)
  if (!parsed.ok) return { plan: null, error: parsed.error.replace(/verify command/g, 'install command') }
  const root = resolve(opts.scopeRoot ?? folder)
  const detected = await detectDeps(folder, opts)
  const cwdRel = detected?.cwdRel ?? cwdRelOf(root, folder) ?? '.'
  return {
    plan: {
      manager: 'custom',
      argv: parsed.argv,
      cwdRel,
      lockfile: detected?.lockfile ?? null,
      sources: detected?.sources ?? [],
      via: 'config',
      tools: [parsed.argv[0] ?? ''],
    },
  }
}

/** The install policy and command from the config (`isolation.worktree`). */
export interface InstallSettings {
  install: 'ask' | 'auto' | 'never'
  installCommand: string | readonly string[] | null
}

export type DepsDecision =
  /** `install: 'never'`: the deps step is skipped. */
  | { kind: 'never' }
  /** Nothing detected and no installCommand. */
  | { kind: 'none' }
  /** installCommand cannot be read as argv. */
  | { kind: 'invalid'; error: string }
  | { kind: 'plan'; plan: DepsPlan }

/** What the deps step does for `folder` under these settings (installCommand replaces detection). */
export async function decideDeps(
  settings: InstallSettings,
  folder: string,
  opts: DetectDepsOptions = {},
): Promise<DepsDecision> {
  if (settings.install === 'never') return { kind: 'never' }
  if (settings.installCommand !== null) {
    const r = await planFromCommand(settings.installCommand, folder, opts)
    return r.plan === null ? { kind: 'invalid', error: r.error } : { kind: 'plan', plan: r.plan }
  }
  const plan = await detectDeps(folder, opts)
  return plan === null ? { kind: 'none' } : { kind: 'plan', plan }
}

/** Every command of a plan in the order it runs (setup first). */
export function planCommands(plan: Pick<DepsPlan, 'argv' | 'setup'>): string[][] {
  return [...(plan.setup ?? []), plan.argv]
}
