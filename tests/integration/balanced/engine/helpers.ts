// Second-vendor engine drivers (the Codex session id "from the thread/start response, before turn/start", first
// launch and the Critic swap, the vendor_setup and switch_vendor executors, "balanced end to end"): a real core with
// the fake Claude (the session and recovery suites' scenario machinery) and an in-process Codex (tests/unit/balanced/engine/helpers.ts ScriptedCodex)
// registered in place of the Codex adapter the core boots with, so the engine's side of a second vendor runs without
// any Codex binary (the machine's own `codex` is never started: probes, auth re-checks and passes all go through the
// registered adapter).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core, CreateCoreOptions } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { homePaths } from '../../../../src/core/home.ts'
import type { RunController } from '../../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import type { Usage } from '../../../../src/shared/events.ts'
import type { Failure } from '../../../../src/shared/failure.ts'
import type { AppEvent, Result } from '../../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../../run/scenario.ts'
import { ScriptedCodex } from '../../../unit/balanced/engine/helpers.ts'
import { prepend } from '../../self-heal/helpers.ts'
import type { CodexScript, Sandbox } from '../../../unit/balanced/engine/helpers.ts'

export { ScriptedCodex }
export type { CodexScript, Sandbox }

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

/** run.json as it is on disk now (what a relaunch would read). */
export function runJsonOnDisk(home: string, runId: string): RunState {
  const doc = JSON.parse(readFileSync(homePaths(home).run(runId).runJson, 'utf8')) as { state: RunState }
  return doc.state
}

/** `claude auth status` signed out (tests/fixtures/claude/meta/auth-status-logged-out.txt), for every probe. */
export function claudeAuthLoggedOut(sc: Scenario): void {
  const file = join(sc.dir, 'scenario.json')
  const entries = JSON.parse(readFileSync(file, 'utf8')) as {
    match: { argvIncludes?: string[] }
    script: string
    repeat?: boolean
  }[]
  const out = {
    loggedIn: false,
    authMethod: 'none',
    apiProvider: 'firstParty',
    analyticsDisabled: false,
  }
  const script = join(sc.dir, 'auth-status-logged-out.script.jsonl')
  const ops = [
    ...JSON.stringify(out, null, 2)
      .split('\n')
      .map((line) => ({ op: 'stdout', line })),
    {
      op: 'exit',
      code: 1,
    },
  ]
  writeFileSync(script, `${ops.map((op) => JSON.stringify(op)).join('\n')}\n`)
  const auth = entries.filter((e) => e.match.argvIncludes?.join(' ') === 'auth status')
  if (auth.length !== 1) throw new Error('the scenario has no single auth status entry')
  auth[0]!.script = script
  auth[0]!.repeat = true
  writeFileSync(file, JSON.stringify(entries, null, 2))
}

export interface BalancedWorld {
  core: Core
  home: string
  folder: string
  sc: Scenario
  codex: ScriptedCodex
  events: RunEnvelope[]
  appEvents: AppEvent[]
}

export class World {
  readonly cores: Core[] = []
  readonly dirs: string[] = []

  /**
   * A home whose dimfactory.json points Claude at the fake (with `user` merged in), a sandbox folder, and a core with
   * `codex` registered. The Codex probe is stored (as the launch probe would) unless `probe: false`.
   * `claudeLoggedOut`: the fake Claude's `auth status` answers signed out, so Claude is not ready
   * without any real Claude being looked for (a missing configured path falls back to the well-known locations, where
   * the developer's own CLI would be found and run).
   */
  async boot(
    spec: ScenarioSpec,
    codex: ScriptedCodex,
    o: {
      user?: Record<string, unknown>
      probe?: boolean
      claudeLoggedOut?: boolean
      /** Hand-written fake Claude scripts placed first (matched by argv, each runs once). */
      first?: Parameters<typeof prepend>[1]
      /** Extra createCore options (the live balanced run's tests: a short live-count poll, a notify sink). */
      core?: Partial<CreateCoreOptions>
    } = {},
  ): Promise<BalancedWorld> {
    const sc = await makeScenario(spec)
    if (o.first !== undefined) prepend(sc, o.first)
    if (o.claudeLoggedOut === true) claudeAuthLoggedOut(sc)
    const { home } = await makeHome(sc)
    const file = join(home, 'dimfactory.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...cfg, ...(o.user ?? {}) }, null, 2))
    const folder = makeSandbox()
    this.dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv(), ...o.core })
    this.cores.push(core)
    core.adapters.register(codex)
    const events: RunEnvelope[] = []
    const appEvents: AppEvent[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e), global: (e) => appEvents.push(e) })
    if (o.probe !== false) value(await core.invoke('vendors.probe', { vendor: 'codex', force: true }))
    return { core, home, folder, sc, codex, events, appEvents }
  }

  async start(
    w: BalancedWorld,
    overrides: Record<string, unknown>,
    task = 'add a --version flag',
  ): Promise<{ runId: string; c: RunController }> {
    const { runId } = value(await w.core.invoke('runs.start', { folder: w.folder, task, overrides }))
    const c = w.core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    return { runId, c }
  }

  async dispose(): Promise<void> {
    for (const c of this.cores.splice(0)) await c.shutdown()
    cleanup(...this.dirs.splice(0))
  }
}

