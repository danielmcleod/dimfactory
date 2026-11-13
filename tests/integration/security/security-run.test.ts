// The security advisor through a real core (the fake Claude for the passes, a fake pip-audit in the sandbox's
// .venv, no network): Implement plants an AWS key and adds a vulnerable dependency; the scan finds the key (critical,
// masked) and the advisory for the added dependency (the one already there is a note, not a finding); the Security
// pass runs beside Review and Critic on its own model and gets the scan's results; Fix gets the security findings
// and removes the key; the re-check confirms both and the run ends fixed. A second run whose re-check finds one still
// open ends "Completed with failures" (security-open). An untrusted audit asks first, and Skip leaves it out.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import { stdinByScript } from '../run/scenario.ts'
import type { ScenarioSpec, Scenario } from '../run/scenario.ts'
import { VerifyWorld, settled, value } from '../verify/helpers.ts'

const world = new VerifyWorld()
afterEach(async () => world.dispose())

/** A key in the AWS access key format, built at run time (no literal key in the source). */
const KEY = ['AK', 'IA', 'Z3QX', '7NVB', 'K2MW', 'R8TP'].join('')

const AUDIT_ARGV = ['pip-audit', '-r', 'requirements.txt', '-f', 'json', '--progress-spinner', 'off']

/** The fake pip-audit: requests 2.19.0 (added by the run) and flask 2.0.0 (already there) are vulnerable. */
const FAKE_AUDIT = [
  "import { readFileSync } from 'node:fs'",
  "const req = readFileSync('requirements.txt', 'utf8')",
  'const deps = []',
  "if (req.includes('requests==2.19.0')) deps.push({ name: 'requests', version: '2.19.0', vulns: [{ id: 'PYSEC-2018-28', fix_versions: ['2.20.0'], aliases: ['CVE-2018-18074'], description: 'Requests sends the Authorization header on redirect.' }] })",
  "if (req.includes('flask==2.0.0')) deps.push({ name: 'flask', version: '2.0.0', vulns: [{ id: 'PYSEC-2099-9', fix_versions: ['2.3.2'], aliases: [], description: 'An old problem.' }] })",
  "console.error('pip-audit: auditing requirements')",
  'console.log(JSON.stringify({ dependencies: deps, fixes: [] }))',
].join('\n')

