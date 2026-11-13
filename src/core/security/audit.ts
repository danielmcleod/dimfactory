// Dependency audits for the security advisor, without running anything: which audit tools apply to a change, what
// each tool's JSON output says, and which advisories the change brought in. An audit is planned only when the
// project uses the ecosystem and the change touched one of its manifests or lockfiles, and only for the project
// root. Each tool's output is read leniently (warnings or progress lines around the JSON are skipped, the exit code
// is never consulted) and turned into one shape of advisory. An advisory is "introduced" when its package is one the
// change added or moved to a new version; every other advisory was already there.
import type { Ecosystem } from './deps.ts'
import { normalizeDepName } from './deps.ts'

export type AuditTool = 'npm' | 'pnpm' | 'yarn' | 'pip-audit' | 'cargo-audit' | 'govulncheck'
export type AdvisorySeverity = 'critical' | 'high' | 'medium' | 'low'

export interface Advisory {
  tool: AuditTool
  ecosystem: Ecosystem
  /** normalized with normalizeDepName */
  package: string
  /** the vulnerable installed version when the tool says it */
  version?: string
  /** GHSA/CVE/RUSTSEC/GO/PYSEC id, or the tool's numeric id as a string */
  id: string
  /** one line, trimmed, at most 200 chars, no em dash */
  title: string
  severity: AdvisorySeverity
  /** false when the tool reports no severity (pip-audit, cargo audit without one, govulncheck): severity is then 'high' */
  severityKnown: boolean
  url?: string
  /** first fixed/patched version when known */
  fixedIn?: string
}

export interface AuditCommand {
  tool: AuditTool
  /** Row name shown in the app, e.g. 'npm audit', 'pip-audit' */
  name: string
  argv: string[]
  /** Relative to the project folder, '/' separators ('.' = root) */
  cwdRel: string
  /** The lockfile it audits (repo-relative path), for the added-vs-existing diff */
  lockfile: string
}

// ---- planning -----------------------------------------------------------------------------------------------------

const JS_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'] as const
const JS_FILES: ReadonlySet<string> = new Set(['package.json', ...JS_LOCKFILES])
const PIP_FILES: ReadonlySet<string> = new Set([
  'pyproject.toml',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
])
const CARGO_FILES: ReadonlySet<string> = new Set(['Cargo.toml', 'Cargo.lock'])
const GO_FILES: ReadonlySet<string> = new Set(['go.mod', 'go.sum'])

type Family = 'js' | 'pip' | 'cargo' | 'go'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirname = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')

/** The manifest family of a path's basename (requirements*.txt included), or null. */
function familyOf(path: string): Family | null {
  const base = basename(path)
  if (JS_FILES.has(base)) return 'js'
  if (PIP_FILES.has(base) || /^requirements[-_.][^/]*\.txt$/.test(base)) return 'pip'
  if (CARGO_FILES.has(base)) return 'cargo'
  if (GO_FILES.has(base)) return 'go'
  return null
}

const cleanPath = (p: string): string => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')

/** A root-level manifest: at the root, or a `.txt` in the root `requirements/` folder. */
function rootFamily(path: string): Family | null {
  if (!path.includes('/')) return familyOf(path)
  if (/^requirements\/[^/]+\.txt$/.test(path)) return 'pip'
  return null
}

/**
 * Which audits apply. `files` = file paths present in the project folder now (relative, '/'), `changed` = paths the
 * change touched (relative, '/'). An ecosystem's audit is planned only when the project uses it AND the change touched
 * one of its lockfiles or manifests (package.json, pyproject.toml, requirements*.txt, Pipfile, Cargo.toml, go.mod and
 * the lockfiles). Only root-folder ('.') projects are planned: a manifest changed in a subfolder gets a note.
 */
