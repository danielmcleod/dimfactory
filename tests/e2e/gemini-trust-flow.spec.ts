// Flow ("trust a folder for Gemini"; the done-check: a tester who hasn't read the docs completes the flow using
// only in-app text; readiness `trust`, when probes run ("More" list: selecting a vendor probes it), trust.json
// `vendorFolder`, the grant executor). Driven the way
// a tester would, by what the screen says: roles, names and visible text, never test ids. Gemini is installed and
// signed in (the fake Gemini), and nothing uses it yet. The tester picks a folder, types a task, opens the passes and
// chooses Gemini for Review from the vendor list's "More" group. Run then says what to fix ("Fix 1 issue to run") and
// the check says Gemini needs the user's OK for this folder; its details say what trusting means and offer
// [Trust this folder for Gemini]. One click: the folder is trusted ("This folder is trusted for Gemini"), the issue is
// gone and Run works. The run goes through: Claude plans and implements, Gemini reviews, read-only, with no question.
import { expect, test } from './harness.ts'
import { SHELL_HERE, readOnlyPass, samePath, vendorFolderGrants } from './gemini-helpers.ts'
import { GEMINI_NO_MCP } from '../../src/core/adapters/gemini/config.ts'
import { CLEAN_FLOW } from './scenarios.ts'

test('Flow: trust a folder for Gemini, using only in-app text', { tag: ['@cross-os'] }, async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: CLEAN_FLOW,
    gemini: {
      readOnly: readOnlyPass({
        asks: [
          {
            toolCallId: 'run_shell_command-e2e-1',
            kind: 'execute',
            title: 'npm test',
            content: `${SHELL_HERE} (Run the test suite)`,
          },
        ],
        text: 'NO FINDINGS',
        usage: { input: 12_288, cached: 8_192, output: 420, thought: 128 },
      }),
    },
  })
  const fake = e2e.gemini
  if (fake === null) throw new Error('no fake Gemini')

  // ---- the Dashboard: a folder and a task; nothing in the way yet ----
  const where = page.getByRole('textbox', { name: 'Folder', exact: true })
  await where.fill(e2e.sandbox)
  await where.press('Enter')
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('add a --version flag')
  // The composer (a compact copy of its Run row shows over the page once that row is scrolled past).
  const composer = page.getByRole('region', { name: 'New run' })
  const run = composer.getByRole('button', { name: 'Run', exact: true })
  await expect(run).toBeEnabled({ timeout: 30_000 })

  // ---- the passes: Review on Gemini, from "More" ----
  await page.getByRole('button', { name: 'Passes' }).click()
  await page.getByRole('button', { name: /^Review · Claude/ }).click()
  const review = page.getByRole('group', { name: 'Review settings' })
  await review.getByRole('combobox', { name: 'Vendor' }).click()
  await page.getByRole('option', { name: /^Gemini/ }).click()
  await expect(review.getByRole('combobox', { name: 'Vendor' })).toContainText('Gemini')

  // ---- Run says what is in the way: Gemini needs the user's OK for this folder ----
  await expect(composer.getByText('Fix 1 issue to run', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(run).toBeDisabled()
  await expect(
    composer.getByText(/1 issue blocks the run: Gemini needs your OK for this folder/),
  ).toBeVisible()

  // ---- the details say what trusting means and offer the grant; one click ----
  await composer.getByRole('button', { name: 'Show details', exact: true }).click()
  const issue = composer.getByRole('listitem').filter({ hasText: 'Gemini needs your OK for this folder' })
  await expect(issue.getByText('Gemini is not trusted in this folder yet')).toBeVisible()
  await expect(
    issue.getByText(/Gemini may read and act in this folder without its own trust prompt/),
  ).toBeVisible()
  await expect(issue.getByText(/revoke it later in Settings/)).toBeVisible()
  const trust = issue.getByRole('button', { name: 'Trust this folder for Gemini' })
  await expect(trust).toBeEnabled()
  await trust.click()

  // ---- the folder is trusted, the issue is gone, Run works ----
  await expect(page.getByText(/This folder is trusted for Gemini/).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Fix 1 issue to run', { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await expect(run).toBeEnabled({ timeout: 30_000 })
  const grants = vendorFolderGrants(e2e.home)
  expect(grants.length === 1 && samePath(grants[0] ?? '', e2e.sandbox), JSON.stringify(grants)).toBe(true)
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)

  // ---- the run: Claude plans (approved at its gate) and implements, Gemini reviews without a question ----
  const gate = page
    .getByRole('region', { name: /plan/i })
    .filter({ has: page.getByRole('button', { name: 'Approve' }) })
  await gate.getByRole('button', { name: 'Approve' }).click({ timeout: 90_000 })
  const runId = /#\/runs\/([^/]+)$/.exec(page.url())?.[1] ?? ''
  const end = await e2e.waitForEnd(runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible()
  const inFolder = fake.starts().filter((s) => samePath(s.cwd, e2e.sandbox))
  // The read-only Review runs at Extensions None: no MCP server of Gemini's own settings may load.
  expect(inFolder.map((s) => s.argv)).toEqual([
    ['--acp', '--skip-trust', '--allowed-mcp-server-names', GEMINI_NO_MCP],
  ])
  expect(fake.permissionAnswers().map((a) => a.optionId)).toEqual(['cancel'])
  expect((await e2e.snapshot(runId)).asks).toEqual([])
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
