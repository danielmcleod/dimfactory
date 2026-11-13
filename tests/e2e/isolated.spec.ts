// Isolated run (isolated runs; verify results; state-machine rows R2,
// R5, R12): an isolated run chosen in the composer (it says what the run leaves out: the folder's uncommitted change)
// → the PrepareCard makes the isolated copy → depsConsent [Install] trusts the install for the SOURCE folder and runs
// it, its output streamed to the PrepareCard → Implement writes in the isolated copy only → verify:1 fails (a node
// script) → [must] at the gate before Fix → Fix → verify:2 passes → Fixed → the finalize card → [Apply to folder] →
// the folder has the run's files (a changed tracked file and a new one) → Undo restores them byte for byte (sha256).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { CHECK_ARGV, CHECK_COMMAND, findingsOf, trustCommand, version } from './verify-helpers.ts'
import {
  CHECK_SCRIPT,
  INSTALL_SCRIPT,
  card,
  choose,
  commitSandbox,
  hashes,
  isolatedConfig,
  runIsolatedFromDashboard,
  text,
  worktreeOf,
  writeBeforeResult,
} from './isolated-helpers.ts'

/** The tracked file Implement changes, with CRLF line ends and non-ASCII bytes as the user has it. */
const INDEX = 'src/index.ts'
const INDEX_RUN = 'export const greeting = "hello from the run"\n'
const PATHS = [INDEX, 'src/version.ts'] as const

test(
  'isolated: deps consent, failing verify, Fix, verify passes, Apply to folder, Undo restores',
  { tag: '@cross-os' },
  async ({ e2e }) => {
    test.setTimeout(420_000)
    const page = await e2e.start({
      scenario: {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
        resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'Done.\n\nF1 fixed' }],
      },
      editScenario: (sc) => writeBeforeResult(sc, 'implement-1', [{ path: INDEX, content: INDEX_RUN }]),
      config: isolatedConfig({ commands: [CHECK_COMMAND] }, { gates: { afterPlan: true, beforeFix: true } }),
    })
    const folder = e2e.sandbox
    commitSandbox(e2e, {
      'check.mjs': CHECK_SCRIPT,
      'install.mjs': INSTALL_SCRIPT,
      [INDEX]: Buffer.from('export const greeting = "héllo"\r\n// été\r\n', 'utf8'),
    })
    // An uncommitted file: the isolated run leaves it out (it starts from HEAD), and Apply never touches it.
    writeFileSync(join(folder, 'notes.txt'), 'my own notes\n')
    await trustCommand(e2e, CHECK_ARGV)
    const before = hashes(folder, [...PATHS, 'notes.txt'])
    expect(before['src/version.ts']).toBe('absent')

    // ---- the composer: Isolated run, and what it leaves out ----
    const runId = await runIsolatedFromDashboard(e2e, 'add a --version flag', { uncommitted: 1 })

    // ---- Prepare: the isolated copy, then depsConsent ----
    const prep = page.getByTestId('pass-card-prepare')
    await expect(prep).toBeVisible()
    await expect(prep.getByTestId('prepare-step-worktree')).toHaveAttribute('data-status', 'done', {
      timeout: 120_000,
    })
    const consent = await card(page, 'depsConsent')
    await expect(consent).toContainText('node install.mjs')
    await expect(consent.getByTestId('deps-command')).toHaveText('node install.mjs')
    const wt = worktreeOf(e2e, runId)
    expect(existsSync(join(wt, 'install.mjs'))).toBe(true)
    // The uncommitted file stayed behind.
    expect(existsSync(join(wt, 'notes.txt'))).toBe(false)
    await choose(page, 'depsConsent', 'install')
    await expect(prep.getByTestId('prepare-step-deps')).toHaveAttribute('data-status', 'done', {
      timeout: 120_000,
    })
    await expect(prep.getByTestId('prepare-output')).toContainText('installed 3 packages')
    expect(existsSync(join(wt, '.deps', 'installed.txt'))).toBe(true)
    expect(existsSync(join(folder, '.deps'))).toBe(false)
    // [Install] trusted the install for the SOURCE folder (trust.json under the temp home).
    const trust = readFileSync(join(e2e.home, 'trust.json'), 'utf8')
    expect(trust).toMatch(/"kind":\s*"deps"/)

    // ---- Plan's gate, Implement in the copy, verify:1 fails → [must] at the gate before Fix ----
    await e2e.approvePlan()
    const v1 = page.getByTestId('pass-card-verify:1')
    await expect(v1).toHaveAttribute('data-status', 'done', { timeout: 120_000 })
    await expect(v1.getByTestId('verify-command-verify:1-0')).toHaveAttribute('data-status', 'fail')
    const gate = await card(page, 'gate:beforeFix')
    const findings = await findingsOf(e2e, runId)
    expect(findings.map((f) => [f.n, f.severity, f.source])).toEqual([[1, 'must', 'verify']])
    await expect(gate).toContainText('node check.mjs')
    // The folder is untouched while the run works in its copy.
    expect(hashes(folder, [...PATHS, 'notes.txt'])).toEqual(before)
    await gate.getByTestId('card-choice-continue').click()

    // ---- Fix → verify:2 passes → Fixed → the finalize card ----
    const fin = await card(page, 'finalize', 180_000)
    await expect(
      page.getByTestId('pass-card-verify:2').getByTestId('verify-command-verify:2-0'),
    ).toHaveAttribute('data-status', 'pass')
    await expect(fin).toContainText('Apply the run to your folder?')
    await expect(fin).toContainText('changed 2 files there')
    const waiting = await e2e.snapshot(runId)
    expect(waiting.summary.outcome).toBe('fixed')
    expect(waiting.summary.phase).toBe('ready-to-apply')
    expect(hashes(folder, [...PATHS, 'notes.txt'])).toEqual(before)
    expect(text(wt, 'src/version.ts')).toContain('1.0.0')

    // ---- [Apply to folder]: the run's files are in the folder ----
    await choose(page, 'finalize', 'apply')
    const ended = await e2e.waitForEnd(runId, 120_000)
    expect(ended.status, e2e.describeRun(ended)).toBe('completed')
    expect(ended.outcome).toBe('fixed')
    const state = page.getByTestId('finalize-state')
    await expect(state).toHaveAttribute('data-state', 'applied')
    await expect(state).toHaveText('Applied to your folder (2 files).')
    expect(text(folder, 'src/version.ts')).toBe('export const version = "1.0.0"\n')
    expect(text(folder, INDEX)).toBe(INDEX_RUN)
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('my own notes\n')
    await expect(page.getByTestId('run-outcome')).toHaveText('Fixed · 1 must · 0 should')

    // ---- Undo: the folder is byte for byte what it was ----
    await page.getByTestId('finalize-undo-apply').click()
    await expect(state).not.toHaveAttribute('data-state', 'applied', { timeout: 60_000 })
    await expect.poll(() => hashes(folder, [...PATHS, 'notes.txt'])).toEqual(before)
    expect(existsSync(join(folder, 'src/version.ts'))).toBe(false)
    const after = await e2e.snapshot(runId)
    expect(after.summary.worktree).toEqual({ state: 'kept', notApplied: true })

    expect(e2e.pageErrors).toEqual([])
  },
)
