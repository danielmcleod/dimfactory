// Findings renderers (with the templates' rendering rules): the {{findings}} value for fix.md and the
// review.md / critic.md artifact text.
//
// {{findings}}:
//   1. A `Notes:` list ("User reverted after review: a, b", "User edited outside the run: c").
//   2. One entry per SELECTED finding, must first: `- [must] F1 (review) <title>`, body indented 2 spaces. A security
//      finding names its level too: `- [must] F2 (security) [security:high] <title>`.
// Capped at 60 KB (UTF-8): should bodies are dropped first (last finding first), then whole should entries, each
// with a truncation note. If the must findings alone still exceed the cap the text is cut hard, with a note, so
// the template's own cap never has to cut it again.
import type { Finding, Severity } from '../../shared/findings.ts'
import { VALUE_CAPS_BYTES, normalizeText, truncateUtf8 } from '../prompts/template.ts'

export { skipRule } from './parse.ts'
export type { SkipDecision } from './parse.ts'

export const FINDINGS_CAP_BYTES = VALUE_CAPS_BYTES['findings'] ?? 60 * 1024

export interface FindingsNotesInput {
  /** Files the user reverted after review. */
  reverted?: readonly string[]
  /** Files the user edited outside the run. */
  editedOutside?: readonly string[]
}

/** The `Notes:` lines for {{findings}}. */
export function findingsNotes(input: FindingsNotesInput): string[] {
  const out: string[] = []
  if (input.reverted !== undefined && input.reverted.length > 0) {
    out.push(`User reverted after review: ${input.reverted.join(', ')}`)
  }
  if (input.editedOutside !== undefined && input.editedOutside.length > 0) {
    out.push(`User edited outside the run: ${input.editedOutside.join(', ')}`)
  }
  return out
}

export interface RenderFindingsOptions {
  /** Finding id → selected. Absent: every finding is rendered. Present: only ids set to `true`. */
  selected?: Readonly<Record<string, boolean>>
  /** Rendered first as a `Notes:` list (see findingsNotes). */
  notes?: readonly string[]
  /** Default 60 KB (the findings cap). */
  capBytes?: number
}

export interface RenderedFindings {
  text: string
  /** UTF-8 size of `text` (≤ capBytes). */
  bytes: number
  /** Findings rendered (with or without their body). */
  included: number
  /** Should findings rendered as a title only. */
  droppedBodies: number
  /** Should findings left out entirely. */
  droppedFindings: number
  /** The must findings alone exceeded the cap and the text was cut. */
  hardTruncated: boolean
}

interface Entry {
  f: Finding
  full: string
  title: string
  fullBytes: number
  titleBytes: number
  mode: 'full' | 'title' | 'drop'
}

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const rank = (s: Severity): number => (s === 'must' ? 0 : 1)

function entryText(f: Finding, withBody: boolean): string {
  const level = f.level !== undefined ? ` [security:${f.level}]` : ''
  const head = `- [${f.severity}] F${f.n} (${f.source})${level} ${oneLine(f.title)}`.trimEnd()
  if (!withBody) return head
  const body = normalizeText(f.body)
    .split('\n')
    .map((l) => l.trimEnd())
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  while (body.length > 0 && body[0] === '') body.shift()
  if (body.length === 0) return head
  return [head, ...body.map((l) => (l === '' ? '' : `  ${l}`))].join('\n')
}

function shortenedNote(droppedBodies: number, droppedFindings: number, capBytes: number): string {
  const parts: string[] = []
  if (droppedBodies > 0)
    parts.push(`details of ${droppedBodies} [should] finding${droppedBodies === 1 ? '' : 's'}`)
  if (droppedFindings > 0)
    parts.push(`${droppedFindings} [should] finding${droppedFindings === 1 ? '' : 's'}`)
  return `[Dim Factory left out ${parts.join(' and ')} to stay within ${Math.floor(capBytes / 1024)} KB.]`
}

/** {{findings}} with the size accounting the engine logs. */
export function renderFindingsDetailed(
  findings: readonly Finding[],
  opts: RenderFindingsOptions = {},
): RenderedFindings {
  const cap = opts.capBytes ?? FINDINGS_CAP_BYTES
  const sel = opts.selected
  const picked = findings
    .filter((f) => sel === undefined || sel[f.id] === true)
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.n - b.n)
  const notes = (opts.notes ?? []).map(oneLine).filter((n) => n !== '')
  const notesBlock = notes.length > 0 ? ['Notes:', ...notes.map((n) => `- ${n}`)].join('\n') : ''

  const entries = picked.map((f): Entry => {
    const full = entryText(f, true)
    const title = entryText(f, false)
    return { f, full, title, fullBytes: bytesOf(full), titleBytes: bytesOf(title), mode: 'full' }
  })
  let droppedBodies = 0
  let droppedFindings = 0

  const compose = (note: string): string => {
    const list = entries
      .filter((e) => e.mode !== 'drop')
      .map((e) => (e.mode === 'full' ? e.full : e.title))
      .join('\n')
    return [notesBlock, list, note].filter((p) => p !== '').join('\n\n')
  }
  const noteNow = (): string =>
    droppedBodies + droppedFindings > 0 ? shortenedNote(droppedBodies, droppedFindings, cap) : ''
  // Size without re-joining: parts separated by '\n\n', entries by '\n' (all separators are ASCII).
  let listBytes = entries.reduce((n, e) => n + e.fullBytes, 0) + Math.max(0, entries.length - 1)
  let listCount = entries.length
  const size = (): number => {
    const note = noteNow()
    const parts = [bytesOf(notesBlock), listCount > 0 ? listBytes : 0, bytesOf(note)].filter((b) => b > 0)
    return parts.reduce((a, b) => a + b, 0) + 2 * Math.max(0, parts.length - 1)
  }

  const shoulds = entries.filter((e) => e.f.severity === 'should').reverse()
  for (const e of shoulds) {
    if (size() <= cap) break
    if (e.full === e.title) continue
    e.mode = 'title'
    listBytes -= e.fullBytes - e.titleBytes
    droppedBodies++
  }
  for (const e of shoulds) {
    if (size() <= cap) break
    const was = e.mode === 'full' ? e.fullBytes : e.titleBytes
    if (e.mode === 'title') droppedBodies--
    e.mode = 'drop'
    listBytes -= was + (listCount > 1 ? 1 : 0)
    listCount--
    droppedFindings++
  }

  let text = compose(noteNow())
  let hardTruncated = false
  if (bytesOf(text) > cap) {
    const note = `\n[… truncated by Dim Factory to stay within ${Math.floor(cap / 1024)} KB]`
    text = truncateUtf8(truncateUtf8(text, Math.max(0, cap - bytesOf(note))) + note, cap)
    hardTruncated = true
  }
  return {
    text,
    bytes: bytesOf(text),
    included: listCount,
    droppedBodies,
    droppedFindings,
    hardTruncated,
  }
}

/** The {{findings}} value for fix.md. */
export function renderFindings(findings: readonly Finding[], opts: RenderFindingsOptions = {}): string {
  return renderFindingsDetailed(findings, opts).text
}

/** runs/<id>/review.md and critic.md: the pass's raw output, LF line endings, one trailing newline. */
export function reviewArtifactText(raw: string): string {
  const t = normalizeText(raw).trimEnd()
  return t === '' ? '' : `${t}\n`
}
