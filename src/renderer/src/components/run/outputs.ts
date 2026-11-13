// Pass outputs for the Run view (runs.output: plan.md, plan.original.md, review.md, critic.md and core's parsed
// findings.json). One request per (run, file, key) is shared by every component that
// asks, so the Plan card and the SummaryBar read plan.original once. NOT_FOUND is an answer here: no
// plan.original.md means the plan was not edited.
import { useEffect, useState } from 'react'
import type { RunOutput } from '@shared/ipc.ts'
import type { RunOutputFile } from '@shared/run.ts'
import { invoke } from '../../ipc/client.ts'

export type OutputState =
  | { status: 'loading' }
  | { status: 'ready'; output: RunOutput }
  | { status: 'missing' }
  | { status: 'error'; message: string }

const LOADING: OutputState = { status: 'loading' }
const OFF: OutputState = { status: 'missing' }

/** Keeps only recent answers; outputs are small (a plan, a review) but a session may open many runs. */
const CACHE_MAX = 40
const cache = new Map<string, Promise<OutputState>>()

function load(runId: string, file: RunOutputFile, key: string): Promise<OutputState> {
  const id = `${runId}\u0000${file}\u0000${key}`
  let p = cache.get(id)
  if (p === undefined) {
    p = invoke('runs.output', { runId, file }).then((r): OutputState => {
      if (r.ok) return { status: 'ready', output: r.value }
      if (r.error.code === 'NOT_FOUND') return { status: 'missing' }
      // Errors are not cached: the next mount asks again.
      cache.delete(id)
      return { status: 'error', message: r.error.message }
    })
    cache.set(id, p)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
  return p
}

/**
 * A run's text output. `key` names the version the caller expects (it changes when core may have rewritten the
 * file, e.g. after the plan gate closed); with `enabled` false nothing is read and the state is `missing`.
 */
export function useRunOutput(runId: string, file: RunOutputFile, key: string, enabled = true): OutputState {
  const id = `${runId}\u0000${file}\u0000${key}`
  const [state, setState] = useState<{ id: string; value: OutputState }>({ id: '', value: LOADING })
  useEffect(() => {
    if (!enabled) return
    let live = true
    void load(runId, file, key).then((value) => {
      if (live) setState({ id, value })
    })
    return () => {
      live = false
    }
  }, [runId, file, key, enabled, id])
  if (!enabled) return OFF
  return state.id === id ? state.value : LOADING
}

/** Tests: forget every cached answer. */
export function clearOutputCache(): void {
  cache.clear()
}
