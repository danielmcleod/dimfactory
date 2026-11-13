// "Exec chosen when the schema lacks a required method" (the Codex probe: "Required: initialize,
// thread/start, thread/resume, turn/start, turn/interrupt, … If any is missing → route to exec, with a warning"; the exec
// fallback argv; the mode row "Codex exec (fallback) autoedit: escalations auto-denied, no relay on this route
// (degraded)"; the `pass.<p>.relay` check W "asks auto-denied, not prompted"). The fake Codex's generate-json-schema lacks
// turn/interrupt: the probe picks `codex exec` and says Codex runs without a question relay. The composer warns that
// Implement's and Fix's asks are auto-denied (not blocking), and the run still completes through exec: Implement as
// `codex exec --json … -o <file> -` (the prompt on stdin, never --full-auto/--ephemeral), Review finds issues, and Fix
// resumes the same thread as `exec … resume <id> -`, with the selected findings on stdin.
import { expect, test } from './harness.ts'
import { REVIEW_WITH_FINDINGS } from '../integration/run/scenario.ts'
import { execPass, threadIdNow } from './codex-helpers.ts'

test('exec route: a Codex without a required method runs on exec, with the relay warning, and the run completes', async ({
  e2e,
}) => {
  test.setTimeout(240_000)
  const thread = threadIdNow('exec')
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
    },
    config: { profile: 'balanced', gates: { afterPlan: false, beforeFix: false } },
    codex: {
      schema: 'exec',
      exec: execPass({
        threadId: thread,
        text: 'Added the --version flag.',
        write: { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
        total: { input: 9_000, cached: 4_000, output: 700, reasoning: 200 },
      }),
      execResume: execPass({
        threadId: thread,
        resume: true,
        text: 'Done.\n\nF1 fixed\nF2 fixed\nF3 fixed',
        write: { path: 'src/version.test.ts', content: 'import "./version"\n' },
        total: { input: 21_000, cached: 9_000, output: 1_500, reasoning: 400 },
      }),
    },
  })
  const fake = e2e.codex
  if (fake === null) throw new Error('no fake Codex')
  fake.writeRollout(thread)

  // ---- the probe chose exec, and says so; the composer warns about the relay, without blocking ----
  await expect(page.getByTestId('vendor-health-codex')).toHaveAttribute('data-health', /^(ready|warning)$/, {
    timeout: 30_000,
  })
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('add a --version flag')
  const strip = page.getByTestId('preflight-strip')
  await expect(strip.getByTestId('preflight-summary-text')).toContainText('warning', { timeout: 30_000 })
  await expect(strip.locator('[data-severity="blocking"]')).toHaveCount(0)
  await strip.getByTestId('preflight-details').click()
  const relay = strip.getByTestId('preflight-chip-pass.implement.relay')
  await expect(relay).toHaveAttribute('data-severity', 'warning')
  await expect(relay).toContainText('Implement: asks auto-denied, not prompted')
  await page.screenshot({ path: test.info().outputPath('exec-relay.png') })
  const probe = (await e2e.call('vendors.list')).find((v) => v.vendor === 'codex')?.probe
  expect(probe).toMatchObject({ route: 'exec', transport: 'codex-exec' })
  expect(probe?.checks.find((c) => c.id === 'vendor.codex.protocol')).toMatchObject({
    status: 'warn',
    title: 'Codex runs without a question relay',
  })
  await expect(page.getByTestId('composer-run')).toBeEnabled()

  // ---- the run: Plan (Claude) → Implement (exec) → Review ∥ Critic → Fix (exec resume) → completed ----
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  const end = await e2e.waitForEnd(run.runId)
  expect(end.status, e2e.describeRun(end)).toBe('completed')
  expect(end.outcome).toBe('fixed')
  const snap = await e2e.snapshot(run.runId)
  expect(snap.steps.implement).toMatchObject({ vendor: 'codex', status: 'done', route: 'exec' })
  expect(snap.steps.implement.modeCopy).toMatchObject({ status: 'degraded' })
  expect(snap.steps.fix).toMatchObject({ vendor: 'codex', sessionNote: 'reused the Implement session' })

  // exec argv: flags before `resume`, the prompt on stdin (`-`), never --full-auto / --ephemeral on an edit pass.
  const execs = fake.argvs().filter((a) => a.includes('exec'))
  expect(execs).toHaveLength(2)
  for (const argv of execs) {
    expect(argv.slice(0, 7)).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
    ])
    expect(argv.at(-1)).toBe('-')
    expect(argv).not.toContain('--full-auto')
    expect(argv).not.toContain('--ephemeral')
    expect(argv.join(' ')).not.toContain('add a --version flag')
  }
  expect(execs[1]?.slice(-3)).toEqual(['resume', thread, '-'])
  const prompts = fake.execPrompts()
  expect(prompts[0]).toContain('add a --version flag')
  expect(prompts[1]).toContain('--version prints nothing')
  // No app-server pass ran: only the probe's handshakes.
  expect(fake.requests('thread/start')).toEqual([])
  expect(fake.errors()).toEqual([])
  expect(e2e.pageErrors).toEqual([])
})
