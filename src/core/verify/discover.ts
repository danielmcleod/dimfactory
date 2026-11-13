// Verify command discovery and script bodies (commands and trust). Detected commands
// come from package.json scripts, Makefile targets, pyproject tools, Cargo, go, dotnet, maven and gradle, ordered
// typecheck → lint → test → build, plus Dim Factory's own play-test when the folder has a playtest.json; the config's
// verify.commands are its own list (configCommands). A body is the text the trust hash covers (what the program reads to decide what runs, whole): the package.json's
// scripts map, every makefile make reads with its includes, or null for a fixed tool command.
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { VerifyCommandConfig } from '../../shared/config-schema.ts'
import type { DetectedCommand, VerifyKind, VerifySource } from '../../shared/verify.ts'
import { VERIFY_KINDS } from '../../shared/verify.ts'
import { PLAYTEST_ARGV, PLAYTEST_COMMAND_NAME, PLAYTEST_FILE } from '../../shared/playtest.ts'
import { relativeInside } from '../real-path.ts'
import { commandArgv } from './argv.ts'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface DiscoverOptions {
  /** The root `cwdRel` is relative to (the scope root: the repository's top level). Default: the folder itself. */
  scopeRoot?: string
}

/** A command as far as its body is concerned: its argv and where it runs. */
export interface BodyCommand {
  run?: readonly string[] | boolean
  argv?: readonly string[]
  cwdRel: string
}

const MAX_READ_BYTES = 4 * 1024 * 1024

/** The `npm init` placeholder: `echo "Error: no test specified" && exit 1`. */
export const NPM_TEST_STUB = /no test specified/i

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'tsc', 'types'] as const
const MAKE_TARGETS = ['check', 'lint', 'test'] as const
const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'] as const
const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

// ---- small fs helpers --------------------------------------------------------------------------------------------

async function readText(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    if (!s.isFile() || s.size > MAX_READ_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** `dir` relative to `root` with `/` separators (`.` for the root); null when `dir` is outside `root`. */
export function cwdRelOf(root: string, dir: string): string | null {
  // Either spelling of the same folder counts (an 8.3 short name or a linked temp folder against its real name).
  const rel = relativeInside(root, dir)
  if (rel === null) return null
  if (rel === '') return '.'
  return rel.split(sep).join('/')
}

/** `folder`, then each parent up to and including `root` (only `folder` when it is not inside `root`). */
function upToRoot(folder: string, root: string): string[] {
  const out = [resolve(folder)]
  const rel = cwdRelOf(root, folder)
  if (rel === null || rel === '.') return out
  // The parents are spelled from `root`, so the walk ends at it however `folder` was spelled.
  const segments = rel.split('/')
  for (let n = segments.length - 1; n >= 0; n--) out.push(join(resolve(root), ...segments.slice(0, n)))
  return out
}

// ---- package.json ------------------------------------------------------------------------------------------------

interface PackageJson {
  scripts: Record<string, string>
  packageManager?: string
}

export function parsePackageJson(text: string): PackageJson | null {
  let v: unknown
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const scripts: Record<string, string> = {}
  const raw = o['scripts']
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [k, s] of Object.entries(raw as Record<string, unknown>))
      if (typeof s === 'string') scripts[k] = s
  }
  const pm = o['packageManager']
  return typeof pm === 'string' ? { scripts, packageManager: pm } : { scripts }
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const text = await readText(join(dir, 'package.json'))
  return text === null ? null : parsePackageJson(text)
}

/** `pnpm@10.28.0` → pnpm. */
export function packageManagerOfField(field: string | undefined): PackageManager | null {
  const m = /^\s*(npm|pnpm|yarn|bun)(?:@|$)/.exec(field ?? '')
  return (m?.[1] as PackageManager | undefined) ?? null
}

/**
 * The package manager for `folder`: package.json#packageManager (the folder's, then its parents' up to the scope
 * root), else the first lockfile found the same way, else npm.
 */
export async function detectPackageManager(folder: string, root: string = folder): Promise<PackageManager> {
  const dirs = upToRoot(folder, root)
  for (const dir of dirs) {
    const pm = packageManagerOfField((await readPackageJson(dir))?.packageManager)
    if (pm !== null) return pm
  }
  for (const dir of dirs) {
    for (const [file, pm] of LOCKFILES) if (await exists(join(dir, file))) return pm
  }
  return 'npm'
}

