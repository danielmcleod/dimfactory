// Dependency lockfiles for the security advisor: which files are lockfiles or pinned manifests, what each one locks,
// and which dependencies a change added or moved to a new version. Only those dependencies can make an audit
// advisory a finding of the change; an advisory on anything else was there before and is only a note.
// Pure text parsing, no YAML or TOML library: package-lock.json (v1 tree, v2/v3 `packages`), pnpm-lock.yaml (v5, v6,
// v9), yarn.lock (classic and Yarn 2+), requirements.txt, poetry.lock, uv.lock, Pipfile.lock, Cargo.lock, go.sum and
// go.mod. A file that cannot be read as its format parses to null; nothing here throws.

export type Ecosystem = 'npm' | 'pip' | 'cargo' | 'go'

/** dependency name (normalized for its ecosystem) -> the versions locked */
export type DepVersions = Map<string, Set<string>>

export interface LockfileInfo {
  ecosystem: Ecosystem
  /**
   * 'package-lock' | 'pnpm-lock' | 'yarn-lock' | 'requirements' | 'poetry-lock' | 'uv-lock' | 'pipfile-lock' |
   * 'cargo-lock' | 'go-sum' | 'go-mod'
   */
  kind: string
}

/** A version that is not pinned exactly (a `>=` requirement, a URL): the name is known, the version is not. */
export const ANY_VERSION = '*'

const BY_BASENAME: ReadonlyMap<string, LockfileInfo> = new Map([
  ['package-lock.json', { ecosystem: 'npm', kind: 'package-lock' }],
  ['npm-shrinkwrap.json', { ecosystem: 'npm', kind: 'package-lock' }],
  ['pnpm-lock.yaml', { ecosystem: 'npm', kind: 'pnpm-lock' }],
  ['yarn.lock', { ecosystem: 'npm', kind: 'yarn-lock' }],
  ['requirements.txt', { ecosystem: 'pip', kind: 'requirements' }],
  ['poetry.lock', { ecosystem: 'pip', kind: 'poetry-lock' }],
  ['uv.lock', { ecosystem: 'pip', kind: 'uv-lock' }],
  ['Pipfile.lock', { ecosystem: 'pip', kind: 'pipfile-lock' }],
  ['Cargo.lock', { ecosystem: 'cargo', kind: 'cargo-lock' }],
  ['go.sum', { ecosystem: 'go', kind: 'go-sum' }],
  ['go.mod', { ecosystem: 'go', kind: 'go-mod' }],
])

/** `requirements-dev.txt`, `requirements_test.txt`, `requirements.in.txt` (requirements.txt itself is in the map). */
const REQUIREMENTS_VARIANT = /^requirements[-_.][^/]*\.txt$/

/**
 * By basename (case-sensitive as the tools are): package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock,
 * requirements.txt (and requirements-*.txt, or any .txt in a `requirements/` folder), poetry.lock, uv.lock,
 * Pipfile.lock, Cargo.lock, go.sum, go.mod. Null for anything else.
 */
export function lockfileInfo(path: string): LockfileInfo | null {
  const parts = path.replace(/\\/g, '/').split('/')
  const base = parts[parts.length - 1] ?? ''
  const known = BY_BASENAME.get(base)
  if (known !== undefined) return { ...known }
  if (REQUIREMENTS_VARIANT.test(base)) return { ecosystem: 'pip', kind: 'requirements' }
  if (parts.length >= 2 && parts[parts.length - 2] === 'requirements' && /^[^/]+\.txt$/.test(base))
    return { ecosystem: 'pip', kind: 'requirements' }
  return null
}

/** pip names lower-case with runs of `-_.` collapsed to `-` (PEP 503); npm, cargo and go names as they are. */
export function normalizeDepName(ecosystem: Ecosystem, name: string): string {
  const trimmed = name.trim()
  return ecosystem === 'pip' ? trimmed.toLowerCase().replace(/[-_.]+/g, '-') : trimmed
}

