// Flow ("override a prompt for one project"; the done-check: a tester who hasn't read the docs completes the
// flow using only in-app text; template lookup "project .dimfactory/prompts/<name>.md → DIM_FACTORY_HOME/prompts/<name>.md
// → builtin"; Settings → Prompts).
// Driven the way a tester would, by what the screen says: roles, names and visible text, never test ids. From the
// Dashboard the tester opens Settings → Prompts, reads which template Dim Factory uses, picks "One project" and the
// project's folder, edits the Implement prompt and saves it for that project. The page says it is now that project's
// own template and that only runs there use it; their own scope still reads Built-in. The next run in that folder
// sends the new text to the vendor (the fake CLI's stdin).
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { CLEAN_FLOW } from './scenarios.ts'

const RULE = 'Team rule: explain each change in one short sentence.'

test('Flow: override a prompt for one project, using only in-app text', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({ scenario: CLEAN_FLOW, pickSandbox: true })

  // ---- Settings → Prompts says what it is for and which template wins ----
  await page.getByRole('link', { name: /^Settings/ }).click()
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Prompts' })
    .click()
  const section = page.getByRole('region', { name: 'Prompts' })
  await expect(section).toContainText('Change one for yourself, in every project, or for one project only.')
  await expect(section).toContainText("Dim Factory uses the first template it finds: the project's own")

  // ---- "One project", then the project's folder ----
  await section.getByRole('radio', { name: 'One project' }).check()
  await expect(section).toContainText('Choose the project.')
  await section.getByRole('button', { name: 'Choose folder…' }).click()
  await expect(section).toContainText(e2e.sandbox)
  await expect(section).toContainText(
    "Saved in ts-small's .dimfactory/prompts folder. Only runs in ts-small use it",
  )

  // ---- the Implement prompt: the built-in one for now ----
  await section.getByRole('tab', { name: 'Implement', exact: true }).click()
  await expect(section).toContainText('In use now:')
  await expect(section).toContainText('ts-small has no template of its own yet: it uses the built-in one.')
  const box = section.getByRole('textbox', { name: 'Implement prompt' })
  await expect(box).toBeEnabled()
  const builtin = await box.inputValue()
  expect(builtin).toContain('{{task}}')
  await box.fill(`${RULE}\n\n${builtin}`)
  await expect(section.getByRole('status').filter({ hasText: /^Unsaved changes$/ })).toBeVisible()

  await section.getByRole('button', { name: 'Save for this project' }).click()
  await expect(
    toasts(page).filter({ hasText: 'Saved the Implement prompt for ts-small. Runs there use it now.' }),
  ).toHaveCount(1)
  await expect(section).toContainText("ts-small's own template")
  await expect(section).toContainText('This project')
  await expect(section.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()

  // ---- their own scope (every other project) is unchanged ----
  await section.getByRole('radio', { name: 'You, in every project' }).check()
  await expect(section).toContainText('You have not changed this prompt: the text below is the built-in one.')
  await expect(section.getByRole('textbox', { name: 'Implement prompt' })).not.toHaveValue(new RegExp(RULE))

  // ---- the next run in that folder uses it ----
  await page.getByRole('link', { name: /^Dashboard/ }).click()
  const run = await e2e.runFromDashboard('add a --version flag')
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await gate.getByRole('button', { name: 'Approve' }).click({ timeout: 90_000 })
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  const sent = promptSent(e2e, 'implement-1.script.jsonl')
  expect(sent).toContain(RULE)
  expect(sent).toContain('add a --version flag')
  expect(e2e.pageErrors).toEqual([])
})
