// Quieter reviews: two reviewers that point at the same place. The same issue raised twice is listed once (the
// stronger severity kept, the other reviewer named in its body); two reviewers that disagree about the same place
// (one says something is missing, the other that it is not needed) are listed once as a suggestion that never goes to
// Fix on its own. Each merge leaves a note. Deterministic word rules, no model. Pure.
import type { Finding, FindingSource } from '../../shared/findings.ts'
import { REVIEWER_SOURCES, findingLocation } from '../../shared/findings.ts'

/** Words that say something should be there (added, kept, handled). */
const WANT =
  /\b(?:add|adds|adding|missing|lacks?|needs?|needed|require[sd]?|should (?:use|add|keep|handle|check|validate)|must (?:use|add|keep|handle|check|validate)|keep|handle|validate|check for|guard)\b/i
/** Words that say something should not be there (removed, not needed). */
const DROP =
  /\b(?:remove|removes|removing|delete|drop|unnecessary|redundant|unused|not needed|no need|needless|superfluous|overkill|should not|must not|shouldn't|don't|do not|avoid)\b/i

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'when',
  'than',
  'then',
  'there',
  'their',
  'here',
  'should',
  'must',
  'not',
  'are',
  'was',
  'were',
  'has',
  'have',
  'been',
  'will',
  'can',
  'its',
  'but',
  'any',
])

/** The content words of a title (three letters or more, lower case, no stop words, no location). */
function wordsOf(title: string): Set<string> {
  const bare = title.replace(/`[^`]*`/g, ' ').toLowerCase()
  return new Set((bare.match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w)))
}

/** How alike two titles are: shared content words over all of them (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const x = wordsOf(a)
  const y = wordsOf(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared += 1
  return shared / (x.size + y.size - shared)
}

/** Whether a title asks for something (`want`) or against it (`drop`), or neither. */
export function stanceOf(title: string): 'want' | 'drop' | undefined {
  const t = title.replace(/`[^`]*`/g, ' ')
  const drop = DROP.test(t)
  const want = WANT.test(t)
  if (drop && !want) return 'drop'
  if (want && !drop) return 'want'
  return undefined
}

/** Titles this alike are the same issue. */
export const SAME_ISSUE = 0.5

const SOURCE_LABEL: Readonly<Partial<Record<FindingSource, string>>> = {
  review: 'Review',
  critic: 'Critic',
  security: 'Security',
}

const isReviewer = (f: Finding): boolean => (REVIEWER_SOURCES as readonly string[]).includes(f.source)

const placeOf = (f: Finding): string | undefined => {
  const at = findingLocation(f)
  return at !== undefined ? `${at.file}:${at.line}` : undefined
}

export interface MergeResult {
  list: Finding[]
  notes: string[]
}

/**
 * Merge what two reviewers said about the same place: duplicates once, disagreements once as a suggestion. Only
 * reviewers' findings with a `file:line` take part; everything else is kept as it is. The list keeps its order (the
 * kept finding where the first of the pair was) and is numbered again, must first.
 */
export function mergeReviewerFindings(list: readonly Finding[]): MergeResult {
  const out: Finding[] = list.map((f) => ({ ...f, flags: [...f.flags] }))
  const gone = new Set<number>()
  const notes: string[] = []
  for (let i = 0; i < out.length; i++) {
    const a = out[i] as Finding
    if (gone.has(i) || !isReviewer(a)) continue
    const at = placeOf(a)
    if (at === undefined) continue
    for (let j = i + 1; j < out.length; j++) {
      const b = out[j] as Finding
      if (gone.has(j) || !isReviewer(b) || b.source === a.source || placeOf(b) !== at) continue
      const who = `${SOURCE_LABEL[a.source] ?? a.source} and ${SOURCE_LABEL[b.source] ?? b.source}`
      const sa = stanceOf(a.title)
      const sb = stanceOf(b.title)
      if (sa !== undefined && sb !== undefined && sa !== sb) {
        out[i] = {
          ...a,
          severity: 'should',
          flags: [...new Set([...a.flags, ...b.flags, 'contradicted' as const])],
          body: [
            a.body,
            `${SOURCE_LABEL[b.source] ?? b.source} disagrees: ${b.title}`,
            ...(b.body !== '' ? [b.body] : []),
          ]
            .filter((x) => x !== '')
            .join('\n'),
        }
        gone.add(j)
        notes.push(
          `${who} disagree about ${at}, so it is listed once as a suggestion and not sent to Fix on its own.`,
        )
        break
      }
      if (titleSimilarity(a.title, b.title) >= SAME_ISSUE) {
        const keep = a.severity === 'must' || b.severity !== 'must' ? a : b
        const other = keep === a ? b : a
        out[i] = {
          ...keep,
          flags: [...new Set([...keep.flags, ...other.flags, 'merged' as const])],
          body: [keep.body, `Also raised by ${SOURCE_LABEL[other.source] ?? other.source}: ${other.title}`]
            .filter((x) => x !== '')
            .join('\n'),
        }
        gone.add(j)
        notes.push(`${who} raised the same issue at ${at}; it is listed once.`)
        break
      }
    }
  }
  const kept = out.filter((_, i) => !gone.has(i))
  const ordered = [...kept.filter((f) => f.severity === 'must'), ...kept.filter((f) => f.severity !== 'must')]
  return { list: ordered.map((f, i) => ({ ...f, n: i + 1 })), notes }
}
