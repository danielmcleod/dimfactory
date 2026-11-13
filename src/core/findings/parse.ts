// Findings parser. Review/Critic output → Finding[].
//
// 1. Normalize: strip the BOM, CRLF → LF, unwrap one whole-output fence (```markdown, ```md or bare).
// 2. `NO FINDINGS` (the whole answer, or its first line before commentary) is status `none`; so are, once no
//    finding is tagged and no untagged list item exists, a last line `NO FINDINGS` after commentary and a short
//    answer that is wholly a "no issues / LGTM" statement (NONE_RE). Anything more stays a finding (step 6).
// 3. Candidates (marked.lexer, raw token text): list items at any depth, top-level paragraphs and top-level
//    headings. Code, HTML, blockquotes and tables are opaque: never candidates, never searched for tags.
// 4. A candidate is tagged when its RAW first line, after the list marker, a GFM checkbox and emphasis/backticks
//    are stripped, matches TAG_RE. must/blocker/critical/major → must; every other tag → should. The security
//    advisor's `[security:<level>]` carries a level: critical and high → must, medium and low → should (a bare
//    `[security]` is a should without a level). A `(grounding)` marker right after the tag (`[must] (grounding) x`)
//    flags the finding `grounding` (the AI's claims do not match the code) and is cut from its title.
// 5. Body: the candidate's raw lines after the first, dedented, with tagged descendants cut out (they are
//    findings of their own). A heading's body runs to the next heading of the same or a higher level.
// 6. Nothing tagged: top-level list items become `should` findings flagged `untagged`; prose only becomes one
//    `unstructured` finding; no output at all is status `empty`.
// 7. id = sha1(source + '\n' + normalizedFirstLine).slice(0, 12), `-2`, `-3`… on a collision. n = F1…, must first.
//
// Positions are tracked in LINES, not offsets: marked dedents list-item content but keeps one content line per
// raw line, so line k of `item.text` is line `itemStart + k` of the source. Link reference definitions
// (`[must]: x`) are neutralized before lexing (marked drops repeated ones from the token stream) by swapping
// the colon after `]` for a private-use character; the swap is 1:1, so lines and offsets are unchanged and every
// line read back for tags, titles and bodies comes from the original text. Parsing never throws: a lexer
// failure falls back to scanning every line as one paragraph.
import { createHash } from 'node:crypto'
import { getDefaults, lexer } from 'marked'
import type { Token, Tokens } from 'marked'
import { FINDING_SOURCES, REVIEWER_SOURCES } from '../../shared/findings.ts'
import type {
  Finding,
  FindingFlag,
  FindingSource,
  FindingsFile,
  FixReportStatus,
  ReviewerSource,
  SecurityLevel,
  Severity,
  SourceParse,
  SourceParseStatus,
} from '../../shared/findings.ts'
import type { FindingCounts } from '../../shared/run.ts'
import { normalizeText } from '../prompts/template.ts'

// ---- constants ----------------------------------------------------------------------------------------------

/** The tag rule, verbatim. Applied to the raw first line after the marker, checkbox and emphasis are stripped. */
export const TAG_RE =
  /^\[\s*(security\s*[:/-]\s*(?:critical|high|medium|moderate|low)|security|must(?:[\s-]?fix)?|should|blocker|critical|major|nit|minor|consider|could)\s*\]\s*[:\-–—]?\s*/i
/** Tags (lower-cased, spaces and hyphens removed) that map to `must`. */
export const MUST_TAGS: ReadonlySet<string> = new Set([
  'must',
  'mustfix',
  'blocker',
  'critical',
  'major',
  'security:critical',
  'security:high',
])

/** `security:<level>` (as TagMatch.tag) → the finding's security level. */
function securityLevelOf(tag: string): SecurityLevel | undefined {
  const m = /^security:(critical|high|medium|moderate|low)$/.exec(tag)
  if (m === null) return undefined
  const level = m[1] === 'moderate' ? 'medium' : m[1]
  return level as SecurityLevel
}

export const NO_FINDINGS = 'NO FINDINGS'
/**
 * A short "no issues / LGTM" answer: the WHOLE answer (decoration trimmed) must be a no-issues statement. Any
 * further content ("LGTM except …", "No issues with X, but …", a second sentence) is not `none`: it may report a
 * problem, and an unreadable reviewer never counts as zero.
 */
