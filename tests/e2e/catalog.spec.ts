// Catalog refresh ("Catalog: consent → fake AI JSON → diff (>50% unticked) → apply → estimate uses the
// new price → Undo"; refresh without consent rejected, flags, scheduler (fake clock), estimates use
// new prices at once; the catalog refresh: the consent card names the vendor and model, says "read-only, web search,
// cannot change files" and shows ~time and ≈cost, [Update now] [Not now (7 days)] [Turn off], never auto-runs; the
// Claude job runs `dontAsk --allowedTools WebSearch,WebFetch(domain:<sources.ts>) --disallowedTools … --permission-
// prompts none` in catalog/jobs/<id>/ with the schema in initialize `jsonSchema`; Apply writes models + pricing with a
// backup in catalog/history/ and a "Prices updated · Undo" toast; manual edits set confidence 'user').
//
// The fake Claude answers the refresh with `structured_output` (the synthesized C17 recording with catalog.spec.ts's answer). Every
// home starts with its last refresh now (the harness), so the refresh is due only once e2e.clock moves 15 days on: the
// scheduler's look then raises the consent card. Nothing runs before Update now's click.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { advanceClock, recordedNotifications, simulateFocus, toasts } from './attention-helpers.ts'
import type { RecordedNotification } from './attention-helpers.ts'
import {
  CLAUDE_HOSTS,
  DAY_MS,
  E21_PROPOSAL,
  INTERVAL_DAYS,
  OPUS_E21,
  OPUS_SEED,
  REFRESH_DISALLOWED,
  ROW,
  catalogHash,
  catalogScheduleState,
  consentCard,
  flagValue,
  holdOpen,
  loadRefreshConverter,
  openCatalogSettings,
  planPriorCost,
  procCwd,
  promptOf,
  refreshProcs,
  stdinFrames,
  storedPrice,
  withRefreshes,
} from './catalog-helpers.ts'

/** The folder and task in the composer: its estimate line appears for them. */
async function composeTask(e2e: E2EHarness): Promise<void> {
  const page = e2e.p
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
}

async function planCostP80(e2e: E2EHarness): Promise<number | undefined> {
  const est = await e2e.call('estimates.get', { folder: e2e.sandbox })
  return est.steps.plan?.costUsd?.p80
}

function jobDirs(e2e: E2EHarness): string[] {
  try {
    return readdirSync(join(e2e.home, 'catalog', 'jobs'))
  } catch {
    return []
  }
}

