// The commit a finished run made (git.commitPreview / git.commit), so "After the run" says it in every place that
// talks about the run's branch. Kept apart from the main store: only the run's end panel reads it.
import { create } from 'zustand'

interface RunGitState {
  commits: Record<string, string>
}

export const useRunGitStore = create<RunGitState>(() => ({ commits: {} }))

export function setRunCommit(runId: string, sha: string): void {
  useRunGitStore.setState((s) => (s.commits[runId] === sha ? s : { commits: { ...s.commits, [runId]: sha } }))
}

/** The sha of the commit this run made, or undefined while it made none (as far as this window knows). */
export function useRunCommit(runId: string): string | undefined {
  return useRunGitStore((s) => s.commits[runId])
}
