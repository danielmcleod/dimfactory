// Keyboard (keys, accessibility; the first-run script's "The plan gate takes focus →
// Approve … perhaps one ask → A"): full-run.spec.ts's run with the keyboard only. Tab to the composer's folder, type it, Tab to
// the task, ⌘/Ctrl+Enter; the plan gate takes focus (visibly) and ⌘/Ctrl+Enter approves it; Implement's ask takes
// focus, is announced in the assertive live region, and A allows it; the step announcer follows the run to the end;
// `?` opens the keyboard sheet and Escape gives the focus back.
import type { Page } from '@playwright/test'
import { expect, test } from './harness.ts'
import { FIXED_FLOW } from './scenarios.ts'

/** The focused element's data-testid (null when focus is on the body or has no test id). */
function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null)
}

/** Press Tab until the element with `testId` has focus (at most `max` presses). */
async function tabTo(page: Page, testId: string, max = 60): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab')
    if ((await focusedTestId(page)) === testId) return i
  }
  throw new Error(`${max} Tab presses never reached ${testId}`)
}

/** Whether focus is inside the element and the browser shows it (`:focus-visible` on the focused element). */
function focusVisibleWithin(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${CSS.escape(id)}"]`)
    const active = document.activeElement
    return el !== null && active !== null && el.contains(active) && active.matches(':focus-visible')
  }, testId)
}

test('keyboard-only run; the ask is announced to screen readers', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({ scenario: FIXED_FLOW })
  await expect(page.getByTestId('composer')).toBeVisible()

  // ---- the composer, by keyboard ----
  await tabTo(page, 'composer-folder-input')
  await page.keyboard.type(e2e.sandbox)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer-folder-input')).toHaveValue(e2e.sandbox)
  await tabTo(page, 'composer-task')
  await page.keyboard.type('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()

  // ---- the plan gate takes focus, visibly; ⌘/Ctrl+Enter approves ----
  const gate = page.getByTestId('card-gate:afterPlan')
  await expect(gate).toBeVisible({ timeout: 90_000 })
  await expect.poll(() => focusVisibleWithin(page, 'card-gate:afterPlan')).toBe(true)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(gate).toBeHidden()

  // ---- the ask takes focus and is announced; A allows it ----
  const ask = page.getByTestId('ask-panel')
  await expect(ask).toBeVisible({ timeout: 60_000 })
  await expect(ask).toBeFocused()
  expect(await focusVisibleWithin(page, 'ask-panel')).toBe(true)
  const announcer = page.getByTestId('ask-announcer')
  await expect(announcer).toHaveAttribute('aria-live', 'assertive')
  await expect(announcer).toHaveText(
    /^Implement: Claude wants to run a command\. Claude asks to run: PowerShell: New-Item .+\. (9|10) minutes left\.$/,
  )
  // The buttons name their keys for assistive technology.
  await expect(ask.getByTestId('ask-allow')).toHaveAttribute('aria-keyshortcuts', 'A')
  await expect(ask.getByTestId('ask-deny')).toHaveAttribute('aria-keyshortcuts', 'D')
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  await expect(page.getByTestId('run-outcome')).toHaveText('Fixed · 2 must · 1 should')
  const steps = page.getByTestId('step-announcer')
  await expect(steps).toHaveAttribute('aria-live', 'polite')
  // The last announcement says Fix is done. Steps that end within one snapshot refetch (state/runs.ts debounces them,
  // up to 1 s under a steady stream) are announced together in step order, so Review and Critic may come before it
  // where the fake's steps end fast (Linux).
  await expect(steps).toHaveText(/(^|\. )Fix: Done(\.|$)/)

  // ---- `?` opens the keyboard sheet with focus; Escape closes it and gives focus back ----
  await tabTo(page, 'run-tab-flow')
  const back = await focusedTestId(page)
  await page.keyboard.press('Shift+Slash')
  const sheet = page.getByTestId('keyboard-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Answer the focused ask')
  expect(
    await page.evaluate(() => document.activeElement?.closest('[data-testid="keyboard-sheet"]') !== null),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  expect(await focusedTestId(page)).toBe(back)
  expect(e2e.pageErrors).toEqual([])
})
