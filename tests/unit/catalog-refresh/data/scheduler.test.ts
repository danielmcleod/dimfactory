// Catalog refresh schedule (refresh scheduler; the `catalog` event;
// src/core/catalog/scheduler.ts) on a fake clock: the due rule (interval, shipped prices, snooze, Off), the look at
// launch and every 6 h, the consent card raised while due, the notification once per due date and only with
// events.catalog on, nothing while a refresh runs, and never a refresh started. state.json's catalog fields.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATALOG_BOOT_DELAY_MS,
  CATALOG_CHECK_INTERVAL_MS,
  CatalogScheduler,
  catalogDue,
  catalogNextDueAt,
  readCatalogScheduleState,
  writeCatalogScheduleState,
} from '../../../../src/core/catalog/scheduler.ts'
import type { CatalogCheck, CatalogScheduleState } from '../../../../src/core/catalog/scheduler.ts'
import { DimFactoryError } from '../../../../src/core/errors.ts'
import { DAY, FakeClock, NOW, settle } from './fixtures.ts'

const H = 3_600_000
const on = { enabled: true, intervalDays: 14 }
const never: CatalogScheduleState = { lastRefreshAt: null, snoozedUntil: null }

describe('the due rule', () => {
  it('due once intervalDays passed since the last refresh; before the first, since the shipped prices', () => {
    const last = { lastRefreshAt: NOW - 14 * DAY, snoozedUntil: null }
    expect(catalogNextDueAt(last, on, NOW)).toBe(NOW)
    expect(catalogDue(last, on, NOW)).toBe(true)
    expect(catalogDue(last, on, NOW - 1)).toBe(false)
    expect(catalogDue({ ...last, lastRefreshAt: NOW - 13 * DAY }, on, NOW)).toBe(false)
    expect(catalogDue(last, { enabled: true, intervalDays: 30 }, NOW)).toBe(false)
    // Never refreshed: the shipped prices' date is the base; with none at all, due now.
    expect(catalogNextDueAt(never, on, NOW, NOW - 20 * DAY)).toBe(NOW - 6 * DAY)
    expect(catalogDue(never, on, NOW, NOW - DAY)).toBe(false)
    expect(catalogNextDueAt(never, on, NOW, null)).toBe(NOW)
  })

  it('"Not now" snoozes until its date; Off is never due', () => {
    const snoozed = { lastRefreshAt: NOW - 20 * DAY, snoozedUntil: NOW + 7 * DAY }
    expect(catalogNextDueAt(snoozed, on, NOW)).toBe(NOW + 7 * DAY)
    expect(catalogDue(snoozed, on, NOW)).toBe(false)
    expect(catalogDue(snoozed, on, NOW + 7 * DAY)).toBe(true)
    expect(catalogNextDueAt(snoozed, { enabled: false, intervalDays: 14 }, NOW)).toBeNull()
    expect(catalogDue(never, { enabled: false, intervalDays: 7 }, NOW, null)).toBe(false)
  })
})

interface Harness {
  clock: FakeClock
  s: CatalogScheduler
  raised: CatalogCheck[]
  notified: CatalogCheck[]
  checks: number
  state: { due: boolean; nextDueAt: number | null; jobRunning: boolean; notify: boolean }
}

function harness(state: Partial<Harness['state']> = {}): Harness {
  const clock = new FakeClock()
  const h: Harness = {
    clock,
    raised: [],
    notified: [],
    checks: 0,
    state: { due: true, nextDueAt: NOW - DAY, jobRunning: false, notify: true, ...state },
    s: undefined as unknown as CatalogScheduler,
  }
  h.s = new CatalogScheduler({
    clock,
    check: () => {
      h.checks++
      return Promise.resolve({
        due: h.state.due,
        nextDueAt: h.state.nextDueAt,
        jobRunning: h.state.jobRunning,
      })
    },
    notifyEnabled: () => h.state.notify,
    raise: (c) => h.raised.push(c),
    notify: (c) => h.notified.push(c),
  })
  return h
}

async function advance(h: Harness, ms: number): Promise<void> {
  h.clock.advance(ms)
  await h.s.idle()
  await settle()
}

