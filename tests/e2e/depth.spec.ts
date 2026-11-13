// Adaptive depth end to end, with the shipped defaults (depth auto, quieter reviews, continuity):
//  1. The composer says Quick for a small change ("Quick: one strong session plus checks" and why); the run follows it:
//     no Plan, no Critic, Implement then one review, no Fix when nothing real failed; the Run view's header says Quick.
//  2. Forcing Thorough in the composer: the run plans first (the plan gate) and the header says Thorough.
//  3. The Easy confirm screen says Thorough for a beginner's new project and lets the user force Quick; the run follows
//     it (no Plan).
// With DEPTH_SCREENS=1 each screen is also saved in light and dark to test-results/direct-mode-screens/ (not committed).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { EASY_CONFIG, easyScenario, ideaToConfirm } from './easy-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'direct-mode-screens')
const EM_DASH = String.fromCodePoint(0x2014)
const SMALL = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }

async function shot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  if (process.env['DEPTH_SCREENS'] === undefined) return
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`), fullPage: true })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

/** The folder and the task in the composer, and the depth line once core decided. */
async function compose(e2e: E2EHarness, page: Page, task: string): Promise<void> {
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill(task)
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
}

test('the composer says Quick for a small change and the run follows it', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    pipeline: 'defaults',
    scenario: {
      implement: [{ recording: 'C08a-session-id-implement', write: SMALL }],
      review: [
        { recording: 'C02-review-shape', text: '- [should] The flag could have a clearer help text.' },
      ],
    },
  })
  await compose(e2e, page, 'add a --version flag')
  const line = page.getByTestId('composer-depth-line')
  await expect(line).toHaveAttribute('data-depth', 'direct')
  await expect(line).toHaveText(
    'Quick: one strong session plus checks. A small or medium change to an existing project.',
  )
  await expect(page.getByTestId('composer-depth-choice').locator('[data-value="auto"]')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  // The depth row keeps one height: core's answer moved nothing.
  expect((await page.getByTestId('composer-depth').boundingBox())?.height).toBeLessThanOrEqual(28.5)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await shot(e2e, page, 'composer-quick')

  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('run-depth')).toHaveText('Quick')
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  for (const [step, status] of [
    ['plan', 'skipped'],
    ['implement', 'done'],
    ['review', 'done'],
    ['critic', 'skipped'],
    ['fix', 'skipped'],
  ] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', status)
  const snap = await e2e.snapshot(run.runId)
  expect(snap.depth).toMatchObject({ depth: 'direct', source: 'auto' })
  // The suggestion is listed; Fix did not run for it.
  expect(snap.notes.some((n) => n.startsWith('The reviewers listed one finding without evidence'))).toBe(true)
  await shot(e2e, page, 'run-quick')
})

test('forcing Thorough in the composer: the run plans first', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    pipeline: 'defaults',
    scenario: { plan: { recording: 'C06-plan-native-host' } },
  })
  await compose(e2e, page, 'add a --version flag')
  await expect(page.getByTestId('composer-depth-line')).toHaveAttribute('data-depth', 'direct')
  const choice = page.getByTestId('composer-depth-choice')
  const before = await choice.boundingBox()
  await choice.locator('[data-value="full"]').click()
  await expect(choice.locator('[data-value="full"]')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('composer-depth-line')).toHaveText(
    'Thorough: plan, build, two reviewers and fixes. You chose Thorough for this run.',
  )
  // The choice keeps its widths.
  expect((await choice.boundingBox())?.width).toBe(before?.width)
  await shot(e2e, page, 'composer-thorough')
  await page.getByTestId('composer-run').click()
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('card-gate:afterPlan')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('run-depth')).toHaveText('Thorough')
  const snap = await e2e.snapshot(run.runId)
  expect(snap.depth).toMatchObject({ depth: 'full', source: 'chosen' })
  await shot(e2e, page, 'run-thorough-gate')
  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
})

test('the Easy confirm screen shows the depth and the run follows a forced Quick', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    pipeline: 'defaults',
    scenario: easyScenario(),
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
  })
  await ideaToConfirm(page)
  const line = page.getByTestId('easy-depth-line')
  await expect(line).toHaveAttribute('data-depth', 'full')
  await expect(line).toHaveText(
    'Thorough: plan, build, two reviewers and fixes. A new project for a beginner: it is planned first and checked by two reviewers.',
  )
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await shot(e2e, page, 'easy-confirm-thorough')
  await page.getByTestId('easy-depth-choice').locator('[data-value="direct"]').click()
  await expect(line).toHaveAttribute('data-depth', 'direct')
  await expect(line).toHaveText('Quick: one strong session plus checks. You chose Quick for this run.')
  await expect(page.getByTestId('easy-confirm-what-text')).toContainText("I'll build it in one go")
  await shot(e2e, page, 'easy-confirm-quick')
  await expect(page.getByTestId('easy-start')).toBeEnabled()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  const snap = await e2e.waitForSnapshot(run.runId, (s) => s.steps.implement.status !== 'queued', {
    what: 'Implement started',
  })
  expect(snap.depth).toMatchObject({ depth: 'direct', source: 'chosen' })
  expect(snap.steps.plan.status).toBe('skipped')
  await shot(e2e, page, 'easy-run-quick')
  await e2e.call('runs.stop', { runId: run.runId })
  await e2e.waitForEnd(run.runId)
})
