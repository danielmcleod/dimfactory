// Research's answer parser: structured and fenced answers, the citation forms it keeps (URLs, repo:<path>, an index
// into the answer's sources, `[n]`), uncited claims dropped and counted, the "nothing usable" notes, the caps, the
// priority reading, control characters, and isCitation's refusals.
import { describe, expect, it } from 'vitest'
import { RESEARCH_SECTION_MAX, RESEARCH_SUMMARY_LINES, isCitation } from '@shared/research.ts'
import { RESEARCH_PARSE_NOTE, RESEARCH_SCHEMA, cleanText, parseResearch } from '@core/research/parse.ts'

const URL1 = 'https://www.w3.org/TR/WCAG22/'
const URL2 = 'https://clig.dev/'

const answer = {
  summary: ['One line.', 'Two lines.'],
  features: [
    { feature: 'Keyboard navigation', priority: 'must', sources: [URL1] },
    { feature: 'Dark mode', priority: 'could', sources: [] },
  ],
  standards: [{ standard: 'WCAG 2.2 AA', why: 'Accessibility', sources: [URL1] }],
  options: [
    {
      topic: 'Storage',
      options: ['SQLite', 'Postgres'],
      recommendation: 'SQLite',
      rationale: 'Single user',
      sources: ['repo:package.json'],
    },
  ],
  risks: [{ risk: 'Focus traps', sources: [URL1] }],
  questions: ['Who are the users?'],
  sources: [{ url: URL1, title: 'WCAG 2.2' }],
}

