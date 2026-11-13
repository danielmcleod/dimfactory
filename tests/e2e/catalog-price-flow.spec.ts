// Flow ("approve a price update"; the done-check: a tester who hasn't read the docs completes the flow using
// only in-app text; the catalog refresh, the Dashboard right rail's "catalog consent card" and Settings → Catalog).
// Driven the way a tester would, by what the screen says:
// roles, names and visible text, never test ids. The shipped prices are 15 days old (the setup moves e2e.clock), so the
// Dashboard asks whether to update them, saying who reads the pages and that it cannot change files. The tester
// starts the update, waits for it, opens the review, reads why some rows start unticked, applies the one change that
// is ticked and sees the new price in the table and the change in the history.
import { expect, test } from './harness.ts'
import { advanceClock, toasts } from './attention-helpers.ts'
import {
  DAY_MS,
  E21_PROPOSAL,
  INTERVAL_DAYS,
  loadRefreshConverter,
  refreshProcs,
  storedPrice,
  withRefreshes,
} from './catalog-helpers.ts'

test('Flow: approve a price update, using only in-app text', async ({ e2e }) => {
  test.setTimeout(240_000)
  await loadRefreshConverter()
  const page = await e2e.start({ editScenario: withRefreshes([{ proposal: E21_PROPOSAL, holdMs: 3_000 }]) })
  await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)

  // ---- the Dashboard asks: who reads the price pages, that it cannot change files, what it costs ----
  const ask = page.getByRole('region', { name: 'Model prices may be out of date' })
  await expect(ask).toBeVisible({ timeout: 30_000 })
  await expect(ask).toContainText("A model can read the vendors' price pages and propose new prices.")
  await expect(ask).toContainText('You review them before anything changes.')
  await expect(ask).toContainText('Claude (sonnet): read-only, web search, cannot change files')
  await expect(ask).toContainText(/~\d+ min · ≈\$\d+\.\d\d/)
  await expect(ask.getByRole('button', { name: 'Not now (7 days)' })).toBeVisible()
  await expect(ask.getByRole('button', { name: 'Turn off' })).toBeVisible()
  await ask.getByRole('button', { name: 'Update now' }).click()

  // ---- it runs, then says changes are ready, and that nothing changes until they are applied ----
  const working = page.getByRole('region', { name: 'Updating model prices' })
  await expect(working).toContainText('Claude (sonnet) is reading the price pages')
  const ready = page.getByRole('region', { name: 'Price changes to review' })
  await expect(ready).toContainText('ready to review', { timeout: 60_000 })
  await expect(ready).toContainText('Nothing changes until you apply them.')
  await ready.getByRole('link', { name: 'Review changes' }).click()

  // ---- the review: what each row changes and why the flagged ones start unticked ----
  const review = page.getByRole('region', { name: 'Review the update' })
  await expect(review).toContainText('Nothing changes until you apply the rows you tick.')
  const table = review.getByRole('table', { name: 'Proposed price changes' })
  await expect(table).toBeVisible({ timeout: 20_000 })
  await expect(review).toContainText('Rows with a flag start unticked.')
  const opus = table.getByRole('checkbox', { name: 'Apply claude-opus-5-5 Output' })
  const sonnet = table.getByRole('checkbox', { name: 'Apply claude-sonnet-5-5 Input' })
  const haiku = table.getByRole('checkbox', { name: 'Apply claude-haiku-4-5-20251001 Output' })
  await expect(opus).toBeChecked()
  await expect(sonnet).not.toBeChecked()
  await expect(haiku).not.toBeChecked()
  const rowOf = (name: string) =>
    table.getByRole('row').filter({ has: page.getByRole('checkbox', { name, exact: true }) })
  const sonnetRow = rowOf('Apply claude-sonnet-5-5 Input')
  await expect(sonnetRow).toContainText('Over 50%')
  await expect(sonnetRow.getByText('Over 50%')).toHaveAttribute(
    'title',
    'The price changes by more than 50%, so the row starts unticked.',
  )
  await expect(rowOf('Apply claude-haiku-4-5-20251001 Output')).toContainText('Suspicious')
  await expect(review).toContainText('Not confirmed on an official page, so left as they are:')
  await expect(review.getByRole('button', { name: 'Apply 1 change' })).toBeEnabled()

  // ---- apply the ticked change ----
  await review.getByRole('button', { name: 'Apply 1 change' }).click()
  const done = toasts(page).filter({ hasText: 'Prices updated' })
  await expect(done).toBeVisible()
  await expect(done.getByRole('button', { name: 'Undo' })).toBeVisible()

  // ---- the new price is in the table, the change in the history ----
  const prices = page.getByRole('region', { name: 'Prices' })
  const opusPrices = prices.getByRole('row', { name: /claude-opus-5-5/ })
  await expect(opusPrices).toContainText('$25.00')
  await expect(opusPrices).toContainText('Verified')
  const history = page.getByRole('region', { name: 'Update history' })
  await expect(history).toContainText('AI update')
  await expect(history.getByRole('button', { name: 'Undo the last change' })).toBeVisible()

  // What the tester saw is what happened: one refresh ran; Opus's output price is $25, Sonnet's input unchanged.
  expect(refreshProcs(e2e)).toHaveLength(1)
  expect(storedPrice(e2e, 'claude-opus-5-5')).toMatchObject({ outputPerMTok: 25 })
  expect(storedPrice(e2e, 'claude-sonnet-5-5')).toMatchObject({ inputPerMTok: 2 })
  expect(e2e.pageErrors).toEqual([])
})
