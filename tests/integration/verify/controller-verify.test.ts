// Verify controller effects (the runner steps): the trust check, the command grant and the round
// as RunController runs them, with an injected round runner (the real one is covered by verify-run.test.ts):
//   - the round gets the configured order, per-command timeouts, failFast and the scope root; its progress (a command
//     starting, finishing, new output) reaches the reducer; verifyFindings makes the [must]
//   - a round that throws opens verifyEnv ("Verify could not run: …")
//   - [Trust for this project] calls the grant with the body the card showed; a grant that fails skips the command
//   - Stop aborts the round's signal; the run is cancelled once the round has answered
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter, RunHandle } from '../../../src/core/adapters/types.ts'
import { EventBus } from '../../../src/core/bus/bus.ts'
import { resolveBuiltinConfig } from '../../../src/core/config/builtins.ts'
import { commandGrantHash } from '../../../src/core/config/trust.ts'
import type { Shadow, SnapshotRecord } from '../../../src/core/git/shadow.ts'
import { ensureHome, homePaths } from '../../../src/core/home.ts'
import { silentLogger } from '../../../src/core/log.ts'
import { ProcTable } from '../../../src/core/proc/proc-table.ts'
import { RunStore } from '../../../src/core/store/run-store.ts'
import { RunController } from '../../../src/core/supervisor/controller.ts'
import type { ControllerVerify, RunDoc } from '../../../src/core/supervisor/controller.ts'
import { toRunSummary } from '../../../src/core/supervisor/derive.ts'
import { systemClock } from '../../../src/core/supervisor/effects.ts'
import { initRunState, runConfigFromResolved } from '../../../src/core/supervisor/machine.ts'
import { FolderScheduler } from '../../../src/core/supervisor/scheduler.ts'
import type { RunState } from '../../../src/core/supervisor/types.ts'
import type { VerifyRoundOptions, VerifyRoundResult } from '../../../src/core/verify/index.ts'
import type { NormalizedEvent } from '../../../src/shared/events.ts'
import type { GrantCommand } from '../../../src/shared/failure.ts'
import type { TrustGrants } from '../../../src/shared/ipc.ts'
import type { VerifyCommandResult } from '../../../src/shared/verify.ts'

const dirs: string[] = []
const controllers: RunController[] = []
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function record(label: string): SnapshotRecord {
  return {
    label,
    tree: label === 'run-start' || label === 'S0' ? 't-base' : 't-changed',
    commit: `c-${label}`,
    at: Date.now(),
    unreadable: [],
    reused: false,
    ms: 1,
    warnings: [],
  }
}

/** A vendor pass that reports a session and `done` at once, then exits 0. */
function instantAdapter(): Adapter {
  let n = 0
  const start = (): RunHandle => {
    n++
    const events: NormalizedEvent[] = [
      { type: 'session', id: `s-${n}` },
      { type: 'done', result: 'implemented', usage: { input: 1, output: 1 } },
    ]
    let resolveExit: (v: { code: number; signal: null; sawTerminal: boolean; ranMs: number }) => void = () =>
      undefined
    const exited = new Promise<{ code: number; signal: null; sawTerminal: boolean; ranMs: number }>(
      (r) => (resolveExit = r),
    )
    return {
      id: `h-${n}`,
      vendor: 'claude',
      route: 'stdio',
      pid: undefined,
      onEvent: (cb: (e: NormalizedEvent) => void) => {
        setImmediate(() => {
          for (const e of events) cb(e)
          setImmediate(() => resolveExit({ code: 0, signal: null, sawTerminal: true, ranMs: 10 }))
        })
        return () => undefined
      },
      onSignal: () => () => undefined,
      sessionId: () => `s-${n}`,
      cumulativeUsage: () => undefined,
      pendingAsks: () => [],
      exited,
    } as unknown as RunHandle
  }
  return {
    id: 'claude',
    displayName: 'Claude',
    transport: 'claude-stdio',
    start,
    stop: () => Promise.resolve(),
    answer: () => undefined,
    canResume: () => Promise.resolve({ ok: true }),
  } as unknown as Adapter
}

const pass = (name: string, argv: string[]): VerifyCommandResult => ({
  name,
  argv,
  status: 'pass',
  exitCode: 0,
  durationMs: 10,
  excerpt: '',
  logPath: '',
})

interface Setup {
  c: RunController
  rounds: VerifyRoundOptions[]
  grants: GrantCommand[]
}

