// Re-run with same config through a real core and the fake Claude ("Re-run loads resolved.json.config through
// ResolvedConfigZ ... Trust is re-checked by the authoritative preflight", state-machine row R14,
// history.spec.ts "re-run with same config (resolved.json equal)"), and `dimf rerun` (the dev CLI):
//   - the re-run's resolved.json equals the source's but for one run's start facts (resolved-json.ts), with patches
//     folded in and `rerunOf` naming the source; same task, folder and title
//   - a tampered resolved.json (mode "full" without auto) is refused; a blocked preflight creates no run folder
//   - `dimf rerun <id> --from-fix` follows the re-run to its end (exit 0)
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../../../src/cli/dimf.ts'
import { sameResolvedSettings } from '../../../src/core/resolved-json.ts'
import { hermeticEnv } from '../run/scenario.ts'
import {
  Bench,
  RESUMED_FIX,
  SOURCE,
  TASK,
  readJson,
  runDirs,
  settled,
  value,
  versionWrite,
} from './helpers.ts'

const b = new Bench()
afterEach(() => b.dispose())

describe('Re-run with same config (core + fake Claude)', () => {
  it('the re-run’s resolved.json equals the source’s (settings, patches folded), naming its source', async () => {
    const core = await b.setup({
      plan: [{ recording: 'C06-plan-native-host' }, { recording: 'C06-plan-native-host' }],
      implement: [
        { recording: 'C08a-session-id-implement', write: versionWrite },
        { recording: 'C08a-session-id-implement', write: { path: 'src/again.ts', content: 'export {}\n' } },
      ],
    })
    const src = await b.start(core, { gates: { afterPlan: false } })
    const first = await src.waitFor(settled, 120_000)
    await src.settle(10_000)
    expect(first.outcome, first.notes.join(' | ')).toBe('clean')
    // A recovery patch the source ran with (resolved.json patches[]): the re-run starts with it applied.
    const srcResolvedFile = core.paths.run(src.runId).resolvedJson
    const srcResolved = readJson(srcResolvedFile)
    srcResolved['patches'] = [
      {
        at: 1,
        ops: [{ op: 'replace', path: '/timeouts/stallMs', value: 420000 }],
        label: 'Wait longer',
        source: 'recovery',
      },
    ]
    writeFileSync(srcResolvedFile, JSON.stringify(srcResolved, null, 2))

    const r = value(await core.invoke('runs.rerun', { runId: src.runId, from: 'start' }))
    const c = b.controller(core, r.runId)
    const done = await c.waitFor(settled, 120_000)
    await c.settle(10_000)
    expect(done.status, done.notes.join(' | ')).toBe('completed')
    expect(done).toMatchObject({
      task: first.task,
      title: first.title,
      folder: first.folder,
      profile: first.profile,
    })
    expect(done.task).toBe(TASK)
    expect(done.rerunOf).toEqual({ runId: src.runId, displayNo: first.displayNo, from: 'start' })
    // It ran the whole pipeline again.
    expect(done.steps.plan.status).toBe('done')
    expect(done.steps.implement.status).toBe('done')
    expect(done.config.timeouts.stallMs).toBe(420000)

    const rerunResolved = readJson(core.paths.run(r.runId).resolvedJson)
    expect(sameResolvedSettings(srcResolved, rerunResolved)).toBe(true)
    expect(rerunResolved['patches']).toEqual([])
    expect(rerunResolved['rerunOf']).toEqual({ runId: src.runId, displayNo: first.displayNo, from: 'start' })
    expect(rerunResolved['provenance']).toEqual(srcResolved['provenance'])
    expect(rerunResolved['layers']).toEqual(srcResolved['layers'])
    // Not equal to a run with other settings.
    const other = structuredClone(rerunResolved)
    ;(other['config'] as { gates: { afterPlan: boolean } }).gates.afterPlan = true
    expect(sameResolvedSettings(srcResolved, other)).toBe(false)
    expect(core.summary(r.runId)?.rerunOf).toEqual({
      runId: src.runId,
      displayNo: first.displayNo,
      from: 'start',
    })
  }, 300_000)

  it('refused, with no run folder made: a tampered resolved.json, a blocked preflight, a run still going', async () => {
    const core = await b.setup({ plan: [{ recording: 'C06-plan-native-host', delayMs: 120_000 }] })
    const src = await b.start(core, { gates: { afterPlan: false } })
    await src.waitFor((s) => s.steps.plan.proc?.live === true, 120_000)
    const before = runDirs(b.home)
    // Still going: Re-run waits for the run to finish, fail, pause or stop.
    const going = await core.invoke('runs.rerun', { runId: src.runId, from: 'start' })
    expect(going.ok === false && going.error.code).toBe('CONFLICT')
    value(await core.invoke('runs.stop', { runId: src.runId }))
    await src.waitFor((s) => s.status === 'cancelled' && s.lock === 'none', 60_000)
    await src.settle(10_000)

    const file = core.paths.run(src.runId).resolvedJson
    const text = readFileSync(file, 'utf8')
    const tampered = JSON.parse(text) as {
      config: { auto: boolean; passes: { implement: { mode: string } } }
    }
    tampered.config.auto = false
    tampered.config.passes.implement.mode = 'full'
    writeFileSync(file, JSON.stringify(tampered))
    const bad = await core.invoke('runs.rerun', { runId: src.runId, from: 'start' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.code).toBe('VALIDATION')
      expect(bad.error.message).toContain(
        '/config/passes/implement/mode: mode "full" is only valid together with auto: true',
      )
    }
    expect(runDirs(b.home)).toEqual(before)

    // Re-run from Fix of a run that never reached Implement: not offered, with why.
    const fromFix = await core.invoke('runs.rerun', { runId: src.runId, from: 'fix' })
    expect(fromFix.ok === false && fromFix.error.code).toBe('CONFLICT')

    // The folder is gone: the authoritative preflight blocks it (no run folder).
    writeFileSync(file, text)
    rmSync(b.folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    const blocked = await core.invoke('runs.rerun', { runId: src.runId, from: 'start' })
    expect(blocked.ok === false && blocked.error.code).toBe('PREFLIGHT_BLOCKED')
    expect(runDirs(b.home)).toEqual(before)

    const missing = await core.invoke('runs.rerun', { runId: 'nope', from: 'start' })
    expect(missing.ok === false && missing.error.code).toBe('NOT_FOUND')
  }, 300_000)
})

describe('dimf rerun', () => {
  it('--from-fix follows the re-run to its end (exit 0) after the app core let the home go', async () => {
    const core = await b.setup({ ...SOURCE, resume: [RESUMED_FIX] })
    const src = await b.start(core, { gates: { afterPlan: false, beforeFix: true } })
    const atGate = await src.waitFor((s) => s.cards.some((x) => x.view.kind === 'gate:beforeFix'), 120_000)
    const gate = atGate.cards.find((x) => x.view.kind === 'gate:beforeFix')
    value(
      await core.invoke('cards.resolve', {
        runId: src.runId,
        cardId: gate?.view.id ?? '',
        choiceId: 'cancel',
      }),
    )
    await src.waitFor((s) => s.status === 'cancelled' && s.lock === 'none', 60_000)
    await core.shutdown()

    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      write: (t: string) => out.push(t),
      err: (l: string) => out.push(l),
      stdin: Readable.from([]),
      isTTY: false,
      env: hermeticEnv(),
      cwd: process.cwd(),
      onInterrupt: () => () => undefined,
    }
    const code = await main(
      [
        'rerun',
        src.runId,
        '--from-fix',
        '--home',
        b.home,
        '--gates',
        'approve',
        '--cards',
        'default',
        '--asks',
        'allow',
      ],
      io,
    )
    const text = out.join('\n')
    expect(code, text).toBe(0)
    expect(text).toContain(`re-runs from Fix run #${atGate.displayNo}`)
    expect(text).toContain(`Plan, Implement, Review and Critic are carried from run #${atGate.displayNo}`)
    expect(text).toContain(`Review skipped (carried from run #${atGate.displayNo})`)

    // `dimf show` names the source; usage errors exit 2.
    const shown: string[] = []
    const ids = runDirs(b.home)
    const rerunId = ids.find((id) => id !== src.runId) ?? ''
    expect(await main(['show', rerunId, '--home', b.home], { ...io, out: (l) => shown.push(l) })).toBe(0)
    expect(shown.join('\n')).toContain(`Re-run:  of run #${atGate.displayNo} (${src.runId}) from Fix`)
    expect(await main(['rerun', src.runId, '--findings', 'F1', '--home', b.home], io)).toBe(2)
  }, 300_000)
})
