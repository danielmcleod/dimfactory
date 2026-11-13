// An environment failure (verify results: "Environment failures are never findings. These are 127/9009,
// ENOENT, 'not recognized', or a missing module. They open verifyEnv [Retry] [Skip verify]"; "127/9009 classified
// as env"; the verifyEnv card; failure category deps_missing). The project's lint script calls a
// program this computer does not have; the trusted `npm run lint` resolves (npm is on PATH, so preflight lets the run
// start) but the script cannot run: the shell says the program is not recognized (Windows) or not found (exit 127).
// The verifyEnv card names the command and why, with the output excerpt; [Skip verify] goes on without it, and the
// run completes clean with no finding.
import { expect, test } from './harness.ts'
import { findingsOf, PASSING_FLOW, setScripts, trustCommand, verifyConfig } from './verify-helpers.ts'

const LINT_ARGV = ['npm', 'run', 'lint'] as const

test('a missing tool opens the verifyEnv card; Skip verify goes on without a finding', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: PASSING_FLOW,
    config: verifyConfig([{ name: 'lint', run: [...LINT_ARGV] }], { gates: { afterPlan: false } }),
  })
  setScripts(e2e, { lint: 'dim-factory-e2e-missing-linter --check .' })
  await trustCommand(e2e, LINT_ARGV)

  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the verifyEnv card: the command, why it could not run, its output ----
  const card = page.getByTestId('card-verifyEnv')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card).toContainText('The lint check could not run')
  await expect(card).toContainText('npm run lint')
  await expect(card.getByTestId('verify-env-0-why')).toHaveText(
    'A program it runs was not found: dim-factory-e2e-missing-linter',
  )
  await expect(card.getByTestId('verify-env-0-excerpt')).toContainText('dim-factory-e2e-missing-linter')
  await expect(card.locator('button[data-testid^="card-choice-"]')).toHaveText(['Retry', 'Skip verify'])
  const waiting = await e2e.snapshot(run.runId)
  expect(waiting.steps['verify:1'].verify?.commands).toEqual([
    expect.objectContaining({ name: 'lint', status: 'env' }),
  ])
  await expect(
    page.getByTestId('pass-card-verify:1').getByTestId('verify-command-verify:1-0'),
  ).toHaveAttribute('data-status', 'env')

  // ---- Skip verify: the run goes on and completes clean; nothing became a finding ----
  await card.getByTestId('card-choice-skip-verify').click()
  await expect(card).toBeHidden()
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  expect(ended.findings).toEqual({ must: 0, should: 0 })
  expect(await findingsOf(e2e, run.runId)).toEqual([])
  await expect(page.getByTestId('run-outcome')).toHaveText('Clean: no findings')
  await expect(page.getByTestId('timeline-node-verify:1')).toHaveAttribute('data-status', 'skipped')
  expect(e2e.pageErrors).toEqual([])
})
