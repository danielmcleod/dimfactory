// "A second identical ask is auto-answered in-process and in the next process" (Allow for this run: the Claude
// adapter's allow-session + allow-cache, AllowRule.nativeRules → `--allowedTools`), with the answer given from a
// desktop notification and the "AUTO approved N" count:
//   - Allow for this run on C04a's first `npm --version` ask (via notification) persists the vendor's rule
//   - the identical second ask never reaches the user: the adapter's allow-cache answers it (`auto-answered`)
//   - Fix, the run's next process (resuming Implement's session), starts with `--allowedTools Bash(npm --version)`
//   - the rule never leaves the run: another run's Implement starts without it
import { afterEach, describe, expect, it } from 'vitest'
import type { RunSnapshot } from '../../../src/shared/run.ts'
import { REVIEW_WITH_FINDINGS, makeSandbox, passArgvs } from '../run/scenario.ts'
import { bodies, fixWrite, implementAsk, settled, start, teardown, track, versionWrite } from './helpers.ts'

afterEach(teardown)

const allowedTools = (argv: readonly string[]): string | undefined => {
  const i = argv.indexOf('--allowedTools')
  return i >= 0 ? argv[i + 1] : undefined
}

describe('Allow for this run (core + fake Claude)', () => {
  it('in-process: allow-cache answers the second identical ask; next process: --allowedTools; never another run', async () => {
    const t = await start(
      {
        plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
        implement: [
          { recording: 'C04a-ask-allow', write: versionWrite },
          { recording: 'C08a-session-id-implement', write: versionWrite },
        ],
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
        resume: [{ recording: 'C08b-resume-fix', write: fixWrite }],
      },
      { overrides: { gates: { afterPlan: false, beforeFix: false } } },
    )
    const { requestId, expiresAt } = await implementAsk(t.c)

    // The notification facts the host presents for this ask.
    const note = t.notes.find((n) => n.kind === 'ask' && n.requestId === requestId)
    expect(note?.run).toEqual({
      runId: t.runId,
      displayNo: 1,
      title: 'add a --version flag',
      folder: t.c.state.folder,
      auto: false,
    })
    expect(note?.ask).toEqual(
      expect.objectContaining({
        requestId,
        step: 'implement',
        vendor: 'claude',
        vendorName: 'Claude',
        kind: 'shell',
        detail: 'Bash: npm --version',
        expiresAt,
        allowSession: true,
        waiting: 1,
      }),
    )

    const r = await t.core.answerAsk({ runId: t.runId, requestId, decision: 'allow-session' })
    expect(r.ok).toBe(true)
    expect(bodies(t.events, 'ask-resolved')).toContainEqual(
      expect.objectContaining({ requestId, via: 'notification', decision: 'allow-session', by: 'user' }),
    )
    const rule = {
      vendor: 'claude',
      kind: 'shell',
      tool: 'Bash',
      match: { argv: ['npm', '--version'] },
      nativeRules: ['Bash(npm --version)'],
      source: 'vendor-suggestion',
    }
    await t.c.waitFor((s) => s.allowRules.length > 0, 30_000)
    expect(t.c.state.allowRules).toEqual([rule])

    const end = await t.c.waitFor(settled, 150_000)
    expect(end.status).toBe('completed')
    expect(end.outcome).toBe('fixed')

    // In-process: the second `npm --version` was answered by the adapter, never raised to the user.
    const own = t.events.filter((e) => e.runId === t.runId)
    const auto = bodies(own, 'auto-answered').filter((b) => b.step === 'implement')
    expect(auto).toEqual([
      expect.objectContaining({ step: 'implement', decision: 'allow', why: 'allow-cache', tool: 'Bash' }),
    ])
    const raised = bodies(own, 'ev').filter((b) => b.ev.type === 'ask')
    expect(raised.map((b) => b.step)).toEqual(['implement'])
    expect(t.notes.filter((n) => n.kind === 'ask')).toHaveLength(1)
    // "AUTO approved N" comes from core.
    const snap = await t.core.invoke('runs.get', { runId: t.runId })
    expect(snap.ok).toBe(true)
    const v = (snap as { ok: true; value: RunSnapshot }).value
    expect(v.autoAnswered).toEqual({ approved: 1, denied: 0 })
    expect(v.steps.implement.autoAnswered).toEqual({ approved: 1, denied: 0 })
    expect(v.allowRules).toEqual([rule])

    // The next process of the run: Fix resumes Implement's session with the rule as --allowedTools.
    const argvs = passArgvs(t.sc.entries())
    const implement = argvs.find(
      (a) => a.includes('acceptEdits') && !a.some((x) => x.startsWith('--resume=')),
    )
    const fix = argvs.find((a) => a.some((x) => x.startsWith('--resume=')))
    expect(implement).toBeDefined()
    expect(allowedTools(implement ?? [])).toBeUndefined()
    expect(fix).toContain(`--resume=${end.steps.implement.sessionId ?? ''}`)
    expect(allowedTools(fix ?? [])?.split(',')).toContain('Bash(npm --version)')
    // Read-only passes never get it (they run with no permission host).
    for (const a of argvs.filter((x) => x.includes('dontAsk'))) expect(allowedTools(a)).toBeUndefined()

    // Rules never leave the run: a second run's Implement starts without them.
    const folder2 = makeSandbox()
    track(folder2)
    const second = await t.core.invoke('runs.start', {
      folder: folder2,
      task: 'add a --version flag',
      overrides: { gates: { afterPlan: false, beforeFix: false } },
    })
    if (!second.ok) throw new Error(second.error.message)
    const c2 = t.core.controller(second.value.runId)
    const end2 = await c2?.waitFor(settled, 150_000)
    expect(end2?.status).toBe('completed')
    expect(end2?.allowRules).toEqual([])
    const impl2 = passArgvs(t.sc.entries()).filter(
      (a) => a.includes('acceptEdits') && !a.some((x) => x.startsWith('--resume=')),
    )[1]
    expect(impl2).toBeDefined()
    expect(allowedTools(impl2 ?? [])).toBeUndefined()
  }, 300_000)
})