/** One Codex turn: completes (a mutating pass writes `file`), or fails with a classified failure. */
export type CodexTurn =
  { kind: 'ok'; text?: string; file?: string; usage?: Usage } | { kind: 'fail'; failure: Failure }

/**
 * Codex as the adapter reports it to the engine: thread/start (or thread/resume, echoing its id) → onSession → the
 * turn. `turns` are played per start in order (the last one repeats); `thread` names each fresh thread.
 */
export function codexPlays(
  turns: readonly CodexTurn[],
  o: { thread?: (n: number) => string } = {},
): CodexScript {
  let n = 0
  return (h, start) => {
    const turn = turns[Math.min(n, turns.length - 1)] ?? { kind: 'ok' }
    n++
    const thread = start.resume?.sessionId ?? o.thread?.(n) ?? `thr_m8_${n}`
    void (async () => {
      h.thread = thread
      await start.onSession?.(thread)
      h.events.emit({ type: 'session', id: thread })
      if (turn.kind === 'fail') {
        const f = turn.failure
        h.events.emit({
          type: 'error',
          message: f.message,
          raw: f.raw,
          fatal: true,
          category: f.category,
          ...(f.resetsAt !== undefined ? { resetsAt: f.resetsAt } : {}),
          ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}),
        })
        h.exit(1)
        return
      }
      if (turn.file !== undefined) {
        writeFileSync(join(start.cwd, turn.file), `// ${start.step} ${n}\n`)
        h.events.emit({ type: 'tool', id: `fc${n}`, name: 'fileChange', summary: turn.file, phase: 'start' })
        h.events.emit({
          type: 'tool',
          id: `fc${n}`,
          name: 'fileChange',
          summary: turn.file,
          phase: 'end',
          status: 'ok',
        })
      }
      const text = turn.text ?? 'Done.'
      h.events.emit({ type: 'text', delta: text })
      h.events.emit({ type: 'done', result: text, usage: turn.usage ?? { input: 1_000, output: 100 } })
      h.exit(0)
    })()
  }
}

const claudeHandshake = [
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
    line: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-0001', cwd: '<CWD>' }),
  },
]

/** A Claude pass whose CLI is logged out (C09: `is_error` on a success result, "Not logged in"): auth_required. */
export function claudeLoggedOutScript(): object[] {
  return [
    ...claudeHandshake,
    {
      op: 'stdout',
      line: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        session_id: 'claude-0001',
      }),
    },
    { op: 'exit', code: 1 },
  ]
}

/** A Claude pass that fails in a way no rule knows (stderr only): `unknown`, healed automatically. */
export const UNKNOWN_STDERR = 'zork: the frobnicator is out of phase'
export function claudeUnknownFailureScript(): object[] {
  return [...claudeHandshake, { op: 'stderr', line: UNKNOWN_STDERR }, { op: 'exit', code: 3 }]
}

export const IMPLEMENT_MATCH = { argvIncludes: ['-p', 'acceptEdits'], argvExcludes: ['--resume=*'] }
export const REVIEW_MATCH = { argvIncludes: ['-p', 'dontAsk', '--model', 'sonnet'] }

/** The latest snag a step raised (its actions in the failure table's order). */
export function snagOf(
  events: readonly RunEnvelope[],
  step: string,
): Extract<RunEnvelope['body'], { t: 'snag' }> | undefined {
  return events
    .map((e) => e.body)
    .filter((b): b is Extract<RunEnvelope['body'], { t: 'snag' }> => b.t === 'snag' && b.step === step)
    .at(-1)
}

export const failedWithSnag =
  (step: 'plan' | 'implement' | 'review' | 'critic' | 'fix') =>
  (s: RunState): boolean =>
    s.steps[step].status === 'failed' && s.steps[step].snagOpen

/** A healer's answer (the internal/heal.md prompt: one fenced JSON block) with one safe config fix. */
export const HEAL_DIAGNOSIS = 'Review used a model this account cannot reach; use the CLI default.'
export const HEAL_ANSWER = [
  'Diagnosis below.',
  '```json',
  JSON.stringify({
    diagnosis: HEAL_DIAGNOSIS,
    confidence: 'medium',
    category: 'model_unavailable',
    actions: [
      {
        kind: 'config',
        ops: [{ op: 'replace', path: '/passes/review/model', value: null }],
        reason: 'Use the default model.',
      },
    ],
  }),
  '```',
].join('\n')
