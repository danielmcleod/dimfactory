// Acceptance criteria: the decided plan's `## Acceptance criteria` list as structured criteria (AC1…ACn), and the
// checklist the Run view, the run's end panel and the CLI show (each criterion Met, Not met, Unknown or Not checked,
// with its evidence and the tests mapped to it). Core parses and decides; the renderer and the CLI only format.

/** The most criteria a plan keeps (later lines are left out with a note). */
export const ACCEPTANCE_MAX_CRITERIA = 20
/** The longest criterion text kept (longer ones are cut at a word). */
export const ACCEPTANCE_TEXT_MAX = 300
/** The longest evidence line kept. */
export const ACCEPTANCE_EVIDENCE_MAX = 300
/** The most tests mapped to one criterion, and the longest test reference kept. */
export const ACCEPTANCE_TESTS_MAX = 8
export const ACCEPTANCE_TEST_REF_MAX = 200

/** One criterion of the plan. `id`: AC1, AC2… in the plan's order. */
export interface AcceptanceCriterion {
  id: string
  text: string
}

/**
 * A criterion's status: `met` and `not-met` (the acceptance review's verdict, with evidence; a re-check of Fix until
 * green can turn not-met into met) · `unknown` (the review could not tell, gave no evidence, or left it out) ·
 * `not-checked` (no acceptance review ran: it is off, or did not get to it).
 */
export const ACCEPTANCE_STATUSES = ['met', 'not-met', 'unknown', 'not-checked'] as const
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number]

/** The checklist's words for each status (UI copy). */
export const ACCEPTANCE_STATUS_LABEL: Readonly<Record<AcceptanceStatus, string>> = {
  met: 'Met',
  'not-met': 'Not met',
  unknown: 'Unknown',
  'not-checked': 'Not checked',
}

/** One row of the checklist. */
export interface AcceptanceItemView {
  id: string
  text: string
  status: AcceptanceStatus
  /** Why: a file, a test or a verify result the review named, or the re-check that confirmed it. */
  evidence?: string
  /** The tests the Tests step (Test-first) mapped to it ("tests/x.test.ts: adds an item"). */
  tests?: string[]
  /** With Fix until green: the F-number of the [must] finding it became while not met. */
  finding?: number
}

export interface AcceptanceCounts {
  met: number
  notMet: number
  unknown: number
  notChecked: number
}

/**
 * RunSnapshot.acceptance. `review`: the run's acceptance review: `off` (not used), `pending` (it has not run yet),
 * `checking`, `done`, `skipped` (it did not run: `note` says why). `findings`: unmet criteria become [must] findings
 * (Fix until green is on); otherwise the review is a summary only.
 */
export interface AcceptanceView {
  review: 'off' | 'pending' | 'checking' | 'done' | 'skipped'
  findings: boolean
  items: AcceptanceItemView[]
  counts: AcceptanceCounts
  note?: string
}

/** acceptance.json in the run folder. */
export interface AcceptanceFile {
  schemaVersion: 1
  runId: string
  review: AcceptanceView['review']
  criteria: AcceptanceItemView[]
  counts: AcceptanceCounts
}

/** The checklist's counts. */
export function acceptanceCounts(items: readonly Pick<AcceptanceItemView, 'status'>[]): AcceptanceCounts {
  const c: AcceptanceCounts = { met: 0, notMet: 0, unknown: 0, notChecked: 0 }
  for (const i of items) {
    if (i.status === 'met') c.met++
    else if (i.status === 'not-met') c.notMet++
    else if (i.status === 'unknown') c.unknown++
    else c.notChecked++
  }
  return c
}

/**
 * One line for the run's notes, the end panel and the CLI: "Acceptance: 3 of 5 criteria met, 1 not met, 1 unknown."
 * (no em dashes).
 */
export function acceptanceSummaryText(c: AcceptanceCounts): string {
  const total = c.met + c.notMet + c.unknown + c.notChecked
  const parts = [`${c.met} of ${total} ${total === 1 ? 'criterion' : 'criteria'} met`]
  if (c.notMet > 0) parts.push(`${c.notMet} not met`)
  if (c.unknown > 0) parts.push(`${c.unknown} unknown`)
  if (c.notChecked > 0) parts.push(`${c.notChecked} not checked`)
  return `Acceptance: ${parts.join(', ')}.`
}
