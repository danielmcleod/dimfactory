// What a folder says about how it ships, read with no model and no tokens: the root entries, package.json's
// dependencies and scripts, the Python, Rust and Go manifests, and the config files of the usual hosts and doc tools.
// Reads a bounded, fixed set of files; never runs anything and never touches the network. The classifier
// (classify.ts) is a pure function of these signals, so its corpus is unit-tested without files.
import type { Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** One file read is capped here (manifests and configs are small). */
export const SIGNAL_FILE_MAX_BYTES = 256 * 1024

export interface PackageSignals {
  name?: string
  version?: string
  deps: string[]
  scripts: Record<string, string>
  private: boolean
  /** `main`, `module`, `exports` or `types`: something a consumer imports. */
  library: boolean
  bin: boolean
}

export interface PythonSignals {
  /** Dependency names (lower case) from pyproject.toml and requirements*.txt. */
  deps: string[]
  /** pyproject.toml declares a build backend (`[build-system]`). */
  buildSystem: boolean
  /** `[project.scripts]` or setup.py console scripts. */
  scripts: boolean
  name?: string
  version?: string
}

export interface RustSignals {
  bin: boolean
  lib: boolean
  deps: string[]
  name?: string
  version?: string
}

/** Everything the classifier and the command placeholders read. */
export interface DeploySignals {
  /** Root entry names (files and folders), as written. */
  files: string[]
  dirs: string[]
  pkg?: PackageSignals
  python?: PythonSignals
  rust?: RustSignals
  go?: { main: boolean; deps: string[] }
  /** The Dockerfile's `EXPOSE` port, when it has one. */
  exposePort?: number
  /** `app.json` names Expo. */
  expo: boolean
  /** An `index.html` at the root or in `public/`. */
  html: boolean
  /** Source files under api/ (Vercel's functions folder). */
  apiFunctions: boolean
  /** netlify/functions or netlify/edge-functions. */
  netlifyFunctions: boolean
  /** The folder's name (a fallback app name). */
  folderName: string
}

async function readCapped(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(SIGNAL_FILE_MAX_BYTES)
    const { bytesRead } = await fh.read(buf, 0, SIGNAL_FILE_MAX_BYTES, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function strings(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, s] of Object.entries(asRecord(v) ?? {})) if (typeof s === 'string') out[k] = s
  return out
}

/** package.json's facts (null: unreadable or not an object). */
export function parsePackageSignals(text: string): PackageSignals | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  const o = asRecord(v)
  if (o === undefined) return null
  const deps = [
    ...Object.keys(asRecord(o['dependencies']) ?? {}),
    ...Object.keys(asRecord(o['devDependencies']) ?? {}),
    ...Object.keys(asRecord(o['peerDependencies']) ?? {}),
  ]
  const name = typeof o['name'] === 'string' ? o['name'] : undefined
  const version = typeof o['version'] === 'string' ? o['version'] : undefined
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    deps: [...new Set(deps)].sort(),
    scripts: strings(o['scripts']),
    private: o['private'] === true,
    library: ['main', 'module', 'exports', 'types'].some((k) => o[k] !== undefined),
    bin: o['bin'] !== undefined,
  }
}

/** A requirement line's package name, lower case (`Flask>=2` → flask); undefined for options and comments. */
function requirementName(line: string): string | undefined {
  const t = line.replace(/#.*$/, '').trim()
  if (t === '' || t.startsWith('-')) return undefined
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(t)
  return m?.[1]?.toLowerCase().replace(/_/g, '-')
}

/** pyproject.toml (read as text: only the keys the classifier needs) and requirements files. */
export function parsePythonSignals(
  pyproject: string | undefined,
  requirements: readonly string[],
): PythonSignals {
  const deps = new Set<string>()
  for (const r of requirements)
    for (const line of r.split(/\r?\n/)) {
      const n = requirementName(line)
      if (n !== undefined) deps.add(n)
    }
  let buildSystem = false
  let scripts = false
  let name: string | undefined
  let version: string | undefined
  if (pyproject !== undefined) {
    buildSystem = /^\s*\[build-system\]/m.test(pyproject)
    scripts = /^\s*\[(?:project\.scripts|tool\.poetry\.scripts)\]/m.test(pyproject)
    name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1]
    version = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1]
    // `dependencies = [ "fastapi>=0.1", ... ]` and Poetry's `[tool.poetry.dependencies]` table keys.
    // The array closes at a `]` that ends its line (an extra like `uvicorn[standard]` has its own brackets inside).
    const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]\s*$/m.exec(pyproject)?.[1] ?? ''
    for (const m of list.matchAll(/["']([^"']+)["']/g)) {
      const n = requirementName(m[1] ?? '')
      if (n !== undefined) deps.add(n)
    }
    const poetry =
      /^\s*\[tool\.poetry\.dependencies\]([\s\S]*?)(?:^\s*\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? ''
    for (const line of poetry.split(/\r?\n/)) {
      const n = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line)?.[1]?.toLowerCase()
      if (n !== undefined && n !== 'python') deps.add(n.replace(/_/g, '-'))
    }
  }
  return {
    deps: [...deps].sort(),
    buildSystem,
    scripts,
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  }
}

