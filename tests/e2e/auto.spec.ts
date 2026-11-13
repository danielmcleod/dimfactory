// Auto ("Auto (amber + AUTO text everywhere)", "The Log tab shows AUTO approved
// N"; "auto sets Implement and Fix to full and turns the gates off"): a run started with the composer's Auto
// switch. AUTO badges in amber on the Run header, the Dashboard's active card and the Recent row; no plan gate
// (the timeline marks it skipped by Auto); Implement and Fix launch in full mode (`bypassPermissions`). Implement's
// two identical asks: the first is allowed for the run, so core answers the second itself — "AUTO approved 1" in
// the header and the Log tab, from core's count.
import type { Locator } from '@playwright/test'
import { expect, test } from './harness.ts'
import { bodiesOf, fakeProc, fakeProcs, fullMode, nextAsk, runBodies } from './attention-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

/** The badge's text colour is the theme's `--auto` (amber) token. */
async function expectAmber(badge: Locator): Promise<void> {
  await expect(badge).toHaveText('AUTO')
  const [color, auto] = await badge.evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--auto)'
    document.body.append(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return [getComputedStyle(el).color, want]
  })
  expect(auto).not.toBe('')
  expect(color).toBe(auto)
}

test('Auto: amber badges, gates skipped, AUTO approved N', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      resume: [{ recording: 'C08b-resume-fix', write: FIX_WRITE }],
    },
    editScenario: fullMode,
  })

  // ---- the composer: folder, task, the Auto switch (amber, "AUTO"), Run ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const autoSwitch = page.getByTestId('composer-auto')
  await expect(autoSwitch).toHaveAttribute('aria-checked', 'false')
  await autoSwitch.click()
  await expect(autoSwitch).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  expect(run.auto).toBe(true)
  await expect(page.getByTestId('run-view')).toBeVisible()

  // ---- Run view: AUTO in the header; the plan gate is skipped (no card) ----
  await expectAmber(page.getByTestId('run-header').getByTestId('auto-badge'))
  await expect(page.getByTestId('timeline-gate-auto-afterPlan')).toBeVisible()
  await expect(page.getByTestId('timeline-gate-afterPlan')).toHaveCount(0)

  // ---- Implement asks: allowed for the run; the identical second ask is answered by core ----
  const ask = page.getByTestId('ask-panel')
  const first = await nextAsk(page)
  await expect(page.getByTestId('timeline-node-plan')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('card-gate:afterPlan')).toHaveCount(0)

  // The Dashboard meanwhile: the active card carries AUTO too.
  await page.keyboard.press('ControlOrMeta+1')
  const card = page.getByTestId(`active-run-${run.runId}`)
  await expect(card).toBeVisible()
  await expectAmber(card.getByTestId('auto-badge'))
  await card.getByRole('link', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))

  await expect(ask).toHaveAttribute('data-request-id', first)
  await ask.focus()
  await page.keyboard.press('Shift+A')
  await expect(ask).toBeHidden()
  const header = page.getByTestId('run-header')
  await expect(header.getByTestId('auto-approved-count')).toHaveText('AUTO approved 1', { timeout: 60_000 })

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  // No gate card ever opened; Fix ran without one either.
  const bodies = await runBodies(e2e, run.runId)
  expect(bodiesOf(bodies, 'card').filter((b) => b.card.kind.startsWith('gate:'))).toEqual([])
  expect(bodiesOf(bodies, 'auto-answered').filter((b) => b.step === 'implement')).toEqual([
    expect.objectContaining({ decision: 'allow', why: 'allow-cache', tool: 'Bash' }),
  ])
  const snap = await e2e.snapshot(run.runId)
  expect(snap.autoAnswered).toEqual({ approved: 1, denied: 0 })
  // Full mode for the edit passes.
  expect(fakeProc(e2e, 'implement-1.script.jsonl').argv).toContain('bypassPermissions')
  expect(fakeProcs(e2e).filter((p) => p.argv.includes('acceptEdits'))).toEqual([])

  // ---- the Log tab: AUTO and the count ----
  await page.getByRole('tab', { name: 'Log' }).click()
  const log = page.getByTestId('log-tab')
  await expect(log).toBeVisible()
  await expectAmber(log.getByTestId('log-auto-badge'))
  await expect(log.getByTestId('log-auto-approved')).toHaveText('AUTO approved 1')
  await expect(header.getByTestId('auto-approved-count')).toHaveText('AUTO approved 1')

  // ---- Dashboard afterwards: the Recent row carries AUTO ----
  await page.keyboard.press('ControlOrMeta+1')
  const recent = page.getByTestId(`recent-run-${run.runId}`)
  await expect(recent).toBeVisible()
  await expectAmber(recent.getByTestId('auto-badge'))
  expect(e2e.pageErrors).toEqual([])
})
