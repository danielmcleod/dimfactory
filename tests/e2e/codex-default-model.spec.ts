// Codex's "CLI default", decided per pass (a model the account's list lacks). The live run's account (a free
// ChatGPT login) refused the model its Codex profile names (X09h), while the
// composer said "CLI default". With the fake Codex (a ChatGPT login), from the Dashboard:
//   1. The folder's model is not offered to the account: Implement and Fix, which name no model, start their threads
//      without one, read the account's whole list, and run its default (sent on turn/start); their cards name it from
//      the start (the model core expects), and the run records the model replaced. The model chip is at least as wide
//      as its text. The Config tab, open while Implement starts, names the expected model from the plan gate on (a
//      queued pass has no card yet), and nothing in it moves or changes as Implement starts and Codex confirms that
//      model (UI standard: nothing moves on its own).
//   2. The folder's model is listed, hidden, so Dim Factory leaves it to the CLI (nothing sent); its id is longer than
//      the expected one, so when it arrives the chip keeps its width, its text is cut with an ellipsis and the mode chip
//      after it does not move; when the account refuses it anyway the snag offers the account's default as a one-click
//      fix, and Implement runs again with it.
//   3. Codex ignores the default Dim Factory sent on turn/start (its refusal names the folder's model): the card names
//      that model, not the default, and the one-click fix puts the default on the pass, sent on thread/start.
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { snagCard, unpromptedShifts, watchShifts } from './recovery-helpers.ts'
import { editPass, failedPass, resumePass, threadIdNow } from './codex-helpers.ts'
import type { CodexModel } from './codex-helpers.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

const TASK = 'add a --version flag'
/** The account's picker list: gpt-5.6-terra is its default. */
const ACCOUNT: CodexModel[] = [
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', isDefault: true },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
]
/** A hidden model whose id is longer than the expected one (and than "default model"). */
const LONG_HIDDEN = 'gpt-5.6-sol-max-preview-0815'
/** The same account's whole list with LONG_HIDDEN hidden (never shown in a picker). */
const WITH_HIDDEN_LONG: CodexModel[] = [
  ...ACCOUNT,
  { id: LONG_HIDDEN, displayName: 'GPT-5.6 Sol Max Preview', hidden: true },
]
const TOTAL = { input: 12_000, cached: 8_192, output: 900, reasoning: 256 }
const refusal = (model: string): string =>
  `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '${model}' model is not supported when using Codex with a ChatGPT account."}}`

/** The model chip's parts as laid out: its box, its sizers' widest text and the shown text's widths. */
async function chipLayout(page: Page, step: string) {
  return page.getByTestId(`model-chip-${step}`).evaluate((chip) => {
    const reserve = chip.querySelector<HTMLElement>('[data-chip-reserve]')
    const sizers = [...(reserve?.querySelectorAll<HTMLElement>(':scope > [aria-hidden]') ?? [])]
    const shown = reserve?.querySelector<HTMLElement>(':scope > span:not([aria-hidden])')
    return {
      chipWidth: chip.getBoundingClientRect().width,
      reserveWidth: reserve?.clientWidth ?? 0,
      labels: sizers.map((s) => s.getAttribute('data-label')),
      widestLabel: Math.max(0, ...sizers.map((s) => s.scrollWidth)),
      shownWidth: shown?.clientWidth ?? 0,
      shownText: shown?.scrollWidth ?? 0,
      ellipsis: shown !== null && shown !== undefined ? getComputedStyle(shown).textOverflow : '',
    }
  })
}

type Watch = { moves: string[]; texts: string[]; frames: number; stop?: () => void }
type WatchWindow = Window & { __configWatch?: Watch }

/**
 * Record, every frame, where the Config tab's table rows and cells are (against where they were when the watch began)
 * and every text Implement's Model cell shows.
 */
