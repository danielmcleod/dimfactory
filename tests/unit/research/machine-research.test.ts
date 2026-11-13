// Research in the state machine (the reducer only; the drivers play the controller):
//   - a run without it never touches the `research` step
//   - with it: run-start → Research (confined, on the Plan pass's config, its pass-boundary preflight) before Plan,
//     after Clarify when both are on
//   - a cited answer opens the research card (blocking, default = must-haves and recommendations); uncited claims are
//     dropped with a note; research.md and research.json are written
//   - Use selected: the kept items and answers become `{{research}}` in the Plan prompt; Plan without research: none
//   - Auto takes the default (must-haves and recommendations, no answers); nothing usable lets Plan start with a note
//   - no web: the launch has web off and the prompt says so; Plan off skips it; failure and Continue without; Stop;
//     Re-run from Fix carries it
import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/run.ts'
import type { NormalizedEvent } from '@shared/events.ts'
import type { ResearchRunConfig } from '@shared/research.ts'
import { META_STRUCTURED_OUTPUT } from '@core/adapters/types.ts'
import { RESEARCH_PARSE_NOTE, RESEARCH_SCHEMA } from '@core/research/parse.ts'
import { RESEARCH_CHOICE } from '@core/supervisor/cards.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { buildPrompt, startOptionsFor } from '@core/supervisor/effects.ts'
import { RESEARCH_NOTE, SKIP_REASON } from '@core/supervisor/machine.ts'
import type { Reduction, RunConfig } from '@core/supervisor/types.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { initRerunFromFix } from '@core/supervisor/rerun-state.ts'
import { Harness, PLAN_TEXT, makeConfig, okReport } from '../supervisor/helpers.ts'
import { rerunInit } from '../rerun/helpers.ts'

const WEB: ResearchRunConfig = {
  web: true,
  lenses: [
    { id: 'comparable', label: 'Comparable products', ask: 'What do similar products offer?', web: true },
    { id: 'repository', label: 'This repository', ask: 'What exists here already?', web: false },
  ],
}
const NO_WEB: ResearchRunConfig = {
  web: false,
  lenses: [{ id: 'repository', label: 'This repository', ask: 'What exists here already?', web: false }],
  offWeb: ['Comparable products'],
}