export function planAudits(
  files: readonly string[],
  changed: readonly string[],
): { commands: AuditCommand[]; notes: string[] } {
  const present = new Set(files.map(cleanPath))
  const has = (p: string): boolean => present.has(p)
  const touched = new Set<Family>()
  const subfolders = new Set<string>()
  for (const raw of changed) {
    const path = cleanPath(raw)
    if (/(?:^|\/)node_modules\//.test(path)) continue
    const root = rootFamily(path)
    if (root !== null) touched.add(root)
    else if (familyOf(path) !== null) subfolders.add(dirname(path))
  }

  const commands: AuditCommand[] = []
  const notes: string[] = []
  const command = (tool: AuditTool, name: string, argv: string[], lockfile: string): void => {
    commands.push({ tool, name, argv, cwdRel: '.', lockfile })
  }

  if (touched.has('js') && has('package.json')) {
    const lockfile = JS_LOCKFILES.find(has)
    if (lockfile === undefined) {
      notes.push('npm audit needs a lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock): not audited.')
    } else if (lockfile === 'pnpm-lock.yaml') {
      command('pnpm', 'pnpm audit', ['pnpm', 'audit', '--json'], lockfile)
    } else if (lockfile === 'yarn.lock') {
      if (has('.yarnrc.yml')) notes.push('The Yarn 2+ audit is not supported yet: yarn.lock was not audited.')
      else command('yarn', 'yarn audit', ['yarn', 'audit', '--json'], lockfile)
    } else {
      command('npm', 'npm audit', ['npm', 'audit', '--json'], lockfile)
    }
  }

  const usesPip = [...present].some((p) => rootFamily(p) === 'pip')
  if (touched.has('pip') && usesPip) {
    if (has('requirements.txt')) {
      command(
        'pip-audit',
        'pip-audit',
        ['pip-audit', '-r', 'requirements.txt', '-f', 'json', '--progress-spinner', 'off'],
        'requirements.txt',
      )
    } else {
      notes.push(
        'pip-audit needs a requirements.txt at the project root: the Python dependencies were not audited.',
      )
    }
  }

  if (touched.has('cargo') && (has('Cargo.toml') || has('Cargo.lock'))) {
    if (has('Cargo.lock')) command('cargo-audit', 'cargo audit', ['cargo', 'audit', '--json'], 'Cargo.lock')
    else
      notes.push(
        'cargo audit needs a Cargo.lock at the project root: the Rust dependencies were not audited.',
      )
  }

  if (touched.has('go') && has('go.mod')) {
    command(
      'govulncheck',
      'govulncheck',
      ['govulncheck', '-json', './...'],
      has('go.sum') ? 'go.sum' : 'go.mod',
    )
  }

  for (const dir of [...subfolders].sort()) {
    notes.push(`Dependencies changed in ${dir}/ were not audited: only the project root is audited.`)
  }
  return { commands, notes }
}

// ---- reading the tools' output ------------------------------------------------------------------------------------

export type AuditParse = { ok: true; advisories: Advisory[] } | { ok: false; reason: string }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Values bigger than this are not scanned as JSON (no audit report comes near it). */
const MAX_OUTPUT = 64 * 1024 * 1024

/**
 * Every top-level JSON object or array in `text`, in order: a bracket-depth scan that skips over strings, then
 * JSON.parse of each balanced span. Non-JSON text around and between the values (warnings, progress) is skipped, so
 * this reads one document, NDJSON and a stream of pretty-printed objects alike.
 */
export function jsonValues(text: string): unknown[] {
  const out: unknown[] = []
  if (text.length > MAX_OUTPUT) return out
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c !== '{' && c !== '[') {
      i++
      continue
    }
    const end = balancedEnd(text, i)
    if (end < 0) {
      i++
      continue
    }
    try {
      out.push(JSON.parse(text.slice(i, end + 1)) as unknown)
      i = end + 1
    } catch {
      i++
    }
  }
  return out
}

/** The index of the bracket that closes the one at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let j = start; j < text.length; j++) {
    const c = text[j]
    if (inString) {
      if (c === '\\') j++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

/** U+2014 by code point: the character itself stays out of the source. */
const EM_DASH = 0x2014
const noEmDash = (text: string): string =>
  [...text].map((c) => (c.codePointAt(0) === EM_DASH ? ' - ' : c)).join('')

