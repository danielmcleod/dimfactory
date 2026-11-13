// The security advisor end to end, on the fake Claude in the temp sandbox with a fake pip-audit in its .venv (no
// network). The composer's "Security review" switch turns the advisor on for the run (it is off in the default
// profile) with its honest cost note. Implement plants an AWS key and adds a vulnerable dependency; the timeline shows
// the Security scan, Review ∥ Critic ∥ Security and the re-check; the scan finds the key (shown masked, never whole)
// and the advisory for the added dependency (the one already there is a note, not a finding); the gate before Fix
// tags both with a security chip; Fix removes the key; the re-check confirms both and the run reads Fixed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './harness.ts'
import { promptSent } from './diff-settings-helpers.ts'
import { findingsOf, trustCommand, writeSandbox } from './verify-helpers.ts'

/** A key in the AWS access key format, built at run time (no literal key in the source). */
const KEY = ['AK', 'IA', 'W5RT', '2HJQ', 'N7XC', 'L4PZ'].join('')

const AUDIT_ARGV = ['pip-audit', '-r', 'requirements.txt', '-f', 'json', '--progress-spinner', 'off']

/** The fake pip-audit: requests 2.19.0 (the run adds it) and flask 2.0.0 (already there) have advisories. */
const FAKE_AUDIT = [
  "import { readFileSync } from 'node:fs'",
  "const req = readFileSync('requirements.txt', 'utf8')",
  'const deps = []',
  "if (req.includes('requests==2.19.0')) deps.push({ name: 'requests', version: '2.19.0', vulns: [{ id: 'PYSEC-2018-28', fix_versions: ['2.20.0'], aliases: [], description: 'Requests sends the Authorization header on redirect.' }] })",
  "if (req.includes('flask==2.0.0')) deps.push({ name: 'flask', version: '2.0.0', vulns: [{ id: 'PYSEC-2099-9', fix_versions: ['2.3.2'], aliases: [], description: 'An old problem.' }] })",
  'console.log(JSON.stringify({ dependencies: deps, fixes: [] }))',
].join('\n')

const CONFIG = {
  path: 'src/config.ts',
  content: `export const region = 'eu-west-1'\nexport const awsAccessKeyId = '${KEY}'\n`,
}
const CLEAN_CONFIG = {
  path: 'src/config.ts',
  content:
    "export const region = 'eu-west-1'\nexport const awsAccessKeyId = process.env['AWS_ACCESS_KEY_ID'] ?? ''\n",
}

test('a planted secret and a vulnerable dependency: found, fixed, re-checked', async ({ e2e }) => {
  test.setTimeout(300_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          prepend: [
            { op: 'writeFile', path: 'requirements.txt', content: 'flask==2.0.0\nrequests==2.19.0\n' },
          ],
          write: CONFIG,
        },
      ],
      resume: [{ recording: 'C08b-resume-fix', write: CLEAN_CONFIG, text: 'F1 fixed\nF2 fixed' }],
      security: [
        { recording: 'C02-review-shape', text: 'NO FINDINGS' },
        { recording: 'C02-review-shape', text: 'F1 resolved\nF2 resolved' },
      ],
    },
    // The Security pass on its own model here, so the fake tells it from Critic; the advisor itself stays off
    // until the composer's switch turns it on.
    config: { gates: { afterPlan: true, beforeFix: true }, passes: { security: { model: 'haiku' } } },
  })
  writeSandbox(e2e, { 'requirements.txt': 'flask==2.0.0\n' })
  const venv = join(e2e.sandbox, '.venv')
  const bin = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(venv, 'pip-audit.mjs'), FAKE_AUDIT)
  if (process.platform === 'win32')
    writeFileSync(join(bin, 'pip-audit.cmd'), '@node "%~dp0..\\pip-audit.mjs" %*\r\n')
  else
    writeFileSync(join(bin, 'pip-audit'), '#!/bin/sh\nexec node "$(dirname "$0")/../pip-audit.mjs" "$@"\n', {
      mode: 0o755,
    })
  await trustCommand(e2e, AUDIT_ARGV)

  // ---- the composer: the switch is off (balanced), with its constant cost note; turning it on moves nothing ----
  await expect(page.getByTestId('composer')).toBeVisible()
  const folder = page.getByTestId('composer-folder-input')
  await folder.fill(e2e.sandbox)
  await folder.press('Enter')
  await page.getByTestId('composer-task').fill('Read the AWS settings and add the requests library')
  await expect(page.getByTestId('composer-passes')).toContainText('Claude')
  const toggle = page.getByTestId('composer-security')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const note = page.getByTestId('composer-security-note')
  await expect(note).toBeVisible()
  const noteText = await note.textContent()
  const box = await note.boundingBox()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(await note.textContent()).toBe(noteText)
  expect((await note.boundingBox())?.y).toBe(box?.y)

  await expect(page.getByTestId('composer-run')).toBeEnabled()
  await page.getByTestId('composer-run').click()
  await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
  const run = await e2e.onlyRun()
  // The scan, the Security pass and the re-check are in the timeline from the start.
  for (const step of ['scan', 'security', 'recheck'] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toBeVisible()
  await e2e.approvePlan()

  // ---- the gate before Fix: the key and the added dependency, each with a security chip ----
  const gate = page.getByTestId('card-gate:beforeFix')
  await expect(gate).toBeVisible({ timeout: 150_000 })
  const findings = await findingsOf(e2e, run.runId)
  expect(findings.map((f) => [f.n, f.severity, f.source, f.level])).toEqual([
    [1, 'must', 'scan', 'critical'],
    [2, 'must', 'scan', 'high'],
  ])
  for (const f of findings)
    await expect(gate.getByTestId(`finding-security-${f.id}`)).toHaveAttribute('data-level', f.level ?? '')
  await expect(gate).toContainText('AKIA…')
  await expect(gate).toContainText('requests@2.19.0')
  // The scan's card: the key masked, the audit's counts, the advisory already there as a note.
  const scan = page.getByTestId('pass-card-scan')
  await expect(scan.getByTestId('scan-masked').first()).toContainText('AKIA…')
  await expect(scan.getByTestId('scan-audit-0')).toHaveAttribute('data-status', 'done')
  await expect(scan.getByTestId('scan-existing')).toBeVisible()
  expect(await page.locator('body').innerText()).not.toContain(KEY)
  await gate.getByTestId('card-choice-continue').click()
  await expect(gate).toBeHidden()

  // ---- Fix removes the key; the re-check confirms both; Fixed ----
  const ended = await e2e.waitForEnd(run.runId, 180_000)
  expect(ended.status, e2e.describeRun(ended)).toBe('completed')
  expect(ended.outcome).toBe('fixed')
  for (const step of ['scan', 'security', 'fix', 'recheck'] as const)
    await expect(page.getByTestId(`timeline-node-${step}`)).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('pass-card-recheck').getByTestId('recheck-facts')).toHaveAttribute(
    'data-status',
    'resolved',
  )
  expect(readFileSync(join(e2e.sandbox, 'src', 'config.ts'), 'utf8')).not.toContain(KEY)

  // The prompts: the Security pass read the scan (masked); Fix got the security rules; the re-check, both musts.
  const security = promptSent(e2e, 'security-1.script.jsonl')
  expect(security).toContain('You are the security reviewer')
  expect(security).toContain('Secret scanner (values masked):')
  expect(promptSent(e2e, 'resume-1.script.jsonl')).toContain('Never silence a check')
  expect(promptSent(e2e, 'security-2.script.jsonl')).toContain('F2 (scan) [security:high]')
  expect(e2e.pageErrors).toEqual([])
})
