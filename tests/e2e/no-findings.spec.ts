// No findings: Review and Critic both answer `NO FINDINGS` → Fix is skipped with a reason
// (timeline tooltip and Fix card) → completed(clean), "Clean: no findings" in the Run view and on the Dashboard.
import { passArgvs } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { CLEAN_FLOW } from './scenarios.ts'

test(
  'NO FINDINGS from both reviewers skips Fix and completes clean',
  { tag: '@cross-os' },
  async ({ e2e }) => {
    const page = await e2e.start({ scenario: CLEAN_FLOW })
    const run = await e2e.runFromDashboard('add a --version flag')
    await e2e.approvePlan()

    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('clean')
    expect(ended.findings).toEqual({ must: 0, should: 0 })

    await expect(page.getByTestId('run-outcome')).toHaveText('Clean: no findings')
    for (const step of ['plan', 'implement', 'review', 'critic'] as const)
      await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')
    const fixNode = page.getByTestId('timeline-node-fix')
    await expect(fixNode).toHaveAttribute('data-status', 'skipped')
    await fixNode.hover()
    await expect(page.getByRole('tooltip')).toContainText('Skipped: no findings to fix')
    await expect(page.getByTestId('pass-card-fix')).toHaveAttribute('data-status', 'skipped')
    await expect(page.getByTestId('pass-reason-fix')).toHaveText('Skipped · no findings to fix')
    await expect(page.getByTestId('summary-findings')).toHaveText('no findings')

    // No Fix process ever started: Plan, Implement, Review, Critic only.
    const argvs = passArgvs(e2e.fakeLog())
    expect(argvs.filter((a) => a.includes('acceptEdits'))).toHaveLength(1)
    expect(argvs.filter((a) => a.some((x) => x.startsWith('--resume')))).toHaveLength(0)

    await page.keyboard.press('ControlOrMeta+1')
    await expect(page.getByTestId(`recent-outcome-${run.runId}`)).toHaveText('Clean: no findings')

    expect(e2e.pageErrors).toEqual([])
  },
)