describe('parseResearch', () => {
  it('reads a structured answer, numbers the items, drops uncited claims and counts them', () => {
    const r = parseResearch(answer).result
    expect(r).toBeDefined()
    expect(r?.features.map((f) => [f.id, f.feature, f.priority])).toEqual([
      ['f1', 'Keyboard navigation', 'must'],
    ])
    expect(r?.dropped).toBe(1)
    expect(r?.standards).toEqual([
      { id: 's1', standard: 'WCAG 2.2 AA', why: 'Accessibility', sources: [URL1] },
    ])
    expect(r?.options[0]).toMatchObject({
      id: 'o1',
      recommendation: 'SQLite',
      sources: ['repo:package.json'],
    })
    expect(r?.risks).toEqual([{ id: 'r1', risk: 'Focus traps', sources: [URL1] }])
    expect(r?.questions).toEqual([{ id: 'q1', question: 'Who are the users?' }])
    expect(r?.summary).toEqual(['One line.', 'Two lines.'])
    // Every cited source is listed, with the title the answer gave.
    expect(r?.sources).toEqual([{ url: URL1, title: 'WCAG 2.2' }, { url: 'repo:package.json' }])
  })

  it('reads a fenced JSON block in the final message, the same as the structured answer', () => {
    const text = `Here it is.\n\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\nDone.`
    expect(parseResearch(text)).toEqual(parseResearch(answer))
  })

  it('takes a citation as a URL, {url}, an index into the sources, or [n]', () => {
    const r = parseResearch({
      features: [
        { feature: 'a', priority: 'must', sources: [1] },
        { feature: 'b', priority: 'must', sources: ['[2]'] },
        { feature: 'c', priority: 'must', sources: [{ url: URL2 }] },
        { feature: 'd', priority: 'must', citations: URL1 },
        { feature: 'e', priority: 'must', sources: [9, '[7]', 'not a url', 'ftp://x.example/y'] },
      ],
      sources: [{ url: URL1 }, URL2],
    }).result
    expect(r?.features.map((f) => [f.feature, f.sources])).toEqual([
      ['a', [URL1]],
      ['b', [URL2]],
      ['c', [URL2]],
      ['d', [URL1]],
    ])
    expect(r?.dropped).toBe(1)
  })

  it('reads must-have / should / could, and anything else as should', () => {
    const f = (priority: unknown) =>
      parseResearch({ features: [{ feature: 'x', priority, sources: [URL1] }] }).result?.features[0]?.priority
    expect(f('Must-have')).toBe('must')
    expect(f('could')).toBe('could')
    expect(f('nice')).toBe('should')
    expect(f(undefined)).toBe('should')
  })

  it('caps every section and the summary, and keeps ids dense', () => {
    const many = Array.from({ length: RESEARCH_SECTION_MAX + 5 }, (_, i) => ({
      risk: `risk ${i}`,
      sources: [URL1],
    }))
    const r = parseResearch({ risks: many, summary: ['1', '2', '3', '4', '5', '6', '7'] }).result
    expect(r?.risks).toHaveLength(RESEARCH_SECTION_MAX)
    expect(r?.risks.at(-1)?.id).toBe(`r${RESEARCH_SECTION_MAX}`)
    expect(r?.summary).toHaveLength(RESEARCH_SUMMARY_LINES)
  })

  it('strips control characters and cuts long text', () => {
    const r = parseResearch({
      features: [{ feature: 'a\u0000b\u001bc\nd', priority: 'must', sources: [URL1] }],
    }).result
    expect(r?.features[0]?.feature).toBe('a b c d')
    expect(cleanText('x '.repeat(400)).length).toBeLessThanOrEqual(301)
    expect(cleanText(42)).toBe('')
  })

  it('an option needs a topic and a recommendation', () => {
    const r = parseResearch({
      options: [
        { topic: 'A', recommendation: '', sources: [URL1] },
        { topic: 'B', recommendation: 'Yes', sources: [URL1] },
      ],
    }).result
    expect(r?.options.map((o) => o.topic)).toEqual(['B'])
    expect(r?.options[0]?.id).toBe('o1')
  })

  it('nothing usable: unreadable text, or only uncited claims', () => {
    expect(parseResearch('I looked around and found nothing.')).toEqual({
      note: RESEARCH_PARSE_NOTE.unreadable,
    })
    expect(parseResearch(null)).toEqual({ note: RESEARCH_PARSE_NOTE.unreadable })
    expect(parseResearch({ features: [{ feature: 'x', priority: 'must' }] })).toEqual({
      note: RESEARCH_PARSE_NOTE.uncited,
    })
    // Questions alone are not a brief.
    expect(parseResearch({ questions: ['Why?'] })).toEqual({ note: RESEARCH_PARSE_NOTE.unreadable })
  })

  it('its schema asks for every section and every claim with sources', () => {
    expect(RESEARCH_SCHEMA.required).toEqual([
      'summary',
      'features',
      'standards',
      'options',
      'risks',
      'questions',
      'sources',
    ])
    expect(RESEARCH_SCHEMA.properties.features.items.required).toContain('sources')
    expect(RESEARCH_SCHEMA.properties.risks.items.required).toContain('sources')
  })

  it('the dropped note counts its claims (no em dash)', () => {
    expect(RESEARCH_PARSE_NOTE.dropped(1)).toBe('Research left out one claim that cited no source.')
    expect(RESEARCH_PARSE_NOTE.dropped(3)).toBe('Research left out 3 claims that cited no source.')
    for (const n of [RESEARCH_PARSE_NOTE.unreadable, RESEARCH_PARSE_NOTE.uncited])
      expect(n).not.toContain('—')
  })
})

describe('isCitation', () => {
  it.each([
    'https://clig.dev/',
    'http://example.org/a?b=c#d',
    'https://www.w3.org/TR/WCAG22/',
    'repo:package.json',
    'repo:src/index.ts',
  ])('keeps %s', (c) => expect(isCitation(c)).toBe(true))

  it.each([
    'repo:/etc/passwd',
    'repo:\\windows',
    'repo:C:/x',
    'repo:../secret',
    'repo:src/../../x',
    'ftp://example.org/x',
    'https://localhost',
    'javascript:alert(1)',
    'example.org',
    'https://a b.example/',
    '',
  ])('refuses %s', (c) => expect(isCitation(c)).toBe(false))
})
