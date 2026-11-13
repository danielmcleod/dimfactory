// Notifications (attention surfaces, notification events and rules; the done-check flow
// "answer an ask from a desktop notification"). Under DIM_FACTORY_E2E=1 main records desktop notifications instead
// of showing them, and its E2E hooks press their buttons and simulate the window's focus (src/main/e2e.ts):
//   - unfocused: the ask becomes a desktop notification with [Allow once] [Allow for this run] [Deny] (Windows); the
//     tray shows the `-attn` icon and the taskbar overlay "1 needs you" (Dock/launcher badge elsewhere) while it
//     waits; pressing "Allow for this run" answers it through core via 'notification' at once, the panel says
//     "Answered from a notification", and the identical second ask is answered by the run's rule (no notification)
//   - a stale activation (the same toast from Action Center, after it was answered) opens the run and says it was
//     already answered or has expired
//   - focused: the next ask (Fix) is an in-app toast only; no desktop notification is recorded
// Notification buttons are Windows-only here (macOS needs a signed bundle), so that test runs on Windows; the
// second (all OSes) clicks the notification's body, which opens the run where the ask is answered (Linux and
// unsigned macOS say "Open Dim Factory to answer").
import { expect, test } from './harness.ts'
import {
  actOnNotification,
  activateNotification,
  bodiesOf,
  fakeProc,
  nextAsk,
  permissionAnswers,
  recordedNotifications,
  runBodies,
  simulateFocus,
  surfacesOf,
  toasts,
  waitForNotification,
} from './attention-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

test('desktop notifications: answer an ask from a notification', async ({ e2e }) => {
  // Toast buttons are Windows (and signed macOS) only; the next test covers the open-to-answer path everywhere.
  test.skip(process.platform !== 'win32', 'notification buttons need Windows toasts')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      // Two identical `npm --version` asks.
      implement: [{ recording: 'C04a-ask-allow', write: VERSION_WRITE }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      // Fix reuses the session and asks to run a PowerShell command (not covered by the run's rule).
      // It waits a little first, so the checks above see the run with nothing pending.
      resume: [{ recording: 'C03-accept-edits', write: FIX_WRITE, delayMs: 8_000 }],
    },
    config: { gates: { afterPlan: false } },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  await simulateFocus(e2e, false)

  // ---- unfocused: the ask becomes a desktop notification; tray, overlay / badge while it waits ----
  const ask = page.getByTestId('ask-panel')
  const requestId = await nextAsk(page)
  const note = await waitForNotification(e2e, (n) => n.kind === 'ask' && n.requestId === requestId)
  expect(note.runId).toBe(run.runId)
  expect(note.title).toBe('Claude needs approval · ts-small')
  expect(note.body).toMatch(/^Bash: npm --version · (9|10):\d\d left$/)
  expect(note.sticky).toBe(true)
  expect(note.actions).toEqual(['Allow once', 'Allow for this run', 'Deny'])
  const waiting = await e2e.e2eState()
  expect(waiting.windowFocused).toBe(false)
  expect(waiting.notifications).toContainEqual({ title: note.title, body: note.body, actions: note.actions })
  expect(waiting.tray.icon).toMatch(/-attn\.png$/)
  expect(waiting.tray.tooltip).toContain('1 needs you')
  const surfaces = surfacesOf(waiting)
  expect(surfaces.needsYou).toBe(1)
  expect(surfaces.overlay).toBe('overlay-1.png')
  expect(surfaces.overlayDescription).toBe('1 needs you')
  expect(surfaces.flashing).toBe(true)

  // ---- "Allow for this run" from the notification: answered through core, via 'notification' ----
  const answeredAt = Date.now()
  const outcome = await actOnNotification(e2e, note.index, 'Allow for this run')
  expect(outcome).toEqual({ kind: 'answered', runId: run.runId, requestId, decision: 'allow-session' })
  await expect(ask).toBeHidden()
  await expect(page.getByTestId('ask-withdrawn-note')).toHaveText('Answered from a notification')
  await expect(page.getByTestId('allow-rules')).toContainText('npm --version')
  // Back at the window from here on.
  await simulateFocus(e2e, true)
  const before = (await recordedNotifications(e2e)).length
  // The notification is taken down; the overlay and the tray's attention go with the last ask.
  expect((await recordedNotifications(e2e)).find((n) => n.index === note.index)?.closed).toBe(true)
  await expect
    .poll(async () => {
      const st = await e2e.e2eState()
      const a = surfacesOf(st)
      return {
        attn: /-attn\.png$/.test(st.tray.icon),
        needsYou: a.needsYou,
        overlay: a.overlay,
        flash: a.flashing,
      }
    })
    .toEqual({ attn: false, needsYou: 0, overlay: null, flash: false })

  // ---- the identical second ask never reaches the user: the run's rule answers it ----
  await expect.poll(() => permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl')).length).toBe(2)
  const implement = permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))
  expect(implement[0]).toEqual(
    expect.objectContaining({
      behavior: 'allow',
      updatedPermissions: [expect.objectContaining({ destination: 'session' })],
    }),
  )
  expect(implement[1]?.behavior).toBe('allow')
  const resolved = bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved')
  expect(resolved).toContainEqual(
    expect.objectContaining({ requestId, by: 'user', via: 'notification', decision: 'allow-session' }),
  )

  // ---- a stale activation: the same toast's Deny from Action Center, after the answer ----
  // (Activations of one ask within 5 s are one click reported twice; this one comes later.)
  const wait = answeredAt + 5_500 - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  const denyArgs = note.actionArgs[note.actions.indexOf('Deny')]
  expect(denyArgs).toBeDefined()
  expect(await activateNotification(e2e, denyArgs ?? '')).toEqual({
    kind: 'stale',
    runId: run.runId,
    requestId,
  })
  await expect(
    toasts(page).filter({ hasText: 'This question was already answered or has expired.' }),
  ).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
  // Nothing more reached the vendor.
  expect(permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))).toHaveLength(2)

  // ---- focused: Fix's ask is an in-app toast only ----
  const fixAsk = await nextAsk(page, requestId, 120_000)
  await expect(page.getByTestId('timeline-node-fix')).toHaveAttribute('data-status', 'waiting')
  await expect(toasts(page).filter({ hasText: 'Claude needs approval · ts-small' })).toBeVisible()
  expect((await recordedNotifications(e2e)).slice(before).filter((n) => n.kind === 'ask')).toEqual([])
  await ask.focus()
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()

  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  // Still focused: the completion is an in-app toast too.
  await expect(toasts(page).filter({ hasText: /^Completed · Fixed · / })).toBeVisible()
  const after = (await recordedNotifications(e2e)).slice(before)
  expect(after).toEqual([])
  const fixResolved = bodiesOf(await runBodies(e2e, run.runId), 'ask-resolved').find(
    (b) => b.requestId === fixAsk,
  )
  expect(fixResolved).toEqual(expect.objectContaining({ by: 'user', via: 'app', decision: 'allow' }))
  expect(e2e.pageErrors).toEqual([])
})

