// Through the real Gemini adapter ("read-only Review raises zero asks" at the engine level; the ACP base:
// initialize → session/new → session/set_mode → session/prompt, session/load for Fix with replayed
// updates dropped, read-only passes reject every permission request; Gemini launch "--skip-trust only with the
// vendorFolder grant"; the ACP session id comes "from the session/new response, before session/prompt"; trust.json): a real
// core, the fake Claude for Plan and Critic, and the real Gemini adapter (adapters/gemini on the ACP base) talking ACP
// to the fake CLI behind its npm-style shim (system node). The probe is a stand-in so nothing else is spawned, and
// Gemini's home is an empty temp folder (never ~/.gemini).
//   - the folder's vendorFolder grant reaches the adapter: every Gemini process runs `--acp --skip-trust`, and its
//     readiness `trust` check passes; without the grant the run does not start (the check's grant fixes that)
//   - Review on Gemini: both permission requests are answered `reject_once` by the adapter; the run raises zero asks
//   - Implement's ACP session (session/new) is what Fix loads (session/load), with the selected findings in its prompt
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { createGeminiAdapter } from '../../../../src/core/adapters/gemini/index.ts'
import type { Adapter } from '../../../../src/core/adapters/types.ts'
import type { ProbeResult } from '../../../../src/shared/vendors.ts'
import { readFakeLog } from '../../../fake-cli/harness.ts'
import { geminiProbe } from '../../../unit/gemini/engine/helpers.ts'
import { REVIEW_WITH_FINDINGS, cleanup, hermeticEnv } from '../../run/scenario.ts'
import { ScriptedGemini, World, asksIn, settled, value } from './helpers.ts'

const w = new World()
const dirs: string[] = []
afterEach(async () => {
  await w.dispose()
  cleanup(...dirs.splice(0))
})

