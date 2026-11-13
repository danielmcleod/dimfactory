// One run of the grounding checks over a pass, with its I/O injected (the controller's shadow and folder; fakes in
// tests): the pass's patch and changed paths, the project's files at its end, its manifests, lockfiles and tsconfig,
// and node_modules on disk. Then the pure checks (checks.ts), the offline dependency check, the optional registry
// lookup and the optional AI judge. Never throws for a check's own failure: what could not be read is left out.
import type { FindingInput } from '../supervisor/types.ts'
import { pathRefs } from './claims.ts'
import type { GroundingInput, VerifyFact } from './checks.ts'
import { runGroundingChecks } from './checks.ts'
import type { GroundingTrack } from './evidence.ts'
import type { ImportFacts } from './imports.ts'
import { importsOf, langOf, pipName } from './imports.ts'
import { judgePrompt, parseJudgeAnswer } from './judge.ts'
import type { AddedDependency, RegistryFetcher } from './packages.ts'
import {
  LOCKFILES,
  addedDependencies,
  lockedNames,
  manifestDeps,
  manifestKind,
  missingFromRegistry,
  notInstalled,
} from './packages.ts'
import { linkFindings } from './links.ts'
import { addedLinesByFile } from './patch.ts'

export interface GroundingIo {
  /** The pass's changes as a zero-context patch (paths relative to the run's folder). */
  patch(from: string, to: string): Promise<string>
  /** Paths the pass changed, relative to the run's folder. */
  changedPaths(from: string, to: string): Promise<string[]>
  /** Every file of the project at a commit, relative to the run's folder. */
  files(commit: string): Promise<string[]>
  /** A file's text at a commit; null when it is not there. */
  fileAt(commit: string, path: string): Promise<string | null>
  /** A path exists in the folder on disk now (ignored files, node_modules). */
  onDisk(path: string): boolean
}

export interface GroundingRequest {
  step: 'implement' | 'fix'
  from: string
  to: string
  finalText: string
  plan?: string | undefined
  evidence?: GroundingTrack | undefined
  verify?: readonly VerifyFact[] | undefined
  registryCheck: boolean
  judge?: { vendor: string } | undefined
  /** A research memo's run: the web sources Research found (the memo's links are checked against them). */
  sources?: readonly string[] | undefined
}

export interface GroundingDeps {
  /** The registry lookup (only with `registryCheck`); absent: none is made. */
  registry?: RegistryFetcher | undefined
  /** The AI judge: one read-only answer from the vendor's cheapest model; absent: the judge does not run. */
  judge?: ((vendor: string, prompt: string) => Promise<string>) | undefined
}

const MANIFEST_MAX = 30
const DEFAULT_ALIASES = ['@/', '~/']

