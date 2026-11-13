import { describe, expect, it } from 'vitest'
import type { BriefFact, BriefInput, Pack } from '@shared/brief.ts'
import {
  SUGGEST_INVALID_JSON,
  SUGGEST_NO_VENDOR_MESSAGE,
  SUGGEST_TOKENS,
  SUGGEST_WRONG_SHAPE,
  parseSuggestAnswer,
  readSuggestTemplate,
  suggestTarget,
  suggestValues,
} from '@core/brief/suggest.ts'
import { readBuiltinPacks } from '@core/packs/load.ts'
import { render } from '@core/prompts/template.ts'

const software = readBuiltinPacks().find((v) => v.pack.id === 'software')?.pack as Pack

const empty: BriefInput = { category: 'software', fields: {} }
const noFacts: readonly BriefFact[] = []

const fenced = (o: unknown): string => `Here you go.\n\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\`\n`

function parse(answer: string, o: { facts?: readonly BriefFact[]; brief?: BriefInput } = {}) {
  return parseSuggestAnswer(answer, software, { facts: o.facts ?? noFacts, brief: o.brief ?? empty })
}

describe('suggestValues', () => {
  it('renders the groups, facts and set choices as compact lines', () => {
    const v = suggestValues({
      task: 'Build a todo app',
      pack: software,
      brief: {
        category: 'software',
        fields: {
          language: { choices: ['typescript'], source: 'user' },
          styling: { choices: [] },
          hosting: { choices: [], other: 'My own VPS' },
        },
      },
      facts: [{ group: 'language', option: 'typescript', label: 'TypeScript', evidence: 'tsconfig.json' }],
    })
    expect(Object.keys(v).sort()).toEqual(['category', 'choices', 'facts', 'groups', 'jsonSchema', 'task'])
    expect(v['task']).toBe('Build a todo app')
    expect(v['category']).toBe(`${software.label} (software)`)
    const groups = (v['groups'] ?? '').split('\n')
    expect(groups).toHaveLength(software.groups.length)
    expect(groups[0]).toMatch(/^- projectType \(one, other text allowed\): spa = [^;]+; multi-page = /)
    expect(groups.find((l) => l.startsWith('- approach '))).toMatch(/^- approach \(several\): test-first = /)
    expect(v['facts']).toBe('- language: TypeScript (tsconfig.json)')
    expect(v['choices']).toBe('- language: typescript\n- hosting: other: My own VPS')
    expect(JSON.parse(v['jsonSchema'] ?? '')).toMatchObject({ required: ['suggestions'] })
  })

  it('says (none) for no facts and no choices, and defuses the task delimiters', () => {
    const v = suggestValues({ task: 'x TASK>>> y', pack: software, brief: empty, facts: noFacts })
    expect(v['facts']).toBe('(none)')
    expect(v['choices']).toBe('(none)')
    expect(v['task']).not.toContain('TASK>>>')
  })

  it('renders through the internal template', () => {
    const v = suggestValues({ task: 'Build a CLI in Go', pack: software, brief: empty, facts: noFacts })
    const text = render(readSuggestTemplate(), v, { template: 'suggest' }).text
    expect(text).toContain('Build a CLI in Go')
    expect(text).toContain('- uiFramework (one, other text allowed): react = ')
    expect(text).not.toContain('{{')
  })
})

