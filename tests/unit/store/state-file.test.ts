// DIM_FACTORY_HOME/state.json has four writers in one process: main's state.get / state.set store, the catalog
// scheduler, first launch and the outside-agent settings. Every change goes through one serialized
// read-modify-write per file (store/state-file.ts), so writes interleaved from all of them lose nothing.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCatalogScheduleState } from '../../../src/core/catalog/scheduler.ts'
import { runFirstLaunch } from '../../../src/core/config/firstLaunch.ts'
import { homePaths } from '../../../src/core/home.ts'
import type { HomePaths } from '../../../src/core/home.ts'
import { createExternalMcpStateStore } from '../../../src/core/mcp/state.ts'
import { updateStateFile } from '../../../src/core/store/state-file.ts'
import { createAppStateStore } from '../../../src/main/app-state.ts'

let dir = ''
let paths: HomePaths

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dim-factory-state-file-'))
  paths = homePaths(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const readState = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>

describe('state.json writers', () => {
  it('interleaved writes from main, the catalog, first launch and outside agents lose nothing', async () => {
    const appState = createAppStateStore(paths)
    const mcp = createExternalMcpStateStore(paths.state)
    const N = 25
    const writes: Promise<unknown>[] = []
    // First launch reads state.json, then writes the user's profile (slow), then records itself: every other writer
    // runs while it waits.
    writes.push(
      runFirstLaunch({
        paths,
        readiness: { claude: { probeOk: true, autoedit: 'supported' } },
        writeProfile: async (profile) => {
          await new Promise((r) => setTimeout(r, 30))
          await writeFile(paths.userConfig, `{ "profile": "${profile}" }\n`)
        },
        now: () => 4242,
      }),
    )
    for (let i = 1; i <= N; i++) {
      writes.push(appState.set({ notificationsPausedUntil: i }))
      writes.push(appState.set({ setupDismissed: i % 2 === 1 }))
      writes.push(writeCatalogScheduleState(paths.state, { lastRefreshAt: i }))
      writes.push(mcp.set({ port: 2000 + i }))
      writes.push(mcp.set({ enabled: i % 2 === 0 }))
    }
    await Promise.all(writes)
    const s = await readState()
    expect(s['firstLaunchCompletedAt']).toBe(4242)
    expect(s['setupDismissed']).toBe(N % 2 === 1)
    expect(s['notifications']).toMatchObject({ pausedUntil: N })
    expect(s['catalog']).toMatchObject({ lastRefreshAt: N })
    expect(s['externalMcp']).toMatchObject({ port: 2000 + N, enabled: N % 2 === 0 })
  })

  it('keeps fields no writer knows, and a change that writes nothing leaves the file alone', async () => {
    await writeFile(paths.state, JSON.stringify({ schemaVersion: 1, future: { a: 1 } }))
    await updateStateFile(paths.state, (raw) => ({ next: { ...raw, x: 1 }, value: undefined }))
    const unchanged = await updateStateFile(paths.state, (raw) => ({ value: raw['x'] }))
    expect(unchanged).toBe(1)
    expect(await readState()).toEqual({ schemaVersion: 1, future: { a: 1 }, x: 1 })
  })

  it('a failed change does not stop the next one', async () => {
    const failed = updateStateFile(paths.state, () => {
      throw new Error('boom')
    })
    const next = updateStateFile(paths.state, (raw) => ({ next: { ...raw, y: 2 }, value: 'ok' }))
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(await readState()).toMatchObject({ y: 2 })
  })

  it('refuses (NEWER_SCHEMA) a state.json a newer Dim Factory wrote', async () => {
    await writeFile(paths.state, JSON.stringify({ schemaVersion: 99, keep: true }))
    await expect(
      updateStateFile(paths.state, (raw) => ({ next: { ...raw, z: 1 }, value: undefined })),
    ).rejects.toMatchObject({ code: 'NEWER_SCHEMA' })
    expect(await readState()).toEqual({ schemaVersion: 99, keep: true })
  })
})
