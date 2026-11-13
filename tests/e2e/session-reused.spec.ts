// A reused session ("Reused Implement session" in E2E, C08 replay `--resume=` + delta; sessions,
// usage; state-machine row R10; the pass.fix.resume check): a full Claude-only run from the Dashboard whose Fix continues
// Implement's session.
//   - before the run, the composer's Fix row says Reuse and core's pass.fix.resume says Fix will continue the session
//   - Implement (C08a) starts its session with `--session-id`; Fix (C08b) is spawned with `--resume=<Implement's id>`
//     and no `--session-id`, after canResume found the transcript the CLI keeps
//   - the Fix card reads "Session: reused the Implement session", shows the id (short, full on hover) and copies it
//   - Fix's usage is the delta of C08b's cumulative totals over C08a's (the adapter subtracts; the engine never does)
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import type { ScenarioSpec } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import { clipboardText, keepingClipboard } from './dashboard-helpers.ts'
import { fakeProc, fakeProcs, stepSessionId } from './attention-helpers.ts'
import {
  argvSessionId,
  composeRun,
  cumulativeUsage,
  openFixRow,
  recordedSessionId,
  storedStep,
} from './session-helpers.ts'
import { FIX_WRITE, VERSION_WRITE } from './scenarios.ts'

/** Plan → Implement (C08a, no asks) → Review finds 2 must + 1 should → Fix resumes the session (C08b). */
const REUSED_FLOW: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: VERSION_WRITE }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  resume: [{ recording: 'C08b-resume-fix', write: FIX_WRITE }],
}

test(
  'Fix continues Implement’s session: card line, --resume=<id>, usage delta',
  { tag: ['@cross-os'] },
  async ({ e2e }) => {
    const page = await e2e.start({ scenario: REUSED_FLOW })

    // ---- the composer: Reuse, and core's word that Fix will continue Implement's session ----
    const run = await composeRun(e2e, 'add a --version flag', async (p) => {
      await openFixRow(p)
      await expect(p.getByTestId('fix-session')).toHaveText("Reuse Implement's session")
      await expect(p.getByTestId('fix-session-reason')).toHaveCount(0)
      await expect(p.getByTestId('fix-session-note')).toContainText("Fix will continue Implement's session")
    })
    await e2e.approvePlan()
    const ended = await e2e.waitForEnd(run.runId)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('fixed')

    // ---- the session: Implement reported C08a's id; the fake kept its transcript; Fix resumed it ----
    const implId = stepSessionId(e2e, run.runId, 'implement') ?? ''
    expect(implId).toBe(recordedSessionId('C08a-session-id-implement'))
    const implement = fakeProc(e2e, 'implement-1.script.jsonl')
    expect(argvSessionId(implement.argv)).toMatch(/^[0-9a-f-]{36}$/)
    expect(implement.argv.some((a) => a.startsWith('--resume'))).toBe(false)
    const fix = fakeProc(e2e, 'resume-1.script.jsonl')
    expect(fix.argv).toContain(`--resume=${implId}`)
    expect(argvSessionId(fix.argv)).toBeUndefined()
    expect(fix.argv).toContain('acceptEdits')
    // One resumed spawn, and no fresh Fix besides it.
    const procs = fakeProcs(e2e)
    expect(procs.filter((p) => p.argv.some((a) => a.startsWith('--resume')))).toHaveLength(1)
    expect(procs.filter((p) => p.argv.includes('acceptEdits'))).toHaveLength(2)

    // ---- the Fix card: the session line, the id and its copy button ----
    const card = page.getByTestId('pass-card-fix')
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId('fix-session-line')).toHaveText('Session: reused the Implement session')
    await expect(page.getByTestId('session-line-fix')).toHaveAttribute('data-session', 'reused')
    const shortId = page.getByTestId('session-id-fix')
    await expect(shortId).toHaveText(implId.slice(0, 8))
    await expect(shortId).toHaveAttribute('title', implId)
    await expect(page.getByTestId('session-why-fix-toggle')).toHaveCount(0)
    await expect(card).not.toContainText(/attempt \d/)
    await keepingClipboard(e2e, async () => {
      await page.getByTestId('session-copy-fix').click()
      await expect(page.getByText('Session id copied to the clipboard')).toBeVisible()
      expect(await clipboardText(e2e)).toBe(implId)
    })

    // ---- usage: Fix's own delta over Implement's cumulative totals ----
    const a = cumulativeUsage('C08a-session-id-implement')
    const b = cumulativeUsage('C08b-resume-fix')
    const snap = await e2e.snapshot(run.runId)
    const fixView = snap.steps.fix
    expect(fixView).toMatchObject({ status: 'done', attempt: 1, sessionNote: 'reused the Implement session' })
    expect(fixView.usage).toMatchObject({
      input: b.input - a.input,
      output: b.output - a.output,
      cacheRead: (b.cacheRead ?? 0) - (a.cacheRead ?? 0),
      cacheWrite: (b.cacheWrite ?? 0) - (a.cacheWrite ?? 0),
    })
    expect(fixView.usage?.costUsd).toBeCloseTo((b.costUsd ?? 0) - (a.costUsd ?? 0), 9)
    expect(fixView.usageApprox).toBeUndefined()
    expect(snap.steps.implement.usage).toMatchObject({ input: a.input, output: a.output })
    expect(storedStep(e2e, run.runId, 'fix')).toMatchObject({ attempt: 1, autoRetryUsed: false })

    expect(e2e.pageErrors).toEqual([])
  },
)
