// Adaptive depth, quieter reviews and continuity through a real core and the fake Claude, with the shipped defaults
// (depth `auto`, findings with evidence to Fix, Implement continuing Plan's session):
//   - a Quick run whose checks pass: no Plan, Implement on direct.md, one review with a suggestion only, no Fix: clean
//   - a Quick run whose check fails: thorough checks (the Critic joins), Fix runs, verify:2 passes: fixed
//   - a Thorough run: Plan keeps its session and Implement resumes it in its own mode (`--resume=<plan session>`)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { grantTrust } from '../../../src/core/config/trust.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario, passArgvs } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'
import { CHECK, CHECK_SCRIPT, value, version } from '../verify/helpers.ts'

const cores: Core[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

const TASK = 'add a --version flag'

interface Started {
  core: Core
  c: RunController
  runId: string
  home: string
  folder: string
  sc: Scenario
}

async function start(spec: ScenarioSpec, overrides: Record<string, unknown>): Promise<Started> {
  const sc = await makeScenario(spec)
  // The shipped defaults: depth auto, quieter reviews, continuity.
  const { home } = await makeHome(sc, undefined, { pipeline: 'defaults' })
  const folder = makeSandbox()
  writeFileSync(join(folder, 'check.mjs'), CHECK_SCRIPT)
  dirs.push(home, sc.dir, folder)
  await grantTrust(
    folder,
    { kind: 'command', command: { kind: 'verify', argv: [...CHECK.run], cwdRel: '.' } },
    { home },
  )
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  const { runId } = value(await core.invoke('runs.start', { folder, task: TASK, overrides }))
  const c = core.controller(runId)
  if (c === undefined) throw new Error('no controller')
  // Every ask is allowed, as a user would (the recordings' shell asks).
  c.subscribe((s) => {
    for (const st of Object.values(s.steps))
      for (const a of st.asks)
        void core.invoke('asks.answer', { runId, requestId: a.requestId, decision: 'allow', graceMs: 0 })
  })
  return { core, c, runId, home, folder, sc }
}

/** The prompt a spawn was sent (runs/<id>/prompts/<step>-<n>.md). */
function prompt(t: Started, step: string): string {
  const dir = join(t.home, 'runs', t.runId, 'prompts')
  const file = readdirSync(dir).find((f) => f.startsWith(`${step}-`))
  if (file === undefined) throw new Error(`no ${step} prompt`)
  return readFileSync(join(dir, file), 'utf8')
}

const verifyOn = {
  gates: { afterPlan: false, beforeFix: false },
  verify: { enabled: true, commands: [CHECK] },
}

describe('Quick by default for a small change', () => {
  it('checks pass and the review has only a suggestion: no Plan, no Critic, no Fix, clean', async () => {
    const t = await start(
      {
        implement: [{ recording: 'C08a-session-id-implement', write: version('1.0.0') }],
        review: [
          { recording: 'C02-review-shape', text: '- [should] The flag could have a clearer help text.' },
        ],
      },
      verifyOn,
    )
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(10_000)
    expect(done.config.depth).toMatchObject({ depth: 'direct', source: 'auto' })
    expect(done.steps.plan.status).toBe('skipped')
    expect(done.steps.critic.status).toBe('skipped')
    expect(done.steps['verify:1'].status).toBe('done')
    expect(done.steps.review.status).toBe('done')
    expect(done.steps.fix).toMatchObject({ status: 'skipped', reason: 'nothing with evidence' })
    expect(done.outcome).toBe('clean')
    // Implement got the user's task as it is (direct.md), not the plan-following wrapper.
    const text = prompt(t, 'implement')
    expect(text.startsWith(`${TASK}\n`)).toBe(true)
    expect(text).not.toMatch(/Stay within the plan's scope/)
    // The frozen config has the Quick shape (Re-run takes it as it is).
    const resolved = JSON.parse(readFileSync(join(t.home, 'runs', t.runId, 'resolved.json'), 'utf8')) as {
      config: {
        depth?: string
        passes: { plan: { enabled: boolean }; implement: { promptTemplate: { name: string } } }
      }
      depth?: { depth: string }
    }
    expect(resolved.config.depth).toBe('direct')
    expect(resolved.config.passes.plan.enabled).toBe(false)
    expect(resolved.config.passes.implement.promptTemplate.name).toBe('direct')
    expect(resolved.depth?.depth).toBe('direct')
  }, 180_000)

  it('a failing check: thorough checks (the Critic joins), Fix runs, verify:2 passes: fixed', async () => {
    const t = await start(
      {
        implement: [{ recording: 'C08a-session-id-implement', write: version('0.1.0') }],
        resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0') }],
        fix: [{ recording: 'C03-accept-edits', write: version('1.0.0') }],
      },
      verifyOn,
    )
    const done = await t.c.waitFor(settled, 180_000)
    await t.c.settle(10_000)
    expect(done.config.depth).toMatchObject({ depth: 'direct', escalated: 'check' })
    expect(done.notes.some((n) => n.startsWith('A check failed (check), so this Quick run switched'))).toBe(
      true,
    )
    expect(done.steps.critic.status).toBe('done')
    expect(done.steps.fix.status).toBe('done')
    expect(done.steps['verify:2'].status).toBe('done')
    expect(done.outcome).toBe('fixed')
  }, 240_000)
})

describe('continuity: Implement continues Plan’s session', () => {
  it('Thorough on one vendor: Plan keeps its session, Implement resumes it with acceptEdits', async () => {
    const t = await start(
      {
        plan: { recording: 'C06-plan-native-host' },
        resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0') }],
      },
      { depth: 'full', gates: { afterPlan: false, beforeFix: false } },
    )
    const done = await t.c.waitFor(settled, 180_000)
    await t.c.settle(10_000)
    expect(done.config.depth).toMatchObject({ depth: 'full', source: 'chosen' })
    const planSession = done.steps.plan.sessionId ?? ''
    expect(planSession).not.toBe('')
    const argvs = passArgvs(t.sc.entries())
    const plan = argvs.find((a) => a.includes('plan'))
    expect(plan).toBeDefined()
    expect(plan).not.toContain('--no-session-persistence')
    const resumed = argvs.filter((a) => a.some((x) => x.startsWith('--resume=')))
    expect(resumed[0]).toContain(`--resume=${planSession}`)
    expect(resumed[0]).toContain('acceptEdits')
    expect(done.steps.implement).toMatchObject({ status: 'done', sessionNote: 'continued the Plan session' })
    // Implement's resumed turn still gets its full prompt (the plan as decided).
    expect(prompt(t, 'implement')).toContain('Implement the following task')
  }, 240_000)
})
