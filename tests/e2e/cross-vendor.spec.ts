// Cross-vendor balanced ("Cross-vendor balanced: Review‖Critic side by side; untick a should; Fix stdin has
// only the selected findings; Fix resumes the Codex thread"; "balanced end to end from the Dashboard … Claude
// native Plan · Codex Implement · Review‖Critic · Fix resumes the Codex thread, with statuses/ETA/cost on every card";
// Codex: one private app-server per pass, the thread id persisted before turn/start, approvals → accept, resume
// {threadId, excludeTurns:true} with the echoed id; sessions: "Fix resumes the Codex thread"). From the Dashboard,
// balanced runs with the fake Claude and the fake Codex: Claude's native Plan → the plan gate → Codex Implement asks to
// run a command (allowed once, `accept` on the wire) → Review (2 must + 1 should) ∥ Critic (none), side by side → the gate
// before Fix, where the should is unticked → Codex Fix resumes Implement's thread (thread/resume of that id, echoed) and
// its turn carries only the two selected findings → completed, Fixed. Every card has its status, its ETA (core's
// per-step estimate; the counting line while a pass runs) and its cost; the Fix card names the Codex thread it
// continued. No prompt ever travels in argv.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { CODEX_MODELS, editPass, resumePass, threadIdNow } from './codex-helpers.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'

const TASK = 'add a --version flag'
const STEPS = ['plan', 'implement', 'review', 'critic', 'fix'] as const

