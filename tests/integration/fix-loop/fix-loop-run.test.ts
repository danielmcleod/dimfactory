// Fix until green through a real core (the fake Claude for the passes, a real verify command in the sandbox):
//   - Implement leaves the version wrong (verify:1 fails) and Review reports two [must]s. Round 1's Fix (continuing
//     Implement's session) fixes the reviewers' findings but not the version; its re-check (on Review's model)
//     confirms F1 and F2; round 2's Fix (continuing round 1's session) fixes the version; verify:2 passes → fixed.
//   - With 2 rounds and a version still wrong after round 2: the round cap → "Completed with failures".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import { REVIEW_WITH_FINDINGS, stdinByScript } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'
import { CHECK, VerifyWorld, settled, value, verifyOverrides, version } from '../verify/helpers.ts'

const world = new VerifyWorld()
afterEach(async () => world.dispose())

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

const spec = (round2Version: string): ScenarioSpec => ({
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
  // Round 1 continues Implement's session; round 2 continues round 1's.
  resume: [
    { recording: 'C08b-resume-fix', write: version('0.2.0'), text: 'F1 fixed\nF2 fixed\nF3 fixed' },
    { recording: 'C08b-resume-fix', write: version(round2Version), text: 'F4 fixed' },
  ],
  // Review's findings, then round 1's re-check (it runs on Review's model without the security advisor).
  review: [
    { recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS },
    { recording: 'C02-review-shape', text: 'F1 resolved\nF2 resolved' },
  ],
})

const overrides = (rounds: number): Record<string, unknown> =>
  verifyOverrides([CHECK], { passes: { fix: { rounds } } })

describe('Fix until green (core + fake Claude + a real check)', () => {
  it('goes green on round 2: the rounds, their sessions, prompts and findings', async () => {
    const w = await world.setup(spec('1.0.0'))
    await world.trust(w.home, w.folder, ['node', 'check.mjs'])
    const t = await world.start(w, overrides(3))
    const done = await t.c.waitFor(settled, 180_000)
    await t.c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.outcome).toBe('fixed')
    expect(readFileSync(join(w.folder, 'src', 'version.ts'), 'utf8')).toContain('1.0.0')

    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.fixLoop).toMatchObject({ max: 3, round: 2, stop: { reason: 'green' } })
    expect(snap.fixLoop?.rounds).toEqual([
      expect.objectContaining({ n: 1, status: 'done', changed: true, failing: ['check'], resolved: [1, 2] }),
      expect.objectContaining({ n: 2, status: 'done', changed: true, failing: [], open: [] }),
    ])
    expect(snap.summary.fixLoop).toEqual({ rounds: 2, max: 3, stop: 'green' })
    // Each round is an attempt of Fix and verify:2; the second round had nothing for the re-check.
    expect(snap.steps.fix).toMatchObject({ status: 'done', attempt: 2, round: { n: 2, of: 3 } })
    expect(snap.steps['verify:2'].verify?.commands).toEqual([
      expect.objectContaining({ name: 'check', status: 'pass' }),
    ])
    expect(snap.steps.recheck).toMatchObject({ status: 'skipped', reason: 'not needed' })
    expect(snap.steps.fix.sessionNote).toBe("continued the previous round's session")

    // Round 1's Fix got every finding; its re-check the two [must]s from Review with the Fix diff; round 2's Fix only
    // what was still open (the failing check, F5) with the latest check results.
    const fix1 = sent(t.sc, 'resume-1.script.jsonl')
    expect(fix1).toMatch(/F1 \(review\)/)
    expect(fix1).toMatch(/F3 \(verify\)/)
    const recheck = sent(t.sc, 'review-2.script.jsonl')
    expect(recheck).toContain('You are re-checking a fix')
    expect(recheck).toMatch(/F1 \(review\)/)
    expect(recheck).toMatch(/F2 \(review\)/)
    expect(recheck).not.toMatch(/F3 \(verify\)/)
    expect(recheck).toContain('0.2.0')
    const fix2 = sent(t.sc, 'resume-2.script.jsonl')
    expect(fix2).toContain('Fix until green, round 2 of 3')
    expect(fix2).toMatch(/F5 \(verify\)/)
    expect(fix2).not.toMatch(/F1 \(review\)/)
    expect(fix2).toContain('expected version 1.0.0, got export const version = "0.2.0"')

    const ff = JSON.parse(
      readFileSync(join(t.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    // Must first: F1, F2 from Review, F3 verify:1's failure, then Review's should (F4), then round 1's verify:2 failure.
    expect(ff.findings.map((f) => [f.n, f.source, f.severity])).toEqual([
      [1, 'review', 'must'],
      [2, 'review', 'must'],
      [3, 'verify', 'must'],
      [4, 'review', 'should'],
      [5, 'verify', 'must'],
    ])
    // Phases on the way: each round's Fix, verify and re-check.
    const phases = t.events.flatMap((e) =>
      e.runId === t.runId && e.body.t === 'run-status' ? [e.body.phase] : [],
    )
    expect(phases).toEqual(expect.arrayContaining(['fixing', 'final-verify', 'rechecking']))
    expect(
      t.events.some((e) => e.runId === t.runId && e.body.t === 'output' && e.body.file === 'rounds'),
    ).toBe(true)
    // The post-round snapshot sits between the rounds.
    const snaps = JSON.parse(readFileSync(join(t.home, 'runs', t.runId, 'snapshots.json'), 'utf8')) as {
      snapshots: { label: string }[]
    }
    expect(snaps.snapshots.map((s) => s.label)).toEqual(expect.arrayContaining(['post-round']))
  }, 240_000)

  it('stops at the round cap when the check still fails after the last round', async () => {
    const w = await world.setup(spec('0.3.0'))
    await world.trust(w.home, w.folder, ['node', 'check.mjs'])
    const t = await world.start(w, overrides(2))
    const done = await t.c.waitFor(settled, 180_000)
    await t.c.settle(15_000)
    expect(done).toMatchObject({ status: 'completed', outcome: 'fix-stopped' })
    expect(done.fixLoop?.stop?.reason).toBe('cap')
    expect(done.notes.at(-1)).toContain(
      'Completed with failures: Fix until green stopped at the round cap (2 of 2',
    )
    expect(done.notes.at(-1)).toContain('check still fails')
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.summary).toMatchObject({
      outcome: 'fix-stopped',
      fixLoop: { rounds: 2, max: 2, stop: 'cap' },
    })
    // The second round's failure keeps the finding the first round listed (no duplicate row).
    expect(snap.fixLoop?.rounds.map((r) => r.open)).toEqual([[5], [5]])
    expect(stdinByScript(t.sc.entries()).has('resume-2.script.jsonl')).toBe(true)
  }, 240_000)
})