async function setup(
  verify: Omit<ControllerVerify, 'trustGrants'> & { trusted?: boolean },
  commands = [
    { name: 'typecheck', run: ['node', 'tc.mjs'], timeoutMs: 5000 },
    { name: 'test', run: ['node', 'test.mjs'] },
  ],
): Promise<Setup> {
  const home = mkdtempSync(join(tmpdir(), 'dim-run-controller-'))
  dirs.push(home)
  const paths = homePaths(home)
  await ensureHome(paths)
  const config = resolveBuiltinConfig({
    profile: 'claude-only',
    overrides: {
      gates: { afterPlan: false, beforeFix: false },
      passes: {
        plan: { enabled: false },
        review: { enabled: false },
        critic: { enabled: false },
        fix: { enabled: false },
      },
      verify: { enabled: true, commands, runAfter: ['implement'], failFast: true },
    },
  })
  const runId = '20261009T120000Z-vc01'
  const state: RunState = initRunState({
    runId,
    displayNo: 1,
    folder: home,
    folderKey: '0123456789abcdef',
    task: 'add a --version flag',
    profile: 'claude-only',
    createdAt: Date.now(),
    config: runConfigFromResolved(config, 'emulated'),
  })
  const scope = { folder: home, scopeRoot: home, lockKey: home, folderKey: '0123456789abcdef', isRepo: false }
  const doc: RunDoc = { runId, state, lastSeq: 0, scope, createdBy: 'cli' }
  const store = await RunStore.create<RunDoc>(paths, runId, doc, { log: silentLogger })
  const bus = new EventBus({ home: paths, log: silentLogger })
  await bus.openRun(runId, { createdAt: state.createdAt })
  const shadow = {
    snapshot: (_id: string, label: string): Promise<SnapshotRecord> => Promise.resolve(record(label)),
    liveChanged: () => Promise.resolve(null),
    treeNow: () => Promise.resolve({ tree: 't-changed' }),
  } as unknown as Shadow
  const rounds: VerifyRoundOptions[] = []
  const grants: GrantCommand[] = []
  const trusted: TrustGrants =
    verify.trusted === false
      ? {}
      : {
          commands: Object.fromEntries(
            commands.map((x) => [
              commandGrantHash({ kind: 'verify', argv: x.run, cwdRel: '.' }),
              { kind: 'verify' as const, argv: x.run, cwdRel: '.', at: 1 },
            ]),
          ),
        }
  const { trusted: _t, runRound, grant, ...rest } = verify
  const c = new RunController(state, {
    paths,
    bus,
    store,
    config,
    scope,
    createdBy: 'cli',
    adapters: { get: () => instantAdapter() },
    preflight: (mode) => Promise.resolve({ mode, ok: true, blocking: [], warnings: [], info: [] }),
    scheduler: new FolderScheduler(),
    summarize: (s) => toRunSummary(s),
    clock: systemClock(),
    log: silentLogger,
    shadow: () => Promise.resolve(shadow),
    procTable: await ProcTable.open(paths.run(runId).procsJson),
    verify: {
      ...rest,
      trustGrants: () => Promise.resolve(trusted),
      grant: async (folder, cmd) => {
        grants.push(cmd)
        await grant?.(folder, cmd)
      },
      runRound: async (deps, o) => {
        rounds.push(o)
        if (runRound === undefined) throw new Error('no round runner')
        return runRound(deps, o)
      },
    },
  })
  controllers.push(c)
  await c.enqueue({ t: 'created' })
  return { c, rounds, grants }
}