async function watchConfigTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as WatchWindow
    const watch: Watch = { moves: [], texts: [], frames: 0 }
    w.__configWatch = watch
    const cells = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="config-tab"] tr, [data-testid="config-tab"] th, [data-testid="config-tab"] td',
      ),
    ]
    const box = (el: HTMLElement): string => {
      const r = el.getBoundingClientRect()
      return `${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}×${r.height.toFixed(1)}`
    }
    const first = new Map(cells().map((el) => [el, box(el)]))
    const name = (el: HTMLElement): string =>
      `${el.tagName.toLowerCase()}[${el.closest('tr')?.getAttribute('data-testid') ?? 'head'}] ${el.textContent?.slice(0, 30) ?? ''}`
    let raf = 0
    const tick = (): void => {
      watch.frames++
      for (const el of cells()) {
        const was = first.get(el)
        const now = box(el)
        if (was === undefined) watch.moves.push(`${name(el)} appeared at ${now}`)
        else if (was !== now) watch.moves.push(`${name(el)} ${was} → ${now}`)
        if (was === undefined || was !== now) first.set(el, now)
      }
      const text = document.querySelector('[data-testid="config-model-implement"]')?.textContent ?? ''
      if (watch.texts.at(-1) !== text) watch.texts.push(text)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    watch.stop = () => cancelAnimationFrame(raf)
  })
}

async function stopConfigWatch(page: Page): Promise<Omit<Watch, 'stop'>> {
  return page.evaluate(() => {
    const w = (window as WatchWindow).__configWatch
    if (w === undefined) throw new Error('the Config tab is not watched')
    w.stop?.()
    return { moves: w.moves, texts: w.texts, frames: w.frames }
  })
}

test('default model: a pass with no model runs the account’s default when the folder’s model is not offered', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const thread = threadIdNow('dm1')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      critic: [{ recording: 'C02-review-shape', text: 'NO FINDINGS' }],
    },
    config: { profile: 'balanced', gates: { afterPlan: true, beforeFix: false } },
    codex: {
      models: ACCOUNT,
      edit: editPass({
        threadId: thread,
        turnId: 'turn-dm-implement',
        model: 'gpt-5.6-sol',
        accountList: ACCOUNT,
        // The pass has started and Codex has not said yet which model it runs.
        listDelayMs: 1_500,
        text: 'Added the --version flag.',
        write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        total: TOTAL,
      }),
      resume: {
        threadId: thread,
        ops: resumePass({
          threadId: thread,
          turnId: 'turn-dm-fix',
          model: 'gpt-5.6-sol',
          accountList: ACCOUNT,
          text: 'Done.\n\nF1 fixed\nF2 fixed',
          restored: TOTAL,
          total: { ...TOTAL, input: 20_000 },
        }),
      },
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  fake.writeRollout(thread)

  const run = await e2e.runFromDashboard(TASK)
  // At the plan gate (Implement queued, so it has no card yet), the user opens the Config tab: Implement's Model cell
  // names the expected model already.
  const gateSnap = await e2e.waitForSnapshot(
    run.runId,
    (s) => s.cards.some((c) => c.kind === 'gate:afterPlan'),
    {
      what: 'the plan gate',
    },
  )
  await page.getByTestId('run-tab-config').click()
  await expect(page.getByTestId('run-tab-config')).toHaveAttribute('data-state', 'active')
  const cell = page.getByTestId('config-model-implement')
  await expect(cell).toHaveText('gpt-5.6-terra (default)')
  await page.waitForTimeout(500)
  await watchShifts(page)
  await watchConfigTab(page)
  // The plan is approved elsewhere (not a click in this page): Implement starts, reads the list, and Codex confirms.
  const gate = gateSnap.cards.find((c) => c.kind === 'gate:afterPlan')
  await e2e.call('cards.resolve', { runId: run.runId, cardId: gate?.id ?? '', choiceId: 'approve' })
  await e2e.waitForSnapshot(
    run.runId,
    (s) => s.steps.implement.status === 'done' && s.steps.implement.modelUsed !== undefined,
    { what: 'Implement done, its model said' },
  )
  const watched = await stopConfigWatch(page)
  expect(watched.frames).toBeGreaterThan(10)
  expect(watched.texts).toEqual(['gpt-5.6-terra (default)'])
  expect(watched.moves, 'the Config tab moved while Implement started').toEqual([])
  // The page as ui-layout.spec.ts measures a live run (CLS under 0.02), and no layout shift in the Config tab at all.
  const shifts = await unpromptedShifts(page)
  expect(shifts.cls, shifts.moved.join('\n')).toBeLessThan(0.02)
  expect(shifts.moved.filter((m) => m.includes('[config-'))).toEqual([])
  await expect(cell).toHaveText('gpt-5.6-terra (default)')

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // The threads started without a model; each pass read the whole list, then turn/start carried the account's default.
  expect(fake.errors()).toEqual([])
  expect(fake.requests('config/read')).toEqual([])
  expect(fake.requests('thread/start').map((r) => r.params['model'])).toEqual([undefined])
  expect(fake.requests('thread/resume').map((r) => r.params['model'])).toEqual([undefined])
  expect(fake.requests('model/list').filter((r) => r.params['includeHidden'] === true)).toHaveLength(2)
  expect(fake.requests('turn/start').map((r) => r.params['model'])).toEqual([
    'gpt-5.6-terra',
    'gpt-5.6-terra',
  ])

  // The cards name the model that ran, each chip at least as wide as its text (its sizer renders); the run records
  // that the passes named none, and the model replaced.
  await page.getByTestId('run-tab-flow').click()
  await expect(page.getByTestId('model-chip-implement')).toHaveText('gpt-5.6-terra')
  await expect(page.getByTestId('model-chip-fix')).toHaveText('gpt-5.6-terra')
  for (const step of ['implement', 'fix']) {
    const chip = await chipLayout(page, step)
    expect(chip.labels).toEqual(['gpt-5.6-terra'])
    expect(chip.widestLabel).toBeGreaterThan(20)
    expect(chip.reserveWidth).toBeGreaterThanOrEqual(chip.widestLabel - 0.5)
    expect(chip.shownWidth).toBeGreaterThanOrEqual(chip.shownText - 0.5)
    expect(chip.chipWidth).toBeGreaterThan(chip.widestLabel)
  }
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.implement).toMatchObject({
    model: null,
    modelUsed: 'gpt-5.6-terra',
    modelReplaced: 'gpt-5.6-sol',
  })
  // It ran: nothing is expected any more.
  expect(snap.steps.implement.expectedModel).toBeUndefined()
  expect(e2e.pageErrors).toEqual([])
})

