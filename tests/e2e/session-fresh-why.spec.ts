// Why Fix started fresh (the flow "understand why Fix started fresh from the card line"; sessions,
// the retry budget; state-machine row R10; failure category resume_failed "fresh (no budget)"): Fix starts a fresh session and its
// card line says why, with a "Why?" that states the rule in one sentence.
//   (a) the user set Fix to Fresh in the composer → the composer and the card use the same words
//       ("Fresh session: set to start fresh") and the same "Why?" ("You chose a fresh session for Fix …");
//       no `--resume` is ever spawned
//   (b) Implement's session cannot be continued:
//       - the CLI rejects the resume at startup (C08c "No conversation found", exit 1) → Fix restarts fresh in the
//         same attempt: "resuming failed", attempt 1, the retry budget unused, no snag
//       - the CLI kept no transcript → canResume says no → "the session cannot be resumed", no `--resume` at all
import type { Page } from '@playwright/test'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import type { ScenarioSpec } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { bodiesOf, fakeProcs, runBodies, stepSessionId } from './attention-helpers.ts'
import { argvSessionId, composeRun, openFixRow, playFirst, storedStep } from './session-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'

const NO_PLAN_GATE = { gates: { afterPlan: false } }

/** Plan → Implement (C08a) → Review finds 2 must + 1 should → a fresh Fix (C03b: an edit session, no asks). */
const FRESH_FIX_FLOW: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  fix: [{ recording: 'C03b-accept-edits-steps', write: FIX_WRITE }],
}

/** The Fix card's session line once the run ended: its words, its reason, and the opened "Why?" sentence. */
async function expectFreshLine(page: Page, words: string, reason: string, why: string): Promise<void> {
  await expect(page.getByTestId('pass-card-fix')).toHaveAttribute('data-status', 'done')
  const line = page.getByTestId('session-line-fix')
  await expect(line).toHaveAttribute('data-session', 'fresh')
  await expect(line).toHaveAttribute('data-reason', reason)
  await expect(page.getByTestId('fix-session-line')).toHaveText(words)
  const toggle = page.getByTestId('session-why-fix-toggle')
  await expect(toggle).toHaveText('Why?')
  await expect(toggle).toHaveAttribute('aria-label', 'Why Fix started a fresh session')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('session-why-fix')).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('session-why-fix')).toHaveText(why)
  // A fresh session has no id to show or copy.
  await expect(page.getByTestId('session-id-fix')).toHaveCount(0)
  await expect(page.getByTestId('session-copy-fix')).toHaveCount(0)
}

/** Fix's `step-status` bodies: status, attempt and the session note core sent. */
async function fixStatuses(
  e2e: Parameters<typeof runBodies>[0],
  runId: string,
): Promise<{ status: string; attempt: number; note: string | undefined }[]> {
  return bodiesOf(await runBodies(e2e, runId), 'step-status')
    .filter((b) => b.step === 'fix')
    .map((b) => ({ status: b.status, attempt: b.attempt, note: b.sessionNote }))
}

test(
  '(a) Fix set to Fresh in the composer: same words and Why on the card',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    const page = await e2e.start({ scenario: FRESH_FIX_FLOW, config: NO_PLAN_GATE })

    // ---- the composer: Fresh session → core's reason, worded as the card will word it ----
    let composerWords = ''
    let composerWhy = ''
    const run = await composeRun(e2e, 'add a --version flag', async (p) => {
      await openFixRow(p)
      await expect(p.getByTestId('fix-session')).toHaveText("Reuse Implement's session")
      await expect(p.getByTestId('fix-session-note')).toContainText("Fix will continue Implement's session")
      await p.getByTestId('fix-session').click()
      await p.getByRole('option', { name: 'Fresh session', exact: true }).click()
      await expect(p.getByTestId('fix-session')).toHaveText('Fresh session')
      await expect(p.getByTestId('pass-summary-fix')).toContainText('Fresh session')
      const reason = p.getByTestId('fix-session-reason')
      await expect(reason).toHaveAttribute('data-reason', 'override-fresh')
      await expect(p.getByTestId('fix-session-reason-text')).toHaveText('Fresh session: set to start fresh')
      const toggle = p.getByTestId('fix-session-reason-why-toggle')
      await expect(toggle).toHaveAttribute('aria-label', 'Why Fix starts a fresh session')
      await toggle.click()
      await expect(p.getByTestId('fix-session-reason-why')).toHaveText(
        "You chose a fresh session for Fix instead of continuing Implement's.",
      )
      // core's pass.fix.resume (live preflight) agrees; the note adds its detail without repeating the reason line.
      const note = p.getByTestId('fix-session-note')
      await expect(note).toContainText('it gets the task, the plan and the changes')
      await expect(note).not.toContainText('Fix will start fresh')
      composerWords = (await p.getByTestId('fix-session-reason-text').textContent()) ?? ''
      composerWhy = (await p.getByTestId('fix-session-reason-why').textContent()) ?? ''
    })

    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('fixed')

    // ---- the card: the composer's words and Why, after the fact ----
    await expectFreshLine(
      page,
      'Fresh session: set to start fresh',
      'override-fresh',
      "You chose a fresh session for Fix instead of continuing Implement's.",
    )
    expect(await page.getByTestId('fix-session-line').textContent()).toBe(composerWords)
    expect(await page.getByTestId('session-why-fix').textContent()).toBe(composerWhy)

    // ---- the vendor: no --resume ever; Fix ran in its own new session ----
    const procs = fakeProcs(e2e)
    expect(procs.some((p) => p.argv.some((a) => a.startsWith('--resume')))).toBe(false)
    const fix = procs.find((p) => p.script === 'fix-1.script.jsonl')
    expect(fix, 'the fresh Fix spawn').toBeDefined()
    const implId = stepSessionId(e2e, run.runId, 'implement')
    expect(argvSessionId(fix?.argv ?? [])).toMatch(/^[0-9a-f-]{36}$/)
    expect(argvSessionId(fix?.argv ?? [])).not.toBe(implId)
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.fix).toMatchObject({ attempt: 1, sessionNote: 'fresh session: set to start fresh' })
    expect(e2e.pageErrors).toEqual([])
  },
)