/**
 * The body of every `<pm> …` command run from a package.json: its whole `scripts` map as JSON. A script
 * may run another (`"test": "npm run unit"`), and npm runs `pre<name>` / `post<name>` too, so any script of the file
 * can run; JSON keeps two different maps from ever reading as the same text.
 */
export function scriptsBody(scripts: Readonly<Record<string, string>>): string {
  return JSON.stringify(scripts, null, 2)
}

const PM_NAMES = new Set<string>(['npm', 'pnpm', 'yarn', 'bun'])

/** argv[0]'s program name: basename, lower case, without a Windows launcher extension. */
export function programName(argv0: string): string {
  return basename(argv0.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(?:cmd|bat|exe|com|ps1|cjs|mjs|js)$/, '')
}

/**
 * Package-manager options that make it read another package.json than the one in (or above) cwd: another folder
 * (`-C`, `--dir`, `--prefix`, `--cwd`), workspaces (`--filter`, `-w`, `--workspace(s)`, `-r`), the global prefix.
 * Trust could not show those scripts, so such a command is `invalid`. Short forms may carry their value
 * (`-Cdir`, `-Fweb`); long forms may use `=`.
 */
const PM_ELSEWHERE_LONG = new Set([
  '--dir',
  '--prefix',
  '--cwd',
  '--filter',
  '--filter-prod',
  '--workspace',
  '--workspaces',
  '--workspace-root',
  '--include-workspace-root',
  '--recursive',
  '--global',
  '--location',
])
const PM_ELSEWHERE_SHORT = /^-(?:C|F|w|W|r|g)/
const PM_ELSEWHERE_SUBCOMMANDS = new Set(['workspace', 'workspaces', 'recursive', 'multi', 'm'])

/** Why a package-manager command cannot be covered by trust (null: it reads the package.json in or above cwd). */
export function packageManagerProblem(pm: string, args: readonly string[]): string | null {
  const own = args.indexOf('--')
  const head = own === -1 ? args : args.slice(0, own)
  const optionName = (a: string): string => (a.includes('=') ? a.slice(0, a.indexOf('=')) : a)
  const flag = head.find(
    (a) => a.startsWith('-') && (PM_ELSEWHERE_LONG.has(optionName(a)) || PM_ELSEWHERE_SHORT.test(a)),
  )
  const sub = head.find((a) => !a.startsWith('-'))
  let what: string | null = null
  if (flag !== undefined) what = `\`${optionName(flag)}\``
  else if (sub !== undefined && PM_ELSEWHERE_SUBCOMMANDS.has(sub)) what = `\`${pm} ${sub}\``
  if (what === null) return null
  return (
    `${what} makes ${pm} run another package's scripts, which Dim Factory cannot show you to trust: ` +
    `use \`${pm} run <name>\` with that package's folder as the command's cwd`
  )
}

/** Manifests a package manager reads scripts from, in the order it looks (pnpm also reads package.yaml / .json5). */
const MANIFESTS = ['package.json', 'package.yaml', 'package.json5'] as const

/**
 * The scripts body for a package-manager command run in `dir`: the nearest manifest at or above it (where npm, pnpm,
 * yarn, bun and `node --run` look). package.json → its `scripts` map (scriptsBody); a manifest Dim Factory does not
 * parse (unparseable JSON, package.yaml, package.json5) → its whole text; none → null.
 */
async function nearestScripts(dir: string): Promise<string | null> {
  let at = resolve(dir)
  for (;;) {
    for (const name of MANIFESTS) {
      const text = await readText(join(at, name))
      if (text === null) continue
      const pkg = name === 'package.json' ? parsePackageJson(text) : null
      return pkg !== null ? scriptsBody(pkg.scripts) : `# ${name}\n${text.replace(/\r\n/g, '\n')}`
    }
    const parent = dirname(at)
    if (parent === at) return null
    at = parent
  }
}

