// The plan's acceptance criteria, parsed (pure, never throwing): the `## Acceptance criteria` section (any heading
// level or case; a plan without one falls back to "## Done when") as AC1 to ACn, one per list item, capped in number
// and length. Shared: core decides the run's criteria with it, and the renderer reads them from a plan it shows.
import { ACCEPTANCE_MAX_CRITERIA, ACCEPTANCE_TEXT_MAX } from './acceptance.ts'
import type { AcceptanceCriterion } from './acceptance.ts'

// ---- the plan's criteria ---------------------------------------------------------------------------------------

export interface CriteriaParse {
  criteria: AcceptanceCriterion[]
  /** Items left out past the cap. */
  dropped: number
}

const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/
/** A heading written as a bold line or a label ("**Acceptance criteria**", "Acceptance criteria:"). */
const LABEL_RE = /^ {0,3}(?:\*\*|__)?([A-Za-z][A-Za-z ]{2,40}?)(?:\*\*|__)?[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/

/** A heading's title without bold markers and a trailing colon. */
const titleText = (t: string): string =>
  t
    .replace(/^(\*\*|__)(.*)\1$/, '$2')
    .replace(/:\s*$/, '')
    .trim()
const isCriteriaTitle = (t: string): boolean => /^acceptance(\s+criteria)?$/i.test(titleText(t))
const isDoneTitle = (t: string): boolean => /^done\s+when$/i.test(titleText(t))

/** One line of text, cut at a word boundary to `max` characters. */
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/** The section's lines after a heading that `match` accepts, up to the next heading (undefined: no such heading). */
function sectionLines(lines: readonly string[], match: (title: string) => boolean): string[] | undefined {
  let fence: string | undefined
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const f = FENCE_RE.exec(line)
    if (f !== null) {
      const mark = f[1] ?? ''
      if (fence === undefined) fence = mark
      else if (mark.startsWith(fence[0] ?? '') && mark.length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const h = HEADING_RE.exec(line)
    const l = h === null ? LABEL_RE.exec(line) : null
    const title = h?.[1] ?? l?.[1]
    if (start < 0) {
      if (title !== undefined && match(title)) start = i + 1
      continue
    }
    // The next heading ends the section (a bold label only when it is another known section's).
    if (h !== null) return lines.slice(start, i)
    if (l !== null && /^(goal|steps|risks|decisions|done when|notes|assumptions)$/i.test((l[1] ?? '').trim()))
      return lines.slice(start, i)
  }
  return start < 0 ? undefined : lines.slice(start)
}

/** The list items of a section: top-level items, with indented lines and nested items joined to their item. */
function itemsOf(lines: readonly string[]): string[] {
  const items: string[] = []
  let top: number | undefined
  let fence: string | undefined
  for (const raw of lines) {
    const f = FENCE_RE.exec(raw)
    if (f !== null) {
      fence = fence === undefined ? (f[1] ?? '') : undefined
      continue
    }
    if (fence !== undefined || raw.trim() === '') continue
    const m = ITEM_RE.exec(raw)
    const indent = (raw.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length
    if (m !== null) {
      top ??= indent
      if (indent <= top + 1 || items.length === 0) items.push(m[2] ?? '')
      else items[items.length - 1] = `${items[items.length - 1] ?? ''} ${m[2] ?? ''}`
      continue
    }
    // A plain line: a criterion of its own (a list written without markers), or the continuation of an item.
    if (items.length > 0 && top !== undefined && indent > top)
      items[items.length - 1] = `${items[items.length - 1] ?? ''} ${raw}`
    else items.push(raw)
  }
  return items
}

const EMPTY_RE = /^(none|n\/a|na|-|tbd|nothing)\.?$/i

/**
 * The decided plan's acceptance criteria: the `## Acceptance criteria` section (else `## Done when`), one per list
 * item, at most ACCEPTANCE_MAX_CRITERIA, each at most ACCEPTANCE_TEXT_MAX characters, duplicates left out. A plan
 * without the section has none.
 */
export function parseCriteria(plan: string | null | undefined): CriteriaParse {
  if (plan === null || plan === undefined || plan.trim() === '') return { criteria: [], dropped: 0 }
  const lines = plan
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const section = sectionLines(lines, isCriteriaTitle) ?? sectionLines(lines, isDoneTitle)
  if (section === undefined) return { criteria: [], dropped: 0 }
  const seen = new Set<string>()
  const texts: string[] = []
  for (const item of itemsOf(section)) {
    const text = cleanLine(item.replace(/^\*\*(.+?)\*\*$/, '$1'), ACCEPTANCE_TEXT_MAX)
    const key = text.toLowerCase()
    if (text === '' || EMPTY_RE.test(text) || seen.has(key)) continue
    seen.add(key)
    texts.push(text)
  }
  const kept = texts.slice(0, ACCEPTANCE_MAX_CRITERIA)
  return {
    criteria: kept.map((text, i) => ({ id: `AC${i + 1}`, text })),
    dropped: texts.length - kept.length,
  }
}
