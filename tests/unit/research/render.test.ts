// Research's renderings: research.md (every section, the dropped line) and `{{research}}` for the Plan prompt (only
// the kept features, standards and recommendations, the risks, the answered questions; empty when nothing was kept).
import { describe, expect, it } from 'vitest'
import type { ResearchResult } from '@shared/research.ts'
import { renderResearchMd, researchForPlan } from '@core/research/render.ts'

const R: ResearchResult = {
  summary: ['Version flags are table stakes.'],
  features: [
    { id: 'f1', feature: 'Print the version', priority: 'must', sources: ['https://clig.dev/'] },
    { id: 'f2', feature: 'A | pipe', priority: 'could', sources: ['https://clig.dev/'] },
  ],
  standards: [
    { id: 's1', standard: 'GNU --version', why: 'Scripts parse it', sources: ['https://gnu.org/x'] },
  ],
  options: [
    {
      id: 'o1',
      topic: 'Source of the version',
      options: ['package.json', 'constant'],
      recommendation: 'package.json',
      rationale: 'One source of truth',
      sources: ['repo:package.json'],
    },
  ],
  risks: [{ id: 'r1', risk: 'Stale bundles', sources: ['https://example.org/a'] }],
  questions: [
    { id: 'q1', question: 'Print the commit too?' },
    { id: 'q2', question: 'Support -V?' },
  ],
  sources: [{ url: 'https://clig.dev/', title: 'CLI Guidelines' }, { url: 'repo:package.json' }],
  dropped: 2,
}

describe('research.md', () => {
  it('renders every section with its sources, the lenses, and the dropped claims', () => {
    const md = renderResearchMd(R, { lenses: [{ label: 'Comparable products', web: true }], web: true })
    for (const h of [
      '# Research',
      '## Summary',
      '## Features',
      '## Standards and practices',
      '## Options',
      '### Source of the version',
      '## Risks and pitfalls',
      '## Open questions',
      '## Sources',
    ])
      expect(md).toContain(`${h}\n`)
    expect(md).toContain('Lenses: Comparable products.')
    expect(md).toContain('Web search was on; web content is untrusted input.')
    expect(md).toContain('| Print the version | must | https://clig.dev/ |')
    expect(md).toContain('| A \\| pipe | could |')
    expect(md).toContain('Recommendation: package.json. One source of truth (repo:package.json)')
    expect(md).toContain('- CLI Guidelines: https://clig.dev/')
    expect(md).toContain('2 claims were left out because they cited no source.')
    expect(md.endsWith('\n')).toBe(true)
    const repoOnly = renderResearchMd({ ...R, dropped: 0 }, { lenses: [], web: false })
    expect(repoOnly).toContain('No web search: this repository only.')
    expect(repoOnly).not.toContain('left out')
  })
})

describe('{{research}}', () => {
  it('has only the kept items, the risks and the answered questions', () => {
    const t = researchForPlan(R, ['f2', 'o1'], { q2: '  yes,\n uppercase  ', q1: ' ' })
    expect(t).toContain('Summary:\n- Version flags are table stakes.')
    expect(t).toContain('Features to include:\n- [could] A | pipe (https://clig.dev/)')
    expect(t).not.toContain('Print the version')
    expect(t).not.toContain('Standards and practices')
    expect(t).toContain(
      '- Source of the version: package.json. One source of truth (weighed: package.json, constant) (repo:package.json)',
    )
    expect(t).toContain('Risks research found:\n- Stale bundles (https://example.org/a)')
    expect(t).toContain('- Support -V?\n  Answer: yes, uppercase')
    expect(t).not.toContain('Print the commit too?')
  })

  it('is empty when nothing was kept and nothing answered', () => {
    expect(researchForPlan(R, [], {})).toBe('')
    expect(researchForPlan(R, ['x9'], { q1: '' })).toBe('')
    // An answer alone is something kept.
    expect(researchForPlan(R, [], { q1: 'No' })).toContain('Answer: No')
  })
})
