// Properties: parsing never throws, ids are unique, numbering and statuses are consistent, rendering stays
// within its cap — for arbitrary text and for markdown-shaped noise built from the constructs the parser handles.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mergeFindings, parseFindings, parseFixReport } from '@core/findings/parse.ts'
import type { ParsedSource } from '@core/findings/parse.ts'
import { renderFindingsDetailed } from '@core/findings/render.ts'

const TAGS = [
  'must',
  'MUST',
  'must fix',
  'must-fix',
  'should',
  'blocker',
  'critical',
  'major',
  'nit',
  'minor',
  'consider',
  'could',
  'todo',
]

const fragment = fc.oneof(
  fc.constantFrom(
    '',
    ' ',
    '  ',
    '    ',
    '\t',
    '- ',
    '* ',
    '+ ',
    '1. ',
    '2) ',
    '[ ] ',
    '[x] ',
    '**',
    '*',
    '_',
    '`',
    '```',
    '```md',
    '~~~',
    '> ',
    '# ',
    '### ',
    '---',
    '===',
    '|',
    '<div>',
    '</div>',
    ':',
    ' — ',
    'NO FINDINGS',
    'LGTM',
    '\r',
    '\uFEFF',
    '[',
    ']',
    ']:',
  ),
  fc.constantFrom(...TAGS).map((t) => `[${t}]`),
  fc.constantFrom(...TAGS).map((t) => `[${t}]: `),
  fc.string({ maxLength: 12 }),
)
const mdLine = fc.array(fragment, { maxLength: 8 }).map((parts) => parts.join(''))
const mdText = fc.array(mdLine, { maxLength: 40 }).map((lines) => lines.join('\n'))
const anyText = fc.oneof(mdText, fc.string({ unit: 'binary', maxLength: 400 }), fc.string({ maxLength: 400 }))
const source = fc.constantFrom('review' as const, 'critic' as const)

function checkInvariants(r: ParsedSource): void {
  const ids = r.findings.map((f) => f.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}(-\d+)?$/)
  expect(r.findings.map((f) => f.n)).toEqual(r.findings.map((_, i) => i + 1))
  const firstShould = r.findings.findIndex((f) => f.severity === 'should')
  if (firstShould >= 0) expect(r.findings.slice(firstShould).every((f) => f.severity === 'should')).toBe(true)
  expect(r.parse.count).toBe(r.findings.length)
  for (const f of r.findings) {
    expect(f.source).toBe(r.source)
    expect(f.title).not.toMatch(/\n/)
  }
  switch (r.parse.status) {
    case 'none':
    case 'empty':
    case 'failed':
      expect(r.findings).toEqual([])
      break
    case 'ok':
      expect(r.findings.length).toBeGreaterThan(0)
      expect(r.findings.every((f) => f.flags.length === 0)).toBe(true)
      break
    case 'untagged':
      expect(r.findings.length).toBeGreaterThan(0)
      expect(r.findings.every((f) => f.severity === 'should' && f.flags.includes('untagged'))).toBe(true)
      break
    case 'unstructured':
      expect(r.findings).toHaveLength(1)
      expect(r.findings[0]?.flags).toEqual(['unstructured'])
      break
  }
}

describe('findings properties', () => {
  it('parsing never throws and every finding id is unique', () => {
    fc.assert(
      fc.property(anyText, source, (text, src) => {
        const r = parseFindings(text, src)
        checkInvariants(r)
        expect(parseFindings(text, src)).toEqual(r) // deterministic
      }),
      { numRuns: 1500 },
    )
  })

  it('merging and rendering never throw; merged ids stay unique; rendering stays within the cap', () => {
    fc.assert(
      fc.property(mdText, mdText, fc.integer({ min: 64, max: 4096 }), (a, b, cap) => {
        const merged = mergeFindings([
          parseFindings(a, 'review'),
          parseFindings(b, 'critic'),
          parseFindings(a, 'review'),
        ])
        expect(new Set(merged.map((f) => f.id)).size).toBe(merged.length)
        const r = renderFindingsDetailed(merged, {
          capBytes: cap,
          notes: ['User reverted after review: a.ts'],
        })
        expect(r.bytes).toBeLessThanOrEqual(cap)
        expect(r.bytes).toBe(Buffer.byteLength(r.text, 'utf8'))
        parseFixReport(a)
      }),
      { numRuns: 500 },
    )
  })

  it('a plain tagged bullet list round-trips: one finding per bullet, severity by tag', () => {
    const title = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => /^[A-Za-z0-9`][^\n\r[\]]*$/.test(s))
    const item = fc.record({
      tag: fc.constantFrom(...TAGS.filter((t) => t !== 'todo')),
      title,
      marker: fc.constantFrom('-', '*', '1.'),
    })
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 15 }), (items) => {
        const text = items.map((i) => `${i.marker} [${i.tag}] ${i.title}`).join('\n')
        const r = parseFindings(text, 'review')
        expect(r.parse.status).toBe('ok')
        expect(r.findings).toHaveLength(items.length)
        const isMust = (t: string): boolean =>
          ['must', 'mustfix', 'blocker', 'critical', 'major'].includes(t.toLowerCase().replace(/[\s-]/g, ''))
        expect(r.findings.filter((f) => f.severity === 'must')).toHaveLength(
          items.filter((i) => isMust(i.tag)).length,
        )
        checkInvariants(r)
      }),
      { numRuns: 300 },
    )
  })
})
