// Isolated-run engine drivers (state-machine rows R2/R5/R12): a real core with the fake
// Claude CLI, a temp git repository with committed node scripts as the install command and the verify commands, the
// real worktree (git/worktree.ts), deps install (src/core/prepare) and finalize (git/finalize.ts). Everything lives in
// temp folders: a temp DIM_FACTORY_HOME (never the real ~/.dimfactory), its trust.json and its worktrees.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Core, CreateCoreOptions } from '../../../../src/core/app-core.ts'
import { createCore } from '../../../../src/core/app-core.ts'
import { grantTrust } from '../../../../src/core/config/trust.ts'
import type { RunController } from '../../../../src/core/supervisor/controller.ts'
import type { RunState } from '../../../../src/core/supervisor/types.ts'
import type { VerifyCommandConfig } from '../../../../src/shared/config-schema.ts'
import type { Result } from '../../../../src/shared/ipc.ts'
import type { CardView, RunEnvelope } from '../../../../src/shared/run.ts'
import { cleanup, git, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../../run/scenario.ts'
import type { Scenario, ScenarioSpec } from '../../run/scenario.ts'

export function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

/** Passes when src/version.ts names 1.0.0; otherwise fails (exit 1). Committed, so the worktree has it. */
export const CHECK_SCRIPT = [
  "import { readFileSync } from 'node:fs'",
  "let v = ''",
  "try { v = readFileSync('src/version.ts', 'utf8') } catch {}",
  "if (v.includes('1.0.0')) { console.log('version ok'); process.exit(0) }",
  "console.error('expected version 1.0.0, got ' + (v.trim() || 'nothing'))",
  'process.exit(1)',
].join('\n')

/** Always fails: a check already failing before the run (the verify:0 baseline). */
export const LINT_SCRIPT = "console.error('lint: 3 problems'); process.exit(1)"

/**
 * The install command: writes `.deps/installed.txt` in its cwd (the worktree) and prints a few lines; with
 * `INSTALL_SLEEP` in a `sleep.txt` next to it, it first waits that many ms (and writes its pid to `.deps/pid.txt`).
 */
export const INSTALL_SCRIPT = [
  "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
  "mkdirSync('.deps', { recursive: true })",
  "writeFileSync('.deps/pid.txt', String(process.pid))",
  "const ms = existsSync('sleep.txt') ? Number(readFileSync('sleep.txt', 'utf8')) : 0",
  "console.log('installing dependencies')",
  'await new Promise((r) => setTimeout(r, ms))',
  "writeFileSync('.deps/installed.txt', 'ok')",
  "console.log('installed 3 packages')",
].join('\n')

export const CHECK: VerifyCommandConfig = { name: 'check', run: ['node', 'check.mjs'] }
export const LINT: VerifyCommandConfig = { name: 'lint', run: ['node', 'lint.mjs'] }
export const INSTALL = ['node', 'install.mjs']

export const version = (v: string): { path: string; content: string } => ({
  path: 'src/version.ts',
  content: `export const version = "${v}"\n`,
})

export const settled = (s: RunState): boolean =>
  s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed'

export function openCard(s: RunState, kind: CardView['kind']): CardView | undefined {
  return s.cards.find((c) => c.view.kind === kind)?.view
}

export const hasCard =
  (kind: CardView['kind']) =>
  (s: RunState): boolean =>
    openCard(s, kind) !== undefined

export interface IsoWorld {
  sc: Scenario
  home: string
  folder: string
}

export interface Started extends IsoWorld {
  core: Core
  c: RunController
  runId: string
  events: RunEnvelope[]
}

export class IsolatedWorld {
  readonly cores: Core[] = []
  readonly dirs: string[] = []

  /**
   * A scenario, a home and a git sandbox with the scripts committed (an isolated run starts from HEAD, so the worktree
   * has them) and `extra` files written uncommitted.
   */
  async setup(
    spec: ScenarioSpec,
    o: { committed?: Record<string, string>; extra?: Record<string, string> } = {},
  ): Promise<IsoWorld> {
    const sc = await makeScenario(spec)
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    const committed = {
      'check.mjs': CHECK_SCRIPT,
      'lint.mjs': LINT_SCRIPT,
      'install.mjs': INSTALL_SCRIPT,
      ...o.committed,
    }
    for (const [rel, text] of Object.entries(committed)) writeFileSync(join(folder, rel), text)
    git(folder, 'add', '-A')
    git(folder, 'commit', '-q', '-m', 'scripts')
    for (const [rel, text] of Object.entries(o.extra ?? {})) writeFileSync(join(folder, rel), text)
    this.dirs.push(home, sc.dir, folder)
    return { sc, home, folder }
  }

  /** A verify command grant in the SOURCE folder (trust.json under the temp home). */
  async trustVerify(w: IsoWorld, argv: string[]): Promise<void> {
    await grantTrust(
      w.folder,
      { kind: 'command', command: { kind: 'verify', argv, cwdRel: '.' } },
      { home: w.home },
    )
  }

  async boot(
    w: IsoWorld,
    o: Partial<CreateCoreOptions> = {},
  ): Promise<{ core: Core; events: RunEnvelope[] }> {
    const core = await createCore({ home: w.home, host: { kind: 'app' }, env: hermeticEnv(), ...o })
    this.cores.push(core)
    const events: RunEnvelope[] = []
    core.bus.attach({ name: 't', run: (e) => events.push(e) })
    return { core, events }
  }

  async start(
    w: IsoWorld,
    overrides: Record<string, unknown>,
    o: Partial<CreateCoreOptions> = {},
  ): Promise<Started> {
    const { core, events } = await this.boot(w, o)
    const { runId } = value(
      await core.invoke('runs.start', { folder: w.folder, task: 'add a --version flag', overrides }),
    )
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    return { ...w, core, c, runId, events }
  }

  async choose(
    t: Started,
    kind: CardView['kind'],
    choiceId: string,
    input?: string | string[],
  ): Promise<void> {
    const s = await t.c.waitFor(hasCard(kind), 120_000)
    const card = openCard(s, kind)
    value(
      await t.core.invoke('cards.resolve', {
        runId: t.runId,
        cardId: card?.id ?? '',
        choiceId,
        ...(input !== undefined ? { input } : {}),
      }),
    )
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

/** Run overrides of an isolated run: no gates, the install command, Verify with `commands` (off when none). */
export function isoOverrides(
  o: {
    commands?: VerifyCommandConfig[]
    baseline?: boolean
    auto?: boolean
    autoApply?: boolean
    install?: 'ask' | 'auto' | 'never'
  } = {},
): Record<string, unknown> {
  const commands = o.commands ?? []
  return {
    profile: 'claude-only',
    ...(o.auto === true ? { auto: true } : {}),
    gates: { afterPlan: false, beforeFix: false },
    isolation: {
      mode: 'worktree',
      worktree: {
        installCommand: INSTALL,
        install: o.install ?? 'ask',
        autoApply: o.autoApply ?? false,
      },
    },
    verify: { enabled: commands.length > 0, commands, baseline: o.baseline ?? false },
  }
}
