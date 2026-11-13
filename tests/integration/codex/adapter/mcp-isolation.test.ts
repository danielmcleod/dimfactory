// Read-only Codex passes switch off the MCP servers of the user's config.toml (a temp CODEX_HOME here, never
// ~/.codex), through the real resolver and spawn path: the thread/start config (app-server) and the `-c` overrides
// (exec) name them, Implement does not, and the names never reach the raw log, the spawn record or a failure.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpawnHook } from '../../../../src/core/adapters/codex/run-base.ts'
import type { StartOptions } from '../../../../src/core/adapters/types.ts'
import type { Op } from './helpers.ts'
import {
  checkInvariants,
  drive,
  eventsOf,
  fakeCodex,
  fakeSetup,
  loadFixture,
  scenario,
  tempDir,
} from './helpers.ts'

const THREAD = '019a1c3e-5b2f-7c41-9d8e-0a1b2c3d4e99'
const APP_SERVER = { argvIncludes: ['app-server', '--listen'] }
const SERVERS = ['zeta_srv', 'omega-srv']
const CONFIG =
  '[mcp_servers.zeta_srv]\ncommand = "z"\n[mcp_servers]\nomega-srv = { url = "http://127.0.0.1:1" }\n'

const handshake: Op[] = [
  { op: 'rpcExpect', method: 'initialize', kind: 'request', as: 'init' },
  {
    op: 'rpcResult',
    id: '$init',
    result: { userAgent: 'fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' },
  },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
]

const threadResult = (sandbox: Record<string, unknown>, approvalPolicy: string) => ({
  thread: { id: THREAD },
  model: 'gpt-5.6-terra',
  modelProvider: 'openai',
  cwd: '/w',
  approvalPolicy,
  approvalsReviewer: 'user',
  sandbox,
})