export const NONE_RE =
  /^(?:no (?:findings|issues|problems|concerns)(?: (?:found|spotted|detected|identified|to report))?(?: (?:in|with) (?:this|the) (?:change|changes|diff|code|implementation|patch))?|lgtm|looks good(?: to me)?)(?:,? ship it)?[.!]*$/i

const SOURCE_LABEL: Readonly<Record<FindingSource, string>> = {
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
  scan: 'Security scan',
  verify: 'Verify',
  tests: 'Tests',
  preview: 'Preview',
  acceptance: 'Acceptance',
  grounding: 'Grounding',
}

// ---- normalization --------------------------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/

/**
 * Unwrap output that is exactly one fenced block whose info string is `markdown`, `md` or empty. Fences nested
 * inside (```ts … ```) are allowed; a bare fence that would close the outer block early means the output holds
 * more than one block, and the text is returned unchanged.
 */
export function unwrapSingleFence(text: string): string {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return text
  const open = FENCE_RE.exec(lines[0] ?? '')
  const close = FENCE_RE.exec(lines[lines.length - 1] ?? '')
  if (open === null || close === null) return text
  const openFence = open[1] ?? ''
  const info = (open[2] ?? '').toLowerCase()
  if (info !== '' && info !== 'markdown' && info !== 'md') return text
  const char = openFence[0]
  const closes = (m: RegExpExecArray, c: string | undefined, len: number): boolean =>
    (m[2] ?? '') === '' && (m[1] ?? '')[0] === c && (m[1] ?? '').length >= len
  if (!closes(close, char, openFence.length)) return text
  let nested: { char: string | undefined; len: number } | null = null
  for (const line of lines.slice(1, -1)) {
    const m = FENCE_RE.exec(line)
    if (m === null) continue
    const fence = m[1] ?? ''
    if (nested !== null) {
      if (closes(m, nested.char, nested.len)) nested = null
      continue
    }
    if (closes(m, char, openFence.length)) return text
    nested = { char: fence[0], len: fence.length }
  }
  return lines.slice(1, -1).join('\n')
}

/** Strip a BOM, CRLF → LF, unwrap a single whole-output fence. */
export function normalizeOutput(text: string): string {
  return unwrapSingleFence(normalizeText(text))
}

// ---- tag detection ----------------------------------------------------------------------------------------------

const LIST_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
const ATX_RE = /^#{1,6}(?:[ \t]+|$)/
const CHECKBOX_RE = /^\[[ xX]\](?:[ \t]+|$)/
const EMPHASIS_RE = /^[*_~`]+/
const SEPARATOR_RE = /^\s*[:\-–—]?\s*/

/** `## Title ##` → `## Title` (an ATX closing sequence needs whitespace before it). */
function stripClosingHashes(line: string): string {
  const t = line.trimEnd()
  let i = t.length
  while (i > 0 && t[i - 1] === '#') i--
  if (i === t.length) return line
  const before = t[i - 1]
  return before === ' ' || before === '\t' ? t.slice(0, i).trimEnd() : line
}

/** Remove indentation, one list marker (or ATX heading hashes) and one GFM checkbox. */
export function stripLineLead(line: string): string {
  let s = line.trimStart()
  const marker = LIST_MARKER_RE.exec(s) ?? ATX_RE.exec(s)
  if (marker !== null) s = s.slice(marker[0].length)
  const box = CHECKBOX_RE.exec(s)
  if (box !== null) s = s.slice(box[0].length)
  return s
}

export interface TagMatch {
  /** The tag word, lower-cased, spaces and hyphens removed (`mustfix`, `nit`…). */
  tag: string
  severity: Severity
  /** The rest of the line after the tag, its separator and any emphasis wrapped around the tag. */
  title: string
  /** `[security:<level>]`: the security level. */
  level?: SecurityLevel
}

/** Tag detection on a raw first line. Null when the line carries no tag. */
export function detectTag(line: string): TagMatch | null {
  const s = stripLineLead(line)
  const opener = EMPHASIS_RE.exec(s)?.[0] ?? ''
  let rest = s.slice(opener.length).trimStart()
  const m = TAG_RE.exec(rest)
  if (m === null) return null
  const tag = (m[1] ?? '')
    .toLowerCase()
    .replace(/[\s-]/g, '')
    .replace(/^security[:/]?(?=critical|high|medium|moderate|low)/, 'security:')
  rest = rest.slice(m[0].length)
  if (opener !== '') {
    const closer = [...opener].reverse().join('')
    if (rest.startsWith(closer)) {
      rest = rest.slice(closer.length).replace(SEPARATOR_RE, '') // **[must]** x · **[must]:** x
    } else {
      const at = rest.indexOf(closer) // **[must] x** · `[must] x` y
      if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + closer.length)
    }
  }
  const level = securityLevelOf(tag)
  return {
    tag,
    severity: MUST_TAGS.has(tag) ? 'must' : 'should',
    title: rest.trim(),
    ...(level !== undefined ? { level } : {}),
  }
}

