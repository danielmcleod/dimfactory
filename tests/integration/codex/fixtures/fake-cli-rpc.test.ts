// The fake CLI's Codex support: the JSON-RPC script ops (an inbox, so requests can come in
// any order across methods; ids bound and echoed), the exec helpers (readToEof, writeFile/copyFiles into the path an
// argv flag names) and the pattern matchers the Codex scripts use ($oneOf, $not, $absent, $optional).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFakeCli } from '../../../../scripts/build-fake-cli.mjs'
import { launchersFor, runFake, startFake } from '../../../fake-cli/harness.ts'
import { argvValue, matchPartial } from '../../../fake-cli/fake-cli.mjs'

const build = await buildFakeCli()
const node = launchersFor(build, 'codex').find((l) => l.kind === 'node')!

function script(ops: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-rpc-'))
  const file = join(dir, 'x.script.jsonl')
  writeFileSync(file, `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`)
  return file
}

const APP_SERVER: Record<string, unknown>[] = [
  { op: 'rpcExpect', method: 'initialize', as: 'init', params: { clientInfo: { name: 'dim-factory' } } },
  { op: 'rpcResult', id: '$init', result: { userAgent: 'fake' } },
  { op: 'rpcExpect', method: 'initialized', kind: 'notification' },
  { op: 'rpcExpect', method: 'thread/start', as: 'ts', params: { sandbox: 'read-only', ephemeral: true } },
  { op: 'rpcResult', id: '$ts', result: { thread: { id: 'th-1' } } },
  {
    op: 'stdout',
    json: { id: 0, method: 'item/commandExecution/requestApproval', params: { itemId: 'c1' } },
  },
  { op: 'rpcExpectResponse', id: 0, result: { decision: 'decline' } },
  { op: 'rpcExpect', method: 'turn/start', as: 'turn', params: { threadId: 'th-1' } },
  { op: 'rpcError', id: '$turn', error: { code: -32602, message: 'Invalid params' } },
  { op: 'rpcDrained' },
  { op: 'exit', code: 0 },
]

describe('JSON-RPC script ops', () => {
  it('serves a session, with the client ids echoed and replies matched by id', async () => {
    const proc = startFake(node, {
      env: { FAKE_CLI_SCRIPT: script(APP_SERVER), FAKE_CLI_TIMEOUT_MS: '8000' },
    })
    proc.send({
      id: 7,
      method: 'initialize',
      params: { clientInfo: { name: 'dim-factory', version: '0.1.0' } },
    })
    await proc.waitForJson((f) => f['id'] === 7)
    // initialized and thread/start in one write, thread/start first: the inbox takes them in the script's order.
    proc.send({
      id: 'b',
      method: 'thread/start',
      params: { cwd: '/x', sandbox: 'read-only', ephemeral: true },
    })
    proc.send({ method: 'initialized' })
    await proc.waitForJson((f) => f['method'] === 'item/commandExecution/requestApproval')
    proc.send({ id: 0, result: { decision: 'decline' } })
    proc.send({ id: 9, method: 'turn/start', params: { threadId: 'th-1', input: [] } })
    const err = await proc.waitForJson((f) => f['id'] === 9)
    proc.end()
    expect(err).toEqual({ error: { code: -32602, message: 'Invalid params' }, id: 9 })
    expect(proc.json()).toContainEqual({ id: 'b', result: { thread: { id: 'th-1' } } })
    expect((await proc.exited).code).toBe(0)
  })

  it('a client message no op took fails rpcDrained (99)', async () => {
    const ops = [
      { op: 'rpcExpect', method: 'initialize', as: 'init' },
      { op: 'rpcResult', id: '$init', result: {} },
      { op: 'sleep', ms: 300 },
      { op: 'rpcDrained' },
      { op: 'exit', code: 0 },
    ]
    const r = await runFake(node, {
      env: { FAKE_CLI_SCRIPT: script(ops) },
      stdin: [
        { id: 1, method: 'initialize', params: {} },
        { id: 2, method: 'model/list', params: {} },
      ],
      keepStdinOpen: true,
    })
    expect(r.code).toBe(99)
    expect(r.stderr).toMatch(/unconsumed JSON-RPC messages[\s\S]*model\/list/)
  })

  it('params that do not match fail with the path (99)', async () => {
    const r = await runFake(node, {
      env: { FAKE_CLI_SCRIPT: script(APP_SERVER), FAKE_CLI_TIMEOUT_MS: '4000' },
      stdin: [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'someone-else' } } }],
      keepStdinOpen: true,
    })
    expect(r.code).toBe(99)
    expect(r.stderr).toMatch(/clientInfo\.name/)
  })
})

describe('exec helpers', () => {
  it('readToEof takes the prompt; writeFile and copyFiles use the paths the argv names', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fake-exec-'))
    const source = mkdtempSync(join(tmpdir(), 'fake-src-'))
    writeFileSync(join(source, 'schema.json'), '{"x":1}')
    const ops = [
      { op: 'readToEof', includes: 'add a --version flag', capture: 'prompt' },
      { op: 'stdout', json: { type: 'thread.started', thread_id: 't' } },
      {
        op: 'writeFile',
        argvPath: ['-o', '--output-last-message'],
        content: 'got: ${prompt}',
        substitute: true,
      },
      { op: 'copyFiles', from: join(source, 'schema.json'), argvPath: '--out' },
      { op: 'exit', code: 0 },
    ]
    const r = await runFake(node, {
      cwd,
      args: ['exec', '--json', '-o', 'last.txt', '--out', 'schemas', '-'],
      env: { FAKE_CLI_SCRIPT: script(ops) },
      stdin: ['Please', 'add a --version flag'],
    })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(readFileSync(join(cwd, 'last.txt'), 'utf8')).toBe('got: Please\nadd a --version flag')
    expect(readFileSync(join(cwd, 'schemas', 'schema.json'), 'utf8')).toBe('{"x":1}')
  })

  it('argvValue finds `-o v`, `--flag=v` and any of several spellings', () => {
    expect(argvValue(['exec', '-o', 'a.txt'], '-o')).toBe('a.txt')
    expect(argvValue(['--output-last-message=b.txt'], ['-o', '--output-last-message'])).toBe('b.txt')
    expect(argvValue(['-o'], '-o')).toBeUndefined()
  })
})

describe('matchers', () => {
  it('$oneOf, $not, $absent, $optional', () => {
    const p = {
      sandbox: { $oneOf: ['read-only', 'workspace-write'] },
      approvalPolicy: { $not: 'untrusted' },
      ephemeral: { $absent: true },
      model: { $optional: 'gpt-5.6-terra' },
    }
    expect(matchPartial(p, { sandbox: 'read-only', approvalPolicy: 'never' }).ok).toBe(true)
    expect(
      matchPartial(p, { sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-5.6-terra' }).ok,
    ).toBe(true)
    expect(matchPartial(p, { sandbox: 'danger-full-access', approvalPolicy: 'never' }).ok).toBe(false)
    expect(matchPartial(p, { sandbox: 'read-only', approvalPolicy: 'untrusted' }).ok).toBe(false)
    expect(matchPartial(p, { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true }).ok).toBe(false)
    expect(matchPartial(p, { sandbox: 'read-only', approvalPolicy: 'never', model: 'other' }).ok).toBe(false)
  })
})