function plantAudit(folder: string): void {
  const scripts = join(folder, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
  mkdirSync(scripts, { recursive: true })
  writeFileSync(join(folder, '.venv', 'pip-audit.mjs'), FAKE_AUDIT)
  if (process.platform === 'win32') {
    writeFileSync(join(scripts, 'pip-audit.cmd'), '@node "%~dp0..\\pip-audit.mjs" %*\r\n')
  } else {
    const p = join(scripts, 'pip-audit')
    writeFileSync(p, '#!/bin/sh\nexec node "$(dirname "$0")/../pip-audit.mjs" "$@"\n', { mode: 0o755 })
  }
}

const CONFIG = (key: string): { path: string; content: string } => ({
  path: 'src/config.ts',
  content: `export const region = 'eu-west-1'\nexport const awsAccessKeyId = '${key}'\n`,
})
const CLEAN_CONFIG = {
  path: 'src/config.ts',
  content:
    "export const region = 'eu-west-1'\nexport const awsAccessKeyId = process.env['AWS_ACCESS_KEY_ID'] ?? ''\n",
}

const spec = (recheck: string): ScenarioSpec => ({
  plan: { recording: 'C06-plan-native-host' },
  implement: [
    {
      recording: 'C08a-session-id-implement',
      prepend: [{ op: 'writeFile', path: 'requirements.txt', content: 'flask==2.0.0\nrequests==2.19.0\n' }],
      write: CONFIG(KEY),
    },
  ],
  resume: [{ recording: 'C08b-resume-fix', write: CLEAN_CONFIG, text: 'F1 fixed\nF2 fixed' }],
  security: [
    { recording: 'C02-review-shape', text: 'NO FINDINGS' },
    { recording: 'C02-review-shape', text: recheck },
  ],
})

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

const overrides = (): Record<string, unknown> => ({
  profile: 'claude-only',

  gates: { afterPlan: false, beforeFix: false },
  passes: { security: { enabled: true, model: 'haiku' } },
})

async function setup(recheck: string): Promise<Awaited<ReturnType<VerifyWorld['setup']>>> {
  const w = await world.setup(spec(recheck), { 'requirements.txt': 'flask==2.0.0\n' })
  plantAudit(w.folder)
  return w
}

describe('security advisor (core + fake Claude + a fake audit tool)', () => {
  it('finds the planted key and the added vulnerable dependency; Fix removes the key; the re-check passes', async () => {
    const w = await setup('F1 resolved\nF2 resolved')
    await world.trust(w.home, w.folder, AUDIT_ARGV)
    const { core } = await world.boot(w.home)
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'read the AWS config',
        overrides: overrides(),
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.outcome).toBe('fixed')

    const snap = value(await core.invoke('runs.get', { runId }))
    const scan = snap.steps.scan.scan
    expect(snap.steps.scan.status).toBe('done')
    expect(scan?.secrets).toEqual([
      expect.objectContaining({ file: 'src/config.ts', line: 2, level: 'critical', confidence: 'pattern' }),
    ])
    expect(scan?.audits).toEqual([
      expect.objectContaining({ name: 'pip-audit', status: 'done', introduced: 1, existing: 1 }),
    ])
    expect(scan?.advisories.map((a) => [a.package, a.id, a.level])).toEqual([
      ['requests', 'PYSEC-2018-28', 'high'],
    ])
    expect(scan?.existing).toBe(1)
    // The whole key never leaves the scanner: not in the run's views, findings or the reviewer's prompt.
    expect(JSON.stringify(snap)).not.toContain(KEY)
    const findings = JSON.parse(
      readFileSync(join(w.home, 'runs', runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    expect(JSON.stringify(findings)).not.toContain(KEY)
    expect(findings.findings.map((f) => [f.source, f.severity, f.level])).toEqual([
      ['scan', 'must', 'critical'],
      ['scan', 'must', 'high'],
    ])
    expect(findings.sources.scan).toMatchObject({ status: 'ok', count: 2 })
    expect(findings.sources.security).toMatchObject({ status: 'none' })

    // The Security pass ran beside the reviewers on its own model and read the scan's results.
    expect(snap.steps.security).toMatchObject({ status: 'done', model: 'haiku', mode: 'readonly' })
    const secPrompt = sent(w.sc, 'security-1.script.jsonl')
    expect(secPrompt).toContain('You are the security reviewer')
    expect(secPrompt).toContain('AKIA…')
    expect(secPrompt).toContain('requests@2.19.0: PYSEC-2018-28')
    // Fix got the security findings and the rules; the re-check got the Fix diff and the two musts.
    const fixPrompt = sent(w.sc, 'resume-1.script.jsonl')
    expect(fixPrompt).toContain('[security:critical]')
    expect(fixPrompt).toContain('Never silence a check')
    const recheckPrompt = sent(w.sc, 'security-2.script.jsonl')
    expect(recheckPrompt).toContain('F1 (scan) [security:critical]')
    expect(recheckPrompt).toContain('F2 (scan) [security:high]')
    expect(recheckPrompt).toContain('process.env')
    expect(snap.steps.recheck.recheck).toEqual({ status: 'resolved', resolved: [1, 2], open: [] })
    expect(readFileSync(join(w.folder, 'src', 'config.ts'), 'utf8')).not.toContain(KEY)
    expect(existsSync(join(w.home, 'runs', runId, 'recheck.md'))).toBe(true)
  })

  it('a re-check that finds one still open completes with failures (security-open)', async () => {
    const w = await setup('F1 resolved\nF2 open: requests is still 2.19.0')
    await world.trust(w.home, w.folder, AUDIT_ARGV)
    const { core } = await world.boot(w.home)
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'read the AWS config',
        overrides: overrides(),
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.outcome).toBe('security-open')
    expect(done.notes.some((n) => n.includes('found F2 still open'))).toBe(true)
  })

  it('an untrusted audit asks first; Skip leaves it out (not run, not a finding); the secret is still found', async () => {
    const w = await setup('F1 resolved')
    const { core } = await world.boot(w.home)
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'read the AWS config',
        overrides: overrides(),
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const asking = await c.waitFor((s) => s.cards.some((x) => x.view.kind === 'trust'), 120_000)
    const card = asking.cards.find((x) => x.view.kind === 'trust')
    if (card === undefined) throw new Error('no trust card')
    expect(card.view.payload).toMatchObject({ step: 'scan', argv: AUDIT_ARGV })
    expect(asking.steps.scan.status).toBe('waiting')
    value(await core.invoke('cards.resolve', { runId, cardId: card.view.id, choiceId: 'skip' }))
    const done = await c.waitFor(settled, 120_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    const snap = value(await core.invoke('runs.get', { runId }))
    expect(snap.steps.scan.scan?.audits).toEqual([
      expect.objectContaining({ name: 'pip-audit', status: 'skipped', reason: 'You skipped it this run.' }),
    ])
    expect(snap.steps.scan.scan?.secrets).toHaveLength(1)
    expect(snap.steps.scan.scan?.advisories).toEqual([])
    expect(done.outcome).toBe('fixed')
  })
})