/** The program a command runs package scripts with: `<pm> …`, `corepack <pm> …`, `node --run <name>`; else null. */
function scriptRunner(argv: readonly string[]): { pm: string; args: readonly string[] } | null {
  const prog = programName(argv[0] ?? '')
  if (PM_NAMES.has(prog)) return { pm: prog, args: argv.slice(1) }
  const next = programName(argv[1] ?? '')
  if (prog === 'corepack' && PM_NAMES.has(next)) return { pm: next, args: argv.slice(2) }
  if (prog === 'node' && argv.slice(1).some((a) => a === '--run' || a.startsWith('--run='))) {
    return { pm: 'node', args: [] }
  }
  return null
}

// ---- Makefile ----------------------------------------------------------------------------------------------------

/** Each target's text: its rule line(s) and recipe lines, as written (a target defined twice keeps both). */
export function parseMakefile(text: string): Map<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const out = new Map<string, string[]>()
  let current: { targets: string[]; lines: string[] } | null = null
  const flush = (): void => {
    if (current === null) return
    const body = [...current.lines]
    while (body.length > 1 && (body[body.length - 1] ?? '').trim() === '') body.pop()
    for (const t of current.targets) {
      const list = out.get(t) ?? []
      list.push(body.join('\n'))
      out.set(t, list)
    }
    current = null
  }
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? ''
    if (current !== null && (line.startsWith('\t') || line.trim() === '')) {
      current.lines.push(line)
      continue
    }
    flush()
    if (line.startsWith('\t') || /^\s*#/.test(line)) continue
    // A rule line may continue onto the next lines with a trailing backslash.
    while (line.endsWith('\\') && i + 1 < lines.length) line = `${line}\n${lines[++i] ?? ''}`
    const m = /^([^:#=\s][^:#=]*?)\s*::?(?!=)(.*)$/s.exec(line)
    if (m === null) continue
    const targets = (m[1] ?? '')
      .split(/\s+/)
      .filter((t) => t !== '' && !t.startsWith('.') && !t.includes('%'))
    if (targets.length === 0) continue
    current = { targets, lines: [line] }
  }
  flush()
  const result = new Map<string, string>()
  for (const [t, bodies] of out) result.set(t, bodies.join('\n'))
  return result
}

/** The makefile `make` reads in `dir` without `-f` (GNUmakefile, makefile, Makefile), or null. */
async function defaultMakefile(dir: string): Promise<string | null> {
  for (const name of MAKEFILE_NAMES) {
    const p = resolve(dir, name)
    if ((await readText(p)) !== null) return p
  }
  return null
}

export interface MakeInvocation {
  dir?: string
  /** Every `-f` file, in order (make reads them all). */
  files: string[]
  /** `-I` folders (where an include not found in the make folder is looked for). */
  includeDirs: string[]
  targets: string[]
}

/** `make [-C dir] [-f file]… [-I dir]… [VAR=x] target…` (no targets: the default goal). */
export function makeInvocation(args: readonly string[]): MakeInvocation {
  const out: MakeInvocation = { files: [], includeDirs: [], targets: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '-f' || a === '--file' || a === '--makefile') out.files.push(args[++i] ?? '')
    else if (a.startsWith('--file=') || a.startsWith('--makefile='))
      out.files.push(a.slice(a.indexOf('=') + 1))
    else if (/^-f./.test(a)) out.files.push(a.slice(2))
    else if (a === '-C' || a === '--directory') out.dir = args[++i] ?? ''
    else if (a.startsWith('--directory=')) out.dir = a.slice('--directory='.length)
    else if (/^-C./.test(a)) out.dir = a.slice(2)
    else if (a === '-I' || a === '--include-dir') out.includeDirs.push(args[++i] ?? '')
    else if (a.startsWith('--include-dir=')) out.includeDirs.push(a.slice('--include-dir='.length))
    else if (/^-I./.test(a)) out.includeDirs.push(a.slice(2))
    else if ((a === '-j' || a === '-l') && /^\d+(?:\.\d+)?$/.test(args[i + 1] ?? '')) i++
    else if (a.startsWith('-') || a.includes('=')) continue
    else out.targets.push(a)
  }
  return out
}

