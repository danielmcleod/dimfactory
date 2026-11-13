// Hides the names of the user's MCP servers and skills in what Dim Factory writes down about a pass (its raw log, the
// argv it records, failure text). A name is replaced wherever it stands on its own: in a JSON string, a flag value,
// a comma list or a tool name such as `mcp__<name>__<tool>` (the underscores around it count as boundaries).
export const REDACTED_NAME = '[REDACTED]'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The identity function when there is nothing to hide. */
export function namesRedactor(names: readonly string[]): (text: string) => string {
  const list = [...new Set(names.filter((n) => n !== ''))].sort((a, b) => b.length - a.length)
  if (list.length === 0) return (t) => t
  const re = new RegExp(
    String.raw`(?<![A-Za-z0-9.:-])(?:${list.map(escapeRe).join('|')})(?![A-Za-z0-9.:-])`,
    'g',
  )
  return (t) => t.replace(re, REDACTED_NAME)
}
