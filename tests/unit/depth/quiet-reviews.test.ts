// Quieter reviews: which findings go to Fix by default (a [must] with evidence; a [should] with evidence only with Fix
// until green; never a disagreement, a failure from before the run or the AI judge), and two reviewers on the same
// place merged (the same issue) or listed once as a suggestion (a disagreement), each with a note.
import { describe, expect, it } from 'vitest'
import { findingLocation, hasEvidence, triggersFix } from '@shared/findings.ts'
import type { Finding, FindingSource } from '@shared/findings.ts'
import { mergeReviewerFindings, stanceOf, titleSimilarity } from '@core/findings/merge.ts'

let n = 0
function f(
  source: FindingSource,
  severity: Finding['severity'],
  title: string,
  o: Partial<Finding> = {},
): Finding {
  n += 1
  return { id: `f${n}`, n, severity, source, title, body: '', flags: [], round: 1, ...o }
}

describe('evidence', () => {
  it('a file:line in the title or the body', () => {
    expect(findingLocation({ title: '`src/app.ts:12`: wrong total', body: '' })).toEqual({
      file: 'src/app.ts',
      line: 12,
    })
    expect(findingLocation({ title: 'wrong total', body: 'see .\\src\\App.tsx:3:5' })).toEqual({
      file: 'src/app.tsx',
      line: 3,
    })
    expect(findingLocation({ title: '`file:line`: placeholder', body: '' })).toBeUndefined()
    expect(findingLocation({ title: 'Consider more tests', body: '' })).toBeUndefined()
  })

  it('a check Dim Factory ran, or a grounding flag, is evidence by itself', () => {
    for (const s of ['verify', 'tests', 'scan', 'grounding', 'acceptance', 'preview'] as const)
      expect(hasEvidence(f(s, 'must', 'x'))).toBe(true)
    expect(hasEvidence(f('critic', 'must', 'Invented API', { flags: ['grounding'] }))).toBe(true)
    expect(hasEvidence(f('review', 'must', 'Seems wrong'))).toBe(false)
  })
})

describe('triggersFix', () => {
  const at = '`src/a.ts:4`: off by one'
  it.each([
    ['a [must] with a file:line', f('review', 'must', at), false, true],
    ['a [must] without evidence', f('review', 'must', 'Looks fragile'), false, false],
    ['a failing check', f('verify', 'must', '`npm test` failed'), false, true],
    ['a grounding [must]', f('grounding', 'must', 'Claimed tests ran'), false, true],
    ['a [should] with evidence, a single Fix', f('review', 'should', at), false, false],
    ['a [should] with evidence, Fix until green', f('review', 'should', at), true, true],
    ['a [should] without evidence, Fix until green', f('critic', 'should', 'Nicer names'), true, false],
    ['a failure from before the run', f('verify', 'must', 'x', { flags: ['preexisting'] }), true, false],
    ['a disagreement between reviewers', f('review', 'should', at, { flags: ['contradicted'] }), true, false],
    ["the AI judge's note", f('grounding', 'should', 'x', { flags: ['ai-judged'] }), true, false],
  ])('%s', (_name, finding, loop, want) => {
    expect(triggersFix(finding, loop)).toBe(want)
  })
})

describe('two reviewers on the same place', () => {
  it('the same issue twice is listed once, the stronger severity kept, with a note', () => {
    const a = f('review', 'should', '`src/cart.ts:40`: total ignores the discount')
    const b = f('critic', 'must', '`src/cart.ts:40`: the total ignores the discount code')
    const r = mergeReviewerFindings([a, b])
    expect(r.list).toHaveLength(1)
    expect(r.list[0]).toMatchObject({ id: b.id, severity: 'must', n: 1 })
    expect(r.list[0]?.flags).toContain('merged')
    expect(r.list[0]?.body).toContain('Also raised by Review')
    expect(r.notes).toEqual(['Review and Critic raised the same issue at src/cart.ts:40; it is listed once.'])
  })

  it('a disagreement is listed once as a suggestion that never goes to Fix on its own', () => {
    const a = f('review', 'must', '`src/api.ts:9`: missing null check on the user')
    const b = f('critic', 'should', '`src/api.ts:9`: the null check is unnecessary here')
    const r = mergeReviewerFindings([a, b])
    expect(r.list).toHaveLength(1)
    expect(r.list[0]).toMatchObject({ id: a.id, severity: 'should' })
    expect(r.list[0]?.flags).toContain('contradicted')
    expect(r.list[0]?.body).toContain('Critic disagrees')
    expect(triggersFix(r.list[0] as Finding, true)).toBe(false)
    expect(r.notes).toEqual([
      'Review and Critic disagree about src/api.ts:9, so it is listed once as a suggestion and not sent to Fix on its own.',
    ])
  })

  it('different issues at one place, one reviewer twice, or no place: all kept as they are', () => {
    const list = [
      f('review', 'must', '`src/a.ts:1`: race on the cache'),
      f('critic', 'should', '`src/a.ts:1`: the logger name is confusing'),
      f('review', 'should', '`src/a.ts:1`: race again'),
      f('critic', 'must', 'Unclear ownership'),
      f('verify', 'must', '`src/a.ts:1`: tests fail'),
    ]
    const r = mergeReviewerFindings(list)
    expect(r.list).toHaveLength(5)
    expect(r.notes).toEqual([])
    // Numbered again, must first.
    expect(r.list.map((x) => x.severity)).toEqual(['must', 'must', 'must', 'should', 'should'])
    expect(r.list.map((x) => x.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('stance and likeness are read from the words', () => {
    expect(stanceOf('Add input validation')).toBe('want')
    expect(stanceOf('Remove the redundant validation')).toBe('drop')
    expect(stanceOf('Off by one')).toBeUndefined()
    expect(titleSimilarity('total ignores discount', 'the total ignores the discount code')).toBeGreaterThan(
      0.5,
    )
    expect(titleSimilarity('race on the cache', 'logger name is confusing')).toBe(0)
  })
})
