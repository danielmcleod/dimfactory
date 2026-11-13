// Prompt templates. This is the ONLY parser, validator and renderer.
//
// Grammar:
//   {{name}}               placeholder; whitespace inside the braces is allowed
//   {{#name}}…{{/name}}    section, rendered only when `name` is non-empty (nesting allowed)
//   \{{                    a literal `{{` (a backslash immediately before `{{` always escapes it)
// A section tag alone on its line (Mustache "standalone") removes that whole line, so an empty section leaves
// no blank lines behind. Templates are normalized first: BOM stripped, CRLF → LF. Values are normalized the
// same way and lose trailing line breaks.

export const TEMPLATE_KINDS = [
  'plan',
  'implement',
  'review',
  'critic',
  'fix',
  'tests',
  'security',
  'recheck',
  'clarify',
  'research',
  'deploy',
  'acceptance',
  'explain',
  'heal',
  'catalog',
  'suggest',
] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

export interface TemplateSpec {
  allowed: readonly string[]
  required: readonly string[]
  /** implement / tests: `plan` is required only when the Plan pass is enabled. */
  requiredWhenPlan?: readonly string[]
  /** recheck / heal / catalog-refresh / suggest: Dim Factory-internal, never user-overridable. */
  internal: boolean
}

/**
 * `{{brief}}`: the run's Brief (the choices the user made or accepted, and what is already in the repository); empty
 * without one. `{{memory}}`: the project memory file as the run read it (capped); empty without one. `{{tests}}` (Test-first): the tests the Tests step wrote, how they failed before Implement, and, for the
 * readers and Fix, Dim Factory's check that Implement left them whole; empty otherwise.
 */
const READER_PLACEHOLDERS = ['task', 'plan', 'diff', 'verify', 'brief', 'tests', 'memory'] as const
const HEAL_PLACEHOLDERS = ['trigger', 'probe', 'passConfig', 'env', 'tail', 'shell', 'os'] as const
const CATALOG_PLACEHOLDERS = ['vendors', 'officialSources', 'today', 'currentCatalog', 'jsonSchema'] as const
/** Suggest choices: the task, the category's groups and options, the facts and choices so far, the answer's shape. */
const SUGGEST_PLACEHOLDERS = ['task', 'category', 'groups', 'facts', 'choices', 'jsonSchema'] as const

