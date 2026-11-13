// Recovery drivers (the executors and self-heal; state-machine rows P17/P22): a real core with the fake Claude (the
// session and verify suites' scenario machinery), plus hand-written failing passes the recordings do not cover: a rate-limit rejection with its
// reset time, and a CLI that fails in a way nothing classifies (unknown).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core, CreateCoreOptions } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

const handshake = [
  {
    op: 'expectStdin',
    match: { type: 'control_request', request_id: '$request_id_1', request: { subtype: 'initialize' } },
  },
  {
    op: 'stdout',
    line: JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: '$request_id_1', response: { models: [] } },
    }),
  },
  { op: 'expectStdin', match: { type: 'user', message: '$_' } },
  {
    op: 'stdout',
    line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fail-0001', cwd: '<CWD>' }),
  },
]

/** A Claude pass rejected by a rate limit (not a usage window) that resets at `resetsAtMs`. */
export function rateLimitedScript(resetsAtMs: number): object[] {
  return [
    ...handshake,
    {
      op: 'stdout',
      line: JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'opus',
          resetsAt: Math.floor(resetsAtMs / 1000),
        },
      }),
    },
    {
      op: 'stdout',
      line: JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'fail-0001',
        errors: ['Request rejected'],
      }),
    },
    { op: 'exit', code: 1 },
  ]
}

/** A CLI that fails in a way no rule knows (stderr only, no result): `unknown`, classified by the heuristic stage. */
export const UNKNOWN_STDERR = 'zork: the frobnicator is out of phase'
export function unknownFailureScript(): object[] {
  return [...handshake, { op: 'stderr', line: UNKNOWN_STDERR }, { op: 'exit', code: 3 }]
}

/** Put scripts first in the scenario for argv matches (each runs once, in order). */
export function prepend(
  sc: Scenario,
  entries: { match: Record<string, string[]>; ops: object[]; name: string }[],
): void {
  const file = join(sc.dir, 'scenario.json')
  const existing = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
  const first = entries.map((e) => {
    const script = join(sc.dir, `${e.name}.script.jsonl`)
    writeFileSync(script, `${e.ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
    return { match: e.match, script }
  })
  writeFileSync(file, JSON.stringify([...first, ...existing], null, 2))
}

export const PLAN_MATCH = { argvIncludes: ['-p', 'plan'] }

export interface HealWorld {
  core: Core
  home: string
  folder: string
  sc: Scenario
  events: RunEnvelope[]
}

/** A home + scenario + sandbox and a core on them; `boot` again for a relaunch on the same home. */
export class World {
  readonly cores: Core[] = []
  readonly dirs: string[] = []
  home = ''
  folder = ''
  sc: Scenario | undefined

  async setup(
    spec: ScenarioSpec,
    first: Parameters<typeof prepend>[1] = [],
    user: object = {},
  ): Promise<void> {
    const sc = await makeScenario(spec)
    prepend(sc, first)
    const { home } = await makeHome(sc)
    if (Object.keys(user).length > 0) {
      const file = join(home, 'dimfactory.json')
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      writeFileSync(file, JSON.stringify({ ...cfg, ...user }, null, 2))
    }
    this.sc = sc
    this.home = home
    this.folder = makeSandbox()
    this.dirs.push(home, sc.dir, this.folder)
  }

  async boot(o: Partial<CreateCoreOptions> = {}, env: Record<string, string> = {}): Promise<HealWorld> {
    if (this.sc === undefined) throw new Error('setup first')
    const core = await createCore({ home: this.home, host: { kind: 'app' }, env: hermeticEnv(env), ...o })
    this.cores.push(core)
    const events: RunEnvelope[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e) })
    return { core, home: this.home, folder: this.folder, sc: this.sc, events }
  }

  async start(w: HealWorld): Promise<{ runId: string; c: RunController }> {
    const { runId } = value(
      await w.core.invoke('runs.start', {
        folder: w.folder,
        task: 'add a --version flag',
        overrides: { profile: 'claude-only' },
      }),
    )
    const c = w.core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    return { runId, c }
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

export const failedWithSnag =
  (step: 'plan' | 'implement') =>
  (s: RunState): boolean =>
    s.steps[step].status === 'failed' && s.steps[step].snagOpen

export const atPlanGate = (s: RunState): boolean => s.cards.some((c) => c.view.kind === 'gate:afterPlan')
