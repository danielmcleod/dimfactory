// The sandbox chip, the Gemini variant ("Preflight: … Gemini trust chip clears the block"; readiness
// `trust`: "Gemini/Muse without a grant → fail, with a grant vendorFolder action"; Gemini launch "`--skip-trust`
// only with the vendorFolder grant"; trust.json `vendorFolder`; the grant executor, which runs only from a user
// click). Review runs on Gemini (the fake Gemini, through the real resolver and the npm shim) in a folder Gemini was
// never trusted in: the composer's preflight blocks with the trust chip as the fix, Run disabled with why, and nothing
// is written or started in the folder before the click. Clicking [Trust this folder for Gemini] writes the folder's
// grant to trust.json (recovery.execute), the live checks run again and the block clears; the button keeps its size
// through every state. The run then starts Gemini in the folder with `--skip-trust`, and the read-only Review raises no
// ask: the fake's permission requests are answered reject_once by Dim Factory itself.
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import { expectSteadyWidth, trackWidth } from './git-helpers.ts'
import { SHELL_HERE, readOnlyPass, revisitDashboard, samePath, vendorFolderGrants } from './gemini-helpers.ts'
import { GEMINI_NO_MCP } from '../../src/core/adapters/gemini/config.ts'
import { CLEAN_FLOW } from './scenarios.ts'

const CHECK = 'pass.review.readiness.trust'

test('Gemini: the trust chip clears the preflight block', { tag: ['@cross-os'] }, async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: CLEAN_FLOW,
    config: { passes: { review: { vendor: 'gemini', model: null } }, gates: { afterPlan: false } },
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
  await expect(page.getByTestId('vendor-health-gemini')).toHaveAttribute('data-health', 'ready', {
    timeout: 30_000,
  })
  // The setup card lists Gemini (and its trust chip) on a visit that starts with Gemini found.
  await revisitDashboard(page)

  // ---- the composer: Review on Gemini is blocked until the folder is trusted for it; the chip is the fix ----
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Gemini')
  const strip = page.getByTestId('preflight-strip')
  const block = strip.locator('[data-severity="blocking"]').filter({ hasText: 'Gemini' }).first()
  await expect(block).toBeVisible({ timeout: 30_000 })
  const run = page.getByTestId('composer-run')
  await expect(run).toBeDisabled()
  await expect(page.getByTestId('composer-run-status')).toHaveText('Fix 1 issue to run')
  await expect(strip.getByTestId('preflight-summary-text')).toContainText(
    'Gemini needs your OK for this folder',
  )
  await strip.getByTestId('preflight-details').click()
  const button = strip.getByTestId(`preflight-trust-${CHECK}`)
  const chip = strip.getByTestId(`preflight-trust-${CHECK}-chip`)
  await expect(button).toBeVisible()
  await expect(button).toHaveText('Trust this folder for Gemini')
  await expect(button).toHaveAttribute('data-kind', 'grant')
  await expect(button).toBeEnabled()
  await expect(chip).toHaveAttribute('data-phase', 'needed')
  await expect(chip).toHaveAttribute('data-vendor', 'gemini')
  await expect(strip.getByTestId(`preflight-trust-${CHECK}-status`)).toHaveText(
    'Gemini is not trusted in this folder yet',
  )
  await page.screenshot({ path: test.info().outputPath('e12-gemini-blocked.png') })
  // Nothing was trusted, and no Gemini ran in the folder, before the click.
  expect(vendorFolderGrants(e2e.home)).toEqual([])
  expect(fake.starts().filter((s) => samePath(s.cwd, e2e.sandbox))).toEqual([])

  // ---- the click: the grant is written; the live checks run again and the block clears ----
  await trackWidth(page, 'trust', `[data-testid="preflight-trust-${CHECK}"]`)
  await button.click()
  await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0, { timeout: 60_000 })
  await expect(run).toBeEnabled()
  await expect(page.getByTestId('composer-run-status')).toHaveText('')
  const grants = vendorFolderGrants(e2e.home)
  expect(grants).toHaveLength(1)
  expect(samePath(grants[0] ?? '', e2e.sandbox), `${grants[0]} is the sandbox`).toBe(true)
  await expect(toasts(page).filter({ hasText: /Gemini/ })).toHaveCount(1)
  // The setup card's chip for the composer's folder agrees (the same grant).
  await expect(page.getByTestId('setup-gemini-trust-chip')).toHaveAttribute('data-phase', 'trusted')
  await page.screenshot({ path: test.info().outputPath('e12-gemini-trusted.png') })
  await expectSteadyWidth(page, 'trust', 'Trust this folder for Gemini')

  // ---- the run: Gemini starts in the folder with --skip-trust; the read-only Review raises no ask ----
  await run.click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const summary = await e2e.onlyRun()
  const ended = await e2e.waitForEnd(summary.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const inFolder = fake.starts().filter((s) => samePath(s.cwd, e2e.sandbox))
  expect(inFolder).toHaveLength(1)
  // The read-only Review runs at Extensions None: no MCP server of Gemini's own settings may load.
  expect(inFolder[0]?.argv).toEqual(['--acp', '--skip-trust', '--allowed-mcp-server-names', GEMINI_NO_MCP])
  expect(fake.permissionAnswers().filter((a) => a.pid === inFolder[0]?.pid)).toEqual([
    { pid: inFolder[0]?.pid, optionId: 'cancel' },
  ])
  const snap = await e2e.snapshot(summary.runId)
  expect(snap.steps.review.vendor).toBe('gemini')
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