test('catalog: consent → the AI’s prices → review (>50% unticked) → apply → the estimate uses the new price → Undo', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  await loadRefreshConverter()
  const page = await e2e.start({ editScenario: withRefreshes([{ proposal: E21_PROPOSAL, holdMs: 4_000 }]) })
  await expect(page.getByTestId('vendor-health-claude')).toHaveAttribute('data-health', 'ready')

  // ---- the composer's estimate, at the shipped prices ----
  await composeTask(e2e)
  const line = page.getByTestId('estimate-line')
  await expect(line).toContainText('typical (no history yet)')
  // The seed's own price: until Claude's launch probe names the CLI's default model, the line reads "no price (CLI
  // default model unknown)" (with Gemini's launch probe too, this read that line as the seed).
  await expect(line).toContainText(' est. ', { timeout: 30_000 })
  const seedLine = (await line.innerText()).trim()
  expect(await planCostP80(e2e)).toBeCloseTo(planPriorCost(OPUS_SEED), 9)
  const seedPricing = catalogHash(e2e, 'pricing')
  const seedModels = catalogHash(e2e, 'models')

  // ---- prices refreshed today (the harness): no card; 15 days on, the scheduler's look raises it ----
  await expect(consentCard(page)).toHaveCount(0)
  await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)
  const card = consentCard(page)
  await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
  await expect(card).toContainText('Model prices may be out of date')
  await expect(card.getByTestId('catalog-card-consent')).toHaveText(
    'Claude (sonnet): read-only, web search, cannot change files',
  )
  await expect(card.getByTestId('catalog-card-consent')).toHaveAttribute(
    'title',
    `Claude (sonnet): read-only, web search, cannot change files. It reads pages only on ${CLAUDE_HOSTS.join(', ')}.`,
  )
  await expect(card.getByTestId('catalog-card-estimate')).toHaveText(
    /^~\d+ min · ≈\$\d+\.\d\d( API-equiv\.)?$/,
  )
  await expect(card.getByTestId('catalog-card-update')).toHaveText('Update now')
  await expect(card.getByTestId('catalog-card-snooze')).toHaveText('Not now (7 days)')
  await expect(card.getByTestId('catalog-card-off')).toHaveText('Turn off')
  // It never runs on its own.
  await page.waitForTimeout(1_000)
  expect(refreshProcs(e2e)).toEqual([])
  expect(jobDirs(e2e)).toEqual([])

  // ---- Update now: the job runs (the card shows it), then its changes wait for review ----
  await card.getByTestId('catalog-card-update').click()
  await expect(card).toHaveAttribute('data-mode', 'running')
  await expect(card.getByTestId('catalog-card-status')).toContainText(
    'Claude (sonnet) is reading the price pages',
  )
  await expect(card.getByTestId('catalog-card-cancel')).toBeVisible()
  await expect(card).toHaveAttribute('data-mode', 'review', { timeout: 60_000 })
  await expect(card.getByTestId('catalog-card-status')).toContainText('ready to review')

  // ---- what ran: Claude read-only and web-limited, in the job's own folder, the schema in initialize ----
  const procs = refreshProcs(e2e)
  expect(procs).toHaveLength(1)
  const proc = procs[0]
  if (proc === undefined) throw new Error('no refresh process')
  const argv = proc.argv
  expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
  expect(flagValue(argv, '--model')).toBe('sonnet')
  expect(flagValue(argv, '--permission-prompts')).toBe('none')
  expect(argv).toContain('--no-session-persistence')
  expect(argv).toContain('--strict-mcp-config')
  expect(flagValue(argv, '--settings')).toBe('{"disableAllHooks":true}')
  expect(flagValue(argv, '--disallowedTools')?.split(',')).toEqual(REFRESH_DISALLOWED)
  // Those two are its only built-in tools (an allow list, not only a cut).
  expect(flagValue(argv, '--tools')).toBe('WebSearch,WebFetch')
  // Only web search and page fetches on the official hosts.
  expect(flagValue(argv, '--allowedTools')?.split(',')).toEqual([
    'WebSearch',
    ...CLAUDE_HOSTS.map((h) => `WebFetch(domain:${h})`),
  ])
  expect(argv.some((a) => a.startsWith('--permission-prompt-tool'))).toBe(false)
  expect(argv.some((a) => a.startsWith('--resume') || a.startsWith('--session-id'))).toBe(false)
  const [jobId] = jobDirs(e2e)
  expect(jobDirs(e2e)).toHaveLength(1)
  expect(procCwd(e2e, proc.pid)?.toLowerCase()).toBe(
    join(e2e.home, 'catalog', 'jobs', jobId ?? '').toLowerCase(),
  )
  const init = stdinFrames(proc).find((f) => f['type'] === 'control_request')
  const schema =
    (init?.['request'] as { subtype?: string; jsonSchema?: { required?: string[] } } | undefined) ?? {}
  expect(schema.subtype).toBe('initialize')
  expect(schema.jsonSchema?.required).toEqual(['generatedAt', 'entries', 'newModels', 'unverifiable'])
  const prompt = promptOf(proc)
  expect(prompt).toContain('Use web search and page fetches ONLY to read official')
  expect(prompt).toContain('platform.claude.com')
  // Nothing changed yet.
  expect(catalogHash(e2e, 'pricing')).toBe(seedPricing)

  // ---- Review changes: Settings → Catalog's review, core's flags and default ticks ----
  await card.getByTestId('catalog-card-review').click()
  await expect(page).toHaveURL(/#\/settings\/catalog/)
  const table = page.getByTestId('catalog-diff')
  await expect(table).toBeVisible({ timeout: 20_000 })
  const tick = (id: string) => page.getByTestId(`catalog-diff-tick-${id}`)
  const row = (id: string) => page.getByTestId(`catalog-diff-row-${id}`)
  // Opus output +25%: offered and ticked.
  await expect(row(ROW.opusOutput)).toContainText('$20.00')
  await expect(row(ROW.opusOutput)).toContainText('$25.00')
  await expect(tick(ROW.opusOutput)).toHaveAttribute('data-state', 'checked')
  // Sonnet input +75% (over 50%): amber, unticked.
  await expect(row(ROW.sonnetInput).locator('[data-flag="bigChange"]')).toBeVisible()
  await expect(page.getByTestId(`catalog-diff-delta-${ROW.sonnetInput}`)).toHaveClass(/text-warning/)
  await expect(tick(ROW.sonnetInput)).toHaveAttribute('data-state', 'unchecked')
  // Haiku output 12×: suspicious, unticked.
  await expect(row(ROW.haikuOutput).locator('[data-flag="suspicious"]')).toBeVisible()
  await expect(tick(ROW.haikuOutput)).toHaveAttribute('data-state', 'unchecked')
  // A model the CLI does not report is flagged and unticked; Fable could not be confirmed.
  await expect(row(ROW.newHaiku5).locator('[data-flag="notReportedByCli"]')).toBeVisible()
  await expect(tick(ROW.newHaiku5)).toHaveAttribute('data-state', 'unchecked')
  await expect(page.getByTestId('catalog-diff-unverifiable')).toContainText('claude-fable-5-1')
  const ticked = await page
    .locator('[data-testid^="catalog-diff-tick-"][data-state="checked"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  expect(ticked).toEqual([`catalog-diff-tick-${ROW.opusOutput}`])

  // ---- Apply 1 change: "Prices updated · Undo"; the files and a backup ----
  const apply = page.getByTestId('catalog-diff-apply')
  await expect(apply).toHaveText('Apply 1 change')
  await apply.click()
  const updated = toasts(page).filter({ hasText: 'Prices updated' })
  await expect(updated).toBeVisible()
  await expect(updated.getByRole('button', { name: 'Undo' })).toBeVisible()
  expect(storedPrice(e2e, 'claude-opus-5-5')).toMatchObject({ outputPerMTok: 25, confidence: 'verified' })
  expect(storedPrice(e2e, 'claude-sonnet-5-5')).toMatchObject({ inputPerMTok: 2 })
  expect(storedPrice(e2e, 'claude-haiku-4-5-20251001')).toMatchObject({ outputPerMTok: 5 })
  expect(readdirSync(join(e2e.home, 'catalog', 'history'))).toHaveLength(1)
  expect(catalogScheduleState(e2e).lastRefreshAt).toBeGreaterThan(Date.now() + INTERVAL_DAYS * DAY_MS)
  // The update is done: the card goes (applied, and the next refresh is due in 14 days).
  await expect(page.getByTestId('catalog-history-undo')).toBeVisible()

  // ---- the estimate uses the new price at once (core), and the composer shows it ----
  expect(await planCostP80(e2e)).toBeCloseTo(planPriorCost(OPUS_E21), 9)
  // Keep the toast's timer paused (hover) while the Dashboard is opened with the keyboard.
  await updated.getByRole('button', { name: 'Undo' }).hover()
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(line).not.toHaveText(seedLine)
  await expect(line).toContainText('typical (no history yet)')
  const newLine = (await line.innerText()).trim()
  await expect(consentCard(page)).toHaveCount(0)

  // ---- Undo from the toast, the Dashboard open: the old prices, and the estimate follows without a reload ----
  await updated.getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page).filter({ hasText: 'The last price change was undone' })).toBeVisible()
  await expect(line).toHaveText(seedLine)
  expect(await planCostP80(e2e)).toBeCloseTo(planPriorCost(OPUS_SEED), 9)
  expect(catalogHash(e2e, 'pricing')).toBe(seedPricing)
  expect(catalogHash(e2e, 'models')).toBe(seedModels)
  expect(storedPrice(e2e, 'claude-opus-5-5')).toMatchObject({ outputPerMTok: 20 })
  expect(newLine).not.toBe(seedLine)

  // ---- the history lists the update and its undo ----
  await openCatalogSettings(page)
  const history = page.getByTestId('catalog-history')
  await expect(history.locator('tbody tr')).toHaveCount(2)
  expect(e2e.pageErrors).toEqual([])
})

