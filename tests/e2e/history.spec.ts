// History ("History: filters; re-run with same config (resolved.json equal); re-run from
// Fix (fake sees --resume=<id>), including from a failed run"; the Runs history's filters (folder, status, vendor,
// date, text; 100 per page) and row actions (Open · Re-run with same config · Re-run from Fix, whose tooltip says
// fresh or why · Open diff · Reveal folder · Pin / Remove with undo); a re-run loads
// resolved.json.config through ResolvedConfigZ; state-machine row R14).
//   - filters: a history seeded before launch (two folders, Claude and Codex runs, every finished status, from today
//     back to 90 days ago) is filtered by status, folder, vendor, date and title text, each answered by core's
//     runs.list; 100 rows a page, and Load more appends the next page below without moving the rows above
//   - Re-run with same config from a row's menu: the new run has the source's task, and its resolved.json equals the
//     source's except the key naming the run it re-runs (rerunOf); the source's own run settings carry over
//   - Re-run from Fix from a row's menu: the menu says Fix would continue the Implement session; the findings picker
//     opens under the row with core's default ticks; with one should unticked, the new run's Fix is spawned with
//     `--resume=<Implement's session id>` and gets only the two musts; Plan, Implement, Review and Critic are carried
//     from run #1, not run again
//   - Re-run from Fix of a failed run (its Fix failed: logged out) that still holds its folder: the menu and the picker
//     say the run is stopped when the new one starts; the source ends cancelled (its failure kept) and the re-run's Fix
//     resumes Implement's session
//   - Re-run with same config of such a failed run (R14 for both forms): the Run view's Re-run ▾ says so; the source is
//     closed (cancelled, failure kept) and the new run runs the whole task again
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { passArgvs } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { fakeProc, fakeProcs, stepSessionId } from './attention-helpers.ts'
import {
  DAY_MS,
  FAILED_FIX,
  FINDING_TITLES,
  NO_GATES,
  RESUMED_FIX,
  findingsFlow,
  listed,
  manyRows,
  openRowMenu,
  openRunsPage,
  resolvedJson,
  rowIds,
  runRow,
  seedHistory,
  storedState,
} from './history-helpers.ts'
import type { SeedRow } from './history-helpers.ts'
import { cleanRuns } from './dashboard-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

/** Start a run in the sandbox through core (the run under test is the re-run, started from the UI). */
async function startRun(
  e2e: E2EHarness,
  task: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return (await e2e.call('runs.start', { folder: e2e.sandbox, task, overrides })).runId
}

/** The run opened by the last navigation (#/runs/<id>), once its Run view is up. */
async function openedRun(page: Page, not: string): Promise<string> {
  await expect(page).not.toHaveURL(new RegExp(`#/runs/${not}$`))
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  await expect(page.getByTestId('run-view')).toBeVisible()
  const id = /#\/runs\/([^/]+)$/.exec(page.url())?.[1]
  if (id === undefined) throw new Error(`no run in ${page.url()}`)
  return id
}

/** The page's count once core's answer for the filters is on screen. */
async function expectCount(page: Page, n: number): Promise<void> {
  await expect(page.locator('[data-testid="runs-list"][aria-busy="true"]')).toHaveCount(0)
  if (n === 0) {
    await expect(page.getByText('No runs match these filters')).toBeVisible()
    return
  }
  await expect(page.getByTestId('runs-count')).toHaveText(`${n} ${n === 1 ? 'run' : 'runs'}`)
}

