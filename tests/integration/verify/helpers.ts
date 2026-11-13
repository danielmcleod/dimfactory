// Verify drivers (the Verify step, state-machine rows R6/R7/R11): a real core with the fake Claude (the run suite's
// scenario machinery) and real verify commands: small node scripts in the sandbox, run by src/core/verify through
// src/core/proc. Trust grants are written to the temp home's trust.json (never the real ~/.dimfactory).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { grantTrust } from '../../../src/core/config/trust.ts'
import type { RunController } from '../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { VerifyCommandConfig } from '../../../src/shared/config-schema.ts'
import type { Result } from '../../../src/shared/ipc.ts'
import type { CardView, RunEnvelope } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../run/scenario.ts'

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

/** Passes when src/version.ts names 1.0.0; otherwise prints what it found and fails (exit 1). */
export const CHECK_SCRIPT = [
  "import { readFileSync } from 'node:fs'",
  "let v = ''",
  "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
  "if (v.includes('1.0.0')) { console.log('version ok'); process.exit(0) }",
  "console.log('checking src/version.ts')",
  "console.error('expected version 1.0.0, got ' + (v.trim() || 'nothing'))",
  'process.exit(1)',
].join('\n')

export const CHECK: VerifyCommandConfig = { name: 'check', run: ['node', 'check.mjs'] }

export const version = (v: string): { path: string; content: string } => ({
  path: 'src/version.ts',
  content: `export const version = "${v}"\n`,
})

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

export function openCard(s: RunState, kind: CardView['kind']): CardView | undefined {
  return s.cards.find((c) => c.view.kind === kind)?.view
}

export interface Started {
  core: Core
  c: RunController
  runId: string
  home: string
  folder: string
  sc: Scenario
  events: RunEnvelope[]
}

export class VerifyWorld {
  readonly cores: Core[] = []
  readonly dirs: string[] = []

  /** A scenario, a home and a git sandbox with `files` written into it (untracked, so in every snapshot). */
  async setup(
    spec: ScenarioSpec,
    files: Record<string, string> = { 'check.mjs': CHECK_SCRIPT },
  ): Promise<{ sc: Scenario; home: string; folder: string }> {
    const sc = await makeScenario(spec)
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(folder, rel), text)
    this.dirs.push(home, sc.dir, folder)
    return { sc, home, folder }
  }

  /** The command grant [Trust for this project] would write (trust.json under the temp home). */
  async trust(home: string, folder: string, argv: string[], body?: string): Promise<void> {
    await grantTrust(
      folder,
      {
        kind: 'command',
        command: { kind: 'verify', argv, cwdRel: '.', ...(body !== undefined ? { body } : {}) },
      },
      { home },
    )
  }

  async boot(home: string): Promise<{ core: Core; events: RunEnvelope[] }> {
    const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
    this.cores.push(core)
    const events: RunEnvelope[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e) })
    return { core, events }
  }

  async start(
    w: { sc: Scenario; home: string; folder: string },
    overrides: Record<string, unknown>,
  ): Promise<Started> {
    const { core, events } = await this.boot(w.home)
    const { runId } = value(
      await core.invoke('runs.start', { folder: w.folder, task: 'add a --version flag', overrides }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    return { core, c, runId, home: w.home, folder: w.folder, sc: w.sc, events }
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

/** Run overrides: no plan gate, Verify on with `commands`. */
export function verifyOverrides(
  commands: VerifyCommandConfig[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    profile: 'claude-only',
    gates: { afterPlan: false, beforeFix: false },
    verify: { enabled: true, commands },
    ...extra,
  }
}