test('a click on the notification opens the run to answer it', { tag: ['@cross-os'] }, async ({ e2e }) => {
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C03-accept-edits', write: VERSION_WRITE }],
    },
    config: { gates: { afterPlan: false } },
  })
  const run = await e2e.runFromDashboard('add a --version flag')
  await simulateFocus(e2e, false)
  // The user is elsewhere in the app when the ask arrives.
  await page.keyboard.press('ControlOrMeta+1')
  await expect(page).toHaveURL(/#\/$/)

  const note = await waitForNotification(e2e, (n) => n.kind === 'ask' && n.runId === run.runId, 90_000)
  expect(note.title).toBe('Claude needs approval · ts-small')
  // Without notification buttons (Linux, unsigned macOS) the body says how to answer.
  if (note.actions.length === 0) expect(note.body).toContain('Open Dim Factory to answer')
  const surfaces = surfacesOf(await e2e.e2eState())
  expect(surfaces.needsYou).toBe(1)
  if (process.platform === 'win32') expect(surfaces.overlay).toBe('overlay-1.png')
  else expect(surfaces.badge).toBe(1)

  // The body: the window opens on the run, where the ask is answered.
  expect(await actOnNotification(e2e, note.index, 'click')).toEqual({ kind: 'opened', runId: run.runId })
  await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
  await simulateFocus(e2e, true)
  const ask = page.getByTestId('ask-panel')
  await expect(ask).toHaveAttribute('data-request-id', note.requestId ?? '')
  await ask.focus()
  await page.keyboard.press('a')
  await expect(ask).toBeHidden()
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(permissionAnswers(fakeProc(e2e, 'implement-1.script.jsonl'))).toEqual([
    expect.objectContaining({ behavior: 'allow' }),
  ])
  const surfacesAfter = surfacesOf(await e2e.e2eState())
  expect(surfacesAfter.needsYou).toBe(0)
  expect(e2e.pageErrors).toEqual([])
})
