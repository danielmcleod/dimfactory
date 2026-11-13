// Kill-during-apply child ("kill during apply -> idempotent Finish"): runs
// git/finalize applyRun on the target given as JSON in argv[2], prints `STOPPED <step>` once the apply reaches the
// step named in argv[3] and then waits forever, so the test can kill this process right there.
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'src', 'core', 'git')
const { configureGit } = await import(pathToFileURL(join(src, 'exec.ts')).href)
const { applyRun } = await import(pathToFileURL(join(src, 'finalize.ts')).href)

const git = process.env['DIM_FACTORY_TEST_GIT']?.trim()
if (git) configureGit({ executable: git })
const target = JSON.parse(process.argv[2] ?? '{}')
const stopAt = process.argv[3] ?? 'deleted'
await applyRun(target, {
  onStep: async (step) => {
    if (step !== stopAt) return
    process.stdout.write(`STOPPED ${step}\n`)
    await new Promise(() => {})
  },
})
process.stdout.write('FINISHED\n')
