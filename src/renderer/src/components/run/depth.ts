// Adaptive depth in the Run view: the header's short fact ("Quick", "Thorough") and its tooltip (core's reason, and why
// a Quick run switched to thorough checks). Core decides; this only words it (no em dashes).
import type { RunDepthView } from '@shared/depth.ts'
import { DEPTH_LABEL, DEPTH_SUMMARY } from '@shared/depth.ts'

/** The header's fact: "Quick", "Quick, then thorough checks", "Thorough" or "Profile's own passes". */
export function depthFact(d: RunDepthView): string {
  if (d.source === 'profile') return "Profile's own passes"
  if (d.depth === 'direct' && d.escalated !== undefined) return 'Quick, then thorough checks'
  return DEPTH_LABEL[d.depth]
}

/** The fact's tooltip: what the depth runs and why, and the escalation. */
export function depthTitle(d: RunDepthView): string {
  const what = d.source === 'profile' ? d.reason : `${DEPTH_SUMMARY[d.depth]}. ${d.reason}`
  return d.escalated !== undefined
    ? `${what} A check failed (${d.escalated}), so a second reviewer joined and Fix repeats until the checks pass.`
    : what
}