// ---- ids ----------------------------------------------------------------------------------------------------------

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** A location code span at a title's start, then its separator (a colon, a spaced hyphen, an en or em dash). */
const LOCATION_SEPARATOR_RE = /^(`[^`\n]+`)(?:\s*:\s+|\s+-{1,2}\s+|\s*[–—]+\s*)(?=\S)/

/**
 * A title that opens with a location and a separator (`file:line` — problem, `file:line` - problem) reads
 * "`file:line`: problem": the app never shows an em dash (a UI copy standard), whatever format
 * a reviewer used. Dim Factory's own Review and Critic prompts ask for the colon already. Ids are unaffected (they hash
 * the raw first line).
 */
export function tidyLocation(title: string): string {
  return title.replace(LOCATION_SEPARATOR_RE, '$1: ')
}

/** sha1(source + '\n' + normalizedFirstLine).slice(0, 12). `firstLine` is normalized here (lead, whitespace). */
export function findingId(source: FindingSource, firstLine: string): string {
  return createHash('sha1')
    .update(`${source}\n${collapse(stripLineLead(firstLine))}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
}

/** Make `id` unique against `used` (`-2`, `-3`…) and record it. */
function claimId(id: string, used: Set<string>): string {
  let out = id
  for (let k = 2; used.has(out); k++) out = `${id}-${k}`
  used.add(out)
  return out
}

// ---- candidate extraction ---------------------------------------------------------------------------------------

interface Candidate {
  kind: 'item' | 'para' | 'heading'
  /** Source line of the first line. */
  start: number
  /** Last line of the head (a setext heading has two); the body starts after it. */
  headEnd: number
  /** Last line covered (items: the item; paragraphs: the segment; headings: the section). */
  end: number
  /** List nesting (0 = top-level list); -1 for paragraphs and headings. */
  nest: number
  /** Heading level; 0 otherwise. */
  depth: number
  /** The raw first line (an item's own raw line, marker included). */
  first: string
  /** Items: content lines from marked (dedented); index k is source line start + k. */
  content: string[] | null
  tag: TagMatch | null
}

const isList = (t: Token): t is Tokens.List => t.type === 'list'
const isHeading = (t: Token): t is Tokens.Heading => t.type === 'heading'

