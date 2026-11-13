// Verify output excerpt: the last 60 lines plus error-pattern lines with 2 lines of
// context, ANSI stripped, at most 4 KB. Collected while the output streams, so memory stays bounded for any size.
//
// Layout: the error blocks that lie before the tail, in output order, `…` between pieces that are not adjacent,
// then the tail. Over 4 KB, the error blocks keep up to half the budget (the first ones: usually the cause) and the
// tail keeps the rest (its last lines: usually the summary); either side's unused budget goes to the other.

export const EXCERPT_TAIL_LINES = 60
export const EXCERPT_CONTEXT_LINES = 2
export const EXCERPT_MAX_BYTES = 4096
/** A single line is cut to this many characters (a minified bundle line must not take the whole excerpt). */
export const EXCERPT_LINE_CHARS = 400
/** Error-context lines kept from before the tail (only the first ones can fit in 4 KB anyway). */
const MAX_ERROR_LINES = 200

export const ERROR_LINE_RE = /error|fail|✗|×|✖|panic|traceback|assert|exception|fatal/i

/* eslint-disable no-control-regex */
const ANSI_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g
/* eslint-enable no-control-regex */

/** A terminal line as text: ANSI sequences and control characters removed; after a CR, only what it showed last. */
export function cleanLine(line: string): string {
  let s = line.replace(ANSI_RE, '')
  const cr = s.lastIndexOf('\r')
  if (cr !== -1) {
    const after = s.slice(cr + 1)
    s = after === '' ? s.slice(0, cr) : after
  }
  return s.replace(CONTROL_RE, '')
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

function cutLine(line: string): string {
  return line.length <= EXCERPT_LINE_CHARS ? line : `${line.slice(0, EXCERPT_LINE_CHARS)}…`
}

interface Numbered {
  n: number
  text: string
}

export class ExcerptCollector {
  #count = 0
  /** The last EXCERPT_TAIL_LINES lines (also the context before an error line). */
  #tail: Numbered[] = []
  /** Error lines with context, in output order, by line number. */
  #errors: Numbered[] = []
  #lastErrorLine = -1
  #contextUntil = -1

  push(raw: string): void {
    const n = this.#count++
    const text = cutLine(cleanLine(raw))
    const line = { n, text }
    if (this.#errors.length < MAX_ERROR_LINES) {
      if (ERROR_LINE_RE.test(text)) {
        for (const prev of this.#tail.slice(-EXCERPT_CONTEXT_LINES)) {
          if (prev.n > this.#lastErrorLine) this.#addError(prev)
        }
        this.#addError(line)
        this.#contextUntil = n + EXCERPT_CONTEXT_LINES
      } else if (n <= this.#contextUntil) this.#addError(line)
    }
    this.#tail.push(line)
    if (this.#tail.length > EXCERPT_TAIL_LINES) this.#tail.shift()
  }

  #addError(line: Numbered): void {
    if (line.n <= this.#lastErrorLine) return
    this.#errors.push(line)
    this.#lastErrorLine = line.n
  }

  /** Lines seen. */
  get lines(): number {
    return this.#count
  }

  /** The last lines (cleaned), oldest first. */
  tail(): string[] {
    return this.#tail.map((l) => l.text)
  }

  excerpt(maxBytes = EXCERPT_MAX_BYTES): string {
    const tail = this.#tail
    const tailStart = tail[0]?.n ?? this.#count
    const before = this.#errors.filter((l) => l.n < tailStart)
    return assemble(before, tail, maxBytes)
  }
}

/** Pieces joined with `…` between non-adjacent lines. */
function render(lines: readonly Numbered[]): string[] {
  const out: string[] = []
  let prev = -2
  for (const l of lines) {
    if (out.length > 0 && l.n !== prev + 1) out.push('…')
    out.push(l.text)
    prev = l.n
  }
  return out
}

function size(lines: readonly string[]): number {
  return lines.reduce((sum, l) => sum + bytes(l) + 1, 0)
}

/** Keep the first lines of `lines` within `budget` bytes (with a closing `…` when cut). */
function keepHead(lines: readonly string[], budget: number): string[] {
  const out: string[] = []
  let used = 0
  for (const l of lines) {
    if (used + bytes(l) + 1 > budget - 4) {
      if (out.length > 0 || lines.length > 0) out.push('…')
      return out
    }
    out.push(l)
    used += bytes(l) + 1
  }
  return out
}

/** Keep the last lines of `lines` within `budget` bytes (with an opening `…` when cut). */
function keepTail(lines: readonly string[], budget: number): string[] {
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? ''
    if (used + bytes(l) + 1 > budget - 4) {
      out.unshift('…')
      return out
    }
    out.unshift(l)
    used += bytes(l) + 1
  }
  return out
}

function assemble(errors: readonly Numbered[], tail: readonly Numbered[], maxBytes: number): string {
  const errLines = render(errors)
  const gap = errors.length > 0 && tail.length > 0 && (tail[0]?.n ?? 0) !== (errors.at(-1)?.n ?? -2) + 1
  const tailLines = render(tail)
  const sep = gap ? ['…'] : []
  if (size(errLines) + size(sep) + size(tailLines) <= maxBytes) {
    return [...errLines, ...sep, ...tailLines].join('\n')
  }
  const half = Math.floor(maxBytes / 2)
  const errBudget = Math.min(size(errLines), Math.max(half, maxBytes - size(tailLines) - size(sep)))
  const keptErr = errLines.length > 0 ? keepHead(errLines, errBudget) : []
  const tailBudget = maxBytes - size(keptErr) - size(sep)
  const keptTail = keepTail(tailLines, tailBudget)
  const joined = [...keptErr, ...(keptErr.length > 0 ? sep : []), ...keptTail]
  const text = joined.filter((l, i) => !(l === '…' && joined[i - 1] === '…')).join('\n')
  return bytes(text) <= maxBytes ? text : truncateEnd(text, maxBytes)
}

/** Last resort: keep the end of `text` within `max` bytes, cut at a character boundary. */
function truncateEnd(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8')
  let start = buf.length - max
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}

/** The excerpt of a complete output (tests, short outputs). */
export function buildExcerpt(lines: Iterable<string>, maxBytes = EXCERPT_MAX_BYTES): string {
  const c = new ExcerptCollector()
  for (const l of lines) c.push(l)
  return c.excerpt(maxBytes)
}
