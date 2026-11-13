// Clarify in the state machine (the reducer only; the drivers play the controller):
//   - a run without it never touches the `clarify` step (no events, never shown or cancelled)
//   - with it: run-start → Clarify (read-only, on the Plan pass's config, its pass-boundary preflight) before Plan
//   - questions open a blocking Clarify card with no default (it waits even in Auto); the step waits on the user
//   - Use these answers adds them to the Brief, then Plan starts; Skip questions goes on with a note
//   - no questions, or an unreadable answer, lets Plan start with a note; the structured answer wins over the text
//   - Auto skips Clarify unless `inAuto`; Plan off skips it; Stop, relaunch, a failure and Continue without
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentStep } from '@shared/run.ts'
import type { NormalizedEvent } from '@shared/events.ts'
import { META_STRUCTURED_OUTPUT } from '@core/adapters/types.ts'
import { CLARIFY_PARSE_NOTE, CLARIFY_SCHEMA } from '@core/clarify/parse.ts'
import { CLARIFY_CHOICE } from '@core/supervisor/cards.ts'
import { toRunSnapshot } from '@core/supervisor/derive.ts'
import { buildPrompt, startOptionsFor } from '@core/supervisor/effects.ts'
import { CLARIFY_NOTE, SKIP_REASON } from '@core/supervisor/machine.ts'
import type { Reduction, RunConfig } from '@core/supervisor/types.ts'
import { resolveBuiltinConfig } from '@core/config/builtins.ts'
import { Harness, PLAN_TEXT, makeConfig, okReport } from '../supervisor/helpers.ts'
import { initRerunFromFix } from '@core/supervisor/rerun-state.ts'
import { rerunInit } from '../rerun/helpers.ts'

const QUESTIONS = {
  questions: [
    { question: 'Which database should it use?', options: ['SQLite', 'Postgres'] },
    { question: 'Who uses it?', options: ['Just me', 'A small team'] },
  ],
}
const FENCED = `A couple of points matter.\n\n\`\`\`json\n${JSON.stringify(QUESTIONS)}\n\`\`\``

function clarifyConfig(
  o: { auto?: boolean; inAuto?: boolean; plan?: boolean; questions?: number } = {},
): RunConfig {
  const c = makeConfig({
    auto: o.auto ?? false,
    gates: { afterPlan: o.auto !== true, beforeFix: false },
    clarify: { questions: o.questions ?? 4, inAuto: o.inAuto ?? false },
  })
  c.passes.plan.enabled = o.plan ?? true
  return c
}

class CFlow extends Harness {
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

  /** R1 → R2 → preflight → run-start → Clarify's pass-boundary preflight → Clarify spawned. */
  toClarifyRunning(): this {
    this.create()
    this.lock()
    this.preflight()
    this.snapshot('run-start', 'tree-base')
    this.agentPreflight('clarify')
    return this
  }

  /** Clarify answers (`text`; `structured`: the vendor's structured answer first) and exits. */
  clarifyAnswers(text: string, structured?: unknown): this {
    if (structured !== undefined)
      this.send({
        t: 'signal',
        step: 'clarify',
        spawnNo: this.agentSpawnNo('clarify'),
        signal: { type: 'meta', key: META_STRUCTURED_OUTPUT, value: structured },
      })
    this.agentEv('clarify', { type: 'done', result: text, usage: { input: 10, output: 20 } })
    this.agentExit('clarify')
    return this
  }

  answer(input: string[]): Reduction {
    const c = this.state.cards.find((x) => x.view.kind === 'clarify')
    expect(c, 'open Clarify card').toBeDefined()
    return this.user({ kind: 'card', cardId: c?.view.id ?? '', choiceId: CLARIFY_CHOICE.answer, input })
  }

  skipQuestions(): Reduction {
    const c = this.state.cards.find((x) => x.view.kind === 'clarify')
    return this.user({ kind: 'card', cardId: c?.view.id ?? '', choiceId: CLARIFY_CHOICE.skip })
  }
}

const spawned = (f: CFlow): string[] => f.log.filter((e) => e.t === 'spawn').map((e) => e.step)