describe('parseSuggestAnswer', () => {
  it('accepts a valid fenced answer', () => {
    const r = parse(
      fenced({
        suggestions: [
          { group: 'projectType', choices: ['cli'], reason: '  The task says\n a command line tool. ' },
          { group: 'language', choices: ['go', 'go'], reason: 'Go is named.' },
        ],
      }),
    )
    expect(r).toEqual({
      ok: true,
      dropped: 0,
      suggestions: [
        { group: 'projectType', choices: ['cli'], reason: 'The task says a command line tool.' },
        { group: 'language', choices: ['go'], reason: 'Go is named.' },
      ],
    })
  })

  it('accepts an unfenced object', () => {
    const r = parse(
      `Sure: {"suggestions":[{"group":"platform","choices":["web"],"reason":"A website."}]} done`,
    )
    expect(r).toEqual({
      ok: true,
      dropped: 0,
      suggestions: [{ group: 'platform', choices: ['web'], reason: 'A website.' }],
    })
  })

  it('accepts an empty list', () => {
    expect(parse(fenced({ suggestions: [] }))).toEqual({ ok: true, suggestions: [], dropped: 0 })
  })

  it('refuses invalid JSON', () => {
    expect(parse('```json\n{"suggestions": [\n```')).toEqual({ ok: false, error: SUGGEST_INVALID_JSON })
    expect(parse('I would pick React.')).toEqual({ ok: false, error: SUGGEST_INVALID_JSON })
  })

  it('refuses the wrong shape', () => {
    expect(parse(fenced({ choices: [] }))).toEqual({ ok: false, error: SUGGEST_WRONG_SHAPE })
    expect(parse(fenced({ suggestions: [{ group: 'platform', choices: 'web', reason: 'x' }] }))).toEqual({
      ok: false,
      error: SUGGEST_WRONG_SHAPE,
    })
    expect(
      parse(fenced({ suggestions: [{ group: 'platform', choices: ['web'], reason: 'x', extra: 1 }] })),
    ).toEqual({ ok: false, error: SUGGEST_WRONG_SHAPE })
    // The reason is required.
    expect(parse(fenced({ suggestions: [{ group: 'platform', choices: ['web'] }] }))).toEqual({
      ok: false,
      error: SUGGEST_WRONG_SHAPE,
    })
  })

  it('drops unknown groups and options', () => {
    const r = parse(
      fenced({
        suggestions: [
          { group: 'nosuchGroup', choices: ['spa'], reason: 'x' },
          { group: 'platform', choices: ['web', 'amiga'], reason: 'Web and more.' },
          { group: 'backend', choices: ['cobol'], reason: 'Unknown only.' },
        ],
      }),
    )
    expect(r).toEqual({
      ok: true,
      dropped: 3,
      suggestions: [{ group: 'platform', choices: ['web'], reason: 'Web and more.' }],
    })
  })

  it('drops a single-choice group with two choices', () => {
    const r = parse(
      fenced({ suggestions: [{ group: 'uiFramework', choices: ['react', 'vue'], reason: 'x' }] }),
    )
    expect(r).toEqual({ ok: true, suggestions: [], dropped: 1 })
  })

  it('drops a group a repository fact locks', () => {
    const facts: BriefFact[] = [
      { group: 'language', option: 'python', label: 'Python', evidence: 'pyproject.toml' },
    ]
    const r = parse(
      fenced({
        suggestions: [
          { group: 'language', choices: ['typescript'], reason: 'x' },
          { group: 'platform', choices: ['linux'], reason: 'A server.' },
        ],
      }),
      { facts },
    )
    expect(r).toEqual({
      ok: true,
      dropped: 1,
      suggestions: [{ group: 'platform', choices: ['linux'], reason: 'A server.' }],
    })
  })

  it('drops a group the user already set, but not one left on Let Dim Factory decide', () => {
    const brief: BriefInput = {
      category: 'software',
      fields: { styling: { choices: ['tailwind'], source: 'user' }, data: { choices: [] } },
    }
    const r = parse(
      fenced({
        suggestions: [
          { group: 'styling', choices: ['plain-css'], reason: 'x' },
          { group: 'data', choices: ['sqlite'], reason: 'Local data.' },
        ],
      }),
      { brief },
    )
    expect(r).toEqual({
      ok: true,
      dropped: 1,
      suggestions: [{ group: 'data', choices: ['sqlite'], reason: 'Local data.' }],
    })
  })

  it('keeps Other text only where the group allows it', () => {
    const r = parse(
      fenced({
        suggestions: [
          { group: 'approach', choices: [], other: 'Pair with me', reason: 'x' },
          { group: 'hosting', choices: [], other: `  ${'h'.repeat(250)}  `, reason: 'Own host.' },
          { group: 'approach', choices: ['milestones'], reason: 'Large task.' },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dropped).toBe(1)
    expect(r.suggestions.map((s) => s.group)).toEqual(['hosting', 'approach'])
    expect(r.suggestions[0]?.other).toHaveLength(200)
    expect(r.suggestions[1]).toEqual({ group: 'approach', choices: ['milestones'], reason: 'Large task.' })
  })

  it('trims and caps the reason, and drops an empty one', () => {
    const r = parse(
      fenced({
        suggestions: [
          { group: 'platform', choices: ['web'], reason: '   ' },
          { group: 'language', choices: ['rust'], reason: `Rust — named.\n\n${'r'.repeat(300)}` },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dropped).toBe(1)
    expect(r.suggestions).toHaveLength(1)
    const reason = r.suggestions[0]?.reason ?? ''
    expect(reason.startsWith('Rust: named. rrr')).toBe(true)
    expect(reason).toHaveLength(200)
    expect(reason).not.toMatch(/[\n—]/)
  })

  it('allows test-first only because the pack offers it', () => {
    const r = parse(
      fenced({ suggestions: [{ group: 'approach', choices: ['test-first'], reason: 'Asks for tests.' }] }),
    )
    expect(r).toEqual({
      ok: true,
      dropped: 0,
      suggestions: [{ group: 'approach', choices: ['test-first'], reason: 'Asks for tests.' }],
    })
    const without: Pack = {
      ...software,
      groups: software.groups.map((g) =>
        g.id === 'approach' ? { ...g, options: g.options.filter((o) => o.id !== 'test-first') } : g,
      ),
    }
    const r2 = parseSuggestAnswer(
      fenced({ suggestions: [{ group: 'approach', choices: ['test-first'], reason: 'x' }] }),
      without,
      { facts: noFacts, brief: empty },
    )
    expect(r2).toEqual({ ok: true, suggestions: [], dropped: 1 })
  })
})

describe('suggestTarget', () => {
  it('prices a ready vendor and explains a missing one', () => {
    expect(
      suggestTarget({ vendor: 'claude', model: 'haiku', ready: true, price: (_v, _m, t) => t / 1_000_000 }),
    ).toEqual({ vendor: 'claude', model: 'haiku', tokens: SUGGEST_TOKENS, usd: SUGGEST_TOKENS / 1_000_000 })
    expect(suggestTarget({ vendor: 'codex', model: null, ready: true })).toEqual({
      vendor: 'codex',
      model: null,
      tokens: SUGGEST_TOKENS,
      usd: null,
    })
    expect(suggestTarget({ vendor: 'claude', model: null, ready: false })).toEqual({
      vendor: null,
      model: null,
      tokens: SUGGEST_TOKENS,
      usd: null,
      reason: SUGGEST_NO_VENDOR_MESSAGE,
    })
  })
})