test('cross-vendor balanced from the Dashboard: Claude Plan, Codex Implement, Review ∥ Critic, Fix resumes the Codex thread', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const thread = threadIdNow('e06')
  const implementTotal = { input: 24_576, cached: 16_384, output: 1_450, reasoning: 512 }
  const fixTotal = { input: 55_296, cached: 40_960, output: 2_430, reasoning: 896 }
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      // Both reviewers take a moment, so they visibly run together.
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS, delayMs: 2_500 }],
      critic: [{ recording: 'C02-review-shape', text: 'NO FINDINGS', delayMs: 2_500 }],
    },
    config: { profile: 'balanced', gates: { afterPlan: true, beforeFix: true } },
    codex: {
      models: CODEX_MODELS,
      edit: editPass({
        threadId: thread,
        turnId: 'turn-e06-implement',
        text: 'Added the --version flag. Tests pass.',
        approval: { command: 'npm test', reason: 'Run the test suite' },
        write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        total: implementTotal,
        delayMs: 1_500,
      }),
      resume: {
        threadId: thread,
        ops: resumePass({
          threadId: thread,
          turnId: 'turn-e06-fix',
          text: 'Done.\n\nF1 fixed\nF2 fixed',
          write: { path: 'src/version.test.ts', content: 'import "./version"\n' },
          restored: implementTotal,
          total: fixTotal,
          delayMs: 3_000,
        }),
      },
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  // Codex keeps a rollout for the thread it starts (canResume looks for it; the fake runs no model).
  fake.writeRollout(thread)

  // ---- the Dashboard: balanced puts Implement on Codex ----
  await expect(page.getByTestId('composer-profile')).toHaveText('balanced')
  const run = await e2e.runFromDashboard(TASK)
  await expect(page.getByTestId('pass-card-plan')).toContainText('Claude')

  // ---- Claude's native Plan, then the gate ----
  await e2e.approvePlan()

  // ---- Codex Implement asks to run a command: allowed once ----
  const ask = page.getByTestId('ask-panel')
  await expect(ask).toBeVisible({ timeout: 90_000 })
  await expect(ask).toContainText('npm test')
  const implement = page.getByTestId('pass-card-implement')
  await expect(implement).toHaveAttribute('data-status', 'waiting')
  await expect(implement).toContainText('Codex')
  await expect(page.getByTestId('timeline-node-implement')).toHaveAttribute('data-status', 'waiting')
  // The ask came from the one turn of the one thread, and the thread id is on disk (run.json) while that turn runs
  // (session id persistence; that it was written before turn/start went out is proven in
  // tests/integration/balanced/engine/balanced-real-adapter.test.ts, which reads run.json from inside the adapter's wait).
  const atAsk = await e2e.snapshot(run.runId)
  expect(atAsk.steps.implement).toMatchObject({ vendor: 'codex', status: 'waiting' })
  expect(fake.requests('thread/start')).toHaveLength(1)
  expect(fake.requests('turn/start')).toHaveLength(1)
  const onDiskAtAsk = (
    JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'run.json'), 'utf8')) as {
      state: { steps: Record<string, { sessionId?: string }> }
    }
  ).state
  expect(onDiskAtAsk.steps['implement']?.sessionId).toBe(thread)
  await ask.getByTestId('ask-allow').click()
  await expect(ask).toBeHidden()

  // ---- Review ∥ Critic, side by side ----
  const gate = page.getByTestId('card-gate:beforeFix')
  await expect(gate).toBeVisible({ timeout: 120_000 })
  const atGate = await e2e.snapshot(run.runId)
  const review = atGate.steps.review
  const critic = atGate.steps.critic
  expect(review.status).toBe('done')
  expect(critic.status).toBe('done')
  // They ran at the same time: each started before the other ended.
  expect(review.startedAt ?? Infinity).toBeLessThan(critic.endedAt ?? 0)
  expect(critic.startedAt ?? Infinity).toBeLessThan(review.endedAt ?? 0)
  const reviewBox = await page.getByTestId('pass-card-review').boundingBox()
  const criticBox = await page.getByTestId('pass-card-critic').boundingBox()
  expect(reviewBox).not.toBeNull()
  expect(criticBox).not.toBeNull()
  expect(Math.abs((reviewBox?.y ?? 0) - (criticBox?.y ?? 1))).toBeLessThan(2)
  expect((criticBox?.x ?? 0) - (reviewBox?.x ?? 0)).toBeGreaterThan(100)

  // ---- the gate before Fix: untick the should; Fix receives the two musts ----
  const findings = gate.locator('li[data-severity]')
  await expect(findings).toHaveCount(3)
  const should = gate.locator('li[data-severity="should"]')
  await expect(should).toContainText('Unused import')
  await should.getByRole('checkbox').click()
  await expect(gate.getByTestId('fix-receives')).toHaveText('Fix will receive 2 must · 0 should')
  await gate.getByTestId('card-choice-continue').click()
  await expect(gate).toBeHidden()

  // ---- Fix on Codex: it resumes Implement's thread; its card counts against the ETA while it runs ----
  await expect(page.getByTestId('pass-card-fix')).toHaveAttribute('data-status', 'running', {
    timeout: 60_000,
  })
  await expect(page.getByTestId('pass-time-fix')).toHaveText(/^\d+:\d\d \/ ~\d+ min$/)
  const ended = await e2e.waitForEnd(run.runId)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')

  // The fake saw thread/resume of Implement's thread (echoed), with the edit pass's safety set again.
  expect(fake.errors()).toEqual([])
  const resumes = fake.requests('thread/resume')
  expect(resumes).toHaveLength(1)
  expect(resumes[0]?.params).toMatchObject({
    threadId: thread,
    excludeTurns: true,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  })
  expect(fake.requests('thread/start')).toHaveLength(1)
  // Fix's turn carries the selected findings only.
  const turns = fake.turnTexts()
  expect(turns).toHaveLength(2)
  const fixTurn = turns[1] ?? ''
  expect(fixTurn).toContain('--version prints nothing')
  expect(fixTurn).toContain('No test covers --version')
  expect(fixTurn).not.toContain('Unused import')
  expect(turns[0]).toContain(TASK)
  // The command approval was answered `accept` (the fake checked the reply), never an execpolicy amendment.
  const replies = fake.messages().filter((m) => m.msg['id'] === 0 && 'result' in m.msg)
  expect(replies.map((m) => m.msg['result'])).toEqual([{ decision: 'accept' }])
  // Every Codex process is a private app-server: the prompt never travels in argv.
  for (const argv of fake.argvs().filter((a) => a.includes('--listen'))) {
    expect(argv).toEqual(['app-server', '--listen', 'stdio://'])
  }

  // ---- the Run view: statuses, ETA and cost on every card; Fix names the thread it continued ----
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.implement).toMatchObject({ vendor: 'codex', status: 'done' })
  expect(snap.steps.fix).toMatchObject({
    vendor: 'codex',
    sessionNote: 'reused the Implement session',
    status: 'done',
  })
  // run.json keeps the thread both passes ran in.
  const state = (
    JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'run.json'), 'utf8')) as {
      state: { steps: Record<string, { sessionId?: string }> }
    }
  ).state
  expect(state.steps['implement']?.sessionId).toBe(thread)
  expect(state.steps['fix']?.sessionId).toBe(thread)
  // Fix's own usage: the delta against Implement's cumulative totals.
  expect(snap.steps.fix.usage?.output).toBe(fixTotal.output - implementTotal.output)
  for (const step of STEPS) {
    const s = snap.steps[step]
    expect(s.status, step).toBe('done')
    expect(s.eta?.p50 ?? 0, `${step} ETA`).toBeGreaterThan(0)
    expect(s.cost?.usd ?? null, `${step} cost`).not.toBeNull()
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')
    const card = page.getByTestId(`pass-card-${step}`)
    await expect(card).toHaveAttribute('data-status', 'done')
    await expect(page.getByTestId(`pass-metrics-${step}`)).toContainText('$')
  }
  for (const step of ['implement', 'fix'] as const)
    await expect(page.getByTestId(`pass-card-${step}`)).toContainText('Codex')
  for (const step of ['plan', 'review', 'critic'] as const)
    await expect(page.getByTestId(`pass-card-${step}`)).toContainText('Claude')
  await expect(page.getByTestId('fix-session-line')).toContainText('Implement session')
  await expect(page.getByTestId('session-kind-fix')).toHaveText('Codex thread')
  await expect(page.getByTestId('session-id-fix')).toContainText(thread.slice(0, 8))
  await expect(page.getByTestId('run-outcome')).toHaveText('Fixed · 2 must · 1 should')
  await expect(page.getByTestId('summary-files')).toHaveText('2 files +2 −0')
  expect(e2e.pageErrors).toEqual([])
})