/** The allowed / required placeholders per template. */
export const TEMPLATE_SPECS: Readonly<Record<TemplateKind, TemplateSpec>> = {
  /** `{{research}}`: the research the user kept at the research card (Research before Plan); empty otherwise. */
  plan: { allowed: ['task', 'brief', 'research', 'memory'], required: ['task'], internal: false },
  /**
   * `{{run}}`: Run & Preview's request for a RUN.md when the folder shows no way to run it; empty otherwise.
   * `{{acceptance}}`: the decided plan's acceptance criteria (with the tests mapped to each); empty without any.
   * `{{state}}` (Implement and Fix): after a fresh restart because the session compacted often, where the work stands
   * (the plan, the criteria, the files changed so far); empty otherwise.
   */
  implement: {
    allowed: ['task', 'plan', 'brief', 'tests', 'run', 'acceptance', 'memory', 'state'],
    required: ['task'],
    requiredWhenPlan: ['plan'],
    internal: false,
  },
  review: { allowed: READER_PLACEHOLDERS, required: ['diff'], internal: false },
  /** `{{focus}}`: the Brief's pack's security focus (Games: no eval, kid-safe rules...); empty without one. */
  critic: { allowed: [...READER_PLACEHOLDERS, 'focus'], required: ['diff'], internal: false },
  /**
   * The security advisor's reviewer: the readers' placeholders plus `{{scan}}`, what Dim Factory's own scanners found
   * (secrets in the diff, advisories for dependencies the run added or changed).
   */
  security: { allowed: [...READER_PLACEHOLDERS, 'scan', 'focus'], required: ['diff'], internal: false },
  /**
   * The re-check after Fix (Dim Factory-internal): `{{findings}}` lists the [must] findings Fix was given (the
   * security advisor's, or with Fix until green the round's), `{{diff}}` is what Fix changed, `{{verify}}` the project's
   * checks after it when they ran.
   */
  recheck: {
    allowed: ['task', 'findings', 'diff', 'verify', 'memory'],
    required: ['findings', 'diff'],
    internal: true,
  },
  /**
   * Clarify before Plan (overridable in Settings › Prompts): `{{questions}}` is the most questions it may ask; it answers with the
   * JSON its parser reads.
   */
  clarify: {
    allowed: ['task', 'brief', 'questions', 'memory'],
    required: ['task', 'questions'],
    internal: false,
  },
  /**
   * Research before Plan (overridable in Settings › Prompts): `{{lenses}}` are the questions it researches, `{{access}}` says whether
   * it may search the web; it answers with the cited JSON its parser reads.
   */
  research: {
    allowed: ['task', 'brief', 'lenses', 'access', 'memory'],
    required: ['task', 'lenses', 'access'],
    internal: false,
  },
  /**
   * The Deploy step (overridable in Settings › Prompts): `{{target}}` is where the deliverable goes, `{{deliverable}}` its class,
   * `{{files}}` the config files to write (and what each is for), `{{env}}` the environment variables the code reads.
   */
  deploy: {
    allowed: ['task', 'brief', 'target', 'deliverable', 'files', 'env', 'memory'],
    required: ['target', 'files'],
    internal: false,
  },
  /**
   * The acceptance review (overridable in Settings › Prompts): `{{acceptance}}` lists the plan's criteria with the tests mapped to
   * each, `{{diff}}` is the run's change, `{{verify}}` the latest checks; it answers with the JSON its parser reads.
   */
  acceptance: {
    allowed: ['task', 'plan', 'brief', 'tests', 'acceptance', 'diff', 'verify', 'memory'],
    required: ['acceptance', 'diff'],
    internal: false,
  },
  /**
   * Explain it to me (overridable in Settings › Prompts): `{{files}}` the files the run changed, `{{run}}` how to run the result,
   * `{{verify}}` the last checks, `{{acceptance}}` the checklist, `{{deploy}}` the Deploy step's target, `{{play}}` set for a game
   * (its summary says how to play).
   */
  explain: {
    allowed: ['task', 'brief', 'plan', 'files', 'run', 'verify', 'acceptance', 'deploy', 'memory', 'play'],
    required: ['task'],
    internal: false,
  },
  fix: {
    allowed: [
      'task',
      'plan',
      'diff',
      'findings',
      'verify',
      'brief',
      'tests',
      'security',
      'run',
      'acceptance',
      'memory',
      'state',
      'summary',
    ],
    required: ['findings'],
    internal: false,
  },
  /**
   * Test-first's Tests step: `{{checks}}` lists the project's verify commands (they run the new tests), and
   * `{{acceptance}}` the plan's acceptance criteria it maps its tests to.
   */
  tests: {
    allowed: ['task', 'plan', 'brief', 'checks', 'acceptance', 'memory'],
    required: ['task'],
    requiredWhenPlan: ['plan'],
    internal: false,
  },
  heal: { allowed: HEAL_PLACEHOLDERS, required: HEAL_PLACEHOLDERS, internal: true },
  catalog: { allowed: CATALOG_PLACEHOLDERS, required: CATALOG_PLACEHOLDERS, internal: true },
  suggest: { allowed: SUGGEST_PLACEHOLDERS, required: SUGGEST_PLACEHOLDERS, internal: true },
}

export function isTemplateKind(v: unknown): v is TemplateKind {
  return typeof v === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(v)
}

const KB = 1024
/** Per-value caps in UTF-8 bytes. Longer values are truncated with a note and a warning. */
export const VALUE_CAPS_BYTES: Readonly<Record<string, number>> = {
  task: 100 * KB,
  plan: 40 * KB,
  findings: 60 * KB,
  verify: 16 * KB,
  brief: 16 * KB,
  /** Project memory: already capped at its own maxBytes (64 KB at most) when the run read it. */
  memory: 64 * KB,
  tests: 24 * KB,
  checks: 4 * KB,
  scan: 24 * KB,
  security: 2 * KB,
  focus: 4 * KB,
  run: 2 * KB,
  research: 24 * KB,
  lenses: 8 * KB,
  target: 1 * KB,
  deliverable: 1 * KB,
  files: 8 * KB,
  env: 4 * KB,
  acceptance: 16 * KB,
  deploy: 2 * KB,
  /** Fix's `{{summary}}`: what the person was told so far. */
  summary: 8 * KB,
}
/** The whole rendered prompt; exceeding it is an error, never a truncation. */
export const PROMPT_HARD_CAP_BYTES = 400 * KB

/** Fix resumes a session: these render empty (the session already has them). */
export const RESUMED_FIX_BLANKS = ['task', 'plan', 'diff', 'summary'] as const

