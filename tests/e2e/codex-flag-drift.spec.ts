// Flag drift, the Codex variant ("flag_drift snag: flagMap patch diff shown → apply → retry"; failure category flag_drift
// "X exit 2 `unexpected argument` · heal (→ flagMap config_patch)";
// "flagMap (user-only; heal-patchable) renames a managed flag when building argv"; the exec fallback argv). The fake
// Codex's app-server lacks a required method (turn/interrupt), so Implement runs on the exec route; that CLI no longer
// knows `--color` ("error: unexpected argument '--color' found", exit 2). The snag reads "Codex CLI rejected a flag"
// with [Find the renamed flag] first. Asking runs the healer on the fake Claude (read-only, told the error output, never
// the task); its fix maps `--color` to `--colour` in vendors.codex.flagMap, shown as a diff before anything is applied.
// [Apply to this run] records the patch in resolved.json and retries Implement, whose exec argv carries `--colour`
// where `--color` was; it succeeds and the run completes. The user's config file is not touched.
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
import { execPass, threadIdNow } from './codex-helpers.ts'

const TASK = 'add a --version flag'
const DIAGNOSIS = 'This Codex renamed --color to --colour.'

test('Codex: exec rejects a renamed flag; the AI maps it, the diff is shown, apply, and Implement retries', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: { plan: { recording: 'C06-plan-native-host' } },
    editScenario: (sc) =>
      prependScripts(sc, [
        {
          name: 'heal-answer',
          match: healMatch(),
          ops: healAnswerScript({
            diagnosis: DIAGNOSIS,
            confidence: 'high',
            category: 'flag_drift',
            actions: [
              {
                kind: 'config',
                ops: [{ op: 'add', path: '/vendors/codex/flagMap/--color', value: '--colour' }],
                reason: 'Map the renamed flag.',
              },
            ],
          }),
        },
      ]),
    config: { profile: 'balanced', gates: { afterPlan: false, beforeFix: false } },
    codex: {
      schema: 'exec',
      execBy: [
        {
          name: 'old-flag',
          argvIncludes: ['--color'],
          ops: [
            { op: 'readToEof', timeoutMs: 30_000 },
            { op: 'stderr', line: "error: unexpected argument '--color' found" },
            { op: 'stderr', line: '' },
            { op: 'stderr', line: "  tip: a similar argument exists: '--colour'" },
            { op: 'exit', code: 2 },
          ],
        },
      ],
      exec: execPass({
        threadId: threadIdNow('e09'),
        text: 'Added the --version flag.',
        write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        total: { input: 9_000, cached: 4_000, output: 700, reasoning: 200 },
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  const userConfig = readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')
  const run = await e2e.runFromDashboard(TASK)

  // ---- the snag: a rejected flag, the AI offered first, nothing diagnosed on its own ----
  const snag = snagCard(page, 'implement')
  await expect(snag).toBeVisible({ timeout: 90_000 })
  await expect(snag).toHaveAttribute('data-category', 'flag_drift')
  await expect(snag).toContainText('Codex CLI rejected a flag')
  const ask = snag.getByTestId('recovery-implement:heal')
  await expect(ask).toHaveText('Find the renamed flag')
  await expect(snag.locator('[data-testid^="recovery-"]').first()).toHaveAttribute(
    'data-testid',
    'recovery-implement:heal',
  )
  expect(healStarts(e2e)).toEqual([])

  // ---- Ask the AI: the diagnosis and its fix, as a diff ----
  await ask.click()
  const diagnosis = snag.getByTestId('snag-heal-implement')
  await expect(diagnosis).toHaveAttribute('data-status', 'ok', { timeout: 120_000 })
  await expect(diagnosis).toContainText(`Diagnosis (AI, high confidence): ${DIAGNOSIS}`)
  const heal = healStarts(e2e)[0]
  if (heal === undefined) throw new Error('no heal spawn')
  const prompt = promptOf(e2e, heal.pid)
  expect(prompt).toContain("error: unexpected argument '--color' found")
  expect(prompt).not.toContain(TASK)
  const fix = snag.getByTestId('patch-implement:heal-1')
  await expect(fix.getByTestId('patch-preview-implement:heal-1').locator('[data-kind="add"]')).toHaveText(
    'Added: + vendors.codex.flagMap.--color: "--colour"',
  )
  await expect(fix.getByTestId('recovery-implement:heal-1')).toHaveText('Apply to this run')

  // ---- apply to this run → Implement retries with the renamed flag and succeeds ----
  await fix.getByTestId('recovery-implement:heal-1').click()
  await expect(toasts(page).filter({ hasText: 'Applied. Retrying Implement.' })).toHaveCount(1)
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  expect((await e2e.snapshot(run.runId)).steps.implement).toMatchObject({ status: 'done', attempt: 2 })
  const execs = fake.argvs().filter((a) => a.includes('exec'))
  expect(execs).toHaveLength(2)
  expect(execs[0]).toContain('--color')
  expect(execs[1]).not.toContain('--color')
  expect(execs[1]?.[(execs[1]?.indexOf('--colour') ?? -2) + 1]).toBe('never')
  const resolved = JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'resolved.json'), 'utf8')) as {
    patches?: unknown
  }
  expect(resolved.patches).toEqual([
    expect.objectContaining({
      ops: [{ op: 'add', path: '/vendors/codex/flagMap/--color', value: '--colour' }],
      source: 'recovery',
      step: 'implement',
    }),
  ])
  expect(readFileSync(join(e2e.home, 'dimfactory.json'), 'utf8')).toBe(userConfig)
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
