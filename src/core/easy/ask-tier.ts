// Easy mode's ask classifier, pure: how an ask stands against a new Easy project's folder, and whether the project
// permission the user gave on the confirm screen ("Allow these for this project") covers it.
//
// The permission covers exactly three things, and only with the pass working in the project folder itself:
// - installing the dependencies the project's own manifest names (`npm install`, `pnpm install`, `yarn`, `bun install`,
//   `pip install -r requirements.txt`, `uv sync`, `poetry install`), with no options beyond a few quiet ones, or adding
//   named packages from the registry to its package.json (`npm install react-router-dom`, `pnpm add -D vitest`), each
//   a plain name with an optional version or tag and only the save options (so never `-g`, `--prefix`, `--registry`,
//   another manifest, a URL, a path, a git or GitHub spec, a file, a tarball or an alias);
// - running a script the project defines (`npm run <script>`, `npm test`, `pnpm run <script>`, `yarn <script>`, ...)
//   when its package.json has that script, with no further arguments;
// - reaching a package registry (the install's own downloads).
// Nothing else is covered: a file edit (inside the folder the vendor's own edit mode handles it; outside it always
// asks), any other command, a delete, any other host, and every command with a shell operator, a quote, a path outside
// the folder or a `~`. The verify, install and preview commands Dim Factory runs itself are covered separately
// (config/trust.ts coveredByProject), with the same folder binding.
import type { AllowQuery } from '../adapters/allow-cache.ts'
import { hostOf, normalizePath } from '../adapters/allow-cache.ts'

/** How an ask stands: covered by the project permission, inside the folder (asks), outside it (asks, "no" is safe). */
export type AskTier = 'project' | 'inside' | 'outside'

/** What a covered ask is, for the log of uses. */
export type CoveredUse = 'install' | 'script' | 'registry'

export interface AskClass {
  tier: AskTier
  covered: boolean
  what?: CoveredUse
  /** One line for the log ("npm install", "registry.npmjs.org"). */
  label: string
}

/** What the project folder holds that the permission is about (read when the ask comes, never cached). */
export interface ProjectFacts {
  /** package.json's `scripts` (null: no readable package.json). */
  scripts: Readonly<Record<string, string>> | null
  /** requirements.txt at the folder's top. */
  requirements: boolean
  /** pyproject.toml at the folder's top. */
  pyproject: boolean
}

export interface AskContext {
  /** The project folder (absolute). */
  folder: string
  /** The pass's working folder (absolute). */
  cwd: string
  facts: ProjectFacts
  /** Fold path case (default: Windows and macOS). */
  caseInsensitive?: boolean
}

/** The package registries an install downloads from (exact hosts). */
export const PACKAGE_REGISTRIES: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'repo.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
]

