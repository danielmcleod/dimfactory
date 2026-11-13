// Muse in the app ("Muse exec (M01-M05), Experimental badge, not in profiles", "Muse (exec, no
// relay, Experimental)", the "Muse exec" mode row: readonly unsupported, autoedit `--disable-approval` "sandbox-gated,
// never prompts; escalations fail" (degraded), full `--yolo`; Muse runs as `muse exec --json --prompt-file
// <runs/id/prompts/x.md> [--trust-workspace with grant] --disable-approval|--yolo`, no relay (the stall timer is the
// safety net, and the card says so); Readiness `trust`: without a grant → fail with a `grant vendorFolder` action). On
// the fake Muse (exec JSON lines through the fake CLI's npm-style shim; no real Muse is ever looked for).
//   (a) The vendor lists show Muse under "More" with its Experimental badge, and Dim Factory suggests it nowhere on its
//       own (Fix's "Fresh, different vendor" stays unavailable with only Claude and Muse ready). Muse for Review is
//       blocked with the reason (it has no read-only mode) and no folder grant is offered for it; its own switch puts
//       Review back on Claude. Muse for Implement shows the degraded copy and the trust chip; once trusted, Implement
//       runs on Muse: `--trust-workspace --disable-approval`, the prompt only in the file Dim Factory wrote under
//       runs/<id>/prompts, an escalation that fails instead of asking, no ask at all, and the card saying asks are
//       not relayed and the stall timer stops a pass that waits.
//   (b) Auto: full mode is `--yolo`, still only with the folder's grant; Settings → Vendors shows Muse's card with the
//       Experimental badge and the folder it is trusted in.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { settingsLoaded } from './diff-settings-helpers.ts'
import { bodiesOf, runBodies } from './attention-helpers.ts'
import { museEditPass, openPassRow, pickFromMore } from './grok-muse-helpers.ts'
import { samePath, vendorFolderGrants } from './gemini-helpers.ts'
import { CLEAN_FLOW, VERSION_WRITE } from './scenarios.ts'

const MUSE_READONLY =
  'Muse cannot run read-only: its exec mode has no read-only option, so Dim Factory never uses Muse for Plan, Review or Critic. Choose another vendor for this pass.'
const NEVER_PROMPTS = 'Sandbox-gated, never prompts; escalations fail.'
const NO_RELAY =
  "Muse cannot ask you anything here: questions are not relayed. If it stops producing output, Dim Factory's stall timer stops the pass."
const TASK = 'add a --version flag'