/** The file names the `include` / `-include` / `sinclude` lines of a makefile name (recipe lines excluded). */
export function makeIncludes(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('\t')) continue
    const m = /^\s*(?:-include|sinclude|include)\s+(.*)$/.exec(line)
    if (m === null) continue
    const names = (m[1] ?? '').replace(/\s+#.*$/, '').trim()
    if (names !== '') out.push(...names.split(/\s+/))
  }
  return out
}

const MAKE_FILES_MAX = 64
const WILDCARD = /[*?[]/

/** A make wildcard's last part (`*`, `?`, `[…]`) as a regular expression. */
function wildcardRegExp(pattern: string): RegExp {
  let re = ''
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if (ch === '[' || ch === ']') re += ch
    else re += ch.replace(/[\\^$.|+(){}]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** `name` matched as a make wildcard among the files of its folder, sorted; null when the folder part has one too. */
async function expandWildcard(dir: string, name: string): Promise<string[] | null> {
  const full = resolve(dir, name)
  const parent = dirname(full)
  if (WILDCARD.test(parent)) return null
  let re: RegExp
  try {
    re = wildcardRegExp(basename(full))
  } catch {
    return null
  }
  const entries = await readdir(parent).catch((): string[] => [])
  return entries
    .filter((e) => re.test(e))
    .sort()
    .map((e) => join(parent, e))
}

const unreadableInclude = (name: string, why: string): BodyRead => ({
  body: null,
  error: `Its makefile includes \`${name}\`, ${why}, so Dim Factory cannot show you what it runs: use a package script or include the file by its name`,
})

/**
 * What `make` reads, as one body: every makefile it is given (or the default one) and every file they
 * include, whole, in order, each after a `# ---- <file> ----` line. A recipe runs its prerequisites' recipes and uses
 * variables and included files, so a target's own lines would not cover what it runs. An include whose name only make
 * can work out (`$(DEPS)`) cannot be covered: `error`.
 */
async function makeBody(cwd: string, inv: MakeInvocation): Promise<BodyRead> {
  const dir = inv.dir !== undefined ? resolve(cwd, inv.dir) : cwd
  const searchDirs = [dir, ...inv.includeDirs.map((d) => resolve(dir, d))]
  // label: how the file is named in the body (the first file has no header line).
  const queue: { path: string; label: string | null }[] = []
  if (inv.files.length > 0) {
    inv.files.forEach((f, i) => queue.push({ path: resolve(dir, f), label: i === 0 ? null : f }))
  } else {
    const found = await defaultMakefile(dir)
    if (found === null) return { body: null }
    queue.push({ path: found, label: null })
  }
  const parts: string[] = []
  const seen = new Set<string>()
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.path)) continue
    seen.add(next.path)
    if (seen.size > MAKE_FILES_MAX) {
      return {
        body: null,
        error: `Its makefiles include more than ${MAKE_FILES_MAX} files, too many to show you`,
      }
    }
    const text = await readText(next.path)
    if (next.label !== null) parts.push(`# ---- ${next.label}${text === null ? ' (not found)' : ''} ----`)
    if (text === null) continue
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    parts.push(normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized)
    for (const name of makeIncludes(normalized)) {
      if (name.includes('$')) return unreadableInclude(name, 'a file name only make can work out')
      let found: string[] = []
      if (WILDCARD.test(name)) {
        const hits = await expandWildcard(dir, name)
        if (hits === null) return unreadableInclude(name, 'a pattern Dim Factory cannot read')
        found = hits
      } else {
        for (const d of isAbsolute(name) ? [dir] : searchDirs) {
          const p = resolve(d, name)
          if ((await readText(p)) !== null) {
            found = [p]
            break
          }
        }
        if (found.length === 0) {
          parts.push(`# ---- include ${name} (not found) ----`)
          continue
        }
      }
      for (const p of found) queue.push({ path: p, label: `include ${cwdRelOf(dir, p) ?? p}` })
    }
  }
  return { body: parts.join('\n') }
}

// ---- bodies ------------------------------------------------------------------------------------------------------

function argvOf(cmd: BodyCommand): readonly string[] {
  if (cmd.argv !== undefined) return cmd.argv
  return Array.isArray(cmd.run) ? (cmd.run as readonly string[]) : []
}