test('default model: the folder’s hidden model runs as chosen, the chip keeps its width, one click runs the default', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const first = threadIdNow('dm2a')
  const second = threadIdNow('dm2b')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      review: [{ recording: 'C02-review-shape', text: 'NO FINDINGS' }],
      critic: [{ recording: 'C02-review-shape', text: 'NO FINDINGS' }],
    },
    config: { profile: 'balanced', gates: { afterPlan: false, beforeFix: false } },
    codex: {
      models: WITH_HIDDEN_LONG,
      // Hidden but listed, so Dim Factory leaves it to the CLI (nothing sent); the account refuses it all the same. The
      // whole list answers after a moment, so the card shows the expected model first.
      edit: failedPass({
        threadId: first,
        turnId: 'turn-dm-refused',
        model: LONG_HIDDEN,
        accountList: WITH_HIDDEN_LONG,
        listDelayMs: 2_500,
        message: refusal(LONG_HIDDEN),
        codexErrorInfo: 'other',
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')

  const run = await e2e.runFromDashboard(TASK)
  const chip = page.getByTestId('model-chip-implement')
  const mode = page.getByTestId('mode-chip-implement')
  // The pass has started (its card shows) and Codex has not said which model yet: the chip names the expected one,
  // whole, at least as wide as its text, with "default model" reserved beside it (what it reads if Codex never says).
  await expect(chip).toHaveText('gpt-5.6-terra', { timeout: 90_000 })
  const before = { chip: await chip.boundingBox(), mode: await mode.boundingBox() }
  const expected = await chipLayout(page, 'implement')
  expect(expected.labels).toEqual(['gpt-5.6-terra', 'default model'])
  expect(expected.widestLabel).toBeGreaterThan(20)
  expect(expected.reserveWidth).toBeGreaterThanOrEqual(expected.widestLabel - 0.5)
  expect(expected.shownWidth).toBeGreaterThanOrEqual(expected.shownText - 0.5)
  expect(expected.chipWidth).toBeGreaterThan(expected.widestLabel)
  // The folder's model (longer) runs: the chip names it within the width it had, cut with an ellipsis; the mode chip
  // after it stays put.
  await expect(chip).toHaveText(LONG_HIDDEN, { timeout: 30_000 })
  const after = { chip: await chip.boundingBox(), mode: await mode.boundingBox() }
  expect(after.chip?.width).toBe(before.chip?.width)
  expect(after.mode?.x).toBe(before.mode?.x)
  expect(after.mode?.y).toBe(before.mode?.y)
  const cut = await chipLayout(page, 'implement')
  expect(cut.labels).toEqual(expected.labels)
  expect(cut.shownWidth).toBeGreaterThan(20)
  expect(cut.shownText).toBeGreaterThan(cut.shownWidth)
  expect(cut.ellipsis).toBe('ellipsis')

  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'model_unavailable')
  expect(fake.requests('thread/start')[0]?.params['model']).toBeUndefined()
  expect(fake.requests('turn/start')[0]?.params['model']).toBeUndefined()
  const fix = snag.getByTestId('patch-implement:account-model')
  await expect(fix).toContainText("Use gpt-5.6-terra (Codex's default for this account)")
  await expect(fix.getByTestId('patch-preview-implement:account-model')).toContainText('"gpt-5.6-terra"')

  // The next Codex process answers as the account does for its default.
  fake.set({
    edit: editPass({
      threadId: second,
      turnId: 'turn-dm-retry',
      text: 'Added the --version flag.',
      write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
      total: TOTAL,
    }),
  })
  await snag.getByTestId('recovery-implement:account-model').click()
  // The run reads failed until the retry starts: wait for Implement to run with the model the fix put on it.
  await e2e.waitForSnapshot(run.runId, (s) => s.steps.implement.model === 'gpt-5.6-terra', {
    what: 'Implement retried with gpt-5.6-terra',
  })
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(fake.requests('thread/start').map((r) => r.params['model'])).toEqual([undefined, 'gpt-5.6-terra'])
  await expect(chip).toHaveText('gpt-5.6-terra')
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})