/** One line, trimmed, at most 200 characters, no em dash. */
function cleanTitle(raw: string | undefined, fallback: string): string {
  const line =
    (raw ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  const text = noEmDash(line === '' ? fallback : line)
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 200 ? `${text.slice(0, 197).trimEnd()}...` : text
}

const SEVERITY_WORDS: ReadonlyMap<string, AdvisorySeverity> = new Map([
  ['critical', 'critical'],
  ['high', 'high'],
  ['medium', 'medium'],
  ['moderate', 'medium'],
  ['low', 'low'],
  ['info', 'low'],
])

/**
 * moderate->medium, info->low, critical/high/medium/low as is (case-insensitive); a CVSS score (0 to 10) >= 9
 * critical, >= 7 high, >= 4 medium, else low; anything else high, not known.
 */
export function normalizeSeverity(raw: unknown): { severity: AdvisorySeverity; known: boolean } {
  if (typeof raw === 'string') {
    const word = SEVERITY_WORDS.get(raw.trim().toLowerCase())
    if (word !== undefined) return { severity: word, known: true }
    if (/^\s*\d+(?:\.\d+)?\s*$/.test(raw)) return normalizeSeverity(Number(raw))
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 10) {
    const severity = raw >= 9 ? 'critical' : raw >= 7 ? 'high' : raw >= 4 ? 'medium' : 'low'
    return { severity, known: true }
  }
  return { severity: 'high', known: false }
}

/** A severity word, else a numeric CVSS score (`cvss` as a number or `{score}`), else unknown. */
function severityOf(word: unknown, cvss: unknown): { severity: AdvisorySeverity; known: boolean } {
  const fromWord = normalizeSeverity(word)
  if (fromWord.known) return fromWord
  const score = isRecord(cvss) ? cvss['score'] : cvss
  return typeof score === 'number' ? normalizeSeverity(score) : fromWord
}

const GHSA = /GHSA(?:-[0-9a-z]{4}){3}/i

/** The first version a range like `>=1.2.6`, `>= 1.2.6 <2`, `^0.9.5` or `1.2.6` admits. */
function firstVersion(range: unknown): string | undefined {
  const r = str(range)
  if (r === undefined || /^<\s*0\.0\.0/.test(r)) return undefined
  const m = /(?:^|[\s>=^~,|])v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/.exec(r)
  return m?.[1]
}

function advisory(
  fields: Omit<Advisory, 'version' | 'url' | 'fixedIn'>,
  opt: Record<string, unknown>,
): Advisory {
  const version = str(opt['version'])
  const url = str(opt['url'])
  const fixedIn = str(opt['fixedIn'])
  return {
    ...fields,
    ...(version !== undefined ? { version } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(fixedIn !== undefined ? { fixedIn } : {}),
  }
}

/** Drop repeats of the same tool, package, id and version, keeping the first. */
function unique(list: readonly Advisory[]): Advisory[] {
  const seen = new Set<string>()
  return list.filter((a) => {
    const key = [a.tool, a.package, a.id, a.version ?? ''].join('\n')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** An npm 6 / pnpm / yarn classic advisory object: one advisory per installed version it found. */
function npm6Advisories(tool: AuditTool, raw: unknown): Advisory[] {
  if (!isRecord(raw)) return []
  const name = str(raw['module_name'])
  if (name === undefined) return []
  const numeric =
    typeof raw['id'] === 'number' || typeof raw['id'] === 'string' ? String(raw['id']) : undefined
  const cve = arr(raw['cves']).find((c): c is string => typeof c === 'string')
  const id =
    str(raw['github_advisory_id']) ?? GHSA.exec(str(raw['url']) ?? '')?.[0] ?? cve ?? numeric ?? 'unknown'
  const { severity, known } = severityOf(raw['severity'], raw['cvss'])
  const base = {
    tool,
    ecosystem: 'npm' as const,
    package: normalizeDepName('npm', name),
    id,
    title: cleanTitle(str(raw['title']), id),
    severity,
    severityKnown: known,
  }
  const opt = { url: raw['url'], fixedIn: firstVersion(raw['patched_versions']) }
  const versions = arr(raw['findings'])
    .map((f) => (isRecord(f) ? str(f['version']) : undefined))
    .filter((v): v is string => v !== undefined)
  if (versions.length === 0) return [advisory(base, opt)]
  return versions.map((version) => advisory(base, { ...opt, version }))
}

/** npm 7+ `vulnerabilities`: one advisory per object in `via`; a string `via` is an effect of another package. */
function npm7Advisories(tool: AuditTool, vulns: Record<string, unknown>): Advisory[] {
  const out: Advisory[] = []
  for (const [key, vuln] of Object.entries(vulns)) {
    if (!isRecord(vuln)) continue
    const fix = vuln['fixAvailable']
    for (const via of arr(vuln['via'])) {
      if (!isRecord(via)) continue
      const name = normalizeDepName('npm', str(via['name']) ?? key)
      const source = via['source']
      const id =
        GHSA.exec(str(via['url']) ?? '')?.[0] ??
        (typeof source === 'number' || typeof source === 'string' ? String(source) : 'unknown')
      const { severity, known } = severityOf(via['severity'], via['cvss'])
      // `fixAvailable` names the package to install; its version is this package's fix only when it is this package.
      const fixedIn = isRecord(fix) && fix['name'] === name ? fix['version'] : undefined
      out.push(
        advisory(
          {
            tool,
            ecosystem: 'npm',
            package: name,
            id,
            title: cleanTitle(str(via['title']), id),
            severity,
            severityKnown: known,
          },
          { url: via['url'], fixedIn },
        ),
      )
    }
  }
  return out
}

function errorReason(doc: Record<string, unknown>): string | null {
  const err = doc['error']
  if (!isRecord(err)) return null
  const text = str(err['summary']) ?? str(err['message']) ?? str(err['detail']) ?? str(err['code'])
  return cleanTitle(text, 'the audit reported an error')
}

/** npm audit --json (npm 7+ report, npm 6 report, error) and pnpm audit --json (npm 6 shape). */
function parseNpmLike(tool: AuditTool, stdout: string): AuditParse {
  for (const doc of jsonValues(stdout)) {
    if (!isRecord(doc)) continue
    const reason = errorReason(doc)
    if (reason !== null) return { ok: false, reason }
    const vulns = doc['vulnerabilities']
    if (isRecord(vulns) && (doc['auditReportVersion'] !== undefined || isRecord(doc['metadata'])))
      return { ok: true, advisories: unique(npm7Advisories(tool, vulns)) }
    const advisories = doc['advisories']
    if (isRecord(advisories))
      return {
        ok: true,
        advisories: unique(Object.values(advisories).flatMap((a) => npm6Advisories(tool, a))),
      }
  }
  return { ok: false, reason: `no ${tool} audit report in the output` }
}

/** yarn audit --json (classic): NDJSON `auditAdvisory` lines and a final `auditSummary`. */
function parseYarn(stdout: string): AuditParse {
  const out: Advisory[] = []
  let report = false
  for (const doc of jsonValues(stdout)) {
    if (!isRecord(doc)) continue
    const type = doc['type']
    const data = doc['data']
    if (type === 'auditAdvisory' && isRecord(data)) {
      report = true
      out.push(...npm6Advisories('yarn', data['advisory']))
    } else if (type === 'auditSummary') {
      report = true
    } else if (type === 'error' && !report) {
      return { ok: false, reason: cleanTitle(str(data), 'yarn audit reported an error') }
    }
  }
  return report
    ? { ok: true, advisories: unique(out) }
    : { ok: false, reason: 'no yarn audit report in the output' }
}

/** pip-audit -f json: `{dependencies: [...], fixes: [...]}`, or a bare array of the dependencies (older versions). */
function parsePipAudit(stdout: string): AuditParse {
  for (const doc of jsonValues(stdout)) {
    const deps = Array.isArray(doc) ? doc : isRecord(doc) ? doc['dependencies'] : undefined
    if (!Array.isArray(deps)) continue
    if (!deps.every((d) => isRecord(d) && typeof d['name'] === 'string')) continue
    const out: Advisory[] = []
    for (const dep of deps as Record<string, unknown>[]) {
      if (dep['skip_reason'] !== undefined) continue
      const name = normalizeDepName('pip', String(dep['name']))
      for (const v of arr(dep['vulns'])) {
        if (!isRecord(v)) continue
        const id = str(v['id'])
        if (id === undefined) continue
        const fix = arr(v['fix_versions']).find((f): f is string => typeof f === 'string')
        out.push(
          advisory(
            {
              tool: 'pip-audit',
              ecosystem: 'pip',
              package: name,
              id,
              title: cleanTitle(str(v['description']), id),
              severity: 'high',
              severityKnown: false,
            },
            { version: dep['version'], url: `https://osv.dev/vulnerability/${id}`, fixedIn: fix },
          ),
        )
      }
    }
    return { ok: true, advisories: unique(out) }
  }
  return { ok: false, reason: 'no pip-audit report in the output' }
}

/** cargo audit --json: `vulnerabilities.list`; `warnings` (unmaintained, yanked) are not advisories. */
function parseCargoAudit(stdout: string): AuditParse {
  for (const doc of jsonValues(stdout)) {
    if (!isRecord(doc)) continue
    const vulns = doc['vulnerabilities']
    if (!isRecord(vulns) || !Array.isArray(vulns['list'])) continue
    const out: Advisory[] = []
    for (const entry of vulns['list']) {
      if (!isRecord(entry)) continue
      const adv = entry['advisory']
      const pkg = entry['package']
      if (!isRecord(adv)) continue
      if (adv['withdrawn'] !== undefined && adv['withdrawn'] !== null) continue
      const id = str(adv['id'])
      const name = (isRecord(pkg) ? str(pkg['name']) : undefined) ?? str(adv['package'])
      if (id === undefined || name === undefined) continue
      const { severity, known } = severityOf(undefined, adv['cvss'])
      const versions = entry['versions']
      const patched = isRecord(versions) ? arr(versions['patched']) : []
      out.push(
        advisory(
          {
            tool: 'cargo-audit',
            ecosystem: 'cargo',
            package: normalizeDepName('cargo', name),
            id,
            title: cleanTitle(str(adv['title']), id),
            severity,
            severityKnown: known,
          },
          {
            version: isRecord(pkg) ? pkg['version'] : undefined,
            url: str(adv['url']) ?? `https://rustsec.org/advisories/${id}.html`,
            fixedIn: firstVersion(patched[0]),
          },
        ),
      )
    }
    return { ok: true, advisories: unique(out) }
  }
  return { ok: false, reason: 'no cargo audit report in the output' }
}

/**
 * govulncheck -json: a stream of objects (`config`, `progress`, `osv`, `finding`). Only a finding whose trace has a
 * frame with a function (the vulnerable code is called) is an advisory: one per OSV id and module.
 */
function parseGovulncheck(stdout: string): AuditParse {
  const osvs = new Map<string, Record<string, unknown>>()
  const findings: Record<string, unknown>[] = []
  let stream = false
  for (const doc of jsonValues(stdout)) {
    if (!isRecord(doc)) continue
    if (isRecord(doc['config']) || isRecord(doc['progress']) || isRecord(doc['SBOM'])) stream = true
    const osv = doc['osv']
    if (isRecord(osv)) {
      stream = true
      const id = str(osv['id'])
      if (id !== undefined) osvs.set(id, osv)
    }
    const finding = doc['finding']
    if (isRecord(finding)) {
      stream = true
      findings.push(finding)
    }
  }
  if (!stream) return { ok: false, reason: 'no govulncheck report in the output' }
  const out: Advisory[] = []
  const seen = new Set<string>()
  for (const f of findings) {
    const id = str(f['osv'])
    const trace = arr(f['trace']).filter(isRecord)
    const top = trace[0]
    if (id === undefined || top === undefined) continue
    if (!trace.some((frame) => str(frame['function']) !== undefined)) continue
    const module = str(top['module'])
    if (module === undefined) continue
    const key = `${id}\n${module}`
    if (seen.has(key)) continue
    seen.add(key)
    const osv = osvs.get(id)
    const db = osv !== undefined ? osv['database_specific'] : undefined
    out.push(
      advisory(
        {
          tool: 'govulncheck',
          ecosystem: 'go',
          package: normalizeDepName('go', module),
          id,
          title: cleanTitle(str(osv?.['summary']) ?? str(osv?.['details']), id),
          severity: 'high',
          severityKnown: false,
        },
        {
          version: top['version'],
          url: (isRecord(db) ? str(db['url']) : undefined) ?? `https://pkg.go.dev/vuln/${id}`,
          fixedIn: f['fixed_version'],
        },
      ),
    )
  }
  return { ok: true, advisories: out }
}

/**
 * Parse a tool's stdout (it may be preceded or followed by non-JSON noise lines, and npm exits non-zero when it finds
 * advisories: parsing never depends on the exit code). Never throws.
 */
export function parseAuditOutput(tool: AuditTool, stdout: string): AuditParse {
  try {
    switch (tool) {
      case 'npm':
      case 'pnpm':
        return parseNpmLike(tool, stdout)
      case 'yarn':
        return parseYarn(stdout)
      case 'pip-audit':
        return parsePipAudit(stdout)
      case 'cargo-audit':
        return parseCargoAudit(stdout)
      case 'govulncheck':
        return parseGovulncheck(stdout)
      default:
        return { ok: false, reason: 'unknown audit tool' }
    }
  } catch (err) {
    return { ok: false, reason: `the ${tool} output could not be read: ${String(err)}` }
  }
}

// ---- introduced or existing ---------------------------------------------------------------------------------------

export interface AdvisoryClass {
  introduced: Advisory[]
  existing: Advisory[]
}

/** Go prints `v1.2.3`, go.sum keeps it, other tools print `1.2.3`: compared without the `v`. */
const bareVersion = (v: string): string => v.trim().replace(/^v(?=\d)/, '')

/**
 * introduced = the package is in `changes` (and when the advisory names a version, that version is one of
 * change.to; an unpinned `*` matches any); everything else existing. Duplicates (same tool+package+id) are collapsed
 * into the first one, introduced when any of them is.
 */
export function classifyAdvisories(
  advisories: readonly Advisory[],
  changes: readonly { name: string; to: string[] }[],
): AdvisoryClass {
  const isIntroduced = (a: Advisory): boolean => {
    const name = normalizeDepName(a.ecosystem, a.package)
    return changes.some((c) => {
      if (normalizeDepName(a.ecosystem, c.name) !== name) return false
      if (a.version === undefined) return true
      const want = bareVersion(a.version)
      return c.to.some((v) => v === '*' || bareVersion(v) === want)
    })
  }
  const order: string[] = []
  const picked = new Map<string, { a: Advisory; introduced: boolean }>()
  for (const a of advisories) {
    const key = [a.tool, a.package, a.id].join('\n')
    const introduced = isIntroduced(a)
    const prev = picked.get(key)
    if (prev === undefined) {
      order.push(key)
      picked.set(key, { a, introduced })
    } else if (introduced && !prev.introduced) {
      picked.set(key, { a, introduced })
    }
  }
  const out: AdvisoryClass = { introduced: [], existing: [] }
  for (const key of order) {
    const p = picked.get(key)
    if (p !== undefined) (p.introduced ? out.introduced : out.existing).push(p.a)
  }
  return out
}
