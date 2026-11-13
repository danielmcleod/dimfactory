// The balanced run through the real Codex adapter ("balanced end to end … Fix resumes the Codex thread"; Codex
// "thread/start … thread.id is persisted from the response before turn/start", "Resume: thread/resume
// {threadId, excludeTurns:true, …}, then assert the echoed id matches", prompts over JSON-RPC only; sessions):
// a real core, the fake Claude for Plan/Review/Critic, and the real Codex adapter (adapters/codex) talking JSON-RPC to
// the fake CLI as a private `codex app-server --listen stdio://` per pass (scripted with the fake's rpc* ops; the
// probe is a stand-in so nothing else is spawned, and the machine's own `codex` is never started).
//   - Implement: thread/start with the autoedit safety set (workspace-write, on-request, reviewer user, not
//     ephemeral); the thread id is in run.json on disk when the adapter goes on to turn/start
//   - Fix: canResume finds the thread's rollout, so Fix sends thread/resume for the same id (echoed), with the
//     safety set again, then turn/start with the selected findings; its usage is the delta against Implement's
//   - argv never carries the prompt: every Codex process is `app-server --listen stdio://`
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../../src/core/app-core.ts'
import { createCodexAdapter } from '../../../../src/core/adapters/codex/index.ts'
import type { Adapter, StartOptions } from '../../../../src/core/adapters/types.ts'
import type { ProbeResult } from '../../../../src/shared/vendors.ts'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { readFakeLog } from '../../../fake-cli/harness.ts'
import { codexProbe } from '../../../unit/balanced/engine/helpers.ts'
import { REVIEW_WITH_FINDINGS, cleanup, hermeticEnv } from '../../run/scenario.ts'
import { ScriptedCodex, World, runJsonOnDisk, settled } from './helpers.ts'

const w = new World()
const dirs: string[] = []
afterEach(async () => {
  await w.dispose()
  cleanup(...dirs.splice(0))
})

/** A UUIDv7 thread id created now (canResume finds its rollout by the time it carries). */
function threadIdNow(ms = Date.now()): string {
  const hex = ms.toString(16).padStart(12, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`
}

/** The rollout Codex keeps for a thread it can resume (sessions/YYYY/MM/DD/rollout-…-<id>.jsonl). */
function writeRollout(codexHome: string, id: string, ms = Date.now()): void {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const dir = join(codexHome, 'sessions', String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `rollout-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00-00-00-${id}.jsonl`),
    '',
  )
}

const usage = (input: number, cached: number, output: number, reasoning: number) => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
  totalTokens: input + output,
})

const SAFETY = { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }
const THREAD_REPLY = (id: string) => ({
  thread: { id },
  model: 'gpt-5.6-sol',
  sandbox: { type: 'workspaceWrite' },
  approvalsReviewer: 'user',
})

/** One app-server pass: the handshake, the thread request given, one turn writing `file`, cumulative `total`. */
function appServerPass(o: {
  thread: object
  threadId: string
  turnId: string
  file: string
  text: string
  total: ReturnType<typeof usage>
}): object[] {
  const n = (method: string, params: object): object => ({ op: 'stdout', json: { method, params } })
  return [
    { op: 'rpcExpect', method: 'initialize', as: 'init', params: { clientInfo: { name: 'dim-factory' } } },
    { op: 'rpcResult', id: '$init', result: { userAgent: 'codex_cli_rs/0.160.1' } },
    { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
    o.thread,
    { op: 'rpcResult', id: '$thr', result: THREAD_REPLY(o.threadId) },
    {
      op: 'rpcExpect',
      method: 'turn/start',
      as: 'turn',
      params: { threadId: o.threadId, input: [{ type: 'text', text: '$prompt' }] },
    },
    { op: 'rpcResult', id: '$turn', result: { turn: { id: o.turnId, status: 'inProgress', items: [] } } },
    n('turn/started', { threadId: o.threadId, turn: { id: o.turnId, status: 'inProgress', items: [] } }),
    { op: 'writeFile', path: o.file, content: `// ${o.turnId}\n` },
    n('item/agentMessage/delta', { threadId: o.threadId, turnId: o.turnId, itemId: 'msg_1', delta: o.text }),
    n('thread/tokenUsage/updated', {
      threadId: o.threadId,
      turnId: o.turnId,
      tokenUsage: { total: o.total, last: o.total, modelContextWindow: 272000 },
    }),
    n('turn/completed', { threadId: o.threadId, turn: { id: o.turnId, status: 'completed', items: [] } }),
    { op: 'expectEof', timeoutMs: 20_000 },
    { op: 'exit', code: 0 },
  ]
}

