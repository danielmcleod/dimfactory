// runs.list pages with a keyset cursor (runs history: 100 per page, Load more appends
// below). A run removed (Remove hides it at once), deleted by retention or started between two pages never makes the
// next page skip or repeat a run; an earlier build's offset cursor still works.
import { describe, expect, it } from 'vitest'
import { filterSummaries, runsCursor } from '../../../src/core/handlers.ts'
import { summary } from './helpers.ts'

/** `n` runs, run n the newest. */
const runs = (n: number): ReturnType<typeof summary>[] =>
  Array.from({ length: n }, (_, i) => summary(i + 1, { createdAt: 1_000 + (i + 1) * 10 }))
const ids = (page: { items: { displayNo: number }[] }): number[] => page.items.map((s) => s.displayNo)

describe('runs.list paging', () => {
  it('a run removed on page 1 before Load more: page 2 starts right after the last row shown', () => {
    const all = runs(150)
    const first = filterSummaries(all, { limit: 100 })
    expect(ids(first)).toEqual(Array.from({ length: 100 }, (_, i) => 150 - i))
    expect(first.nextCursor).toBe(runsCursor(all[50] ?? summary(0)))
    // Remove hides run #145 at once (it leaves the summaries core lists).
    const after = all.filter((s) => s.displayNo !== 145)
    const second = filterSummaries(after, { limit: 100, cursor: first.nextCursor ?? '' })
    expect(ids(second)).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i))
    expect(second.nextCursor).toBeNull()
  })

  it('runs started or deleted between pages neither repeat nor drop one', () => {
    const all = runs(150)
    const first = filterSummaries(all, { limit: 100 })
    const newer = [...all, summary(151, { createdAt: 99_999 }), summary(152, { createdAt: 99_998 })]
    // Retention deleted the two oldest meanwhile.
    const now = newer.filter((s) => s.displayNo > 2)
    const second = filterSummaries(now, { limit: 100, cursor: first.nextCursor ?? '' })
    expect(ids(second)).toEqual(Array.from({ length: 48 }, (_, i) => 50 - i))
  })

  it('the row the cursor names is gone: the page starts at the next older one; filters apply as before', () => {
    const all = runs(10)
    const first = filterSummaries(all, { limit: 3 })
    expect(ids(first)).toEqual([10, 9, 8])
    const without = all.filter((s) => s.displayNo !== 8)
    expect(ids(filterSummaries(without, { limit: 3, cursor: first.nextCursor ?? '' }))).toEqual([7, 6, 5])
    const done = all.map((s) => (s.displayNo % 2 === 0 ? { ...s, status: 'failed' as const } : s))
    const p1 = filterSummaries(done, { limit: 2, status: ['completed'] })
    expect(ids(p1)).toEqual([9, 7])
    expect(
      ids(filterSummaries(done, { limit: 2, status: ['completed'], cursor: p1.nextCursor ?? '' })),
    ).toEqual([5, 3])
  })

  it('a row whose createdAt has a fraction still gives a cursor the next page reads', () => {
    const all = Array.from({ length: 4 }, (_, i) => summary(i + 1, { createdAt: 1_000.25 + (i + 1) * 10 }))
    const first = filterSummaries(all, { limit: 2 })
    expect(ids(first)).toEqual([4, 3])
    expect(ids(filterSummaries(all, { limit: 2, cursor: first.nextCursor ?? '' }))).toEqual([2, 1])
  })

  it("an earlier build's offset cursor is still an offset; anything else starts at the first page", () => {
    const all = runs(5)
    expect(ids(filterSummaries(all, { limit: 2, cursor: '2' }))).toEqual([3, 2])
    expect(ids(filterSummaries(all, { limit: 2, cursor: 'bogus' }))).toEqual([5, 4])
  })
})
