// The diff segments diff.files / diff.file read (diffs: implement S0..S1, fix F0..S2, combined
// S0..last): where each starts and ends in a run's snapshots, which a run has, and that undo points (pre-revert,
// resume) never end the Combined segment.
import { describe, expect, it } from 'vitest'
import {
  availableSegments,
  lastResultSnapshot,
  missingSegmentText,
  segmentEnds,
} from '@core/supervisor/diff-segments.ts'
import type { RunState, SnapshotLabel, SnapshotRef } from '@core/supervisor/types.ts'
import { Harness } from '../supervisor/helpers.ts'

const ref = (label: SnapshotLabel, at: number): SnapshotRef => ({
  label,
  commit: `c-${label}`,
  tree: `t-${label}`,
  at,
})

function runWith(...refs: SnapshotRef[]): RunState {
  const s = structuredClone(new Harness().state)
  for (const r of refs) s.snapshots[r.label] = r
  return s
}

describe('diff segments (diff.files / diff.file)', () => {
  it('a run that has not reached S0 has none', () => {
    const s = runWith(ref('run-start', 1))
    expect(availableSegments(s)).toEqual([])
    for (const seg of ['implement', 'fix', 'combined'] as const) expect(segmentEnds(s, seg)).toBeUndefined()
  })

  it('Implement done: implement and combined are S0..S1; fix waits for F0 and S2', () => {
    const s = runWith(ref('run-start', 1), ref('S0', 2), ref('S1', 3), ref('post-review', 4))
    expect(segmentEnds(s, 'implement')).toEqual({ from: ref('S0', 2), to: ref('S1', 3) })
    // post-review should equal S1; as the later of the two it ends Combined.
    expect(segmentEnds(s, 'combined')).toEqual({ from: ref('S0', 2), to: ref('post-review', 4) })
    expect(segmentEnds(s, 'fix')).toBeUndefined()
    expect(availableSegments(s)).toEqual(['implement', 'combined'])
  })

  it('Fix done: fix is F0..S2 and combined S0..S2; later undo points do not end Combined', () => {
    const s = runWith(
      ref('S0', 2),
      ref('S1', 3),
      ref('fix-start', 5),
      ref('S2', 6),
      ref('pre-revert', 7),
      ref('resume', 8),
    )
    expect(segmentEnds(s, 'fix')).toEqual({ from: ref('fix-start', 5), to: ref('S2', 6) })
    expect(segmentEnds(s, 'combined')).toEqual({ from: ref('S0', 2), to: ref('S2', 6) })
    expect(lastResultSnapshot(s)).toEqual(ref('S2', 6))
    expect(availableSegments(s)).toEqual(['implement', 'fix', 'combined'])
  })

  it('a run stopped during Implement: combined is S0..stopped, implement has no end', () => {
    const s = runWith(ref('S0', 2), ref('stopped', 9))
    expect(segmentEnds(s, 'combined')).toEqual({ from: ref('S0', 2), to: ref('stopped', 9) })
    expect(segmentEnds(s, 'implement')).toBeUndefined()
  })

  it("the steps' own start and end snapshots come first (a retried Implement)", () => {
    const s = runWith(ref('S0', 2), ref('S1', 3))
    s.steps.implement.startSnap = ref('S0', 2)
    s.steps.implement.endSnap = ref('S1', 10)
    expect(segmentEnds(s, 'implement')).toEqual({ from: ref('S0', 2), to: ref('S1', 10) })
  })

  it('says why a segment is missing, without em dashes', () => {
    for (const seg of ['implement', 'fix', 'combined'] as const) {
      const text = missingSegmentText(seg)
      expect(text).not.toBe('')
      expect(text.includes(String.fromCharCode(0x2014))).toBe(false)
    }
  })
})
