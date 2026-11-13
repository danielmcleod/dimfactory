// Acceptance criteria and the acceptance review in the state machine (the reducer only; the drivers play the
// controller):
//   - the decided plan's `## Acceptance criteria` (its gate's edits included) become AC1…ACn, written as acceptance.json
//   - without criteria the review is skipped with a note, and the reviewers start as before
//   - with Fix until green: unmet criteria are [must] findings joined with the reviewers', Fix gets them, the round's
//     re-check confirms them, and the checklist reads them met ("Re-check: resolved in round 1.")
//   - without it: a summary note only, no findings, the outcome unchanged
//   - the review runs on Review's config (read-only), Critic's then Plan's when Review is off
//   - stop and relaunch during the review
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@shared/events.ts'
import type { AgentStep } from '@shared/run.ts'
import { acceptanceSummaryText } from '@shared/acceptance.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { buildPrompt, startOptionsFor } from '@core/supervisor/effects.ts'
import { ACCEPTANCE_NOTE, SKIP_REASON, fixSkipRuleHolds } from '@core/supervisor/machine.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import type { Reduction, RunConfig } from '@core/supervisor/types.ts'
import { Flow, reviewConfig } from '../supervisor/helpers.review.ts'
import { makeRun, okReport } from '../supervisor/helpers.ts'
import { VFlow } from '../verify/machine-helpers.ts'
import { initRerunFromFix } from '@core/supervisor/rerun-state.ts'
import { rerunInit } from '../rerun/helpers.ts'

export const PLAN_AC = [
  '## Goal',
  'Add a todo list.',
  '',
  '## Steps',
  '1. Edit `src/todo.ts` (edit)',
  '',
  '## Acceptance criteria',
  '- Adding an item shows it in the list',
  '- [ ] Completed items can be cleared',
  '',
  '## Risks',
  '- none',
].join('\n')

export const ANSWER_MET_UNMET = JSON.stringify({
  verdicts: [
    { id: 'AC1', status: 'met', evidence: 'src/todo.ts addItem; tests/todo.test.ts passes' },
    { id: 'AC2', status: 'not-met', evidence: 'no clear action in src/todo.ts' },
  ],
})

interface AOptions {
  acceptance?: boolean
  loop?: boolean
  review?: boolean
  critic?: boolean
  plan?: string
}

export function acceptanceConfig(o: AOptions = {}): RunConfig {
  const c = reviewConfig({ review: o.review ?? true, critic: o.critic ?? false, fix: true, beforeFix: false })
  if (o.acceptance !== false) c.acceptance = true
  if (o.loop === true) c.fixLoop = { rounds: 2, recheck: true }
  return c
}

export class AFlow extends Flow {
  planText: string

  constructor(o: AOptions = {}) {
    super({ review: o.review ?? true, critic: o.critic ?? false, fix: true, beforeFix: false })
    this.state = makeRun(acceptanceConfig(o))
    this.planText = o.plan ?? PLAN_AC
  }

  override toImplementRunning(o: { session?: boolean } = {}): this {
    this.toPlanGate(this.planText)
    this.approve()
    this.reconcile()
    this.snapshot('S0', 'tree-base')
    this.passPreflight('implement')
    if (o.session !== false) this.ev('implement', { type: 'session', id: 'impl-session' })
    return this
  }

  agentSpawnNo(step: AgentStep): number {
    return this.state.steps[step].proc?.spawnNo ?? 0
  }

  agentEv(step: AgentStep, ev: NormalizedEvent): Reduction {
    return this.send({ t: 'adapter', step, spawnNo: this.agentSpawnNo(step), ev })
  }

  agentExit(step: AgentStep): Reduction {
    return this.send({
      t: 'exit',
      step,
      spawnNo: this.agentSpawnNo(step),
      code: 0,
      signal: null,
      ranMs: 4000,
    })
  }