const IMPL_SESSION = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const REVIEW_SESSION = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a'
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } },
  authMethods: [{ id: 'oauth-personal', name: 'Log in with Google', description: null }],
}
const MODES = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: 'Prompts for approval' },
    { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
    { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
    { id: 'plan', name: 'Plan', description: 'Read-only mode' },
  ],
}
const MODELS = {
  currentModelId: 'gemini-3-pro-preview',
  availableModels: [{ modelId: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)' }],
}
/** Gemini's options for a shell or edit confirmation (no permanent approval among them). */
const OPTIONS = [
  { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

type Op = Record<string, unknown>
const update = (sessionId: string, u: Record<string, unknown>): Op => ({
  op: 'rpcNotify',
  method: 'session/update',
  params: { sessionId, update: u },
})
const chunk = (sessionId: string, text: string): Op =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

const opening: Op[] = [
  { op: 'rpcProtocol', jsonrpc: '2.0' },
  {
    op: 'rpcExpect',
    method: 'initialize',
    as: 'init',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
  },
  { op: 'rpcResult', id: '$init', result: INITIALIZE_RESULT },
]
const setMode = (sessionId: string, modeId: string): Op[] => [
  { op: 'rpcExpect', method: 'session/set_mode', as: 'mode', params: { sessionId, modeId } },
  { op: 'rpcResult', id: '$mode', result: {} },
]
const ending = (text: string, sessionId: string): Op[] => [
  chunk(sessionId, text),
  { op: 'rpcResult', id: '$prompt', result: { stopReason: 'end_turn' } },
  { op: 'expectEof', timeoutMs: 20_000 },
  { op: 'exit', code: 0 },
]

/** Implement: session/new, the session id is the run's before the prompt, one edit, done. */
const implementOps: Op[] = [
  ...opening,
  { op: 'rpcExpect', method: 'session/new', as: 'new', params: { cwd: '<CWD>', mcpServers: [] } },
  { op: 'rpcResult', id: '$new', result: { sessionId: IMPL_SESSION, modes: MODES, models: MODELS } },
  ...setMode(IMPL_SESSION, 'autoEdit'),
  {
    op: 'rpcExpect',
    method: 'session/prompt',
    as: 'prompt',
    params: { sessionId: IMPL_SESSION, prompt: [{ type: 'text', text: { $regex: 'add a --version flag' } }] },
  },
  update(IMPL_SESSION, {
    sessionUpdate: 'tool_call',
    toolCallId: 'write-1',
    title: 'WriteFile src/version.ts',
    kind: 'edit',
    status: 'in_progress',
    locations: [{ path: 'src/version.ts' }],
  }),
  { op: 'writeFile', path: 'src/version.ts', content: 'export const version = "0.1.0"\n' },
  update(IMPL_SESSION, { sessionUpdate: 'tool_call_update', toolCallId: 'write-1', status: 'completed' }),
  ...ending('Added --version.', IMPL_SESSION),
]

/** Review (read-only): two permission requests, each preceded by its pending tool_call; findings as the answer. */
const permission = (n: number, kind: string, title: string): Op[] => [
  update(REVIEW_SESSION, {
    sessionUpdate: 'tool_call',
    toolCallId: `call-${n}`,
    title,
    kind,
    status: 'pending',
  }),
  {
    op: 'rpcRequest',
    method: 'session/request_permission',
    as: `perm${n}`,
    params: {
      sessionId: REVIEW_SESSION,
      toolCall: { toolCallId: `call-${n}`, title, kind, status: 'pending' },
      options: OPTIONS,
    },
  },
  {
    op: 'rpcExpectResponse',
    id: `$perm${n}`,
    result: { outcome: { outcome: 'selected', optionId: 'cancel' } },
  },
]
const reviewOps: Op[] = [
  ...opening,
  { op: 'rpcExpect', method: 'session/new', as: 'new', params: { cwd: '<CWD>', mcpServers: [] } },
  { op: 'rpcResult', id: '$new', result: { sessionId: REVIEW_SESSION, modes: MODES, models: MODELS } },
  ...setMode(REVIEW_SESSION, 'default'),
  { op: 'rpcExpect', method: 'session/prompt', as: 'prompt', params: { sessionId: REVIEW_SESSION } },
  ...permission(1, 'execute', 'npm test'),
  ...permission(2, 'edit', 'src/cli.ts'),
  ...ending(REVIEW_WITH_FINDINGS, REVIEW_SESSION),
]

/** Fix: session/load of Implement's session; the replayed history is dropped; the findings travel in the prompt. */
const fixOps: Op[] = [
  ...opening,
  {
    op: 'rpcExpect',
    method: 'session/load',
    as: 'load',
    params: { sessionId: IMPL_SESSION, cwd: '<CWD>', mcpServers: [] },
  },
  update(IMPL_SESSION, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'the earlier prompt' },
  }),
  chunk(IMPL_SESSION, 'REPLAYED HISTORY'),
  { op: 'rpcResult', id: '$load', result: { modes: MODES, models: MODELS } },
  ...setMode(IMPL_SESSION, 'autoEdit'),
  {
    op: 'rpcExpect',
    method: 'session/prompt',
    as: 'prompt',
    params: { sessionId: IMPL_SESSION, prompt: [{ type: 'text', text: { $regex: 'prints nothing' } }] },
  },
  { op: 'writeFile', path: 'src/version.test.ts', content: 'import "./version"\n' },
  ...ending('Fixed the findings.', IMPL_SESSION),
]

async function realGemini(home: string): Promise<{ adapter: Adapter; log: string }> {
  const root = join(dirname(home), 'gemini-real')
  const scenario = join(root, 'scenario')
  const geminiHome = join(root, 'gemini-home')
  const probeCwd = join(home, 'tmp', 'probe-cwd')
  for (const d of [scenario, geminiHome, probeCwd]) mkdirSync(d, { recursive: true })
  dirs.push(root)
  const scripts: Record<string, Op[]> = {
    version: [
      { op: 'stdout', line: '0.62.0' },
      { op: 'exit', code: 0 },
    ],
    implement: implementOps,
    review: reviewOps,
    fix: fixOps,
  }
  for (const [name, ops] of Object.entries(scripts)) {
    writeFileSync(join(scenario, `${name}.script.jsonl`), `${ops.map((x) => JSON.stringify(x)).join('\n')}\n`)
  }
  writeFileSync(
    join(scenario, 'scenario.json'),
    JSON.stringify([
      {
        match: { argvIncludes: ['--version'] },
        script: join(scenario, 'version.script.jsonl'),
        repeat: true,
      },
      ...['implement', 'review', 'fix'].map((name) => ({
        match: { argvIncludes: ['--acp'] },
        script: join(scenario, `${name}.script.jsonl`),
      })),
    ]),
  )
  const log = join(root, 'gemini.log.jsonl')
  const build = await buildFakeCli()
  const launcher = process.platform === 'win32' ? build.launchers.cmd?.gemini : build.launchers.sh?.gemini
  if (launcher === undefined) throw new Error('no fake gemini launcher')
  const real = createGeminiAdapter({
    configuredPath: launcher,
    search: 'configured',
    pathEnv: [build.dir, dirname(process.execPath)].join(delimiter),
    home: geminiHome,
    dimFactoryHome: home,
    probeCwd,
    env: hermeticEnv(),
    initialFacts: {
      probed: true,
      loadSession: true,
      resume: false,
      modes: MODES.availableModes.map((m) => m.id),
      plan: true,
    },
    vendorEnv: {
      FAKE_CLI_SCRIPT: scenario,
      FAKE_CLI_LOG: log,
      FAKE_CLI_STATE: join(root, 'state'),
      FAKE_CLI_TIMEOUT_MS: '30000',
      GEMINI_CLI_HOME: geminiHome,
    },
  })
  // The probe is a stand-in (no process); everything else is the real adapter.
  const adapter: Adapter = { ...real, probe: () => Promise.resolve(fresh()) }
  return { adapter, log }
}

function fresh(): ProbeResult {
  const at = Date.now()
  const p = geminiProbe()
  return { ...p, at, checks: p.checks.map((c) => ({ ...c, at })) }
}

describe('run through the real Gemini adapter (fake ACP agent)', () => {
  const OVERRIDES = {
    profile: 'claude-only',
    gates: { afterPlan: false },
    passes: {
      implement: { vendor: 'gemini', model: null },
      review: { vendor: 'gemini', model: null },
    },
  }

  it('Implement and Fix share the ACP session; the read-only Review raises zero asks; --skip-trust from the grant', async () => {
    // The core boots with its own Gemini; the test's is the real adapter on the fake.
    const t = await w.boot(
      { plan: { recording: 'C06-plan-native-host' } },
      new ScriptedGemini(() => undefined),
      {
        probe: false,
        trust: true,
      },
    )
    const { adapter, log } = await realGemini(t.home)
    t.core.adapters.register(adapter)
    t.core.preflight.recordProbe(fresh())

    const { runId, c } = await w.start(t, OVERRIDES)
    const done = await c.waitFor(settled, 150_000)
    await c.settle(10_000)

    const entries = readFakeLog(log)
    const errors = entries.filter((e) => e.kind === 'error')
    expect(errors, JSON.stringify(errors)).toEqual([])
    expect(done.status, JSON.stringify(done.steps.fix.failure ?? done.steps.review.failure ?? null)).toBe(
      'completed',
    )
    // Every Gemini process: `--acp --skip-trust` (the grant), never the prompt in argv.
    const argvs = entries
      .filter((e) => e.kind === 'start')
      .map((e) => e['argv'] as string[])
      .filter((a) => !a.includes('--version'))
    expect(argvs).toHaveLength(3)
    for (const a of argvs) {
      expect(a).toContain('--acp')
      expect(a).toContain('--skip-trust')
      expect(a.join(' ')).not.toContain('version flag')
    }

    // Implement on Gemini: the ACP session; Fix loads it ("reused the Implement session").
    expect(done.steps.implement).toMatchObject({ status: 'done', vendor: 'gemini', sessionId: IMPL_SESSION })
    expect(done.steps.fix).toMatchObject({
      status: 'done',
      vendor: 'gemini',
      sessionId: IMPL_SESSION,
      sessionNote: 'reused the Implement session',
    })
    // The history session/load replays never reached Fix's output.
    const fixText = t.events
      .map((e) => e.body)
      .filter((b) => b.t === 'ev' && b.step === 'fix' && b.ev.type === 'text')
      .map((b) => (b.t === 'ev' && b.ev.type === 'text' ? b.ev.delta : ''))
      .join('')
    expect(fixText).not.toContain('REPLAYED HISTORY')

    // Review: both requests rejected by the adapter itself; zero asks.
    expect(asksIn(t.events)).toEqual([])
    const snap = value(await t.core.invoke('runs.get', { runId }))
    expect(snap.steps.review.autoAnswered).toEqual({ approved: 0, denied: 2 })
    expect(done.steps.review).toMatchObject({ status: 'done', vendor: 'gemini' })
  }, 240_000)

  it('without the grant the run does not start; the readiness check names the grant that fixes it', async () => {
    const t = await w.boot(
      { plan: { recording: 'C06-plan-native-host' } },
      new ScriptedGemini(() => undefined),
      {
        probe: false,
      },
    )
    const { adapter, log } = await realGemini(t.home)
    t.core.adapters.register(adapter)
    t.core.preflight.recordProbe(fresh())

    const r = await t.core.invoke('runs.start', {
      folder: t.folder,
      task: 'add a --version flag',
      overrides: OVERRIDES,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('PREFLIGHT_BLOCKED')
    const report = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides: OVERRIDES }))
    const trust = report.blocking.find((x) => x.id === 'pass.implement.readiness.trust')
    expect(trust).toMatchObject({ category: 'trust_required' })
    const grant = trust?.recovery.find((a) => a.kind === 'grant')
    expect(grant).toMatchObject({ grant: 'vendorFolder', vendor: 'gemini' })

    value(await t.core.invoke('recovery.execute', { actionId: grant?.id ?? '', folder: t.folder }))
    const after = value(await t.core.invoke('preflight.run', { folder: t.folder, overrides: OVERRIDES }))
    expect(after.blocking.map((x) => x.id)).not.toContain('pass.implement.readiness.trust')
    // Nothing ran Gemini.
    expect(
      readFakeLog(log).filter((e) => e.kind === 'start' && !(e['argv'] as string[]).includes('--version')),
    ).toEqual([])
  }, 120_000)
})
