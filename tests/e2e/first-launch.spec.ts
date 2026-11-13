// First launch (the first-run script at 0:00): first launch with only the fake Claude. The user
// dimfactory.json names no profile, so first launch picks one from the launch probes: Claude is ready and Codex is not
// installed (Codex is built; the harness looks for vendor CLIs only at their configured paths and gives Codex none),
// so `claude-only` is written to the user file and selected in the composer. The setup card streams
// the probes ("Claude ready" within 10 s of the window), greys Codex and offers its install command (also the
// tooltip of the greyed Codex choice in the composer's vendor picker); copying it goes through core and main's
// clipboard. Dismiss hides the card, and it stays hidden
// after a relaunch (state.json).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { clipboardText, keepingClipboard } from './dashboard-helpers.ts'

/** The first-run script: the setup card's probe results stream in within 10 s. */
const PROBES_WITHIN_MS = 10_000

test('first launch with only fake-claude', { tag: ['@smoke', '@cross-os'] }, async ({ e2e }) => {
  // `profile: undefined` drops the harness's profile from dimfactory.json: first launch chooses it.
  const page = await e2e.start({ config: { profile: undefined } })
  const windowAt = await page.evaluate(() => performance.timeOrigin)

  // ---- the setup card: Claude ready within 10 s of the window ----
  const card = page.getByTestId('setup-card')
  await expect(card).toBeVisible()
  const claude = card.getByTestId('setup-vendor-claude')
  await expect(claude).toHaveAttribute('data-health', 'ready', { timeout: PROBES_WITHIN_MS })
  const readyAfterMs = Math.round(Date.now() - windowAt)
  test
    .info()
    .annotations.push({ type: 'timing', description: `Claude ready ${readyAfterMs} ms after the window` })
  console.log(`[first-launch] Claude ready ${readyAfterMs} ms after the window`)
  expect(readyAfterMs).toBeLessThan(PROBES_WITHIN_MS)
  await expect(claude).toContainText('Claude ready')

  // ---- Codex: greyed (not installed), its install command offered ----
  const codex = card.getByTestId('setup-vendor-codex')
  await expect(codex).toHaveAttribute('data-health', 'not-installed')
  await expect(codex).toHaveClass(/text-muted-foreground/)
  const install = codex.getByTestId('recovery-codex.install')
  await expect(install).toBeEnabled()
  await expect(install).toHaveText('Copy the install command')
  const command =
    process.platform === 'win32'
      ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
      : 'npm install -g @openai/codex@latest'
  await expect(codex.getByText(command, { exact: true })).toBeVisible()
  // Copying it goes through core (nothing probed Codex yet) and main's clipboard; then "I ran it → Re-check".
  await keepingClipboard(e2e, async () => {
    await install.click()
    await expect(page.getByText('Copied. Run it in a terminal.')).toBeVisible()
    expect(await clipboardText(e2e)).toBe(command)
    await expect(codex.getByTestId('recheck-codex.install')).toBeVisible()
    const direct = await e2e.invoke('recovery.execute', { actionId: 'codex.install' })
    expect(direct.ok && direct.value.copied).toBe(command)
  })

  // ---- first launch chose claude-only: written to the user file, shown on the card and in the composer ----
  await expect(card.getByTestId('setup-profile')).toHaveText(/^Using claude-only/)
  await expect(page.getByTestId('composer-profile')).toHaveText('claude-only')
  const user = JSON.parse(readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')) as { profile?: unknown }
  expect(user.profile).toBe('claude-only')

  // The composer's vendor picker: Codex greyed, the install command as its tooltip.
  await page.getByTestId('composer-passes-toggle').click()
  await page.getByTestId('pass-row-toggle-review').click()
  await page.getByTestId('pass-vendor-review').click()
  const codexChoice = page.getByRole('option', { name: /^Codex/ })
  await expect(codexChoice).toHaveAttribute('aria-disabled', 'true')
  await expect(codexChoice).toHaveAttribute('title', command)
  await page.keyboard.press('Escape')

  // ---- Dismiss hides the card (with Undo) and persists across a relaunch ----
  await card.getByTestId('setup-dismiss').click()
  await expect(card).toBeHidden()
  await expect(page.getByText('Setup card hidden')).toBeVisible()
  expect((await e2e.call('state.get')).setupDismissed).toBe(true)

  await e2e.close()
  const again = await e2e.launch()
  // Wait until the probes have reached the renderer (the card would show by now), then check it stays hidden.
  await expect(again.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')
  await expect(again.getByTestId('composer-profile')).toHaveText('claude-only')
  await expect(again.getByTestId('setup-card')).toHaveCount(0)
  expect((await e2e.call('state.get')).setupDismissed).toBe(true)

  expect(e2e.pageErrors).toEqual([])
})
