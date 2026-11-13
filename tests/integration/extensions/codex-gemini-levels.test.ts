// Codex and Gemini Extensions levels through the real adapters and spawn paths, against the fakes (a temp CODEX_HOME
// and GEMINI_CLI_HOME, never ~/.codex or ~/.gemini).
// Codex: None switches every config.toml server off (any pass), Allowed list every one but the allowed ones, Pass
// through none (also on a read-only pass). Gemini: None names no server Gemini knows (none loads), Allowed list names
// the allowed ones, Pass through is today's launch; the names never reach the argv Dim Factory records.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StartOptions } from '../../../src/core/adapters/types.ts'
import { GEMINI_NO_MCP } from '../../../src/core/adapters/gemini/config.ts'
import * as codex from '../codex/adapter/helpers.ts'
import * as acp from '../acp/adapter/helpers.ts'

// ---- Codex ----------------------------------------------------------------------------------------------------------

const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e99'
const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }
const CONFIG =
  '[mcp_servers.zeta_srv]\ncommand = "z"\n[mcp_servers]\nomega-srv = { url = "http://127.0.0.1:1" }\n'

const turn = (sandbox: Record<string, unknown>, approvalPolicy: string): codex.Op[] => [
  { op: 'rpcExpect', method: 'initialize', kind: 'request', as: 'init' },
  {
    op: 'rpcResult',
    id: '$init',
    result: { userAgent: 'fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' },
  },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
  { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
  {
    op: 'rpcResult',
    id: '$ts',
    result: {
      thread: { id: THREAD },
      model: 'gpt-5.6-terra',
      modelProvider: 'openai',
      cwd: '/w',
      approvalPolicy,
      approvalsReviewer: 'user',
      sandbox,
    },
  },
  { op: 'rpcExpect', method: 'turn/start', as: 'tu', params: { threadId: THREAD } },
  { op: 'rpcResult', id: '$tu', result: { turn: { id: 'turn-1', status: 'inProgress' } } },
  {
    op: 'stdout',
    json: {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'turn-1', items: [], status: 'completed', error: null } },
    },
  },
  { op: 'expectEof' },
  { op: 'rpcDrained' },
  { op: 'exit', code: 0 },
]
const READONLY = turn({ type: 'readOnly', networkAccess: false }, 'never')
const EDIT = turn({ type: 'workspaceWrite', writableRoots: [], networkAccess: false }, 'on-request')

function codexHome(): string {
  const home = codex.tempDir('codex-ext-home-')
  writeFileSync(join(home, 'config.toml'), CONFIG)
  return home
}

async function codexPass(o: Partial<StartOptions>, script: codex.Op[]) {
  const setup = await codex.fakeSetup()
  const dir = codex.scenario([{ match: APP_SERVER, script }])
  const raw: string[] = []
  const fake = codex.fakeCodex(setup, dir, { adapter: { vendorEnv: { CODEX_HOME: codexHome() } } })
  const d = await codex.drive(fake.adapter, {
    runId: 'run-ext',
    step: 'review',
    cwd: codex.tempDir('codex-cwd-'),
    prompt: 'Go.',
    mode: 'readonly',
    planNative: false,
    allowRules: [],
    askTimeoutMs: 600_000,
    trustFolder: false,
    tap: (dir, line) => raw.push(`${dir} ${line}`),
    ...o,
  })
  const start = fake.stdinLines().find((m) => (m as { method?: string }).method === 'thread/start') as {
    params: { config?: Record<string, unknown> }
  }
  return { d, fake, raw, config: start.params.config }
}