/**
 * A command's body as read now: `body` is the text its trust hash covers (null: a fixed tool command, covered by its
 * argv alone); `error` says why trust cannot cover what it runs, and the command is `invalid`.
 */
export type BodyRead = { body: string | null; error?: undefined } | { body: null; error: string }

/**
 * The text a command's trust hash covers, read now from disk under `root` (the scope root; a worktree's root for an
 * isolated run). What the program itself reads to decide what to run, whole.
 * - `<pm> …` (npm, pnpm, yarn, bun; `corepack <pm> …`; `node --run x`): the `scripts` map of the manifest in or
 *   above cwd (nearestScripts). An option that picks another package (`--filter`, `-C`, `--prefix`, `-w`…) is
 *   `error`.
 * - `make …`: every makefile it reads and every file they include (makeBody).
 * - anything else (a fixed tool command): null.
 */
export async function readCommandBody(root: string, cmd: BodyCommand): Promise<BodyRead> {
  const argv = argvOf(cmd)
  const argv0 = argv[0]
  if (argv0 === undefined) return { body: null }
  const cwd = resolve(root, cmd.cwdRel)
  const runner = scriptRunner(argv)
  if (runner !== null) {
    const problem = packageManagerProblem(runner.pm, runner.args)
    if (problem !== null) return { body: null, error: problem }
    return { body: await nearestScripts(cwd) }
  }
  const prog = programName(argv0)
  if (prog === 'make' || prog === 'gmake' || prog === 'mingw32-make') {
    return makeBody(cwd, makeInvocation(argv.slice(1)))
  }
  return { body: null }
}

/** readCommandBody's text (null for a fixed tool command, and for one trust cannot cover). */
export async function readBody(root: string, cmd: BodyCommand): Promise<string | null> {
  return (await readCommandBody(root, cmd)).body
}

// ---- discovery -----------------------------------------------------------------------------------------------------

const KIND_RANK = (k: VerifyKind): number => VERIFY_KINDS.indexOf(k)

function cmd(
  name: string,
  run: string[],
  source: VerifySource,
  kind: VerifyKind,
  cwdRel: string,
  body: string | null,
  enabledByDefault = true,
): DetectedCommand {
  return { name, run, cwdRel, source, kind, enabledByDefault, body }
}

async function fromPackageJson(folder: string, root: string, cwdRel: string): Promise<DetectedCommand[]> {
  const pkg = await readPackageJson(folder)
  if (pkg === null) return []
  const { scripts } = pkg
  const pm = await detectPackageManager(folder, root)
  // Every script of the file is the body (scriptsBody): the same text readCommandBody reads for `<pm> run <name>`.
  const body = scriptsBody(scripts)
  const out: DetectedCommand[] = []
  const add = (name: string, kind: VerifyKind, enabled = true): void => {
    out.push(cmd(name, [pm, 'run', name], 'package.json', kind, cwdRel, body, enabled))
  }
  const tc = TYPECHECK_SCRIPTS.find((n) => Object.hasOwn(scripts, n))
  if (tc !== undefined) add(tc, 'typecheck')
  if (Object.hasOwn(scripts, 'lint')) add('lint', 'lint')
  const test = scripts['test']
  if (test !== undefined && !NPM_TEST_STUB.test(test)) add('test', 'test')
  if (Object.hasOwn(scripts, 'build')) add('build', 'build', false)
  return out
}

async function fromMakefile(folder: string, cwdRel: string): Promise<DetectedCommand[]> {
  const file = await defaultMakefile(folder)
  const text = file === null ? null : await readText(file)
  if (text === null) return []
  const targets = parseMakefile(text)
  // The body is what make reads (the makefile and its includes, whole), the same for every target.
  const read = await makeBody(folder, makeInvocation([]))
  const out: DetectedCommand[] = []
  for (const t of MAKE_TARGETS) {
    if (!targets.has(t)) continue
    const kind: VerifyKind = t === 'lint' ? 'lint' : t === 'test' ? 'test' : 'typecheck'
    const c = cmd(`make ${t}`, ['make', t], 'Makefile', kind, cwdRel, read.body)
    out.push(read.error !== undefined ? { ...c, error: read.error } : c)
  }
  return out
}

