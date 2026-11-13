// The first-run (5-minute) script ("flow: first launch → run
// within 5 min"), with the fake Claude: launch on a fresh home without a profile → the setup card streams the probes
// and claude-only is selected → Choose folder… → the preflight strip turns green → type a task, see the estimate
// ("typical (no history yet)") → Ctrl+Enter → the Run view → the plan runs → the plan gate → Approve → Implement →
// Review ∥ Critic → completed (the Run view's status; the Completed toast itself is covered with the notifications).
// The time from launch to the running plan, and to the end, is measured and recorded (test annotations and stdout);
// both must be under 5 minutes.
import { expect, test } from './harness.ts'
import { CLEAN_FLOW } from './scenarios.ts'

const FIVE_MINUTES = 5 * 60_000

test(
  'First-run script: first launch → a running run within 5 minutes',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(FIVE_MINUTES + 60_000)
    const launchedAt = Date.now()
    const marks: Record<string, number> = {}
    const mark = (name: string): void => {
      marks[name] = Date.now() - launchedAt
    }

    // 0:00 — launch: the setup card streams the probes; first launch picks claude-only.
    const page = await e2e.start({ scenario: CLEAN_FLOW, config: { profile: undefined }, pickSandbox: true })
    mark('window')
    const setup = page.getByTestId('setup-card')
    await expect(setup.getByTestId('setup-vendor-claude')).toHaveAttribute('data-health', 'ready')
    await expect(setup.getByTestId('setup-vendor-codex')).toHaveAttribute('data-health', 'not-installed')
    await expect(page.getByTestId('composer-profile')).toHaveText('claude-only')
    mark('setup')

    // 0:20 — choose a folder: preflight turns green.
    await page.getByTestId('composer-choose-folder').click()
    await expect(page.getByTestId('composer-folder-input')).toHaveValue(e2e.sandbox)
    const strip = page.getByTestId('preflight-strip')
    await expect(strip.getByTestId('preflight-ok')).toBeVisible()
    await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0)
    mark('preflight')

    // 0:40 — type a task, see the estimate, Ctrl+Enter: the Run view opens.
    const task = page.getByTestId('composer-task')
    await task.fill('add a --version flag')
    // `≈ 6–10 min · ~$0.30 est. · typical (no history yet)`, the cost from the token priors at the seed prices.
    await expect(page.getByTestId('estimate-line')).toHaveText(
      /^≈ 6–10 min · ~\$0\.\d\d(–\d+\.\d\d)? est\. · typical \(no history yet\)/,
    )
    await expect(page.getByTestId('composer-run')).toBeEnabled()
    await task.focus()
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    await expect(page.getByTestId('run-view')).toBeVisible()
    mark('runView')

    // 0:45 — the plan runs (a native plan: Claude's plan mode; the fake answers in about a second).
    await expect(page.getByTestId('timeline-node-plan')).toHaveAttribute('data-status', /^(running|done)$/, {
      timeout: 90_000,
    })
    mark('planRunning')

    // 1:45 — the plan gate → Approve; Implement, Review ∥ Critic, Fix skipped as clean → Completed.
    await e2e.approvePlan()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    await expect(page.getByTestId('run-status')).toContainText(/completed/i)
    await expect(page.getByTestId('run-outcome')).toHaveText('Clean: no findings')
    mark('completed')

    const line = Object.entries(marks)
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`)
      .join(' · ')
    test.info().annotations.push({ type: 'timing', description: line })
    console.log(`first-run timing: ${line}`)
    expect(marks['planRunning']).toBeLessThan(FIVE_MINUTES)
    expect(marks['completed']).toBeLessThan(FIVE_MINUTES)
    expect(e2e.pageErrors).toEqual([])
  },
)
