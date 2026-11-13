// Conflicts (Apply: a file whose folder content equals neither the run's base nor its new
// version is a conflict → finalizeConflicts [Keep mine] / [Take run's], never overwritten without Take run's; no
// 3-way merge, no conflict markers; Cards finalizeConflicts). The run changes three files in its isolated copy.
// While it runs, the user edits one of them in the folder (at the plan gate), and creates another one just before
// applying. The finalize card names the first; Apply writes the untouched file and leaves both conflicts as the user
// has them; the conflicts card offers each file its own Keep mine / Take run's. Keep mine leaves the user's edit byte
// for byte; Take run's writes the run's version over the other; the step ends applied.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './harness.ts'
import { auditBothSizes, expectSteadyWidth, sha256, trackWidth } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'
import { card, choose, commitSandbox, isolatedConfig, text, writeBeforeResult } from './isolated-helpers.ts'

const INDEX = { path: 'src/index.ts', content: 'export const greeting = "from the run"\n' }
const EXTRA = { path: 'src/extra.ts', content: 'export const extra = true\n' }
const MINE_INDEX = 'export const greeting = "my edit during the run"\n'
const MINE_VERSION = 'export const version = "mine"\n'

function row(c: Locator, path: string): Locator {
  return c.locator(`li[data-path="${path}"]`)
}

test('conflicts: Keep mine leaves the user’s file, Take run’s writes the run’s', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
    },
    editScenario: (sc) => writeBeforeResult(sc, 'implement-1', [INDEX, EXTRA]),
    config: isolatedConfig({ mode: 'worktree', install: 'never' }),
  })
  commitSandbox(e2e, { 'README.md': '# ts-small\n' })
  const folder = e2e.sandbox

  const run = await e2e.runFromDashboard('add a --version flag')
  // ---- during the run: the user edits a file the run also changes ----
  await card(page, 'gate:afterPlan', 90_000)
  writeFileSync(join(folder, INDEX.path), MINE_INDEX)
  await e2e.approvePlan()

  // ---- the finalize card names the file that changed in the folder too ----
  const fin = await card(page, 'finalize', 180_000)
  await expect(fin).toContainText('changed 3 files there')
  await expect(fin).toContainText('1 file also changed in your folder since the run started (src/index.ts)')
  // ...and the user creates the run's new file in the folder before applying.
  writeFileSync(join(folder, VERSION_WRITE.path), MINE_VERSION)
  await choose(page, 'finalize', 'apply')

  // ---- Apply wrote the untouched file and left both conflicts as they are ----
  const conflicts = await card(page, 'finalizeConflicts', 60_000)
  await expect(conflicts.getByRole('heading')).toHaveText('2 files changed in your folder too')
  await expect(row(conflicts, INDEX.path)).toBeVisible()
  await expect(row(conflicts, VERSION_WRITE.path)).toBeVisible()
  expect(text(folder, EXTRA.path)).toBe(EXTRA.content)
  expect(text(folder, INDEX.path)).toBe(MINE_INDEX)
  expect(text(folder, VERSION_WRITE.path)).toBe(MINE_VERSION)
  await expect(page.getByTestId('finalize-state')).toHaveAttribute('data-state', 'conflicts')
  // Nothing is chosen on its own (no default, Auto included): the card waits.
  const open = (await e2e.snapshot(run.runId)).cards.find((c) => c.kind === 'finalizeConflicts')
  expect(open?.defaultChoice).toBeUndefined()
  await auditBothSizes(e2e, page, 'Run view with the finalizeConflicts card')

  // The run's change to a file opens on a click, in the page flow.
  await row(conflicts, INDEX.path).getByRole('button', { name: "Show the run's change" }).click()
  await expect(row(conflicts, INDEX.path).getByTestId('conflict-diff')).toContainText('from the run')

  // ---- Keep mine for src/index.ts: the card stays (same card) with the other file ----
  const mineBytes = sha256(join(folder, INDEX.path))
  const id = await conflicts.getAttribute('data-card-id')
  await trackWidth(page, 'theirs', `li[data-path="${VERSION_WRITE.path}"] button[aria-label^="Take run's"]`)
  await row(conflicts, INDEX.path)
    .getByRole('button', { name: `Keep mine: ${INDEX.path}` })
    .click()
  await expect(row(conflicts, INDEX.path)).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator(`[data-card-id="${id ?? ''}"]`)).toBeVisible()
  expect(sha256(join(folder, INDEX.path))).toBe(mineBytes)

  // ---- Take run's for src/version.ts: the run's version is written over the user's ----
  await row(conflicts, VERSION_WRITE.path)
    .getByRole('button', { name: `Take run's: ${VERSION_WRITE.path}` })
    .click()
  await expect(page.getByTestId('card-finalizeConflicts')).toHaveCount(0, { timeout: 60_000 })
  await expectSteadyWidth(page, 'theirs', "A file's Take run's button")
  expect(readFileSync(join(folder, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  expect(sha256(join(folder, INDEX.path))).toBe(mineBytes)
  expect(text(folder, EXTRA.path)).toBe(EXTRA.content)

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.worktree).toEqual({ state: 'applied', notApplied: false })
  await expect(page.getByTestId('finalize-state')).toHaveAttribute('data-state', 'applied')
  const s = await e2e.snapshot(run.runId)
  expect(s.notes).toContain(`Kept your version of ${INDEX.path}.`)
  expect(e2e.pageErrors).toEqual([])
})