/** `uv run` / `poetry run` when that tool's lockfile is in the folder or a parent up to the scope root. */
async function pythonRunner(folder: string, root: string): Promise<string[]> {
  for (const dir of upToRoot(folder, root)) {
    if (await exists(join(dir, 'uv.lock'))) return ['uv', 'run']
    if (await exists(join(dir, 'poetry.lock'))) return ['poetry', 'run']
  }
  return []
}

async function fromPyproject(folder: string, root: string, cwdRel: string): Promise<DetectedCommand[]> {
  const text = await readText(join(folder, 'pyproject.toml'))
  if (text === null) return []
  const prefix = await pythonRunner(folder, root)
  const any = async (files: readonly string[]): Promise<boolean> => {
    for (const f of files) if (await exists(join(folder, f))) return true
    return false
  }
  const uses = (tool: string): boolean =>
    new RegExp(`^\\s*\\[tool\\.${tool}\\b`, 'm').test(text) || new RegExp(`\\b${tool}\\b`).test(text)
  const out: DetectedCommand[] = []
  if (uses('mypy') || (await any(['mypy.ini', '.mypy.ini']))) {
    out.push(cmd('mypy', [...prefix, 'mypy', '.'], 'pyproject', 'typecheck', cwdRel, null))
  }
  if (uses('ruff') || (await any(['ruff.toml', '.ruff.toml']))) {
    out.push(cmd('ruff', [...prefix, 'ruff', 'check', '.'], 'pyproject', 'lint', cwdRel, null))
  }
  if (uses('pytest') || (await any(['pytest.ini', 'conftest.py']))) {
    out.push(cmd('pytest', [...prefix, 'pytest', '-q'], 'pyproject', 'test', cwdRel, null))
  }
  return out
}

/** `./<name>` when the repo has the wrapper (`<name>` on POSIX, `<name>.bat|.cmd` on Windows), else null. */
async function wrapper(folder: string, root: string, name: string): Promise<string | null> {
  for (const dir of [folder, root]) {
    for (const f of [name, `${name}.bat`, `${name}.cmd`]) if (await exists(join(dir, f))) return `./${name}`
  }
  return null
}

async function fromBuildTools(folder: string, root: string, cwdRel: string): Promise<DetectedCommand[]> {
  const out: DetectedCommand[] = []
  if (await exists(join(folder, 'Cargo.toml'))) {
    out.push(cmd('cargo check', ['cargo', 'check', '--all-targets'], 'cargo', 'typecheck', cwdRel, null))
    out.push(cmd('cargo test', ['cargo', 'test'], 'cargo', 'test', cwdRel, null))
  }
  if (await exists(join(folder, 'go.mod'))) {
    out.push(cmd('go build', ['go', 'build', './...'], 'go', 'typecheck', cwdRel, null))
    out.push(cmd('go vet', ['go', 'vet', './...'], 'go', 'lint', cwdRel, null))
    out.push(cmd('go test', ['go', 'test', './...'], 'go', 'test', cwdRel, null))
  }
  const entries = await readdir(folder).catch((): string[] => [])
  if (entries.some((e) => /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(e))) {
    out.push(cmd('dotnet test', ['dotnet', 'test'], 'dotnet', 'test', cwdRel, null))
  }
  if (entries.includes('pom.xml')) {
    const w = await wrapper(folder, root, 'mvnw')
    out.push(cmd('mvn test', [w ?? 'mvn', '-B', '-q', 'test'], 'maven', 'test', cwdRel, null))
  }
  if (entries.some((e) => /^(?:build|settings)\.gradle(?:\.kts)?$/.test(e))) {
    const w = await wrapper(folder, root, 'gradlew')
    out.push(cmd('gradle test', [w ?? 'gradle', 'test'], 'gradle', 'test', cwdRel, null))
  }
  return out
}

/**
 * Dim Factory's own play-test of a game, when the folder has a playtest.json: run inside Dim Factory (it plays the game
 * in its sandboxed preview), never spawned, so it needs no trust grant (the file is data it reads, not a program).
 */