// ---- issues ---------------------------------------------------------------------------------------------------

export const TEMPLATE_ISSUE_CODES = [
  'malformed-tag',
  'unterminated-tag',
  'unknown-placeholder',
  'unclosed-section',
  'mismatched-section',
  'unexpected-close',
  'missing-required',
  'truncated',
] as const
export type TemplateIssueCode = (typeof TEMPLATE_ISSUE_CODES)[number]

export interface TemplateIssue {
  code: TemplateIssueCode
  severity: 'error' | 'warning'
  message: string
  /** 1-based; absent for issues about the template as a whole (missing-required, truncated). */
  line?: number
  col?: number
  /** The placeholder or section name involved. */
  name?: string
}

/** `file:line:col: message` (or `file: message` without a position). */
export function formatIssue(issue: TemplateIssue, file?: string): string {
  const pos = issue.line !== undefined ? `${issue.line}:${issue.col ?? 1}` : ''
  const where = [file, pos].filter((s) => s !== undefined && s !== '').join(':')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

export class TemplateError extends Error {
  readonly code: 'invalid' | 'too-large'
  readonly issues: TemplateIssue[]
  constructor(code: 'invalid' | 'too-large', message: string, issues: TemplateIssue[] = []) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
    this.issues = issues
  }
}

// ---- parse ----------------------------------------------------------------------------------------------------

export type TemplateNode =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string; line: number; col: number }
  | { type: 'section'; name: string; line: number; col: number; children: TemplateNode[] }

export interface ParsedTemplate {
  /** Normalized source (BOM stripped, LF). */
  source: string
  nodes: TemplateNode[]
  /** Syntax errors only; placeholder rules are checked by {@link validateTemplate}. */
  issues: TemplateIssue[]
}

interface Tag {
  kind: 'var' | 'open' | 'close'
  name: string
  /** Offsets of the tag itself. */
  start: number
  end: number
  /** Range removed from the output (the whole line for a standalone section tag). */
  cutStart: number
  cutEnd: number
  line: number
  col: number
}

const TAG_BODY = /^\s*([#/]?)\s*([A-Za-z][A-Za-z0-9_]*)\s*$/

/** Strip a BOM and turn CRLF / lone CR into LF. */
export function normalizeText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n')
}

function lineIndex(src: string): (offset: number) => { line: number; col: number } {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: offset - (starts[lo] ?? 0) + 1 }
  }
}