/** `YYYY-MM-DD` of the local day `days` before now (an <input type="date"> value). */
function localDay(days: number): string {
  const d = new Date(Date.now() - days * DAY_MS)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test('History: filters by status, folder, vendor, date and title; 100 per page, Load more below', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  // ---- an earlier history, seeded before launch: two projects, Claude and Codex runs, today back to 90 days ----
  const api = join(e2e.root, 'projects', 'api')
  const web = join(e2e.root, 'projects', 'web')
  const webRows: SeedRow[] = [
    { title: 'old web task', folder: web, status: 'completed', ageMs: 90 * DAY_MS },
    { title: 'web cleanup', folder: web, status: 'cancelled', ageMs: 20 * DAY_MS },
    { title: 'rename the parser', folder: web, status: 'completed', ageMs: 2 * DAY_MS },
    // Between two api runs (they are 5 minutes apart).
    {
      title: 'fix the parser tests',
      folder: web,
      status: 'failed',
      vendor: 'codex',
      ageMs: 3 * 3_600_000 + 60_000,
    },
  ]
  // The oldest first (display numbers rise with time): ten api runs from 40 days ago, the web runs, 110 recent api runs.
  const rows: SeedRow[] = [
    ...Array.from({ length: 10 }, (_, i): SeedRow => ({
      title: `archived api run ${i + 1}`,
      folder: api,
      status: 'completed',
      ageMs: 40 * DAY_MS - i * 60_000,
    })),
    ...webRows,
    ...manyRows(110, api, 'api run'),
  ].sort((a, b) => b.ageMs - a.ageMs)
  const seeded = seedHistory(e2e, rows)
  const total = seeded.length
  const count = (pred: (r: SeedRow) => boolean): number => rows.filter(pred).length

  const page = await e2e.start({})
  await openRunsPage(page)

  // ---- every run: 100 a page, newest first; Load more appends the rest below ----
  await expectCount(page, 100)
  // Core's order: newest first (then the higher number).
  const newest = [...seeded].sort((a, b) => b.createdAt - a.createdAt || b.displayNo - a.displayNo)
  const firstPage = await rowIds(page)
  expect(firstPage).toEqual(newest.slice(0, 100).map((s) => s.runId))
  // The user scrolls down to Load more; the last row of the page sits just above it.
  const more = page.getByTestId('runs-load-more')
  await more.scrollIntoViewIfNeeded()
  const last = runRow(page, firstPage.at(-1) ?? '')
  const before = await last.boundingBox()
  await more.click()
  await expectCount(page, total)
  expect(await rowIds(page)).toEqual(newest.map((s) => s.runId))
  // The next page arrived below: the row the user was reading did not move. The button goes once there is no more.
  expect((await last.boundingBox())?.y).toBe(before?.y)
  await expect(more).toHaveCount(0)

  // ---- status ----
  await page.getByTestId('runs-filter-failed').click()
  await expect(page.getByTestId('runs-filter-failed')).toHaveAttribute('aria-pressed', 'true')
  await expectCount(
    page,
    count((r) => r.status === 'failed'),
  )
  for (const id of await rowIds(page)) await expect(runRow(page, id)).toHaveAttribute('data-status', 'failed')
  await page.getByTestId('runs-filter-cancelled').click()
  await expectCount(
    page,
    count((r) => r.status === 'cancelled'),
  )
  await page.getByTestId('runs-filter-all').click()
  await expectCount(page, 100)

  // ---- folder: both projects are offered ----
  const folder = page.getByTestId('runs-filter-folder')
  const options = async (select: typeof folder): Promise<string[]> =>
    (await select.locator('option').allTextContents()).sort()
  expect(await options(folder)).toEqual(['All folders', `api (${api})`, `web (${web})`])
  await folder.selectOption(web)
  await expectCount(page, 4)
  expect(new Set(await rowIds(page))).toEqual(
    new Set(seeded.filter((s) => s.folder === web).map((s) => s.runId)),
  )

  // ---- date, with the folder still set: the last 7 days, the last 30, a custom range ----
  const date = page.getByTestId('runs-filter-date')
  await date.selectOption('7d')
  await expectCount(page, 2)
  await date.selectOption('30d')
  await expectCount(page, 3)
  await date.selectOption('custom')
  await page.getByTestId('runs-filter-from').fill(localDay(25))
  await page.getByTestId('runs-filter-to').fill(localDay(10))
  await expectCount(page, 1)
  await expect(page.getByTestId('runs-list')).toContainText('web cleanup')

  // ---- Clear filters, then vendor: Codex (a vendor a listed run used; Gemini is listed too, and
  //      Grok and Muse) ----
  const clear = page.getByTestId('runs-filter-clear')
  await clear.click()
  await expect(clear).toBeDisabled()
  await expectCount(page, 100)
  const vendor = page.getByTestId('runs-filter-vendor')
  expect(await options(vendor)).toEqual(['All vendors', 'Claude', 'Codex', 'Gemini', 'Grok', 'Muse'])
  await vendor.selectOption('codex')
  await expectCount(page, 1)
  await expect(page.getByTestId('runs-list')).toContainText('fix the parser tests')
  await vendor.selectOption('claude')
  await expectCount(page, 100)
  await vendor.selectOption('')

  // ---- title text: core matches it once typing pauses ----
  await page.getByTestId('runs-filter-text').fill('parser')
  await expectCount(page, 2)
  await expect(page.getByTestId('runs-list')).toContainText('rename the parser')
  await page.getByTestId('runs-filter-text').fill('PARSER TESTS')
  await page.getByTestId('runs-filter-text').press('Enter')
  await expectCount(page, 1)
  await page.getByTestId('runs-filter-text').fill('no such run')
  await expectCount(page, 0)
  await clear.click()
  await expectCount(page, 100)

  // Each answer was core's: the same filters through runs.list.
  expect(await listed(e2e, { folder: web, text: 'parser' })).toHaveLength(2)
  expect(await listed(e2e, { vendor: 'codex' })).toHaveLength(1)

  // ---- the summary tiles: the last 7 days by default ----
  const week = count((r) => r.ageMs < 7 * DAY_MS)
  await expect(page.getByTestId('runs-stat-runs-value')).toHaveText(String(week))
  await page.getByTestId('runs-stats-range-30d').click()
  await expect(page.getByTestId('runs-stat-runs-value')).toHaveText(
    String(count((r) => r.ageMs < 30 * DAY_MS)),
  )
  expect(e2e.pageErrors).toEqual([])
})

