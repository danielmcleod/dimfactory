// state.json for state.get / state.set (src/main/app-state.ts): defaults, normalization, patching that keeps unknown
// fields, atomic versioned writes, and a newer file refused.
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_STATE } from '../../../src/core/config/firstLaunch.ts'
import { homePaths } from '../../../src/core/home.ts'
import { applyAppStatePatch, createAppStateStore, normalizeAppState } from '../../../src/main/app-state.ts'

const paths = (): ReturnType<typeof homePaths> => homePaths(process.env['DIM_FACTORY_HOME'] ?? '')

describe('normalizeAppState', () => {
  it('fills defaults and drops wrong types', () => {
    expect(normalizeAppState({})).toEqual(DEFAULT_APP_STATE)
    expect(
      normalizeAppState({
        setupDismissed: 'yes',
        firstLaunchCompletedAt: 5,
        catalog: { lastRefreshAt: 'x', snoozedUntil: 9 },
        notifications: [],
      }),
    ).toEqual({
      schemaVersion: 1,
      setupDismissed: false,
      firstLaunchCompletedAt: 5,
      catalog: { lastRefreshAt: null, snoozedUntil: 9 },
      notifications: { pausedUntil: null },
    })
  })
})

describe('applyAppStatePatch', () => {
  it('changes only what the patch names and keeps unknown fields', () => {
    const raw = {
      schemaVersion: 1,
      firstLaunchCompletedAt: 7,
      future: { a: 1 },
      notifications: { pausedUntil: 3, x: 1 },
    }
    expect(applyAppStatePatch(raw, { setupDismissed: true })).toMatchObject({
      setupDismissed: true,
      firstLaunchCompletedAt: 7,
      future: { a: 1 },
      notifications: { pausedUntil: 3, x: 1 },
    })
    expect(applyAppStatePatch(raw, { notificationsPausedUntil: null })).toMatchObject({
      notifications: { pausedUntil: null, x: 1 },
    })
  })
})

describe('createAppStateStore', () => {
  it('reads defaults when state.json is missing or corrupt', async () => {
    const store = createAppStateStore(paths())
    expect(await store.get()).toEqual(DEFAULT_APP_STATE)
    await writeFile(paths().state, '{not json')
    expect(await store.get()).toEqual(DEFAULT_APP_STATE)
  })

  it('writes a versioned file, keeps first-launch data and serializes concurrent sets', async () => {
    await writeFile(
      paths().state,
      JSON.stringify({ schemaVersion: 1, firstLaunchCompletedAt: 42, other: true }),
    )
    const store = createAppStateStore(paths())
    const [a, b] = await Promise.all([
      store.set({ setupDismissed: true }),
      store.set({ notificationsPausedUntil: 99 }),
    ])
    expect(a.setupDismissed).toBe(true)
    expect(b).toMatchObject({
      setupDismissed: true,
      firstLaunchCompletedAt: 42,
      notifications: { pausedUntil: 99 },
    })
    const disk = JSON.parse(await readFile(paths().state, 'utf8')) as Record<string, unknown>
    expect(disk).toMatchObject({
      schemaVersion: 1,
      setupDismissed: true,
      other: true,
      firstLaunchCompletedAt: 42,
    })
    expect(Object.keys(disk)[0]).toBe('schemaVersion')
    expect(await store.get()).toEqual(b)
  })

  it('reads but refuses to write a state.json from a newer Dim Factory', async () => {
    await writeFile(paths().state, JSON.stringify({ schemaVersion: 2, setupDismissed: true }))
    const store = createAppStateStore(paths())
    expect((await store.get()).setupDismissed).toBe(true)
    await expect(store.set({ setupDismissed: false })).rejects.toMatchObject({ code: 'NEWER_SCHEMA' })
    // A failed set does not wedge the queue.
    await writeFile(paths().state, JSON.stringify({ schemaVersion: 1 }))
    expect((await store.set({ setupDismissed: true })).setupDismissed).toBe(true)
  })
})