describe('balanced run through the real Codex adapter (fake app-server)', () => {
  it('Implement: thread id durable before turn/start; Fix: thread/resume of the same id, echoed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-'))
    dirs.push(root)
    const codexHome = join(root, 'codex-home')
    const scenario = join(root, 'codex-scenario')
    mkdirSync(scenario, { recursive: true })
    const thread = threadIdNow()
    writeRollout(codexHome, thread)

    const implTotal = usage(12_000, 30_000, 1_500, 400)
    const fixTotal = usage(19_000, 52_000, 2_100, 700)
    const implement = appServerPass({
      thread: {
        op: 'rpcExpect',
        method: 'thread/start',
        as: 'thr',
        params: { ...SAFETY, ephemeral: false, cwd: '$_', threadId: { $absent: true } },
      },
      threadId: thread,
      turnId: 'turn_impl',
      file: 'src/version.ts',
      text: 'Added --version.',
      total: implTotal,
    })
    const fix = appServerPass({
      thread: {
        op: 'rpcExpect',
        method: 'thread/resume',
        as: 'thr',
        params: { ...SAFETY, threadId: thread, excludeTurns: true },
      },
      threadId: thread,
      turnId: 'turn_fix',
      file: 'src/version.test.ts',
      text: 'Fixed the findings.',
      total: fixTotal,
    })
    const scripts = { implement, fix }
    for (const [name, ops] of Object.entries(scripts)) {
      writeFileSync(
        join(scenario, `${name}.script.jsonl`),
        `${ops.map((x) => JSON.stringify(x)).join('\n')}\n`,
      )
    }
    // The resolver checks the binary with `--version` (token-free).
    writeFileSync(
      join(scenario, 'version.script.jsonl'),
      `${JSON.stringify({ op: 'stdout', line: 'codex-cli 0.160.1' })}
${JSON.stringify({ op: 'exit', code: 0 })}
`,
    )
    writeFileSync(
      join(scenario, 'scenario.json'),
      JSON.stringify([
        {
          match: { argvIncludes: ['--version'] },
          script: join(scenario, 'version.script.jsonl'),
          repeat: true,
        },
        ...Object.keys(scripts).map((name) => ({
          match: { argvIncludes: ['app-server', '--listen', 'stdio://'] },
          script: join(scenario, `${name}.script.jsonl`),
        })),
      ]),
    )
    const log = join(root, 'codex.log.jsonl')
    const build = await buildFakeCli()
    const fakeCodex = process.platform === 'win32' ? build.launchers.cmd?.codex : build.launchers.sh?.codex
    if (fakeCodex === undefined) throw new Error('no fake codex launcher')

    // The core boots with its own Codex; the test's is the real adapter on the fake, with a stand-in probe.
    const t = await w.boot(
      {
        plan: { recording: 'C06-plan-native-host' },
        review: [{ recording: 'C02-review-shape', text: REVIEW_WITH_FINDINGS }],
      },
      new ScriptedCodex(() => undefined),
      { probe: false },
    )
    let core: Core | undefined = t.core
    const real = createCodexAdapter({
      configuredPath: fakeCodex,
      vendorEnv: {
        FAKE_CLI_SCRIPT: scenario,
        FAKE_CLI_LOG: log,
        FAKE_CLI_STATE: join(root, 'codex-state'),
        FAKE_CLI_TIMEOUT_MS: '30000',
        CODEX_HOME: codexHome,
      },
      env: hermeticEnv(),
      probeCwd: join(root, 'probe-cwd'),
      tmpDir: join(root, 'tmp'),
      initialFacts: { route: 'app-server', winSandbox: 'ready', tokenUsage: true },
      onSpawn: (so, child) => core?.controller(so.runId)?.onChildSpawned(so, child),
    })
    const persistedAtTurn: (string | undefined)[] = []
    const fresh = (): ProbeResult => {
      const at = Date.now()
      const p = codexProbe({ sandbox: 'ready' })
      return { ...p, at, checks: p.checks.map((c) => ({ ...c, at })) }
    }
    const wrapped: Adapter = {
      ...real,
      probe: () => Promise.resolve(fresh()),
      readiness: () => Promise.resolve([]),
      start: (o: StartOptions) => {
        const hook = o.onSession
        return real.start({
          ...o,
          ...(hook !== undefined
            ? {
                onSession: async (id: string) => {
                  const recorded = await hook(id)
                  // The adapter sends turn/start only after this resolves, and only when the id is durable.
                  if (o.step === 'implement') {
                    expect(recorded).toEqual({ ok: true })
                    persistedAtTurn.push(runJsonOnDisk(t.home, o.runId).steps.implement.sessionId)
                  }
                  return recorded
                },
              }
            : {}),
        })
      },
    }
    delete (wrapped as { recheckAuth?: unknown }).recheckAuth
    t.core.adapters.register(wrapped)
    t.core.preflight.recordProbe(fresh())

    const { runId, c } = await w.start(t, { profile: 'balanced', gates: { afterPlan: false } })
    const done = await c.waitFor(settled, 150_000)
    await c.settle(10_000)
    core = undefined

    const entries = readFakeLog(log)
    const errors = entries.filter((e) => e.kind === 'error')
    expect(errors, JSON.stringify(errors)).toEqual([])
    expect(done.status).toBe('completed')
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'codex', sessionId: thread })
    expect(persistedAtTurn).toEqual([thread])
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      vendor: 'codex',
      sessionId: thread,
      sessionNote: 'reused the Implement session',
    })
    // Both Codex processes: `app-server --listen stdio://` only (no prompt, no --ephemeral in argv).
    const argvs = entries
      .filter((e) => e.kind === 'start')
      .map((e) => e['argv'] as string[])
      .filter((a) => !a.includes('--version'))
    expect(argvs).toEqual([
      ['app-server', '--listen', 'stdio://'],
      ['app-server', '--listen', 'stdio://'],
    ])
    // The order on the wire: thread/start before turn/start; then thread/resume before Fix's turn/start.
    const rpc = entries.filter((e) => e.kind === 'rpc').map((e) => e['method'])
    expect(rpc).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'initialize',
      'initialized',
      'thread/resume',
      'turn/start',
    ])
    // Fix's own usage: the delta against Implement's cumulative totals.
    expect(done.steps.fix.usage?.output).toBe(fixTotal.outputTokens - implTotal.outputTokens)
    expect(done.steps.implement.cost?.basis).toBe('catalog')
    expect(runId).toBe(done.runId)
  }, 240_000)
})
