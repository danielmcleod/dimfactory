// Catalog data through a real core (the catalog refresh, estimates: estimates use new prices at once; the
// scheduler on a fake clock): a finished refresh job's diff review in catalog.get (>50%
// unticked), catalog.apply of the ticked rows and estimates.get priced at the new rate on the very next call, Undo
// putting the old price back, a manual price, the schedule (Turn off in the user dimfactory.json, "Not now" in
// state.json), and the scheduler on the core's clock raising the consent card and the host's notification without
// ever starting a refresh.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { catalogCostUsd } from '../../../../src/core/catalog/cost.ts'
import { loadSeedPricing } from '../../../../src/core/catalog/store.ts'
import { PRIOR_USAGE } from '../../../../src/core/estimates/defaults.ts'
import { homePaths } from '../../../../src/core/home.ts'
import type { GlobalEvent } from '../../../../src/core/bus/bus.ts'
import type { Clock, TimerHandle } from '../../../../src/core/supervisor/effects.ts'
import type { PriceEntry } from '../../../../src/shared/catalog.ts'
import type { RunEstimate } from '../../../../src/shared/estimates.ts'
import { cleanup, hermeticEnv, makeSandbox } from '../../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const JOB = '20261009T120000Z-ab12'
const DAY = 86_400_000

function newHome(userConfig?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'data-'))
  dirs.push(root)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  if (userConfig !== undefined)
    writeFileSync(join(home, 'dimfactory.json'), JSON.stringify(userConfig, null, 2))
  return home
}

async function boot(
  home: string,
  o: { clock?: Clock; notifyCatalog?: () => void; scheduler?: boolean | object } = {},
) {
  const core = await createCore({
    home,
    host: { kind: 'app', ...(o.notifyCatalog !== undefined ? { notifyCatalog: o.notifyCatalog } : {}) },
    env: hermeticEnv(),
    retention: false,
    catalogScheduler: o.scheduler ?? false,
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
  })
  cores.push(core)
  return core
}

/** The seed's Claude prices as the refresh would report them, with changes. */
async function writeJob(home: string, change: Record<string, Partial<PriceEntry>>): Promise<void> {
  const seed = await loadSeedPricing()
  const entries = seed.entries
    .filter((e) => e.vendor === 'claude')
    .map((e) => ({
      vendor: e.vendor,
      model: e.model,
      aliases: e.aliases,
      inputPerMTok: e.inputPerMTok,
      outputPerMTok: e.outputPerMTok,
      cacheReadPerMTok: e.cacheReadPerMTok,
      cacheWritePerMTok: e.cacheWritePerMTok,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      sourceQuote: e.sourceQuote ?? `${e.model} pricing`,
      ...change[e.model],
    }))
  const dir = join(homePaths(home).catalogJobsDir, JOB)
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: JOB,
      state: 'diff-ready',
      vendor: 'claude',
      model: 'sonnet',
      startedAt: now - 120_000,
      endedAt: now - 1000,
    }),
  )
  writeFileSync(
    join(dir, 'proposal.json'),
    JSON.stringify({ generatedAt: new Date(now).toISOString(), entries, newModels: [], unverifiable: [] }),
  )
}

async function ok<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

/** Plan (claude · opus) at its prior: the prior tokens at claude-opus-5-5's rates (p80). */
const planP80 = (
  rates: Pick<PriceEntry, 'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok'>,
) => catalogCostUsd(PRIOR_USAGE.plan ?? { input: 0, output: 0 }, rates, true)

