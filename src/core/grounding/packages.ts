// Dependencies a run added to a manifest (package.json, requirements*.txt, pyproject.toml, Cargo.toml, go.mod), checked
// offline against the lockfile beside it (and node_modules for npm): one with no lockfile entry was never installed,
// and may not exist at all. The optional online check asks the public registry (npm, PyPI, crates.io) through an
// injected fetcher; it is off unless the user turns it on. Parsing is plain text, never throws.
import { BRAND } from '../../shared/brand.ts'
import { parseLockfile } from '../security/deps.ts'
import type { Ecosystem } from '../security/deps.ts'
import { pipName } from './imports.ts'

export interface ManifestKind {
  ecosystem: Ecosystem
  kind: 'package-json' | 'requirements' | 'pyproject' | 'cargo' | 'go-mod'
}

/** Which manifests the check reads (by basename). */
export function manifestKind(path: string): ManifestKind | null {
  const base = path.split('/').pop() ?? ''
  if (base === 'package.json') return { ecosystem: 'npm', kind: 'package-json' }
  if (/^requirements(?:[-_.][^/]*)?\.(?:txt|in)$/.test(base))
    return { ecosystem: 'pip', kind: 'requirements' }
  if (base === 'pyproject.toml') return { ecosystem: 'pip', kind: 'pyproject' }
  if (base === 'Cargo.toml') return { ecosystem: 'cargo', kind: 'cargo' }
  if (base === 'go.mod') return { ecosystem: 'go', kind: 'go-mod' }
  return null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/** package.json's dependency names (every section). */
export function packageJsonDeps(text: string | null): Set<string> {
  const out = new Set<string>()
  if (text === null) return out
  try {
    const doc = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
    if (!isRecord(doc)) return out
    for (const s of NPM_SECTIONS) {
      const deps = doc[s]
      if (!isRecord(deps)) continue
      for (const [name, spec] of Object.entries(deps)) {
        // A workspace or local link is the project's own.
        if (typeof spec === 'string' && /^(?:workspace:|file:|link:|portal:)/.test(spec)) continue
        out.add(name)
      }
    }
  } catch {
    // unreadable: no names
  }
  return out
}

/** A PEP 508 requirement's name (`requests[socks]>=2 ; python_version<'3'` → requests). */
function requirementName(s: string): string | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s)
  return m?.[1] !== undefined ? pipName(m[1]) : undefined
}

export function requirementsDeps(text: string | null): Set<string> {
  const out = new Set<string>()
  if (text === null) return out
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (line === '' || line.startsWith('-') || /:\/\//.test(line)) continue
    const n = requirementName(line)
    if (n !== undefined) out.add(n)
  }
  return out
}

/** pyproject.toml: `[project] dependencies = [...]`, optional-dependencies, and Poetry's dependency tables. */
export function pyprojectDeps(text: string | null): Set<string> {
  const out = new Set<string>()
  if (text === null) return out
  let table = ''
  let inArray = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (line === '') continue
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (header !== null && !inArray) {
      table = header[1] ?? ''
      continue
    }
    if (inArray) {
      for (const m of line.matchAll(/["']([^"']+)["']/g)) {
        const n = requirementName(m[1] ?? '')
        if (n !== undefined) out.add(n)
      }
      if (line.includes(']')) inArray = false
      continue
    }
    const arrayStart =
      (table === 'project' && /^dependencies\s*=\s*\[/.test(line)) ||
      (table === 'project.optional-dependencies' && /^[\w-]+\s*=\s*\[/.test(line))
    if (arrayStart) {
      const rest = line.slice(line.indexOf('[') + 1)
      for (const m of rest.matchAll(/["']([^"']+)["']/g)) {
        const n = requirementName(m[1] ?? '')
        if (n !== undefined) out.add(n)
      }
      inArray = !rest.includes(']')
      continue
    }
    if (/^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\.[\w-]+\.dependencies$/.test(table)) {
      const kv = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line)
      if (kv !== null && kv[1] !== 'python') out.add(pipName(kv[1] ?? ''))
    }
  }
  return out
}

/** Cargo.toml: names in `[*dependencies]` tables and `[dependencies.<name>]` headers (`-` and `_` alike). */
export function cargoDeps(text: string | null): Set<string> {
  const out = new Set<string>()
  if (text === null) return out
  let inDeps = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header !== null) {
      const h = header[1] ?? ''
      const sub = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(h)
      if (sub !== null) {
        out.add((sub[1] ?? '').replace(/-/g, '_'))
        inDeps = false
      } else inDeps = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(h)
      continue
    }
    if (!inDeps) continue
    const kv = /^([A-Za-z0-9_-]+)\s*=/.exec(line)
    if (kv !== null) out.add((kv[1] ?? '').replace(/-/g, '_'))
  }
  return out
}

export function goModDeps(text: string | null): Set<string> {
  if (text === null) return new Set()
  const parsed = parseLockfile('go.mod', text)
  return new Set(parsed !== null ? parsed.keys() : [])
}

