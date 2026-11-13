// Screenshots of grounding checks, reactions and the project report in light and dark, for review
// (not a gate; it asserts only what it needs to reach each screen): Settings > Extensions > Context with the project's
// report open; the gate before Fix with a Grounding finding (the Grounding filter) and a Verify finding flagged as a
// possible hallucination; After the run's Context health; the restart card after three summaries; the loop card. Runs when CONTEXT2_SCREENS=1 and writes PNGs to
// test-results/context2-screens/ (git-ignored; Playwright clears test-results at the start of a run, so run this spec
// on its own, last).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { REPO_ROOT } from '../integration/run/scenario.ts'
import type { E2EHarness } from './harness.ts'
import { expect, test } from './harness.ts'
import { contextProject, seedContextRuns } from './context-report-helpers.ts'
import { CHECK_ARGV, trustCommand, verifyConfig, version, writeSandbox } from './verify-helpers.ts'

const OUT = join(REPO_ROOT, 'test-results', 'context2-screens')

test.skip(process.env['CONTEXT2_SCREENS'] === undefined, 'screenshots only: set CONTEXT2_SCREENS=1')

async function shot(e2e: E2EHarness, page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await e2e.call('ui.setTheme', { theme })
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) })
  }
  await e2e.call('ui.setTheme', { theme: 'light' })
}

/** A check that fails with TypeScript's "cannot find module" until src/version.ts says 1.0.0. */
const INVENTED_MODULE_CHECK = [
  "import { readFileSync } from 'node:fs'",
  "let v = ''",
  "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
  "if (v.includes('1.0.0')) { console.log('version ok'); process.exit(0) }",
  'console.log("src/version.ts(1,21): error TS2307: Cannot find module \'semver-lite\' or its corresponding type declarations.")',
  'process.exit(1)',
].join('\n')

test('Settings > Extensions > Context: the project report', async ({ e2e }) => {
  test.setTimeout(180_000)
  const project = contextProject(e2e.root)
  seedContextRuns(e2e.home, project, Date.now())
  const page = await e2e.start()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate((f) => {
    window.location.hash = `#/settings/extensions?folder=${encodeURIComponent(f)}`
  }, project)
  await expect(page.getByTestId('context-report-summary')).toContainText('From 6 recent runs', {
    timeout: 30_000,
  })
  await page.getByTestId('context-report-details').locator('summary').click()
  await page.getByTestId('extensions-context').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '01-settings-context-report')
})

test('the gate before Fix with grounding findings', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    grounding: true,
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: version('0.1.0'),
          text: 'Updated `src/version.ts`. All tests pass.',
        },
      ],
      resume: [
        { recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'Done.\n\nF1 fixed\nF2 fixed' },
      ],
    },
    config: verifyConfig([{ name: 'test', run: [...CHECK_ARGV] }], {
      gates: { afterPlan: true, beforeFix: true },
    }),
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  writeSandbox(e2e, { 'check.mjs': INVENTED_MODULE_CHECK })
  await trustCommand(e2e, CHECK_ARGV)
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.approvePlan()
  const gate = page.getByTestId('card-gate:beforeFix')
  await expect(gate).toBeVisible({ timeout: 150_000 })
  await expect(gate.getByTestId('findings-filter-grounding')).toBeVisible()
  await gate.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '02-gate-grounding-all')
  await gate.getByTestId('findings-filter-grounding').click()
  await shot(e2e, page, '03-gate-grounding-filter')
  await gate.getByTestId('card-choice-continue').click()
  await e2e.waitForEnd(run.runId, 180_000)
})

test('After the run: Context health', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C23s-compact-auto',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
        },
      ],
    },
    config: { gates: { afterPlan: false, beforeFix: false } },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  const run = await e2e.runFromDashboard('add a --version flag')
  await e2e.waitForEnd(run.runId, 180_000)
  const health = page.getByTestId('run-end-context')
  await expect(health).toBeVisible({ timeout: 30_000 })
  await health.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(e2e, page, '04-after-run-context-health')
})

test('the restart card after three summaries', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C23s-compact-auto', compactions: 3, afterCompactionsMs: 90_000 }],
    },
    config: { gates: { afterPlan: false, beforeFix: false } },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await e2e.runFromDashboard('add a --version flag')
  const card = page.getByTestId('card-restartFresh')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot(e2e, page, '05-restart-fresh-card')
})

test('the loop card', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C23s-compact-auto', toolCalls: 9, afterToolCallsMs: 90_000, delayMs: 0 }],
    },
    config: { gates: { afterPlan: false, beforeFix: false } },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await e2e.runFromDashboard('add a --version flag')
  const card = page.getByTestId('card-loop')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot(e2e, page, '06-loop-card')
})