  agentPreflight(step: AgentStep): Reduction {
    const req = this.req(
      (r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === step,
      `passBoundary ${step}`,
    )
    return this.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
  }

  /** The acceptance review spawned, answers `answer`, exits. */
  accept(answer: string = ANSWER_MET_UNMET): this {
    this.agentPreflight('acceptance')
    this.agentEv('acceptance', {
      type: 'done',
      result: answer,
      usage: { input: 5, output: 5, costUsd: 0.01 },
    })
    this.agentExit('acceptance')
    return this
  }

  /** After the review: reconcile(pre-review) → Review spawned → it reports nothing → the post-review snapshot. */
  reviewNone(): this {
    this.reconcile('pre-review')
    for (const k of this.reviewers) this.passPreflight(k)
    for (const k of this.reviewers) this.report(k, 'none')
    if (this.findReq((r) => r.kind === 'snapshot' && r.label === 'post-review') !== undefined)
      this.snapshot('post-review', 'tree-changed')
    return this
  }
}

describe('acceptance criteria from the decided plan', () => {
  it('parses the approved plan into AC1..ACn and writes acceptance.json, even with the review off', () => {
    const f = new AFlow({ acceptance: false })
    f.toPlanGate(PLAN_AC)
    expect(f.state.acceptance).toBeUndefined()
    f.approve()
    expect(f.state.acceptance?.criteria).toEqual([
      { id: 'AC1', text: 'Adding an item shows it in the list' },
      { id: 'AC2', text: 'Completed items can be cleared' },
    ])
    const out = f.log.filter((e) => e.t === 'writeOutput' && e.file === 'acceptance')
    expect(out).toHaveLength(1)
    const doc = JSON.parse(out[0]?.t === 'writeOutput' ? out[0].text : '{}') as {
      criteria: unknown[]
      review: string
    }
    expect(doc.review).toBe('off')
    expect(doc.criteria).toEqual([
      expect.objectContaining({ id: 'AC1', status: 'not-checked' }),
      expect.objectContaining({ id: 'AC2', status: 'not-checked' }),
    ])
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.acceptance?.counts).toEqual({ met: 0, notMet: 0, unknown: 0, notChecked: 2 })
    // The step is not used in this run: no card, no node.
    expect(snap.steps.acceptance.acceptance).toBeUndefined()
    expect(snap.steps.acceptance.planned).toBeUndefined()
  })

  it("takes the gate's edits: the edited plan's criteria are the run's", () => {
    const f = new AFlow()
    f.toPlanGate(PLAN_AC)
    f.approve(PLAN_AC.replace('- [ ] Completed items can be cleared', '- Items persist after a reload'))
    expect(f.state.acceptance?.criteria.map((c) => c.text)).toEqual([
      'Adding an item shows it in the list',
      'Items persist after a reload',
    ])
  })

  it('the Tests step, Implement and Fix prompts see the criteria', () => {
    const f = new AFlow()
    f.toPlanGate(PLAN_AC)
    f.approve()
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const text = buildPrompt(f.state, cfg, { step: 'implement', launch: { fresh: {} } }).text
    expect(text).toContain(
      'Acceptance criteria (build to meet each one):\n- AC1: Adding an item shows it in the list',
    )
  })
})

describe('Test-first maps its tests to the criteria', () => {
  it("reads the Tests step's closing JSON block; the checklist and the review's prompt show the tests", () => {
    const f = new VFlow({ review: true, critic: false, fix: true, beforeFix: false })
    f.state = { ...f.state, config: { ...f.state.config, testFirst: true, acceptance: true } }
    f.toPlanGate()
    f.approve(PLAN_AC)
    // The Tests step's prompt lists the criteria with their ids and asks for the mapping.
    f.reconcile('pre-implement')
    f.snapshot('T0', 'tree-base')
    const req = f.req((r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === 'tests')
    f.send({ t: 'preflight-result', req, report: { ...okReport(), mode: 'passBoundary' } })
    const spawn = f.fx('spawn')[0]
    if (spawn === undefined) throw new Error('no tests spawn')
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const prompt = buildPrompt(f.state, cfg, spawn).text
    expect(prompt).toContain(
      'The acceptance criteria, with their ids:\n- AC1: Adding an item shows it in the list',
    )
    expect(prompt).toContain('{"mapping": [{"id": "AC1", "tests": ["tests/cart.test.ts: adds an item"]}]}')
    const answer = [
      'Wrote tests/todo.test.ts.',
      '```json',
      JSON.stringify({
        mapping: [
          { id: 'AC1', tests: ['tests/todo.test.ts: adds an item'] },
          { id: 'AC7', tests: ['x'] },
        ],
      }),
      '```',
    ].join('\n')
    f.send({ t: 'adapter', step: 'tests', spawnNo: 1, ev: { type: 'done', result: answer } })
    expect(f.state.acceptance?.tests).toEqual({ AC1: ['tests/todo.test.ts: adds an item'] })
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.acceptance?.items[0]?.tests).toEqual(['tests/todo.test.ts: adds an item'])
    expect(snap.acceptance?.items[1]?.tests).toBeUndefined()
  })
})