describe('catalog data through the core', () => {
  it('diff review → apply → estimates.get uses the new price at once → Undo → a manual price', async () => {
    const home = newHome()
    const folder = makeSandbox()
    dirs.push(folder)
    const core = await boot(home)
    const estimate = (): Promise<RunEstimate> => ok(core.invoke('estimates.get', { folder }))
    const opus = (await loadSeedPricing()).entries.find((e) => e.model === 'claude-opus-5-5')
    if (opus === undefined) throw new Error('seed has no claude-opus-5-5')

    const before = await estimate()
    expect(before.steps.plan?.costUsd?.p80).toBeCloseTo(planP80(opus), 10)

    // The refresh found Opus's input doubled (>50%: unticked) and its output up 25% (ticked).
    await writeJob(home, { 'claude-opus-5-5': { inputPerMTok: 8, outputPerMTok: 25 } })
    const state = await ok(core.invoke('catalog.get'))
    expect(state.job).toMatchObject({ id: JOB, state: 'diff-ready' })
    const rows = state.job?.diff?.rows ?? []
    expect(rows.filter((r) => r.kind !== 'confirm').map((r) => [r.id, r.ticked, r.flags])).toEqual([
      ['price|claude|claude-opus-5-5|inputPerMTok', false, ['bigChange']],
      ['price|claude|claude-opus-5-5|outputPerMTok', true, []],
    ])
    // Every other seed price the page repeats unchanged is a confirm row of its own, ticked.
    const confirms = rows.filter((r) => r.kind === 'confirm')
    expect(confirms.length).toBe(
      (await loadSeedPricing()).entries.filter((e) => e.vendor === 'claude').length - 1,
    )
    expect(confirms.every((r) => r.ticked && r.verified === true)).toBe(true)

    // Apply the ticked rows: the very next estimate is priced at the new output rate.
    const applied = await ok(
      core.invoke('catalog.apply', { jobId: JOB, rowIds: rows.filter((r) => r.ticked).map((r) => r.id) }),
    )
    expect(applied.job?.state).toBe('applied')
    expect(applied.undoId).toBe(applied.history[0]?.id)
    const after = await estimate()
    expect(after.steps.plan?.costUsd?.p80).toBeCloseTo(planP80({ ...opus, outputPerMTok: 25 }), 10)
    expect(after.steps.plan?.costUsd?.p80).toBeGreaterThan(before.steps.plan?.costUsd?.p80 ?? Infinity)
    // The model picker reads the same live catalog.
    expect(
      core.catalog?.data()?.pricing.entries.find((e) => e.model === 'claude-opus-5-5')?.outputPerMTok,
    ).toBe(25)
    // Applied once only.
    const again = await core.invoke('catalog.apply', { jobId: JOB, rowIds: [] })
    expect(again.ok ? null : again.error.code).toBe('CONFLICT')

    // Undo: the old price, at once.
    const undone = await ok(core.invoke('catalog.undo'))
    expect(undone.history.map((h) => [h.source, h.undone === true])).toEqual([
      ['undo', false],
      ['refresh', true],
    ])
    expect((await estimate()).steps.plan?.costUsd?.p80).toBeCloseTo(planP80(opus), 10)

    // A manual price: confidence 'user', used at once, undoable.
    const edited = await ok(
      core.invoke('catalog.savePrice', {
        entry: {
          vendor: 'claude',
          model: 'opus',
          inputPerMTok: 5,
          outputPerMTok: 30,
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 10,
        },
      }),
    )
    expect(edited.pricing.entries.find((e) => e.model === 'claude-opus-5-5')).toMatchObject({
      outputPerMTok: 30,
      confidence: 'user',
    })
    expect((await estimate()).steps.plan?.costUsd?.p80).toBeCloseTo(
      planP80({ inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 10 }),
      10,
    )
    const bad = await core.invoke('catalog.savePrice', {
      entry: {
        vendor: 'claude',
        model: 'opus',
        inputPerMTok: 0,
        outputPerMTok: 30,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
    })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
    await ok(core.invoke('catalog.undo'))
    expect((await estimate()).steps.plan?.costUsd?.p80).toBeCloseTo(planP80(opus), 10)

    // A restart reads what is on disk: the same prices.
    await core.shutdown()
    cores.splice(cores.indexOf(core), 1)
    const again2 = await boot(home)
    expect(again2.catalog?.data()?.pricing.entries.find((e) => e.model === 'claude-opus-5-5')).toMatchObject({
      outputPerMTok: opus.outputPerMTok,
      confidence: opus.confidence,
    })
    const st = await ok(again2.invoke('catalog.get'))
    expect(st.history.map((h) => h.source)).toEqual(['undo', 'manual', 'undo', 'refresh'])
  }, 120_000)

  it('the schedule: Turn off (user dimfactory.json), interval, "Not now (7 days)" (state.json)', async () => {
    const home = newHome()
    const core = await boot(home)
    const off = await ok(core.invoke('catalog.setSchedule', { enabled: false }))
    expect(off).toMatchObject({ enabled: false, nextDueAt: null })
    const userFile = (): { catalog: { refresh: unknown } } =>
      JSON.parse(readFileSync(join(home, 'dimfactory.json'), 'utf8')) as { catalog: { refresh: unknown } }
    expect(userFile().catalog.refresh).toEqual({ enabled: false })
    const dash = await ok(core.invoke('dashboard.get'))
    expect(dash.catalog.schedule.enabled).toBe(false)
    const on = await ok(core.invoke('catalog.setSchedule', { enabled: true, intervalDays: 30 }))
    expect(on).toMatchObject({ enabled: true, intervalDays: 30 })
    expect(userFile().catalog.refresh).toEqual({
      enabled: true,
      intervalDays: 30,
    })
    const before = Date.now()
    const snoozed = await ok(core.invoke('catalog.setSchedule', { snoozeDays: 7 }))
    expect(snoozed.snoozedUntil).toBeGreaterThanOrEqual(before + 7 * DAY)
    const state = JSON.parse(readFileSync(homePaths(home).state, 'utf8')) as {
      catalog: { snoozedUntil: unknown }
    }
    expect(state.catalog.snoozedUntil).toBe(snoozed.snoozedUntil)
    const bad = await core.invoke('catalog.setSchedule', { intervalDays: 0 })
    expect(bad.ok ? null : bad.error.code).toBe('VALIDATION')
  }, 60_000)

  it('the scheduler on the core clock: consent card + one notification when due; never a refresh', async () => {
    const seed = await loadSeedPricing()
    const clock = new TestClock(seed.updatedAt + 20 * DAY)
    const home = newHome({ notifications: { events: { catalog: true } } })
    const notified: number[] = []
    const core = await boot(home, {
      clock,
      notifyCatalog: () => notified.push(clock.now()),
      scheduler: { bootDelayMs: 1000 },
    })
    const events: GlobalEvent[] = []
    core.bus.attach({ name: 'test', global: (ev) => events.push(ev) })
    const catalogEvents = () => events.filter((e) => e.kind === 'catalog')

    clock.advance(1000)
    await core.catalog?.scheduler?.idle()
    await until(() => catalogEvents().length === 1)
    expect(catalogEvents()).toEqual([{ kind: 'catalog', state: 'due' }])
    expect(notified).toHaveLength(1)
    // Six hours later: the card again (still due), no second notification.
    clock.advance(6 * 3_600_000)
    await core.catalog?.scheduler?.idle()
    await until(() => catalogEvents().length === 2)
    expect(notified).toHaveLength(1)
    // It never started a refresh.
    const jobs = homePaths(home).catalogJobsDir
    expect(existsSync(jobs) ? readdirSync(jobs) : []).toEqual([])
    const dash = await ok(core.invoke('dashboard.get'))
    expect(dash.catalog).toMatchObject({ refreshDue: true, jobRunning: false })
  }, 60_000)
})

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The core's clock under test: timers fire only on `advance`. */
class TestClock implements Clock {
  readonly scale = 1
  #t: number
  #seq = 0
  readonly #timers = new Map<number, { fn: () => void; at: number }>()

  constructor(start: number) {
    this.#t = start
  }

  now = (): number => this.#t
  setTimer = (fn: () => void, at: number): TimerHandle => {
    const id = ++this.#seq
    this.#timers.set(id, { fn, at })
    return id as unknown as TimerHandle
  }
  clearTimer = (h: TimerHandle): void => {
    this.#timers.delete(h as unknown as number)
  }
  advance = (ms: number): number => {
    const end = this.#t + ms
    for (;;) {
      let next: [number, { fn: () => void; at: number }] | undefined
      for (const t of this.#timers)
        if (t[1].at <= end && (next === undefined || t[1].at < next[1].at)) next = t
      if (next === undefined) break
      this.#timers.delete(next[0])
      this.#t = Math.max(this.#t, next[1].at)
      next[1].fn()
    }
    this.#t = end
    return end
  }
}