test('a refresh without consent is refused and starts nothing', async ({ e2e }) => {
  test.setTimeout(120_000)
  await loadRefreshConverter()
  await e2e.start({ editScenario: withRefreshes([{ proposal: E21_PROPOSAL }]) })
  await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)
  await expect(consentCard(e2e.p)).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })

  // The IPC schema itself refuses anything but consent: true (z.literal(true)).
  for (const req of [{ consent: false }, {}, { consent: 'true' }, { consent: 1 }, undefined]) {
    const r = await e2e.invoke('catalog.refresh', req as never)
    expect(r.ok ? 'ok' : r.error.code, JSON.stringify(req)).toBe('VALIDATION')
  }
  await e2e.p.waitForTimeout(1_000)
  expect(refreshProcs(e2e)).toEqual([])
  expect(jobDirs(e2e)).toEqual([])
  const state = await e2e.call('catalog.get')
  expect(state.job).toBeNull()
  // The plan alone (what the card shows) runs nothing either.
  const plan = await e2e.call('catalog.refreshPlan')
  expect(plan).toMatchObject({ vendor: 'claude', model: 'sonnet' })
  expect(refreshProcs(e2e)).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})

test('Not now (7 days) sets the card aside for 7 days; Turn off stops asking, and Undo turns it back on', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  // The `catalog` notification is off by default (notification rules); this user turned it on and is in another window.
  const page = await e2e.start({ config: { notifications: { events: { catalog: true } } } })
  await simulateFocus(e2e, false)
  const catalogNotes = async (): Promise<RecordedNotification[]> =>
    (await recordedNotifications(e2e)).filter((n) => n.kind === 'catalog')
  await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)
  const card = consentCard(page)
  await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
  await expect.poll(async () => (await catalogNotes()).length).toBe(1)
  const [note] = await catalogNotes()
  expect(note).toMatchObject({
    title: 'Model prices may be out of date',
    body: 'Refresh them in Settings → Catalog.',
    runId: null,
  })
  // The next look (6 h on) finds the same due date: no second notification.
  await advanceClock(e2e, 7 * 60 * 60 * 1000)
  await page.waitForTimeout(1_500)
  expect(await catalogNotes()).toHaveLength(1)
  await simulateFocus(e2e, null)

  // ---- Not now (7 days): the card goes; state.json snoozes it; 7 days on it is back ----
  const now = (await e2e.e2eState()).now
  await card.getByTestId('catalog-card-snooze').click()
  await expect(
    toasts(page).filter({ hasText: 'Dim Factory asks about prices again in 7 days' }),
  ).toBeVisible()
  await expect(card).toHaveCount(0)
  const snoozed = catalogScheduleState(e2e).snoozedUntil ?? 0
  expect(snoozed).toBeGreaterThanOrEqual(now + 7 * DAY_MS)
  expect(snoozed).toBeLessThan(now + 7 * DAY_MS + 60_000)
  // Six days on: still set aside (the scheduler looks every 6 h).
  await advanceClock(e2e, 6 * DAY_MS)
  await page.waitForTimeout(1_500)
  await expect(card).toHaveCount(0)
  // Two more days: due again (a new due date: a new notification while the window is in the background).
  await simulateFocus(e2e, false)
  await advanceClock(e2e, 2 * DAY_MS)
  await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
  await expect.poll(async () => (await catalogNotes()).length).toBe(2)

  // ---- Turn off: the schedule is off in dimfactory.json; no card however long it waits ----
  await card.getByTestId('catalog-card-off').click()
  const off = toasts(page).filter({ hasText: 'Price checks are off' })
  await expect(off).toBeVisible()
  await expect(card).toHaveCount(0)
  const status = await e2e.call('dashboard.get')
  expect(status.catalog).toMatchObject({ refreshDue: false, schedule: { enabled: false, nextDueAt: null } })
  const userConfig = await e2e.call('config.resolve', {})
  expect(userConfig.config.catalog.refresh.enabled).toBe(false)
  await off.getByRole('button', { name: 'Undo' }).click()
  await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
  expect((await e2e.call('config.resolve', {})).config.catalog.refresh.enabled).toBe(true)

  // Off again, and the clock moves a month: the scheduler never raises it.
  await card.getByTestId('catalog-card-off').click()
  await expect(card).toHaveCount(0)
  await advanceClock(e2e, 30 * DAY_MS)
  await page.waitForTimeout(1_500)
  await expect(card).toHaveCount(0)
  expect(await catalogNotes()).toHaveLength(2)
  await simulateFocus(e2e, null)
  expect(refreshProcs(e2e)).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})

