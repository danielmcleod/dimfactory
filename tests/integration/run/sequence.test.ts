// The full Claude-only sequence against the fake Claude (real adapter, real spawn, real git shadow), assembled
// from the real recordings: C06 native plan → C03 / C08a Implement → C02-shaped Review ∥ Critic → C08b-shaped
// Fix resuming Implement's session.
//   - Fix's stdin carries only the findings the user kept at the gate before Fix
//   - two NO FINDINGS → Fix skipped, clean · no changes → no-changes (R6)
//   - the resumed Fix's usage is the delta against Implement's totals, vendor-reported
//   - a failed reviewer fails the run and the survivor's findings are kept
//   - an empty review twice → emptyFindings card → Treat as no findings
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { sumClaudeModelUsage } from '../../../src/core/adapters/usage.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import type { Usage } from '../../../src/shared/events.ts'
import type { CardView, RunEnvelope } from '../../../src/shared/run.ts'
import {
  REVIEW_WITH_FINDINGS,
  STDIO,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
  stdinByScript,
} from './scenario.ts'
import type { ScenarioSpec } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

/** Fix's closing lines (fix.md): one per finding it got. */
const FIX_REPORT = 'Added the version output.\n\nF1 fixed\nF2 disputed: src/version.test.ts covers it.'

const versionWrite = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }
const fixWrite = { path: 'src/version.test.ts', content: 'import "./version"\n' }

const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

interface Started {
  core: Core
  c: RunController
  runId: string
  home: string
  folder: string
  sc: Awaited<ReturnType<typeof makeScenario>>
  events: RunEnvelope[]
}

async function start(
  spec: ScenarioSpec,
  overrides: Record<string, unknown> = { gates: { afterPlan: false } },
): Promise<Started> {
  const sc = await makeScenario(spec)
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  const events: RunEnvelope[] = []
  core.bus.attach({ name: 't', run: (e) => events.push(e) })
  const r = await core.invoke('runs.start', { folder, task: 'add a --version flag', overrides })
  if (!r.ok) throw new Error(r.error.message)
  const c = core.controller(r.value.runId)
  if (c === undefined) throw new Error('no controller')
  // C03's PowerShell ask: answered like a user would.
  c.subscribe((s) => {
    for (const a of s.steps.implement.asks) {
      void core.invoke('asks.answer', {
        runId: s.runId,
        requestId: a.requestId,
        decision: 'allow',
        graceMs: 0,
      })
    }
  })
  return { core, c, runId: r.value.runId, home, folder, sc, events }
}

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}

