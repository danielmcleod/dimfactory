// The security advisor in the Run view. Everything shown is core's:
// - SecurityFindings: the security findings (the Security pass's and its scanners', from findings.json) grouped by
//   level, critical first, each with its level chip. A secret is only ever shown as core's masked prefix.
// - ScanCard: the scan step (a runner step, no tokens): the secrets the scanner found in the run's added lines, each
//   dependency audit's row (what it found for the dependencies the run added or changed, and how many advisories were
//   already there), the advisories that became findings, and core's notes. A missing tool is a note, never a finding.
// - RecheckFacts: the re-check after Fix: which security [must] findings it confirmed resolved and which are still
//   open (an answer that named none of them leaves them all open). Its line is there from the step's start, so the
//   answer fills it instead of adding one.
// UI standard (nothing moves on its own): the scan's rows come with the scan (core gives a rerun its known rows), each
// row keeps one line for core's note, and nothing here scrolls on its own.
import { CircleCheck, CircleMinus, Circle, CircleX, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { memo } from 'react'
import { SECURITY_LEVELS, isSecurityFinding } from '@shared/findings.ts'
import type { Finding, SecurityLevel } from '@shared/findings.ts'
import type { RecheckView, RunSnapshot, ScanAuditView, ScanView, StepView } from '@shared/run.ts'
import { cn } from '../../lib/cn.ts'
import { PASS_STATUS_LABEL, formatDuration, stepLabel } from '../../lib/format.ts'
import { Badge } from '../ui/Badge.tsx'
import { StableLabel } from '../ui/StableLabel.tsx'
import { JUMP_MARGIN } from './follow.tsx'
import { renderInline } from './LightMarkdown.tsx'
import { useRunOutput } from './outputs.ts'
import { PausedNotice } from './PausedNotice.tsx'
import { useLastEnvelope } from './runLog.ts'
import { SnagCard } from './SnagCard.tsx'
import { StepStatus } from './StepStatus.tsx'
import { skipReasonText } from './text.ts'

/** A level as the chips say it. */
export const LEVEL_LABEL: Readonly<Record<SecurityLevel, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

const LEVEL_TONE: Readonly<Record<SecurityLevel, 'failed' | 'waiting' | 'paused' | 'secondary'>> = {
  critical: 'failed',
  high: 'failed',
  medium: 'waiting',
  low: 'secondary',
}

/** Every level word, so a chip keeps one width whatever level it shows. */
const LEVEL_WORDS: readonly string[] = SECURITY_LEVELS.map((l) => `Security · ${LEVEL_LABEL[l]}`)

/** The security chip: "Security · High". */
export function SecurityLevelChip({
  level,
  testId,
}: {
  level: SecurityLevel | undefined
  testId?: string
}): React.JSX.Element {
  const text = level !== undefined ? `Security · ${LEVEL_LABEL[level]}` : 'Security'
  return (
    <Badge
      variant={level !== undefined ? LEVEL_TONE[level] : 'secondary'}
      data-testid={testId}
      data-level={level ?? 'none'}
    >
      <StableLabel labels={LEVEL_WORDS} align="start">
        {text}
      </StableLabel>
    </Badge>
  )
}

/** Security findings by level, critical first (a finding without a level, e.g. a bare [security], counts as low). */
export function groupByLevel(findings: readonly Finding[]): { level: SecurityLevel; findings: Finding[] }[] {
  return SECURITY_LEVELS.map((level) => ({
    level,
    findings: findings.filter((f) => (f.level ?? (f.severity === 'must' ? 'high' : 'low')) === level),
  })).filter((g) => g.findings.length > 0)
}

/** findings.json's security findings (the Security pass's and the scan's), or null while it is not read. */
export function securityFindingsOf(text: string): Finding[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const list = (doc as { findings?: unknown }).findings
  if (!Array.isArray(list)) return null
  return list.filter(
    (f): f is Finding =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as Finding).id === 'string' &&
      typeof (f as Finding).title === 'string' &&
      isSecurityFinding(f as Finding),
  )
}