function countNewlines(s: string, from: number, to: number): number {
  let n = 0
  for (let i = s.indexOf('\n', from); i >= 0 && i < to; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** A private-use character absent from `text`, used to neutralize `]:` (link reference definitions). */
function placeholderFor(text: string): string {
  for (let c = 0xe000; c <= 0xf8ff; c++) {
    const ch = String.fromCharCode(c)
    if (!text.includes(ch)) return ch
  }
  return '\u0000'
}

function lexBlocks(src: string): Token[] | null {
  try {
    return lexer(src, { ...getDefaults(), gfm: true, pedantic: false, silent: false })
  } catch {
    return null
  }
}

/** Locate `raw` at or after `from` (normally exactly at `from`). -1 when marked rewrote it. */
function locate(hay: string, raw: string, from: number): number {
  return hay.startsWith(raw, from) ? from : hay.indexOf(raw, from)
}

class Collector {
  readonly out: Candidate[] = []
  readonly #lines: readonly string[]
  readonly #restore: (s: string) => string

  constructor(lines: readonly string[], restore: (s: string) => string) {
    this.#lines = lines
    this.#restore = restore
  }

  /** Top-level paragraph lines [s, e]: every line that starts with a tag opens a new candidate. */
  paragraph(s: number, e: number): void {
    let cur: Candidate | null = null
    for (let g = s; g <= e; g++) {
      const line = this.#lines[g] ?? ''
      const tag = detectTag(line)
      if (tag === null) continue
      if (cur !== null) cur.end = g - 1
      cur = {
        kind: 'para',
        start: g,
        headEnd: g,
        end: e,
        nest: -1,
        depth: 0,
        first: line,
        content: null,
        tag,
      }
      this.out.push(cur)
    }
  }

  heading(tok: Tokens.Heading, s: number, e: number): void {
    const line = this.#lines[s] ?? ''
    const first = ATX_RE.test(line.trimStart()) ? stripClosingHashes(line) : line
    this.out.push({
      kind: 'heading',
      start: s,
      headEnd: e,
      end: e,
      nest: -1,
      depth: tok.depth,
      first,
      content: null,
      tag: detectTag(first),
    })
  }

  /** `base` is the source line where `list.raw` starts. */
  list(list: Tokens.List, base: number, nest: number): void {
    let off = 0
    let line = base
    for (const item of list.items) {
      const at = locate(list.raw, item.raw, off)
      if (at < 0) continue
      const start = line + countNewlines(list.raw, off, at)
      const trimmed = item.raw.trimEnd()
      const end = start + countNewlines(trimmed, 0, trimmed.length)
      const content = this.#restore(item.text).split('\n')
      let first = this.#restore(item.raw.split('\n', 1)[0] ?? '')
      let head = 0
      if (stripLineLead(first).trim() === '') {
        // "-" alone on its line: the first content line below it is the item's first line.
        const k = content.findIndex((l, i) => i > 0 && l.trim() !== '')
        if (k > 0 && start + k <= end) {
          head = k
          first = content[k] ?? ''
        }
      }
      this.out.push({
        kind: 'item',
        start,
        headEnd: start + head,
        end,
        nest,
        depth: 0,
        first,
        content,
        tag: detectTag(first),
      })
      this.#children(item, start, nest + 1)
      line = start + countNewlines(item.raw, 0, item.raw.length)
      off = at + item.raw.length
    }
  }

  /** Nested lists inside an item; their raw text is a slice of `item.text` (line k = source line start + k). */
  #children(item: Tokens.ListItem, start: number, nest: number): void {
    const text = item.text
    let off = 0
    let line = start
    for (const child of item.tokens) {
      if (child.type === 'checkbox' || child.raw === '') continue
      const at = locate(text, child.raw, off)
      if (at < 0) continue
      const childLine = line + countNewlines(text, off, at)
      if (isList(child)) this.list(child, childLine, nest)
      line = childLine + countNewlines(child.raw, 0, child.raw.length)
      off = at + child.raw.length
    }
  }
}

function lineStartsOf(s: string): number[] {
  const starts = [0]
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

function lineAtOffset(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

function collectCandidates(src: string, lines: readonly string[]): Candidate[] {
  const ph = placeholderFor(src)
  const sanitized = src.replaceAll(']:', `]${ph}`)
  const restore = (s: string): string => s.replaceAll(ph, ':')
  const c = new Collector(lines, restore)
  const tokens = lexBlocks(sanitized)
  if (tokens === null) {
    c.paragraph(0, lines.length - 1)
    return c.out
  }
  const starts = lineStartsOf(sanitized)
  /** Source lines of the non-blank part of sanitized[from, to), or null when it is blank. */
  const span = (from: number, to: number): [number, number] | null => {
    const text = sanitized.slice(from, to)
    const lead = text.search(/\S/)
    if (lead < 0) return null
    return [lineAtOffset(starts, from + lead), lineAtOffset(starts, from + text.trimEnd().length - 1)]
  }
  const gap = (from: number, to: number): void => {
    const r = span(from, to)
    if (r !== null) c.paragraph(r[0], r[1])
  }

  let cursor = 0
  for (const tok of tokens) {
    if (tok.raw === '') continue
    const at = locate(sanitized, tok.raw, cursor)
    if (at < 0) continue
    if (at > cursor) gap(cursor, at) // text marked dropped from the token stream
    const r = span(at, at + tok.raw.length)
    if (r !== null) {
      if (isList(tok)) c.list(tok, lineAtOffset(starts, at), 0)
      else if (isHeading(tok)) c.heading(tok, r[0], r[1])
      else if (tok.type === 'paragraph' || tok.type === 'text' || tok.type === 'def') c.paragraph(r[0], r[1])
      // code, fences, html, blockquote, table, hr: opaque
    }
    cursor = at + tok.raw.length
  }
  if (cursor < sanitized.length) gap(cursor, sanitized.length)

  // A heading's section runs to the next heading of the same or a higher level (trailing blank lines dropped).
  const open: Candidate[] = []
  const close = (h: Candidate, next: number): void => {
    let end = next - 1
    while (end > h.headEnd && (lines[end] ?? '').trim() === '') end--
    h.end = Math.max(end, h.headEnd)
  }
  for (const h of c.out) {
    if (h.kind !== 'heading') continue
    while (open.length > 0 && (open[open.length - 1]?.depth ?? 0) >= h.depth)
      close(open.pop() as Candidate, h.start)
    open.push(h)
  }
  for (const h of open) close(h, lines.length)
  return c.out.sort((a, b) => a.start - b.start || a.nest - b.nest)
}

// ---- bodies -------------------------------------------------------------------------------------------------------

function dedent(lines: readonly string[]): string[] {
  let min = Infinity
  for (const l of lines) {
    if (l.trim() === '') continue
    const lead = l.length - l.trimStart().length
    if (lead < min) min = lead
  }
  const cut = Number.isFinite(min) ? min : 0
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(cut).trimEnd()))
}

/** Drop leading/trailing blank lines and collapse runs of blank lines to one. */
function tidy(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(l)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

function bodyLines(c: Candidate, lines: readonly string[], cuts: readonly Candidate[]): string[] {
  const cutLines = new Set<number>()
  for (const y of cuts)
    for (let g = Math.max(y.start, c.headEnd + 1); g <= Math.min(y.end, c.end); g++) cutLines.add(g)
  const isCut = (g: number): boolean => cutLines.has(g)
  const raw: string[] = []
  if (c.content !== null) {
    for (let k = c.headEnd - c.start + 1; k < c.content.length && c.start + k <= c.end; k++) {
      if (!isCut(c.start + k)) raw.push(c.content[k] ?? '')
    }
  } else {
    for (let g = c.headEnd + 1; g <= c.end; g++) if (!isCut(g)) raw.push(lines[g] ?? '')
  }
  return tidy(dedent(raw))
}

/** Tagged candidates nested inside `c` (their lines leave c's body). `tagged` is sorted by start line. */
function descendantsOf(c: Candidate, tagged: readonly Candidate[]): Candidate[] {
  let lo = 0
  let hi = tagged.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((tagged[mid]?.start ?? 0) <= c.headEnd) lo = mid + 1
    else hi = mid
  }
  const out: Candidate[] = []
  for (let j = lo; j < tagged.length; j++) {
    const y = tagged[j]
    if (y === undefined || y.start > c.end) break
    if (y !== c && y.end <= c.end) out.push(y)
  }
  return out
}

// ---- parse ----------------------------------------------------------------------------------------------------------

export interface ParseOptions {
  /** Review round (default 1). */
  round?: number
  /** Raw output artifact relative to the run folder (default `<source>.md`). */
  rawFile?: string
}

export interface ParsedSource {
  source: FindingSource
  parse: SourceParse
  /** Must first, numbered F1… within this source (mergeFindings renumbers across sources). */
  findings: Finding[]
}

interface Draft {
  severity: Severity
  title: string
  body: string[]
  flags: FindingFlag[]
  first: string
  level?: SecurityLevel
}

/** Strip surrounding whitespace, emphasis and backticks (manual loop: no regex backtracking on long input). */
function trimDecor(s: string): string {
  const decor = (ch: string | undefined): boolean =>
    ch !== undefined && (ch.trim() === '' || '*_`~'.includes(ch))
  let a = 0
  let b = s.length
  while (a < b && decor(s[a])) a++
  while (b > a && decor(s[b - 1])) b--
  return s.slice(a, b)
}

/** A line that is the explicit verdict: `NO FINDINGS` (any case) once decoration and a final `.`/`!` are gone. */
function isVerdictLine(line: string): boolean {
  return trimDecor(line).replace(/[.!]$/, '').toUpperCase() === NO_FINDINGS
}

/**
 * The explicit verdict as the whole answer or its first line (extension: commentary may follow it). Checked before
 * untagged list items: the reviewer said NO FINDINGS first, so what follows is what it checked.
 */
function isExplicitNone(text: string): boolean {
  const t = text.trim()
  if (t === NO_FINDINGS || trimDecor(t) === NO_FINDINGS) return true
  return isVerdictLine(t.split('\n', 1)[0] ?? '')
}

/**
 * After untagged list items are ruled out: the verdict as the LAST line after commentary (the final text segment
 * after the last tool call often reads "<what I checked>\n\nNO FINDINGS"), or a short answer that is wholly a
 * no-issues statement (NONE_RE).
 */
function isTrailingNone(text: string): boolean {
  const t = text.trim()
  const lines = t.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    if (isVerdictLine(line)) return true
    break
  }
  return !t.includes('\n') && NONE_RE.test(trimDecor(t))
}

