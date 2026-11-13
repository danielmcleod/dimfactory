// Beginners, part A end to end, on the fake Claude with an isolated home (projects beside the test's home,
// never a real Documents folder; no network: the React project's packages are linked from Dim Factory's own
// node_modules, see react-helpers.ts):
//  1. React by default: the confirm screen says how it is built, asks the one plain question about what the idea needs
//     (sign-ups emailed or saved) and says what will work and which checks run; the project starts from the web
//     starter; the Plan prompt carries the look-and-feel bar; Verify runs the starter's real tests, its real Vite build
//     and Dim Factory's page-load check in the hidden window, all passing; the Done screen offers Look it over;
//     Share it's "Get it ready to share" builds dist/ under the project permission and the upload file is made from it;
//     Open it serves dist/ with the static server, whose single-page fallback opens a link to an inner page; the dev
//     server runs as the trusted preview command and its page loads.
//  2. Without Node.js: plain HTML, said plainly with how to install Node.js; the page-load check fails on a console
//     error, Fix repairs it, and it passes; the app's Done screen offers Look it over.
//  3. The confirm screen alone: an AI idea is offered a free server for its key, with its cost; Plain HTML switches the
//     template; with a Node.js too old for Vite it says which version and what is needed.
//  4. The project permission covers adding a registry package (npm install react-router-dom) and still asks for a
//     global install.
//  5. A OneDrive-synced Documents folder: new projects go in the user's folder, and the confirm screen says why.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { rewriteAsks } from '../integration/easy/asks.ts'
import type { ScenarioSpec } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { bodiesOf, runBodies } from './attention-helpers.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { EASY_CONFIG, SUMMARY, withPlan } from './easy-helpers.ts'
import { BAKERY_CONTENT, BAKERY_IDEA, linkReactDeps } from './react-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)
const CRITERIA = ['A visitor can read what the bakery bakes', 'A visitor can sign up for the newsletter']
const VERDICTS = {
  verdicts: CRITERIA.map((_, i) => ({
    id: `AC${i + 1}`,
    status: 'met',
    evidence: 'src/content.ts and the pages',
  })),
}
const RESEARCH = {
  summary: ['Bakery sites work when opening hours and what is baking are easy to find on a phone.'],
  features: [
    {
      feature: 'Show what is baking this week near the top',
      priority: 'must',
      sources: ['https://www.w3.org/WAI/WCAG22/quickref/'],
    },
  ],
  standards: [],
  options: [],
  risks: [],
  questions: [],
  sources: [{ url: 'https://www.w3.org/WAI/WCAG22/quickref/', title: 'WCAG 2.2 quick reference' }],
}
const QUESTIONS = {
  questions: [{ question: 'What feel should it have?', options: ['Warm and friendly', 'Clean and simple'] }],
}

/** A website or app run: questions, a look at similar sites, the plan, Implement's one file, verdicts, a summary. */
function webScenario(
  implement: { path: string; content: string },
  extra: Partial<ScenarioSpec> = {},
): ScenarioSpec {
  return {
    plan: { recording: 'C06-plan-native-host' },
    research: [{ recording: 'C02-review-shape', text: `\`\`\`json\n${JSON.stringify(RESEARCH)}\n\`\`\`` }],
    implement: [{ recording: 'C08a-session-id-implement', write: implement }],
    review: [{ recording: 'C02-review-shape', text: JSON.stringify(VERDICTS), structured: VERDICTS }],
    explain: [
      { recording: 'C02-review-shape', text: JSON.stringify(QUESTIONS) },
      { recording: 'C02-review-shape', text: SUMMARY },
    ],
    ...extra,
  }
}

const withCriteria = (sc: Parameters<typeof withPlan>[0]): void =>
  withPlan(sc, [
    '# Plan: the bakery site',
    '',
    '## Goal',
    'A site for the bakery with a newsletter sign-up.',
    '',
    '## Acceptance criteria',
    ...CRITERIA.map((c) => `- ${c}`),
    '',
  ])

