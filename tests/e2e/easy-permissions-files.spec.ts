// Easy mode's second phase end to end, on the fake Claude with an isolated home (the projects folder is beside
// the test's home, never a real Documents folder):
//  1. The project permission: "Allow these for this project" on the confirm screen. Implement's `npm install` and
//     `npm run dev` (the project's own manifest and script) are answered by core with no ask, and the run screen counts
//     them ("Approved under your project permission: 2"); a write outside the folder still asks, as a warning; the
//     permission is in Easy settings and taken back there while that ask waits: the next `npm install` asks. The Done
//     screen keeps the count; Settings no longer lists it.
//  2. A document with a file added: Add files (a CSV) shows the privacy line and the confirm screen lists it; Start copies
//     it into the new project's data/; the Done screen opens the rendered document in the sandboxed preview window (no
//     bridge, no Node) and Save as PDF writes a PDF beside it; "Remember this for next time" writes the project memory;
//     Share it says putting it online makes it public.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { rewriteAsks } from '../integration/easy/asks.ts'
import { expect, test } from './harness.ts'
import { bodiesOf, fakeProc, permissionAnswers, runBodies } from './attention-helpers.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { EASY_CONFIG, IDEA, QUESTIONS, SUMMARY, ideaToConfirm } from './easy-helpers.ts'

const EM_DASH = String.fromCodePoint(0x2014)
const PACKAGE = JSON.stringify({ name: 'shop', private: true, scripts: { dev: 'vite' } })

/** Easy chosen, the plan check off (the plan card is Phase 1's), Clarify and Explain on haiku. */
const CONFIG = { ...EASY_CONFIG, ui: { experience: 'easy' }, easy: { skipPlanCheck: true } }

async function waitForAsk(page: Page, text: string): Promise<void> {
  const ask = page.getByTestId('easy-ask')
  await expect(ask).toBeVisible({ timeout: 90_000 })
  await expect(ask).toContainText(text)
}

test('the project permission: installs and scripts approved and counted; outside still asks; revoke works at once', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const outside = join(e2e.root, 'outside', 'notes.txt')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow' }],
      explain: [
        { recording: 'C02-review-shape', text: JSON.stringify({ questions: [] }) },
        { recording: 'C02-review-shape', text: SUMMARY },
      ],
    },
    editScenario: (sc) =>
      rewriteAsks(
        join(sc.dir, 'implement-1.script.jsonl'),
        [
          { tool: 'Bash', input: { command: 'npm install' } },
          { tool: 'Bash', input: { command: 'npm run dev' } },
          { tool: 'Write', input: { file_path: outside, content: 'x' } },
          { tool: 'Bash', input: { command: 'npm install' } },
        ],
        [{ op: 'writeFile', path: 'package.json', content: PACKAGE }],
      ),
    config: CONFIG,
  })
  await expect(page).toHaveURL(/#\/easy$/)
  await ideaToConfirm(page)
  const consent = page.getByTestId('easy-confirm-consent')
  await expect(consent).toContainText('Only in this new folder')
  await expect(consent).not.toContainText('still asks you each time')
  await page.getByTestId('easy-consent').click()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('easy-run-project')).toHaveText(
    'Help guide for the customers of my knitting shop',
  )

  // ---- the install and the script went by with no ask; the write outside the folder asks, as a warning ----
  await waitForAsk(page, outside)
  await expect(page.getByTestId('easy-ask')).toContainText('outside the project folder')
  await expect(page.getByTestId('easy-permission-uses')).toHaveText(
    'Approved under your project permission: 2',
  )

  // ---- taken back in Easy settings while that ask waits ----
  await page.getByTestId('nav-easy-settings').click()
  const list = page.getByTestId('easy-permissions')
  await expect(list.getByTestId('easy-permissions-row')).toHaveCount(1)
  await expect(list.getByTestId('easy-permissions-row')).toContainText(
    'Approved under your project permission: 2',
  )
  await list.getByTestId('easy-permissions-revoke').click()
  await expect(list.getByTestId('easy-permissions-state')).toHaveText('No project has this permission.')
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#/easy/runs/${run.runId}$`))
  await page.getByTestId('easy-ask').getByTestId('easy-ask-allow').click()

  // ---- the next install asks now ----
  await waitForAsk(page, 'npm install')
  await page.getByTestId('easy-ask').getByTestId('easy-ask-allow').click()

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('easy-done-title')).toBeVisible()
  await expect(page.getByTestId('easy-done-project')).toHaveText(
    'Help guide for the customers of my knitting shop',
  )
  await expect(page.getByTestId('easy-permission-uses')).toHaveText(
    'Approved under your project permission: 2',
  )
  // No stale approval toast on the Done screen.
  await expect(page.getByText(/needs approval/)).toHaveCount(0)

  // What the vendor got: four allows; core answered the first two itself (no ask was raised for them).
  const answers = permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))
  expect(answers.map((a) => a.behavior)).toEqual(['allow', 'allow', 'allow', 'allow'])
  const bodies = await runBodies(e2e, run.runId)
  expect(
    bodiesOf(bodies, 'auto-answered')
      .filter((b) => b.why !== 'plan-capture')
      .map((b) => b.why),
  ).toEqual(['project-permission', 'project-permission'])
  expect(bodiesOf(bodies, 'ask-resolved').map((b) => [b.by, b.decision])).toEqual([
    ['user', 'allow'],
    ['user', 'allow'],
  ])
  expect(existsSync(outside)).toBe(false)

  // Settings, Vendors lists none now.
  await page.getByTestId('experience-full').click()
  // The switch opens the same run in the Full view first.
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
  await page.evaluate(() => (window.location.hash = '#/settings/vendors'))
  await expect(page.getByTestId('settings-easy-permissions-state')).toHaveText(
    'No project has this permission.',
  )
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})

