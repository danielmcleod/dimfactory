// Gemini engine drivers (the ACP base + Gemini; the ACP session id comes "from the session/new response, before
// session/prompt"; trust.json `vendorFolder`; the grant executor): a real core with the fake Claude (the session and
// recovery suites' scenario machinery), an in-process Gemini (tests/unit/gemini/engine/helpers.ts ScriptedGemini) and optionally the
// in-process Codex, registered in place of the adapters the core boots with. No Gemini binary is ever looked for or
// started: probes, readiness and passes all go through the registered stand-in, and ~/.gemini is never touched.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { homePaths } from '../../../../src/core/home.ts'
import type { RunController } from '../../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import type { Failure } from '../../../../src/shared/failure.ts'
import type { AppEvent, Result } from '../../../../src/shared/ipc.ts'
import type { RunEnvelope } from '../../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../../run/scenario.ts'
import { prepend } from '../../self-heal/helpers.ts'
import { claudeAuthLoggedOut } from '../../balanced/engine/helpers.ts'
import type { ScriptedCodex } from '../../../unit/balanced/engine/helpers.ts'
import { ScriptedGemini, rejectReadOnly } from '../../../unit/gemini/engine/helpers.ts'
import type { GeminiScript, GeminiTurn } from '../../../unit/gemini/engine/helpers.ts'

export { ScriptedGemini }

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

export const failedWithSnag =
  (step: 'plan' | 'implement' | 'review' | 'critic' | 'fix') =>
  (s: RunState): boolean =>
    s.steps[step].status === 'failed' && s.steps[step].snagOpen

/** run.json as it is on disk now (what a relaunch would read). */
export function runJsonOnDisk(home: string, runId: string): RunState {
  const doc = JSON.parse(readFileSync(homePaths(home).run(runId).runJson, 'utf8')) as { state: RunState }
  return doc.state
}

