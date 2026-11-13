// After a queued task's work was committed on its run branch: back to the branch the run started from, so the next
// task starts from there. Only when HEAD is still on the run branch (a branch you moved to yourself is left alone),
// with `git switch` (it refuses rather than overwrite a change of yours: the queue then pauses with git's words).
// No hook of yours runs.
import type { RunBranchInfo } from '../../shared/run.ts'
import { readHead } from '../git/branch.ts'
import { runGit } from '../git/exec.ts'
import { gitConfigPath } from '../git/shadow.ts'
import { errorMessage } from '../errors.ts'

export async function switchBack(o: {
  folder: string
  branch: RunBranchInfo
  hooksPath: string
}): Promise<void> {
  const head = await readHead(o.folder)
  if (head.ref !== `refs/heads/${o.branch.name}`) return
  const prev = o.branch.previous
  const target = prev.startsWith('refs/heads/')
    ? ['switch', '--no-guess', prev.slice('refs/heads/'.length)]
    : prev.startsWith('detached:')
      ? ['switch', '--detach', prev.slice('detached:'.length)]
      : null
  if (target === null) throw new Error(`Dim Factory does not know where the run started (${prev}).`)
  try {
    await runGit(['-c', `core.hooksPath=${gitConfigPath(o.hooksPath)}`, ...target], {
      cwd: o.folder,
      category: 'git_state',
    })
  } catch (err) {
    throw new Error(`git could not go back to ${target.at(-1) ?? ''}: ${errorMessage(err)}`, { cause: err })
  }
}
