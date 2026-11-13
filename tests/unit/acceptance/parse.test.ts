// The acceptance readers: the plan's criteria (heading level and case, list markers, checkboxes, the next heading
// ends the section, caps, ids), the Tests step's mapping (best effort) and the acceptance review's answer (evidence
// required, left-out criteria unknown, unreadable answers a note), plus the criteria as prompts render them and
// configPassOf's fallbacks for the two new steps.
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_MAX_CRITERIA,
  ACCEPTANCE_TEXT_MAX,
  acceptanceCounts,
  acceptanceSummaryText,
} from '@shared/acceptance.ts'
import { configPassOf } from '@shared/run.ts'
import {
  ACCEPTANCE_PARSE_NOTE,
  ACCEPTANCE_SCHEMA,
  NOT_ASSESSED,
  parseAcceptanceAnswer,
  parseCriteria,
  parseTestsMapping,
  renderCriteria,
} from '@core/acceptance/parse.ts'

const CRITERIA = [
  { id: 'AC1', text: 'Adding an item shows it' },
  { id: 'AC2', text: 'Clearing removes completed items' },
  { id: 'AC3', text: 'Items persist' },
]

describe('parseCriteria', () => {
  it('reads the `## Acceptance criteria` section, one criterion per list item, ids AC1..ACn', () => {
    const plan = [
      '## Goal',
      'G',
      '',
      '## Acceptance criteria',
      '- Adding an item shows it',
      '* Clearing removes completed items',
      '1. Items persist',
      '2) The count updates',
      '- [x] A checked box still counts',
      '- [ ] So does an empty one',
      '',
      '## Risks',
      '- not a criterion',
    ].join('\n')
    expect(parseCriteria(plan)).toEqual({
      criteria: [
        { id: 'AC1', text: 'Adding an item shows it' },
        { id: 'AC2', text: 'Clearing removes completed items' },
        { id: 'AC3', text: 'Items persist' },
        { id: 'AC4', text: 'The count updates' },
        { id: 'AC5', text: 'A checked box still counts' },
        { id: 'AC6', text: 'So does an empty one' },
      ],
      dropped: 0,
    })
  })

  it('is tolerant of heading level, case, CRLF, bold labels, and joins nested lines to their item', () => {
    const plan =
      '# Plan\r\n### ACCEPTANCE CRITERIA:\r\n- One\r\n  - with a detail\r\n- Two\r\n#### Next\r\n- no'
    expect(parseCriteria(plan).criteria).toEqual([
      { id: 'AC1', text: 'One with a detail' },
      { id: 'AC2', text: 'Two' },
    ])
    const bold = '**Acceptance criteria**\n- Works offline\n\n**Risks**\n- none'
    expect(parseCriteria(bold).criteria).toEqual([{ id: 'AC1', text: 'Works offline' }])
  })

  it('falls back to "## Done when" for plans written before the section existed', () => {
    expect(parseCriteria('## Done when\n- `npm test` passes').criteria).toEqual([
      { id: 'AC1', text: '`npm test` passes' },
    ])
  })

  it('has none without the section, for an empty plan, or for "none"', () => {
    expect(parseCriteria('## Goal\nG\n## Steps\n1. x')).toEqual({ criteria: [], dropped: 0 })
    expect(parseCriteria(null).criteria).toEqual([])
    expect(parseCriteria('').criteria).toEqual([])
    expect(parseCriteria('## Acceptance criteria\n- none').criteria).toEqual([])
  })

  it('ignores fenced code, drops duplicates, caps the count and the length', () => {
    const items = Array.from({ length: ACCEPTANCE_MAX_CRITERIA + 3 }, (_, i) => `- Criterion ${i + 1}`)
    const plan = ['## Acceptance criteria', '```', '- inside a fence', '```', '- Criterion 1', ...items].join(
      '\n',
    )
    const r = parseCriteria(plan)
    expect(r.criteria).toHaveLength(ACCEPTANCE_MAX_CRITERIA)
    expect(r.dropped).toBe(3)
    expect(r.criteria.some((c) => c.text.includes('fence'))).toBe(false)
    expect(r.criteria.at(-1)?.id).toBe(`AC${ACCEPTANCE_MAX_CRITERIA}`)
    const long = parseCriteria(`## Acceptance criteria\n- ${'word '.repeat(200)}`).criteria[0]?.text ?? ''
    expect(long.length).toBeLessThanOrEqual(ACCEPTANCE_TEXT_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('parseTestsMapping', () => {
  it('reads the closing JSON block; unknown ids and empty entries are dropped', () => {
    const answer = [
      'Wrote tests.',
      '```ts',
      'const x = 1',
      '```',
      '```json',
      JSON.stringify({
        mapping: [
          { id: 'AC1', tests: ['tests/todo.test.ts: adds an item'] },
          { id: 'ac3', tests: ['tests/todo.test.ts: persists', 'tests/todo.test.ts: persists'] },
          { id: 'AC9', tests: ['nope'] },
          { id: 'AC2', tests: [] },
        ],
      }),
      '```',
    ].join('\n')
    expect(parseTestsMapping(answer, CRITERIA)).toEqual({
      AC1: ['tests/todo.test.ts: adds an item'],
      AC3: ['tests/todo.test.ts: persists'],
    })
  })

  it('maps nothing without the block (never a failure)', () => {
    expect(parseTestsMapping('Wrote the tests.', CRITERIA)).toEqual({})
    expect(parseTestsMapping('```json\n{not json\n```', CRITERIA)).toEqual({})
    expect(parseTestsMapping(JSON.stringify({ mapping: [] }), [])).toEqual({})
    // Other list keys are read too.
    expect(
      parseTestsMapping(JSON.stringify({ criteria: [{ id: 'AC1', tests: ['a.test.ts: x'] }] }), CRITERIA),
    ).toEqual({ AC1: ['a.test.ts: x'] })
  })
})

describe('parseAcceptanceAnswer', () => {
  it('reads structured verdicts with evidence', () => {
    const r = parseAcceptanceAnswer(
      {
        verdicts: [
          { id: 'AC1', status: 'met', evidence: 'src/todo.ts adds it' },
          { id: 'AC2', status: 'not-met', evidence: 'no clear button' },
          { id: 'AC3', status: 'unknown', evidence: 'needs a browser' },
        ],
      },
      CRITERIA,
    )
    expect(r).toEqual({
      readable: true,
      notes: [],
      results: {
        AC1: { status: 'met', evidence: 'src/todo.ts adds it' },
        AC2: { status: 'not-met', evidence: 'no clear button' },
        AC3: { status: 'unknown', evidence: 'needs a browser' },
      },
    })
  })

  it('downgrades a verdict without evidence to unknown, and marks left-out criteria not assessed', () => {
    const text =
      'Here:\n```json\n{"verdicts":[{"id":"AC1","status":"met","evidence":""},{"id":"AC2","status":"not met","evidence":"x"}]}\n```'
    const r = parseAcceptanceAnswer(text, CRITERIA)
    expect(r.results).toEqual({
      AC1: { status: 'unknown' },
      AC2: { status: 'not-met', evidence: 'x' },
      AC3: { status: 'unknown', evidence: NOT_ASSESSED },
    })
    expect(r.notes).toEqual([
      ACCEPTANCE_PARSE_NOTE.noEvidence(['AC1']),
      ACCEPTANCE_PARSE_NOTE.missing(['AC3']),
    ])
  })

  it('an unreadable answer, or one that names no criterion, leaves every criterion unknown with a note', () => {
    for (const v of ['I think it works.', '{"verdicts":[{"id":"AC7","status":"met","evidence":"x"}]}', 42]) {
      const r = parseAcceptanceAnswer(v, CRITERIA)
      expect(r.readable).toBe(false)
      expect(r.notes).toEqual([ACCEPTANCE_PARSE_NOTE.unreadable])
      expect(Object.values(r.results).every((x) => x.status === 'unknown')).toBe(true)
    }
  })

  it('answers with a strict schema (every property required)', () => {
    const item = ACCEPTANCE_SCHEMA.properties.verdicts.items
    expect(item.required).toEqual(['id', 'status', 'evidence'])
    expect(item.additionalProperties).toBe(false)
  })
})

describe('the criteria in prompts and summaries', () => {
  it('renders `- AC1: text` with the tests mapped to each', () => {
    expect(renderCriteria(CRITERIA.slice(0, 2), { AC2: ['a.test.ts: clears'] })).toBe(
      '- AC1: Adding an item shows it\n- AC2: Clearing removes completed items\n  Tests: a.test.ts: clears',
    )
  })

  it('summarizes counts without em dashes', () => {
    const c = acceptanceCounts([
      { status: 'met' },
      { status: 'met' },
      { status: 'not-met' },
      { status: 'unknown' },
    ])
    expect(acceptanceSummaryText(c)).toBe('Acceptance: 2 of 4 criteria met, 1 not met, 1 unknown.')
    expect(acceptanceSummaryText(acceptanceCounts([{ status: 'not-checked' }]))).toBe(
      'Acceptance: 0 of 1 criterion met, 1 not checked.',
    )
    expect(acceptanceSummaryText(c)).not.toContain('—')
  })
})

describe('configPassOf for the acceptance review and Explain', () => {
  const passes = (review: boolean, critic: boolean, plan: boolean) => ({
    review: { enabled: review },
    critic: { enabled: critic },
    plan: { enabled: plan },
  })

  it("the acceptance review runs on Review's config, then Critic's, then Plan's", () => {
    expect(configPassOf('acceptance')).toBe('review')
    expect(configPassOf('acceptance', passes(true, true, true))).toBe('review')
    expect(configPassOf('acceptance', passes(false, true, true))).toBe('critic')
    expect(configPassOf('acceptance', passes(false, false, true))).toBe('plan')
    expect(configPassOf('acceptance', passes(false, false, false))).toBe('review')
  })

  it("Explain runs on Plan's config, Review's when Plan is off", () => {
    expect(configPassOf('explain')).toBe('plan')
    expect(configPassOf('explain', passes(true, true, true))).toBe('plan')
    expect(configPassOf('explain', passes(true, false, false))).toBe('review')
    expect(configPassOf('explain', passes(false, false, false))).toBe('plan')
  })
})
