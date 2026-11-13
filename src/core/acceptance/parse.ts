// Acceptance criteria, parsed. Three readers, all pure and never throwing:
//  - parseCriteria: the decided plan's `## Acceptance criteria` section (any heading level or case; a plan without
//    one falls back to "## Done when") as AC1…ACn, one per list item, capped in number and length.
//  - parseTestsMapping: the Tests step's closing JSON block mapping criteria to the tests it wrote (best effort:
//    unknown ids are dropped, an unreadable block maps nothing).
//  - parseAcceptanceAnswer: the acceptance review's verdicts (structured JSON, or a fenced JSON block). A met or not
//    met verdict needs evidence, else it reads unknown; a criterion the answer leaves out is unknown ("not assessed");
//    an unreadable answer leaves every criterion unknown with a note. Never a failure.
// Also the JSON Schema the review answers with, and the criteria as the prompts render them.
import {
  ACCEPTANCE_EVIDENCE_MAX,
  ACCEPTANCE_MAX_CRITERIA,
  ACCEPTANCE_TESTS_MAX,
  ACCEPTANCE_TEST_REF_MAX,
} from '../../shared/acceptance.ts'
import type { AcceptanceCriterion } from '../../shared/acceptance.ts'
import { cleanLine } from '../../shared/acceptance-criteria.ts'
import { jsonFromText } from '../clarify/parse.ts'

// The plan's criteria live in shared/ (the renderer reads them from a plan it shows); re-exported for core's readers.
export { cleanLine, parseCriteria } from '../../shared/acceptance-criteria.ts'
export type { CriteriaParse } from '../../shared/acceptance-criteria.ts'

// ---- reading JSON answers --------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}

/**
 * The keys an answer's list may sit under: the prompts ask for `verdicts` (the acceptance review) and `mapping` (the
 * Tests step); the others are read too.
 */
const LIST_KEYS = ['verdicts', 'mapping', 'criteria', 'items', 'results'] as const

/** The list of an object answer under one of LIST_KEYS (a bare array is the list itself). */
function listOf(v: unknown): unknown[] | undefined {
  if (Array.isArray(v)) return v as unknown[]
  if (!isRecord(v)) return undefined
  for (const k of LIST_KEYS) if (Array.isArray(v[k])) return v[k] as unknown[]
  return undefined
}