export async function playtestCommand(folder: string, cwdRel: string): Promise<DetectedCommand | null> {
  if ((await readText(join(folder, PLAYTEST_FILE))) === null) return null
  return cmd(PLAYTEST_COMMAND_NAME, [...PLAYTEST_ARGV], 'dimfactory', 'test', cwdRel, null)
}

/** Names made unique in order (`test`, `test (2)`). */
function uniqueNames(list: DetectedCommand[]): DetectedCommand[] {
  const seen = new Set<string>()
  return list.map((c) => {
    let name = c.name
    for (let n = 2; seen.has(name); n++) name = `${c.name} (${n})`
    seen.add(name)
    return name === c.name ? c : { ...c, name }
  })
}

/**
 * The verify commands `folder`'s project files suggest (the discovery table), typecheck → lint → test → build,
 * each with the body its trust hash covers. `cwdRel` is relative to `opts.scopeRoot` (default: the folder).
 */
export async function discoverCommands(
  folder: string,
  opts: DiscoverOptions = {},
): Promise<DetectedCommand[]> {
  const dir = resolve(folder)
  const root = resolve(opts.scopeRoot ?? folder)
  const cwdRel = cwdRelOf(root, dir) ?? '.'
  const lists = await Promise.all([
    fromPackageJson(dir, root, cwdRel),
    fromMakefile(dir, cwdRel),
    fromPyproject(dir, root, cwdRel),
    fromBuildTools(dir, root, cwdRel),
    playtestCommand(dir, cwdRel).then((c) => (c === null ? [] : [c])),
  ])
  const all = lists.flat()
  const ordered = all
    .map((c, i) => ({ c, i }))
    .sort((a, b) => KIND_RANK(a.c.kind) - KIND_RANK(b.c.kind) || a.i - b.i)
    .map(({ c }) => c)
  return uniqueNames(ordered)
}

/** A configured command's kind, read from its name (only for display and ordering hints). */
export function kindOfName(name: string): VerifyKind {
  const n = name.toLowerCase()
  if (/type-?check|tsc|mypy|types\b/.test(n)) return 'typecheck'
  if (/lint|ruff|eslint|clippy|vet\b/.test(n)) return 'lint'
  if (/test|spec|pytest/.test(n)) return 'test'
  if (/build|compile/.test(n)) return 'build'
  return 'other'
}

export interface ConfigCommandsOptions {
  /** The run's folder: a command's `cwd` is relative to it. */
  folder: string
  /** The root `cwdRel` is relative to. Default: the folder. */
  scopeRoot?: string
}

/**
 * `verify.commands[]` as DetectedCommand (source `config`), in the configured order. A command that cannot run as
 * written (shell syntax in a string, a cwd outside the project) keeps its place with `error` and an empty argv; one
 * whose body trust cannot cover (readCommandBody's `error`) keeps its argv with `error`.
 */
export async function configCommands(
  commands: readonly VerifyCommandConfig[],
  opts: ConfigCommandsOptions,
): Promise<DetectedCommand[]> {
  const folder = resolve(opts.folder)
  const root = resolve(opts.scopeRoot ?? opts.folder)
  const out: DetectedCommand[] = []
  for (const c of commands) {
    const base: DetectedCommand = {
      name: c.name,
      run: [],
      cwdRel: '.',
      source: 'config',
      kind: kindOfName(c.name),
      enabledByDefault: c.enabled ?? true,
      body: null,
      ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
    }
    const cwdRel = cwdRelOf(root, c.cwd !== undefined ? resolve(folder, c.cwd) : folder)
    if (cwdRel === null) {
      out.push({
        ...base,
        error:
          c.cwd === undefined
            ? `It has no cwd, so it runs in the project folder ${folder}, which is not inside ${root}`
            : `Its cwd ${JSON.stringify(c.cwd)} is outside the project`,
      })
      continue
    }
    const argv = commandArgv(c.run)
    if (!argv.ok) {
      out.push({ ...base, cwdRel, error: argv.error })
      continue
    }
    const read = await readCommandBody(root, { argv: argv.argv, cwdRel })
    out.push({
      ...base,
      run: argv.argv,
      cwdRel,
      body: read.body,
      ...(read.error !== undefined ? { error: read.error } : {}),
    })
  }
  return out
}