function add(out: DepVersions, ecosystem: Ecosystem, name: string, version: string): void {
  const n = normalizeDepName(ecosystem, name)
  const v = version.trim()
  if (n === '' || v === '') return
  const set = out.get(n)
  if (set === undefined) out.set(n, new Set([v]))
  else set.add(v)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** A byte order mark at the start of a file is not content. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripBom(text)) as unknown
  } catch {
    return undefined
  }
}

const lines = (text: string): string[] => stripBom(text).split(/\r?\n/)

// ---- npm ----------------------------------------------------------------------------------------------------------

/** package-lock.json / npm-shrinkwrap.json: v2/v3 `packages` when present, else the v1 `dependencies` tree. */
function parsePackageLock(text: string): DepVersions | null {
  const doc = parseJson(text)
  if (!isRecord(doc)) return null
  const out: DepVersions = new Map()
  const packages = doc['packages']
  if (isRecord(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (key === '' || !isRecord(entry) || entry['link'] === true) continue
      const at = key.lastIndexOf('node_modules/')
      if (at < 0) continue // a workspace folder, not an installed package
      const version = entry['version']
      if (typeof version !== 'string') continue
      // An alias (`"node_modules/alias": {"name": "real"}`) is audited under the real name.
      const name = typeof entry['name'] === 'string' ? entry['name'] : key.slice(at + 'node_modules/'.length)
      add(out, 'npm', name, version)
    }
    return out
  }
  const walk = (deps: unknown): void => {
    if (!isRecord(deps)) return
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry)) continue
      if (typeof entry['version'] === 'string') add(out, 'npm', name, entry['version'])
      walk(entry['dependencies'])
    }
  }
  if (!isRecord(doc['dependencies']) && doc['lockfileVersion'] === undefined) return null
  walk(doc['dependencies'])
  return out
}

/** pnpm v6+ key after the leading `/` is dropped: `name@1.2.3`, `@scope/name@1.2.3`, peers `(react@18.2.0)` after. */
const PNPM_AT_KEY = /^((?:@[^/@\s]+\/)?[^/@\s()]+)@([^@\s()/:]+)(?:\(.*\))?$/
/** pnpm v5 key after the leading `/`: `name/1.2.3`, `@scope/name/1.2.3`, peers `_react@18.2.0` after. */
const PNPM_SLASH_KEY = /^((?:@[^/@\s]+\/)?[^/@\s()]+)\/([^/\s_()]+)(?:_.+)?$/

