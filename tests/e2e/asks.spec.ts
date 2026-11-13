// Asks (AttentionPanel; state-machine rows P8–P10, P19): the ask flows in the Run view,
// answered from the keyboard where the panel has focus, with what reached the fake Claude checked in its log:
//   - A allows once; D then Undo within the 3 s grace takes the deny back (nothing denied reaches the vendor); the
//     new ask is announced in the assertive live region
//   - D denies after the 3 s grace (the vendor gets `deny`); ⇧A allows for the run (the vendor gets `allow` with the
//     rule rewritten to the session destination) and the header lists the run's rule
//   - nobody answers: core's clock passes the 10-minute ask timeout (e2e.clock) → the vendor gets deny + interrupt,
//     the step pauses with "Nobody answered in time" → [Allow & resume] resumes the session with the rule in
//     `--allowedTools` (the test lays down the transcript the real CLI would have kept, which canResume checks)
import { expect, test } from './harness.ts'
import {
  ASK_MS,
  advanceClock,
  allowedTools,
  bodiesOf,
  fakeProc,
  nextAsk,
  permissionAnswers,
  runBodies,
  stepSessionId,
  toasts,
  writeTranscript,
} from './attention-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

const NO_PLAN_GATE = { gates: { afterPlan: false } }

test('A allows once; D + Undo within 3 s takes the deny back', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE }],
    },
    config: NO_PLAN_GATE,
  })
  const run = await e2e.runFromDashboard('add a --version flag')

  // ---- the first ask: announced, focused, counting down from 10 minutes ----
  const ask = page.getByTestId('ask-panel')
  const first = await nextAsk(page)
  await expect(ask).toContainText('npm --version')
  await expect(ask).toBeFocused()
  const announcer = page.getByTestId('ask-announcer')
  await expect(announcer).toHaveAttribute('aria-live', 'assertive')
  await expect(announcer).toContainText(
    'Implement: Claude wants to run a command. Claude asks to run: Bash: npm --version',
  )
  await expect(announcer).toContainText(/\b(9|10) minutes left\.$/)
  await expect(page.getByTestId('ask-countdown').getByRole('timer')).toHaveAttribute('aria-label', /left$/)
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'waiting')

  // ---- D → the 3 s grace (panel + toast both offer Undo) → Undo ----
  await page.keyboard.press('d')
  const pending = page.getByTestId('ask-pending-deny')
  await expect(pending).toContainText(/Denied · sent in [1-3] s/)
  await expect(toasts(page).filter({ hasText: 'Denied · Undo' })).toBeVisible()
  await pending.getByTestId('ask-undo').click()
  await expect(ask.getByTestId('ask-allow')).toBeVisible()
  await expect(ask).toHaveAttribute('data-request-id', first)

  // ---- A: allowed once ----
  await ask.focus()
  await page.keyboard.press('a')
  // ---- the identical second ask is raised again (allowed once only) and announced; A again ----
  const second = await nextAsk(page, first)
  await expect(announcer).toContainText('Claude asks to run: Bash: npm --version')
  await expect(ask).toBeFocused()
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')

  // ---- what the vendor got: two allows, never a deny ----
  const answers = permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))
  expect(answers.map((a) => a.behavior)).toEqual(['allow', 'allow'])
  expect(answers.some((a) => a.updatedPermissions !== undefined)).toBe(false)
  const resolved = bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved')
  expect(resolved.map((b) => [b.requestId, b.decision, b.by, b.via])).toEqual([
    [first, 'allow', 'user', 'app'],
    [second, 'allow', 'user', 'app'],
  ])
  expect(e2e.pageErrors).toEqual([])
})

