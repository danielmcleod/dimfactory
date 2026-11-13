// RunController: a burst of text deltas (one stdout chunk of a fast stream) reduces as a few events, not one per
// delta (performance.spec.ts: a 5 MB replay was ~48k reductions and seconds of the host's event loop). Order with other
// events is kept and the merged text stays under the bus's coalescing size.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter } from '../../../src/core/adapters/types.ts'
import { EventBus } from '../../../src/core/bus/bus.ts'
import { COALESCE_MAX_BYTES } from '../../../src/core/bus/coalesce.ts'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import type { Shadow } from '../../../src/core/git/shadow.ts'
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
import type { EngineEventBody, RunState } from '../../../src/core/supervisor/types.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function controller(): Promise<{ c: RunController; close: () => Promise<void> }> {
  const home = mkdtempSync(join(tmpdir(), 'dim-run-text-burst-'))
  dirs.push(home)
  const paths = homePaths(home)
  await ensureHome(paths)
  const config = resolveBuiltinConfig({ profile: 'claude-only' })
  const runId = '20261006T120000Z-tb01'
  const state: RunState = initRunState({
    runId,
    displayNo: 1,
    folder: home,
    folderKey: '0123456789abcdef',
    task: 'stream a lot of text',
    profile: 'claude-only',
    createdAt: Date.now(),
    config: runConfigFromResolved(config, 'emulated'),
  })
  const scope = { folder: home, scopeRoot: home, lockKey: home, folderKey: '0123456789abcdef', isRepo: false }
  const doc: RunDoc = { runId, state, lastSeq: 0, scope, createdBy: 'cli' }
  const store = await RunStore.create<RunDoc>(paths, runId, doc, { log: silentLogger })
  const bus = new EventBus({ home: paths, log: silentLogger })
  await bus.openRun(runId, { createdAt: state.createdAt })
  const c = new RunController(state, {
    paths,
    bus,
    store,
    config,
    scope,
    createdBy: 'cli',
    adapters: { get: () => ({}) as unknown as Adapter },
    preflight: (mode) => Promise.resolve({ mode, ok: true, blocking: [], warnings: [], info: [] }),
    scheduler: new FolderScheduler(),
    summarize: (s) => toRunSummary(s),
    clock: systemClock(),
    log: silentLogger,
    shadow: () => Promise.resolve({} as unknown as Shadow),
    procTable: await ProcTable.open(paths.run(runId).procsJson),
  })
  return { c, close: () => bus.close() }
}

const text = (delta: string, spawnNo = 1): EngineEventBody => ({
  t: 'adapter',
  step: 'implement',
  spawnNo,
  ev: { type: 'text', delta },
})

describe('RunController text bursts', () => {
  it('reduces the deltas of one stdout chunk as one event, in order with what follows', async () => {
    const { c, close } = await controller()
    let reductions = 0
    c.subscribe(() => reductions++)
    // The adapter hands over a chunk's lines one microtask apart (for await over the line queue).
    const done: Promise<unknown>[] = []
    for (let i = 0; i < 300; i++) {
      done.push(c.enqueue(text(String(i % 10))))
      await Promise.resolve()
    }
    done.push(c.enqueue({ t: 'adapter', step: 'implement', spawnNo: 1, ev: { type: 'session', id: 's1' } }))
    done.push(c.enqueue(text('after')))
    await Promise.all(done)
    // 300 deltas → 1, the session event → 1, the trailing delta → 1.
    expect(reductions).toBe(3)
    await close()
  })

  it('keeps each merged event under the coalescing size and never merges two spawns', async () => {
    const { c, close } = await controller()
    let reductions = 0
    c.subscribe(() => reductions++)
    const big = 'x'.repeat(Math.ceil(COALESCE_MAX_BYTES / 2) + 1)
    const done = [text(big), text(big), text(big), text('y', 2), text('z', 2)].map((b) => c.enqueue(b))
    await Promise.all(done)
    // [big, big] reaches the cap → 1; [big] → 1; spawn 2's two deltas → 1.
    expect(reductions).toBe(3)
    await close()
  })

  it('still drains a non-text event at once (no extra event-loop turn)', async () => {
    const { c, close } = await controller()
    let reductions = 0
    c.subscribe(() => reductions++)
    const p = c.enqueue({ t: 'adapter', step: 'implement', spawnNo: 1, ev: { type: 'session', id: 's1' } })
    let immediate = false
    setImmediate(() => (immediate = true))
    await p
    expect(reductions).toBe(1)
    expect(immediate).toBe(false)
    await close()
  })
})