export function parseRustSignals(cargo: string, hasMainRs: boolean, hasLibRs: boolean): RustSignals {
  const deps = new Set<string>()
  const block = /^\s*\[dependencies\]([\s\S]*?)(?:^\s*\[|$(?![\s\S]))/m.exec(cargo)?.[1] ?? ''
  for (const line of block.split(/\r?\n/)) {
    const n = /^\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/.exec(line)?.[1]
    if (n !== undefined) deps.add(n)
  }
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1]
  const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1]
  return {
    bin: hasMainRs || /^\s*\[\[bin\]\]/m.test(cargo),
    lib: hasLibRs || /^\s*\[lib\]/m.test(cargo),
    deps: [...deps].sort(),
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  }
}

/** go.mod's required modules. */
export function parseGoDeps(gomod: string): string[] {
  const out = new Set<string>()
  for (const m of gomod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[0-9]/gm)) {
    if (m[1] !== undefined) out.add(m[1])
  }
  return [...out].sort()
}

/** The first `EXPOSE <port>` of a Dockerfile. */
export function exposedPort(dockerfile: string): number | undefined {
  const m = /^\s*EXPOSE\s+(\d{2,5})/im.exec(dockerfile)
  const n = m?.[1] !== undefined ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs)$/i

async function hasSourceUnder(dir: string): Promise<boolean> {
  return (await listDir(dir)).some((e) => e.isFile() && SOURCE_EXT.test(e.name))
}

/** Read the signals of `folder` (bounded: the root, a few manifests, a few known subfolders). */
export async function readDeploySignals(folder: string): Promise<DeploySignals> {
  const entries = await listDir(folder)
  const files = entries.filter((e) => e.isFile()).map((e) => e.name)
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const has = (name: string): boolean => files.some((f) => f.toLowerCase() === name.toLowerCase())
  const hasDir = (name: string): boolean => dirs.some((d) => d.toLowerCase() === name.toLowerCase())
  const read = (name: string): Promise<string | undefined> => readCapped(join(folder, name))

  const pkgText = has('package.json') ? await read('package.json') : undefined
  const pkg = pkgText !== undefined ? parsePackageSignals(pkgText) : null

  const reqFiles = files.filter((f) => /^requirements[\w.-]*\.txt$/i.test(f)).slice(0, 5)
  const reqs = (await Promise.all(reqFiles.map((f) => read(f)))).filter((t): t is string => t !== undefined)
  const pyproject = has('pyproject.toml') ? await read('pyproject.toml') : undefined
  const python =
    pyproject !== undefined || reqs.length > 0 || has('setup.py') || has('Pipfile')
      ? parsePythonSignals(pyproject, reqs)
      : undefined
  if (python !== undefined && has('setup.py')) python.buildSystem = true

  let rust: RustSignals | undefined
  if (has('Cargo.toml')) {
    const cargo = (await read('Cargo.toml')) ?? ''
    const src = await listDir(join(folder, 'src'))
    rust = parseRustSignals(
      cargo,
      src.some((e) => e.name === 'main.rs'),
      src.some((e) => e.name === 'lib.rs'),
    )
  }

  let go: DeploySignals['go']
  if (has('go.mod')) {
    const gomod = (await read('go.mod')) ?? ''
    const main =
      has('main.go') || (hasDir('cmd') && (await listDir(join(folder, 'cmd'))).some((e) => e.isDirectory()))
    go = { main, deps: parseGoDeps(gomod) }
  }

  const dockerfile = has('Dockerfile') ? await read('Dockerfile') : undefined
  const port = dockerfile !== undefined ? exposedPort(dockerfile) : undefined
  const appJson = has('app.json') ? await read('app.json') : undefined
  const expo = appJson !== undefined && /"expo"\s*:/.test(appJson)
  const html =
    has('index.html') ||
    (hasDir('public') && (await listDir(join(folder, 'public'))).some((e) => e.name === 'index.html'))
  const apiFunctions = hasDir('api') && (await hasSourceUnder(join(folder, 'api')))
  const netlifyFunctions =
    hasDir('netlify') &&
    (await listDir(join(folder, 'netlify'))).some(
      (e) => e.isDirectory() && (e.name === 'functions' || e.name === 'edge-functions'),
    )

  return {
    files,
    dirs,
    ...(pkg !== null && pkg !== undefined ? { pkg } : {}),
    ...(python !== undefined ? { python } : {}),
    ...(rust !== undefined ? { rust } : {}),
    ...(go !== undefined ? { go } : {}),
    ...(port !== undefined ? { exposePort: port } : {}),
    expo,
    html,
    apiFunctions,
    netlifyFunctions,
    folderName: basename(folder),
  }
}

/** Signals for an empty folder (tests, and a folder that cannot be read). */
export function emptySignals(folderName = 'app'): DeploySignals {
  return {
    files: [],
    dirs: [],
    expo: false,
    html: false,
    apiFunctions: false,
    netlifyFunctions: false,
    folderName,
  }
}
