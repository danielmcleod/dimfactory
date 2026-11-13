// A recipe end to end, on the fake Claude in the temp sandbox. A user recipe file (`<home>/recipes/`) is
// listed in the composer's Recipe menu after the built-in ones; picking it turns its switch on in the composer (core
// resolves it as the recipe layer), uses its task hint and moves nothing; the run researches as the recipe says, and
// the Run view's header names the recipe. Settings > Recipes lists it with its layer.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'

const ANSWER = {
  summary: ['Version flags are table stakes for command line tools.'],
  features: [
    { feature: 'Print the version with --version', priority: 'must', sources: ['https://clig.dev/#help'] },
  ],
  standards: [],
  options: [],
  risks: [],
  questions: [],
  sources: [{ url: 'https://clig.dev/#help', title: 'Command Line Interface Guidelines' }],
}
const FENCED = `\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``

const RECIPE = {
  id: 'research-first',
  version: 1,
  label: 'Research first',
  description: 'Study the problem space before planning.',
  toggles: { research: true, clarify: false },
  taskHint: 'What should Dim Factory look into first?',
}

test('pick a recipe in the composer, run it, see it on the run', async ({ e2e }) => {
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
    config: { gates: { afterPlan: false, beforeFix: false } },
  })
  // A recipe of the user's own (read when the composer lists recipes for the folder).
  mkdirSync(join(e2e.home, 'recipes'), { recursive: true })
  writeFileSync(join(e2e.home, 'recipes', 'research-first.json'), `${JSON.stringify(RECIPE, null, 2)}\n`)

  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const research = page.getByTestId('composer-research')
  await expect(research).toHaveAttribute('aria-checked', 'false')

  // ---- the Recipe menu: None, the built-in recipes, then the user's ----
  const picker = page.getByTestId('composer-recipe')
  await expect(picker).toBeEnabled()
  await expect(picker).toContainText('None')
  const row = page.getByTestId('composer-recipe-row')
  const rowBox = await row.boundingBox()
  const pickerBox = await picker.boundingBox()
  const taskBox = await page.getByTestId('composer-task').boundingBox()
  await picker.click()
  await expect(page.getByRole('option', { name: 'New web app' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Data report' })).toBeVisible()
  await page.getByRole('option', { name: 'Research first (User)' }).click()
  await expect(picker).toContainText('Research first')
  await expect(page.getByTestId('composer-recipe-note')).toContainText('Turns on Research.')
  // The recipe's switch comes from core's resolve with the recipe layer.
  await expect(research).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('composer-task')).toHaveAttribute(
    'placeholder',
    'What should Dim Factory look into first?',
  )
  // Choosing moves nothing.
  expect((await row.boundingBox())?.y).toBe(rowBox?.y)
  expect((await picker.boundingBox())?.width).toBe(pickerBox?.width)
  expect((await page.getByTestId('composer-task').boundingBox())?.y).toBe(taskBox?.y)

  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()

  // ---- the run: the recipe in the header and the summary; its Research step runs ----
  await expect(page.getByTestId('run-recipe')).toHaveText('Recipe: Research first')
  const snap = await e2e.snapshot(run.runId)
  expect(snap.summary.recipe).toMatchObject({ id: 'research-first', label: 'Research first', layer: 'user' })
  const card = page.getByTestId('card-research')
  await expect(card).toBeVisible({ timeout: 120_000 })
  await card.getByTestId('card-choice-use').click()
  await expect(card).toBeHidden()
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  await expect(page.getByTestId('timeline-node-research')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('run-recipe')).toHaveText('Recipe: Research first')

  // ---- Settings > Recipes: the user's recipe with its layer ----
  await page.evaluate(() => (location.hash = '#/settings/recipes'))
  const item = page.getByTestId('recipe-research-first')
  await expect(item).toBeVisible()
  await expect(page.getByTestId('recipe-research-first-layer')).toHaveText('User')
  await expect(page.getByTestId('recipe-bug-fix-layer')).toHaveText('Built in')
  expect(await page.locator('body').innerText()).not.toContain('—')
  expect(e2e.pageErrors).toEqual([])
})
