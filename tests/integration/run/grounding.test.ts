// The grounding checks through a real core, the fake Claude and real verify commands (DIM_FACTORY_GROUNDING=on; the
// other test cores run without them, as their fake answers do not match the files they write):
//   - claims vs Verify: Implement says the tests pass, the `test` command fails: a [must] grounding finding beside the
//     verify one; both go to Fix, whose prompt lists it; findings.json has the grounding source
//   - an invented package: Implement adds `require('left-padx')`; Verify's "Cannot find module" is the code's failure
//     (a [must] flagged possible-hallucination), never the environment card (whose Skip verify Auto takes)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../src/core/app-core.ts'
import type { FindingsFile } from '../../../src/shared/findings.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { VerifyWorld, settled, value, verifyOverrides, version } from '../verify/helpers.ts'
import { hermeticEnv, stdinByScript } from './scenario.ts'

const world = new VerifyWorld()
afterEach(async () => world.dispose())

async function startGrounded(
  w: Awaited<ReturnType<VerifyWorld['setup']>>,
  overrides: Record<string, unknown>,
): Promise<{
  runId: string
  c: NonNullable<ReturnType<Awaited<ReturnType<typeof createCore>>['controller']>>
}> {
  const core = await createCore({
    home: w.home,
    host: { kind: 'app' },
    env: hermeticEnv({ DIM_FACTORY_GROUNDING: 'on' }),
  })
  world.cores.push(core)
  const events: RunEnvelope[] = []
  core.bus.attach({ name: 't', run: (e) => events.push(e) })
  const { runId } = value(
    await core.invoke('runs.start', { folder: w.folder, task: 'add a --version flag', overrides }),
  )
  const c = core.controller(runId)
  if (c === undefined) throw new Error('no controller')
  return { runId, c }
}

const userText = (line: string): string => {
  const v = JSON.parse(line) as { type?: string; message?: { content?: { text?: string }[] } }
  return v.type === 'user' ? (v.message?.content?.[0]?.text ?? '') : ''
}

describe('grounding checks (core + fake Claude + a real check)', () => {
  it('claims vs Verify: "all tests pass" while `test` fails is a [must] that goes to Fix', async () => {
    const w = await world.setup({
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        {
          recording: 'C08a-session-id-implement',
          write: version('0.1.0'),
          text: 'Updated `src/version.ts`. All tests pass.',
        },
      ],
      resume: [{ recording: 'C08b-resume-fix', write: version('1.0.0'), text: 'F1 fixed\nF2 fixed' }],
    })
    await world.trust(w.home, w.folder, ['node', 'check.mjs'])
    const t = await startGrounded(w, verifyOverrides([{ name: 'test', run: ['node', 'check.mjs'] }]))
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    expect(done).toMatchObject({ status: 'completed', outcome: 'fixed' })
    expect(done.grounding?.checks['implement']?.phase).toBe('done')
    const ff = JSON.parse(
      readFileSync(join(w.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    const g = ff.findings.find((f) => f.source === 'grounding')
    expect(g).toMatchObject({
      severity: 'must',
      title: "The AI said the tests pass, but Verify's `test` failed.",
    })
    expect(ff.selected[g?.id ?? '']).toBe(true)
    expect(ff.sources.grounding).toMatchObject({ status: 'ok' })
    expect(done.notes.some((n) => n.includes('grounding checks found'))).toBe(true)
    // Fix's prompt carries it.
    const fix = (stdinByScript(w.sc.entries()).get('resume-1.script.jsonl') ?? []).map(userText).join('\n')
    expect(fix).toContain("The AI said the tests pass, but Verify's `test` failed.")
    // The check after Fix ran too.
    expect(done.grounding?.checks['fix:1']?.phase).toBe('done')
  }, 180_000)

  it("a package the run's own code requires and nobody installed is a failure, not an environment problem", async () => {
    const w = await world.setup(
      {
        plan: { recording: 'C06-plan-native-host' },
        implement: [
          {
            recording: 'C08a-session-id-implement',
            write: {
              path: 'src/app.cjs',
              content: "const pad = require('left-padx')\nconsole.log(pad('x'))\n",
            },
            text: 'Added `src/app.cjs`.',
          },
        ],
      },
      {},
    )
    await world.trust(w.home, w.folder, ['node', 'src/app.cjs'])
    const t = await startGrounded(
      w,
      verifyOverrides([{ name: 'app', run: ['node', 'src/app.cjs'] }], {
        passes: { review: { enabled: false }, critic: { enabled: false }, fix: { enabled: false } },
      }),
    )
    const done = await t.c.waitFor(settled, 120_000)
    await t.c.settle(15_000)
    const cmd = done.steps['verify:1'].verify?.commands[0]
    expect(cmd).toMatchObject({ status: 'fail' })
    expect(done.cards.some((c) => c.view.kind === 'verifyEnv')).toBe(false)
    const ff = JSON.parse(
      readFileSync(join(w.home, 'runs', t.runId, 'findings.json'), 'utf8'),
    ) as FindingsFile
    const v = ff.findings.find((f) => f.source === 'verify')
    expect(v).toMatchObject({ severity: 'must' })
    expect(v?.flags).toContain('possible-hallucination')
    expect(done.outcome).toBe('findings-open')
  }, 180_000)
})
