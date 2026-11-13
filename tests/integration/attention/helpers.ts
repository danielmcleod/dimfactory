// Attention integration helpers: a core over the fake Claude (real adapter, real spawn, real git shadow) under
// DIM_FACTORY_E2E=1, so its clock can be moved (`advanceClock`), with every host notification recorded instead of
// shown. Builds on tests/integration/run/scenario.ts.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core, CoreNotification } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { GlobalEvent } from '../../../src/core/bus/bus.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { RunEnvelope, RunEventBody } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'

export const versionWrite = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }
export const fixWrite = { path: 'src/version.test.ts', content: 'import "./version"\n' }

export interface Started {
  core: Core
  c: RunController
  runId: string
  home: string
  folder: string
  sc: Scenario
  events: RunEnvelope[]
  /** AppEvents other than `run` (attention, run-summary, …). */
  globals: GlobalEvent[]
  notes: CoreNotification[]
}

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

const cores: Core[] = []
const dirs: string[] = []

/** Remove `dir` (and its temp root) in teardown. */
export function track(dir: string): void {
  dirs.push(dir)
}

/** afterEach: shut every core down and remove the temp folders. */
export async function teardown(): Promise<void> {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
}

/**
 * Auto runs launch Implement / Fix with `bypassPermissions` (full mode): point the scenario's `acceptEdits` entries
 * at that permission mode instead.
 */
export function matchFullMode(sc: Scenario): void {
  const file = join(sc.dir, 'scenario.json')
  const entries = JSON.parse(readFileSync(file, 'utf8')) as { match: { argvIncludes?: string[] } }[]
  for (const e of entries) {
    const inc = e.match.argvIncludes
    if (inc !== undefined)
      e.match.argvIncludes = inc.map((a) => (a === 'acceptEdits' ? 'bypassPermissions' : a))
  }
  writeFileSync(file, JSON.stringify(entries, null, 2))
}

export async function start(
  spec: ScenarioSpec,
  o: { overrides?: Record<string, unknown>; fullMode?: boolean } = {},
): Promise<Started> {
  const sc = await makeScenario(spec)
  if (o.fullMode === true) matchFullMode(sc)
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  const notes: CoreNotification[] = []
  const core = await createCore({
    home,
    host: { kind: 'app', notify: (n) => notes.push(n) },
    env: hermeticEnv({ DIM_FACTORY_E2E: '1' }),
  })
  cores.push(core)
  const events: RunEnvelope[] = []
  const globals: GlobalEvent[] = []
  core.bus.attach({ name: 't', run: (e) => events.push(e), global: (g) => globals.push(g) })
  const r = await core.invoke('runs.start', {
    folder,
    task: 'add a --version flag',
    overrides: o.overrides ?? { gates: { afterPlan: false } },
  })
  if (!r.ok) throw new Error(r.error.message)
  const c = core.controller(r.value.runId)
  if (c === undefined) throw new Error('no controller')
  return { core, c, runId: r.value.runId, home, folder, sc, events, globals, notes }
}

export function bodies<T extends RunEventBody['t']>(
  events: readonly RunEnvelope[],
  t: T,
): Extract<RunEventBody, { t: T }>[] {
  return events.map((e) => e.body).filter((b): b is Extract<RunEventBody, { t: T }> => b.t === t)
}

/** The first pending ask of Implement, once there is one. */
export async function implementAsk(
  c: RunController,
  timeoutMs = 60_000,
): Promise<{ state: RunState; requestId: string; expiresAt: number }> {
  const state = await c.waitFor((s) => s.steps.implement.asks.length > 0 || settled(s), timeoutMs)
  const ask = state.steps.implement.asks[0]
  if (ask === undefined) throw new Error(`no ask; run ${state.status}`)
  return { state, requestId: ask.requestId, expiresAt: ask.expiresAt }
}
