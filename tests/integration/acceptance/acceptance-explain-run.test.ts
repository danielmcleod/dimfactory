// The acceptance review and Explain it to me through a real core and the CLI (the fake Claude; no network):
//   - core: the plan gate's edited plan lists acceptance criteria; the acceptance review runs read-only on Review's
//     model before Review (so it takes the first `review` entry) with a structured answer; acceptance.json has the
//     checklist; Explain runs on the Plan pass's model at the end and writes explain.md, which runs.output serves;
//     the outcome is the one the run reached (clean)
//   - CLI: `dimf run --acceptance --explain --plan-file` prints the checklist and explain.md at the end
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import type { CliIo } from '../../../src/cli/io.ts'
import type { AcceptanceFile } from '../../../src/shared/acceptance.ts'
import { hermeticEnv, stdinByScript } from '../run/scenario.ts'
import type { PassScript, Scenario, ScenarioSpec } from '../run/scenario.ts'
import { VerifyWorld, openCard, settled, value } from '../verify/helpers.ts'

const world = new VerifyWorld()
afterEach(async () => {
  await world.dispose()
})

const PLAN = [
  '## Goal',
  'Add a --version flag.',
  '',
  '## Steps',
  '1. Add `src/version.ts` (new)',
  '',
  '## Acceptance criteria',
  '- `--version` prints 1.0.0',
  '- The help text lists --version',
  '',
  '## Risks',
  '- none',
].join('\n')

const VERDICTS = {
  verdicts: [
    { id: 'AC1', status: 'met', evidence: 'src/version.ts exports 1.0.0' },
    { id: 'AC2', status: 'not-met', evidence: 'the help text was not changed' },
  ],
}
const ACCEPTANCE: PassScript = {
  recording: 'C02-review-shape',
  text: JSON.stringify(VERDICTS),
  structured: VERDICTS,
}
const SUMMARY = [
  '## What was built',
  'The tool now tells you its version.',
  '',
  '## How to run it',
  '1. Run `node src/cli.js --version`.',
  '',
  '## What to try next',
  '- Check the help text.',
  '',
  '## Known limits',
  '- The help text does not list the flag yet.',
].join('\n')
const EXPLAIN: PassScript = { recording: 'C02-review-shape', text: SUMMARY }

const versionWrite = { path: 'src/version.ts', content: 'export const version = "1.0.0"\n' }

const spec: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
  review: [ACCEPTANCE],
  explain: [EXPLAIN],
}

const overrides = {
  profile: 'claude-only',
  gates: { afterPlan: true, beforeFix: false },
  // Explain runs on the Plan pass's model: haiku, so the scenario tells it from Critic (opus).
  passes: { review: { acceptance: true }, plan: { explain: true, model: 'haiku' } },
}

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}
const sent = (sc: Scenario, script: string): string =>
  (stdinByScript(sc.entries()).get(script) ?? []).map(userText).find((x) => x !== '') ?? ''

describe('the acceptance review and Explain it to me (core + fake Claude)', () => {
  it('checks the criteria before Review, writes acceptance.json and explain.md, and keeps the outcome', async () => {
    const w = await world.setup(spec, {})
    const { core } = await world.boot(w.home)
    const { runId } = value(
      await core.invoke('runs.start', { folder: w.folder, task: 'add a --version flag', overrides }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const gate = await c.waitFor((s) => openCard(s, 'gate:afterPlan') !== undefined || settled(s), 120_000)
    const card = openCard(gate, 'gate:afterPlan')
    value(
      await core.invoke('cards.resolve', { runId, cardId: card?.id ?? '', choiceId: 'approve', input: PLAN }),
    )
    const done = await c.waitFor(settled, 180_000)
    await c.settle(15_000)
    expect(done.status, JSON.stringify(done.notes)).toBe('completed')
    expect(done.outcome).toBe('clean')
    expect(done.notes).toContain('Acceptance: 1 of 2 criteria met, 1 not met.')

    // The acceptance review: Review's model, read-only, before Review; its prompt lists the criteria and the diff.
    const prompt = sent(w.sc, 'review-1.script.jsonl')
    expect(prompt).toContain('You are the acceptance review')
    expect(prompt).toContain('- AC1: `--version` prints 1.0.0')
    expect(prompt).toContain('src/version.ts')
    // Implement was told to build to the criteria.
    expect(sent(w.sc, 'implement-1.script.jsonl')).toContain('Acceptance criteria (build to meet each one)')

    const dir = core.paths.run(runId).dir
    const doc = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8')) as AcceptanceFile
    expect(doc.review).toBe('done')
    expect(doc.criteria.map((x) => [x.id, x.status, x.evidence])).toEqual([
      ['AC1', 'met', 'src/version.ts exports 1.0.0'],
      ['AC2', 'not-met', 'the help text was not changed'],
    ])
    const snap = value(await core.invoke('runs.get', { runId }))
    expect(snap.acceptance?.counts).toEqual({ met: 1, notMet: 1, unknown: 0, notChecked: 0 })
    expect(snap.steps.acceptance).toMatchObject({
      status: 'done',
      vendor: 'claude',
      model: 'sonnet',
      mode: 'readonly',
    })
    // No Fix until green: the unmet criterion is a summary only, never a finding.
    expect(snap.summary.findings).toEqual({ must: 0, should: 0 })

    // Explain: the Plan pass's model, after the outcome; explain.md served by runs.output.
    expect(snap.steps.explain).toMatchObject({ status: 'done', model: 'haiku', mode: 'readonly' })
    const explainPrompt = sent(w.sc, 'explain-1.script.jsonl')
    expect(explainPrompt).toContain('for someone who does not write code')
    expect(explainPrompt).toContain('- added: src/version.ts')
    expect(explainPrompt).toContain('- Not met: The help text lists --version')
    expect(readFileSync(join(dir, 'explain.md'), 'utf8')).toBe(`${SUMMARY}\n`)
    const out = value(await core.invoke('runs.output', { runId, file: 'explain' }))
    expect(out.text).toContain('## How to run it')
  }, 300_000)
})

describe('dimf run --acceptance --explain', () => {
  it('prints the checklist and explain.md at the end of the run', async () => {
    const w = await world.setup({ ...spec, review: [ACCEPTANCE] }, {})
    const planFile = join(w.folder, '..', 'plan.md')
    writeFileSync(planFile, PLAN)
    const out: string[] = []
    const io: Partial<CliIo> = {
      out: (l) => out.push(l),
      write: (t) => out.push(t),
      err: (l) => out.push(l),
      stdin: Readable.from([]),
      isTTY: false,
      env: hermeticEnv(),
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    const code = await main(
      [
        'run',
        w.folder,
        'add a --version flag',
        '--profile',
        'claude-only',
        '--acceptance',
        '--explain',
        '--set',
        'passes.plan.model=haiku',
        '--gates',
        'approve',
        '--plan-file',
        planFile,
        '--home',
        w.home,
      ],
      io,
    )
    const text = out.join('\n')
    expect(code, text).toBe(0)
    expect(text).toContain('Acceptance: 1 of 2 criteria met, 1 not met.')
    expect(text).toContain('[Met] AC1 `--version` prints 1.0.0 · src/version.ts exports 1.0.0')
    expect(text).toContain('[Not met] AC2 The help text lists --version · the help text was not changed')
    expect(text).toContain('Explain it to me (explain.md):')
    expect(text).toContain('  ## What was built')
    expect(text).toContain('  1. Run `node src/cli.js --version`.')
  }, 300_000)
})
