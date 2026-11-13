// First launch, the Codex variant ("First launch auto-selects a profile from which vendors are
// ready. Codex counts as ready only if support({mode:'autoedit'}) ≠ unsupported" with the readiness matrix "Claude
// ready · Codex ready → balanced"; the first-run script's "5-minute first use … then Claude+Codex"): first launch with both
// fakes ready (the fake Codex logged in, and on Windows its sandbox reporting ready). The setup card streams both
// probes, `balanced` is written to the user file and selected in the composer, whose pass line puts Implement on Codex
// and Plan, Review and Critic on Claude; preflight for a folder is green and the estimate prices Codex's default model.
// On Windows a second launch with the sandbox not set up keeps the user's profile (never overwritten) and says Codex
// needs its sandbox.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { IS_WIN32 } from './codex-helpers.ts'

test('Codex: first launch with fake Claude and fake Codex ready selects balanced', async ({ e2e }) => {
  const page = await e2e.start({ config: { profile: undefined }, codex: {} })

  // ---- the setup card: both vendors ready ----
  const card = page.getByTestId('setup-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('setup-vendor-claude')).toHaveAttribute('data-health', 'ready')
  const codex = card.getByTestId('setup-vendor-codex')
  await expect(codex).toHaveAttribute('data-health', 'ready', { timeout: 30_000 })
  await expect(codex).toContainText('Codex ready')
  await expect(codex).not.toHaveClass(/text-muted-foreground/)

  // ---- first launch chose balanced: in the user file, on the card and in the composer ----
  await expect(card.getByTestId('setup-profile')).toHaveText(/^Using balanced/)
  await expect(page.getByTestId('composer-profile')).toHaveText('balanced')
  const user = JSON.parse(readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')) as { profile?: unknown }
  expect(user.profile).toBe('balanced')

  // ---- a folder: the pass line names both vendors, preflight is green, the estimate prices Codex ----
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  const passes = page.getByTestId('composer-passes')
  await expect(passes).toContainText('Claude')
  await expect(passes).toContainText('Codex')
  const strip = page.getByTestId('preflight-strip')
  await expect(strip.getByTestId('preflight-ok')).toBeVisible({ timeout: 30_000 })
  await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0)
  await expect(page.getByTestId('estimate-line')).toHaveText(/^≈ \d+–\d+ min · ~\$\d+\.\d\d/)
  await expect(page.getByTestId('composer-run')).toBeEnabled()

  // The probes spent nothing: --version, `login status`, the schema, and handshakes without a thread or a turn.
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  expect(fake.errors()).toEqual([])
  expect(fake.requests('thread/start')).toEqual([])
  expect(fake.requests('turn/start')).toEqual([])
  expect(fake.requests('initialize').length).toBeGreaterThan(0)
  if (IS_WIN32) expect(fake.requests('windowsSandbox/readiness').length).toBeGreaterThan(0)
  expect(fake.requests('windowsSandbox/setupStart')).toEqual([])

  if (IS_WIN32) {
    // ---- Windows, the sandbox not set up: the user's profile stays; Codex says what it needs ----
    await e2e.close()
    fake.set({ sandbox: 'notConfigured' })
    const again = await e2e.launch()
    // A later launch probes the vendors of the active profile again (probes run at launch for the active profile).
    await expect(again.getByTestId('vendor-health-codex')).toHaveAttribute('data-health', 'sandbox-needed', {
      timeout: 30_000,
    })
    await expect(again.getByTestId('composer-profile')).toHaveText('balanced')
    const after = JSON.parse(readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')) as { profile?: unknown }
    expect(after.profile).toBe('balanced')
  }
  expect(e2e.pageErrors).toEqual([])
})
