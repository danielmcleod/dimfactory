// Unknown failure ("Unknown snag: Ask AI → config action applied"; self-heal "Triggers. Runs
// automatically only when the category is unknown … and selfHeal.enabled", "Input" (stderr plus status frames, never the
// task), "Execution" (the selfHeal vendor, cwd runs/<id>/heal/), "Parsing" (unsafe suggestions hidden),
// "autoApplyConfigPatches"; state-machine rows P17/P22; failure category unknown "heal (auto if enabled) · retry · open_docs").
// Plan's CLI fails in a way nothing classifies (stderr only, exit 3). Self-heal is on (the default), so the snag
// shows the diagnosis on its way at once, with no click; the healer (the fake Claude, read-only, in the run's heal
// folder) is told the error output and never the task. Its answer: the default model for Plan, plus one unsafe command
// Dim Factory hides. The fix's diff is shown and becomes the card's primary button; applying it records the patch in
// resolved.json and Plan runs again without `--model`, and succeeds. With autoApplyConfigPatches on, the same fix
// applies itself once and the retry spends Plan's automatic retry. With self-heal off, nothing is asked on its own and
// [Ask AI to diagnose] leads the card; once the AI answered, its fix is the primary button. The failure and the
// diagnosis arriving move nothing on the page (layout shifts without input stay under ui-layout.spec.ts's 0.02).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Scenario } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { auditBothSizes } from './git-helpers.ts'
import {
  PLAN_MATCH,
  UNKNOWN_STDERR,
  healAnswerScript,
  healMatch,
  healStarts,
  planArgvs,
  prependScripts,
  promptOf,
  snagCard,
  unknownFailureScript,
  unpromptedShifts,
  watchShifts,
} from './recovery-helpers.ts'
import { storedStep } from './session-helpers.ts'

const TASK = 'add a --version flag'
const DIAGNOSIS = 'The configured model for Plan is not available to this account.'

function failingPlanThenHeal(sc: Scenario): void {
  prependScripts(sc, [
    { name: 'plan-unknown', match: PLAN_MATCH, ops: unknownFailureScript() },
    {
      name: 'heal-answer',
      match: healMatch(),
      ops: healAnswerScript({
        diagnosis: DIAGNOSIS,
        confidence: 'medium',
        category: 'model_unavailable',
        actions: [
          {
            kind: 'config',
            ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
            reason: "Use Claude's default model.",
          },
          { kind: 'shell', command: 'rm -rf ~/.claude', reason: 'Unsafe on purpose.' },
        ],
      }),
    },
  ])
}

const resolvedPatches = (home: string, runId: string): unknown =>
  (JSON.parse(readFileSync(join(home, 'runs', runId, 'resolved.json'), 'utf8')) as Record<string, unknown>)[
    'patches'
  ]

test('unknown failure: the AI diagnoses it on its own; its config fix is applied and Plan retries', async ({
  e2e,
}) => {
  const page = await e2e.start({
    scenario: { plan: [{ recording: 'C06-plan-native-host' }] },
    editScenario: failingPlanThenHeal,
  })
  const run = await e2e.runFromDashboard(TASK)
  await watchShifts(page)

  // ---- the snag: unknown, and the diagnosis started on its own ----
  const snag = snagCard(page, 'plan')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'unknown')
  const diagnosis = snag.getByTestId('snag-heal-plan')
  await expect(diagnosis).toBeVisible()
  await expect(diagnosis).toHaveAttribute('data-status', 'ok', { timeout: 120_000 })
  // The failure and the diagnosis arrived on their own: nothing on the page moved for them (ui-layout.spec.ts's CLS rule).
  const moved = await unpromptedShifts(page)
  expect(moved.cls, `layout shifts without input: ${moved.moved.join(' | ')}`).toBeLessThan(0.02)
  await expect(diagnosis).toContainText(`Diagnosis (AI, medium confidence): ${DIAGNOSIS}`)
  await expect(snag.getByTestId('snag-heal-plan-hidden')).toHaveText('Dim Factory hid 1 unsafe suggestion')
  let snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan.failure).toMatchObject({ category: 'unknown', classifiedBy: 'heuristic' })
  expect(snap.steps.plan.heal).toMatchObject({ status: 'ok', trigger: 'auto', hidden: 1 })

  // The healer: one spawn, read-only, in the run's heal folder, told the error and never the task.
  const heals = healStarts(e2e)
  expect(heals).toHaveLength(1)
  const heal = heals[0]
  if (heal === undefined) throw new Error('no heal spawn')
  expect(heal.cwd.toLowerCase()).toBe(join(e2e.home, 'runs', run.runId, 'heal').toLowerCase())
  const prompt = promptOf(e2e, heal.pid)
  expect(prompt).toContain(UNKNOWN_STDERR)
  expect(prompt).not.toContain(TASK)

  // ---- the fix: its diff, primary now; the unsafe command is nowhere ----
  const fix = snag.getByTestId('patch-plan:heal-1')
  await expect(fix).toContainText('Use the default model for Plan')
  const preview = fix.getByTestId('patch-preview-plan:heal-1')
  await expect(preview.locator('[data-kind="del"]')).toHaveText('Removed: - passes.plan.model: "opus"')
  await expect(preview.locator('[data-kind="add"]')).toHaveText('Added: + passes.plan.model: null')
  const apply = fix.getByTestId('recovery-plan:heal-1')
  await expect(apply).toHaveText('Apply to this run')
  await expect(apply).toHaveClass(/bg-primary/)
  await expect(page.getByText('rm -rf')).toHaveCount(0)
  await auditBothSizes(e2e, page, 'Run view with an unknown failure diagnosed')

  // ---- apply → Plan runs again with Claude's default model and succeeds ----
  await apply.click()
  await expect(toasts(page).filter({ hasText: 'Applied. Retrying Plan.' })).toHaveCount(1)
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan).toMatchObject({ status: 'done', attempt: 2 })
  const plans = planArgvs(e2e)
  expect(plans).toHaveLength(2)
  expect(plans[0]).toContain('--model')
  expect(plans[1]).not.toContain('--model')
  expect(resolvedPatches(e2e.home, run.runId)).toEqual([
    expect.objectContaining({
      ops: [{ op: 'replace', path: '/passes/plan/model', value: null }],
      source: 'recovery',
      actionId: 'plan:heal-1',
    }),
  ])

  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})

