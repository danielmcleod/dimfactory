// Outside agents through a real core (temp home, fake Claude): access is off until turned on; an MCP client with the
// token reads runs, folders, estimates, plans, findings, diffs and logs, with folder and diff-path checks and caps;
// request_run records a pending request and spawns nothing until the user approves it, approving runs it on the fake
// Claude, declining drops it. The stdio bridge relays a client's lines with no token in its configuration and says
// what to do when access is off.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { Core } from '../../../src/core/app-core.ts'
import { createCore } from '../../../src/core/app-core.ts'
import { runMcpBridge } from '../../../src/core/mcp/bridge.ts'
import type { AppEvent, ExternalMcpView, McpRunRequest } from '../../../src/shared/ipc.ts'
import { cleanup, hermeticEnv, makeHome, makeSandbox, makeScenario, passArgvs } from '../run/scenario.ts'
import { freePort } from '../../free-port.ts'

const cores: Core[] = []
const dirs: string[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  for (const c of cores.splice(0)) await c.shutdown()
  cleanup(...dirs.splice(0))
})

const BRIDGE = { command: 'C:\\Dim Factory\\Dim Factory.exe', args: ['--mcp'] }

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  // The SDK's own types disagree with exactOptionalPropertyTypes (sessionId?: string).
  await client.connect(transport as unknown as Parameters<Client['connect']>[0])
  clients.push(client)
  return client
}

type ToolAnswer = { isError?: boolean; content: { type: string; text: string }[] }

async function tool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  return (await client.callTool({ name, arguments: args })) as ToolAnswer
}
const text = (a: ToolAnswer): string => a.content.map((c) => c.text).join('')
const json = <T = Record<string, unknown>>(a: ToolAnswer): T => JSON.parse(text(a)) as T

