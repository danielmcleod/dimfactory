// Live catalog (src/core/catalog/live.ts; Settings → Catalog, the `catalog` event): what
// catalog.get answers (status, the newest refresh job with its diff review, the history and what Undo would revert),
// the in-memory data replaced the moment an apply / manual price / undo commits, the schedule writes (Turn off and the
// interval through the user config, "Not now" in state.json), and the scheduler's consent card and notification.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { catalogFileText } from '../../../../src/core/catalog/apply.ts'
import { CatalogLive } from '../../../../src/core/catalog/live.ts'
import type { CatalogUserSettings } from '../../../../src/core/catalog/live.ts'
import { CATALOG_BOOT_DELAY_MS } from '../../../../src/core/catalog/scheduler.ts'
import { silentLogger } from '../../../../src/core/log.ts'
import type { CatalogJob } from '../../../../src/shared/catalog.ts'
import type { JsonPatchOp } from '../../../../src/shared/failure.ts'
import type { AppEvent } from '../../../../src/shared/ipc.ts'
import {
  CLI_MODELS,
  DAY,
  FakeClock,
  JOB_ID,
  NOW,
  allClaude,
  current,
  homeOf,
  proposal,
  settle,
  writeJob,
} from './fixtures.ts'

interface Setup {
  live: CatalogLive
  clock: FakeClock
  events: Extract<AppEvent, { kind: 'catalog' }>[]
  patches: JsonPatchOp[][]
  notified: number[]
  settings: CatalogUserSettings
}

async function setup(o: { seedFiles?: boolean; pricingUpdatedAt?: number } = {}): Promise<Setup> {
  const p = homeOf()
  if (o.seedFiles !== false) {
    await mkdir(p.catalogDir, { recursive: true })
    const c = current()
    c.pricing.updatedAt = o.pricingUpdatedAt ?? NOW - 2 * DAY
    // The shipped prices' date (the due date and staleness count from the prices' fetchedAt, not from
    // pricing.json's write time): every price was read that day, as in the seed.
    for (const e of c.pricing.entries) e.fetchedAt = c.pricing.updatedAt
    await writeFile(p.catalogPricing, catalogFileText(c.pricing))
    await writeFile(p.catalogModels, catalogFileText(c.models))
  }
  const clock = new FakeClock()
  const s: Setup = {
    clock,
    events: [],
    patches: [],
    notified: [],
    settings: {
      refresh: { enabled: true, intervalDays: 14, vendor: 'claude', model: 'sonnet' },
      notifyCatalog: true,
    },
    live: undefined as unknown as CatalogLive,
  }
  s.live = new CatalogLive({
    paths: p,
    clock,
    log: silentLogger,
    settings: () => s.settings,
    patchUserConfig: (ops) => {
      s.patches.push(ops)
      for (const op of ops) {
        if (!('value' in op)) continue
        if (op.path === '/catalog/refresh/enabled') s.settings.refresh.enabled = op.value as boolean
        if (op.path === '/catalog/refresh/intervalDays') s.settings.refresh.intervalDays = op.value as number
      }
      return Promise.resolve()
    },
    cliModels: (v) => (v === 'claude' ? CLI_MODELS : undefined),
    emit: (ev) => s.events.push(ev),
    notify: () => s.notified.push(clock.now()),
  })
  await s.live.load()
  return s
}

const SONNET_ROW = 'price|claude|claude-sonnet-5-5|inputPerMTok'

const stateFile = async (): Promise<{ catalog: Record<string, unknown> }> =>
  JSON.parse(await readFile(homeOf().state, 'utf8')) as { catalog: Record<string, unknown> }