test('with self-heal off, Ask AI to diagnose leads the unknown snag and its fix applies', async ({ e2e }) => {
  const page = await e2e.start({
    scenario: { plan: [{ recording: 'C06-plan-native-host' }] },
    editScenario: failingPlanThenHeal,
    config: { selfHeal: { enabled: false } },
  })
  const run = await e2e.runFromDashboard(TASK)
  const snag = snagCard(page, 'plan')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'unknown')
  // Nothing was asked on its own; Ask AI is the first and primary button.
  const ask = snag.getByTestId('recovery-plan:heal')
  await expect(ask).toHaveText('Ask AI to diagnose')
  await expect(ask).toHaveClass(/bg-primary/)
  await expect(snag.locator('[data-testid^="recovery-"]').first()).toHaveAttribute(
    'data-testid',
    'recovery-plan:heal',
  )
  await expect(snag.getByTestId('snag-heal-plan')).toHaveCount(0)
  expect(healStarts(e2e)).toEqual([])

  await ask.click()
  await expect(snag.getByTestId('snag-heal-plan')).toHaveAttribute('data-status', 'ok', { timeout: 120_000 })
  expect((await e2e.snapshot(run.runId)).steps.plan.heal).toMatchObject({ trigger: 'user' })
  // Diagnosed: the AI's fix is the primary button now, Ask AI a secondary one.
  await expect(ask).not.toHaveClass(/bg-primary/)
  await snag.getByTestId('recovery-plan:heal-1').click()
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  expect((await e2e.snapshot(run.runId)).steps.plan).toMatchObject({ status: 'done', attempt: 2 })

  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})

test('with autoApplyConfigPatches the fix applies itself once, spending the automatic retry', async ({
  e2e,
}) => {
  const page = await e2e.start({
    scenario: { plan: [{ recording: 'C06-plan-native-host' }] },
    editScenario: failingPlanThenHeal,
    config: { selfHeal: { autoApplyConfigPatches: true } },
  })
  const run = await e2e.runFromDashboard(TASK)

  // No click: the diagnosis, its fix applied, Plan again.
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 120_000 })
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.plan).toMatchObject({ status: 'done', attempt: 2 })
  expect(snap.steps.plan.heal).toMatchObject({ status: 'ok', autoApplied: 'plan:heal-1' })
  expect(snap.notes).toContain('Self-heal applied "Use the default model for Plan" and retried Plan.')
  expect(storedStep(e2e, run.runId, 'plan').autoRetryUsed).toBe(true)
  expect(planArgvs(e2e)[1]).not.toContain('--model')
  expect(resolvedPatches(e2e.home, run.runId)).toEqual([
    expect.objectContaining({ source: 'self-heal', actionId: 'plan:heal-1' }),
  ])

  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
  expect(e2e.pageErrors).toEqual([])
})