/** JSON with comments and trailing commas (tsconfig.json), read leniently; undefined when it still cannot be read. */
export function readJsonc(text: string | null): unknown {
  if (text === null) return undefined
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(stripped) as unknown
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** tsconfig `paths` keys as alias prefixes (`@shared/*` → `@shared/`, `utils` → `utils`). */
export function tsconfigAliases(text: string | null): string[] {
  const doc = readJsonc(text)
  const paths =
    isRecord(doc) && isRecord(doc['compilerOptions']) ? doc['compilerOptions']['paths'] : undefined
  if (!isRecord(paths)) return []
  return Object.keys(paths).map((k) => k.replace(/\*$/, ''))
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** What the project has for the import check, read at the pass's end. */
async function importFacts(io: GroundingIo, to: string, files: ReadonlySet<string>): Promise<ImportFacts> {
  const all = [...files]
  const pick = (re: RegExp): string[] =>
    all.filter((f) => re.test(f) && !f.includes('node_modules/')).slice(0, MANIFEST_MAX)
  const read = (p: string): Promise<string | null> => io.fileAt(to, p).catch(() => null)
  // npm
  const pkgJsons = pick(/(?:^|\/)package\.json$/)
  const npmNames = new Set<string>()
  for (const p of pkgJsons) for (const n of manifestDeps('package-json', await read(p))) npmNames.add(n)
  for (const l of pick(/(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/)) {
    const text = await read(l)
    if (text !== null) for (const n of lockedNames(l, text) ?? []) npmNames.add(n)
  }
  // Workspace packages are the project's own.
  for (const p of pkgJsons) {
    const doc = readJsonc(await read(p))
    if (isRecord(doc) && typeof doc['name'] === 'string') npmNames.add(doc['name'])
  }
  const aliases = [...DEFAULT_ALIASES]
  for (const t of pick(/(?:^|\/)(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json$/))
    aliases.push(...tsconfigAliases(await read(t)))
  // python
  const pyManifests = pick(
    /(?:^|\/)(?:requirements(?:[-_.][^/]*)?\.(?:txt|in)|pyproject\.toml|Pipfile|setup\.cfg|setup\.py)$/,
  )
  const pyNames = new Set<string>()
  for (const p of pyManifests) {
    const text = await read(p)
    const kind = manifestKind(p)
    if (kind !== null) for (const n of manifestDeps(kind.kind, text)) pyNames.add(n)
    else if (text !== null)
      // Pipfile, setup.cfg, setup.py: any quoted or listed requirement-looking name.
      for (const m of text.matchAll(/["'\s]([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~]=?|["',\]]|$)/gm))
        pyNames.add(pipName(m[1] ?? ''))
  }
  for (const l of pick(/(?:^|\/)(?:poetry\.lock|uv\.lock|Pipfile\.lock)$/)) {
    const text = await read(l)
    if (text !== null) for (const n of lockedNames(l, text) ?? []) pyNames.add(n)
  }
  // go
  const goMod = all.includes('go.mod') ? await read('go.mod') : null
  const goModule = goMod !== null ? /^\s*module\s+(\S+)/m.exec(goMod)?.[1] : undefined
  // rust
  const cargo = pick(/(?:^|\/)Cargo\.toml$/)
  const crates = new Set<string>()
  for (const c of cargo) {
    const text = await read(c)
    for (const n of manifestDeps('cargo', text)) crates.add(n)
    const name = text !== null ? /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] : undefined
    if (name !== undefined) crates.add(name.replace(/-/g, '_'))
  }
  return {
    files,
    npm: {
      manifest: pkgJsons.length > 0,
      names: npmNames,
      aliases,
      installed: (name) => io.onDisk(`node_modules/${name}`),
    },
    python: { manifest: pyManifests.length > 0, names: pyNames },
    go: {
      ...(goModule !== undefined ? { module: goModule } : {}),
      requires: [...manifestDeps('go-mod', goMod)],
    },
    rust: { manifest: cargo.length > 0, crates },
  }
}

/** Dependencies the pass added to a manifest, and which of them are not installed. */
async function dependencyFacts(
  io: GroundingIo,
  r: GroundingRequest,
  changed: readonly string[],
  files: ReadonlySet<string>,
): Promise<{ added: AddedDependency[]; missing: AddedDependency[] }> {
  const added: AddedDependency[] = []
  for (const m of changed
    .filter((p) => manifestKind(p) !== null && !p.includes('node_modules/'))
    .slice(0, MANIFEST_MAX)) {
    const [before, after] = await Promise.all([
      io.fileAt(r.from, m).catch(() => null),
      io.fileAt(r.to, m).catch(() => null),
    ])
    added.push(...addedDependencies(m, before, after))
  }
  if (added.length === 0) return { added, missing: [] }
  const locks = new Map<string, Set<string> | null>()
  for (const d of added) {
    const dir = dirOf(d.manifest)
    for (const l of LOCKFILES[d.ecosystem]) {
      const p = dir === '' ? l : `${dir}/${l}`
      if (locks.has(p) || !files.has(p)) continue
      const text = await io.fileAt(r.to, p).catch(() => null)
      locks.set(p, text !== null ? lockedNames(p, text) : null)
    }
  }
  const missing = notInstalled(added, locks, (dir, name) =>
    io.onDisk(dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`),
  )
  return { added, missing }
}

/** The grounding checks over one pass: findings (source grounding) and notes. */
export async function runGrounding(
  io: GroundingIo,
  r: GroundingRequest,
  deps: GroundingDeps = {},
): Promise<{ findings: FindingInput[]; notes: string[] }> {
  const [patch, changed, fileList] = await Promise.all([
    io.patch(r.from, r.to),
    io.changedPaths(r.from, r.to),
    io.files(r.to),
  ])
  const files = new Set(fileList)
  // A path the message names that the snapshots leave out (an ignored file) may still be on disk.
  for (const ref of pathRefs(r.finalText))
    if (!files.has(ref.path) && io.onDisk(ref.path)) files.add(ref.path)
  const added = addedLinesByFile(patch)
  const wantsImports = [...added.entries()].some(
    ([f, lines]) => langOf(f) !== undefined && importsOf(f, lines).length > 0,
  )
  const imports = wantsImports ? await importFacts(io, r.to, files) : undefined
  const deps6 = await dependencyFacts(io, r, changed, files)
  const notes: string[] = []
  let registryMissing: AddedDependency[] = []
  if (r.registryCheck && deps.registry !== undefined && deps6.added.length > 0) {
    registryMissing = await missingFromRegistry(deps6.added, deps.registry)
  }
  const input: GroundingInput = {
    step: r.step,
    finalText: r.finalText,
    plan: r.plan,
    changed: new Set(changed),
    files,
    evidence: r.evidence,
    verify: r.verify,
    added,
    imports,
    notInstalled: deps6.missing,
    registryMissing,
  }
  const out = runGroundingChecks(input)
  notes.push(...out.notes)
  const findings = [...out.findings]
  if (r.sources !== undefined && r.sources.length > 0) findings.push(...linkFindings(added, r.sources))
  if (r.judge !== undefined && deps.judge !== undefined) {
    let plus = 0
    let minus = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) plus++
      else if (line.startsWith('-') && !line.startsWith('---')) minus++
    }
    const prompt = judgePrompt({
      step: r.step,
      finalText: r.finalText,
      diff: { files: changed.length, added: plus, deleted: minus, paths: changed },
      evidence: r.evidence,
      verify: r.verify?.map((v) => ({ name: v.name, status: v.status })),
    })
    try {
      const answer = await deps.judge(r.judge.vendor, prompt)
      const judged = parseJudgeAnswer(answer, r.step).filter((j) => !findings.some((f) => f.id === j.id))
      findings.push(...judged)
    } catch (err) {
      notes.push(
        `The AI judge could not check the claims: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return { findings, notes }
}
