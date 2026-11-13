// Runs with Gemini through a real core ("live Gemini native Plan captured; read-only Review raises zero asks" at
// the engine level; the "Gemini ACP" mode mapping: readonly = `default` + the adapter rejects every ask, native
// Plan = `plan` + exit_plan_mode auto-rejected and captured; the permission order; the ACP session id comes "from
// the session/new response, before session/prompt" and decideSession; trust.json `vendorFolder`):
//   - Gemini's native Plan: the pass starts native and read-only in the trusted folder; the captured plan is the plan
//   - Gemini Review (read-only): the agent's permission requests are rejected by the adapter, so the run raises zero
//     asks (none in the log, none pending, nothing for the user); the auto-answers are counted as denied
//   - Gemini Implement: no made-up session id; the ACP session id is in run.json before the prompt goes out
//   - Fix on Gemini resumes that session when the agent advertised load ("reused the Implement session"); an agent
//     that advertises neither load nor resume starts Fix fresh, "the session cannot be resumed"
import { afterEach, describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import { REVIEW_WITH_FINDINGS } from '../../run/scenario.ts'
import { ScriptedGemini, World, asksIn, geminiPlays, runJsonOnDisk, settled, value } from './helpers.ts'

const w = new World()
afterEach(() => w.dispose())

const PLAN_MD = '## Goal\nAdd a --version flag.\n\n## Steps\n1. Edit `src/cli.ts` (edit)\n'
const IMPLEMENT = {
  recording: 'C08a-session-id-implement',
  write: { path: 'src/version.ts', content: 'x\n' },
}

describe('Gemini native Plan and a read-only Gemini Review (zero asks)', () => {
  it('Plan captured from exit_plan_mode; Review rejects every request itself; the run completes clean', async () => {
    const gemini = new ScriptedGemini(
      geminiPlays([
        { plan: PLAN_MD },
        {
          text: 'NO FINDINGS',
          asks: [
            { toolCallId: 'call-1', tool: 'run_shell_command', title: 'npm test' },
            { toolCallId: 'call-2', tool: 'replace', title: 'src/cli.ts' },
          ],
        },
      ]),
    )
    const t = await w.boot({ implement: [IMPLEMENT] }, gemini, { trust: true })
    const { runId, c } = await w.start(t, {
      profile: 'claude-only',
      gates: { afterPlan: false },
      passes: { plan: { vendor: 'gemini', model: null }, review: { vendor: 'gemini', model: null } },
    })
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)

    expect(done.status).toBe('completed')
    expect(gemini.starts.map((s) => s.step)).toEqual(['plan', 'review'])
    const [plan, review] = gemini.starts as [StartOptions, StartOptions]
    // Native plan mode, read-only, in the folder the user trusted for Gemini (--skip-trust only then).
    expect(plan).toMatchObject({ step: 'plan', mode: 'readonly', planNative: true, trustFolder: true })
    expect(review).toMatchObject({ step: 'review', mode: 'readonly', planNative: false, trustFolder: true })
    expect(done.steps.plan).toMatchObject({ status: 'done', vendor: 'gemini', planMode: 'native' })
    expect(done.plan.text?.trim()).toBe(PLAN_MD.trim())

    // Zero asks: none raised, none pending, nothing waiting on the user; both requests were rejected by the adapter.
    expect(asksIn(t.events)).toEqual([])
    expect(done.steps.review.status).toBe('done')
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.asks).toEqual([])
    expect(snap.steps.review.autoAnswered).toEqual({ approved: 0, denied: 2 })
    const auto = t.events.map((e) => e.body).filter((b) => b.t === 'auto-answered' && b.step === 'review')
    expect(auto.map((b) => (b.t === 'auto-answered' ? [b.decision, b.why] : null))).toEqual([
      ['deny', 'readonly'],
      ['deny', 'readonly'],
    ])
    expect(done.outcome).toBe('clean')
  }, 180_000)
})

