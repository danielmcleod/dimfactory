// Clarify's answer: the questions a read-only pass may ask before Plan, as structured JSON. Read from the vendor's
// structured answer when the adapter has one (Claude's and Codex's outputSchema), else from a fenced JSON block in
// the final message (or the message itself when it is JSON). Lenient in what it reads, strict in what it keeps: an
// unreadable or empty answer means "no questions" (the run goes on with a note), never a failure. Also the JSON
// Schema the pass is asked to answer with, and how the answers join the run's Brief.
import { CLARIFY_MAX_OPTIONS, CLARIFY_MAX_QUESTIONS } from '../../shared/run.ts'
import type { ClarifyQuestion } from '../../shared/run.ts'

/** The longest question and option Dim Factory keeps (longer ones are cut at a word). */
export const CLARIFY_QUESTION_MAX = 300
export const CLARIFY_OPTION_MAX = 120

/** The JSON Schema Clarify answers with (structured output where the vendor supports it). */
export const CLARIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      maxItems: CLARIFY_MAX_QUESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'options'],
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, maxItems: CLARIFY_MAX_OPTIONS },
        },
      },
    },
  },
} as const

/** Notes for an answer that asks nothing (UI copy, no em dashes). */
export const CLARIFY_PARSE_NOTE = {
  none: 'Clarify had no questions, so Plan starts right away.',
  unreadable: "Clarify's answer could not be read as questions, so Plan starts without them.",
} as const

export interface ClarifyParse {
  /** At most `max` questions, each with two or more options. */
  questions: ClarifyQuestion[]
  /** Why there are none (absent when there are questions). */
  note?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** One line of text, cut at a word boundary to `max` characters. */
function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/** "Other" is the card's own free-text choice, never one of the model's options. */
const OTHER_RE = /^(other|something else|none of (the|these) above)\b/i

function questionOf(v: unknown): ClarifyQuestion | undefined {
  if (!isRecord(v)) return undefined
  const question = clean(v['question'] ?? v['text'] ?? v['q'], CLARIFY_QUESTION_MAX)
  const raw = v['options'] ?? v['choices'] ?? v['answers']
  if (question === '' || !Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const options: string[] = []
  for (const o of raw as unknown[]) {
    const text = clean(isRecord(o) ? (o['label'] ?? o['text']) : o, CLARIFY_OPTION_MAX)
    const key = text.toLowerCase()
    if (text === '' || OTHER_RE.test(text) || seen.has(key)) continue
    seen.add(key)
    options.push(text)
    if (options.length >= CLARIFY_MAX_OPTIONS) break
  }
  return options.length >= 2 ? { question, options } : undefined
}

/** A JSON value from the final message: a fenced block (```json first), else the message, else its outer braces. */
export function jsonFromText(text: string): unknown {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const blocks = [...t.matchAll(/(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\1/g)]
  const ordered = [
    ...blocks.filter((m) => (m[2] ?? '').toLowerCase() === 'json'),
    ...blocks.filter((m) => (m[2] ?? '').toLowerCase() !== 'json'),
  ]
  for (const m of ordered) {
    const v = tryJson(m[3] ?? '')
    if (v !== undefined) return v
  }
  const whole = tryJson(t.trim())
  if (whole !== undefined) return whole
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  return start >= 0 && end > start ? tryJson(t.slice(start, end + 1)) : undefined
}

function tryJson(s: string): unknown {
  if (s.trim() === '') return undefined
  try {
    return JSON.parse(s) as unknown
  } catch {
    return undefined
  }
}

/**
 * Clarify's questions from its answer (`value`: the vendor's structured answer, or the final message's text), at most
 * `max`. Never throws.
 */
export function parseClarify(value: unknown, max: number): ClarifyParse {
  const limit = Math.max(0, Math.min(CLARIFY_MAX_QUESTIONS, Math.floor(max)))
  const v = typeof value === 'string' ? jsonFromText(value) : value
  const list = Array.isArray(v) ? v : isRecord(v) ? v['questions'] : undefined
  if (!Array.isArray(list)) return { questions: [], note: CLARIFY_PARSE_NOTE.unreadable }
  const questions: ClarifyQuestion[] = []
  const seen = new Set<string>()
  for (const item of list as unknown[]) {
    const q = questionOf(item)
    if (q === undefined || seen.has(q.question.toLowerCase())) continue
    seen.add(q.question.toLowerCase())
    questions.push(q)
    if (questions.length >= limit) break
  }
  if (questions.length > 0) return { questions }
  // Questions were there, but none could be used (no options): as unreadable as no answer.
  return { questions: [], note: list.length === 0 ? CLARIFY_PARSE_NOTE.none : CLARIFY_PARSE_NOTE.unreadable }
}

/**
 * The run's Brief with the user's answers to Clarify's questions added (the questions left unanswered are left out,
 * so Plan decides them). The Brief renders into every pass prompt as `{{brief}}`.
 */
export function withClarifyAnswers(
  brief: string | undefined,
  questions: readonly ClarifyQuestion[],
  answers: readonly string[],
): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const a = (answers[i] ?? '').trim()
    if (a === '') return
    lines.push(`- ${q.question}`, `  Answer: ${a.replace(/\n+/g, ' ')}`)
  })
  if (lines.length === 0) return brief ?? ''
  const section = ['Answers to the clarifying questions:', ...lines].join('\n')
  const base = (brief ?? '').trim()
  return base === '' ? section : `${base}\n\n${section}`
}