test('Re-run from Fix: the picker’s findings go to a Fix that resumes Implement’s session', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  // The source stops at the findings gate (Cancel): Implement made a change and Review found F1, F2 [must], F3 [should].
  const page = await e2e.start({
    scenario: findingsFlow([RESUMED_FIX]),
    config: { gates: { afterPlan: false, beforeFix: true } },
  })
  const source = await startRun(e2e, 'add a --version flag')
  const gateSnap = await e2e.waitForSnapshot(
    source,
    (s) => s.cards.some((c) => c.kind === 'gate:beforeFix'),
    {
      what: 'the gate before Fix',
    },
  )
  const gate = gateSnap.cards.find((c) => c.kind === 'gate:beforeFix')
  await e2e.call('cards.resolve', { runId: source, cardId: gate?.id ?? '', choiceId: 'cancel' })
  const cancelled = await e2e.waitForSummary(source, (s) => s.status === 'cancelled' && s.lock === undefined)
  expect(cancelled.findings).toEqual({ must: 2, should: 1 })
  const implId = stepSessionId(e2e, source, 'implement') ?? ''
  expect(implId).toMatch(/^[0-9a-f-]{36}$/)

  // ---- the Runs page: the row's menu says Fix would continue the Implement session ----
  await openRunsPage(page)
  await expect(runRow(page, source)).toHaveAttribute('data-status', 'cancelled')
  const menu = await openRowMenu(page, source)
  const item = menu.getByTestId('runs-action-rerun-fix')
  await expect(item).not.toHaveAttribute('data-disabled', /.*/)
  await expect(item.getByTestId('runs-action-rerun-fix-text')).toHaveText(
    'Fix would continue the Implement session',
  )
  await expect(item).toHaveAttribute('title', 'Fix would continue the Implement session')
  await item.click()

  // ---- the picker under the row: core's default ticks (every must, and the should chosen at the gate) ----
  const picker = page.getByTestId(`runs-fix-picker-${source}`)
  await expect(picker).toBeVisible()
  await expect(picker).toBeFocused()
  await expect(picker).toContainText('Plan, Implement, Review and Critic are carried over from run #1')
  await expect(picker.getByTestId('fix-picker-session')).toHaveText(
    'Fix would continue the Implement session.',
  )
  await expect(picker.getByTestId('fix-picker-stops-source')).toHaveCount(0)
  const box = (id: string) => picker.getByTestId(`runs-fix-${source}-${id}`).getByRole('checkbox')
  const findings = (await e2e.call('runs.get', { runId: source })).rerunFromFix.findingIds ?? []
  expect(findings).toHaveLength(3)
  for (const id of findings) await expect(box(id)).toBeChecked()
  await expect(picker.getByTestId('fix-picker-receives')).toHaveText('Fix will receive 2 must · 1 should')
  // F3 (the should) unticked: Fix gets the two musts.
  const should = findings[2] ?? ''
  await box(should).click()
  await expect(box(should)).not.toBeChecked()
  await expect(picker.getByTestId('fix-picker-receives')).toHaveText('Fix will receive 2 must · 0 should')
  const start = picker.getByTestId('fix-picker-start')
  await expect(start).toHaveText('Re-run from Fix with 2 findings')
  await start.click()

  // ---- the new run opens, starts at Fix and resumes Implement's session ----
  const rerun = await openedRun(page, source)
  const ended = await e2e.waitForEnd(rerun)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  expect(ended.rerunOf).toEqual({ runId: source, displayNo: 1, from: 'fix' })
  const fix = fakeProc(e2e, 'resume-1.script.jsonl')
  expect(fix.argv).toContain(`--resume=${implId}`)
  expect(fix.argv.some((a) => a.startsWith('--session-id'))).toBe(false)
  const prompt = fix.stdin.join('\n')
  expect(prompt).toContain(FINDING_TITLES.F1)
  expect(prompt).toContain(FINDING_TITLES.F2)
  expect(prompt).not.toContain(FINDING_TITLES.F3)
  // Nothing before Fix ran again: one Plan, one Implement, one Review and one Critic in all.
  const argvs = passArgvs(e2e.fakeLog())
  expect(argvs.filter((a) => a.includes('plan'))).toHaveLength(1)
  expect(argvs.filter((a) => a.includes('dontAsk'))).toHaveLength(2)
  expect(fakeProcs(e2e).filter((p) => p.script.startsWith('implement-'))).toHaveLength(1)

  // The Run view: the carried steps say where they come from; Fix reused the session.
  for (const step of ['plan', 'implement', 'review', 'critic'] as const) {
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'skipped')
  }
  const snap = await e2e.snapshot(rerun)
  for (const step of ['plan', 'implement', 'review', 'critic'] as const)
    expect(snap.steps[step]).toMatchObject({ status: 'skipped', reason: 'carried from run #1' })
  expect(snap.steps.fix).toMatchObject({ status: 'done', sessionNote: 'reused the Implement session' })
  await expect(page.getByTestId('fix-session-line')).toHaveText('Session: reused the Implement session')
  expect(storedState(e2e, rerun)['rerunOf']).toMatchObject({ runId: source, displayNo: 1, from: 'fix' })

  // The Runs page names the source on the new run's row.
  await openRunsPage(page)
  await expect(page.getByTestId(`runs-meta-${rerun}`)).toContainText('Re-run from Fix of #1')
  expect(e2e.pageErrors).toEqual([])
})

