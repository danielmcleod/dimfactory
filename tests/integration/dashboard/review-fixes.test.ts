// Review fixes through a real core (src/core/app-core.ts) with the fake Claude:
//   - a vendor not in this build: its setup-card install command executes through core (recovery.execute + main's
//     clipboard) on a fresh core, before anything probed that vendor (the first-run script's step at 0:00);
//   - the live ETA in a quiet stretch: core republishes a running run's summary when its step passes the p80, so
//     the pushed summary says "longer than usual" itself (the renderer derives nothing);
//   - dashboard.get carries git's check for the setup card (the first run "probes vendors and git");
//   - config.resolve carries core's Critic swap and Fix session answers.
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { homePaths } from '../../../src/core/home.ts'
import { withRecoveryHost } from '../../../src/main/recovery-host.ts'
import type { Cmd, Result } from '../../../src/shared/ipc.ts'
import type { RunSummary, RunSummaryStep } from '../../../src/shared/run.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario } from '../run/scenario.ts'

const cores: Core[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const S = 1000
const DAY = 86_400_000

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}

async function until(what: string, pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function boot(home: string): Promise<Core> {
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  return core
}

/** A finished claude-only run two days ago whose Plan took `planMs`. */
function seeded(n: number, folder: string, planMs: number): RunSummary {
  const row = (
    key: RunSummaryStep['key'],
    model: string | null,
    mode: RunSummaryStep['mode'],
    activeMs: number,
  ): RunSummaryStep => ({
    key,
    vendor: 'claude',
    model,
    ...(mode !== undefined ? { mode } : {}),
    status: 'done',
    activeMs,
  })
  const createdAt = Date.now() - 2 * DAY + n * 60_000
  return {
    runId: `20261001T00000${n}Z-seed`,
    displayNo: n,
    folder,
    folderKey: 'seededfolderkey0',
    title: `seeded ${n}`,
    status: 'completed',
    phase: 'done',
    outcome: 'clean',
    profile: 'claude-only',
    auto: false,
    isolation: 'inPlace',
    pinned: false,
    createdAt,
    endedAt: createdAt + 5 * 60_000,
    progress: { tokens: 0, costUsd: null, filesChanged: 0 },
    findings: { must: 0, should: 0 },
    steps: [row('plan', 'opus', 'readonly', planMs), row('implement', null, 'autoedit', 120 * S)],
  }
}

describe('review fixes', () => {
  it('a vendor not in this build: its install command executes through core on a fresh core', async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    dirs.push(home, sc.dir)
    const core = await boot(home)
    // Gemini, Grok and Muse are built too: no vendor is left as a stub in this build. This core's Gemini goes
    // back to its registry stub, so a not-built row with an install command is what is checked.
    core.adapters.unregister('gemini')

    // What the setup card shows: Gemini not built, with its install command (the stub probe's). Codex is built, so
    // Gemini is the vendor not in this build now.
    const gemini = value(await core.invoke('vendors.list')).find((v) => v.vendor === 'gemini')
    expect(gemini?.health).toBe('not-built')
    const action = gemini?.probe?.checks.flatMap((c) => c.recovery).find((a) => a.id === 'gemini.install')
    if (action?.kind !== 'shell_copy') throw new Error('no gemini.install shell_copy on the view')

    // Nothing probed Gemini; the click still runs through core and main's clipboard (not a stale-id refusal).
    const clipboard: string[] = []
    const invoke = withRecoveryHost(
      (cmd: Cmd, req: unknown) =>
        (core.invoke as (c: Cmd, r: unknown) => Promise<Result<unknown>>).call(core, cmd, req),
      { writeClipboard: (t) => void clipboard.push(t), openExternal: () => Promise.resolve() },
    )
    const copied = await invoke('recovery.execute', { actionId: 'gemini.install' })
    expect(copied).toMatchObject({ ok: true, value: { kind: 'shell_copy', copied: action.command } })
    expect(clipboard).toEqual([action.command])
    expect(core.preflight.cache.pendingRechecks).toEqual(['vendor.gemini.bin'])
  }, 120_000)

  it('a step passing its p80 in a quiet stretch: core republishes the summary as "longer than usual"', async () => {
    // Plan sleeps a minute after the prompt: no output, so nothing but the ETA timer republishes the run.
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host', delayMs: 60_000 } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    // Five finished runs whose Plan took 12 s: the exact level, p50 = p80 = 12 s.
    const paths = homePaths(home)
    mkdirSync(paths.runsDir, { recursive: true })
    writeFileSync(
      paths.runIndex,
      [1, 2, 3, 4, 5]
        .map((n) => `${JSON.stringify({ v: 1, op: 'put', s: seeded(n, folder, 12 * S) })}\n`)
        .join(''),
    )
    const core = await boot(home)
    const pushed: RunSummary[] = []
    core.bus.attach({
      name: 't',
      global: (ev) => {
        if (ev.kind === 'run-summary') pushed.push(ev.summary)
      },
    })
    const runId = value(
      await core.invoke('runs.start', {
        folder,
        task: 'add a --version flag',
        overrides: { profile: 'claude-only' },
      }),
    ).runId
    const mine = (): RunSummary[] => pushed.filter((s) => s.runId === runId)
    const planRunning = (s: RunSummary): boolean =>
      s.steps.some((st) => st.key === 'plan' && st.status === 'running')

    // While Plan runs within its estimate, the summary counts down to a stated end.
    await until('a counting-down summary while Plan runs', () =>
      mine().some(
        (s) => planRunning(s) && s.progress.etaState === 'ok' && s.progress.etaEndsAt !== undefined,
      ),
    )
    // Past 12 s, in the quiet sleep, the timer republishes it: "longer than usual" as a state, no countdown.
    await until(
      'a pushed "longer than usual" summary',
      () => mine().some((s) => planRunning(s) && s.progress.etaState === 'longer-than-usual'),
      45_000,
    )
    const late = mine().find((s) => s.progress.etaState === 'longer-than-usual')
    expect(late?.progress.etaMs).toBeUndefined()
    expect(late?.progress.etaEndsAt).toBeUndefined()
    // Plan is still in its quiet sleep (it never answered).
    expect(core.controller(runId)?.state.steps.plan.status).toBe('running')
    value(await core.invoke('runs.stop', { runId }))
  }, 180_000)

  it('a stopped run publishes its lock release, after which the folder is free per core', async () => {
    const sc = await makeScenario({ plan: { recording: 'C06-plan-native-host' } })
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await boot(home)
    const pushed: RunSummary[] = []
    core.bus.attach({
      name: 't',
      global: (ev) => {
        if (ev.kind === 'run-summary') pushed.push(ev.summary)
      },
    })
    const runId = value(
      await core.invoke('runs.start', {
        folder,
        task: 'add a --version flag',
        overrides: { profile: 'claude-only' },
      }),
    ).runId
    const mine = (): RunSummary[] => pushed.filter((s) => s.runId === runId)
    await until(
      'the plan gate',
      () => mine().some((s) => s.status === 'waiting' && s.lock === 'held'),
      90_000,
    )
    value(await core.invoke('runs.stop', { runId }))
    await until('the released lock published', () =>
      mine().some((s) => s.status === 'cancelled' && s.lock === undefined),
    )
    const live = value(await core.invoke('preflight.run', { folder, overrides: { profile: 'claude-only' } }))
    expect(live.info.find((c) => c.id === 'folder.lock')?.title).toBe('Folder availability')
  }, 180_000)

  it("dashboard.get carries git's check; config.resolve carries core's suggestions", async () => {
    const sc = await makeScenario({})
    const { home } = await makeHome(sc)
    const folder = makeSandbox()
    dirs.push(home, sc.dir, folder)
    const core = await boot(home)

    const dash = value(await core.invoke('dashboard.get'))
    const git = dash.appChecks?.find((c) => c.id === 'app.git')
    expect(git).toMatchObject({ scope: 'app', status: 'pass' })
    expect(git?.title).toMatch(/^Git \d+\.\d+/)

    value(await core.invoke('vendors.probe', { vendor: 'claude' }))
    const resolved = value(
      await core.invoke('config.resolve', { folder, overrides: { profile: 'claude-only' } }),
    )
    // Only Claude is ready (Codex is not in this build): no swap, no other Fix vendor; Fix reuses Implement's.
    expect(resolved.suggestions).toEqual({
      criticSwap: null,
      fixSession: { choice: 'reuse' },
      otherFixVendor: null,
    })
    const other = value(
      await core.invoke('config.resolve', {
        folder,
        overrides: { profile: 'claude-only', passes: { fix: { vendor: 'codex' } } },
      }),
    )
    // A Fix vendor override starts fresh even with reuseSession on: core says so, not "Reuse".
    expect(other.config.passes.fix.reuseSession).toBe(true)
    expect(other.suggestions?.fixSession).toEqual({ choice: 'fresh-other', reason: 'vendor-differs' })
  }, 120_000)
})
