// Plan edit: edit the plan at the gate after Plan → "View changes" shows the diff
// against the original → Approve sends the edited plan → Implement's prompt (the fake's stdin) contains the edit →
// the Plan card shows the edited chip, and the summary bar says "(edited)".
import { stdinByScript } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { CLEAN_FLOW } from './scenarios.ts'

const ADDED = '- E2E edit: also print the version in the --help footer.'

/** The text of the first `user` message on a script's stdin. */
function userText(lines: readonly string[]): string {
  for (const line of lines) {
    const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] | string } }
    if (v.type !== 'user') continue
    const c = v.message?.content
    return typeof c === 'string' ? c : (c ?? []).map((x) => x.text ?? '').join('')
  }
  return ''
}

test('an edited plan reaches Implement and is marked edited', { tag: '@cross-os' }, async ({ e2e }) => {
  const page = await e2e.start({ scenario: CLEAN_FLOW, pickSandbox: true })
  // Choose folder… (DIM_FACTORY_E2E_PICK_FOLDER) and Ctrl+Enter this time.
  const run = await e2e.runFromDashboard('add a --version flag', { pick: true, keyboard: true })

  const gate = page.getByTestId('card-gate:afterPlan')
  await expect(gate).toBeVisible({ timeout: 90_000 })
  await expect(gate.getByTestId('plan-view-changes')).toHaveCount(0)
  await gate.getByTestId('plan-edit').click()
  const editor = gate.getByTestId('plan-editor')
  await expect(editor).toBeVisible()
  const original = await editor.inputValue()
  expect(original).toContain('--version')
  await editor.fill(`${original.trimEnd()}\n${ADDED}\n`)

  // "View changes" opens the diff against the original; the counts are status text beside it ("Edited · +1 −0").
  const changes = gate.getByTestId('plan-view-changes')
  await expect(changes).toHaveText('View changes')
  await expect(gate.getByTestId('plan-edit-counts')).toHaveText('Edited · +1 −0')
  await changes.click()
  const diff = gate.getByTestId('plan-gate-diff')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText(ADDED)

  const approve = gate.getByTestId('card-choice-approve')
  await expect(approve).toContainText('Approve edited plan')
  await approve.click()
  await expect(gate).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // The fake Implement received the edited plan in its prompt; the original Plan output is kept aside.
  const implementPrompt = userText(stdinByScript(e2e.fakeLog()).get('implement-1.script.jsonl') ?? [])
  expect(implementPrompt).toContain(ADDED)
  const plan = await e2e.call('runs.output', { runId: run.runId, file: 'plan' })
  expect(plan.text).toContain(ADDED)
  const originalOut = await e2e.call('runs.output', { runId: run.runId, file: 'plan.original' })
  expect(originalOut.text).not.toContain(ADDED)

  // The Plan card's header chip ("Edited +1 −0") opens the same diff; the summary bar says edited.
  const chip = page.getByTestId('plan-edited-chip')
  await expect(chip).toHaveText(/Edited \+1 −0/)
  await chip.click()
  await expect(page.getByTestId('plan-edit-diff')).toContainText(ADDED)
  await expect(page.getByTestId('summary-plan')).toHaveText('Plan ✓ approved (edited)')

  expect(e2e.pageErrors).toEqual([])
})