describe('Clarify off', () => {
  it('never touches the clarify step: Plan starts after run-start as before, nothing is emitted for it', () => {
    const f = new CFlow(makeConfig())
    f.create()
    f.lock()
    f.preflight()
    f.snapshot('run-start', 'tree-base')
    f.passPreflight('plan')
    expect(spawned(f)).toEqual(['plan'])
    expect(f.step('clarify').status).toBe('queued')
    const bodies = f.log.filter((e) => e.t === 'emit').map((e) => (e.t === 'emit' ? e.body : null))
    expect(bodies.some((b) => b !== null && 'step' in b && b.step === 'clarify')).toBe(false)
    f.user({ kind: 'stop' })
    expect(f.step('clarify').status).toBe('queued')
    expect(f.state.status).toBe('cancelled')
  })
})

describe('Clarify rows', () => {
  it('runs before Plan, after run-start, on the Plan pass config read-only, with its own pass-boundary preflight', () => {
    const f = new CFlow(clarifyConfig())
    f.create()
    f.lock()
    f.preflight()
    // Its launch starts with the run; its pass-boundary preflight goes out, Plan's does not.
    expect(f.step('clarify').status).toBe('running')
    expect(f.findReq((r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === 'plan')).toBe(
      undefined,
    )
    f.agentPreflight('clarify')
    // R2: it waits for run-start like Plan.
    expect(spawned(f)).toEqual([])
    f.snapshot('run-start', 'tree-base')
    expect(f.fx('spawn')).toEqual([
      expect.objectContaining({ step: 'clarify', vendor: 'claude', model: 'opus', mode: 'readonly' }),
    ])
    expect(f.state.phase).toBe('clarifying')
    expect(f.step('plan').status).toBe('queued')
  })

  it('questions open a blocking card with no default; the step waits; Plan does not start', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    const card = f.state.cards.find((c) => c.view.kind === 'clarify')
    expect(card?.view).toMatchObject({ blocking: true, title: '2 questions before Plan' })
    expect(card?.view.defaultChoice).toBeUndefined()
    expect(card?.view.choices.map((c) => [c.id, c.input])).toEqual([
      ['answer', 'answers'],
      ['skip', undefined],
    ])
    expect(card?.view.payload).toEqual({ step: 'clarify', questions: QUESTIONS.questions })
    expect(f.step('clarify')).toMatchObject({ status: 'waiting', reason: 'questions' })
    expect(f.state.status).toBe('waiting')
    expect(f.state.phase).toBe('clarifying')
    expect(spawned(f)).toEqual(['clarify'])
    expect(f.log).toContainEqual(expect.objectContaining({ t: 'notify', kind: 'card' }))
    // The view: its questions, asking.
    const snap = toRunSnapshot(f.state, 0, f.now)
    expect(snap.steps.clarify.clarify).toEqual({ status: 'asking', questions: QUESTIONS.questions })
    // Its answer is kept as clarify.md.
    expect(f.log).toContainEqual(expect.objectContaining({ t: 'writeOutput', file: 'clarify', text: FENCED }))
  })

  it('Use these answers: the answers join the brief, the step is done, Plan starts and its prompt has them', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.answer(['Postgres', ''])
    expect(f.state.cards).toEqual([])
    expect(f.step('clarify')).toMatchObject({ status: 'done' })
    expect(f.state.brief).toBe(
      'Answers to the clarifying questions:\n- Which database should it use?\n  Answer: Postgres',
    )
    expect(f.state.notes).toContain(CLARIFY_NOTE.answered(1))
    expect(toRunSnapshot(f.state, 0).steps.clarify.clarify).toMatchObject({
      status: 'answered',
      answers: ['Postgres', ''],
    })
    // Plan's launch (its pass-boundary preflight) starts at once.
    f.passPreflight('plan')
    expect(spawned(f)).toEqual(['clarify', 'plan'])
    const spawn = f.log.filter((e) => e.t === 'spawn').at(-1)
    if (spawn?.t !== 'spawn') throw new Error('no plan spawn')
    const prompt = buildPrompt(f.state, resolveBuiltinConfig({ profile: 'claude-only' }), spawn)
    expect(prompt.text).toContain('Answer: Postgres')
  })

  it('an Other answer (free text) is taken as written', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.answer(['', '  Our support team of six  '])
    expect(f.state.brief).toContain('- Who uses it?\n  Answer: Our support team of six')
  })

  it('Skip questions, or no answer at all, goes on without them (a note), Plan starts', () => {
    for (const how of ['skip', 'blank'] as const) {
      const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
      if (how === 'skip') f.skipQuestions()
      else f.answer(['', ' '])
      expect(f.step('clarify')).toMatchObject({ status: 'done', reason: 'questions skipped' })
      expect(f.state.notes).toContain(CLARIFY_NOTE.skipped)
      expect(f.state.brief).toBeUndefined()
      expect(
        f.findReq((r) => r.kind === 'preflight' && r.mode === 'passBoundary' && r.step === 'plan'),
      ).toBeDefined()
    }
  })

  it('rejects answers that do not match the questions (and keeps the card open)', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.answer(['only one'])
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    f.answer(['x'.repeat(501), ''])
    expect(f.fx('result')).toEqual([expect.objectContaining({ code: 'VALIDATION' })])
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['clarify'])
    expect(f.step('clarify').status).toBe('waiting')
  })

  it('no questions, or an unreadable answer, lets Plan start with a note', () => {
    const none = new CFlow(clarifyConfig())
      .toClarifyRunning()
      .clarifyAnswers('```json\n{"questions": []}\n```')
    expect(none.step('clarify')).toMatchObject({ status: 'done', reason: 'no questions' })
    expect(none.state.notes).toContain(CLARIFY_PARSE_NOTE.none)
    expect(none.state.cards).toEqual([])
    none.passPreflight('plan')
    expect(spawned(none)).toEqual(['clarify', 'plan'])

    const bad = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers('I think it is clear.')
    expect(bad.step('clarify').status).toBe('done')
    expect(bad.state.notes).toContain(CLARIFY_PARSE_NOTE.unreadable)
    expect(toRunSnapshot(bad.state, 0).steps.clarify.clarify).toEqual({
      status: 'none',
      questions: [],
      note: CLARIFY_PARSE_NOTE.unreadable,
    })
  })

  it("the vendor's structured answer wins over the final message, and at most `questions` are kept", () => {
    const f = new CFlow(clarifyConfig({ questions: 1 })).toClarifyRunning().clarifyAnswers('', QUESTIONS)
    const card = f.state.cards.find((c) => c.view.kind === 'clarify')
    expect(card?.view.payload).toEqual({ step: 'clarify', questions: [QUESTIONS.questions[0]] })
    expect(card?.view.title).toBe('One question before Plan')
  })

  it('Auto skips Clarify by default (a note), so Plan starts right away', () => {
    const f = new CFlow(clarifyConfig({ auto: true }))
    f.create()
    f.lock()
    f.preflight()
    expect(f.step('clarify')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.auto })
    expect(f.state.notes).toContain(CLARIFY_NOTE.auto)
    f.snapshot('run-start', 'tree-base')
    f.passPreflight('plan')
    expect(spawned(f)).toEqual(['plan'])
  })

  it('with "Ask in Auto" the card waits even in Auto: it has no default to take', () => {
    const f = new CFlow(clarifyConfig({ auto: true, inAuto: true })).toClarifyRunning().clarifyAnswers(FENCED)
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['clarify'])
    expect(f.state.notes.some((n) => n.startsWith('Auto:'))).toBe(false)
    expect(f.state.status).toBe('waiting')
    f.answer(['SQLite', 'Just me'])
    expect(f.state.brief).toContain('Answer: SQLite')
  })

  it('Plan off skips Clarify (it uses the Plan pass settings), with a note', () => {
    const f = new CFlow(clarifyConfig({ plan: false }))
    f.create()
    f.lock()
    f.preflight()
    expect(f.step('clarify')).toMatchObject({ status: 'skipped', reason: SKIP_REASON.disabled })
    expect(f.state.notes).toContain(CLARIFY_NOTE.planOff)
    expect(f.step('plan')).toMatchObject({ status: 'skipped', reason: 'disabled' })
  })

  it('Stop while the card is open resolves it and cancels the step', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.user({ kind: 'stop' })
    expect(f.state.cards).toEqual([])
    expect(f.step('clarify').status).toBe('cancelled')
    expect(f.step('plan').status).toBe('cancelled')
  })

  it('a relaunch leaves the open card waiting (no process to pause), and the answer still works', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.send({ t: 'relaunch' })
    expect(f.step('clarify').status).toBe('waiting')
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['clarify'])
    f.answer(['SQLite', ''])
    expect(f.step('clarify').status).toBe('done')
  })

  it('a relaunch while Clarify runs pauses it; Resume runs it again fresh', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning()
    f.send({ t: 'relaunch' })
    expect(f.step('clarify')).toMatchObject({ status: 'paused', pause: 'interrupted' })
    expect(f.state.status).toBe('paused')
    f.user({ kind: 'resume' })
    f.agentPreflight('clarify')
    expect(f.fx('spawn')).toEqual([expect.objectContaining({ step: 'clarify', launch: { fresh: {} } })])
  })

  it('a failure offers the usual recovery; Continue without Clarify lets Plan start', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning()
    f.agentEv('clarify', {
      type: 'error',
      fatal: true,
      category: 'auth_expired',
      message: 'Not logged in',
      raw: '',
    })
    expect(f.step('clarify').status).toBe('failed')
    expect(f.state.status).toBe('failed')
    f.agentExit('clarify')
    f.user({ kind: 'skip', step: 'clarify' })
    expect(f.step('clarify')).toMatchObject({ status: 'skipped', reason: 'user' })
    f.passPreflight('plan')
    expect(spawned(f)).toEqual(['clarify', 'plan'])
  })

  it('the prompt asks for at most N questions in JSON; the launch asks for structured output on the Plan config', () => {
    const f = new CFlow(clarifyConfig({ questions: 3 })).toClarifyRunning()
    const spawn = f.log.find((e) => e.t === 'spawn')
    if (spawn?.t !== 'spawn') throw new Error('no spawn')
    const config = resolveBuiltinConfig({ profile: 'claude-only' })
    const prompt = buildPrompt(f.state, config, spawn)
    expect(prompt.text).toContain('Ask at most 3 questions')
    expect(prompt.text).toContain(f.state.task)
    expect(prompt.text).toContain('{"questions": []}')
    const o = startOptionsFor({
      runId: f.state.runId,
      cwd: 'C:\\tmp',
      config,
      state: f.state,
      spawn,
      prompt: prompt.text,
    })
    expect(o).toMatchObject({ step: 'plan', mode: 'readonly', planNative: false })
    expect(o.outputSchema).toEqual(CLARIFY_SCHEMA)
    // Read-only: no pre-assigned session for it.
    expect(o.sessionId).toBeUndefined()
  })

  it('renders the run’s own Clarify template when it was made with an override (Settings › Prompts)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dim-factory-clarify-template-'))
    try {
      const path = join(dir, 'clarify.md')
      writeFileSync(path, 'Our house rules. Ask {{questions}} at most about:\n{{task}}\n')
      const f = new CFlow(clarifyConfig({ questions: 2 })).toClarifyRunning()
      const spawn = f.log.find((e) => e.t === 'spawn')
      if (spawn?.t !== 'spawn') throw new Error('no spawn')
      const config = resolveBuiltinConfig({ profile: 'claude-only' })
      const prompt = buildPrompt(f.state, config, spawn, { stepTemplates: { clarify: { path } } })
      expect(prompt.text).toBe(`Our house rules. Ask 2 at most about:\n${f.state.task}\n`)
      // Without one: the built-in.
      expect(buildPrompt(f.state, config, spawn).text).toContain('Ask at most 2 questions')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Re-run from Fix carries Clarify (never asks again before its Fix) and the brief with the answers', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.answer(['Postgres', ''])
    const source = { ...f.state, status: 'completed' as const }
    const s = initRerunFromFix(source, rerunInit(source), [])
    expect(s.steps.clarify).toMatchObject({ status: 'skipped', reason: 'carried from run #7' })
    expect(s.brief).toContain('Answer: Postgres')
    expect(s.clarify?.status).toBe('answered')
    // A source that never asked (Clarify off then, on now) still never asks before the re-run's Fix.
    const plain = new CFlow(makeConfig()).state
    const s2 = initRerunFromFix(plain, rerunInit(plain, { config: clarifyConfig() }), [])
    expect(s2.steps.clarify).toMatchObject({ status: 'skipped', reason: 'carried from run #7' })
  })

  it('reaches the plan gate after the answers, as a run without Clarify would', () => {
    const f = new CFlow(clarifyConfig()).toClarifyRunning().clarifyAnswers(FENCED)
    f.answer(['SQLite', 'Just me'])
    f.passPreflight('plan')
    f.ev('plan', { type: 'session', id: 'plan-session' })
    f.ev('plan', { type: 'done', result: PLAN_TEXT })
    f.exit('plan')
    expect(f.state.cards.map((c) => c.view.kind)).toEqual(['gate:afterPlan'])
    expect(f.state.phase).toBe('plan-review')
  })
})