function userMessage(sc: Started['sc'], script: string): string {
  return (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((t) => t !== '') ?? ''
}

function cumulative(id: string): Usage {
  for (const l of readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8').split('\n')) {
    if (l.trim() === '') continue
    const f = JSON.parse(l) as { dir?: string; line?: string }
    if (f.dir !== 'out' || f.line === undefined) continue
    let v: { type?: string; modelUsage?: Parameters<typeof sumClaudeModelUsage>[0] }
    try {
      v = JSON.parse(f.line) as typeof v
    } catch {
      continue
    }
    if (v.type === 'result') return sumClaudeModelUsage(v.modelUsage)
  }
  throw new Error(`${id}: no result`)
}

function card(s: RunState, kind: CardView['kind']): CardView {
  const c = s.cards.find((x) => x.view.kind === kind)
  if (c === undefined) throw new Error(`no open ${kind} card`)
  return c.view
}

describe('Claude-only sequence (core + fake Claude)', () => {
  it('Review findings → gate before Fix (one unticked) → Fix resumes Implement with only the kept findings → fixed', async () => {
    const t = await start(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [{ recording: 'C03-accept-edits', write: versionWrite }],
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
        resume: [{ recording: 'C08b-resume-fix', write: fixWrite, text: FIX_REPORT }],
      },
      { gates: { afterPlan: false, beforeFix: true } },
    )
    const atGate = await t.c.waitFor(
      (s) => s.cards.some((x) => x.view.kind === 'gate:beforeFix') || settled(s),
      60_000,
    )
    const gate = card(atGate, 'gate:beforeFix')
    expect(atGate.phase).toBe('findings-review')
    const findings = (
      gate.payload as { findings: { id: string; n: number; severity: string; title: string }[] }
    ).findings
    // Must first, numbered F1…: the two musts, then the should.
    expect(findings.map((f) => [f.n, f.severity])).toEqual([
      [1, 'must'],
      [2, 'must'],
      [3, 'should'],
    ])
    expect(findings[2]?.title).toContain('Unused import')
    // Review and Critic were spawned together (the join), and both parsed.
    expect(atGate.steps.review.status).toBe('done')
    expect(atGate.steps.critic.status).toBe('done')
    expect(atGate.findings?.sources.critic?.status).toBe('none')
    const keep = findings.filter((f) => f.n !== 3).map((f) => f.id)
    const r = await t.core.invoke('cards.resolve', {
      runId: t.runId,
      cardId: gate.id,
      choiceId: 'continue',
      input: keep,
    })
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true)
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(10_000)
    expect(done.status).toBe('completed')
    expect(done.outcome).toBe('fixed')

    // Fix reused Implement's Claude session (--resume, no --session-id) and got only F1 and F2.
    const implSession = done.steps.implement.sessionId
    expect(implSession).toBeDefined()
    const argvs = passArgvs(t.sc.entries())
    const fixArgv = argvs.find((a) => a.some((x) => x.startsWith('--resume=')))
    expect(fixArgv).toContain(`--resume=${implSession}`)
    expect(fixArgv?.some((x) => x.startsWith('--session-id'))).toBe(false)
    expect(done.steps.fix.sessionNote).toBe('reused the Implement session')
    const fixPrompt = userMessage(t.sc, 'resume-1.script.jsonl')
    expect(fixPrompt).toContain('Address the findings below')
    expect(fixPrompt).toContain('- [must] F1 (review) `src/cli.ts:12`')
    expect(fixPrompt).toContain('  The handler returns before it writes to stdout.')
    expect(fixPrompt).toContain('- [must] F2 (review) `test/cli.test.ts:1`')
    expect(fixPrompt).not.toContain('Unused import')
    expect(fixPrompt).not.toContain('F3')
    // A resumed Fix gets no task/plan/diff (the session has them).
    expect(fixPrompt).not.toContain('fresh session')
    expect(fixPrompt).not.toContain('<diff>')

    // The reviewers got the task, the plan and the S0..S1 diff.
    const reviewPrompt = userMessage(t.sc, 'review-1.script.jsonl')
    expect(reviewPrompt).toContain('You are reviewing a code change')
    expect(reviewPrompt).toContain('add a --version flag')
    expect(reviewPrompt).toMatch(/<diff>\nFiles changed \(1\):\nA src\/version\.ts/)
    expect(reviewPrompt).toContain('+export const version = "0.1.0"')
    const criticPrompt = userMessage(t.sc, 'critic-default.script.jsonl')
    expect(criticPrompt).toContain('You are the critic')
    expect(criticPrompt).toContain('src/version.ts')

    // Artifacts: review.md / critic.md, findings.json (selection + Fix report), the diff segments.
    const dir = join(t.home, 'runs', t.runId)
    expect(readFileSync(join(dir, 'review.md'), 'utf8')).toBe(`${REVIEW_WITH_FINDINGS}\n`)
    expect(readFileSync(join(dir, 'critic.md'), 'utf8')).toBe('NO FINDINGS\n')
    const ff = JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')) as FindingsFile
    expect(ff.schemaVersion).toBe(1)
    expect(ff.findings).toHaveLength(3)
    expect(ff.sources).toEqual({
      review: { status: 'ok', count: 3, rawFile: 'review.md' },
      critic: { status: 'none', count: 0, rawFile: 'critic.md' },
    })
    expect(Object.values(ff.selected)).toEqual([true, true, false])
    // Fix's closing report, by finding id (display only).
    expect(ff.fixReport).toEqual({ [keep[0] ?? '']: 'fixed', [keep[1] ?? '']: 'disputed' })
    expect(readFileSync(join(dir, 'diffs', 'S0..S1.patch'), 'utf8')).toContain('src/version.ts')
    const fixPatch = readFileSync(join(dir, 'diffs', 'F0..S2.patch'), 'utf8')
    expect(fixPatch).toContain('src/version.test.ts')
    expect(fixPatch).not.toContain('src/version.ts\n')
    const combined = readFileSync(join(dir, 'diffs', 'S0..S2.patch'), 'utf8')
    expect(combined).toContain('src/version.ts')
    expect(combined).toContain('src/version.test.ts')
    const snaps = JSON.parse(readFileSync(join(dir, 'snapshots.json'), 'utf8')) as {
      snapshots: { label: string }[]
    }
    expect(snaps.snapshots.map((s) => s.label)).toEqual(
      expect.arrayContaining(['run-start', 'S0', 'S1', 'post-review', 'fix-start', 'S2']),
    )

    // RunSummary: findings and per-step rows (final attempt), vendor-reported cost, prompt size bucket.
    const snap = await t.core.invoke('runs.get', { runId: t.runId })
    if (!snap.ok) throw new Error(snap.error.message)
    const sum = snap.value.summary
    expect(sum.findings).toEqual({ must: 2, should: 1 })
    expect(sum.progress.filesChanged).toBe(2)
    expect(sum.progress.costUsd).toBeGreaterThan(0)
    for (const key of ['plan', 'implement', 'review', 'critic', 'fix'] as const) {
      const row = sum.steps.find((x) => x.key === key)
      expect(row, key).toMatchObject({
        status: 'done',
        vendor: 'claude',
        costBasis: 'vendor',
        inBytesBucket: 0,
      })
      expect(row?.activeMs, key).toBeGreaterThanOrEqual(0)
      expect(row?.usage?.output, key).toBeGreaterThan(0)
    }
    expect(sum.steps.find((x) => x.key === 'review')).toMatchObject({ model: 'sonnet', mode: 'readonly' })
    expect(sum.steps.find((x) => x.key === 'critic')).toMatchObject({ model: 'opus', mode: 'readonly' })
    expect(snap.value.steps.fix.cost).toMatchObject({ basis: 'vendor', apiEquivalent: true })
    expect(snap.value.steps.fix.sessionNote).toBe('reused the Implement session')

    // Every usage body is labelled; the bus seqs stay gap-free.
    const mine = t.events.filter((e) => e.runId === t.runId)
    expect(mine.map((e) => e.seq)).toEqual(mine.map((_, i) => (mine[0]?.seq ?? 0) + i))
    const usage = mine.flatMap((e) => (e.body.t === 'usage' ? [e.body] : []))
    expect(usage.map((u) => u.step).sort()).toEqual(['critic', 'fix', 'implement', 'plan', 'review'])
    expect(new Set(usage.map((u) => u.costBasis))).toEqual(new Set(['vendor']))
    // The user's repo: only the run's two files, untracked.
    expect(existsSync(join(t.folder, 'src', 'version.test.ts'))).toBe(true)
  }, 120_000)

  it('two NO FINDINGS → Fix is skipped and the run completes clean', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
    })
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(10_000)
    expect(done.status).toBe('completed')
    expect(done.outcome).toBe('clean')
    expect(done.steps.review.status).toBe('done')
    expect(done.steps.critic.status).toBe('done')
    expect(done.steps.fix).toMatchObject({ status: 'skipped', reason: 'no findings', attempt: 0 })
    expect(done.findings?.sources.review?.status).toBe('none')
    expect(done.findings?.sources.critic?.status).toBe('none')
    // Nothing was spawned for Fix.
    const argvs = passArgvs(t.sc.entries())
    expect(argvs.filter((a) => a.includes('acceptEdits'))).toHaveLength(1)
    expect(argvs.filter((a) => a.includes('dontAsk'))).toHaveLength(2)
    const ff = JSON.parse(
      readFileSync(join(t.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    expect(ff.findings).toEqual([])
    const sum = t.core.summary(t.runId)
    expect(sum?.findings).toEqual({ must: 0, should: 0 })
    expect(sum?.steps.find((x) => x.key === 'fix')).toBeUndefined()
    // resolved.json records the prices the run's passes would be costed with (seed pricing).
    const resolved = JSON.parse(readFileSync(join(t.home, 'runs', t.runId, 'resolved.json'), 'utf8')) as {
      pricingRef: { entries: { requested: string; model: string; confidence: string }[]; missing: string[] }
    }
    expect(resolved.pricingRef.entries.map((e) => e.requested)).toEqual(
      expect.arrayContaining(['opus', 'sonnet']),
    )
    expect(resolved.pricingRef.entries.find((e) => e.requested === 'opus')).toMatchObject({
      model: 'claude-opus-5-5',
      confidence: 'unverified',
    })
  }, 120_000)

  it('Implement that changes nothing → completed(no-changes); Review, Critic and Fix never run', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement' }],
    })
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('no-changes')
    for (const k of ['review', 'critic', 'fix'] as const) {
      expect(done.steps[k]).toMatchObject({ status: 'skipped', reason: 'no changes' })
    }
    expect(passArgvs(t.sc.entries()).filter((a) => a.includes('dontAsk'))).toEqual([])
    expect(existsSync(join(t.home, 'runs', t.runId, 'findings.json'))).toBe(false)
  }, 120_000)

  it('the resumed Fix reports its own usage: the delta against Implement’s totals, vendor-reported (C08a → C08b)', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      resume: [{ recording: 'C08b-resume-fix', write: fixWrite }],
    })
    const done = await t.c.waitFor(settled, 60_000)
    await t.c.settle(10_000)
    expect(done.outcome).toBe('fixed')
    const a = cumulative('C08a-session-id-implement')
    const b = cumulative('C08b-resume-fix')
    const delta = {
      input: b.input - a.input,
      output: b.output - a.output,
      cacheRead: (b.cacheRead ?? 0) - (a.cacheRead ?? 0),
      cacheWrite: (b.cacheWrite ?? 0) - (a.cacheWrite ?? 0),
    }
    const fix = done.steps.fix
    expect(fix.usageApprox).toBeUndefined()
    expect(fix.usage).toMatchObject(delta)
    expect(fix.usage?.costUsd).toBeCloseTo((b.costUsd ?? 0) - (a.costUsd ?? 0), 9)
    expect(fix.cost).toMatchObject({ basis: 'vendor', apiEquivalent: true })
    expect(fix.cost?.usd).toBeCloseTo((b.costUsd ?? 0) - (a.costUsd ?? 0), 9)
    // Implement's own usage is its full first session (a fresh session's totals are its delta).
    expect(done.steps.implement.usage).toMatchObject({ input: a.input, output: a.output })
    const fixUsage = t.events.find((e) => e.body.t === 'usage' && e.body.step === 'fix')?.body
    expect(fixUsage).toMatchObject({ t: 'usage', step: 'fix', costBasis: 'vendor', usage: delta })
    // The session's totals are the base the next resume would subtract.
    expect(done.sessions[fix.sessionId ?? '']?.lastTotals).toMatchObject({ input: b.input, output: b.output })
  }, 120_000)

  it('a failed reviewer fails the run; the survivor finishes and its findings are kept', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
      review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      critic: [{ recording: 'C09b-logged-out' }],
      resume: [{ recording: 'C08b-resume-fix', write: fixWrite }],
    })
    const failed = await t.c.waitFor((s) => s.status === 'failed' && s.steps.review.status === 'done', 60_000)
    await t.c.settle(10_000)
    const s = t.c.state
    expect(s.status).toBe('failed')
    expect(s.phase).toBe('needs-attention')
    expect(s.failure).toEqual({ step: 'critic', category: 'auth_required' })
    expect(s.steps.critic.status).toBe('failed')
    expect(s.steps.fix.status).toBe('queued')
    expect(failed.findings?.sources.review?.findings.map((f) => f.severity)).toEqual([
      'must',
      'must',
      'should',
    ])
    const sum = t.core.summary(t.runId)
    expect(sum?.findings).toEqual({ must: 2, should: 1 })
    expect(sum?.failure).toEqual({ step: 'critic', category: 'auth_required' })
    expect(sum?.steps.find((x) => x.key === 'critic')?.failureCategory).toBe('auth_required')
    // Nothing was fixed: no Fix process.
    expect(passArgvs(t.sc.entries()).some((a) => a.some((x) => x.startsWith('--resume=')))).toBe(false)
    // Continue without Critic: the join decides with the survivor's findings → Fix → fixed.
    const after = await continueWithout(t, 'critic')
    expect(after.steps.critic).toMatchObject({ status: 'skipped', reason: 'user' })
    expect(after.outcome).toBe('fixed')
    expect(userMessage(t.sc, 'resume-1.script.jsonl')).toContain('- [must] F1 (review)')
  }, 120_000)

  it('an empty Review twice opens the emptyFindings card; Treat as no findings completes clean', async () => {
    const t = await start({
      plan: { recording: 'C06-plan-native-host' },
      implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
      review: [
        { recording: 'C02-review-shape', text: '' },
        { recording: 'C02-review-shape', text: '' },
      ],
    })
    const waiting = await t.c.waitFor(
      (s) => s.cards.some((x) => x.view.kind === 'emptyFindings') || settled(s),
      60_000,
    )
    const c = card(waiting, 'emptyFindings')
    expect(c.choices.map((x) => x.id)).toEqual(['retry', 'treat-as-none'])
    expect(waiting.steps.review).toMatchObject({ status: 'waiting', attempt: 2, autoRetryUsed: true })
    expect(waiting.status).toBe('waiting')
    // The automatic retry spawned Review a second time (fresh, read-only).
    expect(
      passArgvs(t.sc.entries()).filter((a) => a.includes('sonnet') && a.includes('dontAsk')),
    ).toHaveLength(2)
    const r = await t.core.invoke('cards.resolve', {
      runId: t.runId,
      cardId: c.id,
      choiceId: 'treat-as-none',
    })
    expect(r.ok).toBe(true)
    const done = await t.c.waitFor(settled, 60_000)
    expect(done.outcome).toBe('clean')
    expect(done.findings?.sources.review).toMatchObject({ status: 'none', treatedAsNone: true })
    expect(done.steps.review.reason).toBe('empty output treated as no findings')
  }, 120_000)
})

/** Continue without a failed reviewer (P23), then let the run finish. */
async function continueWithout(t: Started, pass: 'review' | 'critic'): Promise<RunState> {
  const r = await t.core.invoke('runs.skipPass', { runId: t.runId, pass })
  if (!r.ok) throw new Error(r.error.message)
  const s = await t.c.waitFor(
    (x) => (x.status === 'completed' || x.status === 'cancelled') && x.outcome !== undefined,
    60_000,
  )
  await t.c.settle(10_000)
  return s
}
