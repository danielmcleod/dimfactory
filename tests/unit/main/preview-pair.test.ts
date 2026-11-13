// The pair window's rules (src/main/preview-model.ts): where its two pages sit in the content area, and its title.
import { describe, expect, it } from 'vitest'
import { PAIR_GAP, PAIR_SIZE, pairBounds, pairTitle } from '../../../src/main/preview-model.ts'

describe('pairBounds', () => {
  it('gives the left half and the right half, the gap between them', () => {
    expect(pairBounds(1601, 780)).toEqual([
      { x: 0, y: 0, width: 800, height: 780 },
      { x: 801, y: 0, width: 800, height: 780 },
    ])
    // The room beside the gap does not halve: the right page takes the odd pixel.
    expect(pairBounds(1600, 780)).toEqual([
      { x: 0, y: 0, width: 799, height: 780 },
      { x: 800, y: 0, width: 800, height: 780 },
    ])
  })

  it('never overlaps, never leaves more than the gap, and fills the height, at every width', () => {
    for (let width = 0; width <= 2400; width++) {
      const [left, right] = pairBounds(width, 600)
      expect(left.x).toBe(0)
      expect(left.width).toBeGreaterThanOrEqual(0)
      expect(right.width).toBeGreaterThanOrEqual(0)
      // The right page starts after the left one and ends at the content area's edge.
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.width)
      expect(right.x + right.width).toBe(width)
      expect(right.x - (left.x + left.width)).toBe(Math.min(PAIR_GAP, width))
      // The halves differ by one pixel at most.
      expect(Math.abs(right.width - left.width)).toBeLessThanOrEqual(1)
      for (const r of [left, right]) expect([r.y, r.height]).toEqual([0, 600])
    }
  })

  it('gives empty pages, never a negative size, for a content area with no room', () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 }
    expect(pairBounds(0, 0)).toEqual([empty, empty])
    expect(pairBounds(-40, -10)).toEqual([empty, empty])
    expect(pairBounds(Number.NaN, Number.POSITIVE_INFINITY)).toEqual([empty, empty])
    expect(pairBounds(1, 5)).toEqual([
      { x: 0, y: 0, width: 0, height: 5 },
      { x: 1, y: 0, width: 0, height: 5 },
    ])
    expect(pairBounds(2, 5)).toEqual([
      { x: 0, y: 0, width: 0, height: 5 },
      { x: 1, y: 0, width: 1, height: 5 },
    ])
  })

  it('works in whole pixels', () => {
    expect(pairBounds(1000.9, 500.5)).toEqual([
      { x: 0, y: 0, width: 499, height: 500 },
      { x: 500, y: 0, width: 500, height: 500 },
    ])
  })

  it("splits the window's own size into two pages of a usable width", () => {
    const [left, right] = pairBounds(PAIR_SIZE.width, PAIR_SIZE.height)
    expect(left.width).toBeGreaterThanOrEqual(640)
    expect(right.width).toBeGreaterThanOrEqual(640)
  })
})

describe('pairTitle', () => {
  it('names the left page, then the right one, as a preview window', () => {
    expect(pairTitle(['Claude', 'Codex'])).toBe('Preview: Claude | Codex')
    expect(pairTitle(['  Side A ', ' Side B  '])).toBe('Preview: Side A | Side B')
  })
})
