// Head to head, start to finish in the app: the composer's switch and its two sides, Run starting a match and opening
// its page, the names hidden until a pick, the two results compared file by file, keeping one (its changes reach the
// folder), taking the pick back (they leave it again), and keeping neither. Both sides are the fake Claude: two tries
// of one task, the second writing one more line so the results differ.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { auditScreen } from './git-helpers.ts'
import { isolatedConfig, worktreeOf } from './isolated-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

const SECOND = {
  path: VERSION_WRITE.path,
  content: `${VERSION_WRITE.content}export const built = "second"\n`,
}

test('Head to head: compose, compare with names hidden, keep one, undo, keep neither', async ({ e2e }) => {
  test.setTimeout(420_000)
  const page = await e2e.start({
    scenario: {
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: VERSION_WRITE },
        { recording: 'C08a-session-id-implement', write: SECOND },
      ],
    },
    config: isolatedConfig({ install: 'never' }, { gates: { afterPlan: false, beforeFix: false } }),
  })
  const folder = e2e.sandbox

  // ---- the composer: one line, then the two sides on the switch ----
  await expect(page.getByTestId('composer')).toBeVisible()
  await page.getByTestId('composer-folder-input').fill(folder)
  await page.getByTestId('composer-folder-input').press('Enter')
  await page
    .getByTestId('composer-task')
    .fill('add a --version flag to src/cli.ts so that it prints the version')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const row = page.getByTestId('composer-h2h')
  await expect(row).toHaveAttribute('data-on', 'false')
  await expect(page.getByTestId('composer-h2h-sides')).toHaveCount(0)
  const runWidth = (await page.getByTestId('composer-run').boundingBox())?.width
  await page.getByTestId('composer-h2h-switch').click()
  await expect(page.getByTestId('composer-h2h-sides')).toBeVisible()
  // Only Claude is set up here, so both sides are Claude: two tries.
  await expect(page.getByTestId('composer-h2h-vendor-a')).toContainText('Claude')
  await expect(page.getByTestId('composer-h2h-vendor-b')).toContainText('Claude')
  await expect(page.getByTestId('composer-h2h-note')).toContainText('how much two tries differ')
  await page.getByTestId('composer-h2h-blind').click()
  await expect(page.getByTestId('composer-run-status')).toHaveText('Head to head: starts two builds')
  // Run keeps its label and its size.
  expect((await page.getByTestId('composer-run').boundingBox())?.width).toBe(runWidth)
  await auditScreen(page, 'Composer with Head to head on')

  // ---- Run starts the match and opens its page ----
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/matches\/[^/]+$/)
  const matchId = /#\/matches\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  const matchPage = page.getByTestId('match-page')
  await expect(matchPage).toBeVisible()
  await expect(matchPage).toHaveAttribute('data-blind', 'true')
  await expect(page.getByTestId('match-status')).toHaveText('Both sides are built. Keep one, or neither.', {
    timeout: 240_000,
  })

  // ---- names hidden: two results, nothing says who built which ----
  const cards = matchPage.locator('[data-testid^="match-side-"]')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveAttribute('aria-label', 'First result')
  await expect(cards.nth(1)).toHaveAttribute('aria-label', 'Second result')
  await expect(matchPage).not.toContainText('Claude')
  await expect(matchPage.locator('[data-testid^="match-run-"]')).toHaveCount(0)
  const firstSide = ((await cards.nth(0).getAttribute('data-testid')) ?? '').slice(-1) as 'a' | 'b'
  const view = await e2e.call('matches.get', { matchId })
  const runIds = { a: view.sides[0].runId ?? '', b: view.sides[1].runId ?? '' }
  const built = {
    a: readFileSync(join(worktreeOf(e2e, runIds.a), VERSION_WRITE.path), 'utf8'),
    b: readFileSync(join(worktreeOf(e2e, runIds.b), VERSION_WRITE.path), 'utf8'),
  }
  expect([built.a, built.b].sort()).toEqual([VERSION_WRITE.content, SECOND.content].sort())
  expect(existsSync(join(folder, VERSION_WRITE.path))).toBe(false)

  // ---- where they differ: one file, both changed it, put against each other on a click ----
  const file = page.getByTestId(`match-file-${VERSION_WRITE.path}`)
  await expect(page.getByTestId('match-group-both')).toContainText(VERSION_WRITE.path)
  await expect(file).toHaveAttribute('data-open', 'false')
  await file.getByRole('button').first().click()
  await expect(file).toHaveAttribute('data-open', 'true')
  await expect(file).toContainText('built = "second"', { timeout: 30_000 })
  await auditScreen(page, 'Match page with the names hidden and a file open')

  // ---- keep the first result: the names come back, its changes are in the folder, the cards stay put ----
  const labelsBefore = await matchPage
    .locator('button[data-testid^="match-keep-"], [data-testid="match-undo"]')
    .allTextContents()
  await page.getByTestId(`match-keep-${firstSide}`).click()
  await expect(page.getByTestId('match-status')).toContainText('is in the folder.')
  await expect(page.getByTestId(`match-kept-${firstSide}`)).toHaveText('In the folder')
  await expect(page.getByTestId(`match-builder-${firstSide}`)).toContainText('Claude')
  await expect(cards.nth(0)).toHaveAttribute('data-testid', `match-side-${firstSide}`)
  expect(readFileSync(join(folder, VERSION_WRITE.path), 'utf8')).toBe(built[firstSide])
  await expect(page.getByTestId('match-keep-none')).toBeDisabled()
  await expect(page.getByTestId('match-undo')).toBeEnabled()
  expect(
    await matchPage
      .locator('button[data-testid^="match-keep-"], [data-testid="match-undo"]')
      .allTextContents(),
  ).toEqual(labelsBefore)
  await auditScreen(page, 'Match page after a pick')

  // ---- undo: the folder is as it was, and the pick is open again ----
  await page.getByTestId('match-undo').click()
  await expect(page.getByTestId('match-status')).toHaveText('Both sides are built. Keep one, or neither.')
  expect(existsSync(join(folder, VERSION_WRITE.path))).toBe(false)

  // ---- keep neither ----
  await page.getByTestId('match-keep-none').click()
  await expect(page.getByTestId('match-status')).toContainText('You kept neither.')
  expect(existsSync(join(folder, VERSION_WRITE.path))).toBe(false)
  for (const id of [runIds.a, runIds.b]) {
    const ended = await e2e.waitForEnd(id)
    expect(ended.worktree).toEqual({ state: 'kept', notApplied: true })
  }

  // ---- each run says it is one side of a match, and leads back to it ----
  await page.getByTestId(`match-run-${firstSide}`).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${runIds[firstSide]}$`))
  const link = page.getByTestId(`match-link-${runIds[firstSide]}`)
  await expect(link).toContainText(`Head to head: side ${firstSide}`)
  await link.click()
  await expect(page).toHaveURL(new RegExp(`#/matches/${matchId}$`))
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId(`match-chip-${runIds.a}`)).toBeVisible()
  await auditScreen(page, 'Dashboard with a match in the recent runs')
})