test('a document with a CSV: Add files, the rendered document in the preview window, Save as PDF, Remember, Share it', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  const csv = join(e2e.root, 'shop-orders.csv')
  writeFileSync(csv, 'month,orders\nJan,12\nFeb,15\n')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          prepend: [
            {
              op: 'writeFile',
              path: 'docs/index.md',
              content: '# Knitting shop help\n\nSee [ordering](ordering.md).\n\n<script>alert(1)</script>\n',
            },
          ],
          write: { path: 'docs/ordering.md', content: '# Ordering\n\nOrder online.\n' },
        },
      ],
      explain: [
        { recording: 'C02-review-shape', text: JSON.stringify(QUESTIONS) },
        { recording: 'C02-review-shape', text: SUMMARY },
      ],
    },
    config: CONFIG,
    pickFiles: [csv],
  })
  await expect(page).toHaveURL(/#\/easy$/)

  // ---- Add files: checked by core, the privacy line ----
  await page.getByTestId('easy-idea').fill(IDEA)
  await page.getByTestId('easy-attach-add').click()
  const row = page.getByTestId('easy-attach-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('shop-orders.csv')
  await expect(row).toContainText('Copied into data/')
  await expect(page.getByTestId('easy-privacy')).toHaveText(
    'Your file is sent to Claude or Codex to build the report.',
  )
  await page.getByTestId('easy-next').click()
  await expect(page.getByTestId('easy-confirm-kind')).toBeVisible()
  await expect(page.getByTestId('easy-confirm-files')).toContainText('shop-orders.csv')
  await expect(page.getByTestId('easy-confirm-privacy')).toBeVisible()
  await page.getByTestId('easy-start').click()
  await expect(page).toHaveURL(/#\/easy\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  // Copied into the new project's data/ before the run, and the run was told.
  expect(readFileSync(join(run.folder, 'data', 'shop-orders.csv'), 'utf8')).toContain('Jan,12')
  expect(existsSync(csv)).toBe(true)

  // The plain questions (one), then the run goes on.
  const questions = page.getByTestId('easy-card-questions')
  await expect(questions).toBeVisible({ timeout: 90_000 })
  await questions.getByTestId('easy-q-0-opt-0').check()
  await questions.getByTestId('easy-continue').click()

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(promptSent(e2e, 'implement-1.script.jsonl')).toContain('data/shop-orders.csv')
  // The summary was asked for as a document's ("How to open it").
  expect(promptSent(e2e, 'explain-2.script.jsonl')).toContain('## How to open it')
  await expect(page.getByTestId('easy-done-title')).toBeVisible()

  // ---- Open it: the rendered document in Dim Factory's sandboxed preview window ----
  const app = e2e.app
  if (app === null) throw new Error('no app')
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.getByTestId('easy-open-it').click()
  const preview: Page = await opened
  await preview.waitForLoadState('domcontentloaded')
  expect(preview.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  await expect(preview.locator('h1').first()).toHaveText('Knitting shop help')
  await expect(preview.locator('nav.contents')).toContainText('Ordering')
  // Raw HTML in the Markdown is text; the page has no bridge and no Node.
  await expect(preview.locator('script')).toHaveCount(0)
  expect(
    await preview.evaluate(() => ({
      bridge: 'dimFactory' in window,
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    })),
  ).toEqual({ bridge: false, require: 'undefined', process: 'undefined' })

  // ---- Save as PDF: beside the document ----
  await page.getByTestId('easy-save-pdf').click()
  await expect(page.getByTestId('easy-open-note')).toHaveText('Saved as docs.pdf in the project folder.', {
    timeout: 60_000,
  })
  const pdf = readFileSync(join(run.folder, 'docs.pdf'))
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  expect(pdf.length).toBeGreaterThan(1000)

  // ---- Remember this for next time ----
  const remember = page.getByTestId('easy-remember')
  await expect(remember).toBeEnabled({ timeout: 30_000 })
  await remember.click()
  await expect(page.getByTestId('easy-remembered')).toBeVisible()
  const memory = await e2e.call('memory.get', { folder: run.folder })
  expect(memory.exists).toBe(true)
  expect(memory.pending).toEqual([])

  // ---- Share it: folded, public ----
  await expect(page.getByTestId('easy-done-share')).toContainText('Putting it online makes it public.')
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})