const unescape = (s: string): string => s.replace(/\\\{\{/g, '{{')

function scanTags(src: string, issues: TemplateIssue[]): Tag[] {
  const pos = lineIndex(src)
  const tags: Tag[] = []
  let i = 0
  while (i < src.length) {
    const at = src.indexOf('{{', i)
    if (at === -1) break
    if (at > 0 && src[at - 1] === '\\') {
      i = at + 2
      continue
    }
    const { line, col } = pos(at)
    const lineEnd = src.indexOf('\n', at) === -1 ? src.length : src.indexOf('\n', at)
    const close = src.indexOf('}}', at + 2)
    if (close === -1 || close > lineEnd) {
      issues.push({
        code: 'unterminated-tag',
        severity: 'error',
        message: 'Unterminated {{ (write \\{{ for a literal "{{")',
        line,
        col,
      })
      i = at + 2
      continue
    }
    const body = src.slice(at + 2, close)
    const m = TAG_BODY.exec(body)
    if (!m) {
      issues.push({
        code: 'malformed-tag',
        severity: 'error',
        message: `Malformed tag {{${body}}} (expected {{name}}, {{#name}} or {{/name}}; write \\{{ for a literal "{{")`,
        line,
        col,
      })
      i = close + 2
      continue
    }
    const kind = m[1] === '#' ? 'open' : m[1] === '/' ? 'close' : 'var'
    const end = close + 2
    let cutStart = at
    let cutEnd = end
    if (kind !== 'var') {
      const ls = src.lastIndexOf('\n', at - 1) + 1
      if (src.slice(ls, at).trim() === '' && src.slice(end, lineEnd).trim() === '') {
        cutStart = ls
        cutEnd = lineEnd < src.length ? lineEnd + 1 : lineEnd
      }
    }
    tags.push({ kind, name: m[2] ?? '', start: at, end, cutStart, cutEnd, line, col })
    i = end
  }
  return tags
}

/** Tokenize and build the section tree. Never throws; syntax problems come back as issues. */
export function parseTemplate(text: string): ParsedTemplate {
  const source = normalizeText(text)
  const issues: TemplateIssue[] = []
  const tags = scanTags(source, issues)
  const root: TemplateNode[] = []
  const stack: { node: Extract<TemplateNode, { type: 'section' }>; tag: Tag }[] = []
  const current = (): TemplateNode[] => stack[stack.length - 1]?.node.children ?? root
  let cursor = 0
  const pushText = (to: number): void => {
    if (to > cursor) {
      const value = unescape(source.slice(cursor, to))
      if (value !== '') current().push({ type: 'text', value })
    }
  }
  for (const tag of tags) {
    // A standalone cut may reach back over text already emitted only when that text is whitespace on the
    // tag's own line, which pushText never emitted because cursor <= cutStart in that case.
    pushText(Math.max(cursor, tag.cutStart))
    cursor = Math.max(cursor, tag.cutEnd)
    if (tag.kind === 'var') {
      current().push({ type: 'var', name: tag.name, line: tag.line, col: tag.col })
    } else if (tag.kind === 'open') {
      const node: Extract<TemplateNode, { type: 'section' }> = {
        type: 'section',
        name: tag.name,
        line: tag.line,
        col: tag.col,
        children: [],
      }
      current().push(node)
      stack.push({ node, tag })
    } else {
      const top = stack[stack.length - 1]
      if (top === undefined) {
        issues.push({
          code: 'unexpected-close',
          severity: 'error',
          message: `{{/${tag.name}}} closes a section that was never opened`,
          line: tag.line,
          col: tag.col,
          name: tag.name,
        })
      } else if (top.node.name !== tag.name) {
        issues.push({
          code: 'mismatched-section',
          severity: 'error',
          message: `{{/${tag.name}}} does not match {{#${top.node.name}}} opened at line ${top.tag.line}`,
          line: tag.line,
          col: tag.col,
          name: tag.name,
        })
      } else {
        stack.pop()
      }
    }
  }
  pushText(source.length)
  for (const open of stack) {
    issues.push({
      code: 'unclosed-section',
      severity: 'error',
      message: `{{#${open.node.name}}} is never closed (add {{/${open.node.name}}})`,
      line: open.tag.line,
      col: open.tag.col,
      name: open.node.name,
    })
  }
  return { source, nodes: root, issues }
}

/** Every placeholder and section name, in first-use order. */
export function placeholdersOf(nodes: readonly TemplateNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly TemplateNode[]): void => {
    for (const n of list) {
      if (n.type === 'text') continue
      if (!out.includes(n.name)) out.push(n.name)
      if (n.type === 'section') walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// ---- validate -------------------------------------------------------------------------------------------------

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and swaps of two adjacent characters
 * each cost 1, so the common typo `modle` is 1 away from `model`.
 */
function editDistance(a: string, b: string): number {
  const rows: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = []
    for (let j = 0; j <= b.length; j++) {
      if (i === 0 || j === 0) {
        row.push(i + j)
        continue
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min((rows[i - 1]?.[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (rows[i - 1]?.[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (rows[i - 2]?.[j - 2] ?? 0) + 1)
      }
      row.push(d)
    }
    rows.push(row)
  }
  return rows[a.length]?.[b.length] ?? 0
}

/**
 * "did you mean" candidate within edit distance 2 (case-insensitive). Ties go to the candidate whose length is
 * closest to `name` (a swap keeps the length: `modle` → `model`, not `mode`), then to the earlier candidate.
 */
export function suggestName(name: string, candidates: readonly string[]): string | undefined {
  let best: { c: string; d: number; len: number } | undefined
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase())
    const len = Math.abs(c.length - name.length)
    if (d <= 2 && (best === undefined || d < best.d || (d === best.d && len < best.len))) best = { c, d, len }
  }
  return best?.c
}

export interface ValidateOptions {
  /** implement only: Plan is enabled, so `{{plan}}` is required. Default false. */
  planEnabled?: boolean
}

export interface TemplateValidation {
  /** No error-severity issues. */
  ok: boolean
  /** Errors (syntax, unknown placeholders) then missing-required warnings. */
  issues: TemplateIssue[]
  placeholders: string[]
  missingRequired: string[]
}

export function requiredFor(kind: TemplateKind, o: ValidateOptions = {}): string[] {
  const spec = TEMPLATE_SPECS[kind]
  return [...spec.required, ...(o.planEnabled === true ? (spec.requiredWhenPlan ?? []) : [])]
}

function unknownIssues(nodes: readonly TemplateNode[], kind: TemplateKind): TemplateIssue[] {
  const allowed = TEMPLATE_SPECS[kind].allowed
  const out: TemplateIssue[] = []
  const walk = (list: readonly TemplateNode[]): void => {
    for (const n of list) {
      if (n.type === 'text') continue
      if (!allowed.includes(n.name)) {
        const hint = suggestName(n.name, allowed)
        const tag = n.type === 'section' ? `{{#${n.name}}}` : `{{${n.name}}}`
        out.push({
          code: 'unknown-placeholder',
          severity: 'error',
          message:
            `Unknown placeholder ${tag} in the ${kind} template` +
            (hint !== undefined ? ` (did you mean {{${hint}}}?)` : '') +
            `. Allowed: ${allowed.join(', ')}`,
          line: n.line,
          col: n.col,
          name: n.name,
        })
      }
      if (n.type === 'section') walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** Syntax + allowed placeholders (errors, line-numbered) + required placeholders (warnings). */
export function validateTemplate(
  text: string,
  kind: TemplateKind,
  o: ValidateOptions = {},
): TemplateValidation {
  const parsed = parseTemplate(text)
  const placeholders = placeholdersOf(parsed.nodes)
  const errors = [...parsed.issues, ...unknownIssues(parsed.nodes, kind)].sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0),
  )
  const missingRequired = requiredFor(kind, o).filter((n) => !placeholders.includes(n))
  const warnings: TemplateIssue[] = missingRequired.map((name) => ({
    code: 'missing-required',
    severity: 'warning',
    message: `The ${kind} template does not use {{${name}}}; Dim Factory appends the default ${name} section`,
    name,
  }))
  return { ok: errors.length === 0, issues: [...errors, ...warnings], placeholders, missingRequired }
}

// ---- default sections for missing required placeholders -----------------------------------------------------

const STANDALONE_SECTION_LINE = /^\s*\{\{\s*[#/]\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}\s*$/

/**
 * The section of `defaultText` that introduces `name`: its `{{#name}}…{{/name}}` block when there is one,
 * otherwise the paragraph (run of non-blank lines, stopping at standalone section tags) holding `{{name}}`.
 */
export function defaultSectionFor(defaultText: string, name: string): string | undefined {
  const lines = normalizeText(defaultText).split('\n')
  const tag = (re: string): RegExp => new RegExp(`\\{\\{\\s*${re}\\s*${name}\\s*\\}\\}`)
  const open = lines.findIndex((l) => tag('#').test(l) && !/\\\{\{/.test(l))
  if (open !== -1) {
    const close = lines.findIndex((l, i) => i > open && tag('/').test(l))
    if (close !== -1) return lines.slice(open, close + 1).join('\n')
  }
  const at = lines.findIndex((l) => tag('').test(l))
  if (at === -1) return undefined
  const inPara = (l: string | undefined): boolean =>
    l !== undefined && l.trim() !== '' && !STANDALONE_SECTION_LINE.test(l)
  let from = at
  let to = at
  while (inPara(lines[from - 1])) from--
  while (inPara(lines[to + 1])) to++
  return lines.slice(from, to + 1).join('\n')
}

export interface CompletedTemplate {
  text: string
  /** Placeholder names whose default section was appended. */
  appended: string[]
}

/** Append the default section for every missing required placeholder. */
export function completeTemplate(
  text: string,
  kind: TemplateKind,
  defaultText: string | undefined,
  o: ValidateOptions = {},
): CompletedTemplate {
  const source = normalizeText(text)
  const present = placeholdersOf(parseTemplate(source).nodes)
  const missing = requiredFor(kind, o).filter((n) => !present.includes(n))
  if (missing.length === 0 || defaultText === undefined) return { text: source, appended: [] }
  let out = source.replace(/\n+$/, '')
  const appended: string[] = []
  for (const name of missing) {
    const section = defaultSectionFor(defaultText, name)
    if (section === undefined) continue
    // A section block that opens with its own blank line (`{{#plan}}\n\n…`) supplies the paragraph break itself.
    const [first, second] = section.split('\n', 2)
    const selfSpaced = STANDALONE_SECTION_LINE.test(first ?? '') && second?.trim() === ''
    out += (out === '' ? '' : selfSpaced ? '\n' : '\n\n') + section
    appended.push(name)
  }
  return { text: out + '\n', appended }
}

// ---- render ---------------------------------------------------------------------------------------------------

export type TemplateValues = Readonly<Partial<Record<string, string | null>>>

export interface RenderOptions {
  /** Which allowed/required table applies. */
  template: TemplateKind
  /** The builtin text for `template`; supplies sections for missing required placeholders. */
  defaultText?: string
  /** implement: Plan is enabled (so `{{plan}}` is required). Default: `values.plan` is non-empty. */
  planEnabled?: boolean
  /** fix resuming a session: task, plan and diff render empty. */
  resumed?: boolean
}

export interface RenderResult {
  text: string
  /** missing-required (section appended) and truncated-value warnings. */
  warnings: TemplateIssue[]
  /** UTF-8 size of `text`. */
  bytes: number
}

const isEmpty = (v: string | null | undefined): boolean => v === undefined || v === null || v.trim() === ''

/** Cut `s` to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  let end = max
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

function capValue(name: string, value: string, warnings: TemplateIssue[]): string {
  const cap = VALUE_CAPS_BYTES[name]
  if (cap === undefined) return value
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= cap) return value
  const omitted = Math.ceil((bytes - cap) / KB)
  warnings.push({
    code: 'truncated',
    severity: 'warning',
    message: `{{${name}}} is ${Math.ceil(bytes / KB)} KB; Dim Factory kept the first ${cap / KB} KB`,
    name,
  })
  return `${truncateUtf8(value, cap)}\n[… truncated by Dim Factory: ${omitted} KB omitted]`
}

function renderNodes(nodes: readonly TemplateNode[], values: ReadonlyMap<string, string>): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.value
    else if (n.type === 'var') out += values.get(n.name) ?? ''
    else if ((values.get(n.name) ?? '') !== '') out += renderNodes(n.children, values)
  }
  return out
}

/**
 * Render a template. Throws {@link TemplateError} `invalid` for syntax errors or unknown placeholders (preflight
 * `run.templates` reports these before a run starts) and `too-large` when the result exceeds 400 KB.
 */
export function render(templateText: string, values: TemplateValues, o: RenderOptions): RenderResult {
  const kind = o.template
  const planEnabled = o.planEnabled ?? !isEmpty(values['plan'])
  const check = validateTemplate(templateText, kind, { planEnabled })
  const errors = check.issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    throw new TemplateError(
      'invalid',
      `The ${kind} template is invalid: ${errors.map((e) => formatIssue(e)).join('; ')}`,
      errors,
    )
  }
  const completed = completeTemplate(templateText, kind, o.defaultText, { planEnabled })
  const warnings: TemplateIssue[] = check.issues.filter(
    (i) => i.severity === 'warning' && i.name !== undefined && completed.appended.includes(i.name),
  )
  for (const name of check.missingRequired) {
    if (!completed.appended.includes(name)) {
      warnings.push({
        code: 'missing-required',
        severity: 'warning',
        message: `The ${kind} template does not use {{${name}}}, so the ${name} is not in the prompt`,
        name,
      })
    }
  }

  const blanks: readonly string[] = kind === 'fix' && o.resumed === true ? RESUMED_FIX_BLANKS : []
  const map = new Map<string, string>()
  for (const name of TEMPLATE_SPECS[kind].allowed) {
    const raw = values[name]
    if (blanks.includes(name) || isEmpty(raw)) continue
    const v = normalizeText(raw ?? '').replace(/\n+$/, '')
    map.set(name, capValue(name, v, warnings))
  }

  const text = renderNodes(parseTemplate(completed.text).nodes, map)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > PROMPT_HARD_CAP_BYTES) {
    throw new TemplateError(
      'too-large',
      `The ${kind} prompt is ${Math.ceil(bytes / KB)} KB; the limit is ${PROMPT_HARD_CAP_BYTES / KB} KB`,
    )
  }
  return { text, warnings, bytes }
}

/**
 * Diff byte budget for a reader prompt: `min(150 KB, 0.25 × window × 3.5)`, shrunk so the whole
 * prompt stays under 60% of the context window (`otherBytes` = the prompt rendered without the diff).
 */
export function diffBudgetBytes(contextWindowTokens: number, otherBytes: number): number {
  const bytesPerToken = 3.5
  const base = Math.min(150 * KB, Math.floor(0.25 * contextWindowTokens * bytesPerToken))
  const room = Math.floor(0.6 * contextWindowTokens * bytesPerToken) - otherBytes
  return Math.max(0, Math.min(base, room))
}
