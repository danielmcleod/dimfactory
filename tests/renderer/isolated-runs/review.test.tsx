// Review fixes in the renderer's words (Finalize, Cleanup; the Dashboard chip "Isolated: not applied"; review
// findings 15 and 16): a run that changed no files
// reads "Nothing to apply", never "Kept for later"; the chip's hint names only what the UI offers (the Diff tab's
// Apply to folder…, which now has Discard too).
import { describe, expect, it } from 'vitest'
import { DISCARD_COPY_LABEL, DISCARD_INTERRUPTED } from '@renderer/components/diff/ApplyPanel.tsx'
import {
  ISOLATED_NOT_APPLIED_HINT,
  finalizeInfoOf,
  finalizeStateText,
} from '@renderer/components/run/isolation.ts'
import { ISOLATED_REVERT_REASON } from '@renderer/pages/run/DiffTab.tsx'

const EM_DASH = String.fromCharCode(0x2014)

describe('review words', () => {
  it('a run that changed no files: "Nothing to apply", the copy stays until discarded', () => {
    const info = finalizeInfoOf({ finalize: { state: 'kept', files: 0 } } as never)
    expect(finalizeStateText(info)).toBe(
      'Nothing to apply: the run changed no files. Its isolated copy stays until you discard it.',
    )
    const kept = finalizeInfoOf({ finalize: { state: 'kept', files: 2 } } as never)
    expect(finalizeStateText(kept)).toBe(
      'Kept for later: the isolated copy stays until you apply or discard it.',
    )
  })

  it('the chip hint names the Diff tab only (the Finalize card is gone once kept)', () => {
    expect(ISOLATED_NOT_APPLIED_HINT).not.toContain('Finalize card')
    expect(ISOLATED_NOT_APPLIED_HINT).toContain('Diff tab')
  })

  it('no em dash in the new words', () => {
    for (const t of [
      DISCARD_COPY_LABEL,
      DISCARD_INTERRUPTED,
      ISOLATED_REVERT_REASON,
      ISOLATED_NOT_APPLIED_HINT,
    ])
      expect(t).not.toContain(EM_DASH)
  })
})
