// Guardrails through a whole run: real core, real adapter, real spawn and a real shadow, with the fake Claude breaking the
// rules. A settings file a run writes is gone with no outside-edit card, a rule that says stop ends the run with its other
// work kept, a rule that says ask waits for the user, and a hard rule stops a run before it creates anything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../src/core/app-core.ts'
import type { Core } from '../../../src/core/app-core.ts'
import type { GuardrailRule } from '../../../src/shared/guardrails.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { bodies, settled } from '../attention/helpers.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from './scenario.ts'
import type { ScenarioSpec } from './scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

interface Boot {
  core: Core
  folder: string
  events: RunEnvelope[]
}

async function boot(spec: ScenarioSpec, o: { user?: GuardrailRule[]; project?: object } = {}): Promise<Boot> {
  const sc = await makeScenario(spec)
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  if (o.user !== undefined) {
    const file = join(home, 'dimfactory.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...cfg, guardrails: { rules: o.user } }))
  }
  if (o.project !== undefined) {
    mkdirSync(join(folder, '.dimfactory'), { recursive: true })
    writeFileSync(join(folder, '.dimfactory', 'dimfactory.json'), JSON.stringify(o.project))
  }
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv({}) })
  cores.push(core)
  const events: RunEnvelope[] = []
  core.bus.attach({ name: 't', run: (e) => events.push(e) })
  return { core, folder, events }
}

const start = (b: Boot, overrides: object = { gates: { afterPlan: false } }) =>
  b.core.invoke('runs.start', { folder: b.folder, task: 'add a --version flag', overrides })

const script = (write: { path: string; content: string }): ScenarioSpec => ({
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write }],
})

describe('guardrails in a run', () => {
  it('puts back a settings file a run wrote, with no card, and carries on', async () => {
    const b = await boot(script({ path: '.claude/settings.json', content: '{"permissions":{}}\n' }))
    const r = await start(b)
    if (!r.ok) throw new Error(r.error.message)
    const c = b.core.controller(r.value.runId)
    const end = await c?.waitFor(settled, 150_000)
    expect(end?.status).toBe('completed')
    expect(existsSync(join(b.folder, '.claude/settings.json'))).toBe(false)
    const [fired] = bodies(b.events, 'guardrail')
    expect(fired).toMatchObject({ step: 'implement', undone: true })
    expect(fired?.finding.self).toBe(true)
    expect(end?.guardrails).toMatchObject({ fired: 1, undone: 1, stopped: false })
    // Review and Fix are told it was put back on purpose.
    expect(end?.guardrails?.refused).toEqual([
      "Dim Factory's guardrail put back a change to .claude/settings.json (Settings files); this was on purpose, so do not report its absence as a finding.",
    ])
    // Put back before the end snapshot, so it never reads as an edit from outside the run.
    expect(bodies(b.events, 'card').filter((x) => x.card.kind === 'reconcile')).toEqual([])
    expect(end?.notes.some((n) => n.includes('Settings files'))).toBe(true)
  }, 200_000)

  it('stops the run when a rule says stop, keeping what it made', async () => {
    const b = await boot(script({ path: 'src/x.ts', content: 'export const x = 1\n' }), {
      user: [{ kind: 'protectedFiles', paths: ['src/x.ts'], onBreak: 'stop' }],
    })
    const r = await start(b)
    if (!r.ok) throw new Error(r.error.message)
    const end = await b.core.controller(r.value.runId)?.waitFor(settled, 150_000)
    expect(end?.status).toBe('cancelled')
    expect(end?.guardrails?.stopped).toBe(true)
    expect(existsSync(join(b.folder, 'src/x.ts'))).toBe(true)
    expect(bodies(b.events, 'guardrail')[0]?.finding.kind).toBe('protectedFiles')
  }, 200_000)

  it('asks when a rule says ask, and goes on once answered', async () => {
    const b = await boot(script({ path: 'src/x.ts', content: 'export const x = 1\n' }), {
      user: [{ kind: 'protectedFiles', paths: ['src/x.ts'], onBreak: 'ask' }],
    })
    const r = await start(b)
    if (!r.ok) throw new Error(r.error.message)
    const c = b.core.controller(r.value.runId)
    const waiting = await c?.waitFor(
      (s) => s.cards.some((k) => k.view.kind === 'reconcile') || settled(s),
      150_000,
    )
    const card = waiting?.cards.find((k) => k.view.kind === 'reconcile')
    expect(card?.view.choices.map((x) => x.label)).toEqual(['Keep going', 'Stop run'])
    expect(existsSync(join(b.folder, 'src/x.ts'))).toBe(true)
    await b.core.invoke('cards.resolve', {
      runId: r.value.runId,
      cardId: card?.view.id ?? '',
      choiceId: card?.view.choices[0]?.id ?? '',
    })
    expect((await c?.waitFor(settled, 150_000))?.status).toBe('completed')
  }, 200_000)

  it('asks before going on when a run weakens a test', async () => {
    const b = await boot(script({ path: 'src/a.test.ts', content: "it.skip('x', () => {})\n" }))
    const r = await start(b)
    if (!r.ok) throw new Error(r.error.message)
    const c = b.core.controller(r.value.runId)
    const waiting = await c?.waitFor(
      (s) => s.cards.some((k) => k.view.kind === 'reconcile') || settled(s),
      150_000,
    )
    expect(waiting?.guardrails?.fired).toBe(1)
    expect(waiting?.cards.some((k) => k.view.kind === 'reconcile')).toBe(true)
    expect(existsSync(join(b.folder, 'src/a.test.ts'))).toBe(true)
  }, 200_000)

  it('refuses a run a hard rule rules out, creating nothing', async () => {
    const b = await boot({}, { user: [{ kind: 'noFullAccess' }] })
    const r = await start(b, { auto: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
    expect(JSON.stringify(r.error.details)).toContain('No Approve everything')
  }, 120_000)

  it('does not let a project file lower your rules', async () => {
    const b = await boot(script({ path: 'src/x.ts', content: 'export const x = 1\n' }), {
      user: [{ kind: 'noFullAccess' }],
      project: { guardrails: { preset: 'off', rules: [] } },
    })
    const r = await start(b, { auto: true })
    expect(r.ok).toBe(false)
  }, 120_000)

  it('refuses a run whose rule requires more than the AI tool can give', async () => {
    const b = await boot({}, { user: [{ kind: 'privateFiles', paths: ['.env*'], require: 'sandboxed' }] })
    const r = await start(b)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
    expect(JSON.stringify(r.error.details)).toContain('With claude it can only be blocked')
  }, 120_000)

  it('records in trust.json when your guardrails are loosened, and not when they are tightened', async () => {
    const b = await boot({}, { user: [{ kind: 'privateFiles', paths: ['.env*'] }] })
    const patch = (path: string, value: unknown) =>
      b.core.invoke('config.patch', { scope: 'user', ops: [{ op: 'replace', path, value }] })
    expect((await patch('/guardrails/preset', 'strict')).ok).toBe(true)
    let state = await b.core.invoke('guardrails.state', undefined)
    expect(state.ok && state.value.loosened).toEqual([])
    expect((await patch('/guardrails/preset', 'off')).ok).toBe(true)
    expect((await patch('/guardrails/rules', [])).ok).toBe(true)
    state = await b.core.invoke('guardrails.state', undefined)
    if (!state.ok) throw new Error(state.error.message)
    expect(state.value.loosened.map((l) => l.what)).toEqual([
      'Preset lowered from Strict to Off',
      'Removed Private files: .env*',
    ])
    expect(state.value.proofs).toEqual([])
  }, 120_000)
})
