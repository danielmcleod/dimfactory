// JsonRpcPeer over a spawned fake CLI (Codex-style framing).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonRpcPeer, METHOD_NOT_FOUND } from '../../../src/core/proc/jsonrpc.ts'
import { spawnChild } from '../../../src/core/proc/spawn.ts'
import { readFakeLog } from '../../fake-cli/harness.ts'
import { fixture, forceKill, resolveFake, vendorEnv, waitGone } from './helpers.ts'

let work = ''
let pid: number | undefined
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dim-factory-rpc-'))
})
afterEach(async () => {
  if (pid !== undefined) {
    forceKill(pid)
    await waitGone(pid, 2000)
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('JsonRpcPeer with the fake CLI', () => {
  it('initialize, -32601 for unknown server requests, handler replies, -32001 retry', async () => {
    const log = join(work, 'fake.log')
    const { build, cli } = await resolveFake()
    const child = await spawnChild({
      cli,
      args: ['app-server', '--listen', 'stdio://'],
      cwd: work,
      env: vendorEnv(build, cli, { FAKE_CLI_SCRIPT: fixture('rpc.script.jsonl'), FAKE_CLI_LOG: log }),
      maxLineBytes: 32 * 1024 * 1024,
    })
    pid = child.pid
    const peer = JsonRpcPeer.fromChild(child, { header: 'omit', defaultTimeoutMs: 8000 })
    const errors: unknown[] = []
    peer.onError((e) => errors.push(e))
    const approvals: unknown[] = []
    peer.onRequest('item/commandExecution/requestApproval', (params) => {
      approvals.push(params)
      return { decision: 'accept' }
    })
    const ready = new Promise<void>((resolve) => peer.onNotification('dim/test/ready', () => resolve()))
    const started: unknown[] = []
    peer.onNotification('turn/started', (p) => started.push(p))

    expect(await peer.request('initialize', { clientInfo: { name: 'dim-factory' } })).toEqual({
      userAgent: 'fake/1.0',
    })
    await peer.notify('initialized')
    await ready
    expect(approvals).toEqual([{ command: 'ls' }])

    const t0 = Date.now()
    expect(await peer.request('turn/start', { threadId: 'th_1', input: [] })).toEqual({ turn: { id: 't1' } })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240)
    expect(started).toEqual([{ turnId: 't1' }])

    child.closeStdin()
    const exit = await child.exited
    expect(child.stderrTail().join('\n')).not.toContain('mismatch')
    expect(exit.code).toBe(0)
    await peer.done
    expect(peer.isClosed).toBe(true)
    expect(errors).toEqual([])

    const sent = readFakeLog(log)
      .filter((e) => e.kind === 'stdin')
      .map((e) => JSON.parse(String(e['line'])) as Record<string, unknown>)
    expect(sent.some((f) => 'jsonrpc' in f)).toBe(false)
    expect(sent.find((f) => f['id'] === 900)).toEqual({
      id: 900,
      error: { code: METHOD_NOT_FOUND, message: 'Method not found: item/tool/unknownThing' },
    })
    const turnIds = sent.filter((f) => f['method'] === 'turn/start').map((f) => f['id'])
    expect(turnIds).toHaveLength(2)
    expect(new Set(turnIds).size).toBe(2)
  })
})
