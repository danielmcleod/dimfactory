// Review (accessibility: an assertive live region for asks; keys; asks.spec.ts, keyboard.spec.ts).
// C04a asks for `npm --version` twice. Each ask is a new node in the assertive region (its data-request-id), counted
// by a MutationObserver in the page, so a screen reader says the second one even where the words repeat (the
// renderer test askGuards.test.tsx pins identical text). A held A (Playwright's repeated keyboard.down sends
// `repeat: true`) answers the shown ask once and never the next one; a new press does.
import { expect, test } from './harness.ts'
import { bodiesOf, fakeProc, nextAsk, permissionAnswers, runBodies } from './attention-helpers.ts'
import { VERSION_WRITE } from './scenarios.ts'

/** What the assertive region says for either of C04a's asks (the detail goes on with the command's description). */
const SAID =
  /^Implement: Claude wants to run a command\. Claude asks to run: Bash: npm --version\b.*\. (9|10) minutes left\.$/

test('a second ask for the same command is announced again; a held A answers once', async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE }],
    },
    config: { gates: { afterPlan: false } },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const ask = page.getByTestId('ask-panel')
  const announcer = page.getByTestId('ask-announcer')

  // ---- the first ask, announced as its own node ----
  const first = await nextAsk(page)
  await expect(ask).toBeFocused()
  await expect(announcer.locator(`[data-request-id="${first}"]`)).toHaveText(SAID)
  // From here on, every node added to the assertive region is recorded.
  await page.evaluate(() => {
    const region = document.querySelector('[data-testid="ask-announcer"]')
    const w = window as unknown as { __announced: string[] }
    w.__announced = []
    if (region === null) return
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement) w.__announced.push(n.dataset['requestId'] ?? '')
    }).observe(region, { childList: true, subtree: true })
  })

  // ---- A held down: the first press answers; its auto-repeats reach nothing ----
  await page.keyboard.down('a')
  const second = await nextAsk(page, first)
  await expect(ask).toBeFocused()
  for (let i = 0; i < 4; i++) await page.keyboard.down('a')
  await page.keyboard.up('a')
  await page.waitForTimeout(1_000)
  await expect(ask).toHaveAttribute('data-request-id', second)
  expect(permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))).toHaveLength(1)

  // ---- the second ask: same words, a new node, so it is said again ----
  await expect(announcer.locator(`[data-request-id="${second}"]`)).toHaveText(SAID)
  await expect(announcer.locator('[data-request-id]')).toHaveCount(1)
  expect(await page.evaluate(() => (window as unknown as { __announced: string[] }).__announced)).toEqual([
    second,
  ])

  // ---- a new press answers it ----
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl')).map((a) => a.behavior)).toEqual([
    'allow',
    'allow',
  ])
  const resolved = bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved')
  expect(resolved.map((b) => [b.requestId, b.decision, b.via])).toEqual([
    [first, 'allow', 'app'],
    [second, 'allow', 'app'],
  ])
  expect(e2e.pageErrors).toEqual([])
})
