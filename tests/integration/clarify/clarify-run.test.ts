// Clarify through a real core and the CLI (the fake Claude; Clarify runs read-only on the Plan pass's model, `haiku`
// here so the fake tells it from Critic):
//   - core: Clarify asks two questions (a fenced JSON block); the run waits on its card; the answers join the brief
//     the Plan prompt reads; the run then goes on as usual
//   - the vendor's structured answer (jsonSchema) is used when it gives one; an answer with no questions goes on
//   - CLI without a terminal: `--clarify` stops at the questions with exit 5 and prints them
//   - CLI in a terminal: each question in turn (a number, own words, or Enter); the answers reach Plan
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import {
  CLI_ENTRY,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  stdinByScript,
} from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'
import { VerifyWorld, openCard, settled, value } from '../verify/helpers.ts'

const world = new VerifyWorld()
const dirs: string[] = []
afterEach(async () => {
  await world.dispose()
  cleanup(...dirs.splice(0))
})

const QUESTIONS = {
  questions: [
    {
      question: 'Which output format should --version print?',
      options: ['Just the number', 'Name and number'],
    },
    { question: 'Should it also accept -v?', options: ['Yes', 'No'] },
  ],
}
const FENCED = `Two choices change the plan.\n\n\`\`\`json\n${JSON.stringify(QUESTIONS)}\n\`\`\``

const versionWrite = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }

const spec = (clarify: ScenarioSpec['clarify']): ScenarioSpec => ({
  ...(clarify !== undefined ? { clarify } : {}),
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
})

const overrides = (): Record<string, unknown> => ({
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  passes: { plan: { model: 'haiku', clarify: true, clarifyQuestions: 3 } },
})

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

/** The init request the fake received from a script's process (the jsonSchema rides on it). */
const initOf = (sc: Scenario, script: string): Record<string, unknown> | undefined =>
  (stdinByScript(sc.entries()).get(script) ?? [])
    .map((l) => JSON.parse(l) as { type?: string; request?: Record<string, unknown> })
    .find((v) => v.type === 'control_request' && v.request?.['subtype'] === 'initialize')?.request

describe('Clarify (core + fake Claude)', () => {
  it('asks, waits on its card, and the answers reach the Plan prompt through the brief', async () => {
    const w = await world.setup(spec([{ recording: 'C02-review-shape', text: FENCED }]))
    const t = await world.start(w, overrides())
    const asking = await t.c.waitFor((s) => openCard(s, 'clarify') !== undefined, 120_000)
    const card = openCard(asking, 'clarify')
    expect(card).toMatchObject({ title: '2 questions before Plan', blocking: true })
    expect(card?.payload).toEqual({ step: 'clarify', questions: QUESTIONS.questions })
    expect(asking.steps.clarify).toMatchObject({
      status: 'waiting',
      vendor: 'claude',
      model: 'haiku',
      mode: 'readonly',
    })
    expect(asking.phase).toBe('clarifying')
    expect(asking.steps.plan.status).toBe('queued')
    // It asked for structured output on its read-only launch, with the task and the question limit.
    expect(initOf(t.sc, 'clarify-1.script.jsonl')?.['jsonSchema']).toMatchObject({ required: ['questions'] })
    const prompt = sent(t.sc, 'clarify-1.script.jsonl')
    expect(prompt).toContain('add a --version flag')
    expect(prompt).toContain('Ask at most 3 questions')

    value(
      await t.core.invoke('cards.resolve', {
        runId: t.runId,
        cardId: card?.id ?? '',
        choiceId: 'answer',
        input: ['Name and number', ''],
      }),
    )
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    const plan = sent(t.sc, 'plan-1.script.jsonl')
    expect(plan).toContain('Answers to the clarifying questions:')
    expect(plan).toContain('Which output format should --version print?\n  Answer: Name and number')
    expect(plan).not.toContain('Should it also accept -v?')
    const snap = value(await t.core.invoke('runs.get', { runId: t.runId }))
    expect(snap.steps.clarify.clarify).toEqual({
      status: 'answered',
      questions: QUESTIONS.questions,
      answers: ['Name and number', ''],
    })
    const out = readFileSync(join(t.home, 'runs', t.runId, 'clarify.md'), 'utf8')
    expect(out).toContain('"questions"')
  }, 180_000)

  it("uses the vendor's structured answer when it gives one", async () => {
    const w = await world.setup(spec([{ recording: 'C02-review-shape', text: '', structured: QUESTIONS }]))
    const t = await world.start(w, overrides())
    const asking = await t.c.waitFor((s) => openCard(s, 'clarify') !== undefined, 120_000)
    expect(openCard(asking, 'clarify')?.payload).toEqual({ step: 'clarify', questions: QUESTIONS.questions })
    value(
      await t.core.invoke('cards.resolve', {
        runId: t.runId,
        cardId: openCard(asking, 'clarify')?.id ?? '',
        choiceId: 'skip',
      }),
    )
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status).toBe('completed')
    expect(done.notes).toContain("You skipped Clarify's questions; Plan decides those points itself.")
  }, 180_000)

  it('no questions: the run goes straight on, with a note', async () => {
    const w = await world.setup(
      spec([{ recording: 'C02-review-shape', text: '```json\n{"questions": []}\n```' }]),
    )
    const t = await world.start(w, overrides())
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.notes).toContain('Clarify had no questions, so Plan starts right away.')
    expect(done.steps.clarify).toMatchObject({ status: 'done', reason: 'no questions' })
  }, 180_000)
})

