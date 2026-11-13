// Grok in the app (the flow "pick Grok for Review"; the "Grok ACP" mode row: readonly = the
// adapter rejects every ask, autoedit unsupported until GR03, full = `_meta.yoloMode:true` (Auto only), plan emulated;
// Grok runs as `grok agent stdio` with GROK_DISABLE_AUTOUPDATER=1). On the fake Grok (ACP through the fake CLI's npm-style
// shim; no real Grok is ever looked for), through the real resolver, spawn path and adapter.
//   (a) The flow, from what the app shows alone: Review's Vendor list → "More" → Grok; the composer shows Grok's
//       read-only copy; Review runs read-only, Grok asks for a command and an edit, Dim Factory answers both
//       reject_once itself, the run asks nothing, the step counts two auto-denials, and the PassCard says what
//       read-only means on Grok while it runs.
//   (b) Grok for Implement: "Approve edits" reads "not available here" in the mode list, the composer says why in
//       words (no reason code), and the run is blocked with a switch to Claude. With Auto on, Implement runs on Grok
//       in full mode: always-approve for that session only (`_meta.yoloMode:true`), never a flag.
//   (c) Review: a Review on Grok in a profile whose Claude settings allow edits and commands is not run (readiness
//       `grok-allow-rules`), with the rules named and Claude offered.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { bodiesOf, runBodies } from './attention-helpers.ts'
import { grokFullPass, grokReview, pickFromMore } from './grok-muse-helpers.ts'
import { CLEAN_FLOW, VERSION_WRITE } from './scenarios.ts'

/** Grok's read-only copy (src/core/adapters/grok/config.ts GROK_COPY.readonly), as the composer and the card show it. */
const GROK_READONLY =
  'Reads and searches only: every edit, command and web fetch Grok asks for is denied by Dim Factory, not prompted. Grok applies your own allow rules and hooks (its own and those in your Claude settings) before it asks, so Dim Factory does not run a read-only pass whose rules would let Grok change files.'
const GROK_AUTOEDIT =
  "Not supported until Dim Factory has seen it work: Grok's agent mode has no setting that approves edits only."

test(
  'Flow: pick Grok for Review under More; it runs read-only, every Grok request is auto-rejected, zero asks',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: CLEAN_FLOW,
      config: { gates: { afterPlan: false } },
      // A moment of work after the rejections, so the card is seen while Review runs.
      grok: { readOnly: grokReview({ delayMs: 4_000 }) },
    })
    const fake = e2e.grok
    if (fake === null) throw new Error('no fake Grok')
    await expect(page.getByTestId('vendor-health-grok')).toHaveAttribute('data-health', 'ready', {
      timeout: 30_000,
    })

    // ---- the composer: folder and task, then Review's Vendor list → More → Grok ----
    await expect(page.getByTestId('composer')).toBeVisible()
    const folder = page.getByTestId('composer-folder-input')
    await folder.fill(e2e.sandbox)
    await folder.press('Enter')
    await page.getByTestId('composer-task').fill('add a --version flag')
    await expect(page.getByTestId('composer-passes')).toContainText('Claude')
    await pickFromMore(page, 'review', 'Grok')
    await expect(page.getByTestId('pass-summary-review')).toHaveText(
      'Review · Grok · CLI default · Read-only',
    )
    // Read-only is the only mode a Review has, and its copy is Grok's own.
    await expect(page.getByTestId('pass-mode-review')).toBeDisabled()
    await expect(page.getByTestId('pass-mode-copy-review')).toHaveText(GROK_READONLY)
    await expect(page.getByTestId('composer-passes')).toContainText('Review · Grok')
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()

    // ---- Review on Grok, running: the card names Grok, read-only, and what that means on Grok ----
    const card = page.getByTestId('pass-card-review')
    await expect(card).toHaveAttribute('data-status', 'running', { timeout: 90_000 })
    await expect(card.getByText('Grok', { exact: true })).toBeVisible()
    await expect(page.getByTestId('mode-chip-review')).toHaveText('read-only')
    await expect(page.getByTestId('mode-copy-review')).toHaveText(GROK_READONLY)
    // Nothing reaches the user: no ask panel while Grok's requests are answered.
    await expect(page.getByTestId('ask-panel')).toHaveCount(0)

    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')

    // ---- the agent: one private agent (`--no-leader`), no auto-update, the ask posture, both rejected ----
    const agents = fake.agents().filter((a) => !/probe-cwd$/.test(a.cwd))
    expect(agents.map((a) => a.argv)).toEqual([['agent', '--no-leader', 'stdio']])
    expect(agents[0]?.env['GROK_DISABLE_AUTOUPDATER']).toBe('1')
    // The prompt went over ACP (session/prompt), never argv.
    expect(agents[0]?.argv.join(' ')).not.toContain('version flag')
    const review = agents[0]?.pid
    expect(fake.calls('session/new').filter((c) => c.pid === review)).toEqual([
      { pid: review, params: expect.objectContaining({ _meta: { yoloMode: false, autoMode: false } }) },
    ])
    expect(fake.calls('session/prompt').map((c) => c.pid)).toEqual([review])
    expect(fake.permissionAnswers()).toEqual([
      { pid: review, optionId: 'reject_once' },
      { pid: review, optionId: 'reject_once' },
    ])
    // Every Grok process Dim Factory started (--version, agent --help, the agents) had the updater off.
    for (const s of fake.allStarts()) expect(s.env['GROK_DISABLE_AUTOUPDATER'], s.argv.join(' ')).toBe('1')

    // ---- the run: no ask at all; two auto-answered denials on Review ----
    const bodies = await runBodies(e2e, run.runId)
    expect(bodiesOf(bodies, 'ev').filter((b) => b.ev.type === 'ask')).toEqual([])
    const auto = bodiesOf(bodies, 'auto-answered').filter((b) => b.why !== 'plan-capture')
    expect(auto.map((b) => ({ step: b.step, decision: b.decision, why: b.why }))).toEqual([
      { step: 'review', decision: 'deny', why: 'readonly' },
      { step: 'review', decision: 'deny', why: 'readonly' },
    ])
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.review.vendor).toBe('grok')
    expect(snap.steps.review.modeCopy).toEqual({ status: 'supported', copy: GROK_READONLY })
    expect(snap.steps.review.autoAnswered).toEqual({ approved: 0, denied: 2 })
    expect(snap.asks).toEqual([])

    // ---- the Log tab says so ----
    await page.getByTestId('run-tab-log').click()
    const log = page.getByTestId('log-tab')
    await expect(log).toBeVisible()
    await expect(log.getByText('AUTO denied 2', { exact: true })).toBeVisible()
    await expect(page.getByTestId('log-rows').getByText(/^denied .*\(readonly\)$/)).toHaveCount(2)
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

