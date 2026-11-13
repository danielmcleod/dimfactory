// Chaos: EPERM storms (atomic writes: the temp open and the rename retried
// 50/100/200/400/800 ms on EPERM/EBUSY/EACCES; jsonl.ts: a failed append keeps its lines and retries): the
// antivirus-style sharing violations Windows raises while a scanner or the indexer holds a file, injected on the real
// write paths through vi.mock (fs-faults.ts). A storm that comes and goes is ridden out (every write lands, the run
// completes and its files agree); one that does not pass fails each write cleanly (STORAGE with its errno, nothing
// changed, no temp file) and everything works once it is over. Fixed here, with the first case as the proof: the
// shadow's and procs.json's writer (proc/atomic-lite.ts) did not retry the temp file's open, so a storm on new files
// failed the run's snapshots (snapshot_failed) though every other write rode it out.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { passArgvs } from '../run/scenario.ts'
import { faults, under } from './fs-faults.ts'
import { Chaos, FULL_SPEC, consistency, homeFiles, settled, value } from './helpers.ts'

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

describe('chaos: EPERM / EBUSY storms on the home', () => {
  it('a storm that comes and goes: every write rides it out and the run completes consistent', async () => {
    const w = await chaos.world(FULL_SPEC)
    const { core } = await chaos.relaunch(w, { heal: null })
    // Each target's rename fails three times, then goes through; each new temp file is busy twice; each append to a
    // JSONL file fails twice in three (always within the retry schedule).
    const renames = faults.add({
      op: 'rename',
      code: 'EPERM',
      match: under(w.home),
      cycle: { fail: 3, pass: 1 },
    })
    const opens = faults.add({
      op: 'open',
      code: 'EBUSY',
      match: under(w.home, /\.tmp$/),
      cycle: { fail: 2, pass: 1 },
    })
    const appends = faults.add({
      op: 'write',
      code: 'EBUSY',
      match: under(w.home, /\.jsonl$/),
      cycle: { fail: 2, pass: 1 },
    })
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: OVERRIDES,
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const end = await c.waitFor(settled, 240_000)
    await c.settle(30_000)
    expect(end.notes.filter((n) => /could not|failed/i.test(n))).toEqual([])
    expect(end).toMatchObject({ status: 'completed', outcome: 'clean' })
    expect(renames.hits).toBeGreaterThan(20)
    expect(opens.hits).toBeGreaterThan(10)
    expect(appends.hits).toBeGreaterThan(5)
    // The shadow's own files went through the storm too (proc/atomic-lite.ts).
    expect(faults.log.some((l) => /^open EBUSY (config|meta\.json|procs\.json)\./.test(l))).toBe(true)
    await chaos.stop(core)
    faults.clear()
    expect(consistency(w.home, runId)).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)
  }, 300_000)

  it('a storm that does not pass: each write fails cleanly with its errno, nothing changes; then all of it works', async () => {
    const w = await chaos.world(FULL_SPEC)
    const { core } = await chaos.relaunch(w, { heal: null })
    const userConfig = readFileSync(join(w.home, 'dimfactory.json'), 'utf8')
    const pricingFile = join(w.home, 'catalog', 'pricing.json')
    const pricing = existsSync(pricingFile) ? readFileSync(pricingFile, 'utf8') : null
    faults.add({ op: 'rename', code: 'EPERM', match: under(w.home) })
    const eperm = {
      ok: false,
      error: expect.objectContaining({ code: 'STORAGE', details: { errno: 'EPERM' } }) as object,
    }
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
    expect(await core.invoke('config.patch', config)).toMatchObject(eperm)
    expect(await core.invoke('trust.set', trust)).toMatchObject(eperm)
    expect(await core.invoke('catalog.savePrice', price)).toMatchObject(eperm)
    expect(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: OVERRIDES,
      }),
    ).toMatchObject(eperm)
    expect(readFileSync(join(w.home, 'dimfactory.json'), 'utf8')).toBe(userConfig)
    expect(existsSync(join(w.home, 'trust.json'))).toBe(false)
    expect(existsSync(pricingFile) ? readFileSync(pricingFile, 'utf8') : null).toBe(pricing)
    expect(readdirSync(join(w.home, 'runs'), { withFileTypes: true }).filter((d) => d.isDirectory())).toEqual(
      [],
    )
    expect(passArgvs(w.sc.entries())).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)

    faults.clear()
    expect((await core.invoke('config.patch', config)).ok).toBe(true)
    expect((await core.invoke('trust.set', trust)).ok).toBe(true)
    expect((await core.invoke('catalog.savePrice', price)).ok).toBe(true)
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

  it('a storm on run.json that outlasts the retries: the next pass is not started blind; Retry finishes after it', async () => {
    const w = await chaos.world(FULL_SPEC)
    const { core } = await chaos.relaunch(w, { heal: null })
    const { runId } = value(
      await core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: OVERRIDES,
      }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    let storm = false
    c.subscribe((s) => {
      if (!storm && s.steps.plan.status === 'done') {
        storm = true
        faults.add({ op: 'rename', code: 'EPERM', match: under(join(w.home, 'runs', runId), /^run\.json$/) })
      }
    })
    const failed = await c.waitFor((s) => s.steps.implement.status === 'failed' || settled(s), 120_000)
    await c.settle(15_000)
    expect(failed.steps.implement.failure).toMatchObject({
      category: 'unknown',
      message: expect.stringMatching(
        /^Dim Factory could not save this run's progress, so it did not start Implement: .*EPERM/,
      ) as string,
    })
    expect(passArgvs(w.sc.entries()).filter((a) => a.includes('acceptEdits'))).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)

    faults.clear()
    value(await core.invoke('runs.retryPass', { runId, pass: 'implement' }))
    expect(await c.waitFor(settled, 180_000)).toMatchObject({ status: 'completed', outcome: 'clean' })
    await chaos.stop(core)
    expect(consistency(w.home, runId)).toEqual([])
    expect(homeFiles(w.home)).toEqual(CLEAN)
  }, 300_000)
})