/** A manifest's dependency names (`kind` decides how it is read). */
export function manifestDeps(kind: ManifestKind['kind'], text: string | null): Set<string> {
  switch (kind) {
    case 'package-json':
      return packageJsonDeps(text)
    case 'requirements':
      return requirementsDeps(text)
    case 'pyproject':
      return pyprojectDeps(text)
    case 'cargo':
      return cargoDeps(text)
    case 'go-mod':
      return goModDeps(text)
  }
}

/** The lockfiles that pin a manifest's ecosystem, by basename (same folder as the manifest). */
export const LOCKFILES: Readonly<Record<Ecosystem, readonly string[]>> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
  pip: ['poetry.lock', 'uv.lock', 'Pipfile.lock'],
  cargo: ['Cargo.lock'],
  go: ['go.sum'],
}

/** The names a lockfile locks, in the manifest's spelling (pip normalized, cargo `_`). */
export function lockedNames(lockPath: string, text: string): Set<string> | null {
  const parsed = parseLockfile(lockPath, text)
  if (parsed === null) return null
  const out = new Set<string>()
  for (const name of parsed.keys()) {
    if (lockPath.endsWith('Cargo.lock')) out.add(name.replace(/-/g, '_'))
    else if (/(?:poetry|uv|Pipfile)\.lock$/.test(lockPath)) out.add(pipName(name))
    else out.add(name)
  }
  return out
}

export interface AddedDependency {
  manifest: string
  ecosystem: Ecosystem
  name: string
}

/** Names a manifest gained between the run's base and its end. */
export function addedDependencies(
  manifest: string,
  before: string | null,
  after: string | null,
): AddedDependency[] {
  const kind = manifestKind(manifest)
  if (kind === null || after === null) return []
  const was = manifestDeps(kind.kind, before)
  return [...manifestDeps(kind.kind, after)]
    .filter((n) => !was.has(n))
    .sort()
    .map((name) => ({ manifest, ecosystem: kind.ecosystem, name }))
}

/**
 * Added dependencies that were never installed: no lockfile beside the manifest names them. npm without a lockfile
 * counts node_modules instead; the other ecosystems without one are not judged (nothing pins them).
 */
export function notInstalled(
  added: readonly AddedDependency[],
  locks: ReadonlyMap<string, Set<string> | null>,
  npmInstalled: (manifestDir: string, name: string) => boolean,
): AddedDependency[] {
  return added.filter((d) => {
    const dir = d.manifest.includes('/') ? d.manifest.slice(0, d.manifest.lastIndexOf('/')) : ''
    const sets = LOCKFILES[d.ecosystem]
      .map((l) => locks.get(dir === '' ? l : `${dir}/${l}`))
      .filter((s): s is Set<string> => s !== undefined && s !== null)
    if (sets.length > 0) {
      if (sets.some((s) => s.has(d.name))) return false
      return !(d.ecosystem === 'npm' && npmInstalled(dir, d.name))
    }
    if (d.ecosystem === 'npm') return !npmInstalled(dir, d.name)
    return false
  })
}

// ---- the online registry check (opt-in) ------------------------------------------------------------------------------

/** Whether a package exists in its public registry; `unknown` when the lookup failed (never a finding). */
export type RegistryAnswer = 'exists' | 'missing' | 'unknown'
export type RegistryFetcher = (ecosystem: Ecosystem, name: string) => Promise<RegistryAnswer>

/** The registry URL a name is looked up at (Go modules are not looked up). */
export function registryUrl(ecosystem: Ecosystem, name: string): string | null {
  const n = encodeURIComponent(name).replace(/^%40/, '@')
  switch (ecosystem) {
    case 'npm':
      return `https://registry.npmjs.org/${n}`
    case 'pip':
      return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
    case 'cargo':
      return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`
    case 'go':
      return null
  }
}

/** The default fetcher: a HEAD-like GET with a short timeout; 404 is `missing`, any 2xx `exists`. */
export function httpRegistryFetcher(fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): RegistryFetcher {
  return async (ecosystem, name) => {
    const url = registryUrl(ecosystem, name)
    if (url === null) return 'unknown'
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, {
        method: 'GET',
        signal: ac.signal,
        headers: { accept: 'application/json', 'user-agent': `${BRAND.slug}-grounding` },
      })
      if (r.status === 404) return 'missing'
      return r.ok ? 'exists' : 'unknown'
    } catch {
      return 'unknown'
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Ask the registry about each name once (at most `max`); names it does not know come back. */
export async function missingFromRegistry(
  deps: readonly AddedDependency[],
  fetcher: RegistryFetcher,
  max = 20,
): Promise<AddedDependency[]> {
  const out: AddedDependency[] = []
  const seen = new Set<string>()
  for (const d of deps) {
    const key = `${d.ecosystem}:${d.name}`
    if (seen.has(key) || seen.size >= max) continue
    seen.add(key)
    const a = await fetcher(d.ecosystem, d.name).catch((): RegistryAnswer => 'unknown')
    if (a === 'missing') out.push(d)
  }
  return out
}
