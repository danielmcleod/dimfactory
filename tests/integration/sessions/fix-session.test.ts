// Session reuse through a real core and the fake Claude (state-machine row R10, failure category resume_failed,
// the pass.fix.resume check):
//   - C08 replay: Fix continues Implement's session (`--resume=<id>`, no `--session-id`) after the controller's
//     canResume found its transcript; Fix's usage is the delta against Implement's cumulative totals
//   - a bogus id (C08c "No conversation found", exit 1) → Fix restarts fresh with "fresh session: resuming failed";
//     the attempt stays 1 and the retry budget is unused
//   - no transcript → canResume says no → Fix starts fresh ("the session cannot be resumed"), no `--resume` at all
//   - pass.fix.resume in live preflight words what config.resolve suggests
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeProjectDir } from '../../../src/core/adapters/claude/session.ts'
import { realPathSync } from '../../../src/core/real-path.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { REVIEW_WITH_FINDINGS, passArgvs } from '../run/scenario.ts'
import { World, cumulative, fixWrite, settled, value, versionWrite } from './helpers.ts'
import type { Started } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

/** Every ask on any step: allowed, as a user would (C03's PowerShell ask). */
function allowAsks(t: Started): void {
  t.c.subscribe((s) => {
    for (const st of Object.values(s.steps)) {
      for (const a of st.asks) {
        void t.core.invoke('asks.answer', {
          runId: s.runId,
          requestId: a.requestId,
          decision: 'allow',
          graceMs: 0,
        })
      }
    }
  })
}

const fixStatuses = (events: RunEnvelope[]) =>
  events
    .map((e) => e.body)
    .filter((b) => b.t === 'step-status' && b.step === 'fix')
    .map((b) =>
      b.t === 'step-status' ? { status: b.status, attempt: b.attempt, note: b.sessionNote } : null,
    )

const BASE = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
}