test('a price edited by hand is marked as yours, used at once, and Undo puts the old one back', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  await composeTask(e2e)
  const line = page.getByTestId('estimate-line')
  await expect(line).toContainText('typical (no history yet)')
  // The seed's own price: until Claude's launch probe names the CLI's default model, the line reads "no price (CLI
  // default model unknown)" (with Gemini's launch probe too, this read that line as the seed).
  await expect(line).toContainText(' est. ', { timeout: 30_000 })
  const seedLine = (await line.innerText()).trim()
  const seedPricing = catalogHash(e2e, 'pricing')

  // ---- Settings → Catalog → Edit Opus 5.5: a bad value is refused in the row, then output $25 is saved ----
  await openCatalogSettings(page)
  const key = 'claude-claude-opus-5-5'
  await page.getByTestId(`catalog-edit-${key}`).click()
  const output = page.getByTestId(`catalog-edit-${key}-outputPerMTok`)
  await output.fill('2000')
  await page.getByTestId(`catalog-save-${key}`).click()
  await expect(page.getByTestId(`catalog-edit-error-${key}`)).toContainText(
    'At most $1,000 per million tokens.',
  )
  expect(catalogHash(e2e, 'pricing')).toBe(seedPricing)
  await output.fill('25')
  await output.press('Enter')
  const saved = toasts(page).filter({ hasText: 'Price saved for claude-opus-5-5' })
  await expect(saved).toBeVisible()
  await expect(page.getByTestId(`catalog-edited-${key}`)).toContainText('Edited by you')
  await expect(page.getByTestId(`catalog-price-${key}`)).toContainText('$25.00')
  expect(storedPrice(e2e, 'claude-opus-5-5')).toMatchObject({ outputPerMTok: 25, confidence: 'user' })
  expect(await planCostP80(e2e)).toBeCloseTo(planPriorCost(OPUS_E21), 9)

  // ---- the composer's estimate uses it ----
  await saved.getByRole('button', { name: 'Undo' }).hover()
  await page.keyboard.press('ControlOrMeta+1')
  await expect(line).not.toHaveText(seedLine)

  // ---- Undo (the toast): the shipped price, byte for byte ----
  await saved.getByRole('button', { name: 'Undo' }).click()
  await expect(line).toHaveText(seedLine)
  expect(catalogHash(e2e, 'pricing')).toBe(seedPricing)
  expect(storedPrice(e2e, 'claude-opus-5-5')).toMatchObject({ outputPerMTok: 20, confidence: 'unverified' })
  await openCatalogSettings(page)
  await expect(page.getByTestId(`catalog-edited-${key}`)).toHaveCount(0)
  await expect(page.getByTestId(`catalog-price-${key}`)).toContainText('$20.00')
  expect(e2e.pageErrors).toEqual([])
})