describe('Fix on Gemini after a Gemini Implement', () => {
  const SPEC = {
    plan: { recording: 'C06-plan-native-host' },
    review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
  }
  const OVERRIDES = {
    profile: 'claude-only',
    gates: { afterPlan: false },
    passes: { implement: { vendor: 'gemini', model: null } },
  }

  it('resumes the ACP session Implement left (persisted before the prompt); the card says so', async () => {
    let home = ''
    const persisted: { step: string; onDisk: string | undefined }[] = []
    const gemini = new ScriptedGemini(
      geminiPlays([{ file: 'src/version.ts', text: 'Added --version.' }, { file: 'src/version.test.ts' }], {
        session: () => 'gem-sess-implement',
        seen: (o) => {
          if (o.step === 'implement')
            persisted.push({ step: o.step, onDisk: runJsonOnDisk(home, o.runId).steps.implement.sessionId })
        },
      }),
    )
    const t = await w.boot(SPEC, gemini, { trust: true })
    home = t.home
    const { c } = await w.start(t, OVERRIDES)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)

    expect(done.status).toBe('completed')
    expect(done.config.passes.fix.vendor).toBe('gemini')
    const [impl, fix] = gemini.starts
    expect(gemini.starts.map((s) => s.step)).toEqual(['implement', 'fix'])
    // ACP assigns the id (session/new): none is made up; it is durable in run.json before session/prompt.
    expect(impl?.sessionId).toBeUndefined()
    expect(impl).toMatchObject({ mode: 'autoedit', trustFolder: true, cwd: t.folder })
    expect(persisted).toEqual([{ step: 'implement', onDisk: 'gem-sess-implement' }])
    expect(done.steps.implement).toMatchObject({
      status: 'done',
      vendor: 'gemini',
      sessionId: 'gem-sess-implement',
    })
    // Fix: session/load of the same id (canResume asked in the folder the session ran in).
    expect(fix?.resume?.sessionId).toBe('gem-sess-implement')
    expect(fix?.sessionId).toBeUndefined()
    expect(fix).toMatchObject({ mode: 'autoedit', trustFolder: true })
    expect(gemini.canResumeCalls).toEqual([{ sessionId: 'gem-sess-implement', cwd: t.folder }])
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      vendor: 'gemini',
      sessionId: 'gem-sess-implement',
      sessionNote: 'reused the Implement session',
    })
    expect(fix?.prompt).toContain('--version prints nothing')
  }, 180_000)

  it('an agent that advertises neither load nor resume: Fix starts fresh and the card says why', async () => {
    const gemini = new ScriptedGemini(
      geminiPlays([{ file: 'src/version.ts' }, { file: 'src/version.test.ts' }]),
      {
        resume: 'none',
      },
    )
    const t = await w.boot(SPEC, gemini, { trust: true })
    const { runId, c } = await w.start(t, OVERRIDES)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status).toBe('completed')
    const fix = gemini.starts[1]
    expect(fix?.step).toBe('fix')
    expect(fix?.resume).toBeUndefined()
    expect(done.steps.fix.sessionNote).toBe('fresh session: the session cannot be resumed')
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.fix.freshDetail).toBe('vendor-cannot-resume')
  }, 180_000)

  it('Fix on Claude after a Gemini Implement: "Fix vendor differs" (never another vendor’s session)', async () => {
    const gemini = new ScriptedGemini(geminiPlays([{ file: 'src/version.ts' }]))
    const t = await w.boot({ ...SPEC, fix: [{ recording: 'C08a-session-id-implement' }] }, gemini, {
      trust: true,
    })
    const { c } = await w.start(t, {
      ...OVERRIDES,
      passes: { ...OVERRIDES.passes, fix: { vendor: 'claude', model: null, mode: 'autoedit' } },
    })
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(gemini.starts.map((s) => s.step)).toEqual(['implement'])
    expect(done.steps.fix).toMatchObject({
      vendor: 'claude',
      sessionNote: 'fresh session: Fix vendor differs',
    })
  }, 180_000)
})
