// Estimates ("estimate tests; priors → 'from N runs' after repeated runs"; estimate
// lookup levels with n ≥ 5, display `≈ 9–14 min · ~$0.40–0.85 est. · from 12 runs`, live ETA): the
// composer's estimate line reads "typical (no history yet)" on a fresh home; after five quick clean runs in the folder
// (Plan → Implement → NO FINDINGS reviewers, the after-plan gate off as a run override) it reads "from 5 runs" with a
// cost range (two of the five Implement passes used more tokens), without the user touching the composer. A sixth run
// waiting at its plan gate shows an ETA on its Dashboard card.
import type { ScenarioSpec } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { runByNo } from './dashboard-helpers.ts'

const RUNS = 5
const CHEAP = 'C08a-session-id-implement'
/** A longer Implement (more tokens): the cost estimate's p80 differs from its p50. */
const DEARER = 'C03b-accept-edits-steps'

const SCENARIO: ScenarioSpec = {
  plan: Array.from({ length: RUNS + 1 }, () => ({ recording: 'C06-plan-native-host' })),
  // Every run writes its own file, so each one changes something (and its reviewers run).
  implement: [CHEAP, CHEAP, CHEAP, DEARER, DEARER, CHEAP].map((recording, i) => ({
    recording,
    write: {
      path: `src/flag${i + 1}.ts`,
      content: `export const flag${i + 1} = true
`,
    },
  })),
}

const NO_GATES = { gates: { afterPlan: false, beforeFix: false } }

test('estimates: priors, then "from 5 runs" after repeated runs; ETA while a run waits', async ({ e2e }) => {
  test.setTimeout(480_000)
  const page = await e2e.start({ scenario: SCENARIO })

  // ---- a fresh home: the composer's estimate is the priors ----
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  const line = page.getByTestId('estimate-line')
  await expect(line).toContainText('typical (no history yet)')
  await expect(line).toContainText('+ your review time')
  const prior = await e2e.call('estimates.get', { folder: e2e.sandbox })
  expect(prior.total.basis).toBe('typical (no history yet)')

  // ---- five quick runs in the folder (gates off as run overrides); they queue and run one after another ----
  const started: string[] = []
  for (let i = 1; i <= RUNS; i++) {
    const r = await e2e.call('runs.start', {
      folder: e2e.sandbox,
      task: `add flag number ${i}`,
      overrides: NO_GATES,
    })
    started.push(r.runId)
  }
  for (const [i, runId] of started.entries()) {
    const ended = await e2e.waitForEnd(runId, 180_000)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('clean')
    if (i === RUNS - 2) {
      // Four runs are not enough history (n ≥ 5): still the priors.
      const four = await e2e.call('estimates.get', { folder: e2e.sandbox })
      expect(four.total.basis).toBe('typical (no history yet)')
    }
  }

  // ---- the composer followed the runs: "from 5 runs", with a cost range ----
  await expect(line).toContainText(`from ${RUNS} runs`, { timeout: 30_000 })
  await expect(line).not.toContainText('no history yet')
  await expect(line).toHaveText(/^≈ [^·]+ min · ~\$\d+\.\d\d–\d+\.\d\d est\. · from 5 runs/)
  const est = await e2e.call('estimates.get', { folder: e2e.sandbox })
  expect(est.total.basis).toMatch(/^from 5 runs/)
  expect(est.steps.plan?.samples).toBe(RUNS)
  expect(est.steps.implement?.samples).toBe(RUNS)
  expect(est.total.costUsd?.p80).toBeGreaterThan(est.total.costUsd?.p50 ?? Infinity)
  // The per-step table on keyboard focus: Plan's basis names its history.
  await line.focus()
  const table = page.getByTestId('estimate-table')
  await expect(table).toBeVisible()
  await expect(table.locator('tr[data-step="plan"]')).toContainText('from 5 runs')

  // ---- a sixth run waits at its plan gate: its Dashboard card shows an ETA ----
  await page.getByTestId('composer-task').fill('add a --quiet flag')
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const sixth = await runByNo(e2e, RUNS + 1)
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  await page.keyboard.press('ControlOrMeta+1')
  const card = page.getByTestId(`active-run-${sixth.runId}`)
  await expect(card).toHaveAttribute('data-status', 'waiting')
  await expect(card.getByTestId(`active-run-eta-${sixth.runId}`)).toHaveText(/^ETA ~\d+ min$/)
  const snap = await e2e.snapshot(sixth.runId)
  expect(snap.summary.progress.etaMs).toBeGreaterThan(0)
  expect(snap.steps.implement.eta?.p50).toBeGreaterThan(0)

  await e2e.call('runs.stop', { runId: sixth.runId })
  await e2e.waitForEnd(sixth.runId)
  expect(e2e.pageErrors).toEqual([])
})
