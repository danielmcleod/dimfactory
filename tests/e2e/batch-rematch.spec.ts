// A batch rematch and the Scoreboard, in the app: a finished run is queued as a rematch against another model (what the
// Dashboard's new-model card does), the Queue page shows it as a rematch and starts it, its row links to the comparison
// (names hidden, as queued rematches are), and after a pick the Plops page's Scoreboard lists the match and says that
// one match is not enough to tell. Both builders are the fake Claude.
import { expect, test } from './harness.ts'
import { auditScreen } from './git-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

const SECOND = {
  path: VERSION_WRITE.path,
  content: `${VERSION_WRITE.content}export const built = "second"\n`,
}

test('Batch rematch through the queue, then the Scoreboard', async ({ e2e }) => {
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

  // ---- a finished run to replay ----
  const run = await e2e.runFromDashboard('add a --version flag')
  expect((await e2e.waitForEnd(run.runId)).status).toBe('completed')

  // ---- the batch, as the new-model card would queue it ----
  const challenger = { vendor: 'claude', model: 'opus' }
  const plan = await e2e.call('matches.batchPlan', { challenger })
  expect(plan.items.map((i) => i.runId)).toEqual([run.runId])
  expect(await e2e.call('matches.batchAdd', { challenger, runIds: [run.runId] })).toEqual({
    added: 1,
    skipped: 0,
  })

  // ---- the Queue page: a rematch among the tasks, started by the queue ----
  await page.getByTestId('nav-queue').click()
  await expect(page.getByTestId('queue-page')).toBeVisible()
  const folder = page.getByTestId('queue-folder')
  const row = folder.locator('[data-testid^="queue-task-t"][data-status]').first()
  await expect(row).toHaveAttribute('data-status', 'pending')
  await expect(row.getByTestId('queue-task-facts')).toContainText(
    `Rematch of run #${run.displayNo} against Claude (opus)`,
  )
  await auditScreen(page, 'Queue page with a rematch queued')
  await folder.getByTestId('queue-toggle').click()
  await expect(row).toHaveAttribute('data-status', 'done', { timeout: 240_000 })

  // ---- its row leads to the comparison, names hidden ----
  await row.getByTestId('queue-task-match').click()
  await expect(page).toHaveURL(/#\/matches\/[^/]+$/)
  const matchId = /#\/matches\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rematch')
  await expect(page.getByTestId('match-page')).toHaveAttribute('data-blind', 'true')
  await expect(page.getByTestId('match-status')).toHaveText(
    'Both results are in. Pick the one you prefer, or neither.',
  )
  const first = page.getByTestId('match-page').locator('[data-testid^="match-side-"]').first()
  await first.locator('button[data-testid^="match-keep-"]').click()
  await expect(page.getByTestId('match-status')).toContainText('Nothing was applied')

  // ---- the Scoreboard on the Plops page ----
  await page.getByTestId('nav-plops').click()
  const board = page.getByTestId('plops-scoreboard')
  await expect(board).toBeVisible()
  await expect(board.getByTestId('scoreboard-row')).toHaveCount(2)
  await expect(board.getByTestId('scoreboard-row').first()).toContainText(
    'Not enough to tell (1 of 5 matches)',
  )
  await expect(board.getByTestId(`scoreboard-match-${matchId}`)).toContainText('add a --version flag')
  await expect(board.getByTestId('scoreboard-suggestions')).toContainText('No suggestion yet')
  await board.scrollIntoViewIfNeeded()
  await auditScreen(page, 'Plops page with the Scoreboard')
  await board.getByTestId(`scoreboard-match-${matchId}`).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`#/matches/${matchId}$`))
})