/** The security findings, grouped by level (pure: the Security pass's card reads findings.json for it). */
export function SecurityFindingsList({ findings }: { findings: readonly Finding[] }): React.JSX.Element {
  if (findings.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="security-findings-none">
        No security findings.
      </p>
    )
  return (
    <div className="flex flex-col gap-2" data-testid="security-findings">
      {groupByLevel(findings).map((g) => (
        <section key={g.level} aria-label={LEVEL_LABEL[g.level]} data-testid={`security-level-${g.level}`}>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase">
            {`${LEVEL_LABEL[g.level]} (${g.findings.length})`}
          </h4>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {g.findings.map((f) => (
              <li key={f.id} className="flex items-baseline gap-2" data-testid={`security-finding-${f.id}`}>
                <SecurityLevelChip level={f.level} />
                <span className="text-muted-foreground tabular-nums">F{f.n}</span>
                <span className="min-w-0 break-words">{renderInline(f.title)}</span>
                {f.source === 'scan' && (
                  <span className="shrink-0 text-xs text-muted-foreground">scanner</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The Security pass's findings, read from findings.json once the pass is done (re-read as core rewrites it). */
export function SecurityFindings({
  runId,
  snap,
  done,
}: {
  runId: string
  snap: RunSnapshot
  done: boolean
}): React.JSX.Element | null {
  const written = useLastEnvelope(runId, 'output', (b) => b.file === 'findings', { enabled: done })
  const version = written?.body.version ?? 0
  const { security, scan } = snap.steps
  const key = `${security.attempt}:${security.status}|${scan.attempt}:${scan.status}|${version}`
  const file = useRunOutput(runId, 'findings', key, done)
  if (!done) return null
  if (file.status === 'loading') return <p className="text-sm text-muted-foreground">Loading the findings…</p>
  const list = file.status === 'ready' ? securityFindingsOf(file.output.text) : null
  if (list === null) return null
  return <SecurityFindingsList findings={list} />
}

// ---- the scan ----------------------------------------------------------------------------------------------------

export const AUDIT_STATUS_LABEL: Readonly<Record<ScanAuditView['status'], string>> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  skipped: 'Not run',
  env: 'Could not run',
  unreadable: 'Output unreadable',
}

const AUDIT_WORDS: readonly string[] = Object.values(AUDIT_STATUS_LABEL)

const AUDIT_ICON: Readonly<Record<ScanAuditView['status'], LucideIcon>> = {
  queued: Circle,
  running: LoaderCircle,
  done: CircleCheck,
  skipped: CircleMinus,
  env: TriangleAlert,
  unreadable: TriangleAlert,
}

/** What an audit found, as one short line ("2 from this run · 5 already there"). */
export function auditFactsText(a: ScanAuditView): string {
  if (a.status !== 'done') return ''
  const mine = a.introduced ?? 0
  const before = a.existing ?? 0
  return `${mine} from this run · ${before} already there`
}

/** The scan's summary line: "1 secret · 2 advisories from this run". */
export function scanSummaryText(v: ScanView): string {
  const s = v.secrets.length
  const a = v.advisories.length
  if (v.phase !== 'done') return v.phase === 'trust' ? 'Waiting for your choice below' : 'Scanning'
  if (s === 0 && a === 0) return 'Nothing found'
  const parts: string[] = []
  if (s > 0) parts.push(`${s} ${s === 1 ? 'secret' : 'secrets'}`)
  if (a > 0) parts.push(`${a} ${a === 1 ? 'advisory' : 'advisories'} from this run`)
  return parts.join(' · ')
}

/** The scan's facts (StepView.scan): secrets (masked), audits, advisories, the count already there, notes. */
export function ScanFacts({ view }: { view: ScanView }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-testid="scan-facts" data-phase={view.phase}>
      <section aria-label="Secrets" data-testid="scan-secrets">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase">Secrets in the change</h4>
        {view.phase === 'done' && view.secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="scan-secrets-none">
            None found in the added lines.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {view.secrets.map((h, i) => (
              <li
                key={`${h.file}:${h.line}:${h.label}`}
                className="flex min-w-0 items-baseline gap-2"
                data-testid={`scan-secret-${i}`}
              >
                <SecurityLevelChip level={h.level} />
                <code className="min-w-0 truncate font-mono text-xs" title={`${h.file}:${h.line}`}>
                  {`${h.file}:${h.line}`}
                </code>
                <span className="min-w-0 truncate">{h.label}</span>
                <code className="shrink-0 font-mono text-xs text-muted-foreground" data-testid="scan-masked">
                  {h.masked}
                </code>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Dependency audits" data-testid="scan-audits">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase">Dependency audits</h4>
        {view.audits.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="scan-audits-none">
            {view.phase === 'check' ? 'Checking which audits apply.' : 'None applied to this change.'}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {view.audits.map((a, i) => {
              const Icon = AUDIT_ICON[a.status]
              const facts = auditFactsText(a)
              return (
                <li
                  key={a.name}
                  data-testid={`scan-audit-${i}`}
                  data-status={a.status}
                  className="flex min-w-0 flex-col gap-0.5 py-1"
                >
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <Icon
                      aria-hidden
                      className={cn(
                        'size-4 shrink-0 text-muted-foreground',
                        a.status === 'running' && 'motion-safe:animate-spin',
                        a.status === 'done' && 'text-st-done',
                        (a.status === 'env' || a.status === 'unreadable') && 'text-warning',
                      )}
                    />
                    <span className="min-w-0 truncate font-medium" title={a.name}>
                      {a.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <StableLabel labels={AUDIT_WORDS} align="start">
                        {AUDIT_STATUS_LABEL[a.status]}
                      </StableLabel>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{facts}</span>
                  </div>
                  {/* One line, always there: core's reason. */}
                  <p className="h-5 min-w-0 truncate pl-6 text-xs text-muted-foreground" title={a.reason}>
                    {a.reason ?? ''}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {view.advisories.length > 0 && (
        <section aria-label="Advisories" data-testid="scan-advisories">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase">
            Advisories for dependencies this run added or changed
          </h4>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {view.advisories.map((a, i) => (
              <li
                key={`${a.tool}:${a.package}:${a.id}`}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2"
                data-testid={`scan-advisory-${i}`}
              >
                <SecurityLevelChip level={a.level} />
                <span className="font-medium">{`${a.package}${a.version !== undefined ? `@${a.version}` : ''}`}</span>
                <span className="text-muted-foreground">{a.id}</span>
                <span className="min-w-0 break-words">{a.title}</span>
                {a.fixedIn !== undefined && (
                  <span className="text-xs text-muted-foreground">{`fixed in ${a.fixedIn}`}</span>
                )}
                {!a.levelKnown && (
                  <span className="text-xs text-muted-foreground">no severity reported, treated as high</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.existing > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="scan-existing">
          {`${view.existing} ${view.existing === 1 ? 'advisory was' : 'advisories were'} already there before this run (not findings).`}
        </p>
      )}
      {view.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="scan-notes">
          {view.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The scan step's card (a runner step: no vendor, no stream). */
export const ScanCard = memo(function ScanCard({
  runId,
  snap,
  view,
}: {
  runId: string
  snap: RunSnapshot
  view: StepView
  finishedAtOpen?: boolean
}): React.JSX.Element {
  void snap
  const label = stepLabel(view.key)
  const reason = view.status === 'skipped' ? skipReasonText(view.reason) : undefined
  return (
    <article
      id={`pass-card-${view.key}`}
      data-testid={`pass-card-${view.key}`}
      data-status={view.status}
      aria-label={`${label}: ${PASS_STATUS_LABEL[view.status]}`}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground',
        JUMP_MARGIN,
      )}
    >
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <StepStatus status={view.status} reserve />
      </header>
      <p
        data-testid="scan-summary"
        className="-mt-1 flex h-4 min-w-0 items-center gap-3 overflow-clip text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {view.activeMs > 0 && <span className="shrink-0">{formatDuration(view.activeMs)}</span>}
        <span className="min-w-0 truncate">
          {view.scan !== undefined
            ? scanSummaryText(view.scan)
            : 'No tokens: Dim Factory scans the change itself'}
        </span>
      </p>
      {reason !== undefined && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="pass-reason-scan"
        >{`Skipped · ${reason}`}</p>
      )}
      {view.scan !== undefined && <ScanFacts view={view.scan} />}
      <PausedNotice runId={runId} view={view} />
      <SnagCard runId={runId} view={view} />
    </article>
  )
})

// ---- the re-check after Fix ------------------------------------------------------------------------------------------

/** The re-check's line. */
export function recheckText(v: RecheckView | undefined, security = true): string {
  // Without the security advisor, Fix until green re-checks every [must] finding of the round.
  const one = security ? 'security finding' : 'finding'
  const many = security ? 'security findings' : 'findings'
  if (v === undefined) return `Checks the ${many} once Fix ends.`
  if (v.status === 'checking') return `Checking that Fix resolved the ${many}…`
  if (v.status === 'resolved') {
    const n = v.resolved.length
    return `Fix resolved ${n === 1 ? `the ${one}` : `all ${n} ${many}`}`
  }
  if (v.status === 'unclear') return `The re-check named none of the ${many}, so they count as still open`
  const n = v.open.length
  return `${n} ${n === 1 ? `${one} is` : `${many} are`} still open after Fix`
}

const RECHECK_TONE: Readonly<Record<RecheckView['status'] | 'pending', string>> = {
  pending: 'text-muted-foreground',
  checking: 'text-muted-foreground',
  resolved: 'text-st-done',
  open: 'text-st-failed',
  unclear: 'text-warning',
}

/** The re-check's facts: one line from its start, and the open findings with the re-check's reasons. */
export function RecheckFacts({
  view,
  security = true,
}: {
  view: RecheckView | undefined
  /** The run has the security advisor (its re-check is about security findings); false for Fix until green's. */
  security?: boolean
}): React.JSX.Element {
  const status = view?.status ?? 'pending'
  return (
    <div className="flex flex-col gap-1" data-testid="recheck-facts" data-status={status}>
      <p className={cn('h-4 truncate text-xs', RECHECK_TONE[status])} data-testid="recheck-line">
        {recheckText(view, security)}
      </p>
      {view !== undefined &&
        view.status !== 'checking' &&
        (view.open.length > 0 || view.resolved.length > 0) && (
          <ul className="flex flex-col gap-0.5 text-sm" data-testid="recheck-list">
            {view.open.map((o) => (
              <li
                key={`open-${o.n}`}
                className="flex items-baseline gap-2"
                data-testid={`recheck-open-${o.n}`}
              >
                <CircleX aria-hidden className="size-3.5 shrink-0 text-st-failed" />
                <span className="tabular-nums">F{o.n}</span>
                <span className="min-w-0 break-words text-muted-foreground">{o.reason ?? 'still open'}</span>
              </li>
            ))}
            {view.resolved.map((n) => (
              <li key={`ok-${n}`} className="flex items-baseline gap-2" data-testid={`recheck-resolved-${n}`}>
                <CircleCheck aria-hidden className="size-3.5 shrink-0 text-st-done" />
                <span className="tabular-nums">F{n}</span>
                <span className="text-muted-foreground">resolved</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
