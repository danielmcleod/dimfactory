// A full run: a full Claude-only run started from the Dashboard — plan gate → Approve →
// Implement (one ask, allowed once) → Review ∥ Critic (Review finds 2 must + 1 should) → Fix (reuses the Implement
// session) → completed "Fixed". The Dashboard shows an active card and a needs-you item while the run waits, and a
// Recent row with the outcome afterwards; the Run view's timeline and summary bar show the statuses and counts, the
// reviewer cards list their own findings, and Copy launch command really writes the clipboard (main grants the
// renderer clipboard writes and nothing else).
import { expect, test } from './harness.ts'
import { FIXED_FLOW } from './scenarios.ts'

test('a full Claude-only run from the Dashboard', { tag: ['@smoke', '@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({ scenario: FIXED_FLOW })

  // ---- Dashboard: folder (typed), task, Run ----
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- Run view: the plan streams, then the gate after Plan ----
  const gate = page.getByTestId('card-gate:afterPlan')
  await expect(gate).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('timeline-node-plan')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('timeline-gate-afterPlan')).toHaveAttribute('data-open', 'true')
  await expect(page.getByTestId('summary-plan')).toHaveText('Plan ready for review')

  // ---- Dashboard while the run waits at the gate: an active card and a needs-you item ----
  await page.keyboard.press('ControlOrMeta+1')
  const card = page.getByTestId(`active-run-${run.runId}`)
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-status', 'waiting')
  await expect(card).toContainText('add a --version flag')
  await expect(card.getByTestId('phase-line')).toContainText('Plan')
  await expect(card.getByRole('link', { name: 'Open', exact: true })).toBeVisible()
  await page.getByTestId('needs-you').getByRole('link', { name: 'Review plan' }).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))

  // ---- Approve → Implement (ask: Allow once) → Review ∥ Critic → Fix → completed ----
  await gate.getByTestId('card-choice-approve').click()
  await expect(gate).toBeHidden()
  const ask = page.getByTestId('ask-panel')
  await expect(ask).toBeVisible({ timeout: 60_000 })
  await expect(ask).toContainText('PowerShell')
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'waiting')
  await ask.getByTestId('ask-allow').click()
  await expect(ask).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  expect(ended.findings).toEqual({ must: 2, should: 1 })

  await expect(page.getByTestId('run-outcome')).toHaveText('Fixed · 2 must · 1 should')
  await expect(page.getByTestId('run-status')).toContainText(/completed/i)
  for (const step of ['plan', 'implement', 'review', 'critic', 'fix'] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('summary-plan')).toHaveText('Plan ✓ approved')
  await expect(page.getByTestId('summary-findings')).toHaveText('2 must · 1 should')
  await expect(page.getByTestId('summary-files')).toHaveText('2 files +2 −0')
  await expect(page.getByTestId('summary-tokens')).toHaveText(/^[\d.]+k tokens$/)
  await expect(page.getByTestId('fix-session-line')).toContainText('Implement session')
  // A pass that finishes while the view is open stays open (UI standard: nothing moves on its own; a card starts
  // collapsed when the view opens on it finished): the Review card lists its findings, the Critic card says it found
  // none. The user collapses and opens a card.
  const review = page.getByTestId('pass-card-review')
  await expect(review.getByTestId('findings-review').locator('li')).toHaveCount(3)
  await expect(review).toContainText('--version prints nothing')
  await review.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(review).not.toContainText('--version prints nothing')
  await review.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(review).toContainText('--version prints nothing')
  const critic = page.getByTestId('pass-card-critic')
  await expect(critic.getByTestId('no-findings-critic')).toHaveText('No findings from Critic.')

  // ---- Copy launch command (Plan ⋯): through the real permission path into the system clipboard ----
  // The developer's clipboard text is put back afterwards, whatever the assertions say.
  const app = e2e.app
  if (app === null) throw new Error('the app is not running')
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await page.getByTestId('pass-menu-plan').click()
    await page.getByTestId('pass-copy-launch').click()
    await expect(page.getByText('Launch command copied to the clipboard')).toBeVisible()
    await expect(page.getByText(/Could not copy/)).toHaveCount(0)
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copied).toContain('--output-format stream-json')
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
  }

  // ---- Dashboard afterwards: no active card, a Recent row with the outcome string ----
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('recent-runs')).toBeVisible()
  await expect(page.getByTestId(`active-run-${run.runId}`)).toHaveCount(0)
  await expect(page.getByTestId(`recent-outcome-${run.runId}`)).toHaveText('Fixed · 2 must · 1 should')
  await expect(page.getByTestId(`recent-run-${run.runId}`)).toHaveAttribute('data-status', 'completed')

  expect(e2e.pageErrors).toEqual([])
})
