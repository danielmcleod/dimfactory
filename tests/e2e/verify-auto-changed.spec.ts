// Auto and a changed script (verify commands and trust: "The body is re-read before each round. If
// it changed: non-Auto → trust card; Auto → skip the command and add a [should] finding. Auto never implies trust";
// "body change → new hash → trust card (Auto: skipped + [should])"). The project's check script was
// trusted, then edited: its hash no longer matches the grant. A run started with the composer's Auto switch opens no
// card: verify:1 skips the command (its card says why and links to Settings to trust it), a [should] finding from
// Verify says it was not run, core's note says Auto never trusts on its own, and nothing ran. A [should] does not
// block the Fix skip rule, so Fix is skipped and the outcome names the finding instead of "no findings".
import { expect, test } from './harness.ts'
import {
  CHECK_SCRIPT,
  PASSING_FLOW,
  findingsOf,
  setScripts,
  trustCommand,
  verifyConfig,
  writeSandbox,
} from './verify-helpers.ts'
import { fullMode } from './attention-helpers.ts'

const ARGV = ['npm', 'run', 'check'] as const

test('Auto skips a command whose script changed since it was trusted, with a [should]', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: PASSING_FLOW,
    editScenario: fullMode,
    config: verifyConfig([{ name: 'check', run: [...ARGV] }]),
  })
  writeSandbox(e2e, { 'check.mjs': CHECK_SCRIPT })
  setScripts(e2e, { check: 'node check.mjs' })
  await trustCommand(e2e, ARGV)
  // The script changes after it was trusted: its hash no longer matches the grant.
  setScripts(e2e, { check: 'node check.mjs --strict' })

  // ---- the composer: folder, task, the Auto switch, Run ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  await page.getByTestId('composer-auto').click()
  await expect(page.getByTestId('composer-auto')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  expect(run.auto).toBe(true)

  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const snap = await e2e.snapshot(run.runId)
  // No card ever opened (Auto never asks to trust), and the round ran nothing.
  expect(snap.cards).toEqual([])
  expect(snap.steps['verify:1']).toMatchObject({ status: 'skipped', reason: 'no command ran' })
  expect(snap.steps['verify:1'].verify?.commands).toEqual([
    expect.objectContaining({ name: 'check', status: 'skipped-untrusted' }),
  ])
  expect(snap.notes).toContain(
    'Auto skipped the verify command check: its script changed since it was trusted. Trust it in Settings to run it.',
  )
  // The [should] from Verify; the skip rule still holds (no [must]), so Fix did not run.
  const findings = await findingsOf(e2e, run.runId)
  expect(findings.map((f) => [f.n, f.severity, f.source])).toEqual([[1, 'should', 'verify']])
  expect(findings[0]?.title).toBe(
    '`npm run check` changed since it was trusted, so it was not run (it needs your approval)',
  )
  expect(ended.outcome).toBe('clean')
  expect(ended.findings).toEqual({ must: 0, should: 1 })
  expect(snap.steps.fix.status).toBe('skipped')

  // ---- the Run view: the outcome names the finding; the VerifyCard says why and links to Settings ----
  await expect(page.getByTestId('run-outcome')).toHaveText('Clean · 0 must · 1 should')
  const card = page.getByTestId('pass-card-verify:1')
  const row = card.getByTestId('verify-command-verify:1-0')
  await expect(row).toHaveAttribute('data-status', 'skipped-untrusted')
  await expect(row.getByTestId('verify-command-verify:1-0-status')).toContainText('Not trusted')
  const link = row.getByTestId('verify-command-verify:1-0-trust')
  await expect(link).toHaveText('Trust it in Settings')
  await expect(page.getByTestId('run-view')).toContainText('Auto skipped the verify command check')
  // The link opens Settings → Isolation & Verify for this project, where the command reads as changed.
  await link.click()
  await expect(page).toHaveURL(/#\/settings\/isolation/)
  const changed = page.getByTestId('verify-row-check')
  await expect(changed).toHaveAttribute('data-trust', 'changed', { timeout: 20_000 })
  await expect(page.getByTestId('verify-row-check-diff')).toContainText('node check.mjs --strict')
  expect(e2e.pageErrors).toEqual([])
})