const fullTurn = (sandbox: Record<string, unknown>, approvalPolicy: string): Op[] => [
  ...handshake,
  { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
  { op: 'rpcResult', id: '$ts', result: threadResult(sandbox, approvalPolicy) },
  { op: 'rpcExpect', method: 'turn/start', as: 'tu', params: { threadId: THREAD } },
  { op: 'rpcResult', id: '$tu', result: { turn: { id: 'turn-1', status: 'inProgress' } } },
  {
    op: 'stdout',
    json: {
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD, turnId: 'turn-1', itemId: 'm', delta: 'Done.' },
    },
  },
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

function codexHomeWith(toml: string): string {
  const home = tempDir('codex-mcp-home-')
  writeFileSync(join(home, 'config.toml'), toml)
  return home
}

const startOptions = (cwd: string, o: Partial<StartOptions>): StartOptions => ({
  runId: 'run-it',
  step: 'review',
  cwd,
  prompt: 'Review the change.',
  mode: 'readonly',
  planNative: false,
  allowRules: [],
  askTimeoutMs: 600_000,
  trustFolder: false,
  ...o,
})

/** Everything Dim Factory would write down for the pass: raw log lines, the spawn record, the events. */
function recorder() {
  const raw: string[] = []
  const spawned: string[][] = []
  const onSpawn: SpawnHook = (_o, child) => {
    spawned.push([...child.argv])
  }
  const tap = (dir: string, line: string): void => {
    raw.push(`${dir} ${line}`)
  }
  return { raw, spawned, onSpawn, tap }
}

/** The argv a Codex run handle reports (CodexRunBase.argv, after the binary's prefix args). */
const argvOf = (h: unknown): string[] => (h as { argv: string[] }).argv

const mentionsAny = (text: string): boolean => SERVERS.some((n) => text.includes(n))

describe('read-only passes switch the user MCP servers off', () => {
  it('app-server review: thread/start config names each server; the raw log and spawn record do not', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      { match: APP_SERVER, script: fullTurn({ type: 'readOnly', networkAccess: false }, 'never') },
    ])
    const rec = recorder()
    const fake = fakeCodex(setup, dir, {
      adapter: { onSpawn: rec.onSpawn, vendorEnv: { CODEX_HOME: codexHomeWith(CONFIG) } },
    })
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-'), { tap: rec.tap }))
    expect(fake.logEntries().filter((e) => e['kind'] === 'error')).toEqual([])
    checkInvariants(d, { readOnly: true })
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done', result: 'Done.' })
    const start = fake.stdinLines().find((m) => (m as { method?: string }).method === 'thread/start') as {
      params: { config?: Record<string, unknown> }
    }
    expect(start.params.config).toEqual({
      'mcp_servers.zeta_srv.enabled': false,
      'mcp_servers.omega-srv.enabled': false,
      // Codex's own apps, plugins and hooks, which config.toml does not name, are off by their feature switches.
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
    })
    // What Dim Factory keeps: the frame is in the raw log with the names hidden.
    const frame = rec.raw.find((l) => l.startsWith('in ') && l.includes('thread/start'))
    expect(frame).toContain('mcp_servers.[REDACTED].enabled')
    expect(rec.raw.some(mentionsAny)).toBe(false)
    expect(rec.spawned.flat().some(mentionsAny)).toBe(false)
    expect(argvOf(d.handle).some(mentionsAny)).toBe(false)
  }, 60_000)

  it('app-server implement: the user servers stay (no mcp_servers key sent)', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: fullTurn({ type: 'workspaceWrite', writableRoots: [], networkAccess: false }, 'on-request'),
      },
    ])
    const fake = fakeCodex(setup, dir, { adapter: { vendorEnv: { CODEX_HOME: codexHomeWith(CONFIG) } } })
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('codex-cwd-'), { step: 'implement', mode: 'autoedit' }),
    )
    expect(eventsOf(d.entries).at(-1)).toMatchObject({ type: 'done' })
    expect(JSON.stringify(fake.stdinLines())).not.toContain('mcp_servers')
  }, 60_000)

  it('a Codex error quoting a switched-off key reaches the failure with the name hidden', async () => {
    const setup = await fakeSetup()
    const dir = scenario([
      {
        match: APP_SERVER,
        script: [
          ...handshake,
          { op: 'rpcExpect', method: 'thread/start', as: 'ts' },
          {
            op: 'rpcError',
            id: '$ts',
            error: {
              code: -32600,
              message: 'failed to load configuration: invalid transport in `mcp_servers.zeta_srv`',
            },
          },
          { op: 'stderr', line: 'Error: invalid transport in `mcp_servers.omega-srv`' },
          { op: 'expectEof', ignoreLines: true },
          { op: 'exit', code: 1 },
        ],
      },
    ])
    const rec = recorder()
    const fake = fakeCodex(setup, dir, { adapter: { vendorEnv: { CODEX_HOME: codexHomeWith(CONFIG) } } })
    const d = await drive(fake.adapter, startOptions(tempDir('codex-cwd-'), { tap: rec.tap }))
    const last = eventsOf(d.entries).at(-1) as { type: string; message: string; raw: string }
    expect(last.type).toBe('error')
    expect(last.message).toContain('mcp_servers.[REDACTED]')
    expect(mentionsAny(`${last.message}\n${last.raw}`)).toBe(false)
    expect(rec.raw.some(mentionsAny)).toBe(false)
  }, 60_000)

  it('exec review: `-c mcp_servers.<name>.enabled=false` for each, hidden in the handle argv and spawn record', async () => {
    const setup = await fakeSetup()
    const e01 = loadFixture('exec', 'E01-review-readonly')
    const dir = scenario([{ match: { argvIncludes: ['exec', '--json'] }, script: e01.recording }])
    const rec = recorder()
    const fake = fakeCodex(setup, dir, {
      facts: { route: 'exec', planNative: false },
      adapter: { onSpawn: rec.onSpawn, vendorEnv: { CODEX_HOME: codexHomeWith(CONFIG) } },
    })
    const d = await drive(
      fake.adapter,
      startOptions(tempDir('codex-cwd-'), { prompt: e01.inMessages[0] as string, tap: rec.tap }),
    )
    expect(d.handle.route).toBe('exec')
    const argv = fake
      .logEntries()
      .filter((e) => e['kind'] === 'start')
      .map((e) => e['argv'] as string[])
      .find((a) => a.includes('exec')) as string[]
    for (const n of SERVERS) {
      const at = argv.indexOf(`mcp_servers.${n}.enabled=false`)
      expect(at, n).toBeGreaterThan(0)
      expect(argv[at - 1]).toBe('-c')
    }
    expect(argvOf(d.handle).filter((a) => a === 'mcp_servers.[REDACTED].enabled=false')).toHaveLength(2)
    expect(argvOf(d.handle).some(mentionsAny)).toBe(false)
    expect(rec.spawned.flat().some(mentionsAny)).toBe(false)
    expect(rec.raw.some(mentionsAny)).toBe(false)
  }, 60_000)
})
