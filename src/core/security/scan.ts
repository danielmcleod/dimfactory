// The security advisor's scan, before its reviewer and with no model: a secret scanner over the run's added lines and
// the dependency audits that apply (security/audit.ts). This module turns their results into what the run keeps:
// findings (source `scan`, with a security level: a known key format is critical, an entropy hit medium, an advisory
// for a dependency the run added or changed takes the tool's severity, high when the tool reports none), the views
// the app shows (secrets masked, never whole) and notes. An audit that could not run (the tool is not installed, its
// output could not be read) is a note, never a finding; advisories for dependencies the run did not touch are one
// note. The I/O (git in the shadow, the folder, spawning the audits through the trusted-command runner) is injected.
import { createHash } from 'node:crypto'
import { securitySeverity } from '../../shared/findings.ts'
import type { SecurityLevel } from '../../shared/findings.ts'
import type { ScanAdvisoryView, ScanSecretView } from '../../shared/run.ts'
import type { VerifyCommandResult } from '../../shared/verify.ts'
import type { FindingInput, ScanAuditResult, ScanRunAudit } from '../supervisor/types.ts'
import { classifyAdvisories, parseAuditOutput, planAudits } from './audit.ts'
import type { Advisory, AuditCommand, AuditTool } from './audit.ts'
import { changedDependencies, parseLockfile } from './deps.ts'
import { scanPatchForSecrets } from './secrets.ts'
import { sensitiveChange } from './sensitive.ts'
import type { SecretHit } from './secrets.ts'

/** What the scan reads and runs, injected (the controller's shadow, folder and round runner; fakes in tests). */
export interface ScanIo {
  /** The run's changes between two snapshot commits as a git patch (zero context is enough), its folder only. */
  patch(from: string, to: string): Promise<string>
  /** Paths the run changed between the commits, relative to its folder, `/` separators. */
  changedPaths(from: string, to: string): Promise<string[]>
  /** A file's text at a commit (relative to the run's folder); null when it is not there. */
  fileAt(commit: string, path: string): Promise<string | null>
  /** Files present in the run's folder now that decide which audits apply (relative, `/`). */
  folderFiles(): Promise<string[]>
}

/** An audit's run as the trusted-command runner reports it, with the command's standard output. */
export interface AuditRun {
  result: VerifyCommandResult
  stdout: string
}

/** The audits that apply to the run's changes, and why some do not. */
export async function planScan(
  io: ScanIo,
  from: string,
  to: string,
): Promise<{ audits: AuditCommand[]; notes: string[] }> {
  const [files, changed] = await Promise.all([io.folderFiles(), io.changedPaths(from, to)])
  const plan = planAudits(files, changed)
  return { audits: plan.commands, notes: plan.notes }
}

const AUDIT_TOOLS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'pip-audit',
  'cargo-audit',
  'govulncheck',
])

export const isAuditTool = (v: string): v is AuditTool => AUDIT_TOOLS.has(v)

const idOf = (key: string): string =>
  createHash('sha1').update(`scan\n${key}`, 'utf8').digest('hex').slice(0, 12)

/** A secret hit as the finding it becomes: critical for a known key format, medium for an entropy hit. */
export function secretLevel(h: Pick<SecretHit, 'confidence'>): SecurityLevel {
  return h.confidence === 'pattern' ? 'critical' : 'medium'
}

export function secretView(h: SecretHit): ScanSecretView {
  return {
    file: h.file,
    line: h.line,
    label: h.label,
    masked: h.masked,
    confidence: h.confidence,
    level: secretLevel(h),
  }
}

/** A secret as a finding (never the whole value: its masked prefix only). */
export function secretFinding(h: ScanSecretView): FindingInput {
  const certain = h.confidence === 'pattern'
  return {
    id: idOf(`secret\n${h.file}\n${h.line}\n${h.label}`),
    severity: securitySeverity(h.level),
    level: h.level,
    title: `\`${h.file}:${h.line}\`: ${certain ? `${h.label} committed in the code` : 'Possible secret in the code'} (${h.masked}).`,
    body: certain
      ? 'Remove it from the code and read it from the environment or a secret store instead. The value is now in the change history: rotate it.'
      : `${h.label}. If it is a real credential, remove it from the code, read it from the environment or a secret store, and rotate it.`,
    source: 'scan',
  }
}

export function advisoryView(a: Advisory): ScanAdvisoryView {
  const v: ScanAdvisoryView = {
    tool: a.tool,
    package: a.package,
    id: a.id,
    title: a.title,
    level: a.severity,
    levelKnown: a.severityKnown,
  }
  if (a.version !== undefined) v.version = a.version
  if (a.url !== undefined) v.url = a.url
  if (a.fixedIn !== undefined) v.fixedIn = a.fixedIn
  return v
}

/** An advisory for a dependency the run added or changed, as a finding. */
export function advisoryFinding(a: ScanAdvisoryView): FindingInput {
  const at = a.version !== undefined ? `@${a.version}` : ''
  const lines = [
    a.fixedIn !== undefined
      ? `Upgrade ${a.package} to ${a.fixedIn} or later, or replace it.`
      : `No fixed version is known: replace ${a.package} or remove it.`,
  ]
  if (!a.levelKnown) lines.push(`The audit reports no severity for it, so Dim Factory treats it as high.`)
  if (a.url !== undefined) lines.push(a.url)
  return {
    id: idOf(`advisory\n${a.tool}\n${a.package}\n${a.id}`),
    severity: securitySeverity(a.level),
    level: a.level,
    title: `${a.package}${at}: ${a.id} ${a.title}`,
    body: lines.join('\n'),
    source: 'scan',
  }
}