/** `(grounding)` right after a tag: the claim does not match the code (the grounding filter). Never throws. */
const GROUNDING_MARKER_RE = /^[*_`]*\(\s*grounding\s*\)[*_`]*\s*[:\-–]?\s*/i

/** A tagged title's `(grounding)` marker, cut off: the title without it and whether it was there. */
export function groundingMarker(title: string): { title: string; grounding: boolean } {
  const m = GROUNDING_MARKER_RE.exec(title)
  return m === null ? { title, grounding: false } : { title: title.slice(m[0].length), grounding: true }
}

function finish(source: FindingSource, drafts: readonly Draft[], round: number): Finding[] {
  const used = new Set<string>()
  const withIds = drafts.map((d) => {
    let title = tidyLocation(collapse(d.title))
    let body = d.body
    if (title === '') {
      const k = body.findIndex((l) => l.trim() !== '')
      if (k >= 0) {
        title = tidyLocation(collapse(body[k] ?? ''))
        body = tidy(dedent(body.slice(k + 1)))
      }
    }
    const finding: Finding = {
      id: claimId(findingId(source, d.first), used),
      n: 0,
      severity: d.severity,
      source,
      title,
      body: body.join('\n'),
      flags: d.flags,
      round,
      ...(d.level !== undefined ? { level: d.level } : {}),
    }
    return finding
  })
  return mustFirst(withIds).map((f, i) => ({ ...f, n: i + 1 }))
}

