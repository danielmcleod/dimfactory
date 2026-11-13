// Re-run drivers (Re-run from Fix, Re-run with same config, state-machine row R14): a real core
// (src/core/app-core.ts) with the fake Claude replaying the Claude recordings (tests/integration/run/scenario.ts), a home
// that can be booted again (a relaunch), and the re-run's own controller.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import {
  REVIEW_WITH_FINDINGS,
  cleanup,
  git,
  hermeticEnv,
  makeHome,
  makeSandbox,
  makeScenario,
  passArgvs,
} from '../run/scenario.ts'
import type { PassScript, ScenarioSpec } from '../run/scenario.ts'

export { REVIEW_WITH_FINDINGS, git }

export const versionWrite = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }
export const fixWrite = { path: 'src/version.test.ts', content: 'import "./version"\n' }
export const TASK = 'add a --version flag'

/** Plan (native), Implement (C08a, its session id), Review with F1/F2 [must] and F3 [should]; Critic clean. */
export const SOURCE: ScenarioSpec = {
  plan: { recording: 'C06-plan-native-host' },
  implement: [{ recording: 'C08a-session-id-implement', write: versionWrite }],
  review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
}

/** A Fix that continues Implement's session (`--resume=<id>`, C08b) and writes a test file. */
export const RESUMED_FIX: PassScript = { recording: 'C08b-resume-fix', write: fixWrite }

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

/** Every ask on any step of the run: allowed, as a user would (C03/C08's tool asks). */
export function allowAsks(core: Core, c: RunController): void {
  c.subscribe((s) => {
    for (const st of Object.values(s.steps)) {
      for (const a of st.asks) {
        void core.invoke('asks.answer', {
          runId: s.runId,
          requestId: a.requestId,
          decision: 'allow',
          graceMs: 0,
        })
      }
    }
  })
}

export function runDirs(home: string): string[] {
  try {
    return readdirSync(join(home, 'runs'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** One home + folder + fake-Claude scenario; cores can be booted on it again (a relaunch). */
export class Bench {
  readonly cores: Core[] = []
  readonly dirs: string[] = []
  home = ''
  folder = ''
  claudeConfigDir = ''
  sc: Awaited<ReturnType<typeof makeScenario>> | undefined
  events: RunEnvelope[] = []

  async setup(spec: ScenarioSpec): Promise<Core> {
    this.sc = await makeScenario(spec)
    const h = await makeHome(this.sc)
    this.home = h.home
    this.claudeConfigDir = h.claudeConfigDir
    this.folder = makeSandbox()
    this.dirs.push(this.home, this.sc.dir, this.folder)
    return this.boot()
  }

  /** A core on the bench's home (again after a shutdown: the relaunch's recovery runs). */
  async boot(): Promise<Core> {
    const core = await createCore({ home: this.home, host: { kind: 'app' }, env: hermeticEnv() })
    this.cores.push(core)
    core.bus.attach({ name: 't', run: (e) => this.events.push(e) })
    return core
  }

  /** runs.start in the bench's folder; the run's controller, with asks allowed. */
  async start(core: Core, overrides: Record<string, unknown>): Promise<RunController> {
    const r = value(await core.invoke('runs.start', { folder: this.folder, task: TASK, overrides }))
    return this.controller(core, r.runId)
  }

  controller(core: Core, runId: string): RunController {
    const c = core.controller(runId)
    expect(c, `controller of ${runId}`).toBeDefined()
    allowAsks(core, c as RunController)
    return c as RunController
  }

  async dispose(): Promise<void> {
    for (const c of this.cores.splice(0)) await c.shutdown().catch(() => undefined)
    cleanup(...this.dirs.splice(0))
  }
}

/** The argv of every pass the fake started, and those that resumed a session (`--resume=<id>`). */
export function passes(b: Bench): { all: string[][]; resumed: string[][] } {
  const all = b.sc !== undefined ? passArgvs(b.sc.entries()) : []
  return { all, resumed: all.filter((a) => a.some((x) => x.startsWith('--resume='))) }
}
