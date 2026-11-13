// Research's answer: the cited brief a read-only pass hands Plan, as structured JSON. Read from the vendor's
// structured answer when the adapter has one, else from a fenced JSON block in the final message. Lenient in what it
// reads, strict in what it keeps: every feature, standard, option and risk must cite a source (an http(s) URL or a
// `repo:<path>` of the repository), and one that cites none is dropped. An answer with no cited claim left is "nothing
// usable" (Plan starts with a note), never a failure. Web content is untrusted: the text is kept as data, cut to
// length, and never interpreted.
import {
  RESEARCH_PRIORITIES,
  RESEARCH_SECTION_MAX,
  RESEARCH_SOURCES_MAX,
  RESEARCH_SUMMARY_LINES,
  RESEARCH_TEXT_MAX,
  isCitation,
} from '../../shared/research.ts'
import type {
  ResearchCitation,
  ResearchFeature,
  ResearchOption,
  ResearchPriority,
  ResearchQuestion,
  ResearchResult,
  ResearchRisk,
  ResearchSource,
  ResearchStandard,
} from '../../shared/research.ts'
import { jsonFromText } from '../clarify/parse.ts'

const SOURCES_SCHEMA = { type: 'array', items: { type: 'string' }, maxItems: 8 } as const

/** The JSON Schema Research answers with (structured output where the vendor supports it). */
export const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'features', 'standards', 'options', 'risks', 'questions', 'sources'],
  properties: {
    summary: { type: 'array', items: { type: 'string' }, maxItems: RESEARCH_SUMMARY_LINES },
    features: {
      type: 'array',
      maxItems: RESEARCH_SECTION_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['feature', 'priority', 'sources'],
        properties: {
          feature: { type: 'string' },
          priority: { type: 'string', enum: [...RESEARCH_PRIORITIES] },
          sources: SOURCES_SCHEMA,
        },
      },
    },
    standards: {
      type: 'array',
      maxItems: RESEARCH_SECTION_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['standard', 'why', 'sources'],
        properties: { standard: { type: 'string' }, why: { type: 'string' }, sources: SOURCES_SCHEMA },
      },
    },
    options: {
      type: 'array',
      maxItems: RESEARCH_SECTION_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic', 'options', 'recommendation', 'rationale', 'sources'],
        properties: {
          topic: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          recommendation: { type: 'string' },
          rationale: { type: 'string' },
          sources: SOURCES_SCHEMA,
        },
      },
    },
    risks: {
      type: 'array',
      maxItems: RESEARCH_SECTION_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['risk', 'sources'],
        properties: { risk: { type: 'string' }, sources: SOURCES_SCHEMA },
      },
    },
    questions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    sources: {
      type: 'array',
      maxItems: RESEARCH_SOURCES_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: { url: { type: 'string' }, title: { type: 'string' } },
      },
    },
  },
} as const

/** Notes for an answer Plan cannot use (UI copy, no em dashes). */
export const RESEARCH_PARSE_NOTE = {
  unreadable: "Research's answer could not be read, so Plan starts without it.",
  uncited: 'Research found nothing it could cite, so Plan starts without it.',
  dropped: (n: number): string =>
    `Research left out ${n === 1 ? 'one claim' : `${n} claims`} that cited no source.`,
} as const