test(
  "Grok's Approve edits is not available for Implement (the composer says why); Auto runs it in full mode",
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    test.setTimeout(240_000)
    const page = await e2e.start({
      scenario: CLEAN_FLOW,
      grok: {
        full: grokFullPass({
          write: VERSION_WRITE,
          text: 'Added the --version flag.',
          usage: { input: 11_000, cacheRead: 22_000, output: 480, costUsd: 0.041 },
        }),
      },
    })
    const fake = e2e.grok
    if (fake === null) throw new Error('no fake Grok')
    await expect(page.getByTestId('vendor-health-grok')).toHaveAttribute('data-health', 'ready', {
      timeout: 30_000,
    })
    const folder = page.getByTestId('composer-folder-input')
    await folder.fill(e2e.sandbox)
    await folder.press('Enter')
    await page.getByTestId('composer-task').fill('add a --version flag')
    await expect(page.getByTestId('composer-passes')).toContainText('Claude')

    // ---- Implement on Grok: Approve edits is not available here, and the composer says why in words ----
    await pickFromMore(page, 'implement', 'Grok')
    await expect(page.getByTestId('pass-summary-implement')).toHaveText(
      'Implement · Grok · CLI default · Approve edits',
    )
    await expect(page.getByTestId('pass-mode-copy-implement')).toHaveText(GROK_AUTOEDIT)
    await page.getByTestId('pass-mode-implement').click()
    const modes = page.getByRole('listbox')
    await expect(modes.getByRole('option', { name: 'Approve edits · not available here' })).toBeVisible()
    await expect(modes.getByRole('option', { name: 'Approve edits · not available here' })).toHaveAttribute(
      'data-support',
      'unsupported',
    )
    await page.keyboard.press('Escape')
    await expect(modes).toBeHidden()

    // The run is blocked, with the reason and a way out (Claude for Implement).
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('composer-run')).toBeDisabled()
    await page.getByTestId('preflight-details').click()
    const strip = page.getByTestId('preflight-strip')
    await expect(page.getByTestId('preflight-chip-pass.implement.mode')).toContainText(
      'Grok cannot run Implement in autoedit mode',
    )
    await expect(strip.getByRole('button', { name: 'Use Claude for Implement' })).toBeVisible()
    await expect(strip).not.toContainText('mode-unsupported')
    // Nothing was started for a pass that cannot run.
    expect(fake.agents().filter((a) => !/probe-cwd$/.test(a.cwd))).toEqual([])

    // ---- Auto: Implement (and Fix) run in full mode, which Grok supports: always-approve for the session ----
    const autoSwitch = page.getByTestId('composer-auto')
    await autoSwitch.click()
    await expect(autoSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('pass-summary-implement')).toHaveText(
      'Implement · Grok · CLI default · Approve everything',
    )
    await expect(page.getByTestId('pass-mode-copy-implement')).toHaveText(
      'Everything runs without asking (Grok always-approve, for this session only).',
    )
    await expect(page.getByTestId('composer-run')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('composer-run').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.implement.vendor).toBe('grok')
    expect(snap.steps.implement.mode).toBe('full')
    const implement = fake.agents().find((a) => !/probe-cwd$/.test(a.cwd))?.pid
    expect(fake.calls('session/new').filter((c) => c.pid === implement)).toEqual([
      { pid: implement, params: expect.objectContaining({ _meta: { yoloMode: true } }) },
    ])
    // Always-approve comes from the session's `_meta` only: never the CLI's --always-approve / --yolo flags.
    for (const a of fake.agents()) {
      expect(a.argv).not.toContain('--always-approve')
      expect(a.argv).not.toContain('--yolo')
    }
    expect(fake.permissionAnswers()).toEqual([])
    expect(fake.errors()).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

