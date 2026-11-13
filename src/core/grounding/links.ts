// The research memo's link check, with no model: every web link a memo's added lines cite is compared with the sources
// Research found for the run. A link Research never found (a made-up page, a wrong path, a source from memory) is a
// `[should]` finding per file, listing the links: someone should open each one, or cite a source Research found.
import type { FindingInput } from '../supervisor/types.ts'
import { groundingId } from './checks.ts'

/** Files whose links are checked: what a reader of the memo reads. */
const MEMO_FILE = /\.(?:md|markdown|html?|txt)$/i
/** The most links one finding lists. */
const LINKS_MAX = 8

/** http(s) links in a line: Markdown targets, angle-bracket links, href values and bare URLs. */
const LINK = /https?:\/\/[^\s<>"'`)\]]+/gi

/** A link as it is compared: no scheme, `www.`, fragment or trailing slash or punctuation; host in lower case. */
export function linkKey(url: string): string {
  const trimmed = url.replace(/[.,;:!?]+$/, '')
  try {
    const u = new URL(trimmed)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${u.search}`
  } catch {
    return trimmed.toLowerCase()
  }
}

/** The web links the added lines cite, per file (each once, in order). */
export function citedLinks(added: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [file, lines] of added) {
    if (!MEMO_FILE.test(file)) continue
    const seen = new Set<string>()
    const list: string[] = []
    for (const line of lines)
      for (const m of line.matchAll(LINK)) {
        const url = m[0].replace(/[.,;:!?]+$/, '')
        const key = linkKey(url)
        if (seen.has(key)) continue
        seen.add(key)
        list.push(url)
      }
    if (list.length > 0) out.set(file, list)
  }
  return out
}

/** One `[should]` finding per file whose added lines cite links Research did not find. */
export function linkFindings(
  added: ReadonlyMap<string, readonly string[]>,
  sources: readonly string[],
): FindingInput[] {
  const known = new Set(sources.map(linkKey))
  const findings: FindingInput[] = []
  for (const [file, links] of citedLinks(added)) {
    const unknown = links.filter((l) => !known.has(linkKey(l)))
    if (unknown.length === 0) continue
    const shown = unknown.slice(0, LINKS_MAX)
    const more = unknown.length - shown.length
    findings.push({
      id: groundingId(`links\n${file}\n${unknown.map(linkKey).sort().join('\n')}`),
      severity: 'should',
      title: `\`${file}\`: ${unknown.length === 1 ? 'a link' : `${unknown.length} links`} that Research did not find`,
      body: [
        'These links are not among the sources Research found for this run, so nothing checked that they exist or say what the text claims. Open each one, or cite a source Research found instead:',
        ...shown.map((l) => `- ${l}`),
        ...(more > 0 ? [`- and ${more} more`] : []),
      ].join('\n'),
      source: 'grounding',
      flags: [],
    })
  }
  return findings
}