test(
  '(b) the CLI rejects the resume: fresh in the same attempt, no retry used, Why says so',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    const page = await e2e.start({
      scenario: FRESH_FIX_FLOW,
      config: NO_PLAN_GATE,
      // The first `--resume=<id>` answers as C08c did: "No conversation found with session ID", exit 1.
      editScenario: (sc) => playFirst(sc, ['-p', '--resume=*'], 'C08c-resume-bogus'),
    })
    const run = await e2e.runFromDashboard('add a --version flag')
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('fixed')

    // ---- the vendor: one rejected resume of Implement's session, then a fresh edit session ----
    const implId = stepSessionId(e2e, run.runId, 'implement') ?? ''
    const edits = fakeProcs(e2e).filter((p) => p.argv.includes('acceptEdits'))
    expect(edits.map((p) => p.script)).toEqual([
      'implement-1.script.jsonl',
      'recording.jsonl',
      'fix-1.script.jsonl',
    ])
    expect(edits[1]?.argv).toContain(`--resume=${implId}`)
    expect(edits[2]?.argv.some((a) => a.startsWith('--resume'))).toBe(false)
    expect(argvSessionId(edits[2]?.argv ?? [])).toMatch(/^[0-9a-f-]{36}$/)

    // ---- the snapshot: still attempt 1, the retry budget unused, no snag ----
    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      sessionNote: 'fresh session: resuming failed',
    })
    expect(snap.steps.fix.failure).toBeUndefined()
    expect(storedStep(e2e, run.runId, 'fix')).toMatchObject({ attempt: 1, autoRetryUsed: false })
    const statuses = await fixStatuses(e2e, run.runId)
    expect(statuses.every((s) => s.attempt === 1)).toBe(true)
    expect(statuses).toContainEqual({ status: 'running', attempt: 1, note: 'reused the Implement session' })
    expect(statuses).toContainEqual({ status: 'running', attempt: 1, note: 'fresh session: resuming failed' })
    expect(statuses.some((s) => s.status === 'failed')).toBe(false)
    expect(bodiesOf(await runBodies(e2e, run.runId), 'snag')).toEqual([])

    // ---- the card: no attempt chip, no snag; the line says why, and Why says the retry was not used ----
    const card = page.getByTestId('pass-card-fix')
    await expect(card).not.toContainText(/attempt \d/)
    await expect(page.getByTestId('snag-fix')).toHaveCount(0)
    await expectFreshLine(
      page,
      'Fresh session: resuming failed',
      'resume-failed',
      'Claude rejected the session; Fix started fresh. This did not use the retry.',
    )
    expect(e2e.pageErrors).toEqual([])
  },
)

test(
  '(b) no transcript to resume: fresh without trying --resume, Why says so',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    const page = await e2e.start({
      scenario: FRESH_FIX_FLOW,
      config: NO_PLAN_GATE,
      // The fake keeps no session transcript (as if the CLI cleaned it up), so canResume answers no.
      editScenario: (sc) => {
        sc.env['FAKE_CLI_CLAUDE_TRANSCRIPTS'] = '0'
      },
    })
    const run = await e2e.runFromDashboard('add a --version flag')
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('fixed')

    expect(stepSessionId(e2e, run.runId, 'implement')).toMatch(/^[0-9a-f-]{36}$/)
    const procs = fakeProcs(e2e)
    expect(procs.some((p) => p.argv.some((a) => a.startsWith('--resume')))).toBe(false)
    expect(procs.filter((p) => p.argv.includes('acceptEdits')).map((p) => p.script)).toEqual([
      'implement-1.script.jsonl',
      'fix-1.script.jsonl',
    ])

    const snap = await e2e.snapshot(run.runId)
    expect(snap.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      sessionNote: 'fresh session: the session cannot be resumed',
    })
    expect(storedStep(e2e, run.runId, 'fix')).toMatchObject({ attempt: 1, autoRetryUsed: false })
    const statuses = await fixStatuses(e2e, run.runId)
    expect(statuses.every((s) => s.attempt === 1)).toBe(true)
    expect(statuses.some((s) => s.note === 'reused the Implement session')).toBe(false)

    await expect(page.getByTestId('pass-card-fix')).not.toContainText(/attempt \d/)
    await expectFreshLine(
      page,
      'Fresh session: the session cannot be resumed',
      'cannot-resume',
      "Claude no longer has Implement's conversation (it may have been cleaned up).",
    )
    expect(e2e.pageErrors).toEqual([])
  },
)
