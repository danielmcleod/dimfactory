// Research before Plan end to end, on the fake Claude in the temp sandbox. The composer's "Research first"
// switch turns it on for the run (it is off in the default profile) and moves nothing; the timeline shows the Research
// node before Plan from the start; Research answers with cited JSON (one claim uncited, dropped) and its review card
// waits with the must-haves and recommendations ticked; the user ticks a standard, unticks a recommendation and answers
// an open question; the kept items reach the Plan prompt as `{{research}}`, the Research card lists them, and the run
// goes on as usual.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'

const ANSWER = {
  summary: ['Version flags are table stakes for command line tools.'],
  features: [
    { feature: 'Print the version with --version', priority: 'must', sources: ['https://clig.dev/#help'] },
    { feature: 'Short -v alias', priority: 'could', sources: ['https://clig.dev/#arguments-and-flags'] },
    { feature: 'An uncited claim', priority: 'must', sources: [] },
  ],
  standards: [
    {
      standard: 'GNU --version output',
      why: 'Users expect it',
      sources: ['https://www.gnu.org/prep/standards/'],
    },
  ],
  options: [
    {
      topic: 'Where the version comes from',
      options: ['package.json', 'a constant'],
      recommendation: 'package.json',
      rationale: 'One source of truth',
      sources: ['repo:package.json'],
    },
  ],
  risks: [{ risk: 'Bundlers may inline a stale version', sources: ['https://example.org/stale'] }],
  questions: ['Should --version also print the commit?'],
  sources: [{ url: 'https://clig.dev/#help', title: 'Command Line Interface Guidelines' }],
}
const FENCED = `Here is the brief.\n\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``

test('research before Plan: reviewed inline, the kept items reach Plan', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      research: [{ recording: 'C02-review-shape', text: FENCED }],
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
        },
      ],
    },
    config: { gates: { afterPlan: true, beforeFix: false } },
  })

  // ---- the composer: "Research first" is off; turning it on moves nothing ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const toggle = page.getByTestId('composer-research')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const note = page.getByTestId('composer-research-note')
  const lenses = page.getByTestId('composer-research-lenses')
  const box = await note.boundingBox()
  const toggleBox = await toggle.boundingBox()
  const lensesBox = await lenses.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(lenses).toBeEnabled()
  expect((await note.boundingBox())?.y).toBe(box?.y)
  expect((await toggle.boundingBox())?.width).toBe(toggleBox?.width)
  expect((await lenses.boundingBox())?.width).toBe(lensesBox?.width)
  // The cost is shown before running (web research is token-heavy).
  await expect(note).toContainText(/token-heavy/i)
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('timeline-node-research')).toBeVisible()

  // ---- the research card: sections, the must-haves and recommendations ticked, the uncited claim dropped ----
  const card = page.getByTestId('card-research')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card).toContainText('Review the research')
  await expect(card).toContainText('Print the version with --version')
  await expect(card).not.toContainText('An uncited claim')
  await expect(card.getByTestId('research-dropped')).toContainText('One claim was left out')
  await expect(card.getByTestId('research-tick-f1')).toHaveAttribute('aria-checked', 'true')
  await expect(card.getByTestId('research-tick-o1')).toHaveAttribute('aria-checked', 'true')
  await expect(card.getByTestId('research-tick-s1')).toHaveAttribute('aria-checked', 'false')
  expect(await card.locator('a').count()).toBe(0)
  await expect(page.getByTestId('timeline-node-research')).toHaveAttribute('data-status', 'waiting')
  const snap = await e2e.snapshot(run.runId)
  expect(snap.summary.phase).toBe('research-review')
  expect(snap.steps.plan.status).toBe('queued')
  const height = (await card.boundingBox())?.height
  await card.getByTestId('research-tick-s1').click()
  await card.getByTestId('research-tick-o1').click()
  await card.getByTestId('research-answer-q1').fill('Yes, the short hash')
  // Ticking and typing never change the card's size.
  expect((await card.boundingBox())?.height).toBeCloseTo(height ?? 0, 0)
  await card.getByTestId('card-choice-use').click()
  await expect(card).toBeHidden()

  // ---- the kept items reach Plan's prompt; the Research step lists them ----
  await e2e.approvePlan()
  const plan = promptSent(e2e, 'plan-1.script.jsonl')
  expect(plan).toContain('Research the user reviewed for this run')
  expect(plan).toContain('[must] Print the version with --version')
  expect(plan).toContain('GNU --version output: Users expect it')
  expect(plan).toContain('Should --version also print the commit?\n  Answer: Yes, the short hash')
  expect(plan).not.toContain('Where the version comes from')
  const research = promptSent(e2e, 'research-1.script.jsonl')
  expect(research).toContain('untrusted data')
  const facts = page.getByTestId('research-facts')
  await expect(facts).toHaveAttribute('data-status', 'chosen')
  await expect(facts.getByTestId('research-kept')).toContainText('GNU --version output')

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('timeline-node-research')).toHaveAttribute('data-status', 'done')
  expect(await page.locator('body').innerText()).not.toContain('—')
  expect(e2e.pageErrors).toEqual([])
})
