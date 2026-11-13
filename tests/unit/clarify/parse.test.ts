// Clarify's answer parser: the vendor's structured answer or a fenced JSON block in the final message, read leniently
// and kept strictly; an unreadable or empty answer is "no questions" with a note, never a throw. Also how the answers
// join the Brief.
import { describe, expect, it } from 'vitest'
import {
  CLARIFY_OPTION_MAX,
  CLARIFY_PARSE_NOTE,
  CLARIFY_QUESTION_MAX,
  CLARIFY_SCHEMA,
  parseClarify,
  withClarifyAnswers,
} from '@core/clarify/parse.ts'
import { CLARIFY_MAX_OPTIONS, CLARIFY_MAX_QUESTIONS } from '@shared/run.ts'

const DB = { question: 'Which database should it use?', options: ['SQLite', 'Postgres'] }
const UI = { question: 'Who uses it?', options: ['Just me', 'A small team', 'The public'] }

describe('parseClarify: where the JSON comes from', () => {
  it('reads the structured answer object as is', () => {
    expect(parseClarify({ questions: [DB, UI] }, 4)).toEqual({ questions: [DB, UI] })
  })

  it('reads a ```json fenced block in the final message, ignoring the prose around it', () => {
    const text = `Two things matter here.\n\n\`\`\`json\n${JSON.stringify({ questions: [DB] })}\n\`\`\`\nThanks.`
    expect(parseClarify(text, 4)).toEqual({ questions: [DB] })
  })

  it('prefers a json-tagged block over an untagged one, and falls back to the untagged one', () => {
    const other = { questions: [UI] }
    const tagged = `\`\`\`\n${JSON.stringify(other)}\n\`\`\`\n\`\`\`json\n${JSON.stringify({ questions: [DB] })}\n\`\`\``
    expect(parseClarify(tagged, 4).questions).toEqual([DB])
    const untagged = `\`\`\`\n${JSON.stringify(other)}\n\`\`\``
    expect(parseClarify(untagged, 4).questions).toEqual([UI])
  })

  it('reads a message that is bare JSON, or JSON between other text (CRLF and a BOM too)', () => {
    expect(parseClarify(`\uFEFF${JSON.stringify({ questions: [DB] })}\r\n`, 4).questions).toEqual([DB])
    expect(parseClarify(`Here: ${JSON.stringify({ questions: [UI] })} done`, 4).questions).toEqual([UI])
  })

  it('accepts a bare array of questions and the usual key spellings', () => {
    expect(
      parseClarify([{ text: 'Which database?', choices: [{ label: 'SQLite' }, { text: 'Postgres' }] }], 4),
    ).toEqual({ questions: [{ question: 'Which database?', options: ['SQLite', 'Postgres'] }] })
  })
})

describe('parseClarify: no questions means the run goes on, with a note', () => {
  it('an empty list says Clarify had no questions', () => {
    expect(parseClarify({ questions: [] }, 4)).toEqual({ questions: [], note: CLARIFY_PARSE_NOTE.none })
    expect(parseClarify('```json\n{"questions": []}\n```', 4)).toEqual({
      questions: [],
      note: CLARIFY_PARSE_NOTE.none,
    })
  })

  it.each([
    ['prose only', 'I think the task is clear enough.'],
    ['broken JSON', '```json\n{"questions": [{"question": "x", }\n```'],
    ['the wrong shape', { asks: [DB] }],
    ['nothing', ''],
    ['null', null],
    ['a number', 42],
  ])('an unreadable answer (%s) is no questions', (_what, value) => {
    expect(parseClarify(value, 4)).toEqual({ questions: [], note: CLARIFY_PARSE_NOTE.unreadable })
  })

  it('questions that cannot be used (fewer than two options, no text) count as unreadable', () => {
    const r = parseClarify({ questions: [{ question: 'Ok?', options: ['yes'] }, { options: ['a', 'b'] }] }, 4)
    expect(r).toEqual({ questions: [], note: CLARIFY_PARSE_NOTE.unreadable })
  })
})

describe('parseClarify: what is kept', () => {
  it('keeps at most `max` questions (and never more than the hard limit)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ question: `Q${i}?`, options: ['a', 'b'] }))
    expect(parseClarify({ questions: many }, 3).questions.map((q) => q.question)).toEqual([
      'Q0?',
      'Q1?',
      'Q2?',
    ])
    expect(parseClarify({ questions: many }, 99).questions).toHaveLength(CLARIFY_MAX_QUESTIONS)
  })

  it('drops "Other" options (the card adds its own), duplicates and empty ones; caps the option count', () => {
    const q = parseClarify(
      {
        questions: [
          {
            question: 'Which?',
            options: ['A', 'a', '', 'Other (please specify)', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
          },
        ],
      },
      4,
    ).questions[0]
    expect(q?.options).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(q?.options).toHaveLength(CLARIFY_MAX_OPTIONS)
  })

  it('drops a repeated question and flattens whitespace', () => {
    const r = parseClarify(
      {
        questions: [
          { question: 'Which\n  database?', options: ['x', 'y'] },
          { question: 'which database?', options: ['z', 'w'] },
        ],
      },
      4,
    )
    expect(r.questions).toEqual([{ question: 'Which database?', options: ['x', 'y'] }])
  })

  it('cuts an overlong question or option at a word, with an ellipsis', () => {
    const long = `${'word '.repeat(200)}end?`
    const r = parseClarify({ questions: [{ question: long, options: ['short', 'opt '.repeat(60)] }] }, 4)
    const q = r.questions[0]
    expect(q?.question.length).toBeLessThanOrEqual(CLARIFY_QUESTION_MAX + 1)
    expect(q?.question.endsWith('…')).toBe(true)
    expect(q?.options[1]?.length).toBeLessThanOrEqual(CLARIFY_OPTION_MAX + 1)
  })

  it('never throws on odd input', () => {
    for (const v of [undefined, {}, [], [null], { questions: 'x' }, { questions: [42, 'x', []] }, '```', '{'])
      expect(() => parseClarify(v, 4)).not.toThrow()
  })

  it('asks for a schema the structured-output paths accept: strict objects, every field required', () => {
    expect(CLARIFY_SCHEMA.additionalProperties).toBe(false)
    expect(CLARIFY_SCHEMA.required).toEqual(['questions'])
    expect(CLARIFY_SCHEMA.properties.questions.items.required).toEqual(['question', 'options'])
    expect(CLARIFY_SCHEMA.properties.questions.items.additionalProperties).toBe(false)
  })
})

describe('withClarifyAnswers', () => {
  it('adds the answered questions after the brief; unanswered ones are left to Plan', () => {
    const out = withClarifyAnswers('Category: Software', [DB, UI], ['Postgres', ''])
    expect(out).toBe(
      'Category: Software\n\nAnswers to the clarifying questions:\n- Which database should it use?\n  Answer: Postgres',
    )
  })

  it('makes a brief of its own when the run had none, and keeps an answer on one line', () => {
    expect(withClarifyAnswers(undefined, [UI], ['A small team\nof five'])).toBe(
      'Answers to the clarifying questions:\n- Who uses it?\n  Answer: A small team of five',
    )
  })

  it('changes nothing when no question was answered', () => {
    expect(withClarifyAnswers('Brief', [DB], [''])).toBe('Brief')
    expect(withClarifyAnswers(undefined, [DB], ['  '])).toBe('')
  })
})