/** trust.json as it is on disk now (missing: null). */
export function trustJsonOnDisk(home: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(homePaths(home).trust, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

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

/** Every ask the run's event log carries (a read-only pass must raise none). */
export function asksIn(events: readonly RunEnvelope[], step?: string): RunEnvelope[] {
  return events.filter(
    (e) => e.body.t === 'ev' && e.body.ev.type === 'ask' && (step === undefined || e.body.step === step),
  )
}

export interface GeminiWorld {
  core: Core
  home: string
  folder: string
  sc: Scenario
  gemini: ScriptedGemini
  codex?: ScriptedCodex
  events: RunEnvelope[]
  appEvents: AppEvent[]
}

export class World {
  readonly cores: Core[] = []
  readonly dirs: string[] = []

  /**
   * A home whose dimfactory.json points Claude at the fake (with `user` merged in), a sandbox folder, and a core with
   * the Gemini stand-in (and `codex`, when given) registered. Their probes are stored as the launch probe would
   * (unless `probe: false`); `trust` grants the sandbox folder to Gemini through `trust.set` first. `claudeLoggedOut`:
   * the fake Claude's `auth status` answers logged out (Claude not ready without ever looking for a real Claude: a
   * missing configured path falls back to the well-known locations, where the developer's own CLI may be signed in).
   */
  async boot(
    spec: ScenarioSpec,
    gemini: ScriptedGemini,
    o: {
      codex?: ScriptedCodex
      user?: Record<string, unknown>
      probe?: boolean
      trust?: boolean
      first?: Parameters<typeof prepend>[1]
      claudeLoggedOut?: boolean
    } = {},
  ): Promise<GeminiWorld> {
    const sc = await makeScenario(spec)
    if (o.first !== undefined) prepend(sc, o.first)
    if (o.claudeLoggedOut === true) claudeAuthLoggedOut(sc)
    const { home } = await makeHome(sc)
    const file = join(home, 'dimfactory.json')
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...cfg, ...(o.user ?? {}) }, null, 2))
    const folder = makeSandbox()
    this.dirs.push(home, sc.dir, folder)
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    this.cores.push(core)
    if (o.codex !== undefined) core.adapters.register(o.codex)
    core.adapters.register(gemini)
    const events: RunEnvelope[] = []
    const appEvents: AppEvent[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e), global: (e) => appEvents.push(e) })
    if (o.probe !== false) {
      value(await core.invoke('vendors.probe', { vendor: 'gemini', force: true }))
      if (o.codex !== undefined) value(await core.invoke('vendors.probe', { vendor: 'codex', force: true }))
    }
    if (o.trust === true) {
      value(
        await core.invoke('trust.set', {
          folder,
          grant: { kind: 'vendorFolder', vendor: 'gemini' },
          trusted: true,
        }),
      )
    }
    return {
      core,
      home,
      folder,
      sc,
      gemini,
      ...(o.codex !== undefined ? { codex: o.codex } : {}),
      events,
      appEvents,
    }
  }

  async start(
    w: GeminiWorld,
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

/** A Gemini turn that fails the way Gemini does in a folder it does not trust (exit 55, its own words). */
export const UNTRUSTED: Failure = {
  category: 'trust_required',
  message: 'Gemini CLI is not running in a trusted directory. To proceed, trust this folder.',
  raw: 'Gemini CLI is not running in a trusted directory. To proceed, trust this folder.',
  classifiedBy: 'exit',
}

export type GeminiPlay = GeminiTurn & { fail?: Failure; plan?: string }

/**
 * Gemini as the ACP adapter reports it to the engine: session/new (or session/load of the resumed id) → onSession
 * awaited before session/prompt → the turn. A read-only pass rejects every permission request itself (never an ask).
 * A native Plan captures the plan from exit_plan_mode (rejected) and ends with it. `plays` run per start in order
 * (the last repeats); `session(n)` names each fresh session.
 */
export function geminiPlays(
  plays: readonly GeminiPlay[],
  o: {
    session?: (n: number) => string
    seen?: (o: Parameters<GeminiScript>[1], persisted: string | undefined) => void
  } = {},
): GeminiScript {
  let n = 0
  return (h, start) => {
    const play = plays[Math.min(n, plays.length - 1)] ?? {}
    n++
    const session = start.resume?.sessionId ?? o.session?.(n) ?? `gem-sess-${n}`
    void (async () => {
      h.session = session
      const recorded = await start.onSession?.(session)
      o.seen?.(start, recorded?.ok === true ? session : undefined)
      h.events.emit({ type: 'session', id: session })
      if (play.fail !== undefined) {
        const f = play.fail
        h.events.emit({ type: 'error', message: f.message, raw: f.raw, fatal: true, category: f.category })
        h.exit(f.category === 'trust_required' ? 55 : 1)
        return
      }
      for (const a of play.asks ?? []) {
        if (start.mode === 'readonly') rejectReadOnly(h, a.toolCallId, a.tool, a.title)
      }
      if (start.step === 'plan' && start.planNative && play.plan !== undefined) {
        // Permission order, first rule: exit_plan_mode is captured, rejected, and the turn cancelled.
        h.signals.emit({ type: 'plan-captured', markdown: play.plan, source: 'acp-exit-plan' })
        h.signals.emit({
          type: 'auto-answered',
          requestId: `${h.id}:exit-plan`,
          decision: 'deny',
          tool: 'exit_plan_mode',
          why: 'plan-capture',
        })
        h.events.emit({ type: 'done', result: play.plan, usage: play.usage ?? { input: 800, output: 200 } })
        h.exit(0)
        return
      }
      if (play.file !== undefined) {
        writeFileSync(join(start.cwd, play.file), `// ${start.step} ${n}\n`)
        h.events.emit({ type: 'tool', id: `w${n}`, name: 'write_file', summary: play.file, phase: 'start' })
        h.events.emit({
          type: 'tool',
          id: `w${n}`,
          name: 'write_file',
          summary: play.file,
          phase: 'end',
          status: 'ok',
        })
      }
      const text = play.text ?? 'Done.'
      h.events.emit({ type: 'text', delta: text })
      h.events.emit({
        type: 'done',
        result: text,
        usage: play.usage ?? { input: 1_000, output: 100 },
      })
      h.exit(0)
    })()
  }
}

export const IMPLEMENT_MATCH = { argvIncludes: ['-p', 'acceptEdits'], argvExcludes: ['--resume=*'] }