test(
  "A Grok Review is not run when the user's own allow rules would let Grok change files",
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    // Grok applies allow rules from its own config and the user's Claude settings before it asks (its user guide 22),
    // so rejecting every ask cannot keep a read-only pass read-only: readiness `grok-allow-rules` stops it first.
    test.setTimeout(180_000)
    const page = await e2e.start({ scenario: CLEAN_FLOW, grok: { readOnly: grokReview() } })
    const fake = e2e.grok
    if (fake === null) throw new Error('no fake Grok')
    // The app's user home (DIM_FACTORY_E2E_USER_HOME, inside the test's root; never the developer's ~/.claude).
    mkdirSync(join(e2e.userHome, '.claude'), { recursive: true })
    writeFileSync(
      join(e2e.userHome, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read', 'Edit', 'Bash(npm *)'] } }),
    )
    await expect(page.getByTestId('vendor-health-grok')).toHaveAttribute('data-health', 'ready', {
      timeout: 30_000,
    })
    const folder = page.getByTestId('composer-folder-input')
    await folder.fill(e2e.sandbox)
    await folder.press('Enter')
    await page.getByTestId('composer-task').fill('add a --version flag')
    await expect(page.getByTestId('composer-passes')).toContainText('Claude')
    await pickFromMore(page, 'review', 'Grok')
    await expect(page.getByTestId('pass-summary-review')).toHaveText(
      'Review · Grok · CLI default · Read-only',
    )

    // The run is blocked with the rules named and Claude offered for the Review.
    await expect(page.getByTestId('composer-run-status')).toHaveText(/^Fix \d+ issues? to run$/, {
      timeout: 30_000,
    })
    await expect(page.getByTestId('composer-run')).toBeDisabled()
    await page.getByTestId('preflight-details').click()
    const chip = page.getByTestId('preflight-chip-pass.review.readiness.grok-allow-rules')
    await expect(chip).toContainText('Your allow rules would let Grok change files in Review')
    const strip = page.getByTestId('preflight-strip')
    await expect(strip.getByRole('button', { name: 'Use Claude for Review' })).toBeVisible()
    // The chip's details name each rule and the file it is in (read-only rules, such as Read, are not named).
    await chip.getByRole('button', { name: /^Show details and fixes: / }).click()
    await expect(chip).toContainText('Edit in ~/.claude/settings.json')
    await expect(chip).toContainText('Bash(npm *) in ~/.claude/settings.json')
    await expect(chip).not.toContainText('Read in ')
    // Nothing was started for the pass.
    expect(fake.agents().filter((a) => !/probe-cwd$/.test(a.cwd))).toEqual([])
    expect(e2e.pageErrors).toEqual([])
  },
)

test('Grok and Muse are in no built-in profile', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({ grok: {}, muse: {} })
  await expect(page.getByTestId('vendor-health-grok')).toHaveAttribute('data-health', 'ready', {
    timeout: 30_000,
  })
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-profiles').click()
  const list = page.getByTestId('profiles-list')
  await expect(list).toBeVisible()
  for (const name of ['balanced', 'claude-only', 'codex-only', 'fast', 'thorough']) {
    await page.getByTestId(`profile-item-${name}`).click()
    // A built-in profile is a read-only table: one row per pass, its vendor in words.
    await expect(page.getByTestId('profile-passes-table')).toBeVisible()
    for (const pass of ['plan', 'implement', 'review', 'critic', 'fix']) {
      const row = page.getByTestId(`profile-pass-${pass}`)
      await expect(row, `${name} ${pass}`).toContainText(/Claude|Codex|Same as Implement/)
      await expect(row, `${name} ${pass}`).not.toContainText(/Grok|Muse/)
    }
  }
  // Core's resolved profiles agree.
  for (const profile of ['balanced', 'claude-only', 'codex-only', 'fast', 'thorough']) {
    const r = await e2e.call('config.resolve', { folder: e2e.sandbox, overrides: { profile } })
    const vendors = Object.values(r.config.passes).map((p) => p.vendor)
    expect(vendors, profile).not.toContain('grok')
    expect(vendors, profile).not.toContain('muse')
  }
  expect(e2e.pageErrors).toEqual([])
})
