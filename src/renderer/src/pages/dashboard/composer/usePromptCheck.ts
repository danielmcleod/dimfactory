// The prompt check for the composer: core's hints for the task as typed (task.check: what it might leave out, with no
// model call, and who could sharpen it), asked again a moment after the task, the folder or the recipe change, with a
// request counter so only the newest answer counts. The last answer stays while the next is on its way, so the line
// changes words once, not twice. Core decides; nothing is checked here. An older core (UNSUPPORTED) leaves it unknown.
import { useEffect, useRef, useState } from 'react'
import type { PromptCheckView } from '@shared/prompt-check.ts'
import { invoke } from '../../../ipc/client.ts'

/** Typing pauses this long before core is asked again. */
export const PROMPT_CHECK_DEBOUNCE_MS = 400

export interface PromptCheckInput {
  folder: string | null
  task: string
  recipe?: string | undefined
}

export interface PromptCheckState {
  /** Core's answer for the latest request that answered (null: none yet, no folder, or not available). */
  view: PromptCheckView | null
  /** The folder the answer is for. */
  folder: string | null
}

const NONE: PromptCheckView = { hints: [], sharpen: null }

export function usePromptCheck({ folder, task, recipe }: PromptCheckInput): PromptCheckState {
  const [state, setState] = useState<PromptCheckState>({ view: null, folder: null })
  const seq = useRef(0)
  const blank = task.trim() === ''
  useEffect(() => {
    const n = ++seq.current
    if (folder === null) return
    // Nothing typed: nothing to ask core about.
    if (blank) {
      setState({ view: NONE, folder })
      return
    }
    const t = setTimeout(() => {
      void invoke('task.check', { folder, task, ...(recipe !== undefined ? { recipe } : {}) }).then((r) => {
        if (seq.current !== n) return
        setState({ view: r.ok ? r.value : null, folder })
      })
    }, PROMPT_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [folder, task, blank, recipe])
  return state
}
