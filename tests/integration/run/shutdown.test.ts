// RunController.shutdown (P26) with no vendor process alive but a launch in flight: the quit must pause the step,
// so the snapshot that lands during the shutdown cannot pump the launch into a spawn that outlives close().
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter } from '../../../src/core/adapters/types.ts'
import { EventBus } from '../../../src/core/bus/bus.ts'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import type { Shadow, SnapshotRecord } from '../../../src/core/git/shadow.ts'
import { ensureHome, homePaths } from '../../../src/core/home.ts'
import { silentLogger } from '../../../src/core/log.ts'
import { ProcTable } from '../../../src/core/proc/proc-table.ts'
import { RunStore } from '../../../src/core/store/run-store.ts'
import { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunDoc } from '../../../src/core/supervisor/controller.ts'
import { toRunSummary } from '../../../src/core/supervisor/derive.ts'
import { systemClock } from '../../../src/core/supervisor/effects.ts'
import { initRunState, runConfigFromResolved } from '../../../src/core/supervisor/machine.ts'
import { FolderScheduler } from '../../../src/core/supervisor/scheduler.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function record(label: string): SnapshotRecord {
  return {
    label,
    tree: `t-${label}`,
    commit: `c-${label}`,
    at: Date.now(),
    unreadable: [],
    reused: false,
    ms: 1,
    warnings: [],
  }
}

describe('RunController.shutdown', () => {
  it('pauses a launch waiting on its start snapshot; the late snapshot spawns nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dim-run-shutdown-'))
    dirs.push(home)
    const paths = homePaths(home)
    await ensureHome(paths)
    const config = resolveBuiltinConfig({
      profile: 'claude-only',
      overrides: { passes: { plan: { enabled: false } } },
    })
    const runId = '20261005T120000Z-sd01'
    const state: RunState = initRunState({
      runId,
      displayNo: 1,
      folder: home,
      folderKey: '0123456789abcdef',
      task: 'add a --version flag',
      profile: 'claude-only',
      createdAt: Date.now(),
      config: runConfigFromResolved(config, 'emulated'),
    })
    const scope = {
      folder: home,
      scopeRoot: home,
      lockKey: home,
      folderKey: '0123456789abcdef',
      isRepo: false,
    }
    const doc: RunDoc = { runId, state, lastSeq: 0, scope, createdBy: 'cli' }
    const store = await RunStore.create<RunDoc>(paths, runId, doc, { log: silentLogger })
    const bus = new EventBus({ home: paths, log: silentLogger })
    await bus.openRun(runId, { createdAt: state.createdAt })
    let starts = 0
    const adapter = {
      id: 'claude',
      displayName: 'Claude',
      transport: 'stdio-json',
      start: () => {
        starts++
        throw new Error('no vendor in this test')
      },
    } as unknown as Adapter
    let releaseS0: (() => void) | undefined
    const s0 = new Promise<void>((r) => (releaseS0 = r))
    const shadow = {
      snapshot: async (_id: string, label: string): Promise<SnapshotRecord> => {
        if (label === 'S0') await s0
        return record(label)
      },
      liveChanged: () => Promise.resolve(null),
    } as unknown as Shadow
    const c = new RunController(state, {
      paths,
      bus,
      store,
      config,
      scope,
      createdBy: 'cli',
      adapters: { get: () => adapter },
      preflight: (mode) => Promise.resolve({ mode, ok: true, blocking: [], warnings: [], info: [] }),
      scheduler: new FolderScheduler(),
      summarize: (s) => toRunSummary(s),
      clock: systemClock(),
      log: silentLogger,
      shadow: () => Promise.resolve(shadow),
      procTable: await ProcTable.open(paths.run(runId).procsJson),
    })
    await c.enqueue({ t: 'created' })
    // R2 → preflight → (Plan disabled) → R5 reconcile → S0 requested and held.
    await c.waitFor(
      (s) => Object.values(s.requests).some((r) => r.kind === 'snapshot' && r.label === 'S0'),
      10_000,
    )
    expect(c.liveProcs()).toEqual([])
    const done = c.shutdown(5000)
    await c.waitFor((s) => s.steps.implement.status === 'paused', 5000)
    releaseS0?.()
    await done
    expect(starts).toBe(0)
    expect(c.state.steps.implement).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
    const onDisk = JSON.parse(readFileSync(paths.run(runId).runJson, 'utf8')) as { state: RunState }
    expect(onDisk.state.steps.implement).toMatchObject({ status: 'paused', pause: 'interrupted-by-quit' })
    await bus.close()
  }, 30_000)
})
