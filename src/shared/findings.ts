// Findings contracts. Core parses Review/Critic output into
// these (src/core/findings/parse.ts) and persists them as runs/<id>/findings.json; the renderer only formats them.

/**
 * Who produced a finding. `verify` findings come from failing checks; `tests` from Test-first's check that Implement
 * did not weaken the tests written before it; `security` from the Security pass; `scan` from the security advisor's
 * deterministic scanners (secrets in the diff, advisories for dependencies the run added or changed); `preview` from
 * Run & Preview's smoke check (console errors on the preview's page); `acceptance` from the acceptance review (a plan
 * criterion it found not met, with Fix until green on); `grounding` from Dim Factory's own grounding checks after a pass (no model):
 * what the AI said it did against what the run shows (files it named, tests it said it ran, imports and packages it added).
 */
export const FINDING_SOURCES = [
  'review',
  'critic',
  'security',
  'scan',
  'verify',
  'tests',
  'preview',
  'acceptance',
  'grounding',
] as const
export type FindingSource = (typeof FINDING_SOURCES)[number]

/** The reader passes whose output is parsed for findings. */
export const REVIEWER_SOURCES = ['review', 'critic', 'security'] as const satisfies readonly FindingSource[]

/** A security finding's severity: critical and high are `[must]`, medium and low `[should]`. */
export const SECURITY_LEVELS = ['critical', 'high', 'medium', 'low'] as const
export type SecurityLevel = (typeof SECURITY_LEVELS)[number]

/** The `[must]` / `[should]` a security level maps to. */
export function securitySeverity(level: SecurityLevel): Severity {
  return level === 'critical' || level === 'high' ? 'must' : 'should'
}

/** A finding from the security advisor (the Security pass, or its scanners). */
export function isSecurityFinding(f: Pick<Finding, 'source' | 'level'>): boolean {
  return f.source === 'security' || f.source === 'scan' || f.level !== undefined
}
export type ReviewerSource = (typeof REVIEWER_SOURCES)[number]

export const SEVERITIES = ['must', 'should'] as const
export type Severity = (typeof SEVERITIES)[number]

/**
 * - `untagged`: the source tagged nothing, so each top-level list item became a `should` ("didn't tag findings").
 * - `unstructured`: the source answered in prose only; the whole answer is one `should`.
 * - `preexisting`: a verify command that already failed before the run (does not block the Fix skip rule).
 * - `possible-hallucination`: a failure that points to something the AI made up (an API, a module, a package).
 * - `grounding`: a reviewer marked it `(grounding)`: the AI's claims do not match the code (the grounding filter).
 * - `ai-judged`: the optional AI judge raised it (never `[must]`).
 * - `merged`: two reviewers raised the same issue at the same place; it is listed once.
 * - `contradicted`: two reviewers disagree about the same place; it is listed once as a suggestion, never sent to Fix
 *   on its own.
 */
export const FINDING_FLAGS = [
  'untagged',
  'unstructured',
  'preexisting',
  'possible-hallucination',
  'grounding',
  'ai-judged',
  'merged',
  'contradicted',
] as const
export type FindingFlag = (typeof FINDING_FLAGS)[number]

export interface Finding {
  /** `sha1(source + '\n' + normalizedFirstLine).slice(0, 12)`, `-2`, `-3`… on a collision. Stable across re-parses. */
  id: string
  /** Display number (F1…), must findings first. */
  n: number
  severity: Severity
  source: FindingSource
  /** The finding's first line without its marker and tag. */
  title: string
  /** Supporting lines, dedented; tagged descendants are cut out (they are findings of their own). */
  body: string
  flags: FindingFlag[]
  /** Review round that produced it (1 = the first Review ‖ Critic). */
  round: number
  /** A security finding's severity (`[security:<level>]`, or the scanner's); absent for other findings. */
  level?: SecurityLevel
}

/**
 * - `none`: `NO FINDINGS` (or a short "no issues / LGTM") · `ok`: at least one tagged finding
 * - `untagged` / `unstructured`: see {@link FindingFlag} · `empty`: no output at all · `failed`: the pass failed.
 * A failed, empty or unparsed source never counts as zero findings.
 */
export const SOURCE_PARSE_STATUSES = ['none', 'ok', 'untagged', 'unstructured', 'empty', 'failed'] as const
export type SourceParseStatus = (typeof SOURCE_PARSE_STATUSES)[number]

export interface SourceParse {
  status: SourceParseStatus
  /** Findings produced by this source. */
  count: number
  /** The raw output artifact, relative to the run folder (e.g. `review.md`). */
  rawFile: string
}

/** Fix's closing report (`F<n> fixed|skipped|disputed`), parsed best-effort for display only. */
export const FIX_REPORT_STATUSES = ['fixed', 'skipped', 'disputed'] as const
export type FixReportStatus = (typeof FIX_REPORT_STATUSES)[number]

/** runs/<id>/findings.json */
export interface FindingsFile {
  schemaVersion: 1
  runId: string
  round: number
  sources: Partial<Record<FindingSource, SourceParse>>
  /** Must first, numbered F1…. */
  findings: Finding[]
  /** Finding id → sent to Fix. */
  selected: Record<string, boolean>
  /** Finding id → what Fix said it did. */
  fixReport?: Record<string, FixReportStatus>
  /**
   * Findings that turned out wrong: Fix disputed them and the checks after Fix confirmed the code was fine. Absent:
   * Fix disputed nothing (or did not run).
   */
  metrics?: FindingsMetrics
}

/** findings.json `metrics`. */
export interface FindingsMetrics {
  /** Findings Fix disputed. */
  disputed: number
  /** Of those, the ones the checks after Fix confirmed (verify passed, no re-check kept them open). */
  wrong: number
  /** The ids of the wrong ones. */
  wrongIds: string[]
}

/** A finding's `file:line` (`src/a.ts:12`, `a\b.py:3:5`), the evidence a reviewer points to; undefined without one. */
export function findingLocation(
  f: Pick<Finding, 'title' | 'body'>,
): { file: string; line: number } | undefined {
  const m = LOCATION.exec(f.title) ?? LOCATION.exec(f.body)
  if (m === null) return undefined
  return { file: (m[1] ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(), line: Number(m[2]) }
}
const LOCATION = /([\w@.\-/\\]*[\w-]\.[A-Za-z0-9]{1,8}):(\d{1,6})/

/** Sources that are checks Dim Factory ran (a failing test, a secret found, a grounding flag): evidence by themselves. */
export const CHECK_SOURCES: readonly FindingSource[] = [
  'verify',
  'tests',
  'scan',
  'grounding',
  'acceptance',
  'preview',
]

/** A finding comes with evidence: a check found it, it is a grounding flag, or it points to a `file:line`. */
export function hasEvidence(f: Pick<Finding, 'source' | 'flags' | 'title' | 'body'>): boolean {
  return CHECK_SOURCES.includes(f.source) || f.flags.includes('grounding') || findingLocation(f) !== undefined
}

/**
 * Quieter reviews: whether a finding is sent to Fix by default. A [must] with evidence always is; a [should] with
 * evidence only with Fix until green on; a disagreement between reviewers, a failure that was there before the run and
 * the AI judge's notes never are. Every finding stays listed, and the user can tick any of them.
 */
export function triggersFix(
  f: Pick<Finding, 'severity' | 'source' | 'flags' | 'title' | 'body'>,
  fixLoop: boolean,
): boolean {
  if (f.flags.includes('preexisting') || f.flags.includes('contradicted') || f.flags.includes('ai-judged'))
    return false
  if (!hasEvidence(f)) return false
  return f.severity === 'must' || fixLoop
}