export interface ResearchParse {
  /** Absent when nothing usable was left (`note` says why). */
  result?: ResearchResult
  note?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** One line of text without control characters, cut at a word boundary to `max` characters. */
export function cleanText(v: unknown, max: number = RESEARCH_TEXT_MAX): string {
  if (typeof v !== 'string') return ''
  const t = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

const first = (r: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined) return r[k]
  return undefined
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A citation as written: a string, `{url}`, or a 1-based index into the answer's sources list. */
function citationOf(v: unknown, list: readonly ResearchSource[]): ResearchCitation | undefined {
  let raw: unknown = v
  if (typeof v === 'number' && Number.isInteger(v)) raw = list[v - 1]?.url
  else if (isRecord(v)) raw = first(v, 'url', 'href', 'source')
  if (typeof raw !== 'string') return undefined
  const t = raw.trim().replace(/^<(.*)>$/, '$1')
  const m = /^\[(\d+)\]$/.exec(t)
  if (m !== null) return list[Number(m[1]) - 1]?.url
  return t.length <= 2000 && isCitation(t) ? t : undefined
}

function citationsOf(r: Record<string, unknown>, list: readonly ResearchSource[]): ResearchCitation[] {
  const raw = first(r, 'sources', 'citations', 'source', 'seenIn', 'seen_in', 'urls', 'url')
  const items = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []
  const out: ResearchCitation[] = []
  for (const item of items) {
    const c = citationOf(item, list)
    if (c !== undefined && !out.includes(c)) out.push(c)
    if (out.length >= 8) break
  }
  return out
}

function priorityOf(v: unknown): ResearchPriority {
  const t =
    typeof v === 'string'
      ? v
          .trim()
          .toLowerCase()
          .replace(/[-\s]?have$/, '')
      : ''
  return (RESEARCH_PRIORITIES as readonly string[]).includes(t) ? (t as ResearchPriority) : 'should'
}

function sourcesOf(v: unknown): ResearchSource[] {
  const out: ResearchSource[] = []
  for (const item of arr(v)) {
    const url = citationOf(item, [])
    if (url === undefined || out.some((s) => s.url === url)) continue
    const title = isRecord(item) ? cleanText(first(item, 'title', 'name'), 200) : ''
    out.push(title !== '' ? { url, title } : { url })
    if (out.length >= RESEARCH_SOURCES_MAX) break
  }
  return out
}

function summaryOf(v: unknown): string[] {
  const lines = typeof v === 'string' ? v.split(/\r?\n/) : arr(v)
  return lines
    .map((l) => cleanText(l).replace(/^[-*•]\s*/, ''))
    .filter((l) => l !== '')
    .slice(0, RESEARCH_SUMMARY_LINES)
}

/**
 * Research's brief from its answer (`value`: the vendor's structured answer, or the final message's text). Claims
 * without a citation are dropped and counted. Never throws.
 */
export function parseResearch(value: unknown): ResearchParse {
  const v = typeof value === 'string' ? jsonFromText(value) : value
  if (!isRecord(v)) return { note: RESEARCH_PARSE_NOTE.unreadable }
  const sources = sourcesOf(first(v, 'sources', 'references'))
  let dropped = 0
  /** Keeps up to RESEARCH_SECTION_MAX cited items of a section; an uncited one counts as dropped. */
  const section = <T>(raw: unknown, make: (r: Record<string, unknown>, n: number) => T | undefined): T[] => {
    const out: T[] = []
    for (const item of arr(raw)) {
      if (!isRecord(item)) continue
      if (citationsOf(item, sources).length === 0) {
        dropped++
        continue
      }
      if (out.length >= RESEARCH_SECTION_MAX) continue
      const made = make(item, out.length + 1)
      if (made !== undefined) out.push(made)
    }
    return out
  }
  const features = section<ResearchFeature>(first(v, 'features', 'featureTable', 'feature_table'), (r, n) => {
    const feature = cleanText(first(r, 'feature', 'name', 'title'))
    if (feature === '') return undefined
    return { id: `f${n}`, feature, priority: priorityOf(r['priority']), sources: citationsOf(r, sources) }
  })
  const standards = section<ResearchStandard>(first(v, 'standards', 'practices'), (r, n) => {
    const standard = cleanText(first(r, 'standard', 'name', 'title'))
    if (standard === '') return undefined
    const why = cleanText(first(r, 'why', 'reason', 'note'))
    return { id: `s${n}`, standard, ...(why !== '' ? { why } : {}), sources: citationsOf(r, sources) }
  })
  const options = section<ResearchOption>(first(v, 'options', 'recommendations', 'decisions'), (r, n) => {
    const topic = cleanText(first(r, 'topic', 'decision', 'question', 'title'))
    const recommendation = cleanText(first(r, 'recommendation', 'recommended', 'choice'))
    if (topic === '' || recommendation === '') return undefined
    const list = arr(first(r, 'options', 'choices', 'alternatives'))
      .map((o) => cleanText(isRecord(o) ? first(o, 'name', 'option', 'label') : o, 120))
      .filter((o) => o !== '')
      .slice(0, 6)
    return {
      id: `o${n}`,
      topic,
      options: [...new Set(list)],
      recommendation,
      rationale: cleanText(first(r, 'rationale', 'why', 'reason')),
      sources: citationsOf(r, sources),
    }
  })
  const risks = section<ResearchRisk>(first(v, 'risks', 'pitfalls'), (r, n) => {
    const risk = cleanText(first(r, 'risk', 'pitfall', 'text', 'title'))
    return risk !== '' ? { id: `r${n}`, risk, sources: citationsOf(r, sources) } : undefined
  })
  const questions: ResearchQuestion[] = []
  for (const q of arr(first(v, 'questions', 'openQuestions', 'open_questions'))) {
    const question = cleanText(isRecord(q) ? first(q, 'question', 'text') : q)
    if (question === '' || questions.some((x) => x.question === question)) continue
    questions.push({ id: `q${questions.length + 1}`, question })
    if (questions.length >= 8) break
  }
  const claims = features.length + standards.length + options.length + risks.length
  if (claims === 0)
    return { note: dropped > 0 ? RESEARCH_PARSE_NOTE.uncited : RESEARCH_PARSE_NOTE.unreadable }
  // Every source a kept claim cites is listed (with its title when the answer gave one).
  const cited = [...features, ...standards, ...options, ...risks].flatMap((c) => c.sources)
  const listed: ResearchSource[] = []
  for (const url of cited) {
    if (listed.some((s) => s.url === url)) continue
    listed.push(sources.find((s) => s.url === url) ?? { url })
  }
  return {
    result: {
      summary: summaryOf(first(v, 'summary', 'overview')),
      features,
      standards,
      options,
      risks,
      questions,
      sources: listed.slice(0, RESEARCH_SOURCES_MAX),
      dropped,
    },
  }
}
