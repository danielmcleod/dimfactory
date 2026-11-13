// Research through a real core and the CLI (the fake Claude; Research is the read-only pass whose launch carries a
// `--tools` allow list, which is how the scenario tells it from Review and Critic):
//   - core: the confined, web-enabled launch (its tool allow list, the output schema, the confinement variable); the
//     research card; the items kept and an answer reach the Plan prompt, the unticked ones do not; research.md/.json
//   - Auto: the card takes its default (must-haves and recommendations), no answers
//   - a Plan vendor without web search: the preflight warning, a launch without web tools, a prompt that says so and
//     a note naming the lenses left out
//   - a brief whose pack researches by default turns Research on; an explicit `passes.plan.research: false` keeps it off
//   - Re-run from Fix carries the chosen research (no second Research spawn)
//   - CLI: `--research` without a terminal stops at the card (exit 5) and prints its items; in a terminal the items
//     chosen reach Plan; a bad lens id is a usage error
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import type { Core } from '../../../src/core/app-core.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { BriefInput } from '../../../src/shared/brief.ts'
import type { ResearchPayload } from '../../../src/shared/research.ts'
import type { ProbeResult } from '../../../src/shared/vendors.ts'
import {
  CLI_ENTRY,
  REVIEW_WITH_FINDINGS,
  cleanup,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
  stdinByScript,
} from '../run/scenario.ts'
import type { PassScript, Scenario, ScenarioSpec } from '../run/scenario.ts'
import { VerifyWorld, openCard, settled, value } from '../verify/helpers.ts'
import { matchFullMode } from '../attention/helpers.ts'

const world = new VerifyWorld()
const dirs: string[] = []
afterEach(async () => {
  await world.dispose()
  cleanup(...dirs.splice(0))
})