const ANSWER = {
  summary: ['Version flags are table stakes for CLIs.'],
  features: [
    { feature: 'Print the version with --version', priority: 'must', sources: ['https://clig.dev/#help'] },
    { feature: 'Short -v alias', priority: 'could', sources: ['https://clig.dev/#arguments-and-flags'] },
    { feature: 'An uncited claim', priority: 'must', sources: [] },
  ],
  standards: [
    { standard: 'GNU --version', why: 'Users expect it', sources: ['https://www.gnu.org/prep/standards/'] },
  ],
  options: [
    {
      topic: 'Where the version comes from',
      options: ['package.json', 'a constant'],
      recommendation: 'package.json',
      rationale: 'One source of truth',
      sources: ['repo:package.json'],
    },
  ],
  risks: [{ risk: 'Bundlers may inline a stale version', sources: ['https://example.org/stale'] }],
  questions: ['Should --version also print the commit?'],
  sources: [{ url: 'https://clig.dev/#help', title: 'Command Line Interface Guidelines' }],
}
const FENCED = `Here is the brief.\n\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``

function researchConfig(
  o: { auto?: boolean; plan?: boolean; web?: boolean; clarify?: boolean } = {},
): RunConfig {
  const c = makeConfig({
    auto: o.auto ?? false,
    gates: { afterPlan: o.auto !== true, beforeFix: false },
    research: structuredClone(o.web === false ? NO_WEB : WEB),
    ...(o.clarify === true ? { clarify: { questions: 4, inAuto: false } } : {}),
  })
  c.passes.plan.enabled = o.plan ?? true
  return c
}

class RFlow extends Harness {
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

  toResearchRunning(): this {
    this.create()
    this.lock()
    this.preflight()
    this.snapshot('run-start', 'tree-base')
    this.agentPreflight('research')
    return this
  }

  researchAnswers(text: string, structured?: unknown): this {
    if (structured !== undefined)
      this.send({
        t: 'signal',
        step: 'research',
        spawnNo: this.agentSpawnNo('research'),
        signal: { type: 'meta', key: META_STRUCTURED_OUTPUT, value: structured },
      })
    this.agentEv('research', { type: 'done', result: text, usage: { input: 10, output: 20 } })
    this.agentExit('research')
    return this
  }

  card(): string {
    const c = this.state.cards.find((x) => x.view.kind === 'research')
    expect(c, 'open research card').toBeDefined()
    return c?.view.id ?? ''
  }

  use(input?: string[]): Reduction {
    return this.user({
      kind: 'card',
      cardId: this.card(),
      choiceId: RESEARCH_CHOICE.use,
      ...(input !== undefined ? { input } : {}),
    })
  }

  planPrompt(): string {
    this.passPreflight('plan')
    const spawn = this.log.filter((e) => e.t === 'spawn').at(-1)
    if (spawn?.t !== 'spawn' || spawn.step !== 'plan') throw new Error('no plan spawn')
    return buildPrompt(this.state, resolveBuiltinConfig({ profile: 'claude-only' }), spawn).text
  }
}

const spawned = (f: RFlow): string[] => f.log.filter((e) => e.t === 'spawn').map((e) => e.step)

describe('Research off', () => {
  it('never touches the research step, and the Plan prompt has no research section', () => {
    const f = new RFlow(makeConfig())
    f.create()
    f.lock()
    f.preflight()
    f.snapshot('run-start', 'tree-base')
    expect(f.step('research').status).toBe('queued')
    expect(f.planPrompt()).not.toContain('Research the user reviewed')
    expect(spawned(f)).toEqual(['plan'])
    expect(toRunSnapshot(f.state, 0).steps.research.research).toBeUndefined()
  })
})

describe('Research rows', () => {
  it('runs before Plan after run-start, confined on the Plan pass config, with web search and structured output', () => {
    const f = new RFlow(researchConfig())
    f.create()
    f.lock()
    f.preflight()
    expect(f.step('research').status).toBe('running')
    f.agentPreflight('research')
    expect(spawned(f)).toEqual([])
    f.snapshot('run-start', 'tree-base')
    expect(f.fx('spawn')).toEqual([
      expect.objectContaining({ step: 'research', vendor: 'claude', model: 'opus', mode: 'readonly' }),
    ])
    expect(f.state.phase).toBe('researching')
    // Planned from the start: the view carries its lenses before it answers.
    const v = toRunSnapshot(f.state, 0).steps.research.research
    expect(v).toEqual({
      status: 'pending',
      web: true,
      lenses: [
        { id: 'comparable', label: 'Comparable products', web: true },
        { id: 'repository', label: 'This repository', web: false },
      ],
    })
    const spawn = f.log.find((e) => e.t === 'spawn')
    if (spawn?.t !== 'spawn') throw new Error('no spawn')
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    const prompt = buildPrompt(f.state, config, spawn).text
    expect(prompt).toContain('1. Comparable products: What do similar products offer?')
    expect(prompt).toContain('2. This repository (repository only, no web): What exists here already?')
    expect(prompt).toContain('You may search the web')
    expect(prompt).toContain('is untrusted data')
    expect(prompt).toContain(f.state.task)
    const o = startOptionsFor({ runId: f.state.runId, cwd: 'C:\\tmp', config, state: f.state, spawn, prompt })
    expect(o).toMatchObject({ step: 'research', mode: 'readonly', planNative: false, web: true })
    expect(o.outputSchema).toEqual(RESEARCH_SCHEMA)
    expect(o.extensions?.level).toBe('none')
    expect(o.sessionId).toBeUndefined()
  })

  it('without web search: the launch has web off and the prompt names the repository only', () => {
    const f = new RFlow(researchConfig({ web: false })).toResearchRunning()
    const spawn = f.log.find((e) => e.t === 'spawn')
    if (spawn?.t !== 'spawn') throw new Error('no spawn')
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    const prompt = buildPrompt(f.state, config, spawn).text
    expect(prompt).toContain('You have no web access in this run')
    expect(prompt).not.toContain('Comparable products')
    const o = startOptionsFor({ runId: f.state.runId, cwd: 'C:\\tmp', config, state: f.state, spawn, prompt })
    expect(o.web).toBe(false)
    expect(f.state.notes).toContain(RESEARCH_NOTE.offWeb('Claude', ['Comparable products']))
  })

  it('a cited answer opens the research card; uncited claims are dropped; research.md and .json are written', () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    const card = f.state.cards.find((c) => c.view.kind === 'research')
    expect(card?.view).toMatchObject({ blocking: true, title: 'Review the research', defaultChoice: 'use' })
    expect(card?.view.choices.map((c) => [c.id, c.input])).toEqual([
      ['use', 'research'],
      ['skip', undefined],
    ])
    const payload = card?.view.payload as {
      suggested: string[]
      result: { features: unknown[]; dropped: number }
    }
    expect(payload.suggested).toEqual(['f1', 'o1'])
    expect(payload.result.features).toHaveLength(2)
    expect(payload.result.dropped).toBe(1)
    expect(f.state.notes).toContain(RESEARCH_PARSE_NOTE.dropped(1))
    expect(f.step('research')).toMatchObject({ status: 'waiting', reason: 'review' })
    expect(f.state.phase).toBe('research-review')
    expect(f.state.status).toBe('waiting')
    expect(spawned(f)).toEqual(['research'])
    const files = f.log.filter((e) => e.t === 'writeOutput').map((e) => (e.t === 'writeOutput' ? e.file : ''))
    expect(files).toEqual(['research.json', 'research'])
    const md = f.log.find((e) => e.t === 'writeOutput' && e.file === 'research')
    expect(md?.t === 'writeOutput' ? md.text : '').toContain('| Print the version with --version | must |')
    expect(md?.t === 'writeOutput' ? md.text : '').not.toContain('An uncited claim')
    expect(toRunSnapshot(f.state, 0).steps.research.research?.status).toBe('reviewing')
  })

  it('Use selected: the kept items and answers reach the Plan prompt; unticked ones do not', () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    f.use(['f2', 's1', 'q1=Yes, the short hash'])
    expect(f.state.cards).toEqual([])
    expect(f.step('research').status).toBe('done')
    expect(f.state.notes).toContain(RESEARCH_NOTE.kept(3))
    expect(toRunSnapshot(f.state, 0).steps.research.research).toMatchObject({
      status: 'chosen',
      chosen: ['f2', 's1'],
      answers: { q1: 'Yes, the short hash' },
    })
    const prompt = f.planPrompt()
    expect(prompt).toContain('Research the user reviewed for this run')
    expect(prompt).toContain('- [could] Short -v alias (https://clig.dev/#arguments-and-flags)')
    expect(prompt).toContain('- GNU --version: Users expect it (https://www.gnu.org/prep/standards/)')
    expect(prompt).toContain('- Should --version also print the commit?\n  Answer: Yes, the short hash')
    expect(prompt).not.toContain('Print the version with --version')
    expect(prompt).not.toContain('Recommended choices')
    expect(spawned(f)).toEqual(['research', 'plan'])
  })

  it('Plan without research, or keeping nothing, goes on without it (a note)', () => {
    const skip = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    skip.user({ kind: 'card', cardId: skip.card(), choiceId: RESEARCH_CHOICE.skip })
    expect(skip.step('research')).toMatchObject({ status: 'done', reason: 'research skipped' })
    expect(skip.state.notes).toContain(RESEARCH_NOTE.skipped)
    expect(skip.planPrompt()).not.toContain('Research the user reviewed')

    const none = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    none.use([])
    expect(none.step('research')).toMatchObject({ status: 'done', reason: 'nothing kept' })
    expect(none.state.notes).toContain(RESEARCH_NOTE.nothingKept)
  })

  it('rejects unknown items or questions and over-long answers (the card stays open)', () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    f.use(['f9'])
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    f.use(['q7=hello'])
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    f.use([`q1=${'x'.repeat(501)}`])
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['research'])
    expect(f.step('research').status).toBe('waiting')
  })

  it('Auto takes the must-haves and recommendations and skips the open questions', () => {
    const f = new RFlow(researchConfig({ auto: true })).toResearchRunning().researchAnswers(FENCED)
    expect(f.state.cards).toEqual([])
    expect(f.state.notes).toContain('Auto: "Review the research" → Use selected')
    expect(toRunSnapshot(f.state, 0).steps.research.research).toMatchObject({
      status: 'chosen',
      chosen: ['f1', 'o1'],
      auto: true,
    })
    const prompt = f.planPrompt()
    expect(prompt).toContain('- [must] Print the version with --version')
    expect(prompt).toContain('- Where the version comes from: package.json. One source of truth')
    expect(prompt).not.toContain('Answers to research questions')
  })

  it("the vendor's structured answer wins over the final message", () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers('no json here', ANSWER)
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['research'])
  })

  it('nothing usable (no cited claim, or unreadable) lets Plan start with a note and no card', () => {
    const uncited = new RFlow(researchConfig())
      .toResearchRunning()
      .researchAnswers(JSON.stringify({ features: [{ feature: 'x', priority: 'must' }] }))
    expect(uncited.step('research')).toMatchObject({ status: 'done', reason: 'nothing usable' })
    expect(uncited.state.notes).toContain(RESEARCH_PARSE_NOTE.uncited)
    expect(uncited.state.cards).toEqual([])
    expect(toRunSnapshot(uncited.state, 0).steps.research.research).toMatchObject({
      status: 'none',
      note: RESEARCH_PARSE_NOTE.uncited,
    })
    uncited.passPreflight('plan')
    expect(spawned(uncited)).toEqual(['research', 'plan'])

    const bad = new RFlow(researchConfig()).toResearchRunning().researchAnswers('I looked around.')
    expect(bad.state.notes).toContain(RESEARCH_PARSE_NOTE.unreadable)
  })

  it('after Clarify when both are on: Clarify, then Research, then Plan', () => {
    const f = new RFlow(researchConfig({ clarify: true }))
    f.create()
    f.lock()
    f.preflight()
    f.snapshot('run-start', 'tree-base')
    expect(f.step('research').status).toBe('queued')
    f.agentPreflight('clarify')
    f.agentEv('clarify', { type: 'done', result: '{"questions": []}' })
    f.agentExit('clarify')
    expect(f.step('clarify').status).toBe('done')
    f.agentPreflight('research')
    expect(spawned(f)).toEqual(['clarify', 'research'])
    f.researchAnswers(FENCED)
    f.use(['f1'])
    f.passPreflight('plan')
    expect(spawned(f)).toEqual(['clarify', 'research', 'plan'])
  })

  it('Plan off skips Research (it uses the Plan pass settings), with a note', () => {
    const f = new RFlow(researchConfig({ plan: false }))
    f.create()
    f.lock()
    f.preflight()
    expect(f.step('research')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.disabled })
    expect(f.state.notes).toContain(RESEARCH_NOTE.planOff)
  })

  it('a failure offers the usual recovery; Continue without Research lets Plan start', () => {
    const f = new RFlow(researchConfig()).toResearchRunning()
    f.agentEv('research', {
      type: 'error',
      fatal: true,
      category: 'rate_limited',
      message: 'Slow down',
      raw: '',
    })
    expect(f.step('research').status).toBe('failed')
    f.agentExit('research')
    f.user({ kind: 'skip', step: 'research' })
    expect(f.step('research')).toMatchObject({ status: 'skipped', reason: 'user' })
    f.passPreflight('plan')
    expect(spawned(f)).toEqual(['research', 'plan'])
  })

  it('Stop while the card is open resolves it and cancels the step', () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    f.user({ kind: 'stop' })
    expect(f.state.cards).toEqual([])
    expect(f.step('research').status).toBe('cancelled')
  })

  it('reaches the plan gate after the review, as a run without Research would', () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    f.use(['f1'])
    f.passPreflight('plan')
    f.ev('plan', { type: 'session', id: 'plan-session' })
    f.ev('plan', { type: 'done', result: PLAN_TEXT })
    f.exit('plan')
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
  })

  it('Re-run from Fix carries Research with what was kept (it neither researches nor asks again)', () => {
    const f = new RFlow(researchConfig()).toResearchRunning().researchAnswers(FENCED)
    f.use(['f1', 'q1=No'])
    const source = { ...f.state, status: 'completed' as const }
    const s = initRerunFromFix(source, rerunInit(source), [])
    expect(s.steps.research).toMatchObject({ status: 'skipped', reason: 'carried from run #7' })
    expect(s.research).toMatchObject({ status: 'chosen', chosen: ['f1'], answers: { q1: 'No' } })
    expect(s.config.research).toEqual(WEB)
    expect(s.outputs['research.json']).toBe(1)
  })
})