test('Re-run from Fix of a failed run: the source is closed as the re-run takes its folder', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  // The source's Fix fails (the CLI is logged out): the run fails at Fix and keeps its folder. The re-run's Fix resumes.
  const page = await e2e.start({ scenario: findingsFlow([FAILED_FIX, RESUMED_FIX]), config: NO_GATES })
  const source = await startRun(e2e, 'add a --version flag')
  const failed = await e2e.waitForEnd(source)
  expect(failed.status, e2e.describeRun(failed)).toBe('failed')
  expect(failed.failure?.step).toBe('fix')
  expect(failed.lock).toBe('held')
  const implId = stepSessionId(e2e, source, 'implement') ?? ''
  expect(fakeProc(e2e, 'resume-1.script.jsonl').argv).toContain(`--resume=${implId}`)

  // ---- the Runs page: the failed run cannot be removed while it holds its folder; Re-run from Fix is offered ----
  await openRunsPage(page)
  await expect(runRow(page, source)).toHaveAttribute('data-status', 'failed')
  await expect(page.getByTestId(`runs-remove-${source}`)).toBeDisabled()
  const menu = await openRowMenu(page, source)
  // Either form of re-run stops a source that still holds its folder (R14): both items say so.
  const stopsFirst = 'Run #1 still holds its folder, so it is stopped when the new run starts.'
  await expect(menu.getByTestId('runs-action-rerun-text')).toHaveText(stopsFirst)
  const item = menu.getByTestId('runs-action-rerun-fix')
  await expect(item.getByTestId('runs-action-rerun-fix-text')).toHaveText(
    'Fix would continue the Implement session',
  )
  await item.click()
  const picker = page.getByTestId(`runs-fix-picker-${source}`)
  await expect(picker).toBeVisible()
  await expect(picker.getByTestId('fix-picker-stops-source')).toHaveText(stopsFirst)
  await expect(picker.getByTestId('fix-picker-receives')).toHaveText('Fix will receive 2 must · 1 should')
  await picker.getByTestId('fix-picker-start').click()

  // ---- the re-run takes the folder; the source was closed (cancelled, its failure kept) ----
  const rerun = await openedRun(page, source)
  const ended = await e2e.waitForEnd(rerun)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  const fix = fakeProc(e2e, 'resume-2.script.jsonl')
  expect(fix.argv).toContain(`--resume=${implId}`)
  for (const t of Object.values(FINDING_TITLES)) expect(fix.stdin.join('\n')).toContain(t)
  const closed = await e2e.waitForSummary(source, (s) => s.status === 'cancelled' && s.lock === undefined)
  expect(closed.outcome).toBe('failed')
  expect(closed.failure?.step).toBe('fix')
  expect(ended.rerunOf).toEqual({ runId: source, displayNo: 1, from: 'fix' })
  // One Plan and one Implement in all: the re-run carried them.
  expect(passArgvs(e2e.fakeLog()).filter((a) => a.includes('plan'))).toHaveLength(1)
  expect(fakeProcs(e2e).filter((p) => p.script.startsWith('implement-'))).toHaveLength(1)
  await expect(page.getByTestId('run-outcome')).toHaveText(/^Fixed/)
  expect(e2e.pageErrors).toEqual([])
})

