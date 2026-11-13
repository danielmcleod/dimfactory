// Factory drivers: a real core with the fake Claude (the run suites' scenario machinery) in a temp home and a temp git
// sandbox, with the user file's profile, gates, verify and factory settings set for queued runs. Nothing touches the
// network or the developer's own vendor homes; the temp folders go with dispose().
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core, CreateCoreOptions } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { QueueView } from '../../../src/shared/factory.ts'
import type { AppEvent, Result } from '../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { CHECK_SCRIPT } from '../verify/helpers.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'

export { CHECK_SCRIPT }

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

export const version = (v: string): { path: string; content: string } => ({
  path: 'src/version.ts',
  content: `export const version = "${v}"\n`,
})

/** A plan entry and an implement entry per task, in order. */
export function tasksSpec(
  writes: { path: string; content: string }[],
  extra: ScenarioSpec = {},
): ScenarioSpec {
  return {
    plan: writes.map(() => ({ recording: 'C06-plan-native-host' })),
    implement: writes.map((w) => ({ recording: 'C08a-session-id-implement', write: w })),
    ...extra,
  }
}

export interface FactoryWorld {
  core: Core
  home: string
  folder: string
  sc: Scenario
  events: RunEnvelope[]
  appEvents: AppEvent[]
}

export class World {
  readonly cores: Core[] = []
  readonly dirs: string[] = []

  /** A scenario, a home whose dimfactory.json adds `user` to the fake Claude's vendors entry, and a git sandbox. */
  async setup(
    spec: ScenarioSpec,
    user: Record<string, unknown> = {},
    o: { files?: Record<string, string>; project?: Record<string, unknown> } = {},
  ): Promise<{ sc: Scenario; home: string; folder: string }> {
    const sc = await makeScenario(spec)
    const { home } = await makeHome(sc)
    const file = join(home, 'dimfactory.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(
      file,
      JSON.stringify(
        { profile: 'claude-only', gates: { afterPlan: false, beforeFix: false }, ...cfg, ...user },
        null,
        2,
      ),
    )
    const folder = makeSandbox()
    for (const [rel, text] of Object.entries(o.files ?? { 'check.mjs': CHECK_SCRIPT })) {
      writeFileSync(join(folder, rel), text)
    }
    if (o.project !== undefined) {
      mkdirSync(join(folder, '.dimfactory'), { recursive: true })
      writeFileSync(join(folder, '.dimfactory', 'dimfactory.json'), JSON.stringify(o.project, null, 2))
    }
    this.dirs.push(home, sc.dir, folder)
    return { sc, home, folder }
  }

  async boot(
    w: { sc: Scenario; home: string; folder: string },
    o: Partial<CreateCoreOptions> = {},
    env: Record<string, string> = {},
  ): Promise<FactoryWorld> {
    const core = await createCore({ home: w.home, host: { kind: 'app' }, env: hermeticEnv(env), ...o })
    this.cores.push(core)
    const events: RunEnvelope[] = []
    const appEvents: AppEvent[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e), global: (e) => appEvents.push(e) })
    return { core, home: w.home, folder: w.folder, sc: w.sc, events, appEvents }
  }

  async stop(core: Core): Promise<void> {
    const i = this.cores.indexOf(core)
    if (i >= 0) this.cores.splice(i, 1)
    await core.shutdown()
  }

  async dispose(): Promise<void> {
    for (const c of this.cores.splice(0)) await c.shutdown()
    cleanup(...this.dirs.splice(0))
  }
}

/** The queue view, once `pred` holds (read through queue.get after each queue event), or throws after `ms`. */
export async function waitForQueue(
  core: Core,
  pred: (v: QueueView) => boolean,
  ms = 180_000,
): Promise<QueueView> {
  const end = Date.now() + ms
  for (;;) {
    await core.factory?.settled()
    const v = value(await core.invoke('queue.get'))
    if (pred(v)) return v
    if (Date.now() > end) throw new Error(`queue never reached the state: ${JSON.stringify(v, null, 2)}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** The one folder queue of a view. */
export function only(v: QueueView): QueueView['folders'][number] {
  const f = v.folders[0]
  if (f === undefined || v.folders.length !== 1)
    throw new Error(`expected one queue, got ${v.folders.length}`)
  return f
}