// ---- the CLI --------------------------------------------------------------------------------------------------------

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function cli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: hermeticEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dimf timed out\n${stdout}\n${stderr}`))
    }, 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

async function cliSetup(s: ScenarioSpec): Promise<{ home: string; folder: string; sc: Scenario }> {
  const sc = await makeScenario(s)
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  return { home, folder, sc }
}

async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('dimf run --clarify', () => {
  it('without a terminal: stops at the questions (exit 5) and prints them', async () => {
    const { home, folder } = await cliSetup(spec([{ recording: 'C02-review-shape', text: FENCED }]))
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--clarify',
      '--set',
      'passes.plan.model=haiku',
      '--gates',
      'approve',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(5)
    expect(r.stdout).toContain('? 2 questions before Plan')
    expect(r.stdout).toContain(
      '  1. Which output format should --version print? (Just the number · Name and number · Other)',
    )
    expect(r.stdout).toContain('Choices: Use these answers · Skip questions')
  }, 150_000)

  it('rejects --fix-rounds above 3 as a usage error (exit 2)', async () => {
    const { home, folder } = await cliSetup(spec(undefined))
    const r = await cli(['run', folder, 'add a --version flag', '--fix-rounds', '4', '--home', home])
    expect(r.code, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain('--fix-rounds takes a whole number from 1 to 3 (got "4")')
  }, 60_000)

  it('in a terminal: each question in turn; a number picks an option, text is your own answer', async () => {
    const { home, folder, sc } = await cliSetup(spec([{ recording: 'C02-review-shape', text: FENCED }]))
    const stdin = new PassThrough()
    const out: string[] = []
    const io: Partial<CliIo> = {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      stdin,
      isTTY: true,
      env: hermeticEnv(),
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    const running = main(
      [
        'run',
        folder,
        'add a --version flag',
        '--clarify',
        '--set',
        'passes.plan.model=haiku',
        '--gates',
        'approve',
        '--home',
        home,
      ],
      io,
    )
    await until(() => out.some((l) => l.includes('Question 1 of 2')))
    expect(out.join('\n')).toContain('    2) Name and number')
    stdin.write('2\n')
    await until(() => out.some((l) => l.includes('Question 2 of 2')))
    stdin.write('Only --version, not -v\n')
    const code = await running
    expect(code, out.join('\n')).toBe(0)
    const plan = sent(sc, 'plan-1.script.jsonl')
    expect(plan).toContain('Answer: Name and number')
    expect(plan).toContain('Answer: Only --version, not -v')
  }, 150_000)
})