describe('CatalogScheduler (fake clock)', () => {
  it('looks after the boot delay, then every 6 h; raises the card each time it is due, notifies once per due date', async () => {
    const h = harness()
    h.s.start()
    await advance(h, CATALOG_BOOT_DELAY_MS - 1)
    expect(h.checks).toBe(0)
    await advance(h, 1)
    expect(h.checks).toBe(1)
    expect(h.raised).toHaveLength(1)
    expect(h.notified).toEqual([{ due: true, nextDueAt: NOW - DAY, jobRunning: false }])
    await advance(h, CATALOG_CHECK_INTERVAL_MS - 1)
    expect(h.checks).toBe(1)
    await advance(h, 1)
    expect(h.checks).toBe(2)
    expect(h.raised).toHaveLength(2)
    expect(h.notified).toHaveLength(1)
    // Four more looks in a day.
    await advance(h, 24 * H)
    expect(h.checks).toBe(6)
    expect(h.notified).toHaveLength(1)
  })

  it('a new due date (after a snooze or a refresh) notifies again', async () => {
    const h = harness()
    h.s.start()
    await advance(h, CATALOG_BOOT_DELAY_MS)
    h.state.nextDueAt = NOW + 7 * DAY
    await advance(h, CATALOG_CHECK_INTERVAL_MS)
    expect(h.notified.map((c) => c.nextDueAt)).toEqual([NOW - DAY, NOW + 7 * DAY])
  })

  it('not due (snoozed, refreshed, Off): no card, no notification', async () => {
    const h = harness({ due: false, nextDueAt: NOW + 3 * DAY })
    h.s.start()
    await advance(h, CATALOG_BOOT_DELAY_MS + 3 * CATALOG_CHECK_INTERVAL_MS)
    expect(h.checks).toBe(4)
    expect(h.raised).toEqual([])
    expect(h.notified).toEqual([])
    const off = harness({ due: false, nextDueAt: null })
    expect(await off.s.tick()).toMatchObject({ due: false, raised: false, notified: false })
  })

  it('events.catalog off: the card is raised, the notification is not; a running refresh raises nothing', async () => {
    const h = harness({ notify: false })
    expect(await h.s.tick()).toMatchObject({ raised: true, notified: false })
    expect(h.notified).toEqual([])
    h.state.notify = true
    expect(await h.s.tick()).toMatchObject({ raised: true, notified: true })
    const busy = harness({ jobRunning: true })
    expect(await busy.s.tick()).toMatchObject({ due: true, raised: false, notified: false })
  })

  it('stop() ends the looks; a failing check is logged, never thrown, and the next look still runs', async () => {
    const clock = new FakeClock()
    let n = 0
    const warnings: string[] = []
    const s = new CatalogScheduler({
      clock,
      check: () =>
        ++n === 1
          ? Promise.reject(new Error('state.json locked'))
          : Promise.resolve({ due: false, nextDueAt: null, jobRunning: false }),
      notifyEnabled: () => true,
      raise: () => undefined,
      notify: () => undefined,
      bootDelayMs: 0,
      intervalMs: H,
      log: { warn: (m: string) => warnings.push(m) } as never,
    })
    s.start()
    clock.advance(0)
    expect(await s.idle()).toBeNull()
    await settle()
    clock.advance(H)
    await s.idle()
    await settle()
    expect(n).toBe(2)
    expect(warnings).toEqual(['catalog schedule check failed'])
    s.stop()
    clock.advance(10 * H)
    await settle()
    expect(n).toBe(2)
    expect(clock.timers.size).toBe(0)
  })
})

describe("state.json's catalog fields", () => {
  it('writes lastRefreshAt / snoozedUntil and keeps every other field; reads defaults when missing or corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'state-'))
    const file = join(dir, 'state.json')
    expect(await readCatalogScheduleState(file)).toEqual(never)
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        setupDismissed: true,
        notifications: { pausedUntil: 5 },
        catalog: { x: 1 },
      }),
    )
    expect(await writeCatalogScheduleState(file, { snoozedUntil: NOW + 7 * DAY })).toEqual({
      lastRefreshAt: null,
      snoozedUntil: NOW + 7 * DAY,
    })
    await writeCatalogScheduleState(file, { lastRefreshAt: NOW })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      setupDismissed: true,
      notifications: { pausedUntil: 5 },
      catalog: { x: 1, lastRefreshAt: NOW, snoozedUntil: NOW + 7 * DAY },
    })
    // Concurrent writes from this process are serialized: both land.
    await Promise.all([
      writeCatalogScheduleState(file, { lastRefreshAt: NOW + 1 }),
      writeCatalogScheduleState(file, { snoozedUntil: null }),
    ])
    expect(await readCatalogScheduleState(file)).toEqual({ lastRefreshAt: NOW + 1, snoozedUntil: null })
    await writeFile(file, '{oops')
    expect(await readCatalogScheduleState(file)).toEqual(never)
  })

  it('a state.json from a newer Dim Factory is never written (NEWER_SCHEMA)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'state-'))
    const file = join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 9, catalog: { lastRefreshAt: 1 } }))
    let err: unknown
    try {
      await writeCatalogScheduleState(file, { snoozedUntil: NOW })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DimFactoryError)
    expect((err as DimFactoryError).code).toBe('NEWER_SCHEMA')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 9,
      catalog: { lastRefreshAt: 1 },
    })
  })
})