describe('catalog.get state', () => {
  it('no job yet: prices, models, status, empty history, nothing to undo', async () => {
    const { live } = await setup()
    const st = await live.state()
    expect(st.job).toBeNull()
    expect(st.history).toEqual([])
    expect(st.undoId).toBeNull()
    expect(st.pricing.entries).toHaveLength(5)
    expect(st.status).toMatchObject({ refreshDue: false, jobRunning: false, confidence: 'mixed' })
    expect(st.status.schedule).toMatchObject({ enabled: true, intervalDays: 14, nextDueAt: NOW + 12 * DAY })
  })

  it("a finished job carries its diff review (with the schema's rejected rows); it counts as the last refresh", async () => {
    const { live } = await setup()
    await writeJob(homeOf(), {
      proposal: proposal(
        allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 }, 'claude-opus-5-5': { inputPerMTok: 7 } }),
      ),
      endedAt: NOW - 60_000,
      rejected: [{ vendor: 'claude', model: 'claude-x', value: null, reason: 'Not a model id.' }],
    })
    const st = await live.state()
    expect(st.job).toMatchObject({ id: JOB_ID, state: 'diff-ready', vendor: 'claude', model: 'sonnet' })
    expect(st.job?.diff?.jobId).toBe(JOB_ID)
    expect(st.job?.diff?.generatedAt).toBe(NOW - 60_000)
    expect(st.job?.diff?.rows.map((r) => [r.id, r.ticked, r.flags])).toEqual([
      ['confirm|claude|claude-haiku-4-5-20251001', true, []],
      ['price|claude|claude-opus-5-5|inputPerMTok', false, ['bigChange']],
      [SONNET_ROW, true, []],
    ])
    expect(st.job?.diff?.rejected).toEqual([
      { vendor: 'claude', model: 'claude-x', value: null, reason: 'Not a model id.' },
    ])
    expect(st.status.schedule.lastRefreshAt).toBe(NOW - 60_000)
  })

  it("the review uses the job's own record: pages it did not read, models it named, vendors it covered", async () => {
    const { live } = await setup()
    await writeJob(homeOf(), {
      proposal: proposal([
        ...allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } }).filter(
          (e) => e.model !== 'claude-haiku-4-5-20251001',
        ),
      ]),
      endedAt: NOW - 60_000,
      // It read only www.anthropic.com; the schema check refused its Haiku entry (named all the same).
      extra: {
        fetchedHosts: ['www.anthropic.com'],
        mentioned: [{ vendor: 'claude', model: 'claude-haiku-4-5-20251001' }],
        vendors: ['claude'],
      },
    })
    const st = await live.state()
    expect(st.job?.diff?.rows.map((r) => [r.id, r.ticked, r.flags])).toEqual([
      [SONNET_ROW, false, ['notFetched']],
    ])
    expect(st.job?.diff?.rows[0]?.verified).toBeUndefined()
  })

  it("a running job from a Dim Factory that closed reads failed; this process's running job reads running", async () => {
    const s = await setup()
    await writeJob(homeOf(), { state: 'running', startedAt: NOW - 60_000 })
    expect(await s.live.latestJob()).toMatchObject({
      state: 'failed',
      error: 'The update stopped when Dim Factory closed. Start it again.',
    })
    const job: CatalogJob = {
      id: JOB_ID,
      state: 'running',
      vendor: 'claude',
      model: 'sonnet',
      startedAt: NOW - 60_000,
      progress: 'Reading pricing',
    }
    s.live.setJobSource(() => job)
    expect(await s.live.latestJob()).toEqual(job)
    expect((await s.live.status()).jobRunning).toBe(true)
  })
})

describe('writes replace the data at once', () => {
  it('apply → data() has the new price, state.json records the refresh, `applied` is emitted; undo → back', async () => {
    const s = await setup()
    await writeJob(homeOf(), {
      proposal: proposal(allClaude({ 'claude-sonnet-5-5': { inputPerMTok: 2.5 } })),
    })
    const before = s.live.data()
    s.clock.t = NOW + 1000
    const st = await s.live.apply(JOB_ID, [SONNET_ROW])
    expect(s.live.data()).not.toBe(before)
    expect(s.live.data()?.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')?.inputPerMTok).toBe(
      2.5,
    )
    expect(st.job).toMatchObject({ id: JOB_ID, state: 'applied' })
    expect(st.undoId).toBe(st.history[0]?.id)
    expect(s.events).toEqual([{ kind: 'catalog', state: 'applied', jobId: JOB_ID }])
    expect((await stateFile()).catalog.lastRefreshAt).toBe(NOW + 1000)
    expect(st.status.schedule.lastRefreshAt).toBe(NOW + 1000)

    const undone = await s.live.undo()
    expect(s.live.data()?.pricing.entries.find((e) => e.model === 'claude-sonnet-5-5')?.inputPerMTok).toBe(2)
    expect(undone.undoId).toBeNull()
    expect(undone.history.map((h) => h.source)).toEqual(['undo', 'refresh'])
  })

  it("savePrice → confidence 'user' in data() at once", async () => {
    const s = await setup()
    await s.live.savePrice({
      vendor: 'claude',
      model: 'opus',
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 10,
    })
    expect(s.live.data()?.pricing.entries.find((e) => e.model === 'claude-opus-5-5')).toMatchObject({
      inputPerMTok: 5,
      confidence: 'user',
    })
  })
})

