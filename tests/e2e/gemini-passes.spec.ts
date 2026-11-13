// Gemini passes in the app ("read-only Review raises zero asks" and "Gemini native
// Plan captured", here on the fake Gemini: the live ones wait for the user's Gemini CLI, tests/fixtures/gemini/README.md
// "Pending on the user"; the ACP base answers a permission request by these rules, in order: 1. a plan exit during a Plan pass →
// capture the plan, reject, session/cancel; 2. a read-only pass → reject; exit_plan_mode is auto-rejected because
// approving it in Gemini's ACP flow could switch the session out of plan mode). Both run in a folder trusted for
// Gemini (the grant made through core's trust.set), through the real resolver, the npm shim and the real adapter.
//   (a) Review on Gemini asks twice (a shell command, an edit): Dim Factory answers both reject_once itself, so the run
//       raises no ask; both are logged as auto-answered (AUTO denied, read-only) and the step counts them.
//   (b) Plan on Gemini runs its native plan mode; its exit_plan_mode request names the plan file Gemini wrote under its
//       own tmp folder (kind other, as gemini-cli sends it): Dim Factory reads the plan from it,
//       answers reject_once (never Allow), sends session/cancel, and the plan gate shows the plan's text.
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { bodiesOf, runBodies } from './attention-helpers.ts'
import { SHELL_HERE, planPass, readOnlyPass } from './gemini-helpers.ts'
import { CLEAN_FLOW, VERSION_WRITE } from './scenarios.ts'

async function trustGemini(e2e: E2EHarness): Promise<void> {
  await expect(e2e.p.getByTestId('vendor-health-gemini')).toHaveAttribute('data-health', 'ready', {
    timeout: 30_000,
  })
  await e2e.call('trust.set', {
    folder: e2e.sandbox,
    grant: { kind: 'vendorFolder', vendor: 'gemini' },
    trusted: true,
  })
}

async function openLog(page: Page): Promise<void> {
  await page.getByTestId('run-tab-log').click()
  await expect(page.getByTestId('log-tab')).toBeVisible()
}

test(
  'a read-only Review on Gemini raises zero asks; its requests are auto-answered',
  {
    tag: ['@cross-os'],
  },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: CLEAN_FLOW,
      config: { gates: { afterPlan: false }, passes: { review: { vendor: 'gemini', model: null } } },
      gemini: {
        readOnly: readOnlyPass({
          asks: [
            {
              toolCallId: 'run_shell_command-e2e-1',
              kind: 'execute',
              title: 'npm test',
              content: `${SHELL_HERE} (Run the test suite)`,
            },
            { toolCallId: 'write_file-e2e-2', kind: 'edit', title: 'Writing to src/cli.ts' },
          ],
          text: 'NO FINDINGS',
          usage: { input: 12_288, cached: 8_192, output: 420, thought: 128 },
        }),
      },
    })
    const fake = e2e.gemini
    if (fake === null) throw new Error('no fake Gemini')
    await trustGemini(e2e)
    const run = await e2e.runFromDashboard('add a --version flag')
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')

    // ---- the agent: both requests answered reject_once ("cancel") by Dim Factory, in the read-only session ----
    const review = fake.pidOfMode('default')
    expect(review).toBeDefined()
    expect(fake.permissionAnswers()).toEqual([
      { pid: review, optionId: 'cancel' },
      { pid: review, optionId: 'cancel' },
    ])

    // ---- the run: no ask at all, two auto-answered denials on Review ----
    const bodies = await runBodies(e2e, run.runId)
    expect(bodiesOf(bodies, 'ev').filter((b) => b.ev.type === 'ask')).toEqual([])
    // (Claude's native Plan takes its plan through a capture too: that is not a denial.)
    const auto = bodiesOf(bodies, 'auto-answered').filter((b) => b.why !== 'plan-capture')
    expect(auto.map((b) => ({ step: b.step, decision: b.decision, why: b.why }))).toEqual([
      { step: 'review', decision: 'deny', why: 'readonly' },
      { step: 'review', decision: 'deny', why: 'readonly' },
    ])
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.review.vendor).toBe('gemini')
    expect(snap.steps.review.autoAnswered).toEqual({ approved: 0, denied: 2 })
    expect(snap.asks).toEqual([])

    // ---- the Log tab says so ----
    await openLog(page)
    const log = page.getByTestId('log-tab')
    await expect(log.getByText('AUTO denied 2', { exact: true })).toBeVisible()
    await expect(page.getByTestId('log-rows').getByText(/^denied .*\(readonly\)$/)).toHaveCount(2)
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

const PLAN = [
  '## Plan',
  '1. Read the version from package.json in src/cli.ts.',
  '2. Print it for --version and exit 0.',
  '3. Add a test in test/cli.test.ts.',
].join('\n')

test(
  "Gemini's native Plan is captured from exit_plan_mode, rejected, and shown at the plan gate",
  {
    tag: ['@cross-os'],
  },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: { implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }] },
      config: { gates: { afterPlan: true }, passes: { plan: { vendor: 'gemini', model: null } } },
      gemini: {
        plan: planPass({ plan: PLAN }),
      },
    })
    const fake = e2e.gemini
    if (fake === null) throw new Error('no fake Gemini')
    await trustGemini(e2e)
    await expect(page.getByTestId('composer')).toBeVisible()
    const folder = page.getByTestId('composer-folder-input')
    await folder.fill(e2e.sandbox)
    await folder.press('Enter')
    await page.getByTestId('composer-task').fill('add a --version flag')
    await expect(page.getByTestId('composer-passes')).toContainText('Gemini')
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()

    // ---- the plan gate shows the plan from the file Gemini's exit_plan_mode request names ----
    const gate = page.getByTestId('card-gate:afterPlan')
    await expect(gate).toBeVisible({ timeout: 90_000 })
    for (const line of [
      'Read the version from package.json in src/cli.ts.',
      'Add a test in test/cli.test.ts.',
    ])
      await expect(page.getByText(line).first()).toBeVisible()
    expect((await e2e.call('runs.output', { runId: run.runId, file: 'plan' })).text.trim()).toBe(PLAN)

    // ---- the agent: plan mode set, the exit rejected (never allowed), then session/cancel ----
    const plan = fake.pidOfMode('plan')
    expect(plan).toBeDefined()
    expect(fake.permissionAnswers()).toEqual([{ pid: plan, optionId: 'cancel' }])
    expect(fake.calls('session/cancel').map((c) => c.pid)).toEqual([plan])
    const snapAtGate = await e2e.snapshot(run.runId)
    expect(snapAtGate.steps.plan.vendor).toBe('gemini')
    expect(snapAtGate.steps.plan.planMode).toBe('native')
    expect(snapAtGate.steps.plan.status).toBe('done')
    const bodies = await runBodies(e2e, run.runId)
    expect(bodiesOf(bodies, 'ev').filter((b) => b.ev.type === 'ask')).toEqual([])
    expect(bodiesOf(bodies, 'auto-answered').map((b) => ({ step: b.step, why: b.why }))).toEqual([
      { step: 'plan', why: 'plan-capture' },
    ])
    // The capture is how the plan is taken, not a denial: nothing counted on the step.
    expect(snapAtGate.steps.plan.autoAnswered).toBeUndefined()

    // ---- approve: Claude implements from Gemini's plan, the reviewers find nothing ----
    await e2e.approvePlan()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)