const ANSWER = {
  summary: ['Version flags are table stakes for command line tools.'],
  features: [
    { feature: 'Print the version with --version', priority: 'must', sources: ['https://clig.dev/#help'] },
    { feature: 'Short -v alias', priority: 'could', sources: ['https://clig.dev/#arguments-and-flags'] },
    { feature: 'An uncited claim', priority: 'must', sources: [] },
  ],
  standards: [
    {
      standard: 'GNU --version output',
      why: 'Users expect it',
      sources: ['https://www.gnu.org/prep/standards/'],
    },
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
const RESEARCH: PassScript = { recording: 'C02-review-shape', text: FENCED }

const versionWrite = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }

const spec = (research: PassScript[] | undefined, extra: Partial<ScenarioSpec> = {}): ScenarioSpec => ({
  ...(research !== undefined ? { research } : {}),
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
  ...extra,
})

const overrides = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  passes: { plan: { research: true } },
  ...extra,
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

/** The research launch's start entry (argv and the variables FAKE_CLI_LOG_ENV names). */
function researchStart(sc: Scenario): { argv: string[]; env: Record<string, string | null> } | undefined {
  const e = sc
    .entries()
    .find((x) => x.kind === 'start' && (x['argv'] as string[] | undefined)?.includes('--tools'))
  return e === undefined
    ? undefined
    : { argv: e['argv'] as string[], env: (e['env'] as Record<string, string | null> | undefined) ?? {} }
}

const flagValue = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

/** A scenario whose fake logs the confinement variable, a home and a sandbox. */
async function setup(s: ScenarioSpec): Promise<{ sc: Scenario; home: string; folder: string }> {
  const sc = await makeScenario(s)
  sc.env['FAKE_CLI_LOG_ENV'] = 'CLAUDE_CODE_EVAL_CONFINED'
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  world.dirs.push(home, sc.dir, folder)
  return { sc, home, folder }
}

async function startOn(
  core: Core,
  folder: string,
  o: Record<string, unknown>,
  brief?: BriefInput,
): Promise<{ runId: string; c: RunController }> {
  const { runId } = value(
    await core.invoke('runs.start', {
      folder,
      task: 'add a --version flag',
      overrides: o,
      ...(brief !== undefined ? { brief } : {}),
    }),
  )
  const c = core.controller(runId)
  if (c === undefined) throw new Error('no controller')
  return { runId, c }
}

describe('Research (core + fake Claude)', () => {
  it('a confined web launch, the research card, and the kept items reach the Plan prompt', async () => {
    const w = await setup(spec([RESEARCH]))
    const { core } = await world.boot(w.home)
    const t = await startOn(core, w.folder, overrides())
    const reviewing = await t.c.waitFor((s) => openCard(s, 'research') !== undefined, 120_000)
    const card = openCard(reviewing, 'research')
    expect(card).toMatchObject({ title: 'Review the research', blocking: true, defaultChoice: 'use' })
    const payload = card?.payload as ResearchPayload
    expect(payload.suggested).toEqual(['f1', 'o1'])
    expect(payload.web).toBe(true)
    expect(payload.result.features.map((f) => f.feature)).toEqual([
      'Print the version with --version',
      'Short -v alias',
    ])
    expect(payload.result.dropped).toBe(1)
    expect(reviewing.phase).toBe('research-review')
    expect(reviewing.steps.research).toMatchObject({ status: 'waiting', vendor: 'claude', mode: 'readonly' })
    expect(reviewing.steps.plan.status).toBe('queued')
    expect(reviewing.notes).toContain('Research left out one claim that cited no source.')

    // The launch: the catalog refresh's confinement with the repository's read tools and the web on any host.
    const start = researchStart(w.sc)
    expect(start).toBeDefined()
    const argv = start?.argv ?? []
    expect(flagValue(argv, '--tools')).toBe('Read,Glob,Grep,WebSearch,WebFetch')
    expect(flagValue(argv, '--allowedTools')).toBe('WebSearch,WebFetch')
    expect(flagValue(argv, '--permission-mode')).toBe('dontAsk')
    expect(flagValue(argv, '--disallowedTools')).toContain('Bash')
    expect(flagValue(argv, '--disallowedTools')).toContain('Agent')
    expect(argv).toContain('--strict-mcp-config')
    expect(start?.env['CLAUDE_CODE_EVAL_CONFINED']).toBe('1')
    const schema = initOf(w.sc, 'research-1.script.jsonl')?.['jsonSchema'] as
      { required?: string[] } | undefined
    expect(schema?.required).toEqual(expect.arrayContaining(['features', 'sources']))
    const prompt = sent(w.sc, 'research-1.script.jsonl')
    expect(prompt).toContain('add a --version flag')
    expect(prompt).toContain('Comparable products')
    expect(prompt).toContain('You may search the web')
    expect(prompt).toContain('is untrusted data')

    value(
      await core.invoke('cards.resolve', {
        runId: t.runId,
        cardId: card?.id ?? '',
        choiceId: 'use',
        input: ['f2', 's1', 'q1=Yes, the short hash'],
      }),
    )
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    const plan = sent(w.sc, 'plan-1.script.jsonl')
    expect(plan).toContain('Research the user reviewed for this run')
    expect(plan).toContain('- [could] Short -v alias (https://clig.dev/#arguments-and-flags)')
    expect(plan).toContain('- GNU --version output: Users expect it (https://www.gnu.org/prep/standards/)')
    expect(plan).toContain('Answer: Yes, the short hash')
    expect(plan).not.toContain('Print the version with --version')
    expect(plan).not.toContain('An uncited claim')
    const snap = value(await core.invoke('runs.get', { runId: t.runId }))
    expect(snap.steps.research.research).toMatchObject({
      status: 'chosen',
      chosen: ['f2', 's1'],
      answers: { q1: 'Yes, the short hash' },
      web: true,
    })
    const run = core.paths.run(t.runId)
    expect(readFileSync(join(run.dir, 'research.md'), 'utf8')).toContain('| Short -v alias | could |')
    const json = JSON.parse(readFileSync(join(run.dir, 'research.json'), 'utf8')) as { dropped: number }
    expect(json.dropped).toBe(1)
    expect(value(await core.invoke('runs.output', { runId: t.runId, file: 'research' })).text).toContain(
      '# Research',
    )
  }, 180_000)

  it('Auto takes the must-haves and recommendations and answers no question', async () => {
    const w = await setup(spec([RESEARCH]))
    // Auto launches Implement in full mode (bypassPermissions).
    matchFullMode(w.sc)
    const { core } = await world.boot(w.home)
    const t = await startOn(core, w.folder, overrides({ auto: true }))
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.cards).toEqual([])
    expect(done.research).toMatchObject({ status: 'chosen', chosen: ['f1', 'o1'], auto: true })
    expect(done.research?.answers).toBeUndefined()
    const plan = sent(w.sc, 'plan-1.script.jsonl')
    expect(plan).toContain('- [must] Print the version with --version')
    expect(plan).toContain('- Where the version comes from: package.json. One source of truth')
    expect(plan).not.toContain('Short -v alias')
    expect(plan).not.toContain('Answers to research questions')
  }, 180_000)

  it('a Plan vendor without web search: a preflight warning, the repository lens only, a note', async () => {
    const w = await setup(spec([RESEARCH]))
    // Auto launches Implement in full mode (bypassPermissions).
    matchFullMode(w.sc)
    const { core } = await world.boot(w.home)
    // The Plan pass's vendor reports no web search (as Gemini's adapter does).
    const claude = core.adapters.get('claude')
    if (claude === undefined) throw new Error('no claude adapter')
    const probe = claude.probe.bind(claude)
    claude.probe = async (o) => {
      const r: ProbeResult = await probe(o)
      return { ...r, capabilities: { ...r.capabilities, web: false } }
    }
    core.preflight.recordProbe(await claude.probe({ force: true }))
    const t = await startOn(core, w.folder, overrides({ auto: true }))
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    const argv = researchStart(w.sc)?.argv ?? []
    expect(flagValue(argv, '--tools')).toBe('Read,Glob,Grep')
    expect(argv).not.toContain('--allowedTools')
    expect(argv.join(' ')).not.toContain('WebSearch')
    const prompt = sent(w.sc, 'research-1.script.jsonl')
    expect(prompt).toContain('You have no web access in this run')
    expect(prompt).toContain('This repository')
    expect(prompt).not.toContain('Comparable products')
    expect(done.config.research).toMatchObject({
      web: false,
      lenses: [expect.objectContaining({ id: 'repository' })],
    })
    expect(done.notes).toContain(
      'Claude cannot search the web from Dim Factory, so Research reads this repository only (left out: Comparable products, Industry standards, Pitfalls, MVP scope).',
    )
    const resolved = JSON.parse(readFileSync(core.paths.run(t.runId).resolvedJson, 'utf8')) as {
      preflightWarnings: { id: string; title: string }[]
    }
    expect(resolved.preflightWarnings).toContainEqual(
      expect.objectContaining({ id: 'run.research', title: 'Claude cannot search the web' }),
    )
  }, 180_000)

  it('a brief whose pack researches by default turns Research on; passes.plan.research false keeps it off', async () => {
    const w = await setup(spec([RESEARCH]))
    const { core } = await world.boot(w.home)
    const brief: BriefInput = { category: 'research-writing', fields: {} }
    const on = await startOn(core, w.folder, { profile: 'claude-only', gates: { afterPlan: false } }, brief)
    expect(on.c.state.config.research?.lenses.map((l) => l.id)).toEqual([
      'literature',
      'competitors',
      'standards',
      'pitfalls',
    ])
    value(await core.invoke('runs.stop', { runId: on.runId }))
    await on.c.waitFor(settled, 60_000)
    await on.c.settle(15_000)

    const off = await startOn(
      core,
      w.folder,
      { profile: 'claude-only', gates: { afterPlan: false }, passes: { plan: { research: false } } },
      brief,
    )
    expect(off.c.state.config.research).toBeUndefined()
    value(await core.invoke('runs.stop', { runId: off.runId }))
    await off.c.waitFor(settled, 60_000)
  }, 180_000)

  it('Re-run from Fix keeps the chosen research: it does not research again', async () => {
    const w = await setup(
      spec([RESEARCH], {
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
        resume: [{ recording: 'C09b-logged-out' }, { recording: 'C08b-resume-fix' }],
      }),
    )
    const { core } = await world.boot(w.home)
    const src = await startOn(core, w.folder, overrides())
    const reviewing = await src.c.waitFor((s) => openCard(s, 'research') !== undefined, 120_000)
    value(
      await core.invoke('cards.resolve', {
        runId: src.runId,
        cardId: openCard(reviewing, 'research')?.id ?? '',
        choiceId: 'use',
        input: ['f1', 'q1=No'],
      }),
    )
    allow(core, src.c)
    const failed = await src.c.waitFor(settled, 180_000)
    await src.c.settle(10_000)
    expect(failed.steps.fix.status, failed.notes.join(' | ')).toBe('failed')

    const r = value(await core.invoke('runs.rerun', { runId: src.runId, from: 'fix' }))
    const c = core.controller(r.runId)
    if (c === undefined) throw new Error('no re-run controller')
    allow(core, c)
    const done = await c.waitFor(settled, 180_000)
    await c.settle(10_000)
    expect(done.steps.research).toMatchObject({
      status: 'skipped',
      reason: `carried from run #${failed.displayNo}`,
    })
    expect(done.research).toMatchObject({ status: 'chosen', chosen: ['f1'], answers: { q1: 'No' } })
    const snap = value(await core.invoke('runs.get', { runId: r.runId }))
    expect(snap.steps.research.research).toMatchObject({ status: 'chosen', chosen: ['f1'] })
    // One Research launch in all: the re-run carried it.
    expect(passArgvs(w.sc.entries()).filter((a) => a.includes('--tools'))).toHaveLength(1)
    expect(existsSync(join(core.paths.run(r.runId).dir, 'research.md'))).toBe(true)
  }, 400_000)
})