async function fillComposer(e2e: E2EHarness, page: Page): Promise<void> {
  await expect(page.getByTestId('vendor-health-muse')).toHaveAttribute('data-health', /^(ready|warning)$/, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill(TASK)
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
}

const editPass = (delayMs?: number) =>
  museEditPass({
    write: VERSION_WRITE,
    escalation: true,
    text: 'Added the --version flag. Fetching the changelog needed the network, which the sandbox refused.',
    usage: { input: 12_288, cached: 4_096, output: 512 },
    ...(delayMs !== undefined ? { delayMs } : {}),
  })

test(
  'Muse is Experimental under More, blocked for read-only passes with the reason, and runs Implement only once trusted',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: CLEAN_FLOW,
      config: { gates: { afterPlan: false } },
      muse: { edit: editPass(4_000) },
    })
    const fake = e2e.muse
    if (fake === null) throw new Error('no fake Muse')
    await fillComposer(e2e, page)

    // ---- the Vendor list: Muse under More, with its Experimental badge ----
    await openPassRow(page, 'implement')
    await page.getByTestId('pass-vendor-implement').click()
    const list = page.getByRole('listbox')
    const more = list.getByRole('group').filter({ hasText: 'More' })
    await expect(more.getByRole('option', { name: /^Muse · Experimental/ })).toBeVisible()
    await expect(list.getByRole('group').first().getByRole('option', { name: /^Muse/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()

    // ---- never suggested on its own: Fix's "Fresh, different vendor" has no vendor (only Claude and Muse are ready),
    //      and no Critic swap is offered ----
    await openPassRow(page, 'fix')
    await page.getByTestId('fix-session').click()
    await expect(
      page.getByRole('option', { name: 'Fresh, different vendor · no other vendor is ready' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('critic-swap')).toHaveCount(0)

    // ---- Review on Muse: blocked with the reason; no folder grant offered, since trust would not let it run ----
    await pickFromMore(page, 'review', 'Muse')
    await expect(page.getByTestId('pass-summary-review')).toHaveText(
      'Review · Muse · CLI default · Read-only',
    )
    await expect(page.getByTestId('pass-mode-copy-review')).toHaveText(MUSE_READONLY)
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('composer-run')).toBeDisabled()
    await page.getByTestId('preflight-details').click()
    const strip = page.getByTestId('preflight-strip')
    await expect(page.getByTestId('preflight-chip-pass.review.mode')).toContainText(
      'Muse cannot run Review in readonly mode',
    )
    await expect(strip.locator('[data-kind="grant"]')).toHaveCount(0)
    await expect(strip).not.toContainText('Trust this folder for Muse')
    // Its way out is offered (Review on Claude); Reset puts the profile's Review (Claude, sonnet) back.
    await expect(strip.getByRole('button', { name: 'Use Claude for Review' })).toBeVisible()
    await page.getByTestId('pass-reset-review').click()
    await expect(page.getByTestId('pass-summary-review')).toHaveText('Review · Claude · sonnet · Read-only')

    // ---- Implement on Muse: the degraded copy, and the trust chip while the folder has no grant ----
    await pickFromMore(page, 'implement', 'Muse')
    await expect(page.getByTestId('pass-vendor-implement')).toContainText('Muse · Experimental')
    const copy = page.getByTestId('pass-mode-copy-implement')
    await expect(copy).toContainText(NEVER_PROMPTS)
    await expect(copy).toContainText(NO_RELAY)
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    const grant = strip.locator('[data-kind="grant"]')
    await expect(grant).toHaveCount(1)
    await expect(grant).toHaveText('Trust this folder for Muse')
    await expect(page.getByTestId('preflight-chip-pass.implement.readiness.trust')).toContainText(
      'Muse needs your OK for this folder',
    )
    expect(fake.passes()).toEqual([])
    await grant.click()
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 60_000 })
    expect(vendorFolderGrants(e2e.home, 'muse').some((p) => samePath(p, e2e.sandbox))).toBe(true)
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()

    // ---- Implement on Muse, running: the card says asks are not relayed and the stall timer is the safety net ----
    const card = page.getByTestId('pass-card-implement')
    await expect(card).toHaveAttribute('data-status', 'running', { timeout: 90_000 })
    await expect(card.getByText('Muse', { exact: true })).toBeVisible()
    await expect(page.getByTestId('mode-copy-implement')).toContainText(NEVER_PROMPTS)
    await expect(page.getByTestId('mode-copy-implement')).toContainText(NO_RELAY)
    await expect(page.getByTestId('ask-panel')).toHaveCount(0)
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')

    // ---- argv: exec with the grant's --trust-workspace and --disable-approval with the sandbox's network
    // off; the prompt only in the file ----
    const passes = fake.passes()
    expect(passes).toHaveLength(1)
    const argv = passes[0]?.argv ?? []
    const promptFile = join(e2e.home, 'runs', run.runId, 'prompts', 'implement-muse-1.md')
    expect(argv).toEqual([
      'exec',
      '--json',
      '--prompt-file',
      expect.stringMatching(/implement-muse-1\.md$/),
      '--trust-workspace',
      '--disable-approval',
      '--sandbox-network',
      'restricted',
    ])
    expect(samePath(argv[3] ?? '', promptFile)).toBe(true)
    expect(argv.join(' ')).not.toContain(TASK)
    expect(existsSync(promptFile)).toBe(true)
    expect(readFileSync(promptFile, 'utf8')).toContain(TASK)
    expect(samePath(passes[0]?.cwd ?? '', e2e.sandbox)).toBe(true)

    // ---- the run: no ask; the escalation failed instead of asking (a declined tool), Muse's usage counted ----
    const bodies = await runBodies(e2e, run.runId)
    expect(bodiesOf(bodies, 'ev').filter((b) => b.ev.type === 'ask')).toEqual([])
    const toolEnds = bodiesOf(bodies, 'ev')
      .filter((b) => b.step === 'implement')
      .flatMap((b) => (b.ev.type === 'tool' && b.ev.phase === 'end' ? [`${b.ev.name}:${b.ev.status}`] : []))
    expect(toolEnds).toEqual(['write_file:ok', 'bash:ok', 'web_fetch:declined'])
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.implement.vendor).toBe('muse')
    expect(snap.steps.implement.modeCopy?.status).toBe('degraded')
    expect(snap.steps.implement.usage).toMatchObject({ input: 8_192, cacheRead: 4_096, output: 512 })
    expect(snap.asks).toEqual([])
    expect(readFileSync(join(e2e.sandbox, VERSION_WRITE.path), 'utf8')).toBe(VERSION_WRITE.content)
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

test(
  'Muse in Auto runs --yolo only with the grant; its Settings card is Experimental and lists the trusted folder',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({ scenario: CLEAN_FLOW, muse: { full: editPass() } })
    const fake = e2e.muse
    if (fake === null) throw new Error('no fake Muse')
    await fillComposer(e2e, page)
    await pickFromMore(page, 'implement', 'Muse')
    const autoSwitch = page.getByTestId('composer-auto')
    await autoSwitch.click()
    await expect(autoSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('pass-summary-implement')).toHaveText(
      'Implement · Muse · CLI default · Approve everything',
    )
    await expect(page.getByTestId('pass-mode-copy-implement')).toContainText(
      'Everything runs automatically: no sandbox and no prompts',
    )
    // Full mode does not lift the grant: --yolo would trust the folder by itself, so the folder needs the user's OK.
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    await page.getByTestId('preflight-details').click()
    const grant = page.getByTestId('preflight-strip').locator('[data-kind="grant"]')
    await expect(grant).toHaveText('Trust this folder for Muse')
    await grant.click()
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 60_000 })
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    const argv = fake.passes().map((p) => p.argv)
    expect(argv).toHaveLength(1)
    expect(argv[0]?.slice(4)).toEqual(['--trust-workspace', '--yolo'])
    expect(argv[0]).not.toContain('--disable-approval')
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.implement.mode).toBe('full')

    // ---- Settings → Vendors: Muse's card, Experimental, with the folder it is trusted in ----
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-section-vendors').click()
    await settingsLoaded(page)
    const museCard = page.getByTestId('settings-vendor-muse')
    await expect(museCard).toBeVisible()
    await expect(museCard.getByText('Experimental', { exact: true })).toBeVisible()
    await expect(page.getByTestId('vendor-trusted-muse-row')).toHaveCount(1, { timeout: 30_000 })
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)
