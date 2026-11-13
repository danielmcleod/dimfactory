// Clarify before Plan end to end, on the fake Claude in the temp sandbox. The composer's "Clarify first"
// switch turns it on for the run (it is off in the default profile) and moves nothing; the timeline shows the Clarify
// node before Plan from the start; Clarify asks two questions (a fenced JSON answer) and its card waits; the user picks
// an option for one and writes their own answer for the other; the answers reach the Plan prompt through the brief, the
// Clarify card on the flow lists them, and the run goes on as usual.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'

const QUESTIONS = {
  questions: [
    {
      question: 'Which output format should --version print?',
      options: ['Just the number', 'Name and number'],
    },
    { question: 'Should it also accept -v?', options: ['Yes', 'No'] },
  ],
}
const FENCED = `Two choices change the plan.\n\n\`\`\`json\n${JSON.stringify(QUESTIONS)}\n\`\`\``

test('questions before Plan: answered inline, the answers reach Plan', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      clarify: [{ recording: 'C02-review-shape', text: FENCED }],
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' },
        },
      ],
    },
    // Clarify runs on the Plan pass's model: `haiku` here, so the fake tells it from Critic (opus).
    config: { gates: { afterPlan: true, beforeFix: false }, passes: { plan: { model: 'haiku' } } },
  })

  // ---- the composer: "Clarify first" is off, with a constant note; turning it on moves nothing ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const toggle = page.getByTestId('composer-clarify')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const note = page.getByTestId('composer-clarify-note')
  const noteText = await note.textContent()
  const box = await note.boundingBox()
  const toggleBox = await toggle.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(await note.textContent()).toBe(noteText)
  expect((await note.boundingBox())?.y).toBe(box?.y)
  expect((await toggle.boundingBox())?.width).toBe(toggleBox?.width)
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  await expect(page.getByTestId('timeline-node-clarify')).toBeVisible()

  // ---- the Clarify card: two questions, each with its options, Other and "Leave it to Plan" ----
  const card = page.getByTestId('card-clarify')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await expect(card).toContainText('2 questions before Plan')
  await expect(card).toContainText('Which output format should --version print?')
  await expect(card.getByTestId('clarify-q-0-none')).toBeChecked()
  await expect(page.getByTestId('timeline-node-clarify')).toHaveAttribute('data-status', 'waiting')
  // Waiting for the user: nothing else starts, even after a while.
  const snap = await e2e.snapshot(run.runId)
  expect(snap.summary.phase).toBe('clarifying')
  expect(snap.steps.plan.status).toBe('queued')
  const height = (await card.boundingBox())?.height
  await card.getByTestId('clarify-q-0-opt-1').check()
  await card.getByTestId('clarify-q-1-other-text').fill('Only --version, not -v')
  await expect(card.getByTestId('clarify-q-1-other')).toBeChecked()
  // Picking and typing never change the card's size.
  expect((await card.boundingBox())?.height).toBeCloseTo(height ?? 0, 0)
  await card.getByTestId('card-choice-answer').click()
  await expect(card).toBeHidden()

  // ---- the answers joined the brief: Plan's prompt has them; the Clarify step lists them ----
  await e2e.approvePlan()
  const plan = promptSent(e2e, 'plan-1.script.jsonl')
  expect(plan).toContain('Answers to the clarifying questions:')
  expect(plan).toContain('Which output format should --version print?\n  Answer: Name and number')
  expect(plan).toContain('Should it also accept -v?\n  Answer: Only --version, not -v')
  const facts = page.getByTestId('clarify-facts')
  await expect(facts).toHaveAttribute('data-status', 'answered')
  await expect(facts.getByTestId('clarify-answer-0')).toContainText('Name and number')
  await expect(facts.getByTestId('clarify-answer-1')).toContainText('Only --version, not -v')

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('timeline-node-clarify')).toHaveAttribute('data-status', 'done')
  expect(await page.locator('body').innerText()).not.toContain('—')
  expect(e2e.pageErrors).toEqual([])
})
