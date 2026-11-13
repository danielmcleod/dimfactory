// Session-reuse drivers (state-machine row R10): a real core (src/core/app-core.ts) with the fake
// Claude replaying the C08 recordings — C08a Implement (`--session-id`), C08b Fix (`--resume=<id>`), C08c a resume
// the CLI rejects ("No conversation found", exit 1). The fake keeps the transcript of every session it reports, like
// the real CLI, which is what the Claude adapter's canResume looks for.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { sumClaudeModelUsage } from '../../../src/core/adapters/usage.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { Usage } from '../../../src/shared/events.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { STDIO, cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { ScenarioSpec } from '../run/scenario.ts'

export const versionWrite = { path: 'src/version.ts', content: 'export const version = "0.1.0"\n' }
export const fixWrite = { path: 'src/version.test.ts', content: 'import "./version"\n' }

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

export interface Started {
  core: Core
  c: RunController
  runId: string
  home: string
  folder: string
  claudeConfigDir: string
  sc: Awaited<ReturnType<typeof makeScenario>>
  events: RunEnvelope[]
}

export class World {
  readonly cores: Core[] = []
  readonly dirs: string[] = []

  async dispose(): Promise<void> {
    for (const c of this.cores.splice(0)) await c.shutdown()
    cleanup(...this.dirs.splice(0))
  }

  async boot(
    spec: ScenarioSpec,
    o: {
      /** Scenario entries placed first (raw recordings matched by argv), e.g. C08c for `--resume=*`. */
      first?: { match: Record<string, string[]>; recording: string }[]
      /** Extra env for the fake (vendors.claude.env). */
      env?: Record<string, string>
    } = {},
  ): Promise<Omit<Started, 'c' | 'runId'>> {
    const sc = await makeScenario(spec)
    if (o.first !== undefined && o.first.length > 0) {
      const file = join(sc.dir, 'scenario.json')
      const entries = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
      const first = o.first.map((e) => ({
        match: e.match,
        script: join(STDIO, e.recording, 'recording.jsonl'),
      }))
      writeFileSync(file, JSON.stringify([...first, ...entries], null, 2))
    }
    Object.assign(sc.env, o.env ?? {})
    const { home, claudeConfigDir } = await makeHome(sc)
    const folder = makeSandbox()
    this.dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    this.cores.push(core)
    const events: RunEnvelope[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e) })
    return { core, home, folder, claudeConfigDir, sc, events }
  }

  async start(
    spec: ScenarioSpec,
    o: Parameters<World['boot']>[1] & { overrides?: Record<string, unknown> } = {},
  ): Promise<Started> {
    const b = await this.boot(spec, o)
    const r = await b.core.invoke('runs.start', {
      folder: b.folder,
      task: 'add a --version flag',
      overrides: o.overrides ?? { gates: { afterPlan: false } },
    })
    const runId = value(r).runId
    const c = b.core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    return { ...b, c, runId }
  }
}

/** The cumulative totals a recording's `result` reports (what the adapter subtracts from). */
export function cumulative(id: string): Usage {
  for (const l of readFileSync(join(STDIO, id, 'recording.jsonl'), 'utf8').split('\n')) {
    if (l.trim() === '') continue
    const f = JSON.parse(l) as { dir?: string; line?: string }
    if (f.dir !== 'out' || f.line === undefined) continue
    let v: { type?: string; modelUsage?: Parameters<typeof sumClaudeModelUsage>[0] }
    try {
      v = JSON.parse(f.line) as typeof v
    } catch {
      continue
    }
    if (v.type === 'result') return sumClaudeModelUsage(v.modelUsage)
  }
  throw new Error(`${id}: no result`)
}