/** Shell operators, quotes, substitutions and line breaks: a command holding any is never covered. */
const SHELL_META = /[;&|<>`$"'\n\r(){}*?!\\]/

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/

/** Quiet options an install may carry and still be "from the project's own manifest". */
const QUIET_FLAGS: Readonly<Record<string, readonly string[]>> = {
  npm: ['--no-audit', '--no-fund', '--silent', '--prefer-offline', '--no-progress', '--loglevel=error'],
  pnpm: ['--frozen-lockfile', '--prefer-offline', '--silent'],
  yarn: ['--frozen-lockfile', '--immutable', '--silent'],
  bun: ['--frozen-lockfile'],
}

/** Yarn's own commands: `yarn <name>` runs a script only when the name is none of these. */
const YARN_BUILTINS: ReadonlySet<string> = new Set(
  (
    'add bin cache config constraints dedupe dlx exec explain global info init install link node npm pack patch ' +
    'plugin publish rebuild remove run set unlink unplug up upgrade version why workspace workspaces'
  ).split(' '),
)

/** `npm.cmd` / `NPM.EXE` / `/usr/bin/npm` read as `npm`. */
function program(argv0: string): string {
  const base = argv0.replace(/\\/g, '/').split('/').pop() ?? argv0
  return base.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '')
}

function fold(p: string, ci: boolean): string {
  return ci ? p.toLowerCase() : p
}

/** Whether `p` (absolute, or relative to cwd) is the folder or inside it. */
export function insideFolder(p: string, folder: string, cwd: string, ci: boolean): boolean {
  if (p.startsWith('~')) return false
  const f = fold(normalizePath(folder), ci)
  const t = fold(normalizePath(p, { cwd }), ci)
  return t === f || t.startsWith(`${f}/`)
}

/** A token that names a path: absolute, home-relative, or one that climbs (`..`). */
function pathLike(t: string): boolean {
  return (
    t.startsWith('/') ||
    t.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(t) ||
    t.startsWith('\\\\') ||
    /(^|[\\/])\.\.([\\/]|$)/.test(t)
  )
}

const onlyFlags = (rest: readonly string[], allowed: readonly string[]): boolean =>
  rest.every((t) => allowed.includes(t))

/**
 * The install a command is, when it installs from the project's own manifest or adds named registry packages to it;
 * else undefined.
 */
function installOf(argv: readonly string[], facts: ProjectFacts): string | undefined {
  const prog = program(argv[0] ?? '')
  const args = argv.slice(1)
  const pkg = facts.scripts !== null
  if (pkg && (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun')) {
    const named = registryInstallOf(prog, args)
    if (named !== undefined) return named
  }
  switch (prog) {
    case 'npm': {
      if (!pkg) return undefined
      const [verb, ...rest] = args
      if ((verb === 'install' || verb === 'i' || verb === 'ci') && onlyFlags(rest, QUIET_FLAGS['npm'] ?? []))
        return `npm ${verb}`
      return undefined
    }
    case 'pnpm': {
      if (!pkg) return undefined
      const [verb, ...rest] = args
      if ((verb === 'install' || verb === 'i') && onlyFlags(rest, QUIET_FLAGS['pnpm'] ?? []))
        return `pnpm ${verb}`
      return undefined
    }
    case 'yarn': {
      if (!pkg) return undefined
      const rest = args[0] === 'install' ? args.slice(1) : args
      if (onlyFlags(rest, QUIET_FLAGS['yarn'] ?? [])) return args[0] === 'install' ? 'yarn install' : 'yarn'
      return undefined
    }
    case 'bun': {
      if (!pkg) return undefined
      const [verb, ...rest] = args
      if (verb === 'install' && onlyFlags(rest, QUIET_FLAGS['bun'] ?? [])) return 'bun install'
      return undefined
    }
    case 'pip':
    case 'pip3':
      return facts.requirements && same(args, ['install', '-r', 'requirements.txt'])
        ? `${prog} install -r requirements.txt`
        : undefined
    case 'python':
    case 'python3':
    case 'py':
      return facts.requirements && same(args, ['-m', 'pip', 'install', '-r', 'requirements.txt'])
        ? `${prog} -m pip install -r requirements.txt`
        : undefined
    case 'uv':
      return facts.pyproject && same(args, ['sync']) ? 'uv sync' : undefined
    case 'poetry':
      return facts.pyproject && same(args, ['install']) ? 'poetry install' : undefined
    default:
      return undefined
  }
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** An npm package name (optionally scoped), as the registry has it. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/
/** A version range or tag after `@`: digits, dots, `x`, `^`, `~`, a prerelease, or a plain tag (`latest`, `next`). */
const PACKAGE_VERSION = /^(?:[~^]?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?|[a-z][a-z0-9.-]{0,39})$/
/** A name that npm would read as a file (a tarball or an archive) rather than a registry package. */
const ARCHIVE_NAME = /\.(?:tgz|tar|gz|zip|tar\.gz)$/i

/**
 * A package from the registry, by name and optionally a version or tag (`react-router-dom`, `@scope/pkg@^2.1`,
 * `zod@latest`). Never a path, a URL, a git or GitHub spec (`user/repo`), a file, a tarball or an alias (`npm:`).
 */
export function registryPackageSpec(spec: string): boolean {
  if (spec === '' || spec.startsWith('-')) return false
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : null
  if (!PACKAGE_NAME.test(name) || ARCHIVE_NAME.test(name)) return false
  return version === null || PACKAGE_VERSION.test(version)
}

/** Options an install of named registry packages may carry: where it is saved in package.json, and the quiet ones. */
const SAVE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  npm: ['-D', '--save-dev', '-S', '--save', '-E', '--save-exact', '-O', '--save-optional'],
  pnpm: ['-D', '--save-dev', '-E', '--save-exact', '-O', '--save-optional'],
  yarn: ['-D', '--dev', '-E', '--exact', '-O', '--optional'],
  bun: ['-d', '-D', '--dev', '-E', '--exact', '--optional'],
}

/**
 * Named registry packages added to the project's own package.json (`npm install react-router-dom`, `pnpm add -D
 * vitest`, `yarn add zod`, `bun add date-fns`): at least one package, each a plain registry spec, and only the save and
 * quiet options (so never `-g`, `--global`, `--prefix`, `--registry`, `--location`, a URL, a path, git or a file).
 */
function registryInstallOf(prog: string, args: readonly string[]): string | undefined {
  const verbs: Readonly<Record<string, readonly string[]>> = {
    npm: ['install', 'i', 'add'],
    pnpm: ['add'],
    yarn: ['add'],
    bun: ['add'],
  }
  const [verb, ...rest] = args
  if (verb === undefined || !(verbs[prog] ?? []).includes(verb)) return undefined
  const allowed = [...(SAVE_FLAGS[prog] ?? []), ...(QUIET_FLAGS[prog] ?? [])]
  const names = rest.filter((t) => !t.startsWith('-'))
  if (names.length === 0) return undefined
  if (!rest.every((t) => (t.startsWith('-') ? allowed.includes(t) : registryPackageSpec(t)))) return undefined
  return `${prog} ${verb} ${names.join(' ')}`
}

/** The project script a command runs, when the project defines it and nothing else is passed; else undefined. */
function scriptOf(argv: readonly string[], facts: ProjectFacts): string | undefined {
  const scripts = facts.scripts
  if (scripts === null) return undefined
  const has = (name: string | undefined): name is string =>
    name !== undefined && SCRIPT_NAME.test(name) && Object.hasOwn(scripts, name)
  const prog = program(argv[0] ?? '')
  const args = argv.slice(1)
  if (prog !== 'npm' && prog !== 'pnpm' && prog !== 'yarn' && prog !== 'bun') return undefined
  // `<pm> run <name>` (npm also `run-script`)
  if (
    args.length === 2 &&
    (args[0] === 'run' || (prog === 'npm' && args[0] === 'run-script')) &&
    has(args[1])
  )
    return `${prog} run ${args[1]}`
  // `<pm> test` / `<pm> start` (not bun: `bun test` is its own test runner)
  if (args.length === 1 && prog !== 'bun' && (args[0] === 'test' || args[0] === 'start') && has(args[0]))
    return `${prog} ${args[0]}`
  // `yarn <name>` when the name is no yarn command of its own
  if (prog === 'yarn' && args.length === 1 && !YARN_BUILTINS.has(args[0] ?? '') && has(args[0]))
    return `yarn ${args[0]}`
  return undefined
}

/** How an ask stands against the project folder, and whether the project permission covers it (see the header). */
export function classifyAsk(q: AllowQuery, c: AskContext): AskClass {
  const ci = c.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')
  const here = fold(normalizePath(c.cwd), ci) === fold(normalizePath(c.folder), ci)
  const inside = (p: string): boolean => insideFolder(p, c.folder, c.cwd, ci)
  switch (q.kind) {
    case 'edit': {
      const paths = [...(q.path !== undefined ? [q.path] : []), ...(q.paths ?? [])]
      const label = paths.join(', ') || q.tool
      const out = paths.length === 0 || paths.some((p) => !inside(p))
      return { tier: out ? 'outside' : 'inside', covered: false, label }
    }
    case 'network': {
      const host = (q.host ?? (q.url !== undefined ? hostOf(q.url) : undefined) ?? '').replace(/:443$/, '')
      if (here && PACKAGE_REGISTRIES.includes(host))
        return { tier: 'project', covered: true, what: 'registry', label: host }
      return { tier: 'outside', covered: false, label: host || q.tool }
    }
    case 'shell': {
      const argv = q.argv ?? []
      const label = argv.join(' ') || q.tool
      if (argv.length === 0) return { tier: 'inside', covered: false, label }
      const outside = argv.some((t) => pathLike(t) && !inside(t.replace(/^['"]|['"]$/g, '')))
      if (outside || !here) return { tier: 'outside', covered: false, label }
      if (argv.some((t) => SHELL_META.test(t) || pathLike(t)))
        return { tier: 'inside', covered: false, label }
      const install = installOf(argv, c.facts)
      if (install !== undefined) return { tier: 'project', covered: true, what: 'install', label: install }
      const script = scriptOf(argv, c.facts)
      if (script !== undefined) return { tier: 'project', covered: true, what: 'script', label: script }
      return { tier: 'inside', covered: false, label }
    }
    case 'other':
      return { tier: 'inside', covered: false, label: q.tool }
  }
}
