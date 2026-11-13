// Tool call fingerprints and output sizes for the context health detectors (repeated calls, oversized outputs).
// A fingerprint is a short hash of the tool's name and its canonical input: two identical calls share it, and the
// input itself (a command, a file body) never leaves the adapter.
import { createHash } from 'node:crypto'
import { tokensFromBytes } from '../../shared/context.ts'

/** JSON with object keys sorted at every level, so the same input always reads the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** 12 hex characters of sha256(name + canonical input). */
export function toolFingerprint(name: string, input: unknown): string {
  return createHash('sha256')
    .update(`${name}\u0000${canonicalJson(input)}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * The text of a tool's output, wherever the vendor puts it: a string, or content blocks (`{type:'text', text}`), or
 * any JSON value (sized as its JSON). Undefined when there is nothing to size.
 */
function outputText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v
  if (!Array.isArray(v) && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string')
    return (v as { text: string }).text
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (const b of v) {
      if (b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string')
        parts.push((b as { text: string }).text)
      else if (typeof b === 'string') parts.push(b)
      else {
        const inner = (b as { content?: unknown } | null)?.content
        const t = inner !== undefined ? outputText(inner) : undefined
        if (t !== undefined) parts.push(t)
      }
    }
    return parts.join('\n')
  }
  return JSON.stringify(v)
}

/** Estimated tokens of a tool's output (bytes / 3.5); undefined when the output is not shown. */
export function outputTokens(v: unknown): number | undefined {
  const t = outputText(v)
  if (t === undefined || t === '') return undefined
  const n = tokensFromBytes(Buffer.byteLength(t, 'utf8'))
  return n > 0 ? n : undefined
}