describe('Codex', () => {
  it('Allowed list on Review: every server but the allowed one is off; no name reaches the raw log', async () => {
    const r = await codexPass({ extensions: { level: 'allowed', mcp: ['zeta_srv'], skills: [] } }, READONLY)
    expect(codex.eventsOf(r.d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(r.config).toEqual({
      'mcp_servers.omega-srv.enabled': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
    })
    expect(r.raw.some((l) => l.includes('zeta_srv') || l.includes('omega-srv'))).toBe(false)
  }, 60_000)

  it('Allowed list with codex_apps: the apps linked to the account stay on; plugins and hooks stay off', async () => {
    const r = await codexPass({ extensions: { level: 'allowed', mcp: ['codex_apps'], skills: [] } }, READONLY)
    expect(codex.eventsOf(r.d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(r.config).toEqual({
      'mcp_servers.zeta_srv.enabled': false,
      'mcp_servers.omega-srv.enabled': false,
      'features.plugins': false,
      'features.hooks': false,
    })
  }, 60_000)

  it('None on Implement: every server off', async () => {
    const r = await codexPass(
      { step: 'implement', mode: 'autoedit', extensions: { level: 'none', mcp: [], skills: [] } },
      EDIT,
    )
    expect(codex.eventsOf(r.d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(r.config).toEqual({
      'mcp_servers.zeta_srv.enabled': false,
      'mcp_servers.omega-srv.enabled': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
    })
  }, 60_000)

  it("Pass through on Review: nothing switched off (as Implement does today); None on Review is today's", async () => {
    const pass = await codexPass({ extensions: { level: 'passthrough', mcp: [], skills: [] } }, READONLY)
    expect(codex.eventsOf(pass.d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(pass.config).toBeUndefined()
    const none = await codexPass({ extensions: { level: 'none', mcp: [], skills: [] } }, READONLY)
    const legacy = await codexPass({}, READONLY)
    expect(none.config).toEqual(legacy.config)
    expect(none.config).toEqual({
      'mcp_servers.zeta_srv.enabled': false,
      'mcp_servers.omega-srv.enabled': false,
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
    })
  }, 90_000)
})

// ---- Gemini ---------------------------------------------------------------------------------------------------------

async function geminiReview(o: Partial<StartOptions>) {
  const setup = await acp.fakeSetup()
  const file = acp.recording({ scenario: 'review-ext' }, [
    ...acp.opening(),
    acp.inReq(3, 'session/set_mode', { sessionId: acp.SESSION, modeId: 'default' }),
    acp.outRes(3, {}),
    acp.inReq(4, 'session/prompt', { sessionId: acp.SESSION, prompt: [{ type: 'text', text: 'Review.' }] }),
    acp.chunk('Fine.'),
    acp.outRes(4, { stopReason: 'end_turn' }),
    acp.eof(),
    acp.exitFrame(0),
  ])
  const spawned: string[][] = []
  const fake = acp.fakeGemini(setup, acp.acpScenario(file), {
    vendorEnv: { FAKE_CLI_OUT_CWD: '1' },
    adapter: { onSpawn: (_o, child) => void spawned.push([...child.argv]) },
  })
  const d = await acp.drive(
    fake.adapter,
    acp.startOptions(acp.tempDir('gemini-cwd-'), {
      step: 'review',
      mode: 'readonly',
      prompt: 'Review.',
      ...o,
    }),
  )
  acp.expectNoMismatch(fake.logEntries())
  const argv = fake.starts().find((a) => a.includes('--acp')) ?? []
  return { d, argv, spawned, recorded: (d.handle as unknown as { argv: string[] }).argv }
}

describe('Gemini', () => {
  it('None: no MCP server may load (a name no settings define); session/new stays as it was', async () => {
    const r = await geminiReview({ extensions: { level: 'none', mcp: [], skills: [] } })
    expect(acp.eventsOf(r.d.entries).at(-1)).toMatchObject({ type: 'done' })
    const at = r.argv.indexOf('--allowed-mcp-server-names')
    expect(r.argv.slice(at, at + 2)).toEqual(['--allowed-mcp-server-names', GEMINI_NO_MCP])
  }, 60_000)

  it('Allowed list: only the allowed names, hidden in the argv Dim Factory records', async () => {
    const r = await geminiReview({ extensions: { level: 'allowed', mcp: ['zeta_srv', 'beta'], skills: [] } })
    expect(acp.eventsOf(r.d.entries).at(-1)).toMatchObject({ type: 'done' })
    const at = r.argv.indexOf('--allowed-mcp-server-names')
    expect(r.argv[at + 1]).toBe('zeta_srv,beta')
    for (const recorded of [r.recorded, ...r.spawned]) {
      expect(recorded.join(' ')).not.toMatch(/zeta_srv|beta/)
      expect(recorded).toContain('--allowed-mcp-server-names')
    }
  }, 60_000)

  it("Pass through: today's launch (no name filter)", async () => {
    const r = await geminiReview({ extensions: { level: 'passthrough', mcp: ['x'], skills: [] } })
    expect(acp.eventsOf(r.d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(r.argv).not.toContain('--allowed-mcp-server-names')
    const legacy = await geminiReview({})
    expect(legacy.argv).toEqual(r.argv)
  }, 90_000)
})
