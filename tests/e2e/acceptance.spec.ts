// The acceptance review end to end, on the fake Claude in the temp sandbox. The composer's "Acceptance
// review" switch turns it on for the run (off in the default profile) and moves nothing; the user adds an
// `## Acceptance criteria` section to the plan at its gate; the timeline shows the Acceptance review node before
// Review; the review (read-only, on Review's model, so it takes the scenario's first review entry) answers one
// criterion met and one not met with evidence; without Fix until green that is a summary only (the run completes
// clean, no findings). The review's card and "After the run" show the checklist: status word, criterion, evidence.
// No em dashes.
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'

const VERDICTS = {
  verdicts: [
    { id: 'AC1', status: 'met', evidence: 'src/version.ts exports 1.0.0' },
    { id: 'AC2', status: 'not-met', evidence: 'the help text was not changed' },
  ],
}

const CRITERIA = '\n## Acceptance criteria\n- `--version` prints 1.0.0\n- The help text lists --version\n'

test('the acceptance review checks the plan criteria and shows a checklist', async ({ e2e }) => {
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
      review: [{ recording: 'C02-review-shape', text: JSON.stringify(VERDICTS), structured: VERDICTS }],
    },
    config: { gates: { afterPlan: true, beforeFix: false } },
  })

  // ---- the composer: "Acceptance review" is off; turning it on moves nothing ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const toggle = page.getByTestId('composer-acceptance')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const note = page.getByTestId('composer-acceptance-note')
  const noteBox = await note.boundingBox()
  const toggleBox = await toggle.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('composer-acceptance-provenance')).toHaveAttribute('data-source', 'run')
  expect((await note.boundingBox())?.y).toBe(noteBox?.y)
  expect((await note.boundingBox())?.x).toBe(noteBox?.x)
  expect((await toggle.boundingBox())?.width).toBe(toggleBox?.width)
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  // Planned from the start: the node is there before the review begins.
  await expect(page.getByTestId('timeline-node-acceptance')).toBeVisible()

  // ---- the plan gate: the user adds the acceptance criteria ----
  const gate = page.getByTestId('card-gate:afterPlan')
  await expect(gate).toBeVisible({ timeout: 90_000 })
  await gate.getByTestId('plan-edit').click()
  const editor = gate.getByTestId('plan-editor')
  const original = await editor.inputValue()
  await editor.fill(`${original.trimEnd()}\n${CRITERIA}`)
  await gate.getByTestId('card-choice-approve').click()
  await expect(gate).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')

  // The review read the criteria and the change; Implement was told to build to them.
  const prompt = promptSent(e2e, 'review-1.script.jsonl')
  expect(prompt).toContain('You are the acceptance review')
  expect(prompt).toContain('- AC2: The help text lists --version')
  expect(promptSent(e2e, 'implement-1.script.jsonl')).toContain(
    'Acceptance criteria (build to meet each one)',
  )

  // ---- the checklist on the review's card and after the run ----
  await expect(page.getByTestId('timeline-node-acceptance')).toHaveAttribute('data-status', 'done')
  const facts = page.getByTestId('acceptance-facts')
  await expect(facts).toHaveAttribute('data-review', 'done')
  await expect(facts.getByTestId('acceptance-facts-line')).toHaveText(
    'Acceptance: 1 of 2 criteria met, 1 not met.',
  )
  const end = page.getByTestId('run-end-acceptance')
  await expect(end).toBeVisible()
  await expect(end.getByTestId('acceptance-status-AC1')).toHaveText('Met')
  await expect(end.getByTestId('acceptance-status-AC2')).toHaveText('Not met')
  await expect(end.getByTestId('acceptance-evidence-AC2')).toHaveText('the help text was not changed')
  // A summary only: no finding, Fix skipped.
  const snap = await e2e.snapshot(run.runId)
  expect(snap.summary.findings).toEqual({ must: 0, should: 0 })
  expect(snap.acceptance?.counts).toEqual({ met: 1, notMet: 1, unknown: 0, notChecked: 0 })
  const json = await e2e.call('runs.output', { runId: run.runId, file: 'acceptance' })
  expect(json.text).toContain('"AC2"')

  expect(await page.locator('body').innerText()).not.toContain(String.fromCodePoint(0x2014))
  expect(e2e.pageErrors).toEqual([])
})
