// A vibe coder's run with the Brief and Test-first, on the fake Claude with a real node-script check in the
// temp sandbox. The composer's Brief starts collapsed (one line: the detected category); opened, it shows what the
// folder already has (locked chips) and the groups on "Let Dim Factory decide". Choosing Test-first and a quality bar
// shows on the line; the run then goes Plan → gate → Tests (writes a failing test) → Red check (fails, as expected) →
// Implement (makes it pass) → Verify (green) → Clean. The prompts carry the brief; the brief is saved for the folder
// and comes back, and Reset forgets it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { trustCommand, verifyConfig } from './verify-helpers.ts'

const RUN_TESTS = [
  "import { existsSync, readdirSync } from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  "const dir = 'tdd-tests'",
  "const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.test.mjs')) : []",
  'let failed = 0',
  'for (const f of files) {',
  '  try {',
  "    await import(pathToFileURL(dir + '/' + f).href)",
  "    console.log('ok ' + f)",
  '  } catch (e) {',
  '    failed++',
  "    console.error('FAIL ' + f + ': ' + (e instanceof Error ? e.message : String(e)))",
  '  }',
  '}',
  'process.exit(failed > 0 ? 1 : 0)',
].join('\n')

const TEST_FILE = {
  path: 'tdd-tests/version.test.mjs',
  content: [
    "import assert from 'node:assert'",
    "import { readFileSync } from 'node:fs'",
    "let v = ''",
    "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
    "assert.ok(v.includes('1.0.0'), 'expected version 1.0.0')",
    '',
  ].join('\n'),
}
const VERSION = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }
const RUN_ARGV = ['node', 'run-tests.mjs'] as const

test('a vibe coder runs with the Brief and Test-first: red, then green', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: TEST_FILE,
          text: 'Wrote tdd-tests/version.test.mjs',
        },
        { recording: 'C08a-session-id-implement', write: VERSION },
      ],
    },
    config: verifyConfig([{ name: 'tests', run: [...RUN_ARGV] }], {
      gates: { afterPlan: true, beforeFix: false },
    }),
  })
  writeFileSync(join(e2e.sandbox, 'run-tests.mjs'), RUN_TESTS)
  await trustCommand(e2e, RUN_ARGV)

  // ---- the composer: the Brief, collapsed, then opened ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('Build a version constant my app can show, with tests')
  const line = page.getByTestId('brief-line')
  await expect(line).toBeVisible()
  await expect(page.getByTestId('brief-panel')).toHaveCount(0)
  await expect(page.getByTestId('brief-category')).toContainText('Software', { timeout: 30_000 })
  const composer = page.getByTestId('composer')
  /** The summary line's place in the composer (the page may scroll as chips further down are clicked). */
  const linePlace = async (): Promise<{ dy: number; h: number }> => {
    const [l, c] = await Promise.all([line.boundingBox(), composer.boundingBox()])
    return { dy: Math.round((l?.y ?? 0) - (c?.y ?? 0)), h: Math.round(l?.height ?? 0) }
  }
  const before = await linePlace()
  await page.getByTestId('brief-toggle').click()
  const panel = page.getByTestId('brief-panel')
  await expect(panel).toBeVisible()
  // What the folder already has is locked (tsconfig.json: TypeScript).
  await expect(page.getByTestId('brief-fact-language-typescript')).toHaveAttribute('data-locked', 'true')
  await expect(page.getByTestId('brief-option-language-typescript')).toHaveAttribute('aria-disabled', 'true')
  // Every group starts on "Let Dim Factory decide".
  await expect(page.getByTestId('brief-decide-hosting')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('brief-option-approach-walking-skeleton')).toContainText('Guides the plan')
  const testFirst = page.getByTestId('brief-option-approach-test-first')
  await expect(testFirst).toContainText('Adds a Tests step')
  await testFirst.click()
  await expect(testFirst).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('brief-option-quality-accessible').click()
  await expect(page.getByTestId('brief-test-first')).toBeVisible()
  await expect(page.getByTestId('brief-summary')).toContainText('2 choices')
  // The summary line did not move or change height while the brief changed.
  expect(await linePlace()).toEqual(before)

  // ---- Run: Plan → gate → Tests → Red check → Implement → Verify → Clean ----
  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  // The Tests step and its red check are in the timeline from the start.
  await expect(page.getByTestId('timeline-node-tests')).toBeVisible()
  await expect(page.getByTestId('timeline-node-verify:red')).toBeVisible()
  await e2e.approvePlan()
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('clean')
  await expect(page.getByTestId('run-outcome')).toHaveText('Clean: no findings')
  for (const step of ['plan', 'tests', 'verify:red', 'implement', 'verify:1'] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')
  const red = page.getByTestId('pass-card-verify:red')
  await expect(red.getByTestId('red-check-note')).toBeVisible()
  await expect(red.getByTestId('verify-command-verify:red-0')).toHaveAttribute('data-status', 'fail')
  await expect(
    page.getByTestId('pass-card-verify:1').getByTestId('verify-command-verify:1-0'),
  ).toHaveAttribute('data-status', 'pass')
  await expect(page.getByTestId('tests-guard')).toHaveAttribute('data-guard', 'ok')

  // The prompts: the Tests step and Implement got the brief; Implement the failing test.
  const tests = promptSent(e2e, 'implement-1.script.jsonl')
  expect(tests).toContain('You are the Tests step')
  expect(tests).toContain('Accessible (WCAG AA)')
  const impl = promptSent(e2e, 'implement-2.script.jsonl')
  expect(impl).toContain('- tdd-tests/version.test.mjs')
  expect(impl).toContain('- FAIL `node run-tests.mjs`')
  const resolved = JSON.parse(readFileSync(join(e2e.home, 'runs', run.runId, 'resolved.json'), 'utf8')) as {
    brief?: { testFirst?: boolean }
  }
  expect(resolved.brief?.testFirst).toBe(true)

  // ---- back on the Dashboard: the folder's brief comes back; Reset forgets it ----
  await page.keyboard.press('ControlOrMeta+1')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await expect(page.getByTestId('brief-test-first')).toBeVisible({ timeout: 30_000 })
  if ((await page.getByTestId('brief-panel').count()) === 0) await page.getByTestId('brief-toggle').click()
  await expect(page.getByTestId('brief-option-approach-test-first')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('brief-reset').click()
  await expect(page.getByTestId('brief-option-approach-test-first')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('brief-test-first')).toBeHidden()
  expect(e2e.pageErrors).toEqual([])
})