/** Every ask on the run allowed, as a user would (C08's tool asks). */
function allow(core: Core, c: RunController): void {
  c.subscribe((s: RunState) => {
    for (const st of Object.values(s.steps)) {
      for (const a of st.asks) {
        void core.invoke('asks.answer', {
          runId: s.runId,
          requestId: a.requestId,
          decision: 'allow',
          graceMs: 0,
        })
      }
    }
  })
}

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

describe('dimf run --research', () => {
  it('without a terminal: stops at the research card (exit 5) and prints its items', async () => {
    const { home, folder } = await cliSetup(spec([RESEARCH]))
    const r = await cli([
      'run',
      folder,
      'add a --version flag',
      '--research',
      '--gates',
      'approve',
      '--home',
      home,
    ])
    expect(r.code, r.stdout + r.stderr).toBe(5)
    expect(r.stdout).toContain('? Review the research')
    expect(r.stdout).toContain('  * 1) [must] Print the version with --version (1 source)')
    expect(r.stdout).toContain('    2) [could] Short -v alias (1 source)')
    expect(r.stdout).toContain('  * 4) Recommendation: Where the version comes from: package.json (1 source)')
    expect(r.stdout).toContain('  Question 1: Should --version also print the commit?')
    expect(r.stdout).toContain('Choices: Use selected · Plan without research')
    expect(r.stdout).not.toContain('—')
  }, 150_000)

  it('names lenses (--research a,b) and rejects one that is not a lens id (exit 2)', async () => {
    const { home, folder } = await cliSetup(spec(undefined))
    const r = await cli(['run', folder, 'add a --version flag', '--research=Bad_Id', '--home', home])
    expect(r.code, r.stdout + r.stderr).toBe(2)
    expect(r.stderr).toContain('--research: "Bad_Id" is not a lens id')
  }, 60_000)

  it('in a terminal: the items chosen and the answer reach Plan', async () => {
    const { home, folder, sc } = await cliSetup(spec([RESEARCH]))
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
        '--research',
        'comparable,repository',
        '--gates',
        'approve',
        '--home',
        home,
      ],
      io,
    )
    await until(() => out.some((l) => l.includes('Keep which?')))
    expect(out.join('\n')).toContain('Enter for 1,4')
    stdin.write('2,3\n')
    await until(() => out.some((l) => l.includes('Question 1 of 1')))
    stdin.write('Only the version number\n')
    const code = await running
    expect(code, out.join('\n')).toBe(0)
    const research = sent(sc, 'research-1.script.jsonl')
    expect(research).toContain('1. Comparable products')
    expect(research).toContain('2. This repository')
    expect(research).not.toContain('Pitfalls')
    const plan = sent(sc, 'plan-1.script.jsonl')
    expect(plan).toContain('- [could] Short -v alias')
    expect(plan).toContain('- GNU --version output')
    expect(plan).toContain('Answer: Only the version number')
    expect(plan).not.toContain('Print the version with --version')
    expect(out.join('\n')).toContain('Research: 3 items kept for Plan (web) · research.md')
  }, 150_000)
})