/**
 * resolved.json without the one key a re-run adds about itself (the run it re-runs). It has no ids or timestamps
 * otherwise: the settings, where they came from, the folder's scope, and the vendors and prices as probed at the start
 * (the same fake CLI here).
 */
function settingsOf(resolved: Record<string, unknown>): Record<string, unknown> {
  const { rerunOf: _rerunOf, ...rest } = resolved
  return rest
}

test('Re-run with same config: the new run’s resolved.json equals the source’s', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({ scenario: cleanRuns(2) })
  // The source's own run settings (a run override): no plan gate, the Review on opus. The re-run keeps them.
  const source = await startRun(e2e, 'add a --version flag', {
    gates: { afterPlan: false },
    passes: { review: { model: 'opus' } },
  })
  const first = await e2e.waitForEnd(source)
  expect(first.status, e2e.describeRun(first)).toBe('completed')

  await openRunsPage(page)
  const menu = await openRowMenu(page, source)
  const item = menu.getByTestId('runs-action-rerun')
  await expect(item).toContainText('Re-run with same config')
  await expect(item).toContainText("A new run with this run's task and settings")
  await item.click()
  const rerun = await openedRun(page, source)
  const ended = await e2e.waitForEnd(rerun)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.title).toBe(first.title)
  expect(ended.rerunOf).toEqual({ runId: source, displayNo: 1, from: 'start' })
  // It never stopped for its plan: the gate was off in the source's settings.
  expect((await e2e.snapshot(rerun)).steps.plan.status).toBe('done')

  const a = resolvedJson(e2e, source)
  const b = resolvedJson(e2e, rerun)
  expect(b['rerunOf']).toEqual({ runId: source, displayNo: 1, from: 'start' })
  expect(settingsOf(b)).toEqual(settingsOf(a))
  expect((a['config'] as { passes: { review: { model: string } } }).passes.review.model).toBe('opus')
  // Both reviewers ran on opus, the source's setting, in both runs.
  const reviewers = passArgvs(e2e.fakeLog()).filter((x) => x.includes('dontAsk'))
  expect(reviewers).toHaveLength(4)
  for (const x of reviewers) expect(x[x.indexOf('--model') + 1]).toBe('opus')
  expect(e2e.pageErrors).toEqual([])
})

test('Re-run with same config of a failed run that holds its folder: the source is closed first', async ({
  e2e,
}) => {
  test.setTimeout(300_000)
  // The source fails at Fix (logged out) and keeps its folder; the re-run plans and implements again (reviewers clean).
  const page = await e2e.start({
    scenario: {
      ...findingsFlow([FAILED_FIX]),
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: VERSION_WRITE },
        { recording: 'C08a-session-id-implement', write: { path: 'src/help.ts', content: 'export {}\n' } },
      ],
    },
    config: NO_GATES,
  })
  const source = await startRun(e2e, 'add a --version flag')
  const failed = await e2e.waitForEnd(source)
  expect(failed.status, e2e.describeRun(failed)).toBe('failed')
  expect(failed.lock).toBe('held')

  // The Run view's Re-run ▾: Re-run with same config says the failed run is stopped when the new run starts.
  await page.evaluate((id) => {
    location.hash = `#/runs/${id}`
  }, source)
  await expect(page.getByTestId('run-view')).toBeVisible()
  await page.getByTestId('rerun-menu').click()
  await expect(page.getByTestId('rerun-start-hint')).toHaveText(
    'Run #1 still holds its folder, so it is stopped when the new run starts.',
  )
  await page.getByTestId('rerun-start').click()
  const rerun = await openedRun(page, source)
  const ended = await e2e.waitForEnd(rerun)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  expect(ended.rerunOf).toEqual({ runId: source, displayNo: 1, from: 'start' })
  const closed = await e2e.waitForSummary(source, (s) => s.status === 'cancelled' && s.lock === undefined)
  expect(closed.outcome).toBe('failed')
  expect(closed.failure?.step).toBe('fix')
  // The whole run again: a second Plan and Implement.
  expect(passArgvs(e2e.fakeLog()).filter((a) => a.includes('plan'))).toHaveLength(2)
  expect(fakeProcs(e2e).filter((p) => p.script.startsWith('implement-'))).toHaveLength(2)
  expect(e2e.pageErrors).toEqual([])
})
