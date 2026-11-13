// The security re-check's answer: one line per finding it was given, `F<n> resolved` or `F<n> open: <reason>`.
// Read leniently (bullets, emphasis, backticks, a colon or dash after the number, "fixed" for resolved, "still open"
// or "unresolved" for open); the last line for an F-number wins. A finding the answer never names stays open: the
// re-check exists to confirm a fix, and silence confirms nothing. F-numbers it was not given are ignored.
import { stripLineLead } from '../findings/parse.ts'
import { normalizeText } from '../prompts/template.ts'

export interface RecheckVerdict {
  /** F-numbers confirmed resolved, ascending. */
  resolved: number[]
  /** F-numbers still open (named open, or not named at all), ascending, with the reason when one was given. */
  open: { n: number; reason?: string }[]
  /** How many of the checked F-numbers the answer named (0: it answered nothing usable). */
  named: number
}

const LINE_RE =
  /^F(\d{1,6})\b[*_`]*\s*[:\-–—]?\s*[*_`]*(resolved|fixed|open|still open|unresolved|not resolved)\b[*_`]*\s*[:\-–—]?\s*(.*)$/i

/** Parse the re-check's answer against the F-numbers it was asked about. Never throws. */
export function parseRecheck(text: string, checks: readonly number[]): RecheckVerdict {
  const asked = new Set(checks)
  const said = new Map<number, { ok: boolean; reason: string }>()
  for (const raw of normalizeText(typeof text === 'string' ? text : '').split('\n')) {
    const line = stripLineLead(raw)
      .trim()
      .replace(/^[*_`]+/, '')
    const m = LINE_RE.exec(line)
    if (m === null) continue
    const n = Number(m[1])
    if (!asked.has(n)) continue
    const word = (m[2] ?? '').toLowerCase()
    const ok = word === 'resolved' || word === 'fixed'
    const reason = (m[3] ?? '').replace(/[*_`]+$/, '').trim()
    said.set(n, { ok, reason })
  }
  const resolved: number[] = []
  const open: { n: number; reason?: string }[] = []
  for (const n of [...asked].sort((a, b) => a - b)) {
    const v = said.get(n)
    if (v?.ok === true) resolved.push(n)
    else if (v !== undefined && v.reason !== '') open.push({ n, reason: v.reason })
    else open.push({ n })
  }
  return { resolved, open, named: said.size }
}
