// Chaos: ENOSPC (failure category disk_full; every home write is write-ahead and atomic): a full drive under the
// home's writes (run.json, events.jsonl, runs/index.jsonl, catalog, trust.json, dimfactory.json, a run's diffs and
// procs.json), injected on the real write paths through vi.mock (fs-faults.ts: a short write, then ENOSPC). Each write
// fails with a clear disk_full answer, leaves no partial or temp file, and works again once space returns. Fixed here,
// each with its case as the proof: a run on a full drive went on starting passes whose progress it could not save (now
// the pass fails disk_full with Retry); procs.json's and the shadow's writer left half-written temp files; a run's diff
// patches were written in place, so a full drive left half a patch for the Diff tab.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomicLite } from '../../../src/core/proc/atomic-lite.ts'
import { writePromptFile } from '../../../src/core/supervisor/effects.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { passArgvs } from '../run/scenario.ts'
import { faults, under } from './fs-faults.ts'
import {
  ASK_SPEC,
  Chaos,
  FULL_SPEC,
  consistency,
  homeFiles,
  logEnvelopes,
  settled,
  sleep,
  value,
} from './helpers.ts'

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./fs-faults.ts')).faultyFsPromises(await importOriginal<typeof FsPromises>()),
)

const chaos = new Chaos()
afterEach(async () => {
  faults.reset()
  await chaos.dispose()
})

const OVERRIDES = {
  profile: 'claude-only',
  gates: { afterPlan: false, beforeFix: false },
  verify: { enabled: false },
}
const CLEAN = { badJson: [], badLines: [], tornTail: [], temps: [] }

/** A disk_full STORAGE answer (errors.ts storageError). */
const DISK_FULL = {
  ok: false,
  error: expect.objectContaining({
    code: 'STORAGE',
    message: expect.stringMatching(/no space left on device/) as string,
    details: { errno: 'ENOSPC', category: 'disk_full' },
  }) as object,
}

/** A full drive under `dir`: every write (a short one first) and every new folder there fail with ENOSPC. */
function fillDrive(dir: string): void {
  faults.add({ op: 'write', code: 'ENOSPC', match: under(dir) })
  faults.add({ op: 'mkdir', code: 'ENOSPC', match: under(dir) })
  faults.add({ op: 'copyFile', code: 'ENOSPC', match: under(dir) })
}

const snag = (events: RunEnvelope[], step: string): Extract<RunEnvelope['body'], { t: 'snag' }> | undefined =>
  events
    .map((e) => e.body)
    .filter((b): b is Extract<RunEnvelope['body'], { t: 'snag' }> => b.t === 'snag' && b.step === step)
    .at(-1)

