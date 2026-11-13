// The sandbox chip, the Codex variant ("Preflight: Codex Windows sandbox chip … clears the block"; the mode
// row "Codex, Windows sandbox not ready": autoedit **unsupported** (never a silent downgrade to read-only), "fix:
// vendor_setup unelevated → elevated shell_copy"; the vendor_setup executor "runs only from a user click"; failure category
// sandbox_unavailable; the Codex Windows sandbox procedure X11a/X11b). Windows only. balanced puts Implement on Codex in
// autoedit, and the fake Codex answers windowsSandbox/readiness `notConfigured`: the composer's preflight blocks with the
// sandbox chip as the fix, Run disabled with why. Clicking [Set up the Codex sandbox] runs windowsSandbox/setupStart
// {mode:'unelevated'} on a private app-server (nothing ran before the click), the chip shows its progress, the fake
// answers setupCompleted and now reads `ready`; core probes Codex again, the block clears and Run enables. The button
// keeps its size through every state, and nothing elevated ever runs.
import { expect, test } from './harness.ts'
import { IS_WIN32 } from './codex-helpers.ts'
import { toasts } from './attention-helpers.ts'
import { expectSteadyWidth, trackWidth } from './git-helpers.ts'

test('Codex: the sandbox chip clears the preflight block', async ({ e2e }) => {
  test.skip(!IS_WIN32, 'the Codex Windows sandbox exists on Windows only')
  const page = await e2e.start({ config: { profile: 'balanced' }, codex: { sandbox: 'notConfigured' } })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  await expect(page.getByTestId('vendor-health-codex')).toHaveAttribute('data-health', 'sandbox-needed', {
    timeout: 30_000,
  })

  // ---- the composer: Implement on Codex autoedit is blocked, the sandbox chip is the fix ----
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Codex')
  const strip = page.getByTestId('preflight-strip')
  const block = strip.locator('[data-severity="blocking"]').filter({ hasText: 'Codex' }).first()
  await expect(block).toBeVisible({ timeout: 30_000 })
  const run = page.getByTestId('composer-run')
  await expect(run).toBeDisabled()
  await expect(strip.getByTestId('preflight-summary-text')).toContainText(
    'Codex cannot run Implement in autoedit mode',
  )
  await strip.getByTestId('preflight-details').click()
  const chip = strip.locator('[data-kind="vendor_setup"]').first()
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText('Set up the Codex sandbox')
  await expect(chip).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('e12-blocked.png') })
  // Nothing ran the setup on its own.
  expect(fake.requests('windowsSandbox/setupStart')).toEqual([])

  // ---- the click: the setup runs (unelevated) on a private app-server; progress beside the button ----
  const testId = (await chip.getAttribute('data-testid')) ?? ''
  await trackWidth(page, 'sandbox', `[data-testid="${testId}"]`)
  await trackWidth(page, 'card-sandbox', '[data-testid="setup-codex-sandbox"]')
  await chip.click()
  const status = page.getByTestId(`${testId}-status`)
  await expect(page.getByTestId(`${testId}-chip`)).toHaveAttribute('data-phase', 'running')
  await expect(status).toHaveText(/^Setting up the Codex sandbox… \d+:\d\d$/)
  await fake.waitForRequest('windowsSandbox/setupStart')
  // The fake's sandbox is set up from now on (its next readiness answers `ready`).
  fake.set({ sandbox: 'ready' })
  const setups = fake.requests('windowsSandbox/setupStart')
  expect(setups).toHaveLength(1)
  expect(setups[0]?.params).toEqual({ mode: 'unelevated' })

  // ---- core probes again: the block clears (its chip goes with it), Run enables; the sandbox reads ready ----
  await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0, { timeout: 60_000 })
  await expect(run).toBeEnabled()
  await expect(page.getByTestId('vendor-health-codex')).toHaveAttribute('data-health', 'ready')
  // The setup card's chip (the same setup, shared) says what core found.
  await expect(page.getByTestId('setup-codex-sandbox-chip')).toHaveAttribute('data-phase', 'ready')
  await expect(page.getByTestId('setup-codex-sandbox-status')).toHaveText('Codex sandbox ready')
  await expect(toasts(page).filter({ hasText: 'The Codex sandbox is set up.' })).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('e12-ready.png') })
  await expectSteadyWidth(page, 'sandbox', 'The sandbox setup button')
  await expectSteadyWidth(page, 'card-sandbox', "The setup card's sandbox button")

  // Only the unelevated setup ran, once; the elevated command was never needed.
  expect(fake.requests('windowsSandbox/setupStart')).toHaveLength(1)
  expect(fake.errors()).toEqual([])
  expect(fake.argvs().some((a) => a.includes('--elevated') || a.includes('sandbox'))).toBe(false)
  expect(e2e.pageErrors).toEqual([])
})