test('default model: Codex ignores the default sent on turn/start: the card says so, one click pins it', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const first = threadIdNow('dm3a')
  const second = threadIdNow('dm3b')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      review: [{ recording: 'C02-review-shape', text: 'NO FINDINGS' }],
      critic: [{ recording: 'C02-review-shape', text: 'NO FINDINGS' }],
    },
    config: { profile: 'balanced', gates: { afterPlan: false, beforeFix: false } },
    codex: {
      models: ACCOUNT,
      // gpt-5.6-sol is not offered, so turn/start carries gpt-5.6-terra; this CLI runs gpt-5.6-sol all the same.
      edit: failedPass({
        threadId: first,
        turnId: 'turn-dm-ignored',
        model: 'gpt-5.6-sol',
        accountList: ACCOUNT,
        message: refusal('gpt-5.6-sol'),
        codexErrorInfo: 'other',
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')

  const run = await e2e.runFromDashboard(TASK)
  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'model_unavailable')
  expect(fake.requests('turn/start')[0]?.params['model']).toBe('gpt-5.6-terra')
  // The card names the model Codex ran, and its tooltip says the default was asked for and not run.
  const chip = page.getByTestId('model-chip-implement')
  await expect(chip).toHaveText('gpt-5.6-sol')
  await chip.hover()
  await expect(page.getByRole('tooltip')).toContainText(
    "Dim Factory asked for the account's default, gpt-5.6-terra, but Codex ran gpt-5.6-sol, and the account refused it.",
  )
  await page.mouse.move(0, 0)
  const failedSnap = await e2e.snapshot(run.runId)
  expect(failedSnap.steps.implement).toMatchObject({
    modelUsed: 'gpt-5.6-sol',
    modelOverrideIgnored: 'gpt-5.6-terra',
  })
  const fix = snag.getByTestId('patch-implement:account-model')
  await expect(fix).toContainText("Use gpt-5.6-terra (Codex's default for this account)")

  fake.set({
    edit: editPass({
      threadId: second,
      turnId: 'turn-dm-pinned',
      text: 'Added the --version flag.',
      write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
      total: TOTAL,
    }),
  })
  await snag.getByTestId('recovery-implement:account-model').click()
  // The run reads failed until the retry starts: wait for Implement to run with the model the fix put on it.
  await e2e.waitForSnapshot(run.runId, (s) => s.steps.implement.model === 'gpt-5.6-terra', {
    what: 'Implement retried with gpt-5.6-terra',
  })
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  // The pass now names the model, sent on thread/start (which the live runs confirm Codex honours).
  expect(fake.requests('thread/start').map((r) => r.params['model'])).toEqual([undefined, 'gpt-5.6-terra'])
  await expect(chip).toHaveText('gpt-5.6-terra')
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
