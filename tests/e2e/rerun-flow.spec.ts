// Flow ("re-run a failed run from Fix"; the done-check: a tester who hasn't read the docs completes the flow
// using only in-app text; Sessions' Re-run from Fix; the Run view's [Re-run ▾]). Driven the way a tester would, by
// what the screen says: roles, names and visible text,
// never test ids. The tester starts a run from the Dashboard and approves its plan; Review finds two must-fix issues
// and a should, and Fix fails (the vendor's login expired). From the failed run's Re-run menu, Re-run from Fix says Fix
// would continue the Implement session; it opens the findings picker, which says the failed run is stopped when the
// new run starts and what Fix will receive. Started, the new run goes straight to Fix, which continues Implement's
// session and fixes the issues; the failed run is now cancelled.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { fakeProc, stepSessionId } from './attention-helpers.ts'
import { FAILED_FIX, NO_GATES, RESUMED_FIX, findingsFlow } from './history-helpers.ts'
import { FIX_WRITE } from './scenarios.ts'

test('Flow: re-run a failed run from Fix, using only in-app text', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: findingsFlow([FAILED_FIX, RESUMED_FIX]) })

  // ---- the Dashboard: the project, the task, Run; then the plan ----
  const where = page.getByRole('textbox', { name: 'Folder', exact: true })
  await where.fill(e2e.sandbox)
  await where.press('Enter')
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('add a --version flag')
  const run = page.getByRole('button', { name: 'Run', exact: true })
  await expect(run).toBeEnabled({ timeout: 30_000 })
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const source = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await gate.getByRole('button', { name: 'Approve' }).click({ timeout: 90_000 })
  await expect(gate).toBeHidden()

  // ---- Fix fails: the run says so ----
  await expect(page.getByText(/^failed$/i).first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Failed at Fix', { exact: false }).first()).toBeVisible()

  // ---- Re-run ▾ → Re-run from Fix: whether Fix continues the Implement session, then the findings picker ----
  await page.getByRole('button', { name: 'Re-run', exact: true }).click()
  const fromFix = page.getByRole('menuitem', { name: /Re-run from Fix/ })
  await expect(fromFix).toContainText('Fix would continue the Implement session')
  await fromFix.click()
  const picker = page.getByRole('region', { name: 'Re-run from Fix' })
  await expect(picker).toBeVisible()
  await expect(picker).toContainText(
    'A new run starts at Fix with the findings you tick. Plan, Implement, Review and Critic are carried over from run #1, not run again.',
  )
  await expect(picker).toContainText(
    'Run #1 still holds its folder, so it is stopped when the new run starts.',
  )
  await expect(picker).toContainText('Fix will receive 2 must · 1 should')
  await expect(picker.getByRole('checkbox')).toHaveCount(3)
  await picker.getByRole('button', { name: 'Re-run from Fix with 3 findings' }).click()

  // ---- the new run: straight to Fix, which continues Implement's session and fixes the issues ----
  await expect(page).not.toHaveURL(new RegExp(`#/runs/${source}$`))
  await expect(page.getByText('Session: reused the Implement session')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/^Fixed/).first()).toBeVisible({ timeout: 120_000 })
  expect(readFileSync(join(e2e.sandbox, FIX_WRITE.path), 'utf8')).toBe(FIX_WRITE.content)
  // What the tester saw is what happened: the re-run's Fix was spawned on Implement's session.
  const implId = stepSessionId(e2e, source, 'implement') ?? ''
  expect(fakeProc(e2e, 'resume-2.script.jsonl').argv).toContain(`--resume=${implId}`)

  // ---- the failed run is now cancelled, its folder let go ----
  await page.getByRole('link', { name: /Runs/ }).first().click()
  await expect(page.getByRole('list', { name: 'Runs' })).toContainText('Re-run from Fix of #1')
  const s = await e2e.waitForSummary(source, (x) => x.status === 'cancelled' && x.lock === undefined)
  expect(s.outcome).toBe('failed')
  expect(e2e.pageErrors).toEqual([])
})

// A run stopped while Critic was still working, after Review had reported, never reached its
// Review/Critic join, so it has no findings.json. Core still offers Re-run from Fix with Review's findings, and the
// picker opens from the Stop toast with them (core sends the list in the run's snapshot); the new run's Fix continues
// Implement's session.
test('Flow: stopped while Critic works, Re-run from Fix from the Stop toast offers Review’s findings', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      ...findingsFlow([RESUMED_FIX]),
      critic: [{ recording: 'C02-review-shape', text: 'NO FINDINGS', delayMs: 600_000 }],
    },
    config: NO_GATES,
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const source = run.runId
  await e2e.waitForSummary(
    source,
    (s) => s.steps.find((x) => x.key === 'review')?.status === 'done' && s.findings.must === 2,
    120_000,
  )
  await e2e.waitForLiveProc(source, 'critic')

  // ---- Stop while Critic works: the toast offers Re-run from Fix ----
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click()
  const stopped = page.locator(`[data-toast-id="stopped:${source}"]`)
  await expect(stopped).toContainText('Run stopped', { timeout: 30_000 })
  await e2e.waitForSummary(source, (s) => s.status === 'cancelled' && s.lock === undefined)
  await stopped.getByRole('button', { name: 'Re-run from Fix' }).click()

  // ---- the picker: Review's findings, nothing about a missing file ----
  const picker = page.getByRole('region', { name: 'Re-run from Fix' })
  await expect(picker).toBeVisible()
  await expect(picker).toContainText('Fix will receive 2 must · 1 should')
  await expect(picker.getByRole('checkbox')).toHaveCount(3)
  await expect(page.getByText(/has no findings yet/)).toHaveCount(0)
  await picker.getByRole('button', { name: 'Re-run from Fix with 3 findings' }).click()

  // ---- the new run goes straight to Fix, on Implement's session ----
  await expect(page).not.toHaveURL(new RegExp(`#/runs/${source}$`))
  await expect(page.getByText(/^Fixed/).first()).toBeVisible({ timeout: 120_000 })
  const implId = stepSessionId(e2e, source, 'implement') ?? ''
  expect(fakeProc(e2e, 'resume-1.script.jsonl').argv).toContain(`--resume=${implId}`)
  expect(e2e.pageErrors).toEqual([])
})
