// Start a new project from the Dashboard, end to end with the fake Claude. New project… opens the
// dialog; the templates are listed by category; the static-site template has no official starter (the row says so),
// Vite + React shows its command with a Copy button. Create project makes the folder in the test's temp root and
// initializes git with nothing committed; the composer then shows the folder, the template's task (with "What should
// it do?"), the template's Brief and its recipe, with the focus on Run. Run (with the recipe set to None) builds the scaffold in the fresh repository (an unborn
// HEAD): Plan → gate → Implement → Review ∥ Critic → completed. No em dashes.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'

const EM_DASH = String.fromCodePoint(0x2014)

test('New project from the Dashboard: create, the composer prefilled, run in the fresh repo', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: { path: 'index.html', content: '<!doctype html><title>Hello</title><h1>Hello</h1>\n' },
        },
      ],
    },
  })
  await expect(page.getByTestId('composer')).toBeVisible()

  // ---- the dialog ----
  await page.getByTestId('composer-new-project').click()
  const dialog = page.getByTestId('new-project')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('new-project-group-software')).toContainText('Vite + React + TypeScript')
  await expect(dialog.getByTestId('new-project-group-documents')).toContainText('Documentation site')
  await expect(dialog.getByTestId('new-project-command')).toHaveText(
    'npm create vite@latest . -- --template react-ts',
  )
  const copy = dialog.getByTestId('new-project-copy')
  const width = (await copy.boundingBox())?.width
  await dialog.getByTestId('new-project-template-static-site').click()
  await expect(dialog.getByTestId('new-project-starter')).toContainText('No official starter command')
  await dialog.getByTestId('new-project-template-vite-react').click()
  await expect(copy).toBeVisible()
  expect((await copy.boundingBox())?.width).toBe(width)
  await dialog.getByTestId('new-project-template-static-site').click()

  await dialog.getByTestId('new-project-parent').fill(e2e.root)
  await dialog.getByTestId('new-project-name').fill('hello-site')
  await dialog.getByTestId('new-project-goal').fill('A page that says hello')
  const folder = join(e2e.root, 'hello-site')
  await expect(dialog.getByTestId('new-project-path')).toHaveText(`Creates ${folder}`)
  expect(await dialog.innerText()).not.toContain(EM_DASH)
  await dialog.getByTestId('new-project-create').click()
  await expect(dialog).toBeHidden()

  // ---- the folder: created, a repository with nothing committed ----
  expect(readdirSync(folder)).toEqual(['.git'])

  // ---- the composer: folder, task and Brief; Run has the focus ----
  await expect(page.getByTestId('composer-folder-input')).toHaveValue(folder)
  const task = page.getByTestId('composer-task')
  await expect(task).toHaveValue(/^Scaffold a static website/)
  await expect(task).toHaveValue(/What it should do: A page that says hello$/)
  await expect(page.getByTestId('brief-summary')).toContainText('choices')
  await expect(page.getByTestId('composer-run')).toBeFocused()
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  // The template's recipe is chosen in the Recipe menu. This test's fake CLI scripts only Plan and Implement, so it
  // goes on without the recipe's extra steps (None), as a user may.
  const picker = page.getByTestId('composer-recipe')
  await expect(picker).toContainText('New web app')
  await picker.click()
  await page.getByRole('option', { name: 'None' }).click()
  await expect(picker).toContainText('None')

  // ---- Run: the scaffold is built in the fresh repository ----
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  expect(run.folder).toBe(folder)
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(existsSync(join(folder, 'index.html'))).toBe(true)
  expect(await page.locator('body').innerText()).not.toContain(EM_DASH)
  expect(e2e.pageErrors).toEqual([])
})
