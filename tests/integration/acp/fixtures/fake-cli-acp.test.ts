// The fake CLI's ACP script ops (JsonRpcPeer's JSON-RPC '2.0' header, fixture replay): rpcProtocol puts the
// JSON-RPC 2.0 header on everything the script writes and requires it on every client message an rpc op takes;
// rpcNotify and rpcRequest write agent notifications and requests (ids from 0, bound for rpcExpectResponse). The
// earlier Codex ops (no header) keep their behaviour.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { launchersFor, runFake, startFake } from '../../../fake-cli/harness.ts'

const build = await buildFakeCli()
const node = launchersFor(build, 'gemini').find((l) => l.kind === 'node')!

function script(ops: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-acp-'))
  const file = join(dir, 'x.script.jsonl')
  writeFileSync(file, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
  return file
}

const SESSION: Record<string, unknown>[] = [
  { op: 'rpcProtocol', jsonrpc: '2.0' },
  { op: 'rpcExpect', method: 'initialize', as: 'init', params: { protocolVersion: 1 } },
  { op: 'rpcResult', id: '$init', result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } },
  { op: 'rpcExpect', method: 'session/new', as: 'new', params: { mcpServers: [] } },
  { op: 'rpcResult', id: '$new', result: { sessionId: 's-1' } },
  { op: 'rpcExpect', method: 'session/prompt', as: 'prompt', params: { sessionId: 's-1' } },
  {
    op: 'rpcNotify',
    method: 'session/update',
    params: {
      sessionId: 's-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    },
  },
  {
    op: 'rpcRequest',
    method: 'session/request_permission',
    as: 'perm',
    params: { sessionId: 's-1', toolCall: { toolCallId: 't' }, options: [] },
  },
  { op: 'rpcExpectResponse', id: '$perm', result: { outcome: { outcome: 'cancelled' } } },
  {
    op: 'rpcRequest',
    method: 'session/request_permission',
    params: { sessionId: 's-1', toolCall: { toolCallId: 'u' }, options: [] },
  },
  { op: 'rpcExpectResponse', id: 1, result: { outcome: { outcome: 'selected' } } },
  { op: 'rpcError', id: '$prompt', error: { code: -32000, message: 'Authentication required' } },
  { op: 'rpcDrained' },
  { op: 'exit', code: 0 },
]

describe('ACP script ops', () => {
  it('serves a session with the JSON-RPC 2.0 header on every message, agent ids from 0', async () => {
    const proc = startFake(node, { env: { FAKE_CLI_SCRIPT: script(SESSION), FAKE_CLI_TIMEOUT_MS: '8000' } })
    proc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
    await proc.waitForJson((f) => f['id'] === 1)
    proc.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/x', mcpServers: [] } })
    await proc.waitForJson((f) => f['id'] === 2)
    proc.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's-1', prompt: [] } })
    await proc.waitForJson((f) => f['method'] === 'session/request_permission' && f['id'] === 0)
    proc.send({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } })
    await proc.waitForJson((f) => f['method'] === 'session/request_permission' && f['id'] === 1)
    proc.send({
      jsonrpc: '2.0',
      id: 1,
      result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
    })
    const err = await proc.waitForJson((f) => f['id'] === 3)
    proc.end()
    expect(err).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32000, message: 'Authentication required' },
    })
    const written = proc.json() as Record<string, unknown>[]
    for (const m of written) expect(m['jsonrpc']).toBe('2.0')
    expect(written).toContainEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
    })
    expect(written).toContainEqual({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } })
    expect((await proc.exited).code).toBe(0)
  })

  it('a client message without the header fails the op that takes it (99)', async () => {
    const r = await runFake(node, {
      env: { FAKE_CLI_SCRIPT: script(SESSION), FAKE_CLI_TIMEOUT_MS: '4000' },
      stdin: [{ id: 1, method: 'initialize', params: { protocolVersion: 1 } }],
      keepStdinOpen: true,
    })
    expect(r.code).toBe(99)
    expect(r.stderr).toMatch(/jsonrpc[\s\S]*missing JSON-RPC header/)
  })

  it('a reply without the header fails rpcExpectResponse (99)', async () => {
    const ops = [
      { op: 'rpcProtocol', jsonrpc: '2.0' },
      { op: 'rpcRequest', method: 'session/request_permission', as: 'p', params: {} },
      { op: 'rpcExpectResponse', id: '$p' },
      { op: 'exit', code: 0 },
    ]
    const r = await runFake(node, {
      env: { FAKE_CLI_SCRIPT: script(ops), FAKE_CLI_TIMEOUT_MS: '4000' },
      stdin: [{ id: 0, result: { outcome: { outcome: 'cancelled' } } }],
      keepStdinOpen: true,
    })
    expect(r.code).toBe(99)
  })

  it('only "2.0" is a protocol', async () => {
    const r = await runFake(node, {
      env: { FAKE_CLI_SCRIPT: script([{ op: 'rpcProtocol', jsonrpc: '1.0' }]) },
    })
    expect(r.code).toBe(97)
    expect(r.stderr).toMatch(/rpcProtocol supports jsonrpc "2.0" only/)
  })

  it('without rpcProtocol the Codex form stays: no header, an error as {"error","id"}', async () => {
    const ops = [
      { op: 'rpcExpect', method: 'initialize', as: 'init' },
      { op: 'rpcError', id: '$init', error: { code: -32602, message: 'Invalid params' } },
      { op: 'rpcNotify', method: 'note', params: { a: 1 } },
      { op: 'exit', code: 0 },
    ]
    const r = await runFake(node, {
      env: { FAKE_CLI_SCRIPT: script(ops) },
      stdin: [{ id: 5, method: 'initialize', params: {} }],
    })
    expect(r.code).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual([
      '{"error":{"code":-32602,"message":"Invalid params"},"id":5}',
      '{"method":"note","params":{"a":1}}',
    ])
  })
})