describe('the acceptance review', () => {
  it('without criteria: skipped with a note, and the reviewers start as before', () => {
    const f = new AFlow({ plan: '## Goal\nG\n\n## Steps\n1. Edit `a.ts` (edit)' })
    f.toS1()
    expect(f.state.acceptance?.criteria).toEqual([])
    expect(f.step('acceptance')).toMatchObject({
      status: 'skipped',
      reason: SKIP_REASON.noCriteria,
      attempt: 0,
    })
    expect(f.state.notes).toContain(ACCEPTANCE_NOTE.noCriteria)
    expect(f.log.some((e) => e.t === 'spawn' && e.step === 'acceptance')).toBe(false)
    expect(f.findReq((r) => r.kind === 'reconcile' && r.boundary === 'pre-review')).toBeDefined()
  })

  it('a run without it never touches the step', () => {
    const f = new AFlow({ acceptance: false })
    f.toS1()
    expect(f.step('acceptance')).toMatchObject({ status: 'queued', attempt: 0 })
    f.reviewNone()
    expect(f.state.outcome).toBe('clean')
    expect(f.step('acceptance')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.notUsed })
  })

  it('runs after Implement on Review config, read-only and confined, with the criteria and the diff', () => {
    const f = new AFlow()
    f.toS1()
    expect(f.step('acceptance').status).toBe('running')
    expect(f.state.phase).toBe('accepting')
    f.agentPreflight('acceptance')
    const spawn = f.fx('spawn')[0]
    expect(spawn).toMatchObject({ step: 'acceptance', vendor: 'claude', model: 'sonnet', mode: 'readonly' })
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    if (spawn === undefined) throw new Error('no spawn')
    const prompt = buildPrompt(f.state, cfg, spawn, { diff: 'diff --git a/x b/x' }).text
    expect(prompt).toContain('- AC1: Adding an item shows it in the list')
    expect(prompt).toContain('diff --git a/x b/x')
    const o = startOptionsFor({ runId: 'r', cwd: 'C:\\w', config: cfg, state: f.state, spawn, prompt })
    expect(o.step).toBe('review')
    expect(o.outputSchema).toBeDefined()
    expect(o.extensions?.level).toBe('none')
  })

  it('without Fix until green: a summary note, no findings, the outcome unchanged', () => {
    const f = new AFlow()
    f.toS1()
    f.accept()
    expect(f.step('acceptance').status).toBe('done')
    expect(f.state.acceptance?.findings).toBeUndefined()
    expect(f.state.notes).toContain(acceptanceSummaryText({ met: 1, notMet: 1, unknown: 0, notChecked: 0 }))
    expect(f.state.notes).toContain('Acceptance: 1 of 2 criteria met, 1 not met.')
    f.reviewNone()
    expect(fixSkipRuleHolds(f.state)).toBe(true)
    expect(f.state.outcome).toBe('clean')
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.acceptance).toMatchObject({ review: 'done', findings: false })
    expect(snap.acceptance?.items.map((i) => i.status)).toEqual(['met', 'not-met'])
    expect(snap.steps.acceptance.acceptance?.items[1]?.evidence).toBe('no clear action in src/todo.ts')
  })

  it('with Fix until green: unmet criteria become [must] findings, Fix gets them, the re-check confirms them', () => {
    const f = new AFlow({ loop: true })
    f.toS1()
    f.accept()
    expect(f.state.acceptance?.findings).toEqual([
      expect.objectContaining({ id: 'acceptance-ac2', severity: 'must', source: 'acceptance' }),
    ])
    expect(f.state.notes).toContain(ACCEPTANCE_NOTE.findings(['AC2']))
    f.reviewNone()
    // Joined with the reviewers' (none): the skip rule does not hold, and Fix starts round 1 with F1.
    expect(f.state.findings?.list).toEqual([expect.objectContaining({ id: 'acceptance-ac2', n: 1 })])
    const doc = f.log.filter((e) => e.t === 'writeFindings').at(-1)
    expect(doc?.t === 'writeFindings' ? doc.doc.sources.acceptance : undefined).toEqual({
      status: 'ok',
      count: 1,
      rawFile: 'acceptance.json',
    })
    expect(f.state.fixLoop).toMatchObject({ round: 1, before: 1 })
    f.toFixSpawned('tree-changed')
    const cfg = resolveBuiltinConfig({ profile: 'claude-only' })
    const fixSpawn = f.fx('spawn')[0]
    if (fixSpawn === undefined) throw new Error('no fix spawn')
    expect(buildPrompt(f.state, cfg, fixSpawn).text).toContain('Acceptance criterion AC2 is not met')
    f.ev('fix', { type: 'done', result: 'F1 fixed' })
    f.exit('fix')
    f.reconcile('end-of-pass')
    f.snapshot('S2', 'tree-fixed')
    // The round's re-check confirms the acceptance [must].
    expect(f.state.security?.recheck?.checks).toEqual([1])
    f.agentPreflight('recheck')
    f.agentEv('recheck', { type: 'done', result: 'F1 resolved', usage: { input: 1, output: 1 } })
    f.agentExit('recheck')
    expect(f.state.outcome).toBe('fixed')
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.acceptance?.items[1]).toMatchObject({
      id: 'AC2',
      status: 'met',
      evidence: 'Re-check: resolved in round 1.',
      finding: 1,
    })
    // acceptance.json is rewritten as the run completes, with the confirmed criterion met.
    const last = f.log.filter((e) => e.t === 'writeOutput' && e.file === 'acceptance').at(-1)
    const json = JSON.parse(last?.t === 'writeOutput' ? last.text : '{}') as { counts: unknown }
    expect(json.counts).toEqual({ met: 2, notMet: 0, unknown: 0, notChecked: 0 })
  })

  it('unknown criteria never become findings, and an unreadable answer is a note, not a failure', () => {
    const f = new AFlow({ loop: true })
    f.toS1()
    f.accept('I could not tell.')
    expect(f.step('acceptance')).toMatchObject({ status: 'done', reason: 'answer unreadable' })
    expect(f.state.acceptance?.findings).toEqual([])
    expect(f.state.notes).toContain(
      "The acceptance review's answer could not be read, so every criterion reads unknown.",
    )
    f.reviewNone()
    expect(f.state.outcome).toBe('clean')
  })

  it('falls back to Critic, then Plan, when Review is off; skipped with a note when all three are off', () => {
    const critic = new AFlow({ review: false, critic: true })
    critic.state.config.passes.critic.model = 'haiku'
    critic.toS1()
    critic.agentPreflight('acceptance')
    expect(critic.fx('spawn')[0]).toMatchObject({ step: 'acceptance', model: 'haiku', mode: 'readonly' })

    const plan = new AFlow({ review: false, critic: false })
    plan.state.config.passes.plan.model = 'plan-model'
    plan.toS1()
    plan.agentPreflight('acceptance')
    expect(plan.fx('spawn')[0]).toMatchObject({ step: 'acceptance', model: 'plan-model' })

    // Review, Critic and Plan all off: the run has no plan (so no criteria), and the review says why it did not run.
    const off = new AFlow({ review: false, critic: false })
    off.state.config.passes.plan.enabled = false
    off.create()
    off.lock()
    off.preflight()
    off.snapshot('run-start', 'tree-base')
    off.reconcile()
    off.snapshot('S0', 'tree-base')
    off.passPreflight('implement')
    off.ev('implement', { type: 'done', result: 'implemented' })
    off.exit('implement')
    off.reconcile('end-of-pass')
    off.snapshot('S1', 'tree-changed')
    expect(off.step('acceptance')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.disabled })
    expect(off.state.notes).toContain(ACCEPTANCE_NOTE.passesOff)
  })

  it('a relaunch during the review pauses it; Resume runs it again; Stop cancels it', () => {
    const f = new AFlow()
    f.toS1()
    f.agentPreflight('acceptance')
    f.send({ t: 'relaunch' })
    expect(f.step('acceptance').status).toBe('paused')
    f.user({ kind: 'resume' })
    expect(f.step('acceptance').status).toBe('running')
    f.accept(ANSWER_MET_UNMET.replace('not-met', 'met'))
    expect(f.log.filter((e) => e.t === 'spawn' && e.step === 'acceptance')).toHaveLength(2)
    expect(f.step('acceptance').status).toBe('done')
    expect(f.state.notes).toContain('Acceptance: 2 of 2 criteria met.')

    const g = new AFlow()
    g.toS1()
    g.agentPreflight('acceptance')
    g.user({ kind: 'stop' })
    expect(g.step('acceptance').status).toBe('cancelled')
    expect(g.state.status).toBe('cancelled')
  })

  it('its node is planned from the start when the run uses it', () => {
    const f = new AFlow()
    f.create()
    expect(toRunSnapshot(f.state, 0, f.now).steps.acceptance.planned).toBe(true)
  })
})