describe('when prices count as old', () => {
  it('a manual price never makes the other prices look fresh, nor moves the due date', async () => {
    const s = await setup({ pricingUpdatedAt: NOW - 40 * DAY })
    const before = await s.live.status()
    expect(before).toMatchObject({ stale: true, refreshDue: true, pricingUpdatedAt: NOW - 40 * DAY })
    s.clock.t = NOW + 1000
    await s.live.savePrice({
      vendor: 'claude',
      model: 'claude-haiku-4-5-20251001',
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 2.5,
    })
    const after = await s.live.status()
    expect(after).toMatchObject({
      stale: true,
      refreshDue: true,
      pricingUpdatedAt: NOW - 40 * DAY,
      confidence: 'mixed',
    })
    expect(after.schedule.nextDueAt).toBe(before.schedule.nextDueAt)
    expect((await s.live.check()).due).toBe(true)
  })

  it('a finished refresh counts as a check of the prices, even with nothing applied', async () => {
    const s = await setup({ pricingUpdatedAt: NOW - 40 * DAY })
    await writeJob(homeOf(), { proposal: proposal(allClaude()), endedAt: NOW - 60_000 })
    expect(await s.live.status()).toMatchObject({
      stale: false,
      refreshDue: false,
      pricingUpdatedAt: NOW - 60_000,
    })
  })
})

describe('the schedule', () => {
  it('Turn off and the interval go to the user config; "Not now (7 days)" to state.json', async () => {
    const s = await setup()
    expect(await s.live.setSchedule({ enabled: false })).toMatchObject({ enabled: false, nextDueAt: null })
    expect(s.patches).toEqual([[{ op: 'add', path: '/catalog/refresh/enabled', value: false }]])
    await s.live.setSchedule({ enabled: true, intervalDays: 30 })
    expect(s.patches[1]).toEqual([
      { op: 'add', path: '/catalog/refresh/enabled', value: true },
      { op: 'add', path: '/catalog/refresh/intervalDays', value: 30 },
    ])
    const snoozed = await s.live.setSchedule({ snoozeDays: 7 })
    expect(snoozed.snoozedUntil).toBe(NOW + 7 * DAY)
    expect((await stateFile()).catalog.snoozedUntil).toBe(NOW + 7 * DAY)
    expect(s.patches).toHaveLength(2)
  })

  it('the scheduler raises the consent card and notifies once; it never starts a refresh', async () => {
    const s = await setup({ pricingUpdatedAt: NOW - 20 * DAY })
    const sched = s.live.startScheduler()
    s.clock.advance(CATALOG_BOOT_DELAY_MS)
    await sched.idle()
    await settle()
    expect(s.events).toEqual([{ kind: 'catalog', state: 'due' }])
    expect(s.notified).toHaveLength(1)
    // "Not now (7 days)": the next looks raise nothing until it ends, then a new due date notifies again.
    await s.live.setSchedule({ snoozeDays: 7 })
    s.clock.advance(6 * 3_600_000)
    await sched.idle()
    await settle()
    expect(s.events).toHaveLength(1)
    s.clock.advance(7 * DAY)
    await sched.idle()
    await settle()
    expect(s.events.length).toBeGreaterThan(1)
    expect(s.notified).toHaveLength(2)
    s.live.stop()
    expect(s.clock.timers.size).toBe(0)
  })

  it('events.catalog off: the card still shows, no notification; Off: nothing', async () => {
    const s = await setup({ pricingUpdatedAt: NOW - 20 * DAY })
    s.settings.notifyCatalog = false
    const sched = s.live.startScheduler({ bootDelayMs: 0 })
    s.clock.advance(0)
    await sched.idle()
    await settle()
    expect(s.events).toEqual([{ kind: 'catalog', state: 'due' }])
    expect(s.notified).toEqual([])
    s.settings.refresh.enabled = false
    expect(await sched.tick()).toMatchObject({ due: false, raised: false })
    s.live.stop()
  })
})