async function toConfirm(page: Page, idea: string): Promise<void> {
  await expect(page.getByTestId('easy-home')).toBeVisible()
  await page.getByTestId('easy-idea').fill(idea)
  await page.getByTestId('easy-next').click()
  await expect(page).toHaveURL(/#\/easy\/new$/)
  await expect(page.getByTestId('easy-confirm-kind')).toBeVisible({ timeout: 30_000 })
}

/** Questions, the look at similar things, and the plan: each answered the plain way. */
async function throughPlan(page: Page, o: { plan: boolean }): Promise<void> {
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()
  const research = page.getByTestId('easy-card-research')
  await expect(research).toBeVisible({ timeout: 90_000 })
  await research.getByTestId('easy-research-use').click()
  if (!o.plan) return
  const plan = page.getByTestId('easy-card-plan')
  await expect(plan).toBeVisible({ timeout: 90_000 })
  await plan.getByTestId('easy-build-it').click()
}

test('React by default: the starter, real checks, Get it ready to share, preview by dist and by dev server', async ({
  e2e,
}) => {
  test.setTimeout(600_000)
  const page = await e2e.start({
    scenario: webScenario({ path: 'src/content.ts', content: BAKERY_CONTENT }),
    editScenario: withCriteria,
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
  })
  const app = e2e.app
  if (app === null) throw new Error('no app')

  // ---- the confirm screen: React, the one question, what will work, the checks ----
  await toConfirm(page, BAKERY_IDEA)
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Landing page (React)')
  await expect(page.getByTestId('easy-stack-react')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('easy-stack-html')).toHaveText('Plain HTML (no build step)')
  await expect(page.getByTestId('easy-need-question')).toHaveText(
    'Should sign-ups be saved somewhere, or just emailed to you?',
  )
  await expect(page.getByTestId('easy-need-forms-email')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('easy-need-cost')).toContainText("Check Netlify's current pricing")
  await expect(page.getByTestId('easy-works-lines')).toHaveText(
    'Sign-ups are emailed to you; nothing is stored in the site.',
  )
  await expect(page.getByTestId('easy-confirm-checks')).toHaveText(
    'Before it says it is ready, it runs its tests, builds it and opens the page to check it loads without errors.',
  )
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  await page.getByTestId('easy-consent').click()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  for (const f of ['package.json', 'index.html', 'vite.config.ts', 'src/App.tsx', 'public/_redirects'])
    expect(existsSync(join(run.folder, ...f.split('/'))), f).toBe(true)
  // The packages npm install would have fetched, linked from Dim Factory's own (no network here).
  linkReactDeps(run.folder)

  await throughPlan(page, { plan: true })
  const ended = await e2e.waitForEnd(run.runId, 420_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome, e2e.describeRun(ended)).toBe('clean')

  // The default look and feel went into the Plan prompt; the run was told how the form works.
  const planPrompt = promptSent(e2e, 'plan-1.script.jsonl')
  expect(planPrompt).toContain('Look and feel (a default: the request does not say how it should look):')
  expect(planPrompt).toContain('Netlify form')
  // Verify ran the starter's own tests, its real build and the page-load check: all passed.
  const snap = await e2e.call('runs.get', { runId: run.runId })
  const commands = snap.steps['verify:1'].verify?.commands ?? []
  expect(commands.map((c) => [c.name, c.status])).toEqual([
    ['Tests', 'pass'],
    ['Build', 'pass'],
    ['Page loads (Dim Factory)', 'pass'],
  ])
  expect(existsSync(join(run.folder, 'dist', '404.html'))).toBe(true)

  // ---- Done: Look it over is offered for a website ----
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await expect(page.getByTestId('easy-done-look')).toBeVisible()

  // ---- Share it: Get it ready to share builds dist/ (the project permission covers the build) ----
  await page.getByTestId('easy-done-share').getByTestId('deploy-toggle').click()
  const build = page.getByTestId('deploy-build-run')
  await expect(build).toHaveText('Get it ready to share', { timeout: 60_000 })
  const width = (await build.boundingBox())?.width
  await build.click()
  await expect(page.getByTestId('deploy-build-status')).toHaveText(/^Ready to share: dist\/ is up to date/, {
    timeout: 180_000,
  })
  expect((await build.boundingBox())?.width).toBe(width)
  await expect(page.getByTestId('deploy-upload')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 })
  await page.getByTestId('deploy-upload-make').click()
  await expect(page.getByTestId('deploy-upload-status')).toHaveAttribute('data-state', 'made', {
    timeout: 60_000,
  })
  const shareSteps = await page.getByTestId('easy-done-share').innerText()
  expect(shareSteps).not.toContain(EM_DASH)

  // ---- Open it: dist/ through the static server, whose single-page fallback opens an inner page ----
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.getByTestId('easy-open-it').click()
  const preview = await opened
  await preview.waitForLoadState('load')
  await expect(preview.locator('h1')).toHaveText('Slow sourdough and seasonal bakes, made down the road', {
    timeout: 30_000,
  })
  const statics = (await e2e.call('preview.list')).filter((s) => s.commandId === 'static:dist')
  expect(statics.length).toBe(1)
  const base = statics[0]?.url ?? ''
  const inner = await fetch(new URL('about', base))
  expect(inner.status).toBe(200)
  expect(await inner.text()).toContain('<div id="root"></div>')
  await preview.goto(new URL('about', base).href)
  await expect(preview.locator('h1')).toHaveText('About')
  await preview.close()

  // ---- the dev server: the trusted preview command, its page loads ----
  await page.evaluate((folder) => {
    window.location.hash = `#/preview?folder=${encodeURIComponent(folder)}`
  }, run.folder)
  const row = page.getByTestId('run-it-command-pkg:dev')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('run-it-command-static:.')).toHaveCount(0)
  if ((await row.getAttribute('data-trust')) !== 'trusted')
    await page.getByTestId('run-it-trust-button-pkg:dev').click()
  await expect(row).toHaveAttribute('data-trust', 'trusted')
  await page.getByTestId('run-it-start-pkg:dev').click()
  const status = page.getByTestId('run-it-status')
  await expect(status).toContainText('Running npm run dev at http://127.0.0.1:', { timeout: 90_000 })
  await page.getByTestId('run-it-smoke').click()
  const smoke = page.getByTestId('run-it-smoke-result')
  await expect(smoke).toBeVisible({ timeout: 90_000 })
  await expect(smoke.getByTestId('run-it-smoke-summary')).toContainText('no console errors')
  await page.getByTestId('run-it-start-pkg:dev').click()
  await expect(status).toHaveText('npm run dev stopped.', { timeout: 30_000 })
  expect(e2e.pageErrors).toEqual([])
})