/** pnpm-lock.yaml: the two-space keys of `packages:` (and v9's `snapshots:`), read line by line. */
function parsePnpmLock(text: string): DepVersions | null {
  const all = lines(text)
  const versionLine = all.find((l) => /^lockfileVersion:/.test(l))
  if (versionLine === undefined) return null
  const major = Number(/(\d+)/.exec(versionLine)?.[1] ?? 'NaN')
  const v5 = Number.isFinite(major) && major < 6
  const out: DepVersions = new Map()
  let inPackages = false
  for (const line of all) {
    if (/^\S/.test(line)) {
      inPackages = /^(?:packages|snapshots):\s*$/.test(line)
      continue
    }
    if (!inPackages) continue
    const m = /^ {2}(\S.*?):(?:\s*\{\})?\s*$/.exec(line)
    if (m === null) continue
    const key = (m[1] ?? '').replace(/^(['"])(.*)\1$/, '$2').replace(/^\//, '')
    const hit = v5 ? (PNPM_SLASH_KEY.exec(key) ?? PNPM_AT_KEY.exec(key)) : PNPM_AT_KEY.exec(key)
    if (hit !== null) add(out, 'npm', hit[1] ?? '', hit[2] ?? '')
  }
  return out
}

/** The package name of a yarn descriptor: before the first `@` that is not the scope's. */
function yarnDescriptorName(descriptor: string): string | null {
  const d = descriptor.trim().replace(/^['"]|['"]$/g, '')
  const at = d.indexOf('@', 1)
  if (at <= 0) return null
  return d.slice(0, at)
}

/** yarn.lock, classic (`a@^1, a@~1:` then `  version "1.2.3"`) and Yarn 2+ (`"a@npm:^1":` then `  version: 1.2.3`). */
function parseYarnLock(text: string): DepVersions | null {
  const out: DepVersions = new Map()
  let current: string | null = null
  let headers = 0
  let content = false
  for (const line of lines(text)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    content = true
    if (/^\S/.test(line)) {
      current = null
      const m = /^(.*):\s*$/.exec(line)
      if (m === null) continue
      headers++
      const first = (m[1] ?? '').split(',')[0] ?? ''
      if (/^"?__metadata"?$/.test(first.trim()) || /@(?:workspace|link|portal):/.test(first)) continue
      current = yarnDescriptorName(first)
      continue
    }
    if (current === null) continue
    const v = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line)
    if (v !== null) {
      add(out, 'npm', current, v[1] ?? '')
      current = null
    }
  }
  if (content && headers === 0) return null
  return out
}

// ---- pip ----------------------------------------------------------------------------------------------------------

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/

/** requirements.txt: `name==1.2.3` is pinned; any other requirement records the name with version `*`. */
function parseRequirements(text: string): DepVersions | null {
  if (text.includes('\0')) return null
  const out: DepVersions = new Map()
  const joined = stripBom(text).replace(/\\\r?\n/g, ' ')
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (line === '' || line.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue
    const m = REQUIREMENT.exec(line)
    if (m === null) continue
    // Options after the requirement (`--hash=...`) and the environment marker (`; python_version < "3.9"`) go.
    const spec = (m[2] ?? '')
      .replace(/\s--\S.*$/, '')
      .replace(/;.*$/, '')
      .trim()
    if (spec.startsWith('@') || /^[a-z+]+:\/\//i.test(spec)) {
      add(out, 'pip', m[1] ?? '', ANY_VERSION)
      continue
    }
    const pin = /^===?\s*([^\s,*]+)$/.exec(spec)
    add(out, 'pip', m[1] ?? '', pin !== null ? (pin[1] ?? ANY_VERSION) : ANY_VERSION)
  }
  return out
}

/** Pipfile.lock: the `default` and `develop` maps, `"version": "==1.2.3"`. */
function parsePipfileLock(text: string): DepVersions | null {
  const doc = parseJson(text)
  if (!isRecord(doc) || (!isRecord(doc['default']) && !isRecord(doc['develop']))) return null
  const out: DepVersions = new Map()
  for (const section of ['default', 'develop']) {
    const deps = doc[section]
    if (!isRecord(deps)) continue
    for (const [name, entry] of Object.entries(deps)) {
      const version = isRecord(entry) ? entry['version'] : undefined
      add(out, 'pip', name, typeof version === 'string' ? version.replace(/^===?\s*/, '') : ANY_VERSION)
    }
  }
  return out
}

// ---- TOML [[package]] blocks: poetry.lock, uv.lock, Cargo.lock ----------------------------------------------------

function parseTomlPackages(text: string, ecosystem: Ecosystem): DepVersions | null {
  const out: DepVersions = new Map()
  let blocks = 0
  let inBase = false
  let pkg: { name?: string; version?: string; local?: boolean } = {}
  const flush = (): void => {
    if (pkg.name !== undefined && pkg.version !== undefined && pkg.local !== true)
      add(out, ecosystem, pkg.name, pkg.version)
    pkg = {}
  }
  for (const line of lines(text)) {
    if (/^\s*\[/.test(line)) {
      if (/^\s*\[\[\s*package\s*\]\]\s*$/.test(line)) {
        flush()
        blocks++
        inBase = true
      } else {
        inBase = false
      }
      continue
    }
    if (!inBase) continue
    const kv = /^(name|version)\s*=\s*"([^"]*)"/.exec(line)
    if (kv !== null) {
      if (kv[1] === 'name') pkg.name ??= kv[2] ?? ''
      else pkg.version ??= kv[2] ?? ''
      continue
    }
    // uv.lock: the project itself and workspace members are `source = { editable = "." }` or `{ virtual = "." }`.
    if (/^source\s*=\s*\{[^}]*\b(?:editable|virtual)\s*=/.test(line)) pkg.local = true
  }
  flush()
  if (blocks > 0) return out
  // No package at all: still a lockfile when it reads as TOML (tables and `key = value` lines), or is empty.
  const meaningful = lines(text).filter((l) => l.trim() !== '' && !/^\s*#/.test(l))
  const toml = meaningful.every((l) => /^\s*\[/.test(l) || /^\s*[\w."-]+\s*=/.test(l))
  return toml ? out : null
}

// ---- go -----------------------------------------------------------------------------------------------------------

/** go.sum: `module version[/go.mod] h1:hash`; the `/go.mod` suffix is dropped, the version kept as printed. */
function parseGoSum(text: string): DepVersions | null {
  const out: DepVersions = new Map()
  let bad = 0
  for (const line of lines(text)) {
    if (line.trim() === '') continue
    const m = /^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s+\S+:\S+\s*$/.exec(line)
    if (m === null) {
      bad++
      continue
    }
    add(out, 'go', m[1] ?? '', m[2] ?? '')
  }
  if (out.size === 0 && bad > 0) return null
  return out
}

/** go.mod: `require module v1.2.3` lines and `require ( ... )` blocks, `// indirect` allowed. */
function parseGoMod(text: string): DepVersions | null {
  const all = lines(text)
  if (!all.some((l) => /^\s*module\s+\S/.test(l))) return null
  const out: DepVersions = new Map()
  let inRequire = false
  for (const raw of all) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (inRequire) {
      if (line === ')') {
        inRequire = false
        continue
      }
      const m = /^(\S+)\s+(v\S+)$/.exec(line)
      if (m !== null) add(out, 'go', m[1] ?? '', m[2] ?? '')
      continue
    }
    if (/^require\s*\($/.test(line)) {
      inRequire = true
      continue
    }
    const single = /^require\s+(\S+)\s+(v\S+)$/.exec(line)
    if (single !== null) add(out, 'go', single[1] ?? '', single[2] ?? '')
  }
  return out
}

/** Parse one lockfile's text; null when it cannot be read as that format. Never throws. */
export function parseLockfile(path: string, text: string): DepVersions | null {
  const info = lockfileInfo(path)
  if (info === null) return null
  try {
    switch (info.kind) {
      case 'package-lock':
        return parsePackageLock(text)
      case 'pnpm-lock':
        return parsePnpmLock(text)
      case 'yarn-lock':
        return parseYarnLock(text)
      case 'requirements':
        return parseRequirements(text)
      case 'pipfile-lock':
        return parsePipfileLock(text)
      case 'poetry-lock':
      case 'uv-lock':
      case 'cargo-lock':
        return parseTomlPackages(text, info.ecosystem)
      case 'go-sum':
        return parseGoSum(text)
      case 'go-mod':
        return parseGoMod(text)
      default:
        return null
    }
  } catch {
    return null
  }
}

export interface DepChange {
  name: string
  /** sorted versions */
  from: string[]
  /** sorted versions */
  to: string[]
}

const collator = new Intl.Collator('en', { numeric: true })
const sorted = (s: ReadonlySet<string> | undefined): string[] => [...(s ?? [])].sort(collator.compare)

/**
 * Added names, and names that gained a version not locked before. Removed-only names are not changes. Sorted by
 * name. With no `before` (the lockfile is new, or could not be read) every dependency is added.
 */
export function changedDependencies(before: DepVersions | null, after: DepVersions): DepChange[] {
  const out: DepChange[] = []
  for (const [name, versions] of after) {
    const was = before?.get(name)
    const gained = was === undefined || [...versions].some((v) => !was.has(v))
    if (gained) out.push({ name, from: sorted(was), to: sorted(versions) })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