test('an apply that cannot replace models.json (another program holds it) changes nothing; Apply again works', async ({
  e2e,
}) => {
  // A real Windows sharing violation (the integration suite injects EPERM on every OS: apply-eperm.test.ts).
  test.skip(process.platform !== 'win32', 'a file held open blocks a rename only on Windows')
  test.setTimeout(240_000)
  await loadRefreshConverter()
  const page = await e2e.start({ editScenario: withRefreshes([{ proposal: E21_PROPOSAL }]) })
  await advanceClock(e2e, (INTERVAL_DAYS + 1) * DAY_MS)
  const card = consentCard(page)
  await expect(card).toHaveAttribute('data-mode', 'consent', { timeout: 30_000 })
  await card.getByTestId('catalog-card-update').click()
  await expect(card).toHaveAttribute('data-mode', 'review', { timeout: 60_000 })
  await card.getByTestId('catalog-card-review').click()
  await expect(page.getByTestId('catalog-diff')).toBeVisible({ timeout: 20_000 })

  // The Opus price and the new model: the apply writes pricing.json, then models.json.
  await page.getByTestId(`catalog-diff-tick-${ROW.newHaiku5}`).click()
  await expect(page.getByTestId(`catalog-diff-tick-${ROW.newHaiku5}`)).toHaveAttribute(
    'data-state',
    'checked',
  )
  const apply = page.getByTestId('catalog-diff-apply')
  await expect(apply).toHaveText('Apply 2 changes')
  const pricing = catalogHash(e2e, 'pricing')
  const models = catalogHash(e2e, 'models')

  const release = await holdOpen(join(e2e.home, 'catalog', 'models.json'))
  try {
    await apply.click()
    const error = toasts(page).filter({ hasText: 'The prices could not be updated; nothing was changed.' })
    await expect(error).toBeVisible({ timeout: 30_000 })
    expect(catalogHash(e2e, 'pricing')).toBe(pricing)
    expect(catalogHash(e2e, 'models')).toBe(models)
    expect(
      readdirSync(join(e2e.home, 'catalog')).filter((f) => f.endsWith('.tmp') || f === '.commit.json'),
    ).toEqual([])
    expect(readdirSync(join(e2e.home, 'catalog', 'history'))).toEqual([])
    // The review stays as the user left it, ready to try again.
    await expect(apply).toHaveText('Apply 2 changes')
    await expect(apply).toBeEnabled()
    expect((await e2e.call('catalog.get')).job?.state).toBe('diff-ready')
  } finally {
    await release()
  }

  await apply.click()
  await expect(toasts(page).filter({ hasText: 'Prices updated' })).toBeVisible()
  expect(catalogHash(e2e, 'pricing')).not.toBe(pricing)
  expect(catalogHash(e2e, 'models')).not.toBe(models)
  expect(storedPrice(e2e, 'claude-opus-5-5')).toMatchObject({ outputPerMTok: 25 })
  expect(e2e.pageErrors).toEqual([])
})