const severityRank = (s: Severity): number => (s === 'must' ? 0 : 1)

/** Stable: must before should, otherwise input order. */
function mustFirst(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
}

/** Parse one source's raw output. Never throws. */
export function parseFindings(text: string, source: FindingSource, opts: ParseOptions = {}): ParsedSource {
  const round = opts.round ?? 1
  const rawFile = opts.rawFile ?? `${source}.md`
  const result = (status: SourceParseStatus, findings: Finding[] = []): ParsedSource => ({
    source,
    parse: { status, count: findings.length, rawFile },
    findings,
  })

  const src = normalizeOutput(typeof text === 'string' ? text : '')
  if (src.trim() === '') return result('empty')
  if (src.trim() === NO_FINDINGS) return result('none')

  const lines = src.split('\n')
  const candidates = collectCandidates(src, lines)
  const tagged = candidates.filter((c) => c.tag !== null)
  if (tagged.length > 0) {
    const drafts = tagged.map((c): Draft => {
      const g = groundingMarker(c.tag?.title ?? '')
      return {
        severity: c.tag?.severity ?? 'should',
        title: g.title,
        body: bodyLines(c, lines, descendantsOf(c, tagged)),
        flags: g.grounding ? ['grounding'] : [],
        first: c.first,
        ...(c.tag?.level !== undefined ? { level: c.tag.level } : {}),
      }
    })
    return result('ok', finish(source, drafts, round))
  }
  if (isExplicitNone(src)) return result('none')

  // Untagged list items come before any short "no issues" reading: "Looks good, except:\n- `a.ts:3` …" reports
  // problems, and each such item is a `should` finding.
  const topItems = candidates.filter((c) => c.kind === 'item' && c.nest === 0)
  if (topItems.length > 0) {
    const drafts = topItems.map((c): Draft => ({
      severity: 'should',
      title: stripLineLead(c.first),
      body: bodyLines(c, lines, []),
      flags: ['untagged'],
      first: c.first,
    }))
    return result('untagged', finish(source, drafts, round))
  }
  if (isTrailingNone(src)) return result('none')

  // Prose only: the whole answer becomes one finding.
  const all = tidy(dedent(lines))
  const firstIdx = all.findIndex((l) => l.trim() !== '')
  const firstLine = all[firstIdx] ?? ''
  const opensBlock = FENCE_RE.test(firstLine) || firstLine.trimStart().startsWith('<')
  const draft: Draft = opensBlock
    ? {
        severity: 'should',
        title: `${SOURCE_LABEL[source]} replied without a findings list`,
        body: all,
        flags: ['unstructured'],
        first: firstLine,
      }
    : {
        severity: 'should',
        title: stripLineLead(firstLine),
        body: tidy(all.slice(firstIdx + 1)),
        flags: ['unstructured'],
        first: firstLine,
      }
  return result('unstructured', finish(source, [draft], round))
}

