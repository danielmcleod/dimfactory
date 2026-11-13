// Kill during apply ("kill during apply → idempotent Finish"; Apply: the
// journal makes [Finish apply] idempotent after a crash (interruptedApply card); Undo = restore(applied, P); at boot
// "Never auto-resume"). The run changed three files in its isolated copy. The E2E hook (DIM_FACTORY_E2E=1 only:
// `<home>/e2e/apply-hold`) pauses the apply after its first file; the app is killed hard right there, with one file in
// the folder and two still to write. Relaunched, the run offers [Finish apply] and nothing is applied on its own;
// Finish writes the two others without writing the first again (its bytes and time unchanged), the step ends applied
// with all three, Apply's preview now finds nothing left to do, and Undo puts the folder back as it was before the
// apply began (snapshot P, taken before the kill).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { openDiffTab } from './diff-settings-helpers.ts'
import { auditScreen } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'
import {
  applyHold,
  card,
  choose,
  commitSandbox,
  hashes,
  holdApply,
  isolatedConfig,
  mtimeOf,
  releaseApply,
  writeBeforeResult,
} from './isolated-helpers.ts'

const FILES = [
  VERSION_WRITE,
  { path: 'src/a.ts', content: 'export const a = 1\n' },
  { path: 'src/b.ts', content: 'export const b = 2\n' },
] as const
const PATHS = FILES.map((f) => f.path)

test(
  'the app killed during an apply: Finish apply completes it once; Undo restores',
  { tag: '@cross-os' },
  async ({ e2e }) => {
    test.setTimeout(300_000)
    let page = await e2e.start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
      },
      editScenario: (sc) => writeBeforeResult(sc, 'implement-1', FILES.slice(1)),
      config: isolatedConfig({ mode: 'worktree', install: 'never' }),
    })
    commitSandbox(e2e, { 'README.md': '# ts-small\n' })
    const folder = e2e.sandbox
    const before = hashes(folder, PATHS)
    const written = (): string[] =>
      FILES.filter(
        (f) => existsSync(join(folder, f.path)) && readFileSync(join(folder, f.path), 'utf8') === f.content,
      ).map((f) => f.path)

    const run = await e2e.runFromDashboard('add a --version flag')
    await e2e.approvePlan()
    await card(page, 'finalize', 180_000)

    // ---- Apply, held after its first file; then a crash ----
    holdApply(e2e)
    await choose(page, 'finalize', 'apply')
    await expect.poll(written, { timeout: 60_000 }).toHaveLength(1)
    await page.waitForTimeout(1_500)
    const first = written()
    expect(first).toHaveLength(1)
    const firstPath = first[0] ?? ''
    const firstTime = mtimeOf(folder, firstPath)
    await e2e.kill()
    releaseApply(e2e)
    expect(existsSync(applyHold(e2e))).toBe(false)
    expect(written()).toEqual(first)

    // ---- relaunch: nothing resumes on its own; the run offers Finish apply ----
    page = await e2e.launch()
    await page.evaluate((id) => {
      location.hash = `#/runs/${id}`
    }, run.runId)
    await expect(page.getByTestId('run-view')).toBeVisible()
    const interrupted = await card(page, 'interruptedApply', 60_000)
    await expect(interrupted).toContainText('Finish applying the run')
    await expect(interrupted).toContainText('Dim Factory closed while it was applying the run to your folder')
    await auditScreen(page, 'Run view with the interruptedApply card')
    await page.waitForTimeout(2_000)
    expect(written()).toEqual(first)
    const waiting = await e2e.snapshot(run.runId)
    expect(waiting.steps.finalize.finalize?.state).toBe('interrupted')

    // ---- Finish apply: the two others are written, the first is not written again ----
    await choose(page, 'interruptedApply', 'finish-apply')
    const ended = await e2e.waitForEnd(run.runId, 60_000)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(written().sort()).toEqual([...PATHS].sort())
    expect(mtimeOf(folder, firstPath)).toBe(firstTime)
    const state = page.getByTestId('finalize-state')
    await expect(state).toHaveAttribute('data-state', 'applied')
    await expect(state).toHaveText('Applied to your folder (3 files).')

    // ---- idempotent: Apply now has nothing left to do ----
    const preview = await e2e.call('worktree.preview', { runId: run.runId })
    expect(preview.conflicts).toEqual([])
    expect((preview.actions ?? []).map((a) => a.action)).toEqual(['noop', 'noop', 'noop'])
    await openDiffTab(page, run.runId)
    await expect(page.getByTestId('diff-apply-facts')).toHaveText('3 already the same')
    await page.getByTestId('run-tab-flow').click()

    // ---- Undo: the folder as it was before the apply began (P, taken before the crash) ----
    await page.getByTestId('finalize-undo-apply').click()
    await expect(state).not.toHaveAttribute('data-state', 'applied', { timeout: 60_000 })
    await expect.poll(() => hashes(folder, PATHS)).toEqual(before)
    expect(e2e.pageErrors).toEqual([])
  },
)
