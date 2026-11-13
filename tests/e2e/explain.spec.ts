// Explain it to me end to end, on the fake Claude in the temp sandbox. The composer's "Explain it to me"
// switch turns it on for the run and moves nothing; the timeline shows its node after the reviewers from the start;
// once the outcome is decided the run holds it while Explain (read-only, on the Plan pass's model, haiku here so the
// scenario tells it from Critic) writes a plain-language summary; the prompt names the files changed (not the diff)
// and how to run the project (its package.json start script). "After the run" shows explain.md inline with the light
// markdown component, in the page's one scroll region. No em dashes.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { setScripts } from './verify-helpers.ts'

const SUMMARY = [
  '## What was built',
  'The tool now tells you its version.',
  '',
  '## How to run it',
  '1. Open a terminal in the project folder.',
  '2. Type `npm start -- --version`.',
  '',
  '## What to try next',
  '- Run it without the flag.',
  '',
  '## Known limits',
  '- None known.',
].join('\n')

test('Explain it to me writes a plain-language summary shown at the end of the run', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
        },
      ],
      explain: [{ recording: 'C02-review-shape', text: SUMMARY }],
    },
    config: { gates: { afterPlan: false, beforeFix: false }, passes: { plan: { model: 'haiku' } } },
  })
  setScripts(e2e, { start: 'node src/cli.js' })

  // ---- the composer: "Explain it to me" is off; turning it on moves nothing ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const toggle = page.getByTestId('composer-explain')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const note = page.getByTestId('composer-explain-note')
  const noteBox = await note.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect((await note.boundingBox())?.y).toBe(noteBox?.y)
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('timeline-node-explain')).toBeVisible()

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  await expect(page.getByTestId('timeline-node-explain')).toHaveAttribute('data-status', 'done')

  // The prompt: for a non-developer, the files changed by name, how to run it from the project's own scripts.
  const prompt = promptSent(e2e, 'explain-1.script.jsonl')
  expect(prompt).toContain('for someone who does not write code')
  expect(prompt).toContain('- added: src/version.ts')
  expect(prompt).toContain('Ways Dim Factory found to run it:')
  expect(prompt).not.toContain('<diff>')

  // ---- "After the run": the summary inline, with headings and steps ----
  const section = page.getByTestId('run-end-explain')
  await expect(section).toBeVisible({ timeout: 30_000 })
  await expect(section.getByRole('heading', { name: 'Explain it to me' })).toBeVisible()
  const text = page.getByTestId('run-end-explain-text')
  await expect(text).toContainText('The tool now tells you its version.')
  await expect(text).toContainText('npm start -- --version')
  // Inline: no scroll box of its own.
  const overflow = await section.evaluate((el) => getComputedStyle(el).overflowY)
  expect(['visible', 'clip']).toContain(overflow)
  const out = await e2e.call('runs.output', { runId: run.runId, file: 'explain' })
  expect(out.text).toContain('## Known limits')

  expect(await page.locator('body').innerText()).not.toContain(String.fromCodePoint(0x2014))
  expect(e2e.pageErrors).toEqual([])
})