/** A source whose pass failed (or produced nothing parseable). Never counts as zero findings. */
export function failedSource(source: FindingSource, opts: ParseOptions = {}): ParsedSource {
  return {
    source,
    parse: { status: 'failed', count: 0, rawFile: opts.rawFile ?? `${source}.md` },
    findings: [],
  }
}

// ---- merge / file ---------------------------------------------------------------------------------------------------

const sourceRank = (s: FindingSource): number => FINDING_SOURCES.indexOf(s)

/** All sources' findings, must first (then review, critic, verify; then document order), renumbered F1…. */
export function mergeFindings(parts: readonly ParsedSource[]): Finding[] {
  const ordered = [...parts].sort((a, b) => sourceRank(a.source) - sourceRank(b.source))
  const all = ordered.flatMap((p) => [...p.findings].sort((a, b) => a.n - b.n))
  const used = new Set<string>()
  return mustFirst(all).map((f, i) => ({ ...f, id: claimId(f.id, used), n: i + 1 }))
}

export interface BuildFindingsFileInput {
  runId: string
  round: number
  parts: readonly ParsedSource[]
  /** Earlier selection to carry over (ids not listed default to selected). */
  selected?: Readonly<Record<string, boolean>>
  fixReport?: Record<string, FixReportStatus>
}

export function buildFindingsFile(input: BuildFindingsFileInput): FindingsFile {
  const findings = mergeFindings(input.parts)
  const sources: Partial<Record<FindingSource, SourceParse>> = {}
  for (const p of input.parts) sources[p.source] = { ...p.parse }
  const selected: Record<string, boolean> = {}
  for (const f of findings) selected[f.id] = input.selected?.[f.id] ?? true
  const file: FindingsFile = {
    schemaVersion: 1,
    runId: input.runId,
    round: input.round,
    sources,
    findings,
    selected,
  }
  if (input.fixReport !== undefined) file.fixReport = input.fixReport
  return file
}

/** Must/should counts, optionally only of the selected findings ("Fix will receive 3 must · 2 should"). */
export function countFindings(
  findings: readonly Finding[],
  selected?: Readonly<Record<string, boolean>>,
): FindingCounts {
  const counts: FindingCounts = { must: 0, should: 0 }
  for (const f of findings) if (selected === undefined || selected[f.id] === true) counts[f.severity]++
  return counts
}

// ---- Fix skip rule ----------------------------------------------------------------------------------------------------

