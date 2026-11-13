// Cancel at the plan gate ("cancel at plan gate leaves no dim/* ref"; branch prep:
// the run branch is created at the pre-Implement boundary, state-machine row R5). The user turns on New run branch in the
// composer (a run override, core's provenance badge reads "run"), starts the run and cancels at the plan gate: no
// `dim/*` branch exists, HEAD and every ref are as they were, and the run shows no branch (header, After the run).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { composeRun } from './session-helpers.ts'
import { gitOut, refsOf } from './git-helpers.ts'
import { CLEAN_FLOW } from './scenarios.ts'

test('cancel at the plan gate with New run branch leaves no dim/* ref', async ({ e2e }) => {
  const page = await e2e.start({ scenario: CLEAN_FLOW })
  const refs = refsOf(e2e.sandbox)

  const run = await composeRun(e2e, 'add a --version flag', async (p) => {
    await p.getByTestId('composer-passes-toggle').click()
    const box = p.getByTestId('run-branch')
    await expect(box).toBeEnabled()
    await expect(box).toHaveAttribute('aria-checked', 'false')
    await box.click()
    await expect(box).toHaveAttribute('aria-checked', 'true')
    // Core resolved the override: the badge says it comes from this run.
    await expect(p.getByTestId('run-branch-provenance')).toHaveAttribute('data-source', 'run')
  })
  // The run's resolved config carries the choice.
  const resolved = JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'resolved.json'), 'utf8')) as {
    config: { isolation: { branch: string } }
  }
  expect(resolved.config.isolation.branch).toBe('runBranch')

  const gate = page.getByTestId('card-gate:afterPlan')
  await expect(gate).toBeVisible({ timeout: 90_000 })
  // Plan has run; the branch has not been made yet.
  expect(gitOut(e2e.sandbox, 'for-each-ref', '--format=%(refname)', 'refs/heads/dim/')).toBe('')
  await gate.getByTestId('card-choice-cancel').click()
  await expect(gate).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('cancelled')
  expect(gitOut(e2e.sandbox, 'for-each-ref', '--format=%(refname)', 'refs/heads/dim/')).toBe('')
  expect(refsOf(e2e.sandbox)).toBe(refs)
  expect((await e2e.snapshot(run.runId)).branch).toBeUndefined()

  // The Run view shows no branch: not in the header, and "After the run" has no branch actions.
  await expect(page.getByTestId('run-end')).toBeVisible()
  await expect(page.getByTestId('run-end-branch')).toHaveCount(0)
  await expect(page.getByTestId('run-header').getByTestId('run-branch')).toHaveCount(0)
  await expect(page.getByTestId('run-end-changes')).toHaveText('The run made no changes to the folder.')

  expect(e2e.pageErrors).toEqual([])
})