async function start(): Promise<{
  core: Core
  folder: string
  home: string
  entries: () => string[][]
  events: AppEvent[]
}> {
  const sc = await makeScenario({
    plan: { recording: 'C06-plan-native-host' },
    implement: [
      { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
    ],
  })
  const { home } = await makeHome(sc)
  const folder = makeSandbox()
  dirs.push(home, sc.dir, folder)
  // No plan gate: an approved request runs straight through.
  const cfgFile = join(home, 'dimfactory.json')
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as Record<string, unknown>
  writeFileSync(
    cfgFile,
    JSON.stringify({ ...cfg, profile: 'claude-only', gates: { afterPlan: false } }, null, 2),
  )
  const core = await createCore({ home, host: { kind: 'app' }, env: hermeticEnv() })
  cores.push(core)
  const events: AppEvent[] = []
  core.bus.attach({ name: 'test', global: (ev) => events.push(ev) })
  return { core, folder, home, entries: () => passArgvs(sc.entries()), events }
}

async function enable(core: Core): Promise<{ url: string; token: string; view: ExternalMcpView }> {
  const on = await core.invoke('mcp.external.set', { enabled: true, port: await freePort() })
  if (!on.ok) throw new Error(on.error.message)
  const { url, token } = on.value
  if (url === null || token === null) throw new Error(`not listening: ${on.value.error}`)
  return { url, token, view: on.value }
}

describe('outside agents through the core', () => {
  it('is off by default; turning it on makes a token kept in state.json; a wrong token gets nothing', async () => {
    const { core, home } = await start()
    const off = await core.invoke('mcp.external.get')
    expect(off.ok && off.value).toMatchObject({
      enabled: false,
      running: false,
      url: null,
      token: null,
      port: 47821,
    })
    const { url, token, view } = await enable(core)
    expect(view.running).toBe(true)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/dim-factory$/)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as Record<string, unknown>
    expect(state['externalMcp']).toEqual({ enabled: true, port: view.port, token })
    await expect(connect(url, 'wrong-token')).rejects.toThrow()

    // A new token: the old one stops working at once.
    const fresh = await core.invoke('mcp.external.set', { regenerate: true })
    if (!fresh.ok || fresh.value.token === null || fresh.value.url === null) throw new Error('no token')
    expect(fresh.value.token).not.toBe(token)
    await expect(connect(fresh.value.url, token)).rejects.toThrow()
    const client = await connect(fresh.value.url, fresh.value.token)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'get_diff',
      'get_estimate',
      'get_findings',
      'get_log',
      'get_plan',
      'get_request_status',
      'get_run',
      'list_folders',
      'list_runs',
      'request_run',
    ])
    const tools = (await client.listTools()).tools
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(t.name !== 'request_run')
      expect(t.annotations?.destructiveHint, t.name).toBe(false)
    }
    expect(
      (await core.invoke('mcp.external.get')).ok && (await core.invoke('mcp.external.get')),
    ).toMatchObject({
      value: { lastCall: expect.any(Number) as number },
    })

    // Off: the endpoint goes away, the token stays for next time.
    const offAgain = await core.invoke('mcp.external.set', { enabled: false })
    expect(offAgain.ok && offAgain.value).toMatchObject({ enabled: false, running: false, url: null })
    await expect(connect(fresh.value.url, fresh.value.token)).rejects.toThrow()
  })

  it('reports a port in use without throwing', async () => {
    const { core } = await start()
    const { view } = await enable(core)
    const other = await createCore({
      home: join(dirs[0] ?? '', '..', 'other-home'),
      host: { kind: 'app' },
      env: hermeticEnv(),
    })
    cores.push(other)
    const r = await other.invoke('mcp.external.set', { enabled: true, port: view.port })
    expect(r.ok && r.value).toMatchObject({
      enabled: true,
      running: false,
      error: `Port ${view.port} is in use by another program. Pick another port.`,
    })
  })

  it('a request spawns nothing until approved; approving runs it; agents read the run; declining drops one', async () => {
    const { core, folder, entries, events } = await start()
    const { url, token } = await enable(core)
    const client = await connect(url, token)

    // Folder checks: relative, missing, guarded (the user's home, Dim Factory's own home).
    for (const bad of ['relative/path', join(folder, 'nope'), homedir(), core.paths.home]) {
      const r = await tool(client, 'request_run', { folder: bad, task: 'x' })
      expect(r.isError, bad).toBe(true)
    }
    expect((await tool(client, 'request_run', { folder, task: 'x', profile: 'no-such' })).isError).toBe(true)
    expect((await tool(client, 'get_estimate', { folder: 'relative' })).isError).toBe(true)

    const est = json<{ steps: Record<string, unknown> }>(await tool(client, 'get_estimate', { folder }))
    expect(Object.keys(est.steps)).toContain('implement')

    const asked = json<{ requestId: string; status: string }>(
      await tool(client, 'request_run', {
        folder,
        task: 'add a --version flag',
        notes: 'The user asked for it in chat.',
      }),
    )
    expect(asked.status).toBe('pending_approval')
    // The same request again answers the one waiting.
    expect(
      json(await tool(client, 'request_run', { folder, task: 'add a --version flag' }))['requestId'],
    ).toBe(asked.requestId)
    expect(json(await tool(client, 'get_request_status', { requestId: asked.requestId }))['status']).toBe(
      'pending_approval',
    )

    const pending = await core.invoke('mcp.requests.list')
    expect(pending.ok && pending.value).toEqual([
      expect.objectContaining({
        id: asked.requestId,
        folder,
        task: 'add a --version flag',
        notes: 'The user asked for it in chat.',
        requestedBy: 'test-agent 1.0.0',
        status: 'pending',
      }) as McpRunRequest,
    ])
    const announced = events.filter((e) => e.kind === 'mcp-requests')
    expect(announced.at(-1)).toMatchObject({ requests: [{ id: asked.requestId }] })
    // Nothing ran.
    expect(entries()).toEqual([])
    const runs = await core.invoke('runs.list', {})
    expect(runs.ok && runs.value.items).toEqual([])

    // A second request, declined.
    const other = json<{ requestId: string }>(
      await tool(client, 'request_run', { folder, task: 'something else' }),
    )
    expect((await core.invoke('mcp.requests.decline', { id: other.requestId })).ok).toBe(true)
    expect(json(await tool(client, 'get_request_status', { requestId: other.requestId }))['status']).toBe(
      'declined',
    )
    const again = await core.invoke('mcp.requests.approve', { id: other.requestId })
    expect(again.ok ? null : again.error.code).toBe('CONFLICT')

    // Approve: the run starts through runs.start and runs on the fake Claude.
    const approved = await core.invoke('mcp.requests.approve', { id: asked.requestId })
    if (!approved.ok) throw new Error(approved.error.message)
    const runId = approved.value.runId
    const c = core.controller(runId)
    if (c === undefined) throw new Error('no controller')
    const done = await c.waitFor((s) => s.status === 'completed' || s.status === 'failed', 90_000)
    expect(done.status).toBe('completed')
    expect(entries().length).toBeGreaterThan(0)
    const status = json(await tool(client, 'get_request_status', { requestId: asked.requestId }))
    expect(status).toMatchObject({ status: 'approved', runId, runNumber: approved.value.displayNo })
    const left = await core.invoke('mcp.requests.list')
    expect(left.ok && left.value).toEqual([])

    // Reads.
    const list = json<{ runs: { runId: string; status: string }[] }>(
      await tool(client, 'list_runs', { limit: 5 }),
    )
    expect(list.runs.map((r) => r.runId)).toEqual([runId])
    const byStatus = json<{ runs: unknown[] }>(await tool(client, 'list_runs', { status: ['failed'] }))
    expect(byStatus.runs).toEqual([])
    const run = json<Record<string, unknown>>(await tool(client, 'get_run', { runId }))
    expect(run).toMatchObject({ runId, status: 'completed', task: 'add a --version flag', folder })
    expect((run['steps'] as { pass: string }[]).map((s) => s.pass)).toContain('implement')
    expect((await tool(client, 'get_run', { runId: '../../etc' })).isError).toBe(true)
    expect(text(await tool(client, 'get_plan', { runId })).length).toBeGreaterThan(0)
    expect(json(await tool(client, 'get_findings', { runId }))).toHaveProperty('findings')
    const files = json<{ files: { path: string }[] }>(await tool(client, 'get_diff', { runId }))
    expect(files.files.map((f) => f.path)).toContain('src/version.ts')
    const patch = json<{ patch: string; truncated: boolean }>(
      await tool(client, 'get_diff', { runId, path: 'src/version.ts' }),
    )
    expect(patch.patch).toContain('+x')
    // Only the run's own files.
    for (const p of ['package.json', '../outside.txt', join(folder, 'src', 'version.ts')]) {
      expect((await tool(client, 'get_diff', { runId, path: p })).isError, p).toBe(true)
    }
    const log = text(await tool(client, 'get_log', { runId, limit: 20 }))
    expect(log.split('\n').length).toBeLessThanOrEqual(20)
    expect(log).toContain('run completed')
    const folders = json<{ folders: { folder: string }[] }>(await tool(client, 'list_folders'))
    expect(folders.folders.map((f) => f.folder)).toContain(folder)
  }, 180_000)

  it('keeps a request pending when the preflight blocks its run', async () => {
    const { core, folder, entries } = await start()
    const { url, token } = await enable(core)
    const client = await connect(url, token)
    const asked = json<{ requestId: string }>(
      await tool(client, 'request_run', { folder, task: 'x', profile: 'codex-only' }),
    )
    const r = await core.invoke('mcp.requests.approve', { id: asked.requestId })
    expect(r.ok ? null : r.error.code).toBe('PREFLIGHT_BLOCKED')
    expect(json(await tool(client, 'get_request_status', { requestId: asked.requestId }))['status']).toBe(
      'pending_approval',
    )
    expect(entries()).toEqual([])
  })

  it('the stdio bridge relays a client with no token in its configuration, and says when access is off', async () => {
    const { core } = await start()
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on('data', (d: Buffer) =>
      lines.push(
        ...String(d)
          .split('\n')
          .filter((l) => l.trim() !== ''),
      ),
    )
    const done = runMcpBridge({ stateFile: core.paths.state, input, output })
    const ask = async (msg: object, n: number): Promise<void> => {
      input.write(`${JSON.stringify(msg)}\n`)
      const end = Date.now() + 10_000
      while (lines.length < n) {
        if (Date.now() > end) throw new Error(`no reply to ${JSON.stringify(msg)}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    // No state.json yet, then access off: errors that say what to do.
    await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 1)
    expect(lines[0]).toContain('Settings, Outside agents')
    mkdirSync(core.paths.home, { recursive: true })
    writeFileSync(core.paths.state, JSON.stringify({ schemaVersion: 1, externalMcp: { enabled: false } }))
    await ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 2)
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
      id: 2,
      error: { message: expect.stringContaining('turned off') as string },
    })
    // A notification gets no reply; a bad line gets a parse error.
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    await ask({ nope: true }, 2)
    input.write('not json\n')
    await new Promise((r) => setTimeout(r, 200))
    expect(lines.some((l) => l.includes('Parse error'))).toBe(true)
    const count = lines.length

    await enable(core)
    await ask(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'Codex', version: '1' },
        },
      },
      count + 1,
    )
    expect(JSON.parse(lines[count] ?? '{}')).toMatchObject({
      id: 3,
      result: { serverInfo: { name: 'dim-factory' } },
    })
    await ask({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, count + 2)
    expect(lines[count + 1]).toContain('request_run')

    // The app gone: "not running".
    await core.invoke('mcp.external.set', { port: await freePort() })
    const state = JSON.parse(readFileSync(core.paths.state, 'utf8')) as { externalMcp: { port: number } }
    await core.shutdown()
    writeFileSync(
      core.paths.state,
      JSON.stringify({
        ...state,
        externalMcp: { ...state.externalMcp, enabled: true, token: 'x'.repeat(43) },
      }),
    )
    await ask({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, count + 3)
    expect(lines[count + 2]).toContain('not running')
    input.end()
    expect(await done).toBe(0)
  }, 60_000)

  it('the Codex plugin: listed first, written and installed only on install, with the core runner', async () => {
    const { home } = await start()
    const plain = cores[0]
    if (plain === undefined) throw new Error('no core')
    const none = await plain.invoke('mcp.external.codexPlugin', { install: false })
    expect(none.ok ? null : none.error.code).toBe('UNSUPPORTED')
    await plain.shutdown()
    const calls: string[][] = []
    const core = await createCore({
      home,
      host: { kind: 'app' },
      env: hermeticEnv(),
      externalMcp: {
        bridge: BRIDGE,
        runCodex: (args) => {
          calls.push(args)
          return Promise.resolve({ code: 0, output: '' })
        },
      },
    })
    cores.push(core)
    const plan = await core.invoke('mcp.external.codexPlugin', { install: false })
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.installed).toBe(false)
    expect(existsSync(plan.value.dir)).toBe(false)
    expect(calls).toEqual([])
    const view = await core.invoke('mcp.external.get')
    expect(view.ok && view.value.bridge).toEqual(BRIDGE)
    const done = await core.invoke('mcp.external.codexPlugin', { install: true })
    if (!done.ok) throw new Error(done.error.message)
    expect(done.value.installed).toBe(true)
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', join(home, 'codex-marketplace')],
      ['plugin', 'add', 'dim-factory@dim-factory'],
    ])
    for (const f of done.value.files) expect(existsSync(f)).toBe(true)
  })

  it('the Claude Code plugin: listed first, written and installed only on install, with the core runner', async () => {
    const { home } = await start()
    const plain = cores[0]
    if (plain === undefined) throw new Error('no core')
    const none = await plain.invoke('mcp.external.claudePlugin', { install: false })
    expect(none.ok ? null : none.error.code).toBe('UNSUPPORTED')
    await plain.shutdown()
    const calls: string[][] = []
    const core = await createCore({
      home,
      host: { kind: 'app' },
      env: hermeticEnv(),
      externalMcp: {
        bridge: BRIDGE,
        runCodex: () => Promise.reject(new Error('the Codex runner ran')),
        runClaude: (args) => {
          calls.push(args)
          return Promise.resolve({ code: 0, output: '' })
        },
      },
    })
    cores.push(core)
    const plan = await core.invoke('mcp.external.claudePlugin', { install: false })
    if (!plan.ok) throw new Error(plan.error.message)
    expect(plan.value.installed).toBe(false)
    expect(existsSync(plan.value.dir)).toBe(false)
    expect(calls).toEqual([])
    const done = await core.invoke('mcp.external.claudePlugin', { install: true })
    if (!done.ok) throw new Error(done.error.message)
    expect(done.value.installed).toBe(true)
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', join(home, 'claude-marketplace')],
      ['plugin', 'install', 'dim-factory@dim-factory'],
    ])
    for (const f of done.value.files) expect(existsSync(f)).toBe(true)
  })
})