export interface SkipDecision {
  skip: boolean
  /** User-facing: why Fix is skipped, or why it runs. */
  reason: string
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Fix is skipped only when every enabled reviewer is done with `none` (or `ok` with 0 findings) AND the
 * latest verify has no [must] failures. A failed, empty or unparsed reviewer never counts as zero.
 *
 * `sources`: one key per ENABLED reviewer (`review`, `critic`); `null` = enabled but no parse result (still
 * running, crashed before output…). A `verify` key is ignored; pass verify failures as the second argument.
 */
export function skipRule(
  sources: Partial<Record<FindingSource, SourceParse | null>>,
  verifyHasMustFailures: boolean,
): SkipDecision {
  const enabled = REVIEWER_SOURCES.filter((s) => Object.hasOwn(sources, s))
  const blockers: string[] = []
  for (const s of enabled) {
    const p = sources[s] ?? null
    const label = SOURCE_LABEL[s]
    if (p === null) blockers.push(`${label} has no result`)
    else if (p.status === 'none' || (p.status === 'ok' && p.count === 0)) continue
    else blockers.push(blockerText(label, p))
  }
  if (verifyHasMustFailures) blockers.push('automated checks are failing')
  if (blockers.length > 0) return { skip: false, reason: capitalize(blockers.join('; ')) }
  if (enabled.length === 0) return { skip: true, reason: 'Review and Critic are off and no checks failed' }
  const names = enabled.map((s: ReviewerSource) => SOURCE_LABEL[s]).join(' and ')
  return { skip: true, reason: `${names} reported no findings` }
}

function blockerText(label: string, p: SourceParse): string {
  switch (p.status) {
    case 'failed':
      return `${label} failed`
    case 'empty':
      return `${label} returned no output`
    case 'untagged':
      return `${label} reported ${plural(p.count, 'untagged finding')}`
    case 'unstructured':
      return `${label} replied without a findings list`
    case 'ok':
    case 'none':
      return `${label} reported ${plural(p.count, 'finding')}`
  }
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ---- Fix report ---------------------------------------------------------------------------------------------------------

export interface FixReportEntry {
  n: number
  status: FixReportStatus
  reason?: string
}

const FIX_LINE_RE = /^F(\d{1,6})\b[*_`]*[ \t]*[:\-–—]?[ \t]*[*_`]*(fixed|skipped|disputed)\b[*_`]*(.*)$/i

/**
 * Fix's closing lines `F<n> fixed` | `F<n> skipped: <reason>` | `F<n> disputed: <reason>` (best-effort, display
 * only). Tolerates bullets, emphasis, backticks and `F1: fixed`. The last line for an F-number wins.
 */
export function parseFixReport(text: string): FixReportEntry[] {
  const byN = new Map<number, FixReportEntry>()
  for (const rawLine of normalizeText(typeof text === 'string' ? text : '').split('\n')) {
    const m = fixLineMatch(rawLine)
    if (m === null) continue
    const n = Number(m[1])
    const status = (m[2] ?? '').toLowerCase() as FixReportStatus
    let reason = (m[3] ?? '').replace(SEPARATOR_RE, '').trim()
    if (/^[.!;,]*$/.test(reason)) reason = ''
    byN.delete(n)
    byN.set(n, reason === '' ? { n, status } : { n, status, reason })
  }
  return [...byN.values()].sort((a, b) => a.n - b.n)
}

/** One line read as a Fix report line (bullets and emphasis around it tolerated), or null. */
function fixLineMatch(rawLine: string): RegExpExecArray | null {
  let line = stripLineLead(rawLine).trimEnd()
  const opener = EMPHASIS_RE.exec(line)?.[0] ?? ''
  if (opener !== '') {
    line = line.slice(opener.length)
    const closer = [...opener].reverse().join('')
    if (line.endsWith(closer)) line = line.slice(0, -closer.length)
  }
  return FIX_LINE_RE.exec(line.trim())
}

/** Fix's heading over what it wrote for the person (`## Summary`, any level, emphasis or a colon tolerated). */
const SUMMARY_HEADING_RE = /^(?:#{1,6}[ \t]*)?[*_]*summary[*_]*[ \t]*:?[*_]*[ \t]*$/i

/**
 * What Fix wrote for the person who asked: the text under its `## Summary` heading, without any report lines.
 * Undefined when it wrote no such heading or nothing under it.
 */
export function fixSummary(text: string): string | undefined {
  const lines = normalizeText(typeof text === 'string' ? text : '').split('\n')
  const at = lines.findIndex((l) => SUMMARY_HEADING_RE.test(l.trim()))
  if (at < 0) return undefined
  const kept = lines
    .slice(at + 1)
    .filter((l) => fixLineMatch(l) === null)
    .join('\n')
    .trim()
  return kept === '' ? undefined : kept
}

/** Fix's text with its report lines taken out ('' when that is all it said). */
export function withoutFixReport(text: string): string {
  return normalizeText(typeof text === 'string' ? text : '')
    .split('\n')
    .filter((l) => fixLineMatch(l) === null)
    .join('\n')
    .trim()
}

/** Fix report keyed by finding id (FindingsFile.fixReport). Unknown F-numbers are dropped. */
export function fixReportById(
  findings: readonly Finding[],
  entries: readonly FixReportEntry[],
): Record<string, FixReportStatus> {
  const byN = new Map(findings.map((f) => [f.n, f.id]))
  const out: Record<string, FixReportStatus> = {}
  for (const e of entries) {
    const id = byN.get(e.n)
    if (id !== undefined) out[id] = e.status
  }
  return out
}
