// Adaptive depth for the composer: core's decision for the task as typed (depth.decide: Quick or Thorough, and why),
// asked again a moment after the task, the folder, the overrides, the Brief or the recipe change, with a request
// counter so only the newest answer counts. Core decides; nothing is decided here. An older core (UNSUPPORTED) leaves
// it unknown and the composer shows no depth line.
import { useEffect, useRef, useState } from 'react'
import type { BriefInput } from '@shared/brief.ts'
import type { RunOverrides } from '@shared/config-schema.ts'
import type { DepthDecision } from '@shared/depth.ts'
import { invoke } from '../../../ipc/client.ts'
import { overridesForRequest } from './overrides.ts'

/** Typing pauses this long before core is asked again. */
export const DEPTH_DEBOUNCE_MS = 400

export interface DepthInput {
  folder: string | null
  task: string
  overrides: RunOverrides
  brief?: BriefInput | undefined
  recipe?: string | undefined
  /** Bumped by config-changed events. */
  configEpoch: number
}

export interface DepthState {
  /** Core's decision for the latest request that answered (null: none yet, or no folder). */
  decision: DepthDecision | null
  /** The folder the decision is for. */
  folder: string | null
}

export function useDepth({ folder, task, overrides, brief, recipe, configEpoch }: DepthInput): DepthState {
  const [state, setState] = useState<DepthState>({ decision: null, folder: null })
  const seq = useRef(0)
  useEffect(() => {
    if (folder === null) {
      seq.current++
      return
    }
    const n = ++seq.current
    const t = setTimeout(() => {
      const sent = overridesForRequest(overrides)
      void invoke('depth.decide', {
        folder,
        task,
        ...(sent !== undefined ? { overrides: sent } : {}),
        ...(brief !== undefined ? { brief } : {}),
        ...(recipe !== undefined ? { recipe } : {}),
      }).then((r) => {
        if (seq.current !== n) return
        setState(r.ok ? { decision: r.value, folder } : { decision: null, folder })
      })
    }, DEPTH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [folder, task, overrides, brief, recipe, configEpoch])
  return state
}

/**
 * The overrides the composer's checks are asked with: the user's, plus the depth core decided when the user left it to
 * Auto, so the pass rows, the checks and the estimate show the passes the run will have. runs.start gets the user's
 * own overrides (core decides again, the same way). Same input, same object.
 */
export function withDecidedDepth(overrides: RunOverrides, decision: DepthDecision | null): RunOverrides {
  if (overrides.depth !== undefined || decision === null || decision.source !== 'auto') return overrides
  return decision.depth === 'direct' ? { ...overrides, depth: 'direct' } : overrides
}
