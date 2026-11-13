// When the markdown lexer throws, the parser falls back to scanning every line as one paragraph: tagged lines are
// still found and parsing never throws.
import type * as Marked from 'marked'
import { describe, expect, it, vi } from 'vitest'
import { parseFindings } from '@core/findings/parse.ts'

vi.mock('marked', async (importOriginal) => {
  const actual = await importOriginal<typeof Marked>()
  return {
    ...actual,
    lexer: (): never => {
      throw new Error('lexer exploded')
    },
  }
})

describe('lexer failure fallback', () => {
  it('still finds tagged lines, including list items', () => {
    const r = parseFindings(['- [must] a', '  detail', '[should] b', 'prose'].join('\n'), 'review')
    expect(r.parse.status).toBe('ok')
    expect(r.findings.map((f) => [f.severity, f.title, f.body])).toEqual([
      ['must', 'a', 'detail'],
      ['should', 'b', 'prose'],
    ])
  })

  it('treats untagged text as unstructured', () => {
    const r = parseFindings('- just a remark', 'critic')
    expect(r.parse.status).toBe('unstructured')
    expect(r.findings).toHaveLength(1)
  })
})