test('D denies after the 3 s grace; ⇧A allows for the run', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      // The first recording of C04b, kept as C04e (the live re-record's model stops after one denied call).
      implement: [{ recording: 'C04e-ask-deny-twice', write: VERSION_WRITE }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      // Fix reuses Implement's session and asks again: allowed for the run.
      resume: [{ recording: 'C04c-ask-allow-session', write: FIX_WRITE }],
    },
    config: NO_PLAN_GATE,
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const ask = page.getByTestId('ask-panel')

  // ---- Implement: D (keyboard) → sent after the grace; the second ask: the Deny button ----
  const first = await nextAsk(page)
  await expect(ask).toBeFocused()
  const pressed = Date.now()
  await page.keyboard.press('d')
  await expect(page.getByTestId('ask-pending-deny')).toBeVisible()
  const second = await nextAsk(page, first, 30_000)
  // The deny waited out its grace before the vendor heard it (and only then asked again).
  expect(Date.now() - pressed).toBeGreaterThanOrEqual(2_500)
  await ask.getByTestId('ask-deny').click()
  // This ask goes; Fix's own ask may already be in its place on a fast machine.
  await expect(page.locator(`[data-testid="ask-panel"][data-request-id="${second}"]`)).toBeHidden({
    timeout: 30_000,
  })
  const denies = permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))
  expect(denies.map((a) => a.behavior)).toEqual(['deny', 'deny'])
  expect(denies.every((a) => a.interrupt !== true)).toBe(true)

  // ---- Fix: ⇧A → allow with the vendor's rule moved to the session destination ----
  const third = await nextAsk(page, second, 120_000)
  await expect(page.getByTestId('timeline-node-fix')).toHaveAttribute('data-status', 'waiting')
  await expect(ask.getByTestId('ask-allow-session')).toHaveAttribute('aria-keyshortcuts', 'Shift+A')
  await ask.focus()
  await page.keyboard.press('Shift+A')
  await expect(ask).toBeHidden()
  await expect(page.getByTestId('allow-rules')).toContainText('Allowed for this run:')
  await expect(page.getByTestId('allow-rules')).toContainText('npm --version')

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  const fix = permissionAnswers(fakeProc(e2e, 'resume-1.script.jsonl'))
  expect(fix).toHaveLength(1)
  expect(fix[0]?.behavior).toBe('allow')
  expect(fix[0]?.updatedPermissions).toEqual([
    expect.objectContaining({ type: 'addRules', behavior: 'allow', destination: 'session' }),
  ])
  const resolved = bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved')
  expect(resolved.map((b) => [b.requestId, b.decision, b.via])).toEqual([
    [first, 'deny', 'app'],
    [second, 'deny', 'app'],
    [third, 'allow-session', 'app'],
  ])
  expect(e2e.pageErrors).toEqual([])
})

test('ask timeout → paused → Allow & resume with the allow rule', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      // The recorded answer is the timeout's deny + interrupt; Implement then resumes its session.
      implement: [{ recording: 'C04d-ask-cancel' }],
      resume: [{ recording: 'C08b-resume-fix', write: VERSION_WRITE, text: 'Done.' }],
    },
    config: NO_PLAN_GATE,
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  const ask = page.getByTestId('ask-panel')
  const requestId = await nextAsk(page)

  // ---- nobody answers: core's clock passes the ask timeout ----
  await advanceClock(e2e, ASK_MS + 1_000)
  const paused = page.getByTestId('paused-implement')
  await expect(paused).toBeVisible()
  await expect(ask).toBeHidden()
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'paused')
  await expect(page.getByTestId('paused-why-implement')).toContainText(
    "Nobody answered Implement's question in time (Bash: npm --version",
  )
  // The polite region says why the ask left the panel.
  await expect(page.getByTestId('ask-withdrawn-note')).toHaveText('Nobody answered in time')
  await expect
    .poll(() => permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl')))
    .toEqual([expect.objectContaining({ behavior: 'deny', interrupt: true })])
  const timedOut = bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved')
  expect(timedOut).toEqual([expect.objectContaining({ requestId, by: 'timeout', decision: 'cancel' })])
  await expect.poll(() => fakeProc(e2e, 'implement-1.script.jsonl').exited, { timeout: 60_000 }).toBe(true)
  // The session the vendor reported (the recording's), which Resume continues.
  const sessionId = stepSessionId(e2e, run.runId, 'implement')
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
  writeTranscript(e2e, sessionId ?? '')

  // ---- Allow & resume: the session resumes with the timed-out request allowed for the run ----
  await page.getByTestId('timeout-allow-resume').click()
  await expect(paused).toBeHidden({ timeout: 60_000 })
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  const snap = await e2e.snapshot(run.runId)
  expect(snap.allowRules).toEqual([
    expect.objectContaining({ vendor: 'claude', kind: 'shell', tool: 'Bash' }),
  ])
  const resumed = fakeProc(e2e, 'resume-1.script.jsonl')
  expect(resumed.argv).toContain(`--resume=${sessionId ?? ''}`)
  expect(allowedTools(resumed.argv)).toContain('Bash(npm --version)')
  // Rules never reach the read-only passes.
  for (const p of ['review-default.script.jsonl', 'critic-default.script.jsonl'])
    expect(allowedTools(fakeProc(e2e, p).argv)).toBeUndefined()
  expect(e2e.pageErrors).toEqual([])
})