/** One audit's outcome: its advisories split into the run's and the ones already there, or why it has none. */
export interface AuditOutcome {
  row: ScanAuditResult
  introduced: Advisory[]
  existing: Advisory[]
  notes: string[]
}

/**
 * Read one audit's run: a tool that could not run is `env`, one whose output cannot be read `unreadable` (notes,
 * never findings); otherwise its advisories are classified against the lockfile before and after the run.
 */
export function auditOutcome(
  audit: Pick<ScanRunAudit, 'name' | 'tool' | 'lockfile'>,
  run: AuditRun,
  lock: { before: string | null; after: string | null },
): AuditOutcome {
  const r = run.result
  const base = { name: audit.name }
  if (r.status === 'skipped' || r.status === 'skipped-untrusted') {
    return {
      row: { ...base, status: 'skipped', ...(r.reason !== undefined ? { reason: r.reason } : {}) },
      introduced: [],
      existing: [],
      notes: [],
    }
  }
  if (r.status === 'env') {
    const reason = r.reason ?? 'The tool could not run here.'
    return {
      row: { ...base, status: 'env', reason },
      introduced: [],
      existing: [],
      notes: [
        `${audit.name} could not run (${reason}), so the dependencies this run changed were not audited.`,
      ],
    }
  }
  if (!isAuditTool(audit.tool)) {
    return {
      row: { ...base, status: 'unreadable', reason: 'Unknown audit tool.' },
      introduced: [],
      existing: [],
      notes: [],
    }
  }
  const parsed = parseAuditOutput(audit.tool, run.stdout)
  if (!parsed.ok) {
    const reason = r.timedOut === true ? (r.reason ?? 'It timed out.') : parsed.reason
    return {
      row: { ...base, status: 'unreadable', reason },
      introduced: [],
      existing: [],
      notes: [`Dim Factory could not read the output of ${audit.name} (${reason}); it is not a finding.`],
    }
  }
  const after = lock.after !== null ? parseLockfile(audit.lockfile, lock.after) : null
  // No lockfile at the run's base: it is new, so every dependency in it is the run's. One that was there but cannot
  // be read is not that: it gives no way to tell the run's dependencies from the ones already there.
  const before = lock.before !== null ? parseLockfile(audit.lockfile, lock.before) : null
  if (after === null || (lock.before !== null && before === null)) {
    // Only advisories for dependencies the run added or changed are findings: unattributed ones never are.
    const n = parsed.advisories.length
    const reason = `Could not read ${audit.lockfile} to tell which advisories this run brought in.`
    return {
      row: { ...base, status: 'unreadable', reason },
      introduced: [],
      existing: [],
      notes:
        n === 0
          ? []
          : [
              `Dim Factory could not read ${audit.lockfile} to tell which of the ${n === 1 ? 'one advisory' : `${n} advisories`} ${audit.name} reported this run brought in, so ${n === 1 ? 'it is not a finding' : 'they are not findings'}. Run ${audit.name} yourself to review ${n === 1 ? 'it' : 'them'}.`,
            ],
    }
  }
  const cls = classifyAdvisories(parsed.advisories, changedDependencies(before, after))
  return {
    row: {
      ...base,
      status: 'done',
      introduced: cls.introduced.length,
      existing: cls.existing.length,
    },
    introduced: cls.introduced,
    existing: cls.existing,
    notes: [],
  }
}

/** The scan's whole result (what `scan-result` carries). */
export interface ScanOutcome {
  secrets: ScanSecretView[]
  audits: ScanAuditResult[]
  advisories: ScanAdvisoryView[]
  existing: number
  notes: string[]
  findings: FindingInput[]
  /** The changes touch code that handles keys, sign-in, payments or people's data (sensitive.ts). */
  sensitive: boolean
}

/**
 * The scan: the secret scanner over the run's patch, then each audit through `runAudit` (the trusted-command
 * runner; an audit not to run is reported as given), classified against its lockfile at the run's base and after.
 */
export async function runSecurityScan(
  io: ScanIo,
  o: {
    from: string
    to: string
    audits: readonly ScanRunAudit[]
    runAudits: (audits: readonly ScanRunAudit[]) => Promise<Map<string, AuditRun>>
  },
): Promise<ScanOutcome> {
  const patch = await io.patch(o.from, o.to)
  const secrets = scanPatchForSecrets(patch).map(secretView)
  const runs = await o.runAudits(o.audits)
  const rows: ScanAuditResult[] = []
  const notes: string[] = []
  const introduced: ScanAdvisoryView[] = []
  let existing = 0
  const existingBy: string[] = []
  for (const a of o.audits) {
    const run = runs.get(a.name)
    if (!a.run || run === undefined) {
      rows.push({ name: a.name, status: 'skipped', ...(a.reason !== undefined ? { reason: a.reason } : {}) })
      continue
    }
    const [before, after] = await Promise.all([io.fileAt(o.from, a.lockfile), io.fileAt(o.to, a.lockfile)])
    const out = auditOutcome(a, run, { before, after })
    rows.push(out.row)
    notes.push(...out.notes)
    introduced.push(...out.introduced.map(advisoryView))
    if (out.existing.length > 0) {
      existing += out.existing.length
      existingBy.push(a.name)
    }
  }
  if (existing > 0) {
    notes.push(
      `${existing === 1 ? 'One advisory' : `${existing} advisories`} for dependencies this run did not change ${existing === 1 ? 'was' : 'were'} already there (${existingBy.join(', ')}). ${existing === 1 ? 'It is' : 'They are'} not findings of this run.`,
    )
  }
  const findings = [...secrets.map(secretFinding), ...introduced.map(advisoryFinding)]
  return {
    secrets,
    audits: rows,
    advisories: introduced,
    existing,
    notes,
    findings,
    sensitive: sensitiveChange(patch),
  }
}