test('without Node.js: plain HTML; the page-load check fails on a console error, Fix repairs it', async ({
  e2e,
}) => {
  test.setTimeout(420_000)
  const broken =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tip splitter</title></head><body><h1>Tip splitter</h1>' +
    "<script>console.error('Cannot read the bill total')</script></body></html>\n"
  const fixed =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tip splitter</title></head><body><h1>Tip splitter</h1></body></html>\n'
  const page = await e2e.start({
    scenario: webScenario(
      { path: 'index.html', content: broken },
      {
        resume: [
          {
            recording: 'C08b-resume-fix',
            write: { path: 'index.html', content: fixed },
            text: 'Done.\n\nF1 fixed',
          },
        ],
      },
    ),
    editScenario: withCriteria,
    config: { ...EASY_CONFIG, ui: { experience: 'easy' }, easy: { skipPlanCheck: true } },
    env: { DIM_FACTORY_E2E_NODE: 'none' },
  })
  await toConfirm(page, 'A tip splitter app my friends can open on their phones')
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Static website')
  await expect(page.getByTestId('easy-stack-react')).toHaveCount(0)
  await expect(page.getByTestId('easy-stack-why')).toHaveText(
    /^Node\.js is not installed, so it is made with plain HTML/,
  )
  await expect(page.getByTestId('easy-node-steps')).toContainText('nodejs.org')
  await expect(page.getByTestId('easy-confirm-checks')).toHaveText(
    'Before it says it is ready, it opens the page to check it loads without errors.',
  )
  await page.getByTestId('easy-start').click()
  const run = await e2e.onlyRun()
  await throughPlan(page, { plan: false })
  const ended = await e2e.waitForEnd(run.runId, 300_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome, e2e.describeRun(ended)).toBe('fixed')
  const snap = await e2e.call('runs.get', { runId: run.runId })
  const first = snap.steps['verify:1'].verify?.commands ?? []
  expect(first.map((c) => [c.name, c.status])).toEqual([['Page loads (Dim Factory)', 'fail']])
  expect(first[0]?.excerpt).toContain('console error: Cannot read the bill total')
  const second = snap.steps['verify:2'].verify?.commands ?? []
  expect(second.map((c) => [c.name, c.status])).toEqual([['Page loads (Dim Factory)', 'pass']])
  expect(readFileSync(join(run.folder, 'index.html'), 'utf8')).toBe(fixed)
  // Fix was told what the check saw.
  expect(promptSent(e2e, 'resume-1.script.jsonl')).toContain('Cannot read the bill total')
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  // An app gets Look it over too.
  await expect(page.getByTestId('easy-done-look')).toBeVisible()
  expect(e2e.pageErrors).toEqual([])
})

