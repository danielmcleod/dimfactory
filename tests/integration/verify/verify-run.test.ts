// The Verify step through a real core (state-machine rows R6/R7/R11): the fake Claude for the
// passes, real node scripts as verify commands in a temp git sandbox.
//   - failing verify → [must] (source verify) → Fix → verify:2 passes → fixed
//   - failing again after Fix → verify-failed ("Completed with failures"), findings listed after Fix
//   - untrusted → trust card → [Trust for this project] writes the command grant → the round runs it
//   - a changed script body (new hash) → Auto: skipped with a [should]; non-Auto: a trust card with the diff
//   - an environment failure (exit 127) → verifyEnv card, never a finding → Retry
//   - Stop during a round kills the command's process tree; the folder lock is released after it
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scriptsBody } from '../../../src/core/verify/discover.ts'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import { matchFullMode } from '../attention/helpers.ts'
import { stdinByScript } from '../run/scenario.ts'
import type { Scenario } from '../run/scenario.ts'
import { CHECK, VerifyWorld, openCard, settled, value, verifyOverrides, version } from './helpers.ts'

const world = new VerifyWorld()
afterEach(async () => world.dispose())

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}

function userMessage(t: { sc: Scenario }, script: string): string {
  return (stdinByScript(t.sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('verify rounds (core + fake Claude + real commands)', () => {
  it('failing verify → [must] → Fix → verify:2 passes → fixed; {{verify}} reaches the prompts', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
      resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'F1 fixed' }],
    })
    await world.trust(w.home, w.folder, ['node', 'check.mjs'])
    const t = await world.start(w, verifyOverrides([CHECK]))
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status).toBe('completed')
    expect(done.outcome).toBe('fixed')

    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.steps['verify:1']).toMatchObject({ status: 'done', attempt: 1 })
    expect(snap.steps['verify:1'].verify?.commands).toEqual([
      expect.objectContaining({ name: 'check', argv: ['node', 'check.mjs'], status: 'fail', exitCode: 1 }),
    ])
    expect(snap.steps['verify:1'].verify?.commands[0]?.excerpt).toContain(
      'expected version 1.0.0, got export const version = "0.1.0"',
    )
    expect(snap.steps['verify:2'].verify?.commands).toEqual([
      expect.objectContaining({ name: 'check', status: 'pass', exitCode: 0 }),
    ])
    // The [must] joined the (empty) reviews at R8: Fix ran on it, and it is F1 (verify).
    const dir = join(t.home, 'runs', t.runId)
    const ff = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')) as FindingsFile
    expect(ff.findings).toEqual([
      expect.objectContaining({ n: 1, severity: 'must', source: 'verify', round: 1 }),
    ])
    expect(ff.findings[0]?.title).toMatch(/^`node check\.mjs` failed \(exit 1, \d+s\)$/)
    // findings.json's verify source is the latest round (verify:2, passing).
    expect(ff.sources.verify).toEqual({ status: 'none', count: 0, rawFile: 'verify/verify-2/output.log' })
    expect(ff.fixReport).toEqual({ [ff.findings[0]?.id ?? '']: 'fixed' })
    expect(snap.summary.findings).toEqual({ must: 1, should: 0 })

    // {{verify}}: the reviewers got verify:1's FAIL with its excerpt; Fix got F1 (verify) and the latest results.
    const review = userMessage(t, 'review-default.script.jsonl')
    expect(review).toContain(
      'Automated checks Dim Factory ran after the change:\n- FAIL `node check.mjs` (exit 1, ',
    )
    expect(review).toContain('expected version 1.0.0')
    const fix = userMessage(t, 'resume-1.script.jsonl')
    expect(fix).toMatch(/- \[must\] F1 \(verify\) `node check\.mjs` failed \(exit 1, \d+s\)/)
    expect(fix).toContain('Latest automated check results:\n- FAIL `node check.mjs`')

    // R7: the post-verify-1 snapshot; the round's combined output is served for the Run view.
    const snaps = JSON.parse(readFileSync(join(dir, 'snapshots.json'), 'utf8')) as {
      snapshots: { label: string }[]
    }
    expect(snaps.snapshots.map((s) => s.label)).toEqual(
      expect.arrayContaining(['S1', 'post-verify-1', 'post-review', 'S2']),
    )
    const out = value(await t.core.invoke('runs.output', { runId: t.runId, file: 'verify:1' }))
    expect(out.text).toContain('$ node check.mjs')
    expect(out.text).toContain('expected version 1.0.0')
    expect(out.version).toBeGreaterThan(0)
    expect(
      t.events.some((e) => e.runId === t.runId && e.body.t === 'output' && e.body.file === 'verify:2'),
    ).toBe(true)
    // Phases on the way: verifying (verify:1) and final-verify (verify:2).
    const phases = t.events.flatMap((e) =>
      e.runId === t.runId && e.body.t === 'run-status' ? [e.body.phase] : [],
    )
    expect(phases).toEqual(expect.arrayContaining(['verifying', 'final-verify']))
  }, 180_000)

  it('failing again after Fix → completed(verify-failed): "Completed with failures"', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
      resume: [{ recording: 'C08b-resume-fix', write: version('0.2.0'), text: 'F1 fixed' }],
    })
    await world.trust(w.home, w.folder, ['node', 'check.mjs'])
    const t = await world.start(w, verifyOverrides([CHECK]))
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done).toMatchObject({ status: 'completed', outcome: 'verify-failed' })
    expect(done.notes).toContain('Completed with failures: check still fails after Fix.')
    expect(done.steps['verify:2'].verify?.commands[0]).toMatchObject({ status: 'fail', exitCode: 1 })
    const ff = JSON.parse(
      readFileSync(join(t.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    // verify:1's finding went to Fix; verify:2's is listed after it (round 2), not sent to Fix.
    expect(ff.findings.map((f) => [f.n, f.source, f.round])).toEqual([
      [1, 'verify', 1],
      [2, 'verify', 2],
    ])
    expect(Object.values(ff.selected)).toEqual([true, false])
    expect(ff.fixReport).toBeDefined()
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.summary.outcome).toBe('verify-failed')
    expect(snap.summary.findings).toEqual({ must: 2, should: 0 })
  }, 180_000)

  it('untrusted → trust card (non-Auto) → [Trust for this project] writes the grant → the round runs it', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
    })
    const t = await world.start(w, verifyOverrides([CHECK]))
    const asking = await t.c.waitFor((s) => openCard(s, 'trust') !== undefined || settled(s), 90_000)
    const card = openCard(asking, 'trust')
    expect(card).toMatchObject({ title: 'Trust the check check?', blocking: true })
    expect(card?.defaultChoice).toBeUndefined()
    expect(card?.body).toContain('`node check.mjs`')
    expect(asking.steps['verify:1']).toMatchObject({ status: 'waiting', reason: 'trust needed' })
    expect(asking.phase).toBe('needs-attention')
    // Nothing ran yet: the round's folder does not exist.
    expect(existsSync(join(t.home, 'runs', t.runId, 'verify', 'verify-1', 'output.log'))).toBe(false)

    value(await t.core.invoke('cards.resolve', { runId: t.runId, cardId: card?.id ?? '', choiceId: 'trust' }))
    const done = await t.c.waitFor(settled, 120_000)
    expect(done.outcome).toBe('clean')
    expect(done.steps['verify:1'].verify?.commands[0]).toMatchObject({ status: 'pass' })
    expect(done.notes).toContain('Trusted the verify command check for this project.')
    const trust = value(await t.core.invoke('trust.get', { folder: t.folder }))
    expect(Object.values(trust.grants.commands ?? {})).toEqual([
      expect.objectContaining({ kind: 'verify', argv: ['node', 'check.mjs'], cwdRel: '.' }),
    ])
  }, 180_000)

  it('a changed script body (new hash): Auto skips it with a [should]; Auto never implies trust', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
    })
    const pkgFile = join(w.folder, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts: Record<string, string> }
    pkg.scripts['check'] = 'node check.mjs'
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    // The grant covers the package.json's scripts map as it is now.
    await world.trust(w.home, w.folder, ['npm', 'run', 'check'], scriptsBody(pkg.scripts))
    // The script changes after it was trusted: its hash no longer matches the grant.
    pkg.scripts['check'] = 'node check.mjs --strict'
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    // Auto launches Implement in full mode (bypassPermissions).
    matchFullMode(w.sc)
    const t = await world.start(
      w,
      verifyOverrides([{ name: 'check', run: ['npm', 'run', 'check'] }], { auto: true }),
    )
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.cards).toEqual([])
    expect(done.steps['verify:1']).toMatchObject({ status: 'skipped', reason: 'no command ran' })
    expect(done.steps['verify:1'].verify?.commands[0]).toMatchObject({ status: 'skipped-untrusted' })
    expect(done.notes).toContain(
      'Auto skipped the verify command check: its script changed since it was trusted. Trust it in Settings to run it.',
    )
    const ff = JSON.parse(
      readFileSync(join(t.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    expect(ff.findings).toEqual([expect.objectContaining({ severity: 'should', source: 'verify' })])
    // A [should] does not block the skip rule.
    expect(done.outcome).toBe('clean')
    // Nothing ran: no npm output in the round's log.
    const out = readFileSync(join(t.home, 'runs', t.runId, 'verify', 'verify-1', 'output.log'), 'utf8')
    expect(out).toContain('[not run:')
  }, 180_000)

  it('a changed script body, non-Auto → a trust card with the diff; [Skip] leaves it out', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
    })
    const pkgFile = join(w.folder, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts: Record<string, string> }
    pkg.scripts['check'] = 'node check.mjs --strict'
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))
    // A body is the package.json's scripts map: the grant was for the map with the old check script.
    const granted = scriptsBody({ ...pkg.scripts, check: 'node check.mjs' })
    await world.trust(w.home, w.folder, ['npm', 'run', 'check'], granted)
    const t = await world.start(w, verifyOverrides([{ name: 'check', run: ['npm', 'run', 'check'] }]))
    const asking = await t.c.waitFor((s) => openCard(s, 'trust') !== undefined || settled(s), 90_000)
    const card = openCard(asking, 'trust')
    expect(card?.title).toBe('The check check changed since you trusted it')
    expect(card?.payload).toMatchObject({
      trust: 'changed',
      grantedBody: granted,
      body: scriptsBody(pkg.scripts),
    })
    const diff = (card?.payload as { diff?: { op: string; text: string }[] }).diff ?? []
    expect(diff.filter((d) => d.op !== 'same').map((d) => [d.op, d.text.replace(/,$/, '').trim()])).toEqual([
      ['del', '"check": "node check.mjs"'],
      ['add', '"check": "node check.mjs --strict"'],
    ])
    value(await t.core.invoke('cards.resolve', { runId: t.runId, cardId: card?.id ?? '', choiceId: 'skip' }))
    const done = await t.c.waitFor(settled, 120_000)
    expect(done.steps['verify:1'].verify?.commands[0]).toMatchObject({
      status: 'skipped',
      reason: 'You skipped it this round.',
    })
    expect(done.outcome).toBe('clean')
  }, 180_000)

  it('an environment failure (exit 127) → verifyEnv card, never a finding → Retry runs the round again', async () => {
    const w = await world.setup(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
      },
      { 'env.mjs': "console.error('tool: not installed')\nprocess.exit(127)\n" },
    )
    await world.trust(w.home, w.folder, ['node', 'env.mjs'])
    const t = await world.start(w, verifyOverrides([{ name: 'tool', run: ['node', 'env.mjs'] }]))
    const asking = await t.c.waitFor((s) => openCard(s, 'verifyEnv') !== undefined || settled(s), 90_000)
    const card = openCard(asking, 'verifyEnv')
    expect(card).toMatchObject({ title: 'The tool check could not run', defaultChoice: 'skip-verify' })
    expect(card?.body).toContain('A program it runs was not found (exit 127)')
    expect(asking.steps['verify:1'].verify?.commands[0]).toMatchObject({ status: 'env', exitCode: 127 })
    expect(asking.findings?.verify).toBeUndefined()
    // The environment is fixed; Retry reruns the round from its trust check.
    writeFileSync(join(w.folder, 'env.mjs'), "console.log('tool ok')\n")
    value(await t.core.invoke('cards.resolve', { runId: t.runId, cardId: card?.id ?? '', choiceId: 'retry' }))
    const done = await t.c.waitFor(settled, 120_000)
    expect(done.steps['verify:1']).toMatchObject({ status: 'done', attempt: 2 })
    expect(done.steps['verify:1'].verify?.commands[0]).toMatchObject({ status: 'pass' })
    expect(done.outcome).toBe('clean')
  }, 180_000)

  it('Stop during a round kills the command (tree kill); cancelled; the lock goes after it', async () => {
    const w = await world.setup(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
      },
      {
        'slow.mjs': [
          "import { writeFileSync } from 'node:fs'",
          'writeFileSync(process.argv[2], String(process.pid))',
          'setInterval(() => {}, 1000)',
        ].join('\n'),
      },
    )
    const pidFile = join(w.home, 'slow.pid')
    const argv = ['node', 'slow.mjs', pidFile]
    await world.trust(w.home, w.folder, argv)
    const t = await world.start(w, verifyOverrides([{ name: 'slow', run: argv }]))
    await until(() => existsSync(pidFile), 90_000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(pid)).toBe(true)
    value(await t.core.invoke('runs.stop', { runId: t.runId }))
    const done = await t.c.waitFor((s) => s.status === 'cancelled' && s.lock === 'none', 60_000)
    expect(done.steps['verify:1'].status).toBe('cancelled')
    await until(() => !alive(pid), 15_000)
  }, 180_000)
})