describe('RunController verify effects', () => {
  it('runs the round with the configured order, timeouts, failFast and scope; progress and findings land', async () => {
    const t = await setup({
      runRound: (_deps, o): Promise<VerifyRoundResult> => {
        const tc: VerifyCommandResult = {
          name: 'typecheck',
          argv: ['node', 'tc.mjs'],
          status: 'fail',
          exitCode: 2,
          durationMs: 1200,
          excerpt: 'error TS2322',
          logPath: '',
        }
        o.onOutput?.({ type: 'start', index: 0, name: 'typecheck', argv: ['node', 'tc.mjs'] })
        o.onOutput?.({ type: 'line', index: 0, name: 'typecheck', stream: 'stdout', line: 'error TS2322' })
        o.onOutput?.({ type: 'end', index: 0, result: tc })
        const skipped: VerifyCommandResult = {
          ...pass('test', ['node', 'test.mjs']),
          status: 'skipped',
          durationMs: 0,
          reason: 'Not run: failFast stopped the round after typecheck failed',
        }
        return Promise.resolve({ results: [tc, skipped], aborted: true, logDir: '', outputLog: '' })
      },
    })
    const done = await t.c.waitFor((s) => s.outcome !== undefined, 20_000)
    expect(t.rounds).toHaveLength(1)
    const o = t.rounds[0]
    expect(o).toMatchObject({ round: 'verify:1', failFast: true, folder: o?.scopeRoot })
    expect(o?.commands).toEqual([
      { name: 'typecheck', argv: ['node', 'tc.mjs'], cwdRel: '.', run: true, timeoutMs: 5000 },
      { name: 'test', argv: ['node', 'test.mjs'], cwdRel: '.', run: true },
    ])
    expect(done.steps['verify:1'].verify).toMatchObject({ phase: 'done', aborted: true })
    expect(done.steps['verify:1'].verify?.commands.map((x) => x.status)).toEqual(['fail', 'skipped'])
    // verifyFindings: the [must] reaches the join (Fix is off here: findings-open).
    expect(done.outcome).toBe('findings-open')
    expect(done.findings?.list).toEqual([
      expect.objectContaining({
        source: 'verify',
        severity: 'must',
        title: '`node tc.mjs` failed (exit 2, 1s)',
      }),
    ])
    expect(done.outputs['verify:1']).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('a round that throws opens verifyEnv with the reason', async () => {
    const t = await setup({ runRound: () => Promise.reject(new Error('cmd.exe is missing')) })
    const s = await t.c.waitFor((x) => x.cards.some((c) => c.view.kind === 'verifyEnv'), 20_000)
    const card = s.cards.find((c) => c.view.kind === 'verifyEnv')
    expect(card?.view.body).toContain('Verify could not run: cmd.exe is missing')
    expect(s.steps['verify:1']).toMatchObject({ status: 'waiting', reason: 'checks could not run' })
  }, 30_000)

  it('[Trust for this project] grants the command with the body shown; a failing grant skips it', async () => {
    let fail = false
    const t = await setup({
      trusted: false,
      grant: () => (fail ? Promise.reject(new Error('trust.json is read-only')) : Promise.resolve()),
      runRound: (_d, o) =>
        Promise.resolve({
          results: o.commands.map((x) =>
            x.run === false
              ? {
                  ...pass(x.name, [...(x.argv ?? [])]),
                  status: x.status ?? 'skipped',
                  durationMs: 0,
                  ...(x.reason !== undefined ? { reason: x.reason } : {}),
                }
              : pass(x.name, [...(x.argv ?? [])]),
          ),
          logDir: '',
          outputLog: '',
        }),
    })
    const asking = await t.c.waitFor(
      (s) => s.cards.filter((c) => c.view.kind === 'trust').length === 2,
      20_000,
    )
    const [first, second] = asking.cards.filter((c) => c.view.kind === 'trust')
    expect(await t.c.command({ kind: 'card', cardId: first?.view.id ?? '', choiceId: 'trust' })).toEqual({
      ok: true,
      value: undefined,
    })
    await t.c.waitFor((s) => s.steps['verify:1'].verify?.commands[0]?.decision === 'run', 10_000)
    expect(t.grants).toEqual([{ kind: 'verify', argv: ['node', 'tc.mjs'], cwdRel: '.' }])
    fail = true
    await t.c.command({ kind: 'card', cardId: second?.view.id ?? '', choiceId: 'trust' })
    const done = await t.c.waitFor((s) => s.outcome !== undefined, 20_000)
    expect(t.rounds[0]?.commands.map((x) => [x.name, x.run])).toEqual([
      ['typecheck', true],
      ['test', false],
    ])
    expect(done.steps['verify:1'].verify?.commands[1]).toMatchObject({
      status: 'skipped',
      reason: 'Dim Factory could not save the trust for it: trust.json is read-only',
    })
  }, 30_000)

  it('Stop aborts the round; the run is cancelled once it has answered', async () => {
    let aborted = false
    const t = await setup({
      runRound: (_d, o) =>
        new Promise((resolve) => {
          o.onOutput?.({ type: 'start', index: 0, name: 'typecheck', argv: ['node', 'tc.mjs'] })
          o.signal?.addEventListener('abort', () => {
            aborted = true
            resolve({
              results: o.commands.map((x) => ({
                ...pass(x.name, [...(x.argv ?? [])]),
                status: 'skipped' as const,
                reason: 'Stopped before it finished',
              })),
              stopped: true,
              logDir: '',
              outputLog: '',
            })
          })
        }),
    })
    await t.c.waitFor((s) => s.steps['verify:1'].verify?.commands[0]?.status === 'running', 20_000)
    expect(t.c.state.phase).toBe('verifying')
    await t.c.command({ kind: 'stop' })
    const done = await t.c.waitFor((s) => s.status === 'cancelled' && s.lock === 'none', 20_000)
    expect(aborted).toBe(true)
    expect(done.steps['verify:1'].status).toBe('cancelled')
  }, 30_000)
})
