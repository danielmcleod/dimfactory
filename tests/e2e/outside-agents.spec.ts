// Outside agents, end to end: turn access on in Settings → Outside agents (a free port, the token masked), connect an
// MCP client over HTTP with the token from this home's state.json, ask for a run, and see that nothing runs until the
// request is approved on the Dashboard; approving opens the run, which completes on the fake Claude, and the agent
// reads it back. Then `Dim Factory --mcp` (the stdio bridge, this same Electron) relays a client with no token in its
// configuration, opens no window and leaves the running app alone; Add to VS Code is recorded (never opened) under E2E.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Page } from '@playwright/test'
import { REPO_ROOT, hermeticEnv, passArgvs } from '../integration/run/scenario.ts'
import { expect, test } from './harness.ts'
import type { E2EHarness } from './harness.ts'
import { settingsLoaded } from './diff-settings-helpers.ts'
import { freePort } from '../free-port.ts'

const TASK = 'add a --version flag'

type ToolAnswer = { isError?: boolean; content: { type: string; text: string }[] }
const json = <T = Record<string, unknown>>(a: unknown): T =>
  JSON.parse((a as ToolAnswer).content.map((c) => c.text).join('')) as T

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport as unknown as Parameters<Client['connect']>[0])
  return client
}

/** Settings → Outside agents: pick `port`, turn access on, wait until it listens. */
async function turnOn(page: Page, port: number): Promise<void> {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-section-outside-agents').click()
  await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'outside-agents')
  await settingsLoaded(page)
  await expect(page.getByTestId('mcp-status')).toHaveText('Off. No agent can connect.')
  await page.getByTestId('mcp-port').fill(String(port))
  await page.getByTestId('mcp-port-change').click()
  await expect(page.getByTestId('mcp-port')).toHaveValue(String(port))
  await page.getByTestId('mcp-enabled').click()
  await expect(page.getByTestId('mcp-status')).toHaveText(
    `Listening on 127.0.0.1:${port}. No agent has called yet.`,
  )
  await expect(page.getByTestId('mcp-token')).toHaveText('•'.repeat(24))
}

function endpointOf(e2e: E2EHarness): { port: number; token: string } {
  const state = JSON.parse(readFileSync(join(e2e.home, 'state.json'), 'utf8')) as {
    externalMcp: { port: number; token: string }
  }
  return state.externalMcp
}

test('outside agents: request a run over MCP, approve it on the Dashboard, it runs', async ({ e2e }) => {
  test.setTimeout(240_000)
  const page = await e2e.start({
    scenario: {
      plan: { recording: 'C06-plan-native-host' },
      implement: [
        { recording: 'C08a-session-id-implement', write: { path: 'src/version.ts', content: 'x\n' } },
      ],
    },
    config: { gates: { afterPlan: false } },
  })
  const port = await freePort()
  await turnOn(page, port)
  const { token } = endpointOf(e2e)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  await expect(page.getByTestId('settings-outside-agents')).not.toContainText(token)

  const client = await connect(`http://127.0.0.1:${port}/mcp/dim-factory`, token)
  try {
    const asked = json<{ requestId: string; status: string }>(
      await client.callTool({
        name: 'request_run',
        arguments: { folder: e2e.sandbox, task: TASK, notes: 'From the E2E agent.' },
      }),
    )
    expect(asked.status).toBe('pending_approval')

    // Nothing runs while the request waits.
    await page.getByTestId('nav-dashboard').click()
    const row = page.getByTestId(`needs-you-request-${asked.requestId}`)
    await expect(row).toBeVisible()
    await expect(row.getByTestId('request-task')).toHaveText(`e2e-agent 1.0.0 asks to run: ${TASK}`)
    await expect(row.getByTestId('request-where')).toContainText(e2e.sandbox)
    expect((await e2e.call('runs.list', {})).items).toEqual([])
    expect(passArgvs(e2e.fakeLog())).toEqual([])

    // Approve: the run starts (runs.start's preflight) and its Run view opens.
    await row.getByTestId('request-approve').click()
    await expect(page).toHaveURL(/#\/runs\/[^/]+$/)
    const run = await e2e.onlyRun()
    await expect(page).toHaveURL(new RegExp(`#/runs/${run.runId}$`))
    const done = await e2e.waitForEnd(run.runId)
    expect(done.status, e2e.describeRun(done)).toBe('completed')

    const status = json(
      await client.callTool({ name: 'get_request_status', arguments: { requestId: asked.requestId } }),
    )
    expect(status).toMatchObject({ status: 'approved', runId: run.runId })
    const read = json<Record<string, unknown>>(
      await client.callTool({ name: 'get_run', arguments: { runId: run.runId } }),
    )
    expect(read).toMatchObject({ runId: run.runId, status: 'completed', task: TASK })
    const diff = json<{ files: { path: string }[] }>(
      await client.callTool({ name: 'get_diff', arguments: { runId: run.runId } }),
    )
    expect(diff.files.map((f) => f.path)).toContain('src/version.ts')
  } finally {
    await client.close()
  }

  // The Dashboard has nothing left waiting.
  await page.getByTestId('nav-dashboard').click()
  await expect(page.getByTestId('needs-you')).toHaveAttribute('data-requests', '0')
  expect(e2e.pageErrors).toEqual([])
})

test('stdio bridge: Dim Factory --mcp relays to the running app with no token in its configuration', async ({
  e2e,
}) => {
  test.setTimeout(180_000)
  const page = await e2e.start()
  const port = await freePort()
  await turnOn(page, port)

  // Add to VS Code: main builds the link from the bridge command; under E2E it is recorded, never opened.
  await page.getByTestId('mcp-add-vscode').click()
  await expect(page.getByTestId('mcp-connect-status')).toContainText('Asked VS Code to add Dim Factory')
  const url = (await e2e.e2eState()).extra?.['mcpEditorUrl']
  expect(typeof url === 'string' && url.startsWith('vscode:mcp/install?')).toBe(true)
  const cfg = JSON.parse(decodeURIComponent(String(url).slice('vscode:mcp/install?'.length))) as {
    command: string
    args: string[]
  }
  expect(cfg.args).toEqual([REPO_ROOT.replace(/[\\/]$/, ''), '--mcp'])

  // The bridge: this Electron with the app folder and --mcp, as the snippets say. It reads the home's state.json.
  const env = hermeticEnv({ DIM_FACTORY_HOME: e2e.home })
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(cfg.command, cfg.args, {
    env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines: string[] = []
  let buf = ''
  child.stdout.on('data', (d: Buffer) => {
    buf += String(d)
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    lines.push(...parts.map((l) => l.trim()).filter((l) => l.startsWith('{')))
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  try {
    const send = async (msg: object, n: number): Promise<void> => {
      child.stdin.write(`${JSON.stringify(msg)}\n`)
      await expect.poll(() => lines.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(n)
    }
    await send(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bridge-test', version: '1' },
        },
      },
      1,
    )
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'dim-factory' } },
    })
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 2)
    expect(lines[1]).toContain('request_run')
    child.stdin.end()
    expect(await exited).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill()
  }

  // The app is untouched: still one window, still listening, and it saw the bridge's calls.
  expect(e2e.app?.windows()).toHaveLength(1)
  await page.getByTestId('settings-section-diagnostics').click()
  await page.getByTestId('settings-section-outside-agents').click()
  await settingsLoaded(page)
  await expect(page.getByTestId('mcp-status')).toContainText('Last call at')
})
