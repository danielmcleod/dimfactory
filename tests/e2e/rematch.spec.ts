// Rematch, start to finish in the app: a run finishes in the folder, its Re-run menu opens the Rematch page, the
// challenger builds from the folder as it was when the run began, the Match page compares the recorded original with
// the new build, a pick marks a result without applying anything, and a side's changes are saved as a patch. Both
// builders are the fake Claude; the second build writes one more line, so the results differ.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { auditScreen } from './git-helpers.ts'
import { worktreeOf } from './isolated-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

const SECOND = {
  path: VERSION_WRITE.path,
  content: `${VERSION_WRITE.content}export const built = "second"\n`,
}

test('Rematch: replay a finished run, compare, pick without applying, save a patch', async ({ e2e }) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: VERSION_WRITE },
        { recording: 'C08a-session-id-implement', write: SECOND },
      ],
    },
    config: { gates: { afterPlan: false, beforeFix: false }, isolation: { worktree: { install: 'never' } } },
  })
  const folder = e2e.sandbox

  // ---- the original run, in the folder ----
  const run = await e2e.runFromDashboard('add a --version flag')
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(readFileSync(join(folder, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
  // The folder moves on.
  writeFileSync(join(folder, 'written-later.txt'), 'after the run\n')

  // ---- its Re-run menu leads to the Rematch page ----
  await page.getByTestId('rerun-menu').first().click()
  await page.getByTestId('rerun-rematch').click()
  await expect(page).toHaveURL(new RegExp(`#/rematch/${run.runId}$`))
  await expect(page.getByTestId('rematch-run')).toHaveText(`Run #${run.displayNo}`)
  await expect(page.getByTestId('rematch-original')).toContainText('Built by Claude')
  await expect(page.getByTestId('rematch-task')).toHaveText('add a --version flag')
  await expect(page.getByTestId('rematch-blocked')).toHaveText('')
  // Claude has run here, so nothing has to be agreed to.
  await expect(page.getByTestId('rematch-vendor-note')).toHaveText(
    'This vendor has run in this project before.',
  )
  await expect(page.getByTestId('rematch-start')).toBeEnabled()
  await auditScreen(page, 'Rematch page')

  // ---- start: the Match page, as a rematch ----
  await page.getByTestId('rematch-start').click()
  await expect(page).toHaveURL(/#\/matches\/[^/]+$/)
  const matchId = /#\/matches\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rematch')
  await expect(page.getByTestId('match-status')).toHaveText(
    'Both results are in. Pick the one you prefer, or neither.',
    { timeout: 240_000 },
  )
  await expect(page.getByTestId('match-run-a')).toContainText('the original, as it was recorded')
  await expect(page.getByTestId('match-then-now')).toBeVisible()
  const view = await e2e.call('matches.get', { matchId })
  expect(view.sides[0].runId).toBe(run.runId)
  const bId = view.sides[1].runId ?? ''
  // Built from where the run began: none of what the folder got since.
  const copy = worktreeOf(e2e, bId)
  expect(readFileSync(join(copy, VERSION_WRITE.path), 'utf8')).toBe(SECOND.content)
  expect(existsSync(join(copy, 'written-later.txt'))).toBe(false)

  // ---- the two results against each other ----
  const file = page.getByTestId(`match-file-${VERSION_WRITE.path}`)
  await file.getByRole('button').first().click()
  await expect(file).toContainText('built = "second"', { timeout: 30_000 })

  // ---- a pick marks the result and applies nothing ----
  await page.getByTestId('match-keep-b').click()
  await expect(page.getByTestId('match-kept-b')).toHaveText('Your pick')
  await expect(page.getByTestId('match-status')).toContainText('You picked Side B. Nothing was applied')
  expect(readFileSync(join(folder, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)

  // ---- its changes as a patch ----
  await page.getByTestId('match-patch-b').click()
  const savedLine = page.getByTestId('match-patch-saved')
  await expect(savedLine).toContainText("Saved Side B's changes as a patch:")
  const path = (await savedLine.getAttribute('title')) ?? ''
  expect(readFileSync(path, 'utf8')).toContain('+export const built = "second"')
  await auditScreen(page, 'Match page of a rematch after a pick')

  // ---- the new build's own page offers no Apply, and says it is a rematch's side ----
  await page.getByTestId('match-run-b').click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${bId}$`))
  await expect(page.getByTestId(`match-link-${bId}`)).toContainText('Rematch: side b')
  await expect(page.getByTestId('card-finalize')).toHaveCount(0)
  await page.getByTestId('run-tab-diff').click()
  await expect(page.getByTestId('diff-rematch-not-applied')).toContainText(
    'A rematch’s result is not applied',
  )
  await expect(page.getByTestId('diff-apply-panel')).toHaveCount(0)
  // No "not applied" warning on it anywhere: that is how a rematch's side is meant to stay.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`match-chip-${bId}`)).toBeVisible()
  await expect(page.getByTestId(`isolated-chip-${bId}`)).toHaveCount(0)
  await auditScreen(page, 'Dashboard after a rematch')
})
