// Unknown failure, the Codex variant ("Unknown snag: Ask AI → config action applied"; failure category unknown "heal (auto if
// enabled) · retry · open_docs"; self-heal: runs on its own for an unknown
// category with selfHeal.enabled, on the selfHeal vendor (Claude), read-only, told the error output and never the task;
// "Parsing" (unsafe suggestions hidden); state-machine row P22). balanced: Codex Implement's app-server dies mid-turn with
// stderr nothing classifies (exit 3). The snag is `unknown` and the diagnosis starts by itself on the fake Claude, whose
// answer is to run Implement on another Codex model, plus one unsafe command Dim Factory hides. The fix's diff is shown;
// applying it records the patch in resolved.json and Implement runs again in a new Codex thread on that model, and the
// run completes. The user's config file is not touched.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { toasts } from './attention-helpers.ts'
import {
  healAnswerScript,
  healMatch,
  healStarts,
  prependScripts,
  promptOf,
  snagCard,
} from './recovery-helpers.ts'
import { editPass, threadIdNow } from './codex-helpers.ts'
import type { Op } from './codex-helpers.ts'

const TASK = 'add a --version flag'
const STDERR = 'codex: zork: the frobnicator is out of phase'
const DIAGNOSIS = 'The default Codex model is failing for this account; another model works.'

test('Codex: an unknown Codex failure is diagnosed on its own; its config fix is applied and Implement retries', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const thread = threadIdNow('e11a')
  const dies: Op[] = [
    {
      op: 'rpcResult',
      id: '$thr',
      result: {
        thread: { id: thread, sessionId: thread, ephemeral: false, status: { type: 'idle' }, turns: [] },
        model: 'gpt-5.6-terra',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
      },
    },
    { op: 'rpcExpect', method: 'turn/start', as: 'turn', params: { threadId: thread } },
    { op: 'rpcResult', id: '$turn', result: { turn: { id: 'turn-e11-a', items: [], status: 'inProgress' } } },
    { op: 'stderr', line: STDERR },
    { op: 'exit', code: 3 },
  ]
  const page = await e2e.start({
    scenario: { plan: { recording: 'C06-plan-native-host' } },
    editScenario: (sc) =>
      prependScripts(sc, [
        {
          name: 'heal-answer',
          match: healMatch(),
          ops: healAnswerScript({
            diagnosis: DIAGNOSIS,
            confidence: 'medium',
            category: 'model_unavailable',
            actions: [
              {
                kind: 'config',
                ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-5.6-sol' }],
                reason: 'Run Implement on gpt-5.6-sol.',
              },
              { kind: 'shell', command: 'rm -rf ~/.codex', reason: 'Unsafe on purpose.' },
            ],
          }),
        },
      ]),
    config: { profile: 'balanced', gates: { afterPlan: false, beforeFix: false } },
    codex: { edit: dies },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  const userConfig = readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')
  const run = await e2e.runFromDashboard(TASK)

  // ---- the snag: unknown, and the diagnosis on its way by itself ----
  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'unknown')
  const diagnosis = snag.getByTestId('snag-heal-implement')
  await expect(diagnosis).toHaveAttribute('data-status', 'ok', { timeout: 120_000 })
  await expect(diagnosis).toContainText(`Diagnosis (AI, medium confidence): ${DIAGNOSIS}`)
  await expect(snag.getByTestId('snag-heal-implement-hidden')).toHaveText(
    'Dim Factory hid 1 unsafe suggestion',
  )
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.implement.failure).toMatchObject({ category: 'unknown' })
  expect(snap.steps.implement.heal).toMatchObject({ status: 'ok', trigger: 'auto', hidden: 1 })

  // The healer: Claude (the selfHeal vendor), one spawn, told Codex's error output and never the task.
  const heals = healStarts(e2e)
  expect(heals).toHaveLength(1)
  const heal = heals[0]
  if (heal === undefined) throw new Error('no heal spawn')
  expect(heal.cwd.toLowerCase()).toBe(join(e2e.home, 'runs', run.runId, 'heal').toLowerCase())
  const prompt = promptOf(e2e, heal.pid)
  expect(prompt).toContain('frobnicator is out of phase')
  expect(prompt).not.toContain(TASK)

  // ---- the fix: its diff; applying it retries Implement on that model ----
  const fix = snag.getByTestId('patch-implement:heal-1')
  const preview = fix.getByTestId('patch-preview-implement:heal-1')
  await expect(preview.locator('[data-kind="add"]')).toHaveText(
    'Added: + passes.implement.model: "gpt-5.6-sol"',
  )
  await expect(page.getByText('rm -rf')).toHaveCount(0)
  fake.set({
    edit: editPass({
      threadId: threadIdNow('e11b'),
      turnId: 'turn-e11-b',
      text: 'Added the --version flag.',
      write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
      total: { input: 9_000, cached: 4_000, output: 700, reasoning: 200 },
    }),
  })
  await fix.getByTestId('recovery-implement:heal-1').click()
  await expect(toasts(page).filter({ hasText: 'Applied. Retrying Implement.' })).toHaveCount(1)
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  expect((await e2e.snapshot(run.runId)).steps.implement).toMatchObject({ status: 'done', attempt: 2 })
  const starts = fake.requests('thread/start')
  expect(starts).toHaveLength(2)
  expect(starts[0]?.params['model']).toBeUndefined()
  expect(starts[1]?.params['model']).toBe('gpt-5.6-sol')
  const resolved = JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'resolved.json'), 'utf8')) as {
    patches?: unknown
  }
  expect(resolved.patches).toEqual([
    expect.objectContaining({
      ops: [{ op: 'replace', path: '/passes/implement/model', value: 'gpt-5.6-sol' }],
      step: 'implement',
    }),
  ])
  expect(readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')).toBe(userConfig)
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
