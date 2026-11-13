// Helpers shared by the Verify E2E specs (the Verify step, VerifyCard and the trust / verifyEnv cards):
// real node-script verify commands written into the run's temp sandbox, the fake Claude
// passes that make them fail or pass (Implement writes version 0.1.0, Fix 1.0.0 or 0.2.0), and trust grants written
// through the app's own trust.set (trust.json under the temp DIM_FACTORY_HOME, never the real ~/.dimfactory).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import type { FindingsFile } from '../../src/shared/findings.ts'
import type { ScenarioSpec } from '../integration/run/scenario.ts'
import { expect } from './harness.ts'
import type { E2EHarness } from './harness.ts'

/** Passes when src/version.ts names 1.0.0; otherwise prints what it found and fails (exit 1). */
export const CHECK_SCRIPT = [
  "import { readFileSync } from 'node:fs'",
  "let v = ''",
  "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
  "if (v.includes('1.0.0')) { console.log('version ok'); process.exit(0) }",
  "console.log('checking src/version.ts')",
  "console.error('expected version 1.0.0, got ' + (v.trim() || 'nothing'))",
  'process.exit(1)',
].join('\n')

/**
 * A command that keeps the round running and its output growing: 150 lines at once (more than the output pane shows),
 * then a line every 100 ms until the file named by its first argument exists (the test writes it, outside the
 * project, so the round changes no project file); then it passes.
 */
export const CHATTY_SCRIPT = [
  "import { existsSync } from 'node:fs'",
  'const release = process.argv[2] ?? ""',
  'let n = 0',
  "const line = () => console.log('chatty line ' + ++n + ': checked module ' + (n % 17) + ' of 17')",
  'for (let i = 0; i < 150; i++) line()',
  'const t = setInterval(() => {',
  '  line()',
  "  if (existsSync(release)) { clearInterval(t); console.log('chatty done'); process.exit(0) }",
  '}, 100)',
].join('\n')

/** CHATTY_SCRIPT's argv for this test (its release file in the test's temp root, outside the project). */
export function chattyArgv(e2e: E2EHarness): string[] {
  return ['node', 'chatty.mjs', join(e2e.root, 'verify-release.txt')]
}

/** Let CHATTY_SCRIPT finish. */
export function releaseChatty(e2e: E2EHarness): void {
  writeFileSync(join(e2e.root, 'verify-release.txt'), 'done\n')
}

/** The verify command the specs configure: `node check.mjs` in the project folder. */
export const CHECK_ARGV = ['node', 'check.mjs'] as const
export const CHECK_COMMAND = { name: 'check', run: [...CHECK_ARGV] }

export const version = (v: string): { path: string; content: string } => ({
  path: 'src/version.ts',
  content: `export const version = "${v}"\n`,
})

/** Plan → Implement writes version 0.1.0 (the check fails) → clean reviewers → Fix (Implement's session) writes `fixTo`. */
export function verifyFlow(fixTo: string): ScenarioSpec {
  return {
    plan: { recording: 'C06-plan-native-host' },
    implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
    resume: [{ recording: 'C08b-resume-fix', write: version(fixTo), text: 'Done.\n\nF1 fixed' }],
  }
}

/** Plan → Implement writes version 1.0.0 (the check passes) → clean reviewers → Fix skipped. */
export const PASSING_FLOW: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
}

/** Write files into the sandbox (untracked: a user's working tree, in every snapshot). */
export function writeSandbox(e2e: E2EHarness, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(e2e.sandbox, rel), text)
}

/** Set (or replace) package.json scripts in the sandbox. */
export function setScripts(e2e: E2EHarness, scripts: Record<string, string>): void {
  const file = join(e2e.sandbox, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }
  pkg.scripts = { ...pkg.scripts, ...scripts }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}

/**
 * Trust a verify command for the sandbox through the app (trust.set: core reads the script body its hash covers,
 * exactly what Settings' Trust and the trust card's [Trust for this project] write).
 */
export async function trustCommand(e2e: E2EHarness, argv: readonly string[]): Promise<void> {
  await e2e.call('trust.set', {
    folder: e2e.sandbox,
    grant: { kind: 'command', command: { kind: 'verify', argv: [...argv], cwdRel: '.' } },
    trusted: true,
  })
}

/** User config: Verify on with `commands`, plus `extra` keys. */
export function verifyConfig(
  commands: { name: string; run: string[] | string }[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { verify: { enabled: true, commands }, ...extra }
}

// ---- the VerifyCard (src/renderer/src/components/run/VerifyCard.tsx) ------------------------------------------------

/**
 * A command's failure excerpt, shown: a round the view watched run opens it on a click ("Show the failure"); a round
 * already over when its card mounted (a fast round can begin and end between two snapshots) shows it open.
 */
export async function showExcerpt(card: Locator, step: string, i: number): Promise<Locator> {
  const id = `verify-command-${step}-${i}`
  const toggle = card.getByTestId(`${id}-excerpt-toggle`)
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return card.getByTestId(`${id}-excerpt`)
}

/**
 * The round's output pane, shown: first in a round the view watched run; in the "Output" disclosure (read once
 * opened) for a round already over when its card mounted.
 */
export async function showOutput(card: Locator, step: string): Promise<Locator> {
  const details = card.getByTestId(`verify-output-details-${step}`)
  if ((await details.count()) > 0 && (await details.getAttribute('open')) === null)
    await details.locator('summary').click()
  const pane = card.getByTestId(`verify-output-${step}`)
  await expect(pane).toBeVisible()
  return pane
}

/** The run's findings as core wrote them (findings.json, through runs.output). */
export async function findingsOf(e2e: E2EHarness, runId: string): Promise<FindingsFile['findings']> {
  const out = await e2e.call('runs.output', { runId, file: 'findings' })
  return (JSON.parse(out.text) as FindingsFile).findings
}

/** The runs in this home, newest first (runs.list). */
export async function runIds(e2e: E2EHarness): Promise<string[]> {
  const r = await e2e.call('runs.list', {})
  return r.items.map((x) => x.runId)
}