describe('Fix session (core + fake Claude)', () => {
  it('C08 replay: Fix resumes Implement’s session (--resume=<id>) and reports its own usage delta', async () => {
    const t = await w.start({ ...BASE, resume: [{ recording: 'C08b-resume-fix', write: fixWrite }] })
    const done = await t.c.waitFor(settled, 90_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('fixed')

    const impl = done.steps.implement.sessionId ?? ''
    expect(impl).not.toBe('')
    // canResume looked where the real CLI keeps the transcript, in the folder the session ran in: the CLI names it by
    // its getcwd(), the real path (macOS /private/var for /var).
    const transcripts = [t.folder, realPathSync(t.folder)].map((d) =>
      join(t.claudeConfigDir, 'projects', encodeProjectDir(d), `${impl}.jsonl`),
    )
    expect(
      transcripts.some((p) => existsSync(p)),
      transcripts.join(' or '),
    ).toBe(true)
    expect(done.sessions[impl]?.cwd).toBe(t.folder)

    const resumed = passArgvs(t.sc.entries()).filter((a) => a.some((x) => x.startsWith('--resume=')))
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toContain(`--resume=${impl}`)
    expect(resumed[0]?.some((x) => x.startsWith('--session-id'))).toBe(false)

    const fix = done.steps.fix
    expect(fix).toMatchObject({ status: 'done', attempt: 1, sessionNote: 'reused the Implement session' })
    expect(fixStatuses(t.events)).toContainEqual({
      status: 'running',
      attempt: 1,
      note: 'reused the Implement session',
    })

    const a = cumulative('C08a-session-id-implement')
    const b = cumulative('C08b-resume-fix')
    const delta = {
      input: b.input - a.input,
      output: b.output - a.output,
      cacheRead: (b.cacheRead ?? 0) - (a.cacheRead ?? 0),
      cacheWrite: (b.cacheWrite ?? 0) - (a.cacheWrite ?? 0),
    }
    expect(fix.usage).toMatchObject(delta)
    expect(fix.usage?.costUsd).toBeCloseTo((b.costUsd ?? 0) - (a.costUsd ?? 0), 9)
    expect(fix.usageApprox).toBeUndefined()
    // Implement's own usage is its whole first session; the session's totals move to C08b's.
    expect(done.steps.implement.usage).toMatchObject({ input: a.input, output: a.output })
    expect(done.sessions[impl]?.lastTotals).toMatchObject({ input: b.input, output: b.output })
  }, 150_000)

  it('a bogus id (C08c "No conversation found") → Fix restarts fresh: same attempt, budget unused, the card says why', async () => {
    const t = await w.start(
      { ...BASE, fix: [{ recording: 'C03-accept-edits', write: fixWrite }] },
      { first: [{ match: { argvIncludes: ['-p', '--resume=*'] }, recording: 'C08c-resume-bogus' }] },
    )
    allowAsks(t)
    const done = await t.c.waitFor(settled, 90_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('fixed')
    const impl = done.steps.implement.sessionId ?? ''

    // One rejected --resume, then one fresh edit session (its own --session-id).
    const edits = passArgvs(t.sc.entries()).filter((a) => a.includes('acceptEdits'))
    expect(edits).toHaveLength(3) // Implement, the rejected resume, the fresh Fix
    expect(edits[1]).toContain(`--resume=${impl}`)
    expect(edits[2]?.some((x) => x.startsWith('--resume='))).toBe(false)
    expect(edits[2]?.some((x) => x.startsWith('--session-id='))).toBe(true)

    expect(done.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      autoRetryUsed: false,
      sessionNote: 'fresh session: resuming failed',
    })
    const statuses = fixStatuses(t.events)
    expect(statuses.every((s) => s?.attempt === 1)).toBe(true)
    expect(statuses).toContainEqual({ status: 'running', attempt: 1, note: 'reused the Implement session' })
    expect(statuses).toContainEqual({ status: 'running', attempt: 1, note: 'fresh session: resuming failed' })
    expect(statuses.some((s) => s?.status === 'failed')).toBe(false)
    expect(t.events.some((e) => e.body.t === 'snag')).toBe(false)
  }, 150_000)

  it('no transcript → canResume says no → Fix starts fresh, never trying --resume', async () => {
    const t = await w.start(
      { ...BASE, fix: [{ recording: 'C03-accept-edits', write: fixWrite }] },
      { env: { FAKE_CLI_CLAUDE_TRANSCRIPTS: '0' } },
    )
    allowAsks(t)
    const done = await t.c.waitFor(settled, 90_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('fixed')
    expect(passArgvs(t.sc.entries()).some((a) => a.some((x) => x.startsWith('--resume=')))).toBe(false)
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      attempt: 1,
      autoRetryUsed: false,
      sessionNote: 'fresh session: the session cannot be resumed',
    })
  }, 150_000)

  it('pass.fix.resume (live preflight) words what config.resolve suggests', async () => {
    const b = await w.boot({})
    value(await b.core.invoke('vendors.probe', { vendor: 'claude' }))
    const cases = [
      [{ profile: 'claude-only' }, "Fix will continue Implement's session", { choice: 'reuse' }],
      [
        { profile: 'claude-only', passes: { fix: { reuseSession: false } } },
        'Fix will start fresh: set to start fresh',
        { choice: 'fresh', reason: 'override-fresh' },
      ],
      [
        { profile: 'claude-only', passes: { fix: { vendor: 'codex' } } },
        'Fix will start fresh: Fix vendor differs',
        { choice: 'fresh-other', reason: 'vendor-differs' },
      ],
    ] as const
    for (const [overrides, title, fixSession] of cases) {
      const live = value(await b.core.invoke('preflight.run', { folder: b.folder, overrides }))
      const check = live.info.find((c) => c.id === 'pass.fix.resume')
      expect(check, JSON.stringify(overrides)).toMatchObject({ scope: 'pass', status: 'pass', title })
      const resolved = value(await b.core.invoke('config.resolve', { folder: b.folder, overrides }))
      expect(resolved.suggestions?.fixSession).toEqual(fixSession)
    }
  }, 150_000)
})