test('the confirm screen: the AI proxy offer with its cost, and Plain HTML', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
    env: { DIM_FACTORY_E2E_NODE: '22.12.0' },
  })
  await toConfirm(page, 'An AI caption writer app for my photos')
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Website or app (React)')
  await expect(page.getByTestId('easy-need-question')).toHaveText(
    'Your idea uses an AI service. That needs a small server so your key stays secret. Set one up for you?',
  )
  await expect(page.getByTestId('easy-need-ai-proxy')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('easy-need-cost')).toContainText("Check the provider's current pricing")
  await expect(page.getByTestId('easy-need-hosts')).toContainText('Netlify or Cloudflare Pages')
  await expect(page.getByTestId('easy-works-lines')).toContainText('Your key is never in the page.')
  const html = page.getByTestId('easy-stack-html')
  const width = (await html.boundingBox())?.width
  await html.click()
  await expect(page.getByTestId('easy-confirm-kind')).toContainText('Static website')
  await expect(html).toHaveAttribute('aria-pressed', 'true')
  expect((await html.boundingBox())?.width).toBe(width)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
})

test('a Node.js too old for React: plain HTML, which version is needed, Check again', async ({ e2e }) => {
  test.setTimeout(180_000)
  const old = await e2e.start({
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
    env: { DIM_FACTORY_E2E_NODE: '18.20.4' },
  })
  await toConfirm(old, 'A tip splitter app for my friends')
  await expect(old.getByTestId('easy-stack-why')).toHaveText(
    "Node.js 18.20.4 is installed, but React's build tools need 20.19 or newer, so it is made with plain HTML: files that open in any browser. To make it with React instead, install Node.js 22 or newer, then press Check again.",
  )
  await old.getByTestId('easy-node-check-again').click()
  await expect(old.getByTestId('easy-node-check-again')).toBeEnabled()
  await expect(old.getByTestId('easy-confirm-kind')).toContainText('Static website')
})

test('the project permission covers a registry package and still asks for a global install', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    // Implement is the recording that asks; its page is written before the asks.
    scenario: {
      ...webScenario({ path: 'index.html', content: '' }),
      implement: [{ recording: 'C04a-ask-allow' }],
    },
    editScenario: (sc) => {
      withCriteria(sc)
      rewriteAsks(
        join(sc.dir, 'implement-1.script.jsonl'),
        [
          { tool: 'Bash', input: { command: 'npm install react-router-dom' } },
          { tool: 'Bash', input: { command: 'npm install -g serve' } },
        ],
        [
          { op: 'writeFile', path: 'package.json', content: JSON.stringify({ name: 'tips', private: true }) },
          {
            op: 'writeFile',
            path: 'index.html',
            content: '<!doctype html><title>Tips</title><h1>Tips</h1>\n',
          },
        ],
      )
    },
    config: { ...EASY_CONFIG, ui: { experience: 'easy' }, easy: { skipPlanCheck: true } },
    env: { DIM_FACTORY_E2E_NODE: 'none' },
  })
  await toConfirm(page, 'A tip splitter app for my friends')
  await page.getByTestId('easy-consent').click()
  await page.getByTestId('easy-start').click()
  const run = await e2e.onlyRun()
  await throughPlan(page, { plan: false })
  const ask = page.getByTestId('easy-ask')
  await expect(ask).toBeVisible({ timeout: 120_000 })
  await expect(ask).toContainText('npm install -g serve')
  await expect(page.getByTestId('easy-permission-uses')).toHaveText(
    'Approved under your project permission: 1',
  )
  await ask.getByTestId('easy-ask-deny').click()
  await e2e.waitForEnd(run.runId, 240_000)
  const bodies = await runBodies(e2e, run.runId)
  expect(
    bodiesOf(bodies, 'auto-answered')
      .filter((b) => b.why !== 'plan-capture')
      .map((b) => b.why),
  ).toEqual(['project-permission'])
})

test('a OneDrive-synced Documents folder: new projects go in the user folder, and it says why', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const documents = join(e2e.root, 'OneDrive', 'Documents')
  mkdirSync(documents, { recursive: true })
  const page = await e2e.start({
    config: { ...EASY_CONFIG, ui: { experience: 'easy' } },
    env: { DIM_FACTORY_E2E_DOCUMENTS: documents },
  })
  await toConfirm(page, 'A tip splitter app for my friends')
  await expect(page.getByTestId('easy-folder')).toHaveText(
    join(e2e.userHome, 'Dim Factory Projects', 'tip-splitter-app'),
  )
  await expect(page.getByTestId('easy-onedrive-note')).toContainText('synced with OneDrive')
  const state = await e2e.call('easy.state')
  expect(state.defaultProjectsReason).toBe('onedrive')
})