describe('Re-run from Fix', () => {
  it("carries the source's criteria, verdicts and acceptance findings; the review is not run again", () => {
    const src = new AFlow({ loop: true })
    src.toS1()
    src.accept()
    src.reviewNone()
    const init = rerunInit(src.state)
    init.config = { ...init.config, explain: true }
    const s = initRerunFromFix(src.state, init, ['acceptance-ac2'])
    expect(s.acceptance?.criteria.map((c) => c.id)).toEqual(['AC1', 'AC2'])
    expect(s.acceptance?.results?.['AC2']).toEqual({
      status: 'not-met',
      evidence: 'no clear action in src/todo.ts',
    })
    expect(s.findings?.list.map((f) => [f.id, f.source])).toEqual([['acceptance-ac2', 'acceptance']])
    expect(s.findings?.selected).toEqual(['acceptance-ac2'])
    expect(s.steps.acceptance.status).toBe('skipped')
    expect(s.steps.acceptance.reason).toContain('#7')
    expect(s.outputs.acceptance).toBe(1)
    // Explain runs again at the re-run's end.
    expect(s.steps.explain.status).toBe('queued')
    const snap = toRunSnapshot(s, 0)
    expect(snap.acceptance?.items[1]).toMatchObject({ id: 'AC2', status: 'not-met', finding: 1 })
  })
})
