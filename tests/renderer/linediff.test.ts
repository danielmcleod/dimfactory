// lib/linediff.ts: Myers line diff → hunks with context and counts (plan gate "Edited · view changes").
import { describe, expect, it } from 'vitest'
import { MAX_EDIT_DISTANCE, diffLines, formatUnified, splitLines } from '@renderer/lib/linediff.ts'

const text = (...lines: string[]): string => `${lines.join('\n')}\n`

describe('diffLines', () => {
  it('reports identical texts (line endings do not count)', () => {
    const d = diffLines('a\nb\n', 'a\r\nb\r\n')
    expect(d).toEqual({ hunks: [], added: 0, removed: 0, identical: true })
  })

  it('finds a single replaced line with three lines of context', () => {
    const a = text('1', '2', '3', '4', '5', '6', '7', '8', '9')
    const b = text('1', '2', '3', '4', 'five', '6', '7', '8', '9')
    const d = diffLines(a, b)
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.hunks).toHaveLength(1)
    expect(formatUnified(d)).toBe(
      ['@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'].join('\n'),
    )
    const h = d.hunks[0]!
    expect(h.lines.find((l) => l.kind === 'del')).toMatchObject({ text: '5', oldNo: 5 })
    expect(h.lines.find((l) => l.kind === 'add')).toMatchObject({ text: 'five', newNo: 5 })
  })

  it('splits distant changes into separate hunks and merges near ones', () => {
    const base = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
    const far = [...base]
    far[1] = 'X'
    far[25] = 'Y'
    expect(diffLines(text(...base), text(...far)).hunks).toHaveLength(2)
    const near = [...base]
    near[1] = 'X'
    near[6] = 'Y'
    expect(diffLines(text(...base), text(...near)).hunks).toHaveLength(1)
  })

  it('handles pure insertions and deletions at the edges', () => {
    expect(formatUnified(diffLines('', 'a\nb\n'))).toBe(['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'))
    expect(formatUnified(diffLines('a\nb\n', ''))).toBe(['@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'))
    const d = diffLines(text('a', 'b'), text('a', 'b', 'c'))
    expect(formatUnified(d)).toBe(['@@ -1,2 +1,3 @@', ' a', ' b', '+c'].join('\n'))
  })

  it('finds a minimal edit script', () => {
    const d = diffLines(text('a', 'b', 'c', 'a', 'b', 'b', 'a'), text('c', 'b', 'a', 'b', 'a', 'c'))
    expect(d.added + d.removed).toBe(5)
  })

  it('reproduces the new text from context + added lines', () => {
    const a = text('# Plan', '', '1. Read', '2. Write', '3. Test', '', 'Done')
    const b = text('# Plan', '', '1. Read the code', '2. Write', '2b. Lint', '3. Test', 'Done', 'Extra')
    const d = diffLines(a, b, { context: 1000 })
    const rebuilt = d.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'del').map((l) => l.text))
    expect(rebuilt).toEqual(splitLines(b))
    const old = d.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'add').map((l) => l.text))
    expect(old).toEqual(splitLines(a))
  })

  it('falls back to a whole replace past the edit budget', () => {
    const n = MAX_EDIT_DISTANCE
    const a = Array.from({ length: n }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: n }, (_, i) => `b${i}`).join('\n')
    const d = diffLines(a, b)
    expect(d.added).toBe(n)
    expect(d.removed).toBe(n)
  })
})