describe('chaos: ENOSPC on the home', () => {
  it('runs.start on a full drive: disk_full, no half-made run; once space returns a run starts and completes', async () => {
    const w = await chaos.world(FULL_SPEC)
    const { core } = await chaos.relaunch(w)
    fillDrive(join(w.home, 'runs'))
    const r = await core.invoke('runs.start', {
      folder: w.folder,
      task: 'add a --version flag',
      overrides: OVERRIDES,
    })
    expect(r).toMatchObject(DISK_FULL)
    expect(faults.log.length).toBeGreaterThan(0)
    expect(value(await core.invoke('runs.list', {})).items).toEqual([])
    expect(readdirSync(join(w.home, 'runs'), { withFileTypes: true }).filter((d) => d.isDirectory())).toEqual(
      [],
    )
    expect(homeFiles(w.home)).toEqual(CLEAN)
    expect(passArgvs(w.sc.entries())).toEqual([])

    faults.clear()
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: OVERRIDES,
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    expect(await c.waitFor(settled, 180_000)).toMatchObject({ status: 'completed', outcome: 'clean' })
    await chaos.stop(core)
    expect(consistency(w.home, runId)).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)
  }, 300_000)

  it("a drive that fills between passes: Implement is not started blind, it fails disk_full; Retry finishes once there's space", async () => {
    const w = await chaos.world(FULL_SPEC)
    const { core, events } = await chaos.relaunch(w)
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: OVERRIDES,
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    // The drive fills as soon as Plan is done: run.json, events.jsonl, the runs index and every other run file.
    let full = false
    c.subscribe((s) => {
      if (!full && s.steps.plan.status === 'done') {
        full = true
        fillDrive(join(w.home, 'runs'))
      }
    })
    const failed = await c.waitFor((s) => s.steps.implement.status === 'failed' || settled(s), 120_000)
    await c.settle(15_000)
    expect(failed.steps.implement.status).toBe('failed')
    expect(failed.steps.implement.failure).toMatchObject({
      category: 'disk_full',
      message: expect.stringMatching(
        /^The drive is full, so Dim Factory could not save this run's progress/,
      ) as string,
    })
    // No vendor process ran a pass whose start was never recorded.
    expect(passArgvs(w.sc.entries()).filter((a) => a.includes('acceptEdits'))).toEqual([])
    // disk_full: Clear snapshots and Retry on the snag.
    expect(snag(events, 'implement')?.actions.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['settings_link', 'retry']),
    )
    expect(faults.log.some((l) => / run\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(l))).toBe(true)
    // Nothing half written: no temp file, every JSON file parses (run.json is the last one that fit).
    const during = homeFiles(w.home)
    expect(during.temps).toEqual([])
    expect(during.badJson).toEqual([])
    expect(during.badLines).toEqual([])

    faults.clear()
    value(await core.invoke('runs.retryPass', { runId, pass: 'implement' }))
    const end = await c.waitFor(settled, 180_000)
    expect(end).toMatchObject({ status: 'completed', outcome: 'clean' })
    await chaos.stop(core)
    expect(consistency(w.home, runId)).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)
  }, 300_000)

  it('Settings on a full drive (config, trust, catalog): disk_full, nothing changed; once space returns each saves', async () => {
    const w = await chaos.world(FULL_SPEC)
    const { core } = await chaos.relaunch(w)
    const userConfig = readFileSync(join(w.home, 'dimfactory.json'), 'utf8')
    const pricingFile = join(w.home, 'catalog', 'pricing.json')
    const pricing = existsSync(pricingFile) ? readFileSync(pricingFile, 'utf8') : null
    fillDrive(w.home)
    const config = {
      scope: 'user' as const,
      ops: [{ op: 'add' as const, path: '/ui', value: { theme: 'dark' } }],
    }
    const trust = {
      folder: w.folder,
      grant: { kind: 'vendorFolder' as const, vendor: 'gemini' as const },
      trusted: true,
    }
    const price = {
      entry: {
        vendor: 'claude' as const,
        model: 'claude-opus-5-5',
        inputPerMTok: 5,
        outputPerMTok: 26,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
    }
    expect(await core.invoke('config.patch', config)).toMatchObject(DISK_FULL)
    expect(await core.invoke('trust.set', trust)).toMatchObject(DISK_FULL)
    expect(await core.invoke('catalog.savePrice', price)).toMatchObject(DISK_FULL)
    expect(readFileSync(join(w.home, 'dimfactory.json'), 'utf8')).toBe(userConfig)
    expect(existsSync(join(w.home, 'trust.json'))).toBe(false)
    expect(existsSync(pricingFile) ? readFileSync(pricingFile, 'utf8') : null).toBe(pricing)
    expect(homeFiles(w.home)).toEqual(CLEAN)

    faults.clear()
    expect((await core.invoke('config.patch', config)).ok).toBe(true)
    expect((await core.invoke('trust.set', trust)).ok).toBe(true)
    expect((await core.invoke('catalog.savePrice', price)).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(w.home, 'dimfactory.json'), 'utf8'))).toMatchObject({
      ui: { theme: 'dark' },
    })
    expect(value(await core.invoke('trust.get', { folder: w.folder })).grants.vendorFolder).toHaveProperty(
      'gemini',
    )
    expect(homeFiles(w.home)).toEqual(CLEAN)
  }, 300_000)

  it('a drive full for a while during a pass: it goes on, its ask is answered, and every line lands once space returns', async () => {
    const w = await chaos.world(ASK_SPEC)
    const { core } = await chaos.relaunch(w)
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: OVERRIDES,
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    // Full as soon as Implement's process is up: its stream, its ask and the transitions they make are not saved.
    let full = false
    c.subscribe((s) => {
      if (!full && s.steps.implement.proc?.live === true) {
        full = true
        fillDrive(join(w.home, 'runs'))
      }
    })
    const asked = await c.waitFor((s) => s.steps.implement.asks.length > 0 || settled(s), 120_000)
    const first = asked.steps.implement.asks[0]
    if (first === undefined) throw new Error(`no ask: ${asked.status}`)
    expect(faults.log.some((l) => /^write ENOSPC events\.jsonl$/.test(l))).toBe(true)
    expect(faults.log.some((l) => /^write ENOSPC run\.json\./.test(l))).toBe(true)
    // While full, the user still sees and answers the pass's ask (from memory); then space returns.
    await sleep(1500)
    faults.clear()
    value(await core.invoke('asks.answer', { runId, requestId: first.requestId, decision: 'allow' }))
    const s2 = await c.waitFor(
      (s) => s.steps.implement.asks.some((a) => a.requestId !== first.requestId) || settled(s),
      60_000,
    )
    const second = s2.steps.implement.asks[0]
    if (second !== undefined)
      value(await core.invoke('asks.answer', { runId, requestId: second.requestId, decision: 'allow' }))
    expect(await c.waitFor(settled, 180_000)).toMatchObject({ status: 'completed', outcome: 'clean' })
    await chaos.stop(core)
    // Nothing the full drive held back was lost: the ask raised while full is in the log, once, with its answer.
    const bodies = logEnvelopes(w.home, runId).map((e) => e.body)
    expect(
      bodies.filter((b) => b.t === 'ev' && b.ev.type === 'ask' && b.ev.requestId === first.requestId),
    ).toHaveLength(1)
    expect(bodies.filter((b) => b.t === 'ask-resolved' && b.requestId === first.requestId)).toEqual([
      expect.objectContaining({ by: 'user', decision: 'allow' }),
    ])
    expect(consistency(w.home, runId)).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)
  }, 300_000)

  it("procs.json's (and the shadow's) writer and a run's diff patches leave nothing half written", async () => {
    const w = await chaos.world(FULL_SPEC)
    const dir = join(w.home, 'runs', 'r1')
    const procs = join(dir, 'procs.json')
    const patch = join(dir, 'diffs', 'S0..S1.patch')
    await writeFileAtomicLite(procs, '{"schemaVersion":1,"procs":[]}\n')
    fillDrive(dir)
    await expect(
      writeFileAtomicLite(procs, `{"schemaVersion":1,"procs":[${'0,'.repeat(500)}0]}\n`),
    ).rejects.toMatchObject({
      code: 'ENOSPC',
    })
    await expect(
      writePromptFile(patch, `diff --git a/x b/x\n${'+line\n'.repeat(500)}`),
    ).rejects.toMatchObject({
      details: { category: 'disk_full' },
    })
    expect(readFileSync(procs, 'utf8')).toBe('{"schemaVersion":1,"procs":[]}\n')
    expect(existsSync(patch)).toBe(false)
    expect(homeFiles(w.home)).toEqual(CLEAN)
    expect(readdirSync(dir).sort()).toEqual(['procs.json'])

    faults.clear()
    await writePromptFile(patch, 'diff --git a/x b/x\n')
    expect(readFileSync(patch, 'utf8')).toBe('diff --git a/x b/x\n')
  }, 120_000)
})