/** The list of an answer: the last fenced JSON block that has one, else the answer's JSON value. */
function criteriaList(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string') return listOf(value)
  const t = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = [...t.matchAll(/(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\1/g)]
  for (const m of blocks.reverse()) {
    const v = tryJson(m[3] ?? '')
    if (isRecord(v) && listOf(v) !== undefined) return listOf(v)
  }
  return listOf(jsonFromText(t))
}

/** A criterion id as the answer wrote it ("AC1", "ac 1", "1") → the known id, or undefined. */
function idOf(v: unknown, known: ReadonlySet<string>): string | undefined {
  const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''
  const m = /^\s*(?:ac)?\s*[-#]?\s*(\d{1,3})\s*$/i.exec(raw)
  if (m === null) return undefined
  const id = `AC${Number(m[1])}`
  return known.has(id) ? id : undefined
}

// ---- the Tests step's mapping ----------------------------------------------------------------------------------

/**
 * The Tests step's map of criteria to the tests it wrote, from the fenced JSON block that ends its answer
 * (a `mapping` list of `{id, tests}` entries, e.g. AC1 with `tests/x.test.ts: adds an item`). Best effort: unknown ids and empty
 * entries are dropped; an answer without the block maps nothing.
 */
export function parseTestsMapping(
  answer: string,
  criteria: readonly AcceptanceCriterion[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (criteria.length === 0) return out
  const known = new Set(criteria.map((c) => c.id))
  const list = criteriaList(answer)
  if (list === undefined) return out
  for (const e of list) {
    if (!isRecord(e)) continue
    const id = idOf(e['id'] ?? e['criterion'], known)
    if (id === undefined) continue
    const raw = e['tests'] ?? e['test']
    const tests = (Array.isArray(raw) ? raw : [raw])
      .map((t) => cleanLine(t, ACCEPTANCE_TEST_REF_MAX))
      .filter((t) => t !== '')
    const all = [...(out[id] ?? [])]
    for (const t of tests) if (!all.includes(t) && all.length < ACCEPTANCE_TESTS_MAX) all.push(t)
    if (all.length > 0) out[id] = all
  }
  return out
}

// ---- the acceptance review's answer ----------------------------------------------------------------------------

/** The JSON Schema the acceptance review answers with (structured output where the vendor supports it). */
export const ACCEPTANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      maxItems: ACCEPTANCE_MAX_CRITERIA,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['met', 'not-met', 'unknown'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
} as const

/** Notes the parse adds (UI copy, no em dashes). */
export const ACCEPTANCE_PARSE_NOTE = {
  unreadable: "The acceptance review's answer could not be read, so every criterion reads unknown.",
  noEvidence: (ids: readonly string[]): string =>
    `The acceptance review gave no evidence for ${ids.join(', ')}, so ${ids.length === 1 ? 'it reads' : 'they read'} unknown.`,
  missing: (ids: readonly string[]): string =>
    `The acceptance review did not assess ${ids.join(', ')}, so ${ids.length === 1 ? 'it reads' : 'they read'} unknown.`,
} as const

/** The evidence of a criterion the answer left out. */
export const NOT_ASSESSED = 'Not assessed.'

export type AcceptanceVerdict = 'met' | 'not-met' | 'unknown'

export interface AcceptanceAnswer {
  /** One verdict per criterion, in the criteria's order. */
  results: Record<string, { status: AcceptanceVerdict; evidence?: string }>
  /** false: nothing could be read (every criterion unknown). */
  readable: boolean
  notes: string[]
}

function verdictOf(v: unknown): AcceptanceVerdict {
  const t =
    typeof v === 'string'
      ? v
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, '-')
      : ''
  if (t === 'met' || t === 'pass' || t === 'passed' || t === 'yes' || t === 'done') return 'met'
  if (t === 'not-met' || t === 'unmet' || t === 'fail' || t === 'failed' || t === 'no' || t === 'missing')
    return 'not-met'
  return 'unknown'
}

/**
 * The acceptance review's verdicts over `criteria` (`value`: the vendor's structured answer, or the final message's
 * text). Never throws.
 */
export function parseAcceptanceAnswer(
  value: unknown,
  criteria: readonly AcceptanceCriterion[],
): AcceptanceAnswer {
  const results: AcceptanceAnswer['results'] = {}
  const known = new Set(criteria.map((c) => c.id))
  const list = criteriaList(value)
  if (list === undefined) {
    for (const c of criteria) results[c.id] = { status: 'unknown' }
    return { results, readable: false, notes: criteria.length > 0 ? [ACCEPTANCE_PARSE_NOTE.unreadable] : [] }
  }
  const noEvidence: string[] = []
  for (const e of list) {
    if (!isRecord(e)) continue
    const id = idOf(e['id'] ?? e['criterion'], known)
    if (id === undefined || results[id] !== undefined) continue
    let status = verdictOf(e['status'] ?? e['verdict'] ?? e['result'])
    const evidence = cleanLine(e['evidence'] ?? e['reason'] ?? e['why'], ACCEPTANCE_EVIDENCE_MAX)
    if (status !== 'unknown' && evidence === '') {
      status = 'unknown'
      noEvidence.push(id)
    }
    results[id] = evidence !== '' ? { status, evidence } : { status }
  }
  const missing: string[] = []
  for (const c of criteria) {
    if (results[c.id] !== undefined) continue
    missing.push(c.id)
    results[c.id] = { status: 'unknown', evidence: NOT_ASSESSED }
  }
  const notes: string[] = []
  if (missing.length === criteria.length && criteria.length > 0) {
    // Nothing usable: the same as an unreadable answer.
    for (const c of criteria) results[c.id] = { status: 'unknown' }
    return { results, readable: false, notes: [ACCEPTANCE_PARSE_NOTE.unreadable] }
  }
  const order = (ids: string[]): string[] => criteria.map((c) => c.id).filter((id) => ids.includes(id))
  if (noEvidence.length > 0) notes.push(ACCEPTANCE_PARSE_NOTE.noEvidence(order(noEvidence)))
  if (missing.length > 0) notes.push(ACCEPTANCE_PARSE_NOTE.missing(missing))
  return { results, readable: true, notes }
}

// ---- prompts ---------------------------------------------------------------------------------------------------

/** The criteria as a prompt lists them (`- AC1: text`), with the tests mapped to each when known. */
export function renderCriteria(
  criteria: readonly AcceptanceCriterion[],
  tests: Readonly<Record<string, readonly string[]>> = {},
): string {
  const lines: string[] = []
  for (const c of criteria) {
    lines.push(`- ${c.id}: ${c.text}`)
    const t = tests[c.id] ?? []
    if (t.length > 0) lines.push(`  Tests: ${t.join('; ')}`)
  }
  return lines.join('\n')
}
